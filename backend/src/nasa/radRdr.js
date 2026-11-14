// MSL RAD RDR (MSL-M-RAD-3-RDR-V1.0) reader.
//
// Verified against the archive documentation (see content/sources.js):
//  - RAD_RDR_SIS §4.2.1.2: observation header keys (EDR_FILENAME, START_OBS_MARS (LMST),
//    START_OBS_UTC "YYYY-DDD HH:MM:SS", QC 8-bit field) and QC bit meanings.
//  - RAD_RDR_SIS §4.2.1.6: [DOSIMETRY_TOTAL_DOSE_B: NN] / [DOSIMETRY_TOTAL_DOSE_E: NN] give the
//    total dose for detectors B and E in µGy/h; the label UNIT is "microGray / Hour".
//  - AAREADME.TXT: label byte pointers are 1-based.
//  - RAD_INST.CAT: A/B/C are silicon solid-state detectors; E is a plastic scintillator.
//
// Only the bytes needed are requested, using HTTP Range requests against the per-sol TXT file.

import { fetchWithTimeout, fetchText, UpstreamError } from './http.js';
import { parsePdsLabel, dosimetryElements, parseDayOfYearUtc, parseIsoUtc } from './pdsLabel.js';

export const RAD_BASE_URL = 'https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0';
export const RAD_DATASET_ID = 'MSL-M-RAD-3-RDR-V1.0';

export const DETECTOR_DESCRIPTIONS = {
  B: 'Detector B — silicon solid-state detector in RAD\'s A/B/C detector stack (RAD_INST.CAT). Total dose per RAD_RDR_SIS §4.2.1.6.',
  E: 'Detector E — plastic scintillator (RAD_INST.CAT), also used for neutral-particle detection. Total dose per RAD_RDR_SIS §4.2.1.6.',
};

/** QC bit meanings from RAD_RDR_SIS §4.2.1.2 (bit 0 = least significant / rightmost). */
const QC_BITS = {
  0: { code: 'unknown_qc_issues_may_exist', label: 'Unknown quality control issues may exist' },
  2: { code: 'dan_mode', label: 'RAD is in DAN mode' },
  3: { code: 'solar_event_mode', label: 'RAD was in Solar Event mode' },
};

export function decodeQc(raw) {
  if (raw === null || raw === undefined) {
    return { qcRaw: null, flags: [], qualityStatus: 'missing_qc' };
  }
  const s = String(raw).trim();
  if (!/^[01]{8}$/.test(s)) {
    return { qcRaw: s, flags: [{ code: 'unparseable_qc', label: 'QC value is not an 8-bit field' }], qualityStatus: 'issues_may_exist' };
  }
  const flags = [];
  for (let bit = 0; bit < 8; bit += 1) {
    if (s[7 - bit] === '1') {
      flags.push(QC_BITS[bit] ? { bit, ...QC_BITS[bit] } : { bit, code: `undocumented_bit_${bit}`, label: `Bit ${bit} set (reserved / not documented in the SIS)` });
    }
  }
  let qualityStatus = 'no_issues_identified';
  if (flags.some((f) => f.bit === 0 || f.code.startsWith('undocumented'))) qualityStatus = 'issues_may_exist';
  else if (flags.length) qualityStatus = 'instrument_mode_flagged';
  return { qcRaw: s, flags, qualityStatus };
}

/** Parses an observation header block ("[OBSERVATION: NN]" followed by KEY=VALUE lines). */
export function parseObservationHeader(text, obsNumber) {
  const marker = `[OBSERVATION: ${String(obsNumber).padStart(2, '0')}]`;
  let idx = text.lastIndexOf(marker);
  if (idx === -1) {
    // Observation numbers above 99 may be printed with three digits.
    const alt = `[OBSERVATION: ${String(obsNumber).padStart(3, '0')}]`;
    idx = text.lastIndexOf(alt);
    if (idx === -1) return null;
  }
  const block = text.slice(idx).split(/\r?\n\s*\r?\n\s*\[/)[0];
  const fields = {};
  for (const line of block.split(/\r?\n/).slice(1)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return {
    edrFilename: fields.EDR_FILENAME || null,
    startObsUtc: fields.START_OBS_UTC ? parseDayOfYearUtc(fields.START_OBS_UTC) : null,
    startObsUtcRaw: fields.START_OBS_UTC || null,
    startObsMars: fields.START_OBS_MARS || null,
    obsDurationRaw: fields.OBS_DURATION !== undefined && /^\d+$/.test(fields.OBS_DURATION) ? Number(fields.OBS_DURATION) : null,
    qc: fields.QC ?? null,
  };
}

/** Parses the dosimetry header and both total-dose values from a text window. */
export function parseDoseWindow(text, obsNumber) {
  const nn = String(obsNumber).padStart(2, '0');
  const result = { B: null, E: null, header: {} };
  const hdr = text.match(new RegExp(`\\[DOSIMETRY: ${nn}\\]([\\s\\S]*?)\\[DOSIMETRY_TOTAL_DOSE_B`));
  if (hdr) {
    for (const line of hdr[1].split(/\r?\n/)) {
      const m = line.match(/^\s*(DETECTOR_[A-Z_]+)\s*=\s*([-\d.eE+]+)\s*$/);
      if (m) result.header[m[1]] = Number(m[2]);
    }
  }
  for (const det of ['B', 'E']) {
    const m = text.match(new RegExp(`\\[DOSIMETRY_TOTAL_DOSE_${det}: ${nn}\\]\\s+([^\\s\\[]+)`));
    if (m) result[det] = m[1];
  }
  return result;
}

/** Interprets an archived value string. Non-numeric, non-finite or negative values become gaps. */
export function interpretDoseValue(valueText) {
  if (valueText === null || valueText === undefined) return { value: null, status: 'missing' };
  const v = Number(valueText);
  if (!Number.isFinite(v)) return { value: null, status: 'invalid_value' };
  if (v < 0) return { value: null, status: 'invalid_value' }; // negative dose rate is non-physical
  return { value: v, status: 'ok' };
}

/** Parses a multipart/byteranges body into [{start, end, buf}]. */
export function parseMultipartByteranges(buffer, contentType) {
  const bm = String(contentType).match(/boundary=("?)([^";]+)\1/i);
  if (!bm) throw new UpstreamError('malformed_response', 'multipart response without boundary');
  const boundary = Buffer.from(`--${bm[2]}`, 'latin1');
  const parts = [];
  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    const next = buffer.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const part = buffer.subarray(pos + boundary.length, next);
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headers = part.subarray(0, sep).toString('latin1');
      const cr = headers.match(/content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
      if (cr) {
        const start = Number(cr[1]);
        const end = Number(cr[2]);
        const body = part.subarray(sep + 4, sep + 4 + (end - start + 1));
        if (body.length !== end - start + 1) throw new UpstreamError('malformed_response', 'truncated byte range in multipart response');
        parts.push({ start, end, buf: body });
      }
    }
    pos = next;
  }
  return parts;
}

/** Merges overlapping/adjacent ranges (sorted). Ranges are inclusive [start, end]. */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Fetches several byte ranges of one file. Uses multipart range requests in batches and
 * refuses to download the full file if a server ignores Range.
 */
export async function fetchRanges(url, ranges, { fetchImpl, batchSize = 40, timeoutMs = 60_000 } = {}) {
  const merged = mergeRanges(ranges);
  const pieces = [];
  for (let i = 0; i < merged.length; i += batchSize) {
    const batch = merged.slice(i, i + batchSize);
    const header = `bytes=${batch.map(([s, e]) => `${s}-${e}`).join(',')}`;
    const { res, controller } = await fetchWithTimeout(url, { headers: { Range: header }, timeoutMs, fetchImpl, retries: 2 });
    if (res.status !== 206) {
      controller.abort();
      throw new UpstreamError('range_not_supported', `Expected HTTP 206 for a range request, got ${res.status}`, { status: res.status, url });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    if (/multipart\/byteranges/i.test(ct)) {
      pieces.push(...parseMultipartByteranges(buf, ct));
    } else {
      const cr = (res.headers.get('content-range') || '').match(/bytes\s+(\d+)-(\d+)\//);
      if (!cr) throw new UpstreamError('malformed_response', 'Range response without Content-Range');
      pieces.push({ start: Number(cr[1]), end: Number(cr[2]), buf });
    }
  }
  return {
    slice(start, end) {
      const p = pieces.find((x) => x.start <= start && x.end >= end);
      if (!p) return null;
      return p.buf.subarray(start - p.start, end - p.start + 1).toString('latin1');
    },
  };
}

/** Reads INDEX/INDEX.TAB and returns the latest-version product per surface sol in [fromSol, toSol]. */
export async function findProductsForSols(fromSol, toSol, { fetchImpl } = {}) {
  const text = await fetchText(`${RAD_BASE_URL}/INDEX/INDEX.TAB`, { timeoutMs: 60_000, fetchImpl });
  return selectProductsFromIndex(text, fromSol, toSol);
}

export function selectProductsFromIndex(indexText, fromSol, toSol) {
  const bySol = new Map();
  for (const line of indexText.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, '').trim());
    if (cols.length < 7 || !cols[1].startsWith('/DATA/')) continue;
    const productId = cols[2];
    const m = productId.match(/^RAD_RDR_\d{4}_\d{3}_\d{2}_\d{2}_(\d{4})_V(\d{2})$/);
    if (!m) continue; // cruise products (C-prefixed) and anything unexpected are skipped
    const sol = Number(m[1]);
    const version = Number(m[2]);
    if (sol < fromSol || sol > toSol) continue;
    const prev = bySol.get(sol);
    if (!prev || version > prev.version) {
      bySol.set(sol, {
        sol, version, productId,
        labelPath: cols[1],
        productCreationTime: cols[4],
        startTime: cols[6],
      });
    }
  }
  return [...bySol.values()].sort((a, b) => a.sol - b.sol);
}

/**
 * Reads the dosimetry observations of one sol product.
 * Returns { product, observations: [...], messages: [...] } with values exactly as archived.
 */
export async function readSolDosimetry(product, { fetchImpl } = {}) {
  const labelUrl = `${RAD_BASE_URL}${product.labelPath}`;
  const labelText = await fetchText(labelUrl, { timeoutMs: 90_000, fetchImpl, retries: 2 });
  const label = parsePdsLabel(labelText);
  const elements = dosimetryElements(label);
  const messages = [];
  if (elements.length === 0) {
    messages.push(`${product.productId}: label lists no TOT_DOSE elements.`);
    return { product, label, observations: [], messages };
  }
  const dataFile = elements[0].file;
  const dataUrl = `${RAD_BASE_URL}${product.labelPath.replace(/[^/]+$/, '')}${dataFile}`;

  // Group elements by observation and plan byte windows.
  const byObs = new Map();
  for (const e of elements) {
    if (!byObs.has(e.obsNumber)) byObs.set(e.obsNumber, { obsNumber: e.obsNumber, elements: {}, l1Offset0: e.l1Offset0 });
    byObs.get(e.obsNumber).elements[e.detector] = e;
  }
  const ranges = [];
  const plan = [];
  for (const o of byObs.values()) {
    const offs = Object.values(o.elements).map((e) => e.offset0);
    const doseStart = Math.max(0, Math.min(...offs) - 220);
    const doseEnd = Math.max(...offs) + 48;
    const anchor = o.l1Offset0 ?? Math.min(...offs);
    const hdrStart = Math.max(0, anchor - 2400);
    const hdrEnd = anchor;
    ranges.push([hdrStart, hdrEnd], [doseStart, doseEnd]);
    plan.push({ ...o, hdr: [hdrStart, hdrEnd], dose: [doseStart, doseEnd] });
  }
  const fetched = await fetchRanges(dataUrl, ranges, { fetchImpl });

  const observations = [];
  for (const p of plan) {
    const hdrText = fetched.slice(p.hdr[0], p.hdr[1]);
    const doseText = fetched.slice(p.dose[0], p.dose[1]);
    const header = hdrText ? parseObservationHeader(hdrText, p.obsNumber) : null;
    if (!header || !header.startObsUtc) {
      messages.push(`${product.productId} obs ${p.obsNumber}: observation header/time not found; skipped (no timestamp, cannot place sample).`);
      continue;
    }
    const doses = doseText ? parseDoseWindow(doseText, p.obsNumber) : { B: null, E: null, header: {} };
    const qc = decodeQc(header.qc);
    for (const det of ['B', 'E']) {
      const el = p.elements[det];
      if (!el) continue;
      // Cross-check: the value found via section markers must start at the label pointer.
      const exact = doseText ? doseText.slice(el.offset0 - p.dose[0], el.offset0 - p.dose[0] + (el.bytes || 8)).trim() : null;
      let valueText = doses[det];
      if (valueText !== null && exact !== null && !valueText.startsWith(exact) && !exact.startsWith(valueText)) {
        messages.push(`${product.productId} obs ${p.obsNumber} ${det}: label pointer text "${exact}" disagrees with section text "${valueText}"; stored as gap.`);
        valueText = null;
      }
      const interp = interpretDoseValue(valueText);
      let qualityStatus = qc.qualityStatus === 'missing_qc' ? 'issues_may_exist' : qc.qualityStatus;
      if (interp.status !== 'ok') qualityStatus = interp.status;
      const detHeader = det === 'B'
        ? { DETECTOR_B_THICKNESS_um: doses.header.DETECTOR_B_THICKNESS ?? null, DETECTOR_B_MASS_g: doses.header.DETECTOR_B_MASS ?? null }
        : { DETECTOR_E_MASS_g: doses.header.DETECTOR_E_MASS ?? null };
      observations.push({
        datasetId: label.keywords.DATA_SET_ID || RAD_DATASET_ID,
        productId: label.keywords.PRODUCT_ID || product.productId,
        productCreationTime: parseIsoUtc(label.keywords.PRODUCT_CREATION_TIME),
        sol: product.sol,
        observationNumber: p.obsNumber,
        observationStartUtc: header.startObsUtc,
        observationStartLmst: header.startObsMars ? `Sol ${header.startObsMars} LMST` : null,
        edrFilename: header.edrFilename,
        obsDurationRaw: header.obsDurationRaw,
        detector: det,
        detectorDescription: DETECTOR_DESCRIPTIONS[det],
        quantity: 'absorbed_dose_rate',
        archiveField: el.objectName,
        archiveDescription: `${el.description || 'Dosimetry Total Dose value'} | dosimetry header: ${JSON.stringify(detHeader)}`,
        value: interp.value,
        valueText,
        unit: el.unit || 'microGray / Hour',
        qcRaw: qc.qcRaw,
        qcFlags: qc.flags,
        qualityStatus,
        dataFileUrl: dataUrl,
        labelFileUrl: labelUrl,
        byteOffset: el.offset0,
      });
    }
  }
  return { product, label, observations, messages };
}
