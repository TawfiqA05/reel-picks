// SQLite storage using Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUserId } from './lib/user.js';
import { preMigrationBackup } from './lib/backup.js';

// DATA_DIR lets the SQLite database live on a persistent volume in production
// (e.g. a mounted /data). Locally it defaults to ./data next to the app.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : fileURLToPath(new URL('../data/', import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'reelpicks.db');
// Exported for the status diagnostics: "where is my data actually living?" is
// the first question on a deployment whose volume may not be mounted.
export { dataDir, dbPath };

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Canonical movie records, keyed by TMDB id once matched.
CREATE TABLE IF NOT EXISTS movies (
  tmdb_id       INTEGER PRIMARY KEY,
  imdb_id       TEXT,
  title         TEXT,
  year          INTEGER,
  poster        TEXT,
  backdrop      TEXT,
  genres        TEXT,            -- JSON array of names
  director      TEXT,
  cast          TEXT,            -- JSON array of top-billed names
  runtime       INTEGER,         -- minutes
  synopsis      TEXT,
  tmdb_rating   REAL,            -- 0-10
  trailer_key   TEXT,            -- YouTube key
  mpaa          TEXT,            -- e.g. PG-13
  release_date  TEXT,            -- YYYY-MM-DD (TMDB's primary date; often a premiere)
  tmdb_votes    INTEGER,         -- how many votes tmdb_rating rests on
  details_missing TEXT,          -- 'not_found' when TMDB has no such film (backfill skips it)
  us_release_date TEXT,          -- YYYY-MM-DD, US limited/theatrical release
  director_id   INTEGER,         -- TMDB person id of director
  cast_ids      TEXT,            -- JSON array of TMDB person ids, parallel to cast
  scores        TEXT,            -- JSON: raw {imdb,rt,metacritic,rated} from OMDb
  scores_at     TEXT,            -- ISO timestamp of last OMDb score fetch
  first_seen_at TEXT,            -- ISO timestamp we first ingested this movie
  details_at    TEXT,            -- ISO timestamp of last TMDB detail fetch
  playing       INTEGER DEFAULT 0,   -- in this week's theatre lineup
  playing_source TEXT,           -- 'amc' | 'tmdb' (fallback)
  upcoming      INTEGER DEFAULT 0,   -- coming soon
  updated_at    TEXT
);

-- One row per AMC movie -> TMDB match (supports manual override / fixing bad matches).
CREATE TABLE IF NOT EXISTS matches (
  amc_movie_id  TEXT PRIMARY KEY,
  amc_title     TEXT,
  amc_year      INTEGER,
  tmdb_id       INTEGER,
  confidence    REAL,
  manual        INTEGER DEFAULT 0,
  updated_at    TEXT
);

-- Individual showtimes pulled from AMC (or fallback source).
CREATE TABLE IF NOT EXISTS showtimes (
  id            TEXT PRIMARY KEY,   -- AMC showtime id (or synthesized)
  amc_movie_id  TEXT,
  tmdb_id       INTEGER,            -- resolved via matches
  theatre_id    TEXT,
  date          TEXT,               -- YYYY-MM-DD (local)
  start_local   TEXT,               -- ISO-ish local datetime string
  start_epoch   INTEGER,            -- ms since epoch for sorting
  is_imax       INTEGER DEFAULT 0,
  is_advance    INTEGER DEFAULT 0,  -- early-access / advance screening
  format        TEXT,               -- IMAX / Dolby / Standard / etc.
  runtime_min   INTEGER,            -- from AMC if available
  attributes    TEXT,               -- JSON array of attribute names
  purchase_url  TEXT,               -- deep link to AMC booking page
  fetched_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_showtimes_date ON showtimes(date);
CREATE INDEX IF NOT EXISTS idx_showtimes_tmdb ON showtimes(tmdb_id);

-- Accounts. User 1 is the owner; friends join through invite links. Only a
-- hash of an invite token is stored, and it is cleared once redeemed.
-- session_version is bumped on revoke / re-issue, which kills older cookies.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  invite_token_hash TEXT,
  created_at        TEXT,
  revoked_at        TEXT,
  last_seen_at      TEXT,
  session_version   INTEGER NOT NULL DEFAULT 1
);

-- Per-user settings (theatres, home base, windows, weights, …). The keys are
-- USER_SETTING_KEYS below; everything else stays in the shared settings table.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);

-- User ratings (one row per user per movie; upserted). rating is on a 0.5-5 star scale.
-- Older databases get user_id in migrateUsers() below.
CREATE TABLE IF NOT EXISTS ratings (
  user_id    INTEGER NOT NULL DEFAULT 1,
  tmdb_id    INTEGER NOT NULL,
  title      TEXT,
  year       INTEGER,
  rating     REAL,        -- 0.5 - 5.0 stars
  source     TEXT,        -- letterboxd | imdb | manual | onboarding
  rated_at   TEXT,        -- when the user rated it (for recency weighting)
  created_at TEXT,
  PRIMARY KEY (user_id, tmdb_id)
);

-- Ratings imported before we could resolve a TMDB id (matched lazily).
CREATE TABLE IF NOT EXISTS unmatched_ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 1,
  title      TEXT,
  year       INTEGER,
  rating     REAL,
  source     TEXT,
  rated_at   TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id  INTEGER NOT NULL DEFAULT 1,
  tmdb_id  INTEGER NOT NULL,
  added_at TEXT,
  PRIMARY KEY (user_id, tmdb_id)
);

-- "Not for me": films the owner has waved off. Keyed by TMDB id, so a hide
-- survives refreshes and re-releases until it is undone. Never read by the
-- scoring or the taste profile; it only filters what gets recommended.
CREATE TABLE IF NOT EXISTS hidden_movies (
  user_id   INTEGER NOT NULL DEFAULT 1,
  tmdb_id   INTEGER NOT NULL,
  title     TEXT,
  hidden_at TEXT,
  PRIMARY KEY (user_id, tmdb_id)
);

-- A-List / watch log. Powers usage counter, savings, and hit-rate.
-- watched_date is the LOCAL calendar day of watched_at; together with tmdb_id
-- it carries a unique index (idx_watched_movie_day, created in the migration
-- below for old and new databases alike) so the same movie logs at most once
-- per day no matter which write path inserts it. A rewatch on another date is
-- a new row as before.
CREATE TABLE IF NOT EXISTS watched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL DEFAULT 1,
  tmdb_id       INTEGER,
  title         TEXT,
  watched_at    TEXT,
  watched_date  TEXT NOT NULL,   -- local YYYY-MM-DD of watched_at
  week_start    TEXT,      -- Friday that begins the A-List week (YYYY-MM-DD)
  in_weekly4    INTEGER DEFAULT 0,
  ticket_price  REAL
);

-- The weekly 4 as it was actually offered: one row per pick per A-List week,
-- written the first time a movie appears in that week's four. The live four
-- drifts during the week (refreshes re-rank; rating a pick removes it), so
-- "was this one of my picks this week" must read this log, never the
-- instantaneous ranking. Mark-seen's in_weekly4 stamp — and therefore the
-- Stats hit-rate — depends on it.
CREATE TABLE IF NOT EXISTS weekly4_log (
  user_id       INTEGER NOT NULL DEFAULT 1,
  week_start    TEXT,      -- Friday that begins the A-List week (YYYY-MM-DD)
  tmdb_id       INTEGER,
  rank          INTEGER,   -- 1-4 position when first seen that week
  first_seen_at TEXT,
  PRIMARY KEY (user_id, week_start, tmdb_id)
);

-- One row per movie per theatre per refresh: the shape of that theatre's lineup
-- at that moment. Lets the app observe departures and shrinking schedules across
-- refreshes instead of guessing from a single snapshot.
CREATE TABLE IF NOT EXISTS lineup_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  refresh_at     TEXT,       -- ISO timestamp of the refresh
  tmdb_id        INTEGER,
  theatre_id     TEXT,       -- AMC theatre id this row describes
  last_date      TEXT,       -- YYYY-MM-DD of the movie's final published showtime
  showtime_count INTEGER,
  horizon        TEXT,       -- density horizon computed on that refresh
  gap_days       INTEGER     -- days between last_date and the horizon
);
CREATE INDEX IF NOT EXISTS idx_snap_movie ON lineup_snapshots(tmdb_id, refresh_at);
CREATE INDEX IF NOT EXISTS idx_snap_at ON lineup_snapshots(refresh_at);

-- Movies that were in a theatre's lineup last refresh and vanished on this one:
-- ground truth that they left, as opposed to a prediction that they will.
CREATE TABLE IF NOT EXISTS departures (
  tmdb_id     INTEGER,
  theatre_id  TEXT,
  title       TEXT,
  last_date   TEXT,   -- final showtime we ever saw
  departed_at TEXT,   -- ISO timestamp of the refresh where it went missing
  PRIMARY KEY (tmdb_id, theatre_id)
);

-- Generic HTTP response cache (enforces once-per-day refresh, etc.).
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  fetched_at TEXT,
  ttl        INTEGER    -- seconds
);

-- Web Push: one row per device someone turned "weekly picks are ready" on
-- for (lib/push.js). Dead ones are deleted when the push service says so.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user_id);

-- The header search's recents, per person: the last queries (kind 'query',
-- key = the normalized query, so a repeat moves up instead of doubling) and
-- the last films opened from search (kind 'movie', key = TMDB id). seq orders
-- them, newest highest. Private: only ever read for the caller.
CREATE TABLE IF NOT EXISTS search_recents (
  user_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  key     TEXT NOT NULL,
  query   TEXT,
  tmdb_id INTEGER,
  title   TEXT,
  year    INTEGER,
  poster  TEXT,
  seq     INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);

-- The weekly push, claimed per person per A-List week before it is sent, so
-- a restart or redeploy never sends it twice.
CREATE TABLE IF NOT EXISTS push_sent (
  user_id    INTEGER NOT NULL,
  week_start TEXT NOT NULL,   -- Friday that begins the A-List week (YYYY-MM-DD)
  sent_at    TEXT,
  PRIMARY KEY (user_id, week_start)
);
`;

db.exec(SCHEMA);

// ---- migrations --------------------------------------------------------

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Multi-theatre: lineup snapshots and departures gained a theatre_id. Older
// databases get the column added and their existing rows stamped with the
// theatre that was configured at the time (there was only ever one). A copy
// of the database is written to data/backups (lib/backup.js) before anything is altered.
function migrateTheatreColumns() {
  const needSnapshots = !hasColumn('lineup_snapshots', 'theatre_id');
  const needDepartures = !hasColumn('departures', 'theatre_id');
  if (!needSnapshots && !needDepartures) return;

  const backup = preMigrationBackup(db, dataDir, 'theatres');

  const row = db.prepare("SELECT value FROM settings WHERE key = 'theatreId'").get();
  let primary = '';
  try { primary = String(JSON.parse(row?.value ?? '""') || ''); } catch { primary = ''; }

  db.exec('BEGIN');
  try {
    if (needSnapshots) {
      db.exec('ALTER TABLE lineup_snapshots ADD COLUMN theatre_id TEXT');
      db.prepare('UPDATE lineup_snapshots SET theatre_id = ? WHERE theatre_id IS NULL').run(primary);
    }
    if (needDepartures) {
      db.exec(`CREATE TABLE departures_v2 (
        tmdb_id INTEGER, theatre_id TEXT, title TEXT, last_date TEXT, departed_at TEXT,
        PRIMARY KEY (tmdb_id, theatre_id))`);
      db.prepare('INSERT INTO departures_v2 SELECT tmdb_id, ?, title, last_date, departed_at FROM departures').run(primary);
      db.exec('DROP TABLE departures');
      db.exec('ALTER TABLE departures_v2 RENAME TO departures');
    }
    // Showtimes always carried a theatre_id, but make sure nothing is left blank
    // now that the column is used to partition the schedule.
    if (primary) {
      db.prepare("UPDATE showtimes SET theatre_id = ? WHERE theatre_id IS NULL OR theatre_id = ''").run(primary);
    }
    db.exec('COMMIT');
    console.log(`[db] migrated lineup history to per-theatre rows (backup: ${backup})`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrateTheatreColumns();

// matches.review: set when an automatic AMC→TMDB match looks suspect (e.g. the
// matched film is years older than AMC's release date) so it's shown for
// review instead of being accepted silently. NULL = fine / reviewed.
if (!hasColumn('matches', 'review')) {
  preMigrationBackup(db, dataDir, 'matches-review');
  db.exec('ALTER TABLE matches ADD COLUMN review TEXT');
  console.log('[db] added matches.review');
}

// Per-day AMC showtime cache rows were keyed by the UTC date (v1); after 8pm
// Eastern that is the NEXT day's key, so a row could hold yesterday's schedule
// under today's date. lib/amc.js now keys by local date under 'amc:showtimes:v2:'.
// Re-key surviving v1 rows by the date inside their payload (which is always
// the local date the request was for) so the first refresh after upgrading
// keeps its stale-on-error fallback and doesn't re-pull every day.
function migrateShowtimeCacheKeys() {
  const rows = db.prepare(
    "SELECT key, value, fetched_at, ttl FROM cache WHERE key LIKE 'amc:showtimes:%' AND key NOT LIKE 'amc:showtimes:v2:%'",
  ).all();
  if (!rows.length) return;
  preMigrationBackup(db, dataDir, 'cache-keys');
  let moved = 0;
  db.exec('BEGIN');
  try {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)',
    );
    for (const r of rows) {
      const theatreId = r.key.split(':')[2];
      let date = null;
      try {
        const arr = JSON.parse(r.value);
        date = Array.isArray(arr) && arr.length ? arr[0]?.date || null : null;
      } catch { /* unreadable: just drop it */ }
      if (theatreId && date) {
        moved += insert.run(`amc:showtimes:v2:${theatreId}:${date}`, r.value, r.fetched_at, r.ttl).changes;
      }
      db.prepare('DELETE FROM cache WHERE key = ?').run(r.key);
    }
    db.exec('COMMIT');
    console.log(`[db] re-keyed ${moved} of ${rows.length} cached AMC showtime days by local date`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrateShowtimeCacheKeys();

// "Mark seen" idempotency: at most one watched row per movie per LOCAL
// calendar day, enforced at the write by a unique index over
// (tmdb_id, watched_date). Older databases are rebuilt rather than ALTERed,
// because watched_date has to be NOT NULL for the index to mean anything —
// SQLite treats NULLs as distinct, so a nullable column would let a writer
// that forgot it insert unlimited duplicates. The rebuild backfills the date
// with SQLite's 'localtime' (the process TZ, the same clock weekStartFriday
// reads), keeps the EARLIEST row of each same-day group, and carries a
// weekly-4 flag from any of its duplicates onto the survivor. A copy of the
// database is written to data/backups before anything is altered. Fresh databases
// already have the column from the schema and only need the index.
function migrateWatchedDaily() {
  const needRebuild = !hasColumn('watched', 'watched_date');
  const needIndex = !db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_watched_movie_day'",
  ).get();
  if (!needRebuild && !needIndex) return;

  if (needRebuild) {
    const backup = preMigrationBackup(db, dataDir, 'watched-daily');

    const before = db.prepare('SELECT COUNT(*) AS n FROM watched').get().n;
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE watched_v2 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tmdb_id       INTEGER,
        title         TEXT,
        watched_at    TEXT,
        watched_date  TEXT NOT NULL,
        week_start    TEXT,
        in_weekly4    INTEGER DEFAULT 0,
        ticket_price  REAL
      )`);
      // Carry a weekly-4 flag from any duplicate onto the row that will
      // survive, before the group is collapsed.
      db.exec(`UPDATE watched SET in_weekly4 = 1 WHERE in_weekly4 = 0 AND EXISTS (
        SELECT 1 FROM watched d
         WHERE d.tmdb_id IS watched.tmdb_id AND d.in_weekly4 = 1
           AND date(d.watched_at, 'localtime') IS date(watched.watched_at, 'localtime'))`);
      // A row with no timestamp at all is dated today so it survives the
      // NOT NULL rebuild rather than being silently dropped.
      db.exec(`INSERT INTO watched_v2(id, tmdb_id, title, watched_at, watched_date, week_start, in_weekly4, ticket_price)
        SELECT id, tmdb_id, title, watched_at,
               COALESCE(date(watched_at, 'localtime'), date('now', 'localtime')),
               week_start, in_weekly4, ticket_price
          FROM watched
         WHERE id IN (SELECT MIN(id) FROM watched
                       GROUP BY tmdb_id, COALESCE(date(watched_at, 'localtime'), date('now', 'localtime')))`);
      const kept = db.prepare('SELECT COUNT(*) AS n FROM watched_v2').get().n;
      db.exec('DROP TABLE watched');
      db.exec('ALTER TABLE watched_v2 RENAME TO watched');
      db.exec('COMMIT');
      const gone = before - kept;
      console.log(`[db] watched: added per-day key${gone ? `, collapsed ${gone} same-day duplicate row(s)` : ''} (backup: ${backup})`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  // Once watched carries user_id, the per-user index (migrateUsers) replaces
  // this one: two people may well see the same film on the same day.
  if (!hasColumn('watched', 'user_id')) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_movie_day ON watched(tmdb_id, watched_date)');
  }
}

migrateWatchedDaily();

// Settings that belong to each person rather than to the instance. Everything
// else (refresh bookkeeping, Last chance tuning, the fallback window, the
// good-match cutoff) stays shared and owner-set.
export const USER_SETTING_KEYS = new Set([
  'theatreId', 'theatreName', 'theatreSlug', 'extraTheatres', 'home',
  'showtimeWindows', 'previewsMinutes',
  'alistWeeklyLimit', 'alistMonthlyFee', 'avgTicketPrice',
  'excludedGenres', 'excludedMpaa',
  'weightPublic', 'weightTaste', 'preferImax',
  'watchlistBoost', 'imaxBoost', 'windowFitBoost', 'urgencyBoost', 'urgencyWatchlistMultiplier',
  'onboardingDone', 'everythingPlayingCollapsed', 'watchTogether',
]);

// Friends: every per-person table gains user_id (existing rows become user 1,
// the owner) and its uniqueness becomes per user; the owner's per-user
// settings are copied into user_settings (the shared rows are left in place,
// so the pre-migration backup and an older build still read them). A copy of
// the database is written to data/backups first. Idempotent: each piece checks
// whether it is already done, and a fully migrated database writes nothing.
function migrateUsers() {
  const need = {
    ratings: !hasColumn('ratings', 'user_id'),
    unmatched: !hasColumn('unmatched_ratings', 'user_id'),
    watchlist: !hasColumn('watchlist', 'user_id'),
    hidden: !hasColumn('hidden_movies', 'user_id'),
    watched: !hasColumn('watched', 'user_id'),
    weekly4: !hasColumn('weekly4_log', 'user_id'),
  };
  const structural = Object.values(need).some(Boolean);
  const keys = [...USER_SETTING_KEYS];
  const marks = keys.map(() => '?').join(',');
  const needSettings = !db.prepare('SELECT 1 FROM user_settings WHERE user_id = 1 LIMIT 1').get()
    && Boolean(db.prepare(`SELECT 1 FROM settings WHERE key IN (${marks}) LIMIT 1`).get(...keys));
  const needOwner = !db.prepare('SELECT 1 FROM users WHERE id = 1').get();
  const needIndex = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_watched_user_movie_day'").get();
  if (!structural && !needSettings && !needOwner && !needIndex) return;

  let backup = null;
  if (structural || needSettings) {
    backup = preMigrationBackup(db, dataDir, 'users');
  }

  // Rebuild a table whose primary key has to change, keeping row order.
  const rebuild = (table, createSql, cols) => {
    db.exec(createSql.replace(`CREATE TABLE ${table} `, `CREATE TABLE ${table}_v2 `));
    db.exec(`INSERT INTO ${table}_v2(user_id, ${cols}) SELECT 1, ${cols} FROM ${table} ORDER BY rowid`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_v2 RENAME TO ${table}`);
  };

  db.exec('BEGIN');
  try {
    if (needOwner) {
      db.prepare('INSERT INTO users(id, name, created_at) VALUES(1, ?, ?)')
        .run(process.env.OWNER_NAME || 'Tawfiq', new Date().toISOString());
    }
    if (need.ratings) {
      rebuild('ratings', `CREATE TABLE ratings (
        user_id INTEGER NOT NULL DEFAULT 1, tmdb_id INTEGER NOT NULL, title TEXT, year INTEGER, rating REAL,
        source TEXT, rated_at TEXT, created_at TEXT, PRIMARY KEY (user_id, tmdb_id))`,
      'tmdb_id, title, year, rating, source, rated_at, created_at');
    }
    if (need.watchlist) {
      rebuild('watchlist', `CREATE TABLE watchlist (
        user_id INTEGER NOT NULL DEFAULT 1, tmdb_id INTEGER NOT NULL, added_at TEXT, PRIMARY KEY (user_id, tmdb_id))`,
      'tmdb_id, added_at');
    }
    if (need.hidden) {
      rebuild('hidden_movies', `CREATE TABLE hidden_movies (
        user_id INTEGER NOT NULL DEFAULT 1, tmdb_id INTEGER NOT NULL, title TEXT, hidden_at TEXT, PRIMARY KEY (user_id, tmdb_id))`,
      'tmdb_id, title, hidden_at');
    }
    if (need.weekly4) {
      rebuild('weekly4_log', `CREATE TABLE weekly4_log (
        user_id INTEGER NOT NULL DEFAULT 1, week_start TEXT, tmdb_id INTEGER, rank INTEGER, first_seen_at TEXT,
        PRIMARY KEY (user_id, week_start, tmdb_id))`,
      'week_start, tmdb_id, rank, first_seen_at');
    }
    if (need.unmatched) db.exec('ALTER TABLE unmatched_ratings ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1');
    if (need.watched) db.exec('ALTER TABLE watched ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1');
    if (needIndex) {
      db.exec('DROP INDEX IF EXISTS idx_watched_movie_day');
      db.exec('CREATE UNIQUE INDEX idx_watched_user_movie_day ON watched(user_id, tmdb_id, watched_date)');
    }
    if (needSettings) {
      db.prepare(`INSERT OR IGNORE INTO user_settings(user_id, key, value)
        SELECT 1, key, value FROM settings WHERE key IN (${marks})`).run(...keys);
    }
    db.exec('COMMIT');
    if (structural || needSettings) console.log(`[db] per-user data: existing rows are now the owner's (user 1) (backup: ${backup})`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrateUsers();

// TMDB vote counts and US release dates, so a rating from a handful of votes
// (or on a film nobody in the US can see yet) stops counting as a review (see
// lib/scoring.js). Older databases gain the columns and are filled from the
// TMDB detail responses already in the cache — the very responses the stored
// ratings came from, so each count is the one its rating rests on. No
// network. A copy of the database is written first. Films with no cached
// detail stay unknown until the next refresh fetches them.
function migrateMovieVotes() {
  const needVotes = !hasColumn('movies', 'tmdb_votes');
  const needUs = !hasColumn('movies', 'us_release_date');
  if (!needVotes && !needUs) return;
  const backup = preMigrationBackup(db, dataDir, 'votes');
  let filled = 0;
  db.exec('BEGIN');
  try {
    if (needVotes) db.exec('ALTER TABLE movies ADD COLUMN tmdb_votes INTEGER');
    if (needUs) db.exec('ALTER TABLE movies ADD COLUMN us_release_date TEXT');
    const set = db.prepare('UPDATE movies SET tmdb_votes = ?, us_release_date = ? WHERE tmdb_id = ?');
    for (const m of db.prepare('SELECT tmdb_id FROM movies').all()) {
      const row = db.prepare('SELECT value FROM cache WHERE key = ?').get(`tmdb:movie:${m.tmdb_id}`);
      if (!row) continue;
      let d;
      try { d = JSON.parse(row.value); } catch { continue; }
      const us = (d?.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US');
      const usDate = (us?.release_dates || []).filter((x) => x.type === 2 || x.type === 3)
        .map((x) => String(x.release_date || '').slice(0, 10)).filter(Boolean).sort()[0] || null;
      set.run(Number.isInteger(d?.vote_count) ? d.vote_count : null, usDate, m.tmdb_id);
      filled++;
    }
    db.exec('COMMIT');
    console.log(`[db] movies: TMDB vote counts and US release dates for ${filled} film(s) from cache (backup: ${backup})`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migrateMovieVotes();

// movies.details_missing: set when TMDB says a rated film doesn't exist, so the
// credits backfill (lib/backfill.js) stops asking. NULL = fine / not checked.
if (!hasColumn('movies', 'details_missing')) {
  preMigrationBackup(db, dataDir, 'details-missing');
  db.exec('ALTER TABLE movies ADD COLUMN details_missing TEXT');
  console.log('[db] added movies.details_missing');
}

// TMDB person ids for the director and billed cast, so Stats can fetch a
// filmography by id ("More from …"). Older databases gain the columns and are
// filled from the TMDB detail responses already in the cache, the ones their
// names came from. No network; films without a cached response get their ids
// the next time their details are fetched. A copy of the database is written
// first.
function migratePersonIds() {
  if (hasColumn('movies', 'director_id') && hasColumn('movies', 'cast_ids')) return;
  const backup = preMigrationBackup(db, dataDir, 'person-ids');
  let filled = 0;
  db.exec('BEGIN');
  try {
    if (!hasColumn('movies', 'director_id')) db.exec('ALTER TABLE movies ADD COLUMN director_id INTEGER');
    if (!hasColumn('movies', 'cast_ids')) db.exec('ALTER TABLE movies ADD COLUMN cast_ids TEXT');
    const set = db.prepare('UPDATE movies SET director_id = ?, cast_ids = ? WHERE tmdb_id = ?');
    const read = db.prepare('SELECT value FROM cache WHERE key = ?');
    for (const m of db.prepare('SELECT tmdb_id, director, "cast" FROM movies WHERE details_at IS NOT NULL').all()) {
      const row = read.get(`tmdb:movie:${m.tmdb_id}`);
      if (!row) continue;
      let d;
      try { d = JSON.parse(row.value); } catch { continue; }
      // Same picks as tmdb.normalizeDetails; ids only where the stored name matches.
      const dir = (d?.credits?.crew || []).find((c) => c.job === 'Director');
      const billed = (d?.credits?.cast || []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 6);
      let names = [];
      try { names = JSON.parse(m.cast || '[]') || []; } catch { names = []; }
      const byName = new Map(billed.map((c) => [c.name, c.id]));
      set.run(dir && dir.name === m.director ? dir.id : null, JSON.stringify(names.map((n) => byName.get(n) ?? null)), m.tmdb_id);
      filled++;
    }
    db.exec('COMMIT');
    console.log(`[db] movies: TMDB person ids for ${filled} film(s) from cache (backup: ${backup})`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

migratePersonIds();

// ---- low-level helpers -------------------------------------------------

// node:sqlite only accepts null | number | bigint | string | Uint8Array as
// bound params, so coerce booleans/undefined/Date at the boundary.
function clean(params) {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (p === true) return 1;
    if (p === false) return 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...clean(params));
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...clean(params));
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...clean(params));
}

// ---- settings ----------------------------------------------------------

export const DEFAULT_SETTINGS = {
  // Primary theatre: drives the ranking, the day picker, and the runway badges.
  theatreId: '',
  theatreName: 'AMC Castleton Square 14',
  theatreSlug: '',
  // Additional theatres to follow, in the user's order: [{ id, name, slug }].
  // Their showtimes are pulled on every refresh; movies playing only at one of
  // these surface in a separate "Also nearby" section, never in the ranking.
  extraTheatres: [],
  // Where drive times are measured from. Computed once per theatre and cached.
  home: { label: 'Fishers, IN', lat: 39.9568, lng: -86.0134 },
  weightPublic: 0.5,
  weightTaste: 0.5,
  preferImax: true,
  fallbackRecencyWeeks: 8,  // TMDB-fallback only: drop films released longer ago than this
  excludedGenres: [],       // genre names never recommended in the weekly 4
  excludedMpaa: [],         // e.g. ["NC-17"]
  watchlistBoost: 8,        // points added to final score for starred movies
  imaxBoost: 4,             // points added when an IMAX showing exists
  windowFitBoost: 6,        // points added when a showing lands in a preferred window
  // Urgency: up to this many points for a movie whose run at the theatre is
  // CONFIRMED to be ending (runway kind 'ending' — never a hedged "through at
  // least", which is the publishing horizon, not scarcity), scaled by how soon:
  // full on its last day, fading to nothing a week out. Starred movies feel it
  // urgencyWatchlistMultiplier× as strongly. See lib/ranking.js urgencyBoost().
  urgencyBoost: 6,
  urgencyWatchlistMultiplier: 1.5,
  showtimeWindows: {
    weekday: { enabled: true, after: '18:30', before: '23:30' },
    weekend: { enabled: true, after: '10:00', before: '23:30' },
  },
  // Remembered collapse state of the "Everything playing" section.
  everythingPlayingCollapsed: false,
  // Score at or above which a movie counts as a good match for you: the cutoff
  // for the ranked "Worth seeing" section under the weekly 4 on the Picks page.
  goodMatchMinScore: 75,
  // "Last chance" section. Only movies scoring at least lastChanceMinScore show,
  // and only when their last showtime is lastChanceMinGapDays before the
  // publishing horizon (see lib/leaving.js). lastChanceDensity is the share of a
  // normal day's lineup a date must still have to count as published.
  lastChanceMinScore: 75,
  lastChanceMinGapDays: 3,
  lastChanceMaxEntries: 3,
  lastChanceDensity: 0.5,
  // A-List plan terms. AMC varies the reservation allowance and the fee by
  // region and raises the price periodically, so both are settings rather
  // than constants — the usage counter, "remaining", and the savings figure
  // all read them.
  alistWeeklyLimit: 4,
  alistMonthlyFee: 25.99,
  avgTicketPrice: 14.5,
  previewsMinutes: 20,      // added to runtime for end-time calc
  onboardingDone: false,
  // A friend's "Let <owner> plan movies with me" switch (lib/together.js).
  // Off until they turn it on; the owner has no switch and is always available.
  watchTogether: false,
  lastRefresh: null,        // ISO timestamp
  lastRefreshLog: null,     // JSON summary of last refresh
};

// Per-user keys (USER_SETTING_KEYS) live in user_settings for the current
// user, or for `userId` when a caller names one; every other key is shared and
// lives in settings. Reading a per-user key with no user in context throws
// (see lib/user.js) rather than quietly returning the owner's value.
const parse = (row, key) => {
  if (row === undefined) return structuredCloneish(DEFAULT_SETTINGS[key]);
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
};

export function getSetting(key, { userId } = {}) {
  if (USER_SETTING_KEYS.has(key)) {
    return parse(get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', userId ?? currentUserId(), key), key);
  }
  return parse(get('SELECT value FROM settings WHERE key = ?', key), key);
}

export function setSetting(key, value, { userId } = {}) {
  if (USER_SETTING_KEYS.has(key)) {
    run(
      `INSERT INTO user_settings(user_id, key, value) VALUES(?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      userId ?? currentUserId(), key, JSON.stringify(value),
    );
    return value;
  }
  run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
  return value;
}

// One user's view of the settings: their own per-user keys over the shared ones.
export function getSettings({ userId } = {}) {
  const uid = userId ?? currentUserId();
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(key, { userId: uid });
  return out;
}

// Only the shared keys, for background work that belongs to no one user.
export function getSharedSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (!USER_SETTING_KEYS.has(key)) out[key] = getSetting(key);
  return out;
}

export function updateSettings(patch, { userId } = {}) {
  const uid = userId ?? currentUserId();
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) setSetting(k, v, { userId: uid });
  }
  return getSettings({ userId: uid });
}

function structuredCloneish(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
