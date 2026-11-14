// Metric and symptom definitions used for data entry, display and trends.
//
// IMPORTANT: `inputRange` values are DATA-ENTRY plausibility bounds that catch typing
// errors (e.g. 720 instead of 72). They are not clinical reference ranges and are never
// used to label a reading as normal or abnormal. MONICA has no configured clinical thresholds.

export const VITAL_METRICS = {
  heart_rate: {
    label: 'Heart rate',
    units: ['beats/min'],
    defaultUnit: 'beats/min',
    inputRange: { min: 20, max: 250 },
    maxDecimals: 0,
    methods: [],
  },
  spo2: {
    label: 'Oxygen saturation (SpO₂)',
    units: ['%'],
    defaultUnit: '%',
    inputRange: { min: 50, max: 100 },
    maxDecimals: 0,
    methods: [],
  },
  temperature: {
    label: 'Body temperature',
    units: ['degC', 'degF'],
    defaultUnit: 'degC',
    inputRange: { degC: { min: 30, max: 45 }, degF: { min: 86, max: 113 } },
    maxDecimals: 1,
    methods: ['oral', 'tympanic', 'temporal', 'axillary', 'skin_wearable', 'other'],
    methodRequired: true,
  },
  bp_systolic: {
    label: 'Blood pressure — systolic',
    units: ['mmHg'],
    defaultUnit: 'mmHg',
    inputRange: { min: 50, max: 300 },
    maxDecimals: 0,
    methods: [],
  },
  bp_diastolic: {
    label: 'Blood pressure — diastolic',
    units: ['mmHg'],
    defaultUnit: 'mmHg',
    inputRange: { min: 20, max: 200 },
    maxDecimals: 0,
    methods: [],
  },
  respiratory_rate: {
    label: 'Respiratory rate',
    units: ['breaths/min'],
    defaultUnit: 'breaths/min',
    inputRange: { min: 4, max: 80 },
    maxDecimals: 0,
    methods: [],
  },
};

export const VITAL_METRIC_KEYS = Object.keys(VITAL_METRICS);

/** Self-reported wellbeing fields stored on the check-in. These are MONICA prototype
 * self-rating scales, not validated clinical instruments. */
export const WELLBEING_METRICS = {
  sleep_duration_hours: { label: 'Sleep duration', unit: 'h', column: 'sleep_duration_hours', range: { min: 0, max: 24 }, maxDecimals: 2 },
  sleep_quality: { label: 'Perceived sleep quality', unit: '1–5 self-rating', column: 'sleep_quality', range: { min: 1, max: 5 }, integer: true,
    anchors: { 1: 'Very poor', 2: 'Poor', 3: 'Fair', 4: 'Good', 5: 'Very good' } },
  fatigue_rating: { label: 'Fatigue', unit: '0–10 self-rating', column: 'fatigue_rating', range: { min: 0, max: 10 }, integer: true,
    anchors: { 0: 'None', 5: 'Moderate', 10: 'Worst imaginable' } },
  mood_rating: { label: 'Mood', unit: '1–5 self-rating', column: 'mood_rating', range: { min: 1, max: 5 }, integer: true,
    anchors: { 1: 'Very low', 2: 'Low', 3: 'Neutral', 4: 'Good', 5: 'Very good' } },
};

export const ACTIVITY_CONTEXTS = ['resting', 'post_exercise', 'after_waking', 'during_activity', 'other', 'unknown'];
export const SOURCE_TYPES = ['manual', 'device_reported'];
export const QUALITY_VALUES = ['good', 'uncertain', 'poor', 'not_stated'];
export const SEVERITIES = ['mild', 'moderate', 'severe'];

/** Symptom vocabulary for structured entry. Labels only — MONICA draws no diagnostic
 * inference from any symptom or combination of symptoms. */
export const SYMPTOMS = {
  headache: 'Headache',
  nausea: 'Nausea',
  vomiting: 'Vomiting',
  dizziness: 'Dizziness or light-headedness',
  unusual_fatigue: 'Unusual tiredness',
  shortness_of_breath: 'Shortness of breath',
  chest_discomfort: 'Chest discomfort',
  palpitations: 'Palpitations',
  fever_chills: 'Fever or chills',
  congestion: 'Nasal congestion',
  sore_throat: 'Sore throat',
  cough: 'Cough',
  skin_change: 'Skin change or rash',
  vision_change: 'Vision change',
  back_pain: 'Back pain',
  muscle_joint_pain: 'Muscle or joint pain',
  sleep_difficulty: 'Difficulty sleeping',
  low_mood_anxiety: 'Low mood or anxiety',
  difficulty_concentrating: 'Difficulty concentrating',
  injury: 'Injury',
  other: 'Other (describe in notes)',
};

export const SYMPTOM_CODES = Object.keys(SYMPTOMS);

/** Exact unit conversion used only for display when °F readings are charted with °C ones. */
export function toCelsius(value, unit) {
  if (unit === 'degF') return Math.round(((value - 32) * 5 / 9) * 100) / 100;
  return value;
}
