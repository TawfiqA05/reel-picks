// The weekly four, locked. Each person's four is fixed once a week, at the
// first good refresh of the A-List week (Friday's, normally), and kept in
// weekly4_lock. Until the new week's four lock, the previous week's stays on
// screen. Midweek a film leaves only when that person rates it, marks it seen,
// taps Not for me, or it has no showtimes left this week at their theaters;
// the next best film by current score takes the free place (lib/recommend.js
// applies these rules each time the four is read). One exception, once a week
// at most: a film that had no public score when the four locked (the
// thin-rating rule) and has since earned one replaces #4 if it now beats #4 by
// SWAP_MARGIN or more. It is tagged "New this week".
//
// weekly4_log (the hit-rate's record of what was offered) is written from
// here only: the four when it locks, and each film that joins it later.
import { get, run, getSetting, setSetting } from '../db.js';
import { runAs } from './user.js';
import { weekStartFriday, addDays, localYMD } from './util.js';
import { activeUserIds } from './theatres.js';

// Points on the 0-100 match score. Chosen from the real spread: adjacent
// films in the top eight sit 0-3 points apart (median 1), and #1 to #4 spans
// 5-9 points, so 5 is past ordinary drift and enough to put the film at or
// near the top of that person's four.
export const SWAP_MARGIN = 5;

export const prevWeek = (week) => localYMD(addDays(new Date(`${week}T12:00:00`), -7));

// The newest week whose four may lock. Set by the first good refresh in that
// week, or by the last retry of a failing one (lib/refresh.js). Before this
// existed, a refresh this week counts.
export function weekOpen(week = weekStartFriday()) {
  const open = getSetting('lockWeek');
  if (open) return open >= week;
  const last = getSetting('lastRefresh');
  return Boolean(last) && weekStartFriday(new Date(last)) >= week;
}

export function openWeek(week) {
  const open = getSetting('lockWeek');
  if (!open || open < week) setSetting('lockWeek', week);
}

export function readLock(userId, week) {
  const r = get('SELECT * FROM weekly4_lock WHERE user_id = ? AND week_start = ?', userId, week);
  if (!r) return null;
  let picks = []; let unscored = [];
  try { picks = JSON.parse(r.picks) || []; } catch { picks = []; }
  try { unscored = JSON.parse(r.unscored) || []; } catch { unscored = []; }
  return { ...r, picks, unscored };
}

function logPicks(userId, week, picks, at) {
  picks.forEach((p, i) => run(
    `INSERT INTO weekly4_log(user_id, week_start, tmdb_id, rank, first_seen_at)
      VALUES(?,?,?,?,?) ON CONFLICT(user_id, week_start, tmdb_id) DO NOTHING`,
    userId, week, p.tmdb_id, i + 1, at,
  ));
}

// Locks a four (the caller's ranked picks) and logs it. A lock that already
// exists wins, so two requests at once can't lock twice.
export function createLock(userId, week, picks, unscored, how, at) {
  const rows = picks.map((p) => ({ tmdb_id: p.tmdb_id, via: 'lock' }));
  const made = run(
    `INSERT INTO weekly4_lock(user_id, week_start, locked_at, how, picks, unscored, swapped_at)
      VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(user_id, week_start) DO NOTHING`,
    userId, week, at, how, JSON.stringify(rows), JSON.stringify(unscored),
  ).changes;
  if (made) logPicks(userId, week, rows, at);
  return readLock(userId, week);
}

// After the four changed midweek: the new list, the swap if one happened, and
// a log row for every film that joined.
export function saveLock(lock, picks, { swappedAt = null, at }) {
  run('UPDATE weekly4_lock SET picks = ?, swapped_at = COALESCE(swapped_at, ?) WHERE user_id = ? AND week_start = ?',
    JSON.stringify(picks), swappedAt, lock.user_id, lock.week_start);
  const had = new Set(lock.picks.map((p) => p.tmdb_id));
  const joined = picks.filter((p) => !had.has(p.tmdb_id));
  if (joined.length) {
    joined.forEach((p) => run(
      `INSERT INTO weekly4_log(user_id, week_start, tmdb_id, rank, first_seen_at)
        VALUES(?,?,?,?,?) ON CONFLICT(user_id, week_start, tmdb_id) DO NOTHING`,
      lock.user_id, lock.week_start, p.tmdb_id, picks.indexOf(p) + 1, at,
    ));
  }
}

// Opens the week and locks everyone's four now (the refresh that made the
// week's lineup, or the kept lineup after the last failed retry). `read` is
// getRecommendations, passed in so this module doesn't import recommend.js.
export function lockEveryone(week, how, read) {
  openWeek(week);
  for (const uid of activeUserIds()) {
    try {
      runAs(uid, () => read({ lockHow: how }));
    } catch (e) {
      console.error(`[lock] user ${uid}: ${e.message}`);
    }
  }
}
