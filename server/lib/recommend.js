// Assembles the ranked outputs the UI consumes: the weekly 4, the full ranked
// list, Coming Soon, leaving-soon alerts, and per-movie detail.
//
// Theatres: the ranking, the day picker and the runway badge are all about the
// PRIMARY theatre. Other followed theatres only contribute (a) which theatres a
// movie is playing at, with per-theatre showtimes and runway, (b) the "Also
// nearby" section for movies the primary doesn't have, and (c) the hand-off
// line when a movie is leaving the primary but still on elsewhere.
import { all, get, getSettings } from '../db.js';
import { getMovie, hydrate } from './movies.js';
import { profileRows, ratedIds, getRating, statsRows } from './ratings.js';
import { getMatch } from './match.js';
import { buildProfile, confidence, tasteMatch, topTasteFactor } from './taste.js';
import { publicScoreForMovie, isSettling, isReleased, usReleaseDate } from './scoring.js';
import {
  finalScore, buildReason, reasonFacts, bestShowtime, showtimeFits, endTimeLabel, beThereByLabel, urgencyBoost, excludedBySettings,
} from './ranking.js';
import { getLastChance, dailyBreadth, computeHorizon, lineupExodus } from './leaving.js';
import { followedTheatres, homeBase, readDistance, sharedTheatreIds } from './theatres.js';
import { computeRunway, runwayDates, handoffLine, goneAfterPhrase } from './runway.js';
import { localYMD, addDays, timeLabel, weekStartFriday } from './util.js';
import { ownerName } from './guest.js';
import { currentUserId } from './user.js';
import { glowColor, ensurePosterColor } from './posterColor.js';
import { SWAP_MARGIN, weekOpen, prevWeek, readLock, createLock, saveLock } from './lock.js';

// Everything below is for the user in context (lib/user.js): their settings,
// ratings, watchlist, watch log and hidden films. The guest link runs as the
// owner. Movies, showtimes and scores are shared.
function watchlistSet() {
  return new Set(all('SELECT tmdb_id FROM watchlist WHERE user_id = ?', currentUserId()).map((r) => r.tmdb_id));
}

function watchedSet() {
  return new Set(all('SELECT DISTINCT tmdb_id FROM watched WHERE user_id = ?', currentUserId()).map((r) => r.tmdb_id));
}

// Films marked "Not for me". Filters recommendations only; scores and the
// taste profile never see it.
function hiddenSet() {
  return new Set(all('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?', currentUserId()).map((r) => r.tmdb_id));
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
  // into the primary rather than vanish. Rows from a theatre someone ELSE
  // follows are theirs, not this user's lineup: skipped, and remembered so a
  // movie showing only there stays out of this user's list.
  const byTheatre = new Map(theatres.map((t) => [t.id, new Map()]));
  const others = sharedTheatreIds();
  for (const id of known) others.delete(id);
  const elsewhereThisWeek = new Set();
  for (const s of all(
    'SELECT * FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ? ORDER BY start_epoch', today,
  )) {
    if (!known.has(s.theatre_id) && others.has(s.theatre_id)) {
      if (s.date <= weekEnd) elsewhereThisWeek.add(s.tmdb_id);
      continue;
    }
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
    ratings: new Map(all('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', currentUserId()).map((r) => [r.tmdb_id, r.rating])),
    watch: watchlistSet(),
    watched: watchedSet(),
    hidden: hiddenSet(),
    weights: { public: Number(settings.weightPublic) || 0, taste: Number(settings.weightTaste) || 0 },
    today,
    weekEnd,
    now: Date.now(),
    theatres,
    primaryId,
    byTheatre,
    elsewhereThisWeek,
    othersTheatres: others,
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
    us_release_date: m.us_release_date || null,
    glow: glowColor(m),
  };
}

const HERO_SOON_MS = 48 * 3600 * 1000;

// Not out in the US yet, and every showtime this week is an early screening
// (flagged advance by AMC, or simply before the US release date): the film
// "opens" on its release date. soon: one of those screenings is within two
// days, which is what earns it the Picks hero (see public/js/views/home.js).
// Display only — nothing here feeds the score or the order.
function prereleaseOf(movie, weekRows, now) {
  const opens = usReleaseDate(movie);
  if (!opens || isReleased(movie, new Date(now)) || !weekRows.length) return null;
  if (!weekRows.every((s) => s.is_advance || s.date < opens)) return null;
  const soon = weekRows.some((s) => (s.start_epoch ?? 0) >= now && (s.start_epoch ?? 0) <= now + HERO_SOON_MS);
  return { opens, soon };
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
    // Display only: when the feature starts, and the padding it was derived
    // from so the UI can explain itself. Nothing here feeds scoring, the
    // window-fit test, or the runway — those all key off the listed time.
    be_there_by: beThereByLabel(s.start_local, settings.previewsMinutes),
    previews_min: Number(settings.previewsMinutes) || 0,
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
  const excluded = excludedBySettings(movie, ctx.settings);

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

  const reasonFlags = {
    watchlist: watchlisted,
    imax: imaxAvailable && ctx.settings.preferImax,
    goneAfter: urgency > 0 ? goneAfterPhrase(runway, ctx.today) : null,
  };
  const reason = buildReason({ pub, topTaste, conf: ctx.conf, flags: reasonFlags, owner: ctx.owner });

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
    why: reasonFacts({ pub, topTaste, conf: ctx.conf, flags: reasonFlags }),
    myRating: ctx.ratings.get(movie.tmdb_id) ?? null,
    public: {
      combined: pub.combined, critic: pub.critic, audience: pub.audience, sources: pub.sources, divergence: pub.divergence, display: pub.display,
      // OMDb was asked (by IMDb id and title) and has nothing for this title.
      noOmdbRecord: Boolean(movie.scores?.noRecord),
      // A TMDB rating on file but not counted (too few votes / not out yet).
      tmdbIgnored: pub.tmdbIgnored || null,
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
      // "Not for me": kept in the full list, dropped from every recommendation.
      hidden: ctx.hidden.has(movie.tmdb_id),
      // No public score at all: `final` is built on a neutral 50, so the UI
      // marks it and the "worth seeing" cut ignores it.
      noScores: pub.combined == null,
    },
    bestShowtime: best ? summarizeShowtime(best.s, movie, ctx.settings) : null,
    nextShowtime: nextBest ? summarizeShowtime(nextBest.s, movie, ctx.settings) : null,
    showtimesByDay: byDay,
    showtimeCount: sts.length,
    prerelease: prereleaseOf(movie, sts, ctx.now),
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

// Stats' three rankings and their drill-down sheets. Display only: they
// count films and average the user's own ratings plainly, and never touch the
// (recency-weighted) taste profile that scores the picks. The rankings and the
// sheets share GROUP_KEYS and statsRows(), so a sheet's films are exactly the
// films its row counted.
const TOP_SHOWN = 10;
export const parseList = (v) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) || []; } catch { return []; } };
const GROUP_KEYS = {
  genre: (r) => parseList(r.genres),
  director: (r) => [r.director],
  actor: (r) => parseList(r.cast),
};
const keysOf = (kind, r) => [...new Set(GROUP_KEYS[kind](r))].filter(Boolean);
// The recap (lib/year.js) counts the year's films by the same keys.
export const groupKeys = keysOf;
const average = (sum, n) => Math.round((sum / n) * 100) / 100;

function ranking(rows, kind) {
  const m = new Map();
  for (const r of rows) {
    for (const k of keysOf(kind, r)) {
      const e = m.get(k) || { n: 0, sum: 0 };
      e.n++;
      e.sum += Number(r.rating) || 0;
      m.set(k, e);
    }
  }
  return [...m].map(([name, e]) => ({ name, n: e.n, avg: average(e.sum, e.n) }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg || a.name.localeCompare(b.name));
}
// People: the top ten, plus everyone else with 2+ films for "Show all", so a
// big import doesn't list hundreds of one-film names. Ranked by films, so the
// 2+ people are always a prefix of the list.
const forPeople = (list) => list.slice(0, Math.max(TOP_SHOWN, list.filter((d) => d.n >= 2).length));

export const STATS_GROUP_KINDS = Object.keys(GROUP_KEYS);

// The films behind one Stats row, for the current user: highest rating first,
// then title. n and avg are computed exactly as the row's were.
export function getStatsGroup(kind, name) {
  const films = statsRows()
    .filter((r) => keysOf(kind, r).includes(name))
    .map((r) => ({
      tmdb_id: r.tmdb_id, title: r.title || `Movie ${r.tmdb_id}`, year: r.year ?? null, poster: r.poster || null, rating: Number(r.rating) || 0,
      // For the sheet's filter box, which matches people as well as titles.
      director: r.director || null, cast: parseList(r.cast),
    }))
    .sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title));
  const sum = films.reduce((s, f) => s + f.rating, 0);
  return { kind, name, n: films.length, avg: films.length ? average(sum, films.length) : 0, films };
}

export function getProfileSummary() {
  const profile = buildProfile(profileRows());
  const rows = statsRows();
  return {
    count: profile.count,
    confidence: confidence(profile),
    overall: Number(profile.overall.toFixed(2)),
    lowData: profile.count < 10,
    // Ranked by films rated, then the user's average rating, then name.
    topGenres: ranking(rows, 'genre'),
    topDirectors: forPeople(ranking(rows, 'director')),
    topActors: forPeople(ranking(rows, 'actor')),
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

// Was this movie among the weekly 4 at any point in the given A-List week?
// weekly4_log is written when a week's four locks and when a film joins it
// (lib/lock.js), never for a week that hasn't locked. Until this week's four
// locks, last week's is the one on screen, so it is asked about too.
export function wasWeekly4Pick(tmdbId, week = weekStartFriday()) {
  const logged = (w) => Boolean(get('SELECT 1 AS x FROM weekly4_log WHERE user_id = ? AND week_start = ? AND tmdb_id = ?', currentUserId(), w, tmdbId));
  return logged(week) || (!weekOpen(week) && logged(prevWeek(week)));
}

// Split the lineup: in the primary's schedule this week → ranked as always;
// only at another followed theatre → "Also nearby", never in the ranking.
// A movie with no showtimes anywhere (TMDB fallback) stays in the ranking.
function splitLineup(ctx, playing) {
  const hasWeek = (tid, id) => rowsAt(ctx, tid, id, { week: true }).length > 0;
  const main = [];
  const nearby = [];
  for (const m of playing) {
    if (hasWeek(ctx.primaryId, m.tmdb_id)) { main.push(m); continue; }
    const t = ctx.theatres.find((x) => !x.isPrimary && hasWeek(x.id, m.tmdb_id));
    if (t) nearby.push({ m, t });
    // Playing this week only at theatres other people follow: not this user's.
    else if (ctx.elsewhereThisWeek.has(m.tmdb_id)) continue;
    else main.push(m);
  }
  return { main, nearby };
}

// The films at the current user's theatres this week (the Picks page's list
// plus "Also nearby") and the Coming Soon films, for Stats' genre sheets.
// Read only: unlike getRecommendations it records nothing in weekly4_log.
export function userLineup() {
  const ctx = buildCtx();
  const { main, nearby } = splitLineup(ctx, all('SELECT * FROM movies WHERE playing = 1').map(hydrate));
  return {
    playing: [...main, ...nearby.map(({ m }) => m)],
    upcoming: all('SELECT * FROM movies WHERE upcoming = 1').map(hydrate),
  };
}

// "What should I watch?" (lib/suggest.js): every film at the user's theaters
// this week, scored exactly as the Picks page scores it (evaluate(), same
// context), with the movie record beside it. Read only: nothing is recorded.
export function scoredLineup() {
  const ctx = buildCtx();
  const { main, nearby } = splitLineup(ctx, all('SELECT * FROM movies WHERE playing = 1').map(hydrate));
  return [
    ...main.map((m) => ({ m, e: evaluate(m, ctx) })),
    ...nearby.map(({ m, t }) => ({ m, e: evaluate(m, ctx, t.id) })),
  ];
}

// Watchlist alerts (lib/watchalerts.js): the films in the user's Last chance
// right now, flagged exactly as the Picks page flags them (getLastChance on
// the primary theater, before the section's score bar and cap, the list the
// Watchlist page warns from), and the primary theater. Read only: nothing is
// recorded, no lock is made.
export function lastChanceNow() {
  const ctx = buildCtx();
  const { main } = splitLineup(ctx, all('SELECT * FROM movies WHERE playing = 1').map(hydrate));
  const { all: flagged } = getLastChance(main.map((m) => evaluate(m, ctx)).sort(byScore), ctx);
  return { theatre: ctx.theatres[0], ids: new Set(flagged.map((e) => e.tmdb_id)) };
}

// Does the film still have a showing this week (the next 7 days, not yet
// started) at any of the user's theaters? A film with no showtimes there at
// all is a TMDB-fallback film, playing on the lineup's word.
function stillShowing(ctx, tmdbId) {
  let any = false;
  for (const t of ctx.theatres) {
    const rows = rowsAt(ctx, t.id, tmdbId);
    if (rows.length) any = true;
    if (rows.some((s) => s.date <= ctx.weekEnd && (s.start_epoch ?? 0) >= ctx.now)) return true;
  }
  return !any;
}

// This week's four for the user in context (lib/lock.js has the rules). The
// lock is made from `eligible` in ranked order, which is exactly the four the
// live ranking would show at that moment; after that the four only changes
// by the rules below. The guest link reads the owner's lock and writes nothing.
function weeklyFour(ctx, { list, eligible, nearbyEval, guest, lockHow }) {
  const uid = currentUserId();
  const week = weekStartFriday(new Date(ctx.now));
  const at = new Date(ctx.now).toISOString();
  const unscored = () => list.filter((e) => e.flags.noScores).map((e) => e.tmdb_id);
  let lock = readLock(uid, week);
  let pending = false;
  if (!lock && weekOpen(week)) {
    lock = guest
      ? { user_id: uid, week_start: week, locked_at: at, how: 'preview', slots: eligible.slice(0, 4).map((e) => [{ tmdb_id: e.tmdb_id, via: 'lock' }]), unscored: unscored(), swapped_at: null, preview: true }
      : createLock(uid, week, eligible.slice(0, 4), unscored(), lockHow || 'first-view', at);
  }
  // Until this week's four lock, last week's stays up.
  if (!lock) { lock = readLock(uid, prevWeek(week)); pending = true; }
  // Nothing locked yet at all (someone brand new before Friday's refresh).
  if (!lock) return { four: eligible.slice(0, 4), meta: { week, pending: true, lockedAt: null } };

  const entries = new Map([...list, ...nearbyEval].map((e) => [e.tmdb_id, e]));
  const seenThisWeek = new Set(all('SELECT DISTINCT tmdb_id FROM watched WHERE user_id = ? AND watched_date >= ?', uid, lock.week_start).map((r) => r.tmdb_id));
  const out = (id) => ctx.rated.has(id) || ctx.hidden.has(id) || seenThisWeek.has(id) || !entries.has(id) || !stillShowing(ctx, id);
  // Each of the four places keeps its films in order, the locked one first.
  // A place shows the first of them that hasn't left (rated, marked seen,
  // hidden, no showtimes left). When all of a place's films have left, the
  // next best film by current score joins it. Undoing a rating, a Not for me
  // or a Mark seen brings the film back to its place.
  const slots = lock.slots.map((s) => s.slice());
  const shown = new Set();
  const pick = slots.map((stack) => {
    const e = stack.find((x) => !out(x.tmdb_id) && !shown.has(x.tmdb_id));
    if (e) shown.add(e.tmdb_id);
    return e || null;
  });
  const next = () => eligible.find((e) => !shown.has(e.tmdb_id) && !out(e.tmdb_id));
  for (let i = 0; i < 4; i++) {
    if (pick[i]) continue;
    const f = next();
    if (!f) break;
    const entry = { tmdb_id: f.tmdb_id, via: 'refill' };
    if (!slots[i]) slots[i] = [];
    slots[i].push(entry);
    pick[i] = entry;
    shown.add(f.tmdb_id);
  }
  // Once a week at most: a film unscored at the lock that now beats #4 by a
  // clear margin takes #4's place (at the front of that place's films).
  let swappedAt = null;
  if (!lock.swapped_at && pick.length === 4 && pick.every(Boolean)) {
    const fourth = entries.get(pick[3].tmdb_id);
    const wasUnscored = new Set(lock.unscored);
    const swap = fourth && eligible.find((e) => wasUnscored.has(e.tmdb_id) && !e.flags.noScores
      && !shown.has(e.tmdb_id) && !out(e.tmdb_id) && e.final - fourth.final >= SWAP_MARGIN);
    if (swap) {
      const entry = { tmdb_id: swap.tmdb_id, via: 'swap' };
      slots[3].unshift(entry);
      pick[3] = entry;
      swappedAt = at;
    }
  }
  const four = pick.filter(Boolean);
  if (!guest && !lock.preview && (swappedAt || JSON.stringify(slots) !== JSON.stringify(lock.slots))) saveLock(lock, slots, four, { swappedAt, at });
  return {
    four: four.map((p) => ({ ...entries.get(p.tmdb_id), pick: { via: p.via, newThisWeek: p.via === 'swap' } })),
    meta: { week: lock.week_start, lockedAt: lock.preview ? null : lock.locked_at, how: lock.how, pending },
  };
}

// lockHow: set by the refresh that locks everyone's four (lib/lock.js).
export function getRecommendations({ guest = false, lockHow = null } = {}) {
  const ctx = buildCtx({ guest });
  const playing = all('SELECT * FROM movies WHERE playing = 1').map(hydrate);
  const { main, nearby } = splitLineup(ctx, playing);

  const evaluated = main.map((m) => evaluate(m, ctx));
  const list = evaluated.sort(byScore);
  // Hidden films drop out here, so the next-best film moves up into the four.
  const eligible = list.filter((e) => !e.flags.seen && !e.flags.excluded && !e.flags.hidden);
  const nearbyEval = nearby.map(({ m, t }) => evaluate(m, ctx, t.id));
  const { four: weekly4, meta: lock } = weeklyFour(ctx, { list, eligible, nearbyEval, guest, lockHow });
  // Everything else that still clears the "good match" bar, so the picks page
  // isn't capped at four. Already-in-weekly4 movies are excluded, not repeated;
  // so are movies with no public score — their `final` rests on a default 50.
  const cutoff = Number(ctx.settings.goodMatchMinScore) || 0;
  const top4 = new Set(weekly4.map((e) => e.tmdb_id));
  const worthSeeing = eligible.filter((e) => !top4.has(e.tmdb_id) && e.final >= cutoff && !e.flags.noScores);
  const lastChance = getLastChance(list, ctx);

  const alsoNearby = nearbyEval
    .filter((e) => !e.flags.hidden && !top4.has(e.tmdb_id))
    .sort(byScore);

  const primary = ctx.theatres[0];
  return {
    weekly4,
    // Which week's four this is, when it locked, and whether it is still last
    // week's (Friday before the first good refresh).
    lock,
    worthSeeing,
    goodMatchMinScore: cutoff,
    // Published days the page's day picker can offer (primary theatre).
    days: dailyBreadth(ctx.today, ctx.primaryId).map((d) => ({ date: d.date, movies: d.movies, showtimes: d.showtimes })),
    list,
    alsoNearby,
    lastChance: lastChance.items,
    hiddenCount: list.filter((e) => e.flags.hidden).length + nearby.filter(({ m }) => ctx.hidden.has(m.tmdb_id)).length,
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
  const up = all('SELECT * FROM movies WHERE upcoming = 1').map(hydrate)
    .filter((m) => !ctx.hidden.has(m.tmdb_id));
  // Advance screenings at this user's theatres (or unfollowed leftovers), not
  // at theatres only other people follow.
  const advanceIds = new Set(
    all('SELECT DISTINCT tmdb_id, theatre_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date > ?', ctx.weekEnd)
      .filter((r) => !ctx.othersTheatres.has(r.theatre_id))
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
      why: reasonFacts({ pub, topTaste, conf: ctx.conf }),
    };
  });
  scored.sort((a, b) => Number(b.advance) - Number(a.advance) || b.predicted - a.predicted);
  return { list: scored, profile: { count: ctx.profile.count, lowData: ctx.profile.count < 10 } };
}

// Where a movie is scored: at the primary when it has the movie this week,
// else at the first followed theatre that does ("Also nearby"), so a movie
// page and Watch together agree with the Picks row for the same film.
function scoredAt(ctx, tmdbId) {
  const hasWeek = (tid) => rowsAt(ctx, tid, tmdbId, { week: true }).length > 0;
  return hasWeek(ctx.primaryId)
    ? ctx.primaryId
    : (ctx.theatres.find((t) => !t.isPrimary && hasWeek(t.id))?.id ?? ctx.primaryId);
}

// Watch together (lib/together.js): the current user's own match score for
// each film, the number their Picks and movie pages show, and whether they
// have already rated it, logged it as seen, or hidden it. Read only: nothing
// is written, so the weekly 4 and its log are untouched.
export function matchScores(tmdbIds) {
  const out = new Map();
  if (!tmdbIds.length) return out;
  const ctx = buildCtx();
  const movies = all(`SELECT * FROM movies WHERE tmdb_id IN (${tmdbIds.map(() => '?').join(',')})`, ...tmdbIds).map(hydrate);
  for (const m of movies) {
    const ev = evaluate(m, ctx, scoredAt(ctx, m.tmdb_id));
    out.set(m.tmdb_id, {
      final: ev.final,
      watchlisted: ctx.watch.has(m.tmdb_id),
      done: ctx.rated.has(m.tmdb_id) || ctx.watched.has(m.tmdb_id) || ctx.hidden.has(m.tmdb_id),
    });
  }
  return out;
}

export function getMovieDetail(tmdbId, { guest = false } = {}) {
  const m = getMovie(tmdbId);
  if (!m) return null;
  ensurePosterColor(tmdbId);
  const ctx = buildCtx({ guest });
  const ev = evaluate(m, ctx, scoredAt(ctx, tmdbId));

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
      // TMDB person ids, so the page can link each name to its person page.
      director_id: m.director_id ?? null,
      cast_ids: m.cast_ids || [],
      synopsis: m.synopsis || '',
      trailer_key: m.trailer_key || null,
      release_date: m.release_date || null,
      imdb_id: m.imdb_id || null,
    },
    final: ev.final,
    reason: ev.reason,
    why: ev.why,
    public: ev.public,
    taste: { ...ev.taste, ...tasteBreakdown(m, ctx.profile) },
    flags: ev.flags,
    prerelease: ev.prerelease,
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
