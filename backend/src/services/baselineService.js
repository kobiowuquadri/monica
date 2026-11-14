import { withTransaction } from '../db/pool.js';
import { HttpError } from '../middleware/errors.js';
import { Validator, rejectUnknownKeys, isUuid } from '../validation/validate.js';
import { VITAL_METRICS } from '../content/metrics.js';
import { retireActive, insertBaseline, eligibleRestingReadings, retireById } from '../repositories/baselines.js';
import { recordAudit } from '../repositories/audit.js';

// MONICA prototype convention — documented in docs/RULES_AND_LIMITATIONS.md.
export const BASELINE_METHODS = {
  recorded_value: {
    version: 'recorded-value-v1',
    description: 'A value entered explicitly by the user from an identified record (e.g. a pre-flight medical record). The source note is required.',
  },
  median_of_resting_readings: {
    version: 'median-resting-v1',
    minSamples: 5,
    description: 'Median of at least 5 MONICA readings taken in a "resting" context with "good" or unstated quality, over a window the user chooses. A prototype convention, not a clinically validated baseline method.',
  },
};

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function establishBaseline({ profile, user, body }) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, ['metric', 'method', 'value', 'unit', 'sourceNote', 'windowStart', 'windowEnd']);
  const metric = v.enumValue('metric', b.metric, Object.keys(VITAL_METRICS), { required: true });
  const method = v.enumValue('method', b.method, Object.keys(BASELINE_METHODS), { required: true });
  const def = metric ? VITAL_METRICS[metric] : null;
  const unit = def ? v.enumValue('unit', b.unit, def.units, { required: true }) : null;
  const sourceNote = v.string('sourceNote', b.sourceNote, { max: 300, required: method === 'recorded_value' });
  let value = null;
  let windowStart = null;
  let windowEnd = null;
  if (method === 'recorded_value' && def) {
    const range = unit && def.inputRange[unit] ? def.inputRange[unit] : def.inputRange;
    value = v.number('value', b.value, { required: true, min: range.min, max: range.max, maxDecimals: def.maxDecimals });
  }
  if (method === 'median_of_resting_readings') {
    if (b.value !== undefined && b.value !== null) v.add('value', 'Not used with the median method; the value is calculated from your readings.');
    windowStart = v.timestamp('windowStart', b.windowStart, { required: true });
    windowEnd = v.timestamp('windowEnd', b.windowEnd, { required: true, notFutureMinutes: 5 });
    if (windowStart && windowEnd && windowStart >= windowEnd) v.add('windowEnd', 'Must be after the window start.');
  }
  v.throwIfInvalid();

  return withTransaction(async (client) => {
    let sampleCount = null;
    if (method === 'median_of_resting_readings') {
      const rows = await eligibleRestingReadings(client, profile.id, metric, unit, windowStart, windowEnd);
      const min = BASELINE_METHODS.median_of_resting_readings.minSamples;
      if (rows.length < min) {
        throw new HttpError(422, 'insufficient_readings',
          `A median baseline needs at least ${min} resting readings of good or unstated quality in the chosen window; found ${rows.length}. No baseline was created.`,
          [{ field: 'windowStart', message: `${rows.length} eligible reading(s) found.` }]);
      }
      value = Math.round(median(rows.map((r) => r.value)) * 100) / 100;
      sampleCount = rows.length;
    }
    await retireActive(client, profile.id, metric);
    const baseline = await insertBaseline(client, profile.id, user.id, {
      metric, method, value, unit, sampleCount, windowStart, windowEnd, sourceNote, methodVersion: BASELINE_METHODS[method].version,
    });
    await recordAudit(client, {
      userId: user.id, profileId: profile.id, entityType: 'baseline', entityId: baseline.id, action: 'baseline.established',
      metadata: { metric, method, sampleCount },
    });
    return baseline;
  });
}

export async function retireBaseline({ profile, user, baselineId }) {
  if (!isUuid(baselineId)) throw new HttpError(404, 'baseline_not_found', 'Baseline not found.');
  return withTransaction(async (client) => {
    const b = await retireById(client, profile.id, baselineId);
    if (!b) throw new HttpError(404, 'baseline_not_found', 'Baseline not found or already retired.');
    await recordAudit(client, { userId: user.id, profileId: profile.id, entityType: 'baseline', entityId: b.id, action: 'baseline.retired', metadata: { metric: b.metric } });
    return b;
  });
}
