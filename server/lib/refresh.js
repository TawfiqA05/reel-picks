// Refresh orchestration: pull showtimes (next ~14 days) from AMC for every
// followed theatre, dedupe to unique movies, match them to TMDB, ingest
// metadata + scores, seed Coming Soon, and keep new-release scores fresh. Falls
// back to TMDB "Now Playing" when AMC data isn't available so the app is still
// useful.
//
// Cost model: movie metadata and scores are global, so following another
// theatre only adds showtime calls — one per published day (14), plus a page
// when a busy day exceeds 100 showtimes. Each (theatre, day) response is cached
// for 24h; a user-initiated refresh re-pulls only today and tomorrow (see
// FRESH_DAYS), so a same-day refresh costs 2 calls per theatre. The per-theatre
// call count is written to the refresh log.
import { run, all, get, getSettings, setSetting, getSetting } from '../db.js';
import * as amc from './amc.js';
import * as tmdb from './tmdb.js';
import * as omdb from './omdb.js';
import {
  getMovie, upsertLightMovie, upsertFullMovie, setScores, setMpaaIfEmpty,
} from './movies.js';
import {
  findTmdbMatch, recordMatch, getMatch, unmatchedTitles, reviewTitles, setReview, setAmcYear, stripQualifiers,
} from './match.js';
import { upsertRating } from './ratings.js';
import { localYMD, addDays } from './util.js';
import { isSettling } from './scoring.js';
import { computeHorizon, snapshotLineup } from './leaving.js';
import { followedTheatres, homeBase, theatreDistance, readDistance, shortName } from './theatres.js';

export const state = { running: false, lastLog: null };

// A user-initiated refresh (`force`) re-pulls this many days from today even
// when they're cached, so a cancelled or added showing shows up the same day.
// The daily auto-refresh keeps using the 24h cache. Costs FRESH_DAYS calls per
// theatre per manual refresh.
const FRESH_DAYS = 2;

async function safe(promise, onErr) {
  try {
    return await promise;
  } catch (e) {
    onErr?.(e);
    return [];
  }
}

// --- TMDB-fallback filters (applied ONLY when there's no live AMC lineup) ----

// Keep films released within the recency window. Unknown dates pass here and
// are left for the junk filter to judge.
function withinRecency(releaseDate, cutoffMs) {
  if (!releaseDate) return true;
  const t = Date.parse(releaseDate);
  if (!Number.isFinite(t)) return true;
  return t >= cutoffMs;
}

// Detects TMDB placeholder / stub records (e.g. a studio-logo "DC" entry). Kept
// conservative so real releases are never dropped: rule 1 requires ALL of
// runtime/overview/genres to be missing; rule 2 needs a tiny title with no cast.
function looksLikeJunk(m) {
  if (!m) return ['missing record'];
  const reasons = [];
  const noRuntime = !m.runtime;
  const noOverview = !m.synopsis || m.synopsis.trim().length < 5;
  const noGenres = !(m.genres && m.genres.length);
  const noCast = !(m.cast && m.cast.length);
  const shortTitle = (m.title || '').trim().length <= 3;
  if (noRuntime && noOverview && noGenres) reasons.push('no runtime, overview, or genres');
  else if (shortTitle && noCast && (noOverview || noGenres)) reasons.push('very short title with no cast and sparse metadata');
  return reasons;
}

function deleteMovieIfUnreferenced(tmdbId) {
  const ref = get(
    `SELECT 1 AS x FROM ratings WHERE tmdb_id = ?
     UNION SELECT 1 FROM watchlist WHERE tmdb_id = ?
     UNION SELECT 1 FROM showtimes WHERE tmdb_id = ? LIMIT 1`,
    tmdbId, tmdbId, tmdbId,
  );
  if (!ref) run('DELETE FROM movies WHERE tmdb_id = ?', tmdbId);
}

function insertShowtime(s) {
  run(
    `INSERT INTO showtimes(id, amc_movie_id, tmdb_id, theatre_id, date, start_local, start_epoch,
                           is_imax, is_advance, format, runtime_min, attributes, purchase_url, fetched_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       theatre_id = excluded.theatre_id,
       date = excluded.date, start_local = excluded.start_local, start_epoch = excluded.start_epoch,
       is_imax = excluded.is_imax, is_advance = excluded.is_advance, format = excluded.format,
       runtime_min = excluded.runtime_min, attributes = excluded.attributes,
       purchase_url = excluded.purchase_url, fetched_at = excluded.fetched_at`,
    s.id, s.amc_movie_id, null, s.theatre_id, s.date, s.start_local, s.start_epoch,
    s.is_imax, s.is_advance, s.format, s.runtime_min, JSON.stringify(s.attributes || []),
    s.purchase_url, new Date().toISOString(),
  );
}

// Fetch TMDB details (once) and OMDb scores (daily / while settling) for a movie.
// Pass { detailsOnly: true } to skip OMDb (used when bulk-enriching restored
// ratings — we only need genres/director/cast for the taste profile).
// TMDB details are re-pulled (bypassing the 7-day cache) while a movie is
// settling, and weekly while its TMDB rating is still zero — otherwise a film
// first seen before anyone voted would show "No scores yet" forever.
const DETAILS_SETTLING_MS = 20 * 3600 * 1000;
const DETAILS_ZERO_VOTE_MS = 6 * 86400 * 1000;

async function ingestMovie(tmdbId, log, opts = {}) {
  let movie = getMovie(tmdbId);
  if (tmdb.tmdbConfigured()) {
    const age = movie?.details_at ? Date.now() - Date.parse(movie.details_at) : Infinity;
    const needDetails = !movie || !movie.details_at;
    const refetch = !needDetails && !opts.detailsOnly && (
      (isSettling(movie) && age > DETAILS_SETTLING_MS)
      || (!(movie.tmdb_rating > 0) && age > DETAILS_ZERO_VOTE_MS)
    );
    if (needDetails || refetch) {
      try {
        upsertFullMovie(tmdb.normalizeDetails(await tmdb.details(tmdbId, { force: refetch })));
      } catch (e) {
        log.errors.push(`TMDB details ${tmdbId}: ${e.message}`);
      }
      movie = getMovie(tmdbId);
    }
  }
  if (!opts.detailsOnly && movie && omdb.omdbConfigured()) {
    const settling = isSettling(movie);
    const ageMs = movie.scores_at ? Date.now() - Date.parse(movie.scores_at) : Infinity;
    const stale = !movie.scores_at || settling || ageMs > 12 * 3600 * 1000;
    if (stale) {
      try {
        // IMDb id first; if OMDb rejects it (stale/wrong id from TMDB) or we
        // have none, fall back to a title + year search before concluding
        // there is no record.
        let s = movie.imdb_id ? await omdb.byImdbId(movie.imdb_id) : null;
        const idRejected = movie.imdb_id && !s?.found ? s?.error : null;
        if (!s?.found) s = await omdb.byTitle(movie.title, movie.year);
        if (s.found) {
          setScores(tmdbId, { imdb: s.imdb, rt: s.rt, metacritic: s.metacritic, rated: s.rated });
          setMpaaIfEmpty(tmdbId, s.rated);
        } else {
          // Genuinely no record. Remember it on the movie (the UI says so and
          // the refresh won't hammer OMDb for it) and say it once, not daily.
          const first = !movie.scores?.noRecord;
          setScores(tmdbId, { imdb: null, rt: null, metacritic: null, rated: null, noRecord: true, checkedAt: new Date().toISOString() });
          if (first) {
            const how = movie.imdb_id ? `IMDb id ${movie.imdb_id} rejected ("${idRejected || 'not found'}"), title search "${s.error || 'empty'}"` : `title search "${s.error || 'empty'}"`;
            log.errors.push(`No OMDb record for "${movie.title}" (${how}) — public score uses TMDB only.`);
          }
        }
      } catch (e) {
        if (e.unavailable) {
          // Quota / auth: count it, report once at the end of the refresh.
          log.omdb = log.omdb || { reason: e.message, skipped: 0 };
          log.omdb.skipped += 1;
        } else {
          log.errors.push(`OMDb ${movie.title}: ${e.message}`);
        }
      }
    }
  }
}

// An automatic match to a film this many years older than AMC's release date
// is suspect (a new "Hot Spot" bound to the 1990 one) unless the AMC title
// itself says it's a re-release ("10th Anniversary", "Fan Event", …).
const REVIEW_YEAR_GAP = 2;

async function ensureMatch(amcId, info, log) {
  let m = getMatch(amcId);

  // AMC's release year. Showtime objects carry none, so fetch the movie
  // record once per title (cached 30 days); it's what makes year
  // disambiguation and the re-release check possible.
  let year = m?.amc_year ?? info.year ?? null;
  if (year == null) {
    try {
      year = (await amc.movieRecord(amcId))?.year ?? null;
    } catch (e) {
      log.errors.push(`AMC movie record for "${info.title}": ${e.message}`);
    }
    if (year != null && m) setAmcYear(amcId, year);
  }
  info.year = year;

  if (!m || (!m.manual && !m.tmdb_id)) {
    const found = await findTmdbMatch(info.title, year);
    if (found) {
      recordMatch(amcId, info.title, year, found.tmdb_id, found.confidence, false);
      upsertLightMovie(found.result);
    } else {
      recordMatch(amcId, info.title, year, null, 0, false);
      log.errors.push(`No TMDB match for "${info.title}"`);
    }
  }
  m = getMatch(amcId);
  if (m && m.tmdb_id) {
    run('UPDATE showtimes SET tmdb_id = ? WHERE amc_movie_id = ?', m.tmdb_id, amcId);
    await ingestMovie(m.tmdb_id, log);

    // Year-gap review, once per automatic match (also runs for older matches
    // the first time their AMC year becomes known).
    if (!m.manual && !m.review && m.amc_year) {
      const mv = getMovie(m.tmdb_id);
      const gap = mv?.year ? m.amc_year - mv.year : 0;
      const rerelease = stripQualifiers(info.title).toLowerCase() !== String(info.title || '').toLowerCase();
      if (gap > REVIEW_YEAR_GAP && !rerelease) {
        const reason = `AMC lists it as a ${m.amc_year} release; it matched ${mv.title} (${mv.year}), ${gap} years older`;
        setReview(amcId, reason);
        log.errors.push(`Match needs review: "${info.title}" → ${mv.title} (${mv.year}) — ${reason}. Keep or fix it in Settings → AMC title matching.`);
      }
    }
  }
}

// Match CSV-imported ratings that couldn't be resolved at import time.
async function resolveUnmatchedRatings(log, limit = 25) {
  if (!tmdb.tmdbConfigured()) return;
  const rows = all('SELECT * FROM unmatched_ratings ORDER BY id LIMIT ?', limit);
  for (const r of rows) {
    try {
      const found = await findTmdbMatch(r.title, r.year);
      if (found) {
        upsertLightMovie(found.result);
        upsertRating({
          tmdb_id: found.tmdb_id, title: found.result.title, year: found.result.year,
          rating: r.rating, source: r.source, rated_at: r.rated_at,
        });
        run('DELETE FROM unmatched_ratings WHERE id = ?', r.id);
      }
    } catch (e) {
      log.errors.push(`resolve rating "${r.title}": ${e.message}`);
    }
  }
}

// Gradually fetch full details for rated movies so the director/actor taste
// profile deepens over time (genre profile works from light records already).
async function enrichRatedMovies(log, limit = 12) {
  if (!tmdb.tmdbConfigured()) return;
  const rows = all(
    `SELECT r.tmdb_id FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id
      WHERE m.details_at IS NULL LIMIT ?`,
    limit,
  );
  for (const row of rows) {
    try {
      await ingestMovie(row.tmdb_id, log);
    } catch (e) {
      log.errors.push(`enrich ${row.tmdb_id}: ${e.message}`);
    }
  }
}

// Resolve the primary theatre to an AMC id on first run (search by name), then
// return every followed theatre. Returns [] when AMC isn't usable.
async function resolveTheatres(log) {
  if (!amc.amcConfigured()) return [];
  const settings = getSettings();
  try {
    if (!settings.theatreId && settings.theatreName) {
      const found = await amc.searchTheatres(settings.theatreName);
      if (found.length) {
        setSetting('theatreId', found[0].id);
        setSetting('theatreSlug', found[0].slug || '');
        setSetting('theatreName', found[0].name);
      }
    }
    const theatres = followedTheatres(getSettings()).filter((t) => t.id);
    for (const t of theatres) t.record = (await amc.getTheatre(t.id)) || null;
    return theatres;
  } catch (e) {
    const unauthorized = e.status === 403 || /unauthorized vendorkey/i.test(e.body?.errors?.[0]?.exceptionMessage || '');
    log.errors.push(unauthorized
      ? 'AMC key rejected ("Unauthorized VendorKey") — AMC\'s developer API is gated and this key is not authorized for showtimes. Ranking TMDB\'s current releases instead. Remove AMC_API_KEY from .env to hide this warning.'
      : `AMC theatre lookup: ${e.message}`);
    return [];
  }
}

export async function refreshAll({ force = false, days = 14 } = {}) {
  // A refresh requested mid-run (e.g. following a second theatre while the
  // first is still loading) runs again as soon as this one finishes, instead
  // of being dropped — otherwise the second theatre would have no showtimes
  // until tomorrow's auto-refresh.
  if (state.running) {
    // Keep the strongest request: a user-initiated (force) refresh queued
    // behind the auto-refresh must still re-pull today/tomorrow.
    state.rerun = { force: Boolean(state.rerun?.force) || force, days: Math.max(state.rerun?.days || 0, days) };
    return { skipped: 'already-running', queued: true, ...(state.lastLog || {}) };
  }
  state.running = true;
  // One clock reading per run, so the fetch window, the forced days, "today"
  // and the past-showtime purge all agree even if the run straddles midnight.
  const start = new Date();
  const log = { startedAt: start.toISOString(), finishedAt: null, sources: {}, counts: {}, errors: [] };
  try {
    const settings = getSettings();
    if (!tmdb.tmdbConfigured()) log.errors.push('TMDB_API_KEY not set — posters, metadata and matching are disabled.');

    // 1. Resolve the followed theatres (primary first).
    const theatres = await resolveTheatres(log);
    const primary = theatres[0] || null;

    run('UPDATE movies SET playing = 0, upcoming = 0');

    // 2. AMC showtimes for the next `days` days, per theatre. Movies are
    //    deduped across theatres by AMC movie id so each is matched/ingested once.
    let amcOk = false;
    if (theatres.length) {
      const ids = theatres.map((t) => t.id);
      run(`DELETE FROM showtimes WHERE theatre_id NOT IN (${ids.map(() => '?').join(',')})`, ...ids);

      const uniqueMovies = new Map();
      const src = {
        ok: false, theatre: primary.name, theatres: [], showtimes: 0, movies: 0, calls: 0,
        freshDays: force ? FRESH_DAYS : 0,
      };
      for (const t of theatres) {
        const callsBefore = amc.apiStats.calls;
        const collected = [];
        const mine = new Set();
        let ok = false;
        // Days whose live AMC call failed and were served from an older cached
        // copy instead — silent inside cachedJson, so count them here.
        const staleDays = [];
        let staleError = null;
        for (let i = 0; i < days; i++) {
          const date = addDays(start, i);
          const meta = {};
          const sts = await safe(amc.showtimes(t.id, date, t.record || t, { force: force && i < FRESH_DAYS, meta }), (e) =>
            log.errors.push(`AMC showtimes ${t.short} ${localYMD(date)}: ${e.message}`));
          if (meta.stale) {
            staleDays.push({ date: localYMD(date), fetchedAt: meta.fetchedAt });
            staleError = meta.error;
          }
          if (Array.isArray(sts)) {
            for (const s of sts) {
              s.theatre_id = s.theatre_id || t.id;
              collected.push(s);
              if (s.amc_movie_id) {
                mine.add(s.amc_movie_id);
                if (!uniqueMovies.has(s.amc_movie_id)) uniqueMovies.set(s.amc_movie_id, { title: s.movie_title, year: s.movie_year });
              }
            }
            if (sts.length) ok = true;
          }
        }
        if (collected.length) {
          run('DELETE FROM showtimes WHERE theatre_id = ?', t.id);
          for (const s of collected) insertShowtime(s);
        }
        const calls = amc.apiStats.calls - callsBefore;
        src.theatres.push({
          id: t.id, name: t.name, short: t.short, isPrimary: t.isPrimary, ok, showtimes: collected.length, movies: mine.size, calls,
          staleDays: staleDays.length, staleError,
        });
        src.showtimes += collected.length;
        src.calls += calls;
        src.staleDays = (src.staleDays || 0) + staleDays.length;
        if (staleDays.length) {
          const oldest = staleDays.map((d) => d.fetchedAt).sort()[0];
          const ageH = oldest ? Math.round((Date.now() - Date.parse(oldest)) / 3600000) : null;
          log.errors.push(
            `${t.short}: AMC failed for ${staleDays.length} day(s) (${staleDays.map((d) => d.date.slice(5)).join(', ')}) — served the cached copy instead${ageH != null ? ` (oldest ${ageH}h old)` : ''}. Error: ${staleError}`,
          );
        }
        // The ranking is driven by the primary; fall back to TMDB only if IT is empty.
        if (t.isPrimary && ok) amcOk = true;
      }
      src.ok = amcOk;
      src.movies = uniqueMovies.size;
      log.sources.amc = src;
      for (const [amcId, info] of uniqueMovies) {
        try {
          await ensureMatch(amcId, info, log);
        } catch (e) {
          log.errors.push(`match "${info.title}": ${e.message}`);
        }
      }
      // Titles still without a TMDB record are invisible to everything
      // downstream, so say so in one place rather than dropping them silently.
      const um = unmatchedTitles(localYMD(start));
      src.unmatched = um.unmatched.map((u) => u.amc_title);
      src.ignored = um.ignored.map((u) => u.amc_title);
      src.review = reviewTitles(localYMD(start)).map((r) => `${r.amc_title} → ${r.matched.title} (${r.matched.year})`);
      if (src.unmatched.length) {
        log.errors.push(
          `${src.unmatched.length} AMC title(s) couldn't be matched to TMDB and aren't ranked: ${src.unmatched.join('; ')} — match them in Settings → Unmatched AMC titles.`,
        );
      }

      // Drive time from home, once per theatre (cached for a year).
      const home = homeBase(getSettings());
      for (const t of theatres) {
        await safe(theatreDistance(t.id, home), (e) => log.errors.push(`Drive time ${t.short}: ${e.message}`));
      }
    } else if (amc.amcConfigured()) {
      log.errors.push('AMC key set but no theatre resolved — set your theatre in Settings.');
    }

    // 3. Fallback: TMDB Now Playing so the app still ranks something. That list
    //    mixes in re-releases and placeholder stubs, so — fallback ONLY — we drop
    //    films released longer ago than the recency window and obvious junk
    //    records. (When AMC drives the lineup, its list is the source of truth and
    //    none of this filtering runs, so legit re-releases/special screenings show.)
    if (!amcOk && tmdb.tmdbConfigured()) {
      const weeks = Number(settings.fallbackRecencyWeeks) || 8;
      const cutoff = Date.now() - weeks * 7 * 86400000;
      const raw = [
        ...(await safe(tmdb.nowPlaying(1), (e) => log.errors.push(`TMDB now_playing: ${e.message}`))),
        ...(await safe(tmdb.nowPlaying(2))),
      ];
      const filtered = { old: [], junk: [], recencyWeeks: weeks };
      const ids = [];
      const seen = new Set();
      for (const r of raw) {
        const lm = tmdb.lightMovie(r);
        if (seen.has(lm.tmdb_id)) continue;
        seen.add(lm.tmdb_id);
        if (!withinRecency(lm.release_date, cutoff)) {
          filtered.old.push({ tmdb_id: lm.tmdb_id, title: lm.title, year: lm.year, release_date: lm.release_date });
          continue;
        }
        upsertLightMovie(lm);
        await ingestMovie(lm.tmdb_id, log); // need full details to judge junk
        const full = getMovie(lm.tmdb_id);
        const reasons = looksLikeJunk(full);
        if (reasons.length) {
          filtered.junk.push({ tmdb_id: lm.tmdb_id, title: full?.title || lm.title, year: full?.year || lm.year, reasons });
          deleteMovieIfUnreferenced(lm.tmdb_id);
          continue;
        }
        ids.push(lm.tmdb_id);
      }
      if (ids.length) {
        run(`UPDATE movies SET playing = 1, playing_source = 'tmdb' WHERE tmdb_id IN (${ids.map(() => '?').join(',')})`, ...ids);
      }
      log.filtered = filtered;
      log.sources.tmdbFallback = {
        ok: ids.length > 0, movies: ids.length,
        filteredOld: filtered.old.length, filteredJunk: filtered.junk.length, recencyWeeks: weeks,
      };
      for (const j of filtered.junk) {
        log.errors.push(`Dropped placeholder "${j.title}" (${j.year || '?'}) — ${j.reasons.join('; ')}`);
      }
      if (filtered.old.length) {
        const sample = filtered.old.slice(0, 15).map((m) => `${m.title} (${(m.release_date || '').slice(0, 10) || m.year || '?'})`).join(', ');
        log.errors.push(`Filtered ${filtered.old.length} title(s) older than ${weeks}wk from fallback: ${sample}${filtered.old.length > 15 ? '…' : ''}`);
      }
    }

    // 4. Flag "playing this week" from showtimes in the next 7 days at ANY
    //    followed theatre. recommend.js decides which of those are in the
    //    primary's lineup (ranked) versus only nearby (separate section).
    const today = localYMD(start);
    const weekEnd = localYMD(addDays(start, 6));
    if (theatres.length) {
      run(
        `UPDATE movies SET playing = 1, playing_source = 'amc'
          WHERE tmdb_id IN (SELECT DISTINCT tmdb_id FROM showtimes
                             WHERE tmdb_id IS NOT NULL AND date >= ? AND date <= ?)`,
        today, weekEnd,
      );
    }

    // 5. Coming Soon: TMDB upcoming + any advance showtimes beyond this week.
    if (tmdb.tmdbConfigured()) {
      const up = [
        ...(await safe(tmdb.upcoming(1), (e) => log.errors.push(`TMDB upcoming: ${e.message}`))),
        ...(await safe(tmdb.upcoming(2))),
      ];
      const upIds = [];
      for (const r of up) {
        const lm = tmdb.lightMovie(r);
        upsertLightMovie(lm);
        upIds.push(lm.tmdb_id);
      }
      if (upIds.length) {
        run(`UPDATE movies SET upcoming = 1 WHERE playing = 0 AND tmdb_id IN (${upIds.map(() => '?').join(',')})`, ...upIds);
      }
      run(
        `UPDATE movies SET upcoming = 1
          WHERE playing = 0 AND tmdb_id IN (SELECT DISTINCT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date > ?)`,
        weekEnd,
      );
      log.sources.upcoming = { movies: upIds.length };
    }

    // 6. Housekeeping: resolve pending ratings, deepen profile, drop past showtimes.
    await resolveUnmatchedRatings(log, 25);
    await enrichRatedMovies(log, 12);
    run('DELETE FROM showtimes WHERE date < ?', today);

    // 7. Publishing horizon + lineup snapshot, per theatre. The horizon is how
    //    "Last chance" and the runway badges tell a real departure from a
    //    schedule AMC hasn't posted yet, so it's logged every refresh to be
    //    sanity-checked against the theatre's site.
    const density = Number(settings.lastChanceDensity) || 0.5;
    const home = homeBase(getSettings());
    const snapTheatres = theatres.length
      ? theatres
      : [{ id: String(getSetting('theatreId') || ''), name: settings.theatreName, short: shortName(settings.theatreName), isPrimary: true }];
    log.horizons = [];
    for (const t of snapTheatres) {
      const info = computeHorizon({ today, density, theatreId: t.id });
      const snap = snapshotLineup({ today, horizonInfo: info, at: log.startedAt, theatreId: t.id });
      const entry = {
        theatre: { id: t.id, name: t.name, short: t.short, isPrimary: Boolean(t.isPrimary), distance: readDistance(t.id, home) },
        publishedThrough: info.horizon,
        furthestShowtime: info.furthest,
        typicalDailyLineup: info.reference,
        breadthThreshold: info.threshold,
        typicalDailyShowtimes: info.referenceShowtimes,
        showtimeThreshold: info.thresholdShowtimes,
        publishedDays: info.publishedDays,
        lineup: snap.movies,
        departed: snap.departed,
        byDate: info.breadth.map((b) => ({ date: b.date, movies: b.movies, showtimes: b.showtimes })),
      };
      log.horizons.push(entry);
      if (t.isPrimary) log.horizon = entry;
      if (info.horizon) {
        const tail = info.furthest !== info.horizon
          ? ` Showtimes exist out to ${info.furthest}, but only for a thin advance-sale tail.`
          : '';
        log.errors.push(
          `${t.short}: schedule published through ${info.horizon} (${info.publishedDays} days, ~${info.reference} movies / ~${info.referenceShowtimes} showtimes per day).${tail}`,
        );
      }
      for (const d of snap.departed) {
        log.errors.push(`Left ${t.short}: "${d.title || d.tmdb_id}" (last showtime ${d.last_date || '?'}).`);
      }
    }

    // OMDb quota/auth failures were counted, not logged per movie: one line.
    if (log.omdb) {
      log.sources.omdb = { paused: log.omdb.reason, skipped: log.omdb.skipped };
      log.errors.push(
        `OMDb unavailable (${log.omdb.reason}) — scores for ${log.omdb.skipped} movie(s) were not updated this refresh; lookups pause for an hour, then retry on the next refresh.`,
      );
    }

    log.counts = {
      playing: all('SELECT tmdb_id FROM movies WHERE playing = 1').length,
      upcoming: all('SELECT tmdb_id FROM movies WHERE upcoming = 1').length,
      showtimes: all('SELECT id FROM showtimes').length,
      theatres: snapTheatres.length,
      amcCalls: log.sources.amc?.calls ?? 0,
    };
    log.finishedAt = new Date().toISOString();
    setSetting('lastRefresh', log.finishedAt);
    setSetting('lastRefreshLog', log);
    state.lastLog = log;
    return log;
  } finally {
    state.running = false;
    const queued = state.rerun;
    state.rerun = null;
    if (queued) refreshAll(queued).catch((e) => console.error('[refresh rerun]', e.message));
  }
}

// Fetch details + scores for a single movie on demand (rating a movie, fixing a
// match, onboarding). Fire-and-forget friendly.
export async function ingestOne(tmdbId) {
  const log = { errors: [] };
  await ingestMovie(tmdbId, log);
  return log;
}

// Bulk-fetch TMDB details for rated movies that don't have them yet (e.g. after
// restoring a backup). Details-only so it doesn't burn the OMDb quota.
export async function enrichMissingDetails({ max = 400 } = {}) {
  if (state.enriching) return { enriched: 0, busy: true };
  state.enriching = true;
  let enriched = 0;
  try {
    if (!tmdb.tmdbConfigured()) return { enriched: 0 };
    const rows = all(
      `SELECT r.tmdb_id FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id
        WHERE m.details_at IS NULL LIMIT ?`,
      max,
    );
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const id = rows[i++].tmdb_id;
        try {
          await ingestMovie(id, { errors: [] }, { detailsOnly: true });
          enriched++;
        } catch {
          /* skip and continue */
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    return { enriched };
  } finally {
    state.enriching = false;
  }
}

// Background-resolve imported ratings that couldn't be matched at import time.
export async function drainUnmatched({ max = 800 } = {}) {
  if (state.draining) return { tried: 0, matched: 0, busy: true };
  state.draining = true;
  let tried = 0;
  let matched = 0;
  try {
    if (!tmdb.tmdbConfigured()) return { tried, matched };
    const rows = all('SELECT * FROM unmatched_ratings ORDER BY id LIMIT ?', max);
    let i = 0;
    const worker = async () => {
      while (i < rows.length) {
        const r = rows[i++];
        tried++;
        try {
          const found = await findTmdbMatch(r.title, r.year);
          if (found) {
            upsertLightMovie(found.result);
            upsertRating({
              tmdb_id: found.tmdb_id, title: found.result.title, year: found.result.year,
              rating: r.rating, source: r.source, rated_at: r.rated_at,
            });
            run('DELETE FROM unmatched_ratings WHERE id = ?', r.id);
            matched++;
          }
        } catch {
          /* leave in queue for a later attempt */
        }
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    // Remembered so the import flow can report "N matched" after its poll.
    state.lastDrain = { tried, matched, finishedAt: new Date().toISOString() };
    return { tried, matched };
  } finally {
    state.draining = false;
  }
}

// Auto-refresh at most once/day; a new calendar day (incl. every Friday when new
// releases land) triggers the next refresh.
export function shouldAutoRefresh(now = new Date()) {
  const last = getSetting('lastRefresh');
  if (!last) return true;
  return localYMD(new Date(last)) !== localYMD(now);
}
