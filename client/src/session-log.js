// Session log: what happened in this page, posted to the server in batches so
// a session in a headset leaves a record that can be read at the desk. The
// room (main.js) calls `log(kind, data)` at the moments that matter and
// `log.stats(...)` once a second while presenting; the server keeps the events
// per project and session (GET /api/projects/:id/events) and
// scripts/session-report.mjs turns them into a readable summary.
//
// Vocabulary (kind → data):
//   session:start      { ua, visitor, viewport, href }
//   project:open       { id, name, assets }
//   xr:start / xr:end  {}
//   input:connected    { kind: 'controller' | 'hand', handedness, profiles }
//   input:disconnected { kind, handedness }
//   mic:ready          { via?: 'first clip' | 'reacquired' }   mic:error { error }   mic:ended { recording }
//   record:start       { source: 'trigger' | 'pinch' | 'voice' | 'mouse' | 'key' | 'reply', question, layer }
//   record:blocked     { reason: 'no name' | 'no consent' | 'mic' | 'no project' }
//   record:end         { reason: 'release' | 'voice-pause' | 'project-changed' | 'track-ended', durationMs, hands }
//   record:saved       { id, durationMs, placementMs, quiet, objectId, hands }
//   record:discarded   { reason: 'too short' | 'save failed' | 'project changed' }
//   play:start / play:stop  { id, reason? }
//   question:ask       { index, result }   question:step { index }
//   stats              { presenting, recording, fps, hands: { l: { seen, of }, r: { seen, of } }, level }
//   error              { message, source? }
//   control            { action, args }      an operator message received (POST /api/projects/:id/control)
// `t` is ms since the page loaded, `at` the client clock; the server adds `received`.
// Nothing here carries audio or transcript text.

const FLUSH_MS = 2000, FLUSH_AT = 50;

export function createSessionLog({ fetchImpl = fetch } = {}) {
  const session = (crypto.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 8);
  const queue = [];
  let projectId = null, timer = null, sending = false, dropped = 0;
  const now = () => Math.round(performance.now());

  function log(kind, data) {
    queue.push({ t: now(), at: new Date().toISOString(), kind, data });
    if (queue.length >= FLUSH_AT) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  }
  async function flush({ beacon = false } = {}) {
    clearTimeout(timer); timer = null;
    if (!projectId || !queue.length || sending) return;
    const events = queue.splice(0, FLUSH_AT * 4);
    const body = JSON.stringify({ session, events });
    const url = `/api/projects/${projectId}/events`;
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); return; }
    sending = true;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
      if (!res.ok) dropped += events.length;
    } catch { dropped += events.length; }                  // the log never gets in the way of the room; a lost batch is lost
    sending = false;
    if (queue.length) flush();
  }
  /** Events logged before a project is open wait for it. */
  log.setProject = (id) => { projectId = id; if (queue.length) flush(); };
  log.flush = flush;
  log.session = session;
  Object.defineProperty(log, 'pending', { get: () => queue.length });
  Object.defineProperty(log, 'dropped', { get: () => dropped });

  // a page going away sends what it has
  addEventListener('pagehide', () => { log('session:end'); flush({ beacon: true }); });
  addEventListener('error', (e) => log('error', { message: String(e.message || e.error || 'error').slice(0, 300), source: e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : undefined }));
  addEventListener('unhandledrejection', (e) => log('error', { message: String(e.reason?.message || e.reason || 'rejection').slice(0, 300) }));
  return log;
}

/** Per-second counters for the `stats` line: call `frame()` every render, `hand(side, tracked)` per hand per render, `level(v)` with the microphone level, then `take()` once a second. */
export function createStatsSampler() {
  let frames = 0, maxLevel = 0, hands = { l: { seen: 0, of: 0 }, r: { seen: 0, of: 0 } }, since = performance.now();
  return {
    frame() { frames++; },
    hand(side, present, tracked) { if (!present) return; hands[side].of++; if (tracked) hands[side].seen++; },
    level(v) { if (v > maxLevel) maxLevel = v; },
    get due() { return performance.now() - since >= 1000; },
    take() {
      const secs = (performance.now() - since) / 1000;
      const out = { fps: Math.round(frames / secs), hands, level: Math.round(maxLevel * 100) / 100 };
      frames = 0; maxLevel = 0; hands = { l: { seen: 0, of: 0 }, r: { seen: 0, of: 0 } }; since = performance.now();
      return out;
    },
  };
}
