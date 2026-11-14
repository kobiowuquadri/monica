// NASA DONKI client via the api.nasa.gov endpoints documented at https://api.nasa.gov/
// (CME, FLR, SEP, GST, IPS; startDate/endDate as yyyy-MM-dd; api_key).
// Only fields present in the upstream record are surfaced; nothing is inferred about Mars.

import { config } from '../config.js';
import { fetchWithTimeout, UpstreamError } from './http.js';

export const DONKI_BASE = 'https://api.nasa.gov/DONKI';
export const DONKI_TYPES = ['FLR', 'SEP', 'CME', 'GST', 'IPS'];

const ID_FIELD = { FLR: 'flrID', SEP: 'sepID', CME: 'activityID', GST: 'gstID', IPS: 'activityID' };

function instrumentNames(rec) {
  return Array.isArray(rec.instruments)
    ? rec.instruments.map((i) => (i && typeof i.displayName === 'string' ? i.displayName : null)).filter(Boolean)
    : [];
}

function linked(rec) {
  return Array.isArray(rec.linkedEvents) ? rec.linkedEvents.map((e) => e?.activityID).filter(Boolean) : [];
}

function validTime(s) {
  if (typeof s !== 'string') return null;
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Normalises one DONKI record. Returns null when required identity/time fields are missing. */
export function normaliseDonkiRecord(type, rec) {
  if (!rec || typeof rec !== 'object') return null;
  const externalId = rec[ID_FIELD[type]];
  if (typeof externalId !== 'string' || !externalId) return null;
  let eventTime = null;
  const summary = {};
  switch (type) {
    case 'FLR':
      eventTime = validTime(rec.peakTime) || validTime(rec.beginTime);
      Object.assign(summary, {
        beginTime: rec.beginTime ?? null, peakTime: rec.peakTime ?? null, endTime: rec.endTime ?? null,
        classType: rec.classType ?? null, sourceLocation: rec.sourceLocation ?? null, activeRegionNum: rec.activeRegionNum ?? null,
      });
      break;
    case 'SEP':
      eventTime = validTime(rec.eventTime);
      Object.assign(summary, { eventTime: rec.eventTime ?? null });
      break;
    case 'CME': {
      eventTime = validTime(rec.startTime);
      const analyses = Array.isArray(rec.cmeAnalyses) ? rec.cmeAnalyses : [];
      const best = analyses.find((a) => a?.isMostAccurate) || analyses[0] || null;
      Object.assign(summary, {
        startTime: rec.startTime ?? null, sourceLocation: rec.sourceLocation || null, activeRegionNum: rec.activeRegionNum ?? null,
        note: typeof rec.note === 'string' ? (rec.note.length > 600 ? `${rec.note.slice(0, 597).trimEnd()}…` : rec.note) : null,
        analysis: best ? { speedKmPerS: best.speed ?? null, type: best.type ?? null, halfAngleDeg: best.halfAngle ?? null, time21_5: best.time21_5 ?? null } : null,
      });
      break;
    }
    case 'GST': {
      eventTime = validTime(rec.startTime);
      const kp = Array.isArray(rec.allKpIndex) ? rec.allKpIndex : [];
      const maxKp = kp.reduce((m, k) => (typeof k?.kpIndex === 'number' && k.kpIndex > m ? k.kpIndex : m), -1);
      Object.assign(summary, { startTime: rec.startTime ?? null, maxKpIndex: maxKp >= 0 ? maxKp : null, kpSources: [...new Set(kp.map((k) => k?.source).filter(Boolean))] });
      break;
    }
    case 'IPS':
      eventTime = validTime(rec.eventTime);
      Object.assign(summary, { eventTime: rec.eventTime ?? null, location: rec.location ?? null, catalog: rec.catalog ?? null });
      break;
    default:
      return null;
  }
  if (!eventTime) return null;
  const observedBy = instrumentNames(rec);
  return {
    eventType: type,
    externalId,
    eventTime,
    observedBy,
    // IPS records carry an explicit observing location; for other types only instruments are known.
    observingLocation: type === 'IPS' ? (rec.location ?? null) : null,
    summary: { ...summary, linkedEvents: linked(rec), observingLocation: type === 'IPS' ? (rec.location ?? null) : null },
    link: typeof rec.link === 'string' && rec.link.startsWith('https://') ? rec.link : null,
    raw: rec,
  };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetches one DONKI type for a date range. Throws UpstreamError on timeouts, HTTP errors,
 * rate limiting or malformed (non-array) JSON. An empty body is a valid "no events" answer.
 */
export async function fetchDonki(type, startDate, endDate, { fetchImpl, timeoutMs = 20_000 } = {}) {
  if (!DONKI_TYPES.includes(type)) throw new Error(`Unsupported DONKI type ${type}`);
  const apiKey = config.nasaApiKey || 'DEMO_KEY';
  const url = `${DONKI_BASE}/${type}?startDate=${ymd(startDate)}&endDate=${ymd(endDate)}&api_key=${encodeURIComponent(apiKey)}`;
  const safeUrl = url.replace(/api_key=[^&]+/, 'api_key=***');
  const { res } = await fetchWithTimeout(url, { timeoutMs, fetchImpl, retries: 1 });
  if (res.status === 429) {
    await res.body?.cancel?.();
    throw new UpstreamError('rate_limited', 'api.nasa.gov rate limit reached (configure NASA_API_KEY for higher limits).', { status: 429, url: safeUrl });
  }
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new UpstreamError('upstream_http_error', `DONKI ${type} returned HTTP ${res.status}`, { status: res.status, url: safeUrl });
  }
  const text = await res.text();
  if (text.trim() === '') return { records: [], malformed: 0, url: safeUrl };
  let json;
  try { json = JSON.parse(text); } catch {
    throw new UpstreamError('malformed_response', `DONKI ${type} response was not valid JSON`, { url: safeUrl });
  }
  if (!Array.isArray(json)) {
    throw new UpstreamError('malformed_response', `DONKI ${type} response was not a list`, { url: safeUrl });
  }
  const records = [];
  let malformed = 0;
  for (const rec of json) {
    const n = normaliseDonkiRecord(type, rec);
    if (n) records.push(n); else malformed += 1;
  }
  return { records, malformed, url: safeUrl };
}
