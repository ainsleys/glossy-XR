# 012 · What a contributor reads is in the project's language

## Problem

Every string a person reads in the room is English: the consent label, the headset panel and its hints ("pinch and hold to answer", "microphone not yet allowed: tick consent on the page"), the status line ("tick consent first", "recording…", "saved …", "too short"), the visitor help text, the interview prompts' chrome, and the review page's card labels. A project can be set to Turkish for transcription (`language: 'tr'`), and its interview questions can be written in Turkish, but the tool around them stays English. A Turkish-speaking contributor is asked to consent to text they may not read.

## Goal

When a project's language is Turkish, everything a contributor or visitor reads in the room and on the review page is Turkish; otherwise English. The operator's panels (Settings, Assets, Help, the project selector) stay English: they are for the team.

## Requirements

R1. **String table.** `shared/strings.js` exporting `STRINGS = { en: {...}, tr: {...} }` keyed by short ids, and `t(key, vars)` that formats `{name}` placeholders. Every key exists in both languages (a unit test enforces this). Turkish strings are written by a Turkish speaker on the team before merge (the implementer drafts them and marks the file for review; the pull request lists every Turkish string for a human read).

R2. **Which language.** The UI language is the project's `language` when it is `tr`, else `en` (`?lang=tr|en` in the URL overrides, for testing and for a kiosk). It is re-evaluated when the project loads or changes. The review page follows the same rule from the project it shows.

R3. **The contributor surface, in scope** (each string through `t()`): the consent label in both forms (plain and with the cloud clause; the stored consent values are unchanged); the visitor help block; the headset panel's hints and status lines (everything `renderHint` and the hint branches produce, including the microphone states and the consent messages); the recording status lines (`starting microphone…`, `recording…`, `saved …`, `too short`, `tick consent first`, `enter your name first`, the reply and interview variants); the interview panel's visible chrome ("question 2 of 3", the ask/next labels); the chat panel lines the visitor sees ("pinch this panel to talk…", "listening…", "sending…"); the Ask voice uses the project language already. On the review page: card labels (period, layer, replies, "sounds like", "transcribed in the cloud"), the search placeholder, and the consent-withdrawn note.

R4. **Out of scope, stays English:** the operator panels (Settings, Assets, Help), the project selector and asset list, the transform controls, error messages that name HTTP or file errors, the session-log vocabulary, console output, and the server.

R5. **Dates and numbers.** `whenOf`'s relative times ("3 min ago", period labels) and durations go through `t()` with the same keys; no locale library is added (keep the formatting hand-written as today).

R6. **README.** The interview/visitor sections say the contributor surface follows the project language (en/tr) and how to add a language (one object in `shared/strings.js`; the unit test tells you what is missing).

## Non-goals

- No translation of operator panels, logs, or the server.
- No change to transcription language handling.
- No right-to-left or pluralisation machinery beyond `{vars}`; Turkish plural forms are written out per key where needed.
- No automatic browser-language detection (the project decides; the URL overrides).

## Design

`shared/strings.js` is dependency-free and runs in Node and the browser (like `shared/text.js`). `main.js` gets `let LANG = 'en'` and `const t = (k, v) => fmt(STRINGS[LANG][k] ?? STRINGS.en[k], v)`, set in `projectToHud` and on `?lang=`; the strings listed in R3 are replaced by `t()` calls; `index.html`'s static contributor text (consent label, visitor help) gets ids and is filled from `t()` at load and on language change. `review.js` does the same for its card labels. The headset panel is redrawn from `renderHint`, so a language change re-renders it on the next frame. Keep keys readable (`consent.plain`, `hint.pinchToAnswer`, `status.tooShort`).

## Tests

T1. Unit, `test/unit/strings.test.mjs`: every key in `en` exists in `tr` and vice versa; no empty strings; every `{var}` in an `en` string appears in its `tr` counterpart; `t()` formats and falls back to `en` for a missing key. Mutation: delete one `tr` key → fails naming it.

T2. E2e, `test/desktop.spec.js` or a new `test/strings.spec.js`: with the project language `tr`, the consent label, the visitor help and the status after a blocked record ("tick consent first" in Turkish) are Turkish; with `?lang=en` on the same project they are English; switching the project language via PATCH re-renders the label (poll). Mutation: make `t()` always use `en` → fails.

T3. Headset: in `test/xr.spec.js`, with the project language `tr`, the panel hint text (read through `__glossy.hud.hint` or the panel's exposed text) is the Turkish string for the current state. Mutation: as T2.

T4. Review page: a Turkish project's card shows Turkish labels. Mutation: as T2.

T5. Full `npm test` at the final commit: all passed.

## Definition of done

- R1–R6; T1–T5 with mutations in the pull request; the Turkish strings listed in the pull request for human review and a note of who read them.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
