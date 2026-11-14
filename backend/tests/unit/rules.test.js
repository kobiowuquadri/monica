import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheckIn, RULE_CATALOGUE } from '../../src/services/rulesEngine.js';

const T = new Date('2026-11-14T08:00:00Z');
const base = (over = {}) => ({
  measuredAt: T, activityContext: 'resting', vitals: [], symptoms: [], wellbeing: {}, medications: [], ...over,
});
const vital = (metric, value, unit, extra = {}) => ({ metric, value, unit, sourceType: 'manual', quality: 'good', ...extra });
const normalVitals = [vital('heart_rate', 62, 'beats/min'), vital('spo2', 98, '%'), vital('temperature', 36.7, 'degC', { method: 'oral' })];
const REQUIRED = ['ruleId', 'ruleVersion', 'category', 'level', 'title', 'explanation', 'triggeringInputs', 'missingInformation', 'suggestedNextStep', 'isDemonstrationRule'];

test('urgent symptom produces an urgent-review observation even with unremarkable vitals', () => {
  const out = evaluateCheckIn(base({
    vitals: normalVitals,
    symptoms: [{ code: 'chest_discomfort', label: 'Chest discomfort', severity: 'moderate', markedUrgent: true }],
  }));
  const urgent = out.filter((o) => o.level === 'urgent_review');
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].ruleId, 'HC-002');
  assert.match(urgent[0].suggestedNextStep, /has not contacted anyone/);
});

test('every observation carries rule metadata, inputs, explanation and next step', () => {
  const out = evaluateCheckIn(base({
    vitals: [vital('heart_rate', 70, 'beats/min', { quality: 'poor' })],
    symptoms: [{ code: 'headache', label: 'Headache', severity: 'severe', markedUrgent: true }],
  }), { recentSymptoms: [{ code: 'headache', measuredAt: new Date(T.getTime() - 3600_000) }] });
  assert.ok(out.length >= 4);
  for (const o of out) {
    for (const key of REQUIRED) assert.ok(key in o, `${o.ruleId} missing ${key}`);
    assert.ok(Array.isArray(o.missingInformation));
    assert.equal(typeof o.isDemonstrationRule, 'boolean');
  }
});

test('no baseline → no fabricated comparison', () => {
  const out = evaluateCheckIn(base({ vitals: normalVitals }), { baselines: new Map() });
  assert.equal(out.find((o) => o.ruleId === 'PT-001'), undefined);
});

test('baseline comparison is descriptive and only for resting, acceptable-quality readings', () => {
  const baselines = new Map([['heart_rate', { value: 60, unit: 'beats/min', method: 'median_of_resting_readings', sampleCount: 7 }]]);
  const resting = evaluateCheckIn(base({ vitals: [vital('heart_rate', 66, 'beats/min')] }), { baselines });
  const pt = resting.find((o) => o.ruleId === 'PT-001');
  assert.ok(pt);
  assert.equal(pt.level, 'info');
  assert.equal(pt.triggeringInputs.comparisons[0].difference, 6);
  assert.match(pt.explanation, /no configured clinical threshold/i);

  const exercise = evaluateCheckIn(base({ activityContext: 'post_exercise', vitals: [vital('heart_rate', 120, 'beats/min')] }), { baselines });
  assert.equal(exercise.find((o) => o.ruleId === 'PT-001'), undefined);
  assert.ok(exercise.find((o) => o.ruleId === 'DQ-002'));

  const poor = evaluateCheckIn(base({ vitals: [vital('heart_rate', 90, 'beats/min', { quality: 'poor' })] }), { baselines });
  assert.equal(poor.find((o) => o.ruleId === 'PT-001'), undefined);
  assert.ok(poor.find((o) => o.ruleId === 'DQ-001'));
});

test('missing vitals are flagged as not assessed, never as normal', () => {
  const out = evaluateCheckIn(base({ symptoms: [{ code: 'nausea', label: 'Nausea', severity: 'mild', markedUrgent: false }] }));
  const dq = out.find((o) => o.ruleId === 'DQ-003');
  assert.ok(dq);
  assert.ok(dq.missingInformation.length >= 5);
});

test('repeated symptom within 72 h is raised; outside the window it is not', () => {
  const s = [{ code: 'nausea', label: 'Nausea', severity: 'mild', markedUrgent: false }];
  const inside = evaluateCheckIn(base({ symptoms: s }), { recentSymptoms: [{ code: 'nausea', measuredAt: new Date(T.getTime() - 48 * 3600_000) }] });
  assert.ok(inside.find((o) => o.ruleId === 'HC-003'));
  const outside = evaluateCheckIn(base({ symptoms: s }), { recentSymptoms: [{ code: 'nausea', measuredAt: new Date(T.getTime() - 80 * 3600_000) }] });
  assert.equal(outside.find((o) => o.ruleId === 'HC-003'), undefined);
});

test('rules never infer radiation injury, dose or fitness from symptoms or vitals', () => {
  const out = evaluateCheckIn(base({
    vitals: [vital('heart_rate', 110, 'beats/min')],
    symptoms: [
      { code: 'nausea', label: 'Nausea', severity: 'severe', markedUrgent: false },
      { code: 'vomiting', label: 'Vomiting', severity: 'severe', markedUrgent: false, onsetAt: new Date(T.getTime() - 2 * 3600_000) },
      { code: 'unusual_fatigue', label: 'Unusual tiredness', severity: 'severe', markedUrgent: false },
    ],
    wellbeing: { fatigueRating: 9 },
  }));
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /radiation|\bdose\b|sievert|gray|fit for duty|safe for duty|health score|all systems normal|prescri|dosage/i);
});

test('rule catalogue entries are all marked as demonstration rules', () => {
  for (const r of RULE_CATALOGUE) assert.equal(r.demonstration, true);
});
