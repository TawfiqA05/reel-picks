// A-List usage tracker: logs watched movies, counts the 3/week allowance
// (weeks reset Friday), and computes money saved vs the monthly fee.
import { run, all, get, getSettings } from '../db.js';
import { weekStartFriday, round2 } from './util.js';

export function logWatched({ tmdb_id, title, in_weekly4 = false }) {
  const settings = getSettings();
  run(
    'INSERT INTO watched(tmdb_id, title, watched_at, week_start, in_weekly4, ticket_price) VALUES(?,?,?,?,?,?)',
    tmdb_id, title, new Date().toISOString(), weekStartFriday(), in_weekly4, Number(settings.avgTicketPrice) || 0,
  );
  return getWeek();
}

export function undoWatched(id) {
  run('DELETE FROM watched WHERE id = ?', id);
  return getWeek();
}

// Restore a watched row from a backup, preserving its original date. De-dupes on
// (tmdb_id, watched_at) so re-importing the same backup doesn't double-count.
export function restoreWatched({ tmdb_id, title, watched_at, in_weekly4 = false, price = null }) {
  const when = watched_at || new Date().toISOString();
  if (get('SELECT 1 AS x FROM watched WHERE tmdb_id = ? AND watched_at = ?', tmdb_id, when)) return false;
  const settings = getSettings();
  run(
    'INSERT INTO watched(tmdb_id, title, watched_at, week_start, in_weekly4, ticket_price) VALUES(?,?,?,?,?,?)',
    tmdb_id, title, when, weekStartFriday(new Date(when)), in_weekly4, price ?? Number(settings.avgTicketPrice) ?? 0,
  );
  return true;
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
  const limit = 3;
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
