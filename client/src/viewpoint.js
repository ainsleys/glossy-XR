// Where the author stood and looked while speaking. Every clip stores the
// author's viewpoint as `pose`, samples of {t, p, q} at 10 Hz in scene
// coordinates (the camera's world position and orientation, rig included). On
// playback in the room it is drawn where it was made, in time with the voice,
// beside the ghost hands: a small translucent head and a line along its gaze,
// so "the water came in over there" shows where "there" was.
//
// Only headset traces are drawn (poseSource 'xr'). A desktop trace is where a
// mouse-steered camera pointed, not where anybody looked; the caller leaves it
// out.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { SEEN } from './hands.js';
import { sampleAt } from '../../shared/pose.js';

const SAMPLE_MS = 1000 / 10;        // the recording rate; one interval past the last sample the replay is over
const HEAD_RADIUS = 0.1, GAZE_M = 0.6;
const NEAR_HEAD_M = 0.4;            // a listener this close to the head would see it from inside: draw the gaze alone

export class Viewpoint {
  constructor(parent) {
    this.group = new THREE.Group(); this.group.visible = false; this.group.name = 'viewpoint';
    parent.add(this.group);
    // the walls and the furniture hide it, as they hide the ghost hands: a viewpoint seen through a wall would mislead
    this.head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 16, 12), new THREE.MeshBasicMaterial({ color: SEEN, transparent: true, opacity: 0.35, depthWrite: false }));
    // the gaze is -Z of the sampled orientation; a Line2 in world units, because a plain line is one pixel wide in a headset
    const geo = new LineGeometry(); geo.setPositions([0, 0, 0, 0, 0, -GAZE_M]);
    this.gaze = new Line2(geo, new LineMaterial({ color: SEEN, worldUnits: true, linewidth: 0.008, transparent: true, opacity: 0.8, depthWrite: false }));
    for (const o of [this.head, this.gaze]) { o.frustumCulled = false; o.renderOrder = 1; }   // after the ghost hands
    this.group.add(this.head, this.gaze);
    this.pose = null; this.cursor = -1;
  }
  get visible() { return this.group.visible; }
  get headShown() { return this.group.visible && this.gaze.visible && this.head.visible; }
  get position() { const s = this.pose?.[this.cursor]; return s ? [...s.p] : null; }
  show(pose) { this.pose = pose?.length ? pose : null; this.cursor = -1; this.group.visible = !!this.pose; if (this.pose) this.update(0); }
  hide() { this.group.visible = false; this.pose = null; this.cursor = -1; }
  /** Draw the viewpoint at t milliseconds into the clip, seen by a listener whose head is at `listener` (world). */
  update(t, listener) {
    const s = this.pose; if (!s || !this.group.visible) return;
    // past the last sample the replay is over: hidden, never frozen at its last pose, whatever stops the sound
    if (t > s[s.length - 1].t + SAMPLE_MS) return this.hide();
    this.cursor = sampleAt(s, t, this.cursor);
    const now = s[this.cursor];
    this.gaze.visible = this.head.visible = !!now;
    if (!now) return;
    this.group.position.fromArray(now.p); this.group.quaternion.fromArray(now.q);
    this.head.visible = !listener || this.group.position.distanceTo(listener) >= NEAR_HEAD_M;
  }
}
