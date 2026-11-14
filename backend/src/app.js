import express from 'express';
import compression from 'compression';
import { config } from './config.js';
import { securityHeaders, corsMiddleware, csrfProtection, requestLogger } from './middleware/security.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';
import { profilesRouter } from './routes/profiles.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(requestLogger);
  app.use(compression());
  app.use(securityHeaders());
  app.use('/api', corsMiddleware());
  app.use('/api', generalLimiter);
  app.use(express.json({ limit: '64kb', strict: true, type: ['application/json'] }));
  app.use('/api', csrfProtection);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use('/api', publicRouter);
  app.use('/api', authRouter);
  app.use('/api', profilesRouter);

  app.get('/', (_req, res) => res.json({ service: 'monica-api', docs: 'See README.md. Health: /api/health, readiness: /api/ready.' }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
