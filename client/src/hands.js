// Hand gestures as part of a clip. While a clip records in a headset with
// hand tracking, the 25 WebXR joints of each hand are sampled at HAND_HZ in
// scene coordinates and stored with the clip as `hands`, next to the head
// pose. On playback the same joints are drawn as translucent ghost hands, in
// the place where they were made, in time with the voice: "and then you stir
// it like this" plays back with the stirring.
//
// Gaps are kept as gaps: when the headset loses a hand (behind the back, out
// at the side, one hand hiding the other) that hand's entry for the frame is
// null, and the ghost hand disappears for those frames rather than freezing.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// WebXR joint order (XRHand); 25 per hand
export const JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];
// bones as index pairs along each finger chain from the wrist
export const BONES = [];
for (const chain of [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8, 9], [0, 10, 11, 12, 13, 14], [0, 15, 16, 17, 18, 19], [0, 20, 21, 22, 23, 24]]) {
  for (let i = 1; i < chain.length; i++) BONES.push([chain[i - 1], chain[i]]);
}
export const HAND_HZ = 20;
export const MAX_HAND_FRAMES = 20 * 120;   // two minutes at HAND_HZ

const _v = new THREE.Vector3();
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Samples the tracked hands of a three.js WebXR session while a clip records.
 *  Driven from the render loop (`tick()` every frame), not a timer: a timer slips
 *  to 100 ms and worse when the page is busy, and the timestamps must be the
 *  frames the joints were actually posed in. */
export class HandTrace {
  /** @param {() => {left?: THREE.Object3D, right?: THREE.Object3D}} hands  the XRHandSpace objects by handedness, when connected */
  constructor(hands) { this.hands = hands; this.frames = []; this.active = false; this.t0 = 0; this.last = -Infinity; this.any = false; }
  start() {
    this.frames = []; this.any = false; this.t0 = performance.now(); this.last = -Infinity; this.active = true;
    this.sample();
  }
  /** Call once per rendered frame; samples at HAND_HZ while a clip records. */
  tick() {
    if (!this.active) return;
    const now = performance.now();
    if (now - this.last >= 1000 / HAND_HZ - 4) this.sample(now);
  }
  sample(now = performance.now()) {
    if (this.frames.length >= MAX_HAND_FRAMES) return;
    this.last = now;
    const hs = this.hands();
    const one = (hand) => {
      const joints = hand?.joints;
      if (!joints || !joints.wrist || !joints.wrist.visible) return null;     // untracked: a gap, not a frozen hand
      const out = new Array(JOINTS.length * 3);
      for (let i = 0; i < JOINTS.length; i++) {
        const j = joints[JOINTS[i]];
        if (!j) return null;
        j.getWorldPosition(_v);
        out[3 * i] = r3(_v.x); out[3 * i + 1] = r3(_v.y); out[3 * i + 2] = r3(_v.z);
      }
      return out;
    };
    const l = one(hs.left), r = one(hs.right);
    if (l || r) this.any = true;
    this.frames.push({ t: Math.round(now - this.t0), l, r });
  }
  /** @returns {{joints: string[], rate: number, frames: {t:number,l:number[]|null,r:number[]|null}[]} | null} null when no hand was ever seen */
  stop() {
    if (!this.active) return null;                            // a trace is read out once; a later clip that never started one (desktop after a headset clip) gets nothing stale
    this.active = false;
    this.sample();
    const frames = this.frames, any = this.any;
    this.frames = []; this.any = false;
    if (!any) return null;
    // trim leading and trailing frames with no hand at all, keep interior gaps
    let a = 0, b = frames.length - 1;
    while (a < b && !frames[a].l && !frames[a].r) a++;
    while (b > a && !frames[b].l && !frames[b].r) b--;
    return { joints: JOINTS, rate: HAND_HZ, frames: frames.slice(a, b + 1) };
  }
  /** Drop whatever was sampled without reading it (the microphone died under the clip). */
  reset() { this.active = false; this.frames = []; this.any = false; }
}

/** Translucent hands replayed from a stored trace, in scene coordinates.
 *
 *  Three ways to draw the same trace, because the capture data (25 points per
 *  hand) is not yet a picture a visitor reads:
 *    skeleton  the joints as beads and the bones as lines: the data itself, legible close up
 *    solid     capsules along the bones and a pad for the palm, lit: a hand-shaped volume
 *    mesh      a skinned hand (the generic WebXR hand model) posed from the joints;
 *              the trace stores positions only, so each joint's orientation is
 *              derived: -Z along the bone towards the tip, +Y out of the back of
 *              the hand (the WebXR joint-space convention, measured)
 *  and, with `trail` on, a ribbon behind each wrist for the last TRAIL_MS, so a
 *  stir reads as a circle even when the hand is small or half out of view.
 *  Inferred frames (gap filling) are drawn grey in every style. */
const TRAIL_MS = 1200;
const SEEN = 0x9fd3ff, INFERRED = 0x6f7f95;
const BONE_RADIUS = (a, b) => (a === 0 ? 0.011 : b % 5 === 4 ? 0.007 : b < 5 ? 0.0095 : 0.0085);   // metacarpals thicker, fingertips thinner, thumb in between
const HAND_MESH_URL = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/';
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4(), _Y = new THREE.Vector3(0, 1, 0);
const PALM = [0, 5, 10, 15, 20, 6, 11, 21];      // joints whose mean is the palm's centre
const NEXT = {}, PREV = {};
for (const [a, b] of BONES) { NEXT[a] = NEXT[a] ?? b; PREV[b] = a; }
NEXT[0] = 10;                                     // the wrist looks along the middle metacarpal

export class GhostHands {
  constructor(parent, { style = 'skeleton', trail = false } = {}) {
    this.group = new THREE.Group(); this.group.visible = false; this.group.name = 'ghost-hands';
    parent.add(this.group);
    const nJ = JOINTS.length;
    this._seen = new THREE.Color(SEEN); this._inferred = new THREE.Color(INFERRED);
    // skeleton: beads and lines
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }), nJ * 2);
    this.bonePos = new Float32Array(BONES.length * 2 * 2 * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.bonePos, 3));
    this.bones = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.6, depthWrite: false }));
    // solid: capsules (a unit cylinder scaled to each bone, round joints at its ends) and a palm pad
    const lit = () => new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false, roughness: 0.55, metalness: 0 });
    this.capsules = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), lit(), BONES.length * 2);
    this.knuckles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 9), lit(), nJ * 2);
    this.palms = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), lit(), 2);
    for (const im of [this.joints, this.capsules, this.knuckles, this.palms]) { im.frustumCulled = false; for (let i = 0; i < im.count; i++) im.setColorAt(i, this._seen); }
    this.bones.frustumCulled = false;
    // mesh: loaded on first use
    this.meshes = { left: null, right: null }; this.meshLoading = null;
    // trail: a ribbon per hand
    this.trails = {};
    for (const side of ['l', 'r']) {
      const geo = new LineGeometry(); geo.setPositions([0, 0, 0, 0, 0, 0]); geo.setColors([0, 0, 0, 0, 0, 0]);
      const mat = new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: 0.012, transparent: true, opacity: 0.85, depthWrite: false });
      const line = new Line2(geo, mat); line.frustumCulled = false; line.visible = false;
      this.trails[side] = line; this.group.add(line);
    }
    this.group.add(this.joints, this.bones, this.capsules, this.knuckles, this.palms);
    this.trace = null; this.cursor = 0; this.shownT = -1;
    this._m = new THREE.Matrix4(); this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._trail = !!trail;
    this.setStyle(style);
  }
  get visible() { return this.group.visible; }
  get style() { return this._style; }
  get trail() { return this._trail; }
  set trail(on) { this._trail = !!on; this.shownT = -1; }
  /** @param {'skeleton'|'solid'|'mesh'} style */
  setStyle(style) {
    this._style = ['skeleton', 'solid', 'mesh'].includes(style) ? style : 'skeleton';
    this.joints.visible = this.bones.visible = this._style === 'skeleton';
    this.capsules.visible = this.knuckles.visible = this.palms.visible = this._style === 'solid';
    for (const m of Object.values(this.meshes)) if (m) m.visible = this._style === 'mesh';
    if (this._style === 'mesh') this.loadMeshes();
    this.shownT = -1;                                        // redraw the current frame in the new style
  }
  loadMeshes() {
    if (this.meshLoading) return this.meshLoading;
    const loader = new GLTFLoader(); loader.setPath(HAND_MESH_URL);
    this.meshLoading = Promise.all(['left', 'right'].map((side) => new Promise((resolve) => loader.load(`${side}.glb`, (gltf) => {
      const object = cloneSkeleton(gltf.scene.children[0]);
      const mesh = object.getObjectByProperty('type', 'SkinnedMesh');
      mesh.frustumCulled = false;
      mesh.material = new THREE.MeshStandardMaterial({ color: SEEN, transparent: true, opacity: 0.7, depthWrite: false, roughness: 0.6 });
      object.userData.bones = JOINTS.map((n) => object.getObjectByName(n) || null);
      object.userData.mesh = mesh;
      object.visible = this._style === 'mesh';
      this.meshes[side] = object; this.group.add(object);
      resolve(object);
    }, undefined, () => resolve(null))))).then(() => { this.shownT = -1; });
    return this.meshLoading;
  }
  show(trace) { this.trace = trace; this.cursor = 0; this.shownT = -1; this.group.visible = !!trace?.frames?.length; if (this.group.visible) this.update(0); }
  hide() { this.group.visible = false; this.trace = null; }
  /** Draw the frame at t milliseconds into the clip. */
  update(t) {
    const tr = this.trace; if (!tr || !this.group.visible) return;
    const f = tr.frames;
    // before the first tracked frame and after the last one there is no hand to show: hidden, not frozen
    const inSpan = t >= f[0].t && t <= f[f.length - 1].t + 1000 / (tr.rate || HAND_HZ);
    if (t < (f[this.cursor]?.t ?? 0)) this.cursor = 0;
    while (this.cursor + 1 < f.length && f[this.cursor + 1].t <= t) this.cursor++;
    const frame = f[this.cursor];
    const style = this._style;
    this.joints.visible = this.bones.visible = inSpan && style === 'skeleton';
    this.capsules.visible = this.knuckles.visible = this.palms.visible = inSpan && style === 'solid';
    for (const [key, hand] of [['l', 'left'], ['r', 'right']]) {
      if (this.meshes[hand]) this.meshes[hand].visible = inSpan && style === 'mesh' && !!frame[key];
      this.trails[key].visible = inSpan && this._trail && !!frame[key] && !!this.trails[key].userData.ok;
    }
    if (!inSpan || frame.t === this.shownT) return;
    this.shownT = frame.t;
    const nJ = JOINTS.length;
    let bi = 0;
    for (const [side, key, hand] of [[0, 'l', 'left'], [1, 'r', 'right']]) {
      const arr = frame[key], inferred = frame[key + 'f'];
      const colour = inferred ? this._inferred : this._seen;
      if (style === 'skeleton') {
        for (let i = 0; i < nJ; i++) {
          const k = side * nJ + i;
          if (!arr) { this.joints.setMatrixAt(k, this._zero); continue; }
          this.joints.setColorAt(k, colour);
          const s = i === 0 ? 0.012 : i % 5 === 4 ? 0.007 : 0.0085;       // wrist larger, fingertips smaller
          this._m.makeScale(s, s, s).setPosition(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
          this.joints.setMatrixAt(k, this._m);
        }
        for (const [a, b] of BONES) {
          if (arr) this.bonePos.set([arr[3 * a], arr[3 * a + 1], arr[3 * a + 2], arr[3 * b], arr[3 * b + 1], arr[3 * b + 2]], bi);
          else this.bonePos.fill(0, bi, bi + 6);
          bi += 6;
        }
      } else if (style === 'solid') {
        for (let i = 0; i < nJ; i++) {
          const k = side * nJ + i;
          if (!arr) { this.knuckles.setMatrixAt(k, this._zero); continue; }
          this.knuckles.setColorAt(k, colour);
          const r = i === 0 ? 0.013 : BONE_RADIUS(PREV[i] ?? 0, i);
          this._m.makeScale(r, r, r).setPosition(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
          this.knuckles.setMatrixAt(k, this._m);
        }
        BONES.forEach(([a, b], j) => {
          const k = side * BONES.length + j;
          if (!arr) { this.capsules.setMatrixAt(k, this._zero); return; }
          _a.set(arr[3 * a], arr[3 * a + 1], arr[3 * a + 2]); _b.set(arr[3 * b], arr[3 * b + 1], arr[3 * b + 2]);
          _z.subVectors(_b, _a); const len = _z.length() || 1e-6; _z.divideScalar(len);
          _q.setFromUnitVectors(_Y, _z);
          const r = BONE_RADIUS(a, b);
          this._m.compose(_c.addVectors(_a, _b).multiplyScalar(0.5), _q, _x.set(r, len, r));
          this.capsules.setColorAt(k, colour);
          this.capsules.setMatrixAt(k, this._m);
        });
        if (!arr) this.palms.setMatrixAt(side, this._zero);
        else {
          _c.set(0, 0, 0); for (const i of PALM) _c.add(_a.set(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2])); _c.divideScalar(PALM.length);
          _x.set(arr[18] - arr[63], arr[19] - arr[64], arr[20] - arr[65]).normalize();              // across the palm: index proximal to pinky proximal
          _z.set(arr[0] - arr[33], arr[1] - arr[34], arr[2] - arr[35]).normalize();                // along it: middle proximal to wrist
          _y.crossVectors(_z, _x).normalize(); _x.crossVectors(_y, _z).normalize();
          _m4.makeBasis(_x, _y, _z); _q.setFromRotationMatrix(_m4);
          this._m.compose(_c, _q, _a.set(0.036, 0.012, 0.046));
          this.palms.setColorAt(side, colour);
          this.palms.setMatrixAt(side, this._m);
        }
      } else if (style === 'mesh') {
        const obj = this.meshes[hand];
        if (obj && arr) { obj.userData.mesh.material.color.copy(colour); this.poseMesh(obj, arr, hand); }
      }
      if (this._trail) this.updateTrail(key, t);
    }
    if (style === 'skeleton') { this.joints.instanceMatrix.needsUpdate = true; if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true; this.bones.geometry.attributes.position.needsUpdate = true; }
    if (style === 'solid') for (const im of [this.capsules, this.knuckles, this.palms]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
  // the skinned hand's bones, each from its joint position and an orientation derived from the chain and the palm
  poseMesh(obj, arr, hand) {
    const P = (i, v) => v.set(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
    // palm normal out of the back of the hand: (index metacarpal - wrist) x (pinky metacarpal - wrist), mirrored for the right hand
    const n = _c.copy(P(5, _a).sub(P(0, _b))).cross(P(20, _x).sub(P(0, _b))).normalize();
    if (hand === 'right') n.negate();
    const normal = n.clone();
    for (let i = 0; i < JOINTS.length; i++) {
      const bone = obj.userData.bones[i]; if (!bone) continue;
      const next = NEXT[i], prev = PREV[i];
      if (next !== undefined) _z.copy(P(i, _a)).sub(P(next, _b)); else _z.copy(P(i, _a)).sub(P(prev, _b));   // a tip continues its bone
      _z.normalize();                                          // +Z points back along the bone, away from the tip
      _y.copy(normal).addScaledVector(_z, -normal.dot(_z)).normalize();
      _x.crossVectors(_y, _z).normalize();
      _m4.makeBasis(_x, _y, _z); _q.setFromRotationMatrix(_m4);
      _m4.compose(P(i, _a), _q, _b.set(1, 1, 1));
      // the bone's local transform from the wanted world transform, through its parent
      if (bone.parent) { bone.parent.updateWorldMatrix(true, false); _m4.premultiply(this._m.copy(bone.parent.matrixWorld).invert()); }
      _m4.decompose(bone.position, bone.quaternion, bone.scale);
      bone.updateWorldMatrix(false, false);
    }
  }
  // the ribbon behind one wrist: its positions over the last TRAIL_MS, fading towards the older end
  updateTrail(key, t) {
    const line = this.trails[key], f = this.trace.frames;
    const pts = [], cols = [];
    for (let i = this.cursor; i >= 0 && f[i].t >= t - TRAIL_MS; i--) {
      const a = f[i][key]; if (!a) break;                       // the ribbon stops where the hand was lost
      const age = (t - f[i].t) / TRAIL_MS, c = f[i][key + 'f'] ? this._inferred : this._seen;
      pts.push(a[0], a[1], a[2]); cols.push(c.r * (1 - 0.8 * age), c.g * (1 - 0.8 * age), c.b * (1 - 0.8 * age));
    }
    line.userData.ok = pts.length >= 6;
    if (!line.userData.ok) { line.visible = false; return; }
    line.geometry.dispose(); line.geometry = new LineGeometry(); line.geometry.setPositions(pts); line.geometry.setColors(cols);
    line.visible = true;
  }
}

/** Short description for lists: "gesture · 4.2 s · both hands" */
export function describeHands(h) {
  if (!h?.frames?.length) return '';
  const l = h.frames.some((f) => f.l), r = h.frames.some((f) => f.r);
  const secs = (h.frames.at(-1).t - h.frames[0].t) / 1000;
  const filled = (h.filled?.l || 0) + (h.filled?.r || 0);
  return `gesture ${secs.toFixed(1)} s, ${l && r ? 'both hands' : l ? 'left hand' : 'right hand'}${filled ? `, ${filled} frames reconstructed` : ''}`;
}
