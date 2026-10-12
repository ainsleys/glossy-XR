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

export async function loadModel({ url, type, renderer, scene, pointSize = 0.01, onProgress }) {
  switch (type) {
    case 'gltf': return loadGltf(url, renderer, onProgress);
    case 'ply': return (await isGaussianPly(url)) ? loadSplat(url, renderer, scene) : loadPly(url, pointSize, onProgress);
    case 'pcd': return loadPcd(url, pointSize, onProgress);
    case 'obj': return loadObj(url, onProgress);
    case 'splat': return loadSplat(url, renderer, scene);
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
  const points = new THREE.Points(geometry, pointsMaterial(hasColor, pointSize));
  points.name = 'pointcloud';
  return finish(points, 'points', geometry.attributes.position.count);
}

// ---- PCD -------------------------------------------------------------------

async function loadPcd(url, pointSize, onProgress) {
  const points = await new PCDLoader().loadAsync(url, onProgress);
  const hasColor = !!points.geometry.attributes.color;
  points.material = pointsMaterial(hasColor, pointSize);
  points.name = 'pointcloud';
  return finish(points, 'points', points.geometry.attributes.position.count);
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

async function loadSplat(url, renderer, scene) {
  sparkModule ??= await import('@sparkjsdev/spark');
  const { SparkRenderer, SplatMesh } = sparkModule;
  if (!sparkRenderer) { sparkRenderer = new SparkRenderer({ renderer }); scene.add(sparkRenderer); }
  const mesh = new SplatMesh({ url });
  mesh.name = 'splat';
  await mesh.initialized;
  // 3DGS training data is Y-down relative to three's Y-up; flip once here so
  // the project transform starts from "upright".
  mesh.quaternion.set(1, 0, 0, 0);
  const count = mesh.numSplats ?? mesh.packedSplats?.numSplats ?? 0;
  const result = finish(mesh, 'splat', count);
  if (result.box.isEmpty()) result.box.set(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
  return result;
}

export const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.ply', '.pcd', '.obj', '.splat', '.ksplat', '.spz', '.sog'];
