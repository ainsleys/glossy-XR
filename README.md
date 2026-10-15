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
| Storage | audio base64-encoded into MongoDB documents | SQLite (`node:sqlite`) for metadata, files on disk for audio and assets |
| Transcription | none | Whisper on the server (transformers.js), word-timestamped |
| Environment | a textured box | any mix of glTF/GLB, PLY, PCD, OBJ, Gaussian splats, photos, panoramas, and video per project |
| Anchoring | fixed offset from the controller | the surface the user points at, with the mesh name |
| Build | script tags, jQuery, `node_modules` committed | Vite, ES modules, no framework |
| Record shape | `{id, x, y, z, audioObject}` | author, timestamp, anchor, period, layer, consent, transcript with word timestamps, head pose over the clip, parent (replies), prompt (interview) |

The server also no longer emits the previous record instead of the one just saved, a bug noted in the 2016 commit log.

## Projects and assets

A project owns a set of assets and its annotations. Meshes, point clouds, Gaussian splats, flat photos, 360 panoramas, and video can share one scene, each with its own transform and visibility. Add an asset in the HUD and the viewer auto-fits it on first load (millimetre scans shrink to a few metres, unitless toys grow to a metre, everything rests on the floor, later assets step sideways so they don't overlap) and saves that transform. Click an asset's name to edit its scale, rotation, offset, and point size; `Z-up→Y` fixes scans exported Z-up.

| Format | Loader | Notes |
|---|---|---|
| `.glb` `.gltf` | GLTFLoader with Draco, KTX2, meshopt | Upload `.bin` and texture sidecars together with a `.gltf` |
| `.ply` | PLYLoader | Mesh if it has faces, point cloud otherwise. A PLY with 3DGS properties (`f_dc_0`, `scale_0`) is treated as a splat |
| `.pcd` | PCDLoader | ascii, binary, and binary_compressed; NaN rows from organized depth-camera clouds are dropped |
| `.obj` | OBJLoader + MTLLoader | Upload `.mtl` and textures alongside |
| `.splat` `.ksplat` `.spz` `.sog` | [Spark](https://sparkjs.dev) | WebGL and WebXR capable; anchors use a cone test over splat centres |
| `.png` `.jpg` `.webp` `.avif` | TextureLoader | A plane 1 m wide with the photo as an unlit texture, standing on the floor. A 2:1 image (or the "360" checkbox) becomes an inside-out sphere you stand inside |
| `.mp4` `.webm` `.mov` | VideoTexture | Same as images, muted and looping |

Tested on 12 Oct 2026 with public-domain or permissively licensed files: Khronos SheenChair (GLB, PNG textures, sheen and variants extensions), Smithsonian Cosmic Buddha (GLB in millimetres, Draco GLB, and OBJ+MTL with 4096px maps), Stanford bunny (ASCII PLY range scan as point cloud, and zippered mesh), PCL table scene (organized binary_compressed PCD with rgba) and colored cloud (binary PCD), Keenan Crane's Spot (OBJ), and Spark's butterfly sample (SPZ). One file did not work: the `hornedlizard.spz` sample from the nianticlabs/spz repository decodes to noise in Spark 2.3.1 even though its header (version 2, 12 fractional bits) matches the butterfly's; treat that as a Spark decoder issue to report upstream.

## Annotation record

```json
{
  "id": "011e1a87-…",
  "project": "2786d4af",
  "author": "Ainsley",
  "createdAt": "2026-10-12T12:25:36.267Z",
  "anchor": { "x": 0.1, "y": 0.9, "z": -1.2, "objectId": "pot" },
  "period": { "from": "1950", "to": "1965", "label": "harvest years" },
  "parent": null,
  "replies": 2,
  "mode": "interview",
  "prompt": "Where did the family eat in summer?",
  "language": null,
  "pose": [{ "t": 0, "p": [0.4, 1.6, 0.6], "q": [0, 0.38, 0, 0.92] }, { "t": 100, "p": [0.4, 1.6, 0.6], "q": [0.01, 0.4, 0, 0.92] }],
  "poseSource": "xr",
  "layer": "review",
  "audioUrl": "/audio/011e1a87-….webm",
  "durationMs": 1000,
  "transcript": "The lamp on the table is broken.",
  "transcription": { "status": "done", "words": [{ "w": "The", "s": 0, "e": 0.2 }, { "w": "lamp", "s": 0.2, "e": 0.5 }], "language": "en", "detected": true, "backend": "local", "model": "onnx-community/whisper-base_timestamped", "ms": 760 },
  "consent": true
}
```

- `period` is the temporal reference: free-form `from`, `to`, `label` strings (years, dates, "always"), or `null` when unspecified. It can be set at creation or afterwards with `PATCH …/annotations/:aid {period}`.
- `parent` makes the record a reply to another clip in the same project; a reply shares its parent's anchor and shows as a small marker above it. Replies are one level deep: a reply to a reply attaches to the original. `replies` counts them, and the server broadcasts the parent's record whenever the count changes. Erasing the parent detaches its replies, which continue as roots at the same anchor.
- `pose` is the author's viewpoint sampled at 10 Hz for the length of the clip, in scene coordinates, and `poseSource` says what produced it: `xr` for the headset pose, `desktop` for the mouse-steered virtual camera. The headset trace is a gaze path and lets a later viewer see where the speaker was looking at a given word; the desktop trace is only where the view was pointed, and a viewer should treat it as such or ignore it.
- `prompt` and `mode` record that the clip was an answer to a question in interview mode (below); otherwise `mode` is `walk`.
- `language` is a per-clip transcription language, rarely set; the project's language or detection usually decides. The detected or applied language is in `transcription.language`, with `detected` saying which.

`GET /api/projects/:id/export` returns the project and its contributions; `GET /api/export` returns every project the same way. Each contribution carries `attribution`, `timestamp`, `anchor`, `period`, `parent`, `mode`, `prompt`, `layer`, `consent`, `audio`, `durationMs`, `language`, `transcript`, `words`, `pose` and `poseSource`, so a set can be reviewed, filtered by period or mapped to another schema without the viewer. Erasing a clip removes the row, the audio file and the derived data, and the export no longer contains it.

## Interview mode and replies

A project can hold a script: an ordered list of questions, edited in the HUD's Interview panel or set with `PATCH /api/projects/:id {script: {questions: [{text}]}}`. With interview mode ticked, the HUD shows one question at a time, **Ask** reads it aloud through the browser's speech synthesis (never while the microphone is open), and every clip recorded answers the current question: it is saved with `mode: "interview"` and `prompt` set to the question, and the panel advances. The intended use is a guided session with a former resident or an expert during prototyping, on a screen or in the headset, with the record written as they speak. The script is plain data, so a dialogue model can replace the fixed list later without changing what is stored.

To reply to a clip on desktop, aim at its marker and hold `R`; release to save. The reply records like any other clip, but with `parent` set and the parent's anchor. The HUD list nests replies under their parent and shows a reply count on it.

On release of the button or trigger, a provisional marker is placed in the scene before the clip is encoded or uploaded, so the mark lands where the speaker was still looking (the suite measures this at about 1 ms); the saved marker replaces it.

## Time and crowding

Time is a navigation axis. Untick **All periods** in the HUD and the year slider becomes the viewer's position in time: clips whose `period` includes the year stay, clips outside it disappear from the scene, the list and the aim ray, and clips with no period are timeless and always stay. The slider's range comes from the periods present in the project, and the label shows how many clips are in view. (The headset has no time control yet; it follows the HUD's setting.)

A crowded room stays readable without deleting anything: only the nearest 40 markers within 8 m draw at full size, the rest shrink to faint dots until approached, hovered or played, and clips older than 180 days draw a little dimmer. `node scripts/seed-dense.mjs --data data --count 200` seeds a project with 200 clips across three periods, several authors and layers, and replies, for trying this by hand; the suite seeds the same fixture and checks the rule, the frame time and the year filter.

## Transcription

Every clip is transcribed on the server after it is saved, off the request path. The record carries `transcript` (plain text) and `transcription` (`status`: `pending`, `done`, `failed`, or `skipped`; plus `words` as `[{w, s, e}]` with second offsets, `language`, `backend`, `model`, `ms`). Clients in the project receive `annotation:updated` when the text lands; the HUD list shows it under each entry and the crosshair status quotes it on hover. `POST /api/projects/:id/annotations/:aid/transcribe` re-runs one clip, and jobs left pending by a previous run are picked up on boot.

The default backend is Whisper running locally through transformers.js (ONNX on CPU, no Python): `onnx-community/whisper-base_timestamped`, quantised, about 77 MB downloaded on first use into `~/.cache/glossy-xr/models`. A two-second clip takes about half a second on an Apple laptop, plus about 0.2 s for language detection. Decoding needs `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`); without it the server logs a warning and marks clips `failed`.

Language is decided per clip: the clip's own `language` if set, else the project's (`PATCH /api/projects/:id {language: "tr"}`, or the select in the HUD), else `GLOSSY_LANGUAGE`, else the local backend detects it with one decoder step over Whisper's language tokens before transcribing. The library on its own would default to English without saying so, which is wrong for most of the speakers this tool is for. Codes are bare ISO codes (`tr`, not `tr-TR`). The record's `transcription` says what happened: `language` as applied, `detected: true` when it came from detection, `fallback: true` when English was used because the model could not say (English-only checkpoints such as `whisper-tiny.en` always transcribe English and ignore the setting). Detection reads the first 30 seconds of a clip. The suite checks a Turkish clip comes back as Turkish.

| Variable | Default | |
|---|---|---|
| `GLOSSY_TRANSCRIBE` | `local` | `openai` uses the Whisper API with `OPENAI_API_KEY`; `none` disables transcription (records are marked `skipped`) |
| `GLOSSY_WHISPER_MODEL` | `onnx-community/whisper-base_timestamped` | `whisper-small_timestamped` or `whisper-large-v3-turbo_timestamped` for better accuracy at more CPU |
| `GLOSSY_WHISPER_DTYPE` | `q8` | `fp32`, `fp16`, `q4` |
| `GLOSSY_LANGUAGE` | unset | ISO code to force for every clip, e.g. `tr`; unset means per project, else detected |
| `GLOSSY_MODEL_CACHE` | `~/.cache/glossy-xr/models` | |

Word timestamps are kept so later work can jump playback to a word, tag a clip by its content, or make the set of annotations queryable.

## Run it

```sh
npm install
npm run dev        # API on :3000, client on http://localhost:5173
```

Node 22.13 or newer (for `node:sqlite`) and `ffmpeg` on the PATH for transcription. Data lives in `data/` (`glossy.db`, `audio/`, `models/`); set `GLOSSY_DATA` to move it. A pre-SQLite `annotations.json` found there is imported once into a project called `default`, and single-model projects from earlier builds migrate into the assets table on first start.

**Desktop:** click the canvas to capture the mouse, `W A S D` to walk (floor following and wall collision by default; untick *Walk mode* to fly with `Q`/`E`), `Shift` to run, hold the mouse button to record at the crosshair and release to save, click a marker to play it, `Space` plays the marker under the crosshair, `Delete` twice removes it (the ✕ in the list also asks twice), `K`/`L` start and stop recording from the keyboard. Walking within about a metre of a marker lights it and previews it in the status row (author, period or age, first words); it plays on click. Tick *Autoplay clips on approach* to have clips on the active layer play as you walk up, for guided walks. A saved clip announces itself: the status line holds "saved" for two seconds, the marker blooms, and a short chime plays.

**Headset (Quest 3 or any WebXR browser):** the headset reaches your machine by IP, which browsers do not treat as secure, so either serve HTTPS and accept the self-signed certificate once:

```sh
HTTPS=1 npm run dev     # then open https://<your-ip>:5173 and press Enter VR
```

or, for Quest over USB, `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173`. Trigger records while held (release to save) or plays a marker you are pointing at. Squeeze cycles the layer.

**Production:** `npm run build && npm start` serves client and API from one process on `:3000`. `GLOSSY_MAX_MODEL_MB` caps uploads (default 1024).

## Testing

```sh
npm test               # headless end-to-end suite; npm run test:headed to watch it
```

Playwright drives a headless Chromium with software WebGL, a fake microphone fed from a generated tone, and, for the headset path, Meta's Immersive Web Emulation Runtime (IWER) standing in for a Quest 3. The suite starts its own API server on `:3100` with a throwaway data directory and Vite on `:5174`, so a running dev session is untouched. It covers: rendering the default room; walking with floor following and stopping at a wall; hold-to-record through the mouse, playback, hover feedback, and two-press delete; transcription of the clip (on macOS the fake microphone speaks a sentence from the system voice, and the test checks the words come back) and the re-transcribe endpoint; head pose captured over the clip; the provisional marker placed within 100 ms of release; the export shape and that an erased clip leaves the export and the disk; replies by holding `R` on a marker; interview mode advancing through a script and stamping each clip with its question; setting a period after the fact; a 200-clip room seeded with `scripts/seed-dense.mjs` (thinning, frame time, the year slider filtering by period, hidden clips not being aim targets); a click released before the microphone is ready; live sync to a second client; entering VR through the real `VRButton`, recording with the emulated controller's trigger, and cycling layers with squeeze. A second Playwright project (`chromium-tr`) runs the same browser with Turkish speech on the fake microphone (macOS `Yelda` voice) and checks language detection and the project-language override. `test/scene.spec.js` additionally uploads a real interior (OBJ + MTL + textures) when one is present at `../test-assets/interiors/fireplace_room` or `GLOSSY_TEST_SCENE`, and checks spawn on the floor, wall collision, and an annotation anchored to a named mesh. Screenshots land in `test-results/`.

Headless Chromium refuses the Pointer Lock API, so the client falls back to a software mouse capture (same controls, cursor stays visible, Esc releases); that fallback is what the tests exercise, and it also covers embedding contexts where pointer lock is denied.

## API

| Method | Path | |
|---|---|---|
| GET / POST | `/api/projects` | list; create `{name}` |
| GET / PATCH / DELETE | `/api/projects/:id` | read (includes `assets[]`, `language`, `script`); update `{name, transform, language, script}`; delete with files |
| GET / POST | `/api/projects/:id/assets` | list; add (multipart `model` plus optional `files` sidecars; `mode=sphere` for a panorama) |
| PATCH / DELETE | `/api/projects/:id/assets/:aid` | update `{name, transform, options, visible, sort}`; remove |
| GET / POST | `/api/projects/:id/annotations` | list; create (multipart `audio`, `x`, `y`, `z`, `author`, `layer`, `consent=true`; optional `objectId`, `durationMs`, `parent`, `period` (JSON), `pose` (JSON), `prompt`, `mode`, `language`) |
| PATCH / DELETE | `/api/projects/:id/annotations/:aid` | update `{layer, period, consent}` (a reviewer may withdraw consent after the fact; the clip stays until erased); erase record, audio file and derived data, detaching any replies |
| POST | `/api/projects/:id/annotations/:aid/transcribe` | re-run speech-to-text for one clip (202) |
| GET | `/api/projects/:id/export`, `/api/export` | JSON export, schema `glossy-xr/project/0.4`: project plus `contributions[]` |
| GET | `/audio/<id>.webm`, `/models/<project>/<file>` | files |
| Socket.IO | `join {project}` → `annotation:all`; then `annotation:new`, `annotation:updated` (transcript landed), `annotation:deleted`, `project:updated`, `project:created`, `project:deleted` | live sync |

Validation: anchor must be numeric, author required, consent must be `true`, model extension must be supported. Rejected uploads are deleted from disk.

## Status

Verified 12 Oct 2026: server round-trip (projects, model upload, annotations, export, delete, restart persistence) with curl; desktop client rendering, project switching, and every format in the table above in Chrome. Verified 13 Oct 2026 by the end-to-end suite: recording through `getUserMedia` and `MediaRecorder`, playback, delete, live sync, and the WebXR session and controller path against an emulated headset. Verified 15 Oct 2026 by the suite: language detection (Turkish and English), per-project language, head pose, provisional placement, export, replies, interview mode, periods. Not yet verified on physical hardware: a real Quest.

## Known limits

- Point-cloud raycasting is brute force; clouds over 3 M points skip surface anchoring and fall back to a point just ahead of the controller.
- The JSON store became SQLite, but there is still no auth: anyone who can reach the server can do anything.
- Transcription runs one clip at a time on the CPU; a long backlog (re-importing a big project) will take a while.
- The three.js bundle is not code-split; Spark loads lazily only when a splat is opened.

## Roadmap

- Companion web form bound to an existing anchor: text, photos, consent from a phone or tablet, no headset needed.
- Export mapped to standard metadata schemas (the contribution record already carries what Europeana Data Model and CIDOC-CRM mappings need).
- A time control inside the headset (the HUD slider exists); locking onto one voice while moving through time; replies from the controller in XR; a dialogue model driving the interview script.
- Accounts, project membership, share links, object storage for files.
- Production transcription: the local CPU backend is for development; a deployment should either switch to the API backend (`GLOSSY_TRANSCRIBE=openai`) or run a larger Whisper model on a box with the CPU or GPU for it.

## Lineage

`ainsleys/glossy` holds the 2016 history plus one 2026 snapshot commit. Development continues here.

MIT.
