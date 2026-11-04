# 008 · Recording without consent is refused, and that is tested

## Problem

The page refuses to record unless the consent box is ticked: `beginRecording` in `client/src/main.js` logs `record:blocked {reason: 'no consent'}` and shows "tick consent first", and the server rejects any annotation whose `consent` is not `true` (`server/index.js`, the create validation: "consent must be true", HTTP 400). Nothing in the suite exercises either path. `test/desktop.spec.js` only asserts that a consented run produced zero `record:blocked` events. A regression in either gate (the client starting the microphone anyway, or the server accepting a clip without consent) would pass the suite.

## Goal

Both gates are tested, each by the behaviour it owns: the client does not start recording and says why; the server rejects the request.

## Requirements

R1. **Server test.** `POST /api/projects/:id/annotations` with the audio part, `x`/`y`/`z` and `author` (the `clip` shape the malformed-pose test in `test/desktop.spec.js` already uses) but `consent` absent, and again with `consent: 'false'`, returns 400 with an error body naming consent; nothing is stored: `GET …/annotations` is empty and the number of entries in `.test-data/audio` is the same before and after (the directory is shared by the whole run and the handler deletes the uploaded file before answering 400, so count, do not assert emptiness). With `consent: 'true'` the same request is accepted (201), as the existing tests already show.

R2. **Client test.** On the desktop page: fill `#author`, assert `#consent` is unchecked (each test has a fresh browser context, so `localStorage` starts empty; the assertion documents the precondition), `lockPointer`, then `mouse.move(640, 400)` and `mouse.down()`. Poll the status until it is exactly "tick consent first"; flush the log and poll the events endpoint for a `record:blocked` event with `data.reason === 'no consent'` and `data.via === 'mouse'` (the log field is `via`, not `source`). Only then read `recorder.isRecording === false`, `starting` falsy (expose or infer via `__glossy`) and `markers.size === 0`, and `mouse.up()`. The event proves `beginRecording` ran and returned, so those reads are not trivially true. Then tick consent and show a normal hold records (`recordWithMouse`).

R3. **No change to `client/` or `server/`.** If either gate turns out not to behave as described, stop and report; that is a product change with its own specification.

R4. **README.** The test-coverage paragraph gains the phrase "recording refused without consent, by the page and by the server".

## Non-goals

- No change to consent wording, storage or the EDM consent rule.
- No in-headset consent flow (a separate, larger change).

## Design

R1 next to the malformed-pose 400 assertions in `test/desktop.spec.js`; R2 in the same file next to the cold-microphone test. Do not change `prepareRecording`; fill `#author` directly.

## Tests

T1. R1's test. Mutation: in `server/index.js`, replace the consent parse with `const consent = true;` → the test fails (201 instead of 400, a stored row, one more audio file). Restore.

T2. R2's test. Mutation: in `client/src/main.js` `beginRecording`, delete the consent check line → recording starts with the fake microphone and the clip even saves (the client posts `consent: true` unconditionally), so the test fails at the status poll or the `record:blocked` poll. Restore. Run with `--repeat-each=5`: 5/5.

T3. Full `npm test` at the final commit: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R4; T1–T3 with mutation results in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. The log field is `via` (the first draft said `source`); fixed in R2.
2. Assertion order fixed so the negative reads follow proof that `beginRecording` ran (status text, then the blocked event).
3. The audio directory is shared across the run: count entries rather than assert emptiness.
4. Both tests live in `desktop.spec.js`; a separate spec would work (the chromium project ignores only `turkish.spec.js`) but adds nothing.
5. Mutations named precisely: `const consent = true;` on the server; deleting the consent check line on the client, which makes the clip save because the client hard-codes `consent: true` in the post.
