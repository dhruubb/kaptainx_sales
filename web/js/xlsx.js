// Minimal, dependency-free .xlsx reader (first worksheet → array of rows).
// Uses the browser's built-in DecompressionStream. Old binary .xls is not supported.
const MAX_UNZIPPED = 60 * 1024 * 1024;

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file isn’t a valid .xlsx workbook.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count && off + 46 <= u8.length; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true), usize = dv.getUint32(off + 24, true);
    const nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
    entries[new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nl))] = { method, csize, usize, lho };
    off += 46 + nl + el + cl;
  }
  return async (name) => {
    const e = entries[name];
    if (!e) return null;
    if (e.usize > MAX_UNZIPPED) throw new Error('This workbook is too large.');
    const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return new TextDecoder().decode(data);
    if (e.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('Can’t read this workbook here. Save it as CSV and try again.');
    const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(out);
  };
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const all = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];

export async function readXlsx(buf) {
  const read = await unzip(buf);
  // locate the first worksheet via workbook.xml + its relationships
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = xml(await read('xl/workbook.xml'));
    const first = all(wb, 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || [...first.attributes].find((a) => a.localName === 'id')?.value);
    const rels = xml(await read('xl/_rels/workbook.xml.rels'));
    const rel = all(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target').replace(/^\//, ''); sheetPath = t.startsWith('xl/') ? t : 'xl/' + t; }
  } catch { /* fall back to sheet1 */ }

  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of all(xml(ss), 'si')) shared.push(all(si, 't').filter((t) => t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));

  const sheetXml = await read(sheetPath);
  if (!sheetXml) throw new Error('No worksheet found in this file.');
  const rows = [];
  for (const row of all(xml(sheetXml), 'row')) {
    const out = [];
    let next = 0;
    for (const c of all(row, 'c')) {
      const ref = c.getAttribute('r');
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const t = c.getAttribute('t');
      const v = all(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = all(c, 't').map((x) => x.textContent).join('');
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (!t || t === 'n') { const num = Number(v); val = v !== '' && Number.isFinite(num) && Number.isInteger(num) ? String(BigInt(Math.round(num))) : v; }
      else val = v;
      out[idx] = String(val).trim();
    }
    rows.push(Array.from(out, (x) => x ?? ''));
  }
  return rows;
}
