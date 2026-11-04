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

Every field, with its type, when it can be null or absent, and who sets it, is in [docs/SCHEMA.md](docs/SCHEMA.md); the example and notes below are the short version.

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
  "hands": { "joints": ["wrist", "thumb-metacarpal", "…"], "rate": 20, "frames": [{ "t": 0, "l": [-0.21, 1.15, 0.24, "…"], "r": null }] },
  "layer": "review",
  "audioUrl": "/audio/011e1a87-….webm",
  "durationMs": 1000,
  "transcript": "The lamp on the table is broken.",
  "transcription": { "status": "done", "words": [{ "w": "The", "s": 0, "e": 0.2 }, { "w": "lamp", "s": 0.2, "e": 0.5 }], "language": "en", "detected": true, "heard": null, "backend": "local", "model": "onnx-community/whisper-base_timestamped", "ms": 760 },
  "links": [{ "kind": "image", "asset": "983dc0e1", "url": "/models/2786d4af/pekmez-1958.png", "title": "pekmez-1958.png" }],
  "consent": true
}
```

- `period` is the temporal reference: free-form `from`, `to`, `label` strings (years, dates, "always"), or `null` when unspecified. It can be set at creation or afterwards with `PATCH …/annotations/:aid {period}`.
- `parent` makes the record a reply to another clip in the same project; a reply shares its parent's anchor and shows as a small marker above it. Replies are one level deep: a reply to a reply attaches to the original. `replies` counts them, and the server broadcasts the parent's record whenever the count changes. Erasing the parent detaches its replies, which continue as roots at the same anchor.
- `pose` is the author's viewpoint sampled at 10 Hz for the length of the clip, in scene coordinates, and `poseSource` says what produced it: `xr` for the headset pose, `desktop` for the mouse-steered virtual camera. The headset trace is a gaze path and lets a later viewer see where the speaker was looking at a given word; the desktop trace is only where the view was pointed, and a viewer should treat it as such or ignore it. The room draws the headset trace on playback: while a clip plays, a small translucent head stands where the author stood, with a line along their gaze, moving in time with the voice beside the ghost hands. Walls and furniture hide it; a listener standing in the author's place sees the gaze line without the head around their eyes. Desktop traces are not drawn.
- `hands` is the gesture made while speaking, when the clip was recorded in a headset with hand tracking: the 25 WebXR joints of each hand at 20 Hz in scene metres, `l` and `r` per frame, `null` for a hand the headset could not see at that moment, `lf`/`rf` true on frames the server reconstructed across a short gap, and `filled: {l, r, gaps, maxGapMs}` counting them. `null` when no hand was ever tracked during the clip (controllers, desktop).
- `prompt` and `mode` record that the clip was an answer to a question in interview mode (below); otherwise `mode` is `walk`.
- `language` is a per-clip transcription language, rarely set; the project's language or detection usually decides. The detected or applied language is in `transcription.language`, with `detected` saying which; when a language was forced, `heard` holds what the detector would have chosen, and the clients flag a clip whose `heard` disagrees.
- `links` are what a reviewer attached to the clip afterwards: `kind` is `image`, `document` or `url`; `asset` names a project asset (a photograph linked on the review page is uploaded as an image asset placed at the clip), `url` and `title` are free. Set with `PATCH …/annotations/:aid {links: [...]}`.

`GET /api/projects/:id/export` returns the project and its contributions; `GET /api/export` returns every project the same way. Each contribution is the annotation record with its attribution, timestamp, place, period, transcript and word timings, pose, gesture and links, so a set can be reviewed, filtered by period or mapped to another schema without the viewer; [docs/SCHEMA.md](docs/SCHEMA.md#native-export) lists every field and how a contribution differs from the record. Erasing a clip removes the row, the audio file and the derived data, and the export no longer contains it.

### Standard export (Europeana Data Model)

`GET /api/projects/:id/export?format=edm` (the *Export EDM* link on the review page, *EDM* in the HUD) returns the same contributions as Europeana Data Model records in JSON-LD, media type `application/ld+json`. This is the shape in which collected annotations can go back into an institution's asset metadata: EDM reuses Dublin Core, so a Dublin Core pipeline reads the records as they are, and every statement is a triple, so a CIDOC-CRM mapping (contribution as `E73 Information Object` made in an `E7 Activity` by an `E21 Person` at an `E53 Place` about an `E52 Time-Span`) is a transformation of the graph, not a new export. The mapping follows the one-to-one principle as restated in Europeana's *Review of EDM to support 3D* (Isaac ed., 2024): the thing said is one node, the file that carries it another.

| Node | What it stands for | Properties |
|---|---|---|
| `edm:ProvidedCHO` (project) | the place | `dc:title`, `edm:type` `3D`, `dcterms:hasPart` → every included contribution, `glossy:contributions`, `glossy:withheldForConsent` |
| `edm:WebResource` (assets) | each scan, photo or video of the scene | `dc:title`, `dc:format`, `edm:type` (`3D`, `IMAGE`, `VIDEO`), `edm:rights` |
| `ore:Aggregation` (project) | | `edm:dataProvider`, `edm:provider`, `edm:rights`, `edm:isShownAt` (the room), `edm:isShownBy` (the scene asset), `edm:hasView` (the rest) |
| `edm:ProvidedCHO` (contribution) | what was said | `dc:creator` (attribution), `dcterms:created` (timestamp), `dcterms:spatial` (place and anchored object) plus `glossy:anchor` (scene coordinates), `dcterms:temporal` → `edm:TimeSpan` (the period), `dc:description` (transcript, language-tagged), `dc:language`, `dc:type` (`voice annotation`, `interview answer`, `reply to a voice annotation`), `edm:type` `SOUND`, `dcterms:isPartOf` → the place, `edm:isRelatedTo` and `glossy:replyTo` → the parent, `glossy:prompt`, `glossy:mode`, `glossy:layer`, `glossy:nativeRecord` → the native export |
| `edm:WebResource` (audio) | the recording | `dc:format` `audio/webm`, `ebucore:duration`, `dcterms:extent`, `dcterms:created`, `dc:creator`, `edm:rights`, `dcterms:provenance` (paradata: headset or desktop, transcription model and backend, whether the language was detected or set, whether the transcript was rejected) |
| `edm:WebResource` (photographs) | each file a reviewer linked | `dc:title`, `edm:type` `IMAGE`, `edm:rights` |
| `ore:Aggregation` (contribution) | | `edm:aggregatedCHO`, `edm:dataProvider`, `edm:provider`, `edm:rights`, `edm:ugc` `true`, `edm:isShownBy` (audio), `edm:isShownAt` (the clip in the room, `/?project=…&focus=…`), `edm:hasView` (photographs) |
| `edm:TimeSpan` | one per distinct period | `skos:prefLabel`, `edm:begin`, `edm:end` |

Clips whose author withdrew consent are left out, and the project node counts them. What EDM has no place for (the anchor coordinates, the layer, the mode, the question, the pose trace and word timings) stays under the `glossy:` namespace or in the native record the `glossy:nativeRecord` link points at, so nothing is lost, only set aside. Identifiers are URLs on this server (`GLOSSY_BASE_URL` sets the host for a deployment behind a proxy); `GLOSSY_PROVIDER` names the data provider and `GLOSSY_RIGHTS` is the licence URI for the set, one licence for all contributions, because that is what the consent text promises. The suite checks the record for a desktop clip (creator, timestamp, anchor, transcript, audio resource, aggregation, rights) and, on the review page, that a period becomes a TimeSpan, a linked photograph a view, and a withdrawn clip disappears from the set. The node-by-node mapping, the `@context` and the `glossy:` properties are set out in [docs/SCHEMA.md](docs/SCHEMA.md#edm-serialisation).

## Interview mode and replies

A project can hold a script: an ordered list of questions, edited in the HUD's Interview panel or set with `PATCH /api/projects/:id {script: {questions: [{text}]}}`. With interview mode ticked, the HUD shows one question at a time, **Ask** reads it aloud through the browser's speech synthesis (never while the microphone is open), and every clip recorded answers the current question: it is saved with `mode: "interview"` and `prompt` set to the question, and the panel advances. The intended use is a guided session with a former resident or an expert during prototyping, on a screen or in the headset, with the record written as they speak. The script is plain data, so a dialogue model can replace the fixed list later without changing what is stored.

To reply to a clip on desktop, aim at its marker and hold `R`; release to save. The reply records like any other clip, but with `parent` set and the parent's anchor. The HUD list nests replies under their parent and shows a reply count on it.

**The HUD.** The operator's panel reads top to bottom in the order things happen: the live line (what the tool is doing, the microphone level, the next key) first, then name and consent, the project and its links (review page, export, visitor view), the time slider, the Interview panel, and the clip list. Layer, transcription language, walk and autoplay sit in a closed *Settings* panel, the asset list and transforms in *Assets*, and the key reference in *Help*, so a demo from a laptop shows one column of what matters and three folded headings.

**Gestures.** "And then you stir it like this" is half words and half hands. In a headset with hand tracking the hands are part of the clip: while recording, the joints of both hands are sampled into `hands` next to the head pose (20 Hz, taken from the render loop so each frame carries the time it was actually posed; a timer slips under load), and on playback they are drawn as translucent ghost hands where they were made, in time with the voice, so a later visitor standing at the same pot sees the stir. Gaps are kept as gaps, then the short ones are filled: when a hand leaves the tracking cameras (behind the back, far out to the side, hidden by the other hand) its frames arrive as `null`. At save time the server reconstructs gaps of up to a second that have a tracked frame on both sides (`shared/hands-fill.js`): the wrist follows a cubic Hermite curve with the velocities measured over at least 100 ms of tracked frames on each side of the gap, so a stir keeps turning instead of cutting a chord, and the hand's shape is blended from one side to the other with bone lengths held. Every reconstructed frame is flagged (`lf`, `rf`) and the trace carries a `filled` count, so the export says what was seen and what was inferred, the ghost hand draws inferred frames grey, and the nulls can be put back. Longer gaps, and gaps at either end, stay empty. This is the kinematic baseline; a learned hand-motion prior is the research step on the roadmap. How the ghost hands are drawn is a setting (*Ghost hands* under Settings, or `?ghost=skeleton|solid|mesh&trail=1` in the URL so a headset can switch without the laptop): *skeleton* is the capture data itself, joints as beads and bones as lines; *solid* is capsules along the bones and a pad for the palm, lit, a hand-shaped volume; *mesh* is the generic WebXR hand model posed from the joints, with each joint's orientation derived from the chain and the palm (the trace stores positions only; -Z along the bone towards the tip, +Y out of the back of the hand, as WebXR defines joint spaces). *Trail* adds a ribbon behind each wrist for the last second or so, fading with age, so the path of a stir is visible as well as the hand. Skeleton is the default until the headset session says which reads; the mesh is fetched from the WebXR input-profiles CDN on first use. The review page marks such clips ✋, draws both wrist paths on the plan, and while the clip plays it thickens the stretch of path that belongs to the word at the playhead, so "like *this*" shows which part of the stir "this" was. With hands there is no trigger to hold, so a pinch is the trigger (hold to record, release to save, the pinch's own ray places the mark), and, with *Start a clip when I speak* on (the default, under Settings), speech starts a clip anchored where the headset looks and a pause of about a second ends it. The Ask voice never starts one. The threshold and the pause are a first guess; the open questions are coverage during a real stir, finger fidelity, and whether a two-handed gesture needs the interviewer on the button, which the Quest session will answer.

**Visitor mode.** Open the page with `?mode=visitor` (the HUD's *Visitor view* link does this for the current project) for the page an exhibition guest sees: the project selector, assets, layers, transcription language, the script editor and every erase control are hidden, the project's script is asked without a toggle, and Delete and the list's ✕ do nothing on that page. In the headset a small panel below the line of sight carries the current question, the status line (recording, saved, the near clip's preview) and the controller hints; a visitor's squeeze reads the question aloud instead of cycling layers. Visitor mode is a presentation setting, not access control: the API is unchanged.

**Interface language.** The client shows a contributor or visitor the consent label, the status line, the key hint, the visitor help, the clip list, the headset panel and the chat panel in the project's `uiLanguage`, English (`en`) or Turkish (`tr`), set under Settings or with `PATCH /api/projects/:id {uiLanguage: "tr"}`. It is separate from the transcription language, so a project can detect the spoken language and still show a Turkish interface. `?lang=tr` or `?lang=en` in the URL overrides the project for that page (a kiosk, a test); it is kept when the page rewrites its URL on opening a project and is carried in the *Visitor view* link. Operator panels (Settings, Assets, Help, the project selector, erase and re-transcribe controls), the session log and the review page stay English. The strings live in `shared/strings.js`; to add a language, add a block with every key of `en` there and in `LANGS`, add it to the server's accepted values and the Settings list, run `npm run test:unit` (it checks keys, variables and empty strings), and have a reviewer who reads the language read it. Turkish is signed off in code: `TR_REVIEWED` in `shared/strings.js` holds, for each Turkish key a reviewer who reads the language has read, a short hash of the string as it was read, and the unit test fails, naming the key, for any Turkish string that is missing there or has changed since. After a reading, `node scripts/sign-off-tr.mjs --by "<reviewer>"` records every current Turkish string and prints the keys; commit that with the reader's name in the message.

On release of the button or trigger, a provisional marker is placed in the scene before the clip is encoded or uploaded, so the mark lands where the speaker was still looking (the suite measures this at about 1 ms); the saved marker replaces it.

## Session log

Every page keeps a log of what happened to it and posts it to the server in small batches: the session beginning and ending, the headset session, input sources connecting and disconnecting (controller or hand, which side), the microphone becoming ready or being refused, each recording from start to end to saved or discarded with its source (trigger, pinch, voice, mouse, key, reply), the reason it ended (release, a voice pause, the track dying, the project changing) and, for a gesture, how many frames each hand was lost or reconstructed; playback, questions asked, page errors; and once a second while presenting or recording a `stats` line with the frame rate, how many render frames each tracked hand was actually seen in, and the microphone level. No audio and no transcript text go into it. The log is for the people running sessions: a morning in a headset leaves a record that can be read at the desk instead of reconstructed from memory, and the hand-tracking coverage and voice-start numbers the gesture work needs come out of it directly.

`GET /api/projects/:id/sessions` lists sessions (start, end, event count, client); `GET /api/projects/:id/events?session=…` returns the events, `&format=ndjson` one per line; `POST /api/projects/:id/events` is what the client calls. `node scripts/session-report.mjs --project <id>` prints a summary per session (recordings by source and outcome, clip lengths, placement times, false voice starts, hand loss per hand, frame rate, microphone level), `--events` the full trail. The vocabulary is listed at the top of `client/src/session-log.js`.

The server writes one kind of event itself: `transcribe:fallback {id, from, to, reason}` each time a clip is sent to the cloud fallback (below), with `error` when the call failed. These go under the session `server`, which has no `session:start`, so the sessions list shows it without a client and the report prints it as a partial session.

**Talking with the person in the headset.** A second panel in VR, left of the status panel, carries a conversation with the laptop. `POST /api/projects/:id/chat {text, session?}` puts a line on it. A pinch on the panel starts a spoken message; a pause of 1.5 s, or another pinch, sends it; the server stores the audio apart from the clips, transcribes it with the same engine, and the text appears on the panel and at `GET /api/projects/:id/chat?after=<id>` for whoever is at the laptop. While a message records, voice start and pinch-to-record stand down. The session log records that an exchange happened (`chat:listen`, `chat:sent`, `chat:received`), never the words.

**Recording with hands in a headset.** The default is the *wrist microphone*: a small microphone sits on the inside of the left wrist. Look at a thing, raise the microphone to your mouth, and a clip starts, anchored to what you were looking at as you raised it; the panel names it while you talk; lower the microphone and the clip is saved. The right pinch then only selects and plays. The other ways remain as settings: *pinch and hold*, and *speak to start* (voice start). Controllers keep the trigger; the desktop keeps the mouse button.

**Moving with the thumb (hands, headset).** On the Quest Browser a thumb swiped along the side of the index finger arrives as a microgesture, on either hand. Each hand has one axis, along its own index finger. The left thumb is speed: toward the fingertip is a push along where you are looking at that moment, carrying about two metres and fading over a couple of seconds (swipe again to keep going or to take a new heading; between pushes looking around does not steer); toward the knuckle, or a thumb tap, brakes, and from a standstill backs you up a step. The right thumb is heading: toward the fingertip turns 30° right, toward the knuckle 30° left, and a second swipe the same way within 0.7 s makes it 45°. Swipes across the finger are logged but do nothing, because the headset reads them unreliably (a small one comes back as an along swipe, the slow return as the opposite across swipe). The way back of a stroke is not a command: an opposite swipe within 0.9 s of the last is ignored, and a brake within 0.8 s of stopping does not back you up. `locoMode` = *steps* instead moves a fixed metre per push and 30° per turn. `locoHand` limits which hand drives; `thumbSource` chooses the headset's recogniser (*meta*, right on a Quest 3S) or the room's own reading of the thumb joints (*ours*, for a Quest 2, whose recogniser fires on about one slide in four).

**A simulated visitor.** `npx playwright test test/sim.spec.js` runs a scripted person in the emulated headset: a head that looks toward its goal with lag and wanders, a thumb that misfires at the rate seen on the Quest 2, a body that turns in place when standing and cannot when seated, and tasks with goals (turn then go, stop at a target, look around while moving, a lap of the room). It prints time, path against the straight line, wrong-way distance, overshoot, collisions, gestures and accidental recordings per task, and writes `test-results/sim-report.json`. Run it after any change to movement, and compare it with a worn session's log; where they disagree, fix the simulation first.

**Driving a page from the laptop.** `POST /api/projects/:id/control` with `{action, args, session?}` reaches every page open on that project (or one page, by the `session` id the session log gives it): `say {text, holdMs}` puts a line on the status bar and so on the headset panel, `play {id}` / `stop`, `ghost {style, trail}`, `voiceStart {on}`, `interview {on}`, `ask`, `step {by}`, `project {id}`, `reload`, `exitVR`. Nothing that needs a user gesture (entering VR, the microphone) can be done this way. It is for a headset nobody can type into, and for an operator steering a visitor's headset in an exhibition; the page logs each message as a `control` event.


## Review page

`/review.html?project=…` (the HUD's *Review* link) is the same project read at a desk: a light page, where the room is dark, because reading and walking are different jobs. It has a search box over transcripts, names, questions and period labels (accent- and case-insensitive, Turkish dotted and dotless i folded together) that highlights the matching words and fades the rest rather than hiding them; a plan of the room from above with one dot per clip in its period colour, which selects the clip when clicked; and one card per clip, replies nested under their parent. Every word of a transcript is clickable and starts playback at that word; the word under the playhead lights as the clip plays, and while it plays an arrow on the plan shows where the author stood and faced at that moment, from the recorded pose. Audio, transcript and viewpoint move together.

The card holds the edits a reviewer makes after the fact: a period (typed, or one of the project's existing periods as a chip; the chips above the list also filter), a photograph or scan attached to the clip, consent withdrawn, speech-to-text run again with a chosen language or with detection, and erase (asks twice). An attached photograph is uploaded as an image asset half a metre wide, hung 30 cm above the mark and turned towards the middle of the room, and the record's `links` point at it; the room shows it there, and keeps its default walls when the only assets are photographs. *In the room* on each card opens the viewer standing a metre in front of that clip (`/?project=…&focus=<id>`), with its row marked in the list and its preview in the status. The page joins the project's live channel, so clips recorded in a headset appear while someone reviews.

## Time and crowding

Time is a navigation axis. Untick **All periods** in the HUD and the year slider becomes the viewer's position in time: clips whose `period` includes the year stay, clips outside it disappear from the scene, the list and the aim ray, and clips with no period are timeless and always stay. The slider's range comes from the periods present in the project; bands under it show each distinct period in its colour, and the label names the period the year falls in (or says "between periods") and how many clips are in view. Marker colour encodes the period, amber for the project's earliest years through to blue for its latest, grey for timeless clips, desaturated for clips older than 180 days; layers are text in the operator's list, not a colour. (The headset has no time control yet; it follows the HUD's setting.)

A crowded room stays readable without deleting anything: only the nearest 40 markers within 8 m draw at full size, the rest shrink to faint dots until approached, hovered or played; full markers carry a ring, dots do not, and the distance limit is half the scene's diagonal (4.5 m in the default room) so large and small scenes both thin. `node scripts/seed-dense.mjs --data data --count 200` seeds a project with 200 clips across three periods, several authors and layers, and replies, for trying this by hand; the suite seeds the same fixture and checks the rule, the frame time and the year filter.

## Transcription

Whisper has two failure modes on short, quiet or noisy clips: a loop ("çabukla çabukla çabukla …") and, for silence, a subtitle credit learned from captioned video ("Bu dizinin betimlemesi TRT tarafından yaptırılmıştır", "Thanks for watching", "Untertitel im Auftrag des ZDF"). `shared/text.js` checks every transcript for repetition (a token repeated four times in a row, fewer than 40% distinct words, or fewer than half the word trigrams distinct on longer text) and against a list of known silence credits in Turkish, English, German, French, Spanish and Italian. On a loop the server decodes once more with repeated trigrams forbidden; if the result still loops, or reads as silence, it stores no transcript and marks the record `transcription.unclear` as `"repetition"` or `"silence"` with the raw text in `transcription.raw`. The same module runs in both clients when a record is drawn, so clips transcribed before the guard existed are read through it too. The room also warns at save time when the microphone's level never rose during a recording.

Every clip is transcribed on the server after it is saved, off the request path. The record carries `transcript` (plain text) and `transcription` (`status`: `pending`, `done`, `failed`, or `skipped`; plus `words` as `[{w, s, e}]` with second offsets, `language`, `backend`, `model`, `ms`). Clients in the project receive `annotation:updated` when the text lands; the HUD list shows it under each entry and the crosshair status quotes it on hover. `POST /api/projects/:id/annotations/:aid/transcribe` re-runs one clip (with `{language}` in the body to set the clip's language first, `""` for detection), and jobs left pending by a previous run are picked up on boot.

The default backend is Whisper running locally through transformers.js (ONNX on CPU, no Python): `onnx-community/whisper-base_timestamped`, quantised, about 77 MB downloaded on first use into `~/.cache/glossy-xr/models`. A two-second clip takes about half a second on an Apple laptop, plus about 0.2 s for language detection. Decoding needs `ffmpeg` on the PATH (or `FFMPEG=/path/to/ffmpeg`); without it the server logs a warning and marks clips `failed`.

**Cloud fallback.** A project can let a clip the local model could not read go to the OpenAI Whisper API instead. Three conditions must all hold, checked when the local result has been rejected, just before the call, from the database as it is then (so switching the project off or withdrawing consent while a clip waits in the queue counts): the project has `cloudFallback` on (`PATCH /api/projects/:id {cloudFallback: true}`, off by default), the contributor agreed to cloud transcription for that clip (`cloudConsent=true` with the upload, kept only if the project allowed it at that moment, and never changed afterwards; the clip's `consent` must also still hold), and the local result came back without error but was rejected by the guard above as silence or repetition. A local error, an empty clip or an English-only model's language fallback is never sent: those are faults to fix, not clips to pay for. The server also needs `GLOSSY_TRANSCRIBE_FALLBACK=openai` (the only value accepted; any other is logged and ignored) and `OPENAI_API_KEY`; if the key is missing the fallback is reported unavailable in `/api/health` and local transcription carries on. Unless all of this holds, no audio leaves the server. When the fallback runs, the record's `transcription` names the cloud backend and model and carries `cloud: {from: "local", reason}` (plus `raw`, the local text, if the cloud text is rejected too), the session log gets a `transcribe:fallback` event, and the EDM provenance says the clip was transcribed by the cloud model after the local transcription was rejected. If the cloud call fails, the local result stays, and because the audio may have been sent all the same, `cloud.error`, the event and the provenance record the attempt. Chat audio is always transcribed locally.

In the room, the switch is "Send unclear clips to the cloud transcriber" in the HUD's Settings panel (hidden in visitor view). With it on, the consent label reads "I consent to my recording being stored and shared, and transcribed by an external service when the local transcriber cannot read it", for visitors too, and the page sends `cloudConsent=true` with a clip only when the contributor ticked that label on a project that is on. The page remembers which label was ticked; consent given to the plain label does not carry over, so when a project with the switch on is opened, or the switch goes on while the page is open, the box is unticked and the status line asks for consent again. Consent is remembered per browser, not per project or person: a tick of the label with the clause carries to other projects that have the switch on, and to the next person on a shared device, as the plain consent already does. The room's clip list and the review page mark a clip "transcribed in the cloud", or "cloud transcription failed, local text kept" after a failed call, with the backend, model and reason in the tooltip.

Language is decided per clip: the clip's own `language` if set, else the project's (`PATCH /api/projects/:id {language: "tr"}`, or the select in the HUD), else `GLOSSY_LANGUAGE`, else the local backend detects it with one decoder step over Whisper's language tokens before transcribing. The library on its own would default to English without saying so, which is wrong for most of the speakers this tool is for. Codes are bare ISO codes (`tr`, not `tr-TR`). The record's `transcription` says what happened: `language` as applied, `detected: true` when it came from detection, `fallback: true` when English was used because the model could not say (English-only checkpoints such as `whisper-tiny.en` always transcribe English and ignore the setting). Detection reads the first 30 seconds of a clip, and it runs even when a language is forced: the forced decoder is used, but the detector's answer is stored as `heard`. When the two differ (an English visitor in a project pinned to Turkish) the room list and the review page say "sounds like English, transcribed as Türkçe" and offer the other decoder in one click, instead of leaving a fluent-looking transcript of nothing. The suite checks that a Turkish clip recorded through the browser is detected as Turkish, and, on a fixed Turkish clip (`test/fixtures/turkish-clip.wav`, one utterance), that it comes back as Turkish words, that the same clip forced through English is flagged as sounding Turkish, and that the one-click retranscription clears the flag.

| Variable | Default | |
|---|---|---|
| `GLOSSY_TRANSCRIBE` | `local` | `openai` uses the Whisper API with `OPENAI_API_KEY`; `none` disables transcription (records are marked `skipped`) |
| `GLOSSY_TRANSCRIBE_FALLBACK` | unset | `openai` enables the cloud fallback for projects and clips that allow it (above); needs `OPENAI_API_KEY` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | where the `openai` backend sends audio; the test suite points it at a stub |
| `GLOSSY_WHISPER_MODEL` | `onnx-community/whisper-base_timestamped` | `whisper-small_timestamped` or `whisper-large-v3-turbo_timestamped` for better accuracy at more CPU |
| `GLOSSY_WHISPER_DTYPE` | `q8` | `fp32`, `fp16`, `q4` |
| `GLOSSY_LANGUAGE` | unset | ISO code to force for every clip, e.g. `tr`; unset means per project, else detected |
| `GLOSSY_MODEL_CACHE` | `~/.cache/glossy-xr/models` | |
| `GLOSSY_BASE_URL` | the request's host | base of the identifiers in the EDM export, e.g. `https://glossy.example.org` behind a proxy |
| `GLOSSY_PROVIDER` | `Glossy XR` | `edm:dataProvider` and `edm:provider` in the EDM export: the institution or project |
| `GLOSSY_RIGHTS` | `http://creativecommons.org/licenses/by/4.0/` | `edm:rights` for every contribution and asset in the EDM export |

Word timestamps are kept so later work can jump playback to a word, tag a clip by its content, or make the set of annotations queryable.

## Run it

```sh
npm install
npm run dev        # API on :3000, client on http://localhost:5173
```

Node 22.13 or newer (for `node:sqlite`) and `ffmpeg` on the PATH for transcription. Data lives in `data/` (`glossy.db`, `audio/`, `models/`); set `GLOSSY_DATA` to move it. A pre-SQLite `annotations.json` found there is imported once into a project called `default`, and single-model projects from earlier builds migrate into the assets table on first start.

**Desktop:** click the canvas to capture the mouse, `W A S D` to walk (floor following and wall collision by default; untick *Walk mode* to fly with `Q`/`E`), `Shift` to run, hold the mouse button to record at the crosshair and release to save, click a marker to play it, `Space` plays the marker under the crosshair, `Delete` twice removes it (the ✕ in the list also asks twice), `K`/`L` start and stop recording from the keyboard. Walking within about a metre of a marker lights it and previews it in the status row (author, period or age, first words); it plays on click. Tick *Autoplay clips on approach* to have clips on the active layer play as you walk up, for guided walks. While recording the status counts seconds and a level bar under it follows the microphone (in the headset the panel shows both); a hint line under the status says what the controls do in the current state. A saved clip announces itself: the status line holds "saved" for two seconds, the marker blooms, and a short chime plays; if the level never rose during the recording, the status says the microphone heard almost nothing. The list and the room point at each other: each row carries its marker's colour and says when the clip is from, the row of the marker you aim at or stand near is marked and scrolled into view, a row under the mouse lights its marker, and clicking a name turns the camera to it. An empty project says so in the status instead of showing a count. The VR button appears only where an immersive session is possible.

**Microphone before VR:** ticking consent asks for the microphone on the flat page (or the first click does, when consent was already ticked on an earlier visit), and the status says *microphone ready*. Do this before *Enter VR*: a permission prompt that first appears inside an immersive session may not be seen in a headset browser, and the panel in VR says so if the microphone is still unallowed. A headset that goes to sleep ends the microphone track; the next clip asks for it again (the log records `mic:ended` and then `mic:ready` with `via: reacquired`), and a clip that was running when it ended closes with `track-ended` and nothing saved.

**Headset (Quest 3 or any WebXR browser):** the headset reaches your machine by IP, which browsers do not treat as secure, so either serve HTTPS and accept the self-signed certificate once:

```sh
HTTPS=1 npm run dev     # then open https://<your-ip>:5173 and press Enter VR
```

or, for Quest over USB, `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173`. Trigger records while held (release to save) or plays a marker you are pointing at. Squeeze cycles the layer.

**Production:** `npm run build && npm start` serves client and API from one process on `:3000`. `GLOSSY_MAX_MODEL_MB` caps uploads (default 1024).

## Testing

```sh
npm test               # unit tests, then the headless end-to-end suite; npm run test:headed to watch the latter
npm run test:unit      # node --test over test/unit: the pure modules (hand-trace gap filling)
```

Playwright drives a headless Chromium with software WebGL, a fake microphone fed from a generated tone, and, for the headset path, Meta's Immersive Web Emulation Runtime (IWER) standing in for a Quest 3. The suite starts its own API server on `:3100` with a throwaway data directory and Vite on `:5174`, so a running dev session is untouched. Those are the defaults: `GLOSSY_TEST_API_PORT` and `GLOSSY_TEST_VITE_PORT` set other ports, so two checkouts (two git worktrees, say) can run the suite at once with different values. The Whisper model cache is shared between checkouts and its download is not locked, so before running two at a time, run the suite once on its own so the model is already cached. It covers: rendering the default room; walking with floor following and stopping at a wall; hold-to-record through the mouse, playback, hover feedback, and two-press delete; transcription of the clip (on macOS the fake microphone speaks a sentence from the system voice, and the test checks the words come back) and the re-transcribe endpoint; head pose captured over the clip; the provisional marker placed within 100 ms of release; the export shape and that an erased clip leaves the export and the disk; replies by holding `R` on a marker; interview mode advancing through a script and stamping each clip with its question; setting a period after the fact; a 200-clip room seeded with `scripts/seed-dense.mjs` (thinning, frame time, the year slider filtering by period, hidden clips not being aim targets); a click released before the microphone is ready; recording refused without consent, by the page and by the server; live sync to a second client; entering VR through the real `VRButton`, recording with the emulated controller's trigger, and cycling layers with squeeze; with emulated hands and no controller, a clip started by speech alone, a stirring left hand stored as a joint trace in scene metres, lost by the tracker for 400 ms mid-stir and reconstructed along the circle with the frames flagged, and replayed as ghost hands that leave when the clip ends, with the author's viewpoint replayed beside them from a pose that is the emulated headset's position carried through the rig; the viewpoint of a headset clip played on the desktop, moving with the clip, hiding its head when the listener stands in the author's place, and leaving when the clip is erased mid-play, while a desktop clip's pose is not drawn; the review page (search, seek by word, period, a linked photograph becoming an asset at the clip, consent, a second transcription, erase) and the room opening on a clip picked there; the cloud fallback through the API against a stub endpoint (`test/cloud.spec.js`, on `GLOSSY_TEST_STUB_PORT`, default `:3101`), with a committed "Thank you." clip the local model hears as a silence credit: sent when the project and the clip allow it, kept local when either does not or when consent is withdrawn while the clip waits in the queue, and a failed cloud call recorded; and in the page, the Settings switch and the consent label following the project, `cloudConsent` sent only after the label with the clause was ticked, consent asked again when the switch goes on, the visitor view, and the cloud badges in the list and on the review page; the session log (a clip's trail from start to saved, per-second stats, the sessions summary, the NDJSON export, refused and truncated batches, and the report script). A second Playwright project (`chromium-tr`) runs the same browser with Turkish speech on the fake microphone (macOS `Yelda` voice) and checks language detection on a clip it records; the Turkish words and the project-language override are checked on a fixed clip posted through the API (`test/fixtures/turkish-clip.wav`, generated once with the command in `playwright.config.js`), since whisper-base decodes some windows of the looping microphone's Turkish to a subtitle credit instead of the words. `test/scene.spec.js` additionally uploads a real interior (OBJ + MTL + textures) when one is present at `../test-assets/interiors/fireplace_room` or `GLOSSY_TEST_SCENE`, and checks spawn on the floor, wall collision, and an annotation anchored to a named mesh. `test/formats.spec.js` loads every scene format the viewer accepts from small files the test writes itself (`test/fixtures/scenes.mjs`): a PLY mesh and a PLY point cloud, a 3DGS PLY and a `.splat` (both through Spark), an ASCII PCD, a `.gltf` with an embedded buffer, an OBJ with its MTL, a 360 panorama and a flat photo (PNG), and a WebM recorded in the page. For each it checks the type the server gave it, what the loader made of it, that auto-fit stood it on the floor and saved the transform, whether the default room stays (it does for a flat photo or video), and, for the 3D formats, which object a clip aimed at it is anchored to. It also checks the upload refusals (a `.txt`, a lone `.mtl`) and that a `.ply` holding something else does not take the page down. When `../test-assets` is present (or `GLOSSY_TEST_ASSETS` names it), the same load checks run over SheenChair, the Draco Cosmic Buddha, the Stanford bunny mesh and PCL's coloured cloud; the 8192×4096 panoramas are skipped, being past the software renderer's texture size. Screenshots land in `test-results/`.

Headless Chromium refuses the Pointer Lock API, so the client falls back to a software mouse capture (same controls, cursor stays visible, Esc releases); that fallback is what the tests exercise, and it also covers embedding contexts where pointer lock is denied.

The fake microphone loops its WAV and a clip can start anywhere in it, so `node test/fixtures/sweep.mjs --text "<sentence>" --voice Yelda --lang tr --ms 3180 --match '<regex>'` checks a fixture offline: it cuts a window at every 25 ms start in the loop, decodes each with the server's transcriber (language detected, then forced) under the Turkish test's pass rules, and prints where it misses (`--replay <dir>` checks stored clips against it).

## API

| Method | Path | |
|---|---|---|
| GET / POST | `/api/projects` | list; create `{name}` |
| GET / PATCH / DELETE | `/api/projects/:id` | read (includes `assets[]`, `language`, `script`, `cloudFallback`); update `{name, transform, language, script, cloudFallback}`; delete with files |
| POST | `/api/projects/:id/control` | steer the pages open on a project: `{action, args, session?}` (see Session log) |
| GET / POST | `/api/projects/:id/chat` | the conversation with the headset: list `?after=<id>`; send `{text, session?}` · `POST …/chat/audio` (multipart `audio`, `session`) is what the headset sends, transcribed on arrival |
| GET / POST | `/api/projects/:id/assets` | list; add (multipart `model` plus optional `files` sidecars; `mode=sphere` for a panorama) |
| PATCH / DELETE | `/api/projects/:id/assets/:aid` | update `{name, transform, options, visible, sort}`; remove |
| GET / POST | `/api/projects/:id/annotations` | list; create (multipart `audio`, `x`, `y`, `z`, `author`, `layer`, `consent=true`; optional `objectId`, `durationMs`, `parent`, `period` (JSON), `pose` (JSON), `prompt`, `mode`, `language`, `cloudConsent`) |
| PATCH / DELETE | `/api/projects/:id/annotations/:aid` | update `{layer, period, consent, links, language}` (a reviewer may withdraw consent after the fact; the clip stays until erased); erase record, audio file and derived data, detaching any replies |
| POST | `/api/projects/:id/annotations/:aid/transcribe` | re-run speech-to-text for one clip (202); optional `{language}` sets the clip's language first |
| GET | `/api/projects/:id/export`, `/api/export` | JSON export, schema `glossy-xr/project/0.4`: project plus `contributions[]` |
| GET | `/api/projects/:id/export?format=edm` | the same contributions as Europeana Data Model records, JSON-LD |
| POST | `/api/projects/:id/events` | session log batch `{session, events:[{t, at, kind, data}]}` (max 500 per post, data ≤ 4 KB) |
| GET | `/api/projects/:id/sessions` | sessions seen in the log: start, end, event count, client |
| GET | `/api/projects/:id/events` | the log, `?session=`, `?after=<id>`, `?format=ndjson` |
| GET | `/audio/<id>.webm`, `/models/<project>/<file>` | files |
| Socket.IO | `join {project}` → `annotation:all`; then `annotation:new`, `annotation:updated` (transcript landed), `annotation:deleted`, `project:updated`, `project:created`, `project:deleted` | live sync |

Validation: anchor must be numeric, author required, consent must be `true`, model extension must be supported. Rejected uploads are deleted from disk.

## Status

Verified 12 Oct 2026: server round-trip (projects, model upload, annotations, export, delete, restart persistence) with curl; desktop client rendering, project switching, and every format in the table above in Chrome. Verified 13 Oct 2026 by the end-to-end suite: recording through `getUserMedia` and `MediaRecorder`, playback, delete, live sync, and the WebXR session and controller path against an emulated headset. Verified 15 and 16 Oct 2026 by the suite: language detection (Turkish and English), per-project language, head pose, provisional placement, export, replies, interview mode, periods, visitor mode, the headset panel, crowd thinning, the transcript guard, the review page and linked photographs, the EDM export, hand-tracked gestures stored and replayed (emulated hands), the session log. Not yet verified on physical hardware: a real Quest, and with it hand-tracking coverage during a real gesture.

## Known limits

- Point-cloud raycasting is brute force; clouds over 3 M points skip surface anchoring and fall back to a point just ahead of the controller.
- The JSON store became SQLite, but there is still no auth: anyone who can reach the server can do anything.
- Transcription runs one clip at a time on the CPU; a long backlog (re-importing a big project) will take a while.
- The three.js bundle is not code-split; Spark loads lazily only when a splat is opened.

## Roadmap

- A phone or tablet form bound to an existing anchor: text, photos and consent added on the spot, no headset needed (the review page covers the desk).
- Review page: drag a photograph straight from a web page, period by scrubbing the waveform.
- A CIDOC-CRM serialisation of the EDM export, and an OAI-PMH endpoint if an aggregator asks for one.
- Gestures: a learned hand-motion prior in place of the kinematic gap filler, for longer gaps and for the hidden hand when hands overlap; a confidence per reconstructed frame in the export; a hand mesh instead of joint spheres; a prop (spoon, sieve) attached to the ghost hand.
- A time control inside the headset (the HUD slider exists); locking onto one voice while moving through time; replies from the controller in XR; a dialogue model driving the interview script.
- Accounts, project membership, share links, object storage for files.
- Production transcription: the local CPU backend is for development; a deployment should either switch to the API backend (`GLOSSY_TRANSCRIBE=openai`) or run a larger Whisper model on a box with the CPU or GPU for it.

## Lineage

`ainsleys/glossy` holds the 2016 history plus one 2026 snapshot commit. Development continues here.

MIT.
