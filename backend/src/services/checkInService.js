import { withTransaction } from '../db/pool.js';
import { HttpError } from '../middleware/errors.js';
import { validateCheckIn, fingerprintCheckIn, validateIdempotencyKey } from '../validation/checkIn.js';
import { findByIdempotencyKey, insertCheckIn, recentSymptomCodes, getCheckIn, listCheckIns } from '../repositories/checkIns.js';
import { activeBaselines } from '../repositories/baselines.js';
import { insertObservations, listObservations } from '../repositories/observations.js';
import { recordAudit } from '../repositories/audit.js';
import { evaluateCheckIn, RULES_VERSION } from './rulesEngine.js';

/**
 * Creates a check-in, its readings and rule observations in one transaction.
 * Idempotent per (profile, Idempotency-Key):
 *  - same key + same payload → returns the original record (replayed: true), nothing duplicated;
 *  - same key + different payload → 409, nothing written.
 */
export async function createCheckIn({ profile, user, idempotencyKey, body }) {
  const key = validateIdempotencyKey(idempotencyKey);
  const data = validateCheckIn(body);
  const fingerprint = fingerprintCheckIn(data);

  const existing = await findByIdempotencyKey(null, profile.id, key);
  if (existing) return replay(existing, fingerprint, profile.id);

  // Earlier check-ins give the Health Brain its exposure and lymphocyte references.
  const priorCheckIns = await listCheckIns(profile.id, { to: data.measuredAt, limit: 300 });

  try {
    const result = await withTransaction(async (client) => {
      const baselineRows = await activeBaselines(client, profile.id);
      const baselines = new Map(baselineRows.map((b) => [b.metric, b]));
      const t = data.measuredAt;
      const recentSymptoms = await recentSymptomCodes(client, profile.id, new Date(t.getTime() - 72 * 3600_000), t);

      const { id } = await insertCheckIn(client, {
        profileId: profile.id, userId: user.id, idempotencyKey: key, fingerprint, data, rulesVersion: RULES_VERSION,
      });
      const generated = evaluateCheckIn(data, { baselines, recentSymptoms, priorCheckIns });
      const observations = await insertObservations(client, profile.id, id, generated);
      await recordAudit(client, {
        userId: user.id, profileId: profile.id, entityType: 'check_in', entityId: id, action: 'check_in.created',
        metadata: { vitals: data.vitals.length, symptoms: data.symptoms.length, observations: observations.length, rulesVersion: RULES_VERSION },
      });
      for (const o of observations) {
        await recordAudit(client, {
          userId: user.id, profileId: profile.id, entityType: 'observation', entityId: o.id, action: 'observation.generated',
          metadata: { ruleId: o.ruleId, level: o.level, checkInId: id },
        });
      }
      return { id, observations };
    });
    const checkIn = await getCheckIn(profile.id, result.id);
    return { status: 201, body: { checkIn, observations: result.observations, replayed: false } };
  } catch (err) {
    // Concurrent retry with the same key: the unique constraint guarantees one record.
    if (err.code === '23505') {
      const winner = await findByIdempotencyKey(null, profile.id, key);
      if (winner) return replay(winner, fingerprint, profile.id);
    }
    throw err;
  }
}

async function replay(existing, fingerprint, profileId) {
  if (existing.request_fingerprint !== fingerprint) {
    throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key was already used for a different check-in. Start a new check-in to submit different data.');
  }
  const checkIn = await getCheckIn(profileId, existing.id);
  const observations = await listObservations(profileId, { checkInId: existing.id });
  return { status: 200, body: { checkIn, observations, replayed: true } };
}
