# NNN · Feature name

Copy this file to `docs/prd/NNN-slug.md` (next number, short slug), fill every section, delete the guidance in parentheses. A PRD describes the feature on its own terms: what the tool should do, for whom, and how that is verified. It is the whole specification the implementer works from.

## Problem

(What a user of the tool cannot do today, or what goes wrong, in two or three sentences. Point at the code or the behaviour, with file and function names, not at documents or discussions.)

## Goal

(One sentence: what the tool does once this is done.)

## Requirements

(Numbered R1, R2, … Each one is a statement about behaviour that a test or a reader of the code can check. Name the files and functions involved. Where the codebase already has a pattern for the same kind of thing, say which one to follow.)

## Non-goals

(What this change must not do, as a list. Anything adjacent that is tempting but out of scope goes here. Name any known failing test that this change must not touch.)

## Design

(How it fits the existing code: new modules and their interface, which existing functions change, where the hooks go. Short. Enough that two implementers would make the same structural choices.)

## Tests

(Numbered T1, T2, … Each test says what it asserts and which requirement it covers. Rules that apply to every test:

- A test must be shown to fail. For each new test, name the change to the code that makes it fail (the "mutation"). The implementer runs that mutation, records that the test fails, restores the code, and says so in the pull request.
- Poll, never wait-and-read. Under the suite's software GL and CPU transcription, the render loop runs behind wall time. Assertions on state that changes over time use `expect.poll(...)` with a generous timeout, never a fixed `waitForTimeout` followed by a single read.
- Stability. Each new or changed end-to-end test is run with `--repeat-each=5` before the pull request opens, and the result is in the pull request.
- Prefer extending an existing test over opening a new XR session; a new session is slow.
- Transient UI text (a status line that a later frame overwrites) is a weak thing to assert on; prefer state the page exposes for tests on `window.__glossy`, or events in the session log.)

## Definition of done

- Every requirement implemented; every test added and passing; each new test shown to fail under its named mutation.
- `npm test` run at the final commit, with the passed/failed/skipped counts and the full text of any failure in the pull request. Only failures the PRD names in advance are acceptable.
- README updated wherever it describes the changed behaviour, and nowhere else.
- Commit messages and the pull request describe the feature and the change, nothing else.

## Decisions

(Filled in after the specification review: each point raised, and what was decided and why. Keep the ones that changed the PRD and the ones that were declined.)
