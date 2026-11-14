import { VITAL_METRICS, VITAL_METRIC_KEYS } from '../content/metrics.js';
import { listCheckIns } from '../repositories/checkIns.js';
import { listObservations } from '../repositories/observations.js';
import { listActions } from '../repositories/actions.js';
import { allBaselines } from '../repositories/baselines.js';
import { listProfileHistory, recordAudit } from '../repositories/audit.js';
import { toProfileDto } from '../repositories/profiles.js';
import { listSources } from '../repositories/nasa.js';
import { RULES_VERSION, RULE_CATALOGUE } from './rulesEngine.js';
import { BASELINE_METHODS } from './baselineService.js';

export const PROTOTYPE_LIMITATIONS = [
  'MONICA is a hackathon research prototype. It is not a validated diagnostic, monitoring or treatment system.',
  'All health entries are user-entered or user-reported device values; MONICA has no live sensor connection.',
  'Rules are deterministic demonstration rules without verified clinical thresholds; no combined health score is produced.',
  'No clinician-approved treatment protocol is configured; MONICA does not recommend treatment or medication.',
  'NASA radiation data are historical rover measurements of the Mars surface environment (absorbed dose rate) and are not personal dosimetry.',
  'MONICA has not contacted any person or ground team. This summary must be shared through your mission\'s own channels.',
];

/**
 * Builds a report strictly from the given (ownership-checked) profile's records.
 */
export async function buildReport({ profile, user, from, to }) {
  const [checkIns, observations, actions, baselines, history, sources] = await Promise.all([
    listCheckIns(profile.id, { from, to, limit: 500 }),
    listObservations(profile.id, { from, to, limit: 500 }),
    listActions(profile.id, { limit: 500 }),
    allBaselines(profile.id),
    listProfileHistory(profile.id, { limit: 500 }),
    listSources().catch(() => []),
  ]);

  const periodActions = actions.filter((a) => {
    const t = new Date(a.createdAt).getTime();
    const s = a.scheduledFor ? new Date(a.scheduledFor).getTime() : t;
    const inRange = (x) => (!from || x >= from.getTime()) && (!to || x <= to.getTime());
    return inRange(t) || inRange(s);
  });

  // Missing-data notes: describe what is absent instead of implying it was fine.
  const missing = [];
  if (checkIns.length === 0) missing.push('No check-ins were recorded in this period.');
  for (const m of VITAL_METRIC_KEYS) {
    if (!checkIns.some((c) => c.vitals.some((v) => v.metric === m))) missing.push(`${VITAL_METRICS[m].label}: no reading recorded in this period.`);
  }
  const noVitals = checkIns.filter((c) => c.vitals.length === 0).length;
  if (noVitals) missing.push(`${noVitals} check-in(s) contained no vital signs (shown as "Not assessed").`);
  const symptomsNotAssessed = checkIns.filter((c) => c.symptomStatus === 'not_assessed').length;
  if (symptomsNotAssessed) missing.push(`${symptomsNotAssessed} check-in(s) did not assess symptoms (not the same as "no symptoms").`);
  const activeB = baselines.filter((b) => !b.retiredAt);
  if (activeB.length === 0) missing.push('No personal baseline is established, so no baseline comparisons are included.');

  const usedSourceKeys = new Set(['msl-rad-rdr', 'msl-rad-rdr-sis', 'nasa-std-3001-hp']);
  const report = {
    reportType: 'MONICA health review summary',
    generatedAt: new Date().toISOString(),
    generatedFor: { userDisplayName: user.displayName },
    profile: toProfileDto(profile),
    period: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null, timezoneForDisplay: profile.timezone },
    rulesVersion: RULES_VERSION,
    ruleCatalogue: RULE_CATALOGUE,
    baselines: baselines.map((b) => ({ ...b, methodDescription: BASELINE_METHODS[b.method]?.description })),
    checkIns,
    observations,
    actions: periodActions,
    eventHistory: history.filter((h) => {
      const t = new Date(h.createdAt).getTime();
      return (!from || t >= from.getTime()) && (!to || t <= to.getTime());
    }),
    dataProvenance: {
      healthRecords: 'User-entered. Each reading records whether it was entered manually or reported from a device, its stated quality and measurement context.',
      calculatedValues: 'Baseline medians and baseline differences are calculated by MONICA from the identified readings using the documented method versions.',
      nasaSources: sources.filter((s) => usedSourceKeys.has(s.key)),
    },
    missingDataNotes: missing,
    limitations: PROTOTYPE_LIMITATIONS,
  };

  await recordAudit(null, {
    userId: user.id, profileId: profile.id, entityType: 'report', action: 'report.generated',
    metadata: { checkIns: checkIns.length, observations: observations.length, from: report.period.from, to: report.period.to },
  });
  return report;
}
