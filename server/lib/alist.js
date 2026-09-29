// Movie-plan usage tracker: logs watched movies, counts the plan's allowance
// (A-List by default; weeks reset Friday, monthly plans on the 1st), and
// computes money saved vs the monthly fee, or ticket spend with no plan.
import { run, get, all, getSettings } from '../db.js';
import { weekStartFriday, localYMD, round2 } from './util.js';
import { currentUserId } from './user.js';
import { planOf } from '../../public/js/plans.js';
import { filmDone } from './done.js';

// Everything here is the current user's log (lib/user.js). Films brought in
// from Letterboxd (source 'letterboxd', lib/letterboxd.js) are in the same
// table, so they count as seen, but never toward the A-List week or savings:
// a film logged on Letterboxd may not have been a ticket at all.
const ALIST = 'source IS NULL';

// At most one row per movie per local calendar day: the insert lands on the
// unique (tmdb_id, watched_date) index, so a double-press can't double-count.
// A rewatch on a later date is a new row as always. With an "I'm going" plan
// for today's showing of it that has started (lib/plans.js), the theater is
// known and saved with it.
export function logWatched({ tmdb_id, title, in_weekly4 = false }) {
  const settings = getSettings();
  const today = localYMD();
  const plan = get(
    'SELECT theatre_name FROM plans WHERE user_id = ? AND tmdb_id = ? AND date = ? AND start_epoch <= ?',
    currentUserId(), tmdb_id, today, Date.now(),
  );
  run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price, theatre)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    currentUserId(), tmdb_id, title, new Date().toISOString(), weekStartFriday(), today, in_weekly4, Number(settings.avgTicketPrice) || 0,
    plan?.theatre_name || null,
  );
  filmDone(currentUserId(), tmdb_id, 'seen');
  return getWeek();
}

// "I'm going", then Yes the next morning (lib/plans.js): the film logged on
// the day of the showing, at its start, at the plan's theater, and counted by
// the movie plan exactly as Mark seen counts it. `date` is the showtime's
// listed day.
export function logWatchedOn({ tmdb_id, title, date, at, in_weekly4 = false, theatre = null }) {
  const settings = getSettings();
  run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price, theatre)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    currentUserId(), tmdb_id, title, new Date(at).toISOString(), weekStartFriday(new Date(`${date}T12:00:00`)), date, in_weekly4, Number(settings.avgTicketPrice) || 0,
    theatre || null,
  );
  filmDone(currentUserId(), tmdb_id, 'seen');
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
export function restoreWatched({ tmdb_id, title, watched_at, in_weekly4 = false, price = null, source = null, theatre = null }) {
  const when = watched_at || new Date().toISOString();
  const settings = getSettings();
  const added = run(
    `INSERT INTO watched(user_id, tmdb_id, title, watched_at, week_start, watched_date, in_weekly4, ticket_price, source, theatre)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, tmdb_id, watched_date) DO NOTHING`,
    currentUserId(), tmdb_id, title, when, weekStartFriday(new Date(when)), localYMD(new Date(when)), in_weekly4,
    price ?? Number(settings.avgTicketPrice) ?? 0, source === 'letterboxd' ? 'letterboxd' : null,
    typeof theatre === 'string' && theatre.trim() ? theatre.trim().slice(0, 200) : null,
  ).changes > 0;
  if (added) filmDone(currentUserId(), tmdb_id, 'seen', when);
  return added;
}

// Months are local calendar months (the server's TZ, America/Indianapolis
// deployed), read from watched_date, the local day each film was logged on.
// watched_at is UTC, so a film logged on the evening of the 31st used to
// count toward the next month.
const localMonth = () => localYMD().slice(0, 7);

export function savings(settings = getSettings()) {
  const month = localMonth();
  const rows = all(`SELECT ticket_price FROM watched WHERE user_id = ? AND substr(watched_date, 1, 7) = ? AND ${ALIST}`, currentUserId(), month);
  const ticketValue = rows.reduce((s, r) => s + (Number(r.ticket_price) || Number(settings.avgTicketPrice) || 0), 0);
  // No subscription, no fee: "saved" is then just what the tickets cost.
  const fee = planOf(settings).subscription ? Number(settings.alistMonthlyFee) || 0 : 0;
  return {
    monthTickets: rows.length,
    ticketValue: round2(ticketValue),
    alistFee: fee,
    saved: round2(ticketValue - fee),
  };
}

// This period's usage under the user's movie plan (public/js/plans.js): the
// A-List week (Friday to Thursday) for a weekly plan, the calendar month for
// a monthly one. A limit of 0 means no limit, so nothing is "remaining".
export function getWeek() {
  const settings = getSettings();
  const plan = planOf(settings);
  const week = weekStartFriday();
  const month = localMonth(); // the same month savings() counts
  const byMonth = plan.subscription && plan.period === 'month';
  const rows = all(
    `SELECT w.*, m.poster FROM watched w LEFT JOIN movies m ON m.tmdb_id = w.tmdb_id
      WHERE w.user_id = ? AND ${byMonth ? 'substr(w.watched_date, 1, 7) = ?' : 'w.week_start = ?'} AND w.${ALIST} ORDER BY w.watched_at DESC`,
    currentUserId(), byMonth ? month : week,
  );
  const limit = plan.limit;
  return {
    weekStart: week,
    used: rows.length,
    limit,
    remaining: plan.unlimited ? null : Math.max(0, limit - rows.length),
    movies: rows.map((r) => ({
      id: r.id,
      tmdb_id: r.tmdb_id,
      title: r.title,
      poster: r.poster,
      watched_at: r.watched_at,
      in_weekly4: Boolean(r.in_weekly4),
    })),
    savings: savings(settings),
    plan,
  };
}
