# 014 · A file that is not a PLY is reported as a load error, not an empty cloud

## Problem

`loadPly` in `client/src/loaders.js` (line 82) hands whatever three.js's `PLYLoader` returns to `finish()`. For bytes with no PLY header, `PLYLoader` returns an empty geometry rather than throwing, so the page shows a point cloud of 0 points, `loaded.get(id).model` is set, `loaded.get(id).error` is not, and the asset list gives no sign that the file is unusable. `test/formats.spec.js` records this as an expected failure ("a .ply that is not a PLY is reported as a load error", `test.fail(true, …)` at line ~290).

## Goal

A `.ply` upload that does not parse to at least one vertex fails to load with a message that names the problem, and the page shows that error the way it shows other load errors.

## Requirements

R1. `loadPly` throws `Error('not a PLY file, or it has no vertices')` when the parsed geometry has no `position` attribute or `position.count === 0`. The error must reach the existing failure path in `client/src/main.js` (the `catch` that sets `entry.error = e.message` at line ~410), so `window.__glossy.loaded.get(id).error` is set and `model` is not.

R2. The check is made twice: on the parsed geometry, and, for the point-cloud branch, again after `stripNonFinite` (a cloud that is all NaN is empty too), with the same error.

R3. The check lives in `loadPly`, not in `loadModel`, so PCD/OBJ paths are unchanged.

## Non-goals

- No header sniffing before download (the 3DGS sniff `isGaussianPly` already reads the header; do not change it).
- No change to what the server accepts (`broken.ply` still uploads with 201; the client decides).
- No change to how `main.js` displays load errors.
- The splat paths (`.splat` and 3DGS PLY through Spark) are unchanged: `isGaussianPly` routes to `loadSplat` only when the header carries `f_dc_0` and `scale_0`, so non-PLY bytes never reach it.

## Design

After `loadAsync` in `loadPly`: `const pos = geometry.attributes.position; if (!pos || pos.count === 0) throw new Error('not a PLY file, or it has no vertices');` (dispose the geometry first); the same check on `cloud.attributes.position.count` after `stripNonFinite`. On junk bytes three's `PLYLoader` fails its header regex and returns a `position` attribute of count 0, which this catches; `main.js` starts `model` as `null` and sets it only on success, so the existing catch sets `entry.error`.

## Tests

T1. In `test/formats.spec.js`, remove the `test.fail(true, …)` line and the "Known gap" comment block above "a .ply that is not a PLY is reported as a load error"; keep its assertion and add, inside one `page.evaluate`, `{ hasModel: !!e.model, error: e.error }` (a THREE object does not serialise), asserting `hasModel` false and `error` containing "not a PLY". Covers R1, R3. Mutation: remove the throw → the test fails (model set, error unset).

T2. The existing PLY mesh and point-cloud tests in `formats.spec.js` still pass (R3), and the real-asset pass when `GLOSSY_TEST_ASSETS` is set (the bunny PLYs under `~/xr-annotation/test-assets`), run once by the implementer and recorded.

## Definition of done

- R1–R3; T1 passing and shown to fail under its mutation; `--repeat-each=5` on T1; full `npm test` with 0 expected failures now (this PR retires the only one). README does not mention the expected failure; nothing to change there unless a sentence describes PLY loading.

## Decisions

1. The Spark question (old R2) is moot: non-PLY bytes cannot reach `loadSplat` because the 3DGS sniff requires `f_dc_0` and `scale_0` in the header; recorded as a non-goal.
2. The check is repeated after `stripNonFinite` so an all-NaN cloud fails the same way.
3. T1 reads `!!e.model` inside `page.evaluate` and removes the "Known gap" comment with the `test.fail` line.
