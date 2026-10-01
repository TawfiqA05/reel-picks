// The film snapshot (snapshot.json): TMDB and OMDb answers saved once with a
// real key by scripts/demo-snapshot.mjs, cut down to the fields the app
// reads. Demo mode answers every TMDB and OMDb request from it (net.js). It
// holds public film data only: titles, years, posters, genres, credits,
// scores, where a film streams. No key, and nothing from anyone's account.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_PATH = fileURLToPath(new URL('./snapshot.json', import.meta.url));

let loaded = null;
export function snapshot() {
  loaded ??= JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  return loaded;
}

const HOSTS = { 'api.themoviedb.org': 'tmdb', 'www.omdbapi.com': 'omdb' };
export const serviceOf = (u) => HOSTS[u.hostname] || null;

// One request's key: the service, the path and the query with its parameters
// sorted, and the key parameter left out (so no key ever lands in the file).
export function requestKey(url) {
  const u = new URL(url);
  const svc = serviceOf(u);
  if (!svc) return null;
  const q = [...u.searchParams.entries()].filter(([k]) => !/^api_?key$/i.test(k))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return `${svc}:${u.pathname}${q.length ? `?${new URLSearchParams(q)}` : ''}`;
}

// ---- trimming (scripts/demo-snapshot.mjs) -------------------------------------
// Only what lib/tmdb.js, lib/omdb.js and the pages built on them read.

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
// A list entry without what it doesn't need: no false, null or empty values
// (every reader treats a missing one the same), one decimal on the numbers.
const lean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== false && v != null && v !== '')
  .map(([k, v]) => [k, (k === 'popularity' || k === 'vote_average') && typeof v === 'number' ? Math.round(v * 10) / 10 : v]));
const short = (s, n = 200) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const LIST_FIELDS = ['id', 'title', 'release_date', 'poster_path', 'backdrop_path', 'vote_average', 'vote_count', 'genre_ids', 'popularity', 'adult', 'video', 'original_language'];
const CREDIT_FIELDS = ['id', 'title', 'release_date', 'poster_path', 'vote_average', 'vote_count', 'genre_ids', 'popularity', 'adult', 'video', 'character', 'job'];
const PERSON_LIST = ['id', 'name', 'known_for_department', 'popularity', 'profile_path', 'adult'];
const byOrder = (a, b) => (a.order ?? 99) - (b.order ?? 99);
const castOf = (c, n) => (c || []).slice().sort(byOrder).slice(0, n).map((x) => pick(x, ['id', 'name', 'order', 'character', 'known_for_department']));
const directorsOf = (c) => (c || []).filter((x) => x.job === 'Director').map((x) => pick(x, ['id', 'name', 'job']));
const youTube = (v) => ({ results: (v?.results || []).filter((x) => x.site === 'YouTube' && x.key).slice(0, 4).map((x) => pick(x, ['key', 'site', 'type', 'iso_639_1', 'official', 'published_at'])) });
const listOf = (d, fields = LIST_FIELDS) => ({
  ...pick(d, ['page', 'total_pages', 'total_results']),
  results: (d?.results || []).map((r) => lean({ ...pick(r, fields), overview: short(r.overview) })),
});

export function trim(key, d) {
  if (!d || typeof d !== 'object') return d;
  if (key.startsWith('omdb:')) return pick(d, ['Response', 'Error', 'Title', 'Year', 'Rated', 'imdbRating', 'Metascore', 'Ratings', 'imdbID']);
  const path = key.slice('tmdb:'.length).split('?')[0];
  let m;
  if ((m = path.match(/^\/3\/movie\/\d+$/))) {
    const us = (d.release_dates?.results || []).filter((r) => r.iso_3166_1 === 'US');
    return {
      ...pick(d, ['id', 'imdb_id', 'title', 'original_title', 'release_date', 'poster_path', 'backdrop_path', 'runtime', 'vote_average', 'vote_count', 'popularity', 'adult', 'status', 'original_language']),
      overview: short(d.overview, 600),
      genres: (d.genres || []).map((g) => pick(g, ['id', 'name'])),
      belongs_to_collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id } : null,
      videos: youTube(d.videos),
      credits: { cast: castOf(d.credits?.cast, 10), crew: directorsOf(d.credits?.crew) },
      release_dates: { results: us.map((r) => ({ iso_3166_1: 'US', release_dates: (r.release_dates || []).map((x) => pick(x, ['certification', 'release_date', 'type'])) })) },
    };
  }
  if (/^\/3\/movie\/\d+\/credits$/.test(path)) return { id: d.id, cast: castOf(d.cast, 10), crew: directorsOf(d.crew) };
  if (/^\/3\/movie\/\d+\/videos$/.test(path)) return { id: d.id, ...youTube(d) };
  if (/^\/3\/movie\/\d+\/watch\/providers$/.test(path)) {
    const us = d.results?.US;
    const prov = (l, n = 12) => (l || []).slice().sort((a, b) => (a.display_priority ?? 99) - (b.display_priority ?? 99)).slice(0, n)
      .map((p) => pick(p, ['provider_id', 'provider_name', 'logo_path', 'display_priority']));
    return { id: d.id, results: us ? { US: { link: us.link, flatrate: prov(us.flatrate), free: prov(us.free), ads: prov(us.ads), rent: prov(us.rent, 4), buy: prov(us.buy, 4) } } : {} };
  }
  if (/^\/3\/person\/\d+$/.test(path)) return pick(d, ['id', 'name', 'adult', 'known_for_department', 'profile_path', 'popularity']);
  if (/^\/3\/person\/\d+\/movie_credits$/.test(path)) {
    const credit = (c) => lean(pick(c, CREDIT_FIELDS));
    return { id: d.id, cast: (d.cast || []).map(credit), crew: (d.crew || []).filter((c) => c.job === 'Director').map(credit) };
  }
  if (path === '/3/search/person') {
    return {
      ...pick(d, ['page', 'total_pages', 'total_results']),
      results: (d.results || []).map((p) => ({ ...pick(p, PERSON_LIST), known_for: (p.known_for || []).map((k) => pick(k, ['id', 'title', 'media_type', 'adult', 'vote_count'])) })),
    };
  }
  if (Array.isArray(d.results)) return listOf(d);
  return d;
}

// ---- answering (net.js) ------------------------------------------------------

// Films the snapshot only knows from a list (a filmography, a search): enough
// for a movie page, so a film tapped on a person page still opens.
let light = null;
function lightIndex() {
  if (light) return light;
  light = new Map();
  const add = (r) => { if (r?.id && r.title && !light.has(r.id)) light.set(r.id, r); };
  for (const [key, body] of Object.entries(snapshot().responses)) {
    if (!key.startsWith('tmdb:')) continue;
    for (const r of body?.results || []) add(r);
    for (const r of body?.cast || []) if (r.title) add(r);
    for (const r of body?.crew || []) if (r.title) add(r);
  }
  return light;
}

function fromLight(id) {
  const r = lightIndex().get(id);
  if (!r) return null;
  const names = Object.fromEntries(Object.entries(GENRES).map(([k, v]) => [Number(k), v]));
  return {
    id, title: r.title, original_title: r.original_title || r.title, release_date: r.release_date || '',
    poster_path: r.poster_path || null, backdrop_path: r.backdrop_path || null, overview: r.overview || '',
    vote_average: r.vote_average ?? 0, vote_count: r.vote_count ?? 0, popularity: r.popularity ?? 0, runtime: null,
    genres: (r.genre_ids || []).filter((g) => names[g]).map((g) => ({ id: g, name: names[g] })),
    videos: { results: [] }, credits: { cast: [], crew: [] }, release_dates: { results: [] },
  };
}

// TMDB's genre ids (as lib/tmdb.js TMDB_GENRES), for a film known only from a list.
const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama',
  10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
};

// People the snapshot has no page for: everyone credited on a saved film
// (its director and top-billed cast), with those films. A person page then
// lists what the demo knows about them instead of "Person not found".
let people = null;
function peopleIndex() {
  if (people) return people;
  people = new Map();
  const add = (p, film, role) => {
    if (!p?.id || !p.name) return;
    let e = people.get(p.id);
    if (!e) people.set(p.id, (e = { id: p.id, name: p.name, directing: 0, acting: 0, cast: [], crew: [] }));
    const credit = {
      id: film.id, title: film.title, release_date: film.release_date, poster_path: film.poster_path,
      vote_average: film.vote_average, vote_count: film.vote_count, popularity: film.popularity,
      genre_ids: (film.genres || []).map((g) => g.id),
    };
    if (role === 'Director') { e.directing++; e.crew.push({ ...credit, job: 'Director' }); } else { e.acting++; e.cast.push({ ...credit, character: p.character || '' }); }
  };
  for (const [key, d] of Object.entries(snapshot().responses)) {
    if (!/^tmdb:\/3\/movie\/\d+\?/.test(key) || !d?.credits) continue;
    for (const c of d.credits.crew || []) add(c, d, 'Director');
    for (const c of d.credits.cast || []) add(c, d, 'Acting');
  }
  return people;
}

const EMPTY_LIST = { page: 1, results: [], total_pages: 0, total_results: 0 };
const NOT_FOUND = { status: 404, body: { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' } };

// { status, body } for a TMDB or OMDb request: the saved answer, or what the
// service says about something it has nothing for.
export function answer(url) {
  const key = requestKey(url);
  if (!key) return null;
  const saved = snapshot().responses[key];
  if (saved !== undefined) return { status: 200, body: saved };
  if (key.startsWith('omdb:')) return { status: 200, body: { Response: 'False', Error: 'Movie not found!' } };
  const path = new URL(url).pathname;
  let m;
  if (/^\/3\/(search|discover)\//.test(path)) return { status: 200, body: EMPTY_LIST };
  if ((m = path.match(/^\/3\/movie\/(\d+)$/))) {
    const d = fromLight(Number(m[1]));
    return d ? { status: 200, body: d } : NOT_FOUND;
  }
  if ((m = path.match(/^\/3\/movie\/(\d+)\/credits$/))) return { status: 200, body: { id: Number(m[1]), cast: [], crew: [] } };
  if ((m = path.match(/^\/3\/movie\/(\d+)\/videos$/))) return { status: 200, body: { id: Number(m[1]), results: [] } };
  if ((m = path.match(/^\/3\/movie\/(\d+)\/watch\/providers$/))) return { status: 200, body: { id: Number(m[1]), results: {} } };
  if ((m = path.match(/^\/3\/person\/(\d+)(\/movie_credits)?$/))) {
    const e = peopleIndex().get(Number(m[1]));
    if (!e) return NOT_FOUND;
    if (m[2]) return { status: 200, body: { id: e.id, cast: e.cast, crew: e.crew } };
    return { status: 200, body: { id: e.id, name: e.name, known_for_department: e.directing > e.acting ? 'Directing' : 'Acting', profile_path: null } };
  }
  return NOT_FOUND;
}
