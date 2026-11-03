// node --test: docs/SCHEMA.md against the code. The document's fenced json
// block lists every field name it describes; this test builds real records
// through server/db.js, reads them back through the running server, and
// compares the names in both directions. A second check matches the names
// against the rows of the document's field tables, also both ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../server/db.js';
import { toEdm } from '../../server/edm.js';
import { fillGaps } from '../../shared/hands-fill.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/SCHEMA.md'), 'utf8');

// the one fenced json block
const blocks = [...DOC.matchAll(/^```json\n([\s\S]*?)^```/gm)];
const LISTED = JSON.parse(blocks[0][1]);

// each list's table rows live under one heading of the document
const SECTIONS = { record: '## Annotation record', contribution: '## Native export', context: '### @context', project: '### Project', asset: '### Asset' };

/** Every key path in a JSON value: nested objects as a.b, array elements as a[].b. */
function paths(v, pre = '', out = new Set()) {
  if (Array.isArray(v)) { for (const e of v) if (e && typeof e === 'object' && !Array.isArray(e)) paths(e, pre + '[]', out); }
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = pre ? `${pre}.${k}` : k; out.add(p); paths(x, p, out); }
  }
  return out;
}
const union = (list) => list.reduce((s, v) => { for (const p of paths(v)) s.add(p); return s; }, new Set());

/** Names in the first cell of the rows of tables headed `| Field |` under a heading, up to the next heading of the same or a higher level. */
function tableNames(heading) {
  const lines = DOC.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start > -1, `docs/SCHEMA.md has no "${heading}" heading`);
  const level = heading.indexOf(' ');
  const names = [];
  let inField = false;
  for (const line of lines.slice(start + 1)) {
    const h = line.match(/^(#+) /);
    if (h && h[1].length <= level) break;
    if (!line.startsWith('|')) { inField = false; continue; }
    if (/^\|\s*Field\s*\|/.test(line)) { inField = true; continue; }
    const m = inField && line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) names.push(m[1]);
  }
  return names;
}

function compare(what, code, listed) {
  const missing = [...code].filter((n) => !listed.includes(n)).sort();
  const extra = listed.filter((n) => !code.has(n)).sort();
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] },
    `${what}: missing = in the code, not in docs/SCHEMA.md (${missing.join(', ') || 'none'}); extra = in docs/SCHEMA.md, not in the code (${extra.join(', ') || 'none'})`);
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});

let dir, server, base, projectId, annotations, exported, edm, projectPaths, assets;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossy-schema-'));
  const db = openDb(dir);
  const project = db.projects.create({ name: 'schema' });
  projectId = project.id;
  db.projects.update(projectId, { language: 'en', script: { questions: [{ id: 'q1', text: 'What was here?' }] }, cloudFallback: true });
  const asset = db.assets.create(projectId, { url: `/models/${projectId}/photo.png`, type: 'image', name: 'photo.png', options: { mode: 'plane' } });
  db.assets.update(projectId, asset.id, { transform: { scale: 1, rotX: -90, rotY: 0, rotZ: 0, x: 0, y: 0, z: 0, pointSize: 0.01 } });

  // a full record: object anchor, period, pose, hands with a gap in each hand, links, a stored transcript
  const J = 25, hand = (x) => Array.from({ length: J * 3 }, (_, i) => x + i * 0.001);
  const frames = [0, 50, 100, 150, 200].map((t, i) => ({ t, l: i === 2 ? null : hand(0.1 * i), r: i === 1 ? null : hand(-0.1 * i) }));
  const hands = fillGaps({ joints: Array.from({ length: J }, (_, i) => `j${i}`), rate: 20, frames });
  const full = db.annotations.create(projectId, {
    author: 'Ayşe', x: 0.1, y: 0.9, z: -1.2, objectId: 'pot', layer: 'review', audioUrl: '/audio/a.webm', durationMs: 1200, consent: true,
    transcriptStatus: 'pending', period: { from: '1950', to: '1965', label: 'orchard years' },
    pose: [{ t: 0, p: [0.4, 1.6, 0.6], q: [0, 0.38, 0, 0.92] }, { t: 100, p: [0.4, 1.6, 0.6], q: [0.01, 0.4, 0, 0.92] }], poseSource: 'xr',
    hands, prompt: 'What was here?', mode: 'interview', language: 'en',
  });
  db.annotations.update(projectId, full.id, { links: [{ kind: 'image', asset: asset.id, url: asset.url, title: 'photo.png' }] });
  db.annotations.setTranscript(projectId, full.id, { transcript: 'The pot stood here.', status: 'done',
    meta: { words: [{ w: 'The', s: 0, e: 0.2 }], language: 'en', detected: true, heard: null, backend: 'local', model: 'whisper', ms: 700 } });
  // a reply whose transcript was rejected as unclear, and a clip whose transcription failed
  const reply = db.annotations.create(projectId, { author: 'Can', x: 0.1, y: 0.9, z: -1.2, audioUrl: '/audio/b.webm', durationMs: 800, consent: true, parent: full.id, transcriptStatus: 'pending' });
  db.annotations.setTranscript(projectId, reply.id, { transcript: '', status: 'done',
    meta: { words: [], language: 'en', detected: false, heard: 'tr', backend: 'local', model: 'whisper', ms: 400, unclear: 'repetition', raw: 'la la la la' } });
  const failed = db.annotations.create(projectId, { author: 'Elif', x: 0, y: 1, z: 0, audioUrl: '/audio/c.webm', durationMs: 500, consent: true, transcriptStatus: 'pending' });
  db.annotations.setTranscript(projectId, failed.id, { transcript: null, status: 'failed', meta: { error: 'decoder failed' } });
  // a clip the cloud fallback transcribed after the local text was rejected
  const cloud = db.annotations.create(projectId, { author: 'Deniz', x: 0, y: 1, z: 0, audioUrl: '/audio/d.webm', durationMs: 900, consent: true, cloudConsent: true, transcriptStatus: 'pending' });
  db.annotations.setTranscript(projectId, cloud.id, { transcript: 'The well was here.', status: 'done',
    meta: { words: [{ w: 'The', s: 0, e: 0.2 }], language: 'en', detected: true, heard: null, backend: 'openai', model: 'whisper-1', ms: 1500, cloud: { from: 'local', reason: 'silence' } } });
  // one whose cloud text was rejected too, and one whose cloud call failed
  const cloudUnclear = db.annotations.create(projectId, { author: 'Deniz', x: 0, y: 1, z: 0, audioUrl: '/audio/e.webm', durationMs: 900, consent: true, cloudConsent: true, transcriptStatus: 'pending' });
  db.annotations.setTranscript(projectId, cloudUnclear.id, { transcript: '', status: 'done',
    meta: { words: [], language: 'en', detected: true, heard: null, backend: 'openai', model: 'whisper-1', ms: 1400, cloud: { from: 'local', reason: 'silence', raw: 'Thank you.' }, unclear: 'silence', raw: 'Thank you.' } });
  const cloudFailed = db.annotations.create(projectId, { author: 'Deniz', x: 0, y: 1, z: 0, audioUrl: '/audio/f.webm', durationMs: 900, consent: true, cloudConsent: true, transcriptStatus: 'pending' });
  db.annotations.setTranscript(projectId, cloudFailed.id, { transcript: '', status: 'done',
    meta: { words: [], language: 'en', detected: true, heard: null, backend: 'local', model: 'whisper', ms: 900, cloud: { from: 'local', reason: 'silence', error: 'openai 500' }, unclear: 'silence', raw: 'Thank you.' } });
  db.close();

  // the server opens the database and listens on import, so it runs as its own process.
  // The port is free when chosen but not reserved: another process could take it before
  // the server listens. The server then exits, and the error below says so.
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(port), GLOSSY_DATA: dir, GLOSSY_TRANSCRIBE: 'none', NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((_, reject) => server.on('exit', (code) => reject(new Error(`server exited (code ${code}) before it answered:\n${stderr}`))));
  exited.catch(() => {});
  const ready = (async () => {
    for (let i = 0; i <= 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not answer on port ${port} within 10 s:\n${stderr}`);
  })();
  await Promise.race([ready, exited]);
  annotations = await (await fetch(`${base}/api/projects/${projectId}/annotations`)).json();
  const one = await (await fetch(`${base}/api/projects/${projectId}`)).json();
  const listed = (await (await fetch(`${base}/api/projects`)).json()).find((p) => p.id === projectId);
  projectPaths = new Set([...union([one, listed])].filter((p) => !p.startsWith('assets[]') && !p.startsWith('script.questions[]')));
  assets = await (await fetch(`${base}/api/projects/${projectId}/assets`)).json();
  exported = await (await fetch(`${base}/api/projects/${projectId}/export`)).json();
  edm = toEdm(one, annotations, { base, provider: 'test', rights: 'http://creativecommons.org/licenses/by/4.0/' });
});

after(() => {
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('docs/SCHEMA.md has one json block with record, contribution, context, project and asset', () => {
  assert.equal(blocks.length, 1);
  assert.deepEqual(Object.keys(LISTED).sort(), ['asset', 'context', 'contribution', 'project', 'record']);
});

test('the record fields match GET /api/projects/:id/annotations', () => {
  assert.equal(annotations.length, 6);
  compare('record', union(annotations), LISTED.record);
});

test('the contribution fields match GET /api/projects/:id/export', () => {
  assert.equal(exported.schema, 'glossy-xr/project/0.4');
  compare('contribution', union(exported.contributions), LISTED.contribution);
});

test('the @context keys match toEdm()', () => {
  compare('context', new Set(Object.keys(edm['@context'])), LISTED.context);
});

test('the project fields match GET /api/projects/:id and GET /api/projects', () => {
  compare('project', projectPaths, LISTED.project);
});

test('the asset fields match GET /api/projects/:id/assets', () => {
  assert.equal(assets.length, 1);
  compare('asset', union(assets), LISTED.asset);
});

test('the field tables and the json block name the same fields', () => {
  for (const [key, heading] of Object.entries(SECTIONS)) {
    const rows = tableNames(heading);
    const absent = LISTED[key].filter((n) => !rows.includes(n));
    const unlisted = rows.filter((n) => !LISTED[key].includes(n));
    assert.deepEqual({ absent, unlisted }, { absent: [], unlisted: [] },
      `${key} under "${heading}": absent = listed but no table row (${absent.join(', ') || 'none'}); unlisted = a table row not in the json block (${unlisted.join(', ') || 'none'})`);
  }
});
