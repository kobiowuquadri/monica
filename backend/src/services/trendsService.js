import { HttpError } from '../middleware/errors.js';
import { VITAL_METRICS, WELLBEING_METRICS, toCelsius } from '../content/metrics.js';
import { vitalSeries, wellbeingSeries } from '../repositories/checkIns.js';
import { activeBaselines } from '../repositories/baselines.js';
import { BASELINE_METHODS } from './baselineService.js';

export const TREND_METRICS = [
  ...Object.entries(VITAL_METRICS).map(([key, d]) => ({ key, label: d.label, kind: 'vital', unit: d.defaultUnit === 'degC' ? '°C' : d.defaultUnit })),
  ...Object.entries(WELLBEING_METRICS).map(([key, d]) => ({ key, label: d.label, kind: 'wellbeing', unit: d.unit })),
];

/**
 * Returns observed points only — no interpolation, smoothing or fabricated values.
 * Temperature readings entered in °F are converted exactly to °C for a single axis and
 * marked `convertedFrom: 'degF'`.
 */
export async function getTrend(profileId, { metric, from, to }) {
  if (VITAL_METRICS[metric]) {
    const rows = await vitalSeries(profileId, metric, { from, to });
    const def = VITAL_METRICS[metric];
    const displayUnit = def.defaultUnit;
    const points = rows.map((r) => ({
      t: r.measuredAt,
      value: metric === 'temperature' ? toCelsius(r.value, r.unit) : r.value,
      originalValue: r.value,
      originalUnit: r.unit,
      convertedFrom: metric === 'temperature' && r.unit === 'degF' ? 'degF' : null,
      activityContext: r.activityContext,
      sourceType: r.sourceType,
      quality: r.quality,
      method: r.method,
      deviceLabel: r.deviceLabel,
      checkInId: r.checkInId,
    }));
    const baselines = await activeBaselines(null, profileId);
    const b = baselines.find((x) => x.metric === metric) || null;
    let baseline = null;
    if (b) {
      baseline = {
        ...b,
        displayValue: metric === 'temperature' ? toCelsius(b.value, b.unit) : b.value,
        methodDescription: BASELINE_METHODS[b.method]?.description,
        appliesTo: 'Resting readings of good or unstated quality',
      };
    }
    return {
      metric, kind: 'vital', label: def.label, unit: displayUnit,
      points,
      counts: countBy(points),
      baseline,
      baselineUnavailableReason: b ? null : 'No baseline has been established for this measurement. Comparison is unavailable.',
    };
  }
  if (WELLBEING_METRICS[metric]) {
    const def = WELLBEING_METRICS[metric];
    const rows = await wellbeingSeries(profileId, def.column, { from, to });
    const points = rows.map((r) => ({ t: r.measuredAt, value: r.value, activityContext: r.activityContext, sourceType: 'self_reported', quality: 'not_stated', checkInId: r.checkInId }));
    return {
      metric, kind: 'wellbeing', label: def.label, unit: def.unit, anchors: def.anchors || null,
      points, counts: countBy(points), baseline: null,
      baselineUnavailableReason: 'Baselines are not used for self-rated wellbeing scales in this prototype.',
    };
  }
  throw new HttpError(400, 'validation_failed', 'Unknown metric.');
}

function countBy(points) {
  const c = { total: points.length, byContext: {}, bySource: {}, byQuality: {} };
  for (const p of points) {
    c.byContext[p.activityContext] = (c.byContext[p.activityContext] || 0) + 1;
    c.bySource[p.sourceType] = (c.bySource[p.sourceType] || 0) + 1;
    c.byQuality[p.quality] = (c.byQuality[p.quality] || 0) + 1;
  }
  return c;
}
