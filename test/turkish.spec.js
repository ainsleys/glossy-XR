// Runs under the chromium-tr project, whose fake microphone speaks Turkish.
// Checks that a clip with no language set is detected as Turkish and comes
// back as Turkish text, and that a project language overrides detection.
import { test, expect } from '@playwright/test';
import { API, openProject, prepareRecording, lockPointer, recordWithMouse, listAnnotations, aimCamera } from './helpers.js';
import { SPEECH_WORDS_TR } from '../playwright.config.js';

test.skip(!process.env.GLOSSY_TEST_SPEECH_TR, 'needs the macOS Turkish system voice (Yelda) for the fake microphone');

test('a Turkish clip is detected and transcribed as Turkish', async ({ page, request }) => {
  const project = await openProject(page, request, 'turkish');
  expect(project.language).toBeNull();
  await prepareRecording(page, 'Konuk');
  await lockPointer(page);
  await recordWithMouse(page, 3200);
  await expect.poll(async () => (await listAnnotations(request, project.id))[0].transcription.status, { timeout: 120_000 }).toBe('done');
  const a = (await listAnnotations(request, project.id))[0];
  console.log('tr transcript:', a.transcript);
  expect(a.transcription.language).toBe('tr');
  expect(a.transcription.detected).toBe(true);
  expect(a.transcript).toMatch(SPEECH_WORDS_TR);
  expect(a.transcription.words.length).toBeGreaterThan(2);
  await expect(page.locator('#annList li .text')).toHaveText(SPEECH_WORDS_TR);

  // pin the project to English: the same speech is forced through the English decoder
  await request.patch(`${API}/api/projects/${project.id}`, { data: { language: 'en' } });
  await expect.poll(() => page.evaluate(() => window.__glossy.project.language)).toBe('en');
  await aimCamera(page, [0, 1.6, 0.6], [-2, 0.4, 0.5]);     // look at the chest, away from the first marker
  await recordWithMouse(page, 3200);                        // long enough to hold a full sentence from the looping fake microphone
  await expect.poll(async () => (await listAnnotations(request, project.id)).at(-1).transcription.status, { timeout: 120_000 }).toBe('done');
  const b = (await listAnnotations(request, project.id)).at(-1);
  expect(b.transcription.language).toBe('en');
  expect(b.transcription.detected).toBe(false);
  // the detector still ran: the clip is marked as sounding Turkish, the list says so and offers the Turkish decoder
  expect(b.transcription.heard).toBe('tr');
  const row = page.locator(`#annList li[data-id="${b.id}"]`);
  await expect(row.locator('.note')).toContainText(/sounds like/);
  await row.locator('.asHeard').click();
  // the first poll could still see the old 'done': wait for a done result in the new language
  await expect.poll(async () => { const t = (await listAnnotations(request, project.id)).at(-1).transcription; return t.status === 'done' && t.language; }, { timeout: 120_000 }).toBe('tr');
  const c = (await listAnnotations(request, project.id)).at(-1);
  expect(c.transcription.heard).toBe('tr');          // the detector agrees with what was asked, so nothing is flagged
  expect(c.transcript).toMatch(SPEECH_WORDS_TR);
  await expect(row.locator('.note')).toHaveCount(0);
});
