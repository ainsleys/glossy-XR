# 013 · The EDM export names each clip's audio format from the stored file

## Problem

`server/edm.js` writes `'dc:format': 'audio/webm'` for every clip's `edm:WebResource` (line 148), but the server stores clips in the container the uploader sent: `audioUpload` in `server/index.js` names the file `<uuid>.webm`, `.ogg` or `.m4a` from the upload's MIME type. A clip uploaded as `audio/ogg` or `audio/mp4` is exported as WebM, so a consumer of the EDM graph that trusts `dc:format` opens the audio with the wrong decoder. Assets already export their stored type (`'dc:format': as.type`, line 99); clips do not.

## Goal

The EDM export's `dc:format` for a clip is the media type named by the stored file's extension.

## Requirements

R1. In `server/edm.js`, derive the clip's `dc:format` from the extension of `a.audioUrl`: `.webm` → `audio/webm`, `.ogg` → `audio/ogg`, `.m4a` → `audio/mp4`; any other or missing extension → `application/octet-stream`. One small function (`audioFormat(audioUrl)`) next to the existing `assetKind` helper, so the mapping is in one place and testable.

R2. The mapping is the inverse of the one in `audioUpload`'s `filename` in `server/index.js` (line ~224: a MIME type containing `ogg` → `.ogg`, `mp4` → `.m4a`, else `.webm`). A comment on each names the other. The upload naming itself is out of scope and unchanged. Rows imported from the pre-SQLite JSON store may carry any `audioUrl`; they get `application/octet-stream`.

R3. `docs/SCHEMA.md` line ~262: replace "`audio/webm` (whatever the container)" with "`audio/webm`, `audio/ogg` or `audio/mp4` by the stored file's extension, else `application/octet-stream`".

## Non-goals

- No change to what the server accepts or how it names files.
- No change to the asset `edm:WebResource` entries.
- No transcoding; the export describes the file as stored.
- Mislabelled uploads stay as they are: `audio/mpeg`, `audio/aac`, `audio/x-m4a` are stored as `.webm` by the upload naming and export as `audio/webm`.
- Do not touch the known expected-fail test in `test/formats.spec.js` (corrupt PLY).

## Design

`audioFormat` is a three-entry lookup on `path.extname(audioUrl).toLowerCase()`; `edm.js` has no imports; add `import path from 'node:path'`. The call site is the one object literal at line ~148.

## Tests

T1. New `node:test` file `test/unit/edm-format.test.mjs` (or a test added to `test/unit/schema.test.mjs`, which already calls `toEdm`): build a project with four synthetic clips whose `audioUrl` end `.webm`, `.ogg`, `.m4a` and have no extension, call `toEdm`, and assert the four audio `edm:WebResource` nodes carry `audio/webm`, `audio/ogg`, `audio/mp4`, `application/octet-stream`, matched by `@id`. Covers R1, R2. Mutation: restore the literal `'audio/webm'` → the ogg, mp4 and fallback assertions fail. The desktop EDM test's existing `'audio/webm'` assertion (`test/desktop.spec.js` ~129) stays as it is.

## Definition of done

- R1–R3 done; T1 passing and shown to fail under its mutation; full `npm test` counts in the pull request (the corrupt-PLY expected failure, if still present, is the only acceptable one).
- README: only if it states the export's audio format anywhere (check; likely nothing to change).

## Decisions

1. T1 moved from the desktop EDM test to a unit test on `toEdm`: adding clips to the desktop test breaks its contribution-count, `hasPart` and delete-tail assertions and queues transcription of junk bytes; `toEdm` is pure and already unit-tested.
2. Title and goal say "named by the stored file's extension", not "real format": the upload naming maps only ogg and mp4, so mislabelled uploads are stored as `.webm` and export as such (now a non-goal).
3. Legacy rows and the fallback stated explicitly; `edm.js` needs the `path` import added; SCHEMA.md edit named by line.
