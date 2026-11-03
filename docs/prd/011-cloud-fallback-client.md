# 011 · Cloud transcription fallback: what the contributor sees and agrees to

Second half of 010. The server now sends a clip to the cloud only when the project has opted in, the clip carries `cloudConsent`, and the local result was rejected. No client sends `cloudConsent` yet, so the feature is inert. This change adds the operator's switch, the consent clause the contributor ticks, the flag the page sends, and the provenance badges.

## Problem

`cloudFallback` can only be set through the API; the consent label in `client/index.html` ("I consent to my recording being stored and shared") never mentions the cloud; the page always posts without `cloudConsent`; and nothing in the room's clip list or the review page shows which backend produced a transcript, although the record now says.

## Goal

An operator can switch the fallback on for a project from the HUD. A contributor who ticks consent on a project with the fallback on has read a label that says their recording may be transcribed by an external service, and only then does the page send `cloudConsent`. Anyone reading a clip can see it was transcribed in the cloud.

## Requirements

R1. **Settings checkbox.** In the HUD Settings panel (`#settingsPanel`, operator-only, hidden in visitor mode like the rest of the panel): "Send unclear clips to the cloud transcriber", bound to the project's `cloudFallback` through `PATCH /api/projects/:id`, updated when a project loads and when `project:updated` arrives over the socket. A short title attribute says when it applies (only clips whose local transcription was rejected, only with consent).

R2. **Consent label.** With the project's `cloudFallback` off, the label reads as today. With it on, it reads "I consent to my recording being stored and shared, and transcribed by an external service when the local transcriber cannot read it". The label follows the project: switching projects or the setting changing re-renders it.

R3. **The flag the page sends.** The page remembers consent in `localStorage` (`glossy.consent`). Replace the stored `'1'` with the text of what was agreed: `'1'` for the plain label, `'cloud'` for the label with the clause. The clip upload sends `cloudConsent: 'true'` only when the stored value is `'cloud'` **and** the current project's `cloudFallback` is on. When a project with the fallback on is loaded (or the setting switches on) and the stored value is `'1'`, the box is unticked and the status line says consent needs to be given again for this project; the microphone-readiness logic that follows the checkbox behaves as for a fresh page. The chat panel's audio is unaffected (server non-goal in 010).

R4. **Badges.** In the room's clip list (`renderList`/`describeRecord`) and on the review page's cards, a clip whose `transcription.backend` is not `local` shows "transcribed in the cloud" (and "cloud transcription failed, local text kept" when `transcription.cloud.error` is set); the title attribute carries `backend`, `model` and `cloud.reason`.

R5. **Visitor mode.** The checkbox is hidden; the label logic (R2, R3) applies to visitors too, since they are the ones consenting.

R6. **README.** The transcription section's fallback paragraph gains the client half: where the switch is, what the label says, that re-consent is required when the clause appears.

## Non-goals

- No change under `server/` (the policy is in 010); if the client needs a server change, stop and report.
- No in-headset consent UI; the headset panel keeps showing "tick consent on the page" as today.
- No change to the review page beyond the badge.

## Design

`client/src/main.js`: `hud.cloudFallback` checkbox wired like `hud.language` (PATCH on change; set from `project` on load and `project:updated`); a `renderConsentLabel()` called from the same places; the consent `change` handler stores `'cloud'` or `'1'`; `beginRecording`'s upload adds `cloudConsent` per R3; `describeRecord` adds the badge text. `client/review.js`: card header adds the same badge. `client/index.html`: the checkbox row in Settings and an id on the consent label text span so it can be rewritten.

## Tests

T1. Label and switch (`test/desktop.spec.js` or `test/cloud.spec.js`): open a project, assert the label is the plain one; `PATCH cloudFallback: true`; assert the label contains "external service" and the Settings checkbox is checked; switch it off from the checkbox; assert the PATCH went through (GET project) and the label is plain again. Mutation: remove the `project:updated` re-render → the label assertion after the PATCH fails.

T2. The flag: with the project on, tick consent and record a clip → the stored record has `cloudConsent: true`; with the project off, tick and record → `cloudConsent: false`; tick consent on a project that is off, then switch the project on → the box is unticked and the status says so; ticking again and recording → `true`. Mutation: send `cloudConsent: 'true'` unconditionally → the "project off" case fails (the server ANDs with the project, so assert through `localStorage` as well: stored value `'1'` must not produce the flag; make the mutation ignore the stored value and the "ticked before the clause" case fails).

T3. Badges: reuse the stub flow from `test/cloud.spec.js` with a page open: after the cloud result lands, the list row shows "transcribed in the cloud" and the review page card does too; for the failed-call case, the "local text kept" badge. Mutation: remove the badge from `describeRecord` → fails.

T4. Visitor mode: `?mode=visitor` with the project on shows the clause and no checkbox.

T5. Full `npm test` at the final commit: all passed.

## Definition of done

- R1–R6; T1–T5 with mutations in the pull request.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
