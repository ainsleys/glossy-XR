# 005 · The Turkish transcription test passes from every point in the loop

## Problem

Measured in 004: `test/turkish.spec.js` fails 2–3 times in 10 because the 3.2 s clip starts at a random point in the looping 7.1 s fixture, and from 52 of 142 possible start points (every 0.05 s) whisper-base decodes the window to a subtitle-credit hallucination, which the silence guard turns into an empty transcript. Decoding is deterministic on the same audio; load, clip truncation and transcriber backlog are ruled out. The e2e test therefore passes or fails on timing alone.

A second, separate defect found during 004: `playwright.config.js` selects the Turkish project with `testMatch: /turkish/` and excludes it elsewhere with `testIgnore: /turkish/`, and Playwright tests those patterns against the full file path. In a checkout whose directory name contains "turkish", every spec matches, and `npm test` cannot run there.

## Goal

The Turkish test's outcome does not depend on where the clip starts in the loop, and that is shown offline before the e2e test is trusted. The project selection matches file names, not paths.

## Requirements

R1. **A fixture sweep tool**, `test/fixtures/sweep.mjs`: given a WAV, a window length in ms and a step in ms (default 50), it cuts every window, encodes it as the recorder would (webm/opus via ffmpeg), decodes each with the server's own transcriber (`server/transcribe.js`, local backend, same options the suite uses, language forced to the fixture's language or detected as the test does), and prints per-start-point pass/miss against a regex, plus a summary (misses/total, the failing start ranges). Runs with `node test/fixtures/sweep.mjs <wav> --ms 3200 --match 'pekmez|kazan|avlu|asma|durur'`. Reuses the transcriber; adds no dependency. Documented in one README sentence in the Testing section.

R2. **Choose the fix with the sweep.** Candidates, in order of preference: (a) a longer hold in `test/turkish.spec.js` for both recordings (sweep lengths from 3200 ms upward in 500 ms steps; pick the shortest with 0 misses, if any ≤ 8000 ms); (b) a changed fixture in `playwright.config.js` (`SPOKEN_TR`): a different sentence, or the same sentence with a pause of about a second between repetitions, swept the same way at the current 3200 ms; (c) both. The chosen option must give **0 misses at every start point** for the lengths the test records. The decision and the sweep numbers for each candidate go in the Decisions section and the pull request.

R3. **Apply the choice.** Only the chosen constants change: the hold length(s) in `test/turkish.spec.js` and/or `SPOKEN_TR` in `playwright.config.js`. No change to the model, its options, the guard, `recordWithMouse`, the English fixture, or anything under `client/` or `server/`.

R4. **Project selection by file name.** In `playwright.config.js`, `testMatch` and `testIgnore` for the Turkish project use a pattern anchored to the file name (for example `/(^|\/)turkish\.spec\.js$/`), so a directory named "turkish-…" no longer matches every spec. Default behaviour on the usual checkout is unchanged.

## Non-goals

- No retry-on-miss in the test.
- No change to Whisper model, options, chunking or the silence/repetition guards.
- No change to the assertions' meaning (language detected, Turkish words present, English override, re-decode as heard).

## Design

`sweep.mjs` imports `createTranscriber` from `../../server/transcribe.js` (check its export; if only a factory exists, use it with `GLOSSY_TRANSCRIBE=local`), uses `ffmpeg` to cut and encode windows to a temp dir, decodes serially, prints a table. The test change is two numbers or one string. The config change is two regexes.

## Tests

T1. Sweep at the chosen configuration: 0 misses, output pasted in the pull request. Mutation: sweep at the old configuration (3200 ms, current sentence): misses reported (expected around 52/142), proving the tool sees the defect.

T2. E2e: `npx playwright test test/turkish.spec.js --repeat-each=10` passes 10/10 at the chosen configuration (poll rules as per the template; the test already polls). Run from a checkout whose directory name contains "turkish" to exercise R4 as well; and once from one that does not.

T3. R4: with the new patterns, `npx playwright test --list` in a checkout named `…/turkish-test` lists `turkish.spec.js` under `chromium-tr` only and every other spec under `chromium` only. Mutation: restore the old patterns in that checkout: the listing shows every spec under `chromium-tr`.

T4. Full `npm test` at the final commit: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R4; T1–T4 recorded in the pull request, including the sweep table per candidate.
- README sentence for the sweep tool.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
