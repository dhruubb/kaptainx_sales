// Small shared helpers (security-relevant ones live here so they're used everywhere).
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

// Only http(s) links ever reach an href. Returns a normalized URL or null.
export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#8e8e93');
export const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
export const waHref = (p) => {
  const raw = String(p || '').trim();
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) d = d.slice(2);
  else if (!raw.startsWith('+') && d.length === 10) d = '91' + d;
  return d.length >= 10 ? `https://wa.me/${d}` : null;
};
export const validEmail = (e) => /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(e || '');
export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
