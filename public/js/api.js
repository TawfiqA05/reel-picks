// Thin fetch wrapper around the Reel Picks JSON API.

// Saves in flight (anything but GET), so an app update never reloads the page
// under one (js/update.js).
let writes = 0;
const settled = new Set();
export const writesInFlight = () => writes;
export const onWritesSettled = (fn) => settled.add(fn);

async function req(method, path, body) {
  if (method === 'GET') return send(method, path, body);
  writes++;
  try {
    return await send(method, path, body);
  } finally {
    writes--;
    if (!writes) for (const fn of settled) setTimeout(fn, 0);
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
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  status: () => req('GET', '/status'),
  refresh: () => req('POST', '/refresh'),
  recommendations: () => req('GET', '/recommendations'),
  comingSoon: () => req('GET', '/coming-soon'),
  movie: (id) => req('GET', '/movies/' + id),
  profile: () => req('GET', '/profile'),

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
  importCsv: (csv) => req('POST', '/ratings/import', { csv }),
  searchRatings: (q) => req('GET', '/ratings/search?q=' + encodeURIComponent(q)),

  onboardingMovies: () => req('GET', '/onboarding/movies'),
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

  friends: () => req('GET', '/friends'),
  addFriend: (name) => req('POST', '/friends', { name }),
  revokeFriend: (id) => req('POST', `/friends/${id}/revoke`),
  reissueFriend: (id) => req('POST', `/friends/${id}/reissue`),
  setMatch: (payload) => req('POST', '/match/set', payload),
  unmatched: () => req('GET', '/matches/unmatched'),
  ignoreMatch: (amc_movie_id, amc_title) => req('POST', '/match/ignore', { amc_movie_id, amc_title }),
  unignoreMatch: (amc_movie_id) => req('DELETE', '/match/ignore/' + encodeURIComponent(amc_movie_id)),
  keepMatch: (amc_movie_id) => req('POST', '/match/keep', { amc_movie_id }),
  together: () => req('GET', '/together'),
  togetherWith: (id) => req('GET', `/together/${encodeURIComponent(id)}`),
  exportUrl: () => '/api/export',
  stateUrl: () => '/api/state',
  backupUrl: () => '/api/backup/latest',
  importState: (doc) => req('POST', '/state', doc),
};
