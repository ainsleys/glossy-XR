#!/usr/bin/env node
// A readable summary of the session log for one project: what each client
// session did, how recording went by source, how often the tracker lost each
// hand, frame rate, microphone level. Reads the API (default :3000).
//
//   node scripts/session-report.mjs --project <id> [--api http://localhost:3000] [--session <id>] [--events]
//   node scripts/session-report.mjs --list [--api …]           the projects and how many sessions each has
//
// --events prints every event of the chosen sessions after the summary, one per line.

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter((x) => x.length));
const API = args.api || process.env.GLOSSY_API || 'http://localhost:3000';
const get = async (p) => { const r = await fetch(API + p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const count = (xs, f) => xs.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const fmtCount = (m) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

if (args.list || !args.project) {
  for (const p of await get('/api/projects')) {
    const sessions = await get(`/api/projects/${p.id}/sessions`);
    console.log(`${p.id}  ${p.name.padEnd(28)} ${String(p.annotationCount).padStart(4)} clips  ${String(sessions.length).padStart(3)} sessions${sessions[0] ? `  last ${sessions[0].started}` : ''}`);
  }
  if (!args.project) { console.log('\nnode scripts/session-report.mjs --project <id>'); process.exit(0); }
}

const project = await get(`/api/projects/${args.project}`);
const sessions = (await get(`/api/projects/${project.id}/sessions`)).filter((s) => !args.session || s.session === args.session);
const clips = await get(`/api/projects/${project.id}/annotations`);
console.log(`\n${project.name} (${project.id}): ${clips.length} clips, ${sessions.length} session${sessions.length === 1 ? '' : 's'}\n`);

for (const s of sessions) {
  const ev = await get(`/api/projects/${project.id}/events?session=${s.session}&limit=50000`);
  const of = (kind) => ev.filter((e) => e.kind === kind);
  const first = ev[0], last = ev.at(-1);
  const span = first && last ? Date.parse(last.at) - Date.parse(first.at) : 0;
  const ua = (s.ua || '').match(/OculusBrowser\/[\d.]+|Quest|Chrome\/[\d.]+|Safari\/[\d.]+|Firefox\/[\d.]+/)?.[0] || (s.ua || '').slice(0, 40);
  console.log(`── session ${s.session}  ${s.started.replace('T', ' ').slice(0, 19)}  ${secs(span)}  ${ua}${s.visitor ? '  visitor' : ''}`);

  // headset time
  const xr = []; let open = null;
  for (const e of ev) { if (e.kind === 'xr:start') open = e.t; if (e.kind === 'xr:end' && open !== null) { xr.push(e.t - open); open = null; } }
  if (open !== null && last) xr.push(last.t - open);
  if (xr.length) console.log(`   headset: ${xr.length} immersive session${xr.length === 1 ? '' : 's'}, ${secs(xr.reduce((a, b) => a + b, 0))} in VR`);
  const inputs = of('input:connected');
  if (inputs.length) console.log(`   inputs: ${fmtCount(inputs, (e) => `${e.data?.kind} ${e.data?.handedness || ''}`.trim())}`);
  const mic = of('mic:ready')[0], micErr = of('mic:error');
  console.log(`   microphone: ${mic ? `ready at ${secs(mic.t)}${mic.data?.via ? ` (${mic.data.via})` : ''}` : 'never ready'}${micErr.length ? `, ${micErr.length} error${micErr.length === 1 ? '' : 's'}: ${micErr[0].data?.error}` : ''}`);

  // recording
  const starts = of('record:start'), saved = of('record:saved'), discarded = of('record:discarded'), blocked = of('record:blocked'), ends = of('record:end');
  console.log(`   recordings: ${starts.length} started (${fmtCount(count(starts, (e) => e.data?.source))}), ${saved.length} saved, ${discarded.length} discarded${discarded.length ? ` (${fmtCount(count(discarded, (e) => e.data?.reason))})` : ''}${blocked.length ? `, ${blocked.length} blocked (${fmtCount(count(blocked, (e) => e.data?.reason))})` : ''}`);
  if (ends.length) console.log(`   ended by: ${fmtCount(count(ends, (e) => e.data?.reason))}`);
  const durs = saved.map((e) => e.data?.durationMs).filter(Number.isFinite);
  if (durs.length) console.log(`   clip length: median ${secs(median(durs))}, longest ${secs(Math.max(...durs))}; placement median ${median(saved.map((e) => e.data?.placementMs).filter(Number.isFinite)) ?? '–'} ms; ${saved.filter((e) => e.data?.quiet).length} near-silent`);
  const voice = starts.filter((e) => e.data?.source === 'voice').length, voiceShort = discarded.filter((e) => e.data?.source === 'voice' && e.data?.reason === 'too short').length;
  if (voice) console.log(`   voice start: ${voice} clips started by speech, ${voiceShort} too short (false starts)`);

  // hands during recording
  const withHands = saved.filter((e) => e.data?.hands);
  if (withHands.length) {
    const tot = { frames: 0, l: 0, r: 0, fl: 0, fr: 0 };
    for (const e of withHands) { const h = e.data.hands; tot.frames += h.frames; tot.l += h.lost.l; tot.r += h.lost.r; tot.fl += h.filled?.l || 0; tot.fr += h.filled?.r || 0; }
    console.log(`   gestures: ${withHands.length} clips with hands, ${tot.frames} frames; lost or inferred: left ${pct(tot.l, tot.frames)}, right ${pct(tot.r, tot.frames)}; reconstructed: left ${tot.fl}, right ${tot.fr} frames`);
  }

  // per-second stats while presenting
  const st = of('stats').filter((e) => e.data?.presenting);
  if (st.length) {
    const fps = st.map((e) => e.data.fps).filter(Number.isFinite);
    const sum = (side) => st.reduce((m, e) => { const h = e.data.hands?.[side]; if (h) { m.seen += h.seen; m.of += h.of; } return m; }, { seen: 0, of: 0 });
    const L = sum('l'), R = sum('r');
    const lossRuns = (side) => { let run = 0, worst = 0; for (const e of st) { const h = e.data.hands?.[side]; if (h && h.of && h.seen === 0) { run++; worst = Math.max(worst, run); } else run = 0; } return worst; };
    const lv = st.map((e) => e.data.level).filter(Number.isFinite);
    console.log(`   in VR (${st.length} s): fps median ${median(fps)}, min ${Math.min(...fps)}; hands tracked: left ${pct(L.seen, L.of)} of ${Math.round(L.of / Math.max(1, median(fps) || 1))} s present, right ${pct(R.seen, R.of)}; longest full loss: left ${lossRuns('l')} s, right ${lossRuns('r')} s; mic level max ${Math.max(...lv, 0)}, median ${median(lv)}`);
  }
  const plays = of('play:start'), asks = of('question:ask'), errors = of('error');
  if (plays.length || asks.length) console.log(`   played ${plays.length} clip${plays.length === 1 ? '' : 's'}${plays.filter((e) => e.data?.hands).length ? ` (${plays.filter((e) => e.data?.hands).length} with ghost hands)` : ''}; asked ${asks.length} question${asks.length === 1 ? '' : 's'}`);
  if (errors.length) console.log(`   errors: ${errors.length}: ${[...new Set(errors.map((e) => e.data?.message))].slice(0, 3).join(' | ')}`);
  if (args.events) for (const e of ev) console.log(`     ${String(e.t).padStart(7)} ms  ${e.kind.padEnd(18)} ${e.data ? JSON.stringify(e.data) : ''}`);
  console.log();
}
