// A-List usage tracker: logs watched movies, counts the 3/week allowance
// (weeks reset Friday), and computes money saved vs the monthly fee.
import { run, all, getSettings } from '../db.js';
import { weekStartFriday, localYMD, round2 } from './util.js';
import { currentUserId } from './user.js';

// Everything here is the current user's log (lib/user.js). Films brought in
// from Letterboxd (source 'letterboxd', lib/letterboxd.js) are in the same
// table, so they count as seen, but never toward the A-List week or savings:
// a film logged on Letterboxd may not have been a ticket at all.
const ALIST = 'source IS NULL';

// At most one row per movie per local calendar day: the insert lands on the
// unique (tmdb_id, watched_date) index, so a double-press can't double-count.
// A rewatch on a later date is a new row as always.
export function logWatched({ tmdb_id, title, in_weekly4 = false }) {
  const settings = getSettings();
  run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    currentUserId(), tmdb_id, title, new Date().toISOString(), weekStartFriday(), localYMD(), in_weekly4, Number(settings.avgTicketPrice) || 0,
  );
  return getWeek();
}

export function undoWatched(id) {
  run('DELETE FROM watched WHERE id = ? AND user_id = ?', id, currentUserId());
  return getWeek();
}

// Restore a watched row from a backup, preserving its original date. The
// per-day unique index does the de-duping — the same movie on the same local
// day (this exact row on a re-import, or a pre-fix double-log) is dropped —
// and the return says whether a row was actually inserted.
export function restoreWatched({ tmdb_id, title, watched_at, in_weekly4 = false, price = null, source = null }) {
  const when = watched_at || new Date().toISOString();
  const settings = getSettings();
  return run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price, source)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    currentUserId(), tmdb_id, title, when, weekStartFriday(new Date(when)), localYMD(new Date(when)), in_weekly4,
    price ?? Number(settings.avgTicketPrice) ?? 0, source === 'letterboxd' ? 'letterboxd' : null,
  ).changes > 0;
}

export function savings(settings = getSettings()) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC-ish, fine here)
  const rows = all(`SELECT ticket_price FROM watched WHERE user_id = ? AND substr(watched_at, 1, 7) = ? AND ${ALIST}`, currentUserId(), month);
  const ticketValue = rows.reduce((s, r) => s + (Number(r.ticket_price) || Number(settings.avgTicketPrice) || 0), 0);
  const fee = Number(settings.alistMonthlyFee) || 0;
  return {
    monthTickets: rows.length,
    ticketValue: round2(ticketValue),
    alistFee: fee,
    saved: round2(ticketValue - fee),
  };
}

export function getWeek() {
  const settings = getSettings();
  const week = weekStartFriday();
  const rows = all(
    `SELECT w.*, m.poster FROM watched w LEFT JOIN movies m ON m.tmdb_id = w.tmdb_id
      WHERE w.user_id = ? AND w.week_start = ? AND w.${ALIST} ORDER BY w.watched_at DESC`,
    currentUserId(), week,
  );
  const limit = Number(settings.alistWeeklyLimit) || 4;
  return {
    weekStart: week,
    used: rows.length,
    limit,
    remaining: Math.max(0, limit - rows.length),
    movies: rows.map((r) => ({
      id: r.id,
      tmdb_id: r.tmdb_id,
      title: r.title,
      poster: r.poster,
      watched_at: r.watched_at,
      in_weekly4: Boolean(r.in_weekly4),
    })),
    savings: savings(settings),
  };
}
