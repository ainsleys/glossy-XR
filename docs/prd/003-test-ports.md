# 003 · Two test suites can run at once

## Problem

The end-to-end suite binds fixed ports: `playwright.config.js` starts the API on `:3100` and Vite on `:5174`, `test/helpers.js` hard-codes `API = 'http://localhost:3100'`, and the fake-microphone WAV files are written to fixed names in the OS temp directory. Two checkouts of the repository (for example two git worktrees, each working on a different change) cannot run `npm test` at the same time: the second run finds the ports taken, or, worse, talks to the first run's servers. The suite takes about eight minutes, so this serialises everyone's verification.

## Goal

A run of the suite can be told which ports to use, and runs on different ports do not share anything.

## Requirements

R1. `playwright.config.js` reads `GLOSSY_TEST_API_PORT` and `GLOSSY_TEST_VITE_PORT` from the environment, defaulting to 3100 and 5174, and uses them everywhere it currently uses the constants (the two `webServer` entries, `baseURL`).

R2. `test/helpers.js` derives `API` from the same variable (`process.env.GLOSSY_TEST_API_PORT || 3100`), so the specs follow the config. Any other place that mentions the port (grep for `3100`, `5174`, `localhost:`) does the same; the README's description of the harness says the ports are overridable and names the variables.

R3. The fake-microphone WAV files written by `playwright.config.js` get a name that includes the API port (for example `glossy-test-mic-3100.wav`), so two runs never write the same temp file while the other is reading it.

R4. The throwaway data directory stays `.test-data` relative to the checkout (each worktree has its own), unchanged.

R5. Default behaviour is unchanged: `npm test` with no variables set does exactly what it does today, on the same ports.

## Non-goals

- No change to the dev-server ports (3000, 5173) or to `vite.config.js` beyond what R1 needs (it already reads `API_PORT`/`VITE_PORT` from the config's `webServer` command).
- No change to any test's assertions.
- No orchestration of parallel runs (scripts, lockfiles, port discovery): the caller sets the variables.

## Design

Two `const` lines at the top of `playwright.config.js` become `Number(process.env.GLOSSY_TEST_API_PORT || 3100)` and `…VITE_PORT || 5174`; the WAV filenames interpolate `API_PORT`. `test/helpers.js` builds `API` from the same expression. README "Testing" paragraph: one sentence naming the variables and that two checkouts can test at once with different values.

## Tests

T1. Default run: `npx playwright test test/desktop.spec.js -g "renders the default room"` with no variables set passes and the servers come up on 3100/5174 (observed in the output). Mutation: none needed; this is the unchanged path.

T2. Overridden run: `GLOSSY_TEST_API_PORT=3200 GLOSSY_TEST_VITE_PORT=5274 npx playwright test test/desktop.spec.js -g "records, saves"` passes, and `lsof -i :3200` during the run shows the API there. Mutation: revert the `helpers.js` change only; the overridden run must fail (the spec would talk to 3100, which is not running). Restore.

T3. Concurrency: start the default run of one spec in one terminal and the overridden run of another spec in a second terminal at the same time; both pass. Record the two commands and results in the pull request.

## Definition of done

- R1–R5; T1–T3 recorded in the pull request, T2's mutation shown to fail.
- `npm test` at the final commit: all passed (the optional interior scene test may be skipped).
- README updated as in R2 and nowhere else.
- Commit messages and the pull request describe the change only.

## Decisions

(Filled in after the specification review.)
