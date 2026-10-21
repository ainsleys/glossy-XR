// Reading a thumb slide from the tracked hand, without the headset's recogniser.
//
// Input: the thumb tip in the index finger's frame, every frame: `along` metres
// from the finger's proximal joint toward the tip, `off` metres from that axis.
// Output: 'push' once per excursion toward the tip, 'brake' for a fast flick
// toward the knuckle. Written for the thumb Ainsley actually has (21 Oct 2026):
// it hovers 2 to 4 cm off the finger and travels about 4 cm each way in about
// a second, and the return stroke looks like the outward stroke in reverse. So
// a push is an excursion of PUSH_M above the running minimum, counted once; the
// way back does not count unless it is fast (a deliberate flick, BRAKE_V), which
// a slow return never is. Pure, so it can be tested on recorded traces.
export const PUSH_M = 0.025, BRAKE_M = 0.03, BRAKE_V = 0.12, OFF_MAX = 0.06, GAP_MS = 300, BRAKE_GAP_MS = 120, RESET_MS = 1500;

export class SlideDetector {
  constructor() { this.reset(); }
  reset() { this.min = null; this.max = null; this.lastAt = 0; this.lastSample = null; this.pushedAt = 0; this.fallFrom = null; }
  /** @returns {'push'|'brake'|null} */
  sample(now, along, off) {
    if (off > OFF_MAX || !Number.isFinite(along)) { this.lastSample = null; return null; }
    const prev = this.lastSample; this.lastSample = [now, along];
    if (prev && now - prev[0] > RESET_MS) { this.min = this.max = null; this.fallFrom = null; }   // a gap in tracking: start over
    if (this.min === null || along < this.min) { this.min = along; if (this.fallFrom === null) this.max = along; }
    let out = null;
    // outward: rose PUSH_M above the running minimum since the last push
    if (this.fallFrom === null && along - this.min >= PUSH_M && now - this.lastAt >= GAP_MS) {
      out = 'push'; this.lastAt = now; this.pushedAt = now; this.fallFrom = along; this.max = along;
    } else if (this.fallFrom !== null) {
      if (along > this.fallFrom) this.fallFrom = along;                      // still going out: track the top
      // the way back: counts only as a fast, deliberate flick
      if (prev && along < prev[1]) {
        const v = (prev[1] - along) / Math.max(1e-3, (now - prev[0]) / 1000);
        if (this.fallFrom - along >= BRAKE_M && v >= BRAKE_V && now - this.lastAt >= BRAKE_GAP_MS) { out = 'brake'; this.lastAt = now; }   // a flick right after a push is a change of mind, allowed
      }
      if (this.fallFrom - along >= PUSH_M * 0.8) { this.fallFrom = null; this.min = along; }   // back down: re-armed for the next push
    }
    return out;
  }
}
