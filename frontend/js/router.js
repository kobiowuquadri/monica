// Hash router: #/path?key=value. Hash routing keeps static hosting simple (no rewrites needed).

const routes = new Map();
let current = { cleanup: null, token: 0 };
let onChange = () => {};

export function defineRoute(path, view) {
  routes.set(path, view);
}

export function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/overview';
  const [path, qs = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs));
  return { path: path || '/overview', params };
}

export function navigate(path, params) {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const target = `#${path}${qs ? `?${qs}` : ''}`;
  if (window.location.hash === target) render();
  else window.location.hash = target;
}

export function routeFor(path) {
  return routes.get(path) || routes.get('/overview');
}

export function startRouter(handler) {
  onChange = handler;
  window.addEventListener('hashchange', render);
  render();
}

export async function render() {
  const { path, params } = parseHash();
  const view = routeFor(path);
  if (typeof current.cleanup === 'function') {
    try { current.cleanup(); } catch { /* ignore */ }
  }
  current.cleanup = null;
  current.token += 1;
  const token = current.token;
  const result = await onChange({ path: routes.has(path) ? path : '/overview', params, view, isCurrent: () => token === current.token });
  if (token === current.token && typeof result === 'function') current.cleanup = result;
}
