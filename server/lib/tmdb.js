// TMDB client — posters, metadata, credits, trailers, now-playing/upcoming.
import { config } from '../env.js';
import { cachedJson, fetchJson } from './cache.js';

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

function req(key, ttl, path, params, { force = false } = {}) {
  if (!tmdbConfigured()) throw new Error('TMDB_API_KEY is not set');
  return cachedJson(`tmdb:${key}`, ttl, () => fetchJson(url(path, params)), { force });
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
export async function details(tmdbId, { force = false } = {}) {
  return req(`movie:${tmdbId}`, 7 * DAY, `/movie/${tmdbId}`, {
    append_to_response: 'videos,credits,release_dates',
    language: 'en-US',
  }, { force });
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
    genres: (r.genre_ids || []).map((id) => TMDB_GENRES[id]).filter(Boolean),
    synopsis: r.overview || '',
    release_date: r.release_date || null,
  };
}

function pickTrailer(videos) {
  const vids = videos?.results || [];
  const yt = vids.filter((v) => v.site === 'YouTube');
  const pref =
    yt.find((v) => v.type === 'Trailer' && v.official) ||
    yt.find((v) => v.type === 'Trailer') ||
    yt.find((v) => v.type === 'Teaser') ||
    yt[0];
  return pref?.key || null;
}

function pickMpaa(releaseDates) {
  const us = (releaseDates?.results || []).find((r) => r.iso_3166_1 === 'US');
  if (!us) return null;
  const cert = (us.release_dates || []).map((d) => d.certification).find((c) => c && c.trim());
  return cert || null;
}

// Convert a full TMDB detail response into our canonical movie shape.
export function normalizeDetails(d) {
  const director = (d.credits?.crew || []).find((c) => c.job === 'Director')?.name || null;
  const cast = (d.credits?.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 6)
    .map((c) => c.name);
  return {
    tmdb_id: d.id,
    imdb_id: d.imdb_id || null,
    title: d.title,
    year: (d.release_date || '').slice(0, 4) || null,
    poster: img(d.poster_path, 'w500'),
    backdrop: img(d.backdrop_path, 'w780'),
    genres: (d.genres || []).map((g) => g.name),
    director,
    cast,
    runtime: d.runtime || null,
    synopsis: d.overview || '',
    tmdb_rating: d.vote_average ?? null,
    trailer_key: pickTrailer(d.videos),
    mpaa: pickMpaa(d.release_dates),
    release_date: d.release_date || null,
  };
}
