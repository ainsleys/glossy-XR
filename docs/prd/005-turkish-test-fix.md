# 005 · The Turkish transcription test passes from every point in the loop

## Problem

Measured in 004: `test/turkish.spec.js` fails 2–3 times in 10 because the 3.2 s clip starts at a random point in the looping 7.1 s fixture, and from 52 of 142 possible start points (every 0.05 s) whisper-base decodes the window to a subtitle-credit hallucination, which the silence guard turns into an empty transcript. Decoding is deterministic on the same audio; load, clip truncation and transcriber backlog are ruled out. The e2e test therefore passes or fails on timing alone.

A second, separate defect found during 004: `playwright.config.js` selects the Turkish project with `testMatch: /turkish/` and excludes it elsewhere with `testIgnore: /turkish/`, and Playwright tests those patterns against the full file path. In a checkout whose directory name contains "turkish", every spec matches, and `npm test` cannot run there.

## Goal

The Turkish test's outcome does not depend on where the clip starts in the loop, and that is shown offline before the e2e test is trusted. The project selection matches file names, not paths.

## Requirements

R1. **A fixture sweep tool**, `test/fixtures/sweep.mjs`. Input: a sentence and voice (it builds the WAV with the same `say` arguments `playwright.config.js` uses, so the audio is the fixture's), a window length in ms, a step in ms (default 25). It treats the fixture as a loop (windows wrap past the end, as the fake microphone does), cuts a window at every start from 0 to the loop length, encodes each as webm/opus with ffmpeg, and decodes each with the server's own transcriber: `createTranscriber` from `server/transcribe.js` is a queue, so the tool wraps `enqueue(id, file, opts, done)` in a promise, treats any error as a miss, applies `unclearReason` from `shared/text.js` exactly as `server/index.js` does, and refuses to run unless the backend is local and `GLOSSY_LANGUAGE` is unset (prints `info()` and exits otherwise). Each window is decoded twice, with language detected and with language forced to the fixture's. Pass rules, mirroring the test: detected mode passes only if not unclear, regex matches, `language` is the fixture's, `detected` is true and `words.length > 2`; forced mode passes if not unclear and the regex matches. The tool prints per-start pass/miss for both modes, `retried` and `ms`, and a summary (misses/total per mode, failing start ranges, any `retried`). Usage: `node test/fixtures/sweep.mjs --text "<sentence>" --voice Yelda --lang tr --ms 3180 --step 25 --match 'pekmez|kazan|avlu|asma|durur'`. Note the recorded clip is about 20 ms shorter than the hold (3180 for a 3200 hold); sweep the recorded length. Adds no dependency. Documented in one README sentence in the Testing section.

R1b. **The sweep is a model of the e2e path, not a replica**: Chromium applies echo cancellation and noise suppression to the microphone and uses its own Opus settings; the sweep uses plain ffmpeg. The 004 data disagrees with the sweep at some start points. So the tool also takes `--replay <dir>` to decode stored clips (the 004 clips are in `/tmp/trm/audio-*` on this machine, if still present) and report agreement with the sweep at their aligned start points; T1 reports that number.

R2. **Choose the fix with the sweep.** Candidates: (a) a longer hold in `test/turkish.spec.js` for both recordings (sweep recorded lengths from 3180 ms upward in 500 ms steps, up to about 6000 ms); (b) a changed fixture in `playwright.config.js` (`SPOKEN_TR`): the same sentence with a pause of about a second between repetitions (`[[slnc 1000]]` in the `say` text), or a different sentence, swept at the current 3180 ms; (c) both. Acceptance for a candidate: **0 misses in both modes at 25 ms steps, at the recorded length and at the recorded length minus 300 ms** (a timing margin), and **no `retried` decode** in either mode (the repetition retry took 17–31 s in 004 and would push the test toward its 60 s timeout). Sweep both (a) and (b), and prefer the candidate with the larger margin (more surplus length, or 0 misses over a wider range); keep the test's worst case (two holds plus three decodes) under about 40 s. The sweep numbers for every candidate go in the Decisions section and the pull request.

R3. **Apply the choice.** Only the chosen constants change: the hold length(s) in `test/turkish.spec.js` and/or `SPOKEN_TR` in `playwright.config.js`. No change to the model, its options, the guard, `recordWithMouse`, the English fixture, or anything under `client/` or `server/`.

R4. **Project selection by file name.** In `playwright.config.js`, both the `chromium` project's `testIgnore: /turkish/` and the `chromium-tr` project's `testMatch: /turkish/` become patterns anchored to the file name, `/(^|[\\/])turkish\.spec\.js$/` (Playwright tests them against the absolute path), so a directory named "turkish-…" no longer matches every spec. Default behaviour on the usual checkout is unchanged.

## Non-goals

- No retry-on-miss in the test.
- No change to Whisper model, options, chunking or the silence/repetition guards.
- No change to the assertions' meaning (language detected, Turkish words present, English override, re-decode as heard).

## Design

`sweep.mjs` imports `createTranscriber` from `../../server/transcribe.js` (check its export; if only a factory exists, use it with `GLOSSY_TRANSCRIBE=local`), uses `ffmpeg` to cut and encode windows to a temp dir, decodes serially, prints a table. The test change is two numbers or one string. The config change is two regexes.

## Tests

Order of work: T1 mutation (old settings) → sweep the candidates and choose → R4 with T3 → R3 → T2 → T4.

T1. Sweep at the old configuration first (3180 ms, current sentence, 25 ms steps): misses reported in detected mode (004 found about 52/142 at 50 ms steps), proving the tool sees the defect; plus the replay agreement figure (R1b). Then sweep every candidate; the chosen one meets R2's acceptance. All outputs in the pull request.

T2. E2e: `npx playwright test test/turkish.spec.js --repeat-each=10` passes 10/10 at the chosen configuration, run from the main checkout (`/Users/ainsleys/xr-annotation/glossy-xr` on this branch via a worktree whose name does not contain "turkish").

T3. R4: in the worktree named `…/turkish-test`, `npx playwright test --list` lists `turkish.spec.js` under `chromium-tr` only and every other spec under `chromium` only. Mutation: restore the old patterns there: the listing shows every spec under `chromium-tr`. (Naming the spec file on the command line does not exercise R4; only `--list` or a full run does.)

T4. Full `npm test` at the final commit in both the turkish-named worktree and a normally named one: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R4; T1–T4 recorded in the pull request, including the sweep table per candidate.
- README sentence for the sweep tool.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. The transcriber is a queue with a callback; the sweep wraps it rather than importing a plain function, applies the silence guard itself (the server does, not the transcriber), and decodes in both modes with the test's full pass rules, so it cannot report 0 misses for a weaker reason.
2. The sweep is a model: Chromium's mic processing and Opus settings differ from ffmpeg's, and 004's clips disagree with the sweep at some starts. Hence 25 ms steps, a 300 ms length margin, the replay agreement figure, and the no-retry rule.
3. The fixture-with-pause option is a peer of the longer hold, not a fallback, because longer clips risk the repetition retry and the 60 s test timeout.
4. Both projects' patterns are anchored (the chromium project's `testIgnore` too).
5. T2 does not exercise R4; T3 with `--list` does.

6. **Sweep (3 Nov).** Windows are Opus at 128 kb/s, Chromium's recorder default (004's sweep used 32 kb/s, which is why its failing starts differ from these). Replay of 49 stored clips from 004: the stored clips reproduce their recorded misses; the sweep agrees with them at the best-aligned start for 39/49 (detected) and 38/49 (forced), and at one of the two copies of the sentence for 47/49 and 46/49. The two copies align almost equally well (r within 0.02) and the sweep often differs between them, so the alignment, not only the model, limits this figure. Candidates stopped after 10 detected-mode misses are marked "stopped"; screens use 200 ms steps and stop after 3.

   | Candidate | Window | Starts decoded | Misses detected / forced | Retried | Typical miss |
   |---|---|---|---|---|---|
   | old: current sentence | 3180 | 284/284 | 94 / 91 | 22 | subtitle credit "Bu dizinin betimlemesi TRT …" |
   | (a) hold 4700 | 4680 | 15/284, stopped | 10 / 10 | 1 | "Altyazı." |
   | (a) hold 5700 | 5680 | 20/284, stopped | 10 / 10 | 0 | "Altyazı." |
   | (b) pause of 1 s after each repetition | 3180 | 82/370, stopped | 10 / 9 | 2 | "Bu ne? Bu ne?", "Altyazı." |
   | (b) "Bugün hava çok güzel, deniz kenarında yürüyüş yapalım." ×2 | 3180 | 185/293, stopped | 8 / 8 | 3 | transcriber error "token_ids must be a non-empty array of integers" (5), "Bu gün halkın bir kere." |
   | (b) screen: "Annem mutfakta çay demliyor, …" ×2 | 3180 | 22/48 | 3 / 1 | 0 | |
   | (b) screen: "İstanbul'da yağmur yağıyor …" ×2 | 3180 | 15/32 | 3 / 2 | 2 | |
   | (b) screen: "Elma, armut, kiraz, …" ×2 | 3180 | 22/48 | 3 / 3 | 0 | |
   | (b) screen: "Kediler bahçede oynuyor, …" ×2 | 3180 | 22/42 | 3 / 2 | 0 | |
   | (b) screen: "Sabah kahvaltıda peynir, …" ×2 | 3180 | 13/41 | 3 / 1 | 0 | |
   | (b) screen: "Kitabı masanın üstüne bırak, …" ×2 | 3180 | 6/37 | 3 / 3 | 1 | |

   **Reading.** No candidate meets R2's acceptance, so R3 is not applied and the test keeps its constants. A longer hold makes things worse: whisper-base (q8) decodes most 4.7 s and 5.7 s windows of the current fixture to "Altyazı.", a hallucination the silence guard does not list, so the miss is a failed word check rather than an empty transcript. A pause in the fixture adds windows that are mostly silence, which the model fills with credits or loops. Every other sentence tried misses somewhere in the loop. The defect is the model's behaviour on short Turkish windows, not the constants; the holds 3700, 4200 and 5200, the pause between repetitions only, and the 300 ms margin runs were not swept, since nothing passed at the recorded length. R4 is independent and is applied.
