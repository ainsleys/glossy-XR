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

5. **Measurement (3 Nov).** Twenty runs on this machine: ten alone on the default ports, ten while `dense.spec.js` and `xr.spec.js` ran at the same time from a second checkout of `main` on ports 3300/5374. Clip A is the first recording (language detected); clip C is the second recording decoded again as Turkish after "as heard" (clip B, its English decode, is not checked against the Turkish words). In every run `language` was `tr`, A had `detected: true` and `heard: null`, and C had `heard: tr`. `transcription.retried` is computed but not stored, so it is unavailable here; the two 66-word A transcripts with 17–31 s decode times look like the repetition retry. "Clip ms" is the end of the last Opus packet in `.test-data/audio/<id>.webm` (`ffprobe -show_entries format=duration` prints `N/A` for these MediaRecorder files); 3200 ms was requested. "Loop s" is where the clip starts in the 7.1 s fixture, found by cross-correlating the decoded clip with the fixture WAV; the fixture holds the sentence twice, so starts about 3.65 s apart are the same point in the sentence. "Start→saved" is `record:start` to `record:saved` in the session log.

   Failures: alone 2 of 10 (one at A, one at C); under load 3 of 10 (all at C).

   | Run | Condition | Result | A: start→saved ms | A: clip ms | A: loop s | A: ms | A: words | A: transcript | C: start→saved ms | C: clip ms | C: loop s | C: ms | C: words | C: transcript |
   |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
   | 1 | alone | pass | 3383 | 3180 | 0.19 | 1501 | 7 | Altın altına kızanlığı da asmanın altında dururdu. | 3251 | 3180 | 5.52 | 1631 | 6 | Asmanın altında dururdu. Pekmez kazanı aluda. |
   | 2 | alone | pass | 3380 | 3180 | 0.02 | 17660 | 66 | Kizmelerin bir kizmeleri var. Bu kizmeti bir kibirin bir sürü. Bu k... | 3273 | 3180 | 0.59 | 1352 | 5 | Kazanı aluda, asmanın altında dururdu. |
   | 3 | alone | pass | 3357 | 3180 | 0.19 | 1416 | 7 | Altın altına kızanı alıda, asmanın altında dururdu. | 3223 | 3180 | 1.59 | 1416 | 5 | Asmanın altında dururdu. Pekmez kazanılır. |
   | 4 | alone | pass | 3393 | 3180 | 0.22 | 1255 | 5 | Kazanı alıda, asmanın altında dururdu. | 3274 | 3180 | 1.61 | 1666 | 5 | Asmanın altında dururdu. Pekmez kazanıladı. |
   | 5 | alone | pass | 3619 | 3180 | 0.19 | 1134 | 3 | Altın altında dururdu. | 3243 | 3180 | 1.57 | 1304 | 5 | Asmanın altında dururdu. Pekmez kazanılır. |
   | 6 | alone | **fail (C)** | 3388 | 3180 | 0.15 | 2723 | 3 | Altın altında dururdu. | 3260 | 3180 | 6.88 | 2089 | 0 | unclear=silence; raw: Bu dizinin betimlemesi TRT-8'ın Film tarafınd... |
   | 7 | alone | pass | 3620 | 3180 | 0.15 | 1372 | 3 | Altın altında dururdu. | 3241 | 3180 | 1.48 | 1214 | 3 | Asmanın altında dururdu. |
   | 8 | alone | **fail (A)** | 3347 | 3180 | 0.17 | 11008 | 8 | Kıvırlılık ve kılıklarına bir kılınca bir kılıç kılıştır. | – | – | – | – | – | not reached |
   | 9 | alone | pass | 3373 | 3180 | 0.14 | 1257 | 5 | Kazanı alıda, asmanın altında dururdu. | 3241 | 3180 | 1.5 | 1283 | 3 | Asmanın altında dururdu. |
   | 10 | alone | pass | 3371 | 3180 | 0.15 | 1091 | 3 | Altın altında dururdu. | 3235 | 3180 | 1.47 | 1424 | 5 | Asmanın altında dururdu. Pekmez kazanılmaz. |
   | 1 | load | pass | 3472 | 3180 | 0.06 | 1799 | 7 | ve pekmez kazanılığı da asmanın altında durur. | 3233 | 3180 | 2.8 | 2243 | 7 | Altyazı'nda dururdu. Pekmez kazanılığda, Asman'ın |
   | 2 | load | **fail (C)** | 3436 | 3180 | 0.09 | 2313 | 7 | ve kines kazanılığı da asmanın altında durur. | 3283 | 3180 | 2.87 | 2318 | 0 | unclear=silence; raw: Bu dizinin betimlemesi TRT-8'ın Film tarafınd... |
   | 3 | load | pass | 3405 | 3180 | 0.03 | 1788 | 6 | Kekmez kazanılığı da asmanın altında durur. | 3255 | 3180 | 1.96 | 1646 | 5 | Asmanın altında dururdu. Pekmez kazanılarda. |
   | 4 | load | pass | 3383 | 3180 | 0.03 | 1831 | 6 | Kekmez kazanılığı da asmanın altında durur. | 3262 | 3180 | 2.04 | 1805 | 5 | Asmanın altında dururdu. Pekmez kazanılarda. |
   | 5 | load | pass | 3492 | 3240 | 0.21 | 1595 | 6 | Kıvırmız kazanı alıda, asmanın altında dururdu. | 3239 | 3180 | 2.65 | 1703 | 2 | Altyun'da dururdu. |
   | 6 | load | **fail (C)** | 3432 | 3180 | 0.08 | 2543 | 6 | Ekmez kazanı alıda, asmanın altında durur. | 3291 | 3180 | 6.5 | 2630 | 0 | unclear=silence; raw: Bu dizinin betimlemesi TRT tarafından Sesli B... |
   | 7 | load | pass | 3363 | 3180 | 0.3 | 1561 | 5 | Kazanı aluda, asmanın altında dururdu. | 3261 | 3180 | 5.52 | 1911 | 6 | Asmanın altında dururdu. Pekmez kazanı aluda. |
   | 8 | load | pass | 3380 | 3180 | 0.02 | 30829 | 66 | Kizmelerin bir kizmeleri var. Bu kizmeti bir kibirin bir sürü. Bu k... | 3292 | 3180 | 0.04 | 2597 | 6 | Tekmez kazanı aluda, asmanın altında durur. |
   | 9 | load | pass | 3572 | 3240 | 0.27 | 1789 | 6 | Nas kazanı aluda, asmanın altında dururdu. | 3234 | 3180 | 5.59 | 5394 | 5 | Sözünün altında dururdu. Pekmez kazanılarda. |
   | 10 | load | **fail (C)** | 3707 | 3180 | 0.05 | 1786 | 6 | Tekmez kazanılığı da asmanın altında durur. | 3254 | 3180 | 2.74 | 3563 | 0 | unclear=silence; raw: Bu dizinin betimlemesi TRT-8'ın Film tarafınd... |

   **Reading.** The data rules out a truncated clip, a late start and a transcriber backlog: every stored clip is 3180–3240 ms, `record:start` to `record:saved` is 3.2–3.7 s in every run, and decoding took 0.9–5.4 s outside the retry cases, with no difference between failing and passing runs. It also rules out decoder variance on identical audio: decoding every stored clip again offline, three times, with the same backend and options gave exactly the in-test transcript each time, including all five misses. Underrun garbling is not needed to explain the misses: the clips align with the fixture along their whole length, and cutting clean 3.18 s windows from the fixture WAV at every 0.05 s start (Opus-encoded, decoded with the test's backend and options) fails at 52 of 142 start points. The misses sit where the sweep fails: C misses started at 6.88, 2.87, 6.5 and 2.74 s, in the last word or the pause of a sentence (the sweep fails at every start from 2.8 to 3.3 s and from 6.3 to 6.95 s, where Whisper base returns the subtitle credit "Bu dizinin betimlemesi TRT …" that the silence guard catches), and the A miss started at 0.17 s, in a stretch where passing and failing starts alternate every 0.05 s. The supported hypothesis is that whisper-base decodes these short windows correctly from some starting points in the looping sentence and not from others, and the starting point depends on timing. Load is not the cause at this sample size (2/10 alone against 3/10 under load). It changes where clip C starts, because C's start depends on how long the run took before the second recording, while A almost always starts within 0.3 s of the loop start. The next specification should make the outcome independent of where the clip starts in the loop, by changing the hold length or the fixture. The same offline sweep is its acceptance test: every 0.05 s start must decode to a root word before the e2e test is trusted.
