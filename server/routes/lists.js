// The API: header search, add to calendar, where to stream, onboarding, the
// watchlist, Not for me, the A-List tracker, At home and What should I watch?
import { Router } from 'express';
import { get, all, run, getSetting, setSetting, DEFAULT_SETTINGS } from '../db.js';
import { ingestOne } from '../lib/refresh.js';
import { getRecommendations, wasWeekly4Pick } from '../lib/recommend.js';
import { upsertRating, ratedIds } from '../lib/ratings.js';
import { getMovie, hydrate } from '../lib/movies.js';
import { logWatched, undoWatched, getWeek } from '../lib/alist.js';
import * as tmdb from '../lib/tmdb.js';
import { followedTheatres } from '../lib/theatres.js';
import { showtimeIcs, icsFilename, theatreRecord } from '../lib/calendar.js';
import { currentUserId, currentUser } from '../lib/user.js';
import { tmdbThrottle } from '../lib/backfill.js';
import { homePicks } from '../lib/home.js';
import { suggest, suggestState } from '../lib/suggest.js';
import { search, playingIds, listRecents, addRecent, removeRecent, clearRecents, restoreRecents } from '../lib/search.js';
import { filmDone } from '../lib/done.js';
import { notesOf } from '../lib/notes.js';
import { intId, ratingInput } from './ratings.js';
import { h, spendLimit, limited, card } from './common.js';

const router = Router();

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
// link may ask too (read only, about the owner's theaters it already sees),
// and gets the default minutes of previews, not the owner's.
router.get('/showtimes/:id/calendar.ics', (req, res) => {
  const s = get('SELECT * FROM showtimes WHERE id = ?', String(req.params.id));
  const theatre = s && followedTheatres().find((t) => String(t.id) === String(s.theatre_id));
  if (!s || !theatre || !s.tmdb_id) return res.status(404).json({ error: 'Showtime not found' });
  const movie = getMovie(s.tmdb_id);
  const ics = showtimeIcs({
    showtime: s, movie, theatreName: theatre.name, record: theatreRecord(s.theatre_id),
    previewsMinutes: currentUser()?.guest ? DEFAULT_SETTINGS.previewsMinutes : getSetting('previewsMinutes'),
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
      if (e.upstreamStatus !== 404) console.error('[providers]', id, e.message);
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

export default router;
