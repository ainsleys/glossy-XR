// A simulated visitor in the emulated headset: a head that looks toward its
// goal with human lag and wanders, a thumb that misfires at the rate seen on
// the Quest 2 on 21 Oct 2026, and tasks with real goals. It reports what a
// person would feel: time, path against the straight line, wrong-way travel,
// overshoot, collisions, accidental recordings, gestures spent. Run it after
// any change to movement; compare its numbers with a worn session's log.
//
//   npx playwright test test/sim.spec.js        → test-results/sim-report.json and a table on stdout
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { API, openProject, prepareRecording } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: 'node_modules/iwer/build/iwer.js' });
  await page.addInitScript(() => {
    const dev = new IWER.XRDevice(IWER.metaQuest3);
    dev.installRuntime({ forceInstall: true });
    dev.position.set(0, 1.6, 0.6);
    window.__xr = dev;
  });
});

// Calibration from Ainsley's 21 Oct sessions: 167 left-hand gestures, median gap 522 ms, forward swipes a
// minority of what the headset reported. We do not know her intent per gesture, so the model is: the
// intended swipe is reported correctly with probability pCorrect, otherwise as one of the other three.
const NOISE = { clean: { pCorrect: 1 }, quest2: { pCorrect: 0.55 } };
const POSTURES = { standing: { bodyTurn: true }, seated: { bodyTurn: false } };   // standing: turns the body in place at ~150°/s; seated: head only, ±60°, software must turn them
const TASKS = [
  { id: 'turn-then-go', goal: [-2, 0.9], note: 'the chest, 80° to the left and behind' },
  { id: 'stop-at-target', goal: [2, 0.6], note: '2 m to the right; overshoot matters' },
  { id: 'look-around-while-moving', goal: [2.4, -2.3], gawk: true, note: 'far corner, head swinging ±40° on the way' },
  { id: 'lap', goals: [[0, -0.3], [2.3, -2.3], [2.3, 2.3], [-2.3, 2.3], [0, 0.6]], budgetMs: 45000, note: 'table, three corners, home' },
];

async function runTask(page, { mode, noise, task, posture }) {
  return page.evaluate(async ({ mode, noise, task, posture }) => {
    const g = window.__glossy, dev = window.__xr;
    // head pose = yaw about Y then pitch about X, composed by hand (the emulator's math classes are not exported)
    const setHead = (yawRad, pitchRad) => { const sy = Math.sin(yawRad / 2), cy = Math.cos(yawRad / 2), sp = Math.sin(pitchRad / 2), cp = Math.cos(pitchRad / 2); dev.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp); };
    const rand = (() => { let s = 1234567 + task.id.length * 7919 + (mode === 'steps' ? 11 : 0) + Math.round(noise.pCorrect * 100); return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
    const wrap = (a) => ((a + 540) % 360) - 180;
    // the visitor thinks in intents and the headset reports Meta's labels for a left hand
    const LABEL = { push: ['left', 'swipe-right'], brake: ['left', 'swipe-left'], 'turn-left': ['right', 'swipe-right'], 'turn-right': ['right', 'swipe-left'] };   // left thumb: speed; right thumb: heading
    const GESTURES = ['push', 'brake', 'turn-left', 'turn-right'];
    const confuse = (want) => { if (rand() < noise.pCorrect) return want; const others = GESTURES.filter((x) => x !== want); return others[Math.floor(rand() * 3)]; };
    // reset the person
    g.rig.position.set(0, 0, 0); g.rig.rotation.y = 0; dev.quaternion.set(0, 0, 0, 1);
    document.querySelector('#locoMode').value = mode; document.querySelector('#locoMode').dispatchEvent(new Event('change'));
    document.querySelector('#locoHand').value = 'both';
    const goals = task.goals || [task.goal];
    const m = { task: task.id, mode, posture: posture.bodyTurn ? 'standing' : 'seated', noise: noise.pCorrect, ms: 0, path: 0, straight: 0, wrongWay: 0, overshoot: 0, intended: {}, reported: {}, collisions: 0, finalDist: null, reached: 0, timedOut: false };
    let headYaw = 0, bodyYawPhys = 0, wantYaw = 0, pitch = -0.1, lastPos = [g.rig.position.x, g.rig.position.z], lastT = performance.now(), speed = 0, t0 = performance.now();
    const headWorld = () => { const ry = g.rig.rotation.y; const p = dev.position; const c = Math.cos(ry), s = Math.sin(ry); return [g.rig.position.x + p.x * c + p.z * s, g.rig.position.z - p.x * s + p.z * c]; };
    let collisionsSeen = 0; const seenStatus = new Set();
    for (const goal of goals) {
      const start = headWorld(); m.straight += Math.hypot(goal[0] - start[0], goal[1] - start[1]);
      let minDist = Infinity, done = false, nextDecision = 0, gawkPhase = 0;
      const tStart = performance.now();
      while (!done) {
        const now = performance.now(), dt = (now - lastT) / 1000; lastT = now;
        if (now - t0 > (task.budgetMs || 25000)) { m.timedOut = true; break; }
        // where am I, how fast
        const hp = headWorld();
        const step = Math.hypot(hp[0] - lastPos[0], hp[1] - lastPos[1]); m.path += step; speed = dt > 0 ? step / dt : 0;
        const toGoal = [goal[0] - hp[0], goal[1] - hp[1]], dist = Math.hypot(toGoal[0], toGoal[1]);
        if (step > 0) { const mv = [hp[0] - lastPos[0], hp[1] - lastPos[1]]; if ((mv[0] * toGoal[0] + mv[1] * toGoal[1]) < 0) m.wrongWay += step; }
        lastPos = hp;
        if (dist < minDist) minDist = dist; else if (dist - minDist > m.overshoot && minDist < 0.8) m.overshoot = dist - minDist;
        const bearingWorld = (Math.atan2(-toGoal[0], -toGoal[1]) * 180) / Math.PI;      // yaw whose -Z points at the goal
        const bodyYaw = (g.rig.rotation.y * 180) / Math.PI + bodyYawPhys;                   // software turn + the person's own
        const rel = wrap(bearingWorld - bodyYaw);                                            // goal relative to the body
        // standing: the body turns in place toward a goal more than 60° off, at a human rate
        if (posture.bodyTurn && Math.abs(rel) > 60) { const turn = Math.sign(rel) * Math.min(Math.abs(rel), 150 * dt); bodyYawPhys += turn; }
        const rel2 = wrap(bearingWorld - (g.rig.rotation.y * 180) / Math.PI - bodyYawPhys);
        // the head: looks toward the goal (within comfort), wanders a little, gawks if the task says so
        let target = Math.max(-60, Math.min(60, rel2));
        if (task.gawk && speed > 0.15) { gawkPhase += dt * 2 * Math.PI * 0.4; target += 40 * Math.sin(gawkPhase); }
        wantYaw = target + (rand() - 0.5) * 6;
        headYaw += (wantYaw - headYaw) * Math.min(1, dt / 0.25);
        setHead(((bodyYawPhys + headYaw) * Math.PI) / 180, pitch);
        // decisions at a human cadence
        if (now >= nextDecision) {
          nextDecision = now + 400 + rand() * 300;
          let want = null;
          if (dist < 0.5) { if (speed > 0.15 && mode === 'scooter') want = 'brake'; else { done = true; m.reached++; } }
          else if (Math.abs(rel2) > 60) { if (!posture.bodyTurn) want = rel2 > 0 ? 'turn-left' : 'turn-right'; }   // seated: ask the software to turn; standing: the body is already turning
          else if (Math.abs(wrap(rel2 - headYaw)) < 25 && (mode === 'steps' || speed < 0.8)) want = 'push';   // a person pushes again while still rolling
          if (want) {
            const send = (w) => { const got = confuse(w); m.intended[w] = (m.intended[w] || 0) + 1; m.reported[got] = (m.reported[got] || 0) + 1; g.microgesture(...LABEL[got]); };
            send(want);
          }
        }
        if (g.status === 'something in the way' && !seenStatus.has(now >> 10)) { seenStatus.add(now >> 10); m.collisions++; }
        await new Promise((r) => setTimeout(r, 50));
      }
      m.finalDist = Math.hypot(goal[0] - headWorld()[0], goal[1] - headWorld()[1]);
      if (m.timedOut) break;
    }
    m.ms = Math.round(performance.now() - t0); m.path = +m.path.toFixed(2); m.straight = +m.straight.toFixed(2); m.wrongWay = +m.wrongWay.toFixed(2); m.overshoot = +m.overshoot.toFixed(2); m.finalDist = +m.finalDist.toFixed(2);
    m.gestures = Object.values(m.intended).reduce((a, b) => a + b, 0);
    g.log('sim', m);
    return m;
  }, { mode, noise, task, posture });
}

test('a simulated visitor moves through the room with the thumb, in both modes, clean and with Quest 2 misfires', async ({ page, request }) => {
  test.setTimeout(15 * 60 * 1000);
  const project = await openProject(page, request, 'sim');
  await prepareRecording(page, 'Sim');
  await page.evaluate(() => { window.__xr.primaryInputMode = 'hand'; document.querySelector('#voiceStart').checked = false; });
  await page.locator('#VRButton').click();
  await page.waitForFunction(() => window.__glossy.renderer.xr.isPresenting, null, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__glossy.handsPresent), { timeout: 10_000 }).toBe(true);
  const rows = [];
  for (const [pName, posture] of Object.entries(POSTURES)) for (const mode of ['scooter', 'steps']) for (const [nName, noise] of Object.entries(NOISE)) for (const task of TASKS) {
    if (nName === 'clean' && task.id !== 'turn-then-go' && task.id !== 'lap') continue;   // the clean baseline on two tasks is enough
    if (pName === 'seated' && (nName === 'clean' || task.id === 'look-around-while-moving')) continue;
    const r = await runTask(page, { mode, noise, task, posture });
    rows.push({ noise: nName, ...r });
    console.log(`SIM ${pName.padEnd(8)} ${mode.padEnd(8)} ${nName.padEnd(6)} ${task.id.padEnd(26)} ${r.timedOut ? 'TIMEOUT' : 'ok     '} ${String(r.ms).padStart(6)} ms  path ${String(r.path).padStart(5)} / ${String(r.straight).padStart(5)} m  wrong-way ${String(r.wrongWay).padStart(5)}  overshoot ${String(r.overshoot).padStart(4)}  gestures ${String(r.gestures).padStart(3)}  collisions ${r.collisions}  final ${r.finalDist} m`);
  }
  await page.evaluate(() => window.__glossy.log.flush());
  const events = await (await request.get(`${API}/api/projects/${project.id}/events`)).json();
  const accidental = events.filter((e) => e.kind === 'record:start').length;
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/sim-report.json', JSON.stringify({ at: new Date().toISOString(), accidentalRecordings: accidental, rows }, null, 2));
  console.log(`SIM accidental recordings during all runs: ${accidental}`);
  // the bar: with Quest 2 misfires, the scooter reaches every goal without timing out, and nothing was recorded by accident
  const slow = rows.filter((r) => r.mode === 'scooter' && r.posture === 'standing' && r.noise === 'quest2' && r.timedOut).map((r) => r.task);
  expect(slow, 'standing scooter tasks that timed out with Quest 2 misfires').toEqual([]);
  expect(accidental).toBe(0);
});
