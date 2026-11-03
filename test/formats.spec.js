// Every scene format the viewer accepts, loaded from a small fixture the test
// writes itself (test/fixtures/scenes.mjs). One test per format, so a failure
// names the format. Each checks what the server called it, what the loader
// made of it, that auto-fit stood it on the floor and saved the transform,
// whether the default room stayed, and where a clip aimed at it is anchored.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { API, openProject, uploadAsset, prepareRecording, lockPointer, aimCamera, recordWithMouse, listAnnotations } from './helpers.js';
import * as scenes from './fixtures/scenes.mjs';

/** Write the fixture files into this test's output dir, upload the first with the rest as sidecars. */
async function load(page, request, files, extra = {}) {
  const project = await openProject(page, request, 'format');
  const paths = Object.entries(files).map(([name, bytes]) => {
    const p = test.info().outputPath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    return p;
  });
  const asset = await uploadAsset(page, request, project.id, paths[0], paths.slice(1), extra);
  // the transform is chosen and saved just after the model appears
  await expect.poll(() => page.evaluate((id) => Object.keys(window.__glossy.loaded.get(id).asset.transform || {}).length, asset.id)).toBeGreaterThan(0);
  return { project, asset };
}

/** What the page made of an asset: kind, count, its box before and after the asset's transform, and the room. */
const inspect = (page, id) => page.evaluate((id) => {
  const g = window.__glossy, e = g.loaded.get(id), m = e.model;
  e.group.updateMatrixWorld(true);
  const world = m.box.clone().applyMatrix4(e.group.matrixWorld);
  return {
    type: e.asset.type, kind: m.kind, count: m.count, imageMode: m.imageMode,
    size: m.box.getSize(m.box.min.clone()).toArray(),
    worldMin: world.min.toArray(), worldMax: world.max.toArray(),
    transform: e.asset.transform, scale: e.transform.scale,
    room: g.room.visible, camera: g.camera.position.toArray(),
  };
}, id);

/** A point given in the file's coordinates, carried into the world through the loaded object. */
const toWorld = (page, id, p) => page.evaluate(([id, p]) => {
  const e = window.__glossy.loaded.get(id);
  e.group.updateMatrixWorld(true);
  return window.__glossy.camera.position.clone().set(...p).applyMatrix4(e.model.object.matrixWorld).toArray();
}, [id, p]);

/** Checks every placed 3D asset shares: positive extent, standing on the floor, scene replaces the room. */
function expectPlaced(info, { type, kind }) {
  expect(info.type).toBe(type);
  expect(info.kind).toBe(kind);
  expect(info.count).toBeGreaterThan(0);
  for (const s of info.size) expect(s).toBeGreaterThan(0);
  expect(Object.keys(info.transform).length).toBeGreaterThan(0);
  expect(info.worldMin[1]).toBeCloseTo(0, 2);
  expect(info.room).toBe(false);
}

/** Aim from `dist` metres out along `dir` at a world point, record a clip, return its anchor. */
async function anchorAt(page, request, projectId, point, dir = [0, 0, 1], dist = 2) {
  await prepareRecording(page, 'Formats');
  await lockPointer(page);
  const from = point.map((v, i) => v + dir[i] * dist);
  await aimCamera(page, from, point);
  await recordWithMouse(page, 800);
  const list = await listAnnotations(request, projectId);
  expect(list).toHaveLength(1);
  return list[0].anchor;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Gaussian splats: Spark decodes in a worker. The anchor comes from the
// viewer's own cone test over splat centres, so aiming at one centre on the
// side facing the camera must land on the sphere's surface.
async function splatTest(page, request, files) {
  test.setTimeout(180_000);
  const { project, asset } = await load(page, request, files);
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: Object.keys(files)[0].endsWith('.splat') ? 'splat' : 'ply', kind: 'splat' });
  expect(info.count).toBe(scenes.GAUSS.count);
  const centre = await toWorld(page, asset.id, scenes.GAUSS.centre);
  const centres = scenes.gaussCentres();
  const target = await toWorld(page, asset.id, centres[Math.floor(centres.length / 2)]);   // on the equator
  const out = target.map((v, i) => v - centre[i]), n = Math.hypot(...out);
  const anchor = await anchorAt(page, request, project.id, target, out.map((v) => v / n));
  expect(anchor.objectId).toBe('splat');
  const r = scenes.GAUSS.radius * info.scale;
  expect(Math.abs(dist([anchor.x, anchor.y, anchor.z], centre) - r)).toBeLessThan(0.05 * r);
}

test('.splat: Gaussians load through Spark and anchor on the sphere', async ({ page, request }) => {
  await splatTest(page, request, { 'sphere.splat': scenes.splatFile() });
});

test('3DGS PLY: the header sniff sends it to Spark, not PLYLoader', async ({ page, request }) => {
  await splatTest(page, request, { 'sphere-3dgs.ply': scenes.gaussianPly() });
});
