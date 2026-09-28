// "I'm going": one plan per person per film, the showing they're going to.
// Picking another showing of the same film moves the plan; they can cancel it
// any time. Two hours before the showing a reminder push goes out (none when
// the plan was made with less than two hours left), and the next morning at
// 10 a push and a card at the top of Picks ask "Did you see <film>?". Yes
// logs the film seen on the showing's own day, the way Mark seen logs it; No
// takes the plan away. With no answer the card stays three days, then the
// plan goes. Seeing or rating the film any other way takes the plan and its
// question away too (lib/done.js).
//
// Who sees a plan: whoever made it. Beyond that only the pairs Watch
// together allows (lib/together.js): the owner sees the plans of friends who
// switched Together on, and such a friend sees the owner's. Never friend to
// friend, and nobody's without Together on. The guest link can't reach any of
// this (lib/guest.js allowlist). Pushes go only to the plan's own maker.
//
// The jobs (runPlanJobs) look at the plans table on every tick, so a restart
// carries on where it left off. Each push is claimed (reminded_at, asked_at)
// before it goes out, so none is ever sent twice, and a cancelled plan has no
// row left to send for. Nothing here touches a score or a pick.
import { get, all, run, getSettings } from '../db.js';
import { followedTheatres, shortName } from './theatres.js';
import { isOptedIn } from './together.js';
import { OWNER_ID, currentUserId } from './user.js';
import { ownerName } from './guest.js';
import { pushEnabled, sendToUser } from './push.js';
import { logWatchedOn } from './alist.js';
import { wasWeekly4Pick, getRecommendations } from './recommend.js';
import { localYMD, addDays, timeLabel, weekStartFriday } from './util.js';

export const REMIND_BEFORE_MS = 2 * 3600 * 1000;
export const ASK_HOUR = 10;
export const ASK_DAYS = 3;
const DAY_MS = 24 * 3600 * 1000;

const status = (code, message) => Object.assign(new Error(message), { status: code });

// 10am local on the day after the showing's listed day.
export function askAt(date) {
  const next = localYMD(addDays(new Date(`${date}T12:00:00`), 1));
  return new Date(`${next}T${String(ASK_HOUR).padStart(2, '0')}:00:00`).getTime();
}

// "Tonight", "Today", "Tomorrow", "Sat", or "Oct 3" for a showing, from its
// listed day and start, as the app words it everywhere.
export function dayWord(date, startLocal, now = Date.now()) {
  const today = localYMD(new Date(now));
  const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS);
  const hour = Number(String(startLocal).match(/T(\d\d)/)?.[1] ?? 0);
  if (days === 0) return hour >= 17 ? 'Tonight' : 'Today';
  if (days === 1) return 'Tomorrow';
  const d = new Date(`${date}T12:00:00`);
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shape(p, now) {
  const m = get('SELECT poster, year FROM movies WHERE tmdb_id = ?', p.tmdb_id);
  return {
    tmdb_id: p.tmdb_id,
    title: p.title || `Movie ${p.tmdb_id}`,
    year: m?.year ?? null,
    poster: m?.poster || null,
    showtime_id: p.showtime_id,
    date: p.date,
    time: timeLabel(p.start_local),
    start_local: p.start_local,
    start_epoch: p.start_epoch,
    theatre: shortName(p.theatre_name) || '',
    started: p.start_epoch <= now,
    // The morning question is up (10am the day after, for three days).
    ask: p.ask_at <= now && now < p.expires_at,
  };
}

// The caller's plans that haven't lapsed, soonest first.
export function myPlans(userId, now = Date.now()) {
  return all('SELECT * FROM plans WHERE user_id = ? AND expires_at > ? ORDER BY start_epoch', userId, now).map((p) => shape(p, now));
}

// Other people's plans the caller may see, for showings still to come: the
// owner sees opted-in friends', an opted-in friend sees the owner's, and
// nobody else sees anybody's. Each carries the name and the when, nothing
// that identifies an account.
export function othersPlans(me, now = Date.now()) {
  let rows = [];
  if (me.isOwner) {
    rows = all(`SELECT p.*, u.name FROM plans p JOIN users u ON u.id = p.user_id
      WHERE p.user_id != ? AND u.revoked_at IS NULL AND p.start_epoch > ? ORDER BY p.start_epoch`, OWNER_ID, now)
      .filter((p) => isOptedIn(p.user_id));
  } else if (!me.guest && isOptedIn(me.userId)) {
    rows = all('SELECT * FROM plans WHERE user_id = ? AND start_epoch > ? ORDER BY start_epoch', OWNER_ID, now)
      .map((p) => ({ ...p, name: ownerName() }));
  }
  return rows.map((p) => ({
    tmdb_id: p.tmdb_id,
    name: p.name,
    date: p.date,
    time: timeLabel(p.start_local),
    start_local: p.start_local,
    start_epoch: p.start_epoch,
    theatre: shortName(p.theatre_name) || '',
  }));
}

// Make or move the caller's plan for this showtime's film. Only a showing
// still to come, at a theater the caller follows; anything else is the same
// 404 as a made-up id (a started one says so).
export function planShowtime(userId, showtimeId, now = Date.now()) {
  const id = typeof showtimeId === 'string' || typeof showtimeId === 'number' ? String(showtimeId).slice(0, 200) : '';
  const s = id ? get('SELECT * FROM showtimes WHERE id = ?', id) : null;
  const theatre = s && followedTheatres(getSettings({ userId })).find((t) => t.id === String(s.theatre_id));
  if (!s || !s.tmdb_id || !theatre || !s.start_local || !Number.isFinite(s.start_epoch)) throw status(404, 'Showtime not found');
  if (s.start_epoch <= now) throw status(409, 'That showing has already started.');
  const had = get('SELECT showtime_id FROM plans WHERE user_id = ? AND tmdb_id = ?', userId, s.tmdb_id);
  const title = get('SELECT title FROM movies WHERE tmdb_id = ?', s.tmdb_id)?.title || null;
  const ask = askAt(s.date);
  run(
    `INSERT INTO plans(user_id, tmdb_id, showtime_id, theatre_id, theatre_name, date, start_local, start_epoch, title, created_at, remind_at, reminded_at, ask_at, asked_at, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?)
      ON CONFLICT(user_id, tmdb_id) DO UPDATE SET
        showtime_id = excluded.showtime_id, theatre_id = excluded.theatre_id, theatre_name = excluded.theatre_name,
        date = excluded.date, start_local = excluded.start_local, start_epoch = excluded.start_epoch, title = excluded.title,
        created_at = excluded.created_at, remind_at = excluded.remind_at, reminded_at = NULL,
        ask_at = excluded.ask_at, asked_at = NULL, expires_at = excluded.expires_at`,
    userId, s.tmdb_id, s.id, String(s.theatre_id), theatre.name, s.date, s.start_local, s.start_epoch, title,
    new Date(now).toISOString(), s.start_epoch - now >= REMIND_BEFORE_MS ? s.start_epoch - REMIND_BEFORE_MS : null,
    ask, ask + ASK_DAYS * DAY_MS,
  );
  const plan = get('SELECT * FROM plans WHERE user_id = ? AND tmdb_id = ?', userId, s.tmdb_id);
  return { plan: shape(plan, now), moved: Boolean(had && had.showtime_id !== s.id), was: had ? had.showtime_id : null };
}

export function cancelPlan(userId, tmdbId) {
  return { cancelled: run('DELETE FROM plans WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId).changes > 0 };
}

// Yes or No to "Did you see it?", once the showing has started. Yes logs the
// film seen on the showing's day, weekly-4 flag from that week's log (never a
// recomputed ranking), which also takes the plan away (lib/done.js). No just
// takes it away. Runs as the caller (lib/user.js).
export function answerPlan(tmdbId, seen, now = Date.now()) {
  const userId = currentUserId();
  const p = get('SELECT * FROM plans WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId);
  if (!p || p.expires_at <= now) throw status(404, 'No plan for that film.');
  if (p.start_epoch > now) throw status(409, 'That showing hasn\'t started yet.');
  if (!seen) {
    cancelPlan(userId, tmdbId);
    return { seen: false };
  }
  const week = weekStartFriday(new Date(`${p.date}T12:00:00`));
  let inWeekly4 = wasWeekly4Pick(tmdbId, week);
  if (!inWeekly4 && week === weekStartFriday(new Date(now))) {
    // The same fallback as Mark seen: this week's four may not be recorded
    // yet if Picks hasn't been opened. Still a log read.
    try { getRecommendations(); } catch { /* the first lookup answered */ }
    inWeekly4 = wasWeekly4Pick(tmdbId, week);
  }
  const alist = logWatchedOn({ tmdb_id: tmdbId, title: p.title, date: p.date, at: p.start_epoch, in_weekly4: inWeekly4 });
  cancelPlan(userId, tmdbId);
  return { seen: true, date: p.date, alist };
}

// ---- the jobs -----------------------------------------------------------

function reminderMessage(p, now) {
  const when = dayWord(p.date, p.start_local, now);
  const where = shortName(p.theatre_name);
  return {
    title: `${p.title || 'Your movie'} at ${timeLabel(p.start_local)}`,
    body: `${when}${where ? ` at ${where}` : ''}. You said you're going.`,
    url: `/#/movie/${p.tmdb_id}`,
    tag: `plan-${p.tmdb_id}`,
  };
}

function questionMessage(p) {
  return {
    title: `Did you see ${p.title || 'your movie'}?`,
    body: 'Tap to answer yes or no.',
    url: '/#/home',
    tag: `plan-ask-${p.tmdb_id}`,
  };
}

let running = false;

// One pass: due reminders, due morning questions, and plans nobody answered
// for three days. Called every minute and at start-up (server/index.js).
export async function runPlanJobs(now = Date.now()) {
  const summary = { reminders: 0, skipped: 0, questions: 0, expired: 0, pushed: 0 };
  if (running) return { ...summary, busy: true };
  running = true;
  try {
    summary.expired = run('DELETE FROM plans WHERE expires_at <= ?', now).changes;
    if (!pushEnabled()) return summary;
    const live = `JOIN users u ON u.id = p.user_id AND u.revoked_at IS NULL`;
    // Reminders. One whose showing has already started (the server was down
    // at the time) is marked done and never sent.
    for (const p of all(`SELECT p.* FROM plans p ${live} WHERE p.remind_at IS NOT NULL AND p.remind_at <= ? AND p.reminded_at IS NULL`, now)) {
      const late = p.start_epoch <= now;
      const claimed = run(
        'UPDATE plans SET reminded_at = ? WHERE user_id = ? AND tmdb_id = ? AND showtime_id = ? AND reminded_at IS NULL',
        late ? `skipped ${new Date(now).toISOString()}` : new Date(now).toISOString(), p.user_id, p.tmdb_id, p.showtime_id,
      ).changes;
      if (!claimed) continue;
      if (late) { summary.skipped++; continue; }
      summary.reminders++;
      summary.pushed += (await sendToUser(p.user_id, reminderMessage(p, now), { topic: 'plan-reminder' })).sent;
    }
    for (const p of all(`SELECT p.* FROM plans p ${live} WHERE p.ask_at <= ? AND p.expires_at > ? AND p.asked_at IS NULL`, now, now)) {
      const claimed = run(
        'UPDATE plans SET asked_at = ? WHERE user_id = ? AND tmdb_id = ? AND showtime_id = ? AND asked_at IS NULL',
        new Date(now).toISOString(), p.user_id, p.tmdb_id, p.showtime_id,
      ).changes;
      if (!claimed) continue;
      summary.questions++;
      summary.pushed += (await sendToUser(p.user_id, questionMessage(p), { topic: 'plan-question' })).sent;
    }
    if (summary.reminders || summary.questions) console.log(`  🎟  Plans: ${summary.reminders} reminder(s), ${summary.questions} morning question(s), ${summary.pushed} push(es) delivered.`);
    return summary;
  } finally {
    running = false;
  }
}
