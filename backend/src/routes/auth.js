import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth, requireDatabase, readCookie } from '../middleware/auth.js';
import { authLimiter, demoLimiter } from '../middleware/rateLimit.js';
import { register, login, startDemo, sessionCookieOptions } from '../services/authService.js';
import { deleteSessionByToken } from '../repositories/sessions.js';

export const authRouter = Router();

function setSession(res, session) {
  res.cookie(config.cookieName, session.token, sessionCookieOptions(session.expiresAt));
}

authRouter.post('/auth/register', requireDatabase, authLimiter, async (req, res, next) => {
  try {
    const { user, session } = await register(req.body);
    setSession(res, session);
    res.status(201).json({ user, sessionExpiresAt: session.expiresAt });
  } catch (err) { next(err); }
});

authRouter.post('/auth/login', requireDatabase, authLimiter, async (req, res, next) => {
  try {
    const { user, session } = await login(req.body);
    setSession(res, session);
    res.json({ user, sessionExpiresAt: session.expiresAt });
  } catch (err) { next(err); }
});

authRouter.post('/auth/demo', requireDatabase, demoLimiter, async (_req, res, next) => {
  try {
    const { user, session } = await startDemo();
    setSession(res, session);
    res.status(201).json({
      user,
      sessionExpiresAt: session.expiresAt,
      retention: `This demo account and everything entered in it are deleted automatically after ${config.demoRetentionHours} hours. Entries are visible only to this browser session.`,
    });
  } catch (err) { next(err); }
});

authRouter.post('/auth/logout', requireDatabase, async (req, res, next) => {
  try {
    const token = readCookie(req, config.cookieName);
    if (token) await deleteSessionByToken(token);
    res.clearCookie(config.cookieName, { ...sessionCookieOptions(new Date(0)), expires: undefined });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

authRouter.get('/me', requireDatabase, requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.isDemo ? null : req.user.email,
      displayName: req.user.displayName,
      isDemo: req.user.isDemo,
      demoExpiresAt: req.user.demoExpiresAt,
    },
  });
});
