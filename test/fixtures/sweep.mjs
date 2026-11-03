// Fixture sweep: where in the looping fake-microphone sentence can a clip
// start and still decode to the expected words? Builds the fixture WAV with
// the same `say` arguments as playwright.config.js, cuts a window of --ms at
// every --step from 0 to the loop length (wrapping past the end, as the fake
// microphone does), encodes each as webm/opus like the browser's recorder,
// and decodes it with the server's own transcriber, twice: language detected
// and language forced to --lang. The silence/repetition guard is applied as
// server/index.js applies it, and the pass rules are the e2e test's.
//
//   node test/fixtures/sweep.mjs --text "<sentence>" --voice Yelda --lang tr \
//     --ms 3180 --step 25 --match 'pekmez|kazan|avlu|asma|durur'
//
// --replay <dir> instead decodes stored clips (.test-data/audio/*.webm), finds
// where each started in the loop by cross-correlation, and reports whether the
// sweep at that start agrees with the stored clip's outcome.
// --max-miss <n> stops after n detected-mode misses. Starts are visited coarse
// to fine (every 8th step first), so a partial run still covers the loop.
// This is a model of the e2e path: Chromium's echo cancellation, noise
// suppression and Opus settings are not reproduced.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createTranscriber } from '../../server/transcribe.js';
import { unclearReason } from '../../shared/text.js';

const { values: o } = parseArgs({ options: {
  text: { type: 'string' }, voice: { type: 'string' }, lang: { type: 'string' },
  ms: { type: 'string', default: '3180' }, step: { type: 'string', default: '25' },
  match: { type: 'string' }, kbps: { type: 'string', default: '128' }, replay: { type: 'string' }, 'max-miss': { type: 'string' },
} });
if (!o.text || !o.lang || !o.match) {
  console.error('usage: node test/fixtures/sweep.mjs --text "<sentence>" [--voice V] --lang tr --ms 3180 [--step 25] --match <regex> [--replay dir] [--max-miss n]');
  process.exit(2);
}
const MS = Number(o.ms), STEP = Number(o.step), WORDS = new RegExp(o.match, 'i');
const MAX_MISS = o['max-miss'] ? Number(o['max-miss']) : Infinity;
const RATE = 16000;

const tx = createTranscriber({ log: { log() {}, warn() {}, error: console.error } });
const info = tx.info();
if (info.backend !== 'local' || process.env.GLOSSY_LANGUAGE) {
  console.error('the sweep needs the local backend and GLOSSY_LANGUAGE unset:', info);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glossy-sweep-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));   // exit runs the cleanup above
const wav = path.join(tmp, 'fixture.wav');
execFileSync('say', [...(o.voice ? ['-v', o.voice] : []), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', wav, o.text]);
const pcm = (file, rate = RATE) => {
  const b = execFileSync('ffmpeg', ['-v', 'fatal', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(rate), '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const fixture = pcm(wav);
const loopMs = Math.round(fixture.length / RATE * 1000);

// the server's queue, one job at a time; an error counts as a miss
const decode = (file, opts) => new Promise((resolve) => tx.enqueue('sweep', file, opts, (err, r) => resolve(err ? { error: err.message } : r)));
function judge(r, detectedMode) {
  if (r.error) return { ok: false, why: 'error: ' + r.error };
  const unclear = unclearReason(r.text);
  const ok = !unclear && WORDS.test(r.text) && (!detectedMode || (r.language === o.lang && r.detected && r.words.length > 2));
  return { ok, why: unclear ? `[${unclear}] ${r.text}` : r.text, retried: !!r.retried, ms: r.ms, language: r.language };
}
async function both(file) {
  const det = judge(await decode(file, {}), true);
  const forced = judge(await decode(file, { language: o.lang }), false);
  return { det, forced };
}

// a window of the loop starting at `ms`, wrapped past the end, encoded as the recorder would (Opus, 48 kHz mono, --kbps, default 128 like Chromium's)
function windowFile(startMs) {
  const n = Math.round(MS / 1000 * RATE), s0 = Math.round(startMs / 1000 * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, fixture[(s0 + i) % fixture.length])) * 32767;
  const raw = path.join(tmp, 'w.pcm'), webm = path.join(tmp, 'w.webm');
  fs.writeFileSync(raw, Buffer.from(out.buffer));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', raw, '-ar', '48000', '-c:a', 'libopus', '-b:a', `${o.kbps}k`, webm]);
  return webm;
}

// coarse to fine: every 8th start, then the ones halfway between, and so on
const starts = [];
for (let s = 0; s < loopMs; s += STEP) starts.push(s);
const order = [8, 4, 2, 1].flatMap((k, j) => starts.filter((_, i) => i % k === 0 && (j === 0 || i % (k * 2) !== 0)));
const rangesOf = (ms) => {
  const r = [];
  for (const s of ms.sort((a, b) => a - b)) { const last = r.at(-1); if (last && s - last[1] <= STEP) last[1] = s; else r.push([s, s]); }
  return r.map(([a, b]) => a === b ? `${a}` : `${a}–${b}`).join(', ') || 'none';
};
const took = (m) => (m.ms == null ? 'err' : `${m.ms} ms`).padStart(8);   // an errored decode has no time
const fmt = (s, r) => `${String(s).padStart(5)} ms  det ${r.det.ok ? 'pass' : 'MISS'} ${r.det.retried ? 'retried ' : ''}${took(r.det)}  forced ${r.forced.ok ? 'pass' : 'MISS'} ${r.forced.retried ? 'retried ' : ''}${took(r.forced)}  ${r.det.ok ? '' : `det: ${r.det.language} ${r.det.why.slice(0, 70)}  `}${r.forced.ok ? '' : `forced: ${r.forced.why.slice(0, 70)}`}`;

if (!o.replay) {
  console.log(`sweep: ${o.voice || 'default voice'}, loop ${loopMs} ms, window ${MS} ms, step ${STEP} ms, ${starts.length} starts; ${info.model}`);
  const res = new Map();
  let detMiss = 0;
  for (const s of order) {
    const r = await both(windowFile(s));
    res.set(s, r); if (!r.det.ok) detMiss++;
    console.log(fmt(s, r));
    if (detMiss >= MAX_MISS) { console.log(`stopped after ${detMiss} detected-mode misses`); break; }
  }
  const done = [...res.keys()];
  const miss = (m) => done.filter((s) => !res.get(s)[m].ok);
  const retried = (m) => done.filter((s) => res.get(s)[m].retried);
  console.log(`\nsummary: window ${MS} ms, loop ${loopMs} ms, ${done.length}/${starts.length} starts decoded`);
  for (const m of ['det', 'forced']) console.log(`  ${m === 'det' ? 'detected' : 'forced  '}: ${miss(m).length}/${done.length} misses at ${rangesOf(miss(m))}; retried at ${rangesOf(retried(m))}`);
  process.exit(0);
}

// ---- replay ------------------------------------------------------------------
// Align each clip at 8 kHz: the normalised correlation of its first second
// (from 0.1 s in) against every offset of the loop. A fixture that says its
// sentence twice has two near-equal peaks, a copy apart; when the second is
// within 0.02 of the first, the sweep is checked at both.
const A = 8000, fx8 = pcm(wav, A), L = fx8.length;
function startsOf(clip) {
  const off = Math.round(0.1 * A), n = Math.min(A, clip.length - off);
  let xn = 0;
  for (let i = 0; i < n; i++) xn += clip[off + i] ** 2;
  const c = new Float64Array(L);
  for (let k = 0; k < L; k++) {
    let dot = 0, e = 0;
    for (let i = 0; i < n; i++) { const f = fx8[(k + i) % L]; dot += f * clip[off + i]; e += f * f; }
    c[k] = dot / Math.sqrt(e * xn + 1e-12);
  }
  const peak = (skip) => { let at = -1; for (let k = 0; k < L; k++) if ((skip < 0 || Math.min(Math.abs(k - skip), L - Math.abs(k - skip)) > A) && (at < 0 || c[k] > c[at])) at = k; return at; };
  const p1 = peak(-1), p2 = peak(p1);
  const ms = (k) => Math.round((((k - off) % L + L) % L) / A * 1000);
  return [{ ms: ms(p1), r: c[p1] }, ...(c[p2] >= c[p1] - 0.02 ? [{ ms: ms(p2), r: c[p2] }] : [])];
}
const clips = fs.readdirSync(o.replay, { recursive: true }).filter((f) => f.endsWith('.webm')).map((f) => path.join(o.replay, f)).sort();
console.log(`replay: ${clips.length} clips from ${o.replay}, loop ${loopMs} ms, sweep window ${MS} ms`);
const agree = { det: [0, 0], forced: [0, 0] };
const pf = (r) => `det ${r.det.ok ? 'pass' : 'MISS'} forced ${r.forced.ok ? 'pass' : 'MISS'}`;
for (const file of clips) {
  const at = startsOf(pcm(file, A));
  const stored = await both(file);
  const swept = [];
  for (const a of at) swept.push(await both(windowFile(Math.round(a.ms / STEP) * STEP % (starts.length * STEP))));
  for (const m of ['det', 'forced']) {
    if (stored[m].ok === swept[0][m].ok) agree[m][0]++;
    if (swept.some((w) => w[m].ok === stored[m].ok)) agree[m][1]++;
  }
  console.log(`${path.basename(path.dirname(file))}/${path.basename(file).slice(0, 8)}  clip ${pf(stored)}  ${at.map((a, i) => `start ${a.ms} ms (r ${a.r.toFixed(2)}) sweep ${pf(swept[i])}`).join('  |  ')}${stored.det.ok && stored.forced.ok ? '' : '  clip: ' + (stored.det.ok ? stored.forced : stored.det).why.slice(0, 50)}`);
}
console.log(`\nagreement at the best start: detected ${agree.det[0]}/${clips.length}, forced ${agree.forced[0]}/${clips.length}; at either copy: detected ${agree.det[1]}/${clips.length}, forced ${agree.forced[1]}/${clips.length}`);
process.exit(0);
