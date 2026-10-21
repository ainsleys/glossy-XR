import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlideDetector } from '../../shared/thumb-slide.js';

// Ainsley's thumb, 21 Oct: ~4 cm out and back in ~1 s, hovering 3 cm off the finger, at 15 Hz.
function run(cycles, { amp = 0.04, periodMs = 1000, off = 0.03, hz = 15, backFast = false } = {}) {
  const d = new SlideDetector(), out = [];
  let t = 0;
  for (let c = 0; c < cycles; c++) {
    const half = periodMs / 2, steps = Math.round((half / 1000) * hz);
    for (let i = 1; i <= steps; i++) { t += 1000 / hz; out.push(d.sample(t, 0.02 + amp * i / steps, off)); }          // out, toward the tip
    const backSteps = backFast ? 2 : steps;
    for (let i = 1; i <= backSteps; i++) { t += 1000 / hz; out.push(d.sample(t, 0.02 + amp * (1 - i / backSteps), off)); }   // and back
    for (let i = 0; i < 3; i++) { t += 1000 / hz; out.push(d.sample(t, 0.02, off)); }                                  // a rest
  }
  return out.filter(Boolean);
}
test('a slow out-and-back slide is one push, and the way back is not a brake', () => {
  assert.deepEqual(run(5), ['push', 'push', 'push', 'push', 'push']);
});
test('a fast flick back is a brake', () => {
  assert.deepEqual(run(2, { backFast: true }), ['push', 'brake', 'push', 'brake']);
});
test('a thumb far from the finger, or a tiny wobble, is nothing', () => {
  assert.deepEqual(run(3, { off: 0.09 }), []);
  assert.deepEqual(run(3, { amp: 0.015 }), []);
});
test('a tracking gap resets so the first sample after it cannot look like a slide', () => {
  const d = new SlideDetector();
  d.sample(0, 0.02, 0.03); d.sample(70, 0.021, 0.03);
  assert.equal(d.sample(3000, 0.06, 0.03), null);   // 4 cm "jump" across a 3 s gap
});
