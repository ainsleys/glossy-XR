# Glossy XR

Spatially anchored, multi-user voice annotation for WebXR.

This is a port of **Glossy** (BuzzFeed Open Lab, October 2016, [ainsleys/glossy](https://github.com/ainsleys/glossy), forked to [buzzfeed-openlab/glossy](https://github.com/buzzfeed-openlab/glossy)) to the browser APIs that exist in 2026. The interaction model is unchanged: pull the trigger, speak, release, and the clip is dropped at the controller's position; everyone else in the scene hears it there. The plumbing is entirely new, because every piece of the 2016 stack has been removed from browsers or from three.js.

| 2016 | 2026 |
|---|---|
| WebVR (`navigator.getVRDisplays`), webvr-polyfill, webvr-boilerplate | WebXR Device API via `renderer.xr`, `VRButton`, `XRControllerModelFactory` |
| three.js r79, `VRControls` / `VREffect`, hand-polled Vive gamepads | three.js r186 ESM, `selectstart` / `selectend` / `squeezestart` controller events |
| recorder.js + opus-recorder worker, WAV blobs | `MediaRecorder` (webm/opus) |
| socket.io 1.x, audio base64-encoded into Mongo documents | Socket.IO 4, audio files on disk, JSON metadata store |
| jQuery, script tags, `node_modules` committed | Vite, no framework |
| "lagging one behind" bug (server emitted the last row, not the saved one) | server emits the record it just wrote |

The private `ainsleys/mediate` repository (Jan 2017) is a byte-identical copy of `glossy`; nothing from Mediate's later work is in here.

## Annotation record

Each contribution carries the four fields the HERIFORGE 2nd Open Call (Türkiye Hub Challenge 2, "Living Layers") requires: **attribution, timestamp, spatial anchor, temporal reference**, in an exportable JSON document.

```json
{
  "id": "011e1a87-36fc-4a7a-8f93-0a068772824e",
  "scene": "default",
  "author": "Ainsley",
  "createdAt": "2026-10-12T12:25:36.267Z",
  "anchor": { "x": 0.1, "y": 0.9, "z": -1.2, "objectId": "copper-pot" },
  "timeLayer": "1950s",
  "audioUrl": "/audio/011e1a87-36fc-4a7a-8f93-0a068772824e.webm",
  "durationMs": 1000,
  "transcript": null,
  "consent": true
}
```

`GET /api/export` returns the whole store with a schema tag. `transcript` is reserved for a later speech-to-text pass, which the 2016 post listed as the next step.

## Run

```sh
npm install
npm run dev          # API on :3000, client on http://localhost:5173
```

Desktop: click the canvas to capture the mouse, `W A S D` to move, `K` to start recording, `L` to stop. The clip is anchored 60 cm in front of the camera. `Space` plays the marker you are looking at. Walking within 1.2 m of a marker on the active time layer plays it.

Headset (Quest 3 or any WebXR browser): the headset reaches the dev machine by IP, which is not a secure context, so serve over HTTPS and accept the self-signed certificate once:

```sh
HTTPS=1 npm run dev
# open https://<your-mac-ip>:5173/ in the headset browser, press "Enter VR"
```

Trigger: record while held (release to save) or, if pointing at a marker, play it. Squeeze: cycle the time layer. Alternative for Quest: `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173`, which needs no certificate.

Optional environment: `?scene=/models/house.glb` loads a glTF in place of the default room (serve it from `client/public/`).

Production: `npm run build && npm start` serves the built client and the API from one process on `:3000`. Set `GLOSSY_DATA` to move the store.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/annotations?scene=` | list |
| POST | `/api/annotations` | multipart: `audio`, `x`, `y`, `z`, `author`, `timeLayer`, `consent=true`, optional `objectId`, `scene`, `durationMs` |
| DELETE | `/api/annotations/:id` | remove record and file |
| GET | `/api/export` | full JSON export |
| GET | `/audio/<id>.webm` | clip |
| WS | `annotation:all`, `annotation:new`, `annotation:deleted` | Socket.IO events |

Validation: anchor must be numeric, author required, consent must be `true`. Rejected uploads are deleted from disk.

## Status

Verified on 2026-10-12: server round-trip (post, list, serve audio, export, delete) with curl; desktop client renders, connects, and loads stored markers in Chrome. **Not yet verified:** recording through a real microphone permission prompt, and the WebXR path on a headset. Both use standard APIs and should work, but test before demoing.

## Next

- Web companion form (phone or tablet) bound to an existing anchor, for text, photo and consent capture without a headset.
- Speech-to-text into `transcript`.
- Export mapping to a Dublin Core / CIDOC CRM-shaped record.
- Replace the JSON file with SQLite once there is more than one scene.
- Code-split three.js (the bundle is ~690 kB minified).
