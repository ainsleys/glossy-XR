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
  const btn = page.locator('#VRButton');
  await expect(btn).toHaveText(/ENTER VR/i);
  await btn.click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect(btn).toHaveText(/EXIT VR/i);

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
  // the new marker often sits under the controller ray, so the "saved" status gives way to its hover text at once
  await expect.poll(() => status(page)).toMatch(/^saved|click to play/);
  const list = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].author).toBe('HeadsetTester');
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
