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

/** Samples the tracked hands of a three.js WebXR session while a clip records. */
export class HandTrace {
  /** @param {() => {left?: THREE.Object3D, right?: THREE.Object3D}} hands  the XRHandSpace objects by handedness, when connected */
  constructor(hands) { this.hands = hands; this.frames = []; this.timer = null; this.t0 = 0; this.any = false; }
  start() {
    clearInterval(this.timer);
    this.frames = []; this.any = false; this.t0 = performance.now();
    this.sample();
    this.timer = setInterval(() => this.sample(), 1000 / HAND_HZ);
  }
  sample() {
    if (this.frames.length >= MAX_HAND_FRAMES) return;
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
    this.frames.push({ t: Math.round(performance.now() - this.t0), l, r });
  }
  /** @returns {{joints: string[], rate: number, frames: {t:number,l:number[]|null,r:number[]|null}[]} | null} null when no hand was ever seen */
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (!this.any) return null;
    this.sample();
    // trim leading and trailing frames with no hand at all, keep interior gaps
    let a = 0, b = this.frames.length - 1;
    while (a < b && !this.frames[a].l && !this.frames[a].r) a++;
    while (b > a && !this.frames[b].l && !this.frames[b].r) b--;
    return { joints: JOINTS, rate: HAND_HZ, frames: this.frames.slice(a, b + 1) };
  }
}

/** Translucent hands replayed from a stored trace, in scene coordinates. */
export class GhostHands {
  constructor(parent) {
    this.group = new THREE.Group(); this.group.visible = false; this.group.name = 'ghost-hands';
    const n = JOINTS.length * 2;
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }), n);
    this.joints.frustumCulled = false;
    this._seen = new THREE.Color(0x9fd3ff); this._inferred = new THREE.Color(0x6f7f95);   // tracked joints light blue; reconstructed frames grey, so a viewer can tell
    for (let i = 0; i < n; i++) this.joints.setColorAt(i, this._seen);
    this.bonePos = new Float32Array(BONES.length * 2 * 2 * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(this.bonePos, 3));
    this.bones = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.6, depthWrite: false }));
    this.bones.frustumCulled = false;
    this.group.add(this.joints, this.bones);
    parent.add(this.group);
    this.trace = null; this.cursor = 0; this.shownT = -1;
    this._m = new THREE.Matrix4(); this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  get visible() { return this.group.visible; }
  show(trace) { this.trace = trace; this.cursor = 0; this.shownT = -1; this.group.visible = !!trace?.frames?.length; this.update(0); }
  hide() { this.group.visible = false; this.trace = null; }
  /** Draw the frame at t milliseconds into the clip. */
  update(t) {
    const tr = this.trace; if (!tr || !this.group.visible) return;
    const f = tr.frames;
    if (t < (f[this.cursor]?.t ?? 0)) this.cursor = 0;
    while (this.cursor + 1 < f.length && f[this.cursor + 1].t <= t) this.cursor++;
    const frame = f[this.cursor];
    if (frame.t === this.shownT) return;
    this.shownT = frame.t;
    const nJ = JOINTS.length;
    let bi = 0;
    for (const [side, arr, inferred] of [[0, frame.l, frame.lf], [1, frame.r, frame.rf]]) {
      for (let i = 0; i < nJ; i++) {
        const k = side * nJ + i;
        if (!arr) { this.joints.setMatrixAt(k, this._zero); continue; }
        this.joints.setColorAt(k, inferred ? this._inferred : this._seen);
        const s = i === 0 ? 0.012 : i % 5 === 4 ? 0.007 : 0.0085;       // wrist larger, fingertips smaller
        this._m.makeScale(s, s, s).setPosition(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
        this.joints.setMatrixAt(k, this._m);
      }
      for (const [a, b] of BONES) {
        if (arr) { this.bonePos.set([arr[3 * a], arr[3 * a + 1], arr[3 * a + 2], arr[3 * b], arr[3 * b + 1], arr[3 * b + 2]], bi); }
        else this.bonePos.fill(0, bi, bi + 6);
        bi += 6;
      }
    }
    this.joints.instanceMatrix.needsUpdate = true;
    if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;
    this.bones.geometry.attributes.position.needsUpdate = true;
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
