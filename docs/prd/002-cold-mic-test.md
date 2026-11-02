# 002 · The cold-microphone test asserts what the room does

## Problem

`test/desktop.spec.js`, "a click released before the microphone is ready does not leave the recorder stuck" (currently at line 278 on `main`), fails on every run. It presses and releases the mouse before the microphone has been opened, then polls the status line for `/too short|^saved/`. Since the change that made a slipped press silent (`endRecording` in `client/src/main.js`: a clip shorter than the minimum is discarded with `setStatus('')`, logged as `record:discarded {reason: 'too short'}`), the status line never says "too short". The room behaves as intended; the test asserts the old behaviour. With it failing, the suite is never green and a real regression would hide behind it.

## Goal

The test checks the behaviour that matters (the early release is honoured, the recorder is not left recording, and the next normal hold works) through state the page exposes, so the suite is green on `main`.

## Requirements

R1. The test asserts, after the instant press-and-release on a cold microphone, that the session log contains a `record:discarded` event with `reason: 'too short'` and `source: 'mouse'` (or a `record:saved` event, if the microphone happened to be ready and the clip long enough; the test's intent is "not stuck", not "discarded"), using `window.__glossy.log.flush()` and `GET /api/projects/:id/events` the way `test/desktop.spec.js` "the session log records a session…" and `test/xr.spec.js` already do.

R2. The test asserts `window.__glossy.recorder.isRecording === false` by polling, not by a single read (the discard happens after an awaited `recorder.start()`).

R3. The test keeps its final step: a normal hold (`recordWithMouse`) afterwards produces one marker.

R4. The test's title stays as it is, so history and references to it still resolve.

R5. No change to `client/` code. If, while making the test pass, the implementer finds that the early-release path does not actually produce the `record:discarded` event (that is, the room is stuck or silent for another reason), stop and report rather than change the room; that would be a different change with its own specification.

## Non-goals

- No change to the behaviour of a slipped press: it stays silent.
- No change to `recordWithMouse`, `lockPointer` or the other helpers.
- No other test is modified.

## Design

Replace the `expect.poll(() => status(page)).toMatch(/too short|^saved/)` line with: flush the log, poll the events endpoint until an event of kind `record:discarded` or `record:saved` for this session appears, assert its `reason`/`source`, then `expect.poll(() => isRecording).toBe(false)`. The helpers for events are in the two tests named in R1; factor a small `eventsOf(request, projectId)` helper into `test/helpers.js` only if both existing call sites can use it unchanged; otherwise inline.

## Tests

T1. The rewritten test itself. Mutation: in `endRecording`, make the too-short branch not log `record:discarded` (comment out the `log(...)` call). The test must fail. Restore.

T2. Stability: run the test with `--repeat-each=5`; 5/5 must pass.

## Definition of done

- The test passes; `npm test` at the final commit has zero failures (the optional interior scene test may be skipped where the asset is absent).
- T1's mutation shown to fail; T2's result in the pull request.
- README: the test-coverage paragraph's phrase "a click released before the microphone is ready" still describes the test; no README change needed unless the implementer finds that phrase inaccurate.

## Decisions

(Filled in after the specification review.)
