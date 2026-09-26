// Letterboxd auto-sync: each person (the owner and friends; never the guest
// link, lib/guest.js) can link their Letterboxd username in Settings. Once a
// day, and on "Sync now", their public RSS feed (letterboxd.com/<name>/rss/,
// the newest ~50 diary entries) is read and brought in like a CSV import:
//
//   - a diary entry with a star rating becomes a rating (0.5-5, the same scale)
//   - every diary entry becomes a watched entry on its watched date, marked
//     source 'letterboxd' so it never counts toward the A-List week or savings
//     (lib/alist.js): a film logged on Letterboxd may have been at home
//   - films are matched by the TMDB id Letterboxd puts in the feed, or by
//     title and year (lib/match.js) when it's missing
//
// Duplicates: each entry is remembered (letterboxd_seen, by its guid) and never
// imported twice, so a re-sync adds nothing and a rating or watch deleted here
// isn't brought back. An entry is looked at again only if its rating changed
// on Letterboxd.
//
// Never overwritten: a rating changed in Reel Picks after the Letterboxd entry
// was logged (rated_at later than the entry's pubDate) is kept as it is.
//
// Lists and anything that isn't a film are skipped. Imports start the credits
// backfill, like every other import.
import { get, run, all } from '../db.js';
import { runAs, OWNER_ID } from './user.js';
import { upsertRating, getRating } from './ratings.js';
import { upsertLightMovie } from './movies.js';
import { findTmdbMatch } from './match.js';
import { startCreditsBackfill } from './backfill.js';
import { localYMD, weekStartFriday } from './util.js';

const TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;
// A failed sync (Letterboxd down, a network blip) is tried again after this
// long; a successful one waits for the next day.
const RETRY_MS = 3 * 3600 * 1000;
// "Sync now" can't be pressed faster than this.
const MANUAL_GAP_MS = 10 * 1000;
const USER_AGENT = 'ReelPicks/1.0 (+https://github.com/TawfiqA05/reel-picks)';

// Tests point the feed at a local copy.
const origin = () => (process.env.RP_LETTERBOXD_ORIGIN || '').trim() || 'https://letterboxd.com';

// ---- usernames --------------------------------------------------------------

// Letterboxd usernames are letters, numbers and underscores. Accepts "@name"
// and a pasted profile or RSS link. Returns the name, or null.
export function cleanUsername(input) {
  let s = String(input ?? '').trim();
  const m = s.match(/letterboxd\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,40}$/.test(s) ? s : null;
}

// ---- the feed ---------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return String(s)
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : null;
}

// The diary entries in a feed, oldest first (so a later rewatch's rating wins).
// { guid, title, year, rating (0.5-5 | null), watchedDate, loggedAt, tmdbId }
export function parseFeed(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const guid = tag(it, 'guid');
    const title = tag(it, 'letterboxd:filmTitle');
    if (!guid || !title) continue; // a list, or not a film
    const rating = Number(tag(it, 'letterboxd:memberRating'));
    const watchedDate = tag(it, 'letterboxd:watchedDate');
    const pub = Date.parse(tag(it, 'pubDate') || '');
    const tmdbId = Number(tag(it, 'tmdb:movieId'));
    out.push({
      guid,
      title,
      year: Number(tag(it, 'letterboxd:filmYear')) || null,
      rating: Number.isFinite(rating) && rating >= 0.5 && rating <= 5 ? Math.round(rating * 2) / 2 : null,
      watchedDate: /^\d{4}-\d{2}-\d{2}$/.test(watchedDate || '') ? watchedDate : null,
      loggedAt: Number.isFinite(pub) ? new Date(pub).toISOString() : null,
      tmdbId: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
    });
  }
  return out.sort((a, b) => (a.loggedAt || '').localeCompare(b.loggedAt || ''));
}

class SyncError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

export async function fetchFeed(username) {
  const url = `${origin()}/${encodeURIComponent(username)}/rss/`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new SyncError(`Couldn't reach Letterboxd (${e.name === 'TimeoutError' ? 'it took too long to answer' : e.message}). It will try again later.`, 'network');
  }
  if (res.status === 404) {
    throw new SyncError(`Letterboxd has no public profile called "${username}". Check the spelling: it's the name in your profile's web address, letterboxd.com/username.`, 'username');
  }
  if (!res.ok) throw new SyncError(`Letterboxd answered with an error (HTTP ${res.status}). It will try again later.`, 'network');
  const text = await res.text();
  if (text.length > MAX_BYTES || !/<rss[\s>]/.test(text.slice(0, 2000))) {
    throw new SyncError('Letterboxd sent something that isn\'t a feed. It will try again later.', 'network');
  }
  return parseFeed(text);
}

// ---- state ------------------------------------------------------------------

const row = (userId) => get('SELECT * FROM letterboxd_sync WHERE user_id = ?', userId);

// What Settings shows: the linked name and how the last sync went.
export function syncStatus(userId) {
  const r = row(userId);
  if (!r) return { username: null, syncing: syncing.has(userId) };
  return {
    username: r.username,
    lastSyncAt: r.last_sync_at,
    lastOkAt: r.last_ok_at,
    added: r.last_added ?? 0,
    ratingsAdded: r.last_ratings ?? 0,
    ratingsUpdated: r.last_updated ?? 0,
    watchedAdded: r.last_watched ?? 0,
    kept: r.last_kept ?? 0,
    unmatched: r.last_unmatched ?? 0,
    error: r.last_error || null,
    syncing: syncing.has(userId),
  };
}

// Link (or, with an empty name, unlink) a username. A different name starts
// over: the old account's last result no longer describes anything.
export function setUsername(userId, input) {
  if (String(input ?? '').trim() === '') {
    run('DELETE FROM letterboxd_sync WHERE user_id = ?', userId);
    return null;
  }
  const name = cleanUsername(input);
  if (!name) throw Object.assign(new Error('That isn\'t a Letterboxd username. Use the name from your profile\'s web address (letterboxd.com/username): letters, numbers and underscores.'), { status: 400 });
  const cur = row(userId);
  if (cur && cur.username.toLowerCase() === name.toLowerCase()) {
    run('UPDATE letterboxd_sync SET username = ? WHERE user_id = ?', name, userId);
  } else {
    run('DELETE FROM letterboxd_sync WHERE user_id = ?', userId);
    run('INSERT INTO letterboxd_sync(user_id, username) VALUES(?, ?)', userId, name);
  }
  return name;
}

// ---- importing --------------------------------------------------------------

async function resolveFilm(e) {
  if (e.tmdbId) {
    if (!get('SELECT 1 AS x FROM movies WHERE tmdb_id = ?', e.tmdbId)) upsertLightMovie({ tmdb_id: e.tmdbId, title: e.title, year: e.year });
    return e.tmdbId;
  }
  const found = await findTmdbMatch(e.title, e.year).catch(() => null);
  if (!found?.auto) return null;
  upsertLightMovie(found.result);
  return found.tmdb_id;
}

// Watched on Letterboxd: the watched date at local noon, no ticket price.
// The per-day unique index drops a film already logged here that day.
function addWatch(userId, tmdbId, title, ymd) {
  const at = new Date(`${ymd}T12:00:00`);
  return run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price, source)
      VALUES(?,?,?,?,?,?,0,0,'letterboxd') ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    userId, tmdbId, title, at.toISOString(), weekStartFriday(at), ymd,
  ).changes > 0;
}

async function importEntries(userId, entries) {
  const sum = { ratingsAdded: 0, ratingsUpdated: 0, watchedAdded: 0, kept: 0, unmatched: 0 };
  const addedFilms = new Set();
  for (const e of entries) {
    const seen = get('SELECT rating FROM letterboxd_seen WHERE user_id = ? AND guid = ?', userId, e.guid);
    if (seen && (seen.rating ?? null) === e.rating) continue;
    const tmdbId = await resolveFilm(e);
    if (!tmdbId) { sum.unmatched++; continue; } // tried again next sync
    if (e.rating != null) {
      const mine = runAs(userId, () => getRating(tmdbId));
      const loggedAt = e.loggedAt || new Date().toISOString();
      const rating = { tmdb_id: tmdbId, title: e.title, year: e.year, rating: e.rating, source: 'letterboxd', rated_at: loggedAt, userId };
      if (!mine) {
        upsertRating(rating);
        sum.ratingsAdded++;
        addedFilms.add(tmdbId);
      } else if (Date.parse(mine.rated_at) > Date.parse(loggedAt)) {
        if (mine.rating !== e.rating) sum.kept++; // changed here after Letterboxd: theirs to keep
      } else if (mine.rating !== e.rating) {
        upsertRating(rating);
        sum.ratingsUpdated++;
      }
    }
    if (!seen && e.watchedDate && addWatch(userId, tmdbId, e.title, e.watchedDate)) {
      sum.watchedAdded++;
      addedFilms.add(tmdbId);
    }
    run(`INSERT INTO letterboxd_seen(user_id, guid, rating, seen_at) VALUES(?,?,?,?)
         ON CONFLICT(user_id, guid) DO UPDATE SET rating = excluded.rating, seen_at = excluded.seen_at`,
    userId, e.guid, e.rating, new Date().toISOString());
  }
  return { ...sum, added: addedFilms.size };
}

const syncing = new Set();
const lastManual = new Map();

// Sync one person now. Resolves to syncStatus(); failures are recorded there
// (and never thrown), so a bad username is a message in Settings, not a 500.
export async function syncUser(userId, { manual = false } = {}) {
  const r = row(userId);
  if (!r) return syncStatus(userId);
  if (syncing.has(userId)) return syncStatus(userId);
  if (manual) {
    const last = lastManual.get(userId) || 0;
    if (Date.now() - last < MANUAL_GAP_MS) return syncStatus(userId);
    lastManual.set(userId, Date.now());
  }
  syncing.add(userId);
  const at = () => new Date().toISOString();
  try {
    const entries = await fetchFeed(r.username);
    const sum = await importEntries(userId, entries);
    run(`UPDATE letterboxd_sync SET last_sync_at = ?, last_ok_at = ?, last_error = NULL, last_error_kind = NULL,
           last_added = ?, last_ratings = ?, last_updated = ?, last_watched = ?, last_kept = ?, last_unmatched = ?
         WHERE user_id = ? AND username = ?`,
    at(), at(), sum.added, sum.ratingsAdded, sum.ratingsUpdated, sum.watchedAdded, sum.kept, sum.unmatched, userId, r.username);
    if (sum.ratingsAdded || sum.ratingsUpdated || sum.watchedAdded) {
      startCreditsBackfill('letterboxd');
      console.log(`  🎞  Letterboxd ${r.username}: ${sum.added} film(s) added (${sum.ratingsAdded} rated, ${sum.watchedAdded} watched, ${sum.ratingsUpdated} ratings updated)`);
    }
  } catch (e) {
    const kind = e instanceof SyncError ? e.kind : 'network';
    const message = e instanceof SyncError ? e.message : `The sync failed: ${e.message}`;
    run(`UPDATE letterboxd_sync SET last_sync_at = ?, last_error = ?, last_error_kind = ?, last_added = 0, last_ratings = 0,
           last_updated = 0, last_watched = 0, last_kept = 0, last_unmatched = 0
         WHERE user_id = ? AND username = ?`, at(), message, kind, userId, r.username);
    if (kind !== 'username') console.error(`[letterboxd] ${r.username}: ${message}`);
  } finally {
    syncing.delete(userId);
  }
  return syncStatus(userId);
}

// Due once a day: nothing synced yet today. A failure other than a bad
// username is retried after RETRY_MS; a bad username waits for a new day (or
// for the person to fix it, which syncs straight away).
export function syncDue(r, now = new Date()) {
  if (!r.last_sync_at) return true;
  const last = new Date(r.last_sync_at);
  if (r.last_ok_at && localYMD(new Date(r.last_ok_at)) === localYMD(now)) return false;
  if (localYMD(last) !== localYMD(now)) return true;
  return Boolean(r.last_error) && r.last_error_kind !== 'username' && now - last >= RETRY_MS;
}

let dailyRunning = false;

// Called at startup and on the server's 15-minute tick. Everyone linked, the
// owner and friends whose access isn't revoked, one at a time.
export async function syncAllDue(now = new Date()) {
  if (dailyRunning) return 0;
  dailyRunning = true;
  let n = 0;
  try {
    const rows = all(`SELECT l.* FROM letterboxd_sync l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ? OR (u.id IS NOT NULL AND u.revoked_at IS NULL) ORDER BY l.user_id`, OWNER_ID);
    for (const r of rows) {
      if (!syncDue(r, now)) continue;
      if (n) await new Promise((res) => setTimeout(res, 2000)); // one request at a time, gently
      await syncUser(r.user_id);
      n++;
    }
  } finally {
    dailyRunning = false;
  }
  return n;
}
