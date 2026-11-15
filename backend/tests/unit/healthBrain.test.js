import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessSeries, assessCheckIn, WEIGHTS } from '../../src/services/healthBrain.js';
import { evaluateCheckIn } from '../../src/services/rulesEngine.js';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-01T08:00:00Z');
const ci = (hours, fields = {}) => ({
  id: `c${hours}`, measuredAt: new Date(T0 + hours * HOUR), vitals: [], symptoms: [], symptomStatus: 'none_reported', wellbeing: {}, ...fields,
});
const dose = (v) => ({ exposure: { doseRate: v, sourceType: 'device_reported' } });
const sym = (code, severity, extra = {}) => ({ code, label: code, severity, ...extra });
const quiet = [ci(0, dose(11)), ci(24, dose(10.9)), ci(48, dose(11.1))];

describe('Health Brain (RHI)', () => {
  test('weights sum to 100', () => {
    assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  });

  test('missing components are "not assessed" and add no points', () => {
    const [a] = assessSeries([ci(0, { symptomStatus: 'not_assessed' })]);
    assert.equal(a.score, 0);
    assert.equal(a.band, 'green');
    assert.equal(a.coverage.assessedWeight, 0);
    assert.deepEqual(a.coverage.notAssessed, ['Exposure', 'Symptoms', 'Biomarkers', 'Wellbeing']);
  });

  test('exposure needs three earlier readings, then scores percent above the personal reference', () => {
    const series = assessSeries([...quiet, ci(72, dose(16.5))]);
    assert.equal(series[2].components[0].assessed, false);
    const exp = series[3].components[0];
    assert.equal(exp.assessed, true);
    assert.equal(exp.subScore, 50);
    assert.equal(exp.points, 17.5);
    assert.equal(series[3].triggers.length, 0);
  });

  test('shelter threshold is a hard trigger that sets RED regardless of score', () => {
    const a = assessCheckIn(ci(72, dose(22.5)), quiet);
    assert.equal(a.score, 35);
    assert.equal(a.scoreBand, 'yellow');
    assert.equal(a.band, 'red');
    assert.equal(a.bandReason, 'hard_trigger');
    assert.deepEqual(a.triggers.map((t) => t.id), ['shelter_threshold']);
  });

  test('vomiting within 2 h of a spike triggers; vomiting without a spike does not', () => {
    const spike = ci(72, dose(17));
    const after = ci(73, { symptoms: [sym('vomiting', 'mild')], symptomStatus: 'reported' });
    assert.ok(assessCheckIn(after, [...quiet, spike]).triggers.some((t) => t.id === 'vomiting_after_spike'));
    const late = ci(76, { symptoms: [sym('vomiting', 'mild')], symptomStatus: 'reported' });
    assert.equal(assessCheckIn(late, [...quiet, spike]).triggers.length, 0);
    assert.equal(assessCheckIn(after, quiet).triggers.length, 0);
  });

  test('fever with lymphocyte drop and chest pain / confusion are hard triggers', () => {
    const base = [ci(0, { biomarkers: { lymphocyteCount: 2.0 } })];
    const fever = ci(24, { biomarkers: { lymphocyteCount: 1.4 }, vitals: [{ metric: 'temperature', value: 38.2, unit: 'degC', quality: 'good' }] });
    assert.deepEqual(assessCheckIn(fever, base).triggers.map((t) => t.id), ['fever_lymphocyte_drop']);
    const noFever = ci(24, { biomarkers: { lymphocyteCount: 1.4 }, vitals: [{ metric: 'temperature', value: 37.2, unit: 'degC', quality: 'good' }] });
    assert.equal(assessCheckIn(noFever, base).triggers.length, 0);
    const chest = ci(24, { symptoms: [sym('chest_discomfort', 'mild')], symptomStatus: 'reported' });
    assert.deepEqual(assessCheckIn(chest, []).triggers.map((t) => t.id), ['chest_pain_or_confusion']);
  });

  test('rules engine raises HB observations only when prior check-ins are supplied', () => {
    const data = { ...ci(72, dose(22.5)), activityContext: 'resting' };
    assert.equal(evaluateCheckIn(data, {}).filter((o) => o.ruleId.startsWith('HB-')).length, 0);
    const obs = evaluateCheckIn(data, { priorCheckIns: quiet }).filter((o) => o.ruleId.startsWith('HB-'));
    assert.equal(obs.length, 1);
    assert.equal(obs[0].ruleId, 'HB-002');
    assert.equal(obs[0].level, 'urgent_review');
    assert.match(obs[0].suggestedNextStep, /has not contacted anyone/);
  });
});
