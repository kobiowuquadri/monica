import { Router } from 'express';
import { requireAuth, requireDatabase } from '../middleware/auth.js';
import { loadOwnedProfile } from '../middleware/profileAccess.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { HttpError } from '../middleware/errors.js';
import { isUuid, parseQueryDate } from '../validation/validate.js';
import { validateProfile } from '../validation/profile.js';
import { withTransaction } from '../db/pool.js';
import { listProfiles, insertProfile, updateProfile, toProfileDto } from '../repositories/profiles.js';
import { listCheckIns, getCheckIn } from '../repositories/checkIns.js';
import { listObservations, getObservation } from '../repositories/observations.js';
import { listActions } from '../repositories/actions.js';
import { activeBaselines, allBaselines } from '../repositories/baselines.js';
import { listProfileHistory, recordAudit } from '../repositories/audit.js';
import { createCheckIn } from '../services/checkInService.js';
import { buildOverview } from '../services/overviewService.js';
import { getTrend, TREND_METRICS } from '../services/trendsService.js';
import { establishBaseline, retireBaseline, BASELINE_METHODS } from '../services/baselineService.js';
import { acknowledge, resolve, createAction, patchAction } from '../services/actionService.js';
import { buildReport } from '../services/reportService.js';

export const profilesRouter = Router();
profilesRouter.use('/profiles', requireDatabase, requireAuth, writeLimiter);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function intParam(v, fallback, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

// ---------------- Profiles ----------------
profilesRouter.get('/profiles', wrap(async (req, res) => {
  const rows = await listProfiles(req.user.id);
  res.json({ profiles: rows.map(toProfileDto) });
}));

profilesRouter.post('/profiles', wrap(async (req, res) => {
  const data = validateProfile(req.body);
  const existing = await listProfiles(req.user.id);
  if (existing.length >= 12) throw new HttpError(409, 'profile_limit', 'This prototype allows up to 12 profiles per account.');
  const row = await withTransaction(async (client) => {
    const p = await insertProfile(client, req.user.id, { ...data, isFictional: req.user.isDemo });
    await recordAudit(client, { userId: req.user.id, profileId: p.id, entityType: 'profile', entityId: p.id, action: 'profile.created' });
    return p;
  });
  res.status(201).json({ profile: toProfileDto(row) });
}));

profilesRouter.patch('/profiles/:id', loadOwnedProfile, wrap(async (req, res) => {
  const data = validateProfile(req.body, { partial: true });
  const row = await updateProfile(req.profile.id, req.user.id, data);
  await recordAudit(null, { userId: req.user.id, profileId: req.profile.id, entityType: 'profile', entityId: req.profile.id, action: 'profile.updated', metadata: { fields: Object.keys(data) } });
  res.json({ profile: toProfileDto(row) });
}));

profilesRouter.get('/profiles/:id/overview', loadOwnedProfile, wrap(async (req, res) => {
  res.json(await buildOverview(req.profile));
}));

// ---------------- Check-ins ----------------
profilesRouter.post('/profiles/:id/check-ins', loadOwnedProfile, wrap(async (req, res) => {
  const result = await createCheckIn({ profile: req.profile, user: req.user, idempotencyKey: req.get('Idempotency-Key'), body: req.body });
  res.status(result.status).json(result.body);
}));

profilesRouter.get('/profiles/:id/check-ins', loadOwnedProfile, wrap(async (req, res) => {
  const from = parseQueryDate(req.query.from, 'from');
  const to = parseQueryDate(req.query.to, 'to');
  const checkIns = await listCheckIns(req.profile.id, { from, to, limit: intParam(req.query.limit, 50, 500) });
  res.json({ checkIns });
}));

profilesRouter.get('/profiles/:id/check-ins/:checkInId', loadOwnedProfile, wrap(async (req, res) => {
  if (!isUuid(req.params.checkInId)) throw new HttpError(404, 'check_in_not_found', 'Check-in not found.');
  const checkIn = await getCheckIn(req.profile.id, req.params.checkInId);
  if (!checkIn) throw new HttpError(404, 'check_in_not_found', 'Check-in not found.');
  const observations = await listObservations(req.profile.id, { checkInId: checkIn.id });
  res.json({ checkIn, observations });
}));

// ---------------- Trends & baselines ----------------
profilesRouter.get('/profiles/:id/trends', loadOwnedProfile, wrap(async (req, res) => {
  const metric = String(req.query.metric || 'heart_rate');
  if (!TREND_METRICS.some((m) => m.key === metric)) throw new HttpError(400, 'validation_failed', 'Unknown metric.');
  const from = parseQueryDate(req.query.from, 'from');
  const to = parseQueryDate(req.query.to, 'to');
  const trend = await getTrend(req.profile.id, { metric, from, to });
  res.json({ metrics: TREND_METRICS, ...trend });
}));

profilesRouter.get('/profiles/:id/baselines', loadOwnedProfile, wrap(async (req, res) => {
  const [active, history] = await Promise.all([activeBaselines(null, req.profile.id), allBaselines(req.profile.id)]);
  res.json({ active, history, methods: BASELINE_METHODS });
}));

profilesRouter.post('/profiles/:id/baselines', loadOwnedProfile, wrap(async (req, res) => {
  const baseline = await establishBaseline({ profile: req.profile, user: req.user, body: req.body });
  res.status(201).json({ baseline });
}));

profilesRouter.post('/profiles/:id/baselines/:baselineId/retire', loadOwnedProfile, wrap(async (req, res) => {
  const baseline = await retireBaseline({ profile: req.profile, user: req.user, baselineId: req.params.baselineId });
  res.json({ baseline });
}));

// ---------------- Observations ----------------
profilesRouter.get('/profiles/:id/observations', loadOwnedProfile, wrap(async (req, res) => {
  const status = ['open', 'acknowledged', 'resolved'].includes(req.query.status) ? req.query.status : undefined;
  const category = ['data_quality', 'personal_trend', 'health_concern'].includes(req.query.category) ? req.query.category : undefined;
  const observations = await listObservations(req.profile.id, { status, category, limit: intParam(req.query.limit, 100, 500) });
  res.json({ observations });
}));

profilesRouter.get('/profiles/:id/observations/:obsId', loadOwnedProfile, wrap(async (req, res) => {
  if (!isUuid(req.params.obsId)) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
  const observation = await getObservation(req.profile.id, req.params.obsId);
  if (!observation) throw new HttpError(404, 'observation_not_found', 'Observation not found.');
  const [checkIn, actions, history] = await Promise.all([
    observation.checkInId ? getCheckIn(req.profile.id, observation.checkInId) : null,
    listActions(req.profile.id, { observationId: observation.id }),
    listProfileHistory(req.profile.id, { entityType: 'observation', entityId: observation.id }),
  ]);
  res.json({ observation, supportingCheckIn: checkIn, actions, history });
}));

profilesRouter.post('/profiles/:id/observations/:obsId/acknowledge', loadOwnedProfile, wrap(async (req, res) => {
  res.json({ observation: await acknowledge({ profile: req.profile, user: req.user, observationId: req.params.obsId }) });
}));

profilesRouter.post('/profiles/:id/observations/:obsId/close', loadOwnedProfile, wrap(async (req, res) => {
  res.json({ observation: await resolve({ profile: req.profile, user: req.user, observationId: req.params.obsId }) });
}));

// ---------------- Actions & follow-up ----------------
profilesRouter.get('/profiles/:id/actions', loadOwnedProfile, wrap(async (req, res) => {
  const status = ['recorded', 'planned', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
  res.json({ actions: await listActions(req.profile.id, { status }) });
}));

profilesRouter.post('/profiles/:id/actions', loadOwnedProfile, wrap(async (req, res) => {
  res.status(201).json({ action: await createAction({ profile: req.profile, user: req.user, body: req.body }) });
}));

profilesRouter.patch('/profiles/:id/actions/:actionId', loadOwnedProfile, wrap(async (req, res) => {
  res.json({ action: await patchAction({ profile: req.profile, user: req.user, actionId: req.params.actionId, body: req.body }) });
}));

profilesRouter.get('/profiles/:id/history', loadOwnedProfile, wrap(async (req, res) => {
  res.json({ history: await listProfileHistory(req.profile.id, { limit: intParam(req.query.limit, 100, 500) }) });
}));

// ---------------- Report ----------------
profilesRouter.get('/profiles/:id/report', loadOwnedProfile, wrap(async (req, res) => {
  const from = parseQueryDate(req.query.from, 'from');
  let to = parseQueryDate(req.query.to, 'to');
  if (to && typeof req.query.to === 'string' && req.query.to.length === 10) to = new Date(to.getTime() + 86_400_000 - 1); // inclusive end date
  if (from && to && from > to) throw new HttpError(400, 'validation_failed', '"from" must be before "to".');
  const report = await buildReport({ profile: req.profile, user: req.user, from, to });
  res.set('Cache-Control', 'no-store');
  res.json(report);
}));
