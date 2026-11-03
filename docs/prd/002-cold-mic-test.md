# 002 · The cold-microphone test asserts what the room does

## Problem

`test/desktop.spec.js`, "a click released before the microphone is ready does not leave the recorder stuck" (currently at line 278 on `main`), fails on every run. It presses and releases the mouse before the microphone has been opened, then polls the status line for `/too short|^saved/`. Since the change that made a slipped press silent (`endRecording` in `client/src/main.js`: a clip shorter than the minimum is discarded with `setStatus('')`, logged as `record:discarded {reason: 'too short'}`), the status line never says "too short". The room behaves as intended; the test asserts the old behaviour. With it failing, the suite is never green and a real regression would hide behind it.

## Goal

The test checks the behaviour that matters (the early release is honoured, the recorder is not left recording, and the next normal hold works) through state the page exposes, so the suite is green on `main`.

## Requirements

R0. **The microphone must actually be cold.** Ticking consent in `prepareRecording` calls `readyMic()`, which opens the fake microphone; by the time the test presses, `recorder.start()` resolves within microtasks and the release lands on an already-recording clip, so the early-release path (`releasedEarly` in `releaseRecording`/`beginRecording`) is never exercised. The test waits for `window.__glossy.recorder.live` to be true (so the consent `readyMic()` is not still in flight), then closes the microphone with `page.evaluate(() => window.__glossy.recorder.release())`, then dispatches `mousedown` and `mouseup` on the canvas inside one `page.evaluate` (two `MouseEvent`s, button 0, in the same task), so the release is guaranteed to arrive while `starting` is set.

R1. The test then asserts, in this order: a poll of `{ live: recorder.live, isRecording: recorder.isRecording }` until it equals `{ live: true, isRecording: false }` (the microphone opened again and the recorder is not recording; `isRecording` on its own proves nothing, because it is already false before the microphone opens, so a plain poll on it passes at once even when the early release is ignored); then `window.__glossy.log.flush()`; then a poll of the events endpoint (`GET /api/projects/:id/events`, the way `test/desktop.spec.js` "the session log records a session…" does) until the `record:discarded`/`record:saved` events for the project are exactly one `record:discarded` with `reason: 'too short'` and `source: 'mouse'`. Flushing before the event exists sends nothing, so the recorder poll comes first. No "or saved" alternative: with a forced-cold microphone and an instant release the clip is always under the 300 ms minimum.

R2. (merged into R1: the recorder poll.)

R3. The test keeps its final step: a normal hold (`recordWithMouse`) afterwards produces one marker.

R4. The test's title stays as it is, so history and references to it still resolve.

R5. No change to `client/` code. If, while making the test pass, the implementer finds that the early-release path does not actually produce the `record:discarded` event (that is, the room is stuck or silent for another reason), stop and report rather than change the room; that would be a different change with its own specification.

## Non-goals

- No change to the behaviour of a slipped press: it stays silent.
- No change to `recordWithMouse`, `lockPointer` or the other helpers.
- No other test is modified.

## Design

Replace the `expect.poll(() => status(page)).toMatch(/too short|^saved/)` line and the `isRecording` check after it with, in order: the recorder poll on `{ live: true, isRecording: false }`, a log flush, and a poll of the events endpoint, filtered to `record:discarded` and `record:saved` (inline as `clipEvents`), until it equals one `record:discarded` with `reason: 'too short'` and `source: 'mouse'`. The events request is inlined; no helper was factored into `test/helpers.js`.

## Tests

T1. The rewritten test itself. Primary mutation, matching the test's title: in `releaseRecording`, remove only the statement `releasedEarly = true;` (it shares a line with the `if (starting === source)` guard, which stays), so an early release is ignored and the recorder stays recording. The test must fail at the recorder poll (received `{ live: true, isRecording: true }`). Restore. Secondary mutation: in `endRecording`'s too-short branch, remove the `record:discarded` log call; the test must fail at the events poll. Restore.

T2. Stability: run the test with `--repeat-each=5`; 5/5 must pass.

## Definition of done

- The test passes; `npm test` at the final commit has zero failures (the optional interior scene test may be skipped where the asset is absent).
- T1's mutation shown to fail; T2's result in the pull request.
- README: the test-coverage paragraph's phrase "a click released before the microphone is ready" still describes the test; no README change needed unless the implementer finds that phrase inaccurate.

## Decisions (2 Nov)

1. The first draft's assertion would have passed without exercising the early-release path, because the microphone is already open when the test presses (consent → `readyMic`). Hence R0: force it cold with `recorder.release()` and send both mouse events in one task.
2. "Discarded or saved" dropped: with a cold microphone and an instant release, saved is unreachable.
3. Order of assertions fixed (`isRecording` first, then flush, then events), because a flush before the event exists sends nothing and the poll would then wait on the 2 s timer.
4. The mutation that proves the test is the one that breaks the early release, not the one that removes a log line.
5. Noted, out of scope: `recorder.start()` racing a `readyMic()` still in flight opens a second stream and never stops the first (an orphaned track). Not a block, not this change.
6. A third mutation, removing `if (releasedEarly) endRecording();` from `beginRecording`, also fails the test at the recorder poll (received `{ live: true, isRecording: true }`), as does the primary one.
