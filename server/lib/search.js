// The header search: TMDB's movie search merged with the films this person
// already has around (playing at their theatres, coming soon, rated,
// watchlisted, hidden), matched forgivingly (public/js/fuzzy.js) and ranked
// for them. Plus their recents. Read-only toward scoring: nothing here writes
// a rating, a pick or a movie row.
import { all, get, run } from '../db.js';
import * as tmdb from './tmdb.js';
import { tmdbThrottle } from './backfill.js';
import { followedTheatres } from './theatres.js';
import { currentUserId } from './user.js';
import { localYMD } from './util.js';
import { norm, prepare, query as prepQuery, score as fit, STARTS, isTypoOnly } from '../../public/js/fuzzy.js';

export const MIN_QUERY = 2;
const LIMIT = 20;
const THIN = 3; // fewer TMDB results than this and a corrected / shortened query is tried too

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

// Films playing this week at the caller's own theatres. Without AMC the
// lineup is TMDB's US now-playing list, which has no theatre.
function playingIds() {
  const ids = followedTheatres().map((t) => t.id).filter(Boolean);
  const out = new Set();
  if (ids.length) {
    for (const r of all(`SELECT DISTINCT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ? AND theatre_id IN (${placeholders(ids.length)})`, localYMD(), ...ids)) out.add(r.tmdb_id);
  }
  if (!out.size) for (const r of all("SELECT tmdb_id FROM movies WHERE playing = 1 AND playing_source = 'tmdb'")) out.add(r.tmdb_id);
  return out;
}

// Everything the badges and ranking need about this person, keyed by TMDB id.
function mine(uid) {
  return {
    ratings: new Map(all('SELECT tmdb_id, rating, title, year FROM ratings WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r])),
    watchlist: new Set(all('SELECT tmdb_id FROM watchlist WHERE user_id = ?', uid).map((r) => r.tmdb_id)),
    hidden: new Map(all('SELECT tmdb_id, title FROM hidden_movies WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r])),
    playing: playingIds(),
  };
}

// The films the app already knows for this person, as search candidates.
function localFilms(me) {
  const upcoming = all('SELECT tmdb_id FROM movies WHERE upcoming = 1').map((r) => r.tmdb_id);
  const ids = [...new Set([...me.playing, ...upcoming, ...me.ratings.keys(), ...me.watchlist, ...me.hidden.keys()])];
  if (!ids.length) return [];
  const rows = new Map(all(`SELECT tmdb_id, title, year, poster, tmdb_votes FROM movies WHERE tmdb_id IN (${placeholders(ids.length)})`, ...ids).map((r) => [r.tmdb_id, r]));
  return ids.map((id) => {
    const m = rows.get(id) || {};
    const title = m.title || me.ratings.get(id)?.title || me.hidden.get(id)?.title;
    if (!title) return null;
    return { tmdb_id: id, title, year: m.year ?? me.ratings.get(id)?.year ?? null, poster: m.poster || null, popularity: null, votes: m.tmdb_votes || 0 };
  }).filter(Boolean);
}

async function tmdbTry(q) {
  try { return await tmdb.searchTitles(q, { gate: tmdbThrottle }); } catch { return []; }
}

// Shorter spellings for a TMDB search that came back thin: every long word
// cut to its first three quarters ("interstelar" -> "interste"), then the
// query without its last word.
function shortened(q) {
  const out = [];
  const cut = q.tokens.map((t) => (t.length >= 6 ? t.slice(0, Math.max(4, Math.ceil(t.length * 0.75))) : t)).join(' ');
  if (cut !== q.n) out.push(cut);
  if (q.tokens.length > 1) out.push(q.tokens.slice(0, -1).join(' '));
  return out;
}

export async function search(raw) {
  const q = prepQuery(String(raw || '').slice(0, 200));
  if (q.c.length < MIN_QUERY) return { query: q.n, results: [] };
  const uid = currentUserId();
  const me = mine(uid);

  const byId = new Map();
  const add = (f, s, source) => {
    const had = byId.get(f.tmdb_id);
    if (had) {
      had.score = Math.max(had.score, s);
      if (f.popularity != null) had.popularity = Math.max(had.popularity ?? 0, f.popularity);
      had.poster ||= f.poster;
      had.year ??= f.year;
      return;
    }
    byId.set(f.tmdb_id, { ...f, score: s, source });
  };

  for (const f of localFilms(me)) {
    const s = fit(q, prepare(f.title));
    if (s) add(f, s, 'local');
  }

  let tmdbCount = 0;
  if (tmdb.tmdbConfigured()) {
    const first = await tmdbTry(q.n);
    tmdbCount = first.length;
    // TMDB matches alternate and original titles too, so a result whose
    // English title doesn't fit still stays, at the bottom.
    for (const r of first) add(r, fit(q, prepare(r.title)), 'tmdb');
    if (first.length < THIN) {
      // A correction: the best film of this person's own that only fits with a typo.
      const fixes = [...byId.values()].filter((f) => f.source === 'local' && isTypoOnly(f.score)).sort((a, b) => b.score - a.score).map((f) => norm(f.title));
      for (const alt of [...new Set([...fixes.slice(0, 1), ...shortened(q)])]) {
        const more = await tmdbTry(alt);
        tmdbCount += more.length;
        // From a looser query only what still fits the words typed.
        for (const r of more) { const s = fit(q, prepare(r.title)); if (s) add(r, s, 'tmdb'); }
        if (tmdbCount >= THIN) break;
      }
    }
  }

  const results = [...byId.values()].map((f) => {
    const rating = me.ratings.get(f.tmdb_id)?.rating ?? null;
    return {
      tmdb_id: f.tmdb_id, title: f.title, year: f.year ? Number(String(f.year).slice(0, 4)) || null : null, poster: f.poster || null,
      playing: me.playing.has(f.tmdb_id), rating, watchlisted: me.watchlist.has(f.tmdb_id), hidden: me.hidden.has(f.tmdb_id),
      match: f.score >= STARTS ? 'title' : f.score >= 300 ? 'words' : f.score > 0 ? 'typo' : 'tmdb',
      _score: f.score, _pop: f.popularity ?? Math.log10(1 + (f.votes || 0)),
    };
  });
  // Exact and starts-with first, then playing at my theatres, then rated or
  // watchlisted, then how well the words fit, then popularity.
  const tier = (r) => [r._score >= STARTS ? 0 : 1, r.playing ? 0 : 1, r.rating != null || r.watchlisted ? 0 : 1, r._score >= 300 ? 0 : r._score > 0 ? 1 : 2];
  results.sort((a, b) => {
    const ta = tier(a); const tb = tier(b);
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return ta[i] - tb[i];
    return b._pop - a._pop || a.title.localeCompare(b.title);
  });
  return { query: q.n, results: results.slice(0, LIMIT).map(({ _score, _pop, ...r }) => r) };
}

// ---- recents ---------------------------------------------------------------

export const MAX_QUERIES = 10;
export const MAX_MOVIES = 8;

const nextSeq = (uid) => (get('SELECT MAX(seq) AS s FROM search_recents WHERE user_id = ?', uid)?.s || 0) + 1;

function prune(uid) {
  for (const [kind, max] of [['query', MAX_QUERIES], ['movie', MAX_MOVIES]]) {
    run(`DELETE FROM search_recents WHERE user_id = ? AND kind = ? AND key NOT IN
          (SELECT key FROM search_recents WHERE user_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?)`, uid, kind, uid, kind, max);
  }
}

export function listRecents() {
  const uid = currentUserId();
  const rows = all('SELECT kind, key, query, tmdb_id, title, year, poster FROM search_recents WHERE user_id = ? ORDER BY seq DESC', uid);
  return {
    queries: rows.filter((r) => r.kind === 'query').map((r) => ({ key: r.key, query: r.query })),
    movies: rows.filter((r) => r.kind === 'movie').map((r) => ({ tmdb_id: r.tmdb_id, title: r.title, year: r.year, poster: r.poster })),
  };
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const cleanText = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// A query: under two letters (after normalizing) is never kept; the same
// query again moves to the top, keeping the latest spelling.
function putQuery(uid, raw) {
  const text = cleanText(raw, 100);
  const key = norm(text);
  if (key.replace(/ /g, '').length < MIN_QUERY) return false;
  run(`INSERT INTO search_recents(user_id, kind, key, query, seq) VALUES(?, 'query', ?, ?, ?)
        ON CONFLICT(user_id, kind, key) DO UPDATE SET query = excluded.query, seq = excluded.seq`, uid, key, text, nextSeq(uid));
  return true;
}

function putMovie(uid, m) {
  const id = Number(m?.tmdb_id);
  if (!Number.isInteger(id) || id <= 0) throw bad('tmdb_id required.');
  const title = cleanText(m.title, 300) || get('SELECT title FROM movies WHERE tmdb_id = ?', id)?.title;
  if (!title) throw bad('title required.');
  const year = Number.isInteger(Number(m.year)) && Number(m.year) > 1800 ? Number(m.year) : null;
  // Only TMDB's own image host, so a stored recent can't point a page anywhere else.
  const poster = typeof m.poster === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/\w+\/[\w.-]+$/.test(m.poster) ? m.poster : null;
  run(`INSERT INTO search_recents(user_id, kind, key, tmdb_id, title, year, poster, seq) VALUES(?, 'movie', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, kind, key) DO UPDATE SET title = excluded.title, year = excluded.year, poster = excluded.poster, seq = excluded.seq`,
  uid, String(id), id, title, year, poster, nextSeq(uid));
}

export function addRecent(body) {
  const uid = currentUserId();
  if (body?.movie) putMovie(uid, body.movie);
  else if (!putQuery(uid, body?.query)) return { saved: false, ...listRecents() };
  prune(uid);
  return { saved: true, ...listRecents() };
}

export function removeRecent(kind, key) {
  if (kind !== 'query' && kind !== 'movie') throw bad('kind must be query or movie.');
  run('DELETE FROM search_recents WHERE user_id = ? AND kind = ? AND key = ?', currentUserId(), kind, String(key ?? ''));
  return listRecents();
}

// Clear all hands back what it removed, so the page can offer Undo.
export function clearRecents() {
  const before = listRecents();
  run('DELETE FROM search_recents WHERE user_id = ?', currentUserId());
  return { cleared: before, ...listRecents() };
}

// Undo: put back what Clear all removed, oldest first so the order returns,
// without pushing out anything added since.
export function restoreRecents(body) {
  const uid = currentUserId();
  const queries = Array.isArray(body?.queries) ? body.queries.slice(0, MAX_QUERIES) : [];
  const movies = Array.isArray(body?.movies) ? body.movies.slice(0, MAX_MOVIES) : [];
  const have = new Set(all('SELECT kind || \':\' || key AS k FROM search_recents WHERE user_id = ?', uid).map((r) => r.k));
  const floor = (get('SELECT MIN(seq) AS s FROM search_recents WHERE user_id = ?', uid)?.s ?? nextSeq(uid));
  let seq = floor - queries.length - movies.length - 1;
  for (const q of [...queries].reverse()) {
    const text = cleanText(q?.query, 100);
    const key = norm(text);
    if (key.replace(/ /g, '').length < MIN_QUERY || have.has(`query:${key}`)) continue;
    run("INSERT INTO search_recents(user_id, kind, key, query, seq) VALUES(?, 'query', ?, ?, ?)", uid, key, text, seq++);
  }
  for (const m of [...movies].reverse()) {
    const id = Number(m?.tmdb_id);
    if (!Number.isInteger(id) || id <= 0 || have.has(`movie:${id}`)) continue;
    const poster = typeof m.poster === 'string' && /^https:\/\/image\.tmdb\.org\/t\/p\/\w+\/[\w.-]+$/.test(m.poster) ? m.poster : null;
    const title = cleanText(m.title, 300);
    if (!title) continue;
    run("INSERT INTO search_recents(user_id, kind, key, tmdb_id, title, year, poster, seq) VALUES(?, 'movie', ?, ?, ?, ?, ?, ?)",
      uid, String(id), id, title, Number(m.year) || null, poster, seq++);
  }
  prune(uid);
  return listRecents();
}
