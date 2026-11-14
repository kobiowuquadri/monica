import { HttpError } from '../middleware/errors.js';
import {
  radiationSeries, radiationCoverage, latestImportRuns, getSourceByKey, toSourceDto, listSpaceWeatherEvents, spaceWeatherCoverage,
} from '../repositories/nasa.js';
import { fetchDonki } from '../nasa/donki.js';
import { DETECTOR_DESCRIPTIONS } from '../nasa/radRdr.js';

const QUALITY_LABELS = {
  no_issues_identified: 'QC 00000000 — no quality control issues identified (RAD_RDR_SIS §4.2.1.2)',
  issues_may_exist: 'QC bit 0 set — unknown quality control issues may exist; excluded from the default view',
  instrument_mode_flagged: 'QC instrument-mode bit set (DAN or Solar Event mode)',
  missing: 'No value in the archive — shown as a gap',
  invalid_value: 'Value not usable (non-numeric or non-physical) — shown as a gap',
};

// Imported NASA data changes only when the CLI importer runs, so responses are cached briefly in memory.
const radCache = new Map();
const RAD_CACHE_MS = 5 * 60 * 1000;

export function _resetRadiationCache() { radCache.clear(); }

/** Historical NASA RAD data from the database. Detectors are returned as separate series. */
export async function getRadiation(args) {
  const key = JSON.stringify([args.from?.toISOString() ?? null, args.to?.toISOString() ?? null, args.detectors]);
  const hit = radCache.get(key);
  if (hit && Date.now() - hit.at < RAD_CACHE_MS) return hit.payload;
  const payload = await loadRadiation(args);
  if (radCache.size > 50) radCache.clear();
  radCache.set(key, { at: Date.now(), payload });
  return payload;
}

async function loadRadiation({ from, to, detectors }) {
  const [rows, coverage, runs, src] = await Promise.all([
    radiationSeries({ from, to, detectors }),
    radiationCoverage(),
    latestImportRuns('msl-rad-rdr', 5),
    getSourceByKey('msl-rad-rdr'),
  ]);
  // Provenance per archive product is listed once; each point references its product by index.
  const series = {};
  for (const det of detectors) series[det] = [];
  const products = [];
  const productIndex = new Map();
  for (const r of rows) {
    if (!productIndex.has(r.product_id)) {
      productIndex.set(r.product_id, products.length);
      products.push({
        productId: r.product_id, sol: r.sol, productCreationTime: r.product_creation_time,
        dataFileUrl: r.data_file_url, labelFileUrl: r.label_file_url,
      });
    }
    series[r.detector].push({
      t: r.observation_start_utc,
      lmst: r.observation_start_lmst,
      sol: r.sol,
      obs: r.observation_number,
      value: r.value,
      valueText: r.value_text,
      quality: r.quality_status,
      qc: r.qc_raw,
      qcFlags: r.qc_flags.length ? r.qc_flags.map((f) => f.code) : undefined,
      duration: r.obs_duration_raw,
      product: productIndex.get(r.product_id),
    });
  }
  const first = rows[0];
  return {
    label: 'Historical NASA data',
    notice: 'Curiosity RAD measurements of the radiation environment at the rover on the Mars surface. Absorbed dose rate as archived — not an astronaut\'s personal dose, not effective dose, and not a live feed.',
    dataset: {
      id: first?.dataset_id || 'MSL-M-RAD-3-RDR-V1.0',
      source: src ? toSourceDto(src) : null,
      quantity: 'absorbed_dose_rate',
      unit: first?.unit || 'microGray / Hour',
      unitDisplay: 'µGy/h',
      channels: detectors.map((d) => ({ detector: d, description: DETECTOR_DESCRIPTIONS[d], archiveField: `OBSnnn_TOT_DOSE_${d}_ELEMENT` })),
      channelsNote: 'Detector B and E values are different measurements and are never added together.',
    },
    qualityLabels: QUALITY_LABELS,
    coverage: coverage.map((c) => ({
      detector: c.detector, firstObservation: c.first_obs, lastObservation: c.last_obs, firstSol: c.first_sol, lastSol: c.last_sol,
      samples: c.total, samplesWithValue: c.with_value, samplesNoIssues: c.no_issues, lastImportedAt: c.last_imported,
    })),
    importRuns: runs,
    fieldNotes: {
      t: 'START_OBS_UTC — observation start time (UTC), RAD_RDR_SIS §4.2.1.2',
      lmst: 'START_OBS_MARS — local mean solar time at the rover',
      value: 'Total dose rate as archived (µGy/h); null = gap',
      valueText: 'Exact characters in the archive file',
      quality: 'MONICA quality status derived from the QC field',
      qc: 'QC field as archived (8-bit string)',
      duration: 'OBS_DURATION as archived; unit not stated in the RDR SIS',
      product: 'Index into products[] (archive file provenance)',
    },
    products,
    series,
  };
}

// ---------------- Space weather ----------------
const RECENT_TYPES = ['FLR', 'SEP', 'CME'];
const CACHE_TTL_MS = 60 * 60 * 1000;
const recentCache = { at: 0, payload: null, inflight: null };

export function _resetSpaceWeatherCache() {
  recentCache.at = 0; recentCache.payload = null; recentCache.inflight = null;
}

const CONTEXT_NOTE = 'DONKI events are space-weather context observed mainly from near-Earth spacecraft and Sun-observing instruments. An Earth-observed event does not establish radiation exposure at Mars, and MONICA never converts flare class into dose or issues a shelter alert from these events.';

/** Historical events stored by the import CLI. */
export async function getStoredSpaceWeather({ from, to, types }) {
  const [events, cov, runs, src] = await Promise.all([
    listSpaceWeatherEvents({ from, to, types }),
    spaceWeatherCoverage(),
    latestImportRuns('donki', 5),
    getSourceByKey('donki'),
  ]);
  return {
    mode: 'stored',
    status: events.length ? 'historical' : (cov?.total ? 'historical' : 'not_imported'),
    label: 'Historical NASA DONKI events (imported)',
    contextNote: CONTEXT_NOTE,
    source: src ? toSourceDto(src) : null,
    coverage: cov?.total ? { firstEvent: cov.first_event, lastEvent: cov.last_event, events: cov.total, lastFetchedAt: cov.last_fetched } : null,
    importRuns: runs,
    events,
  };
}

/**
 * Recent events (last 30 days) fetched live from api.nasa.gov, cached server-side for one hour.
 * On failure returns an honest unavailable state (and a stale cached copy, labelled, if one exists).
 */
export async function getRecentSpaceWeather({ fetchImpl } = {}) {
  const now = Date.now();
  if (recentCache.payload && now - recentCache.at < CACHE_TTL_MS) {
    return { ...recentCache.payload, status: 'cached', cacheAgeSeconds: Math.round((now - recentCache.at) / 1000) };
  }
  if (recentCache.inflight) return recentCache.inflight;
  recentCache.inflight = (async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    const errors = [];
    const events = [];
    for (const type of RECENT_TYPES) {
      try {
        const { records } = await fetchDonki(type, start, end, { fetchImpl, timeoutMs: 12_000 });
        events.push(...records.map((r) => ({
          type: r.eventType, id: r.externalId, time: r.eventTime, observedBy: r.observedBy, summary: r.summary, link: r.link,
        })));
      } catch (err) {
        errors.push({ type, code: err.code || 'upstream_error', message: err.message });
      }
    }
    events.sort((a, b) => new Date(a.time) - new Date(b.time));
    const base = {
      mode: 'recent',
      label: 'Recent NASA DONKI events (last 30 days)',
      window: { start: start.toISOString(), end: end.toISOString() },
      contextNote: CONTEXT_NOTE,
      fetchedAt: new Date().toISOString(),
      errors,
      events,
    };
    if (errors.length === RECENT_TYPES.length) {
      if (recentCache.payload) {
        return { ...recentCache.payload, status: 'stale_cache', errors, cacheAgeSeconds: Math.round((Date.now() - recentCache.at) / 1000) };
      }
      return { ...base, status: 'unavailable', events: [] };
    }
    const payload = { ...base, status: errors.length ? 'partial' : 'live' };
    recentCache.at = Date.now();
    recentCache.payload = payload;
    return payload;
  })();
  try {
    return await recentCache.inflight;
  } finally {
    recentCache.inflight = null;
  }
}

export function parseDetectors(value) {
  if (!value || value === 'both') return ['B', 'E'];
  if (value === 'B' || value === 'E') return [value];
  throw new HttpError(400, 'validation_failed', 'detector must be B, E or both.');
}
