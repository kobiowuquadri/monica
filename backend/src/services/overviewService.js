import { VITAL_METRICS, VITAL_METRIC_KEYS, WELLBEING_METRICS } from '../content/metrics.js';
import { latestVitals, latestWellbeing, listCheckIns, countCheckIns, qualitySummary } from '../repositories/checkIns.js';
import { activeBaselines } from '../repositories/baselines.js';
import { listObservations, observationCounts } from '../repositories/observations.js';
import { listActions } from '../repositories/actions.js';
import { radiationCoverage, spaceWeatherCoverage } from '../repositories/nasa.js';
import { toProfileDto } from '../repositories/profiles.js';
import { LEARNING_CARDS } from '../content/learning.js';
import { buildHealthBrain } from './healthBrainService.js';

/**
 * Overview is assembled from separate categories: the Health Brain index (a labelled prototype
 * triage index), health observations, data quality, personal-trend context and environment
 * (NASA, historical). NASA environment data is never merged into personal records.
 */
export async function buildOverview(profile) {
  const [latest, wellbeing, recent, counts, quality, baselines, openObs, obsCounts, planned, radCov, swCov, healthBrain] = await Promise.all([
    latestVitals(profile.id),
    latestWellbeing(profile.id),
    listCheckIns(profile.id, { limit: 5 }),
    countCheckIns(profile.id),
    qualitySummary(profile.id),
    activeBaselines(null, profile.id),
    listObservations(profile.id, { status: 'open', limit: 6 }),
    observationCounts(profile.id),
    listActions(profile.id, { status: 'planned', limit: 6 }),
    radiationCoverage(),
    spaceWeatherCoverage(),
    buildHealthBrain(profile.id),
  ]);

  const latestByMetric = Object.fromEntries(latest.map((r) => [r.metric, r]));
  const vitals = VITAL_METRIC_KEYS.map((metric) => ({
    metric,
    label: VITAL_METRICS[metric].label,
    reading: latestByMetric[metric] || null,                  // null → "No reading recorded"
    hasBaseline: baselines.some((b) => b.metric === metric),
  }));

  const wb = Object.entries(WELLBEING_METRICS).map(([key, def]) => ({
    metric: key,
    label: def.label,
    unit: def.unit,
    anchors: def.anchors || null,
    reading: wellbeing?.[key] ? { value: Number(wellbeing[key].value), measuredAt: wellbeing[key].measured_at } : null,
  }));

  const sourceCounts = { manual: 0, device_reported: 0 };
  const qualityCounts = { good: 0, uncertain: 0, poor: 0, not_stated: 0 };
  for (const q of quality) {
    sourceCounts[q.source_type] += q.n;
    qualityCounts[q.quality] += q.n;
  }

  const byCategory = { data_quality: 0, personal_trend: 0, health_concern: 0 };
  const byLevel = { info: 0, attention: 0, urgent_review: 0 };
  for (const c of obsCounts) { byCategory[c.category] += c.n; byLevel[c.level] += c.n; }

  const card = LEARNING_CARDS[(counts.n + 1) % LEARNING_CARDS.length];

  return {
    generatedAt: new Date().toISOString(),
    profile: toProfileDto(profile),
    checkIns: { total: counts.n, lastMeasuredAt: counts.last },
    healthBrain,
    vitals,
    wellbeing: wb,
    baselines,
    recentCheckIns: recent.map((c) => ({
      id: c.id, measuredAt: c.measuredAt, activityContext: c.activityContext,
      vitalsCount: c.vitals.length, symptomsCount: c.symptoms.length, symptomStatus: c.symptomStatus,
      symptoms: c.symptoms.map((s) => ({ label: s.label, severity: s.severity, markedUrgent: s.markedUrgent })),
    })),
    observations: { open: openObs, openByCategory: byCategory, openByLevel: byLevel },
    followUps: planned,
    dataQuality: {
      readingsBySource: sourceCounts,
      readingsByQuality: qualityCounts,
      metricsNeverRecorded: vitals.filter((v) => !v.reading).map((v) => v.label),
      metricsWithoutBaseline: vitals.filter((v) => !v.hasBaseline).map((v) => v.label),
    },
    environment: {
      radiation: radCov.map((r) => ({
        datasetId: r.dataset_id, detector: r.detector, detectorDescription: r.detector_description, unit: r.unit, quantity: r.quantity,
        firstObservation: r.first_obs, lastObservation: r.last_obs, firstSol: r.first_sol, lastSol: r.last_sol,
        samples: r.total, samplesWithValue: r.with_value, samplesNoIssues: r.no_issues, lastImportedAt: r.last_imported,
      })),
      spaceWeather: swCov && swCov.total ? {
        firstEvent: swCov.first_event, lastEvent: swCov.last_event, events: swCov.total, lastFetchedAt: swCov.last_fetched,
      } : null,
      label: 'Historical NASA data — not a live feed and not personal dosimetry.',
    },
    learningCard: card,
  };
}
