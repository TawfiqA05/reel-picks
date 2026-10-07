// Helpers every area of the API shares (server/routes.js).
import { refreshAll } from '../lib/refresh.js';
import { currentUser } from '../lib/user.js';
import { take as takeLimit, LIMIT_MESSAGE } from '../lib/limits.js';
import { clientAddress } from '../lib/guest.js';

export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The owner's controls: key status, AMC title matching, friends, full-setup
// import, forced refreshes. A friend gets a 403; the guest link never reaches
// these (lib/guest.js allowlist).
export const isOwnerRequest = () => Boolean(currentUser()?.isOwner);

// After a theatre change: the owner's forces a refresh as always. A friend's
// never forces; one that adds a theatre to their list (follow, Set primary)
// queues the same ordinary background refresh whether or not anyone else
// already follows it, so what happens never says who follows what. Theatres
// already pulled come from the cache and cost no AMC calls. It locks no
// one's weekly four (refresh.js), so a new friend's four still locks when
// they first open Picks.
export function afterTheatreChange(tag, { added = true } = {}) {
  if (isOwnerRequest()) refreshAll({ force: true }).catch((e) => console.error(`[${tag} refresh]`, e.message));
  else if (added) refreshAll({ force: false, lock: false, reason: 'friend changed theatres' }).catch((e) => console.error(`[${tag} refresh]`, e.message));
}
// Per-person hourly limits on what spends the shared keys (lib/limits.js):
// friends by account, the guest link by address (lib/guest.js clientAddress;
// guests with no address share one allowance), the owner not at all.
// Counts `n` against the caller's limit; false when that would go over.
// limited() answers 429 and returns true when `n` more would go over.
export function spendLimit(req, kind, n = 1) {
  const u = currentUser();
  if (!u || u.isOwner || n <= 0) return true;
  const who = u.guest ? `ip:${clientAddress(req) || '?'}` : `user:${u.userId}`;
  return takeLimit(kind, who, u.guest ? 'guest' : 'friend', Date.now(), n);
}
export function limited(req, res, kind, n = 1) {
  if (spendLimit(req, kind, n)) return false;
  res.status(429).json({ error: LIMIT_MESSAGE });
  return true;
}

export const ownerOnly = (req, res, next) => (isOwnerRequest()
  ? next()
  : res.status(403).json({ error: 'Only the owner can do that.' }));

// A friend's view of the settings: no refresh log (it carries the owner's
// drive times), and the shared keys are the owner's to change.
export function forCaller(settings) {
  if (isOwnerRequest()) return settings;
  const { lastRefreshLog, ...rest } = settings;
  return rest;
}
export const card = (m) => ({
  tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster,
  genres: m.genres || [], mpaa: m.mpaa || null, tmdb_rating: m.tmdb_rating ?? null,
});
