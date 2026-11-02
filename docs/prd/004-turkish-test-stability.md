# 004 · Find out why the Turkish transcription test flakes

## Problem

`test/turkish.spec.js` ("a Turkish clip is detected and transcribed as Turkish") fails intermittently in full-suite runs (three times on 2 Nov) and passes when run alone. In each failure the language was detected as `tr` and the transcript was a different Turkish sentence, so the word check (`SPEECH_WORDS_TR`: any of pekmez/kazan/avlu/asma/durur) missed. The test logs the transcript to the console and nothing else, so each failure leaves no evidence of what was recorded or decoded.

A first guess, that a 3.2 s clip from a random point in the 7.1 s looping fixture misses a whole sentence, does not hold: the five roots are spread across the 3.4 s sentence (pekmez 0–0.15 s, kazanı 0.25–0.5, avluda 0.6–1.5, asmanın 1.75–1.9, dururdu 2.65–3.4), so any 3.2 s window contains several, and the loop position is as random alone as in a full run. The difference between alone and full-suite is load: Chromium's fake audio capture can underrun, recording can start late, and the serial transcriber may be busy with earlier clips. Which of these it is has to be measured before anything is changed.

## Goal

Evidence, from repeated runs under both conditions, of what the failing clips contain and what Whisper returned for them, so that the fix (if one is needed beyond the harness) is chosen on data; and a test that, when it fails, says what it heard.

## Requirements

R1. **Measure.** Run the test with `--repeat-each=10` (a) alone, and (b) under load: with a second suite running at the same time in another checkout on other ports (the harness supports this after change 003; if that is not merged yet, run the `dense` and `xr` specs in the other checkout on the default ports while this test runs on `GLOSSY_TEST_API_PORT=3200 GLOSSY_TEST_VITE_PORT=5274` from the `feature/test-ports` worktree's config, or simply run the full suite twice and take the Turkish results). For every run record: pass/fail; `transcript`; `transcription.language`, `detected`, `unclear`, `raw` (the text stored when the silence/repetition guard fires), `words.length`, `ms`; the stored clip's duration (`ffprobe` on `.test-data/audio/<id>.webm`) against the 3200 ms requested; and the time from `record:start` to `record:saved` in the session log. Put the table in the pull request and in this file's Decisions section.

R2. **Say what was heard.** The two `toMatch(SPEECH_WORDS_TR)` assertions carry a message with `JSON.stringify({ transcript, ...transcription })`, so a failure shows `unclear`, `raw`, `heard` and the timing without a console hunt. (`transcription.retried` is computed in `server/transcribe.js` but not stored; note it in the table as unavailable; do not change the server here.)

R3. **No fix in this change.** Clip lengths, model, fixture, retries, `recordWithMouse`, client and server all stay as they are. The table and R2 are the whole change. If the data points to a harness cause (short clips, late start), the fix is the next specification, written from the table.

## Non-goals

- No retry-on-miss, no clip-length change, no model or option change, no fixture change.
- No change to the English project.

## Design

`test/turkish.spec.js`: message arguments on two assertions. Everything else is measurement, reported, not committed, except the table in this file.

## Tests

T1. The test, ten repeats alone and ten under load, before and after R2 (R2 cannot change the outcome; the before/after is a sanity check). No mutation: the change adds no behaviour. The proof the change is worth having is one failing run in the table showing the fields that were invisible before.

## Definition of done

- R1 table (both conditions) in the pull request and in Decisions below, with a one-paragraph reading of it: which hypothesis the data supports (clip truncated or late; underrun garbling the audio; decoder variance on identical audio; transcriber backlog) and what the next specification should change.
- R2 in place; `npm test` at the final commit reported with counts (a Turkish flake in that run is acceptable only if it appears in the table with its fields).
- Commit messages and the pull request describe the change only.

## Decisions (2 Nov)

1. The clip-length diagnosis in the first draft was withdrawn after the fixture was measured (sentence 3.4 s; roots spread across it; 4.5 s would hold a whole sentence from only ~31% of start points, 7.5 s would be needed). Loop position does not distinguish alone from full-suite runs; load does. Hence measure first.
2. The 1.8 s mutation in the first draft was dropped: any 1.8 s window still holds a root.
3. `expect(value, message)` is the Playwright form; the message carries the hidden fields, since `toMatch` already prints the received string.
4. The 30 s chunking and language-detection hypotheses are ruled out: clips are short, and the `language === 'tr'` assertion precedes the word check in the recorded failures.

(The measurement table is appended here by the implementer.)
