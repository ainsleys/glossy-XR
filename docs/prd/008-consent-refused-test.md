# 008 · Recording without consent is refused, and that is tested

## Problem

The room refuses to record unless the consent box is ticked: `beginRecording` in `client/src/main.js` logs `record:blocked {reason: 'no consent'}` and shows "tick consent first", and the server rejects any annotation whose `consent` is not `true` (`server/index.js`, the create validation: "consent must be true", HTTP 400). Nothing in the suite exercises either path. `test/desktop.spec.js` only asserts that a consented run produced zero `record:blocked` events. A regression in either gate (the client starting the microphone anyway, or the server accepting a clip without consent) would pass the suite.

## Goal

Both gates are tested, each by the behaviour it owns: the client does not start recording and says why; the server rejects the request.

## Requirements

R1. **Server test.** `POST /api/projects/:id/annotations` with a valid audio part and every required field but `consent` absent, and again with `consent: 'false'`, returns 400 with an error body naming consent; nothing is stored (`GET …/annotations` is empty; no file under `.test-data/audio`). With `consent: 'true'` the same request is accepted (201), as the existing tests already show.

R2. **Client test.** On the desktop page with a name entered and consent **unticked**: a mouse hold on the canvas starts nothing. Assert by polling: `window.__glossy.recorder.isRecording` stays false over a short window, no marker appears, the status says "tick consent first", and after `log.flush()` the session log contains a `record:blocked` event with `reason: 'no consent'` and `source: 'mouse'`. Then tick consent and show a normal hold records (reuse `recordWithMouse`).

R3. **No change to `client/` or `server/`.** If either gate turns out not to behave as described, stop and report; that is a product change with its own specification.

R4. **README.** The test-coverage paragraph gains the phrase "recording refused without consent, by the page and by the server".

## Non-goals

- No change to consent wording, storage or the EDM consent rule.
- No in-headset consent flow (a separate, larger change).

## Design

R1 as a request-context test in `test/desktop.spec.js` (it already has API-only assertions, e.g. the malformed-pose 400) or in a new small spec `test/consent.spec.js` under the `chromium` project. R2 in `test/desktop.spec.js` next to the cold-microphone test, using `prepareRecording`-like steps but leaving the box unticked (do not change `prepareRecording`; set the name and leave consent as is, or explicitly uncheck it, since `localStorage` may remember a previous tick).

## Tests

T1. R1's test. Mutation: in `server/index.js`, temporarily make the validation accept a missing consent → the test fails (201 instead of 400, or a stored row). Restore.

T2. R2's test. Mutation: in `client/src/main.js` `beginRecording`, temporarily remove the consent check → the test fails (recording starts, or no `record:blocked`). Restore. Run with `--repeat-each=5`: 5/5.

T3. Full `npm test` at the final commit: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R4; T1–T3 with mutation results in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
