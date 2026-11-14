// MONICA frontend configuration — PUBLIC VALUES ONLY. Never put secrets here.
//
// Production (Vercel): the API is reached at same-origin "/api", which vercel.json rewrites to
// the Render service. This keeps the session cookie first-party.
// Local development: the Express API runs on port 8080 on the same host name.
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

export const API_BASE_URL = isLocal
  ? `${window.location.protocol}//${window.location.hostname}:8080/api`
  : '/api';

export const APP_NAME = 'MONICA';
export const APP_VERSION = '0.1.0-prototype';
