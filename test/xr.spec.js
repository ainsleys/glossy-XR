// Headset path without a headset: IWER (Meta's Immersive Web Emulation Runtime)
// installs a fake navigator.xr before the app boots, we enter VR through the
// real VRButton, aim the emulated right controller, and record with its trigger.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { API, openProject, prepareRecording, status, markerCount } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: 'node_modules/iwer/build/iwer.js' });
  await page.addInitScript(() => {
    const dev = new IWER.XRDevice(IWER.metaQuest3);
    dev.installRuntime({ forceInstall: true });   // headless Chromium has a native navigator.xr that reports no device
    dev.position.set(0, 1.6, 0.6);                     // stand near the table
    window.__xr = dev;
  });
});

test('enters VR through VRButton and records with the controller trigger', async ({ page, request }) => {
  const project = await openProject(page, request, 'xr');
  await prepareRecording(page, 'HeadsetTester');
  await request.patch(`${API}/api/projects/${project.id}`, { data: { script: { questions: [{ text: 'Where did the family eat in summer?' }] } } });
  await expect(page.locator('#question')).toHaveText(/1 question/);
  await page.check('#interview');
  const btn = page.locator('#VRButton');
  await expect(btn).toHaveText(/ENTER VR/i);
  await btn.click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect(btn).toHaveText(/EXIT VR/i);
  // the in-headset panel carries the question
  await expect.poll(() => page.evaluate(() => window.__glossy.xrPanel.text)).toMatch(/1\/1 · Where did the family eat in summer\?/);
  expect(await page.evaluate(() => window.__glossy.xrPanel.mesh.visible)).toBe(true);

  // point the right controller down at the table and pull the trigger
  await page.evaluate(() => {
    const c = window.__xr.controllers.right;
    c.position.set(0.2, 1.3, 0.3);
    c.quaternion.set(-0.3826834, 0, 0, 0.9238795);     // pitch -45°: aim at the table top
  });
  await page.waitForTimeout(300);                       // let a frame deliver the pose
  const aim = await page.evaluate(() => {
    const g = window.__glossy, ctrl = g.renderer.xr.getController(0);
    const a = g.aimPoint(ctrl); return { id: a.objectId, p: a.point.toArray(), ctrl: ctrl.position.toArray() };
  });
  expect(aim.id).toBeDefined();
  await page.evaluate(() => window.__xr.controllers.right.updateButtonValue('trigger', 1));
  await expect.poll(() => status(page)).toMatch(/recording/);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__xr.controllers.right.updateButtonValue('trigger', 0));
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(1);
  // "saved" is held for two seconds even though the new marker sits under the controller ray
  await expect.poll(() => status(page)).toMatch(/^saved/);
  await expect.poll(() => page.evaluate(() => window.__glossy.xrPanel.text)).toMatch(/all questions answered[\s\S]*saved/);
  const list = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].author).toBe('HeadsetTester');
  expect(list[0].prompt).toBe('Where did the family eat in summer?');
  expect(list[0].durationMs).toBeGreaterThanOrEqual(900);
  expect(list[0].poseSource).toBe('xr');                 // headset pose, sampled over the clip
  expect(list[0].pose.length).toBeGreaterThanOrEqual(8);
  expect(list[0].pose[0].p[1]).toBeCloseTo(1.6, 0);       // emulated Quest at eye height
  await page.screenshot({ path: 'test-results/xr-presenting.png' });

  // squeeze cycles the layer
  const before = await page.inputValue('#layer');
  await page.evaluate(() => { const c = window.__xr.controllers.right; c.updateButtonValue('squeeze', 1); });
  await expect.poll(() => page.inputValue('#layer')).not.toBe(before);
  await page.evaluate(() => window.__xr.controllers.right.updateButtonValue('squeeze', 0));
});

test('a visitor in the headset sees the question and squeeze reads it aloud', async ({ page, request }) => {
  const project = await openProject(page, request, 'xr-visitor', '&mode=visitor');
  await request.patch(`${API}/api/projects/${project.id}`, { data: { script: { questions: [{ text: 'Where did the family eat in summer?' }, { text: 'What grew in the orchard?' }] } } });
  await expect(page.locator('#question')).toHaveText(/1\/2 · Where did the family eat/);   // asked without a toggle
  await prepareRecording(page, 'Guest');
  await page.locator('#VRButton').click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__glossy.xrPanel.text)).toMatch(/1\/2 · Where did the family eat in summer\?[\s\S]*squeeze: hear the question/);
  await page.evaluate(() => window.__xr.controllers.right.updateButtonValue('squeeze', 1));
  await expect.poll(() => page.evaluate(() => window.__glossy.lastAsked)).toBe('Where did the family eat in summer?');
  await page.evaluate(() => window.__xr.controllers.right.updateButtonValue('squeeze', 0));
  expect(await page.inputValue('#layer')).toBe('default');   // squeeze did not cycle the layer
});

test('with hands tracked, speaking starts a clip, the gesture is stored and replays as ghost hands', async ({ page, request }) => {
  const project = await openProject(page, request, 'xr-hands');
  await prepareRecording(page, 'HandTester');
  await page.evaluate(() => { window.__xr.primaryInputMode = 'hand'; document.querySelector('#recordMode').value = 'voice'; });   // hands, no controllers; this test is about speaking to start
  const btn = page.locator('#VRButton');
  await expect(btn).toHaveText(/ENTER VR/i);
  await btn.click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__glossy.handsPresent), { timeout: 10_000 }).toBe(true);
  // the fake microphone is already speaking: no pinch, no trigger, the clip starts on its own, anchored where the headset looks
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/recording/);
  // meanwhile the left hand stirs: a circle 15 cm across in front of the body
  // the tracker loses the left hand for 400 ms in the middle of the stir, then finds it again
  await page.evaluate(() => new Promise((done) => {
    const h = window.__xr.hands.left, t0 = performance.now();
    let dropped = false;
    const id = setInterval(() => {
      const dt = performance.now() - t0, a = dt / 400;
      h.position.set(-0.15 + 0.15 * Math.cos(a), 1.15, 0.25 + 0.15 * Math.sin(a));
      if (dt > 700 && dt < 1100 && !dropped) { dropped = true; h.connected = false; }
      if (dt >= 1100 && dropped) { dropped = false; h.connected = true; }
      if (dt > 1900) { clearInterval(id); done(); }
    }, 50);
  }));
  // the pause that would end it; the looping fake voice never pauses, so the clip is ended here and the status is read
  // in the same breath: with speech continuing, voice start may open the next clip a moment after the save
  const savedStatus = await page.evaluate(async () => { await window.__glossy.endRecording(); return window.__glossy.status; });
  expect(savedStatus).toMatch(/^saved .* with gesture/);
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(1);
  const [a] = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  fs.writeFileSync('test-results/xr-hands-trace.json', JSON.stringify(a.hands));   // the emulated trace, for looking at when the geometry below disagrees
  expect(a.poseSource).toBe('xr');
  expect(a.hands.joints).toHaveLength(25);
  expect(a.hands.frames.length).toBeGreaterThanOrEqual(15);
  const left = a.hands.frames.map((f) => f.l).filter(Boolean);
  expect(left.length).toBeGreaterThanOrEqual(15);
  expect(left[0]).toHaveLength(75);
  const xs = left.map((l) => l[0]);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.1);   // the wrist moved: the stir is in the record
  expect(Math.abs(left.at(-1)[1] - 1.15)).toBeLessThan(0.15);      // and it is in scene metres at hand height (the first frames predate the stir)
  // the 400 ms the tracker lost the hand came back reconstructed and flagged, so no gap remains inside the stir
  expect(a.hands.filled.l).toBeGreaterThan(0);
  const inferred = a.hands.frames.filter((f) => f.lf);
  expect(inferred.length).toBe(a.hands.filled.l);
  // on the circle the tracked wrist drew, not across it: fit a circle (Kåsa least squares) to the tracked stir frames and compare radii
  const stirFrames = a.hands.frames.filter((f) => f.l && !f.lf && Math.abs(f.l[1] - 1.15) < 0.15);
  const pts = stirFrames.map((f) => [f.l[0], f.l[2]]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, mz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, z] of pts) { const u = x - mx, v = z - mz; suu += u * u; svv += v * v; suv += u * v; suuu += u ** 3; svvv += v ** 3; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv;
  const uc = (0.5 * ((suuu + suvv) * svv - (svvv + svuu) * suv)) / det, vc = (0.5 * ((svvv + svuu) * suu - (suuu + suvv) * suv)) / det;
  const cx = mx + uc, cz = mz + vc, rTracked = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
  expect(Math.abs(rTracked - 0.15)).toBeLessThan(0.03);            // the fit found the 15 cm circle the emulated hand drew
  console.log('stir centroid', cx.toFixed(3), cz.toFixed(3), 'radius', rTracked.toFixed(3), 'inferred', inferred.map((f) => [f.t, Math.hypot(f.l[0] - cx, f.l[2] - cz).toFixed(3)].join('@')).join(' '));
  for (const f of inferred) expect(Math.abs(Math.hypot(f.l[0] - cx, f.l[2] - cz) - rTracked)).toBeLessThan(0.03);
  const firstStir = a.hands.frames.findIndex((f) => f.l && Math.abs(f.l[1] - 1.15) < 0.15);
  expect(a.hands.frames.slice(firstStir).filter((f) => !f.l)).toHaveLength(0);
  // the export carries it, and the EDM record says a gesture was made
  const exp = await (await request.get(`${API}/api/projects/${project.id}/export`)).json();
  expect(exp.contributions[0].hands.frames.length).toBe(a.hands.frames.length);
  const edm = await (await request.get(`${API}/api/projects/${project.id}/export?format=edm`)).json();
  expect(edm['@graph'].find((n) => n['@id'].endsWith(a.id))['glossy:gesture']).toBe(true);
  // playback draws the ghost hands and takes them down when the clip ends
  await expect.poll(() => page.evaluate((id) => !!window.__glossy.markers.get(id)?.sound.buffer, a.id), { timeout: 10_000 }).toBe(true);
  await page.evaluate((id) => window.__glossy.play(id), a.id);
  await expect.poll(() => page.evaluate(() => window.__glossy.ghost.visible)).toBe(true);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/xr-ghost-hands.png' });
  await expect.poll(() => page.evaluate(() => window.__glossy.ghost.visible), { timeout: 10_000 }).toBe(false);
  await expect(page.locator('#annList li .badge', { hasText: '✋' })).toHaveCount(1);

  // the session log saw it: the hands connect, the clip start by voice, per-second tracking coverage, the playback with ghost hands
  await page.evaluate(() => window.__glossy.log.flush());
  const events = await expect.poll(async () => (await request.get(`${API}/api/projects/${project.id}/events`)).json(), { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'record:saved' })])).then(async () => (await request.get(`${API}/api/projects/${project.id}/events`)).json());
  expect(events.filter((e) => e.kind === 'input:connected' && e.data.kind === 'hand').length).toBeGreaterThanOrEqual(1);
  expect(events.find((e) => e.kind === 'record:start').data.source).toBe('voice');
  const savedEv = events.find((e) => e.kind === 'record:saved');
  expect(savedEv.data.hands.frames).toBe(a.hands.frames.length);
  expect(savedEv.data.hands.filled.l).toBe(a.hands.filled.l);
  const stats = events.filter((e) => e.kind === 'stats' && e.data.presenting);
  expect(stats.length).toBeGreaterThan(2);
  expect(stats.some((e) => e.data.hands.l.of > 0 && e.data.hands.l.seen > 0)).toBe(true);
  expect(events.find((e) => e.kind === 'play:start').data.hands).toBe(true);
  const sessions = await (await request.get(`${API}/api/projects/${project.id}/sessions`)).json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].events).toBe(events.length);
});

// Meta's labels on the LEFT hand: along the finger to the tip = swipe-right (our push), to the knuckle = swipe-left (brake),
// The test speaks the labels the headset sends. Speed is the left thumb, heading the right thumb, both
// along the finger: on the right hand toward the knuckle (swipe-right) turns left, toward the tip turns right.
const L = { push: 'swipe-right', brake: 'swipe-left', turnLeft: 'swipe-right', turnRight: 'swipe-left' };
test('a thumb swiped along the index finger steps and turns the person, on the chosen hand only', async ({ page, request }) => {
  await openProject(page, request, 'xr-thumb');
  await prepareRecording(page, 'Walker');
  await page.evaluate(() => { window.__xr.primaryInputMode = 'hand'; document.querySelector('#voiceStart').checked = false; document.querySelector('#locoMode').value = 'steps'; document.querySelector('#locoHand').value = 'both'; });   // hands, no voice clips during the walk, one step per swipe, left hand only
  await page.locator('#VRButton').click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__glossy.handsPresent), { timeout: 10_000 }).toBe(true);
  const pose = () => page.evaluate(() => { const g = window.__glossy, r = g.rig; return { x: +r.position.x.toFixed(3), y: +r.position.y.toFixed(3), z: +r.position.z.toFixed(3), rot: +((r.rotation.y * 180) / Math.PI).toFixed(1) }; });
  const head = () => page.evaluate(() => { const c = window.__glossy.renderer.xr.getCamera(); const p = new (c.position.constructor)(); c.getWorldPosition(p); const d = new (c.position.constructor)(); c.getWorldDirection(d); return { x: p.x, z: p.z, dx: d.x, dz: d.z }; });
  const p0 = await pose(), h0 = await head();
  // the emulated hands report no microgestures; the room exposes the handler the poller calls
  await page.evaluate((g) => window.__glossy.microgesture('left', g), L.push);
  await page.waitForTimeout(400);
  const p1 = await pose();
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  expect(moved).toBeGreaterThan(0.9); expect(moved).toBeLessThan(1.05);                       // one metre, after the glide
  const fwd = Math.hypot(h0.dx, h0.dz);
  expect(((p1.x - p0.x) * h0.dx + (p1.z - p0.z) * h0.dz) / (moved * fwd)).toBeGreaterThan(0.99);   // along the gaze
  expect(p1.rot).toBe(p0.rot);
  // a left swipe turns left by 30°, pivoting where the head is: the head stays put
  const hBefore = await head();
  await page.evaluate((g) => window.__glossy.microgesture('right', g), L.turnLeft);
  await page.waitForTimeout(400);
  const p2 = await pose(), hAfter = await head();
  expect(p2.rot - p1.rot).toBeCloseTo(30, 0);
  expect(Math.hypot(hAfter.x - hBefore.x, hAfter.z - hBefore.z)).toBeLessThan(0.02);
  // a back swipe returns along the new gaze; the right hand does nothing while the setting says left
  await page.evaluate((g) => window.__glossy.microgesture('left', g), L.brake);
  await page.waitForTimeout(400);
  const p3 = await pose(), h3 = await head();
  const back = Math.hypot(p3.x - p2.x, p3.z - p2.z);
  expect(back).toBeGreaterThan(0.9);
  expect(((p3.x - p2.x) * h3.dx + (p3.z - p2.z) * h3.dz) / (back * Math.hypot(h3.dx, h3.dz))).toBeLessThan(-0.99);   // straight back along the turned gaze, handled inside the frame
  // locoHand limits which hand drives: with the left only, a right-thumb turn is named and ignored
  await page.evaluate(() => { const s = document.querySelector('#locoHand'); s.value = 'left'; s.dispatchEvent(new Event('change')); });
  await page.evaluate(() => window.__glossy.microgesture('right', 'swipe-left'));
  await page.waitForTimeout(400);
  expect(await pose()).toEqual(p3);
  await expect.poll(() => status(page)).toMatch(/right thumb: turn-right/);
  await page.evaluate(() => { const s = document.querySelector('#locoHand'); s.value = 'both'; s.dispatchEvent(new Event('change')); });
  // scooter mode: a forward swipe is a push along the gaze that fades out; a back swipe brakes
  await page.evaluate(() => { const s = document.querySelector('#locoMode'); s.value = 'scooter'; s.dispatchEvent(new Event('change')); });
  const c0 = await pose(), hc = await head();
  await page.evaluate((g) => window.__glossy.microgesture('left', g), L.push);
  await page.waitForTimeout(600);
  const c1 = await pose();
  await page.waitForTimeout(4000);
  const c2 = await pose();
  const went = Math.hypot(c1.x - c0.x, c1.z - c0.z), total = Math.hypot(c2.x - c0.x, c2.z - c0.z);
  expect(went).toBeGreaterThan(0.4); expect(total).toBeGreaterThan(1.3); expect(total).toBeLessThan(2.1);   // one push carries about 1.8 m and has faded by four seconds
  expect(((c1.x - c0.x) * hc.dx + (c1.z - c0.z) * hc.dz) / (went * Math.hypot(hc.dx, hc.dz))).toBeGreaterThan(0.99);   // along the gaze at the push, after the turn
  // between pushes the head does not steer: turn the emulated head 90° and the course holds
  await page.evaluate((g) => window.__glossy.microgesture('left', g), L.push);
  await page.waitForTimeout(200);
  const d0 = await pose();
  await page.evaluate(() => { const s = Math.sin(Math.PI / 4), c = Math.cos(Math.PI / 4); window.__xr.quaternion.set(0, s, 0, c); });
  await page.waitForTimeout(600);
  const d1 = await pose();
  const drift = Math.hypot(d1.x - d0.x, d1.z - d0.z);
  expect(((d1.x - d0.x) * hc.dx + (d1.z - d0.z) * hc.dz) / (drift * Math.hypot(hc.dx, hc.dz))).toBeGreaterThan(0.99);
  await page.evaluate(() => { window.__xr.quaternion.set(0, 0, 0, 1); });
  // across the finger turns at once in scooter mode too; a second swipe the same way within 700 ms tops it up to 45°
  const r0 = await pose();
  await page.evaluate((g) => window.__glossy.microgesture('right', g), L.turnLeft);
  await page.waitForTimeout(900);                                                                  // one swipe: 30°
  expect((await pose()).rot - r0.rot).toBeCloseTo(30, 0);
  await page.evaluate((g) => window.__glossy.microgesture('right', g), L.turnLeft);
  await page.waitForTimeout(150);
  await page.evaluate((g) => window.__glossy.microgesture('right', g), L.turnLeft);
  await page.waitForTimeout(400);
  expect((await pose()).rot - r0.rot).toBeCloseTo(75, 0);                                         // 30 + (30 + 15): the pair makes 45°
  await page.evaluate((g) => window.__glossy.microgesture('left', g), L.brake);   // brake
  await page.waitForTimeout(100);
  const c3 = await pose();
  await page.waitForTimeout(500);
  const c4 = await pose();
  expect(Math.hypot(c4.x - c3.x, c4.z - c3.z)).toBeLessThan(0.02);                                   // stopped
  // the log has the gestures and the moves
  await page.evaluate(() => window.__glossy.log.flush());
  const project = (await (await request.get(`${API}/api/projects`)).json()).find((p) => p.name === 'xr-thumb');
  const events = await (await request.get(`${API}/api/projects/${project.id}/events`)).json();
  expect(events.filter((e) => e.kind === 'input:microgesture')).toHaveLength(10);
  const moves = events.filter((e) => e.kind === 'move').map((e) => [e.data.kind, e.data.by]);
  expect(moves.slice(0, 3)).toEqual([['step', 1], ['turn', 30], ['step', -1]]);
  expect(moves.slice(3).map((m) => m[0])).toEqual(['push', 'push', 'turn', 'turn', 'turn', 'push']);
  expect(moves[3][1]).toBe(1.2); expect(moves[4][1]).toBeGreaterThanOrEqual(1.2); expect(moves.slice(5, 8).map((m) => m[1])).toEqual([30, 30, 15]); expect(moves[8][1]).toBe(0);
});

test('the wrist microphone: raise it to the mouth and a clip starts on what you were looking at; lower it and the clip is saved; the pinch no longer records', async ({ page, request }) => {
  const project = await openProject(page, request, 'xr-mic');
  await prepareRecording(page, 'Speaker');
  await page.evaluate(() => { window.__xr.primaryInputMode = 'hand'; document.querySelector('#recordMode').value = 'mic'; });
  await page.locator('#VRButton').click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__glossy.handsPresent), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__glossy.wristMic.group.visible)).toBe(true);
  await page.evaluate(() => { window.__xr.hands.left.position.set(-0.3, 1.0, 0.4); });   // the left hand hangs by the side to begin with
  // the fake microphone is already talking, yet nothing records: voice start stands down in this mode
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__glossy.recorder.isRecording)).toBe(false);
  // a right pinch on empty space does not record either
  await page.evaluate(() => window.__xr.hands.right.updatePinchValue(1));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__glossy.recorder.isRecording)).toBe(false);
  await page.evaluate(() => window.__xr.hands.right.updatePinchValue(0));
  // look at the pot, raise the left hand to the mouth
  await page.evaluate(() => { const d = window.__xr; d.position.set(0, 1.6, 0.6); const a = Math.atan2(0, 1.8), p = -0.35; d.quaternion.set(Math.sin(p / 2), 0, 0, Math.cos(p / 2)); });
  const before = await page.evaluate(() => [window.__glossy.rig.position.x, window.__glossy.rig.position.z]);
  await page.evaluate(() => { const h = window.__xr.hands.left; h.position.set(-0.03, 1.5, 0.52); });
  await expect.poll(() => status(page), { timeout: 5000 }).toMatch(/talking about pot/);
  expect(await page.evaluate(() => [window.__glossy.rig.position.x, window.__glossy.rig.position.z])).toEqual(before);   // raising the hand is not a thumb slide: nobody moved
  await expect.poll(() => page.evaluate(() => window.__glossy.recorder.isRecording)).toBe(true);
  await page.waitForTimeout(1500);
  // lower it: saved, anchored on the pot, source mic
  await page.evaluate(() => { const h = window.__xr.hands.left; h.position.set(-0.3, 1.0, 0.4); });
  await expect.poll(() => markerCount(page), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => status(page), { timeout: 10_000 }).toMatch(/^saved .* on pot/);
  const [a] = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(a.anchor.objectId).toBe('pot');
  await page.evaluate(() => window.__glossy.log.flush());
  const events = await (await request.get(`${API}/api/projects/${project.id}/events`)).json();
  expect(events.find((e) => e.kind === 'record:start').data.source).toBe('mic');
  expect(events.filter((e) => e.kind === 'record:start')).toHaveLength(1);
});

test('with controllers, the left thumbstick glides you where you look and the right one snap-turns', async ({ page, request }) => {
  await openProject(page, request, 'xr-sticks');
  await prepareRecording(page, 'Driver');
  await page.locator('#VRButton').click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  const pose = () => page.evaluate(() => { const r = window.__glossy.rig; return { x: r.position.x, z: r.position.z, rot: Math.round((r.rotation.y * 180) / Math.PI) }; });
  const p0 = await pose();
  await page.evaluate(() => window.__xr.controllers.left.updateAxes('thumbstick', 0, -1));   // pushed forward
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__xr.controllers.left.updateAxes('thumbstick', 0, 0));
  const p1 = await pose();
  const went = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  expect(went).toBeGreaterThan(0.8); expect(went).toBeLessThan(1.5);                      // about 1.2 m/s for a second
  expect(p1.z - p0.z).toBeLessThan(-0.8);                                                // along the gaze, which looks down -Z at the start
  await page.evaluate(() => window.__xr.controllers.right.updateAxes('thumbstick', 1, 0));   // flick right
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__xr.controllers.right.updateAxes('thumbstick', 0, 0));
  await page.waitForTimeout(300);
  const p2 = await pose();
  expect(p2.rot - p1.rot).toBe(-30);                                                       // one snap, not a spin
  await page.evaluate(() => window.__xr.controllers.right.updateAxes('thumbstick', 1, 0));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__xr.controllers.right.updateAxes('thumbstick', 0, 0));
  await page.waitForTimeout(300);
  expect((await pose()).rot - p1.rot).toBe(-60);
});
