// All JSON API routes for Reel Picks.
import { Router } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { get, all, run, getSettings, updateSettings, getSetting, setSetting, dataDir, dbPath } from './db.js';
import { exportState, importState } from './lib/state.js';
import { keyStatus } from './env.js';
import {
  refreshAll, shouldAutoRefresh, state as refreshState, ingestOne, drainUnmatched, enrichMissingDetails,
} from './lib/refresh.js';
import {
  getRecommendations, getComingSoon, getMovieDetail, getProfileSummary,
} from './lib/recommend.js';
import {
  upsertRating, addUnmatched, deleteRating, listRatings, ratedIds,
  ratingsCount, unmatchedCount,
} from './lib/ratings.js';
import { getMovie, upsertLightMovie, hydrate } from './lib/movies.js';
import { setManualMatch, ignoreMatch, unignoreMatch, unmatchedTitles, reviewTitles, keepMatch } from './lib/match.js';
import { logWatched, undoWatched, getWeek, restoreWatched } from './lib/alist.js';
import { getStats } from './lib/stats.js';
import { normalizeRatingsCsv, parseCsv, detectFormat, parseBackupCsv } from './lib/csv.js';
import * as tmdb from './lib/tmdb.js';
import * as amc from './lib/amc.js';
import {
  followedTheatres, homeBase, readDistance, addFollowed, removeFollowed, promoteToPrimary,
  replacePrimary, refreshDistances, MAX_THEATRES,
} from './lib/theatres.js';
import { geocode, reverseGeocode } from './lib/geocode.js';
import { bustCache } from './lib/cache.js';
import { localYMD, addDays, csvField } from './lib/util.js';
import { isGuest, ownerName } from './lib/guest.js';

const router = Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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
    theatre: { ...theatres[0] },
    theatres,
    maxTheatres: MAX_THEATRES,
    home: homeBase(s),
    onboardingDone: Boolean(s.onboardingDone),
    everythingPlayingCollapsed: Boolean(s.everythingPlayingCollapsed),
    lastRefresh: s.lastRefresh,
    refreshing: refreshState.running,
    matching: Boolean(refreshState.draining),
    // Result of the most recent background matching run (import summary panel).
    lastDrain: refreshState.lastDrain || null,
    enriching: Boolean(refreshState.enriching),
    counts: {
      playing: get('SELECT COUNT(*) AS n FROM movies WHERE playing = 1').n,
      upcoming: get('SELECT COUNT(*) AS n FROM movies WHERE upcoming = 1').n,
      showtimes: get('SELECT COUNT(*) AS n FROM showtimes').n,
      ratings: ratingsCount(),
      unmatched: unmatchedCount(),
      watchlist: get('SELECT COUNT(*) AS n FROM watchlist').n,
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
router.post('/refresh', (req, res) => {
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
        return log.errors.length
          ? res.status(502).json({ error: `Couldn't load this movie from TMDB — ${log.errors[0]}` })
          : res.status(404).json({ error: tmdb.tmdbConfigured() ? 'Movie not found' : 'Movie not found locally and TMDB_API_KEY is not set.' });
      }
    }
  }
  const detail = getMovieDetail(id, { guest });
  if (!detail) return res.status(404).json({ error: 'Movie not found' });
  res.json(detail);
}));

// ---- settings / theatre ------------------------------------------------

router.get('/settings', (req, res) => res.json(getSettings()));

router.put('/settings', (req, res) => {
  const patch = { ...(req.body || {}) };
  if (patch.weightPublic != null || patch.weightTaste != null) {
    const wp = Number(patch.weightPublic ?? getSetting('weightPublic')) || 0;
    const wt = Number(patch.weightTaste ?? getSetting('weightTaste')) || 0;
    const sum = wp + wt || 1;
    patch.weightPublic = wp / sum;
    patch.weightTaste = wt / sum;
  }
  // Urgency: a non-negative point value and a multiplier of at least 1, so what
  // is stored is what ranking uses and what the Settings page shows.
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
  // Home moved → every cached drive time measures from the wrong origin. Drop
  // them all and re-measure in the background (one OSRM call per theatre), so
  // the times heal in seconds instead of at the next daily refresh.
  const after = homeBase(next);
  if ('home' in patch && (before.lat !== after.lat || before.lng !== after.lng)) {
    refreshDistances(next).catch((e) => console.error('[home] drive-time refresh', e.message));
  }
  res.json(next);
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
    res.status(502).json({ error: 'Couldn\'t reach the geocoder (nominatim.openstreetmap.org) — check the connection and try again.' });
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
    res.status(502).json({ error: 'Couldn\'t reach the geocoder — keep the coordinates and type a label instead.' });
  }
}));

// Clear home base: wipe the stored location and every cache row derived from
// it (drive times for any origin, geocoder lookups), then fall back to the
// app default and re-measure drive times from there in the background.
router.delete('/home', h(async (req, res) => {
  const next = updateSettings({ home: { label: null, lat: null, lng: null } });
  bustCache('nominatim:');
  refreshDistances(next).catch((e) => console.error('[home] drive-time refresh', e.message));
  res.json({ cleared: true, home: homeBase(next) });
}));

router.get('/theatres', h(async (req, res) => {
  if (!amc.amcConfigured()) return res.status(400).json({ error: 'AMC_API_KEY is not set — add it to .env to search theatres.' });
  res.json({ theatres: await amc.searchTheatres(req.query.query || '') });
}));

// Make a theatre the primary. The old primary stays followed (demoted), so no
// schedule or history is lost; rejected if that would exceed the cap.
router.post('/theatre', (req, res) => {
  const { id, name, slug } = req.body || {};
  try {
    const settings = replacePrimary({ id, name, slug });
    refreshAll({ force: true }).catch((e) => console.error('[theatre refresh]', e.message));
    res.json(settings);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- followed theatres ---------------------------------------------------

router.post('/theatres/follow', (req, res) => {
  const { id, name, slug } = req.body || {};
  try {
    const settings = addFollowed({ id, name, slug });
    refreshAll({ force: true }).catch((e) => console.error('[follow refresh]', e.message));
    res.json(settings);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/theatres/follow/:id', (req, res) => {
  res.json(removeFollowed(req.params.id));
});

// Promote a followed theatre to primary; the old primary stays followed.
router.post('/theatres/primary', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Theatre id is required.' });
  try {
    const settings = promoteToPrimary(id);
    // Showtimes for both are already loaded; re-run so the per-theatre horizon
    // log and the primary-driven snapshot history line up with the new roles.
    refreshAll({ force: true }).catch((e) => console.error('[primary refresh]', e.message));
    res.json(settings);
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

// Apply a full-setup document, then rebuild everything derived: a forced
// refresh pulls this instance's own showtimes/scores for the imported
// theatres, and detail enrichment fills in posters for imported ratings.
router.post('/state', (req, res) => {
  let doc = req.body;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { doc = null; } }
  try {
    const counts = importState(doc);
    refreshAll({ force: true }).catch((e) => console.error('[state refresh]', e.message));
    enrichMissingDetails().catch((e) => console.error('[enrich]', e.message));
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
  ingestOne(tmdb_id).catch(() => {}); // deepen taste profile in the background
  res.json({ ok: true });
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
    return res.status(400).json({ error: 'This looks like Letterboxd\'s watched.csv or watchlist.csv — those files never contain star ratings. Upload ratings.csv from the same export ZIP instead.' });
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
    enrichMissingDetails().catch((e) => console.error('[enrich]', e.message));
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
          ? `This is a valid Letterboxd export, but none of its ${parsed.skipped} film row(s) carry a star rating — on Letterboxd, marking a film watched is not the same as rating it, and only star ratings export. Rate some films there and re-export, or rate here in the app instead.`
          : 'This is a valid Letterboxd export, but it contains no film rows at all — the account looks like it has no star ratings yet. Rate some films there and re-export, or rate here in the app instead.')
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
      ? 'no star rating on those rows — on Letterboxd, watched \u2260 rated'
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

router.get('/ratings/search', h(async (req, res) => {
  if (!tmdb.tmdbConfigured()) return res.status(400).json({ error: 'TMDB_API_KEY is not set.' });
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = await tmdb.liveSearch(q);
  const mine = new Map(all('SELECT tmdb_id, rating FROM ratings').map((r) => [r.tmdb_id, r.rating]));
  res.json({ results: results.map((r) => ({ ...r, myRating: mine.get(r.tmdb_id) ?? null })) });
}));

// ---- onboarding --------------------------------------------------------

router.get('/onboarding/movies', h(async (req, res) => {
  if (!tmdb.tmdbConfigured()) return res.status(400).json({ error: 'TMDB_API_KEY is not set.' });
  const pop = [...(await tmdb.popular(1)), ...(await tmdb.popular(2))];
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
    'SELECT m.* FROM watchlist w JOIN movies m ON m.tmdb_id = w.tmdb_id ORDER BY w.added_at DESC',
  ).map(hydrate);
  res.json({ movies: rows.map(card) });
});

router.post('/watchlist/toggle', (req, res) => {
  const { tmdb_id } = req.body || {};
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required.' });
  const exists = get('SELECT tmdb_id FROM watchlist WHERE tmdb_id = ?', tmdb_id);
  if (exists) {
    run('DELETE FROM watchlist WHERE tmdb_id = ?', tmdb_id);
    return res.json({ watchlisted: false });
  }
  run('INSERT INTO watchlist(tmdb_id, added_at) VALUES(?, ?)', tmdb_id, new Date().toISOString());
  res.json({ watchlisted: true });
});

// ---- A-List / watched --------------------------------------------------

router.get('/alist', (req, res) => res.json(getWeek()));

router.post('/watched', (req, res) => {
  const { tmdb_id, title } = req.body || {};
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required.' });
  let inWeekly4 = req.body?.in_weekly4;
  if (inWeekly4 == null) {
    try {
      inWeekly4 = getRecommendations().weekly4.some((e) => e.tmdb_id === tmdb_id);
    } catch {
      inWeekly4 = false;
    }
  }
  res.json(logWatched({ tmdb_id, title, in_weekly4: inWeekly4 }));
});

router.delete('/watched/:id', (req, res) => res.json(undoWatched(Number(req.params.id))));

// ---- stats / export ----------------------------------------------------

router.get('/stats', (req, res) => res.json(getStats()));

router.get('/export', (req, res) => {
  const ratings = all('SELECT tmdb_id, title, year, rating, source, rated_at FROM ratings');
  const watched = all('SELECT tmdb_id, title, watched_at, in_weekly4, ticket_price FROM watched');
  const lines = ['Type,tmdb_id,Title,Year,Rating,Source,RatedAt,WatchedAt,InWeekly4,Price'];
  for (const r of ratings) {
    lines.push(['rating', r.tmdb_id, csvField(r.title), r.year ?? '', r.rating, r.source, r.rated_at ?? '', '', '', ''].join(','));
  }
  for (const w of watched) {
    lines.push(['watched', w.tmdb_id, csvField(w.title), '', '', '', '', w.watched_at, w.in_weekly4 ? '1' : '0', w.ticket_price ?? ''].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reel-picks-backup.csv"');
  res.send(lines.join('\n'));
});

// ---- AMC->TMDB matches: unmatched list, fix, ignore --------------------

// AMC titles currently showing that have no TMDB record, with where/when they
// play, so they can be matched by hand (or ignored, e.g. "Screen Unseen").
router.get('/matches/unmatched', (req, res) => {
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
router.post('/match/keep', (req, res) => {
  const { amc_movie_id } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  keepMatch(String(amc_movie_id));
  res.json({ ok: true });
});

router.post('/match/ignore', (req, res) => {
  const { amc_movie_id, amc_title } = req.body || {};
  if (!amc_movie_id) return res.status(400).json({ error: 'amc_movie_id required.' });
  ignoreMatch(String(amc_movie_id), amc_title || '');
  res.json({ ok: true });
});

// Forget an ignore: the next refresh retries the match automatically.
router.delete('/match/ignore/:id', (req, res) => {
  unignoreMatch(String(req.params.id));
  res.json({ ok: true });
});

router.post('/match/set', h(async (req, res) => {
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

export default router;
