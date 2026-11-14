// In-memory application state. Health data is never written to browser storage; only the
// selected profile id (not sensitive) is remembered for the tab session.

export const state = {
  user: null,
  profiles: [],
  profileId: null,
  connection: 'unknown',     // online | offline | db_unavailable | unknown
  reference: null,           // metric/symptom/rule definitions from /api/reference
  checkInDraft: null,        // unsaved check-in kept in memory across failures/navigation
  openCounts: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(key) {
  for (const fn of listeners) {
    try { fn(key, state); } catch (err) { console.error(err); }
  }
}

export function setConnection(value) {
  if (state.connection !== value) {
    state.connection = value;
    emit('connection');
  }
}

export function setProfiles(profiles) {
  state.profiles = profiles;
  let remembered = null;
  try { remembered = sessionStorage.getItem('monica.profileId'); } catch { remembered = null; }
  const ids = profiles.map((p) => p.id);
  if (!ids.includes(state.profileId)) state.profileId = ids.includes(remembered) ? remembered : (ids[0] || null);
  emit('profiles');
}

export function selectProfile(id) {
  if (state.profileId === id) return;
  state.profileId = id;
  try { sessionStorage.setItem('monica.profileId', id); } catch { /* storage may be unavailable */ }
  emit('profile');
}

export function currentProfile() {
  return state.profiles.find((p) => p.id === state.profileId) || null;
}

export function setUser(user) {
  state.user = user;
  if (!user) {
    state.profiles = [];
    state.profileId = null;
    state.checkInDraft = null;
  }
  emit('user');
}

export function setOpenCounts(counts) {
  state.openCounts = counts;
  emit('counts');
}
