# 011 · Cloud transcription fallback: what the contributor sees and agrees to

Second half of 010. The server now sends a clip to the cloud only when the project has opted in, the clip carries `cloudConsent`, and the local result was rejected. No client sends `cloudConsent` yet, so the feature is inert. This change adds the operator's switch, the consent clause the contributor ticks, the flag the page sends, and the provenance badges.

## Problem

`cloudFallback` can only be set through the API; the consent label in `client/index.html` ("I consent to my recording being stored and shared") never mentions the cloud; the page always posts without `cloudConsent`; and nothing in the room's clip list or the review page shows which backend produced a transcript, although the record now says.

## Goal

An operator can switch the fallback on for a project from the HUD. A contributor who ticks consent on a project with the fallback on has read a label that says their recording may be transcribed by an external service, and only then does the page send `cloudConsent`. Anyone reading a clip can see it was transcribed in the cloud.

## Requirements

R1. **Settings checkbox.** In the HUD Settings panel (`#settingsPanel`, operator-only, hidden in visitor mode like the rest of the panel): "Send unclear clips to the cloud transcriber", bound to the project's `cloudFallback` through `PATCH /api/projects/:id`, updated when a project loads and when `project:updated` arrives over the socket. A short title attribute says when it applies (only clips whose local transcription was rejected, only with consent).

R2. **Consent label.** With the project's `cloudFallback` off, the label reads as today. With it on, it reads "I consent to my recording being stored and shared, and transcribed by an external service when the local transcriber cannot read it". The label follows the project: switching projects or the setting changing re-renders it.

R3. **The flag the page sends.** The page remembers consent in `localStorage` (`glossy.consent`). Store what was agreed: `'1'` for the plain label, `'cloud'` for the label with the clause; the load check (`main.js` near the top, currently `=== '1'`) treats both as ticked. The clip upload sends `cloudConsent: 'true'` only when the stored value is `'cloud'` **and** the current project's `cloudFallback` is on (the stored-value check is defence in depth; the untick below is what keeps the two in step). `client/src/api.js` lists the fields it uploads, so `cloudConsent` is added there. When a project with the fallback on is loaded (or the setting switches on) and the stored value is `'1'`, the box is unticked and the status line says consent needs to be given again for this project. Two follow-ons: the page-load `pointerdown` listener that opens the microphone checks `hud.consent.checked` when it fires, not only when it is registered; and the headset hint "tick consent on the page" shows whenever the box is unticked, not only while the microphone is not ready (recording is already refused by `beginRecording`, so this is a message, not a gate). The chat panel's audio is unaffected.

R4. **Badges.** In the room's clip list (the `badges` string in `renderList`, not `describeRecord`, which writes the status line) and on the review page's cards (`cardHtml` in `review.js`): "transcribed in the cloud" when `transcription.backend` is set and is not `local` (pending and older clips have no backend and get no badge), and "cloud transcription failed, local text kept" when `transcription.cloud?.error` is set (the backend stays `local` in that case); the title attribute carries `backend`, `model` and `cloud.reason`.

R5. **Visitor mode.** The checkbox is hidden; the label logic (R2, R3) applies to visitors too, since they are the ones consenting.

R6. **README.** The transcription section's fallback paragraph gains the client half: where the switch is, what the label says, that re-consent is required when the clause appears.

## Non-goals

- No change under `server/` (the policy is in 010); if the client needs a server change, stop and report.
- No in-headset consent UI; the headset panel keeps showing "tick consent on the page" as today.
- No change to the review page beyond the badge.

## Design

`client/src/main.js`: `hud.cloudFallback` checkbox wired like `hud.language` (`projectToHud` on load, PATCH on change); `onProjectUpdated` re-renders when `cloudFallback` changes too (today it checks only language and script; the page receives the echo of its own PATCH, which cannot loop since setting `.checked` in code fires no change event); `renderConsentLabel()` called from the same places; the consent `change` handler stores `'cloud'` or `'1'`; the upload adds `cloudConsent` per R3; `renderList` adds the badge. `client/src/api.js`: the field list gains `cloudConsent`. `client/review.js`: `cardHtml` adds the badge. `client/index.html`: the checkbox row in Settings and `<span id="consentText">` around the label text.

## Tests

T1. Label and switch (`test/desktop.spec.js` or `test/cloud.spec.js`): open a project, assert the label is the plain one; `PATCH cloudFallback: true`; assert the label contains "external service" and the Settings checkbox is checked; switch it off from the checkbox; assert the PATCH went through (GET project) and the label is plain again. Mutation: remove the `project:updated` re-render → the label assertion after the PATCH fails.

T2. The flag: with the project on, tick consent and record a clip → the stored record has `cloudConsent: true` and `localStorage` holds `'cloud'`; with the project off, tick and record → `cloudConsent: false` and `'1'`; tick consent on a project that is off (stored `'1'`), then `PATCH cloudFallback: true` from the request context → the page observes `project:updated`, the box is unticked and the status says so; ticking again and recording → `true`. Mutation: remove the untick → the unticked-box assertion fails. Second mutation: always send `cloudConsent: 'true'` → the "project off" case still passes (the server ANDs with the project), so assert the request body too (intercept the upload with `page.route` or read the record's `cloudConsent` after a project switched on with stored `'1'`); choose the form that fails under this mutation and say which.

T3. Badges, in `test/cloud.spec.js` (its `beforeAll` starts the stub; the fake microphone speaks clearly so a recorded clip never triggers the fallback): with the page open on the project, post the "Thank you." clip through the API as the existing tests do; after the cloud result lands, the list row shows "transcribed in the cloud" and the review page card does too; for the failed-call case (stub answering 500), "cloud transcription failed, local text kept". Mutation: remove the badge from `renderList` → fails.

T4. Visitor mode: `?mode=visitor` with the project on shows the clause and no checkbox.

T5. Full `npm test` at the final commit: all passed.

## Definition of done

- R1–R6; T1–T5 with mutations in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions (3 Nov)

1. The stored consent value records which label was agreed; the load check accepts both values; the untick on a project that switches the clause on is the mechanism that keeps the flag honest, and the stored-value check is defence in depth.
2. `api.js` whitelists upload fields, so the new field must be added there or it is silently dropped.
3. `onProjectUpdated` must react to `cloudFallback`; the PATCH echo cannot loop.
4. Badges live in `renderList` and `cardHtml`; the condition is "backend set and not local", with the failed-call badge keyed on `cloud.error`.
5. The page-load microphone listener and the headset hint follow the checkbox's current state after an untick.
6. T3 lives in `cloud.spec.js` because the stub is started there and the live microphone cannot trigger the fallback.
7. Accepted behaviour: consent is stored per browser origin, so a `'cloud'` tick carries to other projects that have the switch on, and to the next person on a shared device (already true of the plain consent; the exhibition consent flow is a separate change). When a project is switched off and later on again, a stored `'cloud'` consent applies without a new prompt.
