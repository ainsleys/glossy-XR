# Glossy XR

**Spatially anchored, multi-user voice annotation inside a 3D scene, in the browser.**

Put on a headset, pull the trigger, say something, let go. The recording is pinned to the surface you were pointing at, tagged with who said it, when, and which layer it belongs to (a draft, a review pass, a period of time, whatever the project needs). Everyone else who opens the project hears it there. Walk up to a marker and it plays. Export the whole set as JSON.

Glossy XR is the 2026 rebuild of [Glossy](https://github.com/ainsleys/glossy), a prototype Ainsley Sutherland built at the BuzzFeed Open Lab in October 2016 to let editors and producers leave notes inside a VR piece instead of describing positions in an email. The idea carried through [Voxhop](https://knightfoundation.org/articles/11-ideas-win-journalism-360-challenge-on-immersive-storytelling/) (Knight Foundation / Google News Lab Journalism 360 award, 2017) and MediateVR. This repository is the working codebase for the next iteration.

## What changed since 2016

The original ran on the WebVR API, which browsers removed in 2020. Nothing in the 2016 stack runs today. The interaction model is kept exactly; everything underneath is replaced.

| | 2016 | 2026 |
|---|---|---|
| Headset API | WebVR + polyfill + webvr-boilerplate | WebXR Device API |
| Rendering | three.js r79, VRControls / VREffect | three.js r186, `renderer.xr`, controller events |
| Audio capture | recorder.js + opus worker, WAV | `MediaRecorder`, webm/opus |
| Transport | Socket.IO 1 | Socket.IO 4, one room per project |
| Storage | audio base64-encoded into MongoDB documents | SQLite (`node:sqlite`) for metadata, files on disk for audio and models |
| Environment | a textured box | any glTF/GLB, PLY, PCD, OBJ, or Gaussian splat, per project |
| Anchoring | fixed offset from the controller | the surface the user points at, with the mesh name |
| Build | script tags, jQuery, `node_modules` committed | Vite, ES modules, no framework |
| Record shape | `{id, x, y, z, audioObject}` | author, timestamp, anchor, layer, consent, transcript slot |

The server also no longer emits the previous record instead of the one just saved, a bug noted in the 2016 commit log.

## Projects and models

A project owns one model and its annotations. Create one in the HUD, upload a model, and the viewer auto-fits it (millimetre scans shrink to a few metres, unitless toys grow to a metre, everything rests on the floor) and saves that transform with the project. Adjust scale, rotation, offset, and point size in the Model panel; `Z-up→Y` fixes scans exported Z-up.

| Format | Loader | Notes |
|---|---|---|
| `.glb` `.gltf` | GLTFLoader with Draco, KTX2, meshopt | Upload `.bin` and texture sidecars together with a `.gltf` |
| `.ply` | PLYLoader | Mesh if it has faces, point cloud otherwise. A PLY with 3DGS properties (`f_dc_0`, `scale_0`) is treated as a splat |
| `.pcd` | PCDLoader | ascii, binary, and binary_compressed; NaN rows from organized depth-camera clouds are dropped |
| `.obj` | OBJLoader + MTLLoader | Upload `.mtl` and textures alongside |
| `.splat` `.ksplat` `.spz` `.sog` | [Spark](https://sparkjs.dev) | WebGL and WebXR capable; anchors raycast against splats |

Tested on 12 Oct 2026 with public-domain or permissively licensed files: Khronos SheenChair (GLB, PNG textures, sheen and variants extensions), Smithsonian Cosmic Buddha (GLB in millimetres, Draco GLB, and OBJ+MTL with 4096px maps), Stanford bunny (ASCII PLY range scan as point cloud, and zippered mesh), PCL table scene (organized binary_compressed PCD with rgba) and colored cloud (binary PCD), Keenan Crane's Spot (OBJ), and Spark's butterfly sample (SPZ). One file did not work: the `hornedlizard.spz` sample from the nianticlabs/spz repository decodes to noise in Spark 2.3.1 even though its header (version 2, 12 fractional bits) matches the butterfly's; treat that as a Spark decoder issue to report upstream.

## Annotation record

```json
{
  "id": "011e1a87-…",
  "project": "2786d4af",
  "author": "Ainsley",
  "createdAt": "2026-10-12T12:25:36.267Z",
  "anchor": { "x": 0.1, "y": 0.9, "z": -1.2, "objectId": "pot" },
  "layer": "review",
  "audioUrl": "/audio/011e1a87-….webm",
  "durationMs": 1000,
  "transcript": null,
  "consent": true
}
```

`GET /api/projects/:id/export` returns a project with all its annotations; `GET /api/export` returns everything. `transcript` is reserved for a later speech-to-text pass.

## Run it

```sh
npm install
npm run dev        # API on :3000, client on http://localhost:5173
```

Node 22.13 or newer (for `node:sqlite`). Data lives in `data/` (`glossy.db`, `audio/`, `models/`); set `GLOSSY_DATA` to move it. A pre-SQLite `annotations.json` found there is imported once into a project called `default`.

**Desktop:** click the canvas, `W A S D` to move, `Q`/`E` down and up, `Shift` to run, `K` start recording, `L` stop, `Space` play the marker you are looking at. Walking within about a metre of a marker on the active layer also plays it.

**Headset (Quest 3 or any WebXR browser):** the headset reaches your machine by IP, which browsers do not treat as secure, so either serve HTTPS and accept the self-signed certificate once:

```sh
HTTPS=1 npm run dev     # then open https://<your-ip>:5173 and press Enter VR
```

or, for Quest over USB, `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173`. Trigger records while held (release to save) or plays a marker you are pointing at. Squeeze cycles the layer.

**Production:** `npm run build && npm start` serves client and API from one process on `:3000`. `GLOSSY_MAX_MODEL_MB` caps uploads (default 1024).

## API

| Method | Path | |
|---|---|---|
| GET / POST | `/api/projects` | list; create `{name}` |
| GET / PATCH / DELETE | `/api/projects/:id` | read; update `{name, transform}`; delete with files |
| POST | `/api/projects/:id/model` | multipart `model` plus optional `files` sidecars |
| GET / POST | `/api/projects/:id/annotations` | list; create (multipart `audio`, `x`, `y`, `z`, `author`, `layer`, `consent=true`, optional `objectId`, `durationMs`) |
| DELETE | `/api/projects/:id/annotations/:aid` | remove record and file |
| GET | `/api/projects/:id/export`, `/api/export` | JSON export |
| GET | `/audio/<id>.webm`, `/models/<project>/<file>` | files |
| Socket.IO | `join {project}` → `annotation:all`; then `annotation:new`, `annotation:deleted`, `project:updated`, `project:created`, `project:deleted` | live sync |

Validation: anchor must be numeric, author required, consent must be `true`, model extension must be supported. Rejected uploads are deleted from disk.

## Status

Verified 12 Oct 2026: server round-trip (projects, model upload, annotations, export, delete, restart persistence) with curl; desktop client rendering, project switching, and every format in the table above in Chrome. Not yet verified: recording through a live microphone prompt, and the WebXR path on a headset.

## Known limits

- Point-cloud raycasting is brute force; clouds over 3 M points skip surface anchoring and fall back to a point just ahead of the controller.
- The JSON store became SQLite, but there is still no auth: anyone who can reach the server can do anything.
- Transcripts are a reserved column with no pipeline behind them.
- The three.js bundle is not code-split; Spark loads lazily only when a splat is opened.

## Roadmap

- Companion web form bound to an existing anchor: text, photos, consent from a phone or tablet, no headset needed.
- Speech-to-text into `transcript`.
- Export mapped to standard metadata schemas.
- Accounts, project membership, share links, object storage for files.

## Lineage

`ainsleys/glossy` holds the 2016 history plus one 2026 snapshot commit. Development continues here.

MIT.
