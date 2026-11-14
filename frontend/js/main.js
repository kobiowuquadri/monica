import { h, mount, clear } from './ui/dom.js';
import { icon, brandMark } from './ui/icons.js';
import { fmtDateTime } from './ui/format.js';
import { toast } from './ui/components.js';
import { get, post, ApiError } from './api.js';
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
  setUser(null);
  showAuth();
  toast('Signed out.');
}

// ---------------- Rendering ----------------
function showAuth() {
  els.boot.hidden = true;
  els.app.hidden = true;
  els.auth.hidden = false;
  renderAuth(els.auth, { onSignedIn: enterApp });
}

async function enterApp(user) {
  setUser(user);
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
  if (!window.location.hash || window.location.hash === '#') window.location.hash = '#/overview';
  if (routerStarted) rerender(); else { routerStarted = true; startRouter(handleRoute); }
  refreshCounts();
}

async function handleRoute({ path, params, view, isCurrent }) {
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
    if (err instanceof ApiError && err.status === 401) { setUser(null); showAuth(); return null; }
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

// Route-level focus management: move focus to the main region after navigation.
window.addEventListener('hashchange', () => { setTimeout(() => els.main.focus({ preventScroll: false }), 0); window.scrollTo(0, 0); });

async function boot() {
  // Free hosting tiers can take up to a minute to wake an idle API; say so instead of failing early.
  const slow = setTimeout(() => {
    const msg = els.boot.querySelector('.boot-inner span:last-child');
    if (msg) msg.textContent = 'Waking the MONICA server — on free hosting this can take up to a minute…';
  }, 6000);
  try {
    await get('/health', { timeoutMs: 75_000 });
  } catch {
    // Health failure is reported via the connection state; continue to session check.
  } finally {
    clearTimeout(slow);
  }
  try {
    const { user } = await get('/me');
    await enterApp(user);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401)) showAuth();
    else {
      els.boot.hidden = true;
      els.auth.hidden = false;
      renderAuth(els.auth, { onSignedIn: enterApp, startupError: err });
    }
  }
}

boot();
