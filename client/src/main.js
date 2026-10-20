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
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { HandTrace, GhostHands, describeHands } from './hands.js';
import { createSessionLog, createStatsSampler } from './session-log.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { VoiceRecorder } from './recorder.js';
import { connect, projects as projectsApi, assets as assetsApi, annotations as annotationsApi } from './api.js';
import { loadModel, SUPPORTED_EXTENSIONS } from './loaders.js';
import { unclearReason, UNCLEAR_TEXT, langName } from '../../shared/text.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// BVH-accelerated raycasts for every mesh: anchoring, hover, and collision
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---- config ----------------------------------------------------------------

const LAYERS = ['default', 'draft', 'review', 'final'];
const MARKER_RADIUS = 0.06;
const PLAY_DISTANCE = 1.2;                        // metres; within this a marker is "near": previewed and lit, played on click (or on approach with autoplay on)
const BLOOM_MS = 450;
const QUIET_PEAK = 0.05;          // recording peak (RMS × 4) below which a clip is reported as near-silent                             // the commit cue: a saved marker swells and glows for this long
const DELETE_ARM_MS = 2500;                       // erase asks twice; the second press must come within this window
// A crowded room stays readable: only the nearest MAX_FULL markers within
// FULL_DISTANCE draw at full size; the rest are abstracted to small faint
// dots until approached. Nothing is hidden by this rule.
const MAX_FULL = 40;
let fullDistance = 4.5;                           // set from the scene's size in updateFullDistance()
const OLD_AFTER_DAYS = 180;                       // clips older than this are drawn a little dimmer
const DEFAULT_TRANSFORM = { scale: 1, rotX: 0, rotY: 0, rotZ: 0, x: 0, y: 0, z: 0, pointSize: 0.01 };

// ---- HUD -------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
// Session log: the moments below are posted to the server per project and session (client/src/session-log.js)
const log = createSessionLog();
const stats = createStatsSampler();
const handsSummary = (h) => h?.frames?.length ? { frames: h.frames.length, ms: h.frames.at(-1).t - h.frames[0].t, lost: { l: h.frames.filter((f) => !f.l || f.lf).length, r: h.frames.filter((f) => !f.r || f.rf).length }, filled: h.filled ? { l: h.filled.l, r: h.filled.r } : undefined } : null;
// Visitor mode (?mode=visitor): the page an exhibition guest sees. Operator
// controls (projects, assets, layers, language, the script editor, erase) are
// hidden, the project's script is asked without a toggle, and nothing can be
// erased from this page. It is a presentation setting, not access control.
const VISITOR = new URLSearchParams(location.search).get('mode') === 'visitor';
document.body.classList.toggle('visitor', VISITOR);
log('session:start', { ua: navigator.userAgent.slice(0, 200), visitor: VISITOR, viewport: [innerWidth, innerHeight], href: location.pathname + location.search });
const hud = {
  project: $('project'), newProject: $('newProject'), modelInfo: $('modelInfo'),
  author: $('author'), layer: $('layer'), consent: $('consent'), status: $('statusText'), rec: $('rec'), count: $('count'),
  assetList: $('assetList'), assetFile: $('assetFile'), uploadProgress: $('uploadProgress'), exportLink: $('exportLink'), edmLink: $('edmLink'), annList: $('annList'),
  t: { scale: $('tScale'), rotX: $('tRotX'), rotY: $('tRotY'), rotZ: $('tRotZ'), x: $('tX'), y: $('tY'), z: $('tZ'), pointSize: $('tPointSize') },
  zUp: $('zUp'), autoFit: $('autoFit'), resetFit: $('resetFit'), saveTransform: $('saveTransform'), selectedName: $('selectedName'),
  walk: $('walk'), autoplay: $('autoplay'), voiceStart: $('voiceStart'), ghostStyle: $('ghostStyle'), ghostTrail: $('ghostTrail'), reviewLink: $('reviewLink'), language: $('language'), timeAll: $('timeAll'), year: $('year'), yearLabel: $('yearLabel'), periodBands: $('periodBands'),
  interview: $('interview'), visitorLink: $('visitorLink'), question: $('question'), level: $('level'), levelBar: $('levelBar'), hint: $('hint'), prevQ: $('prevQ'), askQ: $('askQ'), nextQ: $('nextQ'), scriptText: $('scriptText'), saveScript: $('saveScript'),
};
const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
hud.author.value = ls.get('glossy.author', '');
hud.layer.value = ls.get('glossy.layer', 'default');
hud.consent.checked = ls.get('glossy.consent', '0') === '1';
hud.author.addEventListener('change', () => ls.set('glossy.author', hud.author.value));
hud.layer.addEventListener('change', () => ls.set('glossy.layer', hud.layer.value));
hud.consent.addEventListener('change', () => { ls.set('glossy.consent', hud.consent.checked ? '1' : '0'); if (hud.consent.checked) readyMic(); });
// The microphone is asked for here, on the flat page, in the gesture that ticks
// consent: a permission prompt that first appears inside an immersive session
// may not be seen (Quest Browser), and the first clip would be lost to it. With
// consent already ticked from an earlier visit, the first click on the page does it.
let micState = 'unasked';            // unasked | asking | ready | blocked | ended
async function readyMic() {
  if (micState === 'ready' || micState === 'asking') return;
  micState = 'asking';
  try { await recorder.init(); attachLevel(recorder.stream); micState = 'ready'; setStatus('microphone ready', { hold: 1500 }); log('mic:ready'); }
  catch (e) { micState = 'blocked'; setStatus('microphone blocked: ' + e.message, { hold: 4000 }); log('mic:error', { error: e.message }); }
}
if (hud.consent.checked) document.addEventListener('pointerdown', () => readyMic(), { once: true });
hud.walk.checked = ls.get('glossy.walk', '1') === '1';
hud.walk.addEventListener('change', () => ls.set('glossy.walk', hud.walk.checked ? '1' : '0'));
hud.autoplay.checked = ls.get('glossy.autoplay', '0') === '1';
hud.voiceStart.checked = ls.get('glossy.voiceStart', '1') === '1';
hud.voiceStart.addEventListener('change', () => ls.set('glossy.voiceStart', hud.voiceStart.checked ? '1' : '0'));
hud.autoplay.addEventListener('change', () => ls.set('glossy.autoplay', hud.autoplay.checked ? '1' : '0'));
hud.interview.checked = ls.get('glossy.interview', '0') === '1';
hud.interview.addEventListener('change', () => { ls.set('glossy.interview', hud.interview.checked ? '1' : '0'); renderInterview(); });
// Status line. A message with `hold` stays on screen for that long against
// idle refreshes (hover and approach text), so "saved" is actually seen even
// when the new marker sits under the crosshair. Explicit messages always win.
let statusHeldUntil = 0;
const setStatus = (t, { hold = 0, idle = false } = {}) => {
  if (idle && performance.now() < statusHeldUntil) return;
  hud.status.textContent = t;
  statusHeldUntil = hold ? performance.now() + hold : 0;
  if (hold) setTimeout(refreshIdleStatus, hold + 20);   // then let hover or approach text take over
};
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDur = (ms) => (ms ? (ms / 1000).toFixed(1) + 's' : '');
const snippet = (t, n = 70) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);
// When a clip is from: its period label if it has one, otherwise how long ago it was recorded.
const whenOf = (r) => {
  if (r.period) return r.period.label || [r.period.from, r.period.to].filter(Boolean).join('–');
  const days = Math.floor((Date.now() - Date.parse(r.createdAt)) / 86400e3);
  if (!(days >= 0)) return '';
  return days < 1 ? 'today' : days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : days < 365 ? `${Math.max(1, Math.floor(days / 30))} months ago` : `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`;
};
// One line about a clip for the status row: author · when · layer (unless default) · length · first words.
const linksOf = (r) => { const n = (r.links || []).length; return n ? `${n} ${(r.links || []).every((l) => l.kind === 'image') ? 'photo' : 'attachment'}${n === 1 ? '' : 's'}` : ''; };
const spokenText = (r) => (r.transcript && !unclearReason(r.transcript) ? r.transcript : '');   // older records may hold a loop the guard now catches
const describeRecord = (r) => [r.author, whenOf(r), r.layer !== 'default' ? r.layer : '', fmtDur(r.durationMs), linksOf(r), r.hands ? 'gesture' : '', spokenText(r) ? '“' + snippet(spokenText(r)) + '”' : ''].filter(Boolean).join(' · ');

// ---- renderer / scene ------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.addEventListener('sessionstart', () => log('xr:start'));
renderer.xr.addEventListener('sessionend', () => log('xr:end'));
document.body.appendChild(renderer.domElement);
const vrButton = VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] });   // hands, when the headset tracks them, are part of a clip
document.body.appendChild(vrButton);
// a desktop without a headset gets no "VR NOT SUPPORTED" sign; the help text says where VR is
(navigator.xr ? navigator.xr.isSessionSupported('immersive-vr').catch(() => false) : Promise.resolve(false)).then((ok) => { if (!ok) vrButton.style.setProperty('display', 'none', 'important'); });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(0, 1.6, 2);
camera.lookAt(0, 0.9, -1.2);          // frame the table on first load
const listener = new THREE.AudioListener();
camera.add(listener);

// ---- in-headset panel --------------------------------------------------------
// The HUD does not exist in the headset. A small canvas panel fixed below the
// line of sight carries the current question and the status line (recording,
// saved, the near clip's preview) so a guest in a Quest has the same cues as a
// desktop user. It is redrawn only when its text changes and hidden when empty.
const xrPanel = (() => {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 384;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.1875), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  mesh.position.set(0, -0.22, -0.9); mesh.rotation.x = -0.25; mesh.renderOrder = 999; mesh.visible = false;
  camera.add(mesh);
  let shown = '';
  const wrap = (text, max) => { const lines = []; let cur = ''; for (const w of String(text).split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (cur && ctx.measureText(t).width > max) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines; };
  function draw(question, statusText, hint, recording, level = 0) {
    const key = [question, statusText, hint, recording ? 'R' : '', recording ? Math.round(level * 10) : ''].join('\n');
    if (key === shown) return;
    shown = key;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!question && !statusText && !hint) { mesh.visible = false; tex.needsUpdate = true; return; }
    ctx.fillStyle = recording ? 'rgba(70,0,0,0.7)' : 'rgba(0,0,0,0.62)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(0, 0, canvas.width, canvas.height, 28); else ctx.rect(0, 0, canvas.width, canvas.height); ctx.fill();
    let y = 72;
    if (question) { ctx.fillStyle = '#fff'; ctx.font = '600 46px system-ui, sans-serif'; for (const l of wrap(question, canvas.width - 80).slice(0, 3)) { ctx.fillText(l, 40, y); y += 56; } y += 8; }
    if (statusText) { ctx.fillStyle = recording ? '#ff6b6b' : '#9f9'; ctx.font = '40px system-ui, sans-serif'; for (const l of wrap(statusText, canvas.width - 80).slice(0, 2)) { ctx.fillText(l, 40, y); y += 50; } }
    if (hint) { ctx.fillStyle = '#9ab'; ctx.font = '30px system-ui, sans-serif'; ctx.fillText(hint, 40, canvas.height - 34); }
    if (recording) { ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(40, canvas.height - 14, canvas.width - 80, 6); ctx.fillStyle = '#ff6b6b'; ctx.fillRect(40, canvas.height - 14, (canvas.width - 80) * Math.min(1, level), 6); }
    tex.needsUpdate = true; mesh.visible = true;
  }
  return { mesh, draw, get text() { return shown; } };
})();
function updateXrPanel() {
  if (!renderer.xr.isPresenting) { if (xrPanel.mesh.visible) xrPanel.draw('', '', '', false); return; }
  const qs = questions(), q = currentQuestion();
  const question = q ? `${qIndex + 1}/${qs.length} · ${q.text}` : qs.length && qIndex >= qs.length ? 'all questions answered' : '';
  const hands = handsPresent();
  const act = hands ? (hud.voiceStart.checked ? 'pinch, or just speak, to answer' : 'pinch and hold to answer') : 'hold the trigger to answer';
  let hint = q ? (VISITOR && !hands ? 'squeeze: hear the question · ' + act : act) : hands && hud.voiceStart.checked ? 'speak to leave a clip where you look · pinch to hold one' : '';
  if (micState !== 'ready' && !recorder.isRecording) hint = micState === 'blocked' ? 'microphone blocked: leave VR and allow it in the browser' : micState === 'ended' ? 'microphone stopped while the headset slept: pinch, or speak, to open it again' : 'microphone not yet allowed: tick consent on the page before entering VR';
  xrPanel.draw(question, hud.status.textContent, hint, hud.rec.classList.contains('on'), level);
}

// The one-line key hint under the status, changing with state. Empty in the
// headset, where the panel carries its own hints.
let shownHint = null;
function renderHint() {
  let h = '';
  if (renderer.xr.isPresenting) h = '';
  else if (recorder.isRecording || starting) h = 'release to save · Esc also saves';
  else if (!captured()) h = 'click the scene to take the mouse';
  else if (hoverId) h = `click: play · hold R: reply${VISITOR ? '' : ' · Delete ×2: erase'}`;
  else h = 'hold the mouse button: record here · walk up to a marker to read it · W A S D: move';
  if (h !== shownHint) { shownHint = h; hud.hint.textContent = h; }
}

// Microphone level while recording, from an analyser on the capture stream,
// shown as a bar in the HUD and on the headset panel. The timer is in the
// status text ("recording… 3s").
let level = 0, levelNode = null, levelData = null, levelSrc = null, recStatusBase = '', recSecs = -1, recPeak = 0;
function measureLevel() {
  if (!levelNode) return 0;
  levelNode.getByteTimeDomainData(levelData);
  let s = 0; for (let i = 0; i < levelData.length; i++) { const v = (levelData[i] - 128) / 128; s += v * v; }
  return Math.min(1, Math.sqrt(s / levelData.length) * 4);
}
function updateLevel() {
  if (!recorder.isRecording) { if (level) { level = 0; hud.levelBar.style.width = '0%'; } hud.level.classList.remove('on'); return; }
  if (levelNode) {
    level = measureLevel();
    recPeak = Math.max(recPeak, level);
  }
  hud.level.classList.add('on');
  hud.levelBar.style.width = `${Math.round(level * 100)}%`;
  const secs = Math.floor((performance.now() - recorder.startedAt) / 1000);
  if (secs !== recSecs) { recSecs = secs; setStatus(`${recStatusBase} ${secs}s`); }
}

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
  for (const e of loaded.values()) {
    e.model?.object.traverse((o) => o.geometry?.boundsTree && o.geometry.disposeBoundsTree());
    assetsRoot.remove(e.group); e.model?.dispose();
  }
  loaded.clear();
  const list = p.assets || [];
  const isScene = (a) => !['image', 'video'].includes(a.type) || a.options?.mode === 'sphere';   // a photo linked to a clip hangs in the room; it is not the room
  room.visible = !list.some(isScene);
  floorGrid.visible = !room.visible;
  selectedId = list.some((a) => a.id === selectedId) ? selectedId : (list[0]?.id ?? null);
  renderAssets();
  await Promise.all(list.map((a, i) => loadAsset(a, i)));
  frameAll();
  updateFullDistance();
  renderAssets();
  assetsReady = true;
  if (focusId && markers.has(focusId)) { focusMarker(focusId); focusId = null; }   // the clip picked on the review page wins over framing
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
    if (entry.model.kind === 'mesh' && entry.model.imageMode !== 'sphere') {
      entry.model.object.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position && !o.geometry.boundsTree) o.geometry.computeBoundsTree(); });
    }
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
  if (hud.walk.checked && spawnInside()) return;        // walkable scene: start on the floor inside it, not outside looking in
  assetsRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const e of loaded.values()) {
    if (!e.model || !e.group.visible || e.model.imageMode) continue;      // panoramas surround the camera and flat photos hang at clips: neither frames the view
    const b = e.model.box.clone().applyMatrix4(e.group.matrixWorld);
    if (Number.isFinite(b.min.x)) box.union(b);
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const dist = Math.max(2, Math.max(size.x, size.y, size.z) * 1.1);
  camera.position.set(c.x, Math.max(1.6, c.y), c.z + dist);
  camera.lookAt(c.x, c.y, c.z);
}

// Put the camera inside the largest walkable mesh asset, on its floor.
function spawnInside() {
  let best = null, bestVol = 0;
  for (const e of loaded.values()) {
    if (!e.model || e.model.kind !== 'mesh' || e.model.imageMode || !e.group.visible) continue;
    const b = e.model.box.clone().applyMatrix4(e.group.matrixWorld), s = b.getSize(new THREE.Vector3());
    const vol = s.x * s.y * s.z;
    if (s.x > 2 && s.z > 2 && s.y > 1.5 && vol > bestVol) { best = b; bestVol = vol; }   // room-sized
  }
  if (!best) return false;
  const c = best.getCenter(new THREE.Vector3()), size = best.getSize(new THREE.Vector3());
  // Probe a grid of points, nearest-to-centre first, and take the first one whose
  // "floor" is actually the floor (within 30 cm of the scene's lowest point) with
  // standing headroom. The exact centre of a room is often a table.
  const probes = [];
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) probes.push([c.x + i * size.x / 10, c.z + j * size.z / 10]);
  probes.sort((p, q) => (p[0] - c.x) ** 2 + (p[1] - c.z) ** 2 - ((q[0] - c.x) ** 2 + (q[1] - c.z) ** 2));
  const probe = new THREE.Vector3();
  for (const [x, z] of probes) {
    probe.set(x, best.min.y + EYE_HEIGHT + 0.3, z);      // start just above where a standing eye would be
    const floor = floorBelow(probe);
    if (floor === null || floor > best.min.y + 0.3) continue;
    if (!headroom(x, floor, z)) continue;
    camera.position.set(x, floor + EYE_HEIGHT, z);
    camera.lookAt(c.x === x && c.z === z ? x + 1 : c.x, floor + EYE_HEIGHT, c.z === z && c.x === x ? z : c.z);
    return true;
  }
  camera.position.set(c.x, best.max.y - 0.2, c.z);      // nothing qualified: drop in and let floor-following settle
  camera.lookAt(c.x + 1, camera.position.y, c.z);
  return true;
}
// is there clear space from the floor up to eye height at this spot?
function headroom(x, floorY, z) {
  const targets = collidables(); if (!targets.length) return true;
  _from.set(x, floorY + 0.05, z);
  walkRay.set(_from, new THREE.Vector3(0, 1, 0)); walkRay.far = EYE_HEIGHT + 0.2;
  return !walkRay.intersectObjects(targets, true).some((h) => h.object.type !== 'GridHelper');
}

// ---- walking: floor-following and wall collision (desktop) ----------------
const EYE_HEIGHT = 1.6, BODY_RADIUS = 0.35, STEP_UP = 0.4;
const walkRay = new THREE.Raycaster();
walkRay.firstHitOnly = true;                            // three-mesh-bvh: stop at the nearest hit
const _down = new THREE.Vector3(0, -1, 0), _from = new THREE.Vector3(), _dir = new THREE.Vector3(), _n = new THREE.Vector3();

function collidables() {
  const out = [];
  for (const e of loaded.values()) if (e.model?.kind === 'mesh' && !e.model.imageMode && e.group.visible) out.push(e.model.object);
  if (room.visible) out.push(room);
  return out;
}
// floor height under a point, searching from knee height upward so small steps are climbable
function floorBelow(pos) {
  const targets = collidables(); if (!targets.length) return null;
  _from.set(pos.x, pos.y - EYE_HEIGHT + STEP_UP, pos.z);
  walkRay.set(_from, _down); walkRay.far = 4;
  const hit = walkRay.intersectObjects(targets, true).find((h) => h.object.type !== 'GridHelper');
  return hit ? hit.point.y : null;
}
// move horizontally by `delta`, sliding along walls
function walkMove(delta) {
  const targets = collidables();
  if (!targets.length || delta.lengthSq() === 0) { camera.position.add(delta); return; }
  let d = delta.clone();
  for (let pass = 0; pass < 2 && d.lengthSq() > 1e-10; pass++) {
    let blocked = null;
    for (const h of [0, -EYE_HEIGHT + 0.5]) {           // probe at eye level and at hip level
      _from.copy(camera.position); _from.y += h;
      _dir.copy(d).normalize();
      walkRay.set(_from, _dir); walkRay.far = d.length() + BODY_RADIUS;
      const hit = walkRay.intersectObjects(targets, true).find((x) => x.object.type !== 'GridHelper');
      if (hit && (!blocked || hit.distance < blocked.distance)) blocked = hit;
    }
    if (!blocked) { camera.position.add(d); return; }
    _n.copy(blocked.face.normal).transformDirection(blocked.object.matrixWorld); _n.y = 0; _n.normalize();
    const allowed = Math.max(0, blocked.distance - BODY_RADIUS);
    camera.position.addScaledVector(_dir, allowed);
    d.sub(_n.multiplyScalar(d.dot(_n)));                // slide: drop the component into the wall
    d.multiplyScalar(0.98);
  }
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
    o.value = p.id; o.dataset.name = p.name; o.dataset.suffix = p.assets?.length ? ' · ' + p.assets.length + ' asset' + (p.assets.length === 1 ? '' : 's') : '';
    o.textContent = `${p.name} (${p.id === project?.id ? markers.size : p.annotationCount})${o.dataset.suffix}`;
    hud.project.appendChild(o);
  }
  if (project) hud.project.value = project.id;
  return list;
}

async function openProject(id) {
  project = await projectsApi.get(id);
  hud.project.value = id;
  hud.exportLink.href = `/api/projects/${id}/export`;
  hud.edmLink.href = `/api/projects/${id}/export?format=edm`;
  history.replaceState(null, '', `?project=${id}${VISITOR ? '&mode=visitor' : ''}`);
  hud.visitorLink.href = `?project=${id}&mode=visitor`;
  hud.reviewLink.href = `/review.html?project=${id}`;
  log.setProject(id); log('project:open', { id, name: project.name, assets: (project.assets || []).length });
  selectedId = null;
  clearMarkers();
  net.join(id);
  projectToHud({ fresh: true });
  await showAssets(project);
}

// per-project settings in the HUD: transcription language and the interview script.
// Called on project open and when another client changes the settings; the
// question position is kept unless the questions themselves changed, and a
// textarea being edited is left alone.
let shownScript = null;
function projectToHud({ fresh = false } = {}) {
  hud.language.value = project?.language || '';
  const scriptKey = JSON.stringify((project?.script?.questions || []).map((q) => q.text));
  if (fresh || scriptKey !== shownScript) {
    if (document.activeElement !== hud.scriptText) hud.scriptText.value = (project?.script?.questions || []).map((q) => q.text).join('\n');
    qIndex = 0;
    shownScript = scriptKey;
    if (project?.script?.questions?.length || VISITOR) $('interviewPanel').open = true;   // a script arriving, or a scripted project opening, shows its questions
  }
  renderInterview();
}
hud.language.addEventListener('change', async () => {
  if (!project) return;
  try {
    project = await projectsApi.update(project.id, { language: hud.language.value || null });
    setStatus(hud.language.value ? 'transcription language: ' + hud.language.value : 'transcription language: detect');
  } catch (e) { hud.language.value = project.language || ''; setStatus('language not saved: ' + e.message); }
});
hud.saveScript.addEventListener('click', async () => {
  if (!project) return;
  const questions = hud.scriptText.value.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
  project = await projectsApi.update(project.id, { script: questions.length ? { questions } : null });
  qIndex = 0; renderInterview();
  setStatus(questions.length ? `saved ${questions.length} question${questions.length === 1 ? '' : 's'}` : 'script cleared');
});

// ---- interview mode ---------------------------------------------------------
// The project's script is a list of questions. With interview mode on, the HUD
// shows one at a time, "Ask" reads it aloud, and every clip recorded answers
// the current question (stored as `prompt`, mode 'interview'). Saving a clip
// advances to the next question.

let qIndex = 0;
const interviewOn = () => VISITOR || hud.interview.checked;     // a visitor is asked the script without a toggle
const questions = () => (interviewOn() && project?.script?.questions) || [];
const currentQuestion = () => questions()[qIndex] || null;
function renderInterview() {
  const qs = questions();
  const q = currentQuestion();
  hud.question.textContent = !project?.script?.questions?.length ? (VISITOR ? '' : 'no script: add questions below')
    : !interviewOn() ? `${project.script.questions.length} question${project.script.questions.length === 1 ? '' : 's'} (tick to start)`
    : q ? `${qIndex + 1}/${qs.length} · ${q.text}` : 'all questions answered';
  hud.prevQ.disabled = !qs.length || qIndex === 0;
  hud.nextQ.disabled = !qs.length || qIndex >= qs.length;
  hud.askQ.disabled = !q;
}
function stepQuestion(d) { const n = questions().length; qIndex = Math.max(0, Math.min(n, qIndex + d)); log('question:step', { index: qIndex }); renderInterview(); }
hud.prevQ.addEventListener('click', () => stepQuestion(-1));
hud.nextQ.addEventListener('click', () => stepQuestion(1));
// Read the question aloud with the browser's speech synthesis where it exists.
// Never while the microphone is open: the headset speakers leak into its mic.
function speak(text) {
  if (!text) return 'nothing';
  if (recorder.isRecording || starting) return 'muted';
  if (!('speechSynthesis' in window)) return 'unavailable';
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (project?.language) u.lang = project.language;
  speechSynthesis.speak(u);
  return 'ok';
}
let lastAsked = null;
function askCurrent() {
  const q = currentQuestion(); if (!q) return;
  lastAsked = q.text;
  const r = speak(q.text);
  log('question:ask', { index: qIndex, result: r });
  if (r === 'muted') setStatus('finish recording first; the question is not read while the microphone is open');
  else if (r === 'unavailable') setStatus('speech synthesis unavailable here; read the question from the panel');
}
hud.askQ.addEventListener('click', askCurrent);

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
// Colour says when. A period's midpoint maps from amber (the project's earliest
// year) to blue (its latest); timeless clips are grey; clips older than
// OLD_AFTER_DAYS are desaturated. Layer is text in the operator's list, not a
// colour, because a visitor cannot read it.
const TIMELESS = new THREE.Color(0xb6bcc4);
let yearBounds = { min: NaN, max: NaN };
function markerColor(record) {
  const old = Date.parse(record.createdAt) < Date.now() - OLD_AFTER_DAYS * 86400e3;
  if (!record.period) return TIMELESS.clone().multiplyScalar(old ? 0.7 : 1);
  const a = yearOf(record.period.from, NaN), b = yearOf(record.period.to, NaN);
  const mid = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : b;
  const span = yearBounds.max - yearBounds.min;
  const t = Number.isFinite(mid) && span > 0 ? THREE.MathUtils.clamp((mid - yearBounds.min) / span, 0, 1) : 0;
  return new THREE.Color().setHSL(0.08 + 0.52 * t, old ? 0.3 : 0.75, old ? 0.45 : 0.55);
}
function recolour(m) { const c = markerColor(m.record); m.mesh.material.color.copy(c); m.mesh.material.emissive.copy(c); }
const RING_GEO = new THREE.RingGeometry(MARKER_RADIUS * 1.5, MARKER_RADIUS * 1.8, 28);
const RING_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
// How far a marker may be and still draw in full: half the scene's diagonal,
// so a 6 m room and a 40 m courtyard both thin by distance.
function updateFullDistance() {
  const box = new THREE.Box3();
  for (const e of loaded.values()) if (e.model && e.group.visible && e.model.imageMode !== 'sphere') box.union(e.model.box.clone().applyMatrix4(e.group.matrixWorld));
  if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 3, 3));   // the default room
  fullDistance = Math.max(3, 0.5 * box.getSize(new THREE.Vector3()).length());
}

function addMarker(record) {
  if (markers.has(record.id)) return;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(MARKER_RADIUS, 20, 14),
    new THREE.MeshStandardMaterial({ color: markerColor(record), emissive: markerColor(record), emissiveIntensity: 0.35 }),
  );
  mesh.position.set(record.anchor.x, record.anchor.y, record.anchor.z);
  const isReply = !!record.parent && markers.has(record.parent);   // a reply whose parent is gone stands as a root
  if (isReply) {                                            // replies sit in a short column above their parent
    const n = [...markers.values()].filter((m) => m.record.parent === record.parent).length;
    mesh.position.y += 0.12 * (n + 1);
  }
  mesh.userData.id = record.id;
  markerGroup.add(mesh);
  mesh.userData.reply = isReply;
  const ring = new THREE.Mesh(RING_GEO, RING_MAT);        // the "full" state: a sphere with a ring; abstracted markers are bare dots
  ring.visible = false; ring.raycast = () => {};
  mesh.add(ring); mesh.userData.ring = ring;
  const sound = new THREE.PositionalAudio(listener);
  sound.setRefDistance(0.4);
  sound.setRolloffFactor(2);
  mesh.add(sound);
  audioLoader.load(record.audioUrl, (buffer) => sound.setBuffer(buffer));
  markers.set(record.id, { mesh, sound, record, dist: Infinity });
  frameNo = 0;                                              // re-rank on the next frame rather than up to ten frames later
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
function updateCount() {
  hud.count.textContent = `${markers.size} annotation${markers.size === 1 ? '' : 's'}`;
  const o = project && [...hud.project.options].find((o) => o.value === project.id);   // keep the selector's count in step
  if (o) o.textContent = `${o.dataset.name} (${markers.size})${o.dataset.suffix || ''}`;
}

function applyLayerFilter() {
  for (const { mesh, record } of markers.values()) {
    const active = VISITOR || record.layer === hud.layer.value;   // layers are an operator's working view; a visitor sees every clip alike
    mesh.material.opacity = active ? 1 : 0.25;
    mesh.material.transparent = true;
    mesh.userData.baseScale = active ? 1 : 0.7;
    mesh.userData.layerActive = active;
    mesh.visible = inTime(record);
  }
  updateYearBounds();
}
hud.layer.addEventListener('change', () => { applyLayerFilter(); renderList(); });

// ---- time as a navigation axis -----------------------------------------------
// Every record may carry a period {from, to}. With "all periods" unticked the
// year slider is the viewer's position in time: clips whose period includes
// the year stay, clips outside it disappear, and clips with no period are
// timeless and always stay.
const yearOf = (v, d) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : d; };
function inTime(record) {
  if (hud.timeAll.checked || !record.period) return true;
  const y = Number(hud.year.value);
  return yearOf(record.period.from, -Infinity) <= y && y <= yearOf(record.period.to, Infinity);
}
function updateYearBounds() {
  let min = Infinity, max = -Infinity;
  for (const { record } of markers.values()) {
    if (!record.period) continue;
    const a = yearOf(record.period.from, NaN), b = yearOf(record.period.to, NaN);
    if (Number.isFinite(a)) { min = Math.min(min, a); max = Math.max(max, a); }
    if (Number.isFinite(b)) { min = Math.min(min, b); max = Math.max(max, b); }
  }
  const has = Number.isFinite(min);
  hud.year.disabled = hud.timeAll.checked || !has;
  if (has) { hud.year.min = min; hud.year.max = max; if (Number(hud.year.value) < min || Number(hud.year.value) > max) hud.year.value = max; }
  if (`${min}-${max}` !== `${yearBounds.min}-${yearBounds.max}`) {        // the time scale moved: every colour is relative to it
    yearBounds = { min, max };
    for (const m of markers.values()) recolour(m);
  }
  renderBands();
  const vis = [...markers.values()].filter((m) => m.mesh.visible).length;
  if (hud.timeAll.checked) hud.yearLabel.textContent = has ? `${min}–${max}` : '';
  else {
    const y = Number(hud.year.value);
    const covering = distinctPeriods().filter(({ period }) => yearOf(period.from, -Infinity) <= y && y <= yearOf(period.to, Infinity)).map(({ period }) => periodLabelOf(period));
    hud.yearLabel.textContent = `${hud.year.value} · ${covering.length ? covering.join(', ') : 'between periods'} · ${vis}/${markers.size}`;
  }
}

// Period bands under the year slider: one bar per distinct period in the
// project, on the slider's scale and in the period's colour, so the viewer can
// see where the clips sit in time and when a year falls between periods.
const periodKey = (p) => `${p.from ?? ''}|${p.to ?? ''}|${p.label ?? ''}`;
const periodLabelOf = (p) => p.label || [p.from, p.to].filter(Boolean).join('–');
function distinctPeriods() {
  const seen = new Map();
  for (const { record } of markers.values()) {
    if (!record.period) continue;
    const k = periodKey(record.period), e = seen.get(k) || { period: record.period, n: 0 };
    e.n++; seen.set(k, e);
  }
  return [...seen.values()].sort((x, y) => yearOf(x.period.from, -Infinity) - yearOf(y.period.from, -Infinity));
}
let shownBands = null;
function renderBands() {
  const el = hud.periodBands, { min, max } = yearBounds, span = max - min;
  const periods = span > 0 ? distinctPeriods().slice(0, 12) : [];
  const key = `${min}-${max}:` + periods.map((p) => periodKey(p.period) + '#' + p.n).join(';');
  if (key === shownBands) return;
  shownBands = key;
  el.innerHTML = '';
  if (!periods.length) { el.hidden = true; return; }
  const lanes = [];                                       // overlapping periods stack in lanes instead of covering each other
  for (const { period, n } of periods) {
    const a = yearOf(period.from, min), b = yearOf(period.to, max);
    let lane = lanes.findIndex((end) => end <= a);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = b;
    const s = document.createElement('span');
    s.style.left = `${((a - min) / span) * 100}%`;
    s.style.width = `${Math.max(((b - a) / span) * 100, 1)}%`;
    s.style.top = `${lane * 10}px`;
    s.style.background = '#' + markerColor({ period, createdAt: new Date().toISOString() }).getHexString();
    s.title = `${periodLabelOf(period)} · ${a}–${b} · ${n} clip${n === 1 ? '' : 's'}`;
    s.textContent = periodLabelOf(period);
    el.appendChild(s);
  }
  el.style.height = `${lanes.length * 10}px`;
  el.hidden = false;
}
function applyTime() {
  for (const m of markers.values()) {
    m.mesh.visible = inTime(m.record);
    if (!m.mesh.visible && m.sound.isPlaying) { m.sound.stop(); if (playingId === m.record.id) stopAll(); }
  }
  updateYearBounds();
  renderList();
  if (!hud.timeAll.checked) setStatus(`year ${hud.year.value}: ${[...markers.values()].filter((m) => m.mesh.visible).length} of ${markers.size} clips in view`);
}
hud.timeAll.addEventListener('change', applyTime);
hud.year.addEventListener('input', applyTime);

// Markers keep a readable size on screen: bigger when far, smaller when close.
// In a crowded room only the nearest MAX_FULL within FULL_DISTANCE are drawn in
// full; the others become small faint dots (still there, still hoverable).
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
const fullSet = new Set();
let frameNo = 0;
function scaleMarkers() {
  camera.getWorldPosition(tmpV);
  if (frameNo++ % 10 === 0) {                                               // re-rank every tenth frame
    const ranked = [];
    for (const m of markers.values()) if (m.mesh.visible) { m.dist = m.mesh.position.distanceTo(tmpV); ranked.push(m); }
    ranked.sort((a, b) => a.dist - b.dist);
    fullSet.clear();
    for (const m of ranked) { if (fullSet.size >= MAX_FULL || m.dist > fullDistance) break; fullSet.add(m.record.id); }
    const cutoff = Date.now() - OLD_AFTER_DAYS * 86400e3;
    for (const m of markers.values()) {
      const full = fullSet.has(m.record.id) || m.mesh.userData.playing || m.mesh.userData.hover || m.dist < PLAY_DISTANCE * 1.5;
      m.mesh.userData.full = full;
      const old = Date.parse(m.record.createdAt) < cutoff;
      m.mesh.material.opacity = (m.mesh.userData.layerActive === false ? 0.25 : full ? 1 : 0.35) * (old ? 0.8 : 1);
      if (!m.mesh.userData.playing && !m.mesh.userData.hover && !m.mesh.userData.near && !m.mesh.userData.bloomUntil) m.mesh.material.emissiveIntensity = old ? 0.2 : 0.35;
    }
  }
  const now = performance.now();
  camera.getWorldQuaternion(tmpQ);
  for (const { mesh } of markers.values()) {
    const d = mesh.position.distanceTo(tmpV);
    const r = THREE.MathUtils.clamp(0.012 * d, 0.02, 0.15);              // world radius, ~0.7° of view
    const full = mesh.userData.full !== false;
    mesh.scale.setScalar((mesh.userData.baseScale ?? 1) * (mesh.userData.playing ? 1.3 : mesh.userData.hover ? 1.3 : full ? 1 : 0.35) * r / MARKER_RADIUS);
    const ring = mesh.userData.ring;
    if (ring) { ring.visible = full && mesh.visible; if (ring.visible) ring.quaternion.copy(tmpQ); }
    if (mesh.userData.reply) mesh.scale.multiplyScalar(0.75);
    if (mesh.userData.bloomUntil) {                                        // commit cue: swell and settle
      const left = (mesh.userData.bloomUntil - now) / BLOOM_MS;
      if (left <= 0) { delete mesh.userData.bloomUntil; if (!mesh.userData.playing && !mesh.userData.hover) mesh.material.emissiveIntensity = mesh.userData.near ? 0.6 : 0.35; }
      else mesh.scale.multiplyScalar(1 + 1.2 * Math.sin((1 - left) * Math.PI));
    }
  }
}

// The commit cue for a clip that was just saved: the marker blooms and a short
// two-note chime plays through the scene's audio context (the headset speakers in XR).
function bloom(id) {
  const m = markers.get(id);
  if (!m) return;
  m.mesh.userData.bloomUntil = performance.now() + BLOOM_MS;
  m.mesh.material.emissiveIntensity = 1.0;
  try {
    const ctx = listener.context;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime, g = ctx.createGain(), o = ctx.createOscillator();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.type = 'sine'; o.frequency.setValueAtTime(660, t); o.frequency.setValueAtTime(990, t + 0.09);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.25);
  } catch {}
}

let playingId = null;
function stopAll(reason = 'other') {
  ghost.hide();
  if (playingId) log('play:stop', { id: playingId, reason });
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
  if (!m) return;
  if (!m.sound.buffer) return setStatus('audio still loading…', { hold: 1000 });
  if (listener.context.state === 'suspended') listener.context.resume();
  if (playingId === id) { stopAll('click'); setStatus('■ stopped'); return; }   // click the playing marker again to stop
  stopAll('other');
  m.sound.onEnded = () => { m.sound.isPlaying = false; ghost.hide(); if (playingId === id) { log('play:stop', { id, reason: 'ended' }); playingId = null; m.mesh.userData.playing = false; m.mesh.material.emissiveIntensity = 0.35; renderList(); } };
  m.sound.play();
  playingId = id;
  log('play:start', { id, hands: !!m.record.hands });
  playStartedAt = performance.now();
  if (m.record.hands) ghost.show(m.record.hands); else ghost.hide();
  m.mesh.userData.playing = true;
  m.mesh.material.emissiveIntensity = 1.0;
  renderList();
  setStatus(`▶ ${describeRecord(m.record)}${m.record.anchor.objectId ? ' · ' + m.record.anchor.objectId : ''}`);
}

// Erase asks twice everywhere: the first press (Delete at the crosshair, or ✕
// in the list) arms it and the list's ✕ turns into "erase?"; a second press
// within DELETE_ARM_MS erases. A visitor's mis-click removes nothing.
let armedDelete = null;   // { id, timer }
function armDelete(id, message) {
  if (!markers.has(id)) return;
  if (VISITOR) return setStatus('erasing is done at the desk; ask and your recording will be removed');
  if (armedDelete?.id === id) { clearTimeout(armedDelete.timer); armedDelete = null; return deleteAnnotation(id); }
  if (armedDelete) clearTimeout(armedDelete.timer);
  armedDelete = { id, timer: setTimeout(() => { if (armedDelete?.id === id) { armedDelete = null; renderList(); } }, DELETE_ARM_MS) };
  renderList();
  setStatus(message);
}
async function deleteAnnotation(id) {
  if (!project || !markers.has(id)) return;
  if (armedDelete?.id === id) { clearTimeout(armedDelete.timer); armedDelete = null; }
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
  else if (captured()) id = aimMarker(camera);
  if (id === hoverId) return;
  const prev = markers.get(hoverId);
  if (prev) { prev.mesh.userData.hover = false; prev.mesh.material.emissiveIntensity = prev.mesh.userData.playing ? 1.0 : 0.35; }
  hoverId = id;
  const cur = markers.get(id);
  if (cur) { cur.mesh.userData.hover = true; if (!cur.mesh.userData.playing) cur.mesh.material.emissiveIntensity = 1.0; }
  crosshair.classList.toggle('hover', !!id);
  markRow(id || nearId, !!id);
  refreshIdleStatus();
}

// Approach: the nearest visible marker within PLAY_DISTANCE is "near". It is
// lit and previewed in the status row (author, when, first words) so a visitor
// can read it before deciding to play. Playing takes a click or trigger; the
// autoplay toggle restores play-on-approach for guided walks.
let nearId = null;
function setNear(id) {
  if (id === nearId) return;
  const prev = markers.get(nearId);
  if (prev) { prev.mesh.userData.near = false; if (!prev.mesh.userData.playing && !prev.mesh.userData.hover && !prev.mesh.userData.bloomUntil) prev.mesh.material.emissiveIntensity = 0.35; }
  nearId = id;
  const cur = markers.get(id);
  if (cur) { cur.mesh.userData.near = true; if (!cur.mesh.userData.playing && !cur.mesh.userData.hover && !cur.mesh.userData.bloomUntil) cur.mesh.material.emissiveIntensity = 0.6; }
  if (!hoverId) markRow(id, false);
  refreshIdleStatus();
}

// What the status row shows when nothing explicit is being said: the hovered
// clip, else nothing while a clip plays, else the near clip, else blank.
function refreshIdleStatus() {
  if (recorder.isRecording || starting) return;
  const press = !renderer.xr.isPresenting ? 'click' : handsPresent() ? 'pinch' : 'trigger';          // the same line reads on the headset panel
  const cur = markers.get(hoverId);
  if (cur) return setStatus(`${describeRecord(cur.record)} — ${press} to ${cur.record.id === playingId ? 'stop' : 'play'}`, { idle: true });
  if (playingId) return;
  const n = markers.get(nearId);
  if (n) return setStatus(`near: ${describeRecord(n.record)} — ${!renderer.xr.isPresenting ? 'click it' : handsPresent() ? 'point and pinch' : 'point and pull the trigger'} to play`, { idle: true });
  setStatus('', { idle: true });
}

// The list and the scene point at each other: aiming at or standing near a
// marker marks its row and brings it into view; a row under the mouse lights
// its marker; clicking a name turns the desktop camera to the marker.
let hotId = null;
function markRow(id, scroll) {
  const ul = hud.annList;
  hotId = id || null;
  for (const li of ul.querySelectorAll('li.hot')) if (li.dataset.id !== id) li.classList.remove('hot');
  if (!id) return;
  const li = ul.querySelector(`li[data-id="${id}"]`);
  if (!li) return;
  li.classList.add('hot');
  if (scroll && !ul.matches(':hover')) li.scrollIntoView({ block: 'nearest' });
}
let focusId = new URLSearchParams(location.search).get('focus'), assetsReady = false;
function focusMarker(id) {
  const m = markers.get(id);
  if (!m || renderer.xr.isPresenting) return;
  const a = m.mesh.position;
  const toCentre = new THREE.Vector3(-a.x, 0, -a.z); if (toCentre.lengthSq() < 1e-4) toCentre.set(0, 0, 1); toCentre.normalize();
  camera.position.set(a.x + toCentre.x * 1.0, 1.6, a.z + toCentre.z * 1.0);   // within approach distance, so the status previews this clip
  camera.lookAt(a); camera.updateMatrixWorld(true);
  bloom(id);
  markRow(id, true);
}

// HUD list of annotations in the current project
function renderList() {
  const ul = hud.annList;
  ul.innerHTML = '';
  // newest first; replies directly under their parent, oldest reply first
  const all = [...markers.values()].filter((m) => m.mesh.visible).map((m) => m.record);
  const byParent = new Map();
  for (const r of all) if (r.parent) byParent.set(r.parent, [...(byParent.get(r.parent) || []), r]);
  const roots = all.filter((r) => !r.parent || !markers.has(r.parent)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const items = [];
  for (const r of roots) { items.push(r); for (const c of (byParent.get(r.id) || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) items.push(c); }
  for (const record of items) {
    const li = document.createElement('li');
    li.className = (record.id === playingId ? 'playing ' : '') + (VISITOR || record.layer === hud.layer.value ? '' : 'dim ') + (record.id === hotId ? 'hot ' : '') + (record.parent && markers.has(record.parent) ? 'reply' : '');
    li.dataset.id = record.id;
    const tr = record.transcription || {};
    const unclear = tr.unclear || unclearReason(record.transcript);         // stored as unclear, or an older transcript the guard now catches
    const text = record.transcript && !unclear ? `<div class="text">${esc(record.transcript)}</div>`
      : tr.status === 'pending' ? `<div class="text pending">transcribing…</div>`
      : tr.status === 'failed' ? `<div class="text failed" title="${esc(tr.error || '')}">transcription failed <button class="retry">retry</button></div>`
      : unclear ? `<div class="text pending" title="${esc(tr.raw || record.transcript || '')}">(${UNCLEAR_TEXT[unclear] || 'unclear'})</div>`
      : tr.status === 'done' ? `<div class="text pending">(no speech detected)</div>` : '';
    const periodLabel = record.period ? (record.period.label || [record.period.from, record.period.to].filter(Boolean).join('–')) : '';
    const badges = (record.hands ? `<span class="badge" title="${esc(describeHands(record.hands))}">✋</span>` : '') + (record.replies ? `<span class="badge" title="replies">↩ ${record.replies}</span>` : '') + (periodLabel ? `<span class="period" title="period">${esc(periodLabel)}</span>` : '');
    const prompt = record.prompt ? `<div class="prompt">Q: ${esc(record.prompt)}</div>` : '';
    // the project or clip forced one language and the model heard another: say so, offer the other decoder
    const mismatch = tr.status === 'done' && tr.heard && tr.language && tr.heard !== tr.language;
    const note = mismatch ? `<div class="note" title="the language was set to ${esc(langName(tr.language))}; the model's own detection says ${esc(langName(tr.heard))}">sounds like ${esc(langName(tr.heard))}, transcribed as ${esc(langName(tr.language))}${VISITOR ? '' : ` <button class="asHeard">transcribe as ${esc(langName(tr.heard))}</button>`}</div>` : '';
    const armed = armedDelete?.id === record.id;
    const when = whenOf(record);
    const sw = markers.get(record.id)?.mesh.material.color.getStyle() || '#888';
    const photos = linksOf(record);
    li.innerHTML = `<button class="play" title="play">${record.id === playingId ? '■' : '▶'}</button><span class="sw" style="background:${sw}" title="${esc(when)}"></span><span class="who" title="turn to this clip">${esc(record.author)}</span><span class="meta" title="${esc([when, record.anchor.objectId ? 'on ' + record.anchor.objectId : ''].filter(Boolean).join(' · '))}">${record.layer !== 'default' ? esc(record.layer) + ' · ' : ''}${record.period ? '' : esc(when) + ' · '}${fmtDur(record.durationMs)}${photos ? ' · ' + photos : ''}</span>${badges}<button class="del${armed ? ' armed' : ''}" title="${armed ? 'click again to erase' : 'erase (asks twice)'}">${armed ? 'erase?' : '✕'}</button>${prompt}${text}${note}`;
    li.querySelector('.play').addEventListener('click', () => play(record.id));
    li.querySelector('.who').addEventListener('click', () => focusMarker(record.id));
    li.querySelector('.del').addEventListener('click', () => armDelete(record.id, 'click ✕ again to erase this clip'));
    li.querySelector('.retry')?.addEventListener('click', () => annotationsApi.transcribe(project.id, record.id).catch((e) => setStatus('retry failed: ' + e.message)));
    li.querySelector('.asHeard')?.addEventListener('click', () => annotationsApi.transcribe(project.id, record.id, { language: tr.heard }).then(() => setStatus('transcribing again as ' + langName(tr.heard))).catch((e) => setStatus('retry failed: ' + e.message)));
    li.addEventListener('mouseenter', () => { const m = markers.get(record.id); if (m) m.mesh.material.emissiveIntensity = 0.9; });
    li.addEventListener('mouseleave', () => { const m = markers.get(record.id); if (m && !m.mesh.userData.playing) m.mesh.material.emissiveIntensity = 0.35; });
    ul.appendChild(li);
  }
}

// ---- recording -------------------------------------------------------------

const recorder = new VoiceRecorder();
function attachLevel(stream) {
  try {
    const ctx = listener.context;
    if (ctx.state === 'suspended') ctx.resume();
    if (!levelSrc || levelSrc.mediaStream !== stream) {
      levelSrc?.disconnect();
      levelSrc = ctx.createMediaStreamSource(stream);
      levelNode = ctx.createAnalyser(); levelNode.fftSize = 512;
      levelSrc.connect(levelNode);                         // analyser only; never to the destination (that would be feedback)
      levelData = new Uint8Array(levelNode.fftSize);
    }
  } catch {}
}
recorder.onstart = (stream) => { attachLevel(stream); if (micState !== 'ready') { log('mic:ready', { via: micState === 'ended' ? 'reacquired' : 'first clip' }); micState = 'ready'; } };
// The browser ended the microphone track (headset asleep, device unplugged). A clip in flight is
// closed by the loop's track-ended check; the next clip, or the hands reconnecting, asks again.
recorder.onended = () => { micState = 'ended'; log('mic:ended', { recording: !!anchorSource }); if (!anchorSource) setStatus('microphone stopped; it is asked for again on the next clip', { hold: 3000 }); };
const cursor = new THREE.Mesh(new THREE.SphereGeometry(MARKER_RADIUS * 1.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3333, wireframe: true }));
cursor.visible = false;
scene.add(cursor);
let anchorSource = null;             // Object3D whose aim decides the anchor while recording
let starting = null;                 // source whose recording is still waiting on the microphone
let releasedEarly = false;           // trigger/button let go before the microphone was ready
let recOpts = {};                    // { parent } for a reply
let releaseAt = 0;                   // performance.now() at the release that ended the clip
let saving = false;                  // between the end of a clip and its save: no new clip starts by voice, so "saved" is seen
let lastPlacementMs = null;          // release -> provisional marker visible, measured on the last clip

// The author's viewpoint over the clip, sampled at POSE_HZ from the camera's
// world transform. In XR that is the headset pose; on desktop it is the
// mouse-steered virtual camera, recorded with poseSource 'desktop' so a viewer
// never mistakes it for a gaze path.
const POSE_HZ = 10;
const pose = { samples: [], timer: null, t0: 0, source: 'desktop' };
const _pp = new THREE.Vector3(), _pq = new THREE.Quaternion();
function poseStart() {
  clearInterval(pose.timer);
  pose.samples = []; pose.t0 = performance.now(); pose.source = renderer.xr.isPresenting ? 'xr' : 'desktop';
  poseSample();
  pose.timer = setInterval(poseSample, 1000 / POSE_HZ);
}
function poseSample() {
  camera.getWorldPosition(_pp); camera.getWorldQuaternion(_pq);
  pose.samples.push({ t: Math.round(performance.now() - pose.t0), p: [_pp.x, _pp.y, _pp.z], q: [_pq.x, _pq.y, _pq.z, _pq.w] });
}
function poseStop() { clearInterval(pose.timer); pose.timer = null; poseSample(); return pose.samples; }

async function beginRecording(source, opts = {}) {
  if (recorder.isRecording || starting) return;
  const via = opts.voice ? 'voice' : opts.parent ? 'reply' : source === camera ? (opts.via || 'key') : handsPresent() ? 'pinch' : 'trigger';
  if (!project) { log('record:blocked', { reason: 'no project', via }); return setStatus('no project'); }
  if (!hud.author.value.trim()) { log('record:blocked', { reason: 'no name', via }); return setStatus('enter your name first'); }
  if (!hud.consent.checked) { log('record:blocked', { reason: 'no consent', via }); return setStatus('tick consent first'); }
  if ('speechSynthesis' in window) speechSynthesis.cancel();   // never record over our own voice
  starting = source; releasedEarly = false; recOpts = { ...opts, projectId: project.id, via };
  setStatus('starting microphone…');
  try { await recorder.start(); }
  catch (e) {
    try { recorder.release(); await recorder.start(); }   // a stream the browser ended under us (headset asleep, device gone): ask once more before giving up
    catch (e2) { starting = null; micState = 'blocked'; log('record:blocked', { reason: 'mic', via, error: e2.message }); return setStatus('mic blocked: ' + e2.message); }
  }
  starting = null;
  log('record:start', { source: via, question: currentQuestion() ? qIndex : undefined, layer: hud.layer.value, presenting: renderer.xr.isPresenting, hands: handsPresent() });
  anchorSource = source;
  poseStart();
  if (renderer.xr.isPresenting) handTrace.start();          // hands, if the headset tracks them, travel with the clip
  cursor.visible = !opts.parent;
  hud.rec.classList.add('on'); crosshair.classList.add('rec');
  const q = currentQuestion();
  recPeak = 0;
  recStatusBase = opts.parent ? 'recording a reply…' : q ? `recording answer ${qIndex + 1}…` : VISITOR ? 'recording…' : 'recording… (' + hud.layer.value + ')';
  recSecs = -1;
  setStatus(recStatusBase + ' 0s');
  if (releasedEarly) endRecording();  // the first press on a cold mic: honour the release that already happened
}

// Release of the button/trigger that started a recording. Safe to call while the mic is still warming up.
function releaseRecording(source) {
  if (starting === source) { releasedEarly = true; releaseAt = performance.now(); return; }
  if (recorder.isRecording && anchorSource === source) { releaseAt = performance.now(); endRecording('release'); }
}

// Reset the recording UI when the microphone stops on its own (track ended,
// device unplugged) or when the clip cannot be kept.
function resetRecordingUi() {
  voiceArmed = false;                                         // whatever ended this clip, wait for a pause before speech can start another
  clearInterval(pose.timer); pose.timer = null;
  handTrace.reset();
  cursor.visible = false; anchorSource = null; recOpts = {};
  hud.rec.classList.remove('on'); crosshair.classList.remove('rec');
}

// A provisional marker goes into the scene at release, before the clip is
// encoded or uploaded, so the mark lands where the user is still looking.
const pendingMarkers = new Set();
function placeProvisional(anchor) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(MARKER_RADIUS, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, wireframe: true }));
  mesh.position.copy(anchor);
  scene.add(mesh); pendingMarkers.add(mesh);
  lastPlacementMs = Math.round(performance.now() - releaseAt);
  return mesh;
}
function clearProvisional(mesh) { scene.remove(mesh); pendingMarkers.delete(mesh); }

async function endRecording(reason = 'release') {
  if (!recorder.isRecording) return;
  const opts = recOpts; recOpts = {};
  const heldMs = Math.round(performance.now() - recorder.startedAt);
  if (opts.projectId !== project?.id) {                     // the project changed under the recording: nothing sensible to anchor to
    anchorSource = null;
    await recorder.stop(); resetRecordingUi();
    log('record:end', { reason: 'project-changed', source: opts.via, durationMs: heldMs }); log('record:discarded', { reason: 'project changed', source: opts.via });
    return setStatus('project changed while recording; clip discarded');
  }
  const parentRec = opts.parent ? markers.get(opts.parent)?.record : null;
  const { point: anchor, objectId } = parentRec
    ? { point: new THREE.Vector3(parentRec.anchor.x, parentRec.anchor.y, parentRec.anchor.z), objectId: parentRec.anchor.objectId }
    : aimPoint(anchorSource);
  const provisional = placeProvisional(anchor);
  anchorSource = null; saving = true;                        // from here the clip is ending on purpose: the loop's "track ended" check and voice start both stand down until it is saved
  const samples = poseStop();
  const hands = handTrace.stop();
  const clip = await recorder.stop();
  resetRecordingUi();
  log('record:end', { reason, source: opts.via, durationMs: heldMs, hands: handsSummary(hands) });
  if (!clip) { clearProvisional(provisional); saving = false; log('record:discarded', { reason: 'too short', source: opts.via, durationMs: heldMs }); return setStatus('too short, discarded'); }
  setStatus('saving…');
  const q = currentQuestion();
  try {
    const rec = await annotationsApi.create({
      project: project.id, ...clip, anchor, objectId, author: hud.author.value.trim(), layer: hud.layer.value, consent: true,
      parent: parentRec?.id, pose: samples, poseSource: pose.source, hands,
      prompt: q?.text, mode: q ? 'interview' : 'walk',
    });
    clearProvisional(provisional);
    const quiet = levelNode && recPeak < QUIET_PEAK;              // the level meter never moved: likely the wrong input or a muted microphone
    setStatus((parentRec ? `saved reply to ${parentRec.author}` : `saved ${fmtDur(clip.durationMs)}${objectId ? ' on ' + objectId : ''}${hands ? ' with ' + describeHands(hands) : ''}`) + (quiet ? ' — the microphone heard almost nothing; check the input' : ''), { hold: quiet ? 5000 : 2000 });
    log('record:saved', { id: rec.id, source: opts.via, durationMs: clip.durationMs, placementMs: lastPlacementMs, quiet: !!quiet, objectId, hands: handsSummary(rec.hands), reply: !!parentRec, question: q ? qIndex : undefined });
    addMarker(rec);                  // local echo; server broadcast is deduped by id (the parent's reply count arrives as annotation:updated)
    bloom(rec.id);
    if (q) stepQuestion(1);
  } catch (e) {
    clearProvisional(provisional);
    log('record:discarded', { reason: 'save failed', source: opts.via, error: e.message });
    setStatus('save failed: ' + e.message);
  }
  saving = false;
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
  const hit = raycaster.intersectObjects(markerGroup.children, false).find((h) => h.object.visible);   // hidden by the time filter: not a target
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
  ctrl.addEventListener('selectend', () => releaseRecording(ctrl));
  ctrl.addEventListener('connected', (e) => log('input:connected', { kind: e.data?.hand ? 'hand' : 'controller', handedness: e.data?.handedness, profiles: (e.data?.profiles || []).slice(0, 3) }));
  ctrl.addEventListener('disconnected', (e) => log('input:disconnected', { kind: e.data?.hand ? 'hand' : 'controller', handedness: e.data?.handedness }));
  ctrl.addEventListener('squeezestart', () => {
    if (VISITOR) return askCurrent();                        // a guest hears the question again; layers are an operator concern
    const next = LAYERS[(LAYERS.indexOf(hud.layer.value) + 1) % LAYERS.length];
    hud.layer.value = next; hud.layer.dispatchEvent(new Event('change'));
    setStatus('layer: ' + next);
  });
  rig.add(ctrl);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  rig.add(grip);
}

// Hands. With hand tracking the headset reports an input source per hand:
// its target ray and pinch arrive through the same controller objects above
// (a pinch is a select), and the joints through renderer.xr.getHand(i). The
// joints are sampled into the clip while recording (HandTrace) and drawn back
// on playback (GhostHands). With hands and no controller there is no trigger
// to hold, so, when "start a clip when I speak" is on, speech starts a clip
// anchored where the author looks and a pause ends it.
const handModelFactory = new XRHandModelFactory();
const xrHands = {};                  // handedness -> XRHandSpace while connected
for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i);
  hand.add(handModelFactory.createHandModel(hand, 'spheres'));
  hand.addEventListener('connected', (e) => { if (e.data?.hand) xrHands[e.data.handedness] = hand; if (e.data?.hand && renderer.xr.isPresenting) readyMic(); });   // with hands there is no trigger: voice start needs the microphone open
  hand.addEventListener('disconnected', (e) => { for (const k of Object.keys(xrHands)) if (xrHands[k] === hand) delete xrHands[k]; });
  rig.add(hand);
}
const handsPresent = () => Object.keys(xrHands).length > 0;
const handTrace = new HandTrace(() => xrHands);
// how the ghost hands are drawn: a setting, persisted, and overridable from the URL (?ghost=solid&trail=1) so a headset can switch without the laptop
const urlq = new URLSearchParams(location.search);
hud.ghostStyle.value = urlq.get('ghost') || ls.get('glossy.ghostStyle', 'skeleton');
hud.ghostTrail.checked = urlq.has('trail') ? urlq.get('trail') !== '0' : ls.get('glossy.ghostTrail', '0') === '1';
const ghost = new GhostHands(scene, { style: hud.ghostStyle.value, trail: hud.ghostTrail.checked });
hud.ghostStyle.addEventListener('change', () => { ghost.setStyle(hud.ghostStyle.value); ls.set('glossy.ghostStyle', ghost.style); log('setting', { ghost: ghost.style }); });
hud.ghostTrail.addEventListener('change', () => { ghost.trail = hud.ghostTrail.checked; ls.set('glossy.ghostTrail', ghost.trail ? '1' : '0'); log('setting', { trail: ghost.trail }); });
let playStartedAt = 0;
// voice start: speech above VOICE_START for VOICE_START_MS begins a clip; a pause below VOICE_STOP for VOICE_STOP_MS ends it
const VOICE_START = 0.1, VOICE_START_MS = 250, VOICE_STOP = 0.06, VOICE_STOP_MS = 1200, VOICE_MIN_MS = 600;
let voiceAbove = 0, voiceQuiet = 0, voiceArmed = true;   // armed: a quiet moment has passed since the last clip, so speech may start a new one
function voiceStart(now) {
  if (!renderer.xr.isPresenting || !handsPresent() || !hud.voiceStart.checked || !levelNode) return;
  if ('speechSynthesis' in window && speechSynthesis.speaking) { voiceAbove = 0; return; }   // the Ask voice is not the visitor
  if (playingId && !recorder.isRecording) { voiceAbove = 0; return; }                        // nor is a clip being listened to
  const lvl = measureLevel();
  if (recorder.isRecording) {
    if (!recOpts.voice) return;                                 // a pinch-held clip ends on release, not on silence
    if (lvl < VOICE_STOP) { if (!voiceQuiet) voiceQuiet = now; else if (now - voiceQuiet > VOICE_STOP_MS && now - recorder.startedAt > VOICE_MIN_MS) { voiceQuiet = 0; releaseAt = now; endRecording('voice-pause'); } }
    else voiceQuiet = 0;
    return;
  }
  if (starting || saving) return;
  if (lvl < VOICE_STOP) voiceArmed = true;                    // speech that simply continues after a clip ended does not start the next one
  if (!voiceArmed) { voiceAbove = 0; return; }
  if (lvl > VOICE_START) { if (!voiceAbove) voiceAbove = now; else if (now - voiceAbove > VOICE_START_MS) { voiceAbove = 0; voiceQuiet = 0; voiceArmed = false; beginRecording(camera, { voice: true }); } }
  else voiceAbove = 0;
}

// ---- desktop fallback ------------------------------------------------------

const lock = new PointerLockControls(camera, renderer.domElement);
const crosshair = document.getElementById('crosshair');
// Where the Pointer Lock API is unavailable (some iframes, headless browsers)
// the mouse is "captured" in software instead: same look-and-record behaviour,
// the cursor just stays visible. Esc releases either kind of capture.
let softCapture = false;
const captured = () => lock.isLocked || softCapture;
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
function softLook(e) {
  if (!softCapture || lock.isLocked) return;
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= e.movementX * 0.002;
  euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x - e.movementY * 0.002));
  camera.quaternion.setFromEuler(euler);
}
function setCaptured(on) {
  crosshair.hidden = !on;
  if (!on) releaseRecording(camera);   // Esc mid-recording still saves
}
// First click captures the mouse. After that the mouse button works like the
// controller trigger: hold to record at the crosshair, release to save, and a
// click on a marker plays it instead of recording.
renderer.domElement.addEventListener('mousedown', (e) => {
  if (renderer.xr.isPresenting || e.button !== 0) return;
  if (!captured()) {
    // ask for pointer lock ourselves so a refusal (headless, some iframes) is a quiet pointerlockerror, not an unhandled rejection
    try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch {}
    return;
  }
  const hit = aimMarker(camera);
  if (hit) play(hit); else beginRecording(camera, { via: 'mouse' });
});
renderer.domElement.addEventListener('mouseup', (e) => { if (e.button === 0) releaseRecording(camera); });
renderer.domElement.addEventListener('mousemove', softLook);
document.addEventListener('pointerlockchange', () => { softCapture = false; setCaptured(lock.isLocked); });
document.addEventListener('pointerlockerror', () => {
  if (lock.isLocked) return;
  softCapture = true; setCaptured(true);
  setStatus('pointer lock unavailable here; mouse look without hiding the cursor, Esc to release');
});
window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && softCapture) { softCapture = false; setCaptured(false); } });
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (e.code === 'KeyK') beginRecording(camera, { via: 'key' });
  if (e.code === 'KeyL') releaseRecording(camera);
  if (e.code === 'KeyR' && !e.repeat) { const hit = aimMarker(camera); if (hit) beginRecording(camera, { parent: hit }); else setStatus('aim at a marker to reply to it'); }
  if (e.code === 'Space') { const hit = aimMarker(camera); if (hit) play(hit); }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    const hit = aimMarker(camera);
    if (hit) armDelete(hit, 'press Delete again to erase this clip');
  }
});
window.addEventListener('keyup', (e) => { keys.delete(e.code); if (e.code === 'KeyR') releaseRecording(camera); });

// ---- network ---------------------------------------------------------------

const net = connect({
  onAll: (all) => {
    clearMarkers(); all.forEach(addMarker);
    setStatus(markers.size ? '' : VISITOR ? 'nothing has been recorded here yet: you could be first' : 'nothing recorded here yet — hold the mouse button on the scene and speak', { hold: markers.size ? 0 : 6000 });
    if (focusId && markers.has(focusId)) { focusMarker(focusId); if (assetsReady) focusId = null; }   // opened from the review page: stand in front of that clip (again once the assets have framed the view)
  },
  onNew: (a) => a.project === project?.id && addMarker(a),
  onControl: (c) => {                 // an operator at a laptop (POST /api/projects/:id/control) steering this page; see the README
    if (c.session && c.session !== log.session) return;
    const a = c.args || {};
    log('control', { action: c.action, args: a });
    switch (c.action) {
      case 'say': setStatus(String(a.text || '').slice(0, 200), { hold: Number(a.holdMs) || 6000 }); break;
      case 'play': if (markers.has(a.id)) play(a.id); break;
      case 'stop': stopAll('control'); break;
      case 'ghost':
        if (a.style) { hud.ghostStyle.value = a.style; hud.ghostStyle.dispatchEvent(new Event('change')); }
        if (a.trail !== undefined) { hud.ghostTrail.checked = !!a.trail; hud.ghostTrail.dispatchEvent(new Event('change')); }
        break;
      case 'voiceStart': hud.voiceStart.checked = !!a.on; hud.voiceStart.dispatchEvent(new Event('change')); break;
      case 'interview': hud.interview.checked = !!a.on; hud.interview.dispatchEvent(new Event('change')); break;
      case 'ask': askCurrent(); break;
      case 'step': stepQuestion(Number(a.by) || 1); break;
      case 'project': if (a.id && a.id !== project?.id) openProject(a.id); break;
      case 'reload': log.flush().finally(() => location.reload()); break;
      case 'exitVR': renderer.xr.getSession()?.end(); break;
    }
  },
  onDeleted: (d) => { removeMarker(d); renderList(); },
  onUpdated: (a) => {                 // transcript, period, reply count or parent changed for an existing marker
    const m = markers.get(a.id);
    if (!m || a.project !== project?.id) return;
    if (m.record.parent && !a.parent) { m.mesh.position.set(a.anchor.x, a.anchor.y, a.anchor.z); m.mesh.userData.reply = false; }   // parent erased: now a root
    m.record = a;
    recolour(m);                     // period or age may have changed
    applyLayerFilter();
    m.mesh.visible = inTime(a);
    renderList();
    if (hoverId === a.id) { hoverId = null; updateHover(); }
  },
  onProjectUpdated: async (p) => {
    refreshProjectList();
    if (p.id !== project?.id) return;
    const key = (x) => JSON.stringify((x.assets || []).map((a) => [a.id, a.url, a.visible, a.options]));
    const changed = key(p) !== key(project);
    const settingsChanged = p.language !== project.language || JSON.stringify(p.script) !== JSON.stringify(project.script);
    project = p;
    if (settingsChanged) projectToHud();
    if (changed) await showAssets(p);
    else { for (const a of p.assets || []) { const e = loaded.get(a.id); if (e) e.asset = a; } renderAssets(); }
  },
  onProjectsChanged: refreshProjectList,
  onStatus: (s) => { setStatus(s); if (s === 'connected' && project) net.join(project.id); },
});

// dev-only handle for poking at the scene from the console
if (import.meta.env.DEV) window.__glossy = {
  scene, renderer, camera, rig, room, assetsRoot, loaded, markers, recorder, hud, keys, lock,
  get project() { return project; }, get selected() { return selected(); }, get playingId() { return playingId; }, get nearId() { return nearId; },
  visitor: VISITOR, get lastAsked() { return lastAsked; }, xrPanel, get level() { return level; }, get fullDistance() { return fullDistance; },
  get status() { return hud.status.textContent; },
  get captured() { return captured(); },
  get lastPlacementMs() { return lastPlacementMs; },
  visibleIds: () => [...markers.values()].filter((m) => m.mesh.visible).map((m) => m.record.id),
  fullIds: () => [...markers.values()].filter((m) => m.mesh.visible && m.mesh.userData.full !== false).map((m) => m.record.id),
  nearestId: () => { camera.getWorldPosition(tmpV); let best = null, bd = Infinity; for (const m of markers.values()) { if (!m.mesh.visible) continue; const d = m.mesh.position.distanceTo(tmpV); if (d < bd) { bd = d; best = m.record.id; } } return best; },
  get pending() { return pendingMarkers.size; },
  get interview() { return { on: hud.interview.checked, index: qIndex, question: currentQuestion()?.text || null, total: questions().length }; },
  autoFit, frameAll, applyTransform, aimPoint, aimMarker, floorBelow, spawnInside, focusMarker, play, endRecording,
  ghost, xrHands, get handsPresent() { return handsPresent(); }, log,
};

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

  if (!renderer.xr.isPresenting && captured()) {
    const speed = (keys.has('ShiftLeft') ? 4 : 1.8) * dt;
    if (hud.walk.checked) {
      // walk: WASD on the ground plane, slide along walls, follow the floor
      const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      const move = new THREE.Vector3();
      if (keys.has('KeyW')) move.add(fwd); if (keys.has('KeyS')) move.sub(fwd);
      if (keys.has('KeyD')) move.add(right); if (keys.has('KeyA')) move.sub(right);
      if (move.lengthSq() > 0) walkMove(move.normalize().multiplyScalar(speed));
      const floor = floorBelow(camera.position);
      if (floor !== null) {
        const target = floor + EYE_HEIGHT;
        camera.position.y += (target - camera.position.y) * Math.min(1, dt * 12);
      }
    } else {
      // fly: the original free movement
      if (keys.has('KeyW')) lock.moveForward(speed);
      if (keys.has('KeyS')) lock.moveForward(-speed);
      if (keys.has('KeyA')) lock.moveRight(-speed);
      if (keys.has('KeyD')) lock.moveRight(speed);
      if (keys.has('KeyE')) camera.position.y += speed;
      if (keys.has('KeyQ')) camera.position.y -= speed;
    }
  }

  handTrace.tick();                                          // hand joints into the clip at HAND_HZ, from the frames they were posed in
  if (recorder.isRecording && anchorSource) cursor.position.copy(aimPoint(anchorSource).point);
  else if (anchorSource && !starting && !recorder.isRecording) { log('record:end', { reason: 'track-ended', source: recOpts.via }); resetRecordingUi(); setStatus('microphone stopped; nothing saved', { hold: 3000 }); }   // the track ended under us (a hold, or the hover text replaces it in the same frame)
  updateHover();
  scaleMarkers();
  updateLevel();
  updateXrPanel();
  renderHint();

  // approach: the nearest visible marker within PLAY_DISTANCE is previewed; it
  // plays only with autoplay on (once per approach, active layer only)
  camera.getWorldPosition(near);
  let bestId = null, bestD = PLAY_DISTANCE;
  for (const { mesh, sound, record } of markers.values()) {
    if (!mesh.visible) continue;
    const d = mesh.position.distanceTo(near);
    if (d < bestD) { bestD = d; bestId = record.id; }
    if (hud.autoplay.checked && record.layer === hud.layer.value && sound.buffer) {
      if (d < PLAY_DISTANCE && !sound.isPlaying && !mesh.userData.played) { mesh.userData.played = true; play(record.id); }
      if (d > PLAY_DISTANCE * 1.5) mesh.userData.played = false;
    }
  }
  setNear(bestId);
  voiceStart(performance.now());
  if (ghost.visible) ghost.update(performance.now() - playStartedAt);

  // once a second while presenting or recording: frame rate, hand tracking coverage, microphone level
  stats.frame(); stats.level(recorder.isRecording ? level : levelNode ? measureLevel() : 0);   // the room's level is only kept while recording; the log wants it whenever the microphone is open
  for (const [side, key] of [['l', 'left'], ['r', 'right']]) { const h = xrHands[key]; stats.hand(side, !!h, !!h?.joints?.wrist?.visible); }
  if (stats.due) { const line = stats.take(); if (renderer.xr.isPresenting || recorder.isRecording) log('stats', { presenting: renderer.xr.isPresenting, recording: recorder.isRecording, ...line }); }

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
