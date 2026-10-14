#!/usr/bin/env node
// Seed a dense fixture project straight into the SQLite store: many clips in
// one room, three periods plus timeless ones, several authors and layers,
// replies, and creation dates spread over a year. Used by the test suite and
// by hand to see how the viewer behaves when a room is crowded.
//
//   node scripts/seed-dense.mjs [--data data] [--name dense] [--count 200] [--seed 1]
//
// Records are inserted as already transcribed (no transcription jobs run),
// all sharing one short audio file so the fixture stays small.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { writeToneWav } from '../test/fixtures/tone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PERIODS = [
  { from: '1950', to: '1965', label: 'orchard years' },
  { from: '1970', to: '1990', label: 'summer house' },
  { from: '2000', to: '2026', label: 'museum' },
  null,                                                        // timeless / unspecified
];
const AUTHORS = ['Ayşe', 'Mehmet', 'Fatma', 'Deniz', 'Ainsley', 'Elif', 'Can'];
const LAYERS = ['default', 'default', 'default', 'draft', 'review', 'final'];
const THINGS = ['pekmez cauldron', 'vine terrace', 'cool room', 'well', 'loom', 'bread oven', 'walnut tree', 'guest room', 'stable door', 'cistern'];
const VERBS = ['stood here', 'was kept here', 'was mended every spring', 'was shared with the neighbours', 'was moved after the road came', 'was used only in August'];

/** Deterministic pseudo-random numbers so the fixture is the same every run. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * Insert `count` annotations into project `name` in the store at `dataDir`.
 * Positions fall on the default room's walls, table and floor (a 6 m box),
 * so the fixture works with no assets loaded.
 */
export function seedDense({ dataDir, name = 'dense', count = 200, seed = 1, replyRate = 0.15 }) {
  const db = openDb(dataDir);
  const audioDir = path.join(dataDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const clip = path.join(audioDir, 'dense-fixture.wav');
  if (!fs.existsSync(clip)) writeToneWav(clip, 1.5, 16000);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const project = db.projects.list().find((p) => p.name === name) || db.projects.create({ name });
  const now = Date.now();
  const roots = [];
  for (let i = 0; i < count; i++) {
    const isReply = roots.length > 5 && rand() < replyRate;
    const parent = isReply ? pick(roots) : null;
    let x, y, z;
    if (parent) ({ x, y, z } = parent.anchor);
    else {
      const wall = Math.floor(rand() * 5);
      const u = rand() * 5.6 - 2.8, h = 0.4 + rand() * 2.2;
      [x, y, z] = wall === 0 ? [u, h, -2.98] : wall === 1 ? [u, h, 2.98] : wall === 2 ? [-2.98, h, u] : wall === 3 ? [2.98, h, u] : [rand() * 1.1 - 0.55, 0.79, -1.2 + rand() * 0.6 - 0.3];
    }
    const thing = pick(THINGS), verb = pick(VERBS);
    const period = parent ? parent.period : pick(PERIODS);
    const text = parent ? `My grandmother said the same about the ${thing}.` : `The ${thing} ${verb}.`;
    const words = text.split(' ').map((w, k, arr) => ({ w, s: +(k * 1.4 / arr.length).toFixed(2), e: +((k + 1) * 1.4 / arr.length).toFixed(2) }));
    const ageDays = Math.floor(rand() ** 2 * 400);           // skewed toward recent
    const createdAt = new Date(now - ageDays * 86400e3 - i * 1000).toISOString();
    const rec = db.annotations.create(project.id, {
      author: pick(AUTHORS), createdAt, x, y, z, objectId: parent ? parent.anchor.objectId : (y < 0.8 ? 'table' : 'walls'),
      layer: pick(LAYERS), audioUrl: '/audio/dense-fixture.wav', durationMs: 1400, consent: true,
      transcript: text, transcriptStatus: 'done', parent: parent?.id ?? null, period,
      mode: rand() < 0.3 ? 'interview' : 'walk', prompt: null, language: 'en',
    });
    db.annotations.setTranscript(project.id, rec.id, { transcript: text, status: 'done', meta: { words, language: 'en', detected: false, backend: 'fixture', model: 'none', ms: 0 } });
    if (!parent) roots.push(rec);
  }
  const out = { project: db.projects.get(project.id), count: db.annotations.list(project.id).length };
  db.close();
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
  const dataDir = path.resolve(arg('data', path.join(__dirname, '..', 'data')));
  const r = seedDense({ dataDir, name: arg('name', 'dense'), count: Number(arg('count', 200)), seed: Number(arg('seed', 1)) });
  console.log(`seeded ${r.count} annotations into project "${r.project.name}" (${r.project.id}) in ${dataDir}; restart or reload clients to see them`);
}
