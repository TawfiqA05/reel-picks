// The API: status and refresh, the ranked picks, and a film's detail page.
import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { get, getSettings, dataDir, dbPath } from '../db.js';
import { keyStatus, onRailway } from '../env.js';
import { refreshAll, state as refreshState, ingestOne } from '../lib/refresh.js';
import { getRecommendations, getComingSoon, getMovieDetail } from '../lib/recommend.js';
import { ratingsCount, unmatchedCount } from '../lib/ratings.js';
import { getMovie } from '../lib/movies.js';
import { unmatchedTitles, reviewTitles } from '../lib/match.js';
import * as tmdb from '../lib/tmdb.js';
import * as amc from '../lib/amc.js';
import { followedTheatres, homeBase, readDistance, MAX_THEATRES, sharedTheatreIds } from '../lib/theatres.js';
import { localYMD } from '../lib/util.js';
import { isGuest, ownerName } from '../lib/guest.js';
import { currentUserId, currentUser } from '../lib/user.js';
import { appVersion } from '../lib/version.js';
import { backfillStatus, backfillState } from '../lib/backfill.js';
import { backupStatus, diskStatus } from '../lib/backup.js';
import { userName, handleOf } from '../lib/accounts.js';
import { getNote } from '../lib/notes.js';
import { yearWindow } from '../lib/year.js';
import { h, limited, ownerOnly } from './common.js';

const router = Router();

// ---- status / refresh --------------------------------------------------

// Followed theatres with their cached drive times (no network on this path).
function theatresForStatus(s) {
  const home = homeBase(s);
  return followedTheatres(s).map((t) => ({
    id: t.id, name: t.name, slug: t.slug, short: t.short, isPrimary: t.isPrimary, distance: readDistance(t.id, home),
  }));
}

// Which version is deployed (lib/version.js), for js/update.js. Anyone may ask.
router.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: appVersion });
});

router.get('/status', (req, res) => {
  const s = getSettings();
  const theatres = theatresForStatus(s);
  if (isGuest(req)) {
    // Minimal, non-sensitive payload for the shared read-only link. No drive
    // times or distances: the link is public and they'd reveal where home is.
    return res.json({
      guest: true,
      ownerName: ownerName(),
      theatre: { id: '', name: s.theatreName, short: theatres[0].short, distance: null },
      theatres: theatres.map((t) => ({ id: '', name: t.name, short: t.short, isPrimary: t.isPrimary, distance: null })),
      keys: { tmdb: true, omdb: true, amc: false },
      counts: {},
      onboardingDone: true,
      refreshing: false, matching: false, enriching: false,
      lastRefresh: s.lastRefresh, lastRefreshLog: null,
    });
  }
  const me = currentUser();
  // A friend is named by their handle, never their account number (which
  // would say how many accounts were made before theirs; lib/accounts.js).
  const user = { id: me.isOwner ? me.userId : handleOf(me.userId), name: me.isOwner ? ownerName() : (userName(me.userId) || 'Friend'), isOwner: Boolean(me.isOwner) };
  if (!me.isOwner) {
    // A friend: their own theatres, home and counts; none of the owner's
    // diagnostics (key fingerprints, data dir, refresh log, AMC matching).
    return res.json({
      guest: false,
      user,
      ownerName: ownerName(),
      keys: { tmdb: keyStatus().tmdb, omdb: true, amc: true },
      theatre: { ...theatres[0] },
      theatres,
      maxTheatres: MAX_THEATRES,
      home: homeBase(s),
      onboardingDone: Boolean(s.onboardingDone),
      setupDone: Boolean(s.setupDone),
      tourDone: Boolean(s.tourDone),
      youNoteSeen: Boolean(s.youNoteSeen),
      everythingPlayingCollapsed: Boolean(s.everythingPlayingCollapsed),
      // Your year in movies (lib/year.js): open Dec 1 to Jan 15, and for which year.
      year: yearWindow(),
      lastRefresh: s.lastRefresh,
      refreshing: refreshState.running,
      matching: Boolean(refreshState.draining),
      lastDrain: refreshState.lastDrain || null,
      enriching: backfillState.running,
      counts: {
        ratings: ratingsCount(),
        unmatched: unmatchedCount(),
        watchlist: get('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?', currentUserId()).n,
      },
    });
  }
  const log = s.lastRefreshLog;
  // Non-reversible key fingerprints (length + sha256 prefix): enough to tell
  // whether two instances hold the SAME key value without exposing either.
  const fp = (v) => (v ? { len: v.length, sha8: crypto.createHash('sha256').update(v).digest('hex').slice(0, 8) } : null);
  // WAL mode: recent writes sit in -wal until a checkpoint, so count them too.
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(dbPath).size;
    for (const ext of ['-wal', '-shm']) {
      try { dbBytes += fs.statSync(dbPath + ext).size; } catch { /* absent is fine */ }
    }
  } catch { /* unreadable: leave null */ }
  res.json({
    guest: false,
    user,
    ownerName: ownerName(),
    keys: keyStatus(),
    keyMeta: {
      tmdb: fp(process.env.TMDB_API_KEY?.trim()),
      omdb: fp(process.env.OMDB_API_KEY?.trim()),
      amc: fp(process.env.AMC_API_KEY?.trim()),
    },
    // Deployment diagnostics: is the DB on the volume, and what clock does
    // showtime math use? (Containers default to UTC unless TZ is set.)
    data: { dir: dataDir, dbBytes, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || null },
    // Where keys are edited: Railway sets these variables in every deployment.
    host: onRailway() ? 'railway' : 'local',
    // Automatic backups (lib/backup.js): the newest copy, and a failure since it.
    backup: backupStatus(dataDir),
    // The data volume, the live database and what the backups take (Settings > Data).
    disk: diskStatus(dataDir),
    theatre: { ...theatres[0] },
    theatres,
    maxTheatres: MAX_THEATRES,
    home: homeBase(s),
    onboardingDone: Boolean(s.onboardingDone),
    setupDone: Boolean(s.setupDone),
    tourDone: Boolean(s.tourDone),
    youNoteSeen: Boolean(s.youNoteSeen),
    everythingPlayingCollapsed: Boolean(s.everythingPlayingCollapsed),
    year: yearWindow(),
    lastRefresh: s.lastRefresh,
    refreshing: refreshState.running,
    // Most recent refresh request (who asked is not recorded; force says whether it re-pulled).
    lastRefreshRequest: refreshState.lastRequest || null,
    // Credits backfill for rated films (lib/backfill.js) and live TMDB call counts.
    creditsBackfill: backfillStatus(),
    tmdbCalls: { ...tmdb.netStats },
    sharedTheatres: sharedTheatreIds().size,
    matching: Boolean(refreshState.draining),
    // Result of the most recent background matching run (import summary panel).
    lastDrain: refreshState.lastDrain || null,
    enriching: backfillState.running,
    counts: {
      playing: get('SELECT COUNT(*) AS n FROM movies WHERE playing = 1').n,
      upcoming: get('SELECT COUNT(*) AS n FROM movies WHERE upcoming = 1').n,
      showtimes: get('SELECT COUNT(*) AS n FROM showtimes').n,
      ratings: ratingsCount(),
      unmatched: unmatchedCount(),
      watchlist: get('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?', currentUserId()).n,
      // AMC titles with upcoming showtimes and no TMDB match (not ignored):
      // invisible to ranking/runway until matched, so the UI nags about them.
      unmatchedAmc: unmatchedTitles(localYMD()).unmatched.length,
      // Automatic matches flagged as suspect (e.g. a film years older than
      // AMC's release date), awaiting keep/fix.
      reviewAmc: reviewTitles(localYMD()).length,
    },
    lastRefreshLog: log
      ? {
        errors: (log.errors || []).slice(0, 40), sources: log.sources, counts: log.counts, filtered: log.filtered,
        horizon: log.horizon, horizons: log.horizons || (log.horizon ? [log.horizon] : []), finishedAt: log.finishedAt,
      }
      : null,
  });
});

// Manual refresh. If one is already running (e.g. the startup auto-refresh),
// this one is queued behind it — with force, so it still re-pulls today and
// tomorrow — instead of being dropped.
router.post('/refresh', ownerOnly, (req, res) => {
  const queued = refreshState.running;
  refreshAll({ force: true }).catch((e) => console.error('[refresh]', e.message));
  res.json({ started: true, queued });
});

// ---- recommendations / detail -----------------------------------------

router.get('/recommendations', h(async (req, res) => res.json(getRecommendations({ guest: isGuest(req) }))));
router.get('/coming-soon', h(async (req, res) => res.json(getComingSoon({ guest: isGuest(req) }))));

// Movie detail. The Rate tab's TMDB search can link to a film we've never
// stored, and Coming Soon rows are light records (no runtime/cast/trailer), so
// for the OWNER a missing or light movie is fetched from TMDB (+ OMDb scores)
// once, stored, and rendered. The stored row is never flagged playing/upcoming,
// so it can't touch the lineup, breadth counts or horizon. Guests get a plain
// 404 / the light record: they must not drive TMDB/OMDb calls on the owner's keys.
router.get('/movies/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Movie not found' });
  const guest = isGuest(req);
  if (!guest) {
    const have = getMovie(id);
    if (!have && limited(req, res, 'newFilm')) return;
    if (!have || !have.details_at) {
      const log = await ingestOne(id); // cached: TMDB details 7d, OMDb per its own TTL
      if (!getMovie(id)) {
        // TMDB saying 404 means there's no such film; anything else is TMDB
        // being unreachable. The raw error (it carries the request URL) stays
        // in the server log.
        if (log.errors.length) console.error('[movie]', id, log.errors[0]);
        return log.errors.length && !/HTTP 404/.test(log.errors[0])
          ? res.status(502).json({ error: 'Couldn\'t reach TMDB to load this movie. Try again in a moment.' })
          : res.status(404).json({ error: tmdb.tmdbConfigured() ? 'Movie not found' : 'Movie not found locally and TMDB_API_KEY is not set.' });
      }
    }
  }
  const detail = getMovieDetail(id, { guest });
  if (!detail) return res.status(404).json({ error: 'Movie not found' });
  // The caller's own note on it (lib/notes.js); the guest link has none.
  res.json(guest ? detail : { ...detail, myNote: detail.myRating != null ? getNote(currentUserId(), id) : null });
}));

export default router;
