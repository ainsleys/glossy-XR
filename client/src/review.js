// The review page: the same project read at a desk instead of walked. One
// list of clips with transcripts you can search and seek by word, a plan of
// the room that points at the same clips, and the edits a reviewer makes
// after the fact: a period, a photograph or document linked to the clip,
// consent, a second transcription in another language, erasure. Audio,
// transcript and viewpoint stay linked: the word under the playhead lights,
// and the plan shows where the speaker was looking at that moment.
import { connect, projects as projectsApi, assets as assetsApi, annotations as annotationsApi } from './api.js';
import { unclearReason, UNCLEAR_TEXT } from '../../shared/text.js';

const $ = (id) => document.getElementById(id);
const ui = { project: $('project'), count: $('count'), search: $('search'), filters: $('filters'), roomLink: $('roomLink'), visitorLink: $('visitorLink'), exportLink: $('exportLink'), plan: $('plan'), clips: $('clips'), player: $('player'), audio: $('audio'), time: $('time'), toast: $('toast') };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = (ms) => (ms ? (ms / 1000).toFixed(1) + ' s' : '');
const yearOf = (v, d) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : d; };
const periodLabel = (p) => (p ? p.label || [p.from, p.to].filter(Boolean).join('–') : '');
const periodKey = (p) => (p ? JSON.stringify([p.from ?? '', p.to ?? '', p.label ?? '']) : '');
const ago = (iso) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400e3);
  if (!(days >= 0)) return '';
  return days < 1 ? 'today' : days < 30 ? `${days} day${days === 1 ? '' : 's'} ago` : days < 365 ? `${Math.max(1, Math.floor(days / 30))} months ago` : `${Math.floor(days / 365)} year${days < 730 ? '' : 's'} ago`;
};
// accent- and case-insensitive matching, with Turkish dotted and dotless i folded together
const fold = (s) => String(s ?? '').toLowerCase().replace(/ı/g, 'i').replace(/İ/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');
const LANGS = [['', 'detect'], ['tr', 'Türkçe'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'français'], ['es', 'español'], ['it', 'italiano'], ['ar', 'العربية'], ['el', 'ελληνικά'], ['pl', 'polski']];

let project = null;
let records = new Map();            // id -> record
let selectedId = null;              // the clip in the player
let query = '';
let periodFilter = null;            // periodKey, '' for timeless, null for all
let armed = null;                   // { id, timer } for a two-click erase
let yearBounds = { min: NaN, max: NaN };

// ---- colour: the same mapping as the room, period midpoint on an amber→blue scale ----
function updateYearBounds() {
  let min = Infinity, max = -Infinity;
  for (const r of records.values()) if (r.period) { const a = yearOf(r.period.from, NaN), b = yearOf(r.period.to, NaN); for (const y of [a, b]) if (Number.isFinite(y)) { min = Math.min(min, y); max = Math.max(max, y); } }
  yearBounds = Number.isFinite(min) ? { min, max } : { min: NaN, max: NaN };
}
function colourOf(r) {
  const old = Date.parse(r.createdAt) < Date.now() - 180 * 86400e3;
  if (!r.period) return old ? 'hsl(215 6% 55%)' : 'hsl(215 8% 72%)';
  const a = yearOf(r.period.from, NaN), b = yearOf(r.period.to, NaN);
  const mid = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : Number.isFinite(a) ? a : b;
  const span = yearBounds.max - yearBounds.min;
  const t = Number.isFinite(mid) && span > 0 ? Math.min(1, Math.max(0, (mid - yearBounds.min) / span)) : 0;
  return `hsl(${Math.round((0.08 + 0.52 * t) * 360)} ${old ? 30 : 70}% ${old ? 45 : 50}%)`;
}
function distinctPeriods() {
  const seen = new Map();
  for (const r of records.values()) if (r.period) seen.set(periodKey(r.period), r.period);
  return [...seen.values()].sort((p, q) => yearOf(p.from, yearOf(p.to, 0)) - yearOf(q.from, yearOf(q.to, 0)));
}

// ---- matching -----------------------------------------------------------------
const terms = () => fold(query).split(/\s+/).filter(Boolean);
function matches(r) {
  if (periodFilter !== null && periodKey(r.period) !== periodFilter) return false;
  const ts = terms();
  if (!ts.length) return true;
  const hay = fold([r.author, r.transcript, r.prompt, periodLabel(r.period), r.anchor?.objectId].filter(Boolean).join(' '));
  return ts.every((t) => hay.includes(t));
}

// ---- rendering ----------------------------------------------------------------
function render() {
  updateYearBounds();
  renderFilters();
  renderClips();
  renderPlan();
  const shown = [...records.values()].filter(matches).length;
  ui.count.textContent = records.size ? (shown === records.size ? `${records.size} clips` : `${shown} of ${records.size} clips`) : 'no clips yet';
}

function renderFilters() {
  const ps = distinctPeriods();
  const timeless = [...records.values()].some((r) => !r.period);
  const btn = (key, label, colour) => `<button data-key="${esc(key ?? '')}" data-all="${key === null}" class="${periodFilter === key ? 'on' : ''}" title="${key === null ? 'show every period' : 'show only this period'}">${colour ? `<span class="dot" style="background:${colour}"></span>` : ''}${esc(label)}</button>`;
  ui.filters.innerHTML = records.size ? btn(null, 'all') + ps.map((p) => btn(periodKey(p), periodLabel(p), colourOf({ period: p, createdAt: new Date().toISOString() }))).join('') + (timeless ? btn('', 'timeless', 'hsl(215 8% 72%)') : '') : '';
  for (const b of ui.filters.querySelectorAll('button')) b.addEventListener('click', () => { const k = b.dataset.all === 'true' ? null : b.dataset.key; periodFilter = periodFilter === k ? null : k; render(); });
}

function wordsHtml(r) {
  const ts = terms();
  const hit = (w) => ts.length && ts.some((t) => fold(w).includes(t));
  const words = r.transcription?.words || [];
  const dur = (r.durationMs || 0) / 1000;
  if (words.length && words.map((w) => w.w).join(' ').trim() === r.transcript.trim()) {
    return words.map((w) => `<span class="w${hit(w.w) ? ' hit' : ''}" data-s="${Math.min(w.s, dur)}" data-e="${Math.min(w.e, dur)}" title="${w.s.toFixed(1)} s">${esc(w.w)}</span>`).join(' ');
  }
  return r.transcript.split(/(\s+)/).map((w) => (/\S/.test(w) ? `<span class="${hit(w) ? 'hit' : ''}">${esc(w)}</span>` : w)).join('');
}

function cardHtml(r) {
  const tr = r.transcription || {};
  const unclear = tr.unclear || unclearReason(r.transcript);
  const text = r.transcript && !unclear ? `<div class="text">${wordsHtml(r)}</div>`
    : tr.status === 'pending' ? `<div class="text pending">transcribing…</div>`
    : tr.status === 'failed' ? `<div class="text failed" title="${esc(tr.error || '')}">transcription failed</div>`
    : unclear ? `<div class="text unclear" title="${esc(tr.raw || r.transcript || '')}">${esc(UNCLEAR_TEXT[unclear] || 'unclear')}</div>`
    : tr.status === 'done' ? `<div class="text pending">no speech detected</div>` : `<div class="text pending">no transcript</div>`;
  const lang = tr.language ? `<span title="${tr.detected ? 'language detected by the model' : 'language set for the project or the clip'}">${esc(tr.language)}</span>` : '';
  const links = (r.links || []).length ? `<div class="links">${r.links.map((l, i) => `<figure>${l.kind === 'image' && l.url ? `<a href="${esc(l.url)}" target="_blank"><img src="${esc(l.url)}" alt="${esc(l.title || 'linked photo')}" /></a>` : `<a href="${esc(l.url || '#')}" target="_blank">${esc(l.title || l.url || l.asset)}</a>`}<figcaption title="${esc(l.title || '')}">${esc(l.title || l.kind)}</figcaption><button class="unlink" data-i="${i}" title="remove this link (the file stays in the project's assets)">✕</button></figure>`).join('')}</div>` : '';
  const presets = distinctPeriods().filter((p) => periodKey(p) !== periodKey(r.period)).map((p) => `<button class="preset" data-period='${esc(JSON.stringify(p))}' title="set this period">${esc(periodLabel(p))}</button>`).join('');
  const isArmed = armed?.id === r.id;
  return `<article data-id="${r.id}" class="${r.parent && records.has(r.parent) ? 'reply ' : ''}${r.id === selectedId ? 'sel ' : ''}${matches(r) ? '' : 'dim'}">
    <div class="head"><span class="sw" style="background:${colourOf(r)}"></span><span class="who">${esc(r.author)}</span>
      ${r.period ? `<span class="period">${esc(periodLabel(r.period))}</span>` : ''}<span title="${esc(r.createdAt)}">${esc(ago(r.createdAt))}</span><span>${fmtDur(r.durationMs)}</span>${lang}
      ${r.anchor?.objectId ? `<span>on ${esc(r.anchor.objectId)}</span>` : ''}${r.replies ? `<span>↩ ${r.replies}</span>` : ''}${r.consent === false ? '<span style="color:var(--rec)">consent withdrawn</span>' : ''}
      <span class="right"><button class="playBtn" title="play this clip">${r.id === selectedId && !ui.audio.paused ? '■ stop' : '▶ play'}</button><a href="/?project=${esc(r.project)}&focus=${esc(r.id)}" title="stand in front of this clip in the room">in the room</a></span></div>
    ${r.prompt ? `<div class="prompt">Q: ${esc(r.prompt)}</div>` : ''}
    ${text}${links}
    <div class="tools">
      <span class="group">period <input type="text" class="from" placeholder="from" value="${esc(r.period?.from || '')}" /><input type="text" class="to" placeholder="to" value="${esc(r.period?.to || '')}" /><input type="text" class="label" placeholder="label" value="${esc(r.period?.label || '')}" /><button class="savePeriod">set</button>${r.period ? '<button class="clearPeriod">clear</button>' : ''}${presets}</span>
      <span class="group"><label class="file" title="attach a photograph or scan to this clip; it also appears in the room at the clip">attach a photo<input type="file" class="photo" accept="image/*" /></label></span>
      <span class="group"><select class="lang" title="language for the next transcription">${LANGS.map(([v, l]) => `<option value="${v}" ${(r.language || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="retranscribe" title="run speech-to-text again with this language">transcribe again</button></span>
      <span class="group"><label><input type="checkbox" class="consent" ${r.consent ? 'checked' : ''} /> consent</label></span>
      <span class="group"><button class="erase danger ${isArmed ? 'armed' : ''}" title="${isArmed ? 'click again to erase' : 'erase the clip, its audio and transcript (asks twice)'}">${isArmed ? 'erase?' : 'erase'}</button></span>
    </div>
  </article>`;
}

function renderClips() {
  const all = [...records.values()];
  if (!all.length) { ui.clips.innerHTML = '<div id="empty">Nothing has been recorded in this project yet. Open the room, hold the mouse button and speak.</div>'; return; }
  const byParent = new Map();
  for (const r of all) if (r.parent && records.has(r.parent)) byParent.set(r.parent, [...(byParent.get(r.parent) || []), r]);
  const roots = all.filter((r) => !r.parent || !records.has(r.parent)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const items = [];
  for (const r of roots) { items.push(r); for (const c of (byParent.get(r.id) || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) items.push(c); }
  const shown = terms().length || periodFilter !== null ? items.filter((r) => matches(r) || (byParent.get(r.id) || []).some(matches)) : items;
  ui.clips.innerHTML = shown.length ? shown.map(cardHtml).join('') : '<div id="empty">No clip matches.</div>';
  for (const card of ui.clips.querySelectorAll('article')) wire(card, records.get(card.dataset.id));
}

function wire(card, r) {
  const q = (sel) => card.querySelector(sel);
  q('.playBtn').addEventListener('click', () => (r.id === selectedId && !ui.audio.paused ? ui.audio.pause() : playClip(r.id, 0)));
  for (const w of card.querySelectorAll('.text .w')) w.addEventListener('click', () => playClip(r.id, Number(w.dataset.s) || 0));
  const period = () => { const from = q('.from').value.trim(), to = q('.to').value.trim(), label = q('.label').value.trim(); return from || to || label ? { from: from || undefined, to: to || undefined, label: label || undefined } : null; };
  q('.savePeriod').addEventListener('click', () => patch(r.id, { period: period() }, 'period set'));
  q('.clearPeriod')?.addEventListener('click', () => patch(r.id, { period: null }, 'period cleared'));
  for (const b of card.querySelectorAll('.preset')) b.addEventListener('click', () => patch(r.id, { period: JSON.parse(b.dataset.period) }, 'period set'));
  q('.photo').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) attachPhoto(r, f); e.target.value = ''; });
  for (const b of card.querySelectorAll('.unlink')) b.addEventListener('click', () => patch(r.id, { links: (r.links || []).filter((_, i) => i !== Number(b.dataset.i)) }, 'link removed'));
  q('.retranscribe').addEventListener('click', () => annotationsApi.transcribe(r.project, r.id, { language: q('.lang').value }).then(() => toast('transcribing again…')).catch((e) => toast('could not transcribe: ' + e.message)));
  q('.consent').addEventListener('change', (e) => patch(r.id, { consent: e.target.checked }, e.target.checked ? 'consent recorded' : 'consent withdrawn; erase the clip if the speaker asks'));
  q('.erase').addEventListener('click', () => erase(r));
  card.addEventListener('mouseenter', () => highlightDot(r.id, true));
  card.addEventListener('mouseleave', () => highlightDot(r.id, false));
}

// ---- plan: the room from above, one dot per clip --------------------------------
let planBox = null;      // { minX, maxX, minZ, maxZ, scale }
function renderPlan() {
  const all = [...records.values()];
  const svg = ui.plan;
  if (!all.length) { svg.innerHTML = ''; return; }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of all) { minX = Math.min(minX, r.anchor.x); maxX = Math.max(maxX, r.anchor.x); minZ = Math.min(minZ, r.anchor.z); maxZ = Math.max(maxZ, r.anchor.z); }
  const span = Math.max(maxX - minX, maxZ - minZ, 2) * 1.15;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const scale = 100 / span;
  planBox = { cx, cz, scale };
  const X = (x) => 50 + (x - cx) * scale, Y = (z) => 50 + (z - cz) * scale;     // +z (towards the default spawn) is down the page
  const dots = all.map((r) => `<circle data-id="${r.id}" cx="${X(r.anchor.x).toFixed(2)}" cy="${Y(r.anchor.z).toFixed(2)}" r="${r.parent && records.has(r.parent) ? 1.1 : 1.7}" fill="${colourOf(r)}" class="${matches(r) ? '' : 'dim'}${r.id === selectedId ? ' sel' : ''}"><title>${esc([r.author, periodLabel(r.period) || ago(r.createdAt), r.transcript ? r.transcript.slice(0, 60) : ''].filter(Boolean).join(' · '))}</title></circle>`).join('');
  const m = scale;   // one metre in viewBox units
  svg.innerHTML = `<line class="scale" x1="3" y1="97.5" x2="${(3 + m).toFixed(2)}" y2="97.5" /><text x="${(3 + m + 1).toFixed(2)}" y="98.5">1 m</text>${dots}<path id="poseArrow" class="pose" d="" />`;
  for (const c of svg.querySelectorAll('circle')) c.addEventListener('click', () => { selectCard(c.dataset.id, true); });
  drawPose();
}
function highlightDot(id, on) { const c = ui.plan.querySelector(`circle[data-id="${id}"]`); if (c) c.setAttribute('r', on ? 3 : (records.get(id)?.parent && records.has(records.get(id).parent) ? 1.1 : 1.7)); }
function selectCard(id, scroll) {
  selectedId = id;
  for (const a of ui.clips.querySelectorAll('article')) a.classList.toggle('sel', a.dataset.id === id);
  for (const c of ui.plan.querySelectorAll('circle')) c.classList.toggle('sel', c.dataset.id === id);
  if (scroll) ui.clips.querySelector(`article[data-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
// the author's viewpoint at the playhead: a short arrow from where they stood in the direction they faced
function drawPose() {
  const arrow = ui.plan.querySelector('#poseArrow');
  const r = records.get(selectedId);
  if (!arrow || !r || !planBox || !r.pose?.length || ui.audio.paused && ui.audio.currentTime === 0) { if (arrow) arrow.setAttribute('d', ''); return; }
  const t = ui.audio.currentTime * 1000;
  let s = r.pose[0]; for (const p of r.pose) { if (p.t <= t) s = p; else break; }
  const [qx, qy, qz, qw] = s.q;
  // forward vector of the camera (−Z) rotated by q, projected on the floor
  const fx = -(2 * (qx * qz + qw * qy)), fz = -(1 - 2 * (qx * qx + qy * qy));
  const { cx, cz, scale } = planBox;
  const X = (x) => 50 + (x - cx) * scale, Y = (z) => 50 + (z - cz) * scale;
  const x0 = X(s.p[0]), y0 = Y(s.p[2]), len = Math.max(4, 0.6 * scale);
  const x1 = x0 + fx * len, y1 = y0 + fz * len;
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const h = 1.8;
  arrow.setAttribute('d', `M${x0.toFixed(2)},${y0.toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} M${(x1 - h * Math.cos(ang - 0.5)).toFixed(2)},${(y1 - h * Math.sin(ang - 0.5)).toFixed(2)} L${x1.toFixed(2)},${y1.toFixed(2)} L${(x1 - h * Math.cos(ang + 0.5)).toFixed(2)},${(y1 - h * Math.sin(ang + 0.5)).toFixed(2)}`);
}

// ---- playback: one player, words follow the playhead -----------------------------------
function playClip(id, at) {
  const r = records.get(id);
  if (!r) return;
  if (ui.audio.getAttribute('data-id') !== id) { ui.audio.src = r.audioUrl; ui.audio.setAttribute('data-id', id); ui.audio.load(); }
  selectCard(id, false);
  ui.player.classList.add('on');
  ui.player.querySelector('.now').textContent = [r.author, periodLabel(r.period) || ago(r.createdAt)].filter(Boolean).join(' · ');
  const start = () => { ui.audio.currentTime = at; ui.audio.play().catch((e) => toast('could not play: ' + e.message)); };
  if (ui.audio.readyState >= 1) start(); else ui.audio.addEventListener('loadedmetadata', start, { once: true });
  renderPlayButtons();
}
function renderPlayButtons() {
  for (const a of ui.clips.querySelectorAll('article')) { const b = a.querySelector('.playBtn'); if (b) b.textContent = a.dataset.id === selectedId && !ui.audio.paused ? '■ stop' : '▶ play'; }
}
ui.audio.addEventListener('timeupdate', () => {
  const t = ui.audio.currentTime;
  ui.time.textContent = `${t.toFixed(1)} s`;
  const card = ui.clips.querySelector(`article[data-id="${selectedId}"]`);
  if (card) for (const w of card.querySelectorAll('.text .w')) w.classList.toggle('now', t >= Number(w.dataset.s) && t < Math.max(Number(w.dataset.e), Number(w.dataset.s) + 0.15));
  drawPose();
});
ui.audio.addEventListener('play', renderPlayButtons);
ui.audio.addEventListener('pause', () => { renderPlayButtons(); drawPose(); });
ui.audio.addEventListener('ended', () => { for (const w of ui.clips.querySelectorAll('.w.now')) w.classList.remove('now'); renderPlayButtons(); });

// ---- edits --------------------------------------------------------------------
async function patch(id, body, said) {
  try { const a = await annotationsApi.update(project.id, id, body); upsert(a); render(); if (said) toast(said); }
  catch (e) { toast('not saved: ' + e.message); }
}
// A photograph attached to a clip becomes a project asset placed at the clip's
// anchor, half a metre wide, hung 30 cm above the mark (so the mark stays
// visible) and turned towards the middle of the room, and the clip's record
// points at it. The room shows it where the clip is.
async function attachPhoto(r, file) {
  toast('uploading ' + file.name + '…');
  try {
    const asset = await assetsApi.upload(project.id, file, [], null, { mode: 'plane' });
    const a = r.anchor;
    const len = Math.hypot(a.x, a.z) || 1;
    const dx = -a.x / len, dz = -a.z / len;                              // towards the room's centre
    const rotY = (Math.atan2(dx, dz) * 180) / Math.PI;                   // plane normal +Z turned to face the centre
    await assetsApi.update(project.id, asset.id, { name: `${file.name} (${r.author})`, transform: { scale: 0.5, rotX: 0, rotY: Math.round(rotY), rotZ: 0, x: +(a.x + dx * 0.1).toFixed(3), y: +(a.y + 0.3).toFixed(3), z: +(a.z + dz * 0.1).toFixed(3) } });
    await patch(r.id, { links: [...(r.links || []), { kind: 'image', asset: asset.id, url: asset.url, title: file.name }] }, 'photo linked; it now hangs at the clip in the room');
  } catch (e) { toast('could not attach: ' + e.message); }
}
function erase(r) {
  if (armed?.id === r.id) {
    clearTimeout(armed.timer); armed = null;
    annotationsApi.remove(project.id, r.id).then(() => { records.delete(r.id); if (selectedId === r.id) { ui.audio.pause(); ui.player.classList.remove('on'); selectedId = null; } render(); toast('erased'); }).catch((e) => toast('not erased: ' + e.message));
    return;
  }
  if (armed) clearTimeout(armed.timer);
  armed = { id: r.id, timer: setTimeout(() => { armed = null; render(); }, 2500) };
  render();
}
let toastTimer = null;
function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('on'), 2600); }

// ---- data -----------------------------------------------------------------------
function upsert(a) { if (a.project !== project?.id) return; records.set(a.id, a); }
async function refreshProjects() {
  const list = await projectsApi.list();
  ui.project.innerHTML = list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (project) ui.project.value = project.id;
  return list;
}
async function openProject(id) {
  project = await projectsApi.get(id);
  ui.project.value = id;
  document.title = `${project.name} · Review · Glossy XR`;
  history.replaceState(null, '', `?project=${id}`);
  ui.roomLink.href = `/?project=${id}`; ui.visitorLink.href = `/?project=${id}&mode=visitor`; ui.exportLink.href = `/api/projects/${id}/export`;
  records = new Map(); selectedId = null; periodFilter = null; ui.audio.pause(); ui.player.classList.remove('on');
  for (const a of await annotationsApi.list(id)) records.set(a.id, a);
  render();
  net.join(id);
}
const net = connect({
  onAll: (all) => { records = new Map(); all.forEach(upsert); render(); },
  onNew: (a) => { if (a.project === project?.id) { upsert(a); render(); } },
  onDeleted: (d) => { if (records.delete(d.id)) render(); },
  onUpdated: (a) => { if (a.project === project?.id) { upsert(a); render(); } },
  onProjectUpdated: (p) => { if (p.id === project?.id) project = p; refreshProjects(); },
  onProjectsChanged: refreshProjects,
  onStatus: (s) => { if (s === 'connected' && project) net.join(project.id); },
});
ui.project.addEventListener('change', () => openProject(ui.project.value));
ui.search.addEventListener('input', () => { query = ui.search.value; render(); });

const list = await refreshProjects();
const wanted = new URLSearchParams(location.search).get('project');
const first = list.find((p) => p.id === wanted) || list[0];
if (first) await openProject(first.id);
else ui.count.textContent = 'no projects yet';

if (import.meta.env.DEV) window.__review = { get records() { return records; }, get selectedId() { return selectedId; }, get project() { return project; }, audio: ui.audio, matches, playClip };
