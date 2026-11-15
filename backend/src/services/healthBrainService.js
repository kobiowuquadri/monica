import { listCheckIns } from '../repositories/checkIns.js';
import { assessSeries, describeModel } from './healthBrain.js';

const HISTORY_LIMIT = 300;
const RANK = { green: 0, yellow: 1, orange: 2, red: 3 };

/**
 * Health Brain view of a profile: the model description, the assessment of the most recent
 * check-in and the assessment history. Calculated on read from stored check-ins, so it always
 * reflects the current model version and nothing is stored that could go stale.
 */
export async function buildHealthBrain(profileId, { from = null, to = null } = {}) {
  const checkIns = await listCheckIns(profileId, { limit: HISTORY_LIMIT });
  const byId = new Map(checkIns.map((c) => [c.id, c]));
  let history = assessSeries(checkIns).map(({ spike, ...a }) => {
    const c = byId.get(a.checkInId);
    return { ...a, exposureSource: c?.exposure ? { sourceType: c.exposure.sourceType, sourceNote: c.exposure.sourceNote } : null };
  });
  // References use the full history; the date range only limits what is returned.
  if (from) history = history.filter((a) => new Date(a.measuredAt) >= from);
  if (to) history = history.filter((a) => new Date(a.measuredAt) <= to);
  const current = history.length ? history[history.length - 1] : null;
  const bandCounts = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const a of history) bandCounts[a.band] += 1;
  return {
    model: describeModel(),
    current,
    history,
    summary: {
      assessments: history.length,
      bandCounts,
      // Highest band first (a hard trigger outranks a higher score in a lower band), then score.
      peak: history.reduce((best, a) => (!best || RANK[a.band] > RANK[best.band] || (RANK[a.band] === RANK[best.band] && a.score > best.score) ? { score: a.score, band: a.band, measuredAt: a.measuredAt } : best), null),
      usesNasaReplay: history.some((a) => a.exposureSource?.sourceType === 'nasa_replay'),
    },
  };
}
