import './env.js';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { runMigrations } from '../../scripts/migrate.js';
import { getPool, closePool } from '../../src/db/pool.js';
import { importRad } from '../../src/services/importService.js';
import { _resetRadiationCache } from '../../src/services/environmentService.js';
import { archiveFetch, SOL_1812_PRODUCT } from '../helpers/fixtures.js';

const SCHEMA = process.env.DATABASE_SCHEMA;
const HAS_DB = Boolean(process.env.DATABASE_URL);
let server;
let base;

function adminClient() {
  return new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/sslmode=require\b/, 'sslmode=verify-full') });
}

/** Minimal HTTP client with a cookie jar, mirroring the browser frontend. */
function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monica', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data, headers: res.headers };
  };
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hr = (value, extra = {}) => ({ metric: 'heart_rate', value, unit: 'beats/min', sourceType: 'manual', quality: 'good', ...extra });
let keyCounter = 0;
const key = () => `it-${Date.now()}-${++keyCounter}-abcdefgh`;
const count = async (sql, params) => Number((await getPool().query(sql, params)).rows[0].n);

describe('MONICA API (Neon, isolated schema)', { skip: !HAS_DB && 'DATABASE_URL not set — integration tests need a database' }, () => {
  const A = client();
  const B = client();
  let profileA;
  let profileB;

  before(async () => {
    const c = adminClient();
    await c.connect();
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.end();
    await runMigrations({ log: () => {} });
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await closePool();
    const c = adminClient();
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await c.end();
  });

  test('health and readiness report database state', async () => {
    const h = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(h.database, 'configured');
    const r = await fetch(`${base}/ready`).then((x) => x.json());
    assert.equal(r.status, 'ready');
    assert.equal(r.migrationsApplied, 3);
    // The public catalog reports real counts only: an empty schema has no NASA data.
    const cat = await fetch(`${base}/catalog`).then((x) => x.json());
    assert.equal(cat.radiation, null);
    assert.equal(cat.spaceWeather, null);
  });

  test('personal endpoints require authentication and the CSRF header', async () => {
    const anon = client();
    assert.equal((await anon('GET', '/profiles')).status, 401);
    const noHeader = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const badOrigin = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monica', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(badOrigin.status, 403);
  });

  test('registration, login and password handling', async () => {
    const email = `a-${Date.now()}@example.test`;
    const reg = await A('POST', '/auth/register', { email, password: 'correct horse battery', displayName: 'Tester A', timezone: 'America/Chicago' });
    assert.equal(reg.status, 201);
    assert.match(reg.headers.get('set-cookie'), /HttpOnly/i);
    // The name is entered once: registration creates the account holder's own profile from it.
    const own = (await A('GET', '/profiles')).data.profiles;
    assert.equal(own.length, 1);
    assert.equal(own[0].displayName, 'Tester A');
    assert.equal(own[0].timezone, 'America/Chicago');
    assert.equal(own[0].isFictional, false);
    assert.equal((await client()('POST', '/auth/register', { email: `tz-${Date.now()}@example.test`, password: 'another long pass', displayName: 'X', timezone: 'Mars/Gale' })).status, 400);
    assert.equal((await client()('POST', '/auth/register', { email, password: 'another long pass', displayName: 'Dup' })).status, 409);
    assert.equal((await client()('POST', '/auth/login', { email, password: 'wrong password!!' })).status, 401);
    assert.equal((await client()('POST', '/auth/login', { email: email.toUpperCase(), password: 'correct horse battery' })).status, 200);
    const stored = (await getPool().query('SELECT password_hash FROM users WHERE lower(email) = lower($1)', [email])).rows[0].password_hash;
    assert.match(stored, /^scrypt\$/);
    assert.ok(!stored.includes('correct horse'));
    assert.equal((await B('POST', '/auth/register', { email: `b-${Date.now()}@example.test`, password: 'another long pass', displayName: 'Tester B' })).status, 201);
    profileA = (await A('POST', '/profiles', { displayName: 'Profile A', timezone: 'UTC' })).data.profile;
    profileB = (await B('POST', '/profiles', { displayName: 'Profile B', timezone: 'Europe/London' })).data.profile;
    assert.ok(profileA.id && profileB.id);
  });

  test('cross-site frontends can authenticate with the Bearer token when cookies are blocked', async () => {
    const email = `bearer-${Date.now()}@example.test`;
    const reg = await fetch(`${base}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monica' },
      body: JSON.stringify({ email, password: 'bearer token pass 1', displayName: 'Bearer User' }),
    });
    const body = await reg.json();
    assert.equal(reg.status, 201);
    assert.match(body.sessionToken, /^[A-Za-z0-9_-]{20,}$/);
    // No cookie sent — only the Authorization header.
    const authHeaders = { Authorization: `Bearer ${body.sessionToken}`, 'X-Requested-With': 'monica', 'Content-Type': 'application/json' };
    const me = await fetch(`${base}/me`, { headers: authHeaders });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.displayName, 'Bearer User');
    // Ownership checks still apply to Bearer sessions.
    assert.equal((await fetch(`${base}/profiles/${profileA.id}/overview`, { headers: authHeaders })).status, 404);
    assert.equal((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer not-a-real-token-123456' } })).status, 401);
    // Logout via the header revokes the session server-side.
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: authHeaders, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/me`, { headers: authHeaders })).status, 401);
    // The session token is stored only as a keyed hash.
    const stored = await count('SELECT count(*) AS n FROM sessions WHERE token_hash = $1', [body.sessionToken]);
    assert.equal(stored, 0);
  });

  test('cross-site cookie mode marks the session cookie Secure and Partitioned', async () => {
    const { sessionCookieOptions } = await import('../../src/services/authService.js');
    process.env.COOKIE_SAMESITE = 'none';
    try {
      const opts = sessionCookieOptions(new Date(Date.now() + 3600_000));
      assert.equal(opts.sameSite, 'none');
      assert.equal(opts.secure, true);
      assert.equal(opts.partitioned, true);
      assert.equal(opts.httpOnly, true);
    } finally {
      delete process.env.COOKIE_SAMESITE;
    }
    const lax = sessionCookieOptions(new Date());
    assert.equal(lax.sameSite, 'lax');
    assert.equal(lax.partitioned, undefined);
  });

  test('cross-user access is denied for every personal endpoint', async () => {
    const id = profileA.id;
    const list = await B('GET', '/profiles');
    assert.ok(!list.data.profiles.some((p) => p.id === id));
    for (const path of [`/profiles/${id}/overview`, `/profiles/${id}/check-ins`, `/profiles/${id}/trends`, `/profiles/${id}/observations`, `/profiles/${id}/actions`, `/profiles/${id}/report`, `/profiles/${id}/history`, `/profiles/${id}/baselines`]) {
      assert.equal((await B('GET', path)).status, 404, path);
    }
    const write = await B('POST', `/profiles/${id}/check-ins`, { measuredAt: iso(60_000), activityContext: 'resting', vitals: [hr(60)] }, { 'Idempotency-Key': key() });
    assert.equal(write.status, 404);
    assert.equal((await B('PATCH', `/profiles/${id}`, { displayName: 'hijack' })).status, 404);
    assert.equal(await count('SELECT count(*) AS n FROM check_ins WHERE profile_id = $1', [id]), 0);
  });

  test('check-in is stored and retrieved exactly; missing readings stay unknown', async () => {
    const body = {
      measuredAt: iso(30 * 60_000), activityContext: 'resting', symptomStatus: 'none_reported',
      vitals: [hr(63), { metric: 'spo2', value: 97, unit: '%', sourceType: 'device_reported', deviceLabel: 'Oximeter', quality: 'uncertain' }],
      wellbeing: { sleepDurationHours: 7.25, fatigueRating: 3 },
    };
    const res = await A('POST', `/profiles/${profileA.id}/check-ins`, body, { 'Idempotency-Key': key() });
    assert.equal(res.status, 201);
    assert.equal(res.data.replayed, false);
    const row = (await getPool().query('SELECT metric, value, unit, source_type, quality FROM vital_readings WHERE check_in_id = $1 ORDER BY metric', [res.data.checkIn.id])).rows;
    assert.deepEqual(row.map((r) => [r.metric, r.value, r.unit, r.source_type, r.quality]), [['heart_rate', 63, 'beats/min', 'manual', 'good'], ['spo2', 97, '%', 'device_reported', 'uncertain']]);
    const got = await A('GET', `/profiles/${profileA.id}/check-ins/${res.data.checkIn.id}`);
    assert.equal(got.data.checkIn.wellbeing.sleepDurationHours, 7.25);
    assert.equal(got.data.checkIn.wellbeing.moodRating, null);
    assert.equal(got.data.checkIn.symptomStatus, 'none_reported');

    const ov = await A('GET', `/profiles/${profileA.id}/overview`);
    const byMetric = Object.fromEntries(ov.data.vitals.map((v) => [v.metric, v.reading]));
    assert.equal(byMetric.heart_rate.value, 63);
    assert.equal(byMetric.temperature, null);
    assert.equal(byMetric.respiratory_rate, null);
    assert.equal(ov.data.wellbeing.find((w) => w.metric === 'mood_rating').reading, null);
    assert.ok(!('healthScore' in ov.data));
  });

  test('duplicate submissions never create duplicate records', async () => {
    const k = key();
    const body = { measuredAt: iso(20 * 60_000), activityContext: 'resting', vitals: [hr(65)] };
    const first = await A('POST', `/profiles/${profileA.id}/check-ins`, body, { 'Idempotency-Key': k });
    const retry = await A('POST', `/profiles/${profileA.id}/check-ins`, body, { 'Idempotency-Key': k });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.replayed, true);
    assert.equal(retry.data.checkIn.id, first.data.checkIn.id);
    const conflict = await A('POST', `/profiles/${profileA.id}/check-ins`, { ...body, vitals: [hr(99)] }, { 'Idempotency-Key': k });
    assert.equal(conflict.status, 409);
    assert.equal(await count('SELECT count(*) AS n FROM check_ins WHERE idempotency_key = $1', [k]), 1);

    const k2 = key();
    const concurrent = await Promise.all([1, 2, 3].map(() => A('POST', `/profiles/${profileA.id}/check-ins`, { ...body, vitals: [hr(66)] }, { 'Idempotency-Key': k2 })));
    assert.ok(concurrent.every((r) => r.status === 201 || r.status === 200));
    assert.equal(new Set(concurrent.map((r) => r.data.checkIn.id)).size, 1);
    assert.equal(await count('SELECT count(*) AS n FROM check_ins WHERE idempotency_key = $1', [k2]), 1);
    assert.equal((await A('POST', `/profiles/${profileA.id}/check-ins`, body)).status, 400); // key required
  });

  test('invalid input is rejected and nothing is written', async () => {
    const before = await count('SELECT count(*) AS n FROM check_ins WHERE profile_id = $1', [profileA.id]);
    const res = await A('POST', `/profiles/${profileA.id}/check-ins`, { measuredAt: 'yesterday', activityContext: 'resting', vitals: [hr(900)] }, { 'Idempotency-Key': key() });
    assert.equal(res.status, 400);
    assert.ok(res.data.details.length >= 2);
    const huge = await A('POST', `/profiles/${profileA.id}/check-ins`, { notes: 'x'.repeat(100_000) }, { 'Idempotency-Key': key() });
    assert.equal(huge.status, 413);
    assert.equal(await count('SELECT count(*) AS n FROM check_ins WHERE profile_id = $1', [profileA.id]), before);
  });

  test('without a baseline no comparison is fabricated; baselines need enough readings', async () => {
    const t = await A('GET', `/profiles/${profileA.id}/trends?metric=heart_rate`);
    assert.equal(t.data.baseline, null);
    assert.match(t.data.baselineUnavailableReason, /unavailable/i);
    const obs = await A('GET', `/profiles/${profileA.id}/observations`);
    assert.ok(!obs.data.observations.some((o) => o.ruleId === 'PT-001'));

    const window = { windowStart: iso(30 * 86_400_000), windowEnd: iso(0) };
    const insufficient = await A('POST', `/profiles/${profileA.id}/baselines`, { metric: 'heart_rate', method: 'median_of_resting_readings', unit: 'beats/min', ...window });
    assert.equal(insufficient.status, 422);
    assert.equal(await count('SELECT count(*) AS n FROM baselines WHERE profile_id = $1', [profileA.id]), 0);

    for (const v of [60, 61, 62]) {
      await A('POST', `/profiles/${profileA.id}/check-ins`, { measuredAt: iso(v * 3600_000), activityContext: 'resting', vitals: [hr(v)] }, { 'Idempotency-Key': key() });
    }
    await A('POST', `/profiles/${profileA.id}/check-ins`, { measuredAt: iso(5 * 3600_000), activityContext: 'post_exercise', vitals: [hr(130)] }, { 'Idempotency-Key': key() });
    const ok = await A('POST', `/profiles/${profileA.id}/baselines`, { metric: 'heart_rate', method: 'median_of_resting_readings', unit: 'beats/min', ...window });
    assert.equal(ok.status, 201);
    // Resting readings 60, 61, 62, 63, 65, 66 → median 62.5; the post-exercise 130 is excluded.
    assert.equal(ok.data.baseline.value, 62.5);
    assert.equal(ok.data.baseline.sampleCount, 6);

    const next = await A('POST', `/profiles/${profileA.id}/check-ins`, { measuredAt: iso(60_000), activityContext: 'resting', vitals: [hr(70)] }, { 'Idempotency-Key': key() });
    const pt = next.data.observations.find((o) => o.ruleId === 'PT-001');
    assert.ok(pt);
    assert.equal(pt.level, 'info');
    assert.equal(pt.triggeringInputs.comparisons[0].difference, 7.5);
  });

  test('follow-up creation and completion, scoped to the owner', async () => {
    const urgent = await A('POST', `/profiles/${profileA.id}/check-ins`, {
      measuredAt: iso(10 * 60_000), activityContext: 'resting', vitals: [hr(64)],
      symptoms: [{ code: 'shortness_of_breath', severity: 'moderate', markedUrgent: true }],
    }, { 'Idempotency-Key': key() });
    const obs = urgent.data.observations.find((o) => o.ruleId === 'HC-002');
    assert.equal(obs.level, 'urgent_review');

    assert.equal((await A('POST', `/profiles/${profileA.id}/observations/${obs.id}/acknowledge`)).data.observation.status, 'acknowledged');
    const fu = await A('POST', `/profiles/${profileA.id}/actions`, { kind: 'follow_up', description: 'Repeat check-in', scheduledFor: iso(-3600_000), observationId: obs.id });
    assert.equal(fu.status, 201);
    assert.equal(fu.data.action.status, 'planned');
    assert.equal((await A('POST', `/profiles/${profileA.id}/actions`, { kind: 'follow_up', description: 'no time' })).status, 400);

    const bCheckIn = await B('POST', `/profiles/${profileB.id}/check-ins`, { measuredAt: iso(60_000), activityContext: 'resting', vitals: [hr(70)] }, { 'Idempotency-Key': key() });
    const foreign = await A('PATCH', `/profiles/${profileA.id}/actions/${fu.data.action.id}`, { status: 'completed', completionCheckInId: bCheckIn.data.checkIn.id });
    assert.equal(foreign.status, 404);
    assert.equal((await B('PATCH', `/profiles/${profileA.id}/actions/${fu.data.action.id}`, { status: 'completed' })).status, 404);

    const done = await A('PATCH', `/profiles/${profileA.id}/actions/${fu.data.action.id}`, { status: 'completed', completionCheckInId: urgent.data.checkIn.id });
    assert.equal(done.status, 200);
    assert.equal(done.data.action.status, 'completed');
    assert.equal((await A('PATCH', `/profiles/${profileA.id}/actions/${fu.data.action.id}`, { status: 'cancelled' })).status, 409);

    const detail = await A('GET', `/profiles/${profileA.id}/observations/${obs.id}`);
    const actions = detail.data.history.map((h) => h.action);
    assert.ok(actions.includes('observation.generated'));
    assert.ok(actions.includes('observation.acknowledged'));
    assert.ok(actions.includes('observation.follow_up_completed'));
  });

  test('reports contain only the owner\'s records; audit history holds no health values', async () => {
    const rep = await A('GET', `/profiles/${profileA.id}/report`);
    assert.equal(rep.status, 200);
    assert.equal(rep.data.profile.id, profileA.id);
    const ownIds = new Set((await getPool().query('SELECT id FROM check_ins WHERE profile_id = $1', [profileA.id])).rows.map((r) => r.id));
    assert.ok(rep.data.checkIns.length > 0);
    assert.ok(rep.data.checkIns.every((c) => ownIds.has(c.id)));
    assert.ok(rep.data.limitations.length > 0);
    assert.ok(rep.data.missingDataNotes.some((n) => /Respiratory rate/.test(n)));
    assert.equal((await B('GET', `/profiles/${profileA.id}/report`)).status, 404);
    const repB = await B('GET', `/profiles/${profileB.id}/report`);
    assert.ok(repB.data.checkIns.every((c) => !ownIds.has(c.id)));

    const meta = (await getPool().query("SELECT metadata FROM audit_events WHERE profile_id = $1 AND action = 'check_in.created'", [profileA.id])).rows;
    for (const m of meta) assert.deepEqual(Object.keys(m.metadata).sort(), ['observations', 'rulesVersion', 'symptoms', 'vitals']);
  });

  test('demo sessions are isolated, fictional and start with a labelled scripted scenario', async () => {
    const d1 = client();
    const d2 = client();
    assert.equal((await d1('POST', '/auth/demo')).status, 201);
    assert.equal((await d2('POST', '/auth/demo')).status, 201);
    const p1 = (await d1('GET', '/profiles')).data.profiles;
    const p2 = (await d2('GET', '/profiles')).data.profiles;
    assert.equal(p1.length, 2);
    assert.ok(p1.every((p) => p.isFictional));
    assert.ok(!p2.some((p) => p1.find((q) => q.id === p.id)));
    assert.equal((await d2('GET', `/profiles/${p1[0].id}/overview`)).status, 404);
    const ov = await d1('GET', `/profiles/${p1[0].id}/overview`);
    assert.equal(ov.data.checkIns.total, 12);
    assert.match(ov.data.profile.notes, /Fictional demo identity with a scripted history/);
    const hb = ov.data.healthBrain;
    assert.equal(hb.history.length, 12);
    assert.ok(hb.current.score >= 0 && hb.current.score <= 100);
    assert.ok(['green', 'yellow', 'orange', 'red'].includes(hb.current.band));
    const page = await d1('GET', `/profiles/${p1[1].id}/health-brain`);
    assert.equal(page.status, 200);
    assert.ok(page.data.history.every((a) => a.components[0].assessed === false));
  });

  test('NASA RAD import is deduplicated, keeps provenance, units and separate channels', async () => {
    const first = await importRad({ fromSol: 1812, toSol: 1812, products: [SOL_1812_PRODUCT], fetchImpl: archiveFetch() });
    assert.equal(first.status, 'succeeded');
    assert.equal(first.inserted, 2);
    const again = await importRad({ fromSol: 1812, toSol: 1812, products: [SOL_1812_PRODUCT], fetchImpl: archiveFetch() });
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicates, 2);

    const rows = (await getPool().query('SELECT detector, value, value_text, unit, product_id, label_file_url, import_run_id, quality_status, qc_raw FROM radiation_observations ORDER BY detector')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.detector, r.value_text, r.unit]), [['B', '10.79981', 'microGray / Hour'], ['E', '11.31774', 'microGray / Hour']]);
    assert.ok(rows.every((r) => r.product_id === 'RAD_RDR_2017_253_04_24_1812_V00' && r.import_run_id === first.runId && r.qc_raw === '00000000'));
    const run = (await getPool().query('SELECT status, records_inserted, importer_version FROM import_runs WHERE id = $1', [first.runId])).rows[0];
    assert.equal(run.status, 'succeeded');

    _resetRadiationCache();
    const api = (await fetch(`${base}/radiation`).then((r) => r.json()));
    assert.deepEqual(Object.keys(api.series).sort(), ['B', 'E']);
    assert.equal(api.series.B[0].value, 10.79981);
    assert.equal(api.series.E[0].value, 11.31774);
    assert.equal(api.dataset.unit, 'microGray / Hour');
    assert.equal(api.label, 'Historical NASA data');
    assert.equal(api.products[api.series.B[0].product].productId, 'RAD_RDR_2017_253_04_24_1812_V00');
  });

  test('NASA import failures are recorded honestly with no rows invented', async () => {
    const before = await count('SELECT count(*) AS n FROM radiation_observations', []);
    const failing = async () => { throw new TypeError('fetch failed'); };
    const res = await importRad({ fromSol: 1813, toSol: 1813, products: [{ ...SOL_1812_PRODUCT, sol: 1813, productId: 'RAD_RDR_X_1813_V00', labelPath: '/DATA/X/RAD_RDR_X_1813_V00.LBL' }], fetchImpl: failing });
    assert.equal(res.status, 'failed');
    assert.ok(res.messages.some((m) => /FAILED/.test(m)));
    assert.equal(await count('SELECT count(*) AS n FROM radiation_observations', []), before);
    const run = (await getPool().query('SELECT status FROM import_runs WHERE id = $1', [res.runId])).rows[0];
    assert.equal(run.status, 'failed');
  });
});
