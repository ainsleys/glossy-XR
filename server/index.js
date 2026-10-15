// Glossy XR server.
//
// Same job as the 2016 index.js: accept an audio annotation with a position,
// persist it, and push it to every connected client; send the full set to a
// client when it connects. Since then:
//   - audio and models live on disk as files, metadata in SQLite (node:sqlite)
//   - a project owns one model (GLB/glTF, PLY, PCD, OBJ, splat) and its annotations
//   - every annotation carries author, timestamp, spatial anchor, layer and an
//     optional temporal reference (period), so a set can be filtered, reviewed
//     and exported without the viewer; a reply carries its parent; a clip made
//     in interview mode carries the question it answers; the author's head pose
//     over the clip is stored alongside
//   - the "lagging one behind" bug is gone: the server emits the record it just
//     saved, not the last record in the table
//   - GET /api/projects/:id/export returns one project as a JSON document

import express from 'express';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.js';
import { createTranscriber } from './transcribe.js';
import { unclearReason } from '../shared/text.js';
import { toEdm } from './edm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.GLOSSY_DATA || path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const MODEL_DIR = path.join(DATA_DIR, 'models');
const PORT = Number(process.env.PORT || 3000);
const MAX_MODEL_BYTES = Number(process.env.GLOSSY_MAX_MODEL_MB || 1024) * 1024 * 1024;

for (const d of [AUDIO_DIR, MODEL_DIR]) fs.mkdirSync(d, { recursive: true });
const db = openDb(DATA_DIR);
const imported = db.importLegacyJson(path.join(DATA_DIR, 'annotations.json'));
if (imported) console.log(`imported ${imported} annotations from annotations.json`);
if (db.projects.list().length === 0) db.projects.create({ name: 'default' });

// ---- transcription -----------------------------------------------------------
// Clips are transcribed off the request path; clients get `annotation:updated`
// when the text lands. Jobs left pending by a previous run are picked up on boot.

const transcriber = createTranscriber({ log: console });
function queueTranscription(record) {
  if (!transcriber.enabled) return;
  const file = path.join(AUDIO_DIR, path.basename(record.audioUrl));
  // language: the clip's own setting, else the project's, else the backend detects
  const language = record.language || db.projects.get(record.project)?.language || undefined;
  transcriber.enqueue(record.id, file, { language }, (err, result) => {
    const cur = db.annotations.get(record.project, record.id);
    if (!cur) return;                                        // deleted while queued
    const unclear = err ? null : unclearReason(result.text);      // the model looped, or transcribed silence as a subtitle credit: keep the raw text in meta, store no transcript
    const updated = err
      ? db.annotations.setTranscript(record.project, record.id, { transcript: cur.transcript, status: 'failed', meta: { error: err.message } })
      : unclear
        ? db.annotations.setTranscript(record.project, record.id, { transcript: '', status: 'done', meta: { words: [], language: result.language, detected: !!result.detected, heard: result.heard || null, backend: result.backend, model: result.model, ms: result.ms, unclear, raw: result.text } })
        : db.annotations.setTranscript(record.project, record.id, { transcript: result.text, status: 'done', meta: { words: result.words, language: result.language, detected: !!result.detected, heard: result.heard || null, backend: result.backend, model: result.model, ms: result.ms } });
    io.to(record.project).emit('annotation:updated', updated);
  });
}

// ---- model types -----------------------------------------------------------

// extension -> how the client should load it
export const MODEL_TYPES = {
  '.glb': 'gltf', '.gltf': 'gltf',
  '.ply': 'ply',            // mesh, point cloud, or 3DGS; the client sniffs the header
  '.pcd': 'pcd',
  '.obj': 'obj',
  '.splat': 'splat', '.ksplat': 'splat', '.spz': 'splat', '.sog': 'splat',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.avif': 'image',   // flat plane, or 360 sphere via options.mode
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
};
const safeName = (n) => path.basename(n).replace(/[^\w.\-]+/g, '_').slice(0, 120);

// ---- validation ------------------------------------------------------------

const LANG_RE = /^[a-z]{2,3}$/;             // Whisper takes bare ISO codes (tr, en), not region tags
const MAX_POSE_SAMPLES = 6000;                  // 10 Hz for ten minutes

/** Temporal reference: { from, to, label } with free-form strings (years, dates, "always"); null clears it. */
function parsePeriod(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'null') return null;
  const o = typeof v === 'string' ? JSON.parse(v) : v;
  if (!o || typeof o !== 'object') throw new Error('period must be an object');
  const str = (k) => (o[k] === undefined || o[k] === null ? undefined : String(o[k]).trim().slice(0, 60) || undefined);
  const out = { from: str('from'), to: str('to'), label: str('label') };
  if (!out.from && !out.to && !out.label) return null;
  return out;
}

/** Links: up to 20 attachments, each { kind: image|document|url, asset?: project asset id, url?, title? }. */
function parseLinks(v) {
  const arr = typeof v === 'string' ? JSON.parse(v) : v;
  if (arr === null) return [];
  if (!Array.isArray(arr)) throw new Error('links must be an array');
  return arr.slice(0, 20).map((l) => {
    if (!l || typeof l !== 'object') throw new Error('each link must be an object');
    const s = (k, n) => (l[k] === undefined || l[k] === null ? undefined : String(l[k]).trim().slice(0, n) || undefined);
    const out = { kind: ['image', 'document', 'url'].includes(l.kind) ? l.kind : 'url', asset: s('asset', 80), url: s('url', 2000), title: s('title', 200) };
    if (!out.asset && !out.url) throw new Error('a link needs an asset id or a url');
    return out;
  });
}

/** Head pose over the clip: [{t, p:[x,y,z], q:[x,y,z,w]}], t in ms from the start of recording. */
function parsePose(v) {
  if (v === undefined || v === null || v === '') return [];
  const arr = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(arr)) throw new Error('pose must be an array');
  const r3 = (n) => Math.round(Number(n) * 1000) / 1000, r4 = (n) => Math.round(Number(n) * 10000) / 10000;
  return arr.slice(0, MAX_POSE_SAMPLES).map((s) => {
    if (!s || !Array.isArray(s.p) || s.p.length !== 3 || !Array.isArray(s.q) || s.q.length !== 4) throw new Error('pose sample must have p[3] and q[4]');
    const out = { t: Math.max(0, Math.round(Number(s.t) || 0)), p: s.p.map(r3), q: s.q.map(r4) };
    if ([...out.p, ...out.q].some((n) => !Number.isFinite(n))) throw new Error('pose values must be numbers');
    return out;
  });
}

function validateAnnotation(body, projectId) {
  const errors = [];
  const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
  const x = num(body.x), y = num(body.y), z = num(body.z);
  if ([x, y, z].some(Number.isNaN)) errors.push('anchor x/y/z must be numbers');
  const author = String(body.author || '').trim().slice(0, 120);
  if (!author) errors.push('author is required');
  const layer = String(body.layer || '').trim().slice(0, 120) || 'default';
  const objectId = body.objectId ? String(body.objectId).slice(0, 200) : undefined;
  const consent = body.consent === 'true' || body.consent === true;
  if (!consent) errors.push('consent must be true');
  // replies are one level deep: a reply to a reply attaches to the original
  let parent = body.parent ? String(body.parent).slice(0, 80) : null;
  if (parent) {
    const p = db.annotations.get(projectId, parent);
    if (!p) { errors.push('parent annotation not found'); parent = null; }
    else if (p.parent) parent = p.parent;
  }
  let period = null, pose = [];
  try { period = parsePeriod(body.period) ?? null; } catch (e) { errors.push('period: ' + e.message); }
  try { pose = parsePose(body.pose); } catch (e) { errors.push('pose: ' + e.message); }
  const prompt = body.prompt ? String(body.prompt).trim().slice(0, 500) : null;
  const mode = body.mode === 'interview' ? 'interview' : 'walk';
  const language = body.language && LANG_RE.test(String(body.language)) ? String(body.language) : null;
  const poseSource = body.poseSource === 'xr' ? 'xr' : 'desktop';
  return { errors, x, y, z, author, layer, objectId, consent, parent, period, pose, poseSource, prompt, mode, language };
}

// ---- http ------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
// Idle keep-alive sockets are closed after 65 s rather than Node's 5 s, so a
// client that reuses a connection a few seconds after its last request (the
// Playwright request context, a browser between polls) does not hit a socket
// the server has just closed and see ECONNRESET.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
const io = new SocketServer(server, { cors: { origin: true }, maxHttpBufferSize: 1e6 });

app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));
// max-age 0: a re-uploaded file keeps its name, so browsers must revalidate (the ETag changes) instead of showing yesterday's model for a day
app.use('/models', express.static(MODEL_DIR, { maxAge: 0, setHeaders: (res, p) => {
  if (p.endsWith('.gltf')) res.setHeader('Content-Type', 'model/gltf+json');
  if (p.endsWith('.glb')) res.setHeader('Content-Type', 'model/gltf-binary');
} }));
app.use(express.json());

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (_req, file, cb) => {
      const ext = file.mimetype.includes('ogg') ? 'ogg' : file.mimetype.includes('mp4') ? 'm4a' : 'webm';
      cb(null, `${randomUUID()}.${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  // Browsers send audio/webm or audio/ogg; some clients label the same bytes
  // video/webm or application/octet-stream, so accept those containers too.
  fileFilter: (_req, file, cb) => cb(null,
    file.mimetype.startsWith('audio/')
    || ['video/webm', 'video/ogg', 'application/ogg', 'application/octet-stream'].includes(file.mimetype)),
});

const modelUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(MODEL_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
  }),
  limits: { fileSize: MAX_MODEL_BYTES },
  fileFilter: (_req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() in MODEL_TYPES
    || /\.(bin|png|jpe?g|webp|ktx2|mtl)$/i.test(file.originalname)),   // glTF sidecars
});

const projectOr404 = (req, res, next) => {
  req.project = db.projects.get(req.params.id);
  if (!req.project) return res.status(404).json({ error: 'project not found' });
  next();
};

app.get('/api/health', (_req, res) => res.json({ ok: true, projects: db.projects.list().length, transcription: transcriber.info() }));
app.get('/api/model-types', (_req, res) => res.json(MODEL_TYPES));

// projects
app.get('/api/projects', (_req, res) => res.json(db.projects.list()));
app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const p = db.projects.create({ name, transform: req.body?.transform || {} });
  io.emit('project:created', p);
  res.status(201).json(p);
});
app.get('/api/projects/:id', projectOr404, (req, res) => res.json(req.project));
app.patch('/api/projects/:id', projectOr404, (req, res) => {
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : undefined;
  const transform = req.body?.transform !== undefined ? sanitizeTransform(req.body.transform) : undefined;
  let language, script;
  if (req.body?.language !== undefined) {
    language = req.body.language ? String(req.body.language) : null;
    if (language && !LANG_RE.test(language)) return res.status(400).json({ error: 'language must be an ISO code such as en or tr' });
  }
  if (req.body?.script !== undefined) {
    script = req.body.script ? sanitizeScript(req.body.script) : null;
    if (script === false) return res.status(400).json({ error: 'script must be { questions: [{ text }] }' });
  }
  const p = db.projects.update(req.params.id, { name, transform, language, script });
  io.emit('project:updated', p);
  res.json(p);
});

// Interview script: an ordered list of questions the client asks before each
// clip. Each question keeps `text` and an optional `id`; extra keys (e.g.
// translations) are kept as given.
function sanitizeScript(sc) {
  if (!sc || typeof sc !== 'object' || !Array.isArray(sc.questions)) return false;
  const questions = sc.questions.slice(0, 200).map((q, i) => {
    const o = typeof q === 'string' ? { text: q } : q;
    if (!o || typeof o !== 'object' || !o.text) return null;
    return { ...o, id: String(o.id || `q${i + 1}`).slice(0, 40), text: String(o.text).trim().slice(0, 500) };
  }).filter(Boolean);
  return { ...sc, questions };
}
app.delete('/api/projects/:id', projectOr404, async (req, res) => {
  for (const a of db.annotations.list(req.params.id)) await fsp.unlink(path.join(AUDIO_DIR, path.basename(a.audioUrl))).catch(() => {});
  await fsp.rm(path.join(MODEL_DIR, req.params.id), { recursive: true, force: true });
  db.projects.remove(req.params.id);
  io.emit('project:deleted', { id: req.params.id });
  res.status(204).end();
});

// assets: a project holds any number (meshes, clouds, splats, images, video), each with its own transform
// upload: field "model" (the main file) plus optional sidecar files in "files"
app.post('/api/projects/:id/assets', projectOr404, modelUpload.fields([{ name: 'model', maxCount: 1 }, { name: 'files', maxCount: 50 }]), (req, res) => {
  const main = req.files?.model?.[0];
  if (!main) return res.status(400).json({ error: 'file is required (' + Object.keys(MODEL_TYPES).join(' ') + ')' });
  const type = MODEL_TYPES[path.extname(main.originalname).toLowerCase()];
  if (!type) return res.status(400).json({ error: 'unsupported asset type' });
  const options = {};
  if (type === 'image' && req.body?.mode) options.mode = req.body.mode === 'sphere' ? 'sphere' : 'plane';
  // Sidecars are stored flat next to the model, so point MTL texture references
  // at bare file names (archives often use textures/foo.png).
  for (const f of [main, ...(req.files?.files || [])]) {
    if (!/\.mtl$/i.test(f.filename)) continue;
    const mtl = fs.readFileSync(f.path, 'utf8').replace(/^(\s*map_\w+|\s*bump|\s*disp|\s*decal|\s*refl)(\s+(?:-\S+\s+\S+\s+)*)(.*?)$/gm,
      (_m, key, opts, file) => `${key}${opts || ' '}${safeName(file.trim().split(/[\\/]/).pop())}`);
    fs.writeFileSync(f.path, mtl);
  }
  const asset = db.assets.create(req.params.id, { url: `/models/${req.params.id}/${main.filename}`, type, name: main.originalname, options });
  io.emit('project:updated', db.projects.get(req.params.id));
  res.status(201).json(asset);
});
app.get('/api/projects/:id/assets', projectOr404, (req, res) => res.json(db.assets.list(req.params.id)));
app.patch('/api/projects/:id/assets/:aid', projectOr404, (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 120);
  if (req.body?.transform !== undefined) patch.transform = sanitizeTransform(req.body.transform);
  if (req.body?.options !== undefined && typeof req.body.options === 'object') patch.options = req.body.options;
  if (req.body?.visible !== undefined) patch.visible = !!req.body.visible;
  if (req.body?.sort !== undefined) patch.sort = Number(req.body.sort) || 0;
  const a = db.assets.update(req.params.id, req.params.aid, patch);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  io.emit('project:updated', db.projects.get(req.params.id));
  res.json(a);
});
app.delete('/api/projects/:id/assets/:aid', projectOr404, async (req, res) => {
  const gone = db.assets.remove(req.params.id, req.params.aid);
  if (!gone) return res.status(404).end();
  const others = db.assets.list(req.params.id).some((a) => a.url === gone.url);
  if (!others) await fsp.unlink(path.join(MODEL_DIR, req.params.id, path.basename(gone.url))).catch(() => {});
  io.emit('project:updated', db.projects.get(req.params.id));
  res.status(204).end();
});

function sanitizeTransform(t) {
  if (!t || typeof t !== 'object' || Object.keys(t).length === 0) return {};   // {} means "not set yet": client auto-fits on first load
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    scale: n(t.scale, 1) || 1,
    rotX: n(t.rotX), rotY: n(t.rotY), rotZ: n(t.rotZ),
    x: n(t.x), y: n(t.y), z: n(t.z),
    pointSize: n(t.pointSize, 0.01) || 0.01,
  };
}

// annotations (scoped to a project)
app.get('/api/projects/:id/annotations', projectOr404, (req, res) => res.json(db.annotations.list(req.params.id)));

app.post('/api/projects/:id/annotations', projectOr404, audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required' });
  const v = validateAnnotation(req.body, req.params.id);
  if (v.errors.length) {
    await fsp.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: v.errors.join('; ') });
  }
  const record = db.annotations.create(req.params.id, {
    id: path.parse(req.file.filename).name,
    author: v.author, x: v.x, y: v.y, z: v.z, objectId: v.objectId, layer: v.layer,
    audioUrl: `/audio/${req.file.filename}`, durationMs: Number(req.body.durationMs) || null, consent: true,
    transcriptStatus: transcriber.enabled ? 'pending' : 'skipped',
    parent: v.parent, period: v.period, pose: v.pose, poseSource: v.poseSource, prompt: v.prompt, mode: v.mode, language: v.language,
  });
  io.to(req.params.id).emit('annotation:new', record);     // the record we just saved, to everyone in the project
  if (record.parent) io.to(req.params.id).emit('annotation:updated', db.annotations.get(req.params.id, record.parent));   // its reply count moved
  res.status(201).json(record);
  queueTranscription(record);
});

// edit the fields a reviewer may change after the fact: layer, period (temporal reference), consent, links (photos and documents attached to the clip), language (for the next transcription)
app.patch('/api/projects/:id/annotations/:aid', projectOr404, (req, res) => {
  const patch = {};
  if (req.body?.layer !== undefined) patch.layer = String(req.body.layer).trim().slice(0, 120) || 'default';
  if (req.body?.consent !== undefined) patch.consent = !!req.body.consent;
  try { if (req.body?.period !== undefined) patch.period = parsePeriod(req.body.period); } catch (e) { return res.status(400).json({ error: 'period: ' + e.message }); }
  try { if (req.body?.links !== undefined) patch.links = parseLinks(req.body.links); } catch (e) { return res.status(400).json({ error: 'links: ' + e.message }); }
  if (req.body?.language !== undefined) patch.language = req.body.language && LANG_RE.test(String(req.body.language)) ? String(req.body.language) : null;
  const a = db.annotations.update(req.params.id, req.params.aid, patch);
  if (!a) return res.status(404).end();
  io.to(req.params.id).emit('annotation:updated', a);
  res.json(a);
});

// (re)run speech-to-text for one annotation
app.post('/api/projects/:id/annotations/:aid/transcribe', projectOr404, (req, res) => {
  const cur = db.annotations.get(req.params.id, req.params.aid);
  if (!cur) return res.status(404).end();
  if (!transcriber.enabled) return res.status(503).json({ error: 'transcription disabled', ...transcriber.info() });
  if (req.body?.language !== undefined) {                      // '' = detect; a code = force it for this clip from now on
    const language = req.body.language && LANG_RE.test(String(req.body.language)) ? String(req.body.language) : null;
    db.annotations.update(req.params.id, cur.id, { language });
  }
  const record = db.annotations.setTranscript(req.params.id, cur.id, { transcript: cur.transcript, status: 'pending', meta: {} });
  io.to(req.params.id).emit('annotation:updated', record);
  res.status(202).json(record);
  queueTranscription(record);
});

// Erase: the row, its audio file and its derived data go together. Replies to
// the erased clip stay, detached, as roots.
app.delete('/api/projects/:id/annotations/:aid', projectOr404, async (req, res) => {
  const gone = db.annotations.remove(req.params.id, req.params.aid);
  if (!gone) return res.status(404).end();
  await fsp.unlink(path.join(AUDIO_DIR, path.basename(gone.audioUrl))).catch(() => {});
  io.to(req.params.id).emit('annotation:deleted', { id: gone.id });
  for (const cid of gone.detached) io.to(req.params.id).emit('annotation:updated', db.annotations.get(req.params.id, cid));   // now roots
  if (gone.parent) { const p = db.annotations.get(req.params.id, gone.parent); if (p) io.to(req.params.id).emit('annotation:updated', p); }   // one reply fewer
  res.status(204).end();
});

// Export. Every contribution carries attribution (author), timestamp
// (createdAt), spatial anchor (anchor, in the project's scene coordinates) and
// temporal reference (period, null when unspecified), plus transcript, word
// timestamps, the author's viewpoint over the clip with its source (headset
// pose or desktop camera), parent (for replies), prompt, mode and links
// (photos or documents a reviewer attached to the clip).
function exportProject(p) {
  const annotations = db.annotations.list(p.id);
  return {
    project: p,
    contributions: annotations.map((a) => ({
      id: a.id, attribution: a.author, timestamp: a.createdAt, anchor: a.anchor, period: a.period,
      parent: a.parent, mode: a.mode, prompt: a.prompt, layer: a.layer, consent: a.consent,
      audio: a.audioUrl, durationMs: a.durationMs, language: a.transcription?.language || a.language || null,
      transcript: a.transcript, words: a.transcription?.words || [], pose: a.pose, poseSource: a.poseSource, links: a.links || [],
    })),
  };
}
app.get('/api/projects/:id/export', projectOr404, (req, res) => {
  if (req.query.format === 'edm') {                            // the same contributions as EDM records in JSON-LD (server/edm.js)
    const base = process.env.GLOSSY_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const doc = toEdm(req.project, db.annotations.list(req.params.id), { base, provider: process.env.GLOSSY_PROVIDER || 'Glossy XR', rights: process.env.GLOSSY_RIGHTS || 'http://creativecommons.org/licenses/by/4.0/' });
    res.setHeader('Content-Disposition', `attachment; filename="glossy-${req.params.id}.edm.jsonld"`);
    return res.type('application/ld+json').send(JSON.stringify(doc, null, 2));
  }
  res.setHeader('Content-Disposition', `attachment; filename="glossy-${req.params.id}.json"`);
  res.json({ exportedAt: new Date().toISOString(), schema: 'glossy-xr/project/0.4', ...exportProject(req.project) });
});
app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="glossy-all.json"');
  res.json({ exportedAt: new Date().toISOString(), schema: 'glossy-xr/all/0.4', projects: db.projects.list().map(exportProject) });
});

// serve the built client in production
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// multer and other errors as JSON
app.use((err, _req, res, _next) => {
  const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  res.status(code).json({ error: err.message || 'server error' });
});

// ---- sockets ---------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('join', ({ project }) => {
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    if (!db.projects.get(project)) return socket.emit('error:project', { project });
    socket.join(project);
    socket.emit('annotation:all', db.annotations.list(project));
  });
  socket.on('presence', (p) => { for (const r of socket.rooms) if (r !== socket.id) socket.to(r).emit('presence', { id: socket.id, ...p }); });
  socket.on('disconnect', () => io.emit('presence:left', { id: socket.id }));
});

for (const a of db.annotations.listByTranscriptStatus('pending')) queueTranscription(a);

server.listen(PORT, () => {
  console.log(`glossy-xr server on http://localhost:${PORT}  (${db.projects.list().length} projects, data in ${DATA_DIR})`);
});
