// node --test: the kinematic gap filler on synthetic hand traces
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillGaps, gaps } from '../../shared/hands-fill.js';

const N = 25;
// a hand of N joints: wrist at w, fingers laid out along +x with a fixed shape, in metres
function hand(w, shape = 1) {
  const a = new Array(N * 3);
  for (let i = 0; i < N; i++) { a[3 * i] = w[0] + 0.02 * i * shape; a[3 * i + 1] = w[1] + 0.005 * (i % 5); a[3 * i + 2] = w[2]; }
  return a;
}
// a stir: the wrist on a circle of radius r in the x/z plane at 20 Hz
function stir(ms, { r = 0.15, hz = 20, period = 1600 } = {}) {
  const frames = [];
  for (let t = 0; t <= ms; t += 1000 / hz) {
    const a = (2 * Math.PI * t) / period;
    frames.push({ t: Math.round(t), l: hand([r * Math.cos(a), 1.15, r * Math.sin(a)]), r: null });
  }
  return { joints: new Array(N).fill('j'), rate: hz, frames };
}
const bones = (a) => { const d = []; for (let i = 1; i < N; i++) d.push(Math.hypot(a[3 * i] - a[3 * (i - 1)], a[3 * i + 1] - a[3 * (i - 1) + 1], a[3 * i + 2] - a[3 * (i - 1) + 2])); return d; };

test('a short gap in a stir is filled along the circle, not across it, and flagged', () => {
  const h = stir(3000);
  const drop = h.frames.filter((f) => f.t > 1000 && f.t < 1400);     // 350 ms gone
  for (const f of drop) f.l = null;
  assert.equal(gaps(h).l.length, 1);
  const out = fillGaps(h);
  assert.equal(out.filled.l, drop.length);
  assert.equal(out.filled.gaps, 1);
  for (const f of out.frames) assert.ok(f.l, 'every frame has a left hand again');
  const flagged = out.frames.filter((f) => f.lf);
  assert.equal(flagged.length, drop.length);
  // the reconstructed wrist stays near the circle: radius within 2 cm
  for (const f of flagged) assert.ok(Math.abs(Math.hypot(f.l[0], f.l[2]) - 0.15) < 0.02, `radius at ${f.t}: ${Math.hypot(f.l[0], f.l[2])}`);
  // a chord would cut inside: the midpoint of a 350 ms arc on a 1.6 s period lies ~3.5 cm inside the circle
  const mid = flagged[Math.floor(flagged.length / 2)];
  assert.ok(Math.hypot(mid.l[0], mid.l[2]) > 0.13);
  // the originals are untouched and the input was not mutated
  assert.equal(h.frames.filter((f) => !f.l).length, drop.length);
  assert.equal(gaps(out).l.length, 1, 'gaps() still reports the filled span, from the flags');
});

test('bone lengths survive a shape change across the gap', () => {
  const h = stir(2000);
  // the hand opens (shape 1 → 1.5) across a 300 ms gap
  for (const f of h.frames) if (f.t >= 1000) f.l = hand([f.l[0], f.l[1], f.l[2]], 1.5);
  const drop = h.frames.filter((f) => f.t > 700 && f.t < 1000);
  for (const f of drop) f.l = null;
  const out = fillGaps(h);
  const before = bones(h.frames.find((f) => f.t === 700).l), after = bones(h.frames.find((f) => f.t === 1000).l);
  for (const f of out.frames.filter((f) => f.lf)) {
    const u = (f.t - 700) / 300, b = bones(f.l);
    for (let i = 0; i < b.length; i++) assert.ok(Math.abs(b[i] - (before[i] * (1 - u) + after[i] * u)) < 0.002, `bone ${i} at t=${f.t}`);
  }
});

test('long gaps and gaps at the ends are left alone', () => {
  const h = stir(4000);
  for (const f of h.frames) if (f.t < 300) f.l = null;                 // no hand at the start
  for (const f of h.frames) if (f.t > 1000 && f.t < 2500) f.l = null;  // 1.5 s gone
  const out = fillGaps(h);
  assert.equal(out.filled.l, 0);
  assert.equal(out.filled.gaps, 0);
  const g = gaps(out);
  assert.equal(g.l.length, 2);
  assert.ok(g.l[1].frames > 20);
  // a tighter budget could still fill a shorter one
  const h2 = stir(2000); for (const f of h2.frames) if (f.t > 500 && f.t < 800) f.l = null;
  assert.equal(fillGaps(h2, { maxGapMs: 200 }).filled.l, 0);
  assert.ok(fillGaps(h2, { maxGapMs: 400 }).filled.l > 0);
});

test('the right hand is handled on its own and null traces pass through', () => {
  const h = stir(1000);
  for (const f of h.frames) { f.r = f.l; f.l = null; }
  for (const f of h.frames) if (f.t > 400 && f.t < 600) f.r = null;
  const out = fillGaps(h);
  assert.ok(out.filled.r > 0); assert.equal(out.filled.l, 0);
  assert.equal(fillGaps(null), null);
  assert.deepEqual(fillGaps({ joints: [], rate: 20, frames: [] }), { joints: [], rate: 20, frames: [] });
});
