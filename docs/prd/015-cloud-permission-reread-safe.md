# 015 · A failed permission re-read keeps the local transcript

## Problem

Before sending an unclear clip to the cloud backend, `server/transcribe.js` asks `job.opts.allowCloud()` (line ~225), which `server/index.js` implements by re-reading the clip and project from SQLite (line ~64). That call is inside the job's `try`; if it throws — a transient read error on the database, a locked file, a query that fails — the `catch` at line ~240 calls `finish(job, e, null)` and `server/index.js` (line ~74) marks the clip `failed` with the read error as its message, although the local transcription succeeded and is in hand. Boot re-queues only `pending` clips (index.js ~589), so the clip stays `failed` until someone uses the re-transcribe route. (If the database is already closed at shutdown, the result write fails too and is caught at ~210; this change helps the transient case.)

## Goal

When the permission check cannot be made, the clip keeps its local result and is not sent to the cloud.

## Requirements

R1. In `transcribe.js`, a throwing `allowCloud()` is treated as `false`: the primary result is finished as it stands (no `cloud` key), and a warning is logged naming the clip and the error (`transcribe: <id> permission check failed: <message>; keeping the <backend> result`).

R2. The behaviour for a non-throwing `allowCloud` is unchanged (all existing tests in `test/unit/transcribe-fallback.test.mjs` pass unmodified).

R3. One clause each, saying a check that throws counts as a refusal: the `server/transcribe.js` header comment (line ~20), the `createTranscriber` JSDoc (line ~176), and the fallback paragraph in `docs/SCHEMA.md` (line ~95).

## Non-goals

- No retry or re-queue of the permission check.
- No change to `index.js`'s `allowCloud` implementation, or to when it is called (still just before the secondary runs).
- Do not touch the corrupt-PLY test in `test/formats.spec.js`, expected to fail if still present.

## Design

Wrap the call in a small helper inside the loop: `const allowed = () => { try { return typeof f === 'function' ? !!f() : !!f; } catch (e) { log.warn(...); return false; } }` where `f = job.opts?.allowCloud`. Nothing else moves.

## Tests

T1. `test/unit/transcribe-fallback.test.mjs`, new test following the pattern of "allowCloud as a function is asked after the primary result, and false keeps the clip local" (line ~47). The file's `run()` helper hard-codes a silent logger, so either give `run()` an optional `log` argument or build `createTranscriber` directly in the test with a logger that records `warn` calls. The secondary backend is injected and would return clean text; `allowCloud` throws `new Error('database is locked')`; assert the job finishes with `err === null`, `result.text` equal to the primary's (unclear) text, `result.backend` the primary's name, no `cloud` key, the secondary's `transcribe` never called, and one `warn` whose text contains the clip id, "permission check failed" and "database is locked" (the outer catch's message says "failed:" without "permission check", so this wording is what tells the two apart). Covers R1. Mutation: remove the `try/catch` → the test fails on `err` and on the warn text.

T2. The existing suite in that file unchanged and passing (R2).

## Definition of done

- R1–R3; T1 passing and shown to fail under its mutation; `node --test test/unit/` green; full `npm test` counts in the pull request (the corrupt-PLY expected failure is acceptable if still present).
- README: the transcription section, only if it describes the permission re-read; one clause at most.

## Decisions

1. Problem text corrected: `failed` is not terminal (the re-transcribe route exists) but is not re-queued at boot; the shutdown example replaced by a transient read error, since a closed database would also fail the result write.
2. T1 must observe `warn` through its own logger (the file's helper is silent) and assert the "permission check failed" wording, because the outer catch also logs once under the mutation.
3. R3 names the three places that describe `allowCloud`.
