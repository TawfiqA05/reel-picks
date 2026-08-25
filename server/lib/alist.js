// A-List usage tracker: logs watched movies, counts the 3/week allowance
// (weeks reset Friday), and computes money saved vs the monthly fee.
import { run, all, getSettings } from '../db.js';
import { weekStartFriday, localYMD, round2 } from './util.js';

// At most one row per movie per local calendar day: the insert lands on the
// unique (tmdb_id, watched_date) index, so a double-press can't double-count.
// A rewatch on a later date is a new row as always.
export function logWatched({ tmdb_id, title, in_weekly4 = false }) {
  const settings = getSettings();
  run(
    `INSERT INTO watched(tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(tmdb_id, watched_date) DO NOTHING`,
    tmdb_id, title, new Date().toISOString(), weekStartFriday(), localYMD(), in_weekly4, Number(settings.avgTicketPrice) || 0,
  );
  return getWeek();
}

export function undoWatched(id) {
  run('DELETE FROM watched WHERE id = ?', id);
  return getWeek();
}

// Restore a watched row from a backup, preserving its original date. The
// per-day unique index does the de-duping — the same movie on the same local
// day (this exact row on a re-import, or a pre-fix double-log) is dropped —
// and the return says whether a row was actually inserted.
export function restoreWatched({ tmdb_id, title, watched_at, in_weekly4 = false, price = null }) {
  const when = watched_at || new Date().toISOString();
  const settings = getSettings();
  return run(
    `INSERT INTO watched(tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(tmdb_id, watched_date) DO NOTHING`,
    tmdb_id, title, when, weekStartFriday(new Date(when)), localYMD(new Date(when)), in_weekly4,
    price ?? Number(settings.avgTicketPrice) ?? 0,
  ).changes > 0;
}

export function savings(settings = getSettings()) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC-ish, fine here)
  const rows = all("SELECT ticket_price FROM watched WHERE substr(watched_at, 1, 7) = ?", month);
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
      WHERE w.week_start = ? ORDER BY w.watched_at DESC`,
    week,
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
