// node --test: docs/SCHEMA.md against the code. The document's fenced json
// block lists every field name it describes; this test builds real records
// through server/db.js, reads them back through the running server, and
// compares the names in both directions. A second check finds each listed
// name as a row in the document's tables.
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
const SECTIONS = { record: 'Annotation record', contribution: 'Native export', context: 'EDM serialisation' };

/** Every key path in a JSON value: nested objects as a.b, array elements as a[].b. */
function paths(v, pre = '', out = new Set()) {
  if (Array.isArray(v)) { for (const e of v) if (e && typeof e === 'object' && !Array.isArray(e)) paths(e, pre + '[]', out); }
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = pre ? `${pre}.${k}` : k; out.add(p); paths(x, p, out); }
  }
  return out;
}
const union = (list) => list.reduce((s, v) => { for (const p of paths(v)) s.add(p); return s; }, new Set());

/** Names in the first cell of table rows under `## heading`, up to the next `## `. */
function tableNames(heading) {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  assert.ok(start > -1, `docs/SCHEMA.md has no "## ${heading}" section`);
  const end = DOC.indexOf('\n## ', start + 1);
  const names = new Set();
  for (const line of DOC.slice(start, end === -1 ? undefined : end).split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) names.add(m[1]);
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

let dir, server, base, projectId, annotations, exported, edm;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossy-schema-'));
  const db = openDb(dir);
  const project = db.projects.create({ name: 'schema' });
  projectId = project.id;
  db.projects.update(projectId, { language: 'en', script: { questions: [{ id: 'q1', text: 'What was here?' }] } });
  const asset = db.assets.create(projectId, { url: `/models/${projectId}/photo.png`, type: 'image', name: 'photo.png', options: { mode: 'plane' } });

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
  db.close();

  // the server opens the database and listens on import, so it runs as its own process
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(port), GLOSSY_DATA: dir, GLOSSY_TRANSCRIBE: 'none', NODE_ENV: 'test' }, stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (i > 100) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  annotations = await (await fetch(`${base}/api/projects/${projectId}/annotations`)).json();
  exported = await (await fetch(`${base}/api/projects/${projectId}/export`)).json();
  const proj = await (await fetch(`${base}/api/projects/${projectId}`)).json();
  edm = toEdm(proj, annotations, { base, provider: 'test', rights: 'http://creativecommons.org/licenses/by/4.0/' });
});

after(() => {
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('docs/SCHEMA.md has one json block with record, contribution and context', () => {
  assert.equal(blocks.length, 1);
  assert.deepEqual(Object.keys(LISTED).sort(), ['context', 'contribution', 'record']);
});

test('the record fields match GET /api/projects/:id/annotations', () => {
  assert.equal(annotations.length, 3);
  compare('record', union(annotations), LISTED.record);
});

test('the contribution fields match GET /api/projects/:id/export', () => {
  assert.equal(exported.schema, 'glossy-xr/project/0.4');
  compare('contribution', union(exported.contributions), LISTED.contribution);
});

test('the @context keys match toEdm()', () => {
  compare('context', new Set(Object.keys(edm['@context'])), LISTED.context);
});

test('every listed name is a row in its section\'s tables', () => {
  for (const [key, heading] of Object.entries(SECTIONS)) {
    const rows = tableNames(heading);
    const absent = LISTED[key].filter((n) => !rows.has(n));
    assert.deepEqual(absent, [], `${key}: listed but not a table row under "## ${heading}": ${absent.join(', ')}`);
  }
});
