// Credits backfill: full TMDB details (director, top-billed cast, runtime, …)
// for every rated film that only has a light record. Imports store a title,
// year and genres; without this the taste profile never sees who made or
// starred in an imported film, and Stats can't list directors.
//
// Movie data is shared, so each film is fetched once for everyone. The work
// list is simply "rated by anyone, no details yet, not known to be missing",
// read from the database each batch — so a restart picks up exactly where the
// last run stopped, and a film finished by another path (a refresh, a movie
// page) drops out on its own. It runs after every import, after the daily
// refresh, and on startup, until nothing is missing.
//
// Politeness: one call at a time, at most PER_SECOND live TMDB calls in any
// second, in batches of BATCH with a pause between them. A 429 waits out
// Retry-After and carries on; a 404 marks the film details_missing so it is
// never asked for again; any other failure ends the run, to be retried at the
// next trigger.
import { all, get, run } from '../db.js';
import * as tmdb from './tmdb.js';
import { upsertFullMovie, upsertLightMovie } from './movies.js';
import { currentUserId } from './user.js';

export const PER_SECOND = 4;
const BATCH = 20;
const BATCH_PAUSE_MS = 2000;
// A few ms of margin: Node timers can fire a millisecond early, and four calls
// exactly 250 ms apart can otherwise land five in one second.
const MIN_GAP_MS = Math.ceil(1000 / PER_SECOND) + 5;

export const backfillState = {
  running: false, startedBy: null, startedAt: null, finishedAt: null,
  fetched: 0, notFound: 0, calls: 0, maxPerSecond: 0, lastError: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rated films (anyone's) still waiting for details.
const WAITING = `FROM ratings r LEFT JOIN movies m ON m.tmdb_id = r.tmdb_id
  WHERE (m.tmdb_id IS NULL OR m.details_at IS NULL) AND m.details_missing IS NULL`;

export function pendingCount() {
  return get(`SELECT COUNT(DISTINCT r.tmdb_id) AS n ${WAITING}`).n;
}

// The current user's films still waiting (Stats' "Still loading details" line).
export function pendingForCurrentUser() {
  return get(`SELECT COUNT(*) AS n ${WAITING} AND r.user_id = ?`, currentUserId()).n;
}

// Spaces live calls MIN_GAP_MS apart and records the busiest second. Only
// called on a cache miss (tmdb.js req's gate), so cached films cost nothing.
let nextAt = 0;
const lastSecond = [];
async function gate() {
  // Re-check after sleeping: a timer that wakes early doesn't get to go early.
  for (let wait = nextAt - Date.now(); wait > 0; wait = nextAt - Date.now()) await sleep(wait);
  const now = Date.now();
  nextAt = now + MIN_GAP_MS;
  lastSecond.push(now);
  while (lastSecond.length && lastSecond[0] <= now - 1000) lastSecond.shift();
  backfillState.calls++;
  backfillState.maxPerSecond = Math.max(backfillState.maxPerSecond, lastSecond.length);
}

async function fetchOne(row) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      upsertFullMovie(tmdb.normalizeDetails(await tmdb.details(row.tmdb_id, { gate })));
      backfillState.fetched++;
      return true;
    } catch (e) {
      if (e.status === 404) {
        // TMDB has no such film: remember that, and never ask again.
        if (!get('SELECT 1 AS x FROM movies WHERE tmdb_id = ?', row.tmdb_id)) {
          upsertLightMovie({ tmdb_id: row.tmdb_id, title: row.title || null });
        }
        run("UPDATE movies SET details_missing = 'not_found' WHERE tmdb_id = ?", row.tmdb_id);
        backfillState.notFound++;
        return true;
      }
      if (e.status === 429) {
        const after = Number(e.body?.retry_after || 0) || 10;
        await sleep(Math.min(60, after) * 1000);
        continue;
      }
      backfillState.lastError = `${row.tmdb_id}: ${e.message}`;
      return false;
    }
  }
  backfillState.lastError = `${row.tmdb_id}: still rate-limited after retries`;
  return false;
}

async function runBackfill() {
  const tried = new Set();
  for (;;) {
    const batch = all(`SELECT r.tmdb_id, MAX(r.title) AS title ${WAITING} GROUP BY r.tmdb_id ORDER BY r.tmdb_id LIMIT ?`, BATCH)
      .filter((row) => !tried.has(row.tmdb_id));
    // Nothing left, or only films this run already tried and couldn't finish.
    if (!batch.length) return;
    for (const row of batch) {
      tried.add(row.tmdb_id);
      if (!(await fetchOne(row))) return; // transient trouble: stop, retry at the next trigger
    }
    await sleep(BATCH_PAUSE_MS);
  }
}

// Start the backfill in the background unless it's already running or there's
// nothing to do. `by` says what started it (status diagnostics).
export function startCreditsBackfill(by = 'manual') {
  if (backfillState.running || !tmdb.tmdbConfigured() || pendingCount() === 0) return false;
  Object.assign(backfillState, {
    running: true, startedBy: by, startedAt: new Date().toISOString(), finishedAt: null,
    fetched: 0, notFound: 0, calls: 0, maxPerSecond: 0, lastError: null,
  });
  runBackfill()
    .catch((e) => { backfillState.lastError = e.message; })
    .finally(() => { backfillState.running = false; backfillState.finishedAt = new Date().toISOString(); });
  return true;
}

export function backfillStatus() {
  return { ...backfillState, pending: pendingCount() };
}
