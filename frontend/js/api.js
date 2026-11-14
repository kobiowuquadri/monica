import { API_BASE_URL } from '../config.js';
import { setConnection } from './state.js';

export class ApiError extends Error {
  constructor({ status = 0, code = 'error', message = 'Request failed.', details = null, network = false, timeout = false }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.network = network;
    this.timeout = timeout;
  }
}

// Session token from the last sign-in, kept in page memory only (never localStorage/sessionStorage).
// The API also sets an HttpOnly cookie; this header is the fallback for browsers that block the
// cross-site cookie. A page reload clears it — if the cookie is blocked too, the user signs in again.
let sessionToken = null;

export function clearSessionToken() {
  sessionToken = null;
}

/** JSON request helper. Sends the session cookie (credentials: include) and, if known, the token. */
export async function api(path, { method = 'GET', body, idempotencyKey, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json', 'X-Requested-With': 'monica' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method, headers, credentials: 'include', signal: controller.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const timedOut = controller.signal.aborted;
    setConnection('offline');
    throw new ApiError({
      code: timedOut ? 'timeout' : 'network_error',
      message: timedOut ? 'The server did not respond in time.' : 'Could not reach the MONICA server. Check your connection.',
      network: true, timeout: timedOut,
    });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (data && typeof data.sessionToken === 'string') {
    sessionToken = data.sessionToken;
    delete data.sessionToken; // keep it out of every other object the views see
  }
  if (res.status === 401) sessionToken = null;
  if (!res.ok) {
    if (res.status === 503 && (data?.error === 'database_unavailable' || data?.error === 'database_unreachable')) setConnection('db_unavailable');
    else setConnection('online');
    throw new ApiError({ status: res.status, code: data?.error || 'http_error', message: data?.message || `Request failed (HTTP ${res.status}).`, details: data?.details || null });
  }
  setConnection('online');
  return data;
}

export const get = (path, opts) => api(path, { ...opts, method: 'GET' });
export const post = (path, body, opts) => api(path, { ...opts, method: 'POST', body: body ?? {} });
export const patch = (path, body, opts) => api(path, { ...opts, method: 'PATCH', body });

export function newIdempotencyKey() {
  if (crypto.randomUUID) return `ci-${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ci-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function query(params) {
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return q.length ? `?${q.join('&')}` : '';
}
