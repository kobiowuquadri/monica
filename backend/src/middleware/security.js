import helmet from 'helmet';
import cors from 'cors';
import { config } from '../config.js';
import { HttpError } from './errors.js';

export function securityHeaders() {
  // The API only serves JSON, so the CSP can be maximally restrictive.
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export function corsMiddleware() {
  const allowed = new Set(config.allowedOrigins);
  return cors({
    origin(origin, cb) {
      // Same-origin and non-browser requests send no Origin header.
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Requested-With'],
    maxAge: 600,
  });
}

/**
 * CSRF defence for cookie sessions: state-changing requests must carry a custom header
 * (which forces a CORS pre-flight cross-origin) and, when an Origin header is present,
 * it must be same-origin or explicitly allowed.
 */
export function csrfProtection(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'monica') {
    return next(new HttpError(403, 'csrf_header_missing', 'Missing X-Requested-With header.'));
  }
  const origin = req.get('Origin');
  if (origin) {
    let sameHost = false;
    try {
      const host = req.get('X-Forwarded-Host') || req.get('Host');
      sameHost = new URL(origin).host === host;
    } catch { sameHost = false; }
    if (!sameHost && !config.allowedOrigins.includes(origin)) {
      return next(new HttpError(403, 'origin_not_allowed', 'Request origin is not allowed.'));
    }
  }
  return next();
}

/** Logs method, path, status and duration only — never bodies, query strings, cookies or health values. */
export function requestLogger(req, res, next) {
  if (config.isTest) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Path only (no query string); UUIDs in paths are identifiers, not health content.
    console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
}
