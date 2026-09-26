// Owner alerts: when something the app does on its own goes wrong, the owner
// gets a push (lib/push.js, on every device they turned notifications on for)
// with a one-line reason. Friends never get these.
//
//   refresh     the daily AMC/TMDB refresh failed (lib/refresh.js)
//   showtimes   AMC answered, but with no showtimes for the primary theater
//   backup      the nightly database backup failed (lib/backup.js)
//   offsite     the weekly off-site backup upload failed (lib/offsite.js)
//
// At most one alert per problem per day: while a problem keeps failing, a new
// day brings one reminder and the rest of that day is quiet. When it works
// again, one "back to normal" message, once. Both are claimed in alert_state
// before anything is sent, so two runs at once can't double up.
//
// Every alert is also kept in owner_alerts, and the owner's Settings card
// shows the last 10, whether or not a push went out.
import { get, run, all } from '../db.js';
import { OWNER_ID } from './user.js';
import { sendToUser } from './push.js';
import { localYMD } from './util.js';

export const PROBLEMS = {
  refresh: 'Daily refresh',
  showtimes: 'Showtimes',
  backup: 'Nightly backup',
  offsite: 'Off-site backup',
};
// Push titles, and the one line a recovery sends.
const WORDS = {
  refresh: { fail: 'Daily refresh failed', ok: 'Daily refresh is back to normal', okLine: 'The daily refresh worked again.' },
  showtimes: { fail: 'No showtimes at your theater', ok: 'Showtimes are back to normal', okLine: 'Showtimes came back for your theater.' },
  backup: { fail: 'Nightly backup failed', ok: 'Nightly backup is back to normal', okLine: 'The nightly backup worked again.' },
  offsite: { fail: 'Off-site backup failed', ok: 'Off-site backup is back to normal', okLine: 'The off-site backup upload worked again.' },
};
const URL = '/#/settings';

// One line, short enough for a lock screen.
function oneLine(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

async function notify(problem, kind, message) {
  const id = run('INSERT INTO owner_alerts(problem, kind, message, at) VALUES(?,?,?,?)', problem, kind, message, new Date().toISOString()).lastInsertRowid;
  let sent = 0;
  try {
    const r = await sendToUser(OWNER_ID, {
      title: `Reel Picks: ${kind === 'problem' ? WORDS[problem].fail : WORDS[problem].ok}`,
      body: message,
      url: URL,
      tag: `alert-${problem}`,
    }, { topic: `alert-${problem}` });
    sent = r.sent;
  } catch (e) {
    console.error('[alerts] push failed:', e.message);
  }
  run('UPDATE owner_alerts SET pushed = ? WHERE id = ?', sent, id);
  console.log(`  ${kind === 'problem' ? '⚠' : '✓'} Owner alert (${problem}): ${message}${sent ? '' : ' [no push delivered]'}`);
  return { sent: true, pushed: sent };
}

// Something failed. Sends at most one alert per problem per local day: the
// first failure of the day claims the day. A failure on a day already alerted
// (still failing, or failing again after a recovery) is only recorded; a
// recovery from that quiet episode then sends nothing either.
export async function raise(problem, reason, now = new Date()) {
  if (!PROBLEMS[problem]) throw new Error(`Unknown alert problem: ${problem}`);
  const day = localYMD(now);
  const message = oneLine(reason);
  const at = now.toISOString();
  const claimed = run(`INSERT INTO alert_state(problem, failing, alerted, since, last_alert_day, last_reason) VALUES(?, 1, 1, ?, ?, ?)
    ON CONFLICT(problem) DO UPDATE SET
      since = CASE WHEN alert_state.failing = 1 THEN alert_state.since ELSE excluded.since END,
      failing = 1, alerted = 1, last_alert_day = excluded.last_alert_day, last_reason = excluded.last_reason
    WHERE alert_state.last_alert_day IS NOT excluded.last_alert_day`,
  problem, at, day, message).changes;
  if (!claimed) {
    run(`UPDATE alert_state SET
        since = CASE WHEN failing = 1 THEN since ELSE ? END,
        alerted = CASE WHEN failing = 1 THEN alerted ELSE 0 END,
        failing = 1, last_reason = ?
      WHERE problem = ?`, at, message, problem);
    return { sent: false };
  }
  return notify(problem, 'problem', message);
}

// It worked. Sends one "back to normal" if an alert went out for this failure.
export async function resolve(problem) {
  if (!PROBLEMS[problem]) throw new Error(`Unknown alert problem: ${problem}`);
  const row = get('SELECT since, alerted FROM alert_state WHERE problem = ? AND failing = 1', problem);
  if (!row) return { sent: false };
  const claimed = run('UPDATE alert_state SET failing = 0 WHERE problem = ? AND failing = 1', problem).changes;
  if (!claimed || !row.alerted) return { sent: false };
  const since = new Date(row.since);
  const when = Number.isFinite(since.getTime())
    ? ` It had been failing since ${since.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
    : '';
  return notify(problem, 'recovered', `${WORDS[problem].okLine}${when}`);
}

// Fire and forget, for callers that can't wait (never throws).
export const raiseLater = (problem, reason) => { raise(problem, reason).catch((e) => console.error('[alerts]', e.message)); };
export const resolveLater = (problem) => { resolve(problem).catch((e) => console.error('[alerts]', e.message)); };

// The owner's Settings card: newest first.
export function recentAlerts(limit = 10) {
  return all('SELECT id, problem, kind, message, at, pushed FROM owner_alerts ORDER BY id DESC LIMIT ?', limit)
    .map((r) => ({ ...r, label: PROBLEMS[r.problem] || r.problem, pushed: r.pushed ?? 0 }));
}

// Problems failing right now, for the same card.
export function failingNow() {
  return all('SELECT problem, since, last_reason FROM alert_state WHERE failing = 1 ORDER BY problem')
    .map((r) => ({ problem: r.problem, label: PROBLEMS[r.problem] || r.problem, since: r.since, reason: r.last_reason }));
}
