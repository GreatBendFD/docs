(function () {
'use strict';

/* ---------- push notifications & install ---------- */
// This is a public key, meant to be embedded in the website. The matching
// private key lives only in the Supabase Edge Function's secrets.
const VAPID_PUBLIC_KEY = 'BPbkERMctiDTWBUgHbXHZy1eUY6vRb6tb1Z79SexWW33uM7yebH7DPQVoDgDURXokC_WQ5ApM1DsoteuWXELAtE';
function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iP(hone|od|ad)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; render(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; render(); });
async function registerSW() { if (!pushSupported()) return null; try { return await navigator.serviceWorker.register('sw.js'); } catch (e) { return null; } }
async function currentPushSub() { if (!pushSupported()) return null; try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (e) { return null; } }
// Saves a subscription without relying on an upsert's ON CONFLICT DO UPDATE
// path -- that path needs its own database rule, separate from the insert
// and delete rules, which is easy to leave out and hard to notice until
// someone's phone already has a subscription and tries to re-save it. This
// only ever uses insert and delete, so it only ever needs those two rules.
async function savePushSub(j) {
  await sb.from('push_subscriptions').delete().eq('endpoint', j.endpoint);
  return await sb.from('push_subscriptions').insert({ member_id: S.me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
}
async function refreshPushState() {
  if (!pushSupported()) { S.pushState = 'unsupported'; return; }
  if (Notification.permission === 'denied') { S.pushState = 'denied'; return; }
  const sub = await currentPushSub();
  if (!sub) { S.pushState = 'off'; return; }
  // The browser having a subscription only means your phone talked to Apple or
  // Google's push service. It says nothing about whether this app's database
  // knows to use it. Confirm that separately, and re-save it if it's missing.
  const j = sub.toJSON();
  try {
    const r = await savePushSub(j);
    S.pushState = r.error ? 'error' : 'on';
    if (r.error) S.pushError = r.error.message;
  } catch (e) { S.pushState = 'error'; S.pushError = (e && e.message) || String(e); }
}
async function enablePush() {
  if (!S.me) return;
  await registerSW();
  let perm;
  try { perm = await Notification.requestPermission(); } catch (e) { toast('Could not turn on notifications: ' + ((e && e.message) || String(e)), 'bad'); return; }
  if (perm !== 'granted') { S.pushState = perm === 'denied' ? 'denied' : 'off'; render(); if (perm === 'denied') toast('Notifications are blocked for this site in your browser settings.', 'bad'); return; }
  let sub;
  try {
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  } catch (e) { toast('Could not turn on notifications: ' + ((e && e.message) || String(e)), 'bad'); return; }
  // The phone is now genuinely registered with Apple or Google's push service.
  // What's left is telling our own database to use it, which is a separate
  // step that can fail on its own (for example, if 06_push.sql has not been
  // run yet) without the phone-level part failing at all.
  const j = sub.toJSON();
  try {
    const r = await savePushSub(j);
    if (r.error) throw r.error;
    S.pushState = 'on'; S.pushError = ''; toast('Notifications are on', 'ok');
  } catch (e) {
    S.pushState = 'error'; S.pushError = (e && e.message) || String(e);
    toast('Your phone is set up, but saving it to the department\'s records failed: ' + S.pushError, 'bad');
  }
  render();
}
async function disablePush() {
  try {
    const sub = await currentPushSub();
    if (sub) { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
    S.pushState = 'off'; toast('Notifications are off', 'ok'); render();
  } catch (e) { toast('Could not turn off notifications: ' + ((e && e.message) || String(e)), 'bad'); }
}
function pushCardHtml() {
  if (!S.me || !pushSupported()) return '';
  if (isIOS() && !isStandalone()) {
    return `<div class="card pad stack" style="gap:8px;margin-bottom:14px"><b>Get notifications on this iPhone</b><span class="sm muted">Tap the Share icon in Safari, then "Add to Home Screen". Open the app from that icon, then come back here to turn notifications on.</span></div>`;
  }
  const installBtn = deferredInstallPrompt ? `<button class="btn sm" data-action="install-app">Add to home screen</button>` : '';
  if (S.pushState === 'on') return `<div class="card pad spread" style="margin-bottom:14px"><span>Notifications are on for this device.</span><button class="btn sm" data-action="push-off">Turn off</button></div>`;
  if (S.pushState === 'error') return `<div class="card pad stack" style="gap:6px;margin-bottom:14px"><span><b>Almost on:</b> this phone is set up with Apple or Google, but saving that to the department's records failed${S.pushError ? ': ' + esc(S.pushError) : '.'}</span><div class="row"><button class="btn sm primary" data-action="push-on">Try again</button><button class="btn sm" data-action="push-off">Turn off</button></div></div>`;
  if (S.pushState === 'denied') return `<div class="card pad" style="margin-bottom:14px"><span class="sm muted">Notifications are blocked for this site. Check your browser's site settings to allow them.</span></div>`;
  return `<div class="card pad spread" style="margin-bottom:14px"><span>Get a notification when there's an urgent message.</span><span class="row">${installBtn}<button class="btn sm primary" data-action="push-on">Turn on notifications</button></span></div>`;
}

/* ---------- small helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => iso(new Date());
const pd = s => new Date(s + 'T00:00:00');
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (s, n) => { const d = pd(s); const day = d.getDate(); d.setMonth(d.getMonth() + n); if (d.getDate() < day) d.setDate(0); return iso(d); };
const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / 864e5);
const fmt = s => s ? pd(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const plural = (n, a, b) => n === 1 ? a : (b || a + 's');
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
const chip = (t, tone) => `<span class="chip${tone ? ' ' + tone : ''}">${esc(t)}</span>`;
const sheet = (title, body, foot, sub) => `<div class="sheet-h"><div><h2>${title}</h2>${sub ? `<div class="muted sm">${sub}</div>` : ''}</div><button class="x" data-action="m-close" aria-label="Close">×</button></div><div class="sheet-b">${body}</div>${foot ? `<div class="sheet-f">${foot}</div>` : ''}`;

async function copyText(v) {
  try { await navigator.clipboard.writeText(v); toast('Copied', 'ok'); return; } catch (e) {}
  try { const ta = document.createElement('textarea'); ta.value = v; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); toast(ok ? 'Copied' : 'Could not copy. Press and hold the text instead.', ok ? 'ok' : 'bad'); }
  catch (e2) { toast('Could not copy. Press and hold the text instead.', 'bad'); }
}
function toast(msg, kind) {
  const t = $('#toast'), d = document.createElement('div');
  d.textContent = msg; if (kind) d.className = kind; t.appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6000 : 3200);
}

/* ---------- permissions (the database enforces these; this only decides what to show) ---------- */
const CATS = ['Interior Firefighter', 'Exterior Firefighter', 'Fire Police', 'Pump/Apparatus Operator', 'Administrative Member', 'Exempt Member'];
const PERM_KEYS = ['view_apparatus', 'run_checks', 'edit_equipment', 'log_inspections', 'view_roster', 'manage_training', 'post_messages', 'manage_members', 'manage_events', 'log_incidents', 'admin_setup'];
const PRESET = {
  admin: PERM_KEYS.slice(),
  officer: ['view_apparatus', 'run_checks', 'edit_equipment', 'log_inspections', 'view_roster', 'manage_training', 'post_messages', 'log_incidents', 'manage_events'],
  member: ['view_apparatus']
};
const RANKS = ['Chief', '1st Assistant Chief', '2nd Assistant Chief', '3rd Assistant Chief', 'Captain', 'Lieutenant', 'Firefighter', 'Probationary', 'Fire police', 'President', 'Vice President', 'Secretary', 'Treasurer', 'Commissioner'];
const PERMS = [
  ['view_apparatus', 'See apparatus, equipment, inspections and deficiencies'],
  ['run_checks', 'Run checks, log deficiencies, mark a rig out of service'],
  ['edit_equipment', 'Add and edit equipment, rig details and checklists'],
  ['log_inspections', 'Log inspections and tests'],
  ['view_roster', 'See the roster and everyone\u2019s training status'],
  ['manage_training', 'Record training, fit tests and other requirements for members'],
  ['post_messages', 'Post messages to the landing page ribbon'],
  ['manage_members', 'Add members, set roles and permissions, manage requirements'],
  ['manage_events', 'Create and edit events, and sign other members up'],
  ['log_incidents', 'Prepare incident reports from CAD emails for NERIS'],
  ['admin_setup', 'Edit the base checklist, archive rigs, delete records, export data']
];
function roleKeyOf(perms) {
  for (const r in PRESET) { if (PERM_KEYS.every(k => !!perms[k] === PRESET[r].includes(k))) return r; }
  return 'custom';
}
const roleLabelOf = perms => { const k = roleKeyOf(perms); return k === 'admin' ? 'Administrator' : k === 'officer' ? 'Officer' : k === 'custom' ? 'Custom access' : 'Member'; };
function effPerms(access) {
  const role = (access && access.role) || 'member';
  const base = Object.fromEntries(PERM_KEYS.map(k => [k, (PRESET[role] || PRESET.member).includes(k)]));
  return Object.assign(base, (access && access.perms) || {});
}

/* ---------- requirements and probation (same rules as the prototype) ---------- */
const REQ_FREQS = { annual: 'Every year', semiannual: 'Every 6 months', quarterly: 'Every 3 months', '2y': 'Every 2 years', '3y': 'Every 3 years', '5y': 'Every 5 years', once: 'One time only' };
const REQ_FREQ_OPTS = [['annual', 'Every year'], ['semiannual', 'Every 6 months'], ['quarterly', 'Every 3 months'], ['2y', 'Every 2 years'], ['3y', 'Every 3 years'], ['5y', 'Every 5 years'], ['once', 'One time only'], ['custom', 'Custom (days)']];
const REQ_FREQ_DAYS = { annual: 365, semiannual: 182, quarterly: 91, '2y': 730, '3y': 1095, '5y': 1826, once: 0 };
const freqDaysOf = (freq, days) => freq === 'custom' ? Math.max(1, Number(days) || 365) : (REQ_FREQ_DAYS[freq] ?? 365);
const reqFreqLabel = r => r.freq === 'custom' ? 'Every ' + (Number(r.days) || 365) + ' days' : (REQ_FREQS[r.freq] || REQ_FREQS.annual);
const FAILRES = ['Fail', 'Not cleared'];
const PROB = 'Probationary';
const probMonths = () => Number(S.settings && S.settings.probation_months) || 6;
const isProbTitle = m => String((m && m.title) || '').trim().toLowerCase() === PROB.toLowerCase();
function probEnd(m) { if (!isProbTitle(m)) return ''; if (m.probation_end) return m.probation_end; return m.joined ? addMonths(m.joined, probMonths()) : ''; }
function probInfo(m) { if (!isProbTitle(m)) return null; const end = probEnd(m); if (!end) return { state: 'nodate' }; if (end <= today()) return { state: 'released', end }; return { state: 'on', end, diff: diffDays(today(), end) }; }
function rankOf(m) { const p = probInfo(m); return p && p.state === 'released' ? 'Firefighter' : ((m && m.title) || ''); }
function probChip(m) { const p = probInfo(m); if (!p) return ''; if (p.state === 'nodate') return chip('Probationary, no join date', 'warn'); if (p.state === 'on') return chip('Probation ends ' + fmt(p.end), p.diff <= 30 ? 'warn' : ''); return ''; }
function probLine(m) { const p = probInfo(m); if (!p) return ''; if (p.state === 'nodate') return 'Add a join date so probation can end automatically.'; if (p.state === 'on') return `On probation until ${fmt(p.end)}, then becomes Firefighter automatically.`; return `Released from probation on ${fmt(p.end)}${m.probation_end ? '' : ' (' + probMonths() + ' months after joining)'}.`; }
function tenure(j) {
  if (!j) return '';
  const t = today(); let mo = (+t.slice(0, 4) - +j.slice(0, 4)) * 12 + (+t.slice(5, 7) - +j.slice(5, 7));
  if (+t.slice(8, 10) < +j.slice(8, 10)) mo--; if (mo < 0) return '';
  const y = Math.floor(mo / 12), r = mo % 12;
  return [y ? y + ' ' + plural(y, 'year') : '', r || !y ? r + ' ' + plural(r, 'month') : ''].filter(Boolean).join(', ');
}

/* ---------- state ---------- */
let sb = null, session = null;
const S = {
  loading: true, error: '', fatal: '', me: null, access: null, priv: null, perms: {}, settings: { probation_months: 6 },
  members: [], reqs: [], records: [], messages: [], dismissed: new Set(), tab: 'home', mtab: 'roster', q: '', od: { none: true, soon: true },
  rigs: [], equipment: [], items: [], sessions: [], results: [], defs: [],
  rigId: null, rsub: 'checks', eq: { q: '', where: 'all', cat: 'all', ret: false }, showArch: {}, showBase: {}, defShow: 'open',
  audit: null, auditLoading: false, auditError: '', pushState: 'unsupported', pushError: '',
  events: [], signups: [], trainings: [], attendanceRows: [], eventAttendanceRows: [], ev: { month: '', day: '', past: false },
  threads: [], replies: [], boardReads: [], brdBoard: null, brdThread: null
};
let D = { latest: {}, memById: {} };
const MS = [];

function resetState() {
  S.me = null; S.access = null; S.priv = null; S.perms = {}; S.members = []; S.reqs = []; S.records = []; S.messages = []; S.dismissed = new Set(); S.tab = 'home'; S.mtab = 'roster'; S.q = ''; S.od = { none: true, soon: true }; S.error = '';
  S.rigs = []; S.equipment = []; S.items = []; S.sessions = []; S.results = []; S.defs = []; S.rigId = null; S.rsub = 'checks'; S.eq = { q: '', where: 'all', cat: 'all', ret: false }; S.showArch = {}; S.showBase = {}; S.defShow = 'open';
  S.audit = null; S.auditLoading = false; S.auditError = ''; S.loading = false;
  S.events = []; S.signups = []; S.trainings = []; S.attendanceRows = []; S.eventAttendanceRows = []; S.ev = { month: '', day: '', past: false };
  S.threads = []; S.replies = []; S.boardReads = []; S.brdBoard = null; S.brdThread = null;
  D = { latest: {}, memById: {} }; MS.length = 0;
}

function derive() {
  D.memById = Object.fromEntries(S.members.map(m => [m.id, m]));
  D.latest = {};
  for (const r of S.records) {
    const c = (D.latest[r.member_id] = D.latest[r.member_id] || {}), cur = c[r.requirement_id];
    if (!cur || (r.done_on || '') > (cur.done_on || '') || ((r.done_on || '') === (cur.done_on || '') && (r.created_at || '') > (cur.created_at || ''))) c[r.requirement_id] = r;
  }
  D.signByEvent = {};
  for (const s of S.signups) (D.signByEvent[s.event_id] = D.signByEvent[s.event_id] || {})[s.member_id] = s;
  D.attendance = {};
  for (const a of S.attendanceRows) (D.attendance[a.training_id] = D.attendance[a.training_id] || []).push(a.member_id);
  D.evAttendance = {};
  for (const a of S.eventAttendanceRows) (D.evAttendance[a.event_id] = D.evAttendance[a.event_id] || []).push(a.member_id);
  D.repliesByThread = {};
  for (const r of S.replies) (D.repliesByThread[r.thread_id] = D.repliesByThread[r.thread_id] || []).push(r);
  D.boardRead = D.boardRead || {};
  for (const r of S.boardReads) if (!D.boardRead[r.board] || r.last_read_at > D.boardRead[r.board]) D.boardRead[r.board] = r.last_read_at;
  D.rigById = Object.fromEntries(S.rigs.map(r => [r.id, r]));
  D.eqById = Object.fromEntries(S.equipment.map(e => [e.id, e]));
  D.resBySession = {};
  for (const r of S.results) (D.resBySession[r.session_id] = D.resBySession[r.session_id] || []).push(r);
  // last time each checklist item was checked, per rig (base items are shared across rigs, so key by rig+item)
  D.lastDone = {};
  const sessByRig = {};
  for (const s of S.sessions) (sessByRig[s.rig_id || 'station'] = sessByRig[s.rig_id || 'station'] || []).push(s);
  for (const rigKey in sessByRig) {
    const sess = sessByRig[rigKey].slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.created_at || '').localeCompare(b.created_at || ''));
    for (const s of sess) for (const r of (D.resBySession[s.id] || [])) {
      if (!r.item_id) continue;
      D.lastDone[r.item_id + '|' + rigKey] = { date: s.date, status: r.status };
      D.lastDone[r.item_id] = { date: s.date, status: r.status };  // equipment items aren't shared, so the plain key is enough for them
    }
  }
}

function reqRows(m) {
  const lat = D.latest[m.id] || {};
  const reqs = S.reqs.filter(r => r.active !== false && ((m.category && (r.categories || []).includes(m.category)) || lat[r.id])).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
  return reqs.map(r => {
    const rec = lat[r.id] || null; let state = 'none', diff = null;
    if (rec) { if (FAILRES.includes(rec.result)) state = 'failed'; else if (rec.due_on) { diff = diffDays(today(), rec.due_on); state = diff < 0 ? 'overdue' : diff <= 30 ? 'soon' : 'ok'; } else state = 'ok'; }
    return { req: r, rec, state, diff };
  });
}
const needsAttn = x => x.state === 'none' || x.state === 'overdue' || x.state === 'failed';
function reqChip(x) {
  switch (x.state) {
    case 'none': return chip('No record yet', 'warn');
    case 'failed': return chip('Not current', 'bad');
    case 'overdue': return chip(`Overdue ${-x.diff} ${plural(-x.diff, 'day')}`, 'bad');
    case 'soon': return chip(x.diff === 0 ? 'Due today' : `Due in ${x.diff} ${plural(x.diff, 'day')}`, 'warn');
    default: return chip(x.rec && x.rec.approx ? 'Done in ' + (x.rec.done_on || '').slice(0, 4) : x.rec && x.rec.due_on ? 'Current until ' + fmt(x.rec.due_on) : 'Completed', 'ok');
  }
}
function reqLine(x, memberId) {
  const r = x.rec;
  const when = !r ? 'Nothing recorded yet.' : !r.done_on ? 'On record, date not recorded.' : r.approx ? `Done in ${esc(r.done_on.slice(0, 4))}, exact date not recorded.` : `Last done ${esc(fmt(r.done_on))}${r.result ? ', ' + esc(r.result) : ''}.`;
  const canRecord = memberId && S.perms.manage_training;
  return `<div class="li"><div class="t"><b>${esc(x.req.name)}</b><span class="muted sm">${when}${r && r.notes && r.notes.length <= 40 && !r.approx ? ' ' + esc(r.notes) + '.' : ''} ${esc(reqFreqLabel(x.req))}.</span></div><div class="acts">${reqChip(x)}${canRecord ? `<button class="btn sm" data-action="rec-new" data-member="${esc(memberId)}" data-req="${esc(x.req.id)}">Record</button>` : ''}</div></div>`;
}
function myAlertHtml(m) {
  const rows = reqRows(m);
  const od = rows.filter(x => x.state === 'overdue' || x.state === 'failed'), soon = rows.filter(x => x.state === 'soon'), none = rows.filter(x => x.state === 'none');
  if (!od.length && !soon.length && !none.length) return '';
  const names = l => l.map(x => x.req.name).join(', ');
  const parts = [od.length ? `Overdue: ${names(od)}.` : '', none.length ? `No record yet: ${names(none)}.` : '', soon.length ? `Due soon: ${names(soon)}.` : ''].filter(Boolean).join(' ');
  return `<div class="ribbon ${od.length ? 'urgent' : 'notice'}"><div class="rb-t"><span class="rb-text">${esc(parts)}</span><span class="rb-from">Details are on this page below.</span></div></div>`;
}

/* ---------- messages (the ribbon) ---------- */
const msgActive = m => { const t = today(); return !m.removed && (!m.starts_on || m.starts_on <= t) && (!m.ends_on || m.ends_on >= t); };
const msgForMe = m => m.aud_all || (!!(S.me && S.me.category) && (m.aud_cats || []).includes(S.me.category));
const msgFrom = m => { const x = m.by_member && D.memById[m.by_member]; return x ? ((rankOf(x) ? rankOf(x) + ' ' : '') + x.name) : 'Administration'; };
function ribbonHtml() {
  const rank = { urgent: 0, notice: 1, info: 2 };
  const list = S.messages.filter(m => msgActive(m) && msgForMe(m) && (m.tone === 'urgent' || !S.dismissed.has(m.id)))
    .sort((a, b) => (rank[a.tone] ?? 2) - (rank[b.tone] ?? 2) || (b.created_at || '').localeCompare(a.created_at || ''));
  if (!list.length) return '';
  return `<div class="ribbons" role="region" aria-label="Messages">${list.map(m => `<div class="ribbon ${esc(m.tone || 'info')}"><div class="rb-t"><span class="rb-text">${esc(m.body)}</span><span class="rb-from">${esc(msgFrom(m))}, ${esc(fmt((m.created_at || '').slice(0, 10)))}</span></div>${m.tone === 'urgent' ? '' : `<button class="rb-x" data-action="dismiss" data-id="${esc(m.id)}" aria-label="Dismiss message">×</button>`}</div>`).join('')}</div>`;
}

/* ---------- views ---------- */
function shell(html) { return `<div class="wrap">${html}</div>`; }

function signInView(err) {
  return shell(`<div class="card pad stack" style="max-width:420px;margin:24px auto;gap:14px">
    <div><h1>Sign in</h1><p class="muted sm" style="margin-top:4px">This site is for members of Great Bend Fire Department. It is invite-only.</p></div>
    <form id="f-signin" class="form" autocomplete="on">
      <label class="f"><span>Email</span><input name="email" type="email" required autocomplete="username" inputmode="email"></label>
      <label class="f"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
      ${err ? `<div class="banner">${esc(err)}</div>` : ''}
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <p class="muted sm">Need access or forgot your password? Ask an administrator.</p></div>`);
}

function setupView() {
  return shell(`<div class="card pad stack" style="max-width:560px;margin:24px auto;gap:10px"><h2>Almost ready</h2>
    <p>This site is not connected to its database yet. Open <b>js/config.js</b>, paste in your Supabase project URL and publishable key, and save.</p>
    <p class="muted sm">Never paste the secret (service role) key there.</p></div>`);
}

function unlinkedView() {
  const email = session && session.user ? session.user.email : '';
  return shell(`<div class="card pad stack" style="max-width:560px;margin:24px auto;gap:10px"><h2>Your sign-in is not linked to a member record yet</h2>
    <p>You are signed in as <b>${esc(email)}</b>, but no member record uses that email, or the record is marked inactive.</p>
    <p class="muted sm">Ask an administrator to check that your member record has exactly this email address.</p></div>`);
}

function homeView() {
  const m = S.me, rows = reqRows(m), alert = myAlertHtml(m);
  const p = S.priv || {};
  const dep = m.joined || probInfo(m) ? `<div class="sm muted" style="margin-top:6px">${m.joined ? 'Joined ' + esc(fmt(m.joined)) + (tenure(m.joined) ? ' (' + esc(tenure(m.joined)) + '). ' : '. ') : ''}${esc(probLine(m))}</div>` : '';
  return `${ribbonHtml()}${alert ? `<div class="ribbons">${alert}</div>` : ''}
    ${pushCardHtml()}
    <div class="head-row"><div><h1>Hello, ${esc(first(m.name))}</h1>
      <div class="rc-chips" style="margin-top:6px">${chip(m.category || 'No category set')}${rankOf(m) ? chip(rankOf(m)) : ''}${probChip(m)}${S.access ? chip(roleLabel()) : ''}</div>${dep}
      ${p.nys_id ? `<div class="sm muted" style="margin-top:6px">NYS training ID: <b style="color:var(--ink)">${esc(p.nys_id)}</b></div>` : ''}</div></div>
    <div class="sec" style="margin-top:0"><h3>My requirements</h3></div>
    <div class="card list">${rows.length ? rows.map(x => reqLine(x, m.id)).join('') : `<div class="empty">${m.category ? 'Nothing is required for ' + esc(m.category) + ' members yet.' : 'No category is set on your record yet.'}</div>`}</div>
    ${homeEvents()}
    ${homeAppStatus()}
    <p class="muted sm" style="margin-top:18px">Signed in as ${esc(session.user.email)}. Role: ${esc(roleLabel())}.</p>`;
}
const saveBtn = (formId, label) => `<button class="btn primary" type="submit" form="${formId}">${label || 'Save'}</button>`;
const roleLabel = () => { const r = S.access && S.access.role; return r === 'admin' ? 'Administrator' : r === 'officer' ? 'Officer' : r === 'custom' ? 'Custom access' : 'Member'; };

function memberCard(m) {
  const canSee = S.perms.view_roster || S.perms.manage_training;
  const rows = canSee ? reqRows(m) : [], bad = rows.filter(needsAttn).length, soon = rows.filter(x => x.state === 'soon').length;
  const comp = !canSee || m.status === 'inactive' ? '' : !rows.length ? chip('No requirements') : bad ? chip(bad + ' overdue or missing', 'bad') : soon ? chip(soon + ' due soon', 'warn') : chip('All current', 'ok');
  return `<button class="card eqcard${m.status === 'inactive' ? ' retired' : ''}" data-action="mem-open" data-id="${esc(m.id)}"><span class="top2"><b>${esc(m.name)}</b>${chip(m.category || 'No category')}</span><span class="muted sm">${esc(rankOf(m)) || '&nbsp;'}</span><span class="rc-chips">${m.status === 'inactive' ? chip('Inactive', 'bad') : ''}${probChip(m)}${comp}</span></button>`;
}
function memList() {
  const q = S.q.trim().toLowerCase();
  const list = S.members.filter(m => m.status !== 'inactive' && (!q || (m.name + ' ' + rankOf(m) + ' ' + (m.title || '')).toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  return list.length ? `<div class="eqlist">${list.map(memberCard).join('')}</div>` : '<div class="card empty">Nobody matches.</div>';
}
function rosterView() {
  const active = S.members.filter(m => m.status !== 'inactive');
  return `<div class="rc-chips" style="margin-bottom:12px">${chip(active.length + ' active')}${CATS.map(c => chip(c + ' ' + active.filter(m => m.category === c).length)).join('')}</div>
    <div class="filters" style="grid-template-columns:1fr"><label class="f"><span>Search</span><input id="mem-q" type="search" value="${esc(S.q)}" placeholder="Name or rank"></label></div>
    <div id="mem-list">${memList()}</div>`;
}
function reqsView() {
  const list = S.reqs.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
  return `<div class="head-row"><div><h3>Requirements</h3><span class="muted sm">What each category has to keep current.</span></div><button class="btn primary" data-action="req-new">Add requirement</button></div>
    <div class="card list">${list.length ? list.map(r => `<div class="li${r.active === false ? ' off' : ''}"><div class="t"><b>${esc(r.name)}</b><span class="muted sm">${esc(reqFreqLabel(r))}. Applies to ${esc((r.categories || []).join(', ') || 'no one yet')}.</span></div><div class="acts"><button class="btn sm" data-action="req-edit" data-id="${esc(r.id)}">Edit</button><button class="btn sm" data-action="req-archive" data-id="${esc(r.id)}" data-on="${r.active === false ? '1' : '0'}">${r.active === false ? 'Restore' : 'Archive'}</button></div></div>`).join('') : '<div class="empty">No requirements yet.</div>'}</div>`;
}
function membersView() {
  const tabs = [['roster', 'Roster']];
  if (S.perms.view_roster) tabs.push(['overdue', 'Overdue']);
  if (S.perms.view_roster || S.perms.manage_training) tabs.push(['training', 'Training']);
  if (S.perms.manage_members) tabs.push(['reqs', 'Requirements']);
  if (!tabs.some(t => t[0] === S.mtab)) S.mtab = 'roster';
  const body = S.mtab === 'reqs' ? reqsView() : S.mtab === 'overdue' ? overdueView() : S.mtab === 'training' ? trainingsView() : rosterView();
  return `<div class="head-row"><h1>Members</h1>${S.mtab === 'roster' && S.perms.manage_members ? '<button class="btn primary" data-action="mem-new">Add member</button>' : ''}</div>
    ${tabs.length > 1 ? `<div class="subtabs">${tabs.map(([k, l]) => `<button data-action="mtab" data-tab="${k}"${S.mtab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</div>` : ''}
    ${body}`;
}
function memSheet(id) {
  const m = D.memById[id]; if (!m) return '';
  const canSee = S.perms.view_roster || S.perms.manage_training || m.id === S.me.id;
  const rows = canSee ? reqRows(m) : [];
  return `<div class="sheet-h"><div><h2>${esc(m.name)}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><div class="rc-chips" style="margin-bottom:12px">${chip(m.category || 'No category')}${rankOf(m) ? chip(rankOf(m)) : ''}${probChip(m)}</div>
      ${m.joined || probInfo(m) ? `<div class="sm muted" style="margin:-4px 0 12px">${m.joined ? 'Joined ' + esc(fmt(m.joined)) + (tenure(m.joined) ? ' (' + esc(tenure(m.joined)) + '). ' : '. ') : ''}${esc(probLine(m))}</div>` : ''}
      <div class="sec" style="margin-top:0"><h3>Requirements</h3></div>
      <div class="card list">${rows.length ? rows.map(x => reqLine(x, m.id)).join('') : `<div class="empty">${canSee ? 'Nothing is required yet.' : 'You can see the directory but not training records.'}</div>`}</div></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Close</button>${S.perms.admin_setup ? `<button class="btn danger" data-action="mem-delete" data-id="${esc(id)}">Delete</button>` : ''}${S.perms.manage_members ? `<button class="btn primary" data-action="mem-edit" data-id="${esc(id)}">Edit</button>` : ''}</div>`;
}
async function deleteMember(id) {
  const m = D.memById[id]; if (!m) return;
  if (id === S.me.id) { toast("You can't delete your own account while signed in as them.", 'bad'); return; }
  const ok = window.confirm(`Delete ${m.name}?\n\nThis permanently removes their member record and every training record tied to them. It cannot be undone.\n\nIf they've simply left the department, cancel this and use Inactive instead (Edit, then set Status to Inactive) -- that keeps their history.`);
  if (!ok) return;
  const r = await sb.from('members').delete().eq('id', id);
  if (r.error) { toast('Could not delete: ' + r.error.message, 'bad'); return; }
  MS.length = 0; drawModal(); toast('Member deleted', 'ok'); loadAll();
}


/* ---------- add / edit member ---------- */
function memberFormHtml(m, priv, access) {
  const x = m || { status: 'active' };
  const perms = access ? effPerms(access) : Object.fromEntries(PERM_KEYS.map(k => [k, PRESET.member.includes(k)]));
  const roleSel = access ? roleKeyOf(perms) : 'member';
  return `<div class="sheet-h"><div><h2>${m ? 'Edit member' : 'Add member'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-mem" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Name</span><input name="name" value="${esc(x.name || '')}" required></label>
      <label class="f"><span>Email</span><input name="email" type="email" value="${esc((priv && priv.email) || '')}" placeholder="Used to link their sign-in"></label>
      <div class="two">
        <label class="f"><span>Title or rank</span><input name="title" list="dl-rank" value="${esc(x.title || '')}"></label>
        <label class="f"><span>Category</span><select name="category"><option value="">None</option>${CATS.map(c => `<option value="${esc(c)}"${x.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      </div>
      <div class="two">
        <label class="f"><span>Date joined</span><input name="joined" type="date" max="${today()}" value="${esc(x.joined || (m ? '' : today()))}"></label>
        <label class="f" data-prob-wrap hidden><span>Probation ends (optional)</span><input name="probation_end" type="date" value="${esc(x.probation_end || '')}"></label>
      </div>
      <div class="muted sm" style="margin-top:-6px">Titled Probationary? They become Firefighters automatically ${probMonths()} months after the date joined. Use "Probation ends" only to extend or shorten one person.</div>
      ${m ? `<label class="f"><span>Status</span><select name="status"><option value="active"${x.status !== 'inactive' ? ' selected' : ''}>Active</option><option value="inactive"${x.status === 'inactive' ? ' selected' : ''}>Inactive</option></select></label>` : ''}
      <label class="f"><span>NYS training ID</span><input name="nys_id" value="${esc((priv && priv.nys_id) || '')}" placeholder="Used on state training records"></label>
      <label class="f"><span>Role</span><select name="role">${[['admin', 'Administrator'], ['officer', 'Officer'], ['member', 'Member'], ['custom', 'Custom']].map(([k, l]) => `<option value="${k}"${roleSel === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="f"><span>What this person can do</span><div class="permlist">${PERMS.map(([k, l]) => `<label class="chk perm"><input type="checkbox" name="perm_${k}" data-perm="${k}"${perms[k] ? ' checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></div>
      <datalist id="dl-rank">${RANKS.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button><button class="btn primary" type="submit" form="f-mem">Save</button></div>`;
}
function memFormMount(root) {
  const sel = root.querySelector('[name=role]'), boxes = [...root.querySelectorAll('input[data-perm]')];
  const ti = root.querySelector('[name=title]'), pw = root.querySelector('[data-prob-wrap]');
  if (ti && pw) { const u = () => { pw.hidden = ti.value.trim().toLowerCase() !== PROB.toLowerCase(); }; ti.addEventListener('input', u); u(); }
  if (!sel) return;
  const detect = () => { const on = new Set(boxes.filter(b => b.checked).map(b => b.dataset.perm)); for (const r in PRESET) { if (PERM_KEYS.every(k => on.has(k) === PRESET[r].includes(k))) { sel.value = r; return; } } sel.value = 'custom'; };
  sel.addEventListener('change', () => { if (PRESET[sel.value]) { const set = new Set(PRESET[sel.value]); boxes.forEach(b => { b.checked = set.has(b.dataset.perm); }); } });
  boxes.forEach(b => b.addEventListener('change', detect));
}
async function openMemberForm(id) {
  let m = null, priv = null, access = null;
  if (id) {
    m = D.memById[id];
    const [p, a] = await Promise.all([sb.from('member_private').select('*').eq('member_id', id).maybeSingle(), sb.from('member_access').select('*').eq('member_id', id).maybeSingle()]);
    if (p.error || a.error) { toast('Could not load that member: ' + ((p.error || a.error).message), 'bad'); return; }
    priv = p.data; access = a.data;
  }
  MS.push(() => memberFormHtml(m, priv, access));
  drawModal(); memFormMount(document.querySelector('#modal-root'));
}
async function saveMemberForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  const name = String(fd.get('name') || '').trim();
  if (!name) { toast('Enter a name.', 'bad'); return; }
  const email = String(fd.get('email') || '').trim();
  const title = String(fd.get('title') || '').trim();
  const category = fd.get('category') || '';
  const joined = fd.get('joined') || null;
  const probEndVal = title.toLowerCase() === PROB.toLowerCase() ? (fd.get('probation_end') || null) : null;
  const status = id ? (fd.get('status') || 'active') : 'active';
  const nysId = String(fd.get('nys_id') || '').trim();
  const role = fd.get('role');
  const perms = Object.fromEntries(PERM_KEYS.map(k => [k, !!fd.get('perm_' + k)]));
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    let mid = id;
    if (id) {
      const r = await sb.from('members').update({ name, title, category, joined, probation_end: probEndVal, status }).eq('id', id);
      if (r.error) throw r.error;
    } else {
      const r = await sb.from('members').insert({ name, title, category, joined, probation_end: probEndVal, status: 'active' }).select('id').single();
      if (r.error) throw r.error;
      mid = r.data.id;
    }
    if (email || nysId || id) {
      const r = await sb.from('member_private').upsert({ member_id: mid, email: email || null, nys_id: nysId }, { onConflict: 'member_id' });
      if (r.error) { if (/duplicate|unique/i.test(r.error.message)) throw new Error('That email is already used by another member.'); throw r.error; }
    }
    const r = await sb.from('member_access').upsert({ member_id: mid, role, perms }, { onConflict: 'member_id' });
    if (r.error) throw r.error;
    MS.pop(); drawModal(); toast('Member saved', 'ok'); loadAll();
  } catch (e) {
    toast('Could not save: ' + ((e && e.message) || String(e)), 'bad');
    if (btn) btn.disabled = false;
  }
}


/* ---------- requirements (admin) ---------- */
function reqFormHtml(r) {
  const x = r || { freq: 'annual', days: 365, categories: [] };
  return `<div class="sheet-h"><div><h2>${r ? 'Edit requirement' : 'Add requirement'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-req" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Name</span><input name="name" value="${esc(x.name || '')}" required placeholder="SCBA fit test, CPR, medical clearance"></label>
      <label class="f"><span>How often</span><select name="freq">${REQ_FREQ_OPTS.map(([k, l]) => `<option value="${k}"${(x.freq || 'annual') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f" data-days-wrap hidden><span>Every how many days?</span><input name="days" type="number" min="1" value="${esc(x.days || 365)}"></label>
      <div class="f"><span>Applies to</span><div class="aud">${CATS.map(c => `<label class="chk"><input type="checkbox" name="cat" value="${esc(c)}"${(x.categories || []).includes(c) ? ' checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div></div>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${r ? `<button class="btn danger" data-action="req-archive" data-id="${esc(x.id)}" data-on="${x.active === false ? '1' : '0'}">${x.active === false ? 'Restore' : 'Archive'}</button>` : ''}<button class="btn primary" type="submit" form="f-req">Save</button></div>`;
}
function reqFormMount(root) {
  const sel = root.querySelector('[name=freq]'), w = root.querySelector('[data-days-wrap]'); if (!sel || !w) return;
  const u = () => { w.hidden = sel.value !== 'custom'; }; sel.addEventListener('change', u); u();
}
async function saveReqForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  const name = String(fd.get('name') || '').trim(); if (!name) { toast('Enter a name.', 'bad'); return; }
  const freq = fd.get('freq'), days = freqDaysOf(freq, fd.get('days'));
  const categories = fd.getAll('cat');
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('requirements').update({ name, freq, days, categories }).eq('id', id); if (r.error) throw r.error; }
    else { const r = await sb.from('requirements').insert({ name, freq, days, categories, active: true, sort: (Math.max(0, ...S.reqs.map(x => x.sort || 0)) + 10) }); if (r.error) throw r.error; }
    MS.pop(); drawModal(); toast('Requirement saved', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
async function toggleReqArchive(id, turnOn) {
  const r = await sb.from('requirements').update({ active: turnOn }).eq('id', id);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  if (MS.length) { MS.pop(); drawModal(); }
  toast(turnOn ? 'Requirement restored' : 'Requirement archived. Records are kept.', 'ok'); loadAll();
}

/* ---------- recording a training completion ---------- */
function recordFormHtml(memberId, req) {
  return `<div class="sheet-h"><div><h2>Record ${esc(req.name)}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-rec" class="form" data-member="${esc(memberId)}" data-req="${esc(req.id)}">
      <div class="two"><label class="f"><span>Date done</span><input name="done_on" type="date" max="${today()}" value="${today()}" required></label>
        <label class="f"><span>Result</span><select name="result"><option value="">Not recorded</option><option>Pass</option><option>Fail</option><option>Cleared</option><option>Not cleared</option></select></label></div>
      <label class="f"><span>Next due</span><input name="due_on" type="date" value="${freqDaysOf(req.freq, req.days) ? addDays(today(), freqDaysOf(req.freq, req.days)) : ''}"></label>
      <label class="f"><span>Notes</span><textarea name="notes"></textarea></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button><button class="btn primary" type="submit" form="f-rec">Save</button></div>`;
}
function recordFormMount(root, req) {
  const f = root.querySelector('#f-rec'); if (!f) return;
  let touched = false; f.elements.due_on.addEventListener('input', () => { touched = true; });
  f.elements.done_on.addEventListener('change', () => {
    if (touched) return;
    const d = freqDaysOf(req.freq, req.days);
    f.elements.due_on.value = d ? addDays(f.elements.done_on.value, d) : '';
  });
}
async function saveRecordForm(form) {
  const fd = new FormData(form), memberId = form.dataset.member, reqId = form.dataset.req;
  const done_on = fd.get('done_on'); if (!done_on) { toast('Choose the date it was done.', 'bad'); return; }
  const payload = { member_id: memberId, requirement_id: reqId, done_on, due_on: fd.get('due_on') || null, approx: false, result: fd.get('result') || '', notes: String(fd.get('notes') || '').trim(), recorded_by: S.me.id };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  const r = await sb.from('member_records').insert(payload);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); if (btn) btn.disabled = false; return; }
  MS.pop(); drawModal(); toast('Record saved', 'ok'); loadAll();
}


/* ---------- overdue report ---------- */
const needRank = x => x.state === 'failed' ? 0 : x.state === 'overdue' ? 1 : x.state === 'none' ? 2 : 3;
function needRows(m, inc) {
  return reqRows(m).filter(x => x.state === 'overdue' || x.state === 'failed' || (inc.none && x.state === 'none') || (inc.soon && x.state === 'soon'))
    .sort((a, b) => needRank(a) - needRank(b) || (a.diff || 0) - (b.diff || 0) || a.req.name.localeCompare(b.req.name));
}
function needText(x) {
  switch (x.state) {
    case 'failed': return `${x.req.name}: not current${x.rec && x.rec.result ? ' (last result: ' + x.rec.result + ')' : ''}`;
    case 'overdue': return `${x.req.name}: overdue by ${-x.diff} ${plural(-x.diff, 'day')}${x.rec && x.rec.due_on ? ' (was due ' + fmt(x.rec.due_on) + ')' : ''}`;
    case 'none': return `${x.req.name}: no record on file`;
    default: return `${x.req.name}: due in ${x.diff} ${plural(x.diff, 'day')}${x.rec && x.rec.due_on ? ' (' + fmt(x.rec.due_on) + ')' : ''}`;
  }
}
function odGroups() {
  const inc = S.od;
  return S.members.filter(m => m.status !== 'inactive').map(m => ({ m, rows: needRows(m, inc) })).filter(g => g.rows.length)
    .sort((a, b) => needRank(a.rows[0]) - needRank(b.rows[0]) || (a.rows[0].diff || 0) - (b.rows[0].diff || 0) || a.m.name.localeCompare(b.m.name));
}
const odReminder = g => `Hi ${first(g.m.name)}, this is a reminder from Great Bend Fire Department. Our records show:\n${g.rows.map(x => '- ' + needText(x)).join('\n')}\nPlease let an officer know once these are taken care of.`;
const odAllText = () => { const gs = odGroups(); if (!gs.length) return 'Nobody needs attention.'; return 'Great Bend Fire Department, requirements needing attention (' + fmt(today()) + ')\n\n' + gs.map(g => g.m.name + (g.m.category ? ' (' + g.m.category + ')' : '') + '\n' + g.rows.map(x => '- ' + needText(x)).join('\n')).join('\n\n'); };
function odList() {
  const gs = odGroups();
  if (!gs.length) return '<div class="card empty">Nobody needs attention. Everyone is current.</div>';
  return `<div class="stack">${gs.map(g => `<div class="card"><div class="grp spread"><span>${esc(g.m.name)} <span class="muted sm">${esc(g.m.category || 'No category')}</span></span><span class="row">${g.m.id !== (S.me && S.me.id) ? `<button class="btn sm" data-action="od-push" data-id="${esc(g.m.id)}">Push a reminder</button>` : ''}<button class="btn sm" data-action="copy" data-v="${esc(odReminder(g))}">Copy reminder</button></span></div><div class="list">${g.rows.map(x => `<div class="li"><div class="t"><b>${esc(x.req.name)}</b><span class="muted sm">${x.rec ? (x.rec.done_on ? (x.rec.approx ? 'Done in ' + esc(x.rec.done_on.slice(0, 4)) : 'Last done ' + esc(fmt(x.rec.done_on))) : 'On record, no date') : 'Nothing recorded'}</span></div><div class="acts">${reqChip(x)}</div></div>`).join('')}</div></div>`).join('')}</div>`;
}
function overdueView() {
  const gs = odGroups();
  const nOver = S.members.filter(m => m.status !== 'inactive' && reqRows(m).some(x => x.state === 'overdue' || x.state === 'failed')).length;
  return `<div class="head-row"><div><h3>Needs attention</h3><span class="muted sm">Overdue and failed items, plus the options below. Copy a reminder to paste into IamResponding or an email.</span></div><button class="btn" data-action="od-copyall">Copy the whole list</button></div>
    <div class="rc-chips" style="margin-bottom:8px">${chip(gs.length + ' ' + plural(gs.length, 'member') + ' listed', gs.length ? 'warn' : 'ok')}${nOver ? chip(nOver + ' overdue', 'bad') : chip('None overdue', 'ok')}</div>
    <div class="row" style="margin-bottom:10px"><label class="chk"><input type="checkbox" data-od="none"${S.od.none ? ' checked' : ''}>Include missing records</label><label class="chk"><input type="checkbox" data-od="soon"${S.od.soon ? ' checked' : ''}>Include due within 30 days</label></div>
    <div id="od-list">${odList()}</div>`;
}
/* ---------- messages (the ribbon) management ---------- */
const TONES = [['info', 'Information'], ['notice', 'Important'], ['urgent', 'Urgent']];
const msgAud = m => (m.aud_all || !(m.aud_cats && m.aud_cats.length)) ? 'Everyone' : m.aud_cats.join(', ');
function msgFormHtml(m) {
  const x = m || { tone: 'info', aud_all: true, aud_cats: [], starts_on: today(), ends_on: '' };
  const all = x.aud_all !== false && !(x.aud_cats && x.aud_cats.length) || !!x.aud_all;
  return `<div class="sheet-h"><div><h2>${m ? 'Edit message' : 'Post a message'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-msg" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Message</span><textarea name="body" maxlength="300" required placeholder="Hose testing Saturday at 8 a.m. at the station.">${esc(x.body || '')}</textarea></label>
      <label class="f"><span>Type</span><select name="tone">${TONES.map(([k, l]) => `<option value="${k}"${(x.tone || 'info') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="f"><span>Who sees it</span><div class="aud"><label class="chk"><input type="checkbox" name="aud_all" data-aud="all"${all ? ' checked' : ''}><span>Everyone</span></label>${CATS.map(c => `<label class="chk"><input type="checkbox" name="cat" value="${esc(c)}" data-aud="cat"${!all && (x.aud_cats || []).includes(c) ? ' checked' : ''}${all ? ' disabled' : ''}><span>${esc(c)}</span></label>`).join('')}</div></div>
      <div class="two"><label class="f"><span>Show from</span><input name="starts_on" type="date" value="${esc(x.starts_on || today())}"></label><label class="f"><span>Show until</span><input name="ends_on" type="date" value="${esc(x.ends_on || '')}"></label></div>
      <div class="muted sm" style="margin-top:-6px">Leave "until" empty to keep it up until you end it. Urgent messages can't be dismissed by members.</div>
      ${m ? '' : `<label class="chk"><input type="checkbox" name="push"${(x.tone || 'info') === 'urgent' ? ' checked' : ''}>Also send a push notification to members who have turned them on</label>`}
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-msg', m ? 'Save' : 'Post message')}</div>`;
}
function msgFormMount(root) {
  const all = root.querySelector('[data-aud=all]');
  if (all) { const cats = [...root.querySelectorAll('[data-aud=cat]')]; all.addEventListener('change', () => { cats.forEach(c => { c.disabled = all.checked; if (all.checked) c.checked = false; }); }); }
  const tone = root.querySelector('[name=tone]'), push = root.querySelector('[name=push]');
  if (tone && push) { let touched = false; push.addEventListener('change', () => { touched = true; }); tone.addEventListener('change', () => { if (!touched) push.checked = tone.value === 'urgent'; }); }
}
async function saveMsgForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  const sendPush = !id && !!fd.get('push');
  const body = String(fd.get('body') || '').trim(); if (!body) { toast('Write a message first.', 'bad'); return; }
  const audAll = !!fd.get('aud_all'), cats = fd.getAll('cat');
  if (!audAll && !cats.length) { toast('Choose who should see this message.', 'bad'); return; }
  const starts_on = fd.get('starts_on') || today(), ends_on = fd.get('ends_on') || null;
  if (ends_on && ends_on < starts_on) { toast('The end date is before the start date.', 'bad'); return; }
  const payload = { body, tone: fd.get('tone'), aud_all: audAll, aud_cats: audAll ? [] : cats, starts_on, ends_on };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('messages').update(payload).eq('id', id); if (r.error) throw r.error; }
    else { const r = await sb.from('messages').insert({ ...payload, by_member: S.me.id, removed: false }); if (r.error) throw r.error; }
    MS.pop(); drawModal(); toast(id ? 'Message saved' : 'Message posted', 'ok'); loadAll();
    if (sendPush) {
      try {
        const r = await sb.functions.invoke('send-push', { body: { title: 'Great Bend Fire Department', body, aud_all: payload.aud_all, aud_cats: payload.aud_cats } });
        if (r.error) { r.error.message = await functionErrorMessage(r.error); throw r.error; }
        toast(`Notification sent to ${r.data && r.data.sent || 0} device(s)`, 'ok');
      } catch (e) { toast('Message posted, but the push notification could not be sent: ' + ((e && e.message) || String(e)), 'bad'); }
    }
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
async function endMsgNow(id) {
  const r = await sb.from('messages').update({ ends_on: addDays(today(), -1) }).eq('id', id);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  toast('Message ended', 'ok'); loadAll();
}
async function removeMsg(id) {
  if (!window.confirm('Remove this message? It disappears for everyone.')) return;
  const r = await sb.from('messages').update({ removed: true }).eq('id', id);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  toast('Message removed', 'ok'); loadAll();
}
function msgsView() {
  const list = S.messages.filter(m => !m.removed).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')), t = today();
  return `<div class="head-row"><h1>Messages</h1><button class="btn primary" data-action="msg-new">Post a message</button></div>
    <p class="muted sm" style="margin-top:-8px">Shown as a ribbon at the top of the home page.</p>
    <div class="stack">${list.length ? list.map(m => {
      const st = m.starts_on && m.starts_on > t ? 'Scheduled' : (m.ends_on && m.ends_on < t) ? 'Ended' : 'Showing';
      return `<div class="card pad stack" style="gap:8px"><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-weight:600">${esc(m.body)}</div>
        <div class="rc-chips">${chip(st, st === 'Showing' ? 'ok' : '')}${chip((TONES.find(x => x[0] === m.tone) || TONES[0])[1])}${chip(msgAud(m))}</div>
        <div class="muted sm">Shows ${esc(fmt(m.starts_on))}${m.ends_on ? ' until ' + esc(fmt(m.ends_on)) : ', until you end it'}.</div>
        <div class="row"><button class="btn sm" data-action="msg-edit" data-id="${esc(m.id)}">Edit</button>${st !== 'Ended' ? `<button class="btn sm" data-action="msg-end" data-id="${esc(m.id)}">End now</button>` : ''}<button class="btn sm danger" data-action="msg-remove" data-id="${esc(m.id)}">Remove</button></div></div>`;
    }).join('') : '<div class="card empty">No messages yet. Post one and it appears at the top of everyone\u2019s home page.</div>'}</div>`;
}

/* ---------- apparatus, equipment, checks and deficiencies ---------- */
const FREQS = [
  { k: 'daily', label: 'Daily', days: 1 }, { k: 'weekly', label: 'Weekly', days: 7 }, { k: 'monthly', label: 'Monthly', days: 30 },
  { k: 'quarterly', label: 'Quarterly', days: 91 }, { k: 'semiannual', label: 'Every 6 months', days: 182 }, { k: 'annual', label: 'Annually', days: 365 },
  { k: 'use', label: 'After each use', days: 0 }, { k: 'custom', label: 'Custom (days)', days: null }
];
const freqDays = it => it.freq === 'custom' ? (Number(it.days) || 7) : (FREQS.find(f => f.k === it.freq) || FREQS[1]).days;
const freqLabel = it => it.freq === 'custom' ? ('Every ' + (Number(it.days) || 7) + ' days') : (FREQS.find(f => f.k === it.freq) || FREQS[1]).label;
const STATUS = [['ok', 'OK'], ['low', 'Low'], ['needs_repair', 'Needs repair'], ['dirty', 'Dirty'], ['needs_replacing', 'Needs replacing'], ['missing', 'Missing']];
const SL = Object.fromEntries(STATUS);
const stTone = s => s === 'ok' ? 'ok' : (s === 'low' || s === 'dirty') ? 'warn' : 'bad';
const EQ_CATS = ['SCBA pack', 'SCBA cylinder', 'SCBA facepiece', 'Hose', 'Ladder', 'Hand tool', 'Power tool', 'Extrication', 'Medical / EMS', 'Radio / electronics', 'Lighting', 'Water rescue', 'Pump / hydraulics', 'PPE', 'Other'];
const rigName = id => { const r = D.rigById[id]; return r ? r.unit : 'Station'; };
const whereLabel2 = e => e.assigned_type === 'station' ? 'Station' : rigName(e.assigned_rig_id);
const itemDueKey = (it, rigKey) => it.scope_type === 'base' ? (it.id + '|' + rigKey) : it.id;
function dueInfo(it, rigKey) {
  const days = freqDays(it); if (days === 0) return { state: 'use' };
  const ld = D.lastDone[itemDueKey(it, rigKey)];
  if (!ld) return { state: 'never' };
  const due = addDays(ld.date, days), diff = diffDays(today(), due);
  return { state: diff <= 0 ? 'due' : 'ok', due, diff, last: ld.date, s: ld.status };
}
const isDue = (it, rigKey) => { const s = dueInfo(it, rigKey).state; return s === 'due' || s === 'never'; };
function dueChip(it, rigKey) {
  const d = dueInfo(it, rigKey);
  if (d.state === 'use') return chip('After each use');
  if (d.state === 'never') return chip('Not checked yet', 'warn');
  if (d.state === 'due') return d.diff < 0 ? chip(`Overdue ${-d.diff} ${plural(-d.diff, 'day')}`, 'bad') : chip('Due today', 'warn');
  return chip('Next ' + fmt(d.due), 'ok');
}
function rigItems(rigId) {
  const rig = D.rigById[rigId];
  const ex = (rig && rig.excluded) || [];
  const base = rigId === 'station' ? [] : S.items.filter(i => i.scope_type === 'base' && i.active !== false && !ex.includes(i.id)).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const own = rigId === 'station' ? [] : S.items.filter(i => i.scope_type === 'rig' && i.rig_id === rigId && i.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const eqs = S.equipment.filter(e => (rigId === 'station' ? e.assigned_type === 'station' : e.assigned_type === 'rig' && e.assigned_rig_id === rigId) && e.status !== 'retired');
  const eq = [];
  for (const e of eqs) for (const it of S.items.filter(i => i.scope_type === 'equipment' && i.equipment_id === e.id && i.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0))) eq.push(it);
  return { base, own, eq };
}
const rigFlat = id => { const o = rigItems(id); return [...o.base, ...o.own, ...o.eq]; };
function apparatusAttention() {
  const out = [];
  for (const r of S.rigs.filter(r => !r.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0))) {
    if (r.status === 'out_of_service') out.push({ tone: 'bad', text: `${r.unit} is out of service${r.oos_reason ? ': ' + r.oos_reason : ''}`, tab: 'rigs', rig: r.id });
  }
  const openDefs = S.defs.filter(d => !d.closed).length;
  if (openDefs) out.push({ tone: 'warn', text: `${openDefs} open ${plural(openDefs, 'deficiency', 'deficiencies')}`, tab: 'rigs' });
  return out;
}
function homeAppStatus() {
  if (!S.perms.view_apparatus) return '';
  const at = apparatusAttention();
  return `<div class="sec"><h3>Department status</h3></div><div class="attn">${at.length ? at.slice(0, 10).map(a => `<button class="${a.tone}" data-action="goto-rigs" data-rig="${esc(a.rig || '')}">${esc(a.text)}</button>`).join('') : '<button class="ok" tabindex="-1">Everything is current.</button>'}</div>`;
}

/* ---------- apparatus list + detail ---------- */
function rigCard(r) {
  const due = rigFlat(r.id).filter(it => isDue(it, r.id)).length;
  const defs = S.defs.filter(d => !d.closed && d.rig_id === r.id).length;
  const oos = r.status === 'out_of_service';
  return `<div class="card rigcard ${oos || defs ? 'tone-bad' : due ? 'tone-warn' : ''}">
    <button class="rc-open" data-action="rig-open" data-id="${esc(r.id)}">${plate(r.unit)}<span class="rc-info"><span class="cap">${esc(r.type || 'Apparatus')}</span><span class="muted sm">${r.captain ? 'Captain ' + esc(r.captain) : 'No captain assigned'}</span><span class="rc-chips">${oos ? chip('Out of service', 'bad') : due ? chip(`${due} ${plural(due, 'check')} due`, 'warn') : chip('Checks current', 'ok')}${defs ? chip(`${defs} open ${plural(defs, 'deficiency', 'deficiencies')}`, 'bad') : ''}</span></span></button>
    <div class="rc-foot">${S.perms.run_checks ? `<button class="btn primary sm" data-action="check-start" data-id="${esc(r.id)}">Start check</button>` : ''}</div></div>`;
}
function stationCard() {
  const n = S.equipment.filter(e => e.assigned_type === 'station' && e.status !== 'retired').length;
  const due = rigFlat('station').filter(it => isDue(it, 'station')).length;
  return `<div class="card rigcard ${due ? 'tone-warn' : ''}"><button class="rc-open" data-action="rig-open" data-id="station">${plate('Station')}<span class="rc-info"><span class="cap">Station equipment</span><span class="muted sm">${n} ${plural(n, 'item')} assigned</span><span class="rc-chips">${due ? chip(`${due} ${plural(due, 'check')} due`, 'warn') : chip('Checks current', 'ok')}</span></span></button>
    <div class="rc-foot">${S.perms.run_checks && due ? `<button class="btn primary sm" data-action="check-start" data-id="station">Start check</button>` : ''}</div></div>`;
}
const plate = (u, cls) => `<span class="plate${cls ? ' ' + cls : ''}">${esc(u)}</span>`;
function rigsView() {
  const rigs = S.rigs.filter(r => !r.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  return `<div class="head-row"><h1>Apparatus</h1>${S.perms.edit_equipment ? '<button class="btn primary" data-action="rig-new">Add rig</button>' : ''}</div>
    ${rigs.length ? '' : '<div class="card empty">No rigs yet.</div>'}
    <div class="grid">${rigs.map(rigCard).join('')}${stationCard()}</div>`;
}
function itemRow(it, o) {
  o = o || {};
  const d = dueInfo(it, o.rigKey);
  const last = d.last;
  const meta = `${esc(freqLabel(it))}${last ? `, last done ${esc(fmt(last))}${d.s && d.s !== 'ok' ? ' (' + esc(SL[d.s]) + ')' : ''}` : ''}`;
  return `<div class="li${o.off ? ' off' : ''}"><div class="t"><b>${esc(it.name)}</b><span class="muted sm">${meta}</span></div><div class="acts">${o.off ? chip('Not on this rig') : dueChip(it, o.rigKey)}${o.extra || ''}${o.edit ? `<button class="btn ghost sm" data-action="it-edit" data-id="${esc(it.id)}">Edit</button><button class="btn ghost sm" data-action="it-arch" data-id="${esc(it.id)}">Archive</button>` : ''}</div></div>`;
}
function rigDetail(id) {
  const r = id === 'station' ? { id: 'station', unit: 'Station', isStation: true } : D.rigById[id];
  if (!r) return `<div class="wrap"><div class="card empty">This rig no longer exists.</div></div>`;
  const subs = [['checks', 'Checks'], ['equipment', 'Equipment'], ['deficiencies', 'Deficiencies']]; if (!r.isStation) subs.push(['details', 'Details']);
  if (r.isStation && S.rsub === 'details') S.rsub = 'checks';
  let body; if (S.rsub === 'equipment') body = rigEquipTab(r); else if (S.rsub === 'deficiencies') body = rigDefTab(r); else if (S.rsub === 'details') body = rigDetailsTab(r); else body = rigChecksTab(r);
  const due = rigFlat(id).filter(it => isDue(it, id)).length;
  return `<button class="back" data-action="rig-back">← All apparatus</button>
    <div class="rig-head">${plate(r.unit, 'big')}<div class="txt"><h2>${esc(r.isStation ? 'Station equipment' : (r.type || 'Apparatus'))}</h2>${r.isStation ? '' : `<span class="muted">${r.captain ? 'Captain ' + esc(r.captain) : 'No captain assigned'}</span>`}<span class="rc-chips">${!r.isStation ? (r.status === 'out_of_service' ? chip('Out of service', 'bad') : chip('In service', 'ok')) : ''}${due ? chip(`${due} ${plural(due, 'check')} due`, 'warn') : ''}</span></div>
      <div style="margin-left:auto">${S.perms.run_checks ? `<button class="btn primary" data-action="check-start" data-id="${esc(id)}">Start check</button>` : ''}</div></div>
    <div class="subtabs">${subs.map(([k, l]) => `<button data-action="rsub" data-sub="${k}"${S.rsub === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</div>
    ${body}`;
}
function checklistBlock(title, items, opts) {
  opts = opts || {};
  const key = (opts.scope || '') + ':' + (opts.rigId || opts.eqId || '');
  const archived = S.showArch[key] ? S.items.filter(i => i.scope_type === opts.scope && (opts.scope === 'base' || (opts.scope === 'rig' ? i.rig_id === opts.rigId : i.equipment_id === opts.eqId)) && i.active === false) : [];
  const nArch = S.items.filter(i => i.scope_type === opts.scope && (opts.scope === 'base' || (opts.scope === 'rig' ? i.rig_id === opts.rigId : i.equipment_id === opts.eqId)) && i.active === false).length;
  return `<div class="card" style="margin-bottom:14px"><div class="grp spread"><span>${esc(title)}</span>${opts.canAdd ? `<button class="btn sm" data-action="it-new" data-scope="${opts.scope}" data-rig="${esc(opts.rigId || '')}" data-eq="${esc(opts.eqId || '')}">Add check</button>` : ''}</div>
    <div class="list">${items.length ? items.map(it => itemRow(it, { edit: opts.canEdit, rigKey: opts.rigKey })).join('') : '<div class="empty">No checks yet.</div>'}</div>
    ${nArch ? `<div class="pad"><button class="btn ghost sm" data-action="it-showarch" data-key="${esc(key)}">${S.showArch[key] ? 'Hide' : 'Show'} ${nArch} archived</button></div>` : ''}
    ${archived.map(it => `<div class="li off"><div class="t"><b>${esc(it.name)}</b><span class="muted sm">Archived</span></div>${opts.canEdit ? `<button class="btn sm" data-action="it-restore" data-id="${esc(it.id)}">Restore</button>` : ''}</div>`).join('')}</div>`;
}
function rigChecksTab(r) {
  const o = rigItems(r.id); const all = [...o.base, ...o.own, ...o.eq]; const due = all.filter(it => isDue(it, r.id));
  let h = `<div class="card pad spread" style="margin-bottom:14px"><div><b>${due.length ? `${due.length} of ${all.length} ${plural(all.length, 'check')} due` : 'All checks are current'}</b><div class="muted sm">Only checks that are due appear on the check sheet.</div></div>${S.perms.run_checks ? `<button class="btn primary" data-action="check-start" data-id="${esc(r.id)}">Start check</button>` : ''}</div>`;
  if (!r.isStation) {
    h += checklistBlock('Checks for this rig only', o.own, { canAdd: S.perms.edit_equipment, canEdit: S.perms.edit_equipment, scope: 'rig', rigId: r.id, rigKey: r.id });
    if (o.eq.length) {
      const byE = {}; for (const it of o.eq) (byE[it.equipment_id] = byE[it.equipment_id] || []).push(it);
      h += `<div class="card" style="margin-bottom:14px"><div class="grp">Equipment checks on ${esc(r.unit)}</div><div class="list">${Object.keys(byE).map(eid => { const e = D.eqById[eid]; return `<div class="li" style="background:var(--surface-2)"><b>${esc(e ? e.name : 'Equipment')}</b></div>` + byE[eid].map(it => itemRow(it, { rigKey: eid })).join(''); }).join('')}</div><div class="pad muted sm">Edit these from the equipment record.</div></div>`;
    }
    const ex = r.excluded || []; const allBase = S.items.filter(i => i.scope_type === 'base' && i.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const nOn = allBase.filter(i => !ex.includes(i.id)).length;
    h += `<div class="card" style="margin-bottom:14px"><div class="grp spread"><span>Base checklist, ${nOn} of ${allBase.length} apply here</span><span class="row">${S.perms.admin_setup ? `<button class="btn sm" data-action="it-new" data-scope="base">Add base check</button>` : ''}<button class="btn sm" data-action="base-toggle">${S.showBase[r.id] ? 'Hide' : 'Show'}</button></span></div>
      ${S.showBase[r.id] ? `<div class="list">${allBase.map(it => { const off = ex.includes(it.id); return itemRow(it, { off, edit: S.perms.admin_setup, rigKey: r.id, extra: S.perms.edit_equipment ? `<label class="chk" style="min-height:36px"><input type="checkbox" data-change="it-excl" data-id="${esc(it.id)}" data-rig="${esc(r.id)}"${off ? '' : ' checked'}><span class="sm">Applies</span></label>` : '' }); }).join('')}</div>` : ''}</div>`;
  } else {
    h += `<div class="card pad muted">Checks for station equipment come from the equipment records.</div>`;
  }
  return h;
}
function eqCard(e) {
  const items = S.items.filter(i => i.scope_type === 'equipment' && i.equipment_id === e.id && i.active !== false);
  const due = items.filter(it => isDue(it, e.id)).length;
  return `<button class="card eqcard${e.status === 'retired' ? ' retired' : ''}" data-action="eq-open" data-id="${esc(e.id)}">
    <span class="top2"><b>${esc(e.name)}</b>${chip(whereLabel2(e))}</span>
    <span class="muted sm">${esc([e.category, e.location].filter(Boolean).join(', ')) || '&nbsp;'}</span>
    <span class="rc-chips">${e.status === 'retired' ? chip('Retired') : e.status === 'out_of_service' ? chip('Out of service', 'bad') : ''}${purchaseChip(e)}${due ? chip(`${due} ${plural(due, 'check')} due`, 'warn') : ''}</span></button>`;
}
function rigEquipTab(r) {
  const list = S.equipment.filter(e => e.assigned_type === 'rig' && e.assigned_rig_id === r.id && e.status !== 'retired').sort((a, b) => a.name.localeCompare(b.name));
  const tt = eqTotals(list);
  return `<div class="head-row"><div><b>${list.length} ${plural(list.length, 'item')}</b> <span class="muted">worth ${money(tt.sum)} at purchase${totalsNote(tt)}</span></div>${S.perms.edit_equipment ? `<button class="btn primary" data-action="eq-new" data-assigned="${esc(r.id)}">Add equipment</button>` : ''}</div>
    ${list.length ? `<div class="eqlist">${list.map(eqCard).join('')}</div>` : '<div class="card empty">No equipment is assigned here yet.</div>'}`;
}
function defCard(d) {
  const r = d.rig_id ? D.rigById[d.rig_id] : null;
  return `<div class="card pad stack" style="gap:8px"><div class="spread"><span class="row">${r ? plate(r.unit, 'sm') : ''}<b>${esc(d.item_name)}</b>${d.equipment_name ? `<span class="muted sm">${esc(d.equipment_name)}</span>` : ''}</span>${chip(SL[d.status] || d.status, stTone(d.status))}</div>
    ${d.comment ? `<div>${esc(d.comment)}</div>` : ''}
    <div class="muted sm">Found ${esc(fmt(d.found_date))}${d.found_by ? ' by ' + esc(d.found_by) : ''}. Reported to: ${esc(d.reported_to || 'not yet')}${d.date_reported ? ' on ' + esc(fmt(d.date_reported)) : ''}. ${d.closed ? 'Back in service ' + esc(fmt(d.back_date)) + '.' : 'Still open.'}${d.note ? ' ' + esc(d.note) : ''}</div>
    ${S.perms.run_checks ? `<div class="row"><button class="btn sm" data-action="def-edit" data-id="${esc(d.id)}">Edit</button>${d.closed ? `<button class="btn sm" data-action="def-reopen" data-id="${esc(d.id)}">Reopen</button>` : `<button class="btn sm primary" data-action="def-close" data-id="${esc(d.id)}">Back in service</button>`}</div>` : ''}</div>`;
}
function rigDefTab(r) {
  const list = S.defs.filter(d => d.rig_id === r.id).sort((a, b) => (b.found_date || '').localeCompare(a.found_date || ''));
  return `<div class="stack">${list.length ? list.map(defCard).join('') : '<div class="card empty">No deficiencies logged.</div>'}</div>`;
}
function rigDetailsTab(r) {
  const kv = (k, v) => `<dt>${k}</dt><dd>${v === '' || v == null ? '—' : esc(v)}</dd>`;
  return `<div class="card pad"><dl class="kv">
    ${kv('Unit', r.unit)}${kv('Type', r.type)}${kv('Captain', r.captain)}${kv('Year', r.year)}${kv('Make', r.make)}${kv('Model', r.model)}${kv('VIN', r.vin)}${kv('Plate', r.plate)}
    ${kv('Purchase date', r.purchase_date ? fmt(r.purchase_date) : r.purchase_date_unknown ? 'Unknown' : '')}${kv('Purchase amount', r.purchase_amount != null ? money(r.purchase_amount) : r.purchase_amount_unknown ? 'Unknown' : '')}${kv('Estimated value', r.est_value != null ? money(r.est_value) : '')}
    ${kv('Latest mileage or hours', r.meter ? r.meter + (r.meter_date ? ' (' + fmt(r.meter_date) + ')' : '') : '')}
    ${kv('Status', r.status === 'out_of_service' ? 'Out of service' + (r.oos_reason ? ': ' + r.oos_reason : '') : 'In service')}${kv('Notes', r.notes)}</dl></div>
  ${S.perms.edit_equipment ? `<div class="row" style="margin-top:14px"><button class="btn primary" data-action="rig-edit" data-id="${esc(r.id)}">Edit details</button><button class="btn ${r.status === 'out_of_service' ? '' : 'danger'}" data-action="rig-oos" data-id="${esc(r.id)}">${r.status === 'out_of_service' ? 'Return to service' : 'Mark out of service'}</button>${S.perms.admin_setup ? `<button class="btn" data-action="rig-arch" data-id="${esc(r.id)}">Archive rig</button>` : ''}</div>` : ''}`;
}

/* ---------- equipment list ---------- */
const hasAmt = x => x.purchase_amount != null && x.purchase_amount !== '';
const hasEst = x => x.est_value != null && x.est_value !== '';
function purchaseChip(x) {
  const d = x.purchase_date ? fmt(x.purchase_date) : x.purchase_date_unknown ? 'Date unknown' : null;
  const a = hasAmt(x) ? money(x.purchase_amount) : hasEst(x) ? (x.purchase_amount_unknown ? 'Cost unknown, ' : '') + 'est. ' + money(x.est_value) : x.purchase_amount_unknown ? 'Cost unknown' : null;
  if (d && a) return chip(d + ', ' + a);
  if (!d && !a) return chip('No purchase info', 'warn');
  return chip(d || a) + chip(d ? 'Cost needed' : 'Date needed', 'warn');
}
function eqTotals(list) { let sum = 0, estSum = 0, estN = 0, none = 0; for (const e of list) { if (hasAmt(e)) sum += Number(e.purchase_amount) || 0; else if (hasEst(e)) { estSum += Number(e.est_value) || 0; estN++; } else none++; } return { sum, estSum, estN, none }; }
const totalsNote = t => (t.estN ? `, plus ${money(t.estSum)} estimated for ${t.estN} ${plural(t.estN, 'item')}` : '') + (t.none ? `, ${t.none} ${plural(t.none, 'item')} with no cost or estimate` : '');
const money = n => (n === null || n === undefined || n === '') ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
function equipmentView() {
  const f = S.eq, q = f.q.trim().toLowerCase();
  const cats = [...new Set([...EQ_CATS, ...S.equipment.map(e => e.category).filter(Boolean)])].sort();
  let list = S.equipment.filter(e => f.ret ? true : e.status !== 'retired');
  if (f.where !== 'all') list = list.filter(e => (f.where === 'station' ? e.assigned_type === 'station' : e.assigned_rig_id === f.where));
  if (f.cat !== 'all') list = list.filter(e => e.category === f.cat);
  if (q) list = list.filter(e => [e.name, e.serial, e.category, e.location, e.make_model, e.notes].join(' ').toLowerCase().includes(q));
  list.sort((a, b) => a.name.localeCompare(b.name));
  const tt = eqTotals(list);
  const whereOpts = [['all', 'All locations'], ['station', 'Station'], ...S.rigs.filter(r => !r.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(r => [r.id, r.unit])];
  return `<div class="head-row"><h1>Equipment</h1>${S.perms.edit_equipment ? '<button class="btn primary" data-action="eq-new">Add equipment</button>' : ''}</div>
    <div class="filters">
      <label class="f"><span>Search</span><input id="eq-q" type="search" value="${esc(f.q)}" placeholder="Name, serial number, category…"></label>
      <label class="f"><span>Assigned to</span><select id="eq-where">${whereOpts.map(([v, l]) => `<option value="${v}"${f.where === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="f"><span>Category</span><select id="eq-cat"><option value="all">All categories</option>${cats.map(c => `<option value="${esc(c)}"${f.cat === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    </div>
    <div class="spread" style="margin-bottom:12px"><span><span class="total">${list.length}</span> ${plural(list.length, 'item')}, <span class="total">${money(tt.sum)}</span> <span class="muted">at purchase${totalsNote(tt)}</span></span>
      <label class="chk"><input type="checkbox" id="eq-ret"${f.ret ? ' checked' : ''}>Show retired</label></div>
    <div id="eq-list">${eqList()}</div>`;
}
function eqList() {
  const f = S.eq, q = f.q.trim().toLowerCase();
  let list = S.equipment.filter(e => f.ret ? true : e.status !== 'retired');
  if (f.where !== 'all') list = list.filter(e => (f.where === 'station' ? e.assigned_type === 'station' : e.assigned_rig_id === f.where));
  if (f.cat !== 'all') list = list.filter(e => e.category === f.cat);
  if (q) list = list.filter(e => [e.name, e.serial, e.category, e.location, e.make_model, e.notes].join(' ').toLowerCase().includes(q));
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list.length ? `<div class="eqlist">${list.map(eqCard).join('')}</div>` : `<div class="card empty">${S.equipment.length ? 'Nothing matches those filters.' : 'No equipment yet.'}</div>`;
}
function eqDetailSheet(id) {
  const e = D.eqById[id]; if (!e) return sheet('Equipment', '<div class="empty">This item no longer exists.</div>', '<button class="btn" data-action="m-close">Close</button>');
  const its = S.items.filter(i => i.scope_type === 'equipment' && i.equipment_id === id && i.active !== false);
  const kv = (k, v) => `<dt>${k}</dt><dd>${v === '' || v == null ? '—' : esc(v)}</dd>`;
  const body = `<div class="rc-chips" style="margin-bottom:12px">${chip(whereLabel2(e))}${e.status === 'retired' ? chip('Retired', 'bad') : e.status === 'out_of_service' ? chip('Out of service', 'bad') : chip('In service', 'ok')}</div>
   <div class="card pad"><dl class="kv">${kv('Category', e.category)}${kv('Location', e.location)}${kv('Serial number', e.serial)}${kv('Make and model', e.make_model)}${e.size ? kv('Size', e.size) : ''}${e.mfg_date ? kv('Manufactured', fmt(e.mfg_date)) : ''}${e.service_life_end ? kv('Service life ends', fmt(e.service_life_end)) : ''}
     ${kv('Purchase date', e.purchase_date ? fmt(e.purchase_date) : e.purchase_date_unknown ? 'Unknown' : '')}${kv('Purchase amount', hasAmt(e) ? money(e.purchase_amount) : e.purchase_amount_unknown ? 'Unknown' : '')}${kv('Estimated value', hasEst(e) ? money(e.est_value) : '')}${kv('Purchased from', e.vendor)}${e.status === 'retired' ? kv('Retired', (e.retired_date ? fmt(e.retired_date) : '') + (e.retire_note ? ': ' + e.retire_note : '')) : ''}${kv('Notes', e.notes)}</dl></div>
   <div class="sec spread"><h3>Checks</h3>${S.perms.edit_equipment && e.status !== 'retired' ? `<button class="btn sm" data-action="it-new" data-scope="equipment" data-eq="${esc(id)}">Add check</button>` : ''}</div>
   <div class="card list">${its.length ? its.map(it => itemRow(it, { edit: e.status !== 'retired' && S.perms.edit_equipment, rigKey: id })).join('') : '<div class="empty">No recurring checks.</div>'}</div>`;
  const foot = `<button class="btn" data-action="m-close">Close</button>${S.perms.edit_equipment ? (e.status === 'retired' ? `<button class="btn" data-action="eq-react" data-id="${esc(id)}">Return to service</button>` : `<button class="btn danger" data-action="eq-retire" data-id="${esc(id)}">Retire</button>`) + `<button class="btn primary" data-action="eq-edit" data-id="${esc(id)}">Edit</button>` : ''}`;
  return sheet(esc(e.name), body, foot);
}

/* ---------- forms: rig, equipment, checklist item ---------- */
const unkField = (label, name, val, unk, o) => { o = o || {}; return `<div class="f"><span>${label}</span><input name="${name}" value="${esc(val)}" type="${o.type || 'text'}"${o.step ? ` step="${o.step}"` : ''}${o.min != null ? ` min="${o.min}"` : ''}${unk ? ' disabled' : ''}><label class="chk" style="min-height:36px"><input type="checkbox" name="${name}_unknown" data-unk="${name}"${unk ? ' checked' : ''}><span class="sm">Unknown</span></label></div>`; };
function unkMount(root) { root.querySelectorAll('input[data-unk]').forEach(cb => { const inp = root.querySelector('input[name="' + cb.dataset.unk + '"]'); if (!inp) return; cb.addEventListener('change', () => { inp.disabled = cb.checked; if (cb.checked) inp.value = ''; }); }); }
function rigFormHtml(r) {
  const x = r || {};
  return `<div class="sheet-h"><div><h2>${r ? 'Edit rig' : 'Add rig'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-rig" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Unit number</span><input name="unit" value="${esc(x.unit || '')}" required placeholder="24-1-1"></label>
      <label class="f"><span>Type</span><input name="type" value="${esc(x.type || '')}" placeholder="Engine, tanker, rescue…"></label>
      <label class="f"><span>Captain</span><input name="captain" value="${esc(x.captain || '')}"></label>
      <div class="two"><label class="f"><span>Year</span><input name="year" type="number" value="${esc(x.year || '')}"></label><label class="f"><span>Make</span><input name="make" value="${esc(x.make || '')}"></label></div>
      <label class="f"><span>Model</span><input name="model" value="${esc(x.model || '')}"></label>
      <div class="two"><label class="f"><span>VIN</span><input name="vin" value="${esc(x.vin || '')}"></label><label class="f"><span>Plate</span><input name="plate" value="${esc(x.plate || '')}"></label></div>
      <div class="two">${unkField('Purchase date', 'purchase_date', x.purchase_date, x.purchase_date_unknown, { type: 'date' })}${unkField('Purchase amount ($)', 'purchase_amount', x.purchase_amount, x.purchase_amount_unknown, { type: 'number', step: '0.01', min: 0 })}</div>
      <label class="f"><span>Estimated value ($)</span><input name="est_value" type="number" step="0.01" min="0" value="${esc(x.est_value || '')}"></label>
      <label class="f"><span>Notes</span><textarea name="notes">${esc(x.notes || '')}</textarea></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-rig')}</div>`;
}
async function saveRigForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  const unit = String(fd.get('unit') || '').trim(); if (!unit) { toast('Enter a unit number.', 'bad'); return; }
  const num = v => v === '' || v == null ? null : Number(v);
  const data = { unit, type: (fd.get('type') || '').trim(), captain: (fd.get('captain') || '').trim(), year: num(fd.get('year')), make: (fd.get('make') || '').trim(), model: (fd.get('model') || '').trim(), vin: (fd.get('vin') || '').trim(), plate: (fd.get('plate') || '').trim(),
    purchase_date: fd.get('purchase_date') || null, purchase_date_unknown: !!fd.get('purchase_date_unknown') && !fd.get('purchase_date'),
    purchase_amount: num(fd.get('purchase_amount')), purchase_amount_unknown: !!fd.get('purchase_amount_unknown') && num(fd.get('purchase_amount')) === null,
    est_value: num(fd.get('est_value')), notes: (fd.get('notes') || '').trim() };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('rigs').update(data).eq('id', id); if (r.error) throw r.error; }
    else { const mx = Math.max(0, ...S.rigs.map(r => r.sort || 0)); const r = await sb.from('rigs').insert({ ...data, sort: mx + 10, status: 'in_service', excluded: [], archived: false }); if (r.error) throw r.error; }
    MS.pop(); drawModal(); toast('Rig saved', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
function eqFormHtml(e, assigned) {
  const x = e || {};
  const rigs = S.rigs.filter(r => !r.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const curAssign = x.id ? (x.assigned_type === 'station' ? 'station' : x.assigned_rig_id) : (assigned || 'station');
  const cats = [...EQ_CATS, ...S.equipment.map(q => q.category).filter(Boolean)];
  return `<div class="sheet-h"><div><h2>${e ? 'Edit equipment' : 'Add equipment'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-eq" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Name</span><input name="name" value="${esc(x.name || '')}" placeholder="Positive pressure fan… (blank uses category and serial)"></label>
      <div class="two"><label class="f"><span>Category</span><input name="category" list="dl-cat" value="${esc(x.category || '')}"></label><label class="f"><span>Assigned to</span><select name="assigned">${[['station', 'Station'], ...rigs.map(r => [r.id, r.unit])].map(([v, l]) => `<option value="${esc(v)}"${curAssign === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
      <label class="f"><span>Location</span><input name="location" value="${esc(x.location || '')}" placeholder="Driver side compartment 2…"></label>
      <div class="two"><label class="f"><span>Serial number</span><input name="serial" value="${esc(x.serial || '')}"></label><label class="f"><span>Make and model</span><input name="make_model" value="${esc(x.make_model || '')}"></label></div>
      <div class="two" data-for="cylinder" hidden><label class="f"><span>Manufacture date</span><input name="mfg_date" type="date" value="${esc(x.mfg_date || '')}"></label><label class="f"><span>Service life ends</span><input name="service_life_end" type="date" value="${esc(x.service_life_end || '')}"></label></div>
      <div data-for="facepiece" hidden><label class="f"><span>Size</span><input name="size" value="${esc(x.size || '')}"></label></div>
      <div class="two">${unkField('Purchase date', 'purchase_date', x.purchase_date, x.purchase_date_unknown, { type: 'date' })}${unkField('Purchase amount ($)', 'purchase_amount', x.purchase_amount, x.purchase_amount_unknown, { type: 'number', step: '0.01', min: 0 })}</div>
      <label class="f"><span>Estimated value ($)</span><input name="est_value" type="number" step="0.01" min="0" value="${esc(x.est_value || '')}"></label>
      <label class="f"><span>Purchased from</span><input name="vendor" value="${esc(x.vendor || '')}"></label>
      <label class="f"><span>Notes</span><textarea name="notes">${esc(x.notes || '')}</textarea></label>
      <datalist id="dl-cat">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-eq')}</div>`;
}
function eqFormMount(root) {
  unkMount(root);
  const cat = root.querySelector('[name=category]'); if (!cat) return;
  const apply = () => { const v = cat.value.toLowerCase(); root.querySelectorAll('[data-for]').forEach(n => { n.hidden = !v.includes(n.dataset.for); }); };
  cat.addEventListener('input', apply); apply();
}
async function saveEqForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  let name = String(fd.get('name') || '').trim(); const serial = (fd.get('serial') || '').trim(), category = (fd.get('category') || '').trim();
  if (!name && serial && category) name = category + ' ' + serial;
  if (!name) { toast('Give it a name, or enter a category and serial number.', 'bad'); return; }
  const num = v => v === '' || v == null ? null : Number(v);
  const assignedVal = fd.get('assigned');
  const data = { name, category, assigned_type: assignedVal === 'station' ? 'station' : 'rig', assigned_rig_id: assignedVal === 'station' ? null : assignedVal,
    location: (fd.get('location') || '').trim(), serial, make_model: (fd.get('make_model') || '').trim(), mfg_date: fd.get('mfg_date') || null, service_life_end: fd.get('service_life_end') || null, size: (fd.get('size') || '').trim(),
    purchase_date: fd.get('purchase_date') || null, purchase_date_unknown: !!fd.get('purchase_date_unknown') && !fd.get('purchase_date'),
    purchase_amount: num(fd.get('purchase_amount')), purchase_amount_unknown: !!fd.get('purchase_amount_unknown') && num(fd.get('purchase_amount')) === null,
    est_value: num(fd.get('est_value')), vendor: (fd.get('vendor') || '').trim(), notes: (fd.get('notes') || '').trim() };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('equipment').update(data).eq('id', id); if (r.error) throw r.error; }
    else {
      const r = await sb.from('equipment').insert({ ...data, status: 'in_service' }).select('id').single(); if (r.error) throw r.error;
      // Every new item gets a basic presence check automatically, so it shows up on the rig's check sheet without extra setup.
      // It's an ordinary checklist item from here on -- edit its wording or frequency, or archive it, the same as any other check.
      const ir = await sb.from('checklist_items').insert({ scope_type: 'equipment', equipment_id: r.data.id, name: 'Present and accounted for', freq: 'monthly', days: 30, sort: 5, active: true });
      if (ir.error) toast('Equipment saved, but its check could not be added: ' + ir.error.message, 'bad');
    }
    MS.pop(); drawModal(); toast('Equipment saved', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
function itemFormHtml(scope, rigId, eqId, it) {
  const x = it || { freq: 'weekly', days: 7 };
  const label = scope === 'base' ? 'the base checklist' : scope === 'rig' ? 'this rig' : 'this equipment';
  return `<div class="sheet-h"><div><h2>${it ? 'Edit check' : 'Add check'}</h2><span class="muted sm">For ${label}</span></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-item" class="form" data-id="${esc(x.id || '')}" data-scope="${esc(scope)}" data-rig="${esc(rigId || '')}" data-eq="${esc(eqId || '')}">
      <label class="f"><span>What to check</span><input name="name" value="${esc(x.name || '')}" required placeholder="Fuel (fill at 3/4)"></label>
      <label class="f"><span>How often</span><select name="freq">${FREQS.map(f => `<option value="${f.k}"${(x.freq || 'weekly') === f.k ? ' selected' : ''}>${f.label}</option>`).join('')}</select></label>
      <label class="f" data-days-wrap hidden><span>Every how many days?</span><input name="days" type="number" min="1" value="${esc(x.days || 7)}"></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-item')}</div>`;
}
function itemFormMount(root) { const sel = root.querySelector('[name=freq]'), w = root.querySelector('[data-days-wrap]'); if (!sel || !w) return; const u = () => { w.hidden = sel.value !== 'custom'; }; sel.addEventListener('change', u); u(); }
async function saveItemForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null, scope = form.dataset.scope, rigId = form.dataset.rig || null, eqId = form.dataset.eq || null;
  const name = String(fd.get('name') || '').trim(); if (!name) { toast('Say what to check.', 'bad'); return; }
  const freq = fd.get('freq'), days = freq === 'custom' ? Math.max(1, Number(fd.get('days')) || 7) : (FREQS.find(f => f.k === freq) || FREQS[1]).days;
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('checklist_items').update({ name, freq, days }).eq('id', id); if (r.error) throw r.error; }
    else {
      const sibs = S.items.filter(i => i.scope_type === scope && (scope === 'base' || (scope === 'rig' ? i.rig_id === rigId : i.equipment_id === eqId)));
      const mx = Math.max(0, ...sibs.map(i => i.sort || 0));
      const r = await sb.from('checklist_items').insert({ scope_type: scope, rig_id: scope === 'rig' ? rigId : null, equipment_id: scope === 'equipment' ? eqId : null, name, freq, days, active: true, sort: mx + 10 });
      if (r.error) throw r.error;
    }
    MS.pop(); drawModal(); toast('Check saved', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}

/* ---------- check sheet ---------- */
let CK = null;
function checkStart(rigId) {
  const r = rigId === 'station' ? { id: 'station', unit: 'Station', isStation: true } : D.rigById[rigId];
  if (!r) return;
  CK = { rigId, date: today(), meter: '', showAll: false, res: {}, saving: false };
  MS.push(checkSheetHtml); drawModal();
}
const marked = x => x && (x.mode === 'ok' || (x.mode === 'prob' && x.s));
function checkShown() { return rigFlat(CK.rigId).filter(it => { const d = dueInfo(it, CK.rigId); return CK.showAll || d.state === 'due' || d.state === 'never'; }); }
function ckRowHtml(it) {
  const x = CK.res[it.id] || {}; const d = dueInfo(it, CK.rigId);
  const meta = `${esc(freqLabel(it))}${d.last ? `, last ${esc(fmt(d.last))}` : ', not checked yet'}`;
  let prob = '';
  if (x.mode === 'prob') prob = `<div class="ci-p"><div class="pills">${STATUS.filter(s => s[0] !== 'ok').map(([k, l]) => `<button class="pill${x.s === k ? ' on' : ''}${!x.s ? ' need' : ''}" data-action="ck-st" data-item="${esc(it.id)}" data-st="${k}">${l}</button>`).join('')}</div><label class="f"><span>Comment</span><textarea data-ck-note="${esc(it.id)}">${esc(x.c || '')}</textarea></label></div>`;
  return `<div class="ci" data-item="${esc(it.id)}"><div class="ci-top"><div><div class="ci-name">${esc(it.name)}</div><div class="ci-meta">${meta}</div></div>
    <div class="ci-b"><button class="ck ok${x.mode === 'ok' ? ' on' : ''}" data-action="ck-ok" data-item="${esc(it.id)}">OK</button><button class="ck prob${x.mode === 'prob' ? ' on' : ''}" data-action="ck-prob" data-item="${esc(it.id)}">Problem</button></div></div>${prob}</div>`;
}
function checkSheetHtml() {
  const r = CK.rigId === 'station' ? { unit: 'Station', isStation: true } : D.rigById[CK.rigId];
  const shown = checkShown();
  const nMarked = shown.filter(it => marked(CK.res[it.id])).length;
  const nProb = shown.filter(it => { const x = CK.res[it.id]; return x && x.mode === 'prob'; }).length;
  const o = rigItems(CK.rigId); const inShown = new Set(shown.map(i => i.id));
  const groups = []; const g1 = [...o.base, ...o.own].filter(i => inShown.has(i.id)); if (g1.length) groups.push([r.isStation ? 'Checks' : 'Vehicle checks', g1]);
  const byE = {}; for (const it of o.eq) if (inShown.has(it.id)) (byE[it.equipment_id] = byE[it.equipment_id] || []).push(it);
  for (const eid in byE) { const e = D.eqById[eid]; groups.push([e ? e.name : 'Equipment', byE[eid]]); }
  const body = `<div class="stack">
    <div class="two"><label class="f"><span>Date</span><input type="date" data-ck="date" value="${esc(CK.date)}" max="${today()}"></label>${r.isStation ? '' : `<label class="f"><span>Mileage or hours</span><input data-ck="meter" value="${esc(CK.meter)}" placeholder="e.g. 48,210 mi"></label>`}</div>
    <label class="chk"><input type="checkbox" data-ck-chk="showAll"${CK.showAll ? ' checked' : ''}>Include checks that are not due yet</label>
    <div><div class="spread"><b>${nMarked} of ${shown.length} marked</b>${shown.length ? `<button class="btn sm" data-action="ck-allok">Mark all unmarked OK</button>` : ''}</div><div class="prog"><i style="width:${shown.length ? Math.round(nMarked / shown.length * 100) : 0}%"></i></div></div>
    ${groups.length ? groups.map(([t, its]) => `<div class="card"><div class="grp">${esc(t)}</div>${its.map(ckRowHtml).join('')}</div>`).join('') : '<div class="card empty">Nothing is due right now.</div>'}
  </div>`;
  const foot = `<button class="btn" data-action="m-close">Cancel</button><button class="btn primary" data-action="ck-save"${CK.saving ? ' disabled' : ''}>${CK.saving ? 'Saving…' : `Save check${nProb ? ` (${nProb} ${plural(nProb, 'problem')})` : ''}`}</button>`;
  return sheet(esc(r.unit) + ' check', body, foot, esc(fmt(CK.date)));
}
async function saveCheck() {
  if (!CK || CK.saving) return;
  const all = rigFlat(CK.rigId);
  const todo = all.filter(it => marked(CK.res[it.id]));
  const need = all.filter(it => { const x = CK.res[it.id]; return x && x.mode === 'prob' && !x.s; });
  if (need.length) { toast('Pick what is wrong for each Problem, or change it to OK.', 'bad'); return; }
  if (!todo.length) { toast('Mark at least one item first.', 'bad'); return; }
  if (!CK.date) { toast('Choose a date.', 'bad'); return; }
  CK.saving = true; drawModal();
  const rigIdForDb = CK.rigId === 'station' ? null : CK.rigId;
  try {
    const sr = await sb.from('check_sessions').insert({ rig_id: rigIdForDb, date: CK.date, meter: CK.meter || '', by_member: S.me.id, by_name: S.me.name }).select('id').single();
    if (sr.error) throw sr.error;
    const results = todo.map(it => { const x = CK.res[it.id]; const eq = it.scope_type === 'equipment' ? D.eqById[it.equipment_id] : null; return { session_id: sr.data.id, item_id: it.id, item_name: it.name, equipment_id: eq ? eq.id : null, equipment_name: eq ? eq.name : '', status: x.mode === 'ok' ? 'ok' : x.s, comment: x.mode === 'prob' ? (x.c || '').trim() : '' }; });
    const rr = await sb.from('check_results').insert(results); if (rr.error) throw rr.error;
    const probs = results.filter(r => r.status !== 'ok');
    let newDefs = 0;
    for (const p of probs) {
      if (S.defs.some(d => !d.closed && d.item_id === p.item_id && d.rig_id === rigIdForDb)) continue;
      const dr = await sb.from('deficiencies').insert({ rig_id: rigIdForDb, item_id: p.item_id, item_name: p.item_name, equipment_id: p.equipment_id, equipment_name: p.equipment_name, status: p.status, comment: p.comment, found_date: CK.date, found_by: S.me.name });
      if (dr.error) throw dr.error;
      newDefs++;
    }
    if (CK.meter && rigIdForDb) { const ur = await sb.from('rigs').update({ meter: CK.meter, meter_date: CK.date }).eq('id', rigIdForDb); if (ur.error) throw ur.error; }
    MS.pop(); CK = null; drawModal();
    toast(probs.length ? `Check saved. ${probs.length} ${plural(probs.length, 'deficiency', 'deficiencies')} logged.` : 'Check saved. Everything OK.', probs.length ? '' : 'ok');
    loadAll();
    if (newDefs) { const rig = D.rigById[rigIdForDb]; pushAlert(`${newDefs} new ${plural(newDefs, 'deficiency', 'deficiencies')} logged during today's check on ${rig ? rig.unit : 'the station'}.`); }
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); CK.saving = false; drawModal(); }
}
/* ---------- deficiency edit ---------- */
function defFormHtml(d) {
  return `<div class="sheet-h"><div><h2>Deficiency</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-def" class="form" data-id="${esc(d.id)}">
      <div><b>${esc(d.item_name)}</b> <span class="muted">${esc(SL[d.status] || d.status)}</span></div>
      <label class="f"><span>What is wrong</span><textarea name="comment">${esc(d.comment || '')}</textarea></label>
      <div class="two"><label class="f"><span>Reported to</span><input name="reported_to" value="${esc(d.reported_to || '')}"></label><label class="f"><span>Date reported</span><input name="date_reported" type="date" value="${esc(d.date_reported || '')}"></label></div>
      <div class="two"><label class="f"><span>Date back in service</span><input name="back_date" type="date" value="${esc(d.back_date || '')}"></label><label class="chk" style="align-self:end"><input type="checkbox" name="closed"${d.closed ? ' checked' : ''}>Closed</label></div>
      <label class="f"><span>Resolution notes</span><textarea name="note">${esc(d.note || '')}</textarea></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-def')}</div>`;
}
async function saveDefForm(form) {
  const fd = new FormData(form), id = form.dataset.id;
  const closed = !!fd.get('closed');
  const data = { comment: (fd.get('comment') || '').trim(), reported_to: (fd.get('reported_to') || '').trim(), date_reported: fd.get('date_reported') || null, back_date: fd.get('back_date') || (closed ? today() : null), closed, note: (fd.get('note') || '').trim() };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try { const r = await sb.from('deficiencies').update(data).eq('id', id); if (r.error) throw r.error; MS.pop(); drawModal(); toast('Deficiency saved', 'ok'); loadAll(); }
  catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
async function closeDef(id, closed) { const r = await sb.from('deficiencies').update({ closed, back_date: closed ? today() : null }).eq('id', id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast(closed ? 'Marked back in service' : 'Reopened', 'ok'); loadAll(); }
async function toggleOOS(id) {
  const r = D.rigById[id]; if (!r) return;
  if (r.status === 'out_of_service') { const u = await sb.from('rigs').update({ status: 'in_service', oos_reason: '', oos_since: null }).eq('id', id); if (u.error) { toast('Could not save: ' + u.error.message, 'bad'); return; } toast(r.unit + ' is back in service', 'ok'); loadAll(); return; }
  MS.push(() => sheet('Mark out of service', `<form id="f-oos" class="form" data-id="${esc(id)}"><label class="f"><span>Reason</span><input name="reason" required placeholder="Pump leak, awaiting repair"></label></form>`, `<button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-oos', 'Mark out of service')}`, esc(r.unit))); drawModal();
}
// Fires a push and never blocks or complains to the person who triggered it --
// they did not ask to send a notification, so a failure here is quietly
// logged, not shown as an error on top of whatever they were actually doing.
function pushAlert(text) {
  sb.functions.invoke('send-push', { body: { title: 'Great Bend Fire Department', body: text, aud_all: true } })
    .then(r => { if (r.error) console.warn('Push alert failed:', r.error.message); })
    .catch(e => console.warn('Push alert failed:', (e && e.message) || String(e)));
}
async function saveOOS(form) {
  const fd = new FormData(form), id = form.dataset.id, reason = (fd.get('reason') || '').trim();
  const rig = D.rigById[id];
  const r = await sb.from('rigs').update({ status: 'out_of_service', oos_reason: reason, oos_since: today() }).eq('id', id);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  MS.pop(); drawModal(); toast('Marked out of service', 'ok'); loadAll();
  pushAlert(`${rig ? rig.unit : 'A rig'} is now out of service${reason ? ': ' + reason : ''}.`);
}
async function archiveRig(id) { if (!window.confirm('Archive this rig? It disappears from the list but every record stays.')) return; const r = await sb.from('rigs').update({ archived: true }).eq('id', id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } S.rigId = null; toast('Rig archived', 'ok'); loadAll(); }
async function retireEq(id) {
  const e = D.eqById[id]; if (!e) return;
  MS.push(() => sheet('Retire equipment', `<form id="f-ret" class="form" data-id="${esc(id)}"><p class="muted">The record and its history stay.</p><label class="f"><span>Date retired</span><input name="date" type="date" value="${today()}" max="${today()}" required></label><label class="f"><span>Why</span><textarea name="note"></textarea></label></form>`, `<button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-ret', 'Retire')}`, esc(e.name))); drawModal();
}
async function saveRetire(form) { const fd = new FormData(form), id = form.dataset.id; const r = await sb.from('equipment').update({ status: 'retired', retired_date: fd.get('date'), retire_note: (fd.get('note') || '').trim() }).eq('id', id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } MS.pop(); drawModal(); toast('Equipment retired', 'ok'); loadAll(); }
async function reactivateEq(id) { const r = await sb.from('equipment').update({ status: 'in_service', retired_date: null, retire_note: '' }).eq('id', id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast('Back in service', 'ok'); loadAll(); }
async function archiveItem(id, on) { const r = await sb.from('checklist_items').update({ active: on }).eq('id', id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast(on ? 'Restored' : 'Archived. History is kept.', 'ok'); loadAll(); }

/* ---------- apparatus + equipment actions ---------- */
const RIGACTIONS = {
  'goto-rigs': el => { S.tab = 'rigs'; S.rigId = el.dataset.rig || null; if (S.rigId) S.rsub = 'checks'; render(); window.scrollTo(0, 0); },
  'rig-open': el => { S.rigId = el.dataset.id; S.rsub = 'checks'; render(); window.scrollTo(0, 0); },
  'rig-back': () => { S.rigId = null; render(); window.scrollTo(0, 0); },
  rsub: el => { S.rsub = el.dataset.sub; render(); },
  'base-toggle': () => { S.showBase[S.rigId] = !S.showBase[S.rigId]; render(); },
  'check-start': el => checkStart(el.dataset.id),
  'ck-save': () => saveCheck(),
  'ck-ok': el => { const id = el.dataset.item; const x = CK.res[id] || (CK.res[id] = {}); x.mode = x.mode === 'ok' ? null : 'ok'; drawModal(); },
  'ck-prob': el => { const id = el.dataset.item; const x = CK.res[id] || (CK.res[id] = {}); if (x.mode === 'prob') { x.mode = null; x.s = null; } else x.mode = 'prob'; drawModal(); },
  'ck-st': el => { const x = CK.res[el.dataset.item]; if (x) { x.s = el.dataset.st; drawModal(); } },
  'ck-allok': () => { for (const it of checkShown()) { const x = CK.res[it.id] || (CK.res[it.id] = {}); if (!x.mode) x.mode = 'ok'; } drawModal(); },
  'rig-new': () => { MS.push(() => rigFormHtml(null)); drawModal(); },
  'rig-edit': el => { if (MS.length) MS.pop(); MS.push(() => rigFormHtml(D.rigById[el.dataset.id])); drawModal(); },
  'rig-oos': el => toggleOOS(el.dataset.id),
  'rig-arch': el => archiveRig(el.dataset.id),
  'eq-new': el => { MS.push(() => eqFormHtml(null, el.dataset.assigned)); drawModal(); eqFormMount($('#modal-root')); },
  'eq-open': el => { MS.push(() => eqDetailSheet(el.dataset.id)); drawModal(); },
  'eq-edit': el => { const e = D.eqById[el.dataset.id]; if (MS.length) MS.pop(); MS.push(() => eqFormHtml(e)); drawModal(); eqFormMount($('#modal-root')); },
  'eq-retire': el => retireEq(el.dataset.id),
  'eq-react': el => reactivateEq(el.dataset.id),
  'it-new': el => { MS.push(() => itemFormHtml(el.dataset.scope, el.dataset.rig, el.dataset.eq, null)); drawModal(); itemFormMount($('#modal-root')); },
  'it-edit': el => { const it = S.items.find(i => i.id === el.dataset.id); if (it) { MS.push(() => itemFormHtml(it.scope_type, it.rig_id, it.equipment_id, it)); drawModal(); itemFormMount($('#modal-root')); } },
  'it-arch': el => archiveItem(el.dataset.id, false),
  'it-restore': el => archiveItem(el.dataset.id, true),
  'it-showarch': el => { S.showArch[el.dataset.key] = !S.showArch[el.dataset.key]; render(); },
  'def-edit': el => { const d = S.defs.find(x => x.id === el.dataset.id); if (d) { MS.push(() => defFormHtml(d)); drawModal(); } },
  'def-close': el => closeDef(el.dataset.id, true),
  'def-reopen': el => closeDef(el.dataset.id, false),
  'exp-rigs': () => exportRigs(),
  'exp-equipment': () => exportEquipment(),
  'exp-checks': () => exportChecks(),
  'exp-defs': () => exportDefs(),
  'exp-members': () => exportMembers(),
  'exp-backup': () => exportFullBackup(),
  'od-push': async el => {
    const m = D.memById[el.dataset.id]; if (!m) return;
    const btn = el; btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await sb.functions.invoke('send-push', { body: { title: 'Great Bend Fire Department', body: `${first(m.name)}, you have overdue or missing requirements. Check the app for details.`, member_id: m.id } });
      if (r.error) { r.error.message = await functionErrorMessage(r.error); throw r.error; }
      const d = r.data || {};
      toast(d.sent ? `Reminder sent to ${m.name}` : (d.note || `${m.name} does not have notifications turned on.`), d.sent ? 'ok' : 'bad');
    } catch (e) { toast('Could not send: ' + ((e && e.message) || String(e)), 'bad'); }
    btn.disabled = false; btn.textContent = 'Push a reminder';
  },
  'ev-new': () => { MS.push(() => evFormHtml(null)); drawModal(); evFormMount($('#modal-root')); },
  'ev-open': el => { MS.push(() => evDetailSheet(el.dataset.id)); drawModal(); },
  'ev-edit': el => { const e = S.events.find(x => x.id === el.dataset.id); if (e) { if (MS.length) MS.pop(); MS.push(() => evFormHtml(e)); drawModal(); evFormMount($('#modal-root')); } },
  'ev-day': el => { S.ev.day = el.dataset.day && S.ev.day === el.dataset.day ? '' : el.dataset.day; render(); },
  'ev-month': el => { const [y, m] = S.ev.month.split('-').map(Number); const d = new Date(y, m - 1 + Number(el.dataset.d), 1); S.ev.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; S.ev.day = ''; render(); },
  'ev-slot-add': () => { const c = document.querySelector('#slots'); if (c) c.insertAdjacentHTML('beforeend', slotRowHtml({ need: 4 })); },
  'ev-slot-del': el => { const r = el.closest('.slot-row'); if (r) r.remove(); },
  'ev-join': async el => {
    const e = S.events.find(x => x.id === el.dataset.event); if (!e || !S.me) return;
    const s = (e.slots || []).find(x => x.id === el.dataset.slot); if (!s) return;
    const el2 = slotElig(s); if (!el2.ok) { toast(el2.why, 'bad'); return; }
    if (slotFilled(e, s) >= (Number(s.need) || 0)) { toast('That row is full.', 'bad'); return; }
    const r = await setSignup(e.id, S.me.id, s.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
    toast('You are signed up', 'ok'); loadAll();
  },
  'ev-leave': async el => {
    const e = S.events.find(x => x.id === el.dataset.event); if (!e || !S.me) return;
    const r = await setSignup(e.id, S.me.id, null); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
    toast('You are off the list', 'ok'); loadAll();
  },
  'ev-remove': async el => { const e = S.events.find(x => x.id === el.dataset.event); if (!e) return; const r = await setSignup(e.id, el.dataset.member, null); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast('Removed', 'ok'); loadAll(); },
  'ev-addwho': el => { MS.push(() => evAddSheet(el.dataset.id)); drawModal(); },
  'ev-cancel': async el => {
    const e = S.events.find(x => x.id === el.dataset.id); if (!e) return;
    if (MS.length) { MS.pop(); drawModal(); }
    const wasCancelling = !e.cancelled;
    const r = await sb.from('events').update({ cancelled: wasCancelling }).eq('id', e.id);
    if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
    toast(wasCancelling ? 'Event cancelled' : 'Event reopened', 'ok'); loadAll();
    if (wasCancelling) pushAlert(`Cancelled: ${e.title}, ${evWhen(e)}.`);
  },
  'ev-del': async el => { const e = S.events.find(x => x.id === el.dataset.id); if (!e) return; if (!window.confirm('Delete this event? It disappears for everyone. Cancel it instead if people already signed up.')) return; if (MS.length) { MS.length = 0; drawModal(); } const r = await sb.from('events').update({ removed: true }).eq('id', e.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast('Event deleted', 'ok'); loadAll(); },
  'ev-del-series': async el => {
    const series = el.dataset.series;
    const rows = S.events.filter(x => x.series === series && !x.removed);
    if (!rows.length) return;
    if (!window.confirm(`Delete all ${rows.length} events in this series? This removes every occurrence, not just this one. It cannot be undone.`)) return;
    if (MS.length) { MS.length = 0; drawModal(); }
    const r = await sb.from('events').update({ removed: true }).eq('series', series);
    if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
    toast(`Deleted ${rows.length} events`, 'ok'); loadAll();
  },
  'tr-new': () => { MS.push(() => trFormHtml(null)); drawModal(); },
  'tr-edit': el => { const t = S.trainings.find(x => x.id === el.dataset.id); if (t) { if (MS.length) MS.pop(); MS.push(() => trFormHtml(t)); drawModal(); } },
  'tr-open': el => { MS.push(() => trDetailSheet(el.dataset.id)); drawModal(); },
  'tr-save-att': el => { saveAttendance(el.dataset.id); },
  'ev-att': el => { if (MS.length) MS.pop(); MS.push(() => evAttendanceSheet(el.dataset.id)); drawModal(); },
  'ev-save-att': el => { saveEventAttendance(el.dataset.id); },
  'brd-open': el => { S.brdBoard = el.dataset.board; S.brdThread = null; render(); window.scrollTo(0, 0); markBoardRead(el.dataset.board); },
  'brd-back': () => { S.brdBoard = null; S.brdThread = null; render(); window.scrollTo(0, 0); },
  'thr-back': el => { S.brdThread = null; S.brdBoard = el.dataset.board; render(); window.scrollTo(0, 0); },
  'thr-open': el => { S.brdThread = el.dataset.id; render(); window.scrollTo(0, 0); },
  'thr-new': el => { MS.push(() => threadFormHtml(el.dataset.board, null)); drawModal(); },
  'thr-edit': el => { const t = S.threads.find(x => x.id === el.dataset.id); if (t) { MS.push(() => threadFormHtml(t.board, t)); drawModal(); } },
  'thr-pin': async el => { const t = S.threads.find(x => x.id === el.dataset.id); if (!t) return; const r = await sb.from('board_threads').update({ pinned: !t.pinned }).eq('id', t.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast(t.pinned ? 'Unpinned' : 'Pinned', 'ok'); loadAll(); },
  'thr-lock': async el => { const t = S.threads.find(x => x.id === el.dataset.id); if (!t) return; const r = await sb.from('board_threads').update({ locked: !t.locked }).eq('id', t.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast(t.locked ? 'Unlocked' : 'Locked', 'ok'); loadAll(); },
  'thr-del': async el => { const t = S.threads.find(x => x.id === el.dataset.id); if (!t) return; if (!window.confirm('Delete this thread and all its replies? This cannot be undone.')) return; const r = await sb.from('board_threads').update({ removed: true }).eq('id', t.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } S.brdThread = null; toast('Thread deleted', 'ok'); loadAll(); },
  'rep-edit': el => { const r = (D.repliesByThread[S.brdThread] || []).find(x => x.id === el.dataset.id); if (r) { MS.push(() => replyFormHtml(r)); drawModal(); } },
  'rep-del': async el => { if (!window.confirm('Delete this reply?')) return; const r = await sb.from('board_replies').update({ removed: true }).eq('id', el.dataset.id); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; } toast('Reply deleted', 'ok'); loadAll(); }
};

/* ---------- records: exports and the change log ---------- */
const csvOf = rows => rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function exportRigs() {
  const rows = [['Unit', 'Type', 'Captain', 'Year', 'Make', 'Model', 'VIN', 'Plate', 'Purchase date', 'Purchase amount', 'Estimated value', 'Status', 'Mileage or hours', 'Tracked inspections', 'Notes']];
  for (const r of S.rigs.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)))
    rows.push([r.unit, r.type, r.captain, r.year, r.make, r.model, r.vin, r.plate, r.purchase_date || (r.purchase_date_unknown ? 'Unknown' : ''), hasAmt(r) ? r.purchase_amount : (r.purchase_amount_unknown ? 'Unknown' : ''), r.est_value, r.archived ? 'Archived' : r.status, r.meter, (r.tracked || []).join('; '), r.notes]);
  downloadText(`rigs-${today()}.csv`, csvOf(rows));
}
function exportEquipment() {
  const rows = [['Name', 'Category', 'Assigned to', 'Location', 'Serial number', 'Make and model', 'Purchase date', 'Purchase amount', 'Estimated value', 'Purchased from', 'Status', 'Retired date', 'Retired note', 'Tracked inspections', 'Notes']];
  for (const e of S.equipment.slice().sort((a, b) => a.name.localeCompare(b.name)))
    rows.push([e.name, e.category, whereLabel2(e), e.location, e.serial, e.make_model, e.purchase_date || (e.purchase_date_unknown ? 'Unknown' : ''), hasAmt(e) ? e.purchase_amount : (e.purchase_amount_unknown ? 'Unknown' : ''), e.est_value, e.vendor, e.status, e.retired_date, e.retire_note, (e.tracked || []).join('; '), e.notes]);
  downloadText(`equipment-${today()}.csv`, csvOf(rows));
}
function exportChecks() {
  const rows = [['Date', 'Rig', 'Checked by', 'Mileage or hours', 'Item', 'Equipment', 'Status', 'Comment']];
  for (const s of S.sessions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    for (const r of (D.resBySession[s.id] || [])) rows.push([s.date, s.rig_id ? rigName(s.rig_id) : 'Station', s.by_name, s.meter, r.item_name, r.equipment_name, SL[r.status] || r.status, r.comment]);
  downloadText(`check-history-${today()}.csv`, csvOf(rows));
}
function exportDefs() {
  const rows = [['Rig', 'Item', 'Equipment', 'Status', 'Comment', 'Found', 'Found by', 'Reported to', 'Date reported', 'Back in service', 'Closed', 'Notes']];
  for (const d of S.defs.slice().sort((a, b) => (a.found_date || '').localeCompare(b.found_date || '')))
    rows.push([d.rig_id ? rigName(d.rig_id) : 'Station', d.item_name, d.equipment_name, SL[d.status] || d.status, d.comment, d.found_date, d.found_by, d.reported_to, d.date_reported, d.back_date, d.closed ? 'Yes' : 'No', d.note]);
  downloadText(`deficiencies-${today()}.csv`, csvOf(rows));
}
async function exportMembers() {
  toast('Preparing export…');
  try {
    const [priv, access] = await Promise.all([sb.from('member_private').select('*'), sb.from('member_access').select('*')]);
    if (priv.error) throw priv.error; if (access.error) throw access.error;
    const privById = Object.fromEntries((priv.data || []).map(p => [p.member_id, p]));
    const accById = Object.fromEntries((access.data || []).map(a => [a.member_id, a]));
    const rows = [['Name', 'NYS training ID', 'Rank', 'Category', 'Role', 'Status', 'Joined']];
    for (const m of S.members.slice().sort((a, b) => a.name.localeCompare(b.name)))
      rows.push([m.name, (privById[m.id] || {}).nys_id || '', rankOf(m), m.category, roleLabelOf(effPerms(accById[m.id])), m.status, m.joined]);
    downloadText(`members-${today()}.csv`, csvOf(rows));
    toast('Export ready', 'ok');
  } catch (e) { toast('Could not export: ' + ((e && e.message) || String(e)), 'bad'); }
}
async function exportFullBackup() {
  toast('Preparing backup…');
  try {
    const [priv, access, audit] = await Promise.all([
      sb.from('member_private').select('*'), sb.from('member_access').select('*'), sb.from('audit_log').select('*').order('at', { ascending: false }).limit(2000)
    ]);
    for (const r of [priv, access, audit]) if (r.error) throw r.error;
    const backup = {
      exported_at: new Date().toISOString(),
      rigs: S.rigs, equipment: S.equipment, checklist_items: S.items, check_sessions: S.sessions, check_results: S.results, deficiencies: S.defs,
      members: S.members, member_private: priv.data, member_access: access.data, requirements: S.reqs, member_records: S.records, messages: S.messages, audit_log: audit.data
    };
    downloadText(`gbfd-backup-${today()}.json`, JSON.stringify(backup, null, 2), 'application/json');
    toast('Backup ready', 'ok');
  } catch (e) { toast('Could not prepare the backup: ' + ((e && e.message) || String(e)), 'bad'); }
}
async function loadAudit() {
  S.auditLoading = true; render();
  try {
    const r = await sb.from('audit_log').select('*').order('at', { ascending: false }).limit(200);
    if (r.error) throw r.error;
    S.audit = r.data || [];
  } catch (e) { S.auditError = (e && e.message) || String(e); }
  S.auditLoading = false; render();
}
// supabase-js only gives a generic "non-2xx status code" message by default --
// the function's own, more specific error message is in the response body,
// which has to be read separately.
async function functionErrorMessage(error) {
  try {
    if (error && error.context && typeof error.context.json === 'function') {
      const j = await error.context.json();
      if (j && j.error) return j.error;
    }
  } catch (e2) {}
  return (error && error.message) || String(error);
}
async function sendInvites(memberIds) {
  const body = memberIds ? { member_ids: memberIds } : {};
  toast('Sending invites…');
  try {
    const r = await sb.functions.invoke('invite-members', { body });
    if (r.error) { r.error.message = await functionErrorMessage(r.error); throw r.error; }
    const d = r.data || {};
    if (d.note) toast(d.note, 'ok');
    else toast(`Invited ${d.invited || 0} member(s)${d.failed ? `, ${d.failed} could not be reached -- check the change log or try again` : ''}`, d.failed ? 'bad' : 'ok');
    if (d.errors && d.errors.length) console.warn('Invite failures:', d.errors);
    return true;
  } catch (e) { toast('Could not send invites: ' + ((e && e.message) || String(e)), 'bad'); return false; }
}
async function openInvitePicker() {
  const btn = document.querySelector('[data-action=invite-members]'); if (btn) btn.disabled = true;
  try {
    const [members, priv] = await Promise.all([
      sb.from('members').select('id,name,category').eq('status', 'active').is('user_id', null).order('name'),
      sb.from('member_private').select('member_id,email')
    ]);
    if (members.error) throw members.error; if (priv.error) throw priv.error;
    const emailByMember = Object.fromEntries((priv.data || []).filter(p => p.email).map(p => [p.member_id, p.email]));
    const waiting = (members.data || []).filter(m => emailByMember[m.id]);
    if (!waiting.length) { toast('Nobody without a linked account has an email on file yet.', 'ok'); return; }
    MS.push(() => invitePickerHtml(waiting, emailByMember));
    drawModal();
  } catch (e) { toast('Could not load the list: ' + ((e && e.message) || String(e)), 'bad'); }
  if (btn) btn.disabled = false;
}
function invitePickerHtml(waiting, emailByMember) {
  return `<div class="sheet-h"><div><h2>Invite members</h2><span class="muted sm">Pick who gets an invite email right now. Anyone left unchecked stays waiting -- come back and invite them later.</span></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><div class="row" style="margin-bottom:10px"><button class="btn sm" data-action="invite-pick-all">Select all</button><button class="btn sm" data-action="invite-pick-none">Select none</button></div>
      <div class="card list">${waiting.map(m => `<label class="li" style="cursor:pointer"><div class="t"><b>${esc(m.name)}</b><span class="muted sm">${esc(m.category || 'No category')} -- ${esc(emailByMember[m.id])}</span></div><input type="checkbox" class="invite-pick" data-id="${esc(m.id)}" style="width:22px;height:22px;accent-color:var(--navy)"></label>`).join('')}</div></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button><button class="btn primary" data-action="invite-pick-send">Send invites</button></div>`;
}
async function sendPickedInvites() {
  const ids = [...document.querySelectorAll('.invite-pick:checked')].map(el => el.dataset.id);
  if (!ids.length) { toast('Check at least one person first.', 'bad'); return; }
  const btn = document.querySelector('[data-action=invite-pick-send]'); if (btn) btn.disabled = true;
  const ok = await sendInvites(ids);
  if (ok) { MS.pop(); drawModal(); }
  if (btn) btn.disabled = false;
}
function recordsView() {
  return `<div class="head-row"><h1>Records</h1></div>
    <div class="card pad" style="margin-bottom:14px"><h3>Exports</h3><p class="muted sm" style="margin:4px 0 12px">Spreadsheet files for anyone who asks to see your records, plus a full backup you can keep.</p>
      <div class="row"><button class="btn" data-action="exp-rigs">Rigs</button><button class="btn" data-action="exp-equipment">Equipment</button><button class="btn" data-action="exp-checks">Check history</button><button class="btn" data-action="exp-defs">Deficiencies</button><button class="btn" data-action="exp-members">Members</button><button class="btn primary" data-action="exp-backup">Full backup</button></div></div>
    <div class="card pad" style="margin-bottom:14px"><h3>Invite members</h3><p class="muted sm" style="margin:4px 0 12px">Choose who gets a sign-in invite. Needs custom SMTP set up first (see the README) -- without it, invites will not reach anyone outside your Supabase organization.</p>
      <button class="btn primary" data-action="invite-members">Invite members…</button></div>
    <div class="sec"><h3>Change log</h3><span class="muted sm">Who changed what, newest first.</span></div>
    <div class="card list">${S.auditError ? `<div class="empty">Could not load the change log: ${esc(S.auditError)}</div>` : S.audit === null || S.auditLoading ? '<div class="empty">Loading…</div>' : S.audit.length ? S.audit.map(a => `<div class="li"><div class="t"><b>${esc(a.action)}</b><span class="muted sm">${esc(a.what)}</span></div><span class="muted sm" style="text-align:right">${esc(new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${a.actor_name ? '<br>' + esc(a.actor_name) : ''}</span></div>`).join('') : '<div class="empty">No changes logged yet.</div>'}</div>`;
}

/* ---------- events and manpower signup ---------- */
const WEEKDAYS2 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD2 = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
const fmt2 = s => pd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = t => { if (!t) return ''; const [a, b] = t.split(':').map(Number); return `${a % 12 || 12}:${pad(b)} ${a >= 12 ? 'PM' : 'AM'}`; };
const evWhen = e => fmt(e.date) + (e.start_time ? ', ' + fmtTime(e.start_time) + (e.end_time ? ' to ' + fmtTime(e.end_time) : '') : '');
function nthWeekdayOf(y, m0, wd, nth) {
  if (nth === 0) { const last = new Date(y, m0 + 1, 0); const diff = (last.getDay() - wd + 7) % 7; return iso(new Date(y, m0, last.getDate() - diff)); }
  const first = new Date(y, m0, 1); const day = 1 + (wd - first.getDay() + 7) % 7 + (nth - 1) * 7;
  return day <= new Date(y, m0 + 1, 0).getDate() ? iso(new Date(y, m0, day)) : null;
}
function repeatOptions(dateStr) {
  const d = pd(dateStr), day = d.getDate(), dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), wd = WEEKDAYS2[d.getDay()], nth = Math.ceil(day / 7);
  const o = [['', 'Does not repeat'], ['7', 'Every week'], ['14', 'Every 2 weeks'], ['m', 'Every month on the same date (' + day + ')']];
  if (nth <= 4) o.push(['nth:' + nth, `Every month on the ${ORD2[nth]} ${wd}`]);
  if (day + 7 > dim) o.push(['last', 'Every month on the last ' + wd]);
  return o;
}
function repeatDates(start, mode, n) {
  const out = [start], d = pd(start);
  for (let i = 1; i < n; i++) {
    let x = null; const t = new Date(d.getFullYear(), d.getMonth() + i, 1);
    if (mode === '7' || mode === '14') x = addDays(start, i * Number(mode));
    else if (mode === 'm') x = addMonths(start, i);
    else if (mode && mode.startsWith('nth:')) x = nthWeekdayOf(t.getFullYear(), t.getMonth(), d.getDay(), Number(mode.slice(4)));
    else if (mode === 'last') x = nthWeekdayOf(t.getFullYear(), t.getMonth(), d.getDay(), 0);
    if (x) out.push(x);
  }
  return out;
}
const evPeople = id => (D.signByEvent && D.signByEvent[id]) || {};
const slotFilled = (e, s) => { const p = evPeople(e.id); return Object.values(p).filter(x => x.slot_id === s.id).length; };
function evStatus(e) { const sl = e.slots || []; let need = 0, filled = 0; for (const s of sl) { const n = Number(s.need) || 0; need += n; filled += Math.min(slotFilled(e, s), n); } return { need, filled }; }
const myEntry = e => S.me ? evPeople(e.id)[S.me.id] || null : null;
function slotElig(s) {
  const m = S.me; if (!m) return { ok: false, why: 'Your sign-in is not linked to a member record' };
  if (s.cats && s.cats.length && !s.cats.includes(m.category)) return { ok: false, why: 'Open to ' + s.cats.join(' and ') + ' members' };
  if (s.req) { const rq = S.reqs.find(r => r.id === s.req); const row = reqRows(m).find(x => x.req.id === s.req); if (!row || row.state === 'none' || row.state === 'overdue' || row.state === 'failed') return { ok: false, why: (rq ? rq.name : 'A requirement') + ' is not current' }; }
  return { ok: true };
}
function evCard(e) {
  const st = evStatus(e), mine = myEntry(e);
  return `<button class="card eqcard${e.cancelled ? ' retired' : ''}" data-action="ev-open" data-id="${esc(e.id)}"><span class="top2"><b>${esc(e.title)}</b>${chip(e.category || 'Event')}</span><span class="muted sm">${esc(evWhen(e))}</span><span class="sm">${esc(e.location || '') || '&nbsp;'}</span><span class="rc-chips">${e.cancelled ? chip('Cancelled', 'bad') : st.need ? chip(`${st.filled} of ${st.need} filled`, st.filled >= st.need ? 'ok' : 'warn') : ''}${mine && !e.cancelled ? chip('You are signed up', 'ok') : ''}</span></button>`;
}
function homeEvents() {
  const t = today(); const list = S.events.filter(e => !e.removed && !e.cancelled && e.date >= t).sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || ''))).slice(0, 3);
  if (!list.length) return '';
  return `<div class="sec"><div class="spread"><h3>Upcoming events</h3><button class="btn ghost sm" data-action="tab" data-tab="events">See all</button></div></div><div class="eqlist">${list.map(evCard).join('')}</div>`;
}
function calHtml() {
  const f = S.ev; const [y, mo] = f.month.split('-').map(Number); const lead = new Date(y, mo - 1, 1).getDay(), dim = new Date(y, mo, 0).getDate(), t = today();
  const by = {}; for (const e of S.events) { if (!e.removed && e.date && e.date.startsWith(f.month)) (by[e.date] = by[e.date] || []).push(e); }
  let cells = ''; for (let i = 0; i < lead; i++) cells += '<span class="blank"></span>';
  for (let d = 1; d <= dim; d++) { const dt = `${f.month}-${pad(d)}`, ev = by[dt] || []; cells += `<button data-action="ev-day" data-day="${dt}"${dt === t ? ' class="today"' : ''}${f.day === dt ? ' class="sel"' : ''} aria-label="${esc(fmt(dt))}${ev.length ? ', ' + ev.length + ' ' + plural(ev.length, 'event') : ''}">${d}<span class="dots">${ev.slice(0, 3).map(e => { const s = evStatus(e); return `<i class="${e.cancelled ? 'off' : (s.need && s.filled >= s.need) ? 'full' : ''}"></i>`; }).join('')}</span></button>`; }
  return `<div class="spread" style="margin-bottom:8px"><button class="btn sm" data-action="ev-month" data-d="-1" aria-label="Previous month">←</button><b style="font:700 20px 'Barlow Condensed',sans-serif">${esc(new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</b><button class="btn sm" data-action="ev-month" data-d="1" aria-label="Next month">→</button></div>
    <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<span class="dow">${d}</span>`).join('')}${cells}</div>`;
}
function eventsList() {
  const f = S.ev, t = today();
  let list = S.events.filter(e => !e.removed).slice().sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
  if (f.day) list = list.filter(e => e.date === f.day); else if (!f.past) list = list.filter(e => e.date >= t); else list = list.reverse();
  return list.length ? `<div class="eqlist">${list.map(evCard).join('')}</div>` : `<div class="card empty">${f.day ? 'Nothing on this day.' : 'No events coming up.'}</div>`;
}
function eventsView() {
  const f = S.ev; if (!f.month) f.month = today().slice(0, 7);
  return `<div class="head-row"><h1>Events</h1>${S.perms.manage_events ? '<button class="btn primary" data-action="ev-new">Add an event</button>' : ''}</div>
    <div class="card pad" style="margin-bottom:14px">${calHtml()}</div>
    <div class="spread" style="margin-bottom:10px"><h3>${f.day ? esc(fmt(f.day)) : f.past ? 'All events, newest first' : 'Coming up'}</h3><div class="row">${f.day ? '<button class="btn sm" data-action="ev-day" data-day="">Show all</button>' : `<label class="chk" style="min-height:36px"><input type="checkbox" id="ev-past"${f.past ? ' checked' : ''}>Include past events</label>`}</div></div>
    <div id="ev-list">${eventsList()}</div>`;
}
function evText(e) {
  const p = evPeople(e.id);
  return `${e.title}\n${evWhen(e)}${e.location ? '\n' + e.location : ''}${e.cancelled ? '\nCANCELLED' : ''}\n\n` + (e.slots || []).map(s => { const names = Object.values(p).filter(x => x.slot_id === s.id).map(x => (D.memById[x.member_id] || {}).name || '?'); return `${s.label} (${names.length} of ${s.need}): ${names.join(', ') || 'nobody yet'}`; }).join('\n');
}
function evDetailSheet(id) {
  const e = S.events.find(x => x.id === id);
  if (!e || e.removed) return sheet('Event', '<div class="empty">This event no longer exists.</div>', '<button class="btn" data-action="m-close">Close</button>');
  const t = today(), past = e.date < t, p = evPeople(id), mine = myEntry(e), mgr = S.perms.manage_events, m = S.me;
  const slots = (e.slots || []).map(s => {
    const rows = Object.values(p).filter(x => x.slot_id === s.id).sort((a, b) => ((D.memById[a.member_id] || {}).name || '').localeCompare((D.memById[b.member_id] || {}).name || ''));
    const n = Number(s.need) || 0, full = rows.length >= n, el = slotElig(s), rq = s.req ? S.reqs.find(r => r.id === s.req) : null;
    let action = '';
    if (mine && mine.slot_id === s.id && !past && !e.cancelled) action = `<button class="btn sm" data-action="ev-leave" data-event="${esc(id)}">Leave</button>`;
    else if (!past && !e.cancelled && m) { action = !el.ok ? `<span class="muted sm">${esc(el.why)}</span>` : full ? '<span class="muted sm">Full</span>' : `<button class="btn sm primary" data-action="ev-join" data-event="${esc(id)}" data-slot="${esc(s.id)}">${mine ? 'Switch here' : 'Sign up'}</button>`; }
    return `<div class="card pad stack" style="gap:8px"><div class="spread"><b>${esc(s.label)}</b><span class="row">${chip(`${rows.length} of ${n}`, rows.length >= n ? 'ok' : 'warn')}${rows.length > n ? chip('Over by ' + (rows.length - n), 'bad') : ''}</span></div>
      <div class="muted sm">${s.cats && s.cats.length ? 'Open to ' + esc(s.cats.join(' and ')) + ' members. ' : 'Open to any member. '}${rq ? 'Needs a current ' + esc(rq.name) + '.' : ''}</div>
      <div class="who">${rows.length ? rows.map(x => { const mm = D.memById[x.member_id]; return `<span class="chip${x.member_id === (m && m.id) ? ' ok' : ''}">${esc(mm ? mm.name : '?')}${mgr && !past ? `<button aria-label="Remove ${esc(mm ? mm.name : '')}" data-action="ev-remove" data-event="${esc(id)}" data-member="${esc(x.member_id)}">×</button>` : ''}</span>`; }).join('') : '<span class="muted sm">Nobody yet</span>'}</div>
      ${action ? `<div class="row">${action}</div>` : ''}</div>`;
  }).join('');
  const satRq = e.satisfies_requirement_id ? S.reqs.find(r => r.id === e.satisfies_requirement_id) : null;
  const attCount = (D.evAttendance[id] || []).length;
  const body = `<div class="rc-chips" style="margin-bottom:10px">${chip(e.category || 'Event')}${e.cancelled ? chip('Cancelled', 'bad') : past ? chip('Past') : ''}${mine && !e.cancelled ? chip('You are signed up', 'ok') : ''}${satRq ? chip('Satisfies ' + satRq.name) : ''}</div>
    <div class="card pad stack" style="gap:4px"><b>${esc(evWhen(e))}</b>${e.location ? `<span>${esc(e.location)}</span>` : ''}${e.description ? `<span class="muted" style="white-space:pre-wrap;margin-top:6px">${esc(e.description)}</span>` : ''}</div>
    ${!m && !mgr ? '<div class="banner" style="margin-top:10px">Your sign-in is not linked to a member record, so you cannot sign up yet. Ask an administrator to link it.</div>' : ''}
    ${satRq && S.perms.manage_training ? `<div class="card pad spread" style="margin-top:10px"><span>${attCount ? attCount + ' marked present' : 'Nobody marked present yet'}. Attending completes ${esc(satRq.name)} for them.</span><button class="btn sm" data-action="ev-att" data-id="${esc(id)}">Take attendance</button></div>` : ''}
    <div class="sec"><h3>Who is needed</h3></div><div class="stack">${slots || '<div class="card empty">No signup slots for this event.</div>'}</div>`;
  const foot = `<button class="btn" data-action="m-close">Close</button>${mgr ? `<button class="btn" data-action="copy" data-v="${esc(evText(e))}">Copy list</button>${!past && !e.cancelled ? `<button class="btn" data-action="ev-addwho" data-id="${esc(id)}">Add someone</button>` : ''}<button class="btn primary" data-action="ev-edit" data-id="${esc(id)}">Edit</button>` : ''}`;
  return sheet(esc(e.title), body, foot);
}
function evAttendanceSheet(id) {
  const e = S.events.find(x => x.id === id);
  if (!e) return sheet('Event', '<div class="empty">This event no longer exists.</div>', '<button class="btn" data-action="m-close">Close</button>');
  const rq = e.satisfies_requirement_id ? S.reqs.find(r => r.id === e.satisfies_requirement_id) : null;
  const attended = new Set(D.evAttendance[id] || []);
  const signedUp = new Set(Object.keys(evPeople(id)));
  const list = S.members.filter(m => m.status !== 'inactive').sort((a, b) => (signedUp.has(b.id) - signedUp.has(a.id)) || a.name.localeCompare(b.name));
  const body = `${rq ? `<p class="muted sm">Checking someone here records their ${esc(rq.name)} as done, dated to this event.</p>` : ''}
    <div class="card list">${list.map(m => `<label class="li" style="cursor:pointer"><div class="t"><b>${esc(m.name)}</b><span class="muted sm">${esc(m.category || 'No category')}${signedUp.has(m.id) ? ', signed up' : ''}</span></div><input type="checkbox" class="ev-att" data-id="${esc(m.id)}"${attended.has(m.id) ? ' checked disabled' : ''} style="width:22px;height:22px;accent-color:var(--navy)"></label>`).join('')}</div>`;
  return sheet('Attendance', body, `<button class="btn" data-action="m-close">Close</button><button class="btn primary" data-action="ev-save-att" data-id="${esc(id)}">Save attendance</button>`, esc(e.title));
}
async function saveEventAttendance(eventId) {
  const checked = [...document.querySelectorAll('.ev-att:checked:not(:disabled)')].map(el => el.dataset.id);
  if (!checked.length) { toast('Check at least one new attendee, or close if nobody new attended.', 'bad'); return; }
  const btn = document.querySelector('[data-action=ev-save-att]'); if (btn) btn.disabled = true;
  try {
    const e = S.events.find(x => x.id === eventId);
    const rows = checked.map(member_id => ({ event_id: eventId, member_id }));
    const r = await sb.from('event_attendance').insert(rows); if (r.error) throw r.error;
    if (e && e.satisfies_requirement_id) {
      const recs = checked.map(member_id => ({ member_id, requirement_id: e.satisfies_requirement_id, done_on: e.date, due_on: null, approx: false, result: 'Pass', notes: 'Event: ' + e.title, recorded_by: S.me ? S.me.id : null }));
      const rr = await sb.from('member_records').insert(recs); if (rr.error) throw rr.error;
    }
    MS.pop(); drawModal(); toast(`Marked ${checked.length} present`, 'ok'); loadAll();
  } catch (e2) { toast('Could not save: ' + ((e2 && e2.message) || String(e2)), 'bad'); if (btn) btn.disabled = false; }
}
function slotRowHtml(s) {
  s = s || {}; const reqs = S.reqs.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  return `<div class="slot-row card pad stack"><input type="hidden" name="slot_id" value="${esc(s.id || '')}">
    <div class="two"><label class="f"><span>Who is needed</span><input name="slot_label" value="${esc(s.label || '')}" placeholder="Firefighters, Fire police, Any member"></label><label class="f"><span>How many</span><input name="slot_need" type="number" min="1" value="${esc(s.need || 4)}"></label></div>
    <div class="f"><span>Open to</span><div class="aud">${CATS.map(c => `<label class="chk"><input type="checkbox" name="slot_cat" value="${esc(c)}"${(s.cats || []).includes(c) ? ' checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div><span class="muted sm">Leave all unchecked for any member.</span></div>
    <label class="f"><span>Must have a current</span><select name="slot_req"><option value="">Nothing required</option>${reqs.map(r => `<option value="${esc(r.id)}"${s.req === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    <button type="button" class="btn sm danger" data-action="ev-slot-del">Remove this row</button></div>`;
}
function evFormHtml(e) {
  const x = e || { date: today(), slots: [{ id: '', label: 'Any member', need: 6, cats: [], req: '' }] };
  return `<div class="sheet-h"><div><h2>${e ? 'Edit event' : 'Add an event'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-ev" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Title</span><input name="title" value="${esc(x.title || '')}" required placeholder="Monthly meeting, hose testing, parade detail"></label>
      <div class="two"><label class="f"><span>Type</span><input name="category" list="dl-evcat" value="${esc(x.category || '')}"></label><label class="f"><span>Date</span><input name="date" type="date" value="${esc(x.date || today())}" required></label></div>
      <div class="two"><label class="f"><span>Starts</span><input name="start_time" type="time" value="${esc(x.start_time || '')}"></label><label class="f"><span>Ends</span><input name="end_time" type="time" value="${esc(x.end_time || '')}"></label></div>
      <label class="f"><span>Where</span><input name="location" value="${esc(x.location || '')}" placeholder="Station 24"></label>
      <label class="f"><span>Details</span><textarea name="description" placeholder="What to bring, who to contact">${esc(x.description || '')}</textarea></label>
      <label class="f"><span>If this is a training, it satisfies</span><select name="req"><option value="">Nothing in particular</option>${S.reqs.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(r => `<option value="${esc(r.id)}"${x.satisfies_requirement_id === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <div class="muted sm" style="margin-top:-6px">Taking attendance at this event will then complete it for whoever actually showed up -- separately from who signed up ahead of time.</div>
      <div class="sec" style="margin:4px 0"><h3>Manpower</h3><span class="muted sm">Add a row for each kind of help you need. Members sign up for one row.</span></div>
      <div id="slots" class="stack">${(x.slots || []).map(slotRowHtml).join('')}</div>
      <div><button type="button" class="btn sm" data-action="ev-slot-add">Add a row</button></div>
      ${e ? (x.series ? `<label class="chk"><input type="checkbox" name="applyall">Apply these changes to this and all later events in the series</label><div class="muted sm" style="margin-top:-6px">Each keeps its own date and its own signups.</div>` : '') : `<div class="two"><label class="f"><span>Repeat</span><select name="repeat" id="ev-repeat"><option value="">Does not repeat</option></select></label><label class="f" data-rep-wrap hidden><span>How many in all</span><input name="repeat_n" type="number" min="2" max="36" value="6"></label></div>
      <div class="muted sm" id="ev-repprev" style="margin-top:-6px"></div>
      <label class="chk"><input type="checkbox" name="announce" checked>Also post a message on everyone's home page</label>`}
      <datalist id="dl-evcat">${EV_CATS.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${e ? `<button class="btn danger" data-action="ev-cancel" data-id="${esc(x.id)}">${x.cancelled ? 'Reopen' : 'Cancel event'}</button><button class="btn danger" data-action="ev-del" data-id="${esc(x.id)}">Delete</button>${x.series ? `<button class="btn danger" data-action="ev-del-series" data-series="${esc(x.series)}">Delete this and every event in the series</button>` : ''}` : ''}${saveBtn('f-ev')}</div>`;
}
const EV_CATS = ['Training', 'Meeting', 'Drill', 'Detail or standby', 'Fundraiser', 'Community event', 'Other'];
function evFormMount(root) {
  const f = root.querySelector('#f-ev'); if (!f) return;
  const sel = f.elements.repeat; if (sel) {
    const dI = f.elements.date, nI = f.elements.repeat_n, w = root.querySelector('[data-rep-wrap]'), pv = root.querySelector('#ev-repprev');
    const upd = () => { w.hidden = !sel.value; if (!sel.value || !dI.value) { pv.textContent = ''; return; } const n = Math.min(36, Math.max(2, Number(nI.value) || 6)); const ds = repeatDates(dI.value, sel.value, n); pv.textContent = ds.length + ' events: ' + ds.slice(0, 6).map(fmt2).join('; ') + (ds.length > 6 ? '; and ' + (ds.length - 6) + ' more' : '') + (ds.length < n ? '. Some months have no such day, so fewer than ' + n + ' were found.' : ''); };
    const build = () => { const cur = sel.value, opts = repeatOptions(dI.value || today()); sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); const keep = opts.find(o => o[0] === cur) || (cur.startsWith('nth:') ? opts.find(o => o[0].startsWith('nth:')) : null); sel.value = keep ? keep[0] : ''; upd(); };
    dI.addEventListener('change', build); sel.addEventListener('change', upd); nI.addEventListener('input', upd); build();
  }
}
async function saveEvForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  if (!fd.get('title').trim() || !fd.get('date')) { toast('Add a title and a date.', 'bad'); return; }
  const slots = [...form.querySelectorAll('.slot-row')].map(r => ({ id: r.querySelector('[name=slot_id]').value || ('s' + Math.random().toString(36).slice(2)), label: (r.querySelector('[name=slot_label]').value || '').trim() || 'Any member', need: Math.max(1, Number(r.querySelector('[name=slot_need]').value) || 1), cats: [...r.querySelectorAll('[name=slot_cat]:checked')].map(c => c.value), req: r.querySelector('[name=slot_req]').value || '' }));
  const data = { title: fd.get('title').trim(), category: (fd.get('category') || '').trim(), date: fd.get('date'), start_time: fd.get('start_time') || '', end_time: fd.get('end_time') || '', location: (fd.get('location') || '').trim(), description: (fd.get('description') || '').trim(), satisfies_requirement_id: fd.get('req') || null, slots };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) {
      const cur = S.events.find(x => x.id === id);
      const r = await sb.from('events').update(data).eq('id', id); if (r.error) throw r.error;
      let more = 0;
      if (fd.get('applyall') && cur && cur.series) {
        const { date: _d, ...rest } = data;
        for (const o of S.events.filter(x => x.series === cur.series && !x.removed && x.id !== id && x.date >= cur.date)) { const ur = await sb.from('events').update(rest).eq('id', o.id); if (!ur.error) more++; }
      }
      MS.pop(); drawModal(); toast(more ? `Saved, and updated ${more} later event(s)` : 'Event saved', 'ok'); loadAll();
      return;
    }
    const rep = fd.get('repeat');
    const n = rep ? Math.min(36, Math.max(2, Number(fd.get('repeat_n')) || 6)) : 1;
    const dates = rep ? repeatDates(data.date, rep, n) : [data.date];
    const series = dates.length > 1 ? 'ser' + Math.random().toString(36).slice(2) : null;
    for (const d of dates) { const r = await sb.from('events').insert({ ...data, date: d, series, cancelled: false, removed: false, by_member: S.me ? S.me.id : null }); if (r.error) throw r.error; }
    if (fd.get('announce')) {
      const mr = await sb.from('messages').insert({ body: `New event: ${data.title}, ${evWhen(data)}${data.location ? ' at ' + data.location : ''}${dates.length > 1 ? ' (repeats, ' + dates.length + ' dates)' : ''}. Sign up under Events.`, tone: 'info', aud_all: true, aud_cats: [], starts_on: today(), ends_on: data.date, by_member: S.me ? S.me.id : null, removed: false });
      if (mr.error) console.warn('Could not post the event announcement:', mr.error.message);
    }
    MS.pop(); drawModal(); toast(dates.length > 1 ? dates.length + ' events added' : 'Event added', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
async function setSignup(eventId, memberId, slotId) {
  if (slotId) { const r = await sb.from('event_signups').upsert({ event_id: eventId, member_id: memberId, slot_id: slotId }, { onConflict: 'event_id,member_id' }); return r; }
  return await sb.from('event_signups').delete().eq('event_id', eventId).eq('member_id', memberId);
}
function evAddSheet(id) {
  const e = S.events.find(x => x.id === id); if (!e) return '';
  const p = evPeople(id), mem = S.members.filter(m => m.status !== 'inactive').sort((a, b) => a.name.localeCompare(b.name));
  return sheet('Add someone', `<form id="f-evadd" class="form" data-id="${esc(id)}">
    <label class="f"><span>Member</span><select name="member">${mem.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${p[m.id] ? ' (already signed up)' : ''}</option>`).join('')}</select></label>
    <label class="f"><span>Row</span><select name="slot">${(e.slots || []).map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</select></label>
    <p class="muted sm">Adding someone here skips the row's category and requirement checks, so you can place anyone you choose.</p></form>`, `<button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-evadd', 'Add')}`, esc(e.title));
}
async function saveEvAdd(form) {
  const fd = new FormData(form), id = form.dataset.id; const m = D.memById[fd.get('member')];
  const r = await setSignup(id, fd.get('member'), fd.get('slot')); if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  MS.pop(); drawModal(); toast('Added', 'ok'); loadAll();
}

/* ---------- trainings and attendance ---------- */
const REQ_FREQ_LOOKUP = () => Object.fromEntries(S.reqs.map(r => [r.id, r]));
function trainingsView() {
  const list = S.trainings.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const reqById = REQ_FREQ_LOOKUP();
  return `<div class="head-row"><div><h3>Trainings</h3><span class="muted sm">Meetings, drills and classes, with who attended.</span></div>${S.perms.manage_training ? '<button class="btn primary" data-action="tr-new">Add a training</button>' : ''}</div>
    <div class="card list">${list.length ? list.map(t => {
      const n = (D.attendance[t.id] || []).length, rq = t.satisfies_requirement_id ? reqById[t.satisfies_requirement_id] : null;
      return `<div class="li"><div class="t"><button class="btn ghost" style="padding:0;min-height:0;justify-content:flex-start;font-weight:600;color:var(--ink);text-align:left" data-action="tr-open" data-id="${esc(t.id)}">${esc(t.title)}</button><span class="muted sm">${esc(fmt(t.date))}${t.hours ? ', ' + t.hours + ' ' + plural(Number(t.hours), 'hour') : ''}${t.instructor ? ', taught by ' + esc(t.instructor) : ''}${rq ? '. Satisfies ' + esc(rq.name) : ''}</span></div><div class="acts">${chip(n + ' ' + plural(n, 'attendee'))}</div></div>`;
    }).join('') : '<div class="empty">No trainings logged yet.</div>'}</div>`;
}
function trFormHtml(t) {
  const x = t || { date: today() };
  const reqs = S.reqs.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  return `<div class="sheet-h"><div><h2>${t ? 'Edit training' : 'Add a training'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-tr" class="form" data-id="${esc(x.id || '')}">
      <label class="f"><span>Title</span><input name="title" value="${esc(x.title || '')}" required placeholder="OSHA 8-hour refresher"></label>
      <div class="two"><label class="f"><span>Date</span><input name="date" type="date" value="${esc(x.date || today())}" required max="${today()}"></label><label class="f"><span>Hours</span><input name="hours" type="number" step="0.5" min="0" value="${esc(x.hours || '')}"></label></div>
      <label class="f"><span>Instructor</span><input name="instructor" value="${esc(x.instructor || '')}"></label>
      <label class="f"><span>Topic covered</span><textarea name="topic" placeholder="What the session covered">${esc(x.topic || '')}</textarea></label>
      <label class="f"><span>This training satisfies</span><select name="req"><option value="">Nothing in particular</option>${reqs.map(r => `<option value="${esc(r.id)}"${x.satisfies_requirement_id === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <div class="muted sm" style="margin-top:-6px">If you choose one above, marking someone present will also record it as completed for them, dated to this training.</div>
      <label class="f"><span>Notes</span><textarea name="notes">${esc(x.notes || '')}</textarea></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-tr')}</div>`;
}
async function saveTrForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
  if (!fd.get('title').trim() || !fd.get('date')) { toast('Add a title and a date.', 'bad'); return; }
  const data = { title: fd.get('title').trim(), date: fd.get('date'), hours: fd.get('hours') ? Number(fd.get('hours')) : null, instructor: (fd.get('instructor') || '').trim(), topic: (fd.get('topic') || '').trim(), satisfies_requirement_id: fd.get('req') || null, notes: (fd.get('notes') || '').trim() };
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('trainings').update(data).eq('id', id); if (r.error) throw r.error; }
    else { const r = await sb.from('trainings').insert({ ...data, created_by: S.me ? S.me.id : null }); if (r.error) throw r.error; }
    MS.pop(); drawModal(); toast('Training saved', 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
function trDetailSheet(id) {
  const t = S.trainings.find(x => x.id === id);
  if (!t) return sheet('Training', '<div class="empty">This training no longer exists.</div>', '<button class="btn" data-action="m-close">Close</button>');
  const rq = t.satisfies_requirement_id ? S.reqs.find(r => r.id === t.satisfies_requirement_id) : null;
  const attended = new Set(D.attendance[t.id] || []);
  const list = S.members.filter(m => m.status !== 'inactive').sort((a, b) => a.name.localeCompare(b.name));
  const kv = (k, v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  const body = `<div class="card pad"><dl class="kv">${kv('Date', fmt(t.date))}${kv('Hours', t.hours)}${kv('Instructor', t.instructor)}${kv('Topic', t.topic)}${rq ? kv('Satisfies', rq.name) : ''}${kv('Notes', t.notes)}</dl></div>
    <div class="sec"><h3>Attendance</h3><span class="muted sm">${attended.size} of ${list.length} marked present.${rq ? ' Checking someone here records their ' + esc(rq.name) + ' as done today.' : ''}</span></div>
    <div class="card list">${list.map(m => `<label class="li" style="cursor:pointer"><div class="t"><b>${esc(m.name)}</b><span class="muted sm">${esc(m.category || 'No category')}</span></div><input type="checkbox" class="tr-att" data-id="${esc(m.id)}"${attended.has(m.id) ? ' checked disabled' : ''} style="width:22px;height:22px;accent-color:var(--navy)"></label>`).join('')}</div>`;
  const foot = `<button class="btn" data-action="m-close">Close</button>${S.perms.manage_training ? `<button class="btn" data-action="tr-edit" data-id="${esc(id)}">Edit</button><button class="btn primary" data-action="tr-save-att" data-id="${esc(id)}">Save attendance</button>` : ''}`;
  return sheet(esc(t.title), body, foot, fmt(t.date));
}
async function saveAttendance(trainingId) {
  const checked = [...document.querySelectorAll('.tr-att:checked:not(:disabled)')].map(el => el.dataset.id);
  if (!checked.length) { toast('Check at least one new attendee, or close if nobody new attended.', 'bad'); return; }
  const btn = document.querySelector('[data-action=tr-save-att]'); if (btn) btn.disabled = true;
  try {
    const t = S.trainings.find(x => x.id === trainingId);
    const rows = checked.map(member_id => ({ training_id: trainingId, member_id }));
    const r = await sb.from('training_attendance').insert(rows); if (r.error) throw r.error;
    if (t && t.satisfies_requirement_id) {
      const recs = checked.map(member_id => ({ member_id, requirement_id: t.satisfies_requirement_id, done_on: t.date, due_on: null, approx: false, result: 'Pass', notes: 'Training: ' + t.title, recorded_by: S.me ? S.me.id : null }));
      const rr = await sb.from('member_records').insert(recs); if (rr.error) throw rr.error;
    }
    MS.pop(); drawModal(); toast(`Marked ${checked.length} present`, 'ok'); loadAll();
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}

/* ---------- message board ---------- */
const BOARDS = ['General', 'Training', 'Equipment', 'Events & Fundraisers', 'Fire Police'];
const whoName = id => { const m = D.memById[id]; return m ? m.name : 'A former member'; };
const canMod = () => S.perms.post_messages;
function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime(), mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now'; if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60); if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24); if (days < 7) return days + 'd ago';
  return fmt(iso.slice(0, 10));
}
function boardCounts() {
  const out = {};
  for (const b of BOARDS) out[b] = { threads: 0, latest: null };
  for (const t of S.threads) {
    if (t.removed || !out[t.board]) continue;
    out[t.board].threads++;
    const stamp = t.updated_at || t.created_at;
    if (!out[t.board].latest || stamp > out[t.board].latest) out[t.board].latest = stamp;
  }
  return out;
}
function boardHasUnread(board) {
  const last = D.boardRead[board];
  const counts = boardCounts()[board];
  if (!counts || !counts.latest) return false;
  return !last || counts.latest > last;
}
function boardListView() {
  const counts = boardCounts();
  return `<div class="head-row"><h1>Message board</h1></div>
    <div class="eqlist">${BOARDS.map(b => { const c = counts[b]; const unread = boardHasUnread(b);
      return `<button class="card eqcard" data-action="brd-open" data-board="${esc(b)}"><span class="top2"><b>${esc(b)}</b>${unread ? chip('New', 'warn') : ''}</span><span class="muted sm">${c.threads} ${plural(c.threads, 'thread')}</span><span class="sm">${c.latest ? 'Last activity ' + timeAgo(c.latest) : 'Nothing posted yet'}</span></button>`; }).join('')}</div>`;
}
function threadListHtml(board) {
  const list = S.threads.filter(t => t.board === board && !t.removed).sort((a, b) => (b.pinned - a.pinned) || (b.updated_at || '').localeCompare(a.updated_at || ''));
  const lastRead = D.boardRead[board];
  return list.length ? `<div class="card list">${list.map(t => {
    const nRep = (D.repliesByThread[t.id] || []).filter(r => !r.removed).length;
    const isNew = !lastRead || (t.updated_at || t.created_at) > lastRead;
    return `<div class="li"><div class="t"><button class="btn ghost" style="padding:0;min-height:0;justify-content:flex-start;font-weight:600;color:var(--ink);text-align:left" data-action="thr-open" data-id="${esc(t.id)}">${t.pinned ? '📌 ' : ''}${esc(t.title)}</button><span class="muted sm">${esc(whoName(t.by_member))}, ${timeAgo(t.created_at)}${t.locked ? ', locked' : ''}</span></div><div class="acts">${isNew ? chip('New', 'warn') : ''}${chip(nRep + ' ' + plural(nRep, 'reply', 'replies'))}</div></div>`;
  }).join('')}</div>` : '<div class="card empty">Nothing posted here yet.</div>';
}
function boardThreadsView(board) {
  if (!BOARDS.includes(board)) return `<div class="card empty">That board does not exist.</div>`;
  return `<button class="back" data-action="brd-back">← All boards</button>
    <div class="head-row"><h1>${esc(board)}</h1>${S.me ? `<button class="btn primary" data-action="thr-new" data-board="${esc(board)}">New thread</button>` : ''}</div>
    <div id="thr-list">${threadListHtml(board)}</div>`;
}
function messageBoardRoute() {
  if (S.brdThread) return threadDetailView(S.brdThread);
  if (S.brdBoard) return boardThreadsView(S.brdBoard);
  return boardListView();
}
function replyHtml(r) {
  const mine = S.me && r.by_member === S.me.id;
  return `<div class="card pad stack" style="gap:6px">${r.removed ? '<span class="muted sm">Removed by a moderator.</span>' : `
    <div class="spread"><b>${esc(whoName(r.by_member))}</b><span class="muted sm">${timeAgo(r.created_at)}</span></div>
    <div style="white-space:pre-wrap">${esc(r.body)}</div>
    <div class="row">${mine ? `<button class="btn sm" data-action="rep-edit" data-id="${esc(r.id)}">Edit</button>` : ''}${mine || canMod() ? `<button class="btn sm danger" data-action="rep-del" data-id="${esc(r.id)}">Delete</button>` : ''}</div>`}</div>`;
}
function threadDetailView(id) {
  const t = S.threads.find(x => x.id === id);
  if (!t || t.removed) return `<div class="card empty">This thread no longer exists.</div><button class="btn" data-action="brd-back">← All boards</button>`;
  const mine = S.me && t.by_member === S.me.id;
  const replies = (D.repliesByThread[id] || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  return `<button class="back" data-action="thr-back" data-board="${esc(t.board)}">← ${esc(t.board)}</button>
    <div class="rc-chips" style="margin-bottom:10px">${chip(t.board)}${t.pinned ? chip('Pinned', 'ok') : ''}${t.locked ? chip('Locked') : ''}</div>
    <h1 style="margin-bottom:4px">${esc(t.title)}</h1>
    <div class="muted sm" style="margin-bottom:12px">${esc(whoName(t.by_member))}, ${timeAgo(t.created_at)}</div>
    <div class="card pad" style="margin-bottom:14px;white-space:pre-wrap">${esc(t.body)}</div>
    <div class="row" style="margin-bottom:16px">${mine && !t.locked ? `<button class="btn sm" data-action="thr-edit" data-id="${esc(t.id)}">Edit</button>` : ''}${canMod() ? `<button class="btn sm" data-action="thr-pin" data-id="${esc(t.id)}">${t.pinned ? 'Unpin' : 'Pin'}</button><button class="btn sm" data-action="thr-lock" data-id="${esc(t.id)}">${t.locked ? 'Unlock' : 'Lock'}</button>` : ''}${mine || canMod() ? `<button class="btn sm danger" data-action="thr-del" data-id="${esc(t.id)}">Delete</button>` : ''}</div>
    <div class="sec"><h3>${replies.length} ${plural(replies.length, 'reply', 'replies')}</h3></div>
    <div class="stack" style="margin-bottom:16px">${replies.map(replyHtml).join('') || '<div class="card empty">No replies yet.</div>'}</div>
    ${S.me && !t.locked ? `<form id="f-reply" class="form" data-thread="${esc(id)}"><label class="f"><span>Reply</span><textarea name="body" required placeholder="Write a reply…"></textarea></label><button class="btn primary" type="submit">Post reply</button></form>` : t.locked ? '<p class="muted sm">This thread is locked. No new replies.</p>' : ''}`;
}
function threadFormHtml(board, t) {
  return `<div class="sheet-h"><div><h2>${t ? 'Edit thread' : 'New thread'}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-thr" class="form" data-id="${esc((t && t.id) || '')}" data-board="${esc((t && t.board) || board)}">
      <label class="f"><span>Title</span><input name="title" value="${esc((t && t.title) || '')}" required></label>
      <label class="f"><span>Message</span><textarea name="body" required>${esc((t && t.body) || '')}</textarea></label>
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-thr', t ? 'Save' : 'Post')}</div>`;
}
function replyFormHtml(r) {
  return `<div class="sheet-h"><div><h2>Edit reply</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><form id="f-repedit" class="form" data-id="${esc(r.id)}"><label class="f"><span>Reply</span><textarea name="body" required>${esc(r.body)}</textarea></label></form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-repedit', 'Save')}</div>`;
}
async function saveThreadForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null, board = form.dataset.board;
  const title = fd.get('title').trim(), body = fd.get('body').trim();
  if (!title || !body) { toast('Add a title and a message.', 'bad'); return; }
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  try {
    if (id) { const r = await sb.from('board_threads').update({ title, body, updated_at: new Date().toISOString() }).eq('id', id); if (r.error) throw r.error; }
    else { const r = await sb.from('board_threads').insert({ board, title, body, by_member: S.me.id }); if (r.error) throw r.error; }
    MS.pop(); drawModal(); toast(id ? 'Thread saved' : 'Thread posted', 'ok');
    S.brdBoard = board; S.brdThread = null;
    await loadAll(); markBoardRead(board);
  } catch (e) { toast('Could not save: ' + ((e && e.message) || String(e)), 'bad'); if (btn) btn.disabled = false; }
}
async function saveReplyEdit(form) {
  const fd = new FormData(form), id = form.dataset.id, body = fd.get('body').trim();
  if (!body) { toast('Write something first.', 'bad'); return; }
  const r = await sb.from('board_replies').update({ body }).eq('id', id);
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
  MS.pop(); drawModal(); toast('Reply saved', 'ok'); loadAll();
}
async function postReply(form) {
  const fd = new FormData(form), threadId = form.dataset.thread, body = fd.get('body').trim();
  if (!body) { toast('Write something first.', 'bad'); return; }
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  const r = await sb.from('board_replies').insert({ thread_id: threadId, body, by_member: S.me.id });
  if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); if (btn) btn.disabled = false; return; }
  toast('Reply posted', 'ok'); await loadAll();
}
async function markBoardRead(board) {
  if (!S.me) return;
  const now = new Date().toISOString();
  D.boardRead[board] = now;  // update the screen immediately; no need to wait on the network round trip
  const r = await sb.from('board_reads').upsert({ member_id: S.me.id, board, last_read_at: now }, { onConflict: 'member_id,board' });
  if (r.error) console.warn('Could not mark the board read:', r.error.message);
}

/* ---------- rendering ---------- */
function renderTabs() {
  const el = $('#tabs'), who = $('#who');
  if (!session || !S.me) { el.innerHTML = ''; who.innerHTML = session ? `<button class="btn sm" data-action="signout">Sign out</button>` : ''; return; }
  const T = (k, l) => `<button data-action="tab" data-tab="${k}"${S.tab === k ? ' aria-current="page"' : ''}>${l}</button>`;
  const showMem = S.perms.view_roster || S.perms.manage_members;
  const showApp = S.perms.view_apparatus;
  el.innerHTML = T('home', 'Home') + (S.me ? T('events', 'Events') + T('board', 'Board') : '') + (showApp ? T('rigs', 'Apparatus') + T('equipment', 'Equipment') : '') + (showMem ? T('members', 'Members') : '') + (S.perms.post_messages ? T('msgs', 'Messages') : '') + (S.perms.admin_setup ? T('records', 'Records') : '');
  who.innerHTML = `<button class="btn sm" data-action="signout">Sign out</button>`;
}
function render() {
  const v = $('#view');
  if (S.fatal) { v.innerHTML = shell(`<div class="banner">${esc(S.fatal)}</div>`); renderTabs(); return; }
  if (!cfgOk()) { v.innerHTML = setupView(); renderTabs(); return; }
  if (!session) { v.innerHTML = signInView(S.signInError); renderTabs(); return; }
  if (S.loading) { v.innerHTML = shell('<p class="muted">Loading…</p>'); renderTabs(); return; }
  if (S.error) { v.innerHTML = shell(`<div class="banner">Something went wrong loading your data: ${esc(S.error)} <button class="btn sm" data-action="reload">Try again</button></div>`); renderTabs(); return; }
  if (!S.me) { v.innerHTML = unlinkedView(); renderTabs(); return; }
  let tab = S.tab; if (tab === 'members' && !(S.perms.view_roster || S.perms.manage_members)) tab = 'home';
  if ((tab === 'rigs' || tab === 'equipment') && !S.perms.view_apparatus) tab = 'home';
  if (tab === 'records' && !S.perms.admin_setup) tab = 'home';
  if (tab === 'events' && !S.me) tab = 'home';
  if (tab === 'board' && !S.me) tab = 'home';
  if (tab === 'msgs' && !S.perms.post_messages) tab = 'home';
  v.innerHTML = shell(tab === 'members' ? membersView() : tab === 'rigs' ? (S.rigId ? rigDetail(S.rigId) : rigsView()) : tab === 'equipment' ? equipmentView() : tab === 'records' ? recordsView() : tab === 'events' ? eventsView() : tab === 'board' ? messageBoardRoute() : tab === 'msgs' ? msgsView() : homeView());
  renderTabs();
  drawModal();
}
function drawModal() {
  const root = $('#modal-root');
  if (!MS.length) { root.innerHTML = ''; document.body.classList.remove('lock'); return; }
  root.innerHTML = `<div class="ov"><div class="sheet" role="dialog" aria-modal="true">${MS[MS.length - 1]()}</div></div>`;
  document.body.classList.add('lock');
}

/* ---------- data ---------- */
const cfgOk = () => { const c = window.GBFD_CONFIG || {}; return !!(c.SUPABASE_URL && c.SUPABASE_KEY) && !/YOUR-/.test(c.SUPABASE_URL + c.SUPABASE_KEY); };

async function loadAll() {
  S.loading = true; S.error = ''; render();
  try {
    const uid = session.user.id;
    const [m, rq, st, ms, ds] = await Promise.all([
      sb.from('members').select('*').order('name'),
      sb.from('requirements').select('*').order('sort'),  // all rows, including archived; reqRows() filters active ones
      sb.from('settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('messages').select('*').order('created_at', { ascending: false }),  // posters get every message via RLS; others only get what's meant for them
      sb.from('message_dismissals').select('message_id')
    ]);
    for (const r of [m, rq, st, ms, ds]) if (r.error) throw r.error;
    S.members = m.data || []; S.reqs = rq.data || []; S.settings = st.data || { probation_months: 6 };
    S.messages = ms.data || []; S.dismissed = new Set((ds.data || []).map(x => x.message_id));
    S.me = S.members.find(x => x.user_id === uid) || null; S.access = null; S.priv = null; S.perms = {}; S.records = [];
    if (S.me) {
      const [a, p] = await Promise.all([
        sb.from('member_access').select('*').eq('member_id', S.me.id).maybeSingle(),
        sb.from('member_private').select('*').eq('member_id', S.me.id).maybeSingle()
      ]);
      if (a.error) throw a.error; if (p.error) throw p.error;
      S.access = a.data; S.priv = p.data; S.perms = effPerms(a.data);
      const all = S.perms.view_roster || S.perms.manage_training;
      const rec = await (all ? sb.from('member_records').select('*') : sb.from('member_records').select('*').eq('member_id', S.me.id));
      if (rec.error) throw rec.error;
      S.records = rec.data || [];
    }
    if (S.perms.view_apparatus) {
      const [rg, it, eq, df, cs] = await Promise.all([
        sb.from('rigs').select('*').order('sort'),
        sb.from('checklist_items').select('*').order('sort'),
        sb.from('equipment').select('*').order('name'),
        sb.from('deficiencies').select('*').order('found_date', { ascending: false }),
        sb.from('check_sessions').select('*').order('date', { ascending: false })
      ]);
      for (const r of [rg, it, eq, df, cs]) if (r.error) throw r.error;
      S.rigs = rg.data || []; S.items = it.data || []; S.equipment = eq.data || []; S.defs = df.data || []; S.sessions = cs.data || [];
      const cr = await sb.from('check_results').select('*');
      if (cr.error) throw cr.error;
      S.results = cr.data || [];
    } else { S.rigs = []; S.equipment = []; S.items = []; S.defs = []; S.sessions = []; S.results = []; }
    if (S.me) {
      const [ev, sg, ea, th, rp, br] = await Promise.all([
        sb.from('events').select('*').order('date'), sb.from('event_signups').select('*'), sb.from('event_attendance').select('*'),
        sb.from('board_threads').select('*'), sb.from('board_replies').select('*'), sb.from('board_reads').select('*').eq('member_id', S.me.id)
      ]);
      for (const r of [ev, sg, ea, th, rp, br]) if (r.error) throw r.error;
      S.events = ev.data || []; S.signups = sg.data || []; S.eventAttendanceRows = ea.data || [];
      S.threads = th.data || []; S.replies = rp.data || []; S.boardReads = br.data || [];
    } else { S.events = []; S.signups = []; S.eventAttendanceRows = []; S.threads = []; S.replies = []; S.boardReads = []; }
    if (S.perms.view_roster || S.perms.manage_training) {
      const [tr, at] = await Promise.all([sb.from('trainings').select('*').order('date', { ascending: false }), sb.from('training_attendance').select('*')]);
      for (const r of [tr, at]) if (r.error) throw r.error;
      S.trainings = tr.data || []; S.attendanceRows = at.data || [];
    } else { S.trainings = []; S.attendanceRows = []; }
  } catch (e) { S.error = (e && e.message) || String(e); }
  S.loading = false; derive(); render();
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  if (a === 'tab') { S.tab = el.dataset.tab; if (S.tab === 'rigs') S.rigId = null; if (S.tab === 'board') { S.brdBoard = null; S.brdThread = null; } if (S.tab === 'records' && S.audit === null && !S.auditLoading) loadAudit(); render(); window.scrollTo(0, 0); }
  else if (a === 'signout') { await sb.auth.signOut(); }
  else if (a === 'reload') { loadAll(); }
  else if (a === 'mem-open') { const id = el.dataset.id; MS.push(() => memSheet(id)); drawModal(); }
  else if (a === 'mem-new') { openMemberForm(null); }
  else if (a === 'mem-edit') { if (MS.length) MS.pop(); openMemberForm(el.dataset.id); }
  else if (a === 'mem-delete') { deleteMember(el.dataset.id); }
  else if (a === 'invite-members') { openInvitePicker(); }
  else if (a === 'invite-pick-all') { document.querySelectorAll('.invite-pick').forEach(el => el.checked = true); }
  else if (a === 'invite-pick-none') { document.querySelectorAll('.invite-pick').forEach(el => el.checked = false); }
  else if (a === 'invite-pick-send') { sendPickedInvites(); }
  else if (a === 'mtab') { S.mtab = el.dataset.tab; render(); }
  else if (a === 'req-new') { MS.push(() => reqFormHtml(null)); drawModal(); reqFormMount($('#modal-root')); }
  else if (a === 'req-edit') { const r = S.reqs.find(x => x.id === el.dataset.id); if (r) { if (MS.length) MS.pop(); MS.push(() => reqFormHtml(r)); drawModal(); reqFormMount($('#modal-root')); } }
  else if (a === 'req-archive') { toggleReqArchive(el.dataset.id, el.dataset.on === '1'); }
  else if (a === 'rec-new') { const req = S.reqs.find(x => x.id === el.dataset.req); if (req) { MS.push(() => recordFormHtml(el.dataset.member, req)); drawModal(); recordFormMount($('#modal-root'), req); } }
  else if (a === 'msg-new') { MS.push(() => msgFormHtml(null)); drawModal(); msgFormMount($('#modal-root')); }
  else if (a === 'msg-edit') { const m = S.messages.find(x => x.id === el.dataset.id); if (m) { MS.push(() => msgFormHtml(m)); drawModal(); msgFormMount($('#modal-root')); } }
  else if (a === 'msg-end') { endMsgNow(el.dataset.id); }
  else if (a === 'msg-remove') { removeMsg(el.dataset.id); }
  else if (a === 'od-copyall') { copyText(odAllText()); }
  else if (a === 'push-on') { enablePush(); }
  else if (a === 'push-off') { disablePush(); }
  else if (RIGACTIONS[a]) { RIGACTIONS[a](el); }
  else if (a === 'install-app') { if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt = null; } }
  else if (a === 'copy') { copyText(el.dataset.v || ''); }
  else if (a === 'm-close') { MS.pop(); drawModal(); }
  else if (a === 'dismiss') {
    const id = el.dataset.id; S.dismissed.add(id); render();
    const r = await sb.from('message_dismissals').insert({ user_id: session.user.id, message_id: id });
    if (r.error) toast('Could not save that: ' + r.error.message, 'bad');
  }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset && t.dataset.od) { S.od[t.dataset.od] = t.checked; const l = $('#od-list'); if (l) l.innerHTML = odList(); return; }
  if (['eq-where', 'eq-cat', 'eq-ret'].includes(t.id)) { S.eq.where = $('#eq-where').value; S.eq.cat = $('#eq-cat').value; S.eq.ret = $('#eq-ret').checked; const l = $('#eq-list'); if (l) l.innerHTML = eqList(); return; }
  if (t.id === 'ev-past') { S.ev.past = t.checked; const l = $('#ev-list'); if (l) l.innerHTML = eventsList(); return; }
  if (t.dataset && t.dataset.unk) return;  // handled by unkMount's own listener
  if (t.dataset && t.dataset.ckChk && CK) { CK[t.dataset.ckChk] = t.checked; drawModal(); return; }
  if (t.dataset && t.dataset.change === 'it-excl') {
    const rig = D.rigById[t.dataset.rig]; if (!rig) return;
    const ex = new Set(rig.excluded || []); if (t.checked) ex.delete(t.dataset.id); else ex.add(t.dataset.id);
    const r = await sb.from('rigs').update({ excluded: [...ex] }).eq('id', rig.id);
    if (r.error) { toast('Could not save: ' + r.error.message, 'bad'); return; }
    loadAll();
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'mem-q') { S.q = t.value; const l = $('#mem-list'); if (l) l.innerHTML = memList(); return; }
  if (t.id === 'eq-q') { S.eq.q = t.value; const l = $('#eq-list'); if (l) l.innerHTML = eqList(); return; }
  if (t.dataset && t.dataset.ck && CK) { CK[t.dataset.ck] = t.value; return; }
  if (t.dataset && t.dataset.ckNote !== undefined && CK) { const x = CK.res[t.dataset.ckNote]; if (x) x.c = t.value; return; }
});
document.addEventListener('submit', async e => {
  if (e.target.id === 'f-mem') { e.preventDefault(); saveMemberForm(e.target); return; }
  if (e.target.id === 'f-req') { e.preventDefault(); saveReqForm(e.target); return; }
  if (e.target.id === 'f-ev') { e.preventDefault(); saveEvForm(e.target); return; }
  if (e.target.id === 'f-evadd') { e.preventDefault(); saveEvAdd(e.target); return; }
  if (e.target.id === 'f-tr') { e.preventDefault(); saveTrForm(e.target); return; }
  if (e.target.id === 'f-thr') { e.preventDefault(); saveThreadForm(e.target); return; }
  if (e.target.id === 'f-repedit') { e.preventDefault(); saveReplyEdit(e.target); return; }
  if (e.target.id === 'f-reply') { e.preventDefault(); postReply(e.target); return; }
  if (e.target.id === 'f-rec') { e.preventDefault(); saveRecordForm(e.target); return; }
  if (e.target.id === 'f-msg') { e.preventDefault(); saveMsgForm(e.target); return; }
  if (e.target.id === 'f-rig') { e.preventDefault(); saveRigForm(e.target); return; }
  if (e.target.id === 'f-eq') { e.preventDefault(); saveEqForm(e.target); return; }
  if (e.target.id === 'f-item') { e.preventDefault(); saveItemForm(e.target); return; }
  if (e.target.id === 'f-def') { e.preventDefault(); saveDefForm(e.target); return; }
  if (e.target.id === 'f-oos') { e.preventDefault(); saveOOS(e.target); return; }
  if (e.target.id === 'f-ret') { e.preventDefault(); saveRetire(e.target); return; }
  if (e.target.id !== 'f-signin') return;
  e.preventDefault();
  const fd = new FormData(e.target), btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: String(fd.get('password')) });
  if (error) { S.signInError = 'That email and password did not work. Check them and try again.'; btn.disabled = false; render(); }
  else S.signInError = '';
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && MS.length) { MS.pop(); drawModal(); } });

/* ---------- start ---------- */
async function boot() {
  if (!cfgOk()) { render(); return; }
  if (!window.supabase || !window.supabase.createClient) { S.fatal = 'The database library could not be loaded. Check your internet connection and reload.'; render(); return; }
  sb = window.supabase.createClient(window.GBFD_CONFIG.SUPABASE_URL, window.GBFD_CONFIG.SUPABASE_KEY);
  sb.auth.onAuthStateChange((event, s) => {
    // Do the real work later, outside the callback, as the library advises.
    setTimeout(() => {
      if (event === 'SIGNED_OUT') { session = null; resetState(); render(); }
      else if (event === 'SIGNED_IN' && s && (!session || session.user.id !== s.user.id || !S.me)) { session = s; loadAll(); }
      else if (s) session = s;
    }, 0);
  });
  const { data } = await sb.auth.getSession();
  session = data && data.session ? data.session : null;
  if (session) { registerSW(); loadAll().then(refreshPushState).then(render); } else { S.loading = false; render(); }
}
boot();
})();
