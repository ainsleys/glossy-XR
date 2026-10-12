// One entry point for every model type a project can hold.
//
//   gltf  .glb .gltf          GLTFLoader (+ Draco, KTX2, meshopt)
//   ply   .ply                PLYLoader -> Mesh if it has faces, Points otherwise;
//                             if the header has 3DGS properties (f_dc_0) it is a splat
//   pcd   .pcd                PCDLoader -> Points
//   obj   .obj                OBJLoader (+ sidecar .mtl if uploaded alongside)
//   splat .splat .ksplat .spz .sog   Spark SplatMesh (WebGL + WebXR capable)
//
// Returns { object, kind: 'mesh'|'points'|'splat', box, count, dispose }.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

let sparkModule = null;        // lazy: Spark is ~1 MB and only needed for splats
let sparkRenderer = null;

export async function loadModel({ url, type, renderer, scene, camera, pointSize = 0.01, onProgress }) {
  switch (type) {
    case 'gltf': return loadGltf(url, renderer, onProgress);
    case 'ply': return (await isGaussianPly(url)) ? loadSplat(url, renderer, scene, camera) : loadPly(url, pointSize, onProgress);
    case 'pcd': return loadPcd(url, pointSize, onProgress);
    case 'obj': return loadObj(url, onProgress);
    case 'splat': return loadSplat(url, renderer, scene, camera);
    default: throw new Error('unsupported model type: ' + type);
  }
}

function finish(object, kind, count) {
  const box = new THREE.Box3().setFromObject(object);
  return {
    object, kind, box, count,
    dispose() {
      object.traverse((o) => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (!m) continue; for (const k in m) m[k]?.isTexture && m[k].dispose(); m.dispose?.(); }
      });
      object.dispose?.();
    },
  };
}

function countVerts(object) {
  let n = 0;
  object.traverse((o) => { if (o.geometry?.attributes?.position) n += o.geometry.attributes.position.count; });
  return n;
}

// ---- glTF ------------------------------------------------------------------

async function loadGltf(url, renderer, onProgress) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader().setDecoderPath('/decoders/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, onProgress);
  gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = false; } });
  return finish(gltf.scene, 'mesh', countVerts(gltf.scene));
}

// ---- PLY -------------------------------------------------------------------

async function isGaussianPly(url) {
  // read just the header: 3DGS PLYs declare f_dc_0 / scale_0 / rot_0 properties
  const res = await fetch(url, { headers: { Range: 'bytes=0-4095' } });
  const head = new TextDecoder('latin1').decode(await res.arrayBuffer());
  return /property\s+float\s+f_dc_0/.test(head) && /property\s+float\s+scale_0/.test(head);
}

async function loadPly(url, pointSize, onProgress) {
  const geometry = await new PLYLoader().loadAsync(url, onProgress);
  const hasFaces = !!geometry.index && geometry.index.count > 0;
  const hasColor = !!geometry.attributes.color;
  if (hasFaces) {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0xbbbbbb, roughness: 0.9, side: THREE.DoubleSide }));
    mesh.name = 'ply';
    return finish(mesh, 'mesh', geometry.attributes.position.count);
  }
  const cloud = stripNonFinite(geometry);
  const points = new THREE.Points(cloud, pointsMaterial(hasColor, pointSize));
  points.name = 'pointcloud';
  return finish(points, 'points', cloud.attributes.position.count);
}

// ---- PCD -------------------------------------------------------------------

async function loadPcd(url, pointSize, onProgress) {
  const points = await new PCDLoader().loadAsync(url, onProgress);
  points.geometry = stripNonFinite(points.geometry);
  const hasColor = !!points.geometry.attributes.color;
  points.material = pointsMaterial(hasColor, pointSize);
  points.name = 'pointcloud';
  return finish(points, 'points', points.geometry.attributes.position.count);
}

// Organized clouds from depth cameras (PCD WIDTH x HEIGHT) carry NaN rows for
// missing pixels. One NaN poisons the bounding box and the whole cloud is
// culled, so drop non-finite points and keep the other attributes in step.
function stripNonFinite(geometry) {
  const pos = geometry.attributes.position;
  if (!pos || geometry.index) return geometry;
  const keep = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) keep.push(i);
  }
  if (keep.length === pos.count) return geometry;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize;
    const arr = new attr.array.constructor(keep.length * size);
    for (let k = 0; k < keep.length; k++) for (let c = 0; c < size; c++) arr[k * size + c] = attr.array[keep[k] * size + c];
    out.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
  }
  geometry.dispose();
  return out;
}

function pointsMaterial(vertexColors, size) {
  return new THREE.PointsMaterial({ size, sizeAttenuation: true, vertexColors, color: vertexColors ? 0xffffff : 0xcfd8e3 });
}

// ---- OBJ -------------------------------------------------------------------

async function loadObj(url, onProgress) {
  const loader = new OBJLoader();
  const mtlUrl = url.replace(/\.obj$/i, '.mtl');
  const mtlOk = await fetch(mtlUrl, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  if (mtlOk) {
    const mtl = await new MTLLoader().setResourcePath(url.slice(0, url.lastIndexOf('/') + 1)).loadAsync(mtlUrl);
    mtl.preload();
    loader.setMaterials(mtl);
  }
  const obj = await loader.loadAsync(url, onProgress);
  if (!mtlOk) obj.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.9, side: THREE.DoubleSide }); });
  return finish(obj, 'mesh', countVerts(obj));
}

// ---- Gaussian splats (Spark) ----------------------------------------------

async function loadSplat(url, renderer, scene, camera) {
  sparkModule ??= await import('@sparkjsdev/spark');
  const { SparkRenderer, SplatMesh } = sparkModule;
  if (!sparkRenderer) {
    sparkRenderer = new SparkRenderer({ renderer });
    sparkRenderer.frustumCulled = false;      // it renders every splat in the scene from wherever it sits; never let the camera cull it
    scene.add(sparkRenderer);
  }
  // `initialized` resolves when the mesh object is ready, not when the file has
  // been decoded; onLoad is the signal that the splats are actually there.
  const mesh = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('splat load timed out')), 180_000);
    const m = new SplatMesh({ url, raycastable: true, onLoad: (loaded) => { clearTimeout(timer); resolve(loaded); } });
    m.initialized.catch((e) => { clearTimeout(timer); reject(e); });
  });
  mesh.name = 'splat';
  // 3DGS training data is Y-down relative to three's Y-up; flip once here so
  // the project transform starts from "upright".
  mesh.quaternion.set(1, 0, 0, 0);
  mesh.updateMatrix();
  const count = mesh.packedSplats?.numSplats ?? 0;
  const result = finish(mesh, 'splat', count);
  // SplatMesh has no geometry, so Box3.setFromObject is empty, and Spark's
  // getBoundingBox returns a placeholder. Walk the splat centres instead and
  // trim the 1% tails per axis so training floaters don't inflate the box.
  try {
    const xs = [], ys = [], zs = [];
    const step = Math.max(1, Math.floor(count / 200_000));           // sample big scenes
    mesh.forEachSplat((i, c) => { if (i % step === 0) { xs.push(c.x); ys.push(c.y); zs.push(c.z); } });
    const q = (a, p) => { a.sort((u, v) => u - v); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    const box = new THREE.Box3(
      new THREE.Vector3(q(xs, 0.01), q(ys, 0.01), q(zs, 0.01)),
      new THREE.Vector3(q(xs, 0.99), q(ys, 0.99), q(zs, 0.99)),
    );
    if (!box.isEmpty()) result.box = box.applyMatrix4(mesh.matrix);
  } catch (e) { console.warn('splat bounds', e); }
  if (result.box.isEmpty()) result.box.set(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
  // Spark sorts and uploads splats over the next few animation frames. Kick
  // one update now so the scene is complete even if the tab is not getting
  // frames yet (background window, screenshot tooling).
  if (camera) try { scene.add(mesh); sparkRenderer.update({ scene, camera }); scene.remove(mesh); } catch {}
  return result;
}

export const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.ply', '.pcd', '.obj', '.splat', '.ksplat', '.spz', '.sog'];
