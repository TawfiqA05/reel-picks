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
// week, or by the last retry of a failing one (lib/refresh.js).
export function weekOpen(week = weekStartFriday()) {
  const open = getSetting('lockWeek');
  return Boolean(open) && open >= week;
}

// Once, on a database from before the lock: the week of its last refresh is
// open, so the four locks at first view instead of waiting for Friday.
export function initLockWeek() {
  if (getSetting('lockWeek')) return;
  const last = getSetting('lastRefresh');
  if (last) setSetting('lockWeek', weekStartFriday(new Date(last)));
}

function openWeek(week) {
  const open = getSetting('lockWeek');
  if (!open || open < week) setSetting('lockWeek', week);
}

// picks is stored as the four places, each a list of films in order: the
// locked one first, then any that took the place later (lib/recommend.js
// shows the first that hasn't left). `picks` below is what each place
// started with.
export function readLock(userId, week) {
  const r = get('SELECT * FROM weekly4_lock WHERE user_id = ? AND week_start = ?', userId, week);
  if (!r) return null;
  let slots = []; let unscored = [];
  try { slots = (JSON.parse(r.picks) || []).map((s) => (Array.isArray(s) ? s : [s])); } catch { slots = []; }
  try { unscored = JSON.parse(r.unscored) || []; } catch { unscored = []; }
  return { ...r, slots, picks: slots.map((s) => s[0]).filter(Boolean), unscored };
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
    userId, week, at, how, JSON.stringify(rows.map((p) => [p])), JSON.stringify(unscored),
  ).changes;
  if (made) logPicks(userId, week, rows, at);
  return readLock(userId, week);
}

// After a film joined a place midweek: the places, the swap if one happened,
// and a log row for each film shown that the log doesn't have yet.
export function saveLock(lock, slots, shown, { swappedAt = null, at }) {
  run('UPDATE weekly4_lock SET picks = ?, swapped_at = COALESCE(swapped_at, ?) WHERE user_id = ? AND week_start = ?',
    JSON.stringify(slots), swappedAt, lock.user_id, lock.week_start);
  logPicks(lock.user_id, lock.week_start, shown, at);
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
