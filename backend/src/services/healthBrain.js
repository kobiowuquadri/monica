// MONICA Health Brain — the Radiation Health Index (RHI).
//
// A deterministic, fully explainable 0–100 triage index built from four weighted components,
// with hard triggers that override the score. Pure functions only: no I/O, no randomness.
//
// PROTOTYPE STATUS (shown wherever the index is displayed):
//  - the weights, band cut-offs, sub-score formulas and trigger ratios below are prototype
//    values chosen by the team. They are NOT clinically validated and are not NASA limits;
//    they are to be calibrated against NASA-STD-3001 and clinical review;
//  - the index organises what was recorded. It is not a diagnosis, it does not estimate a
//    radiation dose and it does not infer radiation injury;
//  - a component with no data is "not assessed" and contributes 0 points, so a partial index
//    can understate — coverage is always reported next to the score.

export const HEALTH_BRAIN_VERSION = 'rhi-prototype.1';

export const WEIGHTS = { exposure: 35, symptoms: 30, biomarkers: 20, wellbeing: 15 };

export const COMPONENT_LABELS = {
  exposure: 'Exposure', symptoms: 'Symptoms', biomarkers: 'Biomarkers', wellbeing: 'Wellbeing',
};

export const BANDS = [
  { key: 'green', label: 'GREEN', min: 0, max: 24, range: 'RHI below 25', action: 'Normal. Keep routine.' },
  { key: 'yellow', label: 'YELLOW', min: 25, max: 49, range: 'RHI 25–49', action: 'Watch. Repeat checks.' },
  { key: 'orange', label: 'ORANGE', min: 50, max: 74, range: 'RHI 50–74', action: 'Act now. Alert ground.' },
  { key: 'red', label: 'RED', min: 75, max: 100, range: 'RHI 75+ or any hard trigger', action: 'Shelter. Call the surgeon.' },
];

export const PARAMS = {
  exposureMinPriorReadings: 3,   // earlier dose-rate readings needed to form a personal exposure reference
  spikeRatio: 1.5,               // dose rate ≥ 1.5 × reference counts as a "spike"
  shelterRatio: 2.0,             // dose rate ≥ 2 × reference reaches the prototype shelter threshold
  vomitingWindowHours: 2,
  feverC: 38.0,
  lymphocyteDropPct: 25,
  symptomPoints: { mild: 25, moderate: 55, severe: 85 },
  additionalSymptomPoints: 10,
};

export const TRIGGERS = {
  shelter_threshold: { label: 'Shelter threshold reached', rule: `Dose rate at or above ${PARAMS.shelterRatio}× the personal exposure reference.` },
  vomiting_after_spike: { label: 'Vomiting within 2 h of a spike', rule: `Vomiting reported with onset within ${PARAMS.vomitingWindowHours} hours after a dose-rate reading at or above ${PARAMS.spikeRatio}× the reference.` },
  fever_lymphocyte_drop: { label: 'Fever with lymphocyte drop', rule: `Body temperature at or above ${PARAMS.feverC.toFixed(1)} °C together with a lymphocyte count ${PARAMS.lymphocyteDropPct}% or more below the personal reference.` },
  chest_pain_or_confusion: { label: 'Chest pain or confusion', rule: 'Chest discomfort or confusion reported at any severity.' },
};

export const COMPONENT_METHODS = {
  exposure: `Dose-rate reading compared with the median of this profile's earlier dose-rate readings (at least ${PARAMS.exposureMinPriorReadings} needed). Sub-score = percent above that reference, 0–100.`,
  symptoms: `Worst reported severity (mild ${PARAMS.symptomPoints.mild}, moderate ${PARAMS.symptomPoints.moderate}, severe ${PARAMS.symptomPoints.severe}) plus ${PARAMS.additionalSymptomPoints} for each additional symptom, capped at 100. "No symptoms reported" scores 0.`,
  biomarkers: 'Higher of: lymphocyte drop below the median of earlier counts (5% → 0, 40% → 100) and body temperature (37.5 °C → 0, 39.0 °C → 100).',
  wellbeing: 'Mean of the recorded self-ratings: fatigue (0–10), sleep quality and mood (1–5, reversed) and sleep duration (7 h or more → 0, 4 h or less → 100).',
};

export const DISCLAIMERS = [
  'Prototype weights and thresholds — to be calibrated with NASA-STD-3001 and clinical review. Not clinically validated.',
  'The index organises recorded entries. It is not a diagnosis, a dose estimate or an inference of radiation injury.',
  'Components without data are "not assessed" and add 0 points, so a partial index can understate.',
  'MONICA does not contact anyone. Band actions are prompts for the crew to follow their own mission procedures.',
];

export function describeModel() {
  return {
    version: HEALTH_BRAIN_VERSION,
    name: 'Health Brain',
    index: 'RHI',
    indexName: 'Radiation Health Index',
    scale: '0 to 100',
    weights: WEIGHTS,
    components: Object.keys(WEIGHTS).map((key) => ({ key, label: COMPONENT_LABELS[key], weight: WEIGHTS[key], method: COMPONENT_METHODS[key] })),
    bands: BANDS,
    triggers: Object.entries(TRIGGERS).map(([id, t]) => ({ id, ...t })),
    disclaimers: DISCLAIMERS,
  };
}

const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;
const ms = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : new Date(v).getTime()));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Reduces a check-in (validated payload or stored DTO — same field names) to the model inputs. */
export function toSnapshot(c) {
  const temp = (c.vitals || []).find((v) => v.metric === 'temperature' && v.quality !== 'poor' && v.quality !== 'uncertain');
  let tempC = temp ? num(temp.value) : null;
  if (tempC !== null && temp.unit === 'degF') tempC = Math.round(((tempC - 32) * 5 / 9) * 10) / 10;
  const w = c.wellbeing || {};
  const t = ms(c.measuredAt);
  return {
    id: c.id || null,
    t,
    doseRate: num(c.exposure?.doseRate),
    exposureSource: c.exposure?.sourceType || null,
    lymphocytes: num(c.biomarkers?.lymphocyteCount),
    tempC,
    symptomStatus: c.symptomStatus || ((c.symptoms || []).length ? 'reported' : 'not_assessed'),
    symptoms: (c.symptoms || []).map((s) => ({ code: s.code, label: s.label, severity: s.severity, onset: ms(s.onsetAt) ?? t })),
    wellbeing: {
      sleepDurationHours: num(w.sleepDurationHours), sleepQuality: num(w.sleepQuality),
      fatigueRating: num(w.fatigueRating), moodRating: num(w.moodRating),
    },
  };
}

function bandFor(score) {
  return BANDS.find((b) => score >= b.min && score <= b.max) || BANDS[BANDS.length - 1];
}

function component(key, fields) {
  const assessed = fields.subScore !== null && fields.subScore !== undefined;
  const subScore = assessed ? Math.round(clamp(fields.subScore)) : null;
  return {
    key, label: COMPONENT_LABELS[key], weight: WEIGHTS[key], assessed, subScore,
    points: assessed ? round1((WEIGHTS[key] * subScore) / 100) : 0,
    summary: fields.summary, inputs: fields.inputs || {},
  };
}

/**
 * Assesses one snapshot against the snapshots recorded before it.
 * @param {object} cur   snapshot of the check-in being assessed
 * @param {Array}  prior earlier snapshots, each carrying `.spike` (set by assessSeries)
 */
function assessOne(cur, prior) {
  const triggers = [];

  // ---- Exposure (35) ----
  let exposure;
  let ratio = null;
  const priorDose = prior.filter((p) => p.doseRate !== null).map((p) => p.doseRate);
  if (cur.doseRate === null) {
    exposure = component('exposure', { subScore: null, summary: 'Not assessed — no dose-rate reading in this check-in.' });
  } else if (priorDose.length < PARAMS.exposureMinPriorReadings) {
    exposure = component('exposure', {
      subScore: null,
      summary: `Not assessed — ${priorDose.length} of ${PARAMS.exposureMinPriorReadings} earlier dose-rate readings needed to form a personal exposure reference.`,
      inputs: { doseRate: cur.doseRate, unit: 'µGy/h', source: cur.exposureSource },
    });
  } else {
    const reference = median(priorDose);
    ratio = reference > 0 ? cur.doseRate / reference : null;
    const sub = ratio === null ? 0 : (ratio - 1) * 100;
    exposure = component('exposure', {
      subScore: sub,
      summary: ratio === null
        ? `Dose rate ${cur.doseRate} µGy/h; reference is zero, so no ratio is calculated.`
        : `Dose rate ${cur.doseRate} µGy/h is ${ratio.toFixed(2)}× the reference of ${round1(reference)} µGy/h (median of ${priorDose.length} earlier readings).`,
      inputs: { doseRate: cur.doseRate, unit: 'µGy/h', source: cur.exposureSource, reference: round1(reference), referenceSamples: priorDose.length, ratio: ratio === null ? null : Math.round(ratio * 100) / 100 },
    });
    if (ratio !== null && ratio >= PARAMS.shelterRatio) {
      triggers.push({ id: 'shelter_threshold', label: TRIGGERS.shelter_threshold.label, detail: `Dose rate ${cur.doseRate} µGy/h is ${ratio.toFixed(2)}× the reference (threshold ${PARAMS.shelterRatio}×).` });
    }
  }
  const spike = ratio !== null && ratio >= PARAMS.spikeRatio;

  // ---- Symptoms (30) ----
  let symptoms;
  if (cur.symptoms.length) {
    const pts = cur.symptoms.map((s) => PARAMS.symptomPoints[s.severity] || 0);
    const sub = Math.max(...pts) + PARAMS.additionalSymptomPoints * (cur.symptoms.length - 1);
    symptoms = component('symptoms', {
      subScore: sub,
      summary: `${cur.symptoms.map((s) => `${s.label} (${s.severity})`).join(', ')}.`,
      inputs: { symptoms: cur.symptoms.map((s) => ({ code: s.code, severity: s.severity })) },
    });
  } else if (cur.symptomStatus === 'none_reported') {
    symptoms = component('symptoms', { subScore: 0, summary: 'No symptoms reported.' });
  } else {
    symptoms = component('symptoms', { subScore: null, summary: 'Not assessed — symptoms were not assessed in this check-in.' });
  }

  // ---- Biomarkers (20) ----
  const priorLymph = prior.filter((p) => p.lymphocytes !== null).map((p) => p.lymphocytes);
  const parts = [];
  const bioInputs = {};
  let dropPct = null;
  if (cur.lymphocytes !== null && priorLymph.length >= 1) {
    const ref = median(priorLymph);
    dropPct = ref > 0 ? ((ref - cur.lymphocytes) / ref) * 100 : 0;
    parts.push({ sub: ((dropPct - 5) * 100) / 35, text: `Lymphocytes ${cur.lymphocytes} ×10⁹/L, ${dropPct >= 0 ? `${Math.round(dropPct)}% below` : `${Math.round(-dropPct)}% above`} the reference of ${Math.round(ref * 100) / 100} (median of ${priorLymph.length} earlier count${priorLymph.length === 1 ? '' : 's'})` });
    Object.assign(bioInputs, { lymphocytes: cur.lymphocytes, lymphocyteReference: Math.round(ref * 100) / 100, lymphocyteDropPct: Math.round(dropPct) });
  } else if (cur.lymphocytes !== null) {
    parts.push({ sub: null, text: `Lymphocytes ${cur.lymphocytes} ×10⁹/L recorded — first count, kept as the reference for later comparisons` });
    bioInputs.lymphocytes = cur.lymphocytes;
  }
  if (cur.tempC !== null) {
    parts.push({ sub: ((cur.tempC - 37.5) / 1.5) * 100, text: `Body temperature ${cur.tempC} °C` });
    bioInputs.temperatureC = cur.tempC;
  }
  const scored = parts.filter((p) => p.sub !== null);
  const biomarkers = component('biomarkers', {
    subScore: scored.length ? Math.max(...scored.map((p) => clamp(p.sub))) : null,
    summary: parts.length ? `${parts.map((p) => p.text).join('; ')}.` : 'Not assessed — no lymphocyte count or body temperature in this check-in.',
    inputs: bioInputs,
  });
  if (cur.tempC !== null && cur.tempC >= PARAMS.feverC && dropPct !== null && dropPct >= PARAMS.lymphocyteDropPct) {
    triggers.push({ id: 'fever_lymphocyte_drop', label: TRIGGERS.fever_lymphocyte_drop.label, detail: `Temperature ${cur.tempC} °C with lymphocytes ${Math.round(dropPct)}% below reference.` });
  }

  // ---- Wellbeing (15) ----
  const w = cur.wellbeing;
  const wParts = [];
  if (w.fatigueRating !== null) wParts.push({ sub: w.fatigueRating * 10, text: `fatigue ${w.fatigueRating}/10` });
  if (w.sleepQuality !== null) wParts.push({ sub: (5 - w.sleepQuality) * 25, text: `sleep quality ${w.sleepQuality}/5` });
  if (w.moodRating !== null) wParts.push({ sub: (5 - w.moodRating) * 25, text: `mood ${w.moodRating}/5` });
  if (w.sleepDurationHours !== null) wParts.push({ sub: clamp(((7 - w.sleepDurationHours) / 3) * 100), text: `sleep ${w.sleepDurationHours} h` });
  const wellbeing = component('wellbeing', {
    subScore: wParts.length ? wParts.reduce((a, p) => a + p.sub, 0) / wParts.length : null,
    summary: wParts.length ? `Self-reported: ${wParts.map((p) => p.text).join(', ')}.` : 'Not assessed — no sleep or wellbeing ratings in this check-in.',
    inputs: { ...w },
  });

  // ---- Remaining hard triggers ----
  const vomiting = cur.symptoms.find((s) => s.code === 'vomiting');
  if (vomiting) {
    const windowMs = PARAMS.vomitingWindowHours * 3600_000;
    const candidates = [...prior.filter((p) => p.spike), ...(spike ? [{ t: cur.t, doseRate: cur.doseRate }] : [])];
    // A spike counts when it was recorded within the window around the stated onset; a spike
    // recorded in the same check-in counts even if the onset was slightly earlier.
    const hit = candidates.filter((p) => Math.abs(vomiting.onset - p.t) <= windowMs && p.t <= Math.max(vomiting.onset, cur.t)).pop();
    if (hit) {
      triggers.push({ id: 'vomiting_after_spike', label: TRIGGERS.vomiting_after_spike.label, detail: `Vomiting reported within ${PARAMS.vomitingWindowHours} h of a dose-rate spike (${hit.doseRate} µGy/h at ${new Date(hit.t).toISOString().slice(0, 16)}Z).` });
    }
  }
  const neuroCardiac = cur.symptoms.filter((s) => s.code === 'chest_discomfort' || s.code === 'confusion');
  if (neuroCardiac.length) {
    triggers.push({ id: 'chest_pain_or_confusion', label: TRIGGERS.chest_pain_or_confusion.label, detail: `${neuroCardiac.map((s) => `${s.label} (${s.severity})`).join(', ')} reported.` });
  }

  const components = [exposure, symptoms, biomarkers, wellbeing];
  const score = Math.round(clamp(components.reduce((a, c) => a + c.points, 0)));
  const scoreBand = bandFor(score);
  const band = triggers.length ? BANDS[BANDS.length - 1] : scoreBand;
  const assessedWeight = components.filter((c) => c.assessed).reduce((a, c) => a + c.weight, 0);

  return {
    modelVersion: HEALTH_BRAIN_VERSION,
    checkInId: cur.id,
    measuredAt: new Date(cur.t).toISOString(),
    score,
    band: band.key,
    bandLabel: band.label,
    action: band.action,
    bandReason: triggers.length ? 'hard_trigger' : 'score',
    scoreBand: scoreBand.key,
    triggers,
    components,
    coverage: {
      assessedWeight,
      complete: assessedWeight === 100,
      notAssessed: components.filter((c) => !c.assessed).map((c) => c.label),
    },
    spike,
  };
}

/** Assesses every check-in in order. Input order does not matter; output is oldest first. */
export function assessSeries(checkIns) {
  const snaps = checkIns.map(toSnapshot).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const out = [];
  const prior = [];
  for (const s of snaps) {
    const a = assessOne(s, prior);
    prior.push({ ...s, spike: a.spike });
    out.push(a);
  }
  return out;
}

/** Assesses a new check-in against the profile's earlier check-ins. */
export function assessCheckIn(checkIn, priorCheckIns = []) {
  const cur = toSnapshot(checkIn);
  const earlierCheckIns = priorCheckIns.filter((p) => ms(p.measuredAt) <= cur.t);
  const earlier = assessSeries(earlierCheckIns);
  const priorSnaps = earlierCheckIns.map(toSnapshot).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t)
    .map((s, i) => ({ ...s, spike: earlier[i].spike }));
  return assessOne(cur, priorSnaps);
}
