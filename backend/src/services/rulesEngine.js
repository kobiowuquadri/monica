// MONICA transparent rules engine.
//
// Deterministic, versioned, side-effect free. Each rule returns observations that carry
// their rule ID/version, triggering inputs, explanation, missing information, a suggested
// next step, a reference where one applies, and whether the rule is a demonstration rule.
//
// Deliberate non-rules (see docs/RULES_AND_LIMITATIONS.md):
//  - no "fit for duty" or "all normal" output. The Health Brain index (RHI, see healthBrain.js)
//    is a labelled prototype triage index with uncalibrated weights, not a clinical score;
//  - no verified clinical thresholds (none have been configured; RHI cut-offs are prototype values);
//  - no radiation-injury diagnosis: RHI triggers flag recorded combinations for review only;
//  - no dose estimation from symptom timing; no treatment or medication recommendation;
//  - urgent symptom reports are evaluated independently of vital signs, so normal readings
//    can never cancel them.

import { VITAL_METRICS, VITAL_METRIC_KEYS, SYMPTOMS } from '../content/metrics.js';
import { assessCheckIn, HEALTH_BRAIN_VERSION } from './healthBrain.js';

export const RULES_VERSION = '2026.11-demo.2';

const NO_PROTOCOL = 'No clinician-approved treatment protocol is configured in MONICA, so it does not suggest treatment.';

export const RULE_CATALOGUE = [
  {
    id: 'DQ-001', version: '1', category: 'data_quality', demonstration: true,
    title: 'Measurement quality marked as uncertain or poor',
    description: 'Raised when a recorded vital sign is marked "uncertain" or "poor" quality by the person entering it.',
  },
  {
    id: 'DQ-002', version: '1', category: 'data_quality', demonstration: true,
    title: 'Readings not comparable with a resting baseline',
    description: 'Raised when vital signs are recorded in a non-resting or unknown context while a resting baseline exists for that measurement; the readings are kept but excluded from baseline comparison.',
  },
  {
    id: 'DQ-003', version: '1', category: 'data_quality', demonstration: true,
    title: 'No vital signs in this check-in',
    description: 'Raised when a check-in contains symptoms or wellbeing entries but no vital-sign measurements, so later reviewers know they were not assessed rather than unremarkable.',
  },
  {
    id: 'PT-001', version: '1', category: 'personal_trend', demonstration: true,
    title: 'Comparison with established personal baseline',
    description: 'Descriptive difference between resting readings of good/unstated quality and an explicitly established baseline. No threshold is applied; differences are reported as observations, not diagnoses.',
  },
  {
    id: 'HC-001', version: '1', category: 'health_concern', demonstration: true,
    title: 'Symptom reported as severe',
    description: 'Raised for every symptom the person rates as "severe". Based only on the self-reported severity; no clinical threshold is applied.',
  },
  {
    id: 'HC-002', version: '1', category: 'health_concern', demonstration: true,
    title: 'Symptom marked as needing prompt medical attention',
    description: 'Raised whenever the person marks a symptom as needing prompt attention. Evaluated independently of vital signs so it cannot be averaged away by normal readings.',
  },
  {
    id: 'HC-003', version: '1', category: 'health_concern', demonstration: true,
    title: 'Symptom reported again within 72 hours',
    description: 'Raised when the same symptom was also reported in an earlier check-in within the preceding 72 hours. The 72-hour window is a MONICA prototype convention, not a clinical rule.',
  },
  {
    id: 'HB-001', version: '1', category: 'health_concern', demonstration: true,
    title: 'Health Brain index (RHI) in the YELLOW, ORANGE or RED band',
    description: 'Raised when the RHI for a check-in is 25 or higher. RHI is a 0–100 prototype triage index: Exposure 35%, Symptoms 30%, Biomarkers 20%, Wellbeing 15%. Weights and band cut-offs are prototype values awaiting calibration with NASA-STD-3001 and clinical review.',
  },
  {
    id: 'HB-002', version: '1', category: 'health_concern', demonstration: true,
    title: 'Health Brain hard trigger',
    description: 'Raised when a hard trigger overrides the RHI score and sets the RED band: shelter threshold reached; vomiting within 2 h of a dose-rate spike; fever with lymphocyte drop; chest pain or confusion. Trigger definitions are prototype conventions, not clinical criteria.',
  },
];

const ruleMeta = Object.fromEntries(RULE_CATALOGUE.map((r) => [r.id, r]));

function obs(ruleId, fields) {
  const meta = ruleMeta[ruleId];
  return {
    ruleId,
    ruleVersion: `${RULES_VERSION}/${meta.version}`,
    category: meta.category,
    isDemonstrationRule: meta.demonstration,
    reference: null,
    missingInformation: [],
    ...fields,
  };
}

function fmtValue(value, unit) {
  const u = unit === 'degC' ? '°C' : unit === 'degF' ? '°F' : ` ${unit}`;
  return `${value}${u}`;
}

const CONTEXT_LABEL = {
  resting: 'resting', post_exercise: 'after exercise', after_waking: 'after waking',
  during_activity: 'during activity', other: 'other context', unknown: 'unknown context',
};

/**
 * @param {object} checkIn normalised check-in (see validateCheckIn)
 * @param {object} ctx { baselines: Map(metric -> {value, unit, method, sampleCount, establishedAt}),
 *                       recentSymptoms: Array<{code, measuredAt}> from earlier check-ins (excluding this one) }
 *                       priorCheckIns: earlier check-ins of the profile (enables the Health Brain rules) }
 * @returns {Array<object>} observations
 */
export function evaluateCheckIn(checkIn, ctx = {}) {
  const baselines = ctx.baselines || new Map();
  const recentSymptoms = ctx.recentSymptoms || [];
  const out = [];
  const t = checkIn.measuredAt instanceof Date ? checkIn.measuredAt : new Date(checkIn.measuredAt);

  // ---------------- Health concerns (evaluated first and independently) ----------------
  for (const s of checkIn.symptoms) {
    if (s.markedUrgent) {
      out.push(obs('HC-002', {
        level: 'urgent_review',
        title: `${s.label}: marked as needing prompt medical attention`,
        explanation: `You marked "${s.label}" (rated ${s.severity}) as needing prompt medical attention. MONICA records this exactly as reported. Vital signs in the same check-in do not lower or cancel this prompt.`,
        triggeringInputs: { symptom: s.code, label: s.label, severity: s.severity, markedUrgent: true, measuredAt: t.toISOString() },
        missingInformation: ['Clinical assessment by your medical support team'],
        suggestedNextStep: `Contact your medical support through your mission's established procedures. MONICA has not contacted anyone. Use "Prepare review summary" to organise what you recorded. ${NO_PROTOCOL}`,
      }));
    }
    if (s.severity === 'severe') {
      out.push(obs('HC-001', {
        level: 'attention',
        title: `${s.label} reported as severe`,
        explanation: `"${s.label}" was rated severe in this check-in. This observation reflects your own rating; MONICA does not interpret its cause.`,
        triggeringInputs: { symptom: s.code, label: s.label, severity: s.severity, onsetAt: s.onsetAt ? new Date(s.onsetAt).toISOString() : null, onsetNote: s.onsetNote || null },
        missingInformation: [s.onsetAt || s.onsetNote ? null : 'Symptom onset time', 'Clinical assessment'].filter(Boolean),
        suggestedNextStep: `Prepare a review summary for your medical support and follow your mission's medical procedures. Consider scheduling a follow-up check-in. ${NO_PROTOCOL}`,
      }));
    }
  }

  const windowStart = t.getTime() - 72 * 3600_000;
  const reported = new Map();
  for (const r of recentSymptoms) {
    const rt = new Date(r.measuredAt).getTime();
    if (rt >= windowStart && rt <= t.getTime() && r.code !== 'other') {
      if (!reported.has(r.code)) reported.set(r.code, []);
      reported.get(r.code).push(new Date(r.measuredAt).toISOString());
    }
  }
  for (const s of checkIn.symptoms) {
    const earlier = reported.get(s.code);
    if (!earlier || earlier.length === 0) continue;
    out.push(obs('HC-003', {
      level: 'attention',
      title: `${s.label} reported again`,
      explanation: `"${s.label}" was also reported in ${earlier.length} earlier check-in(s) within the 72 hours before this one. Repeated reports are worth reviewing; this does not indicate a cause or whether it is improving.`,
      triggeringInputs: { symptom: s.code, label: SYMPTOMS[s.code], severity: s.severity, earlierReportsAt: earlier.sort() },
      missingInformation: ['Clinical assessment'],
      suggestedNextStep: 'Schedule a follow-up check-in and include this symptom history in your review summary.',
    }));
  }

  // ---------------- Data quality ----------------
  const flagged = checkIn.vitals.filter((r) => r.quality === 'uncertain' || r.quality === 'poor');
  if (flagged.length) {
    out.push(obs('DQ-001', {
      level: 'info',
      title: `${flagged.length} reading(s) marked ${[...new Set(flagged.map((r) => r.quality))].join(' / ')} quality`,
      explanation: 'These readings are stored as entered but are excluded from baseline calculations and comparisons because their quality was marked uncertain or poor.',
      triggeringInputs: { readings: flagged.map((r) => ({ metric: r.metric, quality: r.quality, sourceType: r.sourceType })) },
      missingInformation: ['A repeat measurement of acceptable quality'],
      suggestedNextStep: 'Repeat the measurement when practical and record the new value in a new check-in.',
    }));
  }

  const comparableContext = checkIn.activityContext === 'resting';
  if (!comparableContext && checkIn.vitals.length) {
    const withBaseline = checkIn.vitals.filter((r) => baselines.has(r.metric));
    if (withBaseline.length) {
      out.push(obs('DQ-002', {
        level: 'info',
        title: `Readings taken ${CONTEXT_LABEL[checkIn.activityContext]} — not compared with resting baseline`,
        explanation: `Baselines in MONICA describe resting readings. Readings taken ${CONTEXT_LABEL[checkIn.activityContext]} are kept and charted separately but are not compared with the baseline.`,
        triggeringInputs: { activityContext: checkIn.activityContext, metrics: withBaseline.map((r) => r.metric) },
        missingInformation: ['Resting readings for comparison'],
        suggestedNextStep: 'If a comparison is needed, record a resting measurement in a separate check-in.',
      }));
    }
  }

  if (checkIn.vitals.length === 0 && (checkIn.symptoms.length || Object.values(checkIn.wellbeing || {}).some((x) => x !== null && x !== undefined))) {
    out.push(obs('DQ-003', {
      level: 'info',
      title: 'No vital signs recorded in this check-in',
      explanation: 'This check-in has symptom or wellbeing entries but no vital-sign measurements. Vital signs are shown as "Not assessed" for this check-in — not as normal.',
      triggeringInputs: { symptomsCount: checkIn.symptoms.length, vitalsCount: 0 },
      missingInformation: VITAL_METRIC_KEYS.map((k) => VITAL_METRICS[k].label),
      suggestedNextStep: 'If measurement equipment is available, record vital signs in a follow-up check-in.',
    }));
  }

  // ---------------- Personal trend (descriptive only) ----------------
  if (comparableContext) {
    const comparisons = [];
    const missingBaselines = [];
    for (const r of checkIn.vitals) {
      if (r.quality === 'uncertain' || r.quality === 'poor') continue;
      const base = baselines.get(r.metric);
      if (!base) { missingBaselines.push(VITAL_METRICS[r.metric].label); continue; }
      if (base.unit !== r.unit) { missingBaselines.push(`${VITAL_METRICS[r.metric].label} (baseline recorded in a different unit)`); continue; }
      const diff = Math.round((r.value - base.value) * 100) / 100;
      comparisons.push({
        metric: r.metric, label: VITAL_METRICS[r.metric].label, value: r.value, unit: r.unit,
        baselineValue: base.value, baselineMethod: base.method, baselineSampleCount: base.sampleCount ?? null,
        difference: diff,
      });
    }
    if (comparisons.length) {
      const parts = comparisons.map((c) => `${c.label} ${fmtValue(c.value, c.unit)} vs baseline ${fmtValue(c.baselineValue, c.unit)} (${c.difference > 0 ? '+' : ''}${c.difference})`);
      out.push(obs('PT-001', {
        level: 'info',
        title: 'Compared with your recorded baseline',
        explanation: `${parts.join('; ')}. These are descriptive differences. MONICA has no configured clinical threshold for deciding whether a difference matters.`,
        triggeringInputs: { activityContext: checkIn.activityContext, comparisons },
        missingInformation: missingBaselines.length ? missingBaselines.map((m) => `Baseline for ${m}`) : [],
        suggestedNextStep: 'Review the trend over several check-ins rather than a single reading; include it in a review summary if it concerns you.',
      }));
    }
  }

  // ---------------- Health Brain (RHI) ----------------
  if (ctx.priorCheckIns) out.push(...healthBrainObservations(assessCheckIn(checkIn, ctx.priorCheckIns)));

  return out;
}

const NOT_CONTACTED = 'MONICA has not contacted anyone — use your mission\'s established procedures.';

/** Observations for one Health Brain assessment (none for a GREEN band without triggers). */
export function healthBrainObservations(a) {
  const breakdown = a.components.map((c) => (c.assessed ? `${c.label} ${c.points} of ${c.weight}` : `${c.label} not assessed`)).join('; ');
  const inputs = {
    modelVersion: HEALTH_BRAIN_VERSION, score: a.score, band: a.band, bandReason: a.bandReason,
    components: a.components.map((c) => ({ key: c.key, weight: c.weight, assessed: c.assessed, subScore: c.subScore, points: c.points, inputs: c.inputs })),
    triggers: a.triggers.map((t) => ({ id: t.id, detail: t.detail })),
    assessedWeight: a.coverage.assessedWeight,
  };
  const missing = a.coverage.notAssessed.map((label) => `${label} component (not assessed — adds 0 points)`);
  missing.push('Calibration of weights and thresholds (prototype values)', 'Clinical assessment');
  if (a.triggers.length) {
    return [obs('HB-002', {
      level: 'urgent_review',
      title: `Health Brain RED — ${a.triggers.map((t) => t.label).join('; ')}`,
      explanation: `A hard trigger overrides the score and sets the RED band. ${a.triggers.map((t) => t.detail).join(' ')} RHI score ${a.score} of 100 (${breakdown}). Triggers are prototype conventions that flag recorded combinations for review; they are not a diagnosis.`,
      triggeringInputs: inputs, missingInformation: missing,
      suggestedNextStep: `${a.action} ${NOT_CONTACTED} ${NO_PROTOCOL}`,
    })];
  }
  if (a.band === 'green') return [];
  const level = a.band === 'red' ? 'urgent_review' : a.band === 'orange' ? 'attention' : 'info';
  return [obs('HB-001', {
    level,
    title: `Health Brain ${a.bandLabel} — RHI ${a.score}`,
    explanation: `RHI is ${a.score} of 100 (${breakdown}). ${a.components.filter((c) => c.assessed && c.points > 0).map((c) => `${c.label}: ${c.summary}`).join(' ')} RHI is a prototype triage index with uncalibrated weights; it is not a diagnosis.`,
    triggeringInputs: inputs, missingInformation: missing,
    suggestedNextStep: `${a.action} ${a.band === 'yellow' ? 'Record another check-in to see whether the index is rising or settling.' : NOT_CONTACTED} ${NO_PROTOCOL}`,
  })];
}
