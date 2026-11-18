// Lead file import: CSV (built-in) and Excel .xlsx (built-in reader, no CDN)
import { readXlsx } from './xlsx.js';
import { safeUrl } from './util.js';

export const MAX_FILE_MB = 10;
export const MAX_ROWS = 20000;

export const FIELDS = [
  { k: 'company', n: 'Business', icon: 'building', max: 200, words: ['business name', 'business', 'company', 'firm', 'organisation', 'organization', 'brand', 'shop', 'clinic', 'store', 'account'] },
  { k: 'name', n: 'Contact name', icon: 'person', max: 200, words: ['owner name', 'contact name', 'contact person', 'name', 'owner', 'full name', 'person', 'client name', 'lead name', 'first name', 'poc', 'decision maker'] },
  { k: 'domain', n: 'Domain', icon: 'tag', max: 120, words: ['domain', 'industry', 'category', 'sector', 'niche', 'vertical', 'business type', 'segment', 'type'] },
  { k: 'problem', n: 'Problem', icon: 'flag', max: 1000, words: ['biggest problem', 'main problem', 'key problem', 'problem', 'pain point', 'pain', 'issue', 'challenge'] },
  { k: 'opener', n: 'Call opener', icon: 'chat', max: 1000, words: ['call opener', 'opener', 'opening line', 'talking point', 'talking points', 'script', 'approach'] },
  { k: 'pitch', n: 'What to pitch', icon: 'target', max: 300, words: ['what to pitch', 'pitch', 'product', 'offer', 'service', 'solution'] },
  { k: 'score', n: 'Lead score', icon: 'star', max: 3, words: ['lead score', 'score', 'priority score'] },
  { k: 'best_time', n: 'Best time to call', icon: 'clock', max: 300, words: ['best time to call', 'best time', 'call time', 'time to call', 'calling time'] },
  { k: 'timezone', n: 'Time zone', icon: 'globe', max: 60, words: ['time zone', 'timezone', 'tz'] },
  { k: 'website', n: 'Website', icon: 'globe', max: 500, words: ['website', 'web site', 'site', 'url', 'web'] },
  { k: 'phone', n: 'Phone', icon: 'phone', max: 40, words: ['phone', 'mobile', 'number', 'contact no', 'contact number', 'whatsapp', 'tel', 'cell', 'ph'] },
  { k: 'email', n: 'Email', icon: 'mail', max: 200, words: ['business email', 'email', 'e-mail', 'mail'] },
  { k: 'city', n: 'City', icon: 'pin', max: 120, words: ['city', 'location', 'area', 'town', 'address', 'region', 'state'] },
  { k: 'notes', n: 'Notes', icon: 'note', max: 5000, words: ['note', 'notes', 'remark', 'remarks', 'comment', 'comments', 'description', 'info'] },
];

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export async function readFile(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`File is over ${MAX_FILE_MB} MB. Split it into smaller files.`);
  const name = file.name.toLowerCase();
  let rows;
  if (/\.(csv|tsv|txt)$/.test(name)) rows = parseCSV(await file.text());
  else if (name.endsWith('.xlsx')) rows = await readXlsx(await file.arrayBuffer());
  else if (name.endsWith('.xls')) throw new Error('Old .xls files aren’t supported. In Excel: File → Save As → .xlsx or CSV.');
  else throw new Error('Use a .csv or .xlsx file.');
  rows = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  let h = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) if (rows[i].filter((c) => String(c).trim()).length >= 2) { h = i; break; }
  const headers = (rows[h] || []).map((c, i) => String(c).trim().slice(0, 80) || `Column ${i + 1}`);
  const body = rows.slice(h + 1, h + 1 + MAX_ROWS).map((r) => headers.map((_, i) => String(r[i] ?? '').trim()));
  return { headers, rows: body, truncated: rows.length - h - 1 > MAX_ROWS };
}

export function autoMap(headers, rows) {
  const map = {}; const used = new Set();
  const norm = (s) => s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[_\-.?:]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Score every (field, column) pair, then assign best matches first so a strong
  // match (e.g. "Lead score") is never stolen by a weaker one (e.g. "PageSpeed score").
  const cands = [];
  for (const f of FIELDS) headers.forEach((h, i) => {
    const n = norm(h); let best = 0;
    for (const w of f.words) {
      const base = n === w ? 4 : n.startsWith(w + ' ') || n.endsWith(' ' + w) ? 3 : n.includes(w) && w.length > 3 ? 2 : 0;
      if (base) best = Math.max(best, base * 100 + w.length);
    }
    if (best) cands.push({ k: f.k, i, s: best });
  });
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) if (map[c.k] == null && !used.has(c.i)) { map[c.k] = c.i; used.add(c.i); }
  const sniff = (test) => headers.findIndex((_, i) => !used.has(i) && rows.slice(0, 25).filter((r) => test(r[i])).length >= Math.min(3, rows.length));
  if (map.phone == null) { const i = sniff((v) => (v || '').replace(/\D/g, '').length >= 10 && !/[a-z]/i.test(v || '')); if (i >= 0) { map.phone = i; used.add(i); } }
  if (map.email == null) { const i = sniff((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v || '')); if (i >= 0) { map.email = i; used.add(i); } }
  if (map.website == null) { const i = sniff((v) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+\.[a-z.]{2,}(\/|$)/i.test(v || '')); if (i >= 0) { map.website = i; used.add(i); } }
  return map;
}

export const normPhone = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};

const NOT_FOUND = /^(not found|n\/?a|none|nil|-+|—|unknown)\b/i;
const SKIP_EXTRA = /^(#|s\.?\s?no\.?|sr\.?\s?no\.?|no\.?|index|id)$/i;

// Guess the country code for numbers written without one (US-style files → +1, otherwise +91)
export function guessCountryCode({ headers, rows }, map) {
  const tz = map.timezone, city = map.city, phone = map.phone;
  const sample = rows.slice(0, 40);
  if (tz != null && sample.some((r) => /\b(ET|CT|MT|PT|Eastern|Central|Mountain|Pacific|Alaska|Hawaii)\b/i.test(r[tz] || ''))) return '+1';
  if (city != null && sample.filter((r) => /,\s*[A-Z]{2}$/.test(r[city] || '')).length >= Math.min(3, sample.length)) return '+1';
  if (phone != null && sample.filter((r) => /^\(\d{3}\)\s?\d{3}-\d{4}$/.test((r[phone] || '').trim())).length >= Math.min(3, sample.length)) return '+1';
  return '+91';
}
export function withCountryCode(phone, cc) {
  const p = String(phone || '').trim();
  if (!p || !cc || p.startsWith('+') || p.startsWith('00')) return p;
  const d = p.replace(/\D/g, '');
  if (cc === '+1' && d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length === 10) return `${cc} ${p.replace(/^0+/, '')}`;
  if (cc === '+91' && d.length === 11 && d.startsWith('0')) return `+91 ${d.slice(1)}`;
  return p;
}

export function buildRows({ headers, rows }, map, keepExtra, existing, cc = '') {
  const seenPhones = new Set(existing.map((p) => normPhone(p.phone)).filter((x) => x.length >= 6));
  const seenEmails = new Set(existing.map((p) => (p.email || '').toLowerCase()).filter(Boolean));
  const mapped = new Set(Object.values(map).filter((i) => i != null && i >= 0));
  const out = []; let dupes = 0, empty = 0;
  for (const r of rows) {
    const o = {}; const extraNotes = [];
    for (const f of FIELDS) {
      const i = map[f.k];
      let v = i != null && i >= 0 ? String(r[i] || '').trim() : '';
      if (!v) continue;
      if (f.k === 'name') {
        // "Jane Doe (owner, per About page)" → name "Jane Doe", details kept in notes
        if (NOT_FOUND.test(v)) { if (v.length > 12) extraNotes.push(`Owner: ${v}`); continue; }
        const m = v.match(/^([^(]{2,}?)\s*\((.+)\)\s*$/);
        if (m) { extraNotes.push(`Owner: ${v}`); v = m[1].trim(); }
      } else if (f.k !== 'notes' && NOT_FOUND.test(v)) continue;
      if (f.k === 'score') { const n = Math.round(Number(String(v).replace(/[^\d.]/g, ''))); if (Number.isFinite(n) && n >= 0 && n <= 100) o.score = n; continue; }
      o[f.k] = v.slice(0, f.max);
    }
    if (o.phone && cc) o.phone = withCountryCode(o.phone, cc).slice(0, 40);
    if (extraNotes.length) o.notes = [o.notes, ...extraNotes].filter(Boolean).join('\n');
    if (o.website) { const u = safeUrl(o.website); if (u) o.website = u.slice(0, 500); else delete o.website; }
    if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) { o.notes = [o.notes, `Email: ${o.email}`].filter(Boolean).join('\n'); delete o.email; }
    if (o.notes) o.notes = o.notes.slice(0, 5000);
    if (keepExtra) {
      const extra = headers.map((h, i) => (!mapped.has(i) && r[i] && !SKIP_EXTRA.test(h.trim()) && !/^not found$/i.test(r[i].trim()) ? `${h}: ${r[i]}` : null)).filter(Boolean);
      if (extra.length) o.notes = [o.notes, ...extra].filter(Boolean).join('\n').slice(0, 5000);
    }
    if (o.notes) o.notes = o.notes.slice(0, 5000);
    if (!o.name && !o.company && !o.phone && !o.email) { empty++; continue; }
    const ph = normPhone(o.phone), em = (o.email || '').toLowerCase();
    if ((ph.length >= 6 && seenPhones.has(ph)) || (em && seenEmails.has(em))) { dupes++; continue; }
    if (ph.length >= 6) seenPhones.add(ph);
    if (em) seenEmails.add(em);
    out.push(o);
  }
  return { rows: out, dupes, empty };
}
