import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ThumbJoystick, thumbInFingerFrame } from '../../shared/thumb-joystick.js';

// Ainsley's left thumb, 21 Oct 2026, labelled blocks (seconds): see the fixture's first line.
const lines = zlib.gunzipSync(fs.readFileSync(new URL('../fixtures/traces/2026-10-21-dd16d028-thumb.ndjson.gz', import.meta.url))).toString().trim().split('\n');
const meta = JSON.parse(lines[0]), frames = lines.slice(1).map((l) => JSON.parse(l));
const J = Object.fromEntries(meta.joints.map((n, i) => [n, i]));
const pick = (a, n) => [a[3 * J[n]], a[3 * J[n] + 1], a[3 * J[n] + 2]];
function excursionsIn(a, z) {
  const joy = new ThumbJoystick(), out = [];
  for (const f of frames) {
    if (f.t < a * 1000 || f.t >= z * 1000) continue;
    if (!f.l) { joy.reset(); continue; }
    const ff = thumbInFingerFrame({ wrist: pick(f.l, 'wrist'), indexMeta: pick(f.l, 'index-finger-metacarpal'), indexProx: pick(f.l, 'index-finger-phalanx-proximal'), indexTip: pick(f.l, 'index-finger-tip'), pinkyMeta: pick(f.l, 'pinky-finger-metacarpal'), thumbTip: pick(f.l, 'thumb-tip') });
    const e = joy.sample(f.t, ff.along, ff.across, ff.off);
    if (e) out.push(e.dir);
  }
  return out;
}
const count = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const dominant = (c) => Object.entries(c).sort((a, b) => b[1] - a[1])[0];
test('one direction dominates each of her blocks, the way back never counts, and left and right are opposite ends of the finger', () => {
  const fwd = count(excursionsIn(520, 575)), left = count(excursionsIn(614, 633)), right = count(excursionsIn(633, 648));
  for (const [name, c] of [['forward', fwd], ['left', left], ['right', right]]) {
    const [dir, n] = dominant(c); const total = Object.values(c).reduce((a, b) => a + b, 0);
    assert.ok(total >= 8, `${name}: too few excursions ${JSON.stringify(c)}`);
    assert.ok(n / total >= 0.7, `${name}: no dominant direction ${JSON.stringify(c)}`);
    console.log(`  ${name}: ${dir} ${n}/${total}`);
  }
  const l = dominant(left)[0], r = dominant(right)[0];
  assert.ok((l === 'tip' && r === 'knuckle') || (l === 'knuckle' && r === 'tip'), `left ${l} vs right ${r}`);
});
test('her quick flick goes across the finger, not along it', () => {
  const c = count(excursionsIn(575, 614));
  assert.ok(((c['across+'] || 0) + (c['across-'] || 0)) >= 12, JSON.stringify(c));
});
test('a still thumb fires nothing', () => {
  const joy = new ThumbJoystick(); let fired = 0;
  for (let t = 0; t < 5000; t += 50) if (joy.sample(t, 0.05 + 0.002 * Math.sin(t / 300), 0.01 + 0.001 * Math.cos(t / 200), 0.03)) fired++;
  assert.equal(fired, 0);
});
