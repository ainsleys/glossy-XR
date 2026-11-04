# Record, export and EDM reference

This document describes the data Glossy XR stores and hands out: the annotation record as the API returns it, the project and asset records, the native export (`glossy-xr/project/0.4`), and the Europeana Data Model (EDM) serialisation. It is written from `server/db.js`, `server/index.js` and `server/edm.js`. The field list at the end is checked against a running server by `test/unit/schema.test.mjs`, so a field added, renamed or removed in the code without a change here fails the unit tests.

Names in the tables are key paths: `anchor.x` is the `x` key of the `anchor` object, and `pose[].t` is the `t` key of each element of the `pose` array.

## Conventions

- **Coordinates** are scene metres in the project's scene, Y up, the same frame the assets' transforms are applied in.
- **Rotations** are quaternions `[x, y, z, w]`.
- **Clip time** (`pose[].t`, `hands.frames[].t`) is integer milliseconds from the start of the recording. Word timings (`words[].s`, `words[].e`) are seconds from the start of the clip, as the transcriber reports them.
- **Timestamps** (`createdAt`, `exportedAt`) are ISO 8601 strings in UTC, as `Date.prototype.toISOString` writes them.
- **Hands** use the 25 WebXR hand joints in the fixed order of `JOINTS` in `client/src/hands.js`: `wrist`; `thumb-metacarpal`, `thumb-phalanx-proximal`, `thumb-phalanx-distal`, `thumb-tip`; then for each of `index-finger`, `middle-finger`, `ring-finger` and `pinky-finger`: `-metacarpal`, `-phalanx-proximal`, `-phalanx-intermediate`, `-phalanx-distal`, `-tip`. A hand in a frame is a flat array of `x, y, z` per joint in that order (three numbers per joint, 75 for the full 25; the server accepts a trace with fewer joints).
- **Absent and null.** A field marked "absent when unset" is left out of the JSON; a field marked "null" is present with the value `null`. Numbers the server rounds are rounded to millimetres for positions and to four decimals for quaternion components.
- **Source** says who sets a field: the *client* that recorded the clip (sent with the upload), the *server*, a *reviewer* (by `PATCH /api/projects/:id/annotations/:aid`), or the *transcriber* (written when a transcription job finishes).

## Annotation record

`GET /api/projects/:id/annotations` returns an array of these, oldest first; the same object is pushed over the socket as `annotation:new`, `annotation:updated` and `annotation:all`. Each record is one row of the `annotations` table in SQLite. Structured fields (`period`, `pose`, `hands`, `links`, and the transcription details) are stored as JSON text in their own columns and parsed on read.

### Identity and authorship

| Field | Type | Null or absent | Source | Meaning |
|---|---|---|---|---|
| `id` | string | never | server | Unique id. For a clip uploaded through the API it is the UUID the audio file is named after. |
| `project` | string | never | server | The project's id. |
| `author` | string | never | client | Who spoke: the name the contributor gave, up to 120 characters. Required. |
| `createdAt` | string | never | server | When the clip was saved, ISO 8601. |
| `layer` | string | never | client, reviewer | A free label (draft, review, a period name), up to 120 characters; `default` when none is given. |
| `consent` | boolean | never | client, reviewer | The contributor's consent. A clip can only be created with `true`; a reviewer sets `false` when consent is withdrawn. |
| `cloudConsent` | boolean | never | client, server | The contributor also agreed to cloud transcription. Set at creation only: `true` when the client sent `cloudConsent: true` and the project's `cloudFallback` was on at that moment, otherwise `false`. The annotation `PATCH` cannot change it. |

### Audio and place

| Field | Type | Null or absent | Source | Meaning |
|---|---|---|---|---|
| `audioUrl` | string | never | server | Path of the recording on this server, `/audio/<id>.webm` (or `.ogg`, `.m4a`, by the uploaded container). |
| `durationMs` | integer | null when the client did not send it | client | Length of the clip in milliseconds. |
| `anchor` | object | never | client | Where the clip is pinned in the scene. |
| `anchor.x` | number | never | client | Scene metres. |
| `anchor.y` | number | never | client | Scene metres, up. |
| `anchor.z` | number | never | client | Scene metres. |
| `anchor.objectId` | string | absent when unset | client | The name of the scene object the anchor sits on, up to 200 characters. |
| `period` | object | null when unspecified | client, reviewer | The time the clip talks about. Each key is a free string up to 60 characters (a year, a date, "always"); a key with no value is absent, and a period with none of the three is stored as null. |
| `period.from` | string | absent when unset | client, reviewer | Start of the period. |
| `period.to` | string | absent when unset | client, reviewer | End of the period. |
| `period.label` | string | absent when unset | client, reviewer | A name for the period. |

### Viewpoint and gesture

| Field | Type | Null or absent | Source | Meaning |
|---|---|---|---|---|
| `pose` | array | empty array when none | client | The author's head pose over the clip, sampled at 10 Hz, at most 6000 samples. |
| `pose[].t` | integer | never | client | Clip milliseconds. |
| `pose[].p` | number[3] | never | client | Head position `[x, y, z]`, scene metres. |
| `pose[].q` | number[4] | never | client | Head orientation `[x, y, z, w]`. |
| `poseSource` | string | null when `pose` is empty | client | `xr` for a headset pose, `desktop` for the mouse-steered camera. A desktop trace is only where the view was pointed. |
| `hands` | object | null when no hand was tracked | client, server | Hand joints over the clip, recorded in a headset with hand tracking. Short gaps are filled by the server at save time (`shared/hands-fill.js`). |
| `hands.joints` | string[] | never | client | Joint names, at most 25, in the order of the per-frame arrays. |
| `hands.rate` | integer | never | client | Sampling rate in Hz (1 to 120, default 20). |
| `hands.frames` | array | never | client, server | One entry per sample, at most 2400. |
| `hands.frames[].t` | integer | never | client | Clip milliseconds. |
| `hands.frames[].l` | number[] | null when the left hand was not seen | client, server | Left hand: `x, y, z` per joint, scene metres. |
| `hands.frames[].r` | number[] | null when the right hand was not seen | client, server | Right hand, as `l`. |
| `hands.frames[].lf` | boolean | absent unless reconstructed | server | `true` on a frame whose left hand the server reconstructed across a gap. |
| `hands.frames[].rf` | boolean | absent unless reconstructed | server | The same for the right hand. |
| `hands.filled` | object | never | server | What the gap filler did. |
| `hands.filled.l` | integer | never | server | Left-hand frames reconstructed. |
| `hands.filled.r` | integer | never | server | Right-hand frames reconstructed. |
| `hands.filled.gaps` | integer | never | server | Gaps filled, both hands together. |
| `hands.filled.maxGapMs` | integer | never | server | The longest gap the filler would bridge (1000); longer gaps and gaps at either end stay null. |

### Conversation

| Field | Type | Null or absent | Source | Meaning |
|---|---|---|---|---|
| `parent` | string | null for a root clip | client | The id of the clip this one replies to, in the same project. Replies are one level deep: a reply to a reply is attached to the original. Erasing a parent sets its replies' `parent` to null. |
| `replies` | integer | never | server | How many clips reply to this one. Computed on every read, not stored. |
| `mode` | string | never | client | `interview` for an answer to a scripted question, otherwise `walk`. |
| `prompt` | string | null when the client sent none | client | The question the clip answers, up to 500 characters. The server stores whatever the client sends whatever the `mode`; only the client ties a prompt to interview mode. |
| `language` | string | null when unset | client, reviewer | The language requested for transcription, an ISO 639 code of two or three letters (`tr`, `en`). Rarely set; when null the project's language applies, else the transcriber detects. The language actually used is `transcription.language`. |
| `links` | array | empty array when none | reviewer | Photographs, documents or web pages a reviewer attached to the clip, at most 20. |
| `links[].kind` | string | never | reviewer | `image`, `document` or `url` (anything else is stored as `url`). |
| `links[].asset` | string | absent when unset | reviewer | The id of a project asset (a linked photograph is uploaded as an image asset). |
| `links[].url` | string | absent when unset | reviewer | Where the linked thing is. A link has an `asset`, a `url`, or both. |
| `links[].title` | string | absent when unset | reviewer | A caption. |

### Transcription

`transcript` holds the text; `transcription` holds the job's state and details. When a job finishes the server replaces everything under `transcription` except `status` with the new result, so the keys present depend on the last outcome:

- `{status}` alone before any result is stored (`pending`, or `skipped` for clips created with transcription disabled, or `none` for clips from before transcription existed), and again after a retry request (`POST …/annotations/:aid/transcribe`), which clears the details and sets `pending` while the transcript text stays until the new result.
- after a successful job: `words`, `language`, `detected`, `heard`, `backend`, `model`, `ms`, `cloud` when the clip was sent to the cloud fallback, and `unclear` and `raw` when the text was rejected.

**Cloud fallback.** A clip is sent to the cloud backend (`GLOSSY_TRANSCRIBE_FALLBACK`) only when the local result came back without error but was rejected as unclear and, read from the database at that moment, the project's `cloudFallback` is on and the clip's `consent` and `cloudConsent` are both `true`; if that read fails, the clip is not sent. The stored result is then the cloud backend's: `backend` and `model` name it, `cloud` says why the local text was set aside, and if the cloud text is unclear too it is stored as rejected in the same way, with the local text in `cloud.raw`. If the cloud call fails, the local result is stored as it was and `cloud.error` records the attempt, since the audio may have been sent. A local error, an empty clip or a language fallback never goes to the cloud. Each attempt also writes a `transcribe:fallback` event to the project's session log.
- after a failed job: `error` alone.

| Field | Type | Null or absent | Source | Meaning |
|---|---|---|---|---|
| `transcript` | string | null until transcribed; empty when rejected as unclear | transcriber | What was said. A failed job leaves the previous value. |
| `transcription` | object | never | server, transcriber | The job's state and details. |
| `transcription.status` | string | never | server, transcriber | `none` (no job and no text), `pending` (queued or running), `done`, `failed`, or `skipped` (transcription was disabled when the clip was saved). |
| `transcription.words` | array | absent until a result is stored | transcriber | Word timings; empty when the text was rejected. |
| `transcription.words[].w` | string | never | transcriber | The word. |
| `transcription.words[].s` | number | never | transcriber | Start, seconds from the start of the clip. |
| `transcription.words[].e` | number | never | transcriber | End, seconds. |
| `transcription.language` | string | absent until a result is stored | transcriber | The language the text was transcribed in, ISO 639 code. |
| `transcription.detected` | boolean | absent until a result is stored | transcriber | `true` when the transcriber chose the language, `false` when it was set by the clip or the project. |
| `transcription.heard` | string | absent until a result is stored; null unless a language was forced | transcriber | When the language was set, the language the detector would have chosen; clients flag a clip where the two disagree. |
| `transcription.backend` | string | absent until a result is stored | transcriber | `local` or `openai`: the backend that produced the stored text. |
| `transcription.model` | string | absent until a result is stored | transcriber | The model name. |
| `transcription.ms` | integer | absent until a result is stored | transcriber | How long the job took, milliseconds, both backends together when the fallback ran. |
| `transcription.cloud` | object | absent unless the cloud fallback ran | transcriber | Present when the clip was sent to the cloud backend after the local result was rejected. Without `error`, the stored text is the cloud backend's. |
| `transcription.cloud.from` | string | never | transcriber | The backend whose result was rejected, `local`. |
| `transcription.cloud.reason` | string | never | transcriber | Why it was rejected: `silence` or `repetition`. |
| `transcription.cloud.raw` | string | absent unless the cloud text was rejected too | transcriber | The rejected local text; `transcription.raw` then holds the rejected cloud text. |
| `transcription.cloud.error` | string | absent unless the cloud call failed | transcriber | The error of the failed cloud call. The stored result is then the local one (`backend` `local`, rejected as unclear). |
| `transcription.unclear` | string | absent unless rejected | server | Why the text was rejected: `silence` (a subtitle credit or similar for an empty clip) or `repetition` (the model looped). |
| `transcription.raw` | string | absent unless rejected | transcriber | The rejected text, kept for inspection. |
| `transcription.error` | string | absent unless failed | transcriber | The error message of a failed job. |

The local transcriber also returns `retried` (it ran a second pass) and `fallback` (it fell back to English); the server does not store them, so they never appear in a record. That `fallback` is unrelated to the cloud fallback, which is recorded as `cloud`.

## Projects and assets

`GET /api/projects` lists projects, most recently changed first; `GET /api/projects/:id` returns one. The `projects` table still has `model_url`, `model_type`, `model_name` and `transform` columns from before projects held several assets; they are emptied on start and never returned. A project has no transform of its own: each asset has one.

### Project

| Field | Type | Null or absent | Meaning |
|---|---|---|---|
| `id` | string | never | Eight hex characters. |
| `name` | string | never | Up to 120 characters. |
| `createdAt` | string | never | ISO 8601. |
| `updatedAt` | string | never | ISO 8601. Moves when the project is created or edited (`PATCH /api/projects/:id`), an asset is added or edited, or a clip is added or edited by a reviewer. A finished transcription, an erased clip and a deleted asset do not move it. |
| `language` | string | null to detect | Default transcription language for the project's clips, ISO 639 code. |
| `uiLanguage` | string | never | The language in which the page and the headset panel show contributors and visitors the consent label, status line, hints, clip list and panel text: `en` or `tr`, `en` by default. Set with `PATCH /api/projects/:id {uiLanguage}`; any other value is refused. Independent of `language`, so transcription can detect while the interface is Turkish. `?lang=` in the page's URL overrides it for that page. Operator panels and the review page stay English. |
| `script` | object | null when none | The interview script. Keys other than `questions` are kept as given. |
| `cloudFallback` | boolean | never | Whether clips whose local transcript is rejected as unclear may be sent to the cloud backend, for clips whose contributor agreed (`cloudConsent`). `false` by default; set with `PATCH /api/projects/:id {cloudFallback}`, a boolean. Switching it on does not apply to clips saved before. |
| `script.questions` | array | never | At most 200 questions, each `{id, text, …}`: `id` (`q1`, `q2`, … when not given), `text` up to 500 characters, and any other keys, such as translations, kept as given. |
| `assets` | array | empty array when none | The project's assets in display order, as below. |
| `annotationCount` | integer | absent except in the list | Number of annotations. Only `GET /api/projects` (and so the all-projects export) carries it. |

### Asset

An asset is one file in the scene (`GET /api/projects/:id/assets`, or embedded in the project's `assets`):

| Field | Type | Null or absent | Meaning |
|---|---|---|---|
| `id` | string | never | Eight hex characters. |
| `project` | string | never | The project's id. |
| `url` | string | never | Path on this server, `/models/<project>/<file>`. |
| `type` | string | never | How the client loads it: `gltf`, `ply`, `pcd`, `obj`, `splat`, `image` or `video`. |
| `name` | string | never | The uploaded file name, or a name given later, up to 120 characters. |
| `sort` | integer | never | Display order. |
| `createdAt` | string | never | ISO 8601. |
| `transform` | object | never | `{}` until the client fits the asset on first load; then all eight keys below. |
| `transform.scale` | number | absent while `{}` | Uniform scale (1 when unset). |
| `transform.rotX` | number | absent while `{}` | Rotation about X, degrees. |
| `transform.rotY` | number | absent while `{}` | Rotation about Y, degrees. |
| `transform.rotZ` | number | absent while `{}` | Rotation about Z, degrees. |
| `transform.x` | number | absent while `{}` | Offset, scene metres. |
| `transform.y` | number | absent while `{}` | Offset, scene metres, up. |
| `transform.z` | number | absent while `{}` | Offset, scene metres. |
| `transform.pointSize` | number | absent while `{}` | Point size for point clouds, metres (0.01 when unset). |
| `visible` | boolean | never | Whether the asset is shown. |
| `options` | object | never | Per-asset options; `{}` for anything but an image. |
| `options.mode` | string | absent except on an image | `plane`, or `sphere` for a 360 panorama. |

## Native export

`GET /api/projects/:id/export` returns one project as a JSON document (served as an attachment, `glossy-<id>.json`):

| Key | Meaning |
|---|---|
| `exportedAt` | When the document was made, ISO 8601. |
| `schema` | `glossy-xr/project/0.4`. |
| `project` | The project record as `GET /api/projects/:id` returns it, assets included. |
| `contributions` | One entry per annotation, oldest first, as below. |

`GET /api/export` returns every project in one document: `{exportedAt, schema: "glossy-xr/all/0.4", projects: [{project, contributions}]}`, where each `project` is in its list form and so carries `annotationCount`. The EDM serialisation exists only per project.

A contribution is the annotation record with some fields renamed and the job details left out. Renamed: `author` is `attribution`, `createdAt` is `timestamp`, `audioUrl` is `audio`, and `transcription.words` is `words`. Left out: `project` (the document says which), `replies` (count the `parent` references), and the whole `transcription` object, so `status`, `detected`, `heard`, `backend`, `model`, `ms`, `cloud`, `unclear`, `raw` and `error` are not exported; the EDM serialisation's provenance sentence says which backend transcribed a clip and whether the cloud fallback ran. `language` is the language the clip was transcribed in when there is one, otherwise the requested language.

Clips whose consent was withdrawn stay in the native export with `consent: false`; the EDM serialisation leaves them out. Audio is referenced by path (`audio`), never embedded: fetch it from the same server. An erased clip is gone from both.

| Field | Type | Null or absent | Meaning |
|---|---|---|---|
| `id` | string | never | The record's `id`. |
| `attribution` | string | never | The record's `author`. |
| `timestamp` | string | never | The record's `createdAt`. |
| `layer` | string | never | As in the record. |
| `consent` | boolean | never | As in the record; `false` for a withdrawn clip. |
| `cloudConsent` | boolean | never | As in the record. |
| `audio` | string | never | The record's `audioUrl`, a path on the exporting server. |
| `durationMs` | integer | null when unknown | As in the record. |
| `anchor` | object | never | As in the record. |
| `anchor.x` | number | never | Scene metres. |
| `anchor.y` | number | never | Scene metres, up. |
| `anchor.z` | number | never | Scene metres. |
| `anchor.objectId` | string | absent when unset | As in the record. |
| `period` | object | null when unspecified | As in the record. |
| `period.from` | string | absent when unset | As in the record. |
| `period.to` | string | absent when unset | As in the record. |
| `period.label` | string | absent when unset | As in the record. |
| `parent` | string | null for a root clip | As in the record. |
| `mode` | string | never | As in the record. |
| `prompt` | string | null when the client sent none | As in the record. |
| `language` | string | null when neither is known | `transcription.language`, else the record's `language`. |
| `transcript` | string | null until transcribed | As in the record. |
| `words` | array | empty array when none | `transcription.words`. |
| `words[].w` | string | never | The word. |
| `words[].s` | number | never | Start, seconds. |
| `words[].e` | number | never | End, seconds. |
| `pose` | array | empty array when none | As in the record. |
| `pose[].t` | integer | never | Clip milliseconds. |
| `pose[].p` | number[3] | never | Head position. |
| `pose[].q` | number[4] | never | Head orientation. |
| `poseSource` | string | null when `pose` is empty | As in the record. |
| `hands` | object | null when no hand was tracked | As in the record. |
| `hands.joints` | string[] | never | As in the record. |
| `hands.rate` | integer | never | As in the record. |
| `hands.frames` | array | never | As in the record. |
| `hands.frames[].t` | integer | never | Clip milliseconds. |
| `hands.frames[].l` | number[] | null when not seen | Left hand. |
| `hands.frames[].r` | number[] | null when not seen | Right hand. |
| `hands.frames[].lf` | boolean | absent unless reconstructed | Left hand reconstructed. |
| `hands.frames[].rf` | boolean | absent unless reconstructed | Right hand reconstructed. |
| `hands.filled` | object | never | As in the record. |
| `hands.filled.l` | integer | never | Left-hand frames reconstructed. |
| `hands.filled.r` | integer | never | Right-hand frames reconstructed. |
| `hands.filled.gaps` | integer | never | Gaps filled. |
| `hands.filled.maxGapMs` | integer | never | Longest gap bridged. |
| `links` | array | empty array when none | As in the record. |
| `links[].kind` | string | never | `image`, `document` or `url`. |
| `links[].asset` | string | absent when unset | A project asset id. |
| `links[].url` | string | absent when unset | Where the linked thing is. |
| `links[].title` | string | absent when unset | A caption. |

## EDM serialisation

`GET /api/projects/:id/export?format=edm` returns the project's contributions as Europeana Data Model records in JSON-LD (`application/ld+json`, attachment `glossy-<id>.edm.jsonld`), made by `toEdm()` in `server/edm.js`. The document is `{"@context": …, "@graph": [...]}`. Every node's `@id` is a URL on this server.

Three environment variables configure it:

| Variable | Default | Effect |
|---|---|---|
| `GLOSSY_BASE_URL` | the request's protocol and host | Base of every identifier, for a server behind a proxy. |
| `GLOSSY_PROVIDER` | `Glossy XR` | `edm:dataProvider` and `edm:provider` on every aggregation. |
| `GLOSSY_RIGHTS` | `http://creativecommons.org/licenses/by/4.0/` | `edm:rights` on every aggregation and web resource: one licence for the whole set. |

**Consent.** Clips with `consent: false` are left out entirely: no node, no web resource, no aggregation, and a reply to a withdrawn clip carries no link to it. The project node says how many were left out in `glossy:withheldForConsent`.

### Nodes

| Node | `@id` | Properties |
|---|---|---|
| `edm:ProvidedCHO`, the project | `/api/projects/<id>` | `dc:title` (project name), `dc:type` `place with voice annotations`, `edm:type` `3D`, `dcterms:created`, `dcterms:modified`, `dcterms:hasPart` (every included contribution), `glossy:contributions` (how many are included), `glossy:withheldForConsent`, `glossy:nativeRecord` (the native export). |
| `edm:WebResource`, each asset | the asset's URL | `dc:title` (asset name), `dc:format` (the asset `type`, e.g. `gltf`), `edm:type` (`IMAGE`, `VIDEO`, else `3D`), `dcterms:created`, `edm:rights`. |
| `ore:Aggregation`, the project | `/api/projects/<id>#aggregation` | `edm:aggregatedCHO`, `edm:dataProvider`, `edm:provider`, `edm:rights`, `edm:isShownAt` (the main page, `/?project=<id>`), `edm:isShownBy` (the first 3D asset, else the first asset; absent with no assets), `edm:hasView` (the other assets, when there is more than one). |
| `edm:ProvidedCHO`, each contribution | `/api/projects/<id>/annotations/<aid>` | `dc:title` (`Answer to “<prompt>”`, else the first eight words of the transcript, else `Voice annotation by <author>`), `dc:creator` (author), `dcterms:created`, `dc:type` (`reply to a voice annotation`, `interview answer` or `voice annotation`), `edm:type` `SOUND`, `dcterms:isPartOf` (the project), `dcterms:spatial` (project name and `on <objectId>`), `dc:description` (the transcript, tagged with its language; absent when empty or rejected as unclear), `dc:language` (when a language is known), `dcterms:temporal` (the period's TimeSpan), `edm:isRelatedTo` and `glossy:replyTo` (the parent, when it is included), and the `glossy:` properties below. |
| `edm:WebResource`, each recording | the audio URL | `dc:format` `audio/webm`, `audio/ogg` or `audio/mp4` by the stored file's extension, else `application/octet-stream`, `ebucore:duration` (ISO 8601 duration, `PT1.2S`), `dcterms:extent` (`1.2 s`), `dcterms:created`, `dc:creator`, `edm:rights`, `dcterms:provenance`: a sentence of paradata saying whether the clip was recorded in a headset or on a desktop, whether a hand trace exists and how many of its frames were reconstructed, and which model and backend transcribed it (with "after the local transcription was rejected as <reason>" when the cloud fallback produced the text, or "a cloud transcription was attempted and failed"), whether the language was detected or set, or that transcription failed or was not done. |
| `edm:WebResource`, each linked file | the link's `url` | For every link that has a `url` (photographs, documents and pages alike): `dc:title` (title, else the URL), `edm:type` `IMAGE` for a link of kind `image`, `edm:rights`. |
| `ore:Aggregation`, each contribution | `/api/projects/<id>/annotations/<aid>#aggregation` | `edm:aggregatedCHO`, `edm:dataProvider`, `edm:provider`, `edm:rights`, `edm:ugc` `"true"` (a string), `edm:isShownBy` (the audio), `edm:isShownAt` (the clip in the scene, `/?project=<id>&focus=<aid>`), `edm:hasView` (the linked files, when any). |
| `edm:TimeSpan`, one per distinct period | `/api/projects/<id>/export#timespan-<n>` | `skos:prefLabel` (the label, else `from–to`), `edm:begin` (`from`, when set), `edm:end` (`to`, when set). |

### The glossy: namespace

EDM has no place for the scene coordinates, the layer, the recording mode, the interview question, or the traces and word timings, so they are kept under `glossy:` rather than dropped or forced into a property that means something else. On a contribution: `glossy:anchor` (`{x, y, z, objectId?}`, scene metres), `glossy:mode`, `glossy:layer`, `glossy:prompt` (when set), `glossy:gesture` `true` (when a hand trace exists), `glossy:replyTo`, and `glossy:nativeRecord`. On the project: `glossy:contributions`, `glossy:withheldForConsent` and `glossy:nativeRecord`. The pose and hand traces and the word timings are not in the EDM document at all; `glossy:nativeRecord` points at the native export that has them.

### @context

| Field | Value | Use |
|---|---|---|
| `dc` | `http://purl.org/dc/elements/1.1/` | Dublin Core elements: title, creator, type, format, language, description. |
| `dcterms` | `http://purl.org/dc/terms/` | Dublin Core terms: created, modified, spatial, temporal, extent, provenance, part relations. |
| `edm` | `http://www.europeana.eu/schemas/edm/` | EDM classes and properties. |
| `ore` | `http://www.openarchives.org/ore/terms/` | `ore:Aggregation`. |
| `skos` | `http://www.w3.org/2004/02/skos/core#` | `skos:prefLabel` on a TimeSpan. |
| `ebucore` | `http://www.ebu.ch/metadata/ontologies/ebucore/ebucore#` | `ebucore:duration` on a recording. |
| `glossy` | `https://github.com/ainsleys/glossy-XR#glossy-` | The properties EDM has no place for, above. |
| `edm:aggregatedCHO` | `{"@type": "@id"}` | Value is an identifier, not a string. |
| `edm:isShownBy` | `{"@type": "@id"}` | Identifier. |
| `edm:isShownAt` | `{"@type": "@id"}` | Identifier. |
| `edm:hasView` | `{"@type": "@id"}` | Identifier. |
| `edm:isRelatedTo` | `{"@type": "@id"}` | Identifier. |
| `edm:rights` | `{"@type": "@id"}` | Identifier (the licence URI). |
| `dcterms:temporal` | `{"@type": "@id"}` | Identifier (a TimeSpan). |
| `dcterms:isPartOf` | `{"@type": "@id"}` | Identifier. |
| `dcterms:hasPart` | `{"@type": "@id"}` | Identifier. |
| `glossy:replyTo` | `{"@type": "@id"}` | Identifier. |
| `glossy:nativeRecord` | `{"@type": "@id"}` | Identifier. |

## Versioning

No versioning rule has been written down before; this section records the practice the history follows. The `schema` string of the native export (`glossy-xr/project/0.4`, `glossy-xr/all/0.4`) names the export's version. Adding a field keeps the version: `poseSource`, `links` and `hands` were added under 0.4 without a change. Renaming or removing a field, or changing what an existing field means, changes the version. A reader should therefore ignore fields it does not know and check the `schema` string before relying on a field. The EDM serialisation carries no version of its own; it follows the native record.

## Field list

The names this document describes, checked against the code by `test/unit/schema.test.mjs`: `record` against the records `GET /api/projects/:id/annotations` returns, `contribution` against the contributions in `GET /api/projects/:id/export`, `context` against the `@context` keys of `toEdm()`, `project` against `GET /api/projects/:id` and `GET /api/projects` together (without the embedded assets, and only the top level of `script`), and `asset` against `GET /api/projects/:id/assets`. Every name here is a row in a table headed `Field` in its section, and every row of those tables is a name here.

```json
{
  "record": [
    "id", "project", "author", "createdAt", "layer", "consent", "cloudConsent",
    "audioUrl", "durationMs",
    "anchor", "anchor.x", "anchor.y", "anchor.z", "anchor.objectId",
    "period", "period.from", "period.to", "period.label",
    "pose", "pose[].t", "pose[].p", "pose[].q", "poseSource",
    "hands", "hands.joints", "hands.rate", "hands.frames",
    "hands.frames[].t", "hands.frames[].l", "hands.frames[].r", "hands.frames[].lf", "hands.frames[].rf",
    "hands.filled", "hands.filled.l", "hands.filled.r", "hands.filled.gaps", "hands.filled.maxGapMs",
    "parent", "replies", "mode", "prompt", "language",
    "links", "links[].kind", "links[].asset", "links[].url", "links[].title",
    "transcript", "transcription", "transcription.status",
    "transcription.words", "transcription.words[].w", "transcription.words[].s", "transcription.words[].e",
    "transcription.language", "transcription.detected", "transcription.heard",
    "transcription.backend", "transcription.model", "transcription.ms",
    "transcription.cloud", "transcription.cloud.from", "transcription.cloud.reason", "transcription.cloud.raw", "transcription.cloud.error",
    "transcription.unclear", "transcription.raw", "transcription.error"
  ],
  "contribution": [
    "id", "attribution", "timestamp", "layer", "consent", "cloudConsent", "audio", "durationMs",
    "anchor", "anchor.x", "anchor.y", "anchor.z", "anchor.objectId",
    "period", "period.from", "period.to", "period.label",
    "parent", "mode", "prompt", "language", "transcript",
    "words", "words[].w", "words[].s", "words[].e",
    "pose", "pose[].t", "pose[].p", "pose[].q", "poseSource",
    "hands", "hands.joints", "hands.rate", "hands.frames",
    "hands.frames[].t", "hands.frames[].l", "hands.frames[].r", "hands.frames[].lf", "hands.frames[].rf",
    "hands.filled", "hands.filled.l", "hands.filled.r", "hands.filled.gaps", "hands.filled.maxGapMs",
    "links", "links[].kind", "links[].asset", "links[].url", "links[].title"
  ],
  "context": [
    "dc", "dcterms", "edm", "ore", "skos", "ebucore", "glossy",
    "edm:aggregatedCHO", "edm:isShownBy", "edm:isShownAt", "edm:hasView", "edm:isRelatedTo", "edm:rights",
    "dcterms:temporal", "dcterms:isPartOf", "dcterms:hasPart",
    "glossy:replyTo", "glossy:nativeRecord"
  ],
  "project": [
    "id", "name", "createdAt", "updatedAt", "language", "uiLanguage", "script", "script.questions", "cloudFallback", "assets", "annotationCount"
  ],
  "asset": [
    "id", "project", "url", "type", "name", "sort", "createdAt",
    "transform", "transform.scale", "transform.rotX", "transform.rotY", "transform.rotZ",
    "transform.x", "transform.y", "transform.z", "transform.pointSize",
    "visible", "options", "options.mode"
  ]
}
```
