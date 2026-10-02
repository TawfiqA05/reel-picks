// The API: ratings and CSV imports, notes on ratings, and the Letterboxd sync.
import { Router } from 'express';
import { all } from '../db.js';
import { state as refreshState, ingestOne, drainUnmatched } from '../lib/refresh.js';
import { upsertRating, addUnmatched, deleteRating, listRatings, ratingsCount, unmatchedCount } from '../lib/ratings.js';
import { getMovie, upsertLightMovie } from '../lib/movies.js';
import { restoreWatched } from '../lib/alist.js';
import { normalizeRatingsCsv, parseCsv, detectFormat, parseBackupCsv, normalizeReviewsCsv } from '../lib/csv.js';
import * as tmdb from '../lib/tmdb.js';
import { currentUserId } from '../lib/user.js';
import { startCreditsBackfill, tmdbThrottle } from '../lib/backfill.js';
import { syncStatus as letterboxdStatus, setUsername as setLetterboxdUser, syncUser as syncLetterboxd } from '../lib/letterboxd.js';
import { setNote, deleteNote, queueReview, NOTE_MAX as RATING_NOTE_MAX } from '../lib/notes.js';
import { h, limited } from './common.js';

const router = Router();

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
export const intId = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d{1,10}$/.test(v)) ? Number(v) : NaN);
export function ratingInput(b = {}) {
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

export default router;
