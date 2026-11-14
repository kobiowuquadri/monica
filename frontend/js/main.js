import { h, mount, clear } from './ui/dom.js';
import { icon, brandMark } from './ui/icons.js';
import { fmtDateTime } from './ui/format.js';
import { toast } from './ui/components.js';
import { get, post, ApiError, clearSessionToken } from './api.js';
import { state, subscribe, setUser, setProfiles, selectProfile, currentProfile, setOpenCounts } from './state.js';
import { defineRoute, startRouter, render as rerender, navigate } from './router.js';
import * as overview from './views/overview.js';
import * as checkin from './views/checkin.js';
import * as trends from './views/trends.js';
import * as environment from './views/environment.js';
import * as actions from './views/actions.js';
import * as reports from './views/reports.js';
import * as sources from './views/sources.js';
import * as settings from './views/settings.js';
import { renderAuth } from './views/auth.js';
import { renderLanding } from './views/landing.js';

const NAV = [
  { group: 'Health', items: [
    { path: '/overview', label: 'Overview', icon: 'overview', view: overview },
    { path: '/check-in', label: 'Health check-in', icon: 'checkin', view: checkin },
    { path: '/trends', label: 'Health trends', icon: 'trends', view: trends },
    { path: '/actions', label: 'Actions & follow-up', icon: 'actions', view: actions, count: true },
  ] },
  { group: 'Environment', items: [
    { path: '/environment', label: 'Radiation & space weather', icon: 'radiation', view: environment },
  ] },
  { group: 'Review', items: [
    { path: '/reports', label: 'Reports', icon: 'reports', view: reports },
    { path: '/sources', label: 'Sources & learning', icon: 'sources', view: sources },
  ] },
  { group: 'Account', items: [
    { path: '/settings', label: 'Profile & settings', icon: 'settings', view: settings },
  ] },
];
const ALL = NAV.flatMap((g) => g.items);
for (const item of ALL) defineRoute(item.path, item.view);

const els = {
  boot: document.getElementById('boot'),
  landing: document.getElementById('landing'),
  auth: document.getElementById('auth'),
  app: document.getElementById('app'),
  nav: document.getElementById('nav'),
  brand: document.getElementById('brand'),
  foot: document.getElementById('sidebar-foot'),
  topbar: document.getElementById('topbar'),
  main: document.getElementById('main'),
  sidebar: document.getElementById('sidebar'),
};
let currentPath = '/overview';
let routerStarted = false;
let menuBtn;
let scrim;

// ---------------- Shell ----------------
function buildBrand() {
  mount(els.brand, brandMark(30), h('span', null, h('span', { class: 'brand-word' }, 'MONICA'), h('span', { class: 'brand-sub' }, 'Mission health console')));
  els.brand.setAttribute('aria-label', 'MONICA — go to overview');
}

function buildNav() {
  clear(els.nav);
  for (const group of NAV) {
    els.nav.append(h('div', { class: 'nav-label' }, group.group));
    for (const item of group.items) {
      const a = h('a', { href: `#${item.path}`, dataset: { path: item.path } }, icon(item.icon), h('span', null, item.label));
      if (item.count) a.append(h('span', { class: 'nav-count', hidden: true, dataset: { role: 'count' } }));
      a.addEventListener('click', () => closeMenu());
      els.nav.append(a);
    }
  }
}

function updateNavCurrent() {
  for (const a of els.nav.querySelectorAll('a')) {
    if (a.dataset.path === currentPath) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function updateNavCounts() {
  const el = els.nav.querySelector('[data-role="count"]');
  if (!el) return;
  const c = state.openCounts;
  const total = c ? c.info + c.attention + c.urgent_review : 0;
  el.hidden = !total;
  el.textContent = String(total);
  el.className = `nav-count${c?.urgent_review ? ' urgent' : c?.attention ? ' attention' : ''}`;
  el.setAttribute('aria-label', `${total} open observation${total === 1 ? '' : 's'}`);
}

function buildFoot() {
  const u = state.user;
  mount(els.foot,
    h('p', null, h('strong', { class: 'muted' }, 'Research prototype.'), ' Not a validated diagnostic or treatment system.'),
    u?.isDemo ? h('p', null, `Demo session — this account and its entries are deleted after ${fmtDateTime(u.demoExpiresAt, 'UTC')}.`) : null,
    h('p', null, 'Not affiliated with or endorsed by NASA.'));
}

function connectionPill() {
  const map = {
    online: ['ok', 'Connected'],
    offline: ['bad', 'Offline — nothing can be saved'],
    db_unavailable: ['warn', 'Database unavailable'],
    unknown: ['', 'Checking connection…'],
  };
  const [cls, text] = map[state.connection] || map.unknown;
  return h('span', { class: 'status-pill', role: 'status', id: 'conn-pill' }, h('span', { class: ['status-dot', cls] }), text);
}

function buildTopbar() {
  menuBtn = h('button', { class: 'btn btn-ghost btn-icon menu-btn', type: 'button', 'aria-label': 'Open navigation', 'aria-expanded': 'false', 'aria-controls': 'sidebar', onclick: toggleMenu }, icon('menu'));
  const profile = currentProfile();
  const title = ALL.find((i) => i.path === currentPath)?.label || '';
  const select = h('select', { class: 'input', id: 'profile-select', 'aria-label': 'Selected profile' },
    state.profiles.map((p) => h('option', { value: p.id, selected: p.id === state.profileId }, p.isFictional ? `${p.displayName} · fictional` : p.displayName)));
  select.addEventListener('change', () => selectProfile(select.value));
  mount(els.topbar,
    menuBtn,
    h('div', { class: 'topbar-title' }, profile ? h('span', null, profile.displayName) : null, profile ? icon('chevronRight', { size: 14 }) : null, h('strong', null, title)),
    h('div', { class: 'topbar-spacer' }),
    connectionPill(),
    state.profiles.length ? h('div', { class: 'profile-switch' }, h('label', { for: 'profile-select' }, 'Profile'), select) : null,
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: signOut, title: 'Sign out' }, icon('logout'), h('span', { class: 'hide-sm' }, 'Sign out')));
}

function toggleMenu() {
  if (els.app.classList.contains('nav-open')) closeMenu(); else openMenu();
}
function openMenu() {
  els.app.classList.add('nav-open');
  menuBtn?.setAttribute('aria-expanded', 'true');
  menuBtn?.setAttribute('aria-label', 'Close navigation');
  scrim = h('div', { class: 'scrim', onclick: closeMenu });
  els.app.append(scrim);
  els.nav.querySelector('a')?.focus();
}
function closeMenu() {
  if (!els.app.classList.contains('nav-open')) return;
  els.app.classList.remove('nav-open');
  menuBtn?.setAttribute('aria-expanded', 'false');
  menuBtn?.setAttribute('aria-label', 'Open navigation');
  scrim?.remove();
  menuBtn?.focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => { if (e.matches) closeMenu(); });

// ---------------- Data ----------------
export async function refreshCounts() {
  if (!state.profileId) { setOpenCounts(null); return; }
  try {
    const { observations } = await get(`/profiles/${state.profileId}/observations?status=open&limit=500`);
    const c = { info: 0, attention: 0, urgent_review: 0 };
    for (const o of observations) c[o.level] += 1;
    setOpenCounts(c);
  } catch { /* counts are decorative; failures are shown by views */ }
}

export async function reloadProfiles() {
  const { profiles } = await get('/profiles');
  setProfiles(profiles);
}

async function signOut() {
  try { await post('/auth/logout'); } catch { /* clear local state regardless */ }
  clearSessionToken();
  setUser(null);
  goSignedOut('#/');
  toast('Signed out.');
}

// ---------------- Signed-out views: landing page, sign-in, registration ----------------
let signedOutView = null;
let landingCleanup = null;

function signedOutModeFor(hash) {
  if (!hash || hash === '#' || hash === '#/') return 'landing';
  if (hash.startsWith('#/register')) return 'register';
  return 'signin'; // #/signin, or a deep link into the app while signed out
}

function showSignedOut({ startupError } = {}) {
  els.boot.hidden = true;
  els.app.hidden = true;
  const mode = signedOutModeFor(window.location.hash);
  if (mode === signedOutView && !startupError) return;
  signedOutView = mode;
  landingCleanup?.();
  landingCleanup = null;
  if (mode === 'landing') {
    els.auth.hidden = true;
    els.landing.hidden = false;
    landingCleanup = renderLanding(els.landing, { onSignedIn: enterApp });
    document.title = 'MONICA — Astronaut Health Monitoring';
  } else {
    els.landing.hidden = true;
    els.auth.hidden = false;
    renderAuth(els.auth, { onSignedIn: enterApp, mode, startupError });
    document.title = `${mode === 'register' ? 'Create account' : 'Sign in'} · MONICA`;
  }
  window.scrollTo(0, 0);
}

function goSignedOut(hash) {
  signedOutView = null;
  history.replaceState(null, '', hash);
  showSignedOut();
}

async function enterApp(user) {
  setUser(user);
  signedOutView = null;
  landingCleanup?.();
  landingCleanup = null;
  els.landing.hidden = true;
  try {
    await reloadProfiles();
    state.reference = await get('/reference');
  } catch (err) {
    els.boot.hidden = true;
    els.auth.hidden = false;
    mount(els.auth, h('div', { class: 'auth-panel' }, h('div', { class: 'auth-card panel' }, h('h1', null, 'MONICA is unavailable'), h('p', { class: 'muted' }, err.message))));
    return;
  }
  els.boot.hidden = true;
  els.auth.hidden = true;
  els.app.hidden = false;
  buildBrand();
  buildNav();
  buildFoot();
  if (['', '#', '#/'].includes(window.location.hash) || /^#\/(signin|register)/.test(window.location.hash)) {
    history.replaceState(null, '', '#/overview');
  }
  if (routerStarted) rerender(); else { routerStarted = true; startRouter(handleRoute); }
  refreshCounts();
}

async function handleRoute({ path, params, view, isCurrent }) {
  if (!state.user) return null; // signed-out navigation is handled by showSignedOut()
  currentPath = path;
  updateNavCurrent();
  buildTopbar();
  const title = ALL.find((i) => i.path === path)?.label || 'MONICA';
  document.title = `${title} · MONICA`;
  clear(els.main);
  const ctx = { params, navigate, isCurrent, refreshCounts, reloadProfiles, rerender };
  try {
    const cleanup = await view.render(els.main, ctx);
    return cleanup;
  } catch (err) {
    console.error(err);
    if (err instanceof ApiError && err.status === 401) { setUser(null); goSignedOut('#/signin'); return null; }
    mount(els.main, h('div', { class: 'empty' }, h('h3', null, 'This page could not be displayed'), h('p', null, err.message || 'Unexpected error.')));
    return null;
  }
}

subscribe((key) => {
  if (key === 'connection') {
    const pill = document.getElementById('conn-pill');
    if (pill) pill.replaceWith(connectionPill());
  }
  if (key === 'profile') {
    refreshCounts();
    rerender();
  }
  if (key === 'profiles') buildTopbar();
  if (key === 'counts') updateNavCounts();
});

// Signed out: the hash selects landing / sign-in / registration. Signed in: move focus to the
// main region after navigation (the router renders the view).
window.addEventListener('hashchange', () => {
  if (!state.user) { showSignedOut(); return; }
  setTimeout(() => els.main.focus({ preventScroll: false }), 0);
  window.scrollTo(0, 0);
});

// The skip link targets whichever main region is visible.
document.getElementById('skip-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  const target = !els.app.hidden ? els.main : !els.landing.hidden ? document.getElementById('landing-main') : els.auth.querySelector('input, button');
  target?.focus();
});

async function boot() {
  // Ask for the session; if the API is slow to answer (free hosting can take up to a minute to
  // wake), show the public landing page meanwhile instead of a blank loading screen.
  const me = get('/me', { timeoutMs: 75_000 }).then((r) => ({ user: r.user }), (err) => ({ err }));
  const early = await Promise.race([me, new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
  if (!early) showSignedOut();
  const res = early || await me;
  if (res.user) { await enterApp(res.user); return; }
  const unexpected = res.err && !(res.err instanceof ApiError && res.err.status === 401);
  if (unexpected && signedOutModeFor(window.location.hash) !== 'landing') showSignedOut({ startupError: res.err });
  else showSignedOut();
}

boot();
