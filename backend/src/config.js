import 'dotenv/config';

function parseOrigins(value) {
  return (value || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: intOr(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL || '',
  authSecret: process.env.AUTH_SECRET || '',
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
  nasaApiKey: process.env.NASA_API_KEY || '',
  trustProxy: process.env.TRUST_PROXY === 'true',
  demoRetentionHours: intOr(process.env.DEMO_RETENTION_HOURS, 24),
  sessionTtlHours: 12,
  cookieName: 'monica_session',
});

export function hasDatabase() {
  return Boolean(config.databaseUrl);
}

/** Configuration problems that should be surfaced at start-up (never secrets themselves). */
export function configWarnings() {
  const warnings = [];
  if (!config.databaseUrl) warnings.push('DATABASE_URL is not set: database functionality is unavailable.');
  if (!config.authSecret || config.authSecret.length < 32) {
    warnings.push('AUTH_SECRET is missing or shorter than 32 characters.');
  }
  if (config.allowedOrigins.length === 0) warnings.push('ALLOWED_ORIGINS is empty: cross-origin browser requests will be refused.');
  if (!config.nasaApiKey) warnings.push('NASA_API_KEY not set: DONKI requests use the rate-limited DEMO_KEY.');
  return warnings;
}
