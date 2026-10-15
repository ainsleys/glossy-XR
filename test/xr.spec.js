// Headset path without a headset: IWER (Meta's Immersive Web Emulation Runtime)
// installs a fake navigator.xr before the app boots, we enter VR through the
// real VRButton, aim the emulated right controller, and record with its trigger.
import { test, expect } from '@playwright/test';
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
