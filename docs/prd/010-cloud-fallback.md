# 010 · Cloud transcription as a consented fallback (server side)

This is the first of two changes. It adds the policy, the storage and the secondary backend, with API-level tests. The second (011) adds the consent label, the Settings checkbox and the badges in the room and the review page. Until 011 ships, no client sends `cloudConsent`, so no clip can be sent to the cloud: this change is safe on its own.

## Problem

Transcription runs locally by default (`server/transcribe.js`) and an OpenAI backend exists, but the choice is a server-wide environment variable set at deployment. There is no way to keep local transcription as the default and call the cloud only for a clip the local model could not read, nothing records that a clip left the server, and nothing ties that to what the contributor agreed to. Measured in 004/005: the local base model returns a hallucination for a meaningful share of short Turkish clips; those end as `transcript: ''` with `unclear` set.

## Goal

A project can opt in to a cloud fallback. A clip is sent to the cloud only when the project has opted in, the contributor consented to that specific clause, and the local model's result was rejected as unclear. The result is stored with its provenance.

## Requirements

R1. **Project setting.** `cloudFallback: boolean` on projects (new column, default false; migration in the existing `db.js` pattern), settable by `PATCH /api/projects/:id {cloudFallback}` (boolean only) and returned by the project endpoints.

R2. **Clip consent flag.** `cloudConsent: boolean` on annotations (new column, default false). On create, the server stores `cloudConsent = (body.cloudConsent === 'true' || body.cloudConsent === true) && project.cloudFallback === true`. The annotation PATCH cannot change it. It is returned in the record and in the native export's contribution.

R3. **Trigger.** The fallback runs only when all hold at run time: `project.cloudFallback`, `clip.consent`, `clip.cloudConsent`, and the primary backend returned a clean result whose `unclearReason(text)` is non-null (silence or repetition). It does **not** run on a primary error (missing ffmpeg, model load failure, backend exception: those stay `failed`), on an empty transcript, or on the primary's language fallback (`fallback: true` in the backend result means an English-only model or no language tokens: a configuration matter). The boot requeue and the `POST …/transcribe` re-run route apply the same rule with the clip's own stored flags.

R4. **Secondary backend.** `createTranscriber` gains an optional secondary backend from `GLOSSY_TRANSCRIBE_FALLBACK=openai` (default unset). Naming, to avoid the existing boolean `fallback` on backend results: the enqueue option is `allowCloud: boolean`; the stored meta is `cloud: { from: 'local', reason: 'silence'|'repetition' }`, present only when the secondary ran; `backend`/`model` name whatever produced the stored text. If the secondary is itself unclear, the result is stored unclear with the secondary's `backend` and `cloud` set. A failed `warm()` of the secondary marks only the secondary unavailable (`info()` reports both), never the primary. `openaiBackend()` builds its URL from `OPENAI_BASE_URL` (default `https://api.openai.com/v1`).

R5. **Event.** When the secondary runs, the server records a `transcribe:fallback {id, from, to, reason}` event through `db.events.add(project, 'server', [...])` (the server-side session `'server'` has no `session:start`; the README's session-log paragraph says so and that reports show it as a partial session).

R6. **Provenance.** EDM `dcterms:provenance` on the audio WebResource, which already names the backend, adds "after the local transcription was rejected as <reason>" when `cloud` is set.

R7. **SCHEMA.md and the drift test.** This branch is rebased on `main` after PR #10 (SCHEMA.md) merges. Add `cloudFallback` to the project list and table; `cloudConsent`, `transcription.cloud`, `transcription.cloud.from`, `transcription.cloud.reason` to the record; `cloudConsent` to the contribution; update the prose about the backend and the export's dropped keys; the drift test's fixture records gain one with `meta.cloud` so the union covers the new keys.

R8. **README.** Transcription section: the fallback, its three conditions, the two switches (project setting and `GLOSSY_TRANSCRIBE_FALLBACK`), and that nothing leaves the server unless all hold.

## Non-goals

- No client change (consent label, Settings checkbox, badges): change 011.
- No change to the primary model or options; no quality scoring beyond `unclearReason`.
- No fallback for chat audio (`POST …/chat/audio`); it stays local-only.
- No cost controls or rate limits.

## Design

`transcribe.js`: `createTranscriber({ log, backends })` where `backends` is a test-only injection seam `{ primary, secondary }` that skips `check()` for injected fakes; otherwise built from env. `pump()` runs the primary; if `job.opts.allowCloud` and the result is clean and `unclearReason(result.text)` is non-null and the secondary is available, runs the secondary and returns its result with `cloud: {from: primary.name, reason}`. `db.js`: `cloud_fallback` (projects), `cloud_consent` (annotations), migrations. `index.js`: PATCH field; create stores `cloudConsent`; `queueTranscription` and the re-run route compute `allowCloud` from the three flags; meta stores `cloud`; event insert. `edm.js`: provenance clause. Test env in `playwright.config.js`'s webServer command: `GLOSSY_TRANSCRIBE_FALLBACK=openai OPENAI_API_KEY=test OPENAI_BASE_URL=http://localhost:${STUB_PORT}/v1`, with `STUB_PORT` from `GLOSSY_TEST_STUB_PORT` (default 3101); harmless for every other test since projects default to off.

## Tests

T1. Unit, `test/unit/transcribe-fallback.test.mjs`: fakes injected through the seam. Cases: unclear primary + `allowCloud` → secondary runs, result has secondary `backend` and `cloud.from/reason`; clean primary → secondary does not run; unclear primary without `allowCloud` → does not run; primary error → `failed`, secondary does not run; secondary unavailable → stored unclear from the primary. Mutations: (a) remove the `unclearReason` check → "clean primary" case fails; (b) make errors fall back → "primary error" case fails.

T2. API-level e2e (Playwright `request` fixture, no browser): a stub HTTP server started in the test on `STUB_PORT`, answering `POST /v1/audio/transcriptions` with a fixed JSON and counting hits. Fixture: a committed `test/fixtures/thank-you.wav` (`say -v Samantha … "Thank you."`, English), which the local model transcribes to a line the silence guard rejects (`/^thank you\.?$/`), verified once and recorded in the PR. Cases: project `cloudFallback` on, clip posted with `cloudConsent: 'true'` → stored transcript is the stub's text, `backend: 'openai'`, `cloud.from === 'local'`, `cloud.reason` set, `cloudConsent: true`, one stub hit, a `transcribe:fallback` event in the project's events; same clip with the project off → unclear, no hit, `cloudConsent: false`; project on but clip without `cloudConsent` → unclear, no hit. Mutation: make `queueTranscription` pass `allowCloud: true` unconditionally → the two negative cases fail.

T3. Drift test (`test/unit/schema.test.mjs`) passes with the new fields; mutation: drop `cloudConsent` from the json block → fails.

T4. Full `npm test` at the final commit: all passed.

## Definition of done

- R1–R8; T1–T4 with mutations in the pull request; the fixture's verification decode in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. Trigger is "clean primary result rejected by the guard", never an error or the language fallback: an infrastructure failure must not become a stream of paid calls, and a configuration problem must be fixed, not papered over.
2. Consent is per clip and set by the client only when the label the contributor ticked carried the clause (011); the server ANDs it with the project setting at creation and the fallback checks all three flags at run time, so a setting switched on later never applies to older clips.
3. `allowCloud`/`cloud` naming avoids the existing `fallback` boolean on backend results.
4. Split in two: server first (safe alone, since no client sends the flag yet), client second.
5. Events are inserted server-side under session `'server'`; documented as a partial session.
6. Depends on PR #10 (SCHEMA.md): rebase after it merges; the drift test is the guard that the document was updated.
7. The e2e uses an API-only path and a committed "Thank you." fixture rather than silence, because short silence is not unclear and longer silence decodes nondeterministically.
