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

test('PLY with faces: a mesh, anchored by its name', async ({ page, request }) => {
  const { project, asset } = await load(page, request, { 'cube.ply': scenes.cubePly() });
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: 'ply', kind: 'mesh' });
  expect(info.count).toBe(8);
  const centre = await toWorld(page, asset.id, scenes.CUBE.centre);
  const anchor = await anchorAt(page, request, project.id, centre);            // the middle of the +Z face is in front of the centre
  expect(anchor.objectId).toBe('ply');
  expect(anchor.z).toBeCloseTo(centre[2] + scenes.CUBE.size / 2 * info.scale, 2);
});

test('PLY without faces: a point cloud, anchored on a corner', async ({ page, request }) => {
  const { project, asset } = await load(page, request, { 'corners.ply': scenes.cubePly({ faces: false }) });
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: 'ply', kind: 'points' });
  expect(info.count).toBe(8);
  const corner = await toWorld(page, asset.id, scenes.cubeCorners().at(-1));    // +X +Y +Z: nothing between it and a camera out along +Z
  const anchor = await anchorAt(page, request, project.id, corner);
  expect(anchor.objectId).toBe('pointcloud');
  expect(dist([anchor.x, anchor.y, anchor.z], corner)).toBeLessThan(0.05);
});

test('PCD: a coloured point cloud, anchored on a known point', async ({ page, request }) => {
  const { project, asset } = await load(page, request, { 'cloud.pcd': scenes.cloudPcd() });
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: 'pcd', kind: 'points' });
  expect(info.count).toBe(scenes.CLOUD.count);
  expect(await page.evaluate((id) => !!window.__glossy.loaded.get(id).model.object.geometry.attributes.color, asset.id)).toBe(true);
  const target = await toWorld(page, asset.id, scenes.CLOUD_TARGET);
  const anchor = await anchorAt(page, request, project.id, target);
  expect(anchor.objectId).toBe('pointcloud');
  expect(dist([anchor.x, anchor.y, anchor.z], target)).toBeLessThan(0.05);
});

test('glTF: an embedded-buffer mesh 50 units across is scaled to 4 m', async ({ page, request }) => {
  const { project, asset } = await load(page, request, { 'crate.gltf': scenes.cubeGltf() });
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: 'gltf', kind: 'mesh' });
  expect(info.scale).toBeCloseTo(4 / scenes.BIG_CUBE.size, 4);                 // auto-fit shrinks giants to about 4 m
  expect(info.worldMax[1] - info.worldMin[1]).toBeCloseTo(4, 2);
  const centre = await toWorld(page, asset.id, scenes.BIG_CUBE.centre);
  const anchor = await anchorAt(page, request, project.id, centre, [0, 0, 1], 5);
  expect(anchor.objectId).toBe(scenes.BIG_CUBE.name);
});

test('OBJ with its MTL: the material colour comes from the MTL', async ({ page, request }) => {
  const { project, asset } = await load(page, request, { 'box.obj': scenes.cubeObj(), 'box.mtl': scenes.objMtl() });
  const info = await inspect(page, asset.id);
  expectPlaced(info, { type: 'obj', kind: 'mesh' });
  // MTLLoader reads Kd as sRGB; getRGB with SRGBColorSpace gives the file's numbers back
  const kd = await page.evaluate((id) => {
    let c = null;
    window.__glossy.loaded.get(id).model.object.traverse((o) => { if (o.isMesh) { const t = { r: 0, g: 0, b: 0 }; o.material.color.getRGB(t, 'srgb'); c = [t.r, t.g, t.b]; } });
    return c;
  }, asset.id);
  scenes.OBJ_CUBE.kd.forEach((v, i) => expect(kd[i]).toBeCloseTo(v, 2));
  const centre = await toWorld(page, asset.id, scenes.OBJ_CUBE.centre);
  const anchor = await anchorAt(page, request, project.id, centre);
  expect(anchor.objectId).toBe(scenes.OBJ_CUBE.name);
});

// Images and video are a plane (or a sphere) with the picture as a texture:
// kind mesh, four corners. A 360 panorama is the room; a flat photo or a
// video hangs in it, so the default room stays (the isScene rule).

test('360 panorama: a sphere around the viewer, centred at scale 1, replacing the room', async ({ page, request }) => {
  const { asset } = await load(page, request, { 'pano.png': await scenes.png(64, 32) }, { mode: 'sphere' });
  const info = await inspect(page, asset.id);
  expect(info).toMatchObject({ type: 'image', kind: 'mesh', count: 4, imageMode: 'sphere', scale: 1, room: false });
  expect(Object.keys(info.transform).length).toBeGreaterThan(0);
  const radius = info.size[1] / 2;
  expect(Math.hypot(...info.camera)).toBeLessThan(radius);
});

test('flat photo: a plane standing on the floor, the room stays', async ({ page, request }) => {
  const { asset } = await load(page, request, { 'photo.png': await scenes.png(48, 32) });
  const info = await inspect(page, asset.id);
  expect(info).toMatchObject({ type: 'image', kind: 'mesh', count: 4, imageMode: 'plane', room: true });
  for (const s of info.size.slice(0, 2)) expect(s).toBeGreaterThan(0);
  expect(Object.keys(info.transform).length).toBeGreaterThan(0);
  expect(info.worldMin[1]).toBeCloseTo(0, 2);
  expect(info.size[1] / info.size[0]).toBeCloseTo(32 / 48, 3);
});

test('video: a WebM recorded in the page plays on a plane, the room stays', async ({ page, request }) => {
  await openProject(page, request, 'recorder');
  // one second of a moving square from a canvas, through MediaRecorder
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const ctx = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    await new Promise((r) => { const step = () => { const t = performance.now() - t0; ctx.fillStyle = '#234'; ctx.fillRect(0, 0, 160, 90); ctx.fillStyle = '#fa3'; ctx.fillRect(t / 10 % 140, 30, 20, 20); if (t < 1000) requestAnimationFrame(step); else r(); }; step(); });
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  });
  const { asset } = await load(page, request, { 'clip.webm': Buffer.from(b64, 'base64') });
  const info = await inspect(page, asset.id);
  expect(info).toMatchObject({ type: 'video', kind: 'mesh', count: 4, imageMode: 'plane', room: true });
  expect(Object.keys(info.transform).length).toBeGreaterThan(0);
  expect(info.worldMin[1]).toBeCloseTo(0, 2);
  expect(info.size[1] / info.size[0]).toBeCloseTo(90 / 160, 2);
  await expect.poll(() => page.evaluate((id) => window.__glossy.loaded.get(id).model.video.readyState, asset.id)).toBeGreaterThanOrEqual(2);
});
