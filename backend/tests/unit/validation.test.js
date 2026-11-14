import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckIn, fingerprintCheckIn, validateIdempotencyKey } from '../../src/validation/checkIn.js';
import { validateProfile } from '../../src/validation/profile.js';

const now = () => new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ok = (over = {}) => ({ measuredAt: now(), activityContext: 'resting', vitals: [{ metric: 'heart_rate', value: 64, unit: 'beats/min', sourceType: 'manual', quality: 'good' }], ...over });
const fields = (fn) => {
  try { fn(); } catch (err) { return (err.details || []).map((d) => d.field); }
  assert.fail('expected validation error');
};

test('accepts a minimal valid check-in and normalises it', () => {
  const v = validateCheckIn(ok());
  assert.equal(v.vitals[0].value, 64);
  assert.equal(v.symptomStatus, 'not_assessed');
  assert.ok(v.measuredAt instanceof Date);
});

test('rejects wrong units and typo-level values (data-entry checks, not clinical ranges)', () => {
  const f = fields(() => validateCheckIn(ok({ vitals: [{ metric: 'heart_rate', value: 720, unit: 'bpm', sourceType: 'manual', quality: 'good' }] })));
  assert.ok(f.includes('vitals[0].unit'));
  assert.ok(f.includes('vitals[0].value'));
});

test('rejects timestamps without a zone offset or in the future', () => {
  assert.ok(fields(() => validateCheckIn(ok({ measuredAt: '2026-11-14T08:00:00' }))).includes('measuredAt'));
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.ok(fields(() => validateCheckIn(ok({ measuredAt: future }))).includes('measuredAt'));
});

test('blood pressure needs both components with systolic above diastolic', () => {
  const single = fields(() => validateCheckIn(ok({ vitals: [{ metric: 'bp_systolic', value: 120, unit: 'mmHg', sourceType: 'manual', quality: 'good' }] })));
  assert.ok(single.includes('vitals'));
  const swapped = fields(() => validateCheckIn(ok({ vitals: [
    { metric: 'bp_systolic', value: 70, unit: 'mmHg', sourceType: 'manual', quality: 'good' },
    { metric: 'bp_diastolic', value: 110, unit: 'mmHg', sourceType: 'manual', quality: 'good' }] })));
  assert.ok(swapped.includes('vitals'));
});

test('temperature requires a measurement method; method is rejected where not applicable', () => {
  assert.ok(fields(() => validateCheckIn(ok({ vitals: [{ metric: 'temperature', value: 36.6, unit: 'degC', sourceType: 'manual', quality: 'good' }] }))).includes('vitals[0].method'));
  assert.ok(fields(() => validateCheckIn(ok({ vitals: [{ metric: 'heart_rate', value: 60, unit: 'beats/min', method: 'oral', sourceType: 'manual', quality: 'good' }] }))).includes('vitals[0].method'));
  const f = validateCheckIn(ok({ vitals: [{ metric: 'temperature', value: 98.2, unit: 'degF', method: 'oral', sourceType: 'manual', quality: 'good' }] }));
  assert.equal(f.vitals[0].unit, 'degF');
});

test('unknown fields and empty check-ins are rejected', () => {
  assert.ok(fields(() => validateCheckIn(ok({ healthScore: 99 }))).includes('healthScore'));
  assert.ok(fields(() => validateCheckIn({ measuredAt: now(), activityContext: 'resting' })).includes('body'));
});

test('symptom status distinguishes "none reported" from "not assessed"', () => {
  assert.equal(validateCheckIn(ok({ symptomStatus: 'none_reported' })).symptomStatus, 'none_reported');
  const withSymptom = validateCheckIn(ok({ symptoms: [{ code: 'headache', severity: 'mild' }] }));
  assert.equal(withSymptom.symptomStatus, 'reported');
  assert.ok(fields(() => validateCheckIn(ok({ symptomStatus: 'reported' }))).includes('symptomStatus'));
  assert.ok(fields(() => validateCheckIn(ok({ symptoms: [{ code: 'other', severity: 'mild' }] }))).includes('symptoms[0].notes'));
});

test('idempotency key format is enforced and fingerprints are stable', () => {
  assert.throws(() => validateIdempotencyKey('short'));
  assert.throws(() => validateIdempotencyKey(undefined));
  assert.equal(validateIdempotencyKey('ci-0123456789abcdef'), 'ci-0123456789abcdef');
  const a = validateCheckIn(ok());
  const b = validateCheckIn(ok({ measuredAt: a.measuredAt.toISOString() }));
  assert.equal(fingerprintCheckIn(a), fingerprintCheckIn(b));
  const c = validateCheckIn(ok({ measuredAt: a.measuredAt.toISOString(), notes: 'different' }));
  assert.notEqual(fingerprintCheckIn(a), fingerprintCheckIn(c));
});

test('profile time zone must be a valid IANA zone', () => {
  assert.equal(validateProfile({ displayName: 'A', timezone: 'America/Chicago' }).timezone, 'America/Chicago');
  assert.throws(() => validateProfile({ displayName: 'A', timezone: 'Mars/Gale' }));
});
