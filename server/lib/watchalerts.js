// Watchlist alerts: a push when a film on someone's watchlist first gets
// showtimes at one of their theaters ("<film> is now showing at <theater>"),
// and one when it enters Last chance ("Last week for <film> at <theater>").
//
// Opt-in per person with "Watchlist alerts" in Settings (watchlistAlerts, off
// by default). The pushes go to the devices that person turned notifications
// on for (lib/push.js); without VAPID keys nothing is queued. The guest link
// can't reach any of it, and each person's alerts come only from their own
// watchlist and theaters and name only films.
//
// scan() runs after every good refresh. For each person it notes which films
// have showtimes at their theaters (watch_presence) and which are in their
// Last chance (lib/recommend.js lastChanceNow, the Picks page's own logic):
//
//   now showing   a film's first showtimes at one of their theaters. A film
//                 away from all of them for 14 days or more that comes back
//                 starts a new run and can alert again. A film only at a
//                 theater they've just started following isn't new to them,
//                 and the first look for someone records without alerting.
//   last week     a film entering Last chance, once per run.
//
// Only films on the watchlist right then, not rated, marked seen, hidden with
// Not for me or with a live "I'm going" plan, and only with the switch on.
// Each alert is queued in watch_alerts, due right away, or at 9am when it was
// found between 9pm and 9am Eastern time (America/New_York).
//
// sendDue() runs after the scan and every minute (server/index.js). It checks
// each due alert again (switch, watchlist, rated, seen, hidden, plan), claims
// it before anything goes out, and sends each person one push: one film opens
// its page, several are one push naming up to 3 that opens Watchlist. What's
// due lives in the database, so a restart carries on and nothing goes twice.
//
// Nothing here touches a score, a pick or the weekly four: it reads them and
// writes only its own three tables.
import { get, all, run, getSettings, getSetting } from '../db.js';
import { OWNER_ID, runAs } from './user.js';
import { activeUserIds, followedTheatres, shortName } from './theatres.js';
import { lastChanceNow } from './recommend.js';
import { pushEnabled, sendToUser } from './push.js';
import { localYMD } from './util.js';

export const TZ = 'America/New_York';
const QUIET_FROM = 21; // 9pm
const QUIET_UNTIL = 9; // 9am
const RETURN_DAYS = 14;
const MAX_NAMED = 3;
const DAY_MS = 24 * 3600 * 1000;
const KEEP_DONE_DAYS = 90;

// ---- the clock, in Eastern time --------------------------------------------

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

function wall(ms) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute };
}

// The instant it is hh:00 on y-m-d in that zone.
function instant(y, m, d, hh) {
  const want = Date.UTC(y, m - 1, d, hh);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = wall(t);
    const off = want - Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
    if (!off) break;
    t += off;
  }
  return t;
}

export const quiet = (ms) => { const h = wall(ms).h; return h >= QUIET_FROM || h < QUIET_UNTIL; };

// When an alert found at `ms` may go out: then, or the next 9am.
function dueAt(ms) {
  if (!quiet(ms)) return ms;
  const w = wall(ms);
  if (w.h < QUIET_UNTIL) return instant(w.y, w.m, w.d, QUIET_UNTIL);
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
  return instant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), QUIET_UNTIL);
}

// ---- who may get one ---------------------------------------------------------

// Why a film gets no alert for this person now, or null.
function skipReason(userId, tmdbId, now) {
  if (!get('SELECT 1 AS x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId)) return 'off watchlist';
  if (get('SELECT 1 AS x FROM ratings WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId)) return 'rated';
  if (get('SELECT 1 AS x FROM watched WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId)) return 'seen';
  if (get('SELECT 1 AS x FROM hidden_movies WHERE user_id = ? AND tmdb_id = ?', userId, tmdbId)) return 'hidden';
  if (get('SELECT 1 AS x FROM plans WHERE user_id = ? AND tmdb_id = ? AND expires_at > ?', userId, tmdbId, now)) return 'going';
  return null;
}

const switchedOn = (userId) => getSetting('watchlistAlerts', { userId }) === true;

// ---- the scan -----------------------------------------------------------------

// Films with showtimes from today on at these theaters: id -> the theater ids
// that have it, in the person's order (primary first).
function lineup(ids, today) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = all(`SELECT DISTINCT tmdb_id, theatre_id FROM showtimes
    WHERE tmdb_id IS NOT NULL AND date >= ? AND theatre_id IN (${ids.map(() => '?').join(',')})`, today, ...ids);
  for (const r of rows) {
    if (!out.has(r.tmdb_id)) out.set(r.tmdb_id, []);
    out.get(r.tmdb_id).push(String(r.theatre_id));
  }
  for (const list of out.values()) list.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
  return out;
}

function scanOne(uid, now, at, today, canQueue) {
  const theatres = followedTheatres(getSettings({ userId: uid })).filter((t) => t.id);
  const ids = theatres.map((t) => t.id);
  const here = lineup(ids, today);
  // No showtimes known at their theaters (none followed, TMDB fallback): there
  // is nothing to judge, and every film would look gone.
  if (!here.size) return { queued: 0 };
  const prev = get('SELECT theatres FROM watch_scan WHERE user_id = ?', uid);
  const first = !prev;
  let known = new Set();
  try { known = new Set(prev ? JSON.parse(prev.theatres) : []); } catch { /* treat as none */ }
  const leaving = runAs(uid, () => lastChanceNow());
  const primary = leaving.theatre?.id ? leaving.theatre : theatres[0];
  const name = (tid) => shortName(theatres.find((t) => t.id === tid)?.name || '') || '';
  const rows = new Map(all('SELECT * FROM watch_presence WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r]));
  const found = [];

  for (const [id, tids] of here) {
    const r = rows.get(id);
    const inLast = leaving.ids.has(id) ? 1 : 0;
    const newRun = !r || (r.gone_since && now - Date.parse(r.gone_since) >= RETURN_DAYS * DAY_MS);
    if (newRun) {
      run(`INSERT INTO watch_presence(user_id, tmdb_id, since, last_seen, gone_since, in_last) VALUES(?,?,?,?,NULL,?)
        ON CONFLICT(user_id, tmdb_id) DO UPDATE SET since = excluded.since, last_seen = excluded.last_seen, gone_since = NULL, in_last = excluded.in_last`,
      uid, id, at, at, inLast);
      // New to them only at a theater they already followed at the last look.
      const where = first ? null : tids.find((t) => known.has(t));
      if (where) {
        found.push({ kind: 'now', id, runSince: at, theatre: name(where) });
        if (inLast) found.push({ kind: 'last', id, runSince: at, theatre: name(primary.id) });
      }
    } else {
      run('UPDATE watch_presence SET last_seen = ?, gone_since = NULL, in_last = ? WHERE user_id = ? AND tmdb_id = ?', at, inLast, uid, id);
      if (inLast && !r.in_last && !first) found.push({ kind: 'last', id, runSince: r.since, theatre: name(primary.id) });
    }
  }
  for (const [id, r] of rows) {
    if (here.has(id)) continue;
    if (!r.gone_since) run('UPDATE watch_presence SET gone_since = ?, in_last = 0 WHERE user_id = ? AND tmdb_id = ?', at, uid, id);
  }
  // Gone 14 days: a return is a new run either way.
  run('DELETE FROM watch_presence WHERE user_id = ? AND gone_since IS NOT NULL AND gone_since <= ?', uid, new Date(now - RETURN_DAYS * DAY_MS).toISOString());
  run(`INSERT INTO watch_scan(user_id, theatres, at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET theatres = excluded.theatres, at = excluded.at`, uid, JSON.stringify(ids), at);

  let queued = 0;
  if (!canQueue || !switchedOn(uid)) return { queued };
  const due = dueAt(now);
  for (const f of found) {
    if (skipReason(uid, f.id, now)) continue;
    const title = get('SELECT title FROM movies WHERE tmdb_id = ?', f.id)?.title || null;
    if (!title) continue;
    queued += run(`INSERT INTO watch_alerts(user_id, tmdb_id, kind, run_since, title, theatre, found_at, due_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, uid, f.id, f.kind, f.runSince, title, f.theatre, at, due).changes;
  }
  return { queued };
}

// After a good refresh. Never throws into the refresh: one person's failure is
// logged and the others carry on.
export function scan({ now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const today = localYMD(new Date(now));
  const canQueue = pushEnabled();
  const summary = { users: 0, queued: 0 };
  for (const uid of activeUserIds()) {
    try {
      const r = scanOne(uid, now, at, today, canQueue);
      summary.users++;
      summary.queued += r.queued;
    } catch (e) {
      console.error(`[watchlist alerts] scan for ${uid === OWNER_ID ? 'the owner' : `friend ${uid}`}:`, e.message);
    }
  }
  run('DELETE FROM watch_alerts WHERE done_at IS NOT NULL AND done_at < ?', new Date(now - KEEP_DONE_DAYS * DAY_MS).toISOString());
  if (summary.queued) console.log(`  🔖 Watchlist alerts: ${summary.queued} queued.`);
  return summary;
}

// ---- sending ------------------------------------------------------------------

const listNames = (titles) => {
  const shown = titles.slice(0, MAX_NAMED);
  const more = titles.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
};

// One push for everything due for one person. A film due both ways is named
// once, as last week.
export function message(alerts) {
  const byFilm = new Map();
  for (const a of alerts) if (!byFilm.has(a.tmdb_id) || a.kind === 'last') byFilm.set(a.tmdb_id, a);
  const films = [...byFilm.values()];
  if (films.length === 1) {
    const a = films[0];
    return {
      title: a.kind === 'last' ? `Last week for ${a.title}${a.theatre ? ` at ${a.theatre}` : ''}` : `${a.title} is now showing${a.theatre ? ` at ${a.theatre}` : ''}`,
      body: 'It\'s on your watchlist.',
      url: `/#/movie/${a.tmdb_id}`,
      tag: `watchlist-${a.tmdb_id}`,
    };
  }
  const kinds = new Set(films.map((a) => a.kind));
  const what = kinds.size > 1 ? 'are now showing or in their last week' : kinds.has('last') ? 'are in their last week' : 'are now showing';
  return {
    title: `${films.length} films from your watchlist ${what}`,
    body: listNames(films.map((a) => a.title)),
    url: '/#/watchlist',
    // Its own tag, so it never replaces an earlier one still on the screen.
    tag: `watchlist-${films.map((a) => a.tmdb_id).sort((x, y) => x - y).join('-')}`,
  };
}

let sending = false;

// Sends what's due. Nothing between 9pm and 9am, whatever is due.
export async function sendDue(now = Date.now()) {
  const summary = { people: 0, pushes: 0, sent: 0, dropped: 0 };
  if (!pushEnabled() || quiet(now)) return summary;
  if (sending) return { ...summary, busy: true };
  sending = true;
  try {
    const due = all(`SELECT a.* FROM watch_alerts a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.done_at IS NULL AND a.due_at <= ? AND (a.user_id = ? OR (u.id IS NOT NULL AND u.revoked_at IS NULL))
      ORDER BY a.user_id, a.id`, now, OWNER_ID);
    const byUser = new Map();
    for (const a of due) {
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
      byUser.get(a.user_id).push(a);
    }
    const at = new Date(now).toISOString();
    for (const [uid, list] of byUser) {
      const on = switchedOn(uid);
      const going = [];
      for (const a of list) {
        const why = on ? skipReason(uid, a.tmdb_id, now) : 'switch off';
        const claimed = run('UPDATE watch_alerts SET done_at = ?, outcome = ? WHERE id = ? AND done_at IS NULL',
          at, why ? `dropped: ${why}` : 'sending', a.id).changes;
        if (!claimed) continue;
        if (why) summary.dropped++;
        else going.push(a);
      }
      if (!going.length) continue;
      summary.people++;
      let r = { devices: 0, sent: 0 };
      try {
        r = await sendToUser(uid, message(going), { topic: 'watchlist' });
      } catch (e) {
        console.error('[watchlist alerts] push failed:', e.message);
      }
      const outcome = !r.devices ? 'no device' : r.sent ? 'sent' : 'failed';
      for (const a of going) run('UPDATE watch_alerts SET outcome = ? WHERE id = ?', outcome, a.id);
      if (r.sent) { summary.pushes++; summary.sent += r.sent; }
    }
    if (summary.pushes) console.log(`  🔖 Watchlist alerts: ${summary.pushes} push(es) to ${summary.people} ${summary.people === 1 ? 'person' : 'people'}.`);
    return summary;
  } finally {
    sending = false;
  }
}

// Fire and forget (never throws).
export const sendDueLater = () => { sendDue().catch((e) => console.error('[watchlist alerts]', e.message)); };
