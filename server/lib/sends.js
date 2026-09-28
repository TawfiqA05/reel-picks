// Send a pick: a film sent to someone, with an optional note.
//
// The same pairs as Watch together, without its switch: the owner can send
// to any friend, and a friend only to the owner. Never friend to friend. A
// friend's recipient list is the owner alone, so nothing a friend can ask for
// here names, counts or hints at another friend, and every id that isn't the
// caller's valid recipient (another friend, a revoked one, a made-up number,
// yourself) gets the same 404 with the same body. The guest link can neither
// send nor receive (lib/guest.js allowlist; there's no guest account).
//
// The note is plain text, up to 140 characters: control and invisible
// formatting characters go, runs of spaces and line breaks become one space,
// and it is only ever shown as text. Ten sends per person per local day, kept
// in the table so a restart doesn't reset the count.
//
// The recipient gets a push (when they have push on) and a "Sent to you" row
// at the top of Picks until they dismiss it or save, see or rate the film
// (lib/done.js). Nothing here touches a score or a pick.
import { get, all, run, db } from '../db.js';
import { OWNER_ID } from './user.js';
import { ownerName } from './guest.js';
import { pushEnabled, sendToUser } from './push.js';
import { localYMD } from './util.js';

export const NOTE_MAX = 140;
export const DAILY_LIMIT = 10;
export const NOT_FOUND = { status: 404, body: { error: 'Not found.' } };
export const LIMIT_MESSAGE = `You've sent ${DAILY_LIMIT} picks today. You can send more tomorrow.`;

const status = (code, message) => Object.assign(new Error(message), { status: code });

const nameOf = (userId) => (userId === OWNER_ID ? ownerName() : get('SELECT name FROM users WHERE id = ?', userId)?.name || 'A friend');

// Who the caller may send to: every friend who hasn't been revoked for the
// owner (by name), the owner alone for a friend, nobody for the guest.
export function recipients(me) {
  if (!me || me.guest) return [];
  if (me.isOwner) return all('SELECT id, name FROM users WHERE id != ? AND revoked_at IS NULL ORDER BY name COLLATE NOCASE, id', OWNER_ID);
  return [{ id: OWNER_ID, name: ownerName() }];
}

function recipientFor(me, id) {
  const pid = typeof id === 'number' || (typeof id === 'string' && /^\d{1,10}$/.test(id)) ? Number(id) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === me.userId) return null;
  if (me.isOwner) return get('SELECT id, name FROM users WHERE id = ? AND id != ? AND revoked_at IS NULL', pid, OWNER_ID) || null;
  return pid === OWNER_ID ? { id: OWNER_ID, name: ownerName() } : null;
}

// Plain text: no control or invisible formatting characters, spaces and
// line breaks folded to one space. Throws a 400 past 140 characters.
export function cleanNote(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw status(400, 'The note has to be text.');
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > NOTE_MAX) throw status(400, `Keep the note to ${NOTE_MAX} characters.`);
  return s;
}

export const sentToday = (userId, now = Date.now()) => get('SELECT COUNT(*) AS n FROM sends WHERE from_user = ? AND sent_day = ?', userId, localYMD(new Date(now))).n;

// Sends a film. Returns { sent, left } or throws with a status: 404 for a
// recipient or film that isn't there, 400 for a bad note, 429 over the limit.
export function sendPick(me, { to, tmdb_id: rawFilm, note: rawNote } = {}, now = Date.now()) {
  if (!me || me.guest) throw status(403, 'This shared link is read only.');
  const who = recipientFor(me, to);
  if (!who) throw Object.assign(new Error(NOT_FOUND.body.error), { status: NOT_FOUND.status });
  const film = typeof rawFilm === 'number' || (typeof rawFilm === 'string' && /^\d{1,10}$/.test(rawFilm)) ? Number(rawFilm) : NaN;
  const m = Number.isSafeInteger(film) && film > 0 ? get('SELECT tmdb_id, title FROM movies WHERE tmdb_id = ?', film) : null;
  if (!m) throw status(404, 'Movie not found');
  const note = cleanNote(rawNote);
  if (sentToday(me.userId, now) >= DAILY_LIMIT) throw status(429, LIMIT_MESSAGE);
  const at = new Date(now).toISOString();
  db.exec('BEGIN');
  try {
    // Sending the same film to the same person again replaces the earlier one.
    run(`UPDATE sends SET cleared_at = ?, cleared_how = 'replaced'
          WHERE from_user = ? AND to_user = ? AND tmdb_id = ? AND cleared_at IS NULL`, at, me.userId, who.id, m.tmdb_id);
    run('INSERT INTO sends(from_user, to_user, tmdb_id, note, sent_at, sent_day) VALUES(?,?,?,?,?,?)',
      me.userId, who.id, m.tmdb_id, note || null, at, localYMD(new Date(now)));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (pushEnabled()) {
    sendToUser(who.id, {
      title: `${nameOf(me.userId)} thinks you'd like ${m.title || 'a movie'}`,
      body: note || 'Tap to see it.',
      url: `/#/movie/${m.tmdb_id}`,
      tag: `sent-${m.tmdb_id}`,
    }, { topic: 'sent-pick' }).catch((e) => console.error('[sends] push', e.message));
  }
  return { sent: true, to: { id: who.id, name: who.name }, left: Math.max(0, DAILY_LIMIT - sentToday(me.userId, now)) };
}

// What's been sent to the caller and is still waiting, newest first. A
// friend only ever has the owner's; a revoked friend's sends stop showing.
export function inbox(me) {
  if (!me || me.guest) return [];
  const rows = all(`SELECT s.id, s.from_user, s.tmdb_id, s.note, s.sent_at, m.title, m.year, m.poster
      FROM sends s JOIN movies m ON m.tmdb_id = s.tmdb_id
      LEFT JOIN users u ON u.id = s.from_user
     WHERE s.to_user = ? AND s.cleared_at IS NULL AND (s.from_user = ? OR u.revoked_at IS NULL)
     ORDER BY s.sent_at DESC, s.id DESC`, me.userId, OWNER_ID);
  return rows
    .filter((r) => me.isOwner || r.from_user === OWNER_ID)
    .map((r) => ({
      id: r.id, tmdb_id: r.tmdb_id, title: r.title || `Movie ${r.tmdb_id}`, year: r.year ?? null, poster: r.poster || null,
      from: nameOf(r.from_user), note: r.note || '', sent_at: r.sent_at,
    }));
}

export function dismiss(userId, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  return run(`UPDATE sends SET cleared_at = ?, cleared_how = 'dismissed' WHERE id = ? AND to_user = ? AND cleared_at IS NULL`,
    new Date().toISOString(), n, userId).changes > 0;
}
