// TMDB client — posters, metadata, credits, trailers, now-playing/upcoming.
import { config } from '../env.js';
import { cachedJson, fetchJson } from './cache.js';
import { run } from '../db.js';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const DAY = 86400;

export function tmdbConfigured() {
  return Boolean(config.tmdbKey);
}

// Standard, stable TMDB movie genre id -> name map (used for search/list results
// that only return genre_ids; full detail responses include names directly).
export const TMDB_GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western',
};

function url(path, params = {}) {
  const u = new URL(BASE + path);
  u.searchParams.set('api_key', config.tmdbKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

export function img(path, size = 'w500') {
  return path ? `${IMG}/${size}${path}` : null;
}

// Live TMDB calls (cache hits don't count): how many, and the most seen in
// any one-second window. Owner diagnostics, and what the backfill's throttle
// is checked against.
export const netStats = { calls: 0, maxPerSecond: 0 };
const recent = [];
function countCall() {
  const now = Date.now();
  recent.push(now);
  while (recent.length && recent[0] <= now - 1000) recent.shift();
  netStats.calls++;
  netStats.maxPerSecond = Math.max(netStats.maxPerSecond, recent.length);
}

// `gate` (optional) is awaited just before a LIVE call, never on a cache hit,
// so a throttled caller only waits when it really goes to the network.
// `more(data, live)` (optional) can top up a fresh response before it is
// cached; `live(path, params)` makes another gated, counted call.
function req(key, ttl, path, params, { force = false, gate = null, more = null } = {}) {
  if (!tmdbConfigured()) throw new Error('TMDB_API_KEY is not set');
  const live = async (p, q) => {
    if (gate) await gate();
    countCall();
    return fetchJson(url(p, q));
  };
  return cachedJson(`tmdb:${key}`, ttl, async () => {
    const data = await live(path, params);
    return more ? more(data, live) : data;
  }, { force });
}

export async function search(title, year) {
  const data = await req(
    `search:${title.toLowerCase()}:${year || ''}`,
    7 * DAY,
    '/search/movie',
    { query: title, year: year || undefined, include_adult: 'false', language: 'en-US' },
  );
  return data?.results || [];
}

// `force` bypasses the 7-day cache (used while a release is settling).
// Videos come back in English plus those with no language set. A film with
// no YouTube video among those (a foreign film with only its own-language
// trailers) gets one more call for its videos in every language.
export async function details(tmdbId, { force = false, gate = null } = {}) {
  return req(`movie:${tmdbId}`, 7 * DAY, `/movie/${tmdbId}`, {
    append_to_response: 'videos,credits,release_dates',
    language: 'en-US',
    include_video_language: 'en,null',
  }, {
    force,
    gate,
    more: async (d, live) => {
      if ((d?.videos?.results || []).some((v) => v.site === 'YouTube')) return d;
      try {
        const all = await live(`/movie/${tmdbId}/videos`, {});
        if (all?.results?.length) d.videos = all;
      } catch { /* no trailer is fine; the film itself loaded */ }
      return d;
    },
  });
}

export async function nowPlaying(page = 1) {
  const data = await req(`now_playing:${page}`, DAY, '/movie/now_playing', {
    region: 'US', page, language: 'en-US',
  });
  return data?.results || [];
}

export async function upcoming(page = 1) {
  const data = await req(`upcoming:${page}`, DAY, '/movie/upcoming', {
    region: 'US', page, language: 'en-US',
  });
  return data?.results || [];
}

export async function popular(page = 1) {
  const data = await req(`popular:${page}`, 7 * DAY, '/movie/popular', {
    region: 'US', page, language: 'en-US',
  });
  return data?.results || [];
}

// The films the most people have rated on TMDB (Inception, The Dark Knight,
// …): ones a new user has most likely seen. Cached 7 days.
export async function wellKnown(page = 1, { gate = null } = {}) {
  const data = await req(`well_known:${page}`, 7 * DAY, '/discover/movie', {
    sort_by: 'vote_count.desc', include_adult: 'false', include_video: 'false', page, language: 'en-US',
  }, { gate });
  return data?.results || [];
}

// A person's film credits (cast and crew), shared by everyone for 7 days.
// Callers pass the backfill throttle as `gate`.
export async function personCredits(personId, { gate = null } = {}) {
  return req(`person:${personId}:movie_credits`, 7 * DAY, `/person/${personId}/movie_credits`, {
    language: 'en-US',
  }, { gate });
}

// Where a film streams in the US (TMDB watch providers, data from JustWatch),
// kept per film for 3 days. Only the US part is stored: Stream (subscription,
// free and with-ads together), Rent and Buy, each in TMDB's display order, and
// TMDB's page for the film. `flatrate` (included with a subscription) and
// `free` (free or with ads) keep Stream's two halves apart for the "At home"
// picks. Null when there is nothing in the US.
export async function watchProviders(tmdbId, { gate = null } = {}) {
  if (!tmdbConfigured()) throw new Error('TMDB_API_KEY is not set');
  return cachedJson(`tmdb:providers:v2:${tmdbId}`, 3 * DAY, async () => {
    if (gate) await gate();
    countCall();
    const us = (await fetchJson(url(`/movie/${tmdbId}/watch/providers`)))?.results?.US;
    const list = (...groups) => {
      const seen = new Set();
      return groups.flat().filter(Boolean)
        .sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99))
        .filter((p) => !seen.has(p.provider_id) && seen.add(p.provider_id))
        .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: img(p.logo_path, 'w92') }));
    };
    const out = {
      link: us?.link || null, stream: list(us?.flatrate, us?.free, us?.ads), rent: list(us?.rent), buy: list(us?.buy),
      flatrate: list(us?.flatrate), free: list(us?.free, us?.ads),
    };
    return out.stream.length || out.rent.length || out.buy.length ? out : null;
  });
}

// Films a streaming service carries in the US, most popular first (or best
// rated, with `sort`), 20 a page: TMDB's discover, filtered by watch provider
// and how it's offered ('flatrate', or 'ads|free'), and optionally genres
// (TMDB genre ids, any of them). TMDB's provider filter is loose,
// so callers confirm each film with watchProviders(). Shared by everyone and
// cached 6 days, so each week's picks start from a fresh list.
export async function discoverStreaming(providerIds, { monetization = 'flatrate', sort = 'popularity.desc', minVotes = 50, page = 1, genres = null, gate = null } = {}) {
  const ids = [...providerIds].sort((a, b) => a - b).join('|');
  const withGenres = genres?.length ? [...genres].sort((a, b) => a - b).join('|') : undefined; // any of them
  const data = await req(`discover:stream:${ids}:${monetization}:${sort}:${minVotes}:${withGenres || ''}:${page}`, 6 * DAY, '/discover/movie', {
    watch_region: 'US', with_watch_providers: ids, with_watch_monetization_types: monetization, with_genres: withGenres,
    'vote_count.gte': minVotes, sort_by: sort, include_adult: 'false', include_video: 'false', language: 'en-US', page,
  }, { gate });
  return (data?.results || []).map((r) => ({ ...lightMovie(r), popularity: r.popularity ?? 0 }));
}

// Typing makes a cache row per spelling ("inte", "inter", …), so expired
// ones are swept out, at most once an hour, instead of piling up.
let sweptAt = 0;
function sweepSearches() {
  if (Date.now() - sweptAt < 3600e3) return;
  sweptAt = Date.now();
  run("DELETE FROM cache WHERE key LIKE 'tmdb:find:%' AND fetched_at < ?", new Date(Date.now() - DAY * 1000).toISOString());
}

// The header search. Cached a day per spelling, and `gate` (the shared TMDB
// throttle) is awaited before any live call, so typing can't outrun the budget
// the backfill and Stats share.
export async function searchTitles(query, { gate = null } = {}) {
  sweepSearches();
  const data = await req(`find:${query.toLowerCase()}`, DAY, '/search/movie',
    { query, include_adult: 'false', language: 'en-US' }, { gate });
  return (data?.results || []).map((r) => ({ ...lightMovie(r), popularity: r.popularity ?? 0 }));
}

// Live (uncached) search for the in-app rating screen so results feel instant/fresh.
export async function liveSearch(query) {
  if (!tmdbConfigured()) throw new Error('TMDB_API_KEY is not set');
  const data = await fetchJson(url('/search/movie', { query, include_adult: 'false', language: 'en-US' }));
  return (data?.results || []).map(lightMovie);
}

// Compact shape for list/search/onboarding cards.
export function lightMovie(r) {
  return {
    tmdb_id: r.id,
    title: r.title || r.name,
    year: (r.release_date || '').slice(0, 4) || null,
    poster: img(r.poster_path, 'w342'),
    backdrop: img(r.backdrop_path, 'w780'),
    tmdb_rating: r.vote_average ?? null,
    tmdb_votes: r.vote_count ?? null,
    genres: (r.genre_ids || []).map((id) => TMDB_GENRES[id]).filter(Boolean),
    synopsis: r.overview || '',
    release_date: r.release_date || null,
  };
}

// A YouTube trailer, best first: type Trailer over Teaser over anything else,
// then English, then official, then the newest. Exported for tests.
export function pickTrailer(videos) {
  const yt = (videos?.results || []).filter((v) => v.site === 'YouTube' && v.key);
  const typeRank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : 2);
  const best = yt.sort((a, b) => typeRank(a) - typeRank(b)
    || Number(b.iso_639_1 === 'en') - Number(a.iso_639_1 === 'en')
    || Number(Boolean(b.official)) - Number(Boolean(a.official))
    || String(b.published_at || '').localeCompare(String(a.published_at || '')))[0];
  return best?.key || null;
}

function pickMpaa(releaseDates) {
  const us = (releaseDates?.results || []).find((r) => r.iso_3166_1 === 'US');
  if (!us) return null;
  const cert = (us.release_dates || []).map((d) => d.certification).find((c) => c && c.trim());
  return cert || null;
}

// The US theatrical release (TMDB types 2 limited, 3 theatrical), earliest
// first. TMDB's own release_date is often a festival or foreign premiere, which
// says nothing about when a US audience can see the film.
export function pickUsRelease(releaseDates) {
  const us = (releaseDates?.results || []).find((r) => r.iso_3166_1 === 'US');
  const dates = (us?.release_dates || [])
    .filter((d) => d.type === 2 || d.type === 3)
    .map((d) => String(d.release_date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  return dates[0] || null;
}

// Convert a full TMDB detail response into our canonical movie shape.
export function normalizeDetails(d) {
  const dir = (d.credits?.crew || []).find((c) => c.job === 'Director');
  const billed = (d.credits?.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 6);
  return {
    tmdb_id: d.id,
    imdb_id: d.imdb_id || null,
    title: d.title,
    year: (d.release_date || '').slice(0, 4) || null,
    poster: img(d.poster_path, 'w500'),
    backdrop: img(d.backdrop_path, 'w780'),
    genres: (d.genres || []).map((g) => g.name),
    director: dir?.name || null,
    cast: billed.map((c) => c.name),
    // TMDB person ids, so Stats can fetch a filmography by id rather than by
    // a name that others share. cast_ids runs parallel to cast.
    director_id: dir?.id ?? null,
    cast_ids: billed.map((c) => c.id ?? null),
    runtime: d.runtime || null,
    synopsis: d.overview || '',
    tmdb_rating: d.vote_average ?? null,
    tmdb_votes: d.vote_count ?? null,
    trailer_key: pickTrailer(d.videos),
    mpaa: pickMpaa(d.release_dates),
    release_date: d.release_date || null,
    us_release_date: pickUsRelease(d.release_dates),
  };
}
