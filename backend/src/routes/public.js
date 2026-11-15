import { Router } from 'express';
import { hasDatabase } from '../config.js';
import { requireDatabase } from '../middleware/auth.js';
import { getPool } from '../db/pool.js';
import { parseQueryDate } from '../validation/validate.js';
import { HttpError } from '../middleware/errors.js';
import { listSources, radiationCoverage, spaceWeatherCoverage } from '../repositories/nasa.js';
import { getRadiation, getStoredSpaceWeather, getRecentSpaceWeather, parseDetectors } from '../services/environmentService.js';
import { LEARNING_CARDS } from '../content/learning.js';
import { SOURCES } from '../content/sources.js';
import { RULE_CATALOGUE, RULES_VERSION } from '../services/rulesEngine.js';
import { VITAL_METRICS, EXPOSURE_INPUT, LYMPHOCYTE_INPUT, WELLBEING_METRICS, SYMPTOMS, ACTIVITY_CONTEXTS } from '../content/metrics.js';
import { describeModel } from '../services/healthBrain.js';
import { BASELINE_METHODS } from '../services/baselineService.js';
import { DONKI_TYPES } from '../nasa/donki.js';

export const publicRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Liveness: the process is up. Always 200; reports configuration state honestly.
publicRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'monica-api', database: hasDatabase() ? 'configured' : 'not_configured', time: new Date().toISOString() });
});

// Readiness: can we serve requests that need the database?
publicRouter.get('/ready', async (_req, res) => {
  if (!hasDatabase()) {
    return res.status(503).json({ status: 'not_ready', database: 'not_configured', message: 'Database functionality is unavailable: DATABASE_URL is not configured.' });
  }
  try {
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM schema_migrations");
    return res.json({ status: 'ready', database: 'reachable', migrationsApplied: rows[0].n });
  } catch (err) {
    return res.status(503).json({ status: 'not_ready', database: 'unreachable', message: err.code === '42P01' ? 'Migrations have not been run.' : 'Database could not be reached.' });
  }
});

// Lightweight summary of imported NASA data for the public landing page (real counts only).
let catalogCache = { at: 0, payload: null };
publicRouter.get('/catalog', requireDatabase, wrap(async (_req, res) => {
  if (!catalogCache.payload || Date.now() - catalogCache.at > 5 * 60 * 1000) {
    const [rad, sw] = await Promise.all([radiationCoverage(), spaceWeatherCoverage()]);
    catalogCache = {
      at: Date.now(),
      payload: {
        radiation: rad.length ? {
          datasetId: rad[0].dataset_id,
          detectors: rad.map((r) => r.detector),
          samples: rad.reduce((n, r) => n + r.total, 0),
          firstObservation: rad.reduce((m, r) => (m && m < r.first_obs ? m : r.first_obs), null),
          lastObservation: rad.reduce((m, r) => (m && m > r.last_obs ? m : r.last_obs), null),
          firstSol: Math.min(...rad.map((r) => r.first_sol)),
          lastSol: Math.max(...rad.map((r) => r.last_sol)),
        } : null,
        spaceWeather: sw?.total ? { events: sw.total, firstEvent: sw.first_event, lastEvent: sw.last_event } : null,
        sources: SOURCES.length,
        label: 'Historical NASA data imported into this deployment',
      },
    };
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json(catalogCache.payload);
}));

publicRouter.get('/radiation', requireDatabase, wrap(async (req, res) => {
  const from = parseQueryDate(req.query.from, 'from');
  const to = parseQueryDate(req.query.to, 'to');
  const detectors = parseDetectors(req.query.detector);
  res.set('Cache-Control', 'public, max-age=300');
  res.json(await getRadiation({ from, to, detectors }));
}));

publicRouter.get('/space-weather', wrap(async (req, res) => {
  const mode = req.query.mode === 'recent' ? 'recent' : 'stored';
  if (mode === 'recent') {
    return res.json(await getRecentSpaceWeather());
  }
  if (!hasDatabase()) throw new HttpError(503, 'database_unavailable', 'Database functionality is unavailable: DATABASE_URL is not configured on the server.');
  const from = parseQueryDate(req.query.from, 'from');
  const to = parseQueryDate(req.query.to, 'to');
  const types = typeof req.query.types === 'string' ? req.query.types.split(',').filter((t) => DONKI_TYPES.includes(t)) : undefined;
  return res.json(await getStoredSpaceWeather({ from, to, types }));
}));

publicRouter.get('/sources', wrap(async (_req, res) => {
  // Registry content is defined in code; the database copy adds import-time retrieval dates.
  let sources = SOURCES.map((s) => ({ ...s, fromDatabase: false }));
  if (hasDatabase()) {
    try {
      const db = await listSources();
      if (db.length) sources = db.map((s) => ({ ...s, fromDatabase: true }));
    } catch { /* fall back to code registry */ }
  }
  res.json({ sources, learning: LEARNING_CARDS });
}));

publicRouter.get('/reference', (_req, res) => {
  res.json({
    rulesVersion: RULES_VERSION,
    rules: RULE_CATALOGUE,
    vitalMetrics: VITAL_METRICS,
    wellbeingMetrics: WELLBEING_METRICS,
    symptoms: SYMPTOMS,
    activityContexts: ACTIVITY_CONTEXTS,
    baselineMethods: BASELINE_METHODS,
    exposureInput: EXPOSURE_INPUT,
    lymphocyteInput: LYMPHOCYTE_INPUT,
    healthBrain: describeModel(),
    inputRangeNote: 'Input ranges catch typing errors only. They are not clinical reference ranges and are never used to label a reading as normal or abnormal.',
  });
});
