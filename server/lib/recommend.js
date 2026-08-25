// Assembles the ranked outputs the UI consumes: the weekly 4, the full ranked
// list, Coming Soon, leaving-soon alerts, and per-movie detail.
//
// Theatres: the ranking, the day picker and the runway badge are all about the
// PRIMARY theatre. Other followed theatres only contribute (a) which theatres a
// movie is playing at, with per-theatre showtimes and runway, (b) the "Also
// nearby" section for movies the primary doesn't have, and (c) the hand-off
// line when a movie is leaving the primary but still on elsewhere.
import { all, get, run, getSettings } from '../db.js';
import { getMovie, hydrate } from './movies.js';
import { profileRows, ratedIds, getRating } from './ratings.js';
import { getMatch } from './match.js';
import { buildProfile, confidence, tasteMatch, topTasteFactor } from './taste.js';
import { publicScoreForMovie, isSettling } from './scoring.js';
import {
  finalScore, buildReason, bestShowtime, showtimeFits, endTimeLabel, urgencyBoost,
} from './ranking.js';
import { getLastChance, dailyBreadth, computeHorizon, lineupExodus } from './leaving.js';
import { followedTheatres, homeBase, readDistance } from './theatres.js';
import { computeRunway, runwayDates, handoffLine, goneAfterPhrase } from './runway.js';
import { localYMD, addDays, timeLabel, weekStartFriday } from './util.js';
import { ownerName } from './guest.js';

function watchlistSet() {
  return new Set(all('SELECT tmdb_id FROM watchlist').map((r) => r.tmdb_id));
}

function watchedSet() {
  return new Set(all('SELECT DISTINCT tmdb_id FROM watched').map((r) => r.tmdb_id));
}

// guest: the read-only shared link. Drive times/distances are dropped at the
// source so no payload derived from this context can reveal where home is.
function buildCtx({ guest = false } = {}) {
  const settings = getSettings();
  const profile = buildProfile(profileRows());
  const conf = confidence(profile);
  const today = localYMD();
  const weekEnd = localYMD(addDays(new Date(), 6));
  const home = homeBase(settings);
  const theatres = followedTheatres(settings).map((t) => ({ ...t, distance: guest ? null : readDistance(t.id, home) }));
  const primaryId = theatres[0].id;
  const known = new Set(theatres.map((t) => t.id));

  // Every upcoming showtime, partitioned theatre -> movie (all published dates,
  // not just this week — runway needs the tail). Rows from a theatre that is
  // no longer followed shouldn't exist after a refresh; if any do, they fold
  // into the primary rather than vanish.
  const byTheatre = new Map(theatres.map((t) => [t.id, new Map()]));
  for (const s of all(
    'SELECT * FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ? ORDER BY start_epoch', today,
  )) {
    const tid = known.has(s.theatre_id) ? s.theatre_id : primaryId;
    const m = byTheatre.get(tid);
    if (!m.has(s.tmdb_id)) m.set(s.tmdb_id, []);
    m.get(s.tmdb_id).push(s);
  }

  const density = Number(settings.lastChanceDensity) || 0.5;
  const minGap = Number(settings.lastChanceMinGapDays) || 3;
  const horizons = new Map(theatres.map((t) => [t.id, computeHorizon({ today, density, theatreId: t.id })]));
  // Per theatre: does most of the lineup "end" the same day? Then the schedule
  // is mid-update and no runway badge at that theatre may commit to an end.
  const exodus = new Map(theatres.map((t) => [
    t.id, lineupExodus({ today, theatreId: t.id, horizon: horizons.get(t.id)?.horizon, minGap }),
  ]));

  return {
    settings,
    profile,
    conf,
    rated: ratedIds(),
    ratings: new Map(all('SELECT tmdb_id, rating FROM ratings').map((r) => [r.tmdb_id, r.rating])),
    watch: watchlistSet(),
    watched: watchedSet(),
    weights: { public: Number(settings.weightPublic) || 0, taste: Number(settings.weightTaste) || 0 },
    today,
    weekEnd,
    now: Date.now(),
    theatres,
    primaryId,
    byTheatre,
    horizons,
    exodus,
    minGap,
    handoffMinScore: Number(settings.lastChanceMinScore) || 0,
    // Third-person voice for reason lines on the guest link ("Tawfiq rates…").
    owner: guest ? ownerName() : null,
  };
}

// Showtime rows for one movie at one theatre; `week` limits to the next 7 days
// (the window "playing this week" is defined by).
function rowsAt(ctx, tid, tmdbId, { week = false } = {}) {
  const rows = ctx.byTheatre.get(tid)?.get(tmdbId) || [];
  return week ? rows.filter((s) => s.date <= ctx.weekEnd) : rows;
}

function runwayAt(ctx, tid, tmdbId) {
  const rows = rowsAt(ctx, tid, tmdbId);
  if (!rows.length) return null;
  return computeRunway({
    ...runwayDates(rows),
    horizon: ctx.horizons.get(tid)?.horizon || null,
    today: ctx.today,
    minGap: ctx.minGap,
    hedgeAll: Boolean(ctx.exodus.get(tid)?.exodus),
  });
}

function isExcluded(movie, settings) {
  const exG = new Set(settings.excludedGenres || []);
  const exM = new Set(settings.excludedMpaa || []);
  if (movie.mpaa && exM.has(movie.mpaa)) return true;
  return (movie.genres || []).some((g) => exG.has(g));
}

function cardShape(m) {
  return {
    tmdb_id: m.tmdb_id,
    title: m.title,
    year: m.year,
    poster: m.poster,
    backdrop: m.backdrop,
    genres: m.genres || [],
    director: m.director || null,
    runtime: m.runtime || null,
    mpaa: m.mpaa || null,
    tmdb_rating: m.tmdb_rating ?? null,
    release_date: m.release_date || null,
  };
}

function theatreShape(t) {
  return { id: t.id, name: t.name, short: t.short, isPrimary: Boolean(t.isPrimary), distance: t.distance || null };
}

function summarizeShowtime(s, movie, settings) {
  const runtime = movie.runtime || s.runtime_min || null;
  return {
    id: s.id,
    date: s.date,
    time: timeLabel(s.start_local),
    start_local: s.start_local,
    start_epoch: s.start_epoch,
    end: endTimeLabel(s.start_local, runtime, settings.previewsMinutes),
    format: s.format,
    is_imax: Boolean(s.is_imax),
    is_advance: Boolean(s.is_advance),
    fits_window: showtimeFits(s.start_local, settings.showtimeWindows),
    purchase_url: s.purchase_url,
  };
}

// Showtimes grouped by day, each marked `past` once it has started.
function byDayOf(rows, movie, ctx) {
  const map = new Map();
  for (const s of rows) {
    if (!map.has(s.date)) map.set(s.date, []);
    map.get(s.date).push({
      ...summarizeShowtime(s, movie, ctx.settings),
      past: (s.start_epoch ?? 0) < ctx.now,
    });
  }
  return [...map.entries()].map(([date, showtimes]) => ({ date, showtimes }));
}

// Which followed theatres have this movie this week, each with its own runway
// and (for theatres other than the one the entry was evaluated at) its own
// day-grouped showtimes for the row's expandable panel.
function presence(movie, ctx, evaluatedTid) {
  const out = [];
  for (const t of ctx.theatres) {
    const week = rowsAt(ctx, t.id, movie.tmdb_id, { week: true });
    if (!week.length) continue;
    const runway = runwayAt(ctx, t.id, movie.tmdb_id);
    out.push({
      ...theatreShape(t),
      showtimesThisWeek: week.length,
      lastDate: runway?.lastDate || null,
      runway,
      showtimesByDay: t.id === evaluatedTid ? undefined : byDayOf(week, movie, ctx),
    });
  }
  return out;
}

function taste3(movie, profile) {
  return { genres: movie.genres, director: movie.director, cast: movie.cast };
}

// Score + shape one movie against one theatre's schedule (the primary unless
// the movie is only playing nearby). Boosts for IMAX / window fit / urgency
// come from that theatre's showtimes and runway, so a nearby-only movie is
// judged by where you'd actually see it.
function evaluate(movie, ctx, tid = ctx.primaryId) {
  const pub = publicScoreForMovie(movie, movie.scores);
  const tm = tasteMatch(taste3(movie), ctx.profile);
  const topTaste = topTasteFactor(taste3(movie), ctx.profile);
  const sts = rowsAt(ctx, tid, movie.tmdb_id, { week: true });
  const imaxAvailable = sts.some((s) => s.is_imax);
  const best = bestShowtime(sts, { windows: ctx.settings.showtimeWindows, preferImax: ctx.settings.preferImax });
  const windowFit = Boolean(best?.fits);

  // Display uses the best *upcoming* showtime — `best` above is left alone
  // because the window-fit boost derives from it and rankings must not shift.
  const upcoming = sts.filter((s) => (s.start_epoch ?? 0) >= ctx.now);
  const nextBest = bestShowtime(upcoming, { windows: ctx.settings.showtimeWindows, preferImax: ctx.settings.preferImax });

  // Every showtime this week, grouped by day, so a row can expand and offer a
  // day picker without another round-trip.
  const byDay = byDayOf(sts, movie, ctx);
  const watchlisted = ctx.watch.has(movie.tmdb_id);
  const excluded = isExcluded(movie, ctx.settings);

  // Runway at the theatre this entry is about (urgency below is judged by it),
  // plus the hand-off line when the PRIMARY run is ending and another followed
  // theatre has it later.
  const theatres = presence(movie, ctx, tid);
  const theatre = ctx.theatres.find((t) => t.id === tid) || ctx.theatres[0];
  const runway = runwayAt(ctx, tid, movie.tmdb_id);
  const primaryRunway = tid === ctx.primaryId ? runway : runwayAt(ctx, ctx.primaryId, movie.tmdb_id);

  let boosts = 0;
  if (watchlisted) boosts += Number(ctx.settings.watchlistBoost) || 0;
  if (imaxAvailable && ctx.settings.preferImax) boosts += Number(ctx.settings.imaxBoost) || 0;
  if (windowFit) boosts += Number(ctx.settings.windowFitBoost) || 0;
  // Urgency: only a COMMITTED end date counts (runway kind 'ending'); a hedged
  // "through at least" is the publishing horizon, not scarcity, and adds nothing.
  const urgency = urgencyBoost({
    runway,
    watchlisted,
    max: ctx.settings.urgencyBoost,
    watchlistMultiplier: ctx.settings.urgencyWatchlistMultiplier,
  });
  boosts += urgency;

  const final = finalScore({
    publicCombined: pub.combined,
    tasteScore: tm.score,
    conf: ctx.conf,
    weights: ctx.weights,
    boosts,
  });
  // The same score without urgency. "Is it good enough to mention" gates (Last
  // chance, the hand-off line) are about quality, and every candidate there is
  // leaving by definition — urgency would just lower the bar for exactly them.
  const finalBeforeUrgency = urgency > 0
    ? finalScore({ publicCombined: pub.combined, tasteScore: tm.score, conf: ctx.conf, weights: ctx.weights, boosts: boosts - urgency })
    : final;

  const reason = buildReason({
    pub,
    topTaste,
    conf: ctx.conf,
    flags: {
      watchlist: watchlisted,
      imax: imaxAvailable && ctx.settings.preferImax,
      goneAfter: urgency > 0 ? goneAfterPhrase(runway, ctx.today) : null,
    },
    owner: ctx.owner,
  });

  const handoff = finalBeforeUrgency >= ctx.handoffMinScore
    ? handoffLine({
      primaryShort: ctx.theatres[0].short,
      primaryRunway,
      others: theatres.filter((t) => !t.isPrimary),
      today: ctx.today,
    })
    : null;

  return {
    ...cardShape(movie),
    final,
    finalBeforeUrgency,
    reason,
    myRating: ctx.ratings.get(movie.tmdb_id) ?? null,
    public: {
      combined: pub.combined, critic: pub.critic, audience: pub.audience, sources: pub.sources, divergence: pub.divergence, display: pub.display,
      // OMDb was asked (by IMDb id and title) and has nothing for this title.
      noOmdbRecord: Boolean(movie.scores?.noRecord),
      omdbCheckedAt: movie.scores?.checkedAt || movie.scores_at || null,
    },
    taste: { score: tm.score, hasSignal: tm.hasSignal },
    flags: {
      watchlisted,
      imax: imaxAvailable,
      windowFit,
      excluded,
      settling: isSettling(movie),
      seen: ctx.rated.has(movie.tmdb_id),
      // No public score at all: `final` is built on a neutral 50, so the UI
      // marks it and the "worth seeing" cut ignores it.
      noScores: pub.combined == null,
    },
    bestShowtime: best ? summarizeShowtime(best.s, movie, ctx.settings) : null,
    nextShowtime: nextBest ? summarizeShowtime(nextBest.s, movie, ctx.settings) : null,
    showtimesByDay: byDay,
    showtimeCount: sts.length,
    theatre: theatreShape(theatre),
    theatres,
    runway,
    handoff,
    // What urgency added to `final` (null when nothing did), for the UI and
    // for breaking ties in the ranking. (Last-chance entries also carry a
    // pre-existing `urgency` string — the card's colour tier — hence the name.)
    urgencyBoost: urgency > 0
      ? { points: Math.round(urgency * 10) / 10, daysLeft: runway.daysLeft, lastDate: runway.lastDate, watchlisted }
      : null,
  };
}

// Ranking order: score, then — when the displayed score ties — whichever has
// more urgency (leaving sooner; starred counts for more), so urgency still
// breaks ties where the 0-100 clamp has flattened the top of the list. Stable
// beyond that (lineup order), as before.
function byScore(a, b) {
  return b.final - a.final || (b.urgencyBoost?.points ?? 0) - (a.urgencyBoost?.points ?? 0);
}

export function getProfileSummary() {
  const profile = buildProfile(profileRows());
  const top = (obj, n = 6) =>
    Object.entries(obj)
      .map(([k, v]) => ({ name: k, avg: Number(v.avg.toFixed(2)), n: v.n }))
      .sort((a, b) => b.n - a.n || b.avg - a.avg)
      .slice(0, n);
  return {
    count: profile.count,
    confidence: confidence(profile),
    overall: Number(profile.overall.toFixed(2)),
    lowData: profile.count < 10,
    topGenres: top(profile.genre),
    topDirectors: top(profile.director),
    topActors: top(profile.actor, 8),
  };
}

function horizonSummary(info, exodus = null) {
  if (!info) return null;
  return {
    publishedThrough: info.horizon,
    furthestShowtime: info.furthest,
    typicalDailyLineup: info.reference,
    breadthThreshold: info.threshold,
    typicalDailyShowtimes: info.referenceShowtimes,
    showtimeThreshold: info.thresholdShowtimes,
    publishedDays: info.publishedDays,
    exodus: exodus ? { suppressed: exodus.exodus, flagged: exodus.flagged, lineup: exodus.lineup } : null,
  };
}

export function theatreList(ctx) {
  return ctx.theatres.map((t) => ({
    ...theatreShape(t), horizon: horizonSummary(ctx.horizons.get(t.id), ctx.exodus.get(t.id)),
  }));
}

// Pin down this week's four as they are offered: each pick is written to
// weekly4_log the first time it shows up in the week's four. The live four
// drifts during the week — a refresh re-ranks the lineup, and rating a pick
// removes it (flags.seen) — so any question about what the picks WERE has to
// read this log, not a recomputation. Guest views never write.
function recordWeekly4(weekly4) {
  const week = weekStartFriday();
  weekly4.forEach((e, i) => {
    run(
      `INSERT INTO weekly4_log(week_start, tmdb_id, rank, first_seen_at)
        VALUES(?,?,?,?) ON CONFLICT(week_start, tmdb_id) DO NOTHING`,
      week, e.tmdb_id, i + 1, new Date().toISOString(),
    );
  });
}

// Was this movie among the weekly 4 at any point in the given A-List week?
export function wasWeekly4Pick(tmdbId, week = weekStartFriday()) {
  return Boolean(get('SELECT 1 AS x FROM weekly4_log WHERE week_start = ? AND tmdb_id = ?', week, tmdbId));
}

export function getRecommendations({ guest = false } = {}) {
  const ctx = buildCtx({ guest });
  const playing = all('SELECT * FROM movies WHERE playing = 1').map(hydrate);

  // Split the lineup: in the primary's schedule this week → ranked as always;
  // only at another followed theatre → "Also nearby", never in the ranking.
  // A movie with no showtimes anywhere (TMDB fallback) stays in the ranking.
  const hasWeek = (tid, id) => rowsAt(ctx, tid, id, { week: true }).length > 0;
  const main = [];
  const nearby = [];
  for (const m of playing) {
    if (hasWeek(ctx.primaryId, m.tmdb_id)) { main.push(m); continue; }
    const t = ctx.theatres.find((x) => !x.isPrimary && hasWeek(x.id, m.tmdb_id));
    if (t) nearby.push({ m, t });
    else main.push(m);
  }

  const evaluated = main.map((m) => evaluate(m, ctx));
  const list = evaluated.sort(byScore);
  const eligible = list.filter((e) => !e.flags.seen && !e.flags.excluded);
  const weekly4 = eligible.slice(0, 4);
  if (!guest) recordWeekly4(weekly4);
  // Everything else that still clears the "good match" bar, so the picks page
  // isn't capped at four. Already-in-weekly4 movies are excluded, not repeated;
  // so are movies with no public score — their `final` rests on a default 50.
  const cutoff = Number(ctx.settings.goodMatchMinScore) || 0;
  const top4 = new Set(weekly4.map((e) => e.tmdb_id));
  const worthSeeing = eligible.filter((e) => !top4.has(e.tmdb_id) && e.final >= cutoff && !e.flags.noScores);
  const lastChance = getLastChance(list, ctx);

  const alsoNearby = nearby
    .map(({ m, t }) => evaluate(m, ctx, t.id))
    .sort(byScore);

  const primary = ctx.theatres[0];
  return {
    weekly4,
    worthSeeing,
    goodMatchMinScore: cutoff,
    // Published days the page's day picker can offer (primary theatre).
    days: dailyBreadth(ctx.today, ctx.primaryId).map((d) => ({ date: d.date, movies: d.movies, showtimes: d.showtimes })),
    list,
    alsoNearby,
    lastChance: lastChance.items,
    lastChanceDiagnostics: lastChance.diagnostics,
    profile: {
      count: ctx.profile.count,
      confidence: ctx.conf,
      lowData: ctx.profile.count < 10,
    },
    weights: ctx.weights,
    urgency: {
      boost: Number(ctx.settings.urgencyBoost) || 0,
      watchlistMultiplier: Number(ctx.settings.urgencyWatchlistMultiplier) || 1,
    },
    theatre: { ...theatreShape(primary), horizon: horizonSummary(ctx.horizons.get(primary.id), ctx.exodus.get(primary.id)) },
    theatres: theatreList(ctx),
    multiTheatre: ctx.theatres.length > 1,
    playingSource: main[0]?.playing_source || playing[0]?.playing_source || null,
    // Every flagged departure, before the score threshold — the watchlist view
    // wants to know about a starred film leaving regardless of how it scores.
    leavingSoon: lastChance.all,
  };
}

export function getComingSoon({ guest = false } = {}) {
  const ctx = buildCtx({ guest });
  const up = all('SELECT * FROM movies WHERE upcoming = 1').map(hydrate);
  const advanceIds = new Set(
    all('SELECT DISTINCT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date > ?', ctx.weekEnd)
      .map((r) => r.tmdb_id),
  );
  const scored = up.map((m) => {
    const tm = tasteMatch(taste3(m), ctx.profile);
    const pub = publicScoreForMovie(m, m.scores);
    const topTaste = topTasteFactor(taste3(m), ctx.profile);
    return {
      ...cardShape(m),
      release_date: m.release_date,
      predicted: tm.score,
      public: { combined: pub.combined, sources: pub.sources },
      advance: advanceIds.has(m.tmdb_id),
      reason: buildReason({ pub, topTaste, conf: ctx.conf, flags: {}, owner: ctx.owner }),
    };
  });
  scored.sort((a, b) => Number(b.advance) - Number(a.advance) || b.predicted - a.predicted);
  return { list: scored, profile: { count: ctx.profile.count, lowData: ctx.profile.count < 10 } };
}

export function getMovieDetail(tmdbId, { guest = false } = {}) {
  const m = getMovie(tmdbId);
  if (!m) return null;
  const ctx = buildCtx({ guest });
  // Evaluate where the ranking did: at the primary when it has the movie this
  // week, else at the first followed theatre that does ("Also nearby"), so the
  // score, reason and runway here agree with the row that led to this page.
  const hasWeek = (tid) => rowsAt(ctx, tid, tmdbId, { week: true }).length > 0;
  const at = hasWeek(ctx.primaryId)
    ? ctx.primaryId
    : (ctx.theatres.find((t) => !t.isPrimary && hasWeek(t.id))?.id ?? ctx.primaryId);
  const ev = evaluate(m, ctx, at);

  // Full schedule (every published date) at each followed theatre that has it.
  const showtimesByTheatre = ctx.theatres
    .map((t) => {
      const rows = rowsAt(ctx, t.id, tmdbId);
      if (!rows.length) return null;
      return { theatre: theatreShape(t), runway: runwayAt(ctx, t.id, tmdbId), showtimesByDay: byDayOf(rows, m, ctx) };
    })
    .filter(Boolean);
  // `showtimesByDay` stays the primary's schedule (what the page shows first).
  const showtimesByDay = showtimesByTheatre.find((x) => x.theatre.isPrimary)?.showtimesByDay || [];

  const match = getMatch(all('SELECT amc_movie_id FROM matches WHERE tmdb_id = ? LIMIT 1', tmdbId)[0]?.amc_movie_id);
  const rating = getRating(tmdbId);

  return {
    movie: {
      ...cardShape(m),
      cast: m.cast || [],
      synopsis: m.synopsis || '',
      trailer_key: m.trailer_key || null,
      release_date: m.release_date || null,
      imdb_id: m.imdb_id || null,
    },
    final: ev.final,
    reason: ev.reason,
    public: ev.public,
    taste: { ...ev.taste, ...tasteBreakdown(m, ctx.profile) },
    flags: ev.flags,
    watchlisted: ctx.watch.has(tmdbId),
    myRating: rating?.rating ?? null,
    showtimesByDay,
    showtimesByTheatre,
    runway: ev.runway,
    handoff: ev.handoff,
    urgencyBoost: ev.urgencyBoost,
    theatres: theatreList(ctx),
    multiTheatre: ctx.theatres.length > 1,
    playing: Boolean(m.playing),
    upcoming: Boolean(m.upcoming),
    match: match
      ? { amc_movie_id: match.amc_movie_id, amc_title: match.amc_title, confidence: match.confidence, manual: Boolean(match.manual), low: !match.manual && (match.confidence ?? 0) < 0.5 }
      : null,
    profile: { count: ctx.profile.count, confidence: ctx.conf, lowData: ctx.profile.count < 10 },
  };
}

function tasteBreakdown(movie, profile) {
  const g = (movie.genres || [])
    .map((name) => (profile.genre[name] ? { name, avg: Number(profile.genre[name].avg.toFixed(2)), n: profile.genre[name].n } : null))
    .filter(Boolean);
  const dEntry = movie.director && profile.director[movie.director];
  const director = dEntry ? { name: movie.director, avg: Number(dEntry.avg.toFixed(2)), n: dEntry.n } : null;
  const actors = (movie.cast || [])
    .map((name) => (profile.actor[name] ? { name, avg: Number(profile.actor[name].avg.toFixed(2)), n: profile.actor[name].n } : null))
    .filter(Boolean);
  return { genres: g, director, actors };
}
