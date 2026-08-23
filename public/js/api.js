// Thin fetch wrapper around the Reel Picks JSON API.
async function req(method, path, body) {
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

  alist: () => req('GET', '/alist'),
  markWatched: (payload) => req('POST', '/watched', payload),
  undoWatched: (id) => req('DELETE', '/watched/' + id),

  stats: () => req('GET', '/stats'),
  setMatch: (payload) => req('POST', '/match/set', payload),
  unmatched: () => req('GET', '/matches/unmatched'),
  ignoreMatch: (amc_movie_id, amc_title) => req('POST', '/match/ignore', { amc_movie_id, amc_title }),
  unignoreMatch: (amc_movie_id) => req('DELETE', '/match/ignore/' + encodeURIComponent(amc_movie_id)),
  keepMatch: (amc_movie_id) => req('POST', '/match/keep', { amc_movie_id }),
  exportUrl: () => '/api/export',
};
