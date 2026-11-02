# 001 · Viewpoint replay in the room

## Problem

Every clip stores the author's viewpoint: `pose`, a list of `{t, p, q}` samples at 10 Hz for the length of the clip (position in scene metres and orientation as a quaternion), and `poseSource`, `xr` for a headset or `desktop` for the mouse-steered camera. The review page already uses it: while a clip plays, an arrow on the plan shows where the author stood and faced at the playhead.

In the room itself nothing shows it. A listener standing at a marker hears "the water came in over there" and sees the ghost hands, but not where the speaker was or which way they were looking when they said it. The data is recorded, exported and drawn on the plan; it is not drawn where it was made.

## Goal

During playback in the room, show where the author stood and looked, moving in time with the audio, in the same way the ghost hands show what the author's hands did.

## Requirements

R1. **Marker.** When a clip with `poseSource === 'xr'` plays, draw a viewpoint: a small translucent head (a sphere of about 0.1 m radius) at the sample's `p`, and a gaze line from the head along the orientation's forward direction (−Z of `q`), about 0.6 m long. Use the ghost palette (`SEEN` colour from `client/src/hands.js`), transparent, `depthWrite: false`, not frustum-culled, so it reads the way the ghost hands do.

R2. **Timing.** At time `t` since playback started, show the latest sample whose `t` is ≤ the elapsed time (a step; interpolation between samples is optional). Updated from the render loop, where `ghost.update(...)` is called, with the same `playStartedAt` clock.

R3. **Lifecycle.** Shown when `play(id)` starts a clip that qualifies; hidden wherever `ghost.hide()` is called (stop, another clip starting, clip ended, project change).

R4. **Desktop poses are not drawn.** A `desktop` trace is where the virtual camera pointed, not a gaze; the README already tells readers to treat it that way. No flag, no dimmed variant: not drawn.

R5. **Don't draw inside the listener's head.** If the listener's camera is within 0.4 m of the head sphere, hide the sphere and keep the gaze line.

R6. **Works in XR and on the desktop** (the marker is in scene space; playback on the desktop of a headset-recorded clip shows it).

R7. **Test exposure.** In DEV, `window.__glossy.viewpoint` exposes `{ visible, position }` (position as `[x, y, z]` of the current sample), alongside the existing `ghost`.

R8. **Session log.** `play:start` data gains `viewpoint: <boolean>` (true when the clip qualifies under R1), next to the existing `hands`.

R9. **README.** The "Annotation record" paragraph on `pose` says the room draws it on playback; the test-coverage paragraph mentions it; the Roadmap line "the pose trace drawn in the room as well as on the plan" is removed.

## Non-goals

- No change to how the pose is recorded, its rate, or its shape in the record or the exports.
- No change to the review page.
- No drawing of desktop-recorded poses.
- No new setting or URL flag.
- No change to the hands, the markers or the panel beyond what R1–R3 need.
- No work on the pre-existing failing test `test/desktop.spec.js:278` ("a click released before the microphone is ready…"); it is tracked separately and this change must not modify it.

## Design

A new module `client/src/viewpoint.js` exporting `class Viewpoint` with the same interface as `GhostHands`: `constructor(parent)`, `show(pose)`, `hide()`, `update(tMs)`, `get visible`, plus `setListener(position)` or an `update(tMs, listenerPosition)` signature for R5. Geometry: one `SphereGeometry` mesh and one `Line` (or thin cylinder) for the gaze, in a `Group`. Orientation: forward = `(0, 0, −1)` rotated by `q`.

`main.js`: construct it next to `ghost`; in `play()`, after `ghost.show(...)`, call `viewpoint.show(m.record.pose)` when `m.record.poseSource === 'xr' && m.record.pose?.length`, else `viewpoint.hide()`; in `stopAll()` and the `onEnded` handler, `viewpoint.hide()`; in the loop, `if (viewpoint.visible) viewpoint.update(performance.now() - playStartedAt, cameraWorldPosition)`; add to `window.__glossy`; add `viewpoint` to the `play:start` log data.

Sample lookup (latest sample with `t ≤ elapsed`) may live in `shared/` as a pure function so a unit test can cover it; optional.

## Tests

T1. `test/xr.spec.js`, in "with hands tracked, speaking starts a clip, the gesture is stored and replays as ghost hands": that test already records a headset clip (`poseSource: 'xr'`) and plays it. Add assertions: after `play(id)`, `__glossy.viewpoint.visible` is true and `__glossy.viewpoint.position` is within 0.05 m of `a.pose[0].p`; after the clip ends, `visible` is false. Also assert the `play:start` event carries `viewpoint: true`. Prefer extending this test over adding a new XR session (each one is slow).

T2. `test/desktop.spec.js`, in "records, saves, plays back, and deletes an annotation": after Space starts playback, assert `__glossy.viewpoint.visible` is false (desktop pose, R4) and the `play:start` event, if checked, carries `viewpoint: false`.

T3. Optional unit test for the sample-lookup function in `test/unit/`.

## Definition of done

- R1–R9 implemented; T1 and T2 added and passing.
- `npm test` passes, with the single pre-existing failure at `test/desktop.spec.js:278` as the only failure, unchanged.
- README updated as in R9.
- PR description describes the feature and the tests, nothing else.

## Decisions

(Filled after review.)
