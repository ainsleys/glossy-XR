# 001 · Viewpoint replay in the scene

## Problem

Every clip stores the author's viewpoint: `pose`, a list of `{t, p, q}` samples at 10 Hz for the length of the clip (position in scene metres and orientation as a quaternion), and `poseSource`, `xr` for a headset or `desktop` for the mouse-steered camera. The review page already uses it: while a clip plays, an arrow on the plan shows where the author stood and faced at the playhead.

In the scene itself nothing shows it. A listener standing at a marker hears "the water came in over there" and sees the ghost hands, but not where the speaker was or which way they were looking when they said it. The data is recorded, exported and drawn on the plan; it is not drawn where it was made.

## Goal

During playback in the scene, show where the author stood and looked, moving in time with the audio, in the same way the ghost hands show what the author's hands did.

## Requirements

R1. **Marker.** When a clip with `poseSource === 'xr'` plays, draw a viewpoint: a small translucent head (a sphere of about 0.1 m radius) at the sample's `p`, and a gaze line from the head along the orientation's forward direction (−Z of `q`), about 0.6 m long. `p` and `q` are the camera's world position and orientation (rig included), so the marker is added to `scene`, where the markers and the ghost hands live. Use the ghost palette (`SEEN` from `client/src/hands.js`, which must be exported), transparent, `depthWrite: false`, depth test **on** (walls and furniture occlude it, as they do the ghost), `renderOrder` after the ghost, not frustum-culled. The gaze line must be visible in a headset: use `Line2`/`LineMaterial` with `worldUnits` (already imported in hands.js for the trail) or a thin cylinder; a plain `Line` draws one pixel.

R2. **Timing.** At time `t` since playback started, show the latest sample whose `t` is ≤ the elapsed time (a step; interpolation between samples is optional). Updated from the render loop, where `ghost.update(...)` is called, with the same `playStartedAt` clock. **Span guard:** once elapsed time passes the last sample's `t` plus one sample interval (100 ms at 10 Hz), the marker hides itself, as `GhostHands` does with `inSpan`, so it can never freeze at its last sample if no stop path runs.

R3. **Lifecycle.** Shown when `play(id)` starts a clip that qualifies; hidden in `stopAll()` and in the sound's `onEnded` handler, which between them cover every start/stop path in the code today (autoplay on approach, the control channel's `play`/`stop`, the list button, XR pinch/trigger, mouse, Space, clicking the playing clip again, the year slider). **One path does not go through them:** `removeMarker` (called by `clearMarkers` on project switch, by delete, and by a remote `annotation:deleted`) stops the sound directly, which clears `onended`, so neither the ghost nor the viewpoint would be hidden. Fix it in this change: when `removeMarker` removes the playing clip (`id === playingId`), call `stopAll('removed')` before removing. This also fixes the ghost hands on that path; say so in the commit.

R4. **Desktop poses are not drawn.** A `desktop` trace is where the virtual camera pointed, not a gaze; the README already tells readers to treat it that way. No flag, no dimmed variant: not drawn.

R5. **Don't draw inside the listener's head.** If the listener's camera is within 0.4 m of the head sphere, hide the sphere and keep the gaze line. The listener's world position is the `near` vector the render loop already fills with `camera.getWorldPosition(near)` just before the ghost update; reuse it (one frame stale in XR is fine).

R6. **Works in XR and on the desktop** (the marker is in scene space; playback on the desktop of a headset-recorded clip shows it).

R7. **Test exposure.** In DEV, `window.__glossy.viewpoint` exposes `{ visible, headShown, position }`: `visible` is the group's visibility (the marker is being replayed), `headShown` whether the sphere is currently drawn (false under R5), `position` the current sample's `p` as `[x, y, z]`. Alongside the existing `ghost`.

R8. **Session log.** `play:start` data gains `viewpoint: <boolean>` (true when the clip qualifies under R1), next to the existing `hands`.

R9. **README.** The "Annotation record" paragraph on `pose` says the page draws it on playback; the test-coverage paragraph mentions it; in the Roadmap line that begins "Review page: drag a photograph…", remove only the clause about the pose trace being drawn in the scene as well as on the plan and keep the rest of the line.

## Non-goals

- No change to how the pose is recorded, its rate, or its shape in the record or the exports.
- No change to the review page.
- No drawing of desktop-recorded poses.
- No new setting or URL flag.
- No change to the hands, the markers or the panel beyond what R1–R3 need (exporting `SEEN` from hands.js and the `removeMarker` fix in R3 are allowed).
- No change to the playback clock. Known limit, shared with the ghost: `playStartedAt` is `performance.now()` after `sound.play()`, and if the AudioContext was suspended the audio starts late while the clock runs. `listener.context.currentTime` minus the sound's start would be exact for both; that is a separate change.
- No work on the pre-existing failing test `test/desktop.spec.js:278` ("a click released before the microphone is ready…"); it is tracked separately and this change must not modify it.

## Design

A new module `client/src/viewpoint.js` exporting `class Viewpoint` with the same interface as `GhostHands`: `constructor(parent)`, `show(pose)`, `hide()`, `update(tMs)`, `get visible`, plus `setListener(position)` or an `update(tMs, listenerPosition)` signature for R5. Geometry: one `SphereGeometry` mesh and one `Line` (or thin cylinder) for the gaze, in a `Group`. Orientation: forward = `(0, 0, −1)` rotated by `q`.

`main.js`: construct it next to `ghost`; in `play()`, after `ghost.show(...)`, call `viewpoint.show(m.record.pose)` when `m.record.poseSource === 'xr' && m.record.pose?.length`, else `viewpoint.hide()`; in `stopAll()` and the `onEnded` handler, `viewpoint.hide()`; in `removeMarker`, `if (id === playingId) stopAll('removed')` before the removal; in the loop, next to the ghost update, `if (viewpoint.visible) viewpoint.update(performance.now() - playStartedAt, near)`; add to `window.__glossy`; add `viewpoint` to the `play:start` log data. No dispose is needed: like the ghost, it lives for the page. Do not add hooks on the individual play paths listed in R3; they all reach `play`/`stopAll`.

Sample lookup (latest sample with `t ≤ elapsed`) may live in `shared/` as a pure function so a unit test can cover it; optional.

## Tests

T1. `test/xr.spec.js`, in "with hands tracked, speaking starts a clip, the gesture is stored and replays as ghost hands": that test already records a headset clip (`poseSource: 'xr'`) and plays it. The emulated headset never moves, so the listener stands exactly where the author stood: every pose sample is the same point and R5 applies throughout. Add, beside the existing ghost visible/hidden polls: after `play(id)`, `__glossy.viewpoint.visible` is true, `headShown` is false (R5), and `position` is within 0.05 m of `a.pose[0].p`; after the clip ends, `visible` is false. Also assert `a.pose[0].p` ≈ the rig-to-world transform of the emulated device position (guards the XR world-matrix caveat), and that the `play:start` event carries `viewpoint: true` (flush the log and fetch events, as the test already does for other events).

T2. `test/desktop.spec.js`, in "records, saves, plays back, and deletes an annotation": after the `playingId` poll confirms playback, assert `__glossy.viewpoint.visible` is false (desktop pose, R4). Then flush the log and assert the `play:start` event carries `viewpoint: false`; this is the real assertion, since `visible` is false before play too.

T3. **New desktop test for R2, R5, R6 and the delete path.** Create a clip through the API with `poseSource: 'xr'` and a synthetic moving pose (for example `x` from 0 to 1 m over 3 s at 10 Hz) and a short audio file, open the page on the desktop, play it, and assert: `visible` true and `position` advancing past `pose[0].p` after ~1 s; `headShown` true while the camera is far from the head and false after aiming/moving the camera within 0.4 m; hidden after deleting the clip mid-play (R3's `removeMarker` fix). Use the existing helpers (`openProject`, `aimCamera`, `listAnnotations`); the hands test writes a clip through the API already, so the multipart shape is known.

T4. Optional unit test for the sample-lookup function in `test/unit/`.

## Definition of done

- R1–R9 implemented; T1, T2 and T3 added and passing.
- `npm test` passes, with the single pre-existing failure at `test/desktop.spec.js:278` as the only failure, unchanged.
- README updated as in R9.
- PR description describes the feature and the tests, nothing else.

## Decisions (2 Nov)

1. `removeMarker` is in scope: it is the one stop path that bypasses `stopAll`, and it already leaves the ghost hands behind on project switch and delete. Fixed here via `stopAll('removed')`.
2. A span guard in `Viewpoint.update` is required, not optional: the step lookup has no natural end.
3. `visible` and `headShown` are separate, because in the emulated XR test the listener stands on the author's spot and R5 hides the sphere for the whole clip.
4. Desktop poses stay undrawn (R4).
5. Walls occlude the marker (depth test on). A viewpoint seen through a wall would mislead more than it helps.
6. The gaze line is `Line2`/`LineMaterial` with world units or a cylinder, never a 1 px `Line`.
7. The playback clock is unchanged; the AudioContext-resume drift is shared with the ghost and noted as a follow-up.
8. The pre-existing failure at `test/desktop.spec.js:278` cannot be affected by this change (it never plays or deletes); it stays as the only allowed failure.
