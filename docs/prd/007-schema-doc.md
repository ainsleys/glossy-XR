# 007 · The record and export formats have a document of their own

## Problem

The shape of an annotation record, the native export (`schema: glossy-xr/project/0.4`) and the Europeana Data Model mapping are described only inside the README, spread over the "Annotation record", "Export" and EDM paragraphs and in comments at the top of `server/edm.js`. Someone who wants to read a `GET /api/projects/:id/export` file into another system, or validate one, has no single reference: no list of every field with its type and meaning, no statement of what is optional, no versioning rule, and the EDM node-by-node mapping is a comment in source.

## Goal

One document, `docs/SCHEMA.md`, that fully describes the native record, the export document and the EDM serialisation as they are today, written from the code and checked against a real export by a test.

## Requirements

R1. **Native record.** Every field of an annotation as returned by `GET /api/projects/:id/annotations` and stored in SQLite (`server/db.js`): name, type, whether it can be null, meaning, where it comes from (client, server, reviewer), with the nested shapes written out: `anchor`, `period`, `pose[]` samples, `hands` (joints, frames, `l`/`r`/`lf`/`rf`, `filled`), `transcription` (`status`, `words[]`, `language`, `detected`, `heard`, `backend`, `model`, `ms`, `unclear`, `raw`), `links[]`. Units and conventions stated once: scene metres, Y up, quaternion `[x, y, z, w]`, clip milliseconds, 25 WebXR joints in the fixed order, times in ISO 8601 for `createdAt`.

R2. **Project and assets.** The project record and asset record shapes (`transform`, `visible`, `options.mode`, `language`, `script.questions[]`) as the API returns them.

R3. **Native export.** The export document: `schema` version string, project node, `contributions[]` and how they differ in naming from the record (`attribution`, `timestamp`, `audio`, `words`), what is omitted and why (audio bytes are referenced by URL, not embedded), and the all-projects form at `GET /api/export`.

R4. **EDM serialisation.** Node by node, from `server/edm.js`: `edm:ProvidedCHO` per contribution and for the project, `edm:WebResource` for audio and linked photographs, `ore:Aggregation`, `edm:TimeSpan` from `period`, the `@context`, what goes under the `glossy:` namespace and why, the rights and provider configuration (`GLOSSY_RIGHTS`, `GLOSSY_PROVIDER`, `GLOSSY_BASE_URL`), and the consent rule (withdrawn clips omitted, counted on the project node).

R5. **Versioning.** The rule as it exists: the `schema` string names the export version; additive changes keep the version; a renamed or removed field bumps it. One paragraph.

R6. **Checked by a test.** A unit test (`test/unit/schema.test.mjs`) reads `docs/SCHEMA.md`, extracts the field names it lists for the record, the export contribution and the EDM `@context`, and compares each set against the code: the record fields against the columns/JSON keys `server/db.js` produces (use a fixture record from `scripts/seed-dense.mjs` or construct one through `db.js` with a temp data dir), the contribution fields against `server/index.js`'s export mapping, and the context keys against `server/edm.js`'s `CONTEXT`. The test fails when the document and the code disagree in either direction, so the document cannot drift silently.

R7. **README.** The README's "Annotation record", "Export" and EDM paragraphs keep their prose but each gains one sentence pointing to `docs/SCHEMA.md` as the reference; duplicated field lists in the README may be shortened to the pointer.

## Non-goals

- No change to any format, field, name or version. This documents what exists.
- No CIDOC-CRM, no OAI-PMH, no JSON Schema file (a follow-up if someone asks for machine validation).
- No change to `server/` or `client/` code.

## Design

`docs/SCHEMA.md` in sections mirroring R1–R5, tables for fields. The unit test uses `node:test`, parses the Markdown tables with a small regex (first column = field name) and has no new dependency.

## Tests

T1. `node --test test/unit/schema.test.mjs` passes. Mutation A: remove one row from the record table in `docs/SCHEMA.md` → fails naming the missing field. Mutation B: add a fictitious row → fails naming the extra field. Mutation C: remove a key from `CONTEXT` in a temporary copy or via the test's extraction path → fails. Restore all.

T2. The full `npm test` at the final commit: all passed (optional interior scene test may be skipped).

## Definition of done

- R1–R7; T1 with its three mutations and T2 recorded in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
