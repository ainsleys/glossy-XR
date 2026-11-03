# 010 · Cloud transcription as a consented fallback

## Problem

Transcription runs locally by default (`server/transcribe.js`, Whisper via transformers.js) and an OpenAI backend exists, but the choice is a server-wide environment variable (`GLOSSY_TRANSCRIBE=local|openai|none`) set at deployment. There is no way to keep local transcription as the default and call the cloud only for a clip the local model could not read, and nothing records that a clip left the server or asks the contributor for that. Measured in 004/005: the local base model returns a hallucination for a meaningful share of short Turkish clips; those end as `transcript: ''` with `unclear` set.

## Goal

A project can opt in to a cloud fallback. When it has, and only then, a clip whose local transcription came back unclear is sent to the cloud backend, the result is stored with its provenance, the consent text the contributor ticked says it may happen, and the room and review page show which backend produced a transcript.

## Requirements

R1. **Project setting.** `cloudFallback: boolean` on the project (new column, default false), settable by `PATCH /api/projects/:id {cloudFallback}` and returned by the project endpoints; a checkbox in the operator HUD's Settings panel ("send unclear clips to the cloud transcriber"), hidden in visitor mode. Documented in SCHEMA.md's project table and json block.

R2. **Secondary backend.** `createTranscriber` gains an optional fallback backend, configured by `GLOSSY_TRANSCRIBE_FALLBACK=openai` (default unset); the primary stays `GLOSSY_TRANSCRIBE`. `enqueue(..., { language, fallback: true|false })`: when `fallback` is true and the primary result is unclear (`unclearReason` non-null) or the primary errors, the job is retried once on the fallback backend; the final result carries `backend` as the backend that produced it and `fallback: { from: 'local', reason: <unclear reason or error> }` when the fallback ran. `info()` reports both backends. `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) is honoured by the OpenAI backend so a test can point it at a stub.

R3. **Server policy.** `queueTranscription` passes `fallback: project.cloudFallback === true`. The stored `transcription` meta gains `fallback` (object or absent). A `fallback` result that is itself unclear is stored as unclear with `backend` of the fallback. The re-run endpoint (`POST …/transcribe`) honours the same policy.

R4. **Consent text.** The consent label in `client/index.html` reads as today when the project's `cloudFallback` is off, and adds ", and transcribed by an external service when the local one cannot read it" when it is on; the label updates when the project loads or the setting changes. The consent recorded on the clip is unchanged in shape (boolean); the project setting at the time of the clip is what makes the label true, so the clip stores `cloudConsent: true|false` (the project setting at creation), returned in the record and the export.

R5. **Visible provenance.** The room's clip list and the review page show "transcribed in the cloud" (or the backend name) on clips whose `transcription.backend !== 'local'`; the EDM `dcterms:provenance` on the audio WebResource already says how a clip was transcribed and includes the backend.

R6. **Session log.** `transcribe:fallback {id, from, to, reason}` emitted server-side into the project's events (the server already stores events; if only clients post them today, add a server-side insert) so the operator can see how often the cloud was used.

R7. **README.** The transcription section describes the fallback, its two switches (project setting + `GLOSSY_TRANSCRIBE_FALLBACK`), the consent text change, and that nothing leaves the server unless both are on.

## Non-goals

- No change to the primary model or its options.
- No per-clip consent prompt in the headset (the project-level text is the consent mechanism, as it is today).
- No automatic quality scoring beyond the existing `unclearReason` guard.
- No cost controls or rate limits on the cloud backend.

## Design

`transcribe.js`: `createTranscriber({ log })` reads `GLOSSY_TRANSCRIBE_FALLBACK`; `pump()` runs primary, checks `unclearReason` (import from `shared/text.js`), and on unclear or error with `job.opts.fallback` runs the fallback backend; `openaiBackend()` uses `process.env.OPENAI_BASE_URL`. `db.js`: `cloud_fallback` on projects, `cloud_consent` on annotations, migrations as the existing pattern. `index.js`: PATCH field, `cloudConsent` on create (from the project), `fallback` meta in both branches, event insert. `main.js`: Settings checkbox bound to the project; consent label text; list badge. `review.js`: badge. `edm.js`: provenance string includes backend (check it already does). SCHEMA.md and its json block updated (the drift test will fail otherwise).

## Tests

T1. Unit: `test/unit/transcribe-fallback.test.mjs` builds a transcriber with a fake primary (returns a subtitle-credit hallucination, or throws) and a fake fallback (returns the words), via a small injection seam (`createTranscriber({ backends })` for tests only, defaulting to env); asserts fallback runs only with `fallback: true`, result has `backend` of the fallback and `fallback.from/reason`, and does not run when the primary result is clear. Mutation: remove the `unclearReason` check → fallback runs on clear results → test fails.

T2. E2e: in `test/desktop.spec.js` (or a new `test/fallback.spec.js`), the suite's server is started with `GLOSSY_TRANSCRIBE_FALLBACK=openai` and `OPENAI_BASE_URL=http://localhost:<API_PORT+1>/v1` (set in `playwright.config.js`'s webServer command); the test starts a stub HTTP server on that port returning a fixed transcription JSON for `/audio/transcriptions`, posts a clip of the committed Turkish fixture? No: posts a clip of **silence** (a short WAV of zeros, which the local model turns into a credit or empty, hence unclear) with the project's `cloudFallback` on, and asserts the stored transcript is the stub's text, `backend: 'openai'`, `fallback.from === 'local'`, `cloudConsent: true`, the list badge, and a `transcribe:fallback` event. Then the same clip with `cloudFallback` off: transcript stays unclear, no stub request (stub records hits), `cloudConsent: false`. Mutation: make `queueTranscription` pass `fallback: true` unconditionally → the "off" half fails.

T3. Consent label: with `cloudFallback` on, `#consent`'s label contains "external service"; off, it does not.

T4. Full `npm test` at the final commit: all passed; SCHEMA drift test passes with the new fields.

## Definition of done

- R1–R7; T1–T4 with mutations in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
