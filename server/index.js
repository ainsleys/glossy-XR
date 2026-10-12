// Glossy XR server.
//
// Same job as the 2016 index.js: accept an audio annotation with a position,
// persist it, and push it to every connected client; send the full set to a
// client when it connects. Since then:
//   - audio and models live on disk as files, metadata in SQLite (node:sqlite)
//   - a project owns one model (GLB/glTF, PLY, PCD, OBJ, splat) and its annotations
//   - every annotation carries author, timestamp, spatial anchor and layer, so
//     a set can be filtered, reviewed and exported without the viewer
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

// ---- model types -----------------------------------------------------------

// extension -> how the client should load it
export const MODEL_TYPES = {
  '.glb': 'gltf', '.gltf': 'gltf',
  '.ply': 'ply',            // mesh, point cloud, or 3DGS; the client sniffs the header
  '.pcd': 'pcd',
  '.obj': 'obj',
  '.splat': 'splat', '.ksplat': 'splat', '.spz': 'splat', '.sog': 'splat',
};
const safeName = (n) => path.basename(n).replace(/[^\w.\-]+/g, '_').slice(0, 120);

// ---- validation ------------------------------------------------------------

function validateAnnotation(body) {
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
  return { errors, x, y, z, author, layer, objectId, consent };
}

// ---- http ------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: true }, maxHttpBufferSize: 1e6 });

app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));
app.use('/models', express.static(MODEL_DIR, { maxAge: '1d', setHeaders: (res, p) => {
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

app.get('/api/health', (_req, res) => res.json({ ok: true, projects: db.projects.list().length }));
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
  const p = db.projects.update(req.params.id, { name, transform });
  io.emit('project:updated', p);
  res.json(p);
});
app.delete('/api/projects/:id', projectOr404, async (req, res) => {
  for (const a of db.annotations.list(req.params.id)) await fsp.unlink(path.join(AUDIO_DIR, path.basename(a.audioUrl))).catch(() => {});
  await fsp.rm(path.join(MODEL_DIR, req.params.id), { recursive: true, force: true });
  db.projects.remove(req.params.id);
  io.emit('project:deleted', { id: req.params.id });
  res.status(204).end();
});

// model upload: field "model" (the main file) plus optional sidecar files in "files"
app.post('/api/projects/:id/model', projectOr404, modelUpload.fields([{ name: 'model', maxCount: 1 }, { name: 'files', maxCount: 50 }]), (req, res) => {
  const main = req.files?.model?.[0];
  if (!main) return res.status(400).json({ error: 'model file is required (glb, gltf, ply, pcd, obj, splat, ksplat, spz, sog)' });
  const type = MODEL_TYPES[path.extname(main.originalname).toLowerCase()];
  if (!type) return res.status(400).json({ error: 'unsupported model type' });
  const p = db.projects.setModel(req.params.id, { url: `/models/${req.params.id}/${main.filename}`, type, name: main.originalname });
  io.emit('project:updated', p);
  res.status(201).json(p);
});

function sanitizeTransform(t) {
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
  const v = validateAnnotation(req.body);
  if (v.errors.length) {
    await fsp.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: v.errors.join('; ') });
  }
  const record = db.annotations.create(req.params.id, {
    id: path.parse(req.file.filename).name,
    author: v.author, x: v.x, y: v.y, z: v.z, objectId: v.objectId, layer: v.layer,
    audioUrl: `/audio/${req.file.filename}`, durationMs: Number(req.body.durationMs) || null, consent: true,
  });
  io.to(req.params.id).emit('annotation:new', record);     // the record we just saved, to everyone in the project
  res.status(201).json(record);
});

app.delete('/api/projects/:id/annotations/:aid', projectOr404, async (req, res) => {
  const gone = db.annotations.remove(req.params.id, req.params.aid);
  if (!gone) return res.status(404).end();
  await fsp.unlink(path.join(AUDIO_DIR, path.basename(gone.audioUrl))).catch(() => {});
  io.to(req.params.id).emit('annotation:deleted', { id: gone.id });
  res.status(204).end();
});

app.get('/api/projects/:id/export', projectOr404, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="glossy-${req.params.id}.json"`);
  res.json({
    exportedAt: new Date().toISOString(),
    schema: 'glossy-xr/project/0.3',
    project: req.project,
    annotations: db.annotations.list(req.params.id),
  });
});
app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="glossy-all.json"');
  res.json({ exportedAt: new Date().toISOString(), schema: 'glossy-xr/all/0.3', projects: db.projects.list(), annotations: db.annotations.listAll() });
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

server.listen(PORT, () => {
  console.log(`glossy-xr server on http://localhost:${PORT}  (${db.projects.list().length} projects, data in ${DATA_DIR})`);
});
