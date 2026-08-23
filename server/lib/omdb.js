// OMDb client — pulls IMDb / Rotten Tomatoes / Metacritic scores.
//
// OMDb answers HTTP 200 with { Response: "False", Error: "…" } for BOTH "we
// have no such movie" and "you've used your 1,000 requests today". Those must
// not be treated alike: a quota/auth failure is thrown (never cached, never
// mistaken for "no record") and pauses further lookups for an hour so a refresh
// doesn't burn every remaining movie into the same wall; a genuine not-found is
// returned as { found: false, error } so the caller can record it.
import { config } from '../env.js';
import { cachedJson, fetchJson } from './cache.js';

const BASE = 'https://www.omdbapi.com/';

export function omdbConfigured() {
  return Boolean(config.omdbKey);
}

function url(params) {
  const u = new URL(BASE);
  u.searchParams.set('apikey', config.omdbKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

function toNum(s) {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---- quota / auth handling ---------------------------------------------

const PAUSE_MS = 60 * 60 * 1000;
// Module-wide: once OMDb says the key is exhausted or invalid, every lookup
// short-circuits until `pausedUntil` (the cache still serves fresh rows).
export const omdbState = { pausedUntil: 0, reason: null };

const LIMIT_RE = /request limit|limit reached|daily limit|too many requests|invalid api key|api key|unauthorized|not authorized/i;

export class OmdbUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OmdbUnavailableError';
    this.unavailable = true;
  }
}

// Why a response means "OMDb is unavailable to us", or null if it's a normal
// answer (including a normal "no such movie").
export function unavailableReason(raw, httpStatus = null) {
  if (httpStatus === 401 || httpStatus === 429 || httpStatus === 503) return `HTTP ${httpStatus}`;
  if (raw && raw.Response === 'False' && LIMIT_RE.test(raw.Error || '')) return raw.Error;
  return null;
}

function pause(reason) {
  omdbState.pausedUntil = Date.now() + PAUSE_MS;
  omdbState.reason = reason;
}

export function omdbPaused() {
  return Date.now() < omdbState.pausedUntil ? omdbState.reason : null;
}

// The fetcher handed to cachedJson: a quota/auth answer is thrown here, so it
// is never written to the cache table as if it were a real record.
async function fetchOmdb(params) {
  const paused = omdbPaused();
  if (paused) throw new OmdbUnavailableError(`OMDb paused after "${paused}" (until ${new Date(omdbState.pausedUntil).toLocaleTimeString()})`);
  let raw;
  try {
    raw = await fetchJson(url(params));
  } catch (e) {
    const why = unavailableReason(null, e.status);
    if (why) { pause(why); throw new OmdbUnavailableError(`OMDb ${why}`); }
    throw e;
  }
  const why = unavailableReason(raw);
  if (why) { pause(why); throw new OmdbUnavailableError(`OMDb: ${why}`); }
  return raw;
}

// Returns { imdb: 0-10|null, rt: 0-100|null, metacritic: 0-100|null, rated, found, error }.
function parse(raw) {
  if (!raw || raw.Response === 'False') {
    return { imdb: null, rt: null, metacritic: null, rated: null, found: false, error: raw?.Error || 'No response' };
  }
  const ratings = raw.Ratings || [];
  const rtEntry = ratings.find((r) => /rotten tomatoes/i.test(r.Source));
  const rt = rtEntry ? toNum(rtEntry.Value) : null; // "91%" -> 91
  const imdb = raw.imdbRating && raw.imdbRating !== 'N/A' ? toNum(raw.imdbRating) : null; // x/10
  const metacritic = raw.Metascore && raw.Metascore !== 'N/A' ? toNum(raw.Metascore) : null; // x/100
  const rated = raw.Rated && raw.Rated !== 'N/A' ? raw.Rated : null;
  return { imdb, rt, metacritic, rated, found: true, error: null };
}

// TTL is short (12h) because new-release scores trickle in; the daily refresh
// re-pulls for movies inside their 14-day settling window.
const TTL = 12 * 3600;

export async function byImdbId(imdbId) {
  if (!omdbConfigured()) throw new Error('OMDB_API_KEY is not set');
  if (!imdbId) return parse(null);
  const raw = await cachedJson(`omdb:i:${imdbId}`, TTL, () => fetchOmdb({ i: imdbId }));
  return parse(raw);
}

export async function byTitle(title, year) {
  if (!omdbConfigured()) throw new Error('OMDB_API_KEY is not set');
  const raw = await cachedJson(
    `omdb:t:${title.toLowerCase()}:${year || ''}`,
    TTL,
    () => fetchOmdb({ t: title, y: year || undefined }),
  );
  return parse(raw);
}
