// The cloud fallback. A stub on STUB_PORT stands in for the OpenAI
// transcription endpoint and counts its calls. The clip is a committed
// "Thank you." that the local model transcribes to a line the transcript guard
// rejects as silence, so only the three conditions (project setting, clip
// consent, cloud consent) decide whether the stub is called. The API tests come
// first; then the page: the switch, the consent label, the flag the page sends,
// and the badges. The fake microphone speaks clearly, so a clip recorded in the
// page never reaches the stub; the badges are checked on the posted clip.
import fs from 'node:fs';
import http from 'node:http';
import { test, expect } from '@playwright/test';
import { API, listAnnotations, openProject, prepareRecording, lockPointer, aimCamera, recordWithMouse } from './helpers.js';
import { STUB_PORT, THANK_YOU_CLIP } from '../playwright.config.js';

const CLOUD_TEXT = 'The well stood by the gate.';
let stub, hits = 0;
let delayMs = 0, failWith = 0;                 // set by a test to slow the stub down or make it fail

test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') { res.writeHead(404).end(); return; }
      hits++;
      const answer = () => failWith ? res.writeHead(failWith, { 'content-type': 'application/json' }).end('{"error":"stub failure"}') : res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        text: CLOUD_TEXT, language: 'english',
        words: CLOUD_TEXT.replace('.', '').split(' ').map((word, i) => ({ word, start: i * 0.3, end: i * 0.3 + 0.25 })),
      }));
      if (delayMs) setTimeout(answer, delayMs); else answer();
    });
  });
  await new Promise((resolve, reject) => stub.once('error', reject).listen(STUB_PORT, 'localhost', resolve));
});
test.afterAll(() => new Promise((resolve) => stub.close(resolve)));
test.afterEach(() => { delayMs = 0; failWith = 0; });

async function project(request, name, cloudFallback) {
  const p = await (await request.post(`${API}/api/projects`, { data: { name } })).json();
  const res = await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback } });
  expect(res.ok(), await res.text()).toBeTruthy();
  expect((await res.json()).cloudFallback).toBe(cloudFallback);
  return p;
}
async function postThankYou(request, projectId, extra = {}) {
  const res = await request.post(`${API}/api/projects/${projectId}/annotations`, { multipart: {
    audio: { name: 'clip.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(THANK_YOU_CLIP) },
    x: '0', y: '1', z: '-1', author: 'Guest', consent: 'true', ...extra,
  } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}
async function transcribed(request, projectId, id) {
  await expect.poll(async () => (await listAnnotations(request, projectId)).find((a) => a.id === id).transcription.status, { timeout: 120_000 }).toBe('done');
  return (await listAnnotations(request, projectId)).find((a) => a.id === id);
}

test('an unclear local transcript goes to the cloud when the project and the clip both allow it', async ({ request }) => {
  const p = await project(request, 'cloud-on', true);
  const before = hits;
  const clip = await postThankYou(request, p.id, { cloudConsent: 'true' });
  expect(clip.cloudConsent).toBe(true);
  const a = await transcribed(request, p.id, clip.id);
  expect(a.transcript, JSON.stringify(a.transcription)).toBe(CLOUD_TEXT);
  expect(a.transcription.backend).toBe('openai');
  expect(a.transcription.cloud).toEqual({ from: 'local', reason: 'silence' });
  expect(a.transcription.unclear).toBeUndefined();
  expect(a.cloudConsent).toBe(true);
  expect(hits - before).toBe(1);

  const events = await (await request.get(`${API}/api/projects/${p.id}/events`)).json();
  const fallback = events.filter((e) => e.kind === 'transcribe:fallback');
  expect(fallback).toHaveLength(1);
  expect(fallback[0].session).toBe('server');
  expect(fallback[0].data).toEqual({ id: clip.id, from: 'local', to: 'openai', reason: 'silence' });

  // the export carries the consent, the EDM provenance says what happened
  const exp = await (await request.get(`${API}/api/projects/${p.id}/export`)).json();
  expect(exp.contributions[0].cloudConsent).toBe(true);
  const edm = await (await request.get(`${API}/api/projects/${p.id}/export?format=edm`)).json();
  const web = edm['@graph'].find((n) => n['@type'] === 'edm:WebResource' && n['@id'].endsWith(clip.audioUrl));
  expect(web['dcterms:provenance']).toContain('Transcribed by whisper-1 (openai) after the local transcription was rejected as silence');

  // a reviewer cannot change the clip's cloud consent
  const patched = await (await request.patch(`${API}/api/projects/${p.id}/annotations/${clip.id}`, { data: { cloudConsent: false, layer: 'review' } })).json();
  expect(patched.cloudConsent).toBe(true);
});

test('with the project setting off the clip stays local and unclear, and its cloud consent is not stored', async ({ request }) => {
  const p = await project(request, 'cloud-off', false);
  const before = hits;
  const clip = await postThankYou(request, p.id, { cloudConsent: 'true' });
  expect(clip.cloudConsent).toBe(false);
  const a = await transcribed(request, p.id, clip.id);
  expect(a.transcript).toBe('');
  expect(a.transcription.unclear).toBe('silence');
  expect(a.transcription.backend).toBe('local');
  expect(a.transcription.cloud).toBeUndefined();
  expect(hits - before).toBe(0);

  // switching the project on later does not reach the clip on a re-run
  await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback: true } });
  await request.post(`${API}/api/projects/${p.id}/annotations/${clip.id}/transcribe`, { data: {} });
  const again = await transcribed(request, p.id, clip.id);
  expect(again.transcription.backend).toBe('local');
  expect(again.cloudConsent).toBe(false);
  expect(hits - before).toBe(0);
  expect((await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback: 'yes' } })).status()).toBe(400);
});

test('with the project on but no cloud consent on the clip it stays local and unclear', async ({ request }) => {
  const p = await project(request, 'cloud-no-consent', true);
  const before = hits;
  const clip = await postThankYou(request, p.id);
  expect(clip.cloudConsent).toBe(false);
  const a = await transcribed(request, p.id, clip.id);
  expect(a.transcript).toBe('');
  expect(a.transcription.unclear).toBe('silence');
  expect(a.transcription.backend).toBe('local');
  expect(hits - before).toBe(0);
  const events = await (await request.get(`${API}/api/projects/${p.id}/events`)).json();
  expect(events.filter((e) => e.kind === 'transcribe:fallback')).toHaveLength(0);
});

test('consent withdrawn while the clip waits in the queue keeps it local', async ({ request }) => {
  const p = await project(request, 'cloud-withdrawn', true);
  const before = hits;
  delayMs = 3000;                                          // the first clip holds the serial queue at the stub for 3 s
  const first = await postThankYou(request, p.id, { cloudConsent: 'true' });
  const second = await postThankYou(request, p.id, { cloudConsent: 'true' });
  const res = await request.patch(`${API}/api/projects/${p.id}/annotations/${second.id}`, { data: { consent: false } });
  expect((await res.json()).consent).toBe(false);
  expect((await transcribed(request, p.id, first.id)).transcription.backend).toBe('openai');
  const b = await transcribed(request, p.id, second.id);
  expect(b.transcript).toBe('');
  expect(b.transcription.unclear).toBe('silence');
  expect(b.transcription.backend).toBe('local');
  expect(b.transcription.cloud).toBeUndefined();
  expect(b.cloudConsent).toBe(true);                       // what the contributor agreed to stays recorded
  expect(hits - before).toBe(1);                           // the first clip only
  const events = await (await request.get(`${API}/api/projects/${p.id}/events`)).json();
  expect(events.filter((e) => e.kind === 'transcribe:fallback').map((e) => e.data.id)).toEqual([first.id]);
});

test('a failed cloud call keeps the local result and leaves a trace of the attempt', async ({ request }) => {
  const p = await project(request, 'cloud-failed', true);
  const before = hits;
  failWith = 500;
  const clip = await postThankYou(request, p.id, { cloudConsent: 'true' });
  const a = await transcribed(request, p.id, clip.id);
  expect(hits - before).toBe(1);
  expect(a.transcript).toBe('');
  expect(a.transcription.unclear).toBe('silence');
  expect(a.transcription.backend).toBe('local');
  expect(a.transcription.cloud).toEqual({ from: 'local', reason: 'silence', error: expect.stringMatching(/openai 500/) });
  const events = await (await request.get(`${API}/api/projects/${p.id}/events`)).json();
  const fallback = events.filter((e) => e.kind === 'transcribe:fallback');
  expect(fallback).toHaveLength(1);
  expect(fallback[0].data).toEqual({ id: clip.id, from: 'local', to: 'openai', reason: 'silence', error: expect.stringMatching(/openai 500/) });
  const edm = await (await request.get(`${API}/api/projects/${p.id}/export?format=edm`)).json();
  const web = edm['@graph'].find((n) => n['@type'] === 'edm:WebResource' && n['@id'].endsWith(clip.audioUrl));
  expect(web['dcterms:provenance']).toContain('a cloud transcription was attempted and failed');
});

const PLAIN = 'I consent to my recording being stored and shared';
const consentState = (page) => page.evaluate(() => window.__glossy.consent);

test('the settings switch and the consent label follow the project', async ({ page, request }) => {
  const p = await openProject(page, request, 'cloud-switch');
  await expect(page.locator('#consentText')).toHaveText(PLAIN);
  await expect(page.locator('#cloudFallback')).not.toBeChecked();
  await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback: true } });
  await expect(page.locator('#consentText')).toContainText('external service');   // project:updated re-renders
  await expect(page.locator('#cloudFallback')).toBeChecked();
  await page.locator('#settingsPanel > summary').click();
  await page.uncheck('#cloudFallback');
  await expect.poll(async () => (await (await request.get(`${API}/api/projects/${p.id}`)).json()).cloudFallback).toBe(false);
  await expect(page.locator('#consentText')).toHaveText(PLAIN);
});

test('the page sends cloud consent only for the label that named the cloud, and asks again when the label changes', async ({ page, request }) => {
  // what each clip upload carried: Chromium does not expose a FormData body holding a blob to page.on('request'), so read it at fetch
  await page.addInitScript(() => {
    const fetch0 = window.fetch; window.__uploads = [];
    window.fetch = (url, opts) => { if (opts?.body instanceof FormData && /\/annotations$/.test(url)) window.__uploads.push(opts.body.get('cloudConsent')); return fetch0(url, opts); };
  });
  const sentCloud = () => page.evaluate(() => window.__uploads.at(-1));
  const latest = async (id) => (await listAnnotations(request, id)).at(-1);

  // project on: the label carries the clause, the page stores 'cloud' and sends the flag
  const on = await openProject(page, request, 'cloud-flag-on');
  await request.patch(`${API}/api/projects/${on.id}`, { data: { cloudFallback: true } });
  await expect(page.locator('#consentText')).toContainText('external service');
  await prepareRecording(page, 'Guest');
  expect(await consentState(page)).toEqual({ checked: true, stored: 'cloud' });
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 700);
  expect(await sentCloud()).toBe('true');
  expect((await latest(on.id)).cloudConsent).toBe(true);

  // project off: consent given again to the plain label stores '1' and sends nothing
  const off = await openProject(page, request, 'cloud-flag-off');
  await expect(page.locator('#consentText')).toHaveText(PLAIN);
  await page.uncheck('#consent');
  await page.check('#consent');
  expect(await consentState(page)).toEqual({ checked: true, stored: '1' });
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 700);
  expect(await sentCloud()).toBeNull();
  expect((await latest(off.id)).cloudConsent).toBe(false);

  // the project switches on under the page: the plain consent no longer covers it
  await request.patch(`${API}/api/projects/${off.id}`, { data: { cloudFallback: true } });
  await expect.poll(() => consentState(page)).toEqual({ checked: false, stored: '0' });
  await expect(page.locator('#consentText')).toContainText('external service');
  await expect(page.locator('#statusText')).toContainText('tick it to record');
  await page.check('#consent');
  expect(await consentState(page)).toEqual({ checked: true, stored: 'cloud' });
  await lockPointer(page);
  await aimCamera(page, [0, 1.6, 0.6], [0, 1.4, -2.9]);                // a fresh spot
  await recordWithMouse(page, 700);
  expect(await sentCloud()).toBe('true');
  expect((await latest(off.id)).cloudConsent).toBe(true);
});

test('the room list and the review page say when a clip was transcribed in the cloud, or the attempt failed', async ({ page, request }) => {
  const p = await openProject(page, request, 'cloud-badges');
  await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback: true } });
  const clip = await postThankYou(request, p.id, { cloudConsent: 'true' });
  expect((await transcribed(request, p.id, clip.id)).transcription.backend).toBe('openai');
  const row = page.locator(`#annList li[data-id="${clip.id}"]`);
  await expect(row.locator('.badge.cloud')).toHaveText('transcribed in the cloud');
  await expect(row.locator('.badge.cloud')).toHaveAttribute('title', /openai · whisper-1 · local result rejected as silence/);

  failWith = 500;
  const failed = await postThankYou(request, p.id, { cloudConsent: 'true' });
  expect((await transcribed(request, p.id, failed.id)).transcription.cloud.error).toMatch(/openai 500/);
  await expect(page.locator(`#annList li[data-id="${failed.id}"] .badge.cloud`)).toHaveText('cloud transcription failed, local text kept');

  // a clip transcribed locally carries no badge
  const local = await postThankYou(request, p.id);
  await transcribed(request, p.id, local.id);
  await expect(page.locator(`#annList li[data-id="${local.id}"]`)).toBeVisible();
  await expect(page.locator(`#annList li[data-id="${local.id}"] .badge.cloud`)).toHaveCount(0);

  await page.goto(`/review.html?project=${p.id}`);
  await expect(page.locator(`article[data-id="${clip.id}"] .head .cloud`)).toHaveText('transcribed in the cloud');
  await expect(page.locator(`article[data-id="${failed.id}"] .head .cloud`)).toHaveText('cloud transcription failed, local text kept');
  await expect(page.locator(`article[data-id="${local.id}"] .head .cloud`)).toHaveCount(0);
});

test('a visitor sees the clause and no switch', async ({ page, request }) => {
  const p = await openProject(page, request, 'cloud-visitor', '&mode=visitor');
  await request.patch(`${API}/api/projects/${p.id}`, { data: { cloudFallback: true } });
  await expect(page.locator('#consentText')).toContainText('external service');
  await expect(page.locator('#cloudFallback')).toBeHidden();
  await page.check('#consent');
  expect(await consentState(page)).toEqual({ checked: true, stored: 'cloud' });
});
