// The thumb as a joystick on the index finger, read from the tracked joints.
//
// Per frame the caller gives the thumb tip in the index finger's frame: `along`
// metres from the finger's proximal joint toward the tip, `across` metres in the
// palm plane perpendicular to the finger (positive = away from the palm's middle
// finger side), `off` metres from the finger's axis. A rest point follows the
// thumb slowly while it is still; an excursion of EXC_M from rest fires once,
// in one of four directions, and nothing else fires until the thumb is back
// within HOME_M of rest. The way back therefore never counts (the problem the
// earlier reader had), and the hand's own drift is removed because everything
// is relative to the finger. The direction → intent map is the caller's: on
// Ainsley's left hand (recorded 21 Oct 2026) toward the tip meant left and
// toward the knuckle meant right.
export const EXC_M = 0.022, HOME_M = 0.011, OFF_MAX = 0.10, STILL_V = 0.035, DWELL_MS = 350, RESET_MS = 1200;   // OFF_MAX generous: her thumb hovers up to 6 cm off the finger

// Rest is where the thumb dwells. A back-and-forth stroke has two ends; the one the thumb pauses at
// (DWELL_MS below STILL_V) is rest, and the excursion is the move away from it. Without this a rest
// point that merely follows the thumb can settle at either end, and the same stroke reads as tip one
// time and knuckle the next (seen on the 21 Oct recording when the off-axis limit was changed).
export class ThumbJoystick {
  /** @param {{excM?:number, homeM?:number, offMax?:number, stillV?:number, dwellMs?:number, resetMs?:number, alongDeg?:number}} [opts] */
  constructor(opts = {}) {
    this.excM = opts.excM ?? EXC_M; this.homeM = opts.homeM ?? HOME_M; this.offMax = opts.offMax ?? OFF_MAX;
    this.stillV = opts.stillV ?? STILL_V; this.dwellMs = opts.dwellMs ?? DWELL_MS; this.resetMs = opts.resetMs ?? RESET_MS;
    this.alongDeg = opts.alongDeg ?? 45;                                   // half-angle of the tip/knuckle sectors
    this.reset();
  }
  reset() { this.rest = null; this.away = false; this.peak = null; this.lastT = 0; this.last = null; this.stillSince = 0; }
  /** @returns {{dir: 'tip'|'knuckle'|'across+'|'across-', size: number, angle: number} | null} once per excursion */
  sample(now, along, across, off) {
    if (off > this.offMax || !Number.isFinite(along) || !Number.isFinite(across)) return null;   // too far from the finger: skip the sample, keep the state
    if (this.lastT && now - this.lastT > this.resetMs) this.reset();
    this.lastT = now;
    const prev = this.last; this.last = [now, along, across];
    const v = prev ? Math.hypot(along - prev[1], across - prev[2]) / Math.max(1e-3, (now - prev[0]) / 1000) : 0;
    if (v < this.stillV) { if (!this.stillSince) this.stillSince = now; } else this.stillSince = 0;
    const dwelling = this.stillSince && now - this.stillSince >= this.dwellMs;
    if (!this.rest) { if (dwelling) this.rest = [along, across]; return null; }   // the first rest is the first dwell
    const dx = along - this.rest[0], dy = across - this.rest[1], m = Math.hypot(dx, dy);
    if (dwelling && m >= this.homeM) { this.rest = [along, across]; this.away = false; return null; }   // dwelling somewhere else: that is the new rest, no event
    if (!this.away) {
      if (m >= this.excM) {
        this.away = true; this.peak = { m, dx, dy };
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const dir = Math.abs(angle) <= this.alongDeg ? 'tip' : Math.abs(angle) >= 180 - this.alongDeg ? 'knuckle' : angle > 0 ? 'across+' : 'across-';
        return { dir, size: m, angle };
      }
      return null;
    }
    if (m > this.peak.m) this.peak = { m, dx, dy };
    if (m < this.homeM) this.away = false;                                    // home again: re-armed
    return null;
  }
}

/** The finger frame from world joint positions (arrays of x,y,z). Returns {along, across, off} of the thumb tip. */
export function thumbInFingerFrame({ wrist, indexMeta, indexProx, indexTip, pinkyMeta, thumbTip }, left = true) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const u = norm(sub(indexTip, indexProx));
  let n = norm(cross(sub(indexMeta, wrist), sub(pinkyMeta, wrist))); if (!left) n = n.map((x) => -x);   // out of the back of the hand
  const w = norm(cross(n, u));                                                                            // across the finger, in the palm plane
  const d = sub(thumbTip, indexProx);
  const along = dot(d, u), across = dot(d, w), up = dot(d, n);
  return { along, across, off: Math.hypot(across, up) };
}
