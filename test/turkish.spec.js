// Runs under the chromium-tr project, whose fake microphone speaks Turkish.
// Checks that a clip with no language set is detected as Turkish and comes
// back as Turkish text, and that a project language overrides detection.
// Detection is checked on a clip recorded through the fake microphone. The
// words and the override are checked on clips posted from a fixed WAV, one
// whole utterance as a person would record it: the looping microphone starts
// a clip anywhere in the sentence, and whisper-base decodes some of those
// windows of Turkish to a subtitle credit instead of the words.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { API, openProject, prepareRecording, lockPointer, recordWithMouse, listAnnotations } from './helpers.js';
import { SPEECH_WORDS_TR, TURKISH_CLIP } from '../playwright.config.js';

test.skip(!process.env.GLOSSY_TEST_SPEECH_TR, 'needs the macOS Turkish system voice (Yelda) for the fake microphone');

/** Post the fixed Turkish clip through the API, as a recorded clip is posted, and return the new record. */
async function postClip(request, projectId, x) {
  const res = await request.post(`${API}/api/projects/${projectId}/annotations`, { multipart: {
    audio: { name: 'clip.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(TURKISH_CLIP) },
    x: String(x), y: '1', z: '-1', author: 'Konuk', consent: 'true',
  } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}
/** The stored record for one clip, by id. */
const annotation = async (request, projectId, id) => (await listAnnotations(request, projectId)).find((a) => a.id === id);
const transcribed = (request, projectId, id) => expect.poll(async () => (await annotation(request, projectId, id)).transcription.status, { timeout: 120_000 }).toBe('done');

test('a Turkish clip is detected and transcribed as Turkish', async ({ page, request }) => {
  const project = await openProject(page, request, 'turkish');
  expect(project.language).toBeNull();

  // recorded through the browser: detection only, since the words depend on where in the loop the clip started
  await prepareRecording(page, 'Konuk');
  await lockPointer(page);
  await recordWithMouse(page, 3200);
  await expect.poll(async () => (await listAnnotations(request, project.id))[0].transcription.status, { timeout: 120_000 }).toBe('done');
  const live = (await listAnnotations(request, project.id))[0];
  console.log('tr transcript (recorded):', live.transcript);
  expect(live.transcription.language, JSON.stringify({ transcript: live.transcript, ...live.transcription })).toBe('tr');   // a miss shows unclear, raw, heard and ms
  expect(live.transcription.detected).toBe(true);

  // the fixed clip, no language set: detected and decoded as Turkish
  const { id: aId } = await postClip(request, project.id, 0);
  await transcribed(request, project.id, aId);
  const a = await annotation(request, project.id, aId);
  console.log('tr transcript (fixed):', a.transcript);
  expect(a.transcription.language).toBe('tr');
  expect(a.transcription.detected).toBe(true);
  expect(a.transcript, JSON.stringify({ transcript: a.transcript, ...a.transcription })).toMatch(SPEECH_WORDS_TR);
  expect(a.transcription.words.length).toBeGreaterThan(2);
  await expect(page.locator(`#annList li[data-id="${aId}"] .text`)).toHaveText(SPEECH_WORDS_TR);

  // pin the project to English: the same speech is forced through the English decoder
  await request.patch(`${API}/api/projects/${project.id}`, { data: { language: 'en' } });
  await expect.poll(() => page.evaluate(() => window.__glossy.project.language)).toBe('en');
  const { id: bId } = await postClip(request, project.id, 1);
  await transcribed(request, project.id, bId);
  const b = await annotation(request, project.id, bId);
  expect(b.transcription.language).toBe('en');
  expect(b.transcription.detected).toBe(false);
  // the detector still ran: the clip is marked as sounding Turkish, the list says so and offers the Turkish decoder
  expect(b.transcription.heard).toBe('tr');
  const row = page.locator(`#annList li[data-id="${bId}"]`);
  await expect(row.locator('.note')).toContainText(/sounds like/);
  await row.locator('.asHeard').click();
  // the first poll could still see the old 'done': wait for a done result in the new language
  await expect.poll(async () => { const t = (await annotation(request, project.id, bId)).transcription; return t.status === 'done' && t.language; }, { timeout: 120_000 }).toBe('tr');
  const c = await annotation(request, project.id, bId);
  expect(c.transcription.heard).toBe('tr');          // the detector agrees with what was asked, so nothing is flagged
  expect(c.transcript, JSON.stringify({ transcript: c.transcript, ...c.transcription })).toMatch(SPEECH_WORDS_TR);
  await expect(row.locator('.note')).toHaveCount(0);
});
