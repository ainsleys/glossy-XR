// Desktop path: render, walk with collision, record an annotation through the
// fake microphone, play it back, delete it, and confirm persistence over the API.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { API, openProject, prepareRecording, lockPointer, camera, markerCount, status, holdKey, aimCamera, recordWithMouse, exportProject, listAnnotations, aimAtMarker } from './helpers.js';

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
  expect(a.mode).toBe('walk');
  expect(a.parent).toBeNull();
  expect(a.period).toBeNull();
  // the author's head pose was sampled over the clip, starting where the camera stood
  expect(a.pose.length).toBeGreaterThanOrEqual(20);          // 10 Hz over 2.6 s, plus the first and last samples
  expect(a.pose[0].t).toBe(0);
  expect(a.pose.at(-1).t).toBeGreaterThanOrEqual(2400);
  expect(a.pose[0].p[0]).toBeCloseTo(0.4, 1);
  expect(a.pose[0].p[1]).toBeCloseTo(1.6, 1);
  expect(a.pose[0].q).toHaveLength(4);
  expect(a.poseSource).toBe('desktop');
  // the mark was placed at release, before the clip was encoded or uploaded
  const placement = await page.evaluate(() => window.__glossy.lastPlacementMs);
  console.log('placement latency ms', placement);
  expect(placement).toBeLessThan(100);
  expect(await page.evaluate(() => window.__glossy.pending)).toBe(0);   // provisional marker replaced by the saved one
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

  // the export carries attribution, timestamp, spatial anchor and temporal reference on every contribution
  const exp = await exportProject(request, project.id);
  expect(exp.schema).toBe('glossy-xr/project/0.4');
  expect(exp.contributions).toHaveLength(1);
  const c = exp.contributions[0];
  expect(c).toMatchObject({ id: a.id, attribution: 'Tester', timestamp: a.createdAt, anchor: a.anchor, period: null, mode: 'walk', parent: null });
  expect(c.words.length).toBe(done.transcription.words.length);
  expect(c.pose.length).toBe(a.pose.length);

  // Delete twice removes it everywhere: row, audio file, export
  await page.keyboard.press('Delete');
  await expect.poll(() => status(page)).toMatch(/press Delete again/);
  await page.keyboard.press('Delete');
  await expect.poll(() => markerCount(page)).toBe(0);
  const after = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(after).toHaveLength(0);
  expect(fs.existsSync(`.test-data/audio/${a.id}.webm`)).toBe(false);
  expect((await exportProject(request, project.id)).contributions).toHaveLength(0);
});

test('a reply is a clip anchored to another clip', async ({ page, request, browser }) => {
  const project = await openProject(page, request, 'reply');
  const other = await browser.newPage();                    // a second client watches the counts
  await other.goto(`/?project=${project.id}`);
  await other.waitForFunction((id) => window.__glossy?.project?.id === id, project.id);
  await prepareRecording(page, 'Author');
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 700);
  const [first] = await listAnnotations(request, project.id);
  // hold R while aiming at the marker: records a reply instead of playing or placing
  await page.fill('#author', 'Visitor'); await page.locator('#author').dispatchEvent('change');
  await page.locator('#author').blur();                     // keys typed into the HUD never reach the scene
  await page.mouse.move(640, 400);
  await aimAtMarker(page, first.id);
  await page.keyboard.down('KeyR');
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/recording a reply/);
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyR');
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(2);
  const list = await listAnnotations(request, project.id);
  const reply = list.find((r) => r.id !== first.id);
  expect(reply.parent).toBe(first.id);
  expect(reply.author).toBe('Visitor');
  expect(reply.anchor).toEqual(first.anchor);                // a reply shares its parent's anchor
  expect(list.find((r) => r.id === first.id).replies).toBe(1);
  await expect(page.locator('#annList li.reply')).toHaveCount(1);
  await expect(page.locator('#annList .badge')).toHaveText(/1/);
  await expect(other.locator('#annList .badge')).toHaveText(/1/);           // the count reached the other client too
  await expect(other.locator('#annList li.reply')).toHaveCount(1);
  // a reply to a missing parent is refused
  const clip = { audio: { name: 'c.webm', mimeType: 'audio/webm', buffer: Buffer.from('x') }, x: '0', y: '0', z: '0', author: 'x', consent: 'true' };
  const bad = await request.post(`${API}/api/projects/${project.id}/annotations`, { multipart: { ...clip, parent: 'nope' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/parent/);
  // a reply to a reply attaches to the original: one level deep
  const nested = await (await request.post(`${API}/api/projects/${project.id}/annotations`, { multipart: { ...clip, parent: reply.id } })).json();
  expect(nested.parent).toBe(first.id);
  await expect(page.locator('#annList .badge')).toHaveText(/2/);
  await expect(page.locator('#annList li.reply')).toHaveCount(2);
  // deleting a reply moves the count down everywhere
  expect((await request.delete(`${API}/api/projects/${project.id}/annotations/${nested.id}`)).status()).toBe(204);
  await expect(page.locator('#annList .badge')).toHaveText(/1/);
  await expect(other.locator('#annList .badge')).toHaveText(/1/);
  // malformed pose and a bad language code are refused; a region-tagged project language is refused
  expect((await request.post(`${API}/api/projects/${project.id}/annotations`, { multipart: { ...clip, pose: '[{"t":0,"p":[1,2],"q":[0,0,0,1]}]' } })).status()).toBe(400);
  expect((await request.patch(`${API}/api/projects/${project.id}`, { data: { language: 'tr-TR' } })).status()).toBe(400);
  // erasing the parent keeps the reply, detached as a root at its own anchor
  expect((await request.delete(`${API}/api/projects/${project.id}/annotations/${first.id}`)).status()).toBe(204);
  await expect.poll(() => markerCount(page)).toBe(1);
  const [left] = await listAnnotations(request, project.id);
  expect(left.id).toBe(reply.id);
  expect(left.parent).toBeNull();
  await expect.poll(() => page.evaluate(() => { const m = [...window.__glossy.markers.values()][0]; return [m.record.parent, m.mesh.userData.reply, m.mesh.position.y]; })).toEqual([null, false, first.anchor.y]);
  await expect(page.locator('#annList li.reply')).toHaveCount(0);
  await expect(other.locator('#annList li.reply')).toHaveCount(0);
  // a layer change from the API recolours the marker on an open client
  await request.patch(`${API}/api/projects/${project.id}/annotations/${reply.id}`, { data: { layer: 'final' } });
  await expect.poll(() => page.evaluate(() => [...window.__glossy.markers.values()][0].record.layer)).toBe('final');
  await other.close();
});

test('interview mode records each clip as the answer to the current question', async ({ page, request }) => {
  const project = await openProject(page, request, 'interview');
  const script = { questions: [{ id: 'eat', text: 'Where did the family eat in summer?' }, { text: 'What was kept in the cool room?' }] };
  const patched = await (await request.patch(`${API}/api/projects/${project.id}`, { data: { script, language: 'en' } })).json();
  expect(patched.script.questions.map((q) => q.id)).toEqual(['eat', 'q2']);
  expect(patched.language).toBe('en');
  await expect.poll(() => page.evaluate(() => window.__glossy.project.script?.questions?.length)).toBe(2);   // project:updated reached the page
  await expect(page.locator('#language')).toHaveValue('en');
  await page.check('#interview');
  await expect(page.locator('#question')).toHaveText(/1\/2 · Where did the family eat/);
  await prepareRecording(page, 'Guest');
  await lockPointer(page);
  await aimCamera(page, [0, 1.6, 0.6], [-2, 0.4, 0.5]);              // the chest
  await recordWithMouse(page, 700);
  await expect(page.locator('#question')).toHaveText(/2\/2 · What was kept/);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);          // the table: a fresh spot, not the marker just made
  await recordWithMouse(page, 700);
  await expect(page.locator('#question')).toHaveText(/all questions answered/);
  const list = await listAnnotations(request, project.id);
  expect(list.map((r) => [r.mode, r.prompt])).toEqual([
    ['interview', 'Where did the family eat in summer?'],
    ['interview', 'What was kept in the cool room?'],
  ]);
  await expect(page.locator('#annList .prompt')).toHaveCount(2);
  // the per-project language reaches the transcriber
  await expect.poll(async () => (await listAnnotations(request, project.id))[0].transcription.status, { timeout: 120_000 }).toBe('done');
  const done = (await listAnnotations(request, project.id))[0];
  expect(done.transcription.language).toBe('en');
  expect(done.transcription.detected).toBe(false);
  // off again: the next clip is a plain walk-mode clip
  await page.uncheck('#interview');
  await aimCamera(page, [0, 1.6, 0.6], [0, 1.4, -2.9]);               // the far wall
  await recordWithMouse(page, 600);
  expect((await listAnnotations(request, project.id)).at(-1).mode).toBe('walk');
});

test('a reviewer can set the temporal reference after the fact', async ({ page, request }) => {
  const project = await openProject(page, request, 'period');
  await prepareRecording(page);
  await lockPointer(page);
  await recordWithMouse(page, 600);
  const [a] = await listAnnotations(request, project.id);
  const res = await request.patch(`${API}/api/projects/${project.id}/annotations/${a.id}`, { data: { period: { from: '1950', to: '1965', label: 'harvest years' } } });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).period).toEqual({ from: '1950', to: '1965', label: 'harvest years' });
  await expect(page.locator('#annList .period')).toHaveText('harvest years');     // annotation:updated reached the page
  expect((await exportProject(request, project.id)).contributions[0].period).toEqual({ from: '1950', to: '1965', label: 'harvest years' });
  const cleared = await request.patch(`${API}/api/projects/${project.id}/annotations/${a.id}`, { data: { period: null } });
  expect((await cleared.json()).period).toBeNull();
  const bad = await request.patch(`${API}/api/projects/${project.id}/annotations/${a.id}`, { data: { period: 'not an object' } });
  expect(bad.status()).toBe(400);
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

test('approach previews a clip instead of playing it, autoplay is opt-in, the list erases on the second click', async ({ page, request }) => {
  const project = await openProject(page, request, 'approach');
  await prepareRecording(page, 'Tester');
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 1500);
  const [a] = await listAnnotations(request, project.id);
  // the commit is announced and held, even though the new marker sits under the crosshair
  await expect.poll(() => status(page)).toMatch(/^saved/);
  expect(await page.evaluate(() => window.__glossy.playingId)).toBeNull();

  // stand 2.5 m from the marker looking away: not near, nothing said
  const at = async (dy, dz, look) => page.evaluate(([dy, dz, look]) => {
    const g = window.__glossy, m = [...g.markers.values()][0].mesh.position;
    g.camera.position.set(m.x, m.y + dy, m.z + dz); g.camera.lookAt(m.x, m.y + dy, m.z + dz + look); g.camera.updateMatrixWorld(true);
  }, [dy, dz, look]);
  await at(0.8, 2.5, 5);
  await expect.poll(() => page.evaluate(() => window.__glossy.nearId)).toBeNull();
  await expect.poll(() => status(page), { timeout: 4000 }).toBe('');
  // walk within a metre, still looking away: previewed and lit, not played
  await at(0.6, 0.7, 5);
  await expect.poll(() => page.evaluate(() => window.__glossy.nearId)).toBe(a.id);
  await expect.poll(() => status(page)).toMatch(/^near: Tester · today · 1\.\ds.*click it to play$/);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__glossy.playingId)).toBeNull();
  expect(await page.evaluate(() => [...window.__glossy.markers.values()][0].mesh.material.emissiveIntensity)).toBeGreaterThan(0.5);
  // autoplay on: the same approach plays the clip
  await page.check('#autoplay');
  await expect.poll(() => page.evaluate(() => window.__glossy.playingId), { timeout: 10_000 }).toBe(a.id);
  await page.uncheck('#autoplay');

  // the list's ✕ asks twice: the first click arms it, the second erases
  await page.click('#annList li .del');
  await expect(page.locator('#annList li .del')).toHaveText('erase?');
  await expect(page.locator('#annList li .del')).toHaveClass(/armed/);
  expect(await markerCount(page)).toBe(1);
  await page.click('#annList li .del');
  await expect.poll(() => markerCount(page)).toBe(0);
  expect(await listAnnotations(request, project.id)).toHaveLength(0);
});

test('an armed erase in the list lapses after a pause', async ({ page, request }) => {
  const project = await openProject(page, request, 'arm-lapse');
  await prepareRecording(page, 'Tester');
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 1200);
  await page.click('#annList li .del');
  await expect(page.locator('#annList li .del')).toHaveText('erase?');
  await expect(page.locator('#annList li .del')).toHaveText('✕', { timeout: 5000 });   // the arm lapses on its own
  await page.click('#annList li .del');                                                   // so this is a first click again
  await page.waitForTimeout(300);
  expect(await markerCount(page)).toBe(1);
  expect(await listAnnotations(request, project.id)).toHaveLength(1);
});

test('visitor mode hides the operator controls, asks the script without a toggle, and cannot erase', async ({ page, request }) => {
  const project = await openProject(page, request, 'visitor', '&mode=visitor');
  await request.patch(`${API}/api/projects/${project.id}`, { data: { script: { questions: [{ text: 'Where did the family eat in summer?' }, { text: 'What grew in the orchard?' }] } } });
  await expect(page.locator('#question')).toHaveText(/1\/2 · Where did the family eat/);   // arrives over the socket, no checkbox needed
  for (const sel of ['#project', '#newProject', '#layer', '#language', '#assetPanel', '#scriptText', '#saveScript', '#interview', '#help', '#walk', '#autoplay']) await expect(page.locator(sel)).toBeHidden();
  for (const sel of ['#author', '#consent', '#timeAll', '#statusText', '#visitorHelp', '#askQ']) await expect(page.locator(sel)).toBeVisible();
  expect(page.url()).toContain('mode=visitor');

  await prepareRecording(page, 'Guest');
  await lockPointer(page);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await recordWithMouse(page, 1200);
  const [a] = await listAnnotations(request, project.id);
  expect(a.mode).toBe('interview');
  expect(a.prompt).toBe('Where did the family eat in summer?');
  await expect(page.locator('#question')).toHaveText(/2\/2 · What grew/);

  // nothing erasable from this page: no ✕ in the list, Delete at the crosshair is refused
  await expect(page.locator('#annList li')).toHaveCount(1);
  await expect(page.locator('#annList li .del')).toBeHidden();
  await page.evaluate(() => document.activeElement?.blur());
  await aimAtMarker(page, a.id);
  await page.keyboard.press('Delete');
  await page.keyboard.press('Delete');
  await expect.poll(() => status(page)).toMatch(/desk/);
  await page.waitForTimeout(300);
  expect(await markerCount(page)).toBe(1);
  expect(await listAnnotations(request, project.id)).toHaveLength(1);
});

test('recording shows a timer and a microphone level, and the selector count keeps up', async ({ page, request }) => {
  const project = await openProject(page, request, 'level');
  await prepareRecording(page, 'Tester');
  await lockPointer(page);
  await expect(page.locator('#hint')).toHaveText(/hold the mouse button: record here/);
  await aimCamera(page, [0.4, 1.6, 0.6], [0.4, 0.79, -1.2]);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/recording… \(default\) 0s/);
  await expect(page.locator('#hint')).toHaveText(/release to save/);
  await expect(page.locator('#level')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__glossy.level), { timeout: 5000 }).toBeGreaterThan(0.05);   // the fake microphone is not silent
  await expect.poll(() => status(page), { timeout: 5000 }).toMatch(/recording… \(default\) [12]s/);
  await page.mouse.up();
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(1);
  await expect(page.locator('#level')).toBeHidden();
  await expect(page.locator('#project option:checked')).toHaveText(/^level \(1\)/);   // not the stale server count
  await expect(page.locator('#hint')).toHaveText(/click: play · hold R: reply · Delete ×2: erase/);   // the new marker is under the crosshair
  // full markers carry a ring; the distance limit follows the room
  expect(await page.evaluate(() => { const m = [...window.__glossy.markers.values()][0]; return m.mesh.userData.ring.visible; })).toBe(true);
  expect(await page.evaluate(() => window.__glossy.fullDistance)).toBeCloseTo(4.5, 1);
  expect(await listAnnotations(request, project.id)).toHaveLength(1);
});
