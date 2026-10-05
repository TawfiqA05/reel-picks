// Read-only "guest mode" for the public tunnel link.
//
// Classification is security-critical. The owner at their own machine is a
// request with a localhost Host that also came over loopback, with neither
// of Cloudflare's edge headers; everything else is remote. The Host alone
// proves nothing: a device on the network can send "Host: localhost". The
// socket alone isn't enough either: cloudflared connects to the origin from
// localhost, so the tunnel's requests are told apart by CF-Ray /
// CF-Connecting-IP, which the edge always sets and a guest cannot strip, and
// which a browser on this machine never sends. Off Railway the server also
// listens on 127.0.0.1 only, unless RP_ALLOW_LAN is set (index.js).
//
// Owner unlock: passing ?owner=<OWNER_TOKEN> sets a signed, HttpOnly cookie whose
// value is an HMAC (keyed by the token) — never the token itself. A valid cookie
// makes isGuest() return false, so the owner gets full access over the tunnel.
//
// On Railway every request is remote, whatever GUEST_MODE says: without it a
// deployment would make everyone who opens the site the owner. There the
// owner cookie and friend cookies are the only ways past the guest view, and
// index.js alerts the owner when GUEST_MODE isn't on.
import crypto from 'node:crypto';
import { onRailway } from '../env.js';
import { FRIEND_COOKIE, verifyFriendCookie } from './accounts.js';
import { OWNER_ID } from './user.js';
import { safeEqual } from './util.js';
import { DEMO } from '../demo/mode.js';

export function guestModeEnabled() {
  const v = (process.env.GUEST_MODE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function ownerName() {
  return process.env.OWNER_NAME || 'Tawfiq';
}

export function hostIsLocal(req) {
  // "[::1]:5170" keeps its colons inside the brackets.
  const raw = (req.headers.host || '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function viaCloudflare(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

// The connection came from this machine itself (a browser here, the share
// tunnel's connector, the tests), not from another device on the network.
export function fromLoopback(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

// The address to count a guest's hourly limits against (lib/limits.js), or
// null when there is none to go by. Only ever kept in memory, never logged.
//   - On Railway: X-Real-IP, which Railway's edge sets to the caller's
//     address. cf-connecting-ip and X-Forwarded-For are ignored there: a
//     caller can type any value into either.
//   - Through the share tunnel: cf-connecting-ip, which Cloudflare's edge
//     sets. The tunnel's connector runs on this machine, so those requests
//     arrive over loopback; the same header from anywhere else counts for
//     nothing.
//   - Anything else: the address the connection came from.
export function clientAddress(req) {
  const one = (v) => String(Array.isArray(v) ? v[0] : v || '').trim().slice(0, 64) || null;
  if (onRailway()) return one(req.headers['x-real-ip']);
  if (fromLoopback(req) && viaCloudflare(req)) return one(req.headers['cf-connecting-ip']);
  return one(req.socket?.remoteAddress);
}

// The owner at their own machine: a localhost Host on a connection from this
// machine, not through the tunnel, and never on Railway. GUEST_MODE doesn't
// change it: anything else is remote whatever GUEST_MODE says.
export function isLocalRequest(req) {
  return !onRailway() && hostIsLocal(req) && fromLoopback(req) && !viaCloudflare(req);
}

function isRemote(req) {
  return !isLocalRequest(req);
}

// Who a request belongs to, in this order: the owner cookie (the owner, even
// over the tunnel); a valid friend cookie (that friend); anything remote with
// neither (the read-only guest view of the owner's picks); otherwise a local
// request, which is the owner as it has always been. A revoked, expired or
// tampered friend cookie counts as no cookie. Cached on the request.
export function requestUser(req) {
  if (req._rpUser) return req._rpUser;
  let u;
  // Demo mode: every visitor is the owner of their own copy of the sample
  // (server/demo/sessions.js). No guest view, no friend cookie.
  if (DEMO) u = { id: OWNER_ID, isOwner: true, guest: false };
  else if (isOwner(req)) u = { id: OWNER_ID, isOwner: true, guest: false };
  else {
    const friend = verifyFriendCookie(readCookie(req, FRIEND_COOKIE));
    if (friend) u = { id: friend.id, isOwner: false, guest: false, name: friend.name, row: friend };
    else if (isRemote(req)) u = { id: OWNER_ID, isOwner: false, guest: true };
    else u = { id: OWNER_ID, isOwner: true, guest: false };
  }
  req._rpUser = u;
  return u;
}

// A request is a guest (read-only) if it is remote with neither the owner
// cookie nor a valid friend cookie (see requestUser).
export function isGuest(req) {
  return requestUser(req).guest;
}

// Endpoints a guest may reach. Default-deny: everything else is rejected.
// Matches whether the router is mounted (path has /api) or not.
const ALLOW = [
  /^(?:\/api)?\/status$/,
  /^(?:\/api)?\/version$/,
  /^(?:\/api)?\/recommendations$/,
  /^(?:\/api)?\/coming-soon$/,
  /^(?:\/api)?\/movies\/\d+$/,
  /^(?:\/api)?\/person\/\d+$/,
  /^(?:\/api)?\/showtimes\/[^/]+\/calendar\.ics$/,
  // Answered with nothing for the guest (routes.js): a page still signed in
  // as a friend who was just revoked asks for it once, and gets no error.
  /^(?:\/api)?\/social$/,
];

export function guestAllowed(req) {
  return req.method === 'GET' && ALLOW.some((re) => re.test(req.path));
}

// ---- owner unlock -------------------------------------------------------

function ownerToken() {
  return (process.env.OWNER_TOKEN || '').trim();
}

const OWNER_COOKIE = 'rp_owner';
const OWNER_TTL_MS = 365 * 24 * 3600 * 1000;


export function tokenMatches(token) {
  if (DEMO) return false; // no owner token in demo mode
  const t = ownerToken();
  if (!t || !token) return false;
  return safeEqual(token, t);
}

function sign(payload) {
  return crypto.createHmac('sha256', ownerToken()).update(payload).digest('base64url');
}

export const ownerCookieName = () => OWNER_COOKIE;
export const ownerCookieMaxAgeMs = () => OWNER_TTL_MS;

// Cookie value = "v1.<expiry>.<hmac>" — the HMAC is keyed by OWNER_TOKEN, so it
// can't be forged without the token, and the token itself is never stored in it.
export function ownerCookieValue() {
  const payload = `v1.${Date.now() + OWNER_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function verifyOwnerCookie(value) {
  if (!value || !ownerToken()) return false;
  const parts = String(value).split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(parts[2], sign(payload))) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() !== name) continue;
    // A value that isn't valid %-encoding ("%zz") counts as no cookie.
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
  }
  return null;
}

export function isOwner(req) {
  return verifyOwnerCookie(readCookie(req, OWNER_COOKIE));
}
