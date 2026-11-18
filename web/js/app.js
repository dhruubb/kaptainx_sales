import { icon } from './icons.js';
import { createApi, TABLES } from './api.js';
import { FIELDS, readFile, autoMap, buildRows, MAX_FILE_MB, guessCountryCode } from './import.js';
import { esc, safeUrl, hostOf, safeColor, telHref, waHref, validEmail, USERNAME_RE } from './util.js';

/* ════════════════════════ constants ════════════════════════ */
const PIPE = [
  { k: 'new', n: 'New' }, { k: 'called', n: 'Called' }, { k: 'interested', n: 'Interested' },
  { k: 'meeting', n: 'Meeting' }, { k: 'proposal', n: 'Proposal' }, { k: 'client', n: 'Client' }, { k: 'lost', n: 'Lost' },
];
const PIPE_N = Object.fromEntries(PIPE.map((p) => [p.k, p.n]));
const pipeColor = (k) => `var(--p-${PIPE_N[k] ? k : 'new'})`;
const OUT = {
  no_answer: { n: 'No answer', icon: 'phoneOff', c: '#8e8e93' },
  callback: { n: 'Callback', icon: 'undo', c: 'var(--warn)' },
  not_interested: { n: 'Not interested', icon: 'x', c: 'var(--bad)' },
  interested: { n: 'Interested', icon: 'thumb', c: 'var(--good)' },
};
const PITCH_DEFAULTS = ['Donna', 'Mercer', 'WhatsApp automation', 'Custom automation'];
const PW_MIN = 10;

/* ════════════════════════ tiny utils ════════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
const nowISO = () => new Date().toISOString();
const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd();
const dayOf = (iso) => (iso ? ymd(new Date(iso)) : '');
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };
const coarse = matchMedia('(pointer: coarse)').matches;
const withTimeout = (p, ms, msg = 'Timed out') => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function rel(iso) {
  if (!iso) return '';
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 50) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400 && dayOf(iso) === today()) return `${Math.round(s / 3600)}h`;
  if (dayOf(iso) === ymd(daysAgo(1))) return 'Yesterday';
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDate = (s) => (s ? new Date(s + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const initials = (s) => (String(s || '?').trim().split(/\s+/).filter((w) => /\w/.test(w)).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
const TZMAP = [[/eastern|\bE[SD]?T\b/i, 'America/New_York'], [/central|\bC[SD]?T\b/i, 'America/Chicago'], [/mountain|\bM[SD]?T\b/i, 'America/Denver'], [/pacific|\bP[SD]?T\b/i, 'America/Los_Angeles'], [/alaska/i, 'America/Anchorage'], [/hawaii/i, 'Pacific/Honolulu'], [/india|\bIST\b/i, 'Asia/Kolkata'], [/\b(uk|london|gmt|bst)\b/i, 'Europe/London'], [/dubai|\bgst\b|uae/i, 'Asia/Dubai'], [/sydney|aest/i, 'Australia/Sydney']];
function theirTime(tz) {
  if (!tz) return null;
  let zone = TZMAP.find(([re]) => re.test(tz))?.[1];
  if (!zone) { try { new Intl.DateTimeFormat('en', { timeZone: tz.trim() }); zone = tz.trim(); } catch { return null; } }
  const now = new Date();
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: zone }).format(now));
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: zone }).format(now);
  return { t: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone }), open: h >= 8 && h < 18 && !['Sat', 'Sun'].includes(day), day };
}
const scoreBadge = (n) => (n == null || n === '' ? '' : `<span class="score ${n >= 75 ? 'hi' : n >= 50 ? 'mid' : 'lo'}" title="Lead score ${Number(n)}/100">${Number(n)}</span>`);
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

/* ════════════════════════ store ════════════════════════ */
const S = {
  api: null, me: null, loginPw: null,
  t: Object.fromEntries(TABLES.map((t) => [t, new Map()])),
  ui: {
    leadsView: localStorage.getItem('kx-leads-view') === 'list' ? 'list' : 'pipeline',
    q: '', domain: 'all', stage: 'all', sort: 'recent', limit: 100,
    scope: 'me', range: '7', actFilter: 'all', skipped: new Set(), imp: null, confirm: null, live: true,
  },
  sheet: null, route: '',
};
const R = (t) => [...S.t[t].values()];
const put = (t, r) => { if (r?.id == null) return; S.t[t].set(r.id, { ...(S.t[t].get(r.id) || {}), ...r }); };
const drop = (t, k) => S.t[t].delete(k);
const get = (t, k) => S.t[t].get(k);
const meP = () => get('profiles', S.me.id) || S.me;
const isFounder = () => meP()?.role === 'founder';
const prof = (id) => get('profiles', id);
const team = () => R('profiles').filter((p) => p.active && p.role).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
const nameOf = (id) => (id && id === S.me?.id ? 'You' : prof(id)?.name || 'Someone');
const avatar = (id, cls = '') => { const p = prof(id); return `<span class="avatar ${cls}" style="background:${safeColor(p?.color)}" title="${esc(nameOf(id))}">${esc(initials(p?.name || '?'))}</span>`; };
const dKey = (d) => String(d || '').trim().toLowerCase();
function domainList(rows = R('prospects')) {
  const m = new Map();
  for (const p of rows) { const k = dKey(p.domain); if (!k) continue; const e = m.get(k) || { k, n: p.domain.trim(), c: 0 }; e.c++; m.set(k, e); }
  return [...m.values()].sort((a, b) => b.c - a.c || a.n.localeCompare(b.n));
}
function filtered({ stage = true } = {}) {
  const q = S.ui.q.trim().toLowerCase();
  return R('prospects').filter((p) =>
    (S.ui.domain === 'all' || (S.ui.domain === '-' ? !dKey(p.domain) : dKey(p.domain) === S.ui.domain)) &&
    (!stage || S.ui.stage === 'all' || p.stage === S.ui.stage) &&
    (!q || `${p.name} ${p.company} ${p.phone} ${p.city} ${p.domain} ${p.pitch} ${p.problem} ${p.opener} ${p.email} ${p.website}`.toLowerCase().includes(q)));
}

/* ════════════════════════ mutations (optimistic, rolled back on failure) ════════════════════════ */
async function ins(t, rows) {
  rows = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, id: r.id || uuid() }));
  const stamp = nowISO(), me = S.me.id;
  rows.forEach((r) => put(t, { created_at: stamp, updated_at: stamp, created_by: me, updated_by: me, ...(t === 'calls' ? { caller: me } : {}), ...r }));
  render();
  try {
    const out = [];
    for (let i = 0; i < rows.length; i += 300) out.push(...(await S.api.insert(t, rows.slice(i, i + 300))));
    out.forEach((r) => put(t, r)); render();
    return out;
  } catch (e) { rows.forEach((r) => drop(t, r.id)); render(); fail(e); throw e; }
}
async function upd(t, id, patch) {
  const old = get(t, id); if (!old) return;
  put(t, { ...old, ...patch, ...(t === 'prospects' ? { updated_at: nowISO(), updated_by: S.me.id } : {}) }); render();
  try { const r = await S.api.update(t, id, patch); if (r) put(t, r); render(); return true; }
  catch (e) { S.t[t].set(id, old); render(); fail(e); return false; }
}
async function rm(t, id) {
  const old = get(t, id); if (!old) return;
  drop(t, id);
  const kids = t === 'prospects' ? R('calls').filter((c) => c.prospect_id === id) : [];
  kids.forEach((c) => drop('calls', c.id));
  render();
  try { await S.api.remove(t, id); }
  catch (e) { S.t[t].set(id, old); kids.forEach((c) => put('calls', c)); render(); fail(e); }
}
function fail(e) {
  console.error(e);
  const m = String(e?.message || '');
  toast(/row-level|permission|not allowed|only founders/i.test(m) ? 'You don’t have permission for that'
    : /check constraint/i.test(m) ? 'That value isn’t allowed'
    : /fetch|network|timed out/i.test(m) ? 'No connection. Change not saved' : 'Couldn’t save. Please try again', { icon: 'x', bad: true });
}

/* ════════════════════════ realtime ════════════════════════ */
function onRemote(t, type, n, o) {
  if (!S.t[t]) return;
  if (type === 'DELETE') { if (o?.id != null) drop(t, o.id); }
  else if (n?.id != null) put(t, n);
  if (t === 'profiles' && n?.id === S.me.id && (!n.active || n.role !== S.me.role)) { location.reload(); return; }
  render();
}
async function refresh() {
  try {
    const data = await withTimeout(S.api.loadAll(), 20000);
    for (const [t, rows] of Object.entries(data)) { S.t[t].clear(); rows.forEach((r) => put(t, r)); }
    render();
  } catch (e) { console.warn('refresh failed', e); }
}

/* ════════════════════════ rendering core ════════════════════════ */
let raf = 0, deferred = false;
const render = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); };
function editingIn(root) {
  const a = document.activeElement;
  if (!a || !root?.contains(a)) return null;
  if (a.isContentEditable || ((a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && !a.dataset.fk)) return 'busy';
  if (a.dataset.fk) return { fk: a.dataset.fk, v: a.value, s: a.selectionStart, e: a.selectionEnd };
  return null;
}
function swap(root, html) {
  const st = editingIn(root);
  if (st === 'busy') { deferred = true; return false; }
  const scrollers = [...root.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollLeft, el.scrollTop]);
  const typed = [...root.querySelectorAll('input[data-fk], textarea[data-fk]')].map((el) => [el.dataset.fk, el.value, el.type]);
  root.innerHTML = html;
  typed.forEach(([k, v, type]) => { const el = root.querySelector(`[data-fk="${CSS.escape(k)}"]`); if (el && v) { el.value = v; if (type === 'text' && el.type === 'password') el.type = 'text'; } });
  scrollers.forEach(([k, l, t]) => { const el = root.querySelector(`[data-keep-scroll="${k}"]`); if (el) { el.scrollLeft = l; el.scrollTop = t; } });
  if (st?.fk) {
    const el = root.querySelector(`[data-fk="${CSS.escape(st.fk)}"]`);
    if (el) { el.value = st.v; el.focus({ preventScroll: true }); try { el.setSelectionRange(st.s, st.e); } catch {} }
  }
  return true;
}
const ROUTES = ['home', 'leads', 'call', 'activity', 'account'];
const routeName = () => { const r = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home'; return ROUTES.includes(r) ? r : 'home'; };

function paint() {
  if (!S.me || !$('#view')) return;
  if (drag?.started) return;
  const r = routeName();
  const changed = r !== S.route;
  S.route = r;
  paintNav(r);
  const html = { home: vHome, leads: vLeads, call: vCall, activity: vActivity, account: vAccount }[r]();
  const wide = r === 'leads' || r === 'home' ? ' wide' : '';
  if (changed) { $('#view').innerHTML = `<div class="view${wide}">${html}</div>`; window.scrollTo(0, 0); }
  else swap($('#view'), `<div class="view${wide}" style="animation:none">${html}</div>`);
  paintSheet();
}
function paintNav(r) {
  const tabs = [['home', 'home', 'Home'], ['leads', 'board', 'Leads'], ['call', 'phone', 'Call'], ['activity', 'clock', 'Activity'], ['account', 'person', 'Account']];
  $('#tabbar').innerHTML = tabs.map(([k, i, n]) => k === 'call'
    ? `<a class="tab fab ${r === k ? 'on' : ''}" href="#/call" aria-label="Start calling"><span class="b">${icon('phone')}</span></a>`
    : `<a class="tab ${r === k ? 'on' : ''}" href="#/${k}">${icon(i)}<span>${n}</span></a>`).join('');
  const side = [['home', 'home', 'Dashboard'], ['leads', 'board', 'Leads'], ['call', 'phone', 'Calling'], ['activity', 'clock', 'Activity'], ['account', isFounder() ? 'people' : 'person', isFounder() ? 'Account & team' : 'Account']];
  $('#side').innerHTML = `<div class="brand"><span class="logo">K</span><div><div>KaptainX</div><div class="faint" style="font-size:12px;font-weight:500">Sales HQ</div></div></div>
    ${side.map(([k, i, n]) => `<a class="nav ${r === k ? 'on' : ''}" href="#/${k}">${icon(i)}${n}</a>`).join('')}
    <div class="spacer"></div>
    ${S.ui.live ? '' : `<div class="faint row" style="font-size:12px;padding:0 12px 8px;gap:6px">${icon('dot', 'xs')}Reconnecting…</div>`}
    <a class="nav" href="#/account">${avatar(S.me.id, 'md')}<span class="grow ell">${esc(meP().name || '')}</span></a>`;
}
const meBtn = () => `<a class="iconbtn plain mobile-only" href="#/account" aria-label="Account">${avatar(S.me.id, 'md')}</a>`;
function ring(p, size = 44, stroke = 4.5, label = null, color = null) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, p));
  const col = color || (v >= 99.5 ? 'var(--good)' : 'var(--accent)');
  return `<div class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--fill)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${col}" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v / 100)}"/></svg>
    <span class="lbl num">${label ?? Math.round(v)}</span></div>`;
}
const bar = (p, color = 'var(--accent)') => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p))}%;background:${color}"></i></div>`;
const stagePill = (k) => `<span class="stagepill"><span class="stagedot" style="background:${pipeColor(k)}"></span>${esc(PIPE_N[k] || k)}</span>`;
const domainChip = (d) => (d ? `<span class="dchip">${icon('tag', 'xs')}${esc(d)}</span>` : '');
const pitchChip = (p) => (p ? `<span class="pchip">${icon('target', 'xs')}${esc(p)}</span>` : '');
const webLink = (w, cls = '') => { const u = safeUrl(w); return u ? `<a class="weblink ${cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(u)}">${icon('globe', 'xs')}<span class="ell">${esc(hostOf(u))}</span></a>` : ''; };

/* ════════════════════════ analytics helpers ════════════════════════ */
const callsFor = (scope) => R('calls').filter((c) => scope === 'team' || c.caller === S.me.id);
const goalFor = (scope) => (scope === 'team' ? team().reduce((s, p) => s + (p.daily_goal || 0), 0) : meP().daily_goal || 40);
function perDay(calls, days) {
  const m = new Map(); for (const c of calls) { const k = dayOf(c.created_at); m.set(k, (m.get(k) || 0) + 1); }
  return [...Array(days)].map((_, i) => { const d = daysAgo(days - 1 - i); const k = ymd(d); return { k, d, n: m.get(k) || 0 }; });
}
function streak(calls, goal) {
  const m = new Map(); for (const c of calls) { const k = dayOf(c.created_at); m.set(k, (m.get(k) || 0) + 1); }
  let s = 0;
  for (let i = 1; i < 400; i++) { const k = ymd(daysAgo(i)); const d = daysAgo(i).getDay(); if ((m.get(k) || 0) >= goal) s++; else if (d === 0 && !(m.get(k))) continue; else break; }
  if ((m.get(today()) || 0) >= goal) s++;
  return s;
}
const sinceFor = (range) => (range === '1' ? daysAgo(0).getTime() : range === 'all' ? 0 : daysAgo(Number(range) - 1).getTime());

/* ──────────────── Dashboard ──────────────── */
function vHome() {
  const scope = S.ui.scope, me = meP();
  const calls = callsFor(scope), goal = goalFor(scope);
  const todayN = calls.filter((c) => dayOf(c.created_at) === today()).length;
  const left = Math.max(0, goal - todayN);
  const wk = calls.filter((c) => new Date(c.created_at) >= daysAgo(6)).length;
  const prevWk = calls.filter((c) => { const d = new Date(c.created_at); return d >= daysAgo(13) && d < daysAgo(6); }).length;
  const delta = prevWk ? Math.round(((wk - prevWk) / prevWk) * 100) : null;
  const st = streak(calls, goal);
  const since = sinceFor(S.ui.range);
  const rc = calls.filter((c) => new Date(c.created_at).getTime() >= since);
  const picked = rc.filter((c) => c.outcome !== 'no_answer').length, interested = rc.filter((c) => c.outcome === 'interested').length;
  const due = R('prospects').filter((p) => p.next_followup && p.next_followup <= today() && !['client', 'lost'].includes(p.stage)).sort((a, b) => a.next_followup.localeCompare(b.next_followup));
  const days = perDay(calls, 14), maxD = Math.max(goal, 1, ...days.map((d) => d.n));
  const ps = R('prospects'), maxF = Math.max(1, ...PIPE.map((p) => ps.filter((x) => x.stage === p.k).length));
  const allCalls = R('calls').filter((c) => new Date(c.created_at).getTime() >= since);
  const board = team().map((p) => {
    const mine = allCalls.filter((c) => c.caller === p.id), t = R('calls').filter((c) => c.caller === p.id && dayOf(c.created_at) === today()).length;
    return { p, n: mine.length, int: mine.filter((c) => c.outcome === 'interested').length, t };
  }).sort((a, b) => b.n - a.n || b.t - a.t);
  const maxB = Math.max(1, ...board.map((b) => b.n));
  const doms = domainList().slice(0, 6).map((d) => {
    const ids = new Set(ps.filter((p) => dKey(p.domain) === d.k).map((p) => p.id));
    const dc = R('calls').filter((c) => ids.has(c.prospect_id));
    return { ...d, calls: dc.length, int: dc.filter((c) => c.outcome === 'interested').length, won: ps.filter((p) => ids.has(p.id) && ['meeting', 'proposal', 'client'].includes(p.stage)).length };
  });
  const rangeLbl = { 1: 'today', 7: 'last 7 days', 30: 'last 30 days', all: 'all time' }[S.ui.range];
  const goalPct = pct(todayN, goal);

  return `<div class="topbar"><div class="muted" style="font-size:15px">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>${meBtn()}</div>
  <div class="row" style="justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
    <h1 class="title" style="margin-bottom:6px">${greeting()}, ${esc((me.name || '').split(' ')[0])}</h1>
    <div class="seg" style="width:180px;margin-bottom:10px">${[['me', 'Me'], ['team', 'Team']].map(([k, n]) => `<button class="${scope === k ? 'on' : ''}" data-a="ui" data-k="scope" data-v="${k}">${n}</button>`).join('')}</div>
  </div>
  <div class="dash">
    <div class="dcol">
      <div class="herocard">
        <button class="heroring" data-a="${scope === 'me' ? 'goal' : 'noop'}" aria-label="Daily goal">${ring(goalPct, 132, 12, `<b>${todayN}</b><small>/ ${goal}</small>`)}</button>
        <div class="grow">
          <div class="h-k">${scope === 'me' ? 'Your calls today' : 'Team calls today'}</div>
          <div class="h-v">${left ? `${left} to go` : 'Goal reached'}${left ? '' : ` <span style="color:var(--good)">${icon('star', 'sm')}</span>`}</div>
          <div class="chips" style="margin-top:10px">
            <span class="chip">${icon('flame', 'xs')}${st}-day streak</span>
            <span class="chip">${icon('trend', 'xs')}${wk} this week${delta == null ? '' : ` <b style="color:${delta >= 0 ? 'var(--good)' : 'var(--bad)'}">${delta >= 0 ? '+' : ''}${delta}%</b>`}</span>
          </div>
          <a class="bigcall" href="#/call" style="margin-top:14px">${icon('phone')}Start calling</a>
        </div>
      </div>

      <div class="row" style="justify-content:space-between;margin:22px 2px 10px"><div class="subtitle" style="margin:0">${icon('chart')}Analytics</div>
        <div class="chips">${[['1', 'Today'], ['7', '7D'], ['30', '30D'], ['all', 'All']].map(([k, n]) => `<button class="chip ${S.ui.range === k ? 'on' : ''}" data-a="ui" data-k="range" data-v="${k}">${n}</button>`).join('')}</div></div>
      <div class="kpis four">
        <div class="kpi"><div class="v num">${rc.length}</div><div class="k">${icon('phone')}Calls</div></div>
        <div class="kpi"><div class="v num">${pct(picked, rc.length)}<span class="u">%</span></div><div class="k">${icon('people')}Picked up</div></div>
        <div class="kpi"><div class="v num">${interested}</div><div class="k">${icon('thumb')}Interested</div></div>
        <div class="kpi"><div class="v num">${pct(interested, picked)}<span class="u">%</span></div><div class="k">${icon('target')}Hit rate</div></div>
      </div>

      <div class="card pad">
        <div class="row" style="justify-content:space-between;margin-bottom:4px"><div style="font-weight:600">Calls per day</div><div class="faint row" style="font-size:12.5px;gap:6px"><span class="goalkey"></span>Daily goal</div></div>
        <div class="plot">
          <div class="goalline" style="bottom:${Math.min(100, (goal / maxD) * 100)}%"><span>${goal}</span></div>
          ${days.map((d) => `<div class="c" data-tip="${esc(d.d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}: ${d.n} call${d.n === 1 ? '' : 's'}"><i style="height:${(d.n / maxD) * 100}%;${d.n >= goal ? 'background:var(--good)' : ''}"></i></div>`).join('')}
        </div>
        <div class="xl">${days.map((d, i) => `<span>${i % 2 === 1 || i === 13 ? (i === 13 ? 'Today' : d.d.getDate()) : ''}</span>`).join('')}</div>
      </div>

      <div class="subtitle">${icon('layers')}Pipeline <span class="count">${ps.length} leads</span></div>
      <div class="card pad stat">${PIPE.map((p) => { const n = ps.filter((x) => x.stage === p.k).length; return `<button class="hbar" data-a="goto-stage" data-v="${p.k}" data-tip="${n} lead${n === 1 ? '' : 's'} · ${pct(n, ps.length)}%"><span class="k"><span class="stagedot" style="background:${pipeColor(p.k)}"></span>${p.n}</span><div class="track"><i style="width:${(n / maxF) * 100}%;background:${pipeColor(p.k)}"></i></div><span class="v num">${n}</span></button>`; }).join('')}</div>

      <div class="subtitle">${icon('phone')}Outcomes <span class="count">${rangeLbl}</span></div>
      <div class="card pad stat">${Object.entries(OUT).map(([k, o]) => { const n = rc.filter((c) => c.outcome === k).length; return `<div class="hbar" data-tip="${n} · ${pct(n, rc.length)}% of calls"><span class="k"><span style="color:${o.c};display:inline-flex">${icon(o.icon, 'xs')}</span>${o.n}</span><div class="track"><i style="width:${pct(n, Math.max(1, rc.length))}%;background:${o.c}"></i></div><span class="v num">${n}</span></div>`; }).join('')}</div>
    </div>

    <div class="dcol">
      <div class="subtitle" style="margin-top:0">${icon('people')}Team <span class="count">${rangeLbl}</span></div>
      <div class="card">${board.map(({ p, n, int, t }) => `<div class="leader">${ring(pct(t, p.daily_goal || 40), 40, 4, avatar(p.id), safeColor(p.color))}<div class="grow"><div style="font-weight:600">${esc(nameOf(p.id))}${p.role === 'founder' ? '' : ' <span class="faint" style="font-weight:500;font-size:12px">· Caller</span>'}</div><div class="muted num" style="font-size:12.5px">${t}/${p.daily_goal || 40} today</div><div class="bar" style="height:6px;margin-top:6px"><i style="width:${(n / maxB) * 100}%;background:${safeColor(p.color)}"></i></div></div>
        <div class="nums"><div><b class="num">${n}</b>calls</div><div><b class="num">${int}</b>${icon('thumb', 'xs')}</div><div><b class="num">${pct(int, n)}%</b>rate</div></div></div>`).join('') || '<div class="empty">No team yet</div>'}</div>

      <div class="subtitle">${icon('cal')}Follow-ups due <span class="count">${due.length}</span></div>
      <div class="card">${due.slice(0, 6).map((p) => `<button class="lead" data-a="prospect" data-id="${esc(p.id)}"><span class="ini">${esc(initials(p.name || p.company))}</span><div class="grow"><div class="ell" style="font-weight:500">${esc(p.name || p.company || 'Unnamed')}</div><div class="ell muted" style="font-size:13px">${esc([p.name ? p.company : '', p.pitch].filter(Boolean).join(' · '))}</div></div><span class="stagepill" style="${p.next_followup < today() ? 'color:var(--bad)' : ''}">${icon('cal', 'xs')}${p.next_followup === today() ? 'Today' : shortDate(p.next_followup)}</span></button>`).join('') || `<div class="emptyline">${icon('check', 'sm')}Nothing due. Nice.</div>`}
        ${due.length > 6 ? `<a class="more" href="#/call">+${due.length - 6} more in the calling queue</a>` : ''}</div>

      <div class="subtitle">${icon('tag')}Domains</div>
      <div class="card">${doms.map((d) => `<button class="leader" data-a="goto-domain" data-v="${esc(d.k)}" style="width:100%;text-align:left"><div class="grow"><div style="font-weight:600" class="ell">${esc(d.n)}</div><div class="muted num" style="font-size:12.5px">${d.c} lead${d.c === 1 ? '' : 's'} · ${d.calls} calls · ${d.won} in meeting+</div>${bar(pct(d.int, d.calls), 'var(--good)')}</div><div class="nums"><div><b class="num">${pct(d.int, d.calls)}%</b>interested</div></div></button>`).join('') || `<div class="emptyline">${icon('tag', 'sm')}Add a domain to leads to compare them.</div>`}</div>
    </div>
  </div><div style="height:24px"></div>`;
}

/* ──────────────── Leads (pipeline + list) ──────────────── */
function vLeads() {
  const all = R('prospects');
  const head = `<div class="topbar"><span></span>${meBtn()}</div>
    <div class="row" style="justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap">
      <h1 class="title" style="margin-bottom:12px">Leads <span class="faint num" style="font-size:22px;font-weight:600">${all.length}</span></h1>
      <div class="row" style="gap:8px;margin-bottom:14px">
        <button class="pillbtn" data-a="import">${icon('tray', 'sm')}<span class="hide-sm">Import</span></button>
        <button class="pillbtn solid" data-a="add-lead">${icon('plus', 'sm')}<span class="hide-sm">Add lead</span></button>
      </div>
    </div>
    <div class="toolbar">
      <div class="seg" style="width:220px;margin:0">${[['pipeline', 'board', 'Pipeline'], ['list', 'list', 'List']].map(([k, i, n]) => `<button class="${S.ui.leadsView === k ? 'on' : ''}" data-a="leads-view" data-v="${k}">${icon(i, 'xs')}${n}</button>`).join('')}</div>
      <div class="search grow" style="margin:0">${icon('search', 'sm')}<input data-fk="q" data-input="q" type="search" placeholder="Search name, business, phone, city…" value="${esc(S.ui.q)}" maxlength="100" autocomplete="off"></div>
    </div>
    ${domainChips()}`;
  if (!all.length) return head + `<div class="empty">${icon('tray')}<div class="h">No leads yet</div>Import a CSV or Excel file, or add one by hand.<div class="row" style="justify-content:center;gap:8px;margin-top:16px"><button class="pillbtn solid" data-a="import">${icon('tray', 'sm')}Import leads</button><button class="pillbtn" data-a="add-lead">${icon('plus', 'sm')}Add lead</button></div></div>`;
  return head + (S.ui.leadsView === 'pipeline' ? vPipeline() : vList());
}
function domainChips() {
  const doms = domainList(), all = R('prospects'), none = all.filter((p) => !dKey(p.domain)).length;
  if (!doms.length) return '';
  const chip = (k, label, n) => `<button class="chip ${S.ui.domain === k ? 'on' : ''}" data-a="ui" data-k="domain" data-v="${esc(k)}">${label} <span class="cn">${n}</span></button>`;
  return `<div class="chips scroll" style="margin:12px -16px 14px" data-keep-scroll="dom">${chip('all', `${icon('tag', 'xs')}All domains`, all.length)}${doms.map((d) => chip(d.k, esc(d.n), d.c)).join('')}${none ? chip('-', 'No domain', none) : ''}</div>`;
}
function vPipeline() {
  const ps = filtered({ stage: false });
  return `<div class="hint-drag faint">${icon('grip', 'xs')}${coarse ? 'Press and hold a card, then drag it to another column' : 'Drag cards between columns to change status'}</div>
  <div class="board" data-keep-scroll="board">${PIPE.map((p) => {
    const list = ps.filter((x) => x.stage === p.k).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return `<div class="col" data-col="${p.k}"><div class="ch"><span class="stagedot" style="background:${pipeColor(p.k)}"></span>${p.n}<span class="n num">${list.length}</span></div>
      <div class="stack" data-drop="${p.k}">${list.slice(0, 40).map(pCard).join('')}${list.length > 40 ? `<button class="more" data-a="list-stage" data-v="${p.k}">+${list.length - 40} more</button>` : ''}${list.length ? '' : '<div class="dropzone-empty">Drop here</div>'}</div></div>`;
  }).join('')}</div>`;
}
function pCard(p) {
  const due = p.next_followup && p.next_followup <= today() && !['client', 'lost'].includes(p.stage);
  return `<div class="pcard" role="button" tabindex="0" data-card="${esc(p.id)}">
    <div class="row" style="gap:6px"><div class="n ell grow">${esc(p.company || p.name || 'Unnamed')}</div>${scoreBadge(p.score)}</div>
    ${p.name && p.company ? `<div class="m ell">${esc(p.name)}</div>` : ''}
    ${p.problem ? `<div class="probline">${esc(p.problem)}</div>` : ''}
    ${p.domain || p.pitch ? `<div class="chips" style="gap:4px">${domainChip(p.domain)}${pitchChip(p.pitch)}</div>` : ''}
    <div class="m">${p.call_count ? `<span class="row" style="gap:3px">${icon('phone', 'xs')}${p.call_count}</span>` : ''}${p.next_followup && !['client', 'lost'].includes(p.stage) ? `<span class="row" style="gap:3px;${due ? 'color:var(--bad)' : ''}">${icon('cal', 'xs')}${shortDate(p.next_followup)}</span>` : ''}${p.city ? `<span class="ell">${esc(p.city)}</span>` : ''}<span class="grow"></span>${safeUrl(p.website) ? `<span class="faint" title="Has website">${icon('globe', 'xs')}</span>` : ''}</div>
  </div>`;
}
function vList() {
  const base = filtered({ stage: false });
  const list = filtered();
  const sorters = {
    recent: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
    name: (a, b) => (a.name || a.company || '').localeCompare(b.name || b.company || ''),
    score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
    business: (a, b) => (a.company || '').localeCompare(b.company || ''),
    lastcall: (a, b) => (b.last_call_at || '').localeCompare(a.last_call_at || ''),
    status: (a, b) => PIPE.findIndex((x) => x.k === a.stage) - PIPE.findIndex((x) => x.k === b.stage),
  };
  list.sort(sorters[S.ui.sort] || sorters.recent);
  const shown = list.slice(0, S.ui.limit);
  const stSel = (p) => `<label class="stsel" style="--c:${pipeColor(p.stage)}"><span class="stagedot"></span><select data-stage="${esc(p.id)}" aria-label="Status">${PIPE.map((x) => `<option value="${x.k}" ${x.k === p.stage ? 'selected' : ''}>${x.n}</option>`).join('')}</select></label>`;
  return `<div class="row" style="justify-content:space-between;gap:10px;margin-bottom:12px">
      <div class="chips scroll stagechips" data-keep-scroll="stg"><button class="chip ${S.ui.stage === 'all' ? 'on' : ''}" data-a="ui" data-k="stage" data-v="all">All <span class="cn">${base.length}</span></button>${PIPE.map((p) => `<button class="chip ${S.ui.stage === p.k ? 'on' : ''}" data-a="ui" data-k="stage" data-v="${p.k}"><span class="dot" style="background:${pipeColor(p.k)}"></span>${p.n} <span class="cn">${base.filter((x) => x.stage === p.k).length}</span></button>`).join('')}</div>
      <label class="sortsel">${icon('filter', 'xs')}<select data-ui="sort" aria-label="Sort">${[['recent', 'Recent'], ['score', 'Lead score'], ['business', 'Business'], ['name', 'Contact'], ['lastcall', 'Last call'], ['status', 'Status']].map(([k, n]) => `<option value="${k}" ${S.ui.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>
    ${list.length ? `<div class="card ltable">
      <div class="lrow lhead"><div>Business</div><div>Contact</div><div>Domain</div><div>Problem &amp; pitch</div><div>Website</div><div>Status</div><div class="r">Calls</div></div>
      ${shown.map((p) => `<div class="lrow" data-row="${esc(p.id)}">
        <div class="c-contact"><span class="ini">${esc(initials(p.company || p.name))}</span><div class="grow" style="min-width:0"><div class="row" style="gap:6px"><span class="ell strong">${esc(p.company || p.name || '—')}</span>${scoreBadge(p.score)}</div><div class="ell muted sm">${esc(p.phone || '')}${p.phone && p.city ? ' · ' : ''}${esc(p.city || '')}</div></div></div>
        <div class="c-biz ell">${esc(p.name && p.company ? p.name : '') || '<span class="faint">—</span>'}</div>
        <div class="c-dom">${domainChip(p.domain) || '<span class="faint">—</span>'}</div>
        <div class="c-pitch">${p.problem ? `<div class="clamp2" title="${esc(p.problem)}">${esc(p.problem)}</div>` : ''}${p.pitch ? `<div style="margin-top:4px">${pitchChip(p.pitch)}</div>` : ''}${!p.problem && !p.pitch ? '<span class="faint">—</span>' : ''}</div>
        <div class="c-web">${webLink(p.website) || '<span class="faint">—</span>'}</div>
        <div class="c-st">${stSel(p)}</div>
        ${p.problem ? `<div class="c-prob clamp2">${icon('flag', 'xs')}${esc(p.problem)}</div>` : ''}
        <div class="c-tags">${domainChip(p.domain)}${pitchChip(p.pitch)}${webLink(p.website)}${p.call_count ? `<span class="dchip">${icon('phone', 'xs')}${p.call_count}</span>` : ''}</div>
        <div class="c-calls r num">${p.call_count ? `${p.call_count}<div class="faint sm">${rel(p.last_call_at)}</div>` : '<span class="faint">0</span>'}</div>
      </div>`).join('')}
    </div>${list.length > S.ui.limit ? `<button class="btn ghost" style="margin-top:12px" data-a="more-leads">Show ${Math.min(200, list.length - S.ui.limit)} more</button>` : ''}`
    : `<div class="empty">${icon('search')}<div class="h">No matches</div>Try another search or domain.</div>`}<div style="height:20px"></div>`;
}

/* ──────────────── Calling ──────────────── */
function queue() {
  const t = today();
  const due = (p) => p.next_followup && p.next_followup <= t && !['client', 'lost'].includes(p.stage);
  return filtered({ stage: false }).filter((p) => p.phone && !S.ui.skipped.has(p.id) && dayOf(p.last_call_at) !== t &&
      (due(p) || (['new', 'called'].includes(p.stage) && !(p.next_followup && p.next_followup > t))))
    .sort((a, b) => (due(b) - due(a)) || ((a.call_count || 0) - (b.call_count || 0)) || ((b.score ?? -1) - (a.score ?? -1)) || String(a.last_call_at || a.created_at).localeCompare(String(b.last_call_at || b.created_at)));
}
function approachCard(p) {
  if (!p.problem && !p.opener && !p.pitch && !p.best_time) return '';
  return `<div class="card approach">
    ${p.problem ? `<div class="ap"><div class="apk" style="color:var(--bad)">${icon('flag', 'xs')}The problem</div><div class="apv">${esc(p.problem)}</div></div>` : ''}
    ${p.opener ? `<div class="ap"><div class="apk" style="color:var(--accent)">${icon('chat', 'xs')}Open with</div><div class="apv quote">“${esc(p.opener)}”</div></div>` : ''}
    ${p.pitch ? `<div class="ap"><div class="apk" style="color:var(--good)">${icon('target', 'xs')}Pitch</div><div class="apv"><b>${esc(p.pitch)}</b></div></div>` : ''}
    ${p.best_time ? `<div class="ap"><div class="apk">${icon('clock', 'xs')}Best time to call</div><div class="apv sm2">${esc(p.best_time)}</div></div>` : ''}
  </div>`;
}
function vCall() {
  const q = queue(), p = q[0], goal = meP().daily_goal || 40;
  const mine = R('calls').filter((c) => c.caller === S.me.id && dayOf(c.created_at) === today()).length;
  const head = `<div class="topbar"><span></span>${meBtn()}</div><h1 class="title">Calling</h1>
    <div class="card pad row" style="margin-bottom:12px">${ring(pct(mine, goal), 56, 6, icon(mine >= goal ? 'star' : 'target', 'sm'))}<div class="grow"><div style="font-weight:600;font-size:17px" class="num">${mine} / ${goal} today</div><div class="muted" style="font-size:13.5px">${q.length} in queue${S.ui.skipped.size ? ` · ${S.ui.skipped.size} skipped` : ''}${S.ui.domain !== 'all' ? ' · filtered' : ''}</div></div>${S.ui.skipped.size ? `<button class="pillbtn" data-a="unskip">${icon('undo', 'sm')}Skipped</button>` : ''}</div>
    ${domainChips()}`;
  if (!p) return head + `<div class="empty">${icon('check')}<div class="h">Queue clear</div>${S.ui.domain !== 'all' ? 'No one left in this domain today.' : 'No one left to call today.'}<div style="margin-top:14px"><button class="pillbtn" data-a="import">${icon('tray', 'sm')}Import more leads</button></div></div>`;
  const last = R('calls').filter((c) => c.prospect_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const due = p.next_followup && p.next_followup <= today();
  const tt = theirTime(p.timezone);
  return head + `<div class="dial">
    <div class="dialcard" data-a="prospect" data-id="${esc(p.id)}" role="button" tabindex="0">
      <div class="row" style="justify-content:center;gap:8px"><div class="n">${esc(p.company || p.name || 'Unnamed')}</div>${scoreBadge(p.score)}</div>
      ${p.name && p.company ? `<div class="muted">${esc(p.name)}</div>` : ''}
      <div class="ph">${esc(p.phone)}</div>
      <div class="chips" style="justify-content:center;margin-top:8px">${stagePill(p.stage)}${domainChip(p.domain)}${p.city ? `<span class="chip">${icon('pin', 'xs')}${esc(p.city)}</span>` : ''}${tt ? `<span class="chip" style="color:${tt.open ? 'var(--good)' : 'var(--warn)'}">${icon('clock', 'xs')}${esc(tt.t)} their time${tt.open ? '' : ' · after hours'}</span>` : ''}${due ? `<span class="chip" style="color:var(--bad)">${icon('cal', 'xs')}Callback due</span>` : ''}${last ? `<span class="chip">${icon(OUT[last.outcome]?.icon || 'phone', 'xs')}${rel(last.created_at)} by ${esc(nameOf(last.caller))}</span>` : ''}</div>
      ${webLink(p.website, 'wcenter')}
    </div>
    ${approachCard(p)}
    ${p.notes ? `<details class="card notesdetails"><summary>${icon('note', 'sm')}Notes & research</summary><div class="notesbox">${esc(p.notes)}</div></details>` : ''}
    <a class="bigcall" href="${esc(telHref(p.phone))}">${icon('phone')}Call ${esc(p.phone)}</a>
    <input class="card noteinput" data-fk="dialnote-${esc(p.id)}" id="callnote" placeholder="Note (optional)" maxlength="1000">
    <div class="callbtns">${Object.entries(OUT).map(([k, o]) => `<button class="callbtn" data-a="log-call" data-id="${esc(p.id)}" data-v="${k}"><span class="ci ${k}">${icon(o.icon)}</span>${o.n}</button>`).join('')}</div>
    <button class="btn ghost" data-a="skip" data-id="${esc(p.id)}">${icon('skip', 'sm')}Skip for now</button>
  </div>`;
}

/* ──────────────── Activity ──────────────── */
function actText(a) {
  const L = `<b>${esc(a.label || 'an untitled lead')}</b>`, ch = a.changes || {};
  switch (a.entity) {
    case 'prospects':
      if (a.action === 'insert') return `added lead ${L}`;
      if (a.action === 'delete') return `deleted lead ${L}`;
      if (ch.stage) return `moved ${L} → ${esc(PIPE_N[ch.stage[1]] || ch.stage[1])}`;
      return `updated ${Object.keys(ch).map((k) => ({ name: 'contact', company: 'business', next_followup: 'follow-up', pitch: 'pitch', domain: 'domain', website: 'website', problem: 'problem', opener: 'call opener', best_time: 'best time', timezone: 'time zone', score: 'score' }[k] || k)).join(', ')} of ${L}`;
    case 'calls': return a.action === 'delete' ? `removed a call to ${L}` : `called ${L} · ${esc(OUT[ch.outcome]?.n || '')}${ch.note ? ` <span class="faint">“${esc(ch.note)}”</span>` : ''}`;
    case 'imports': return `imported <b>${Number(ch.count) || 0} leads</b> from ${esc(a.label || 'a file')}`;
    case 'team':
      if (a.action === 'create') return `added ${L} to the team as ${ch.role === 'founder' ? 'founder' : 'caller'}`;
      if (a.action === 'reset_password') return `reset the password of ${L}`;
      if (a.action === 'set_role') return `made ${L} a ${ch.role?.[1] === 'founder' ? 'founder' : 'caller'}`;
      if (a.action === 'set_active') return `${ch.active ? 'reactivated' : 'deactivated'} ${L}`;
  }
  return `${esc(a.action)} ${L}`;
}
function actRow(a) {
  let ic = { prospects: 'person', calls: 'phone', imports: 'tray', team: 'shield' }[a.entity] || 'dot', col = { prospects: 'var(--p-interested)', calls: '#8e8e93', imports: 'var(--s2)', team: 'var(--s4)' }[a.entity] || '#8e8e93';
  if (a.entity === 'calls' && OUT[a.changes?.outcome]) { ic = OUT[a.changes.outcome].icon; col = OUT[a.changes.outcome].c; }
  if (a.action === 'delete') { ic = 'trash'; col = 'var(--bad)'; }
  const target = a.prospect_id && get('prospects', a.prospect_id) ? `data-a="prospect" data-id="${esc(a.prospect_id)}"` : '';
  return `<button class="act" ${target}><span class="ai">${avatar(a.actor, 'md')}<span class="mini" style="background:${col}">${icon(ic)}</span></span>
    <div class="grow"><div class="txt"><b>${esc(nameOf(a.actor))}</b> ${actText(a)}</div><div class="when">${rel(a.created_at)} · ${clock(a.created_at)}</div></div></button>`;
}
function vActivity() {
  const f = S.ui.actFilter;
  let list = R('activity').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (f === 'calls') list = list.filter((a) => a.entity === 'calls');
  else if (f === 'leads') list = list.filter((a) => a.entity === 'prospects' || a.entity === 'imports');
  else if (f === 'team') list = list.filter((a) => a.entity === 'team');
  else if (f !== 'all') list = list.filter((a) => a.actor === f);
  list = list.slice(0, 300);
  const groups = []; let cur = null;
  for (const a of list) { const d = dayOf(a.created_at); if (!cur || cur.d !== d) { cur = { d, items: [] }; groups.push(cur); } cur.items.push(a); }
  const dayLabel = (d) => (d === today() ? 'Today' : rel(d + 'T12:00:00'));
  return `<div class="topbar"><span></span>${meBtn()}</div><h1 class="title">Activity</h1>
    <div class="chips scroll" style="margin-bottom:6px" data-keep-scroll="act">
      ${[['all', 'All'], ['calls', 'Calls'], ['leads', 'Leads'], ['team', 'Team']].map(([k, n]) => `<button class="chip ${f === k ? 'on' : ''}" data-a="ui" data-k="actFilter" data-v="${k}">${n}</button>`).join('')}
      ${team().map((p) => `<button class="chip ${f === p.id ? 'on' : ''}" data-a="ui" data-k="actFilter" data-v="${esc(p.id)}">${avatar(p.id)}${esc(nameOf(p.id))}</button>`).join('')}
    </div>
    ${groups.length ? groups.map((g) => `<div class="dayhead">${esc(dayLabel(g.d))}</div><div class="card">${g.items.map(actRow).join('')}</div>`).join('') : `<div class="empty">${icon('clock')}<div class="h">No activity yet</div></div>`}
    <div style="height:20px"></div>`;
}

/* ──────────────── Account & team ──────────────── */
function vAccount() {
  const me = meP(), theme = localStorage.getItem('kx-theme') || 'auto';
  const members = R('profiles').filter((p) => p.role).sort((a, b) => (b.active - a.active) || String(a.created_at).localeCompare(String(b.created_at)));
  return `<div class="topbar"><span></span></div><h1 class="title">Account</h1>
    <div class="acct">
    <div>
      <div class="card pad row">${avatar(me.id, 'lg')}<div class="grow"><div style="font-weight:700;font-size:19px">${esc(me.name || '')}</div><div class="muted" style="font-size:14px">@${esc(me.username || '')} · ${me.role === 'founder' ? 'Founder' : 'Sales team'}</div></div></div>
      <div class="sec2">Daily call goal</div>
      <div class="card pad row"><button class="iconbtn" data-a="goal-step" data-v="-5" aria-label="Lower goal">−</button><div class="grow num" style="text-align:center"><div style="font-size:30px;font-weight:700;letter-spacing:-.03em">${me.daily_goal || 40}</div><div class="faint" style="font-size:12.5px">calls per day</div></div><button class="iconbtn" data-a="goal-step" data-v="5" aria-label="Raise goal">${icon('plus', 'sm')}</button></div>
      <div class="sec2">Security</div>
      <div class="card"><button class="item" data-a="password">${icon('key', 'sm')}<span class="grow">Change password</span>${icon('right', 'sm chev')}</button></div>
      <div class="sec2">Appearance</div>
      <div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, n]) => `<button class="${theme === k ? 'on' : ''}" data-a="theme" data-v="${k}">${n}</button>`).join('')}</div>
      ${S.api.demo ? `<div class="sec2">Demo</div><div class="card">${S.api.users().map((u) => `<button class="pick ${u.id === S.me.id ? 'on' : ''}" data-a="demo-user" data-v="${esc(u.id)}"><span class="tick">${icon('check')}</span><span class="grow">View as ${esc(u.name)} <span class="faint">(${u.role === 'founder' ? 'founder' : 'caller'})</span></span></button>`).join('')}<button class="item" data-a="demo-reset" style="color:var(--bad)">${icon('undo', 'sm')}Reset demo data</button></div>` : ''}
      <button class="btn danger" style="margin-top:22px" data-a="signout">${icon('out', 'sm')}Sign out</button>
    </div>
    <div>
      <div class="sec2 row" style="justify-content:space-between"><span>Team · ${members.filter((m) => m.active).length}</span>${isFounder() ? `<button class="pillbtn solid sm" data-a="add-member">${icon('userPlus', 'sm')}Add member</button>` : ''}</div>
      <div class="card">${members.map((p) => `<${isFounder() ? 'button' : 'div'} class="item" ${isFounder() ? `data-a="member" data-id="${esc(p.id)}"` : ''} style="${p.active ? '' : 'opacity:.5'}">${avatar(p.id, 'md')}<div class="grow"><div class="t">${esc(p.name)}${p.id === S.me.id ? ' <span class="faint">(you)</span>' : ''}</div><div class="s">@${esc(p.username || '')} · ${p.role === 'founder' ? 'Founder' : 'Caller'}${p.active ? '' : ' · Deactivated'}${p.must_change_password && p.active ? ' · Temp password' : ''}</div></div>${isFounder() ? icon('right', 'sm chev') : ''}</${isFounder() ? 'button' : 'div'}>`).join('')}</div>
      <div class="faint" style="font-size:13px;margin:10px 4px">${isFounder() ? 'Founders can add people, reset passwords, change roles and deactivate accounts. Callers can see and work every lead but can’t delete leads or manage the team.' : 'Forgot your password? Ask a founder to reset it.'}</div>
    </div></div><div style="height:24px"></div>`;
}

/* ════════════════════════ sheets ════════════════════════ */
function openSheet(s) { S.sheet = s; S.ui.confirm = null; paintSheet(true); }
function closeSheet() {
  const s = S.sheet; if (!s) return;
  if (s.locked) return;
  if (s.type === 'prospect') { const p = get('prospects', s.id); if (p && s.fresh && !p.name && !p.company && !p.phone && !p.email) rm('prospects', p.id); }
  S.sheet = null; S.ui.imp = null;
  const sh = $('#sheet'), sc = $('#scrim');
  sh.classList.remove('show'); sc.classList.remove('show');
  setTimeout(() => { if (!S.sheet) { sh.classList.add('hide'); sc.classList.add('hide'); sh.innerHTML = ''; } }, 420);
  render();
}
function paintSheet(fresh) {
  const sh = $('#sheet'), sc = $('#scrim');
  if (!S.sheet) return;
  const fn = { prospect: shProspect, import: shImport, password: shPassword, addMember: shAddMember, member: shMember, secret: shSecret, goal: shGoal }[S.sheet.type];
  if (!fn) return;
  const html = `<div class="grab"></div>${fn(S.sheet)}`;
  if (fresh) {
    sh.innerHTML = html; sh.scrollTop = 0;
    sh.classList.remove('hide'); sc.classList.remove('hide');
    requestAnimationFrame(() => requestAnimationFrame(() => { sh.classList.add('show'); sc.classList.add('show'); }));
    if (S.sheet.focus) setTimeout(() => sh.querySelector(S.sheet.focus)?.focus(), 380);
  } else swap(sh, html);
}
const shHead = (title, right = 'Done') => `<div class="sh"><span class="txtbtn"></span><h2>${title}</h2><button class="txtbtn b" data-a="close">${right}</button></div>`;

function shProspect(s) {
  const p = get('prospects', s.id); if (!p) return shHead('');
  const calls = R('calls').filter((c) => c.prospect_id === p.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const fld = (f, ic, ph, { type = 'text', act = '', max = 200, list = '' } = {}) => `<div class="field">${icon(ic)}<input type="${type}" data-field="${esc(p.id)}:${f}" value="${esc(p[f] || '')}" placeholder="${ph}" maxlength="${max}" ${type === 'tel' ? 'inputmode="tel"' : ''} ${list ? `list="${list}"` : ''} autocomplete="off">${act}</div>`;
  const web = safeUrl(p.website), wa = waHref(p.phone);
  const pitches = [...new Set([...PITCH_DEFAULTS, ...R('prospects').map((x) => (x.pitch || '').trim()).filter(Boolean)])].slice(0, 40);
  return shHead('') + `
    <datalist id="dl-domains">${domainList().slice(0, 60).map((d) => `<option value="${esc(d.n)}">`).join('')}</datalist>
    <datalist id="dl-pitch">${pitches.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    <div style="text-align:center;margin-top:-6px;padding-bottom:10px">
      <div class="ini bigini">${esc(initials(p.company || p.name))}</div>
      <input data-field="${esc(p.id)}:company" value="${esc(p.company || '')}" placeholder="Business name" maxlength="200" class="bigname" id="p-name" autocomplete="off">
      <input data-field="${esc(p.id)}:name" value="${esc(p.name || '')}" placeholder="Contact name" maxlength="200" class="subname" autocomplete="off">
      ${p.score != null || theirTime(p.timezone) ? `<div class="chips" style="justify-content:center;margin-top:6px">${p.score != null ? `<span class="chip">${icon('star', 'xs')}Score ${Number(p.score)}</span>` : ''}${theirTime(p.timezone) ? `<span class="chip">${icon('clock', 'xs')}${esc(theirTime(p.timezone).t)} their time</span>` : ''}</div>` : ''}
    </div>
    ${p.phone ? `<a class="bigcall" href="${esc(telHref(p.phone))}">${icon('phone')}${esc(p.phone)}</a>` : ''}
    <div class="sec">Log call</div>
    <div class="card" style="margin-bottom:10px"><div class="field">${icon('note')}<input data-fk="callnote-${esc(p.id)}" id="callnote" placeholder="Note (optional)" maxlength="1000"></div></div>
    <div class="callbtns">${Object.entries(OUT).map(([k, o]) => `<button class="callbtn" data-a="log-call" data-id="${esc(p.id)}" data-v="${k}"><span class="ci ${k}">${icon(o.icon)}</span>${o.n}</button>`).join('')}</div>
    <div class="sec">Status</div>
    <div class="stagepick" data-keep-scroll="sp">${PIPE.map((x) => `<button class="${p.stage === x.k ? 'on' : ''}" style="${p.stage === x.k ? `background:${pipeColor(x.k)}` : ''}" data-a="set-stage" data-id="${esc(p.id)}" data-v="${x.k}"><span class="stagedot" style="background:${p.stage === x.k ? '#fff' : pipeColor(x.k)}"></span>${x.n}</button>`).join('')}</div>
    <div class="sec">How to approach</div>
    <div class="card">
      <div class="field" style="align-items:flex-start">${icon('flag')}<textarea data-field="${esc(p.id)}:problem" placeholder="Their problem: what's wrong, so the team knows the angle" maxlength="1000" data-grow rows="2">${esc(p.problem || '')}</textarea></div>
      <div class="field" style="align-items:flex-start">${icon('chat')}<textarea data-field="${esc(p.id)}:opener" placeholder="Call opener: the first thing to say" maxlength="1000" data-grow rows="2">${esc(p.opener || '')}</textarea></div>
      ${fld('pitch', 'target', 'What to pitch (e.g. Website rebuild, Donna)', { max: 300, list: 'dl-pitch' })}
      ${fld('best_time', 'clock', 'Best time to call (IST)', { max: 300 })}
      ${fld('timezone', 'globe', 'Their time zone (e.g. Eastern (ET))', { max: 60 })}
      <div class="field">${icon('star')}<span class="muted" style="font-size:15px;flex:none">Lead score</span><input type="number" min="0" max="100" step="1" inputmode="numeric" data-field="${esc(p.id)}:score" value="${p.score ?? ''}" placeholder="0–100" style="text-align:right"></div>
    </div>
    <div class="sec">Business</div>
    <div class="card">
      ${fld('domain', 'tag', 'Domain (e.g. Dentist, HVAC)', { max: 120, list: 'dl-domains' })}
      ${fld('website', 'globe', 'Website', { type: 'url', max: 500, act: web ? `<a class="act" href="${esc(web)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Open website">${icon('ext', 'sm')}</a>` : '' })}
    </div>
    <div class="sec">Contact</div>
    <div class="card">
      ${fld('phone', 'phone', 'Phone', { type: 'tel', max: 40, act: wa ? `<a class="act" href="${esc(wa)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp">${icon('chat', 'sm')}</a>` : '' })}
      ${fld('email', 'mail', 'Email', { type: 'email', act: validEmail(p.email) ? `<a class="act" href="mailto:${esc(p.email)}" aria-label="Email">${icon('arrowR', 'sm')}</a>` : '' })}
      ${fld('city', 'pin', 'City', { max: 120 })}
      <div class="field">${icon('cal')}<span class="muted" style="font-size:15px;flex:none">Follow up</span><input type="date" data-field="${esc(p.id)}:next_followup" value="${esc(p.next_followup || '')}" style="text-align:right"></div>
      <div class="field" style="align-items:flex-start">${icon('note')}<textarea data-field="${esc(p.id)}:notes" placeholder="Notes" maxlength="5000" data-grow>${esc(p.notes || '')}</textarea></div>
    </div>
    <div class="sec">Calls <span>${calls.length}</span></div>
    ${calls.length ? `<div class="card">${calls.slice(0, 50).map((c) => `<div class="leader"><span class="ci ${esc(c.outcome)}" style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;flex:none">${icon(OUT[c.outcome]?.icon || 'phone', 'sm')}</span><div class="grow"><div style="font-weight:500">${esc(OUT[c.outcome]?.n || c.outcome)}</div>${c.note ? `<div class="muted" style="font-size:14px">${esc(c.note)}</div>` : ''}</div><div style="text-align:right;font-size:12.5px" class="muted">${avatar(c.caller)}<div>${rel(c.created_at)}</div></div></div>`).join('')}</div>` : `<div class="muted" style="font-size:14px;padding:0 16px">No calls yet.</div>`}
    <div class="faint" style="font-size:12.5px;text-align:center;margin:18px 0 8px">Added by ${esc(nameOf(p.created_by))} · ${rel(p.created_at)}${p.updated_by ? ` · Edited by ${esc(nameOf(p.updated_by))} ${rel(p.updated_at)}` : ''}</div>
    ${isFounder() ? (S.ui.confirm === 'del-lead' ? `<button class="btn" style="background:var(--bad)" data-a="del-lead" data-id="${esc(p.id)}">${icon('trash', 'sm')}Delete forever</button>` : `<button class="btn danger" data-a="confirm" data-v="del-lead">${icon('trash', 'sm')}Delete lead</button>`) : ''}`;
}

function shImport() {
  const st = S.ui.imp || (S.ui.imp = { step: 'drop', keep: true });
  if (st.step === 'drop') return shHead('Import leads', 'Cancel') + `
    <label class="drop" id="dropzone">${icon('tray')}<div style="font-weight:600;font-size:17px;color:var(--ink)">Choose a file</div><div>CSV or Excel (.xlsx), up to ${MAX_FILE_MB} MB</div>
      <input type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden data-file></label>
    ${st.error ? `<div class="errline">${icon('x', 'sm')}${esc(st.error)}</div>` : ''}
    <div class="muted" style="font-size:13.5px;text-align:center;margin-top:14px">Columns are matched automatically: business, contact, domain, problem, call opener, lead score, best time, website, phone… Duplicates (same phone or email) are skipped.</div>`;
  if (st.step === 'loading') return shHead('Import leads', 'Cancel') + `<div class="center" style="min-height:200px"><div class="spinner"></div></div>`;
  if (st.step === 'map') {
    const res = buildRows(st.data, st.map, st.keep, R('prospects'), st.cc);
    st.ready = res.rows;
    const opts = (k) => `<option value="-1">—</option>` + st.data.headers.map((h, i) => `<option value="${i}" ${st.map[k] === i ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const prev = res.rows.slice(0, 4), cols = ['company', 'domain', 'problem', 'phone', 'score'];
    return shHead('Import leads', 'Cancel') + `
      <div class="card pad row" style="margin-bottom:6px">${icon('note')}<div class="grow"><div class="ell" style="font-weight:600">${esc(st.file)}</div><div class="muted num" style="font-size:13px">${st.data.rows.length} rows${st.data.truncated ? ' (first 20,000 only)' : ''}</div></div></div>
      <div class="kpis" style="margin:12px 0 4px"><div class="kpi"><div class="v num" style="color:var(--good)">${res.rows.length}</div><div class="k">${icon('plus')}New</div></div><div class="kpi"><div class="v num">${res.dupes}</div><div class="k">${icon('layers')}Duplicates</div></div><div class="kpi"><div class="v num">${res.empty}</div><div class="k">${icon('x')}Empty</div></div></div>
      <div class="sec">Match columns</div>
      <div class="card mapgrid">${FIELDS.map((f) => `<div>${icon(f.icon, 'sm')}${f.n}</div><div><select data-map="${f.k}">${opts(f.k)}</select></div>`).join('')}</div>
      <div class="sec">Fill in for every lead (optional)</div>
      <div class="card">
        <div class="field">${icon('tag')}<input data-fk="imp-domain" data-imp="domain" value="${esc(st.domain || '')}" placeholder="Domain, if the file has none" maxlength="120" list="dl-domains2"></div>
        <div class="field">${icon('target')}<input data-fk="imp-pitch" data-imp="pitch" value="${esc(st.pitch || '')}" placeholder="What to pitch, if the file has none" maxlength="300" list="dl-pitch2"></div>
        <div class="field">${icon('phone')}<span class="muted" style="font-size:15px;flex:1">Country code for phones</span><select data-impsel="cc" style="flex:none;text-align:right;color:var(--accent)">${[['+1', 'US / Canada +1'], ['+91', 'India +91'], ['+44', 'UK +44'], ['+61', 'Australia +61'], ['+971', 'UAE +971'], ['', 'Keep as is']].map(([v, n]) => `<option value="${v}" ${st.cc === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <datalist id="dl-domains2">${domainList().slice(0, 60).map((d) => `<option value="${esc(d.n)}">`).join('')}</datalist>
      <datalist id="dl-pitch2">${PITCH_DEFAULTS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="card" style="margin-top:10px"><button class="pick ${st.keep ? 'on' : ''}" data-a="imp-keep"><span class="tick">${icon('check')}</span><span class="grow">Keep other columns in notes</span></button></div>
      ${prev.length ? `<div class="sec">Preview</div><div class="card preview"><table><tr>${cols.map((k) => `<th>${FIELDS.find((f) => f.k === k).n}</th>`).join('')}</tr>${prev.map((r) => `<tr>${cols.map((k) => `<td>${esc(r[k] || (k === 'domain' ? st.domain : k === 'pitch' ? st.pitch : '') || '')}</td>`).join('')}</tr>`).join('')}</table></div>` : ''}
      <div style="margin-top:18px"><button class="btn" data-a="imp-run" ${res.rows.length ? '' : 'disabled'}>${icon('tray', 'sm')}Import ${res.rows.length} lead${res.rows.length === 1 ? '' : 's'}</button></div>`;
  }
  if (st.step === 'run') return shHead('Importing…', '&nbsp;') + `<div style="padding:40px 10px;text-align:center"><div class="num" style="font-size:40px;font-weight:700">${st.done || 0}<span class="faint" style="font-size:22px"> / ${st.total}</span></div><div style="margin-top:16px">${bar(((st.done || 0) / st.total) * 100)}</div><div class="faint" style="margin-top:12px;font-size:13px">Keep this open until it finishes.</div></div>`;
  return shHead('Imported') + `<div style="padding:40px 10px;text-align:center"><div class="ci interested" style="width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;color:#fff">${icon('check', 'lg')}</div><div style="font-size:22px;font-weight:700">${st.done} leads added</div>${st.failed ? `<div style="color:var(--bad);margin-top:6px">${st.failed} couldn’t be saved. Try importing the file again (duplicates are skipped).</div>` : '<div class="muted" style="margin-top:4px">They’re in the pipeline and the calling queue.</div>'}
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:10px"><a class="bigcall" href="#/call" data-a="close-go" data-href="#/call">${icon('phone')}Start calling</a></div></div>`;
}

const pwField = (name, ph, ac, fk) => `<div class="field">${icon('lock')}<input type="password" name="${name}" data-fk="${fk}" placeholder="${ph}" autocomplete="${ac}" maxlength="72" required><button type="button" class="fieldbtn" data-a="peek" aria-label="Show password">${icon('eye', 'sm')}</button></div>`;
function shPassword(s) {
  return shHead('Change password', 'Cancel') + `<form id="pwform" autocomplete="on">
    <input type="text" name="username" value="${esc(meP().username || '')}" autocomplete="username" hidden>
    <div class="card">${pwField('current', 'Current password', 'current-password', 'pw-cur')}${pwField('next', `New password (${PW_MIN}+ characters)`, 'new-password', 'pw-new')}${pwField('confirm', 'Repeat new password', 'new-password', 'pw-rep')}</div>
    ${s.error ? `<div class="errline">${icon('x', 'sm')}${esc(s.error)}</div>` : ''}
    <button class="btn" type="submit" style="margin-top:16px" ${s.busy ? 'disabled' : ''}>${s.busy ? '<span class="spinner sm"></span>' : icon('check', 'sm')}Update password</button>
    <div class="faint" style="font-size:13px;text-align:center;margin-top:12px">Use something long you don’t use elsewhere. A short phrase works well.</div></form>`;
}
function shAddMember(s) {
  return shHead('Add member', 'Cancel') + `<form id="memberform" autocomplete="off">
    <div class="card">
      <div class="field">${icon('person')}<input name="name" data-fk="m-name" placeholder="Full name" maxlength="60" required></div>
      <div class="field">${icon('key')}<input name="username" data-fk="m-user" placeholder="Username (e.g. anjika)" maxlength="30" pattern="[a-z0-9._\\-]{3,30}" autocapitalize="off" autocorrect="off" spellcheck="false" required></div>
    </div>
    <div class="sec">Role</div>
    <div class="card">${[['caller', 'Sales team', 'Works leads and logs calls'], ['founder', 'Founder', 'Everything, plus team management and deleting leads']].map(([k, n, d]) => `<button type="button" class="pick ${(s.role || 'caller') === k ? 'on' : ''}" data-a="m-role" data-v="${k}"><span class="tick">${icon('check')}</span><div class="grow"><div>${n}</div><div class="faint" style="font-size:13px">${d}</div></div></button>`).join('')}</div>
    ${s.error ? `<div class="errline">${icon('x', 'sm')}${esc(s.error)}</div>` : ''}
    <button class="btn" type="submit" style="margin-top:16px" ${s.busy ? 'disabled' : ''}>${s.busy ? '<span class="spinner sm"></span>' : icon('userPlus', 'sm')}Create account</button>
    <div class="faint" style="font-size:13px;text-align:center;margin-top:12px">You’ll get a one-time password to share. They choose their own at first sign-in.</div></form>`;
}
function shMember(s) {
  const p = get('profiles', s.id); if (!p) return shHead('');
  const self = p.id === S.me.id;
  return shHead(esc(p.name)) + `
    <div class="card pad row">${avatar(p.id, 'lg')}<div class="grow"><div style="font-weight:700;font-size:18px">${esc(p.name)}</div><div class="muted">@${esc(p.username || '')} · ${p.role === 'founder' ? 'Founder' : 'Caller'} · ${p.active ? 'Active' : 'Deactivated'}</div></div></div>
    ${s.error ? `<div class="errline">${icon('x', 'sm')}${esc(s.error)}</div>` : ''}
    <div class="card" style="margin-top:14px">
      ${p.active ? `<button class="item" data-a="m-reset" data-id="${esc(p.id)}" ${s.busy ? 'disabled' : ''}>${icon('key', 'sm')}<span class="grow">Reset password</span><span class="faint" style="font-size:13px">One-time password</span></button>` : ''}
      ${!self ? `<button class="item" data-a="m-setrole" data-id="${esc(p.id)}" data-v="${p.role === 'founder' ? 'caller' : 'founder'}" ${s.busy ? 'disabled' : ''}>${icon('shield', 'sm')}<span class="grow">${p.role === 'founder' ? 'Change to caller' : 'Make founder'}</span></button>` : ''}
      ${!self ? (S.ui.confirm === 'deact' && p.active ? `<button class="item" style="color:var(--bad)" data-a="m-active" data-id="${esc(p.id)}" data-v="0">${icon('x', 'sm')}<span class="grow">Tap again to deactivate</span></button>` : `<button class="item" style="color:${p.active ? 'var(--bad)' : 'var(--good)'}" data-a="${p.active ? 'confirm' : 'm-active'}" data-v="${p.active ? 'deact' : '1'}" data-id="${esc(p.id)}" ${s.busy ? 'disabled' : ''}>${icon(p.active ? 'x' : 'check', 'sm')}<span class="grow">${p.active ? 'Deactivate account' : 'Reactivate account'}</span></button>`) : ''}
    </div>
    <div class="faint" style="font-size:13px;margin:12px 4px">Deactivating signs them out and blocks access right away. Their calls and history stay.</div>`;
}
function shSecret(s) {
  return shHead('Share privately') + `<div style="text-align:center;padding:10px 4px 0">
    <div class="ci interested" style="width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 12px;color:#fff">${icon('key', 'lg')}</div>
    <div style="font-size:20px;font-weight:700">${esc(s.title)}</div>
    <div class="muted" style="margin:6px 0 16px">This password is shown only once. They’ll pick their own after signing in.</div></div>
    <div class="card"><div class="field"><span class="muted" style="width:90px;flex:none">Username</span><b class="grow mono">${esc(s.username)}</b></div><div class="field"><span class="muted" style="width:90px;flex:none">Password</span><b class="grow mono">${esc(s.password)}</b></div></div>
    <button class="btn" style="margin-top:16px" data-a="copy-secret">${icon('copy', 'sm')}Copy both</button>`;
}
function shGoal() {
  const g = meP().daily_goal || 40;
  return shHead('Daily goal') + `<div class="card pad row" style="margin-top:6px"><button class="iconbtn" data-a="goal-step" data-v="-5" aria-label="Lower">−</button><div class="grow num" style="text-align:center"><div style="font-size:44px;font-weight:700;letter-spacing:-.03em">${g}</div><div class="faint">calls per day</div></div><button class="iconbtn" data-a="goal-step" data-v="5" aria-label="Raise">${icon('plus', 'sm')}</button></div>
    <div class="chips" style="justify-content:center;margin-top:14px">${[20, 30, 40, 50, 75, 100].map((n) => `<button class="chip ${g === n ? 'on' : ''}" data-a="goal-set" data-v="${n}">${n}</button>`).join('')}</div>`;
}

/* ════════════════════════ actions ════════════════════════ */
let goalTimer = null;
function setGoal(n) {
  n = Math.max(5, Math.min(500, Math.round(n)));
  put('profiles', { ...meP(), daily_goal: n }); render(); paintSheet();
  clearTimeout(goalTimer);
  goalTimer = setTimeout(() => upd('profiles', S.me.id, { daily_goal: n }), 600);
}
async function teamAction(action, payload, after) {
  S.sheet = { ...S.sheet, busy: true, error: null }; paintSheet();
  try {
    const res = await S.api.team(action, payload);
    await refresh();
    after?.(res);
  } catch (e) { if (S.sheet) { S.sheet = { ...S.sheet, busy: false, error: e.message }; paintSheet(); } }
}
const A = {
  noop: () => {},
  close: () => closeSheet(),
  'close-go': (el) => { S.ui.imp = null; closeSheet(); location.hash = el.dataset.href; },
  ui: (el) => { S.ui[el.dataset.k] = el.dataset.v; S.ui.limit = 100; haptic(5); render(); },
  'leads-view': (el) => { S.ui.leadsView = el.dataset.v; localStorage.setItem('kx-leads-view', el.dataset.v); render(); },
  'goto-stage': (el) => { S.ui.stage = el.dataset.v; S.ui.leadsView = 'list'; location.hash = '#/leads'; },
  'goto-domain': (el) => { S.ui.domain = el.dataset.v; location.hash = '#/leads'; },
  'list-stage': (el) => { S.ui.stage = el.dataset.v; S.ui.leadsView = 'list'; render(); },
  'more-leads': () => { S.ui.limit += 200; render(); },
  prospect: (el) => openSheet({ type: 'prospect', id: el.dataset.id }),
  'add-lead': async () => {
    const id = uuid();
    const seed = { id, stage: 'new' };
    if (S.ui.domain !== 'all' && S.ui.domain !== '-') seed.domain = domainList().find((d) => d.k === S.ui.domain)?.n;
    openSheet({ type: 'prospect', id, fresh: true, focus: '#p-name' });
    try { await ins('prospects', seed); } catch { S.sheet.locked = false; closeSheet(); }
  },
  'set-stage': (el) => { haptic(8); upd('prospects', el.dataset.id, { stage: el.dataset.v }); },
  'log-call': (el) => logCall(el.dataset.id, el.dataset.v),
  skip: (el) => { S.ui.skipped.add(el.dataset.id); haptic(5); render(); },
  unskip: () => { S.ui.skipped.clear(); render(); },
  confirm: (el) => { S.ui.confirm = el.dataset.v; haptic(15); paintSheet(); },
  'del-lead': (el) => { closeSheet(); rm('prospects', el.dataset.id); toast('Lead deleted', { icon: 'trash' }); },
  import: () => { S.ui.imp = { step: 'drop', keep: true }; openSheet({ type: 'import' }); },
  'imp-keep': () => { S.ui.imp.keep = !S.ui.imp.keep; paintSheet(); },
  'imp-run': () => runImport(),
  goal: () => openSheet({ type: 'goal' }),
  'goal-step': (el) => setGoal((meP().daily_goal || 40) + Number(el.dataset.v)),
  'goal-set': (el) => setGoal(Number(el.dataset.v)),
  password: () => openSheet({ type: 'password', focus: '[name=current]' }),
  peek: (el) => { const i = el.parentElement.querySelector('input'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; el.innerHTML = icon(show ? 'eyeOff' : 'eye', 'sm'); },
  theme: (el) => { localStorage.setItem('kx-theme', el.dataset.v); applyTheme(); render(); },
  'add-member': () => openSheet({ type: 'addMember', role: 'caller', focus: '[name=name]' }),
  'm-role': (el) => { const f = $('#memberform'); const keep = f ? { n: f.name.value, u: f.username.value } : null; S.sheet = { ...S.sheet, role: el.dataset.v }; paintSheet(); if (keep) { const g = $('#memberform'); g.name.value = keep.n; g.username.value = keep.u; } },
  member: (el) => openSheet({ type: 'member', id: el.dataset.id }),
  'm-reset': (el) => { const p = get('profiles', el.dataset.id); teamAction('reset_password', { user_id: p.id }, (r) => openSheet({ type: 'secret', title: `New password for ${p.name}`, username: r.username, password: r.password })); },
  'm-setrole': (el) => teamAction('set_role', { user_id: el.dataset.id, role: el.dataset.v }, () => { toast('Role updated'); closeSheet(); }),
  'm-active': (el) => teamAction('set_active', { user_id: el.dataset.id, active: el.dataset.v === '1' }, () => { toast(el.dataset.v === '1' ? 'Account reactivated' : 'Account deactivated'); closeSheet(); }),
  'copy-secret': async () => {
    const s = S.sheet, text = `KaptainX Sales HQ\nSite: ${location.origin}\nUsername: ${s.username}\nPassword: ${s.password}`;
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed. Select the text instead', { icon: 'x', bad: true }); }
  },
  signout: async () => { await S.api.signOut(); location.hash = ''; location.reload(); },
  'demo-user': (el) => { S.api.setActor(el.dataset.v); location.hash = ''; location.reload(); },
  'demo-reset': () => { S.api.reset(); location.reload(); },
};

async function logCall(pid, outcome) {
  const p = get('prospects', pid); if (!p || !OUT[outcome]) return;
  const noteEl = document.getElementById('callnote');
  const note = noteEl?.value.trim().slice(0, 1000) || null; if (noteEl) noteEl.value = '';
  const prev = { stage: p.stage, call_count: p.call_count || 0, last_call_at: p.last_call_at, next_followup: p.next_followup ?? null };
  let stage = p.stage;
  if (outcome === 'interested' && ['new', 'called', 'lost'].includes(stage)) stage = 'interested';
  else if (outcome === 'not_interested' && ['new', 'called'].includes(stage)) stage = 'lost';
  else if (stage === 'new') stage = 'called';
  const followup = outcome === 'callback' ? (p.next_followup && p.next_followup > today() ? p.next_followup : ymd(new Date(Date.now() + 864e5))) : null;
  put('prospects', { ...p, stage, call_count: prev.call_count + 1, last_call_at: nowISO(), ...(followup ? { next_followup: followup } : {}) });
  haptic(outcome === 'interested' ? [10, 40, 10] : 10);
  const id = uuid();
  try { await ins('calls', { id, prospect_id: pid, outcome, note, caller: S.me.id, followup }); }
  catch { put('prospects', { ...get('prospects', pid), ...prev }); render(); return; }
  toast(`${OUT[outcome].n}${stage !== prev.stage && stage !== outcome ? ` · moved to ${PIPE_N[stage]}` : ''}`, {
    icon: OUT[outcome].icon,
    undo: async () => {
      await rm('calls', id);
      const cur = get('prospects', pid);
      if (!cur) return;
      put('prospects', { ...cur, call_count: prev.call_count, last_call_at: prev.last_call_at });
      if (cur.stage !== prev.stage || (cur.next_followup ?? null) !== prev.next_followup) upd('prospects', pid, { stage: prev.stage, next_followup: prev.next_followup });
      else render();
    },
  });
}

async function handleFile(file) {
  if (!file) return;
  S.ui.imp = { step: 'loading', keep: true }; paintSheet();
  try {
    const data = await readFile(file);
    if (!data.rows.length) throw new Error('No rows found in this file.');
    const map = autoMap(data.headers, data.rows);
    S.ui.imp = { step: 'map', keep: true, file: file.name.slice(0, 120), data, map, cc: guessCountryCode(data, map) };
  } catch (e) { S.ui.imp = { step: 'drop', keep: true, error: e.message || 'Couldn’t read this file.' }; }
  paintSheet();
}
async function runImport() {
  const st = S.ui.imp, rows = (st.ready || []).map((r) => ({ ...r, ...(st.domain && !r.domain ? { domain: st.domain.slice(0, 120) } : {}), ...(st.pitch && !r.pitch ? { pitch: st.pitch.slice(0, 300) } : {}) }));
  if (!rows.length) return;
  st.step = 'run'; st.total = rows.length; st.done = 0; st.failed = 0;
  S.sheet.locked = true; paintSheet();
  try {
    const [imp] = await S.api.insert('imports', { id: uuid(), file_name: st.file, count: rows.length });
    put('imports', imp);
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({ ...r, id: uuid(), stage: 'new', import_id: imp.id }));
      try {
        const out = await withTimeout(S.api.insert('prospects', chunk), 30000);
        out.forEach((r) => put('prospects', r)); st.done += out.length;
      } catch (e) { console.error(e); st.failed += chunk.length; }
      paintSheet();
    }
    st.step = 'done'; haptic([10, 40, 10]);
  } catch (e) { fail(e); st.step = 'map'; }
  if (S.sheet) S.sheet.locked = false;
  paintSheet(); render();
}

/* ════════════════════════ drag & drop (mouse + touch) ════════════════════════ */
let drag = null, suppressClick = false;
function startDrag() {
  const d = drag; if (!d || d.started) return;
  d.started = true; haptic(12);
  const r = d.card.getBoundingClientRect();
  d.dx = d.x - r.left; d.dy = d.y - r.top;
  const g = d.card.cloneNode(true);
  g.classList.add('ghost'); g.style.width = r.width + 'px'; g.style.left = r.left + 'px'; g.style.top = r.top + 'px';
  document.body.appendChild(g); d.ghost = g;
  d.card.classList.add('dragging');
  document.body.classList.add('is-dragging');
}
function moveDrag(x, y) {
  const d = drag; if (!d?.started) return;
  d.x = x; d.y = y;
  d.ghost.style.transform = `translate(${x - d.dx - parseFloat(d.ghost.style.left)}px, ${y - d.dy - parseFloat(d.ghost.style.top)}px) rotate(2deg) scale(1.03)`;
  const el = document.elementFromPoint(x, y);
  const col = el?.closest?.('[data-col]');
  document.querySelectorAll('.col.over').forEach((c) => c !== col && c.classList.remove('over'));
  if (col) col.classList.add('over');
  d.target = col?.dataset.col || null;
  const board = d.card.closest('.board');
  if (board) {
    const br = board.getBoundingClientRect();
    cancelAnimationFrame(d.scrollRaf);
    const edge = 60, speed = x < br.left + edge ? -12 : x > br.right - edge ? 12 : 0;
    if (speed) { const step = () => { board.scrollLeft += speed; d.scrollRaf = requestAnimationFrame(step); }; d.scrollRaf = requestAnimationFrame(step); }
  }
}
function endDrag(commit) {
  const d = drag; drag = null;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.started) return;
  cancelAnimationFrame(d.scrollRaf);
  d.ghost.remove(); d.card.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  document.querySelectorAll('.col.over').forEach((c) => c.classList.remove('over'));
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
  const p = get('prospects', d.id);
  if (commit && p && d.target && d.target !== p.stage) {
    upd('prospects', d.id, { stage: d.target });
    haptic(10);
    toast(`${p.name || p.company || 'Lead'} → ${PIPE_N[d.target]}`, { icon: 'check', undo: () => upd('prospects', d.id, { stage: p.stage }) });
  }
  render();
}
function bindDrag() {
  document.addEventListener('pointerdown', (e) => {
    const card = e.target.closest?.('.pcard');
    if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { card, id: card.dataset.card, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, mouse: e.pointerType === 'mouse', started: false };
    if (!drag.mouse) drag.timer = setTimeout(startDrag, 320);
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dist = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    if (!drag.started) {
      if (drag.mouse && dist > 6) { drag.x = e.clientX; drag.y = e.clientY; startDrag(); }
      else if (!drag.mouse && dist > 10) { clearTimeout(drag.timer); drag = null; return; }
      else return;
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', () => endDrag(true));
  document.addEventListener('pointercancel', () => endDrag(false));
  document.addEventListener('touchmove', (e) => { if (drag?.started) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.pcard')) e.preventDefault(); });
}

/* ════════════════════════ toast & tooltip ════════════════════════ */
let toastTimer;
function toast(msg, { icon: ic = 'check', undo, bad } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span style="color:${bad ? 'var(--bad)' : 'var(--good)'};display:inline-flex">${icon(ic)}</span><span class="ell">${esc(msg)}</span>${undo ? '<button class="undo">Undo</button>' : ''}`;
  if (undo) t.querySelector('.undo').onclick = () => { t.classList.remove('show'); undo(); };
  t.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), undo ? 5000 : 2600);
}
function tipAt(el) {
  const tip = $('#tip'), r = el.getBoundingClientRect();
  tip.textContent = el.dataset.tip; tip.style.left = r.left + r.width / 2 + 'px'; tip.style.top = r.top + 'px'; tip.classList.add('show');
}
function growTA(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; }

/* ════════════════════════ field saving with validation ════════════════════════ */
function saveField(el) {
  const [id, f] = el.dataset.field.split(':');
  const row = get('prospects', id); if (!row) return;
  let v = el.value.trim();
  if (f === 'website' && v) { const u = safeUrl(v); if (!u) { toast('That website doesn’t look right (e.g. acme.com)', { icon: 'x', bad: true }); el.value = row.website || ''; return; } v = u; el.value = u; }
  if (f === 'score') {
    const n = v === '' ? null : Math.round(Number(v));
    if (n != null && !(n >= 0 && n <= 100)) { toast('Lead score must be 0–100', { icon: 'x', bad: true }); el.value = row.score ?? ''; return; }
    if ((row.score ?? null) !== n) upd('prospects', id, { score: n });
    return;
  }
  if (f === 'email' && v && !validEmail(v)) { toast('That email doesn’t look right', { icon: 'x', bad: true }); el.value = row.email || ''; return; }
  v = v || null;
  if ((row[f] ?? null) !== v) upd('prospects', id, { [f]: v });
}

/* ════════════════════════ global events ════════════════════════ */
function bindEvents() {
  document.addEventListener('click', (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.target.matches?.('input[type=date]')) { try { e.target.showPicker(); } catch {} }
    const card = e.target.closest?.('[data-card]');
    if (card) { openSheet({ type: 'prospect', id: card.dataset.card }); return; }
    const row = e.target.closest?.('[data-row]');
    if (row && !e.target.closest('a, select, label, button')) { openSheet({ type: 'prospect', id: row.dataset.row }); return; }
    const el = e.target.closest?.('[data-a]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.a]; if (!fn) return;
    if (el.tagName === 'A' && el.dataset.a === 'close-go') e.preventDefault();
    fn(el, e);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Escape' && S.sheet) closeSheet();
    if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[data-card], .dialcard') && !e.repeat) { e.preventDefault(); t.click(); }
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.dataset?.field) t.blur();
  });
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('focusout', () => { if (deferred) { deferred = false; setTimeout(render, 0); } });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset?.field) saveField(t);
    if (t.dataset?.stage) { haptic(6); upd('prospects', t.dataset.stage, { stage: t.value }); }
    if (t.dataset?.ui) { S.ui[t.dataset.ui] = t.value; render(); }
    if (t.dataset?.impsel && S.ui.imp) { S.ui.imp[t.dataset.impsel] = t.value; paintSheet(); }
    if (t.dataset?.map && S.ui.imp) { S.ui.imp.map[t.dataset.map] = Number(t.value) >= 0 ? Number(t.value) : undefined; paintSheet(); }
    if (t.dataset?.file !== undefined && t.files?.[0]) handleFile(t.files[0]);
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset?.input) { S.ui[t.dataset.input] = t.value; S.ui.limit = 100; render(); }
    if (t.dataset?.imp && S.ui.imp) { S.ui.imp[t.dataset.imp] = t.value; paintSheet(); }
    if (t.dataset?.grow !== undefined) growTA(t);
  });
  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'pwform') {
      const cur = f.current.value, next = f.next.value, rep = f.confirm.value, me = meP();
      const err = pwProblem(next, rep, me.username, cur);
      if (err) { S.sheet = { ...S.sheet, error: err }; paintSheet(); return; }
      S.sheet = { ...S.sheet, busy: true, error: null }; paintSheet();
      try {
        await withTimeout(S.api.changePassword(me.username, cur, next), 20000);
        if (me.must_change_password) await upd('profiles', S.me.id, { must_change_password: false });
        S.sheet.locked = false; closeSheet(); toast('Password updated');
      } catch (x) { S.sheet = { ...S.sheet, busy: false, error: x.message }; paintSheet(); }
    }
    if (f.id === 'memberform') {
      const name = f.name.value.trim(), username = f.username.value.trim().toLowerCase();
      if (!name) { S.sheet = { ...S.sheet, error: 'Name is required' }; paintSheet(); return; }
      if (!USERNAME_RE.test(username)) { S.sheet = { ...S.sheet, error: 'Username: 3–30 lowercase letters, numbers, dot, dash or underscore' }; paintSheet(); return; }
      const role = S.sheet.role || 'caller';
      await teamAction('create', { name, username, role }, (r) => openSheet({ type: 'secret', title: `${name} can sign in now`, username: r.username, password: r.password }));
      const g = $('#memberform'); if (g) { g.name.value = name; g.username.value = username; }
    }
  });
  // file drop on the import zone
  document.addEventListener('dragover', (e) => { const z = e.target.closest?.('#dropzone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
  document.addEventListener('dragleave', (e) => { e.target.closest?.('#dropzone')?.classList.remove('over'); });
  document.addEventListener('drop', (e) => { const z = e.target.closest?.('#dropzone'); if (z) { e.preventDefault(); z.classList.remove('over'); handleFile(e.dataTransfer.files?.[0]); } else if (e.dataTransfer?.files?.length) e.preventDefault(); });
  // tooltips
  document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) tipAt(el); else $('#tip').classList.remove('show'); });
  document.addEventListener('touchstart', (e) => { const el = e.target.closest?.('[data-tip]'); if (el) { tipAt(el); setTimeout(() => $('#tip').classList.remove('show'), 1600); } }, { passive: true });
  // swipe the sheet down to close (phones)
  let y0 = null, dy = 0; const sh = $('#sheet');
  sh.addEventListener('touchstart', (e) => { if (sh.scrollTop <= 0 && innerWidth < 700 && !e.target.closest('input,textarea,select')) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  sh.addEventListener('touchend', () => { if (y0 == null) return; sh.style.transition = ''; sh.style.transform = ''; if (dy > 110) closeSheet(); y0 = null; });
  window.addEventListener('hashchange', () => { if (S.sheet && !S.sheet.locked) closeSheet(); paint(); });
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else { if (hiddenAt && Date.now() - hiddenAt > 120000) refresh(); render(); } });
  window.addEventListener('online', () => { toast('Back online'); refresh(); });
  window.addEventListener('offline', () => toast('You’re offline. Changes won’t save', { icon: 'x', bad: true }));
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
  setInterval(() => { if (!document.hidden && !S.sheet) render(); }, 60000);
  bindDrag();
}
function pwProblem(next, rep, username, cur) {
  if (next.length < PW_MIN) return `Use at least ${PW_MIN} characters`;
  if (next.length > 72) return 'Use at most 72 characters';
  if (next !== rep) return 'The two new passwords don’t match';
  if (username && next.toLowerCase().includes(username.toLowerCase())) return 'Don’t include your username';
  if (cur && next === cur) return 'Pick a password different from the current one';
  if (/^(.)\1+$/.test(next) || /^(0123456789|1234567890|password|qwerty)/i.test(next)) return 'That password is too easy to guess';
  return null;
}

function applyTheme() {
  const t = localStorage.getItem('kx-theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
}

/* ════════════════════════ auth screens & boot ════════════════════════ */
function screen(html) { $('#app').innerHTML = `<div class="auth"><div class="box">${html}</div></div>`; }
function authScreen(err = '', help = false) {
  screen(`<form id="authf" autocomplete="on">
    <div class="logo">K</div><h1>KaptainX</h1><p>Sales HQ</p>
    <input class="inp" name="username" placeholder="Username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200" required>
    <div class="pwwrap"><input class="inp" type="password" name="pw" placeholder="Password" autocomplete="current-password" maxlength="72" required><button type="button" class="eye" id="eye" aria-label="Show password">${icon('eye', 'sm')}</button></div>
    <div class="err" role="alert">${esc(err)}</div>
    <button class="btn" type="submit">Sign in</button>
    <button class="switch" type="button" id="forgot">Forgot password?</button>
    ${help ? `<div class="helpbox">Ask a founder to open <b>Account → Team</b>, tap your name and choose <b>Reset password</b>. You’ll get a one-time password and pick a new one when you sign in.</div>` : ''}
  </form>`);
  $('#forgot').onclick = () => authScreen(err, !help);
  $('#eye').onclick = () => { const i = $('#authf').pw; i.type = i.type === 'password' ? 'text' : 'password'; };
  $('#authf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('.btn'); btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span>';
    const id = f.username.value.trim(), pw = f.pw.value;
    try { await withTimeout(S.api.signIn(id, pw), 20000, 'No connection. Check your internet'); S.loginPw = pw; await start(); }
    catch (x) { authScreen(x.message || 'Couldn’t sign in'); const g = $('#authf'); if (g) g.username.value = id; }
  };
}
function forcePassword(p) {
  const known = !!S.loginPw;
  screen(`<form id="forcef" autocomplete="on">
    <div class="logo">${icon('lock', 'lg')}</div><h1>Choose your password</h1><p>Welcome, ${esc(p.name || '')}. Replace the one-time password with your own.</p>
    <input type="text" name="username" value="${esc(p.username || '')}" autocomplete="username" hidden>
    ${known ? '' : `<input class="inp" type="password" name="current" placeholder="One-time password" autocomplete="current-password" required>`}
    <input class="inp" type="password" name="next" placeholder="New password (${PW_MIN}+ characters)" autocomplete="new-password" minlength="${PW_MIN}" maxlength="72" required>
    <input class="inp" type="password" name="rep" placeholder="Repeat new password" autocomplete="new-password" maxlength="72" required>
    <div class="err" role="alert"></div>
    <button class="btn" type="submit">Save and continue</button>
    <button class="switch" type="button" id="so">Sign out</button></form>`);
  $('#so').onclick = async () => { await S.api.signOut(); location.reload(); };
  $('#forcef').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, cur = known ? S.loginPw : f.current.value;
    const err = pwProblem(f.next.value, f.rep.value, p.username, cur);
    if (err) { f.querySelector('.err').textContent = err; return; }
    const btn = f.querySelector('.btn'); btn.disabled = true; btn.innerHTML = '<span class="spinner sm"></span>';
    try {
      await withTimeout(S.api.changePassword(p.username, known ? null : cur, f.next.value), 20000);
      await S.api.update('profiles', p.id, { must_change_password: false });
      S.loginPw = null; await start();
    } catch (x) { f.querySelector('.err').textContent = x.message; btn.disabled = false; btn.textContent = 'Save and continue'; }
  };
}
function noAccess(msg) {
  screen(`<div class="logo">K</div><h1>No access</h1><p>${esc(msg)}</p><button class="btn ghost" id="so">Sign out</button>`);
  $('#so').onclick = async () => { await S.api.signOut(); location.reload(); };
}
function errorScreen(msg, setup) {
  screen(`<div class="logo">K</div><h1>${setup ? 'Almost ready' : 'Can’t connect'}</h1><p>${esc(msg)}</p>${setup ? '' : '<button class="btn" id="retry">Try again</button>'}`);
  $('#retry')?.addEventListener('click', () => location.reload());
}
function shell() {
  $('#app').innerHTML = `<div class="shell"><nav class="side" id="side" aria-label="Main"></nav><main class="main" id="view"></main></div><nav class="tabbar" id="tabbar" aria-label="Main"></nav>`;
}

async function start() {
  const sess = await withTimeout(S.api.session(), 15000, 'No connection. Check your internet');
  if (!sess) return authScreen();
  const p = await withTimeout(S.api.profile(sess.user.id), 15000, 'No connection. Check your internet');
  if (!p?.role) return noAccess('This login isn’t on the team. Ask a founder to add you.');
  if (!p.active) return noAccess('This account has been deactivated. Ask a founder if this is a mistake.');
  S.me = { id: p.id, role: p.role };
  if (p.must_change_password && !S.api.demo) return forcePassword(p);
  $('#app').innerHTML = `<div class="center"><div class="spinner"></div></div>`;
  const data = await withTimeout(S.api.loadAll(), 25000, 'Loading took too long. Check your connection and try again');
  for (const [t, rows] of Object.entries(data)) { S.t[t].clear(); rows.forEach((r) => put(t, r)); }
  put('profiles', p);
  S.loginPw = null;
  shell();
  S.api.subscribe(onRemote, (status) => {
    const live = status === 'SUBSCRIBED';
    if (live && !S.ui.live) refresh();
    if (S.ui.live !== live) { S.ui.live = live; render(); }
  });
  paint();
}

(async function boot() {
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  bindEvents();
  try {
    S.api = await createApi(window.KX_CONFIG);
    S.api.onAuth((evt) => { if (evt === 'SIGNED_OUT' && S.me) location.reload(); });
    await start();
  } catch (e) {
    console.error(e);
    errorScreen(e.message || String(e), !!e.setup);
  }
})();
