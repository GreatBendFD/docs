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

function toast(msg, kind) {
  const t = $('#toast'), d = document.createElement('div');
  d.textContent = msg; if (kind) d.className = kind; t.appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6000 : 3200);
}

/* ---------- permissions (the database enforces these; this only decides what to show) ---------- */
const CATS = ['Interior', 'Exterior', 'Fire police', 'Administrative'];
const PERM_KEYS = ['view_apparatus', 'run_checks', 'edit_equipment', 'log_inspections', 'view_roster', 'manage_training', 'post_messages', 'manage_members', 'manage_events', 'log_incidents', 'admin_setup'];
const PRESET = {
  admin: PERM_KEYS.slice(),
  officer: ['view_apparatus', 'run_checks', 'edit_equipment', 'log_inspections', 'view_roster', 'manage_training', 'post_messages', 'log_incidents', 'manage_events'],
  member: ['view_apparatus']
};
function effPerms(access) {
  const role = (access && access.role) || 'member';
  const base = Object.fromEntries(PERM_KEYS.map(k => [k, (PRESET[role] || PRESET.member).includes(k)]));
  return Object.assign(base, (access && access.perms) || {});
}

/* ---------- requirements and probation (same rules as the prototype) ---------- */
const REQ_FREQS = { annual: 'Every year', semiannual: 'Every 6 months', quarterly: 'Every 3 months', '2y': 'Every 2 years', '3y': 'Every 3 years', '5y': 'Every 5 years', once: 'One time only' };
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
  members: [], reqs: [], records: [], messages: [], dismissed: new Set(), tab: 'home', q: ''
};
let D = { latest: {}, memById: {} };
const MS = [];

function resetState() {
  S.me = null; S.access = null; S.priv = null; S.perms = {}; S.members = []; S.reqs = []; S.records = []; S.messages = []; S.dismissed = new Set(); S.tab = 'home'; S.q = ''; S.error = ''; S.loading = false;
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
  const reqs = S.reqs.filter(r => (m.category && (r.categories || []).includes(m.category)) || lat[r.id]).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name));
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
function reqLine(x) {
  const r = x.rec;
  const when = !r ? 'Nothing recorded yet.' : !r.done_on ? 'On record, date not recorded.' : r.approx ? `Done in ${esc(r.done_on.slice(0, 4))}, exact date not recorded.` : `Last done ${esc(fmt(r.done_on))}${r.result ? ', ' + esc(r.result) : ''}.`;
  return `<div class="li"><div class="t"><b>${esc(x.req.name)}</b><span class="muted sm">${when}${r && r.notes && r.notes.length <= 40 && !r.approx ? ' ' + esc(r.notes) + '.' : ''} ${esc(reqFreqLabel(x.req))}.</span></div><div class="acts">${reqChip(x)}</div></div>`;
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
    <div class="card list">${rows.length ? rows.map(reqLine).join('') : `<div class="empty">${m.category ? 'Nothing is required for ' + esc(m.category) + ' members yet.' : 'No category is set on your record yet.'}</div>`}</div>
    <p class="muted sm" style="margin-top:18px">Signed in as ${esc(session.user.email)}. Role: ${esc(roleLabel())}.</p>`;
}
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
function membersView() {
  const active = S.members.filter(m => m.status !== 'inactive');
  return `<div class="head-row"><h1>Members</h1></div>
    <div class="rc-chips" style="margin-bottom:12px">${chip(active.length + ' active')}${CATS.map(c => chip(c + ' ' + active.filter(m => m.category === c).length)).join('')}</div>
    <div class="filters" style="grid-template-columns:1fr"><label class="f"><span>Search</span><input id="mem-q" type="search" value="${esc(S.q)}" placeholder="Name or rank"></label></div>
    <div id="mem-list">${memList()}</div>`;
}
function memSheet(id) {
  const m = D.memById[id]; if (!m) return '';
  const canSee = S.perms.view_roster || S.perms.manage_training || m.id === S.me.id;
  const rows = canSee ? reqRows(m) : [];
  return `<div class="sheet-h"><div><h2>${esc(m.name)}</h2></div><button class="x" data-action="m-close" aria-label="Close">×</button></div>
    <div class="sheet-b"><div class="rc-chips" style="margin-bottom:12px">${chip(m.category || 'No category')}${rankOf(m) ? chip(rankOf(m)) : ''}${probChip(m)}</div>
      ${m.joined || probInfo(m) ? `<div class="sm muted" style="margin:-4px 0 12px">${m.joined ? 'Joined ' + esc(fmt(m.joined)) + (tenure(m.joined) ? ' (' + esc(tenure(m.joined)) + '). ' : '. ') : ''}${esc(probLine(m))}</div>` : ''}
      <div class="sec" style="margin-top:0"><h3>Requirements</h3></div>
      <div class="card list">${rows.length ? rows.map(reqLine).join('') : `<div class="empty">${canSee ? 'Nothing is required yet.' : 'You can see the directory but not training records.'}</div>`}</div></div>
    <div class="sheet-f"><button class="btn" data-action="m-close">Close</button></div>`;
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
      sb.from('requirements').select('*').order('sort'),
      sb.from('settings').select('*').eq('id', 1).maybeSingle(),
      sb.from('messages').select('*').eq('removed', false).order('created_at', { ascending: false }),
      sb.from('message_dismissals').select('message_id')
    ]);
    for (const r of [m, rq, st, ms, ds]) if (r.error) throw r.error;
    S.members = m.data || []; S.reqs = (rq.data || []).filter(r => r.active); S.settings = st.data || { probation_months: 6 };
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
  else if (a === 'm-close') { MS.pop(); drawModal(); }
  else if (a === 'dismiss') {
    const id = el.dataset.id; S.dismissed.add(id); render();
    const r = await sb.from('message_dismissals').insert({ user_id: session.user.id, message_id: id });
    if (r.error) toast('Could not save that: ' + r.error.message, 'bad');
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'mem-q') { S.q = e.target.value; const l = $('#mem-list'); if (l) l.innerHTML = memList(); }
});
document.addEventListener('submit', async e => {
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
