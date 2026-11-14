// Minimal PDS3 detached-label reader for the MSL RAD RDR products.
// Reference: AAREADME.TXT "PDS Label Format" — pointers of the form
//   ^OBJECT = ("FILE.TXT", n <BYTES>)
// where n is the starting byte counting from 1 (1-based).

function stripQuotes(v) {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\s+/g, ' ').trim() : t;
}

export function parsePdsLabel(text) {
  const label = { keywords: {}, pointers: {}, objects: {} };

  // Byte pointers (may wrap onto the following line).
  const ptrRe = /\^(\w+)\s*=\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*<BYTES>\s*\)/g;
  for (const m of text.matchAll(ptrRe)) {
    label.pointers[m[1]] = { file: m[2], startByte1: Number(m[3]), offset0: Number(m[3]) - 1 };
  }

  // OBJECT blocks (non-nested in these labels).
  const objRe = /^\s*OBJECT\s*=\s*(\w+)\s*$([\s\S]*?)^\s*END_OBJECT\s*=\s*\1\s*$/gm;
  for (const m of text.matchAll(objRe)) {
    const body = m[2];
    const obj = {};
    const kvRe = /^\s*([A-Z_^]+)\s*=\s*("[\s\S]*?"|[^\r\n]*)/gm;
    for (const kv of body.matchAll(kvRe)) obj[kv[1]] = stripQuotes(kv[2].replace(/\/\*.*?\*\//g, ''));
    label.objects[m[1]] = obj;
  }

  // Top-level keywords of interest (outside OBJECT blocks; first occurrence wins).
  for (const key of ['DATA_SET_ID', 'PRODUCT_ID', 'PRODUCT_CREATION_TIME', 'START_TIME', 'STOP_TIME', 'INSTRUMENT_NAME', 'INSTRUMENT_HOST_NAME']) {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*("[^"]*"|[^\\r\\n]*)`, 'm'));
    if (m) label.keywords[key] = stripQuotes(m[1]);
  }
  return label;
}

/**
 * Extracts the dosimetry total-dose elements per observation from a RAD RDR label.
 * Returns [{ obsNumber, detector, objectName, offset0, bytes, unit, description, l1Offset0 }].
 */
export function dosimetryElements(label) {
  const out = [];
  for (const [name, ptr] of Object.entries(label.pointers)) {
    const m = name.match(/^OBS(\d+)_TOT_DOSE_([BE])_ELEMENT$/);
    if (!m) continue;
    const obj = label.objects[name] || {};
    const l1 = label.pointers[`OBS${m[1]}_L1_TABLE`];
    out.push({
      obsNumber: Number(m[1]),
      detector: m[2],
      objectName: name,
      file: ptr.file,
      offset0: ptr.offset0,
      bytes: obj.BYTES ? Number(obj.BYTES) : null,
      dataType: obj.DATA_TYPE || null,
      unit: obj.UNIT || null,
      description: obj.DESCRIPTION || null,
      l1Offset0: l1 ? l1.offset0 : null,
    });
  }
  return out.sort((a, b) => a.obsNumber - b.obsNumber || a.detector.localeCompare(b.detector));
}

/** Parses a PDS "YYYY-DDDTHH:MM:SS" or RDR "YYYY-DDD HH:MM:SS" day-of-year timestamp as UTC. */
export function parseDayOfYearUtc(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{3})[T ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  const [, y, doy, hh, mm, ss] = m;
  const day = Number(doy);
  if (day < 1 || day > 366) return null;
  const ms = Date.UTC(Number(y), 0, 1) + (day - 1) * 86_400_000 + Number(hh) * 3_600_000 + Number(mm) * 60_000 + Math.round(Number(ss) * 1000);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(y)) return null; // day 366 in a non-leap year
  return d;
}

/** Parses an ISO-like "YYYY-MM-DDTHH:MM:SS" (PRODUCT_CREATION_TIME) as UTC. */
export function parseIsoUtc(s) {
  const m = String(s || '').trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/);
  if (!m) return parseDayOfYearUtc(s);
  return new Date(`${m[1]}T${m[2]}${m[3] || ''}Z`);
}
