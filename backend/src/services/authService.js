import { randomBytes } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/errors.js';
import { Validator, rejectUnknownKeys } from '../validation/validate.js';
import { findUserByEmail, insertUser } from '../repositories/users.js';
import { createSession } from '../repositories/sessions.js';
import { insertProfile } from '../repositories/profiles.js';
import { recordAudit } from '../repositories/audit.js';
import { hashPassword, verifyPassword, dummyVerify } from './passwords.js';
import { isValidTimezone } from '../validation/profile.js';
import { seedDemoData, DEMO_SCENARIO_NOTE } from './demoSeed.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function validateCredentials(body, { register }) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, register ? ['email', 'password', 'displayName', 'timezone'] : ['email', 'password']);
  const email = v.string('email', b.email, { required: true, max: 254 });
  if (email && !EMAIL_RE.test(email)) v.add('email', 'Enter a valid email address.');
  const password = v.string('password', b.password, { required: true, max: 200, trim: false, min: register ? 10 : 1 });
  const displayName = register ? v.string('displayName', b.displayName, { required: true, min: 1, max: 80 }) : null;
  let timezone = null;
  if (register) {
    timezone = v.string('timezone', b.timezone, { max: 64 });
    if (timezone && !isValidTimezone(timezone)) v.add('timezone', 'Unknown time zone.');
  }
  v.throwIfInvalid();
  return { email: email.toLowerCase(), password, displayName, timezone: timezone || 'UTC' };
}

export function userDto(u) {
  return {
    id: u.id,
    email: u.is_demo ? null : u.email,
    displayName: u.display_name,
    isDemo: u.is_demo,
    demoExpiresAt: u.demo_expires_at,
  };
}

/**
 * Creates the account AND the account holder's own health profile from the same name, so the
 * user never has to enter their name twice. Mission details can be added later.
 */
export async function register(body) {
  const { email, password, displayName, timezone } = validateCredentials(body, { register: true });
  const existing = await findUserByEmail(email);
  if (existing) throw new HttpError(409, 'email_in_use', 'An account with this email already exists. Sign in instead.');
  const passwordHash = await hashPassword(password);
  try {
    return await withTransaction(async (client) => {
      const user = await insertUser(client, { email, passwordHash, displayName });
      const profile = await insertProfile(client, user.id, { displayName, timezone, isFictional: false });
      const session = await createSession(user.id, client);
      await recordAudit(client, { userId: user.id, entityType: 'user', entityId: user.id, action: 'user.registered' });
      await recordAudit(client, { userId: user.id, profileId: profile.id, entityType: 'profile', entityId: profile.id, action: 'profile.created', metadata: { createdAtRegistration: true } });
      return { user: userDto(user), session };
    });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'email_in_use', 'An account with this email already exists. Sign in instead.');
    throw err;
  }
}

export async function login(body) {
  const { email, password } = validateCredentials(body, { register: false });
  const user = await findUserByEmail(email);
  const valid = user && !user.is_demo ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);
  if (!valid) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
  const session = await createSession(user.id);
  return { user: userDto(user), session };
}

/**
 * Starts an isolated public demo account with two clearly fictional profiles that carry a
 * scripted scenario history (see demoSeed.js for what is real NASA data and what is invented).
 * Everything created under it is deleted after DEMO_RETENTION_HOURS.
 */
export async function startDemo({ seed = true } = {}) {
  const suffix = randomBytes(9).toString('base64url');
  const email = `demo-${suffix}@demo.monica.invalid`;
  // Demo accounts cannot sign in with a password; the unusable hash is random.
  const passwordHash = `disabled$${randomBytes(24).toString('base64url')}`;
  const demoExpiresAt = new Date(Date.now() + config.demoRetentionHours * 3600_000);
  const created = await withTransaction(async (client) => {
    const user = await insertUser(client, { email, passwordHash, displayName: 'Demo visitor', isDemo: true, demoExpiresAt });
    const profiles = [
      { displayName: 'Demo Crew Member A', roleTitle: 'Fictional flight engineer', missionName: 'Fictional Mars surface mission (demo)', missionPhase: 'Surface operations', timezone: 'UTC', isFictional: true, notes: seed ? DEMO_SCENARIO_NOTE : 'Fictional demo identity. Contains no real person\'s data.' },
      { displayName: 'Demo Crew Member B', roleTitle: 'Fictional mission specialist', missionName: 'Fictional Mars transit (demo)', missionPhase: 'Interplanetary cruise', timezone: 'UTC', isFictional: true, notes: seed ? 'Fictional demo identity with a scripted history. All entries are invented to demonstrate the logic; no dose-rate readings are recorded for this profile. No real person\'s data.' : 'Fictional demo identity. Contains no real person\'s data.' },
    ];
    const rows = [];
    for (const p of profiles) {
      const row = await insertProfile(client, user.id, p);
      rows.push(row);
      await recordAudit(client, { userId: user.id, profileId: row.id, entityType: 'profile', entityId: row.id, action: 'profile.created', metadata: { fictional: true } });
    }
    const session = await createSession(user.id, client);
    return { user, session, rows };
  });
  let seeded = null;
  if (seed) {
    // The scenario is a convenience: if seeding fails the demo still starts, just empty.
    try {
      seeded = await seedDemoData({ userId: created.user.id, profiles: { a: created.rows[0], b: created.rows[1] } });
    } catch (err) {
      console.error('[demo] scenario seeding failed:', err.code || err.message);
    }
  }
  return { user: userDto(created.user), session: created.session, seeded };
}

/**
 * Session cookie options. When the frontend calls the API from another site (COOKIE_SAMESITE=none),
 * the cookie must be Secure and is marked Partitioned (CHIPS) so browsers that restrict third-party
 * cookies can still keep it per top-level site. Browsers that block it entirely fall back to the
 * Bearer token returned in the sign-in response (held in page memory only).
 */
export function sessionCookieOptions(expiresAt) {
  const raw = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(raw) ? raw : 'lax';
  const crossSite = sameSite === 'none';
  return {
    httpOnly: true,
    secure: config.isProduction || crossSite,
    sameSite,
    ...(crossSite ? { partitioned: true } : {}),
    path: '/',
    expires: expiresAt,
  };
}
