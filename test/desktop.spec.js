// Desktop path: render, walk with collision, record an annotation through the
// fake microphone, play it back, delete it, and confirm persistence over the API.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { API, openProject, prepareRecording, lockPointer, camera, markerCount, status, holdKey, aimCamera, recordWithMouse } from './helpers.js';

test('renders the default room with a working WebGL context', async ({ page, request }) => {
  await openProject(page, request, 'render');
  const info = await page.evaluate(() => {
    const g = window.__glossy, gl = g.renderer.getContext();
    return { renderer: gl.getParameter(gl.RENDERER), room: g.room.visible, calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
  });
  expect(info.room).toBe(true);
  expect(info.calls).toBeGreaterThan(0);
  expect(info.tris).toBeGreaterThan(0);
  const shot = await page.screenshot({ path: 'test-results/default-room.png' });
  expect(shot.length).toBeGreaterThan(10_000);          // not a blank frame
});

test('walks forward and is stopped by the room wall', async ({ page, request }) => {
  await openProject(page, request, 'walk');
  await lockPointer(page);
  await expect(page.locator('#crosshair')).toBeVisible();
  // face -Z (toward the table) so W walks into the far wall at z = -3
  await page.evaluate(() => { const c = window.__glossy.camera; c.position.set(0, 1.6, 2); c.lookAt(0, 1.6, -10); });
  const start = await camera(page);
  await holdKey(page, 'KeyW', 2500);                    // 1.8 m/s * 2.5 s = 4.5 m requested; wall is 5 m away minus body radius
  const mid = await camera(page);
  expect(mid[2]).toBeLessThan(start[2] - 2);            // actually moved
  expect(mid[1]).toBeCloseTo(1.6, 1);                   // eye height held by floor following
  await holdKey(page, 'KeyW', 3000);                    // keep pushing: must stop at the wall, not pass through
  const end = await camera(page);
  expect(end[2]).toBeGreaterThan(-3 + 0.3);             // BODY_RADIUS keeps us inside
  expect(end[2]).toBeLessThan(-2.2);
  await page.screenshot({ path: 'test-results/walk-at-wall.png' });
});

test('records, saves, plays back, and deletes an annotation', async ({ page, request }) => {
  const project = await openProject(page, request, 'annotate');
  await prepareRecording(page, 'Tester');
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);   // at the table top, beside the pot
  const aim = await page.evaluate(() => { const a = window.__glossy.aimPoint(window.__glossy.camera); return { p: a.point.toArray(), id: a.objectId }; });
  expect(aim.id).toBe('table');

  await recordWithMouse(page, 2600);                   // long enough to catch a full sentence from the looping fake mic
  expect(await markerCount(page)).toBe(1);

  const list = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(list).toHaveLength(1);
  const a = list[0];
  expect(a.author).toBe('Tester');
  expect(a.anchor.objectId).toBe('table');
  expect(a.durationMs).toBeGreaterThanOrEqual(2400);
  expect(a.consent).toBe(true);
  const audio = await request.get(`${API}${a.audioUrl}`);
  expect(audio.ok()).toBeTruthy();
  expect((await audio.body()).length).toBeGreaterThan(2000);     // ~1.2 s of opus from the fake mic, not an empty container
  expect(fs.existsSync(`.test-data/audio/${a.id}.webm`)).toBe(true);

  // transcription runs off the request path and arrives over the socket
  expect(a.transcription.status).toBe('pending');
  await expect.poll(async () => (await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json())[0].transcription.status, { timeout: 120_000 }).toBe('done');
  const done = (await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json())[0];
  expect(done.transcription.backend).toBe('local');
  expect(Array.isArray(done.transcription.words)).toBe(true);
  if (process.env.GLOSSY_TEST_SPEECH) {
    expect(done.transcript).toMatch(/lamp|table|broken/i);
    expect(done.transcription.words.length).toBeGreaterThan(2);
    expect(done.transcription.words[0].s).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#annList li .text')).toHaveText(/lamp|table|broken/i);
  } else {
    await expect(page.locator('#annList li .text')).not.toHaveText(/transcribing/);
  }

  // hover feedback + Space plays
  await page.evaluate(() => { const g = window.__glossy; g.camera.lookAt([...g.markers.values()][0].mesh.position); g.camera.updateMatrixWorld(true); });
  await expect.poll(() => page.evaluate(() => window.__glossy.aimMarker(window.__glossy.camera))).toBe(a.id);
  await expect(page.locator('#crosshair')).toHaveClass(/hover/);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.__glossy.playingId), { timeout: 10_000 }).toBe(a.id);
  await expect(page.locator('#annList li.playing')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/annotation-playing.png' });

  // Delete twice removes it everywhere
  await page.keyboard.press('Delete');
  await expect.poll(() => status(page)).toMatch(/press Delete again/);
  await page.keyboard.press('Delete');
  await expect.poll(() => markerCount(page)).toBe(0);
  const after = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(after).toHaveLength(0);
  expect(fs.existsSync(`.test-data/audio/${a.id}.webm`)).toBe(false);
});

test('re-transcribe endpoint and deleting while a job is queued', async ({ page, request }) => {
  const project = await openProject(page, request, 'retranscribe');
  await prepareRecording(page);
  await lockPointer(page);
  await recordWithMouse(page, 800);
  const [a] = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  await expect.poll(async () => (await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json())[0].transcription.status, { timeout: 120_000 }).toBe('done');
  const re = await request.post(`${API}/api/projects/${project.id}/annotations/${a.id}/transcribe`);
  expect(re.status()).toBe(202);
  expect((await re.json()).transcription.status).toBe('pending');
  // the old text stays on screen while the job re-runs (it takes well under a second), then the fresh result lands
  await expect.poll(async () => (await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json())[0].transcription.status, { timeout: 120_000 }).toBe('done');
  if (process.env.GLOSSY_TEST_SPEECH) await expect(page.locator('#annList li .text')).toHaveText(/lamp|table|broken/i);
  // queue another and delete it before the job finishes: no crash, no resurrected row
  await aimCamera(page, [0, 1.6, 0.6], [-2, 0.4, 0.5]);   // look at the chest, away from the marker we just made (a click on it would play, not record)
  await recordWithMouse(page, 600);
  const list = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  const fresh = list.find((r) => r.id !== a.id);
  expect((await request.delete(`${API}/api/projects/${project.id}/annotations/${fresh.id}`)).status()).toBe(204);
  await page.waitForTimeout(3000);
  const after = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(after.map((r) => r.id)).toEqual([a.id]);
  expect((await (await request.get(`${API}/api/health`)).json()).transcription.backend).toBe('local');
});

test('a click released before the microphone is ready does not leave the recorder stuck', async ({ page, request }) => {
  await openProject(page, request, 'cold-mic');
  await prepareRecording(page);
  await lockPointer(page);
  await page.mouse.down(); await page.mouse.up();                       // instant click on a cold mic
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/too short|^saved/);
  expect(await page.evaluate(() => window.__glossy.recorder.isRecording)).toBe(false);
  await recordWithMouse(page, 600);                                      // and a normal hold still works afterwards
  expect(await markerCount(page)).toBe(1);
});

test('a second client sees the annotation live', async ({ page, request, browser }) => {
  const project = await openProject(page, request, 'sync');
  const other = await browser.newPage();
  await other.goto(`/?project=${project.id}`);
  await other.waitForFunction((id) => window.__glossy?.project?.id === id, project.id);
  await prepareRecording(page);
  await lockPointer(page);
  await recordWithMouse(page, 800);
  await expect.poll(() => markerCount(other)).toBe(1);
  await expect(other.locator('#annList li')).toHaveCount(1);
  await other.close();
});
