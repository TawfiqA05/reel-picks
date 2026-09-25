// Read-only "guest mode" for the public tunnel link.
//
// Classification is security-critical: cloudflared connects to the origin from
// localhost, so we can't use the socket IP. Instead we key off Cloudflare's
// edge headers (CF-Ray / CF-Connecting-IP), which the edge always sets and a
// guest cannot strip — and which a direct local browser never sends. A guest
// also can't reach localhost:PORT directly (only via the tunnel), so any request
// bearing these headers is definitionally remote.
//
// Owner unlock: passing ?owner=<OWNER_TOKEN> sets a signed, HttpOnly cookie whose
// value is an HMAC (keyed by the token) — never the token itself. A valid cookie
// makes isGuest() return false, so the owner gets full access over the tunnel.
import crypto from 'node:crypto';
import { FRIEND_COOKIE, verifyFriendCookie } from './accounts.js';
import { OWNER_ID } from './user.js';

export function guestModeEnabled() {
  const v = (process.env.GUEST_MODE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function ownerName() {
  return process.env.OWNER_NAME || 'Tawfiq';
}

function hostIsLocal(req) {
  const host = (req.headers.host || '').toLowerCase().split(':')[0].replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function viaCloudflare(req) {
  return Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function isRemote(req) {
  return viaCloudflare(req) || (guestModeEnabled() && !hostIsLocal(req));
}

// The owner at their own machine: localhost, not through the tunnel.
export function isLocalRequest(req) {
  return hostIsLocal(req) && !viaCloudflare(req);
}

// Who a request belongs to, in this order: the owner cookie (the owner, even
// over the tunnel); a valid friend cookie (that friend); anything remote with
// neither (the read-only guest view of the owner's picks); otherwise a local
// request, which is the owner as it has always been. A revoked, expired or
// tampered friend cookie counts as no cookie. Cached on the request.
export function requestUser(req) {
  if (req._rpUser) return req._rpUser;
  let u;
  if (isOwner(req)) u = { id: OWNER_ID, isOwner: true, guest: false };
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
  /^(?:\/api)?\/recommendations$/,
  /^(?:\/api)?\/coming-soon$/,
  /^(?:\/api)?\/movies\/\d+$/,
];

export function guestAllowed(req) {
  return req.method === 'GET' && ALLOW.some((re) => re.test(req.path));
}

// ---- owner unlock -------------------------------------------------------

export function ownerToken() {
  return (process.env.OWNER_TOKEN || '').trim();
}

const OWNER_COOKIE = 'rp_owner';
const OWNER_TTL_MS = 365 * 24 * 3600 * 1000;

// Constant-time, length-independent comparison (hash to a fixed 32 bytes first,
// so neither timing nor length leaks anything about the secret).
function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

export function tokenMatches(token) {
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
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isOwner(req) {
  return verifyOwnerCookie(readCookie(req, OWNER_COOKIE));
}
