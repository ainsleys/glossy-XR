# 004 · The Turkish transcription test holds a whole sentence

## Problem

`test/turkish.spec.js` ("a Turkish clip is detected and transcribed as Turkish") fails intermittently: in three of today's full-suite runs Whisper returned a different Turkish sentence and the word check (`SPEECH_WORDS_TR`, any of pekmez/kazan/avlu/asma/durur) missed, while the same test passed when run alone each time. The fake microphone loops a 7.1 s file that speaks the fixture sentence twice (about 3.5 s per repetition); the test records for 3.2 s, starting wherever the loop happens to be. A clip that starts mid-sentence holds the end of one repetition and the start of the next, which the base Whisper model decodes less reliably in Turkish than a whole sentence. The clip length is the first suspect; the test gives no evidence either way because it logs the transcript only on the console.

## Goal

The test records enough audio to contain at least one complete repetition of the fixture sentence whatever the loop position, and the suite reports what it heard when the check fails.

## Requirements

R1. Diagnose before changing: run the test ten times (`npx playwright test test/turkish.spec.js --repeat-each=10`) at the base commit and record each run's `tr transcript:` line and pass/fail. Put the table in the pull request. If the failures do not correlate with partial sentences, say so and stop; the fix below assumes they do.

R2. Both `recordWithMouse` calls in the test record for long enough to contain a full repetition from any start point: at least one repetition length plus the longest gap, so 4.5 s (the second call's comment already says "long enough to hold a full sentence", which 3.2 s is not).

R3. On a word-check miss, the assertion message includes the transcript, so a future failure shows what Whisper heard without a console hunt (`expect(a.transcript, 'heard: ' + a.transcript).toMatch(...)`).

R4. No change to the assertions' meaning, the fixture sentence, the model, or anything under `client/` or `server/`.

R5. After the change: `--repeat-each=10` passes 10/10, recorded in the pull request alongside the R1 table.

## Non-goals

- No retry-on-miss in the test (a retry hides a real regression in Turkish decoding).
- No change to the English fixture or the `chromium` project.
- No change to the Whisper model or its options.
- No change to `recordWithMouse`.

## Design

Two numbers in `test/turkish.spec.js` (3200 → 4500) and a message argument on the two `toMatch(SPEECH_WORDS_TR)` calls. The README's test paragraph does not mention the clip length; no README change.

## Tests

T1. The test itself, ten repeats before (R1) and after (R5). Mutation that proves R2 matters: set the length to 1800 ms (shorter than a sentence); over ten repeats the word check must fail at least once (if it never does, the diagnosis in R1 was wrong; report). Restore.

## Definition of done

- R1 table and R5 result in the pull request; T1's mutation result recorded.
- `npm test` at the final commit: all passed (the optional interior scene test may be skipped).
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
