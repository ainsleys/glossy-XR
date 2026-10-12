// Glossy XR client.
//
// 2016 Glossy: WebVR + three r79 + VRControls/VREffect + webvr-boilerplate,
// Vive gamepads polled by hand, recorder.js, spheres at the controller position,
// socket.io 1.x. Everything in that list is gone from browsers or three.js.
//
// This keeps the interaction model and swaps the plumbing:
//   WebXR (renderer.xr) + XRControllerModelFactory, MediaRecorder,
//   PositionalAudio, Socket.IO 4, ESM three via Vite.
// Desktop fallback (pointer lock + WASD, mouse button to record) kept from the
// original so the tool can be used without a headset.
//
// Projects: each project owns a set of assets (glTF, PLY, PCD, OBJ, Gaussian
// splat, flat image, 360 panorama, video), each with its own transform, plus
// the annotations. Annotations anchor to the surface the user points at and
// carry the name of the mesh hit.

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { VoiceRecorder } from './recorder.js';
import { connect, projects as projectsApi, assets as assetsApi, annotations as annotationsApi } from './api.js';
import { loadModel, SUPPORTED_EXTENSIONS } from './loaders.js';

// ---- config ----------------------------------------------------------------

const LAYERS = ['default', 'draft', 'review', 'final'];
const MARKER_RADIUS = 0.06;
const PLAY_DISTANCE = 1.2;                        // metres; walk near a marker and it plays
const DEFAULT_TRANSFORM = { scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0, z: 0, pointSize: 0.01 };

// ---- HUD -------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const hud = {
  project: $('project'), newProject: $('newProject'), modelInfo: $('modelInfo'),
  author: $('author'), layer: $('layer'), consent: $('consent'), status: $('statusText'), rec: $('rec'), count: $('count'),
  assetList: $('assetList'), assetFile: $('assetFile'), uploadProgress: $('uploadProgress'), exportLink: $('exportLink'), annList: $('annList'),
  t: { scale: $('tScale'), rotX: $('tRotX'), rotY: $('tRotY'), rotZ: $('tRotZ'), x: $('tX'), y: $('tY'), z: $('tZ'), pointSize: $('tPointSize') },
  zUp: $('zUp'), autoFit: $('autoFit'), resetFit: $('resetFit'), saveTransform: $('saveTransform'), selectedName: $('selectedName'),
};
const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
hud.author.value = ls.get('glossy.author', '');
hud.layer.value = ls.get('glossy.layer', 'default');
hud.consent.checked = ls.get('glossy.consent', '0') === '1';
hud.author.addEventListener('change', () => ls.set('glossy.author', hud.author.value));
hud.layer.addEventListener('change', () => ls.set('glossy.layer', hud.layer.value));
hud.consent.addEventListener('change', () => ls.set('glossy.consent', hud.consent.checked ? '1' : '0'));
const setStatus = (t) => { hud.status.textContent = t; };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = (ms) => (ms ? (ms / 1000).toFixed(1) + 's' : '');

// ---- renderer / scene ------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(0, 1.6, 2);
camera.lookAt(0, 0.9, -1.2);          // frame the table on first load
const listener = new THREE.AudioListener();
camera.add(listener);

// player rig so desktop movement and XR share one transform
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 6, 2);
scene.add(sun);

// default environment: a 6 m room with a grid floor, shown when a project has no assets
const room = new THREE.Group();
{
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshStandardMaterial({ color: 0x1b2330, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.name = 'floor';
  room.add(floor, new THREE.GridHelper(6, 12, 0x3b4b5f, 0x2a3644));
  const walls = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 6), new THREE.MeshStandardMaterial({ color: 0x141a22, side: THREE.BackSide, roughness: 1 }));
  walls.position.y = 1.5; walls.name = 'walls';
  room.add(walls);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.7 });
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.7), mat); table.position.set(0, 0.75, -1.2); table.name = 'table';
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.3, 24), new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 0.6, roughness: 0.35 })); pot.position.set(0, 0.94, -1.2); pot.name = 'pot';
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.5), mat); chest.position.set(-2, 0.25, 0.5); chest.name = 'chest';
  room.add(table, pot, chest);
}
scene.add(room);

const floorGrid = new THREE.GridHelper(20, 40, 0x2a3644, 0x1c2530);
floorGrid.visible = false;
scene.add(floorGrid);

// ---- assets ----------------------------------------------------------------
// Each asset lives under its own Group so its saved transform applies as a whole.

const assetsRoot = new THREE.Group();
scene.add(assetsRoot);
const loaded = new Map();         // assetId -> { asset, group, model, transform, error, progress }
let project = null;               // current project record
let selectedId = null;            // asset whose transform the panel edits
const selected = () => loaded.get(selectedId) || null;

async function showAssets(p) {
  for (const e of loaded.values()) { assetsRoot.remove(e.group); e.model?.dispose(); }
  loaded.clear();
  const list = p.assets || [];
  room.visible = list.length === 0;
  floorGrid.visible = list.length > 0;
  selectedId = list.some((a) => a.id === selectedId) ? selectedId : (list[0]?.id ?? null);
  renderAssets();
  await Promise.all(list.map((a, i) => loadAsset(a, i)));
  frameAll();
  renderAssets();
}

async function loadAsset(asset, index = loaded.size) {
  const group = new THREE.Group();
  group.name = asset.name;
  assetsRoot.add(group);
  const entry = { asset, group, model: null, transform: { ...DEFAULT_TRANSFORM, ...asset.transform }, error: null, progress: 0 };
  loaded.set(asset.id, entry);
  group.visible = asset.visible !== false;
  try {
    entry.model = await loadModel({
      url: asset.url, type: asset.type, options: asset.options || {}, renderer, scene, camera, pointSize: entry.transform.pointSize,
      onProgress: (e) => { if (e.lengthComputable) { entry.progress = e.loaded / e.total; renderAssets(); } },
    });
    group.add(entry.model.object);
    applyTransform(entry);
    if (!asset.transform || Object.keys(asset.transform).length === 0) {
      autoFit(entry, index);                                // first time this asset is shown
      entry.asset = await assetsApi.update(project.id, asset.id, { transform: entry.transform });
    }
  } catch (e) {
    console.error(e);
    entry.error = e.message;
  }
  renderAssets();
}

function applyTransform(entry) {
  const t = entry.transform, g = entry.group;
  g.scale.setScalar(t.scale);
  g.rotation.set(THREE.MathUtils.degToRad(t.rotX), THREE.MathUtils.degToRad(t.rotY), THREE.MathUtils.degToRad(t.rotZ));
  g.position.set(t.x, t.y, t.z);
  if (entry.model?.kind === 'points') entry.model.object.material.size = t.pointSize;
}

function autoFit(entry, index = 0) {
  const m = entry.model; if (!m) return;
  const t = entry.transform;
  // leave plausible real-world sizes alone; shrink giants (mm units) to ~4 m, grow miniatures (unitless) to ~1 m
  const raw = m.box, size = raw.getSize(new THREE.Vector3()), max = Math.max(size.x, size.y, size.z) || 1;
  t.scale = max > 12 ? 4 / max : max < 0.3 ? 1 / max : 1;
  const c = raw.getCenter(new THREE.Vector3());
  const zUp = Math.abs(t.rotX + 90) < 1;                  // after rotX=-90 the model's Y/Z swap
  if (m.imageMode === 'sphere') { t.x = t.y = t.z = 0; t.scale = 1; }   // panoramas wrap the viewer; keep them centred
  else {
    t.x = -c.x * t.scale + index * 2.5;                   // later assets step along +X so they don't overlap
    t.z = zUp ? c.y * t.scale : -c.z * t.scale;
    t.y = zUp ? -raw.min.z * t.scale : -raw.min.y * t.scale;
  }
  applyTransform(entry);
  if (entry === selected()) transformToHud();
}

// desktop only: step the camera back far enough to see every visible asset
function frameAll() {
  if (renderer.xr.isPresenting) return;
  assetsRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const e of loaded.values()) {
    if (!e.model || !e.group.visible || e.model.imageMode === 'sphere') continue;
    const b = e.model.box.clone().applyMatrix4(e.group.matrixWorld);
    if (Number.isFinite(b.min.x)) box.union(b);
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const dist = Math.max(2, Math.max(size.x, size.y, size.z) * 1.1);
  camera.position.set(c.x, Math.max(1.6, c.y), c.z + dist);
  camera.lookAt(c.x, c.y, c.z);
}

// transform panel edits the selected asset
function transformToHud() {
  const e = selected();
  hud.selectedName.textContent = e ? `${e.asset.name} · ${e.asset.type}` : 'no asset selected';
  for (const k in hud.t) hud.t[k].value = e ? Number(e.transform[k].toPrecision(5)) : '';
}
function hudToTransform() {
  const e = selected(); if (!e) return;
  for (const k in hud.t) e.transform[k] = Number(hud.t[k].value) || (k === 'scale' ? 1 : k === 'pointSize' ? 0.01 : 0);
  applyTransform(e);
}
for (const k in hud.t) hud.t[k].addEventListener('input', hudToTransform);
hud.zUp.addEventListener('click', () => { const e = selected(); if (!e) return; e.transform.rotX = -90; transformToHud(); applyTransform(e); });
hud.resetFit.addEventListener('click', () => { const e = selected(); if (!e) return; e.transform = { ...DEFAULT_TRANSFORM }; transformToHud(); applyTransform(e); });
hud.autoFit.addEventListener('click', () => { const e = selected(); if (!e) return; autoFit(e, [...loaded.keys()].indexOf(e.asset.id)); frameAll(); });
hud.saveTransform.addEventListener('click', async () => {
  const e = selected(); if (!e || !project) return;
  e.asset = await assetsApi.update(project.id, e.asset.id, { transform: e.transform });
  setStatus('transform saved');
});

function renderAssets() {
  const ul = hud.assetList;
  ul.innerHTML = '';
  const entries = project?.assets?.map((a) => loaded.get(a.id) || { asset: a }) || [];
  for (const e of entries) {
    const a = e.asset;
    const li = document.createElement('li');
    li.className = (a.id === selectedId ? 'selected ' : '') + (e.group && !e.group.visible ? 'hidden ' : '');
    const info = e.error ? `failed: ${esc(e.error)}` : e.model ? describe(e.model) : e.progress ? `${Math.round(e.progress * 100)}%` : 'loading…';
    li.innerHTML = `<input type="checkbox" class="vis" ${e.group?.visible === false ? '' : 'checked'} title="visible" /><span class="name" title="${esc(a.name)}">${esc(a.name)}</span><span class="meta">${esc(a.type)}${e.model?.imageMode ? ' · ' + e.model.imageMode : ''} · ${info}</span><button class="del" title="remove asset">✕</button>`;
    li.querySelector('.name').addEventListener('click', () => { selectedId = a.id; renderAssets(); });
    li.querySelector('.vis').addEventListener('change', async (ev) => {
      if (e.group) e.group.visible = ev.target.checked;
      e.asset = await assetsApi.update(project.id, a.id, { visible: ev.target.checked });
      renderAssets();
    });
    li.querySelector('.del').addEventListener('click', async () => {
      await assetsApi.remove(project.id, a.id);            // server broadcasts project:updated → reload
      setStatus('removed ' + a.name);
    });
    ul.appendChild(li);
  }
  const n = loaded.size, k = [...loaded.values()].filter((e) => e.model).length;
  hud.modelInfo.textContent = n ? `${k}/${n} asset${n === 1 ? '' : 's'} loaded` : 'no assets (default room)';
  transformToHud();
}
function describe(m) {
  const s = m.box.getSize(new THREE.Vector3());
  return `${m.count.toLocaleString()} ${m.kind === 'splat' ? 'splats' : 'verts'} · ${s.x.toFixed(1)}×${s.y.toFixed(1)}×${s.z.toFixed(1)} m`;
}

hud.assetFile.addEventListener('change', async () => {
  if (!project || !hud.assetFile.files.length) return;
  const files = [...hud.assetFile.files];
  const main = files.find((f) => SUPPORTED_EXTENSIONS.includes('.' + f.name.split('.').pop().toLowerCase()));
  if (!main) return setStatus('pick a ' + SUPPORTED_EXTENSIONS.join(' ') + ' file');
  hud.uploadProgress.hidden = false; hud.uploadProgress.value = 0;
  try {
    const extra = {};
    if (/\.(png|jpe?g|webp|avif|mp4|webm|mov)$/i.test(main.name) && $('as360').checked) extra.mode = 'sphere';
    const asset = await assetsApi.upload(project.id, main, files.filter((f) => f !== main), (p) => { hud.uploadProgress.value = p; }, extra);
    setStatus('uploaded ' + main.name);
    selectedId = asset.id;                                  // project:updated will reload the asset list
  } catch (e) { setStatus('upload failed: ' + e.message); }
  hud.uploadProgress.hidden = true; hud.assetFile.value = '';
});

// ---- projects --------------------------------------------------------------

async function refreshProjectList() {
  const list = await projectsApi.list();
  hud.project.innerHTML = '';
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = `${p.name} (${p.annotationCount})${p.assets?.length ? ' · ' + p.assets.length + ' asset' + (p.assets.length === 1 ? '' : 's') : ''}`;
    hud.project.appendChild(o);
  }
  if (project) hud.project.value = project.id;
  return list;
}

async function openProject(id) {
  project = await projectsApi.get(id);
  hud.project.value = id;
  hud.exportLink.href = `/api/projects/${id}/export`;
  history.replaceState(null, '', `?project=${id}`);
  selectedId = null;
  clearMarkers();
  net.join(id);
  await showAssets(project);
}

hud.project.addEventListener('change', () => openProject(hud.project.value));
hud.newProject.addEventListener('click', async () => {
  const name = prompt('Project name');
  if (!name) return;
  const p = await projectsApi.create(name);
  await refreshProjectList();
  await openProject(p.id);
});

// ---- annotations in the scene ---------------------------------------------

const markers = new Map();           // id -> { mesh, sound, record }
const markerGroup = new THREE.Group();
scene.add(markerGroup);
const audioLoader = new THREE.AudioLoader();
const layerColor = (layer) => new THREE.Color().setHSL(((LAYERS.indexOf(layer) + 8) % 8) / 8, 0.75, 0.55);

function addMarker(record) {
  if (markers.has(record.id)) return;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(MARKER_RADIUS, 20, 14),
    new THREE.MeshStandardMaterial({ color: layerColor(record.layer), emissive: layerColor(record.layer), emissiveIntensity: 0.35 }),
  );
  mesh.position.set(record.anchor.x, record.anchor.y, record.anchor.z);
  mesh.userData.id = record.id;
  markerGroup.add(mesh);
  const sound = new THREE.PositionalAudio(listener);
  sound.setRefDistance(0.4);
  sound.setRolloffFactor(2);
  mesh.add(sound);
  audioLoader.load(record.audioUrl, (buffer) => sound.setBuffer(buffer));
  markers.set(record.id, { mesh, sound, record });
  updateCount();
  applyLayerFilter();
  renderList();
}
function removeMarker({ id }) {
  const m = markers.get(id);
  if (!m) return;
  m.sound.isPlaying && m.sound.stop();
  markerGroup.remove(m.mesh);
  markers.delete(id);
  if (playingId === id) playingId = null;
  updateCount();
  renderList();
}
function clearMarkers() { for (const id of [...markers.keys()]) removeMarker({ id }); }
function updateCount() { hud.count.textContent = `${markers.size} annotation${markers.size === 1 ? '' : 's'}`; }
function applyLayerFilter() {
  for (const { mesh, record } of markers.values()) {
    const active = record.layer === hud.layer.value;
    mesh.material.opacity = active ? 1 : 0.25;
    mesh.material.transparent = !active;
    mesh.userData.baseScale = active ? 1 : 0.7;
  }
}
hud.layer.addEventListener('change', () => { applyLayerFilter(); renderList(); });

// Markers keep a readable size on screen: bigger when far, smaller when close.
const tmpV = new THREE.Vector3();
function scaleMarkers() {
  camera.getWorldPosition(tmpV);
  for (const { mesh } of markers.values()) {
    const d = mesh.position.distanceTo(tmpV);
    const r = THREE.MathUtils.clamp(0.012 * d, 0.02, 0.15);              // world radius, ~0.7° of view
    mesh.scale.setScalar((mesh.userData.baseScale ?? 1) * (mesh.userData.playing ? 1.3 : mesh.userData.hover ? 1.15 : 1) * r / MARKER_RADIUS);
  }
}

let playingId = null;
function stopAll() {
  for (const other of markers.values()) {
    if (other.sound.isPlaying) other.sound.stop();
    other.mesh.userData.playing = false;
    other.mesh.material.emissiveIntensity = 0.35;
  }
  playingId = null;
  renderList();
}
function play(id) {
  const m = markers.get(id);
  if (!m || !m.sound.buffer) return;
  if (listener.context.state === 'suspended') listener.context.resume();
  if (playingId === id) { stopAll(); setStatus('■ stopped'); return; }   // click the playing marker again to stop
  stopAll();
  m.sound.onEnded = () => { m.sound.isPlaying = false; if (playingId === id) { playingId = null; m.mesh.userData.playing = false; m.mesh.material.emissiveIntensity = 0.35; renderList(); } };
  m.sound.play();
  playingId = id;
  m.mesh.userData.playing = true;
  m.mesh.material.emissiveIntensity = 1.0;
  renderList();
  setStatus(`▶ ${m.record.author} · ${m.record.layer}${m.record.anchor.objectId ? ' · ' + m.record.anchor.objectId : ''} · ${fmtDur(m.record.durationMs)}`);
}

async function deleteAnnotation(id) {
  if (!project || !markers.has(id)) return;
  try {
    await annotationsApi.remove(project.id, id);   // server broadcasts annotation:deleted, which removes the marker
    removeMarker({ id });
    setStatus('deleted');
  } catch (e) { setStatus('delete failed: ' + e.message); }
}

// Hover: the marker under the crosshair (desktop) or either controller ray (XR)
let hoverId = null;
function updateHover() {
  let id = null;
  if (renderer.xr.isPresenting) { for (const c of xrControllers) { id = aimMarker(c); if (id) break; } }
  else if (lock.isLocked) id = aimMarker(camera);
  if (id === hoverId) return;
  const prev = markers.get(hoverId);
  if (prev) { prev.mesh.userData.hover = false; prev.mesh.material.emissiveIntensity = prev.mesh.userData.playing ? 1.0 : 0.35; }
  hoverId = id;
  const cur = markers.get(id);
  if (cur) { cur.mesh.userData.hover = true; if (!cur.mesh.userData.playing) cur.mesh.material.emissiveIntensity = 0.8; }
  crosshair.classList.toggle('hover', !!id);
  if (cur && !recorder.isRecording) setStatus(`${cur.record.author} · ${cur.record.layer} · ${fmtDur(cur.record.durationMs)} — click to ${cur.record.id === playingId ? 'stop' : 'play'}`);
  else if (!id && !recorder.isRecording && !playingId) setStatus('');
}

// HUD list of annotations in the current project
function renderList() {
  const ul = hud.annList;
  ul.innerHTML = '';
  const items = [...markers.values()].sort((a, b) => a.record.createdAt < b.record.createdAt ? 1 : -1);
  for (const { record } of items) {
    const li = document.createElement('li');
    li.className = (record.id === playingId ? 'playing ' : '') + (record.layer === hud.layer.value ? '' : 'dim');
    li.innerHTML = `<button class="play" title="play">${record.id === playingId ? '■' : '▶'}</button><span class="who">${esc(record.author)}</span><span class="meta">${esc(record.layer)} · ${fmtDur(record.durationMs)}${record.anchor.objectId ? ' · ' + esc(record.anchor.objectId) : ''}</span><button class="del" title="delete">✕</button>`;
    li.querySelector('.play').addEventListener('click', () => play(record.id));
    li.querySelector('.del').addEventListener('click', () => deleteAnnotation(record.id));
    li.addEventListener('mouseenter', () => { const m = markers.get(record.id); if (m) m.mesh.material.emissiveIntensity = 0.9; });
    li.addEventListener('mouseleave', () => { const m = markers.get(record.id); if (m && !m.mesh.userData.playing) m.mesh.material.emissiveIntensity = 0.35; });
    ul.appendChild(li);
  }
}

// ---- recording -------------------------------------------------------------

const recorder = new VoiceRecorder();
const cursor = new THREE.Mesh(new THREE.SphereGeometry(MARKER_RADIUS * 1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3333, wireframe: true }));
cursor.visible = false;
scene.add(cursor);
let anchorSource = null;             // Object3D whose aim decides the anchor while recording

async function beginRecording(source) {
  if (recorder.isRecording) return;
  if (!project) return setStatus('no project');
  if (!hud.author.value.trim()) return setStatus('enter your name first');
  if (!hud.consent.checked) return setStatus('tick consent first');
  try { await recorder.start(); } catch (e) { return setStatus('mic blocked: ' + e.message); }
  anchorSource = source;
  cursor.visible = true;
  hud.rec.classList.add('on'); crosshair.classList.add('rec');
  setStatus('recording… (' + hud.layer.value + ')');
}

async function endRecording() {
  if (!recorder.isRecording) return;
  const { point: anchor, objectId } = aimPoint(anchorSource);
  const clip = await recorder.stop();
  cursor.visible = false;
  hud.rec.classList.remove('on'); crosshair.classList.remove('rec');
  if (!clip) return setStatus('too short, discarded');
  setStatus('saving…');
  try {
    const rec = await annotationsApi.create({
      project: project.id, ...clip, anchor, objectId, author: hud.author.value.trim(), layer: hud.layer.value, consent: true,
    });
    setStatus(`saved ${fmtDur(clip.durationMs)} at (${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}, ${anchor.z.toFixed(2)})${objectId ? ' on ' + objectId : ''}`);
    addMarker(rec);                  // local echo; server broadcast is deduped by id
  } catch (e) {
    setStatus('save failed: ' + e.message);
  }
}

// ---- aiming ----------------------------------------------------------------
// Where does a controller (or the desktop camera) point? Prefer a hit on an
// asset or the default room; fall back to a point a fixed distance ahead.

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.03;
raycaster.far = 30;
const tmpMat = new THREE.Matrix4();
const FALLBACK_AHEAD = { controller: 0.08, camera: 0.6 };

function aimRay(source) {
  tmpMat.identity().extractRotation(source.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(source.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat);
}
function aimMarker(source) {
  aimRay(source);
  const hit = raycaster.intersectObjects(markerGroup.children, false)[0];
  return hit?.object.userData.id || null;
}
function aimPoint(source) {
  aimRay(source);
  const targets = [];
  for (const e of loaded.values()) {
    if (!e.model || !e.group.visible || e.model.kind === 'splat') continue;
    if (e.model.kind === 'points' && e.model.count > 3_000_000) continue;   // brute-force raycast on huge clouds stalls the frame
    targets.push(e.model.object);
  }
  if (room.visible) targets.push(room);
  let hit = targets.length ? raycaster.intersectObjects(targets, true).find((h) => h.object.type !== 'GridHelper') || null : null;
  // Gaussian splats: our own cone test against sampled centres; keep whichever hit is nearest
  for (const e of loaded.values()) {
    if (!e.model?.hitTest || !e.group.visible) continue;
    const p = e.model.hitTest(raycaster.ray);
    if (!p) continue;
    const d = p.distanceTo(raycaster.ray.origin);
    if (!hit || d < hit.distance) hit = { point: p, object: e.model.object, distance: d };
  }
  if (hit) {
    // name the thing that was hit: the mesh's own name, unless it is a generic
    // exporter name (mesh_0, Object_12, node3…), in which case the asset's name
    let o = hit.object, name = o.name;
    while (!name && o.parent && o.parent !== scene) { o = o.parent; name = o.name; }
    if (!name || /^(mesh|object|node|group|geometry|default|scene)[_\-]?\d*$/i.test(name)) {
      let g = hit.object; while (g && g.parent !== assetsRoot) g = g.parent;
      if (g?.name) name = g.name.replace(/\.[^.]+$/, '');                 // asset file name without extension
    }
    return { point: hit.point.clone(), objectId: name || undefined };
  }
  const ahead = source === camera ? FALLBACK_AHEAD.camera : FALLBACK_AHEAD.controller;
  return { point: raycaster.ray.at(ahead, new THREE.Vector3()), objectId: undefined };
}

// ---- XR controllers --------------------------------------------------------

const controllerModelFactory = new XRControllerModelFactory();
const xrControllers = [];
for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  xrControllers.push(ctrl);
  ctrl.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 }),
  ));
  ctrl.addEventListener('selectstart', () => {
    const hit = aimMarker(ctrl);
    if (hit) play(hit); else beginRecording(ctrl);
  });
  ctrl.addEventListener('selectend', () => { if (recorder.isRecording && anchorSource === ctrl) endRecording(); });
  ctrl.addEventListener('squeezestart', () => {
    const next = LAYERS[(LAYERS.indexOf(hud.layer.value) + 1) % LAYERS.length];
    hud.layer.value = next; hud.layer.dispatchEvent(new Event('change'));
    setStatus('layer: ' + next);
  });
  rig.add(ctrl);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  rig.add(grip);
}

// ---- desktop fallback ------------------------------------------------------

const lock = new PointerLockControls(camera, renderer.domElement);
const crosshair = document.getElementById('crosshair');
// First click captures the mouse. After that the mouse button works like the
// controller trigger: hold to record at the crosshair, release to save, and a
// click on a marker plays it instead of recording.
renderer.domElement.addEventListener('mousedown', (e) => {
  if (renderer.xr.isPresenting || e.button !== 0) return;
  if (!lock.isLocked) { lock.lock(); return; }
  const hit = aimMarker(camera);
  if (hit) play(hit); else beginRecording(camera);
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (e.button === 0 && recorder.isRecording && anchorSource === camera) endRecording();
});
document.addEventListener('pointerlockchange', () => {
  crosshair.hidden = !lock.isLocked;
  if (!lock.isLocked && recorder.isRecording && anchorSource === camera) endRecording();   // Esc mid-recording still saves
});
const keys = new Set();
let pendingDelete = null;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (e.code === 'KeyK') beginRecording(camera);
  if (e.code === 'KeyL') endRecording();
  if (e.code === 'Space') { const hit = aimMarker(camera); if (hit) play(hit); }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    const hit = aimMarker(camera);
    if (!hit) return;
    if (pendingDelete === hit) { pendingDelete = null; deleteAnnotation(hit); }
    else { pendingDelete = hit; setStatus('press Delete again to delete this annotation'); setTimeout(() => { if (pendingDelete === hit) pendingDelete = null; }, 2500); }
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---- network ---------------------------------------------------------------

const net = connect({
  onAll: (all) => { clearMarkers(); all.forEach(addMarker); setStatus(`loaded ${markers.size}`); },
  onNew: (a) => a.project === project?.id && addMarker(a),
  onDeleted: removeMarker,
  onProjectUpdated: async (p) => {
    refreshProjectList();
    if (p.id !== project?.id) return;
    const key = (x) => JSON.stringify((x.assets || []).map((a) => [a.id, a.url, a.visible, a.options]));
    const changed = key(p) !== key(project);
    project = p;
    if (changed) await showAssets(p);
    else { for (const a of p.assets || []) { const e = loaded.get(a.id); if (e) e.asset = a; } renderAssets(); }
  },
  onProjectsChanged: refreshProjectList,
  onStatus: (s) => { setStatus(s); if (s === 'connected' && project) net.join(project.id); },
});

// dev-only handle for poking at the scene from the console
if (import.meta.env.DEV) window.__glossy = { scene, renderer, camera, assetsRoot, loaded, markers, get project() { return project; }, get selected() { return selected(); }, autoFit, frameAll, applyTransform, aimPoint, aimMarker, lock };

// ---- boot ------------------------------------------------------------------

(async () => {
  const list = await refreshProjectList();
  const wanted = new URLSearchParams(location.search).get('project');
  const first = list.find((p) => p.id === wanted) || list[0];
  if (first) await openProject(first.id);
})();

// ---- loop ------------------------------------------------------------------

const clock = new THREE.Clock();
const near = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (!renderer.xr.isPresenting && lock.isLocked) {
    const speed = (keys.has('ShiftLeft') ? 5 : 2) * dt;
    if (keys.has('KeyW')) lock.moveForward(speed);
    if (keys.has('KeyS')) lock.moveForward(-speed);
    if (keys.has('KeyA')) lock.moveRight(-speed);
    if (keys.has('KeyD')) lock.moveRight(speed);
    if (keys.has('KeyE')) camera.position.y += speed;
    if (keys.has('KeyQ')) camera.position.y -= speed;
  }

  if (recorder.isRecording && anchorSource) cursor.position.copy(aimPoint(anchorSource).point);
  updateHover();
  scaleMarkers();

  // proximity playback for the active layer: walk up to a marker and it plays
  camera.getWorldPosition(near);
  for (const { mesh, sound, record } of markers.values()) {
    if (record.layer !== hud.layer.value || !sound.buffer) continue;
    const d = mesh.position.distanceTo(near);
    if (d < PLAY_DISTANCE && !sound.isPlaying && !mesh.userData.played) { mesh.userData.played = true; play(record.id); }
    if (d > PLAY_DISTANCE * 1.5) mesh.userData.played = false;
  }

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
