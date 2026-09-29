// Thin fetch wrapper around the Reel Picks JSON API.

// Saves in flight (anything but GET), so an app update never reloads the page
// under one (js/update.js). One that hasn't answered in 20 seconds no longer
// counts: a request frozen while an iPhone app was in the background can
// hang for good, and would otherwise hold every update back.
const writes = new Set();
const settled = new Set();
const STUCK_MS = 20000;
export const writesInFlight = () => [...writes].filter((t) => Date.now() - t.at < STUCK_MS).length;
export const onWritesSettled = (fn) => settled.add(fn);

async function req(method, path, body) {
  if (method === 'GET') return send(method, path, body);
  const token = { at: Date.now() };
  writes.add(token);
  try {
    return await send(method, path, body);
  } finally {
    writes.delete(token);
    if (!writesInFlight()) for (const fn of settled) setTimeout(fn, 0);
  }
}

async function send(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// A GET that a newer one can cancel (search as you type).
async function fetchJson(path, { signal } = {}) {
  const res = await fetch('/api' + path, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  status: () => req('GET', '/status'),
  refresh: () => req('POST', '/refresh'),
  recommendations: () => req('GET', '/recommendations'),
  comingSoon: () => req('GET', '/coming-soon'),
  movie: (id) => req('GET', '/movies/' + id),
  person: (id) => req('GET', '/person/' + id),

  settings: () => req('GET', '/settings'),
  saveSettings: (patch) => req('PUT', '/settings', patch),
  theatres: (q) => req('GET', '/theatres?query=' + encodeURIComponent(q || '')),
  setTheatre: (t) => req('POST', '/theatre', t),
  followTheatre: (t) => req('POST', '/theatres/follow', t),
  unfollowTheatre: (id) => req('DELETE', '/theatres/follow/' + encodeURIComponent(id)),
  setPrimaryTheatre: (id) => req('POST', '/theatres/primary', { id }),

  geocode: (q) => req('GET', '/geocode?q=' + encodeURIComponent(q)),
  reverseGeocode: (lat, lng) => req('GET', `/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`),
  clearHome: () => req('DELETE', '/home'),

  ratings: () => req('GET', '/ratings'),
  rate: (payload) => req('POST', '/ratings', payload),
  unrate: (id) => req('DELETE', '/ratings/' + id),
  // The caller's own note on a film they rated (server/lib/notes.js).
  saveNote: (id, note) => req('PUT', `/ratings/${id}/note`, { note }),
  deleteNote: (id) => req('DELETE', `/ratings/${id}/note`),
  importCsv: (csv) => req('POST', '/ratings/import', { csv }),
  letterboxd: () => req('GET', '/letterboxd'),
  letterboxdSave: (username) => req('PUT', '/letterboxd', { username }),
  letterboxdSync: () => req('POST', '/letterboxd/sync'),
  searchRatings: (q) => req('GET', '/ratings/search?q=' + encodeURIComponent(q)),

  onboardingMovies: ({ known = false } = {}) => req('GET', `/onboarding/movies${known ? '?known=1' : ''}`),
  onboardingRate: (ratings) => req('POST', '/onboarding/rate', { ratings }),
  onboardingDone: () => req('POST', '/onboarding/done'),

  watchlist: () => req('GET', '/watchlist'),
  toggleWatchlist: (tmdb_id) => req('POST', '/watchlist/toggle', { tmdb_id }),

  hidden: () => req('GET', '/hidden'),
  hide: (tmdb_id, title) => req('POST', '/hidden', { tmdb_id, title }),
  unhide: (tmdb_id) => req('DELETE', '/hidden/' + tmdb_id),

  alist: () => req('GET', '/alist'),
  markWatched: (payload) => req('POST', '/watched', payload),
  undoWatched: (id) => req('DELETE', '/watched/' + id),

  stats: () => req('GET', '/stats'),
  statsGroup: (kind, name) => req('GET', `/stats/group?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`),
  statsMore: (kind, name) => req('GET', `/stats/more?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`),
  // Your year in movies (js/year.js); the owner's preview any day.
  year: (preview = false) => req('GET', `/year${preview ? '?preview=1' : ''}`),
  yearPosterUrl: (id, preview = false) => `/api/year/poster/${Number(id)}${preview ? '?preview=1' : ''}`,

  friends: () => req('GET', '/friends'),
  addFriend: (name) => req('POST', '/friends', { name }),
  revokeFriend: (id) => req('POST', `/friends/${id}/revoke`),
  reissueFriend: (id) => req('POST', `/friends/${id}/reissue`),
  setMatch: (payload) => req('POST', '/match/set', payload),
  unmatched: () => req('GET', '/matches/unmatched'),
  ignoreMatch: (amc_movie_id, amc_title) => req('POST', '/match/ignore', { amc_movie_id, amc_title }),
  unignoreMatch: (amc_movie_id) => req('DELETE', '/match/ignore/' + encodeURIComponent(amc_movie_id)),
  keepMatch: (amc_movie_id) => req('POST', '/match/keep', { amc_movie_id }),
  social: () => req('GET', '/social'),
  plan: (showtime_id) => req('PUT', '/plans', { showtime_id }),
  cancelPlan: (tmdb_id) => req('DELETE', '/plans/' + tmdb_id),
  answerPlan: (tmdb_id, seen) => req('POST', `/plans/${tmdb_id}/answer`, { seen }),
  sendPick: (payload) => req('POST', '/sends', payload),
  dismissSend: (id) => req('DELETE', '/sends/' + id),
  together: () => req('GET', '/together'),
  togetherWith: (id) => req('GET', `/together/${encodeURIComponent(id)}`),
  pushConfig: () => req('GET', '/push/config'),
  alerts: () => req('GET', '/alerts'),
  offsite: () => req('GET', '/offsite'),
  offsiteUpload: () => req('POST', '/offsite/upload'),
  homePicks: () => req('GET', '/home-picks'),
  suggest: (ask) => req('POST', '/suggest', ask),
  suggestState: (ids) => req('POST', '/suggest/state', { ids }),
  pushCheck: (endpoint) => req('POST', '/push/check', { endpoint }),
  pushSubscribe: (subscription) => req('POST', '/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => req('POST', '/push/unsubscribe', { endpoint }),
  providers: (ids, { skipPlaying = false } = {}) => req('GET', `/providers?ids=${ids.join(',')}${skipPlaying ? '&skipPlaying=1' : ''}`),
  search: (q, opts) => fetchJson('/search?q=' + encodeURIComponent(q), opts),
  searchRecents: () => req('GET', '/search/recents'),
  addRecentQuery: (query) => req('POST', '/search/recents', { query }),
  addRecentMovie: (movie) => req('POST', '/search/recents', { movie }),
  addRecentPerson: (person) => req('POST', '/search/recents', { person }),
  removeRecent: (kind, key) => req('DELETE', `/search/recents?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`),
  clearRecents: () => req('POST', '/search/recents/clear'),
  restoreRecents: (cleared) => req('POST', '/search/recents/restore', cleared),
  exportUrl: () => '/api/export',
  stateUrl: () => '/api/state',
  backupUrl: () => '/api/backup/latest',
  importState: (doc) => req('POST', '/state', doc),
};
