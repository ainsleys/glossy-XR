// Reading a recorded viewpoint at a playhead. A pose trace is a list of
// {t, p, q} samples in clip milliseconds, oldest first; playback shows the
// latest sample at or before the playhead, a step rather than a blend, so what
// is drawn is always a pose the author actually held. Pure, so it can be tested
// without a scene.

// Index of the latest sample with t <= ms, or -1 before the first one. `from`
// is where the previous lookup landed: a playhead moving forward walks a step
// or two from there instead of the whole list, and one moving back starts over.
export function sampleAt(samples, ms, from = 0) {
  if (!samples?.length || !(ms >= samples[0].t)) return -1;
  let i = Math.min(Math.max(from, 0), samples.length - 1);
  if (samples[i].t > ms) i = 0;
  while (i + 1 < samples.length && samples[i + 1].t <= ms) i++;
  return i;
}
