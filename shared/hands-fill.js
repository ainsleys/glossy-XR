// Filling short tracking gaps in a hand trace. Shared by the server (which
// fills at save time and flags what it filled) and by anything that wants to
// redo it from the raw frames.
//
// A headset loses a hand for a moment when it goes behind the other hand, out
// to the side, or below the cameras' view, and the trace records null for
// those frames. For gaps up to `maxGapMs` with a tracked frame on both sides
// the hand is reconstructed: the wrist follows a cubic Hermite curve whose end
// velocities come from the frames just outside the gap (so a stir keeps
// turning instead of cutting a chord), and the hand's shape, every joint as an offset from the wrist, is
// blended linearly from the shape before the gap to the shape after it, with
// each finger chain rescaled so bone lengths stay what they were. Longer gaps,
// and gaps at either end of the clip, are left as they are: there is nothing
// to interpolate towards.
//
// Every reconstructed frame is flagged (`lf` / `rf` true) and the trace gets a
// `filled` summary, so a reader, an export, or a stricter analysis can tell
// what was seen from what was inferred, or put the nulls back. This is the
// kinematic baseline; a learned hand-motion prior would plug in at `shapeAt`.

const CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8, 9], [0, 10, 11, 12, 13, 14], [0, 15, 16, 17, 18, 19], [0, 20, 21, 22, 23, 24]];

const r3 = (n) => Math.round(n * 1000) / 1000;
const get = (a, i) => [a[3 * i], a[3 * i + 1], a[3 * i + 2]];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// Cubic Hermite between p1 (at t1) and p2 (at t2) with velocities m1, m2 in
// metres per ms, at time t. Velocities come from the neighbouring tracked
// frames with their real timing, so a 50 ms step on each side and a 350 ms
// gap in the middle do not get treated as equal intervals (uniform
// Catmull-Rom would, and the curve would sag towards the chord).
function hermite(p1, m1, p2, m2, t1, t2, t) {
  const dt = t2 - t1, u = (t - t1) / dt, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return [0, 1, 2].map((k) => h00 * p1[k] + h10 * dt * m1[k] + h01 * p2[k] + h11 * dt * m2[k]);
}
const velocity = (pa, ta, pb, tb) => (tb === ta ? [0, 0, 0] : [0, 1, 2].map((k) => (pb[k] - pa[k]) / (tb - ta)));
// the tracked frame at least VEL_MS (at most VEL_MAX_MS) away from the gap's edge in direction dir, as a velocity baseline; undefined when there is none
const VEL_MS = 100, VEL_MAX_MS = 250;
function reach(tracked, k, dir, frames, tEdge) {
  let found;
  for (let j = k + dir; j >= 0 && j < tracked.length; j += dir) {
    const d = Math.abs(frames[tracked[j]].t - tEdge);
    if (d > VEL_MAX_MS && found !== undefined) break;
    found = tracked[j];
    if (d >= VEL_MS) break;
  }
  return found;
}

// the shape (joint offsets from the wrist) blended between two tracked hands,
// with each finger chain rescaled to the blended bone lengths of the originals
function shapeAt(a, b, u, nJoints) {
  const wa = get(a, 0), wb = get(b, 0);
  const off = new Array(nJoints);
  for (let i = 0; i < nJoints; i++) {
    const pa = get(a, i), pb = get(b, i);
    off[i] = [0, 1, 2].map((k) => (pa[k] - wa[k]) * (1 - u) + (pb[k] - wb[k]) * u);
  }
  for (const chain of CHAINS) {
    for (let c = 1; c < chain.length; c++) {
      const i = chain[c], j = chain[c - 1];
      if (i >= nJoints || j >= nJoints) continue;
      const want = dist(get(a, i), get(a, j)) * (1 - u) + dist(get(b, i), get(b, j)) * u;
      const v = [0, 1, 2].map((k) => off[i][k] - off[j][k]);
      const have = Math.hypot(...v) || 1e-9;
      const s = want / have;
      const fixed = [0, 1, 2].map((k) => off[j][k] + v[k] * s);
      const delta = [0, 1, 2].map((k) => fixed[k] - off[i][k]);
      // move this joint and everything further along the chain by the same correction
      for (let d = c; d < chain.length; d++) { const m = chain[d]; if (m < nJoints) off[m] = [0, 1, 2].map((k) => off[m][k] + delta[k]); }
    }
  }
  return off;
}

/**
 * @param {{joints: string[], rate: number, frames: {t:number, l:number[]|null, r:number[]|null}[]}} hands
 * @param {{maxGapMs?: number}} [opts]
 * @returns the same shape with gaps filled, frames flagged `lf`/`rf`, and `filled: {l, r, gaps, maxGapMs}`
 */
export function fillGaps(hands, { maxGapMs = 1000 } = {}) {
  if (!hands?.frames?.length) return hands;
  const nJoints = hands.joints.length;
  const frames = hands.frames.map((f) => ({ t: f.t, l: f.l ? f.l.slice() : null, r: f.r ? f.r.slice() : null }));
  const filled = { l: 0, r: 0, gaps: 0, maxGapMs };
  for (const side of ['l', 'r']) {
    const flag = side + 'f';
    const tracked = [];                                   // indices of frames with this hand
    frames.forEach((f, i) => { if (f[side]) tracked.push(i); });
    for (let k = 0; k + 1 < tracked.length; k++) {
      const ia = tracked[k], ib = tracked[k + 1];
      if (ib - ia < 2) continue;                          // adjacent: no gap
      const gapMs = frames[ib].t - frames[ia].t;
      if (gapMs > maxGapMs) continue;                     // too long to guess
      const a = frames[ia][side], b = frames[ib][side];
      const p1 = get(a, 0), p2 = get(b, 0), t1 = frames[ia].t, t2 = frames[ib].t;
      // wrist velocity entering and leaving the gap, over the tracked frames just outside it. One frame
      // step is too short a baseline at 20 Hz (tracker jitter, or a timer that delivered two steps in one
      // tick, doubles or halves it), so the baseline reaches back at least VEL_MS where frames exist.
      const i0 = reach(tracked, k, -1, frames, t1), i3 = reach(tracked, k + 1, +1, frames, t2);
      let m1 = i0 !== undefined ? velocity(get(frames[i0][side], 0), frames[i0].t, p1, t1) : null;
      let m2 = i3 !== undefined ? velocity(p2, t2, get(frames[i3][side], 0), frames[i3].t) : null;
      if (!m1 && !m2) m1 = m2 = velocity(p1, t1, p2, t2);
      m1 = m1 || m2; m2 = m2 || m1;
      for (let i = ia + 1; i < ib; i++) {
        const u = (frames[i].t - t1) / gapMs;
        const wrist = hermite(p1, m1, p2, m2, t1, t2, frames[i].t);
        const off = shapeAt(a, b, u, nJoints);
        const arr = new Array(nJoints * 3);
        for (let j = 0; j < nJoints; j++) for (let c = 0; c < 3; c++) arr[3 * j + c] = r3(wrist[c] + off[j][c]);
        frames[i][side] = arr; frames[i][flag] = true;
        filled[side]++;
      }
      filled.gaps++;
    }
  }
  return { ...hands, frames, filled };
}

/** Gaps as the tracker left them: spans of null per hand, for a report or a test. */
export function gaps(hands) {
  const out = { l: [], r: [] };
  if (!hands?.frames?.length) return out;
  for (const side of ['l', 'r']) {
    let start = null;
    hands.frames.forEach((f, i) => {
      const missing = !f[side] || f[side + 'f'];
      if (missing && start === null) start = i;
      if (!missing && start !== null) { out[side].push({ from: hands.frames[start].t, to: f.t, frames: i - start }); start = null; }
    });
    if (start !== null) out[side].push({ from: hands.frames[start].t, to: hands.frames.at(-1).t, frames: hands.frames.length - start, open: true });
  }
  return out;
}
