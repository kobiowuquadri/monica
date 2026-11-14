import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

function limiter({ windowMs, limit, code, message, methods }) {
  return rateLimit({
    windowMs,
    limit: config.isTest ? 10_000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: methods ? (req) => !methods.includes(req.method) : undefined,
    handler: (_req, res) => res.status(429).json({ error: code, message }),
  });
}

export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  code: 'too_many_auth_attempts',
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

export const demoLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  code: 'too_many_demo_sessions',
  message: 'Too many demo sessions were started from this network. Please try again later.',
});

export const writeLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  code: 'too_many_writes',
  message: 'Too many changes in a short period. Nothing further was saved; please retry shortly.',
  methods: ['POST', 'PATCH', 'DELETE'],
});

export const generalLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 1200,
  code: 'too_many_requests',
  message: 'Too many requests. Please slow down.',
});
