import { config, hasDatabase } from '../config.js';
import { HttpError } from './errors.js';
import { findSessionByToken, touchSession } from '../repositories/sessions.js';

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function requireDatabase(_req, _res, next) {
  if (!hasDatabase()) {
    return next(new HttpError(503, 'database_unavailable', 'Database functionality is unavailable: DATABASE_URL is not configured on the server.'));
  }
  return next();
}

/** Resolves the session cookie to a user. Rejects with 401 if absent, unknown or expired. */
export async function requireAuth(req, _res, next) {
  try {
    const token = readCookie(req, config.cookieName);
    if (!token || token.length < 20 || token.length > 200) {
      throw new HttpError(401, 'not_authenticated', 'Please sign in to continue.');
    }
    const session = await findSessionByToken(token);
    if (!session) throw new HttpError(401, 'session_expired', 'Your session has ended. Please sign in again.');
    req.user = {
      id: session.user_id,
      email: session.email,
      displayName: session.display_name,
      isDemo: session.is_demo,
      demoExpiresAt: session.demo_expires_at,
    };
    req.sessionId = session.id;
    // Best-effort activity timestamp; failure must not block the request.
    touchSession(session.id).catch(() => {});
    return next();
  } catch (err) {
    return next(err);
  }
}
