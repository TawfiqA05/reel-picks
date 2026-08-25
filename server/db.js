// SQLite storage using Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  release_date  TEXT,            -- YYYY-MM-DD
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

-- User ratings (one row per movie; upserted). rating is on a 0.5-5 star scale.
CREATE TABLE IF NOT EXISTS ratings (
  tmdb_id    INTEGER PRIMARY KEY,
  title      TEXT,
  year       INTEGER,
  rating     REAL,        -- 0.5 - 5.0 stars
  source     TEXT,        -- letterboxd | imdb | manual | onboarding
  rated_at   TEXT,        -- when the user rated it (for recency weighting)
  created_at TEXT
);

-- Ratings imported before we could resolve a TMDB id (matched lazily).
CREATE TABLE IF NOT EXISTS unmatched_ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  year       INTEGER,
  rating     REAL,
  source     TEXT,
  rated_at   TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  tmdb_id  INTEGER PRIMARY KEY,
  added_at TEXT
);

-- A-List / watch log. Powers usage counter, savings, and hit-rate.
-- watched_date is the LOCAL calendar day of watched_at; together with tmdb_id
-- it carries a unique index (idx_watched_movie_day, created in the migration
-- below for old and new databases alike) so the same movie logs at most once
-- per day no matter which write path inserts it. A rewatch on another date is
-- a new row as before.
CREATE TABLE IF NOT EXISTS watched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  week_start    TEXT,      -- Friday that begins the A-List week (YYYY-MM-DD)
  tmdb_id       INTEGER,
  rank          INTEGER,   -- 1-4 position when first seen that week
  first_seen_at TEXT,
  PRIMARY KEY (week_start, tmdb_id)
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
`;

db.exec(SCHEMA);

// ---- migrations --------------------------------------------------------

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Multi-theatre: lineup snapshots and departures gained a theatre_id. Older
// databases get the column added and their existing rows stamped with the
// theatre that was configured at the time (there was only ever one). A copy
// of the database is written next to it before anything is altered.
function migrateTheatreColumns() {
  const needSnapshots = !hasColumn('lineup_snapshots', 'theatre_id');
  const needDepartures = !hasColumn('departures', 'theatre_id');
  if (!needSnapshots && !needDepartures) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dataDir, `reelpicks.pre-theatres-${stamp}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

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
// database is written next to it before anything is altered. Fresh databases
// already have the column from the schema and only need the index.
function migrateWatchedDaily() {
  const needRebuild = !hasColumn('watched', 'watched_date');
  const needIndex = !db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_watched_movie_day'",
  ).get();
  if (!needRebuild && !needIndex) return;

  if (needRebuild) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(dataDir, `reelpicks.pre-watched-daily-${stamp}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

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
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_movie_day ON watched(tmdb_id, watched_date)');
}

migrateWatchedDaily();

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
  lastRefresh: null,        // ISO timestamp
  lastRefreshLog: null,     // JSON summary of last refresh
};

export function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (row === undefined) return structuredCloneish(DEFAULT_SETTINGS[key]);
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
  return value;
}

export function getSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(key);
  return out;
}

export function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) setSetting(k, v);
  }
  return getSettings();
}

function structuredCloneish(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
