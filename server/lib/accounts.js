// Friend accounts: invite links, the signed friend cookie, revoke / re-issue.
//
// Same shape as the owner unlock in lib/guest.js. An invite link carries a
// random token; only its SHA-256 is stored, and it is cleared the moment the
// link is redeemed, so a link works once. Redeeming sets an HttpOnly cookie
// whose value is "v1.<userId>.<sessionVersion>.<expiry>.<hmac>" — never the
// token. The HMAC key is a random secret kept in the settings table (not in
// DEFAULT_SETTINGS, so it never travels in an export). Revoke and re-issue
// bump session_version, which kills every older cookie on the next request.
import crypto from 'node:crypto';
import { get, all, run, getSettings, setSetting } from '../db.js';
import { OWNER_ID } from './user.js';

export const MAX_USERS = 10; // owner included
export const FRIEND_COOKIE = 'rp_user';
export const FRIEND_TTL_MS = 365 * 24 * 3600 * 1000;
const SECRET_KEY = 'friendCookieSecret';
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function secret() {
  const row = get('SELECT value FROM settings WHERE key = ?', SECRET_KEY);
  if (row) return JSON.parse(row.value);
  const s = crypto.randomBytes(32).toString('hex');
  run('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', SECRET_KEY, JSON.stringify(s));
  return JSON.parse(get('SELECT value FROM settings WHERE key = ?', SECRET_KEY).value);
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

// Constant-time and length-independent, as in lib/guest.js.
function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

export function signFriendCookie(user) {
  const payload = `v1.${user.id}.${user.session_version}.${Date.now() + FRIEND_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

// The friend a cookie names, or null for anything absent, malformed, forged,
// expired, revoked, superseded, or claiming to be the owner.
export function verifyFriendCookie(value) {
  if (!value) return null;
  const parts = String(value).split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const payload = parts.slice(0, 4).join('.');
  if (!safeEqual(parts[4], sign(payload))) return null;
  const [id, ver, exp] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(id) || id === OWNER_ID || !(exp > Date.now())) return null;
  const user = get('SELECT id, name, revoked_at, session_version, last_seen_at FROM users WHERE id = ?', id);
  if (!user || user.revoked_at || user.session_version !== ver) return null;
  return user;
}

export function touchLastSeen(user) {
  const last = user.last_seen_at ? Date.parse(user.last_seen_at) : 0;
  if (Date.now() - last > LAST_SEEN_EVERY_MS) {
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), user.id);
  }
}

// A usable-looking token: what newToken() makes (base64url, 43 chars). Anything
// else is never looked up, and never echoed back into a page.
export const isTokenShape = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(t);

// Who an invite is for, without using it up (the Join page). Null for an
// unknown, used or revoked token.
export function findInvite(token) {
  if (!isTokenShape(token)) return null;
  return get(
    'SELECT id, name FROM users WHERE invite_token_hash = ? AND id != ? AND revoked_at IS NULL',
    sha256(token), OWNER_ID,
  ) || null;
}

// Redeem an invite token: returns the friend and burns the token, or null.
// Only the Join button's POST calls this; opening the link never does, so a
// link-preview bot fetching it can't use it up.
export function redeemInvite(token) {
  if (!isTokenShape(token)) return null;
  const user = get(
    'SELECT id, name, session_version FROM users WHERE invite_token_hash = ? AND id != ? AND revoked_at IS NULL',
    sha256(token), OWNER_ID,
  );
  if (!user) return null;
  const burned = run('UPDATE users SET invite_token_hash = NULL WHERE id = ? AND invite_token_hash = ?', user.id, sha256(token));
  return burned.changes ? user : null;
}

function shapeFriend(u) {
  return {
    id: u.id,
    name: u.name,
    created_at: u.created_at,
    revoked_at: u.revoked_at || null,
    last_seen_at: u.last_seen_at || null,
    invite_pending: Boolean(u.invite_token_hash),
    ratings: get('SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?', u.id).n,
  };
}

export function listFriends() {
  return all('SELECT * FROM users WHERE id != ? ORDER BY id', OWNER_ID).map(shapeFriend);
}

function friendRow(id) {
  const u = get('SELECT * FROM users WHERE id = ? AND id != ?', Number(id), OWNER_ID);
  if (!u) throw Object.assign(new Error('No such friend.'), { status: 404 });
  return u;
}

// New friend with a one-time invite. They start on the owner's primary theatre
// (so their picks work before any new refresh) and app defaults for the rest;
// nothing else of the owner's is copied, home base included.
export function createFriend(rawName) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw Object.assign(new Error('Give your friend a name.'), { status: 400 });
  const n = get('SELECT COUNT(*) AS n FROM users').n;
  if (n >= MAX_USERS) throw Object.assign(new Error(`Reel Picks holds up to ${MAX_USERS} people, you included.`), { status: 400 });
  const token = newToken();
  const owner = getSettings({ userId: OWNER_ID });
  const res = run('INSERT INTO users(name, invite_token_hash, created_at) VALUES(?, ?, ?)', name, sha256(token), new Date().toISOString());
  const id = Number(res.lastInsertRowid);
  for (const k of ['theatreId', 'theatreName', 'theatreSlug']) setSetting(k, owner[k], { userId: id });
  setSetting('extraTheatres', [], { userId: id });
  setSetting('onboardingDone', false, { userId: id });
  return { friend: shapeFriend(friendRow(id)), token };
}

// Revoke: the cookie stops working on the next request and any pending invite
// dies. Their ratings and lists are kept.
export function revokeFriend(id) {
  friendRow(id);
  run(
    'UPDATE users SET revoked_at = ?, invite_token_hash = NULL, session_version = session_version + 1 WHERE id = ?',
    new Date().toISOString(), Number(id),
  );
  return shapeFriend(friendRow(id));
}

// Re-issue: a fresh one-time link that restores access; cookies from before
// stay dead, so an old leaked link or cookie can't come back.
export function reissueFriend(id) {
  friendRow(id);
  const token = newToken();
  run(
    'UPDATE users SET revoked_at = NULL, invite_token_hash = ?, session_version = session_version + 1 WHERE id = ?',
    sha256(token), Number(id),
  );
  return { friend: shapeFriend(friendRow(id)), token };
}

export function userName(id) {
  return get('SELECT name FROM users WHERE id = ?', id)?.name || null;
}
