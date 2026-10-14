// End-to-end harness: headless Chromium with software WebGL, a fake microphone
// fed from a generated WAV, and (in xr.spec.js) an emulated Quest 3 via IWER.
// Runs its own API server on :3100 with a throwaway data dir and Vite on :5174,
// so a dev session on :3000/:5173 is left alone.
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeToneWav } from './test/fixtures/tone.js';

const API_PORT = 3100, VITE_PORT = 5174;

// The fake microphone plays this file on a loop. On macOS it is real speech
// from the system voice, so transcripts can be checked for words; elsewhere
// it is a tone and transcript tests only check that the pipeline completes.
export const SPOKEN = 'The lamp on the table is broken. The lamp on the table is broken.';
export const SPEECH_WORDS = /lamp|table|broken/i;
// Turkish fixture for the language test (macOS ships the Yelda voice)
export const SPOKEN_TR = 'Pekmez kazanı avluda, asmanın altında dururdu. Pekmez kazanı avluda, asmanın altında dururdu.';
export const SPEECH_WORDS_TR = /pekmez|kazan|avlu|asma|durur/i;
function fakeMic(name, text, voice, flag) {
  const wav = path.join(os.tmpdir(), name);
  if (process.platform === 'darwin') {
    try { execFileSync('say', [...(voice ? ['-v', voice] : []), '--file-format=WAVE', '--data-format=LEI16@16000', '-o', wav, text]); process.env[flag] = '1'; return wav; } catch {}
  }
  return writeToneWav(wav);
}
const tone = fakeMic('glossy-test-mic.wav', SPOKEN, null, 'GLOSSY_TEST_SPEECH');
const toneTr = fakeMic('glossy-test-mic-tr.wav', SPOKEN_TR, 'Yelda', 'GLOSSY_TEST_SPEECH_TR');   // only set when the Turkish voice exists
const launchArgs = (mic) => [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${mic}`,
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: './test',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: { args: launchArgs(tone) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /turkish/ },
    // same browser, Turkish speech on the fake microphone
    { name: 'chromium-tr', use: { ...devices['Desktop Chrome'], launchOptions: { args: launchArgs(toneTr) } }, testMatch: /turkish/ },
  ],
  webServer: [
    {
      command: `rm -rf .test-data && GLOSSY_DATA=.test-data PORT=${API_PORT} node --disable-warning=ExperimentalWarning server/index.js`,
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `API_PORT=${API_PORT} VITE_PORT=${VITE_PORT} npx vite --host localhost`,
      url: `http://localhost:${VITE_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
