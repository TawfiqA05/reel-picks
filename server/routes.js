// All JSON API routes for Reel Picks.
import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { get, all, run, getSettings, updateSettings, getSetting, setSetting, dataDir, dbPath, USER_SETTING_KEYS, DEFAULT_SETTINGS } from './db.js';
import { exportState, importState } from './lib/state.js';
import { keyStatus, onRailway } from './env.js';
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
import { normalizeRatingsCsv, parseCsv, detectFormat, parseBackupCsv, normalizeReviewsCsv } from './lib/csv.js';
import * as tmdb from './lib/tmdb.js';
import * as amc from './lib/amc.js';
import {
  followedTheatres, homeBase, readDistance, addFollowed, removeFollowed, promoteToPrimary,
  replacePrimary, refreshDistances, MAX_THEATRES, sharedTheatreIds,
} from './lib/theatres.js';
import { geocode, reverseGeocode, forgetLookupsFor } from './lib/geocode.js';
import { showtimeIcs, icsFilename, theatreRecord } from './lib/calendar.js';
import { localYMD, addDays, csvField } from './lib/util.js';
import { isGuest, ownerName } from './lib/guest.js';
import { currentUserId, currentUser } from './lib/user.js';
import { appVersion } from './lib/version.js';
import { startCreditsBackfill, backfillStatus, backfillState, tmdbThrottle } from './lib/backfill.js';
import { backupStatus, latestBackup, backupsDir } from './lib/backup.js';
import { overview as togetherOverview, partnerFor, filmsFor, NOT_FOUND } from './lib/together.js';
import { settingsProblems } from '../public/js/settingsRules.js';
import { planProblems } from '../public/js/plans.js';
import { servicesProblems, cleanServices } from '../public/js/services.js';
import { homePicks } from './lib/home.js';
import { suggest, suggestState } from './lib/suggest.js';
import { search, playingIds, listRecents, addRecent, removeRecent, clearRecents, restoreRecents } from './lib/search.js';
import { listFriends, createFriend, revokeFriend, reissueFriend, MAX_USERS, userName } from './lib/accounts.js';
import {
  pushEnabled, publicKey, saveSubscription, removeSubscription, hasSubscription, sendWeekly,
} from './lib/push.js';
import { recentAlerts, failingNow } from './lib/alerts.js';
import { offsiteStatus, offsiteEnabled, uploadNow as offsiteUpload } from './lib/offsite.js';
import { syncStatus as letterboxdStatus, setUsername as setLetterboxdUser, syncUser as syncLetterboxd } from './lib/letterboxd.js';
import { take as takeLimit, LIMIT_MESSAGE } from './lib/limits.js';
import { getPerson, personCached } from './lib/personPage.js';
import { myPlans, othersPlans, planShowtime, cancelPlan, answerPlan } from './lib/plans.js';
import {
  recipients, sendPick, inbox, dismiss as dismissSend, sentToday, DAILY_LIMIT, NOTE_MAX, NOT_FOUND as SEND_NOT_FOUND,
} from './lib/sends.js';
import { filmDone } from './lib/done.js';
import { getNote, notesOf, setNote, deleteNote, queueReview, NOTE_MAX as RATING_NOTE_MAX } from './lib/notes.js';
import { yearWindow, recapFor, sharePosterUrl } from './lib/year.js';

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
// Per-person hourly limits on what spends the shared keys (lib/limits.js):
// friends by account, the guest link by address, the owner not at all.
// Answers 429 and returns true when `n` more would go over.
// Counts `n` against the caller's limit; false when that would go over.
function spendLimit(req, kind, n = 1) {
  const u = currentUser();
  if (!u || u.isOwner || n <= 0) return true;
  const who = u.guest
    ? `ip:${req.get('cf-connecting-ip') || String(req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket?.remoteAddress || '?'}`
    : `user:${u.userId}`;
  return takeLimit(kind, who, u.guest ? 'guest' : 'friend', Date.now(), n);
}
function limited(req, res, kind, n = 1) {
  if (spendLimit(req, kind, n)) return false;
  res.status(429).json({ error: LIMIT_MESSAGE });
  return true;
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

// ---- settings / theatre ------------------------------------------------

router.get('/settings', (req, res) => res.json(forCaller(getSettings())));

// Theaters change only through /theatre and /theatres/*, which keep the caps;
// the refresh bookkeeping is the server's own.
const NOT_VIA_SETTINGS = new Set(['theatreId', 'theatreName', 'theatreSlug', 'extraTheatres', 'lastRefresh', 'lastRefreshLog']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const shortStrings = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 40);
// Every other key is checked for its kind, not coerced: a value of the wrong
// shape (extraTheatres as {}) used to be stored and then broke every request
// that read it, the owner's included.
function shapeProblems(patch) {
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'boolean' && typeof v !== 'boolean' && v !== 0 && v !== 1) out.push({ key: k, message: 'Use true or false.' });
    if ((k === 'excludedGenres' || k === 'excludedMpaa') && !shortStrings(v, 50)) out.push({ key: k, message: 'Use a list of names.' });
    if (k === 'showtimeWindows') {
      const ok = v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([day, w]) => ['weekday', 'weekend'].includes(day)
        && w && typeof w === 'object' && typeof w.enabled === 'boolean' && TIME.test(w.after) && TIME.test(w.before));
      if (!ok) out.push({ key: k, message: 'Use weekday and weekend windows with times like 18:30.' });
    }
    if (k === 'home' && v && typeof v === 'object' && 'label' in v && (typeof v.label !== 'string' || v.label.length > 200)) out.push({ key: 'home.label', message: 'Use a place name of up to 200 characters.' });
  }
  return out;
}

router.put('/settings', (req, res) => {
  const patch = { ...(req.body || {}) };
  // Friends change only their own keys; the shared ones are the owner's.
  if (!isOwnerRequest()) for (const k of Object.keys(patch)) if (!USER_SETTING_KEYS.has(k)) delete patch[k];
  const theaterKey = Object.keys(patch).find((k) => NOT_VIA_SETTINGS.has(k));
  if (theaterKey) return res.status(400).json({ error: `${theaterKey}: theaters are changed in Settings, Theaters, not here.` });
  for (const k of Object.keys(patch)) if (!(k in DEFAULT_SETTINGS)) delete patch[k];
  // Numbers out of range (or not numbers) are refused, never coerced: the
  // Settings page checks the same rules (public/js/settingsRules.js) first.
  const problems = [...settingsProblems(patch), ...planProblems(patch), ...servicesProblems(patch), ...shapeProblems(patch)];
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
  for (const k of ['setupDone', 'tourDone', 'youNoteSeen']) if (k in patch) patch[k] = Boolean(patch[k]);
  if ('streamingServices' in patch) patch.streamingServices = cleanServices(patch.streamingServices);
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
// The owner's and each friend's own home base. None of these are on the guest
// allowlist (lib/guest.js is default-deny), so the shared link can neither
// geocode nor read home base.

// Free-form text ("Fishers IN", "46037", a street address) → up to 5
// candidates via Nominatim, cached for months and throttled to 1 req/s
// (lib/geocode.js). Failure reports plainly; it never clears anything.
router.get('/geocode', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Type a place to look up.' });
  if (limited(req, res, 'place')) return;
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
  if (limited(req, res, 'place')) return;
  try {
    res.json({ result: await reverseGeocode(req.query.lat, req.query.lng) });
  } catch (e) {
    console.error('[geocode]', e.message);
    res.status(502).json({ error: 'Couldn\'t reach the place lookup. Keep the coordinates and type a label instead.' });
  }
}));

// Clear home base: wipe the stored location and the cache rows derived from
// it (its drive times, and the geocoder lookups that found it; other people's
// lookups stay), then fall back to the app default and re-measure drive times
// from there in the background.
router.delete('/home', h(async (req, res) => {
  const before = homeBase(getSettings());
  const own = get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', currentUserId(), 'home');
  let ownHome = null;
  try { ownHome = own ? JSON.parse(own.value) : null; } catch { ownHome = null; }
  const next = updateSettings({ home: { label: null, lat: null, lng: null } });
  forgetLookupsFor(ownHome);
  refreshDistances(next, before).catch((e) => console.error('[home] drive-time refresh', e.message));
  res.json({ cleared: true, home: homeBase(next) });
}));

router.get('/theatres', h(async (req, res) => {
  if (!amc.amcConfigured()) return res.status(400).json({ error: 'AMC_API_KEY is not set. Add it to .env to search theaters.' });
  const q = req.query.query ?? '';
  if (typeof q !== 'string') return res.status(400).json({ error: 'Type a theater name, city or ZIP.' });
  res.json({ theatres: await amc.searchTheatres(q) });
}));

// Make a theatre the primary. The old primary stays followed (demoted), so no
// schedule or history is lost; rejected if that would exceed the cap.
// An AMC theater as the Settings search returns it: a numeric id and short text.
function theaterProblem({ id, name, slug } = {}) {
  if (!/^\d{1,10}$/.test(String(id ?? ''))) return 'That isn\'t an AMC theater id.';
  if ((name != null && (typeof name !== 'string' || name.length > 200)) || (slug != null && (typeof slug !== 'string' || slug.length > 200))) return 'That theater name is too long.';
  return null;
}

router.post('/theatre', (req, res) => {
  const { id, name, slug } = req.body || {};
  const bad = theaterProblem(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
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
  const bad = theaterProblem(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
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
  if (!id) return res.status(400).json({ error: 'Theater id is required.' });
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
      note: r.note || null, noteFull: r.note ? r.note_full || null : null,
    })),
  });
});

// What a client may say about a film it rates: a TMDB id, a half-star value,
// and short text. A poster is only ever TMDB's own image address, since it
// lands in the shared movies table everyone sees.
const TMDB_POSTER = /^https:\/\/image\.tmdb\.org\/t\/p\/\w+\/[\w.-]+$/;
// A whole number that arrived as a number or as digits, never as [5] or true.
const intId = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d{1,10}$/.test(v)) ? Number(v) : NaN);
function ratingInput(b = {}) {
  const tmdb_id = intId(b.tmdb_id);
  const rating = typeof b.rating === 'number' || typeof b.rating === 'string' ? Number(b.rating) : NaN;
  if (!Number.isInteger(tmdb_id) || tmdb_id <= 0 || !Number.isInteger(rating * 2) || rating < 0.5 || rating > 5) return null;
  if (b.title != null && (typeof b.title !== 'string' || b.title.length > 300)) return null;
  if (b.source != null && (typeof b.source !== 'string' || b.source.length > 40)) return null;
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  return {
    tmdb_id, rating,
    title: text(b.title, 300),
    year: b.year != null && Number.isInteger(Number(b.year)) && Number(b.year) > 1800 && Number(b.year) < 2200 ? Number(b.year) : null,
    poster: typeof b.poster === 'string' && TMDB_POSTER.test(b.poster) ? b.poster : null,
    genres: Array.isArray(b.genres) ? b.genres.filter((g) => typeof g === 'string').slice(0, 10).map((g) => g.slice(0, 40)) : [],
  };
}

router.post('/ratings', (req, res) => {
  const r = ratingInput(req.body || {});
  if (!r) return res.status(400).json({ error: 'tmdb_id and a rating between 0.5 and 5, in half stars, are required.' });
  const { tmdb_id, rating, title, year } = r;
  if (!getMovie(tmdb_id) && limited(req, res, 'newFilm')) return;
  const source = req.body.source || 'manual';
  // The film's own record comes from TMDB (ingestOne, below), never from what
  // a client says about it: the movies table is shared by everyone.
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

// ---- notes on ratings (lib/notes.js) ------------------------------------
// The caller's own note on a film they rated: plain text, one line, up to
// RATING_NOTE_MAX characters. Not on the guest allowlist. Friends' writes count
// against an hourly limit like their other writes; the owner has none.
const filmId = (raw) => (/^\d{1,10}$/.test(String(raw)) ? Number(raw) : NaN);

router.put('/ratings/:id/note', (req, res) => {
  const id = filmId(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Movie not found' });
  if (limited(req, res, 'note')) return;
  try {
    res.json({ note: setNote(currentUserId(), id, req.body?.note), max: RATING_NOTE_MAX });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the note.' });
  }
});

router.delete('/ratings/:id/note', (req, res) => {
  const id = filmId(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Movie not found' });
  if (limited(req, res, 'note')) return;
  deleteNote(currentUserId(), id);
  res.json({ ok: true });
});

router.post('/ratings/import', (req, res) => {
  const csv = req.body?.csv;
  if (typeof csv !== 'string') return res.status(400).json({ error: 'Missing CSV text.' });
  if (!csv.trim()) return res.status(400).json({ error: 'That file is empty.' });
  // The export ZIP itself, read as text, starts with the ZIP magic "PK\x03\x04" —
  // the single most common wrong upload. Name the fix, don't say "could not detect".
  if (csv.startsWith('PK\u0003\u0004')) {
    return res.status(400).json({ error: 'That looks like the export ZIP itself. Unzip it first, then upload the ratings.csv file from inside it.' });
  }
  const rows = parseCsv(csv);
  if (!rows.length) return res.status(400).json({ error: 'That file is empty.' });
  // A big Letterboxd history is a few thousand rows; far past that, the
  // inserts would hold up the server for everyone.
  if (rows.length > 20001) return res.status(400).json({ error: 'That file has more than 20,000 rows. Split it and import the parts one at a time.' });
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

  // Letterboxd's reviews.csv: each review becomes the note on its film (and
  // the rating on it counts only where there's no rating for the film yet).
  // Queued for matching like ratings.csv; a note written here is never
  // overwritten (lib/notes.js).
  if (format === 'letterboxd-reviews') {
    const parsed = normalizeReviewsCsv(csv);
    if (!parsed.rows.length) {
      return res.json({
        format: 'letterboxd', reviews: true, received: 0, skipped: parsed.skipped, emptyExport: true,
        note: 'This is Letterboxd\'s reviews.csv, but none of its rows has review text. Nothing to bring in.',
      });
    }
    const ratingsBefore = ratingsCount();
    const pendingBefore = unmatchedCount();
    for (const row of parsed.rows) queueReview({ userId: currentUserId(), ...row });
    drainUnmatched().catch((e) => console.error('[drain]', e.message));
    return res.json({
      format: 'letterboxd', reviews: true, received: parsed.rows.length, skipped: parsed.skipped,
      skippedSamples: parsed.skippedSamples, skippedWhy: 'no review text on those rows',
      ratingsBefore, pendingBefore, lastDrainAt: refreshState.lastDrain?.finishedAt || null, matching: tmdb.tmdbConfigured(),
    });
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
  const before = letterboxdStatus(uid).username;
  const name = setLetterboxdUser(uid, req.body?.username);
  // A new name syncs at once; saving the same name again waits out the same
  // short gap as Sync now, so re-saving can't fetch the feed over and over.
  res.json(name ? await syncLetterboxd(uid, { manual: name === before }) : letterboxdStatus(uid));
}));

router.post('/letterboxd/sync', h(async (req, res) => {
  const uid = currentUserId();
  if (!letterboxdStatus(uid).username) return res.status(400).json({ error: 'Add your Letterboxd username first.' });
  res.json(await syncLetterboxd(uid, { manual: true }));
}));

router.get('/ratings/search', h(async (req, res) => {
  if (!tmdb.tmdbConfigured()) return res.status(400).json({ error: 'TMDB_API_KEY is not set.' });
  const q = String((Array.isArray(req.query.q) ? req.query.q[0] : req.query.q) ?? '').trim();
  if (!q || typeof q !== 'string') return res.json({ results: [] });
  if (limited(req, res, 'search')) return;
  const results = await tmdb.liveSearch(q.slice(0, 200));
  const mine = new Map(all('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', currentUserId()).map((r) => [r.tmdb_id, r.rating]));
  res.json({ results: results.map((r) => ({ ...r, myRating: mine.get(r.tmdb_id) ?? null })) });
}));

// ---- header search -----------------------------------------------------
// Owner and friends; none of these is on the guest allowlist, so the guest
// link gets a 403 before a handler runs. Recents are the caller's own.

// Looking up people spends the caller's new-film allowance, one per live TMDB
// call; over it, the films still come back, just without people.
router.get('/search', h(async (req, res) => res.json(await search(req.query.q, { spend: () => spendLimit(req, 'newFilm') }))));
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
  const items = (Array.isArray(req.body?.ratings) ? req.body.ratings.slice(0, 50) : [])
    .map((raw) => (raw && typeof raw === 'object' ? ratingInput(raw) : null));
  const unstored = new Set(items.filter((it) => it && !getMovie(it.tmdb_id)).map((it) => it.tmdb_id));
  if (limited(req, res, 'newFilm', unstored.size)) return;
  let count = 0;
  for (const it of items) {
    if (!it) continue;
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
  // The caller's own note, where they rated a film they also saved, so the filter finds it.
  const notes = notesOf(currentUserId());
  res.json({ movies: rows.map((m) => ({ ...card(m), note: notes.get(m.tmdb_id)?.note ?? null })) });
});

router.post('/watchlist/toggle', h(async (req, res) => {
  const tmdb_id = intId(req.body?.tmdb_id);
  if (!Number.isInteger(tmdb_id) || tmdb_id <= 0) return res.status(400).json({ error: 'tmdb_id required.' });
  const uid = currentUserId();
  const exists = get('SELECT tmdb_id FROM watchlist WHERE user_id = ? AND tmdb_id = ?', uid, tmdb_id);
  if (exists) {
    run('DELETE FROM watchlist WHERE user_id = ? AND tmdb_id = ?', uid, tmdb_id);
    return res.json({ watchlisted: false });
  }
  // A film the app hasn't stored yet (from a Stats "More from" list, say) is
  // fetched first, so the Watchlist page, which lists stored films, shows it.
  if (!getMovie(tmdb_id)) {
    if (limited(req, res, 'newFilm')) return;
    await ingestOne(tmdb_id, { detailsOnly: true, gate: tmdbThrottle }).catch(() => {});
    ingestOne(tmdb_id).catch(() => {});
  }
  run('INSERT OR IGNORE INTO watchlist(user_id, tmdb_id, added_at) VALUES(?, ?, ?)', uid, tmdb_id, new Date().toISOString());
  filmDone(uid, tmdb_id, 'watchlisted'); // a pick sent for it has done its job (lib/done.js)
  res.json({ watchlisted: true });
}));

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
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 300) : null;
  if (!Number.isInteger(tmdb_id) || tmdb_id <= 0) return res.status(400).json({ error: 'tmdb_id required.' });
  // Only a real yes or no is taken from the client; anything else reads the log.
  let inWeekly4 = typeof req.body?.in_weekly4 === 'boolean' || req.body?.in_weekly4 === 0 || req.body?.in_weekly4 === 1 ? req.body.in_weekly4 : null;
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

// ---- I'm going and Send a pick (lib/plans.js, lib/sends.js) ---------------
// The caller's own plans, the plans of whoever Watch together pairs them with,
// picks sent to them, and who they can send to. Only GET /social is on the
// guest allowlist, and the guest gets it empty: no plans, no picks, nobody to
// send to. Everything else refuses the guest (the guard below is the same
// rule as the allowlist, again).

const notGuest = (req, res, next) => (currentUser()?.guest
  ? res.status(403).json({ error: 'This shared link is read only.' })
  : next());

router.get('/social', (req, res) => {
  const me = currentUser();
  res.set('Cache-Control', 'no-store');
  if (me.guest) return res.json({ plans: [], going: [], sent: [], send: { recipients: [], left: 0, limit: DAILY_LIMIT, noteMax: NOTE_MAX } });
  res.json({
    plans: myPlans(me.userId),
    going: othersPlans(me),
    sent: inbox(me),
    send: { recipients: recipients(me), left: Math.max(0, DAILY_LIMIT - sentToday(me.userId)), limit: DAILY_LIMIT, noteMax: NOTE_MAX },
  });
});

// Make or move the plan: { showtime_id }.
router.put('/plans', notGuest, (req, res) => {
  try {
    res.json(planShowtime(currentUserId(), req.body?.showtime_id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.delete('/plans/:id', notGuest, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  res.json(cancelPlan(currentUserId(), id));
});

// "Did you see it?": { seen: true | false }.
router.post('/plans/:id/answer', notGuest, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad id.' });
  if (typeof req.body?.seen !== 'boolean') return res.status(400).json({ error: 'seen must be true or false.' });
  try {
    res.json(answerPlan(id, req.body.seen));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

// { to, tmdb_id, note }. A recipient the caller can't send to is the same 404
// as a made-up id.
router.post('/sends', notGuest, (req, res) => {
  try {
    res.json(sendPick(currentUser(), req.body || {}));
  } catch (e) {
    if (e.status === SEND_NOT_FOUND.status && e.message === SEND_NOT_FOUND.body.error) return res.status(404).json(SEND_NOT_FOUND.body);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong on the server. Try again.' });
  }
});

router.delete('/sends/:id', notGuest, (req, res) => {
  if (!dismissSend(currentUserId(), req.params.id)) return res.status(404).json(SEND_NOT_FOUND.body);
  res.json({ dismissed: true });
});

// ---- stats / export ----------------------------------------------------

router.get('/stats', (req, res) => res.json(getStats()));

// ---- your year in movies (lib/year.js) -----------------------------------
// The caller's own recap, open Dec 1 to Jan 15; the owner's preview (?preview=1)
// any day. Not on the guest allowlist, like /stats. Read only.
router.get('/year', notGuest, (req, res) => {
  const preview = req.query.preview === '1';
  if (preview && !isOwnerRequest()) return res.status(403).json({ error: 'Only the owner can preview it.' });
  res.set('Cache-Control', 'no-store');
  const r = recapFor({ preview });
  if (!r) return res.status(404).json({ error: 'Your year in movies opens on December 1.' });
  res.json(r);
});

// A poster for the saved image, from this server so the page's canvas can
// read it back. Only films on the caller's own recap; kept in memory a day.
const posterBytes = new Map();
router.get('/year/poster/:id', notGuest, h(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d{1,10}$/.test(req.params.id) || !Number.isSafeInteger(id)) return res.status(404).json({ error: 'Not found' });
  const preview = req.query.preview === '1';
  if (preview && !isOwnerRequest()) return res.status(403).json({ error: 'Only the owner can preview it.' });
  const url = sharePosterUrl(id, { preview });
  if (!url) return res.status(404).json({ error: 'Not found' });
  let hit = posterBytes.get(url);
  if (!hit || Date.now() - hit.at > 864e5) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\/(jpeg|png|webp)/.test(type)) throw new Error(`poster ${r.status} ${type}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > 3 * 1024 * 1024) throw new Error('poster too large');
      hit = { at: Date.now(), type, body };
      if (posterBytes.size >= 64) posterBytes.delete(posterBytes.keys().next().value);
      posterBytes.set(url, hit);
    } catch (e) {
      console.error('[year poster]', id, e.message);
      return res.status(502).json({ error: "Couldn't load that poster." });
    }
  }
  res.set('Content-Type', hit.type);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(hit.body);
}));

// ---- people ----------------------------------------------------------------
// A person's page (lib/personPage.js). On the guest allowlist, read only: the
// guest gets no one's ratings or watchlist. A person not cached yet counts as
// one new-film lookup against the caller's hourly limit.
router.get('/person/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d{1,10}$/.test(req.params.id) || !Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'Person not found' });
  if (!tmdb.tmdbConfigured()) return res.status(503).json({ error: "TMDB isn't set up, so there's no one to show." });
  if (!personCached(id) && limited(req, res, 'newFilm')) return;
  try {
    const guest = isGuest(req);
    const d = await getPerson(id, { guest });
    // "You rated" shows the caller's own note under each film; never on the guest link.
    if (!guest) {
      const notes = notesOf(currentUserId());
      d.rated = d.rated.map((f) => ({ ...f, myNote: notes.get(f.tmdb_id)?.note ?? null }));
    }
    res.json(d);
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Person not found' });
    console.error('[person]', id, e.message);
    res.status(502).json({ error: "Couldn't reach TMDB to load this person. Try again in a moment." });
  }
}));

// The films behind one Stats row (genre / director / actor), the caller's own.
// Not on the guest allowlist, like /stats.
router.get('/stats/group', (req, res) => {
  const kind = String(req.query.kind || '');
  const name = String(req.query.name || '');
  if (!STATS_GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be genre, director or actor.' });
  if (!name || name.length > 300) return res.status(400).json({ error: 'name is required.' });
  // Each film carries the caller's own note, for the sheet's second line and its filter.
  const g = getStatsGroup(kind, name);
  const notes = notesOf(currentUserId());
  res.json({ ...g, films: g.films.map((f) => ({ ...f, note: notes.get(f.tmdb_id)?.note ?? null })) });
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

// ---- At home (lib/home.js) -----------------------------------------------------
// The caller's own 4 streaming picks this week. Not on the guest allowlist.
router.get('/home-picks', (req, res) => res.json(homePicks()));

// ---- What should I watch? (lib/suggest.js) ----------------------------------
// Three films for the caller's answers. A POST because it carries the ids
// already shown this session. Not on the guest allowlist.
router.post('/suggest', h(async (req, res) => {
  try {
    res.json(await suggest(req.body || {}));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
}));
// The caller's own saved / rated / hidden state for films the sheet showed
// them, when it opens again on kept results. Not on the guest allowlist.
router.post('/suggest/state', (req, res) => {
  try {
    res.json(suggestState(req.body || {}));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ---- off-site backup (lib/offsite.js) ---------------------------------------
// Owner only. With BACKUP_S3_* unset: { enabled: false }, and nothing to press.

router.get('/offsite', ownerOnly, (req, res) => res.json(offsiteStatus()));

router.post('/offsite/upload', ownerOnly, h(async (req, res) => {
  if (!offsiteEnabled()) return res.status(404).json({ error: 'Off-site backup isn\'t set up on this server.' });
  res.json(await offsiteUpload(dataDir));
}));

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
