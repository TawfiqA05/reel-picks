// People in the header search: TMDB's person search, with a name matched the
// way people type it (the whole name, or the last name alone, a letter or two
// off in a long one) and only people known for directing or acting. At most
// two rows, above the films. Read-only toward scoring: nothing here writes a
// movie row, a rating or a pick.
//
// TMDB matches names letter for letter, so "tarentino" finds nobody. For
// that, a list of names the app knows is kept: the directors and billed cast
// of every film stored here, and of the 100 films with the most TMDB votes
// (fetched once a week through the shared throttle, a few fields per film).
// A query that is a typo of one of those names is asked of TMDB spelled
// right.
import { all } from '../db.js';
import * as tmdb from './tmdb.js';
import { tmdbThrottle } from './backfill.js';
import { isFeature, isActing } from './statsMore.js';
import { norm, query as prepQuery, distance } from '../../public/js/fuzzy.js';

const MAX_PEOPLE = 2;
// TMDB popularity below this and a name match is someone few have heard of
// ("Spiderman", an extra; "Alan Oppenheimer" for "oppenheimer").
const MIN_POPULARITY = 1;
// A second person shows only with at least this share of the first's popularity.
const SECOND_SHARE = 1 / 3;
export const ROLE = { Directing: 'Director', Acting: 'Actor' };
const WELL_KNOWN_PAGES = 5;
const DAY_MS = 86400e3;
const INDEX_MS = 3600e3; // the name list is rebuilt from the database at most this often
const WARM_PAUSE_MS = 500;

const typosFor = (len) => (len >= 8 ? 2 : len >= 5 ? 1 : 0);

// How a query fits a name: { how: 'full' | 'last', d } (d = letters off), or
// null. The last name may carry a particle ("villeneuve", "del toro").
function nameFit(q, name) {
  const words = norm(name).split(' ').filter(Boolean);
  if (!words.length || !q.c) return null;
  const k = typosFor(q.c.length);
  let best = null;
  const consider = (target, how) => {
    const d = q.c === target ? 0 : k ? distance(q.c, target, k) : 1;
    if (d > k) return;
    if (!best || d < best.d || (d === best.d && how === 'full' && best.how === 'last')) best = { how, d };
  };
  consider(words.join(''), 'full');
  for (let i = 1; i < words.length; i++) consider(words.slice(i).join(''), 'last');
  return best;
}

// What the films say about the query (lib/search.js): `title`, a well-known
// film's title is what was typed ("oppenheimer"); `words`, some film's title
// fits the words as typed, no typo needed ("brave"). Someone whose whole name
// was typed letter for letter always shows; a last name alone not when a
// well-known film has that title; a name reached only through a typo not when
// a film fits the words as they are ("brave" is not "Richard Brake").
function eligible({ p, fit }, films) {
  if (!ROLE[p.department] || !(p.popularity >= MIN_POPULARITY)) return false;
  if (fit.d > 0) return !films.words;
  return fit.how === 'full' || !films.title;
}

// Fewest letters off, a whole name before a last name, then the best known.
const byFit = (a, b) => a.fit.d - b.fit.d || (a.fit.how === 'full' ? 0 : 1) - (b.fit.how === 'full' ? 0 : 1) || b.p.popularity - a.p.popularity;

// ---- the names the app knows -------------------------------------------------

let index = null; // { at, names: [{ name, n }] }, n = how many films they're in
let warmedAt = 0;
let warming = null;

function nameIndex() {
  if (index && Date.now() - index.at < INDEX_MS) return index.names;
  const count = new Map();
  const add = (name) => { if (name) count.set(name, (count.get(name) || 0) + 1); };
  for (const m of all('SELECT director, "cast" AS names FROM movies')) {
    add(m.director);
    try { for (const c of JSON.parse(m.names || '[]')) add(c); } catch { /* a bad row is skipped */ }
  }
  for (const r of all("SELECT value FROM cache WHERE key LIKE 'tmdb:filmpeople:%'")) {
    try {
      const v = JSON.parse(r.value);
      for (const p of [...(v.directors || []), ...(v.cast || [])]) add(p.name);
    } catch { /* skipped */ }
  }
  index = { at: Date.now(), names: [...count].map(([name, n]) => ({ name, n })) };
  return index.names;
}

// The directors and cast of the most-voted films, for the name list. Cached a
// week per film, so after a restart this reads the cache and asks TMDB nothing.
// One live call at a time with a pause after each, so it takes at most half
// of the shared throttle and anyone searching or opening a page goes first.
export function warmPeople() {
  if (!tmdb.tmdbConfigured() || warming || Date.now() - warmedAt < 6 * DAY_MS) return warming || Promise.resolve();
  warming = (async () => {
    for (let page = 1; page <= WELL_KNOWN_PAGES; page++) {
      for (const f of await tmdb.wellKnown(page, { gate: tmdbThrottle })) {
        if (tmdb.cachedFresh(`filmpeople:${f.id}`)) continue;
        await tmdb.filmPeople(f.id, { gate: tmdbThrottle }).catch(() => {});
        await new Promise((r) => { setTimeout(r, WARM_PAUSE_MS).unref(); });
      }
    }
    warmedAt = Date.now();
    index = null;
  })().catch((e) => console.error('[people]', e.message)).finally(() => { warming = null; });
  return warming;
}

// Names the query may be a typo of, best first: up to two spellings to ask
// TMDB for instead. A query of two words or more also tries its first word
// alone ("quentin tarentino" -> "quentin").
function corrections(q) {
  const out = [];
  const fits = nameIndex().map((e) => ({ e, fit: nameFit(q, e.name) }))
    .filter((x) => x.fit && norm(x.e.name) !== q.n)
    .sort((a, b) => a.fit.d - b.fit.d || b.e.n - a.e.n);
  for (const { e } of fits) {
    if (!out.includes(e.name)) out.push(e.name);
    if (out.length >= 2) return out;
  }
  if (q.tokens.length > 1 && q.tokens[0].length >= 4) out.push(q.tokens[0]);
  return out.slice(0, 2);
}

// ---- the rows ------------------------------------------------------------------

// Two or three films they're known for: TMDB's own pick (films only, most
// voted first), topped up from their credits when that has fewer than two.
async function knownFor(p, spend) {
  const titles = [...p.knownFor].sort((a, b) => b.votes - a.votes).map((k) => k.title);
  if (titles.length < 2 && (tmdb.creditsCached(p.id) || spend())) {
    try {
      const credits = await tmdb.personCredits(p.id, { gate: tmdbThrottle });
      const pool = p.department === 'Directing'
        ? (credits?.crew || []).filter((c) => c.job === 'Director')
        : (credits?.cast || []).filter(isActing);
      for (const c of pool.filter(isFeature).sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))) {
        if (!titles.includes(c.title)) titles.push(c.title);
        if (titles.length >= 3) break;
      }
    } catch { /* TMDB's own pick is enough */ }
  }
  return [...new Set(titles)].slice(0, 3);
}

// The people for a header search. `filmFit` resolves once the films are in
// ({ title, words }, see eligible). `spend()` is asked before every live TMDB
// call and says whether this person may make one (the hourly new-film limit);
// a no leaves the people out, never the films.
export async function findPeople(raw, { filmFit = Promise.resolve({}), spend = () => true } = {}) {
  const q = prepQuery(String(raw || '').slice(0, 200));
  if (q.c.length < 3 || !tmdb.tmdbConfigured()) return [];
  const ask = async (text) => {
    if (!tmdb.cachedFresh(tmdb.personKey(text)) && !spend()) return null;
    try { return await tmdb.searchPeople(text, { gate: tmdbThrottle }); } catch { return []; }
  };
  const first = await ask(q.n);
  if (!first) return [];
  const films = (await filmFit) || {};
  const pick = (list) => list.map((p) => ({ p, fit: nameFit(q, p.name) }))
    .filter((x) => x.fit && eligible(x, films)).sort(byFit);
  let found = pick(first);
  if (!found.length && !films.words) {
    for (const alt of corrections(q)) {
      const more = await ask(alt);
      if (!more) return [];
      found = pick(more);
      if (found.length) break;
    }
  }
  const seen = new Set();
  const top = found.filter((x) => !seen.has(x.p.id) && seen.add(x.p.id)).slice(0, MAX_PEOPLE)
    .filter((x, i, a) => i === 0 || x.p.popularity >= a[0].p.popularity * SECOND_SHARE);
  return Promise.all(top.map(async ({ p }) => ({
    id: p.id, name: p.name, role: ROLE[p.department], photo: p.photo, knownFor: await knownFor(p, spend),
  })));
}
