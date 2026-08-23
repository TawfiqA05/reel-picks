// "Last chance" detection: which movies are genuinely about to leave the
// theatre, separated from AMC simply not having published next week yet.
//
// The naive signal — "this movie has no showtimes past date X" — is useless on
// its own, because AMC posts roughly a week ahead: on any given day most of the
// lineup has an empty second week. Taking the furthest date *any* movie has
// showtimes as the horizon doesn't fix it either. A handful of advance/event
// tickets (a single Hunger Games screening, a one-night concert film) go on sale
// weeks out and drag that date far past the densely-scheduled part of the
// calendar, so every normal movie looks like it's leaving.
//
// Instead we compute a DENSITY horizon: walk forward from today while each day
// still has a normal-sized lineup, and stop where it collapses into that thin
// advance-sale tail. Only a movie whose last showtime falls meaningfully before
// that horizon is actually being dropped.
//
// Across refreshes we also record the lineup, which gives two more signals that
// need no inference: a movie that was here last refresh and is gone now has left
// (ground truth), and a movie whose schedule keeps shrinking while the horizon
// advances is being wound down (leading indicator).
import { run, all, get } from '../db.js';
import { getMovie } from './movies.js';
import { localYMD, round2 } from './util.js';

// Days sampled to establish what a "normal" day's lineup looks like. These are
// the nearest days, which AMC has certainly published in full.
const SAMPLE_DAYS = 3;
// Refreshes retained in lineup_snapshots (roughly one per day).
const KEEP_SNAPSHOTS = 30;
// Refreshes of history needed before the shrinkage signal is trusted.
const TREND_REFRESHES = 3;
// Schedule must have shrunk by this fraction across that history to count.
const TREND_COUNT_DROP = 0.4;
// If more than this share of the lineup flags, we're reading a publishing gap
// rather than an exodus — suppress the whole section instead of crying wolf.
export const MASS_EXODUS = 0.4;

// Same check, usable before any scoring: does this theatre's lineup look like
// a schedule mid-update? Runway badges hedge everything when it does.
export function lineupExodus({ today = localYMD(), theatreId = null, horizon, minGap = 3 } = {}) {
  if (!horizon) return { exodus: false, flagged: 0, lineup: 0 };
  const w = theatreWhere(theatreId);
  const rows = all(
    `SELECT tmdb_id, MAX(date) AS last_date FROM showtimes
      WHERE tmdb_id IS NOT NULL AND date >= ?${w.sql} GROUP BY tmdb_id`,
    today, ...w.params,
  );
  const flagged = rows.filter((r) => (daysApart(r.last_date, horizon) ?? 0) >= minGap).length;
  return { exodus: rows.length > 0 && flagged / rows.length > MASS_EXODUS, flagged, lineup: rows.length };
}

const asDate = (ymd) => new Date(`${ymd}T00:00:00`);

// Whole days between two YYYY-MM-DD strings (both parsed as local midnight, so
// DST never shifts the result).
export function daysApart(from, to) {
  if (!from || !to) return null;
  return Math.round((asDate(to) - asDate(from)) / 86400000);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Scope a showtimes query to one theatre. An empty id (no AMC theatre resolved
// yet) means "everything", which is what a single-theatre database holds.
function theatreWhere(theatreId) {
  return theatreId ? { sql: ' AND theatre_id = ?', params: [theatreId] } : { sql: '', params: [] };
}

// Movies and showtimes on each published date from today forward, for one
// theatre. Breadth is per theatre on purpose: a 12-screen AMC's normal day is
// a different number from a 17-screen one's, and judging either against a
// pooled figure would misread the smaller schedule as collapsing.
export function dailyBreadth(today = localYMD(), theatreId = null) {
  const w = theatreWhere(theatreId);
  return all(
    `SELECT date, COUNT(DISTINCT tmdb_id) AS movies, COUNT(*) AS showtimes
       FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ?${w.sql}
      GROUP BY date ORDER BY date`,
    today, ...w.params,
  );
}

// The last date the schedule is still densely published at one theatre.
// Everything past it is the advance-sale tail and tells us nothing about
// what's leaving.
//
// A day counts as published only if BOTH its movie count and its showtime
// count are at least `density` of a normal day's. Movie count alone is not
// enough: the advance-sale titles are the same half-dozen chain-wide, and at a
// small theatre with a 10-movie day those six are 60% of "normal", so the tail
// passed as published and every other movie looked like it was ending there.
// Showtime volume in the tail is 20-35% of normal everywhere, which separates
// it cleanly; requiring both can only move the horizon earlier (safer).
export function computeHorizon({ today = localYMD(), density = 0.5, theatreId = null } = {}) {
  const breadth = dailyBreadth(today, theatreId);
  const base = {
    theatreId, horizon: null, furthest: null, reference: 0, threshold: 0,
    referenceShowtimes: 0, thresholdShowtimes: 0, breadth, publishedDays: 0,
  };
  if (!breadth.length) return base;

  const furthest = breadth[breadth.length - 1].date;
  // Median (not max) of the nearest days, so one unusually busy day can't
  // inflate what counts as normal.
  const sample = breadth.slice(0, SAMPLE_DAYS);
  const reference = median(sample.map((r) => r.movies));
  const referenceShowtimes = median(sample.map((r) => r.showtimes));
  const threshold = reference * density;
  const thresholdShowtimes = referenceShowtimes * density;

  // Walk forward while the lineup still looks normally populated; the first day
  // that collapses marks the end of the real schedule.
  let horizon = breadth[0].date;
  let publishedDays = 0;
  for (const row of breadth) {
    if (row.movies < threshold || row.showtimes < thresholdShowtimes) break;
    horizon = row.date;
    publishedDays++;
  }
  return {
    theatreId, horizon, furthest, reference, threshold: round2(threshold),
    referenceShowtimes, thresholdShowtimes: round2(thresholdShowtimes), breadth, publishedDays,
  };
}

// Record one theatre's current lineup and diff it against that theatre's
// previous refresh.
export function snapshotLineup({
  today = localYMD(), horizonInfo = null, at = new Date().toISOString(), theatreId = null,
} = {}) {
  const info = horizonInfo || computeHorizon({ today, theatreId });
  const tid = theatreId || '';
  const w = theatreWhere(theatreId);
  const rows = all(
    `SELECT tmdb_id, MAX(date) AS last_date, COUNT(*) AS showtime_count
       FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ?${w.sql} GROUP BY tmdb_id`,
    today, ...w.params,
  );

  const prevAt = get(
    'SELECT refresh_at FROM lineup_snapshots WHERE theatre_id = ? ORDER BY refresh_at DESC LIMIT 1', tid,
  )?.refresh_at || null;
  const prev = prevAt
    ? new Map(all(
      'SELECT tmdb_id, last_date FROM lineup_snapshots WHERE refresh_at = ? AND theatre_id = ?', prevAt, tid,
    ).map((r) => [r.tmdb_id, r]))
    : new Map();

  for (const r of rows) {
    run(
      `INSERT INTO lineup_snapshots(refresh_at, tmdb_id, theatre_id, last_date, showtime_count, horizon, gap_days)
       VALUES(?,?,?,?,?,?,?)`,
      at, r.tmdb_id, tid, r.last_date, r.showtime_count, info.horizon, daysApart(r.last_date, info.horizon),
    );
  }

  // Present last refresh, absent now → it actually left. No inference needed.
  const nowIds = new Set(rows.map((r) => r.tmdb_id));
  const departed = [];
  for (const [id, was] of prev) {
    if (nowIds.has(id)) continue;
    const title = getMovie(id)?.title || null;
    run(
      `INSERT INTO departures(tmdb_id, theatre_id, title, last_date, departed_at) VALUES(?,?,?,?,?)
       ON CONFLICT(tmdb_id, theatre_id) DO UPDATE SET
         title = excluded.title, last_date = excluded.last_date, departed_at = excluded.departed_at`,
      id, tid, title, was.last_date || null, at,
    );
    departed.push({ tmdb_id: id, title, last_date: was.last_date || null });
  }
  // A title that came back (re-release, extended run) is no longer departed.
  for (const id of nowIds) run('DELETE FROM departures WHERE tmdb_id = ? AND theatre_id = ?', id, tid);

  run(
    `DELETE FROM lineup_snapshots WHERE refresh_at NOT IN
       (SELECT refresh_at FROM (SELECT DISTINCT refresh_at FROM lineup_snapshots
         ORDER BY refresh_at DESC LIMIT ?))`,
    KEEP_SNAPSHOTS,
  );

  return { at, prevAt, movies: rows.length, departed, horizon: info.horizon, theatreId: tid };
}

// Leading indicator: is this movie's schedule at this theatre shrinking while
// the rest of the lineup moves on? Needs a few refreshes of history first.
export function movieTrend(tmdbId, theatreId = null) {
  const snaps = all(
    'SELECT * FROM lineup_snapshots WHERE tmdb_id = ? AND theatre_id = ? ORDER BY refresh_at DESC LIMIT ?',
    tmdbId, theatreId || '', TREND_REFRESHES,
  );
  if (snaps.length < TREND_REFRESHES) {
    return { enoughHistory: false, shrinking: false, refreshes: snaps.length };
  }
  const cur = snaps[0];
  const oldest = snaps[snaps.length - 1];
  // Gap widening means the horizon advanced but this movie's last date didn't.
  const gapGrowing = (cur.gap_days ?? 0) > (oldest.gap_days ?? 0);
  const countDrop = oldest.showtime_count > 0
    ? 1 - cur.showtime_count / oldest.showtime_count
    : 0;
  return {
    enoughHistory: true,
    shrinking: gapGrowing && countDrop >= TREND_COUNT_DROP,
    gapGrowing,
    countDrop: round2(countDrop),
    refreshes: snaps.length,
  };
}

export function departures(theatreId = null) {
  if (theatreId == null) return all('SELECT * FROM departures ORDER BY departed_at DESC');
  return all('SELECT * FROM departures WHERE theatre_id = ? ORDER BY departed_at DESC', theatreId || '');
}

function labels(lastDate, today) {
  const daysLeft = daysApart(today, lastDate) ?? 0;
  const weekday = asDate(lastDate).toLocaleDateString('en-US', { weekday: 'long' });
  return {
    daysLeft,
    lastLabel: daysLeft <= 0 ? 'Last showtime today'
      : daysLeft === 1 ? 'Last showtime tomorrow'
      : `Last showtime ${weekday}`,
    leftLabel: daysLeft <= 0 ? 'Gone after today'
      : daysLeft === 1 ? '1 day left'
      : `${daysLeft} days left`,
    urgency: daysLeft <= 1 ? 'urgent' : daysLeft <= 3 ? 'soon' : '',
  };
}

// Build the "Last chance" section from already-evaluated lineup entries. It is
// about the PRIMARY theatre only: its horizon, its schedule, its history.
// Returns { items, all, diagnostics } — `items` is the capped, score-filtered
// section; `all` is every flagged movie (used by the watchlist alert).
export function getLastChance(entries, ctx) {
  const s = ctx.settings;
  const minScore = Number(s.lastChanceMinScore) || 0;
  const minGap = Number(s.lastChanceMinGapDays) || 3;
  const maxEntries = Number(s.lastChanceMaxEntries) || 3;
  const tid = ctx.primaryId || null;
  const info = ctx.horizons?.get(ctx.primaryId)
    || computeHorizon({ today: ctx.today, density: Number(s.lastChanceDensity) || 0.5, theatreId: tid });

  const diagnostics = {
    theatre: ctx.theatres?.[0] ? { id: ctx.theatres[0].id, name: ctx.theatres[0].name, short: ctx.theatres[0].short } : null,
    horizon: info.horizon,
    furthestShowtime: info.furthest,
    typicalDailyLineup: info.reference,
    breadthThreshold: info.threshold,
    typicalDailyShowtimes: info.referenceShowtimes,
    showtimeThreshold: info.thresholdShowtimes,
    publishedDays: info.publishedDays,
    minScore, minGapDays: minGap,
    lineupSize: 0, flaggedTotal: 0, flagged: [], suppressed: null,
  };
  if (!info.horizon) {
    diagnostics.suppressed = 'no showtime data';
    return { items: [], all: [], diagnostics };
  }

  const w = theatreWhere(tid);
  const sched = new Map(
    all(
      `SELECT tmdb_id, MAX(date) AS last_date, COUNT(*) AS n FROM showtimes
        WHERE tmdb_id IS NOT NULL AND date >= ?${w.sql} GROUP BY tmdb_id`,
      ctx.today, ...w.params,
    ).map((r) => [r.tmdb_id, r]),
  );
  diagnostics.lineupSize = sched.size;

  const flagged = [];
  for (const e of entries) {
    const row = sched.get(e.tmdb_id);
    if (!row) continue;
    const gap = daysApart(row.last_date, info.horizon) ?? 0;
    const trend = movieTrend(e.tmdb_id, tid);
    const byHorizon = gap >= minGap;
    // Shrinking schedules count too, but only once they've already fallen behind
    // the horizon by a day — otherwise a normal week-to-week dip would flag.
    const byTrend = !byHorizon && gap >= 1 && trend.shrinking;
    if (!byHorizon && !byTrend) continue;
    flagged.push({ e, row, gap, trend, signal: byHorizon ? 'horizon' : 'shrinking' });
  }
  diagnostics.flaggedTotal = flagged.length;
  diagnostics.flagged = flagged.map((f) => ({
    title: f.e.title, last_date: f.row.last_date, gap_days: f.gap,
    showtimes: f.row.n, score: f.e.final, signal: f.signal,
  }));

  // The check the whole feature exists for: if most of the lineup looks like
  // it's leaving, the schedule just isn't published yet.
  if (sched.size && flagged.length / sched.size > MASS_EXODUS) {
    diagnostics.suppressed =
      `${flagged.length}/${sched.size} of the lineup flagged — reading this as an unpublished schedule, not departures`;
    return { items: [], all: [], diagnostics };
  }

  const shape = (f) => ({
    ...f.e,
    lastDate: f.row.last_date,
    showtimesLeft: f.row.n,
    signal: f.signal,
    watchlisted: Boolean(f.e.flags?.watchlisted),
    ...labels(f.row.last_date, ctx.today),
  });

  const all_ = flagged
    .sort((a, b) => Number(b.e.flags?.watchlisted) - Number(a.e.flags?.watchlisted)
      || a.row.last_date.localeCompare(b.row.last_date)
      || b.e.final - a.e.final)
    .map(shape);

  // The score bar is judged WITHOUT the urgency boost: everything here is
  // leaving by definition, so urgency would lower the bar for exactly these.
  const items = all_
    .filter((m) => !m.flags?.seen && !ctx.watched.has(m.tmdb_id) && !m.flags?.excluded)
    .filter((m) => (m.finalBeforeUrgency ?? m.final) >= minScore)
    .slice(0, maxEntries);

  return { items, all: all_, diagnostics };
}
