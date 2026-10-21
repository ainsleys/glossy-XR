// Ainsley's left thumb on a Quest 3S, 21 Oct 2026: the recording behind the thumb-pad decisions.
// Run: node --test test/unit/quest3s-thumb.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { thumbInFingerFrame } from '../../shared/thumb-joystick.js';

const lines = zlib.gunzipSync(fs.readFileSync(new URL('../fixtures/traces/2026-10-21-257866b7-quest3s-thumb.ndjson.gz', import.meta.url))).toString().trim().split('\n');
const about = JSON.parse(lines[0]).about;
const frames = lines.slice(1).map((l) => JSON.parse(l));
const J = { wrist: 0, thumbTip: 1, indexMeta: 2, indexProx: 3, indexTip: 4, pinkyMeta: 5 };
const pick = (a, k) => [a[3 * J[k]], a[3 * J[k] + 1], a[3 * J[k] + 2]];
const BLOCKS = { tip: [6, 39], knuckle: [39, 66], acrossAway: [66, 93], acrossToward: [93, 120] };

const series = (name) => {
  const [a, z] = BLOCKS[name];
  return frames.filter((f) => f.t >= a * 1000 && f.t < z * 1000).map((f) => ({ t: f.t, ...(f.l ? thumbInFingerFrame({ wrist: pick(f.l, 'wrist'), indexMeta: pick(f.l, 'indexMeta'), indexProx: pick(f.l, 'indexProx'), indexTip: pick(f.l, 'indexTip'), pinkyMeta: pick(f.l, 'pinkyMeta'), thumbTip: pick(f.l, 'thumbTip') }, true) : { along: NaN, across: NaN, off: NaN }) }));
};
// Strokes: full swings of the thumb along the finger. The series crosses its midline with hysteresis
// (`band` either side); one stroke = one excursion to the far side and back.
const strokes = (xs, band) => {
  const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
  let n = 0, high = xs[0] > mid;
  for (const x of xs) {
    if (!high && x > mid + band) { high = true; n++; }
    else if (high && x < mid - band) high = false;
  }
  return n;
};
test(`the Quest 3S tracks the thumb in every frame of the blocks (${about.slice(0, 40)}…)`, () => {
  for (const name of Object.keys(BLOCKS)) {
    const s = series(name);
    assert.ok(s.length > 400, `${name}: ${s.length} frames`);
    const seen = s.filter((x) => Number.isFinite(x.along)).length;
    assert.equal(seen, s.length, `${name}: thumb visible in ${seen}/${s.length} frames`);
    const near = s.filter((x) => x.off <= 0.10).length;
    assert.equal(near, s.length, `${name}: thumb within 10 cm of the finger in ${near}/${s.length} frames (Quest 2 floated 3–6 cm off)`);
  }
});

test('slides along the finger are large and countable: about ten per block, 6–7 cm, as she performed them', () => {
  const tip = series('tip').map((x) => x.along), knuckle = series('knuckle').map((x) => x.along);
  const span = (xs) => Math.max(...xs) - Math.min(...xs);
  assert.ok(span(tip) > 0.06 && span(tip) < 0.12, `tip block spans ${span(tip)} m`);
  assert.ok(span(knuckle) > 0.06 && span(knuckle) < 0.12, `knuckle block spans ${span(knuckle)} m`);
  const nt = strokes(tip, 0.015), nk = strokes(knuckle, 0.015);
  assert.ok(nt >= 9 && nt <= 13, `tip block: ${nt} strokes (she did about 10)`);
  assert.ok(nk >= 8 && nk <= 12, `knuckle block: ${nk} strokes (she did about 10)`);
});

test('her stroke is slow out and fast back, so the direction of the slow phase is the intent', () => {
  // In the tip block the thumb creeps toward the tip and snaps back toward the knuckle; in the knuckle
  // block the reverse. Compare mean speed of frames moving tipward with frames moving knuckleward.
  const speeds = (name) => {
    const s = series(name); const up = [], down = [];
    for (let i = 1; i < s.length; i++) { const v = (s[i].along - s[i - 1].along) / ((s[i].t - s[i - 1].t) / 1000); if (!Number.isFinite(v) || Math.abs(v) < 0.005) continue; (v > 0 ? up : down).push(Math.abs(v)); }
    const mean = (a) => a.reduce((m, x) => m + x, 0) / a.length;
    return { tipward: mean(up), knuckleward: mean(down) };
  };
  const t = speeds('tip'), k = speeds('knuckle');
  assert.ok(t.knuckleward > 1.5 * t.tipward, `tip block: out ${t.tipward.toFixed(3)} m/s vs back ${t.knuckleward.toFixed(3)} m/s`);
  assert.ok(k.tipward > 1.5 * k.knuckleward, `knuckle block: out ${k.knuckleward.toFixed(3)} m/s vs back ${k.tipward.toFixed(3)} m/s`);
});

test('across the finger, the stroke toward the palm is nearly invisible to the joints while the one away from it is not', () => {
  const amp = (name) => { const xs = series(name).map((x) => x.across).filter(Number.isFinite); const sorted = [...xs].sort((a, b) => a - b); return sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]; };
  const away = amp('acrossAway'), toward = amp('acrossToward');
  assert.ok(away > 0.02, `across away from the palm: 5–95 % range ${(away * 100).toFixed(1)} cm`);
  assert.ok(toward < away, `across toward the palm: ${(toward * 100).toFixed(1)} cm, away ${(away * 100).toFixed(1)} cm (occluded by the finger)`);
});
