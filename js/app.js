(function () {
'use strict';

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
  members: [], reqs: [], records: [], messages: [], dismissed: new Set(), tab: 'home', mtab: 'roster', q: '', od: { none: true, soon: true }
};
let D = { latest: {}, memById: {} };
const MS = [];

function resetState() {
  S.me = null; S.access = null; S.priv = null; S.perms = {}; S.members = []; S.reqs = []; S.records = []; S.messages = []; S.dismissed = new Set(); S.tab = 'home'; S.mtab = 'roster'; S.q = ''; S.od = { none: true, soon: true }; S.error = ''; S.loading = false;
  D = { latest: {}, memById: {} }; MS.length = 0;
}

function derive() {
  D.memById = Object.fromEntries(S.members.map(m => [m.id, m]));
  D.latest = {};
  for (const r of S.records) {
    const c = (D.latest[r.member_id] = D.latest[r.member_id] || {}), cur = c[r.requirement_id];
    if (!cur || (r.done_on || '') > (cur.done_on || '') || ((r.done_on || '') === (cur.done_on || '') && (r.created_at || '') > (cur.created_at || ''))) c[r.requirement_id] = r;
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
    <div class="head-row"><div><h1>Hello, ${esc(first(m.name))}</h1>
      <div class="rc-chips" style="margin-top:6px">${chip(m.category || 'No category set')}${rankOf(m) ? chip(rankOf(m)) : ''}${probChip(m)}${S.access ? chip(roleLabel()) : ''}</div>${dep}
      ${p.nys_id ? `<div class="sm muted" style="margin-top:6px">NYS training ID: <b style="color:var(--ink)">${esc(p.nys_id)}</b></div>` : ''}</div></div>
    <div class="sec" style="margin-top:0"><h3>My requirements</h3></div>
    <div class="card list">${rows.length ? rows.map(x => reqLine(x, m.id)).join('') : `<div class="empty">${m.category ? 'Nothing is required for ' + esc(m.category) + ' members yet.' : 'No category is set on your record yet.'}</div>`}</div>
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
  if (S.perms.manage_members) tabs.push(['reqs', 'Requirements']);
  if (S.perms.post_messages) tabs.push(['msgs', 'Messages']);
  if (!tabs.some(t => t[0] === S.mtab)) S.mtab = 'roster';
  const body = S.mtab === 'reqs' ? reqsView() : S.mtab === 'overdue' ? overdueView() : S.mtab === 'msgs' ? msgsView() : rosterView();
  return `<div class="head-row"><h1>Members</h1>${S.mtab === 'roster' && S.perms.manage_members ? '<button class="btn primary" data-action="mem-new">Add member</button>' : S.mtab === 'msgs' && S.perms.post_messages ? '<button class="btn primary" data-action="msg-new">Post a message</button>' : ''}</div>
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
    <div class="sheet-f"><button class="btn" data-action="m-close">Close</button>${S.perms.manage_members ? `<button class="btn primary" data-action="mem-edit" data-id="${esc(id)}">Edit</button>` : ''}</div>`;
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
  return `<div class="stack">${gs.map(g => `<div class="card"><div class="grp spread"><span>${esc(g.m.name)} <span class="muted sm">${esc(g.m.category || 'No category')}</span></span><button class="btn sm" data-action="copy" data-v="${esc(odReminder(g))}">Copy reminder</button></div><div class="list">${g.rows.map(x => `<div class="li"><div class="t"><b>${esc(x.req.name)}</b><span class="muted sm">${x.rec ? (x.rec.done_on ? (x.rec.approx ? 'Done in ' + esc(x.rec.done_on.slice(0, 4)) : 'Last done ' + esc(fmt(x.rec.done_on))) : 'On record, no date') : 'Nothing recorded'}</span></div><div class="acts">${reqChip(x)}</div></div>`).join('')}</div></div>`).join('')}</div>`;
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
    </form></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Cancel</button>${saveBtn('f-msg', m ? 'Save' : 'Post message')}</div>`;
}
function msgFormMount(root) {
  const all = root.querySelector('[data-aud=all]'); if (!all) return;
  const cats = [...root.querySelectorAll('[data-aud=cat]')];
  all.addEventListener('change', () => { cats.forEach(c => { c.disabled = all.checked; if (all.checked) c.checked = false; }); });
}
async function saveMsgForm(form) {
  const fd = new FormData(form), id = form.dataset.id || null;
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
  return `<div class="head-row"><div><h3>Messages</h3><span class="muted sm">Shown as a ribbon at the top of the home page.</span></div></div>
    <div class="stack">${list.length ? list.map(m => {
      const st = m.starts_on && m.starts_on > t ? 'Scheduled' : (m.ends_on && m.ends_on < t) ? 'Ended' : 'Showing';
      return `<div class="card pad stack" style="gap:8px"><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-weight:600">${esc(m.body)}</div>
        <div class="rc-chips">${chip(st, st === 'Showing' ? 'ok' : '')}${chip((TONES.find(x => x[0] === m.tone) || TONES[0])[1])}${chip(msgAud(m))}</div>
        <div class="muted sm">Shows ${esc(fmt(m.starts_on))}${m.ends_on ? ' until ' + esc(fmt(m.ends_on)) : ', until you end it'}.</div>
        <div class="row"><button class="btn sm" data-action="msg-edit" data-id="${esc(m.id)}">Edit</button>${st !== 'Ended' ? `<button class="btn sm" data-action="msg-end" data-id="${esc(m.id)}">End now</button>` : ''}<button class="btn sm danger" data-action="msg-remove" data-id="${esc(m.id)}">Remove</button></div></div>`;
    }).join('') : '<div class="card empty">No messages yet. Post one and it appears at the top of everyone\u2019s home page.</div>'}</div>`;
}

/* ---------- rendering ---------- */
function renderTabs() {
  const el = $('#tabs'), who = $('#who');
  if (!session || !S.me) { el.innerHTML = ''; who.innerHTML = session ? `<button class="btn sm" data-action="signout">Sign out</button>` : ''; return; }
  const T = (k, l) => `<button data-action="tab" data-tab="${k}"${S.tab === k ? ' aria-current="page"' : ''}>${l}</button>`;
  const showMem = S.perms.view_roster || S.perms.manage_members;
  el.innerHTML = T('home', 'Home') + (showMem ? T('members', 'Members') : '');
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
  v.innerHTML = shell(tab === 'members' ? membersView() : homeView());
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
  } catch (e) { S.error = (e && e.message) || String(e); }
  S.loading = false; derive(); render();
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  if (a === 'tab') { S.tab = el.dataset.tab; render(); window.scrollTo(0, 0); }
  else if (a === 'signout') { await sb.auth.signOut(); }
  else if (a === 'reload') { loadAll(); }
  else if (a === 'mem-open') { const id = el.dataset.id; MS.push(() => memSheet(id)); drawModal(); }
  else if (a === 'mem-new') { openMemberForm(null); }
  else if (a === 'mem-edit') { if (MS.length) MS.pop(); openMemberForm(el.dataset.id); }
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
  else if (a === 'copy') { copyText(el.dataset.v || ''); }
  else if (a === 'm-close') { MS.pop(); drawModal(); }
  else if (a === 'dismiss') {
    const id = el.dataset.id; S.dismissed.add(id); render();
    const r = await sb.from('message_dismissals').insert({ user_id: session.user.id, message_id: id });
    if (r.error) toast('Could not save that: ' + r.error.message, 'bad');
  }
});
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.od) { S.od[e.target.dataset.od] = e.target.checked; const l = $('#od-list'); if (l) l.innerHTML = odList(); const rr = $('#view'); if (rr) { const chips = rr.querySelector('.rc-chips'); } } });
document.addEventListener('input', e => {
  if (e.target.id === 'mem-q') { S.q = e.target.value; const l = $('#mem-list'); if (l) l.innerHTML = memList(); }
});
document.addEventListener('submit', async e => {
  if (e.target.id === 'f-mem') { e.preventDefault(); saveMemberForm(e.target); return; }
  if (e.target.id === 'f-req') { e.preventDefault(); saveReqForm(e.target); return; }
  if (e.target.id === 'f-rec') { e.preventDefault(); saveRecordForm(e.target); return; }
  if (e.target.id === 'f-msg') { e.preventDefault(); saveMsgForm(e.target); return; }
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
  if (session) loadAll(); else { S.loading = false; render(); }
}
boot();
})();
