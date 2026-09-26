// All JSON API routes for Reel Picks.
import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { get, all, run, getSettings, updateSettings, getSetting, setSetting, dataDir, dbPath, USER_SETTING_KEYS } from './db.js';
import { exportState, importState } from './lib/state.js';
import { keyStatus } from './env.js';
import {
  refreshAll, shouldAutoRefresh, state as refreshState, ingestOne, drainUnmatched,
} from './lib/refresh.js';
import {
  getRecommendations, getComingSoon, getMovieDetail, getProfileSummary, wasWeekly4Pick, getStatsGroup, STATS_GROUP_KINDS,
} from './lib/recommend.js';
import {
  upsertRating, addUnmatched, deleteRating, listRatings, ratedIds,
  ratingsCount, unmatchedCount,
} from './lib/ratings.js';
import { getMovie, upsertLightMovie, hydrate } from './lib/movies.js';
import { setManualMatch, ignoreMatch, unignoreMatch, unmatchedTitles, reviewTitles, keepMatch } from './lib/match.js';
import { logWatched, undoWatched, getWeek, restoreWatched } from './lib/alist.js';
import { getStats } from './lib/stats.js';
import { getStatsMore } from './lib/statsMore.js';
import { normalizeRatingsCsv, parseCsv, detectFormat, parseBackupCsv } from './lib/csv.js';
import * as tmdb from './lib/tmdb.js';
import * as amc from './lib/amc.js';
import {
  followedTheatres, homeBase, readDistance, addFollowed, removeFollowed, promoteToPrimary,
  replacePrimary, refreshDistances, MAX_THEATRES, sharedTheatreIds,
} from './lib/theatres.js';
import { geocode, reverseGeocode } from './lib/geocode.js';
import { showtimeIcs, icsFilename, theatreRecord } from './lib/calendar.js';
import { bustCache } from './lib/cache.js';
import { localYMD, addDays, csvField } from './lib/util.js';
import { isGuest, ownerName } from './lib/guest.js';
import { currentUserId, currentUser } from './lib/user.js';
import { startCreditsBackfill, backfillStatus, backfillState, tmdbThrottle } from './lib/backfill.js';
import { backupStatus, latestBackup, backupsDir } from './lib/backup.js';
import { overview as togetherOverview, partnerFor, filmsFor, NOT_FOUND } from './lib/together.js';
import { settingsProblems } from '../public/js/settingsRules.js';
import { search, playingIds, listRecents, addRecent, removeRecent, clearRecents, restoreRecents } from './lib/search.js';
import { listFriends, createFriend, revokeFriend, reissueFriend, MAX_USERS, userName } from './lib/accounts.js';
import {
  pushEnabled, publicKey, saveSubscription, removeSubscription, hasSubscription, sendWeekly,
} from './lib/push.js';
import { recentAlerts, failingNow } from './lib/alerts.js';
import { syncStatus as letterboxdStatus, setUsername as setLetterboxdUser, syncUser as syncLetterboxd } from './lib/letterboxd.js';

const router = Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The owner's controls: key status, AMC title matching, friends, full-setup
// import, forced refreshes. A friend gets a 403; the guest link never reaches
// these (lib/guest.js allowlist).
const isOwnerRequest = () => Boolean(currentUser()?.isOwner);

// After a theatre change: the owner's forces a refresh as always. A friend's
// never forces; it queues an ordinary background refresh only when it brought
// in a theatre nobody was following, so its showtimes arrive.
function afterTheatreChange(wasShared, tag) {
  if (isOwnerRequest()) refreshAll({ force: true }).catch((e) => console.error(`[${tag} refresh]`, e.message));
  else if (!wasShared) refreshAll({ force: false, reason: 'friend followed a new theatre' }).catch((e) => console.error(`[${tag} refresh]`, e.message));
}
const ownerOnly = (req, res, next) => (isOwnerRequest()
  ? next()
  : res.status(403).json({ error: 'Only the owner can do that.' }));

// A friend's view of the settings: no refresh log (it carries the owner's
// drive times), and the shared keys are the owner's to change.
function forCaller(settings) {
  if (isOwnerRequest()) return settings;
  const { lastRefreshLog, ...rest } = settings;
  return rest;
}
const card = (m) => ({
  tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster,
  genres: m.genres || [], mpaa: m.mpaa || null, tmdb_rating: m.tmdb_rating ?? null,
});

// ---- status / refresh --------------------------------------------------

// Followed theatres with their cached drive times (no network on this path).
function theatresForStatus(s) {
  const home = homeBase(s);
  return followedTheatres(s).map((t) => ({
    id: t.id, name: t.name, slug: t.slug, short: t.short, isPrimary: t.isPrimary, distance: readDistance(t.id, home),
  }));
}

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
  const user = { id: me.userId, name: me.isOwner ? ownerName() : (userName(me.userId) || 'Friend'), isOwner: Boolean(me.isOwner) };
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
      everythingPlayingCollapsed: Boolean(s.everythingPlayingCollapsed),
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
    // Automatic backups (lib/backup.js): the newest copy, and a failure since it.
    backup: backupStatus(dataDir),
    theatre: { ...theatres[0] },
    theatres,
    maxTheatres: MAX_THEATRES,
    home: homeBase(s),
    onboardingDone: Boolean(s.onboardingDone),
    setupDone: Boolean(s.setupDone),
    tourDone: Boolean(s.tourDone),
    everythingPlayingCollapsed: Boolean(s.everythingPlayingCollapsed),
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
router.get('/profile', (req, res) => res.json(getProfileSummary()));

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
  res.json(detail);
}));

// ---- settings / theatre ------------------------------------------------

router.get('/settings', (req, res) => res.json(forCaller(getSettings())));

router.put('/settings', (req, res) => {
  const patch = { ...(req.body || {}) };
  // Friends change only their own keys; the shared ones are the owner's.
  if (!isOwnerRequest()) for (const k of Object.keys(patch)) if (!USER_SETTING_KEYS.has(k)) delete patch[k];
  // Numbers out of range (or not numbers) are refused, never coerced: the
  // Settings page checks the same rules (public/js/settingsRules.js) first.
  const problems = settingsProblems(patch);
  if (problems.length) return res.status(400).json({ error: `${problems[0].key}: ${problems[0].message}`, problems });
  if (patch.weightPublic != null || patch.weightTaste != null) {
    const wp = Number(patch.weightPublic ?? getSetting('weightPublic')) || 0;
    const wt = Number(patch.weightTaste ?? getSetting('weightTaste')) || 0;
    const sum = wp + wt || 1;
    patch.weightPublic = wp / sum;
    patch.weightTaste = wt / sum;
  }
  // Urgency: a non-negative point value and a multiplier of at least 1, so what
  // is stored is what ranking uses and what the Settings page shows.
  for (const k of ['setupDone', 'tourDone']) if (k in patch) patch[k] = Boolean(patch[k]);
  if ('urgencyBoost' in patch) patch.urgencyBoost = Math.max(0, Number(patch.urgencyBoost) || 0);
  if ('urgencyWatchlistMultiplier' in patch) patch.urgencyWatchlistMultiplier = Math.max(1, Number(patch.urgencyWatchlistMultiplier) || 1);
  // `home` must be a (possibly partial) { label, lat, lng } object. Merge it
  // onto the stored value so a raw client PATCHing one field can't silently
  // reset the others to defaults (the Settings UI always sends all three).
  if ('home' in patch) {
    if (!patch.home || typeof patch.home !== 'object' || Array.isArray(patch.home)) {
      return res.status(400).json({ error: 'home must be an object like { label, lat, lng }.' });
    }
    const cur = getSetting('home') || {};
    const merged = { ...cur };
    for (const k of ['label', 'lat', 'lng']) if (k in patch.home) merged[k] = patch.home[k];
    patch.home = merged;
  }
  const before = homeBase(getSettings());
  const next = updateSettings(patch);
  // Home moved → this user's cached drive times measure from the wrong origin.
  // Drop them and re-measure in the background (one OSRM call per theatre), so
  // the times heal in seconds instead of at the next daily refresh.
  const after = homeBase(next);
  if ('home' in patch && (before.lat !== after.lat || before.lng !== after.lng)) {
    refreshDistances(next, before).catch((e) => console.error('[home] drive-time refresh', e.message));
  }
  res.json(forCaller(next));
});

// ---- home base / geocoding ----------------------------------------------
// Owner-only: none of these are on the guest allowlist (lib/guest.js is
// default-deny), so the shared link can neither geocode nor read home base.

// Free-form text ("Fishers IN", "46037", a street address) → up to 5
// candidates via Nominatim, cached for months and throttled to 1 req/s
// (lib/geocode.js). Failure reports plainly; it never clears anything.
router.get('/geocode', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Type a place to look up.' });
  try {
    res.json({ results: await geocode(q) });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.status(502).json({ error: 'Couldn\'t reach the place lookup (nominatim.openstreetmap.org). Check the connection and try again.' });
  }
}));

// Coordinates → place name, for the "use my current location" button. The
// browser already rounds to ~1 km before calling this, and reverseGeocode
// rounds again before anything goes to Nominatim.
router.get('/geocode/reverse', h(async (req, res) => {
  try {
    res.json({ result: await reverseGeocode(req.query.lat, req.query.lng) });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.status(502).json({ error: 'Couldn\'t reach the place lookup. Keep the coordinates and type a label instead.' });
  }
}));

// Clear home base: wipe the stored location and every cache row derived from
// it (drive times for any origin, geocoder lookups), then fall back to the
// app default and re-measure drive times from there in the background.
router.delete('/home', h(async (req, res) => {
  const before = homeBase(getSettings());
  const next = updateSettings({ home: { label: null, lat: null, lng: null } });
  bustCache('nominatim:');
  refreshDistances(next, before).catch((e) => console.error('[home] drive-time refresh', e.message));
  res.json({ cleared: true, home: homeBase(next) });
}));

router.get('/theatres', h(async (req, res) => {
  if (!amc.amcConfigured()) return res.status(400).json({ error: 'AMC_API_KEY is not set. Add it to .env to search theatres.' });
  res.json({ theatres: await amc.searchTheatres(req.query.query || '') });
}));

// Make a theatre the primary. The old primary stays followed (demoted), so no
// schedule or history is lost; rejected if that would exceed the cap.
router.post('/theatre', (req, res) => {
  const { id, name, slug } = req.body || {};
  try {
    const wasShared = sharedTheatreIds().has(String(id));
    const settings = replacePrimary({ id, name, slug });
    afterTheatreChange(wasShared, 'theatre');
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- followed theatres ---------------------------------------------------

router.post('/theatres/follow', (req, res) => {
  const { id, name, slug } = req.body || {};
  try {
    const wasShared = sharedTheatreIds().has(String(id));
    const settings = addFollowed({ id, name, slug });
    afterTheatreChange(wasShared, 'follow');
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/theatres/follow/:id', (req, res) => {
  res.json(forCaller(removeFollowed(req.params.id)));
});

// Promote a followed theatre to primary; the old primary stays followed.
router.post('/theatres/primary', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Theatre id is required.' });
  try {
    const settings = promoteToPrimary(id);
    // Showtimes for both are already loaded; re-run so the per-theatre horizon
    // log and the primary-driven snapshot history line up with the new roles.
    afterTheatreChange(true, 'primary'); // already followed by this user, so already pulled
    res.json(forCaller(settings));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- full-setup state (owner-only; not on the guest allowlist) ----------

// Everything that makes this instance mine, as one JSON download — the way to
// clone a local setup onto a deployment. See lib/state.js for what travels.
router.get('/state', (req, res) => {
  const doc = exportState();
  res.setHeader('Content-Disposition', `attachment; filename="reelpicks-setup-${localYMD()}.json"`);
  res.json(doc);
});

// The newest automatic backup (nightly or pre-migration), as a SQLite file.
// Owner only: it holds everyone's data. Guests never reach it (not on the
// lib/guest.js allowlist).
router.get('/backup/latest', ownerOnly, (req, res) => {
  const b = latestBackup(backupsDir(dataDir));
  if (!b) return res.status(404).json({ error: 'No backup yet. The first one is taken at 3am.' });
  res.set('Cache-Control', 'no-store');
  res.download(b.file, b.name);
});

// Apply a full-setup document, then rebuild everything derived: a forced
// refresh pulls this instance's own showtimes/scores for the imported
// theatres, and detail enrichment fills in posters for imported ratings.
router.post('/state', ownerOnly, (req, res) => {
  let doc = req.body;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { doc = null; } }
  try {
    const counts = importState(doc);
    refreshAll({ force: true }).catch((e) => console.error('[state refresh]', e.message));
    startCreditsBackfill('setup import');
    res.json({ imported: counts, refreshing: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- ratings -----------------------------------------------------------

router.get('/ratings', (req, res) => {
  res.json({
    ratings: listRatings().map((r) => ({
      tmdb_id: r.tmdb_id, title: r.title, year: r.year, rating: r.rating,
      source: r.source, rated_at: r.rated_at, poster: r.poster || null,
    })),
  });
});

router.post('/ratings', (req, res) => {
  const { tmdb_id, rating, title, year, poster, genres, source = 'manual' } = req.body || {};
  if (!tmdb_id || !(rating >= 0.5 && rating <= 5)) {
    return res.status(400).json({ error: 'tmdb_id and a rating between 0.5 and 5 are required.' });
  }
  if (!getMovie(tmdb_id) && (title || poster)) {
    upsertLightMovie({ tmdb_id, title, year, poster, genres: genres || [] });
  }
  upsertRating({ tmdb_id, title, year, rating, source });
  if (!req.body?.awaitDetails) {
    ingestOne(tmdb_id).catch(() => {}); // deepen taste profile in the background
    return res.json({ ok: true });
  }
  // A Stats sheet asks to wait for the film's credits (throttled, cached), so
  // its "You rated" list can show the film straight away; scores follow in
  // the background as usual.
  ingestOne(tmdb_id, { detailsOnly: true, gate: tmdbThrottle })
    .catch(() => {})
    .finally(() => {
      ingestOne(tmdb_id).catch(() => {});
      res.json({ ok: true });
    });
});

router.delete('/ratings/:id', (req, res) => {
  deleteRating(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/ratings/import', (req, res) => {
  const csv = req.body?.csv;
  if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'Missing CSV text.' });
  // The export ZIP itself, read as text, starts with the ZIP magic "PK\x03\x04" —
  // the single most common wrong upload. Name the fix, don't say "could not detect".
  if (csv.startsWith('PK\u0003\u0004')) {
    return res.status(400).json({ error: 'That looks like the export ZIP itself. Unzip it first, then upload the ratings.csv file from inside it.' });
  }
  const rows = parseCsv(csv);
  if (!rows.length) return res.status(400).json({ error: 'That file is empty.' });
  const format = detectFormat(rows[0]);

  // Right service, wrong file: watched.csv / watchlist.csv (Letterboxd) or a
  // list export (IMDb) — files that genuinely contain no star ratings.
  if (format === 'letterboxd-no-ratings') {
    return res.status(400).json({ error: 'This looks like Letterboxd\'s watched.csv or watchlist.csv. Those files never contain star ratings. Upload ratings.csv from the same export ZIP instead.' });
  }
  if (format === 'imdb-no-ratings') {
    return res.status(400).json({ error: 'This looks like an IMDb list or watchlist export, which has no "Your Rating" column. Export from "Your ratings" instead.' });
  }

  // Reel Picks backup: restore ratings (by tmdb_id) + watch history directly.
  if (format === 'reelpicks') {
    const { ratings, watched, skipped, skippedSamples } = parseBackupCsv(csv);
    let ratingsRestored = 0;
    for (const r of ratings) {
      upsertLightMovie({ tmdb_id: r.tmdb_id, title: r.title, year: r.year });
      upsertRating(r);
      ratingsRestored++;
    }
    let watchedRestored = 0;
    for (const w of watched) {
      upsertLightMovie({ tmdb_id: w.tmdb_id, title: w.title });
      if (restoreWatched(w)) watchedRestored++;
    }
    startCreditsBackfill('import');
    return res.json({ format: 'reelpicks', ratingsRestored, watchedRestored, skipped, skippedSamples, enriching: tmdb.tmdbConfigured() });
  }

  if (format === 'unknown') {
    return res.status(400).json({ error: 'Could not detect a Letterboxd, IMDb, or Reel Picks backup CSV in that file. Expected ratings.csv from a Letterboxd export ZIP, or the CSV from IMDb\'s "Your ratings" export.' });
  }

  // Letterboxd / IMDb: queue for background TMDB title matching.
  const parsed = normalizeRatingsCsv(csv);

  // Valid export, zero rated rows: the classic "I marked everything watched but
  // never starred anything" Letterboxd case. Not a detection failure — say what
  // is actually going on.
  if (!parsed.rows.length) {
    return res.json({
      format: parsed.format,
      received: 0,
      skipped: parsed.skipped,
      emptyExport: true,
      note: parsed.format === 'letterboxd'
        ? (parsed.skipped
          ? `This is a valid Letterboxd export, but none of its ${parsed.skipped} film row(s) carry a star rating. On Letterboxd, marking a film watched is not the same as rating it, and only star ratings export. Rate some films there and re-export, or rate here in the app instead.`
          : 'This is a valid Letterboxd export, but it contains no film rows at all. The account looks like it has no star ratings yet. Rate some films there and re-export, or rate here in the app instead.')
        : `This is a valid IMDb export, but no row has a value in the "Your Rating" column. Rate some titles on IMDb and re-export, or rate here in the app instead.`,
    });
  }

  const ratingsBefore = ratingsCount();
  const pendingBefore = unmatchedCount();
  for (const row of parsed.rows) addUnmatched(row);
  drainUnmatched().catch((e) => console.error('[drain]', e.message));
  res.json({
    format: parsed.format,
    received: parsed.rows.length,
    skipped: parsed.skipped,
    skippedSamples: parsed.skippedSamples,
    skippedWhy: parsed.format === 'letterboxd'
      ? 'no star rating on those rows (on Letterboxd, watched is not rated)'
      : 'no value in the "Your Rating" column on those rows',
    ratingsBefore,
    pendingBefore,
    // Baseline for the client's "has a matching run finished since my import?"
    // check — compared by inequality against /status lastDrain, so browser and
    // server clocks never enter into it.
    lastDrainAt: refreshState.lastDrain?.finishedAt || null,
    matching: tmdb.tmdbConfigured(),
  });
});

// ---- Letterboxd auto-sync (lib/letterboxd.js) -------------------------------
// The caller's own link: owner or friend. Not on the guest allowlist, so the
// guest link gets a 403 before a handler runs. Saving a name syncs straight
// away, so a misspelled one shows its message at once.

router.get('/letterboxd', (req, res) => res.json(letterboxdStatus(currentUserId())));

router.put('/letterboxd', h(async (req, res) => {
  const uid = currentUserId();
  const name = setLetterboxdUser(uid, req.body?.username);
  res.json(name ? await syncLetterboxd(uid) : letterboxdStatus(uid));
}));

router.post('/letterboxd/sync', h(async (req, res) => {
  const uid = currentUserId();
  if (!letterboxdStatus(uid).username) return res.status(400).json({ error: 'Add your Letterboxd username first.' });
  res.json(await syncLetterboxd(uid, { manual: true }));
}));

router.get('/ratings/search', h(async (req, res) => {
  if (!tmdb.tmdbConfigured()) return res.status(400).json({ error: 'TMDB_API_KEY is not set.' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = await tmdb.liveSearch(q);
  const mine = new Map(all('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', currentUserId()).map((r) => [r.tmdb_id, r.rating]));
  res.json({ results: results.map((r) => ({ ...r, myRating: mine.get(r.tmdb_id) ?? null })) });
}));

// ---- header search -----------------------------------------------------
// Owner and friends; none of these is on the guest allowlist, so the guest
// link gets a 403 before a handler runs. Recents are the caller's own.

router.get('/search', h(async (req, res) => res.json(await search(req.query.q))));
router.get('/search/recents', (req, res) => res.json(listRecents()));
router.post('/search/recents', (req, res) => res.json(addRecent(req.body)));
router.delete('/search/recents', (req, res) => res.json(removeRecent(req.query.kind, req.query.key)));
router.post('/search/recents/clear', (req, res) => res.json(clearRecents()));
router.post('/search/recents/restore', (req, res) => res.json(restoreRecents(req.body)));

// ---- add to calendar -------------------------------------------------------

// One showtime as an .ics file (lib/calendar.js). Only showtimes at a theater
// the caller follows; anything else is the same 404 as a made-up id. The guest
// link may ask too (read only, about the owner's theaters it already sees).
router.get('/showtimes/:id/calendar.ics', (req, res) => {
  const s = get('SELECT * FROM showtimes WHERE id = ?', String(req.params.id));
  const theatre = s && followedTheatres().find((t) => String(t.id) === String(s.theatre_id));
  if (!s || !theatre || !s.tmdb_id) return res.status(404).json({ error: 'Showtime not found' });
  const movie = getMovie(s.tmdb_id);
  const ics = showtimeIcs({
    showtime: s, movie, theatreName: theatre.name, record: theatreRecord(s.theatre_id), previewsMinutes: getSetting('previewsMinutes'),
  });
  if (!ics) return res.status(404).json({ error: 'Showtime not found' });
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="${icsFilename(movie?.title, s)}"`,
    'Cache-Control': 'no-store',
  });
  res.send(ics);
});

// ---- where to stream ------------------------------------------------------

// US streaming, rent and buy options for up to 20 films (TMDB watch providers,
// data from JustWatch). Each film is cached 3 days and a live call waits its
// turn on the shared TMDB throttle. With skipPlaying, a film playing at the
// caller's theaters answers { playing: true } without asking TMDB: search and
// "More from" only show the line for films that aren't in theaters. Not on
// the guest allowlist.
router.get('/providers', h(async (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
  if (!ids.length) return res.status(400).json({ error: 'ids required.' });
  const playing = req.query.skipPlaying ? playingIds() : new Set();
  const providers = {};
  for (const id of ids) {
    if (playing.has(id)) { providers[id] = { playing: true }; continue; }
    try {
      providers[id] = await tmdb.watchProviders(id, { gate: tmdbThrottle });
    } catch (e) {
      if (e.status !== 404) console.error('[providers]', id, e.message);
      providers[id] = null;
    }
  }
  res.json({ providers });
}));

// ---- onboarding --------------------------------------------------------

// ?known=1 (the welcome setup): the most-rated films of all time instead of
// this week's popular ones, which are mostly too new to have been seen.
router.get('/onboarding/movies', h(async (req, res) => {
  if (!tmdb.tmdbConfigured()) return res.status(400).json({ error: 'TMDB_API_KEY is not set.' });
  const pop = req.query.known
    ? [...(await tmdb.wellKnown(1, { gate: tmdbThrottle })), ...(await tmdb.wellKnown(2, { gate: tmdbThrottle }))]
    : [...(await tmdb.popular(1)), ...(await tmdb.popular(2))];
  const rated = ratedIds();
  const seen = new Set();
  const list = [];
  for (const r of pop) {
    const lm = tmdb.lightMovie(r);
    if (!lm.poster || rated.has(lm.tmdb_id) || seen.has(lm.tmdb_id)) continue;
    seen.add(lm.tmdb_id);
    list.push(lm);
  }
  res.json({ movies: list.slice(0, 24) });
}));

router.post('/onboarding/rate', (req, res) => {
  const items = req.body?.ratings || [];
  let count = 0;
  for (const it of items) {
    if (!it.tmdb_id || !(it.rating >= 0.5)) continue;
    upsertLightMovie({ tmdb_id: it.tmdb_id, title: it.title, year: it.year, poster: it.poster, genres: it.genres || [] });
    upsertRating({ tmdb_id: it.tmdb_id, title: it.title, year: it.year, rating: it.rating, source: 'onboarding' });
    ingestOne(it.tmdb_id).catch(() => {});
    count++;
  }
  setSetting('onboardingDone', true);
  res.json({ ok: true, count });
});

router.post('/onboarding/done', (req, res) => {
  setSetting('onboardingDone', true);
  res.json({ ok: true });
});

// ---- watchlist ---------------------------------------------------------

router.get('/watchlist', (req, res) => {
  const rows = all(
    'SELECT m.* FROM watchlist w JOIN movies m ON m.tmdb_id = w.tmdb_id WHERE w.user_id = ? ORDER BY w.added_at DESC',
    currentUserId(),
  ).map(hydrate);
  res.json({ movies: rows.map(card) });
});

router.post('/watchlist/toggle', (req, res) => {
  const { tmdb_id } = req.body || {};
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required.' });
  const uid = currentUserId();
  const exists = get('SELECT tmdb_id FROM watchlist WHERE user_id = ? AND tmdb_id = ?', uid, tmdb_id);
  if (exists) {
    run('DELETE FROM watchlist WHERE user_id = ? AND tmdb_id = ?', uid, tmdb_id);
    return res.json({ watchlisted: false });
  }
  run('INSERT INTO watchlist(user_id, tmdb_id, added_at) VALUES(?, ?, ?)', uid, tmdb_id, new Date().toISOString());
  res.json({ watchlisted: true });
});

// ---- not for me (hidden films) ------------------------------------------
// Owner only: none of these paths is on the guest allowlist, so the read-only
// guard in index.js turns a guest away before the handler runs.

router.get('/hidden', (req, res) => {
  res.json({ movies: all('SELECT tmdb_id, title, hidden_at FROM hidden_movies WHERE user_id = ? ORDER BY hidden_at DESC', currentUserId()) });
});

router.post('/hidden', (req, res) => {
  const { tmdb_id, title } = req.body || {};
  const id = Number(tmdb_id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'tmdb_id required.' });
  const name = String(title || get('SELECT title FROM movies WHERE tmdb_id = ?', id)?.title || '').slice(0, 300);
  run(
    `INSERT INTO hidden_movies(user_id, tmdb_id, title, hidden_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id, tmdb_id) DO UPDATE SET title = excluded.title`,
    currentUserId(), id, name, new Date().toISOString(),
  );
  res.json({ hidden: true, tmdb_id: id });
});

router.delete('/hidden/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  run('DELETE FROM hidden_movies WHERE user_id = ? AND tmdb_id = ?', currentUserId(), id);
  res.json({ hidden: false, tmdb_id: id });
});

// ---- A-List / watched --------------------------------------------------

router.get('/alist', (req, res) => res.json(getWeek()));

router.post('/watched', (req, res) => {
  const tmdb_id = Number(req.body?.tmdb_id);
  const title = req.body?.title;
  if (!Number.isInteger(tmdb_id) || tmdb_id <= 0) return res.status(400).json({ error: 'tmdb_id required.' });
  let inWeekly4 = req.body?.in_weekly4;
  if (inWeekly4 == null) {
    // Membership means "was in the weekly 4 at any point this A-List week",
    // read from weekly4_log. It must NOT be recomputed here: by the time a
    // movie is marked seen the live four has usually moved on — above all
    // because rating it sets flags.seen, which drops it out of the very four
    // a recompute would consult, so the movies most likely to be marked seen
    // are exactly the ones a recompute denies.
    inWeekly4 = wasWeekly4Pick(tmdb_id);
    if (!inWeekly4) {
      // Nothing recorded for this movie yet — generate this week's four (which
      // records them) in case the Picks page simply hasn't been opened, then
      // look again. Still a log read, never the instantaneous ranking.
      try { getRecommendations(); } catch { /* the first lookup already answered */ }
      inWeekly4 = wasWeekly4Pick(tmdb_id);
    }
  }
  res.json(logWatched({ tmdb_id, title, in_weekly4: inWeekly4 }));
});

router.delete('/watched/:id', (req, res) => res.json(undoWatched(Number(req.params.id))));

// ---- watch together ------------------------------------------------------

// The owner and one opted-in friend, never two friends (lib/together.js).
// Not on the guest allowlist. Every id that isn't the caller's valid partner
// gets the identical 404, so a friend can't tell another friend's id from a
// made-up one.
router.get('/together', (req, res) => res.json(togetherOverview(currentUser())));

router.get('/together/:id', (req, res) => {
  const me = currentUser();
  const partner = partnerFor(me, req.params.id);
  if (!partner) return res.status(NOT_FOUND.status).json(NOT_FOUND.body);
  res.json(filmsFor(me, partner));
});

// ---- stats / export ----------------------------------------------------

router.get('/stats', (req, res) => res.json(getStats()));

// The films behind one Stats row (genre / director / actor), the caller's own.
// Not on the guest allowlist, like /stats.
router.get('/stats/group', (req, res) => {
  const kind = String(req.query.kind || '');
  const name = String(req.query.name || '');
  if (!STATS_GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be genre, director or actor.' });
  if (!name || name.length > 300) return res.status(400).json({ error: 'name is required.' });
  res.json(getStatsGroup(kind, name));
});

// The sheet's second section: "More from <person>" (TMDB filmography, cached
// 7 days for everyone) or "<Genre> playing now". Not on the guest allowlist.
router.get('/stats/more', h(async (req, res) => {
  const kind = String(req.query.kind || '');
  const name = String(req.query.name || '');
  if (!STATS_GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be genre, director or actor.' });
  if (!name || name.length > 300) return res.status(400).json({ error: 'name is required.' });
  if (kind !== 'genre' && !tmdb.tmdbConfigured()) return res.status(503).json({ error: "TMDB isn't set up, so there's no filmography to show." });
  try {
    res.json(await getStatsMore(kind, name));
  } catch (e) {
    console.error('[stats/more]', kind, name, e.message);
    res.status(502).json({
      error: kind === 'genre' ? "Couldn't load what's playing right now. Try again later." : "Couldn't load more films from TMDB right now. Try again later.",
    });
  }
}));

router.get('/export', (req, res) => {
  const uid = currentUserId();
  const ratings = all('SELECT tmdb_id, title, year, rating, source, rated_at FROM ratings WHERE user_id = ?', uid);
  const watched = all('SELECT tmdb_id, title, watched_at, in_weekly4, ticket_price, source FROM watched WHERE user_id = ? ORDER BY id', uid);
  const lines = ['Type,tmdb_id,Title,Year,Rating,Source,RatedAt,WatchedAt,InWeekly4,Price'];
  for (const r of ratings) {
    lines.push(['rating', r.tmdb_id, csvField(r.title), r.year ?? '', r.rating, r.source, r.rated_at ?? '', '', '', ''].join(','));
  }
  for (const w of watched) {
    lines.push(['watched', w.tmdb_id, csvField(w.title), '', '', w.source ?? '', '', w.watched_at, w.in_weekly4 ? '1' : '0', w.ticket_price ?? ''].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reel-picks-backup.csv"');
  res.send(lines.join('\n'));
});

// ---- AMC->TMDB matches: unmatched list, fix, ignore --------------------

// AMC titles currently showing that have no TMDB record, with where/when they
// play, so they can be matched by hand (or ignored, e.g. "Screen Unseen").
router.get('/matches/unmatched', ownerOnly, (req, res) => {
  const short = new Map(followedTheatres(getSettings()).map((t) => [t.id, t.short]));
  const decorate = (r) => ({ ...r, theatres: r.theatre_ids.map((id) => ({ id, short: short.get(id) || id })) });
  const data = unmatchedTitles(localYMD());
  res.json({
    unmatched: data.unmatched.map(decorate),
    ignored: data.ignored.map(decorate),
    review: reviewTitles(localYMD()).map(decorate),
  });
});

// Owner looked at a flagged automatic match and it's right: keep it.
router.post('/match/keep', ownerOnly, (req, res) => {
  const { amc_movie_id } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  keepMatch(String(amc_movie_id));
  res.json({ ok: true });
});

router.post('/match/ignore', ownerOnly, (req, res) => {
  const { amc_movie_id, amc_title } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  ignoreMatch(String(amc_movie_id), amc_title || '');
  res.json({ ok: true });
});

// Forget an ignore: the next refresh retries the match automatically.
router.delete('/match/ignore/:id', ownerOnly, (req, res) => {
  unignoreMatch(String(req.params.id));
  res.json({ ok: true });
});

router.post('/match/set', ownerOnly, h(async (req, res) => {
  const { amc_movie_id, amc_title, tmdb_id } = req.body || {};
  if (!amc_movie_id || !tmdb_id) return res.status(400).json({ error: 'amc_movie_id and tmdb_id required.' });
  await ingestOne(tmdb_id); // make sure the movie exists with full details
  setManualMatch(amc_movie_id, amc_title || '', tmdb_id);
  const today = localYMD();
  const weekEnd = localYMD(addDays(new Date(), 6));
  run(
    `UPDATE movies SET playing = 1, playing_source = 'amc'
      WHERE tmdb_id = ? AND EXISTS(SELECT 1 FROM showtimes WHERE tmdb_id = ? AND date >= ? AND date <= ?)`,
    tmdb_id, tmdb_id, today, weekEnd,
  );
  res.json({ ok: true });
}));

// ---- friends (owner only) -------------------------------------------------
// Invite links are shown once, at creation or re-issue; only a hash is kept.

router.get('/friends', ownerOnly, (req, res) => res.json({ friends: listFriends(), max: MAX_USERS }));

router.post('/friends', ownerOnly, (req, res) => {
  try {
    const { friend, token } = createFriend(req.body?.name);
    res.json({ friend, invite: `/?invite=${token}` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/friends/:id/revoke', ownerOnly, (req, res) => {
  try {
    res.json({ friend: revokeFriend(req.params.id) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/friends/:id/reissue', ownerOnly, (req, res) => {
  try {
    const { friend, token } = reissueFriend(req.params.id);
    res.json({ friend, invite: `/?invite=${token}` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- weekly picks notifications (lib/push.js) ----------------------------
// Per person, per device. The guest link never gets here (lib/guest.js); the
// guard below is the same rule again. With no VAPID keys the feature is off:
// config says so and the rest answer 404.

const pushOn = (req, res, next) => {
  if (currentUser()?.guest) return res.status(403).json({ error: 'This shared link is read only.' });
  if (!pushEnabled()) return res.status(404).json({ error: 'Notifications aren\'t set up on this server.' });
  next();
};

// ---- owner alerts (lib/alerts.js) ------------------------------------------
// The last 10 alerts and what's failing now, for the owner's Settings card.
// Friends get a 403; the guest link never reaches it (lib/guest.js).
router.get('/alerts', ownerOnly, (req, res) => {
  res.json({
    alerts: recentAlerts(10),
    failing: failingNow(),
    pushEnabled: pushEnabled(),
    devices: get('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', currentUserId()).n,
  });
});

router.get('/push/config', (req, res) => {
  if (currentUser()?.guest) return res.status(403).json({ error: 'This shared link is read only.' });
  res.json(pushEnabled() ? { enabled: true, publicKey: publicKey() } : { enabled: false });
});

// Is this device (its subscription endpoint) signed up for this person?
router.post('/push/check', pushOn, (req, res) => {
  res.json({ subscribed: hasSubscription(currentUserId(), req.body?.endpoint) });
});

router.post('/push/subscribe', pushOn, (req, res) => {
  try {
    saveSubscription(currentUserId(), req.body?.subscription);
    res.json({ subscribed: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/push/unsubscribe', pushOn, (req, res) => {
  removeSubscription(currentUserId(), req.body?.endpoint);
  res.json({ subscribed: false });
});

// The Friday send by hand (it runs on its own after Friday's refresh). Still
// once per person per week: anyone who already got this week's is skipped.
router.post('/push/weekly/send', ownerOnly, pushOn, h(async (req, res) => {
  if (refreshState.running) return res.status(409).json({ error: 'A refresh is running. Try again when it finishes.' });
  res.json(await sendWeekly());
}));

export default router;
