export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(_req, _res, next) {
  next(new HttpError(404, 'not_found', 'The requested resource does not exist.'));
}

/**
 * Central error handler. Messages for unexpected errors are generic so database internals,
 * SQL and stack traces never reach the client. Logs exclude request bodies.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body is too large.' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
  }
  if (err instanceof HttpError) {
    const body = { error: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  // Database connectivity problems are reported honestly but without internals.
  const connCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '08006', '08001']);
  if (connCodes.has(err?.code)) {
    console.error(`[error] database connectivity ${err.code} on ${req.method} ${req.path}`);
    return res.status(503).json({ error: 'database_unreachable', message: 'The database could not be reached. Nothing was saved. Please retry.' });
  }
  console.error(`[error] ${req.method} ${req.path}:`, err?.code || '', err?.message?.slice(0, 200));
  return res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred. Nothing was changed by this request.' });
}
