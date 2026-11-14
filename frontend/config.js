// MONICA frontend configuration — PUBLIC VALUES ONLY. Never put secrets here.

// Live API (Express on Render). The browser calls it directly; the API must list this site's
// origin in ALLOWED_ORIGINS and use COOKIE_SAMESITE=none (see docs/DEPLOYMENT.md).
export const LIVE_API_BASE_URL = 'https://monica-v3u4.onrender.com/api';

// Set to true to develop against a backend running on this machine (npm run dev → port 8080).
const USE_LOCAL_API = false;

const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

export const API_BASE_URL = USE_LOCAL_API && isLocal
  ? `${window.location.protocol}//${window.location.hostname}:8080/api`
  : LIVE_API_BASE_URL;

export const APP_NAME = 'MONICA';
export const APP_VERSION = '0.1.0-prototype';
