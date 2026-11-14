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

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function validateCredentials(body, { register }) {
  const v = new Validator();
  const b = v.object('body', body);
  rejectUnknownKeys(v, '', b, register ? ['email', 'password', 'displayName'] : ['email', 'password']);
  const email = v.string('email', b.email, { required: true, max: 254 });
  if (email && !EMAIL_RE.test(email)) v.add('email', 'Enter a valid email address.');
  const password = v.string('password', b.password, { required: true, max: 200, trim: false, min: register ? 10 : 1 });
  const displayName = register ? v.string('displayName', b.displayName, { required: true, min: 1, max: 80 }) : null;
  v.throwIfInvalid();
  return { email: email.toLowerCase(), password, displayName };
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

export async function register(body) {
  const { email, password, displayName } = validateCredentials(body, { register: true });
  const existing = await findUserByEmail(email);
  if (existing) throw new HttpError(409, 'email_in_use', 'An account with this email already exists. Sign in instead.');
  const passwordHash = await hashPassword(password);
  try {
    return await withTransaction(async (client) => {
      const user = await insertUser(client, { email, passwordHash, displayName });
      const session = await createSession(user.id, client);
      await recordAudit(client, { userId: user.id, entityType: 'user', entityId: user.id, action: 'user.registered' });
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
 * Starts an isolated public demo account with two clearly fictional profiles and no health
 * records. Everything created under it is deleted after DEMO_RETENTION_HOURS.
 */
export async function startDemo() {
  const suffix = randomBytes(9).toString('base64url');
  const email = `demo-${suffix}@demo.monica.invalid`;
  // Demo accounts cannot sign in with a password; the unusable hash is random.
  const passwordHash = `disabled$${randomBytes(24).toString('base64url')}`;
  const demoExpiresAt = new Date(Date.now() + config.demoRetentionHours * 3600_000);
  return withTransaction(async (client) => {
    const user = await insertUser(client, { email, passwordHash, displayName: 'Demo visitor', isDemo: true, demoExpiresAt });
    const profiles = [
      { displayName: 'Demo Crew Member A', roleTitle: 'Fictional flight engineer', missionName: 'Fictional Mars surface mission (demo)', missionPhase: 'Surface operations', timezone: 'UTC', isFictional: true, notes: 'Fictional demo identity. Contains no real person\'s data.' },
      { displayName: 'Demo Crew Member B', roleTitle: 'Fictional mission specialist', missionName: 'Fictional Mars transit (demo)', missionPhase: 'Interplanetary cruise', timezone: 'UTC', isFictional: true, notes: 'Fictional demo identity. Contains no real person\'s data.' },
    ];
    for (const p of profiles) {
      const row = await insertProfile(client, user.id, p);
      await recordAudit(client, { userId: user.id, profileId: row.id, entityType: 'profile', entityId: row.id, action: 'profile.created', metadata: { fictional: true } });
    }
    const session = await createSession(user.id, client);
    return { user: userDto(user), session };
  });
}

export function sessionCookieOptions(expiresAt) {
  const sameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  return {
    httpOnly: true,
    secure: config.isProduction || sameSite === 'none',
    sameSite: ['lax', 'strict', 'none'].includes(sameSite) ? sameSite : 'lax',
    path: '/',
    expires: expiresAt,
  };
}
