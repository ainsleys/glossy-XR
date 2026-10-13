// A real walkable interior: the Fireplace Room OBJ (Wig42, CC-BY 3.0) kept
// outside the repo in ../test-assets. Skipped when it is not present.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API, openProject, uploadAsset, prepareRecording, lockPointer, camera, markerCount, holdKey, recordWithMouse } from './helpers.js';

const ROOM = process.env.GLOSSY_TEST_SCENE || path.resolve('../test-assets/interiors/fireplace_room');
const obj = path.join(ROOM, 'fireplace_room.obj');

test.skip(!fs.existsSync(obj), `no test scene at ${ROOM}`);

test('spawns on the floor of an uploaded interior, walks into a wall, annotates a named mesh', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = await openProject(page, request, 'fireplace');
  const sidecars = [path.join(ROOM, 'fireplace_room.mtl'), ...fs.readdirSync(path.join(ROOM, 'textures')).map((f) => path.join(ROOM, 'textures', f))];
  const asset = await uploadAsset(page, request, project.id, obj, sidecars);
  expect(asset.type).toBe('obj');
  await expect.poll(() => page.evaluate(() => window.__glossy.room.visible)).toBe(false);   // default room hidden once a scene exists

  // spawn: standing on genuine floor at eye height, with the asset auto-fitted and saved
  await expect.poll(() => page.evaluate(() => window.__glossy.floorBelow(window.__glossy.camera.position)), { timeout: 20_000 }).not.toBeNull();
  const [x, y, z] = await camera(page);
  const floor = await page.evaluate(() => window.__glossy.floorBelow(window.__glossy.camera.position));
  expect(y - floor).toBeCloseTo(1.6, 1);
  const saved = await (await request.get(`${API}/api/projects/${project.id}`)).json();
  expect(Object.keys(saved.assets[0].transform).length).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/fireplace-spawn.png' });

  // walk until blocked: position must settle inside the room's bounds and stop changing
  await lockPointer(page);
  await page.evaluate(() => { const c = window.__glossy.camera; c.lookAt(c.position.x + 10, c.position.y, c.position.z); c.updateMatrixWorld(true); });
  await holdKey(page, 'KeyW', 2500);
  const a = await camera(page);
  await holdKey(page, 'KeyW', 2500);
  const b = await camera(page);
  expect(a[0]).toBeGreaterThan(x + 0.5);                 // moved along +X
  expect(Math.abs(b[0] - a[0])).toBeLessThan(0.05);      // then stopped at the wall
  const bounds = await page.evaluate(() => { const g = window.__glossy, e = [...g.loaded.values()][0]; const bx = e.model.box.clone().applyMatrix4(e.group.matrixWorld); return [bx.min.toArray(), bx.max.toArray()]; });
  expect(b[0]).toBeLessThan(bounds[1][0]);
  expect(b[0]).toBeGreaterThan(bounds[0][0]);
  await page.screenshot({ path: 'test-results/fireplace-at-wall.png' });

  // annotate whatever is in front: the anchor must sit on the scene with a mesh name
  await prepareRecording(page, 'Walker');
  await recordWithMouse(page, 800);
  const list = await (await request.get(`${API}/api/projects/${project.id}/annotations`)).json();
  expect(list).toHaveLength(1);
  expect(list[0].anchor.objectId).toBeTruthy();
  expect(Math.abs(list[0].anchor.x - b[0])).toBeLessThan(2);
  expect(await markerCount(page)).toBe(1);
  await page.screenshot({ path: 'test-results/fireplace-annotated.png' });
});
