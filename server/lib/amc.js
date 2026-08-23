// AMC Theatres API client (v2, HAL+JSON). Auth via the X-AMC-Vendor-Key header.
//
// NOTE: AMC's public developer program is gated and the exact field names in
// their v2 responses have shifted over time. This client is written defensively
// (optional chaining + tolerant parsing) so a missing/renamed field degrades to
// null instead of crashing. If AMC returns nothing, the app falls back to TMDB
// "Now Playing" for the movie list (see refresh.js). Adjust field names here if
// your key returns a slightly different shape.
import { config } from '../env.js';
import { cachedJson, fetchJson } from './cache.js';
import { localYMD } from './util.js';

const BASE = 'https://api.amctheatres.com';
const DAY = 86400;

export function amcConfigured() {
  return Boolean(config.amcKey);
}

function headers() {
  return { 'X-AMC-Vendor-Key': config.amcKey, Accept: 'application/json' };
}

function embedded(res, name) {
  return res?._embedded?.[name] || [];
}

// Running count of real HTTP calls to AMC (cache hits don't count), so the
// refresh log can report what following another theatre actually costs.
export const apiStats = { calls: 0 };

function amcFetch(url) {
  apiStats.calls += 1;
  return fetchJson(url, { headers: headers() });
}

// Follow HAL pagination via _links.next, collecting a named embedded collection.
async function pageAll(firstUrl, collection, { cap = 60 } = {}) {
  const out = [];
  let url = firstUrl;
  let pages = 0;
  while (url && pages < cap) {
    const res = await amcFetch(url);
    out.push(...embedded(res, collection));
    url = res?._links?.next?.href || null;
    pages += 1;
  }
  return out;
}

// Full theatre list, cached 30 days; searchTheatres filters it locally so we
// never hammer the API per keystroke.
async function allTheatres() {
  return cachedJson('amc:theatres:all', 30 * DAY, async () => {
    if (!amcConfigured()) throw new Error('AMC_API_KEY is not set');
    const list = await pageAll(`${BASE}/v2/theatres?pageSize=100`, 'theatres', { cap: 40 });
    return list.map(normalizeTheatre);
  });
}

export function normalizeTheatre(t) {
  const loc = t.location || {};
  return {
    id: String(t.id),
    name: t.name || t.longName,
    longName: t.longName || t.name,
    slug: t.slug || '',
    city: loc.cityName || loc.city || '',
    state: loc.stateName || loc.state || '',
    address: loc.addressLine1 || '',
    lat: Number.isFinite(Number(loc.latitude)) ? Number(loc.latitude) : null,
    lng: Number.isFinite(Number(loc.longitude)) ? Number(loc.longitude) : null,
    utcOffset: t.utcOffset ?? null,
    timezone: t.timezone || null,
  };
}

// One theatre's full record (with coordinates), cached 30 days. The bulk list
// above may predate the lat/lng fields, so distance math goes through this.
export async function theatreDetail(id) {
  return cachedJson(`amc:theatre:${id}`, 30 * DAY, async () => {
    if (!amcConfigured()) throw new Error('AMC_API_KEY is not set');
    return normalizeTheatre(await amcFetch(`${BASE}/v2/theatres/${encodeURIComponent(id)}`));
  });
}

export async function searchTheatres(query) {
  const all = await allTheatres();
  if (!query) return all.slice(0, 25);
  const q = query.toLowerCase();
  return all
    .filter((t) =>
      [t.name, t.longName, t.city, t.state, t.slug].some((f) => (f || '').toLowerCase().includes(q)),
    )
    .slice(0, 25);
}

export async function getTheatre(id) {
  const all = await allTheatres();
  return all.find((t) => t.id === String(id)) || null;
}

// AMC's record for one movie, cached 30 days. Showtime objects carry no release
// date, so this is the only source of the year the matcher needs to tell a new
// "Hot Spot" from the 1990 one. One call per new title.
export async function movieRecord(amcMovieId) {
  return cachedJson(`amc:movie:${amcMovieId}`, 30 * DAY, async () => {
    if (!amcConfigured()) throw new Error('AMC_API_KEY is not set');
    const m = await amcFetch(`${BASE}/v2/movies/${encodeURIComponent(amcMovieId)}`);
    const releaseDate = (m?.releaseDateUtc || '').slice(0, 10) || null;
    const year = releaseDate ? Number(releaseDate.slice(0, 4)) || null : null;
    return {
      id: String(m?.id ?? amcMovieId),
      name: m?.name || '',
      releaseDate,
      year,
      runtime: m?.runTime || null,
      mpaa: m?.mpaaRating || null,
      genre: m?.genre || null,
      directors: m?.directors || null,
      actors: m?.starringActors || null,
    };
  });
}

// AMC's showtimes path historically used M-d-yyyy; some deployments use
// yyyy-MM-dd. Try both on a cache miss so we don't depend on guessing right.
function dateVariants(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return [`${m}-${d}-${y}`, `${y}-${pad(m)}-${pad(d)}`];
}

const PREMIUM = [
  'IMAX', 'Dolby Cinema', 'Dolby', 'PRIME', 'RealD 3D', '3D', 'Laser at AMC',
  'Dine-In', 'BigD', 'Screen X', 'ScreenX',
];
const ADVANCE = /advance|early access|sneak|fan first|premiere|preview/i;

function attrNames(raw) {
  return (raw.attributes || []).map((a) => a.name || a.code).filter(Boolean);
}

// Convert one AMC showtime into our canonical showtime row shape.
export function normalizeShowtime(raw, theatre) {
  const names = attrNames(raw);
  const joined = names.join(' ');
  const isImax = /imax/i.test(joined);
  const isAdvance = ADVANCE.test(joined);
  const format = PREMIUM.find((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(joined)) || 'Standard';
  const startLocal = raw.showDateTimeLocal || raw.showDateTimeUtc || null;
  const startEpoch = startLocal ? Date.parse(startLocal.replace(/([+-]\d\d:\d\d)?$/, '')) : null;
  const date = startLocal ? startLocal.slice(0, 10) : null;

  const purchaseUrl =
    raw.purchaseUrl ||
    raw._links?.purchase?.href ||
    raw._links?.deeplink?.href ||
    raw._links?.self?.href ||
    (theatre?.slug && date
      ? `https://www.amctheatres.com/showtimes/all/${date}/${theatre.slug}/all`
      : 'https://www.amctheatres.com/showtimes');

  return {
    id: String(raw.id ?? `${raw.movieId}-${startLocal}`),
    amc_movie_id: String(raw.movieId ?? raw.internalReleaseNumber ?? raw.movieName),
    movie_title: raw.movieName || raw.sortableMovieName || '',
    movie_year: (raw.releaseDateUtc || '').slice(0, 4) || null,
    theatre_id: String(raw.theatreId ?? theatre?.id ?? ''),
    date,
    start_local: startLocal,
    start_epoch: Number.isFinite(startEpoch) ? startEpoch : null,
    is_imax: isImax,
    is_advance: isAdvance,
    format,
    runtime_min: raw.runTime || null,
    attributes: names,
    purchase_url: purchaseUrl,
  };
}

// Cache key prefix for per-day showtimes. v2: keyed by the LOCAL date, matching
// the date the request is actually for. v1 used toISOString() (UTC), so after
// 8pm Eastern a day's showtimes were stored under the next day's key and the
// following morning's refresh read yesterday's schedule as today's. v1 rows are
// never read again and expire on their own.
export const SHOWTIMES_CACHE_PREFIX = 'amc:showtimes:v2:';

// Fetch + normalize all showtimes for one theatre on one day. Cached per day;
// `force` re-pulls even when a fresh copy exists (the cached copy still serves
// as the fallback if the live call fails). Pass `meta` to learn whether the
// result came from a live call, the fresh cache, or a stale copy after an error.
export async function showtimes(theatreId, date, theatre, { force = false, meta = null } = {}) {
  if (!amcConfigured()) throw new Error('AMC_API_KEY is not set');
  const key = `${SHOWTIMES_CACHE_PREFIX}${theatreId}:${localYMD(date)}`;
  return cachedJson(key, DAY, async () => {
    const variants = dateVariants(date);
    let lastErr;
    for (const v of variants) {
      try {
        const raw = await pageAll(
          `${BASE}/v2/theatres/${theatreId}/showtimes/${v}?pageSize=100`,
          'showtimes',
          { cap: 20 },
        );
        return raw.map((s) => normalizeShowtime(s, theatre));
      } catch (err) {
        lastErr = err;
        if (err.status && err.status !== 404 && err.status !== 400) throw err;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }, { force, meta });
}
