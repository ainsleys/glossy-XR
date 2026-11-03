# 007 · The record and export formats have a document of their own

## Problem

The shape of an annotation record, the native export (`schema: glossy-xr/project/0.4`) and the Europeana Data Model mapping are described only inside the README, spread over the "Annotation record", "Export" and EDM paragraphs and in comments at the top of `server/edm.js`. Someone who wants to read a `GET /api/projects/:id/export` file into another system, or validate one, has no single reference: no list of every field with its type and meaning, no statement of what is optional, no versioning rule, and the EDM node-by-node mapping is a comment in source.

## Goal

One document, `docs/SCHEMA.md`, that fully describes the native record, the export document and the EDM serialisation as they are today, written from the code and checked against a real export by a test.

## Requirements

R1. **Native record.** Every field of an annotation as returned by `GET /api/projects/:id/annotations` and stored in SQLite (`server/db.js`): name, type, whether it can be null or absent, meaning, where it comes from (client, server, reviewer). Written from `db.js` and `server/index.js`, not from the README. Includes: `id`, `project`, `author`, `createdAt`, `layer`, `consent`, `audioUrl`, `durationMs`, `anchor` (`x`, `y`, `z`, and `objectId` only when set), `period` (`from`, `to`, `label`, or null), `pose[]` (`t`, `p`, `q`), `poseSource`, `hands` (`joints`, `rate`, `frames[]` with `t`/`l`/`r`/`lf`/`rf`, `filled` `{l, r, gaps, maxGapMs}`), `parent`, `replies` (computed count, not stored), `prompt`, `mode`, `language`, `transcript`, `transcription` (`status` ∈ none/pending/done/failed/skipped; `{status}` alone until a result is stored; then `words[]`, `language`, `detected`, `heard`, `backend`, `model`, `ms`, `unclear`, `raw`; `error` only on failure), `links[]` (`kind`, `asset`, `url`, `title`). A "computed, not stored" note for `retried` and `fallback` (returned by the transcriber, dropped by the server). Units and conventions stated once: scene metres, Y up, quaternion `[x, y, z, w]`, clip milliseconds, 25 WebXR joints in the fixed order, ISO 8601 for `createdAt`.

R2. **Project and assets.** The project record as the API returns it (`id`, `name`, `createdAt`, `language`, `script.questions[]`, embedded `assets[]`; `annotationCount` only in the list form; there is no project-level `transform` any more) and the asset record (`id`, `project`, `url`, `type`, `name`, `sort`, `createdAt`, `transform`, `visible`, `options` which today holds only `mode`).

R3. **Native export.** Written from the export mapping in `server/index.js`: `schema` (`glossy-xr/project/0.4`), `exportedAt`, the project node, `contributions[]` and how they differ from the record (`attribution`, `timestamp`, `audio`, `words`; `replies`, `transcription.status`, `unclear`, `detected` and `model` are dropped), that withdrawn-consent clips stay in the native export with `consent: false` (only EDM omits them), that audio is referenced by URL and not embedded, and the all-projects form at `GET /api/export` with its own `schema` string `glossy-xr/all/0.4`. EDM exists only per project (`?format=edm`).

R4. **EDM serialisation.** Node by node, from `server/edm.js`: `edm:ProvidedCHO` per contribution and for the project, `edm:WebResource` for audio and linked photographs, `ore:Aggregation`, `edm:TimeSpan` from `period`, the `@context`, what goes under the `glossy:` namespace and why, the rights and provider configuration (`GLOSSY_RIGHTS`, `GLOSSY_PROVIDER`, `GLOSSY_BASE_URL`), and the consent rule (withdrawn clips omitted, counted on the project node).

R5. **Versioning.** Nothing in the code or README states a rule; the history fits one (`poseSource`, `links`, `hands` were added under 0.4 without a bump). Write it down as current practice, not as an existing rule: the `schema` string names the export version; additive fields keep it; a renamed or removed field bumps it.

R6. **Checked by a test.** `docs/SCHEMA.md` carries one fenced `json` block listing the field names it documents, keyed `record`, `contribution` and `context` (nested names as dotted paths, e.g. `hands.filled.gaps`). A unit test (`test/unit/schema.test.mjs`, `node:test`, no new dependency) reads that block and compares each list, in both directions, against the code: builds a temp `GLOSSY_DATA`, creates one full record through `openDb` from `server/db.js` (with pose, hands, links, and a stored transcript via `setTranscript`, since `seed-dense` leaves those empty), spawns `node server/index.js` with `GLOSSY_TRANSCRIBE=none` on a free port (the module opens the database and listens on import, so it cannot be imported in-process), fetches `GET /api/projects/:id/annotations` and `/export`, and calls the exported `toEdm()` for the `@context` keys; then kills the server. A second check confirms each listed name also appears as a row in the document's tables. The test fails when the document and the code disagree in either direction.

R7. **README.** The README's "Annotation record", "Export" and EDM paragraphs keep their prose but each gains one sentence pointing to `docs/SCHEMA.md` as the reference; duplicated field lists in the README may be shortened to the pointer.

## Non-goals

- No change to any format, field, name or version. This documents what exists.
- No CIDOC-CRM, no OAI-PMH, no JSON Schema file (a follow-up if someone asks for machine validation).
- No change to `server/` or `client/` code.

## Design

`docs/SCHEMA.md` in sections mirroring R1–R5, tables for fields, plus the machine-readable `json` block at the end. The unit test spawns the server with a temp data dir and a free port; no production code changes.

## Tests

T1. `node --test test/unit/schema.test.mjs` passes. Mutation A: remove one name from the `json` block → fails naming the missing field. Mutation B: add a fictitious name → fails naming the extra field. Mutation C: remove a name from a table but leave it in the block → the table check fails. Mutation D: temporarily remove a key from `CONTEXT` in `server/edm.js` → the context check fails; restore. All restored.

T2. The full `npm test` at the final commit: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R7; T1 with its three mutations and T2 recorded in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. Field lists are written from `db.js` and `index.js`, not from the README, which already omits `id` and `hands` in its export list.
2. `retried`/`fallback` are documented as computed-not-stored, so nobody looks for them in a record.
3. The versioning paragraph is explicitly "practice written down", since no rule existed.
4. The drift test spawns the server (the module listens on import) and builds a full record through `db.js`; a committed fixture export would itself drift.
5. A fenced `json` block is the machine-readable source; tables are for people, and the test checks the two agree.
6. The table check runs both ways: a row in a `Field` table whose name is not in the `json` block fails, as does a listed name with no row (mutation E: a `transcription.bogus` row in the record table only).
7. The `json` block also lists `project` (from `GET /api/projects/:id` and `GET /api/projects` together, so `annotationCount` is covered; only the top level of `script`) and `asset` (including `transform.*`, set through `db.assets.update`), each with its own table (mutation F: remove `annotationCount` from the block).
8. The test fails fast and says why when the spawned server exits before answering, and prints its stderr; the free port is chosen before the server listens, a race the test notes but does not close.
