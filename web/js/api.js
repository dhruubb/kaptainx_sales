// Data layer: Supabase in production, an in-browser emulation in demo mode (local preview only).
export const TABLES = ['profiles', 'prospects', 'calls', 'imports', 'activity'];

const isLocal = () => ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

export async function createApi(cfg) {
  const url = String(cfg?.SUPABASE_URL || '').trim();
  if (!url) {
    if (isLocal()) return demoApi();
    throw Object.assign(new Error('This site isn’t connected to its database yet. Fill in web/config.js and redeploy.'), { setup: true });
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url)) throw Object.assign(new Error('SUPABASE_URL in config.js looks wrong. It should look like https://abcd1234.supabase.co'), { setup: true });
  if (/^sb_secret_/.test(cfg.SUPABASE_ANON_KEY || '') || /service_role/.test(atobSafe(String(cfg.SUPABASE_ANON_KEY || '').split('.')[1]))) throw Object.assign(new Error('config.js contains the SECRET key. Replace it with the publishable key right away, and create a new secret key in Supabase.'), { setup: true });
  if (!cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.length < 20) throw Object.assign(new Error('SUPABASE_ANON_KEY is missing in config.js.'), { setup: true });
  return supabaseApi(url.replace(/\/$/, ''), cfg.SUPABASE_ANON_KEY, cfg.LOGIN_DOMAIN || 'team.kaptainx.com');
}

const atobSafe = (s) => { try { return atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } };
const loginEmail = (id, domain) => (id.includes('@') ? id.trim().toLowerCase() : `${id.trim().toLowerCase()}@${domain}`);
const friendly = (e) => {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return 'Wrong username or password';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again';
  if (/failed to fetch|network/i.test(m)) return 'No connection. Check your internet';
  if (/banned/i.test(m)) return 'This account has been deactivated';
  return m || 'Something went wrong';
};

/* ───────────────────────────── Supabase ───────────────────────────── */
async function supabaseApi(url, key, domain) {
  const { createClient } = await import('../vendor/supabase.mjs');
  const sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  const chk = ({ data, error }) => { if (error) throw error; return data; };
  async function all(table, order, asc) {
    const out = [];
    for (let from = 0; from < 100000; from += 1000) {
      const data = chk(await sb.from(table).select('*').order(order, { ascending: asc }).range(from, from + 999));
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }
  let channel = null;
  return {
    demo: false,
    async session() { return chk(await sb.auth.getSession())?.session ?? null; },
    onAuth(cb) { sb.auth.onAuthStateChange((evt, s) => cb(evt, s)); },
    async signIn(id, password) {
      const { error } = await sb.auth.signInWithPassword({ email: loginEmail(id, domain), password });
      if (error) throw new Error(friendly(error));
    },
    async signOut() { try { await sb.auth.signOut(); } catch {} },
    async changePassword(username, current, next) {
      if (current) {
        const { error } = await sb.auth.signInWithPassword({ email: loginEmail(username, domain), password: current });
        if (error) throw new Error(/invalid/i.test(error.message) ? 'Current password is wrong' : friendly(error));
      }
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) throw new Error(/same/i.test(error.message) ? 'New password must be different' : friendly(error));
    },
    async profile(uid) { return chk(await sb.from('profiles').select('*').eq('id', uid).maybeSingle()); },
    async loadAll() {
      const res = {};
      await Promise.all(TABLES.map(async (t) => {
        res[t] = t === 'activity'
          ? chk(await sb.from('activity').select('*').order('created_at', { ascending: false }).limit(800))
          : await all(t, 'created_at', true);
      }));
      return res;
    },
    async insert(table, rows) { return chk(await sb.from(table).insert(Array.isArray(rows) ? rows : [rows]).select()); },
    async update(table, id, patch) { return chk(await sb.from(table).update(patch).eq('id', id).select())?.[0]; },
    async remove(table, id) { chk(await sb.from(table).delete().eq('id', id)); },
    subscribe(cb, onStatus) {
      if (channel) sb.removeChannel(channel);
      channel = sb.channel('kx-sales')
        .on('postgres_changes', { event: '*', schema: 'public' }, (p) => cb(p.table, p.eventType, p.new, p.old))
        .subscribe((status) => onStatus?.(status));
    },
    async team(action, payload) {
      const { data, error } = await sb.functions.invoke('team', { body: { action, ...payload } });
      if (error) {
        let msg = error.message;
        try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch {}
        throw new Error(/fetch|network/i.test(msg) ? 'Couldn’t reach the team service. Is the `team` function deployed?' : msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
  };
}

/* ───────────────────────────── Demo (localhost only) ───────────────────────────── */
const DEMO_KEY = 'kx-sales-demo-v4';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

function demoApi() {
  let db = null;
  let actor = localStorage.getItem('kx-demo-user') || 'u-dhruv';
  let clock = null, seeding = false;
  const subs = [];
  const now = () => (clock ? new Date(clock) : new Date()).toISOString();
  const save = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch {} };
  const emit = (t, type, row, old) => !seeding && setTimeout(() => subs.forEach((cb) => cb(t, type, row, old)), 0);
  const tbl = (t) => db[t];
  const me = () => tbl('profiles').find((p) => p.id === actor);

  function log(a) {
    const row = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), actor, created_at: now(), changes: null, prospect_id: null, entity_id: null, ...a };
    tbl('activity').unshift(row); emit('activity', 'INSERT', row);
  }
  function audit(t, op, n, o) {
    const r = n || o;
    if (t === 'prospects' && op === 'insert' && r.import_id) return;
    let changes = null;
    if (op === 'update') {
      changes = {};
      for (const k of Object.keys(n)) {
        if (['updated_at', 'updated_by', 'created_at', 'created_by', 'call_count', 'last_call_at'].includes(k)) continue;
        if (JSON.stringify(n[k] ?? null) !== JSON.stringify(o[k] ?? null)) changes[k] = [o[k] ?? null, n[k] ?? null];
      }
      if (!Object.keys(changes).length) return;
    }
    const prospect_id = t === 'prospects' ? r.id : r.prospect_id || null;
    let label = r.name || r.company || r.file_name || null;
    if (t === 'calls') { const p = tbl('prospects').find((x) => x.id === prospect_id); label = p ? p.name || p.company : null; changes = { outcome: r.outcome, note: r.note ?? null }; }
    if (t === 'imports') changes = { count: r.count };
    log({ scope: 'sales', entity: t, entity_id: r.id, prospect_id, action: op, label, changes });
  }
  function rawInsert(t, input) {
    const defaults = { prospects: { stage: 'new', call_count: 0 }, imports: { count: 0 } }[t] || {};
    const row = { ...defaults, ...input, id: input.id || uid(), created_at: now() };
    if (t === 'prospects') { row.created_by = actor; row.updated_by = actor; row.updated_at = now(); }
    if (t === 'imports') row.created_by = actor;
    if (t === 'calls') row.caller = actor;
    tbl(t).push(row); emit(t, 'INSERT', { ...row });
    audit(t, 'insert', row, null);
    if (t === 'calls') onCall(row);
    return { ...row };
  }
  function rawUpdate(t, id, patch, silent) {
    const r = tbl(t).find((x) => x.id === id); if (!r) return null;
    const old = { ...r };
    Object.assign(r, patch);
    if (t === 'prospects') { r.updated_by = actor; r.updated_at = now(); }
    emit(t, 'UPDATE', { ...r }, old);
    if (!silent && t === 'prospects') audit(t, 'update', r, old);
    return { ...r };
  }
  function rawRemove(t, id) {
    const r = tbl(t).find((x) => x.id === id); if (!r) return;
    db[t] = tbl(t).filter((x) => x !== r);
    emit(t, 'DELETE', {}, { id });
    if (t === 'prospects') for (const c of tbl('calls').filter((x) => x.prospect_id === id)) { db.calls = tbl('calls').filter((y) => y !== c); emit('calls', 'DELETE', {}, { id: c.id }); }
    if (!(t === 'calls' && !tbl('prospects').some((p) => p.id === r.prospect_id))) audit(t, 'delete', null, r);
    if (t === 'calls') { const p = tbl('prospects').find((p) => p.id === r.prospect_id); if (p) rawUpdate('prospects', p.id, { call_count: Math.max(0, p.call_count - 1) }, true); }
  }
  function onCall(c) {
    const p = tbl('prospects').find((x) => x.id === c.prospect_id); if (!p) return;
    let stage = p.stage;
    if (c.outcome === 'interested' && ['new', 'called', 'lost'].includes(stage)) stage = 'interested';
    else if (c.outcome === 'not_interested' && ['new', 'called'].includes(stage)) stage = 'lost';
    else if (stage === 'new') stage = 'called';
    const patch = { call_count: (p.call_count || 0) + 1, last_call_at: c.created_at, stage };
    if (c.outcome === 'callback') patch.next_followup = c.followup || new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    rawUpdate('prospects', p.id, patch, true);
  }

  function seed() {
    seeding = true;
    db = Object.fromEntries(TABLES.map((t) => [t, []]));
    db.profiles = [
      { id: 'u-dhruv', username: 'dhruv', name: 'Dhruv', role: 'founder', color: '#2a78d6', daily_goal: 40, active: true, must_change_password: false, created_at: new Date(Date.now() - 30 * 864e5).toISOString() },
      { id: 'u-hardik', username: 'hardik', name: 'Hardik', role: 'founder', color: '#eb6834', daily_goal: 30, active: true, must_change_password: false, created_at: new Date(Date.now() - 30 * 864e5).toISOString() },
      { id: 'u-anjika', username: 'anjika', name: 'Anjika', role: 'caller', color: '#6250d6', daily_goal: 50, active: true, must_change_password: false, created_at: new Date(Date.now() - 20 * 864e5).toISOString() },
    ];
    const D = (days, h = 11) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(h, Math.floor(Math.random() * 59)); return Math.min(d.getTime(), Date.now() - 6e5 - Math.random() * 3e6); };
    const as = (who, t) => { actor = who; clock = t; };
    const people = [
      ['Dr. Anil Kulkarni', 'Smile Dental', 'Pune', 'Dental', 'Donna', 'smiledentalpune.in'], ['Rakesh Jain', 'Jain Polymers', 'Bhiwandi', 'Manufacturing', 'Order automation', 'jainpolymers.com'],
      ['Sneha Patil', 'Patil Physio', 'Pune', 'Healthcare', 'Donna', ''], ['Vikram Shah', 'Shah Steel Works', 'Rajkot', 'Manufacturing', 'Order automation', 'shahsteel.co.in'],
      ['Meera Iyer', 'Bloom Salon', 'Mumbai', 'Salon', 'Donna', 'bloomsalon.in'], ['Arjun Rao', 'Rao Exports', 'Nashik', 'Import-export', 'Mercer', 'raoexports.com'],
      ['Kavita Desai', 'Desai Eye Care', 'Pune', 'Healthcare', 'Donna', 'desaieyecare.com'], ['Imran Sheikh', 'Sheikh Auto Parts', 'Aurangabad', 'Manufacturing', 'Order automation', ''],
      ['Neha Gupta', 'FitHub Gym', 'Pune', 'Fitness', 'Donna', 'fithub.in'], ['Suresh Nair', 'Nair Trading Co', 'Mumbai', 'Import-export', 'Mercer', 'nairtrading.com'],
      ['Pooja Mehta', 'Mehta Dental', 'Thane', 'Dental', 'Donna', ''], ['Rohit Kale', 'Kale Packaging', 'Pune', 'Manufacturing', 'Order automation', 'kalepack.in'],
      ['Ananya Bose', 'Bose Realty', 'Kolkata', 'Real estate', 'Donna', 'boserealty.in'], ['Farhan Ali', 'Ali Textiles', 'Surat', 'Import-export', 'Mercer', 'alitextiles.com'],
      ['Deepa Joshi', 'Joshi Clinic', 'Pune', 'Healthcare', 'Donna', ''], ['Manish Agarwal', 'Agarwal Foods', 'Indore', 'Food', 'WhatsApp automation', 'agarwalfoods.in'],
      ['Ritu Sharma', 'Glow Skin Clinic', 'Delhi', 'Healthcare', 'Donna', 'glowskin.in'], ['Kunal Bhatt', 'Bhatt Spices Export', 'Ahmedabad', 'Import-export', 'Mercer', ''],
      ['Swati Kulkarni', 'Little Steps Preschool', 'Pune', 'Education', 'Donna', 'littlesteps.edu.in'], ['Ajay Pawar', 'Pawar Engineering', 'Pimpri', 'Manufacturing', 'Order automation', ''],
      ['Nisha Reddy', 'Reddy Diagnostics', 'Hyderabad', 'Healthcare', 'Donna', 'reddydiagnostics.com'], ['Gaurav Singh', 'Singh Hardware', 'Lucknow', 'Retail', 'WhatsApp automation', ''],
      ['Tanvi More', 'More Interiors', 'Pune', 'Interiors', 'Donna', 'moreinteriors.in'], ['Prakash Yadav', 'Yadav Cargo', 'Nagpur', 'Logistics', 'Fleet tracking', ''],
      ['Harsh Vora', 'Vora Overseas', 'Mumbai', 'Import-export', 'Mercer', 'voraoverseas.com'], ['Lata Menon', 'Menon Dental Care', 'Kochi', 'Dental', 'Donna', ''],
    ];
    as('u-dhruv', D(9, 10));
    const imp = rawInsert('imports', { file_name: 'pune-leads-nov.csv', count: people.length });
    const probs = [
      ['Site takes 16 seconds to load on a phone, so most callers give up', 'I opened your site on my phone. It took about 16 seconds to show anything. Most people hit back before that.'],
      ['Website and Google show two different phone numbers', 'Your Google listing has one number and your website has another. Which one actually reaches you?'],
      ['Tapping the phone number on the site opens a “page not found”', 'When someone taps the phone number at the top of your site, it opens an error page instead of calling you.'],
      ['Misses calls after hours; no one answers evenings or weekends', 'What happens when someone calls you at 8 pm on a Saturday?'],
      ['No online booking; every appointment is a phone call', 'How many appointment calls does your front desk take on a busy day?'],
      ['Orders come in on WhatsApp and get lost between people', 'How do you keep track of orders that come in on WhatsApp today?'],
    ];
    const ps = people.map(([name, company, city, domain, pitch, site], i) => rawInsert('prospects', {
      name, company, city, domain, pitch, website: site ? 'https://' + site + '/' : null,
      problem: probs[i % probs.length][0], opener: probs[i % probs.length][1], score: 45 + ((i * 37) % 50),
      best_time: i % 3 ? '11 AM – 1 PM, 4 – 6 PM' : 'Mornings before 11 AM', timezone: 'India (IST)',
      phone: '+91 98' + String(20000000 + i * 734521).slice(0, 8), import_id: imp.id,
    }));
    const callers = ['u-anjika', 'u-anjika', 'u-dhruv', 'u-hardik', 'u-anjika', 'u-dhruv'];
    const outs = ['no_answer', 'callback', 'no_answer', 'interested', 'not_interested', 'no_answer', 'interested', 'callback', 'no_answer'];
    let n = 0;
    for (let day = 13; day >= 0; day--) {
      const perDay = day === 0 ? 9 : 6 + ((day * 7) % 9);
      for (let k = 0; k < perDay; k++) {
        const p = ps[(n * 5) % ps.length];
        as(callers[n % callers.length], D(day, 10 + (k % 8)));
        rawInsert('calls', { prospect_id: p.id, outcome: outs[(n * 7 + day * 3 + k) % outs.length], note: n % 7 === 1 ? 'Asked to call after 5pm' : null });
        n++;
      }
    }
    as('u-dhruv', D(1, 16)); rawUpdate('prospects', ps[0].id, { stage: 'meeting' });
    as('u-hardik', D(1, 12)); rawUpdate('prospects', ps[3].id, { stage: 'proposal' });
    as('u-dhruv', D(0, 13)); rawUpdate('prospects', ps[6].id, { stage: 'client' });
    as('u-hardik', D(0, 11)); rawUpdate('prospects', ps[9].id, { stage: 'meeting' });
    as('u-dhruv', D(3, 12)); rawInsert('prospects', { name: 'Shree Sai Trucks', company: 'Shree Sai Transport', city: 'Pune', domain: 'Logistics', pitch: 'Fleet tracking', notes: 'Met at expo. Wants fleet tracking demo.' });
    clock = null; actor = localStorage.getItem('kx-demo-user') || 'u-dhruv';
    seeding = false; save();
  }

  try { db = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null'); } catch { db = null; }
  if (!db || !db.profiles) seed();
  if (!db.profiles.some((p) => p.id === actor && p.active)) { actor = 'u-dhruv'; localStorage.setItem('kx-demo-user', actor); }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isFounder = () => me()?.role === 'founder';

  return {
    demo: true,
    setActor(id) { actor = id; localStorage.setItem('kx-demo-user', id); },
    reset() { localStorage.removeItem(DEMO_KEY); seed(); },
    users() { return clone(tbl('profiles').filter((p) => p.active)); },
    async session() { return { user: { id: actor } }; },
    onAuth() {},
    async signIn() {}, async signOut() {},
    async changePassword(_u, _c, next) { if (!next || next.length < 10) throw new Error('Too short'); },
    async profile(id) { return clone(tbl('profiles').find((p) => p.id === id) || null); },
    async loadAll() { const o = {}; for (const t of TABLES) o[t] = clone(t === 'activity' ? tbl(t).slice(0, 800) : tbl(t)); return o; },
    async insert(t, rows) { const out = (Array.isArray(rows) ? rows : [rows]).map((r) => rawInsert(t, clone(r))); save(); return out; },
    async update(t, id, patch) {
      if (t === 'profiles') { const p = tbl('profiles').find((x) => x.id === id); Object.assign(p, patch); emit('profiles', 'UPDATE', { ...p }); save(); return clone(p); }
      const r = rawUpdate(t, id, clone(patch)); save(); return r;
    },
    async remove(t, id) { if (t === 'prospects' && !isFounder()) throw new Error('Only founders can delete leads'); rawRemove(t, id); save(); },
    subscribe(cb, onStatus) { subs.push(cb); onStatus?.('SUBSCRIBED'); },
    async team(action, b) {
      if (!isFounder()) throw new Error('Only founders can manage the team');
      const pw = () => 'demo-' + Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6);
      if (action === 'create') {
        const username = String(b.username || '').toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('Username: 3–30 letters, numbers, dot, dash or underscore');
        if (tbl('profiles').some((p) => p.username === username)) throw new Error('That username is taken');
        const colors = ['#2a78d6', '#eb6834', '#6250d6', '#1baf7a', '#d55181', '#eda100'];
        const p = { id: uid(), username, name: b.name, role: b.role === 'founder' ? 'founder' : 'caller', color: colors[tbl('profiles').length % colors.length], daily_goal: 40, active: true, must_change_password: true, created_at: now() };
        tbl('profiles').push(p); emit('profiles', 'INSERT', { ...p });
        log({ scope: 'team', entity: 'team', entity_id: p.id, action, label: p.name, changes: { username, role: p.role } }); save();
        return { ok: true, username, password: pw() };
      }
      const t = tbl('profiles').find((p) => p.id === b.user_id); if (!t) throw new Error('Member not found');
      const founders = tbl('profiles').filter((p) => p.role === 'founder' && p.active).length;
      if (action === 'reset_password') { t.must_change_password = true; log({ scope: 'team', entity: 'team', entity_id: t.id, action, label: t.name }); save(); return { ok: true, username: t.username, password: pw() }; }
      if (action === 'set_role') { if (t.role === 'founder' && b.role !== 'founder' && founders <= 1) throw new Error('Keep at least one founder'); const old = t.role; t.role = b.role === 'founder' ? 'founder' : 'caller'; emit('profiles', 'UPDATE', { ...t }); log({ scope: 'team', entity: 'team', entity_id: t.id, action, label: t.name, changes: { role: [old, t.role] } }); save(); return { ok: true }; }
      if (action === 'set_active') {
        if (t.id === actor && !b.active) throw new Error('You can’t deactivate yourself');
        if (!b.active && t.role === 'founder' && founders <= 1) throw new Error('Keep at least one founder');
        t.active = !!b.active; emit('profiles', 'UPDATE', { ...t }); log({ scope: 'team', entity: 'team', entity_id: t.id, action, label: t.name, changes: { active: t.active } }); save(); return { ok: true };
      }
      throw new Error('Unknown action');
    },
  };
}
