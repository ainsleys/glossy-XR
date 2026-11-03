# 012 · What a contributor reads in the room is in the project's UI language

First of two. This change covers the room (desktop page and headset). The review page (012b) is a desk tool with erase, consent and re-transcribe controls; translating only its labels would give a half-translated operator page, so it is left for a separate decision.

## Problem

Every string a person reads in the room is English: the consent label, the headset panel and its hints, the status line, the visitor help text, the clip list, the chat panel. A project can be set to Turkish for transcription and its interview questions can be Turkish, but the tool around them stays English. A Turkish-speaking contributor is asked to consent to text they may not read.

## Goal

When a project's UI language is Turkish, everything a contributor or visitor reads in the room is Turkish; otherwise English. Operator panels stay English.

## Requirements

R1. **String table.** `shared/strings.js`, dependency-free, runs in Node and the browser: `STRINGS = { en: {...}, tr: {...} }` keyed by readable ids with prefixes, `t(key, vars)` formatting `{name}` placeholders and falling back to `en` for a missing key, and `TR_REVIEWED = { key: hash }` recording, for each Turkish key a Turkish speaker has read, a short hash of the string as read (`hash()`, FNV-1a, eight hex digits, no dependency). The unit test fails, naming the key, for any Turkish key missing from `TR_REVIEWED` or whose string no longer matches its hash, so the suite cannot be green at the final commit without sign-off, and an edit after sign-off needs reading again. `node scripts/sign-off-tr.mjs --by "<name>"` fills `TR_REVIEWED` with the current hashes and prints the keys it recorded; the commit it produces names who read the strings (first name or role, in the commit message).

R2. **Which language.** A new project field `uiLanguage` (`'en'` default, `'tr'`), separate from the transcription `language`, because a site may want auto-detected transcription with a Turkish interface. Server: column with migration in the `db.js` pattern, accepted by `PATCH /api/projects/:id` (`en`|`tr` only), returned by the project endpoints, a row and json-block entry in `docs/SCHEMA.md` (the drift test will say if it is missing), a Settings dropdown in the HUD (operator-only, like `language`). `?lang=tr|en` in the URL overrides the project for that page (kiosk, tests): read once at boot, kept through the two `replaceState` calls on project open, and carried in the visitor link. Re-evaluated when the project loads or `project:updated` changes `uiLanguage`.

R3. **The contributor surface, by key prefix** (all through `t()`; counts approximate, from a read of `main.js` on `main`):
- `consent.*`: the plain and cloud labels; the re-consent status.
- `status.*` (~42): microphone ready/blocked/stopped; recording start/progress/saved/too short/blocked (name, consent, project); the five `recStatusBase` variants; reply and interview variants; play/stop/hover/near lines; the year-view line; ask; chat lines; connected/disconnected; the initial `connecting…` in `index.html`.
- `hint.*` (~18): everything `renderHint` (desktop `#hint`) and `updateXrPanel` (the headset panel) produce.
- `chat.*` (4): the chat panel states.
- `list.*` (~20): the clip list a visitor sees: transcribing/failed/no speech, `Q:`, "sounds like … transcribed as …", `UNCLEAR_TEXT` and `cloudBadge` in `shared/text.js`, `linksOf`, `whenOf` (days/months/years ago; Turkish takes no plural after a number: "3 gün önce"), `fmtDur`, `describeHands` in `client/src/hands.js`.
- `html.*` (~12): "Your name" and its placeholder, "All periods", the legend, "Annotations", the Ask/previous/next titles, `document.title`.
- `langName(code, LANG)` uses the UI language, not `navigator.language`.

Strings that are concatenations today become whole templates with variables: "saved {dur} on {object} with {extra}", "recording… ({layer})", "talking about {object}…", "{hand} thumb" (hand names translated too), "{base} {secs}s". Rule for Turkish: variables take postpositions, never case suffixes ("{obj} üzerinde"), and plural keys are chosen by the caller. Durations keep the hand-written formatting; the decimal separator follows the language (`Intl.NumberFormat` is built in).

R4. **Out of scope, stays English:** operator panels (Settings, Assets, Help, project selector, transforms, erase, layer and language controls), `e.message` fragments inside a translated prefix (the prefix is translated, the message is not), the session-log vocabulary, console output, the server, three.js's "ENTER VR" button text, the review page (012b).

R5. **Tests keep their English projects.** Existing tests and helpers (`openProject` polls for not "connecting", `recordWithMouse` polls "recording", the consent and cold-mic tests, xr.spec's panel assertions, cloud.spec's label text) stay as they are on English projects. New Turkish tests import `shared/strings.js` and assert against `STRINGS.tr[key]`, never against literal Turkish in the test.

R6. **README.** The visitor/interview sections say the room follows the project's `uiLanguage` (en/tr) with `?lang=` as override, how to add a language, and that the review page is not translated.

## Non-goals

- No translation of the review page, operator panels, logs, or server messages.
- No change to transcription language handling.
- No pluralisation or RTL machinery beyond `{vars}` and per-key plural forms.
- No browser-language detection.

## Design

`shared/strings.js` as in R1. `main.js`: `LANG` from `?lang=` else `project.uiLanguage` else `en`, set in `projectToHud` and `onProjectUpdated`; `t` wraps `STRINGS`; the strings in R3 replaced; `index.html` contributor text gets ids filled from `t()` at load and on language change; the headset panel redraws from `updateXrPanel` each frame. Server: `ui_language` column, PATCH validation, project JSON. SCHEMA.md updated.

## Tests

T1. Unit `test/unit/strings.test.mjs`: every `en` key in `tr` and vice versa; no empty strings; every `{var}` in `en` appears in `tr`; `t()` formats and falls back; every `tr` key is in `TR_REVIEWED` with a matching hash. Mutations: delete a `tr` key → fails naming it; after a sign-off, edit a `tr` string → fails naming it.

T2. E2e desktop, new `test/strings.spec.js`: a project with `uiLanguage: 'tr'` shows `STRINGS.tr['consent.plain']` as the label, the visitor help in Turkish, and after a blocked record the status equals `STRINGS.tr['status.noConsent']`; `?lang=en` on the same project shows English; `PATCH uiLanguage: 'en'` re-renders the label (poll). Mutation: make `t()` ignore `LANG` → fails.

T3. Headset, in `test/xr.spec.js` or `strings.spec.js` with IWER: with `uiLanguage: 'tr'`, `__glossy.xrPanel.text` contains the Turkish hint for the current state (read keys from the table). Mutation: as T2.

T4. Drift test passes with `uiLanguage`; mutation: drop it from the json block → fails.

T5. Full `npm test` at the final commit: all passed (which requires every Turkish string to be in `TR_REVIEWED` with a matching hash: the pull request stays a draft until a Turkish speaker has read the strings and the sign-off commit is made).

## Definition of done

- R1–R6; T1–T5 with mutations in the pull request; every Turkish string listed in the pull request; the sign-off commit present.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. Split: the room now; the review page later if wanted (012b).
2. `uiLanguage` is its own project field: tying the interface to the transcription language would prevent auto-detected transcription with a Turkish interface. This is the one server change in a client PRD, and it is small.
3. Sign-off is enforced in code, not in prose: the suite cannot pass at the final commit without a human having read the Turkish. Revised after code review (3 Nov): a list of unread keys became `TR_REVIEWED`, a hash per string as read, so a string edited after sign-off is caught, and `scripts/sign-off-tr.mjs` makes the sign-off one command.
4. Existing tests stay on English projects; Turkish tests assert table values, so wording changes don't break them.
5. `?lang=` must survive `replaceState` and be carried in links, or a kiosk loses it on reload.
6. Concatenated strings become templates; the grammar rules for Turkish variables are stated so the drafter and the reader apply the same ones.
