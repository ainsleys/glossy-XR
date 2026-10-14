import { expect } from '@playwright/test';

export const API = 'http://localhost:3100';

/** Create a fresh project through the API and open it in the page. Resolves once the scene is ready. */
export async function openProject(page, request, name = 'test') {
  const res = await request.post(`${API}/api/projects`, { data: { name } });
  expect(res.ok()).toBeTruthy();
  const project = await res.json();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && !/Pointer Lock/.test(m.text()) && console.log('PAGE console.error', m.text()));
  await page.goto(`/?project=${project.id}`);
  await page.waitForFunction((id) => window.__glossy?.project?.id === id, project.id);
  await expect.poll(() => page.evaluate(() => window.__glossy.status)).not.toMatch(/connecting/);
  return project;
}

/** Upload an asset file to a project (optionally with sidecars) and wait for the page to load it. */
export async function uploadAsset(page, request, projectId, file, sidecars = [], extra = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const multipart = { model: { name: path.basename(file), mimeType: 'application/octet-stream', buffer: fs.readFileSync(file) }, ...extra };
  // Playwright's multipart takes one value per field; send sidecars one at a time via the files field in separate requests is not supported, so send all in one FormData
  const fd = new FormData();
  fd.append('model', new Blob([fs.readFileSync(file)]), path.basename(file));
  for (const s of sidecars) fd.append('files', new Blob([fs.readFileSync(s)]), path.basename(s));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const res = await request.post(`${API}/api/projects/${projectId}/assets`, { multipart: fd });
  expect(res.ok(), await res.text()).toBeTruthy();
  const asset = await res.json();
  await page.waitForFunction((id) => { const e = window.__glossy.loaded.get(id); return e && (e.model || e.error); }, asset.id, { timeout: 120_000 });
  const err = await page.evaluate((id) => window.__glossy.loaded.get(id).error, asset.id);
  expect(err).toBeNull();
  return asset;
}

/** Fill the author field and tick consent so recording is allowed. */
export async function prepareRecording(page, author = 'Tester') {
  await page.fill('#author', author);
  await page.locator('#author').dispatchEvent('change');
  if (!(await page.isChecked('#consent'))) await page.check('#consent');
}

/** Click the canvas to capture the mouse. Headless Chromium refuses the Pointer Lock API, so the app's software capture kicks in. */
export async function lockPointer(page) {
  await page.mouse.click(640, 400);
  await page.waitForFunction(() => window.__glossy.captured, null, { timeout: 5000 });
}

export const camera = (page) => page.evaluate(() => window.__glossy.camera.position.toArray());
export const markerCount = (page) => page.evaluate(() => window.__glossy.markers.size);
export const status = (page) => page.evaluate(() => window.__glossy.status);

/** Hold a key for `ms` so the render loop sees it as pressed. */
export async function holdKey(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/** Place and aim the desktop camera, then refresh its world matrix so aimPoint() sees the new pose immediately. */
export async function aimCamera(page, from, at) {
  await page.evaluate(([f, a]) => { const c = window.__glossy.camera; c.position.set(...f); c.lookAt(...a); c.updateMatrixWorld(true); }, [from, at]);
}

/** Hold the mouse button to record: waits for the mic to be live before timing the hold. */
export async function recordWithMouse(page, ms = 1200) {
  const before = await markerCount(page);
  await page.mouse.move(640, 400);                       // back onto the canvas; HUD clicks (consent, author) move the pointer
  await page.mouse.down();
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/recording/);
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(before + 1);   // status flips to hover text as soon as the new marker sits under the crosshair
}

/** The project's export document. */
export const exportProject = async (request, projectId) => (await request.get(`${API}/api/projects/${projectId}/export`)).json();
export const listAnnotations = async (request, projectId) => (await request.get(`${API}/api/projects/${projectId}/annotations`)).json();
/** Aim the camera at a marker and wait until the crosshair reports it. */
export async function aimAtMarker(page, id) {
  await page.evaluate((id) => { const g = window.__glossy; g.camera.lookAt(g.markers.get(id).mesh.position); g.camera.updateMatrixWorld(true); }, id);
  await expect.poll(() => page.evaluate(() => window.__glossy.aimMarker(window.__glossy.camera))).toBe(id);
}
