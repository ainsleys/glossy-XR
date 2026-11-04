import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleAt } from '../../shared/pose.js';

// a 10 Hz trace the way the client records it: one sample every 100 ms from t = 0
const trace = Array.from({ length: 31 }, (_, i) => ({ t: i * 100, p: [i / 30, 1.6, 0], q: [0, 0, 0, 1] }));

test('the latest sample at or before the playhead, a step and not a blend', () => {
  assert.equal(sampleAt(trace, 0), 0);
  assert.equal(sampleAt(trace, 99), 0);
  assert.equal(sampleAt(trace, 100), 1);
  assert.equal(sampleAt(trace, 1050), 10);
  assert.equal(sampleAt(trace, 3000), 30);
  assert.equal(sampleAt(trace, 9000), 30);         // past the end it stays on the last sample; the caller decides when the replay is over
});

test('before the first sample, and with no trace, there is nothing to show', () => {
  assert.equal(sampleAt(trace.slice(5), 400), -1);
  assert.equal(sampleAt([], 100), -1);
  assert.equal(sampleAt(null, 100), -1);
  assert.equal(sampleAt(trace, NaN), -1);
});

test('the cursor from the last lookup gives the same answer going forward and after a jump back', () => {
  let i = -1;
  for (let ms = 0; ms <= 3000; ms += 16) { i = sampleAt(trace, ms, i); assert.equal(i, Math.floor(ms / 100)); }
  assert.equal(sampleAt(trace, 250, 30), 2);       // the playhead went back (a replay from the start)
  assert.equal(sampleAt(trace, 250, 99), 2);       // a cursor past the end of a shorter trace
});
