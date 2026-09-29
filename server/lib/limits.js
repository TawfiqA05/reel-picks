// Per-person hourly limits on the requests that spend the shared API keys:
//
//   newFilm   opening, rating or watchlisting a film the app hasn't stored
//             yet (a TMDB and an OMDb lookup; OMDb has a daily quota)
//   search    the Rate tab's TMDB search
//   place     home-base lookups (Nominatim asks for one request a second)
//   note      saving or deleting a note on a rating (lib/notes.js)
//
// Friends get room for far more than a busy evening; the guest link, keyed
// by address, gets less (it can't reach any of these today, so its limits are
// a second line). The owner has none. Kept in memory: a restart starts every
// count again, which is fine for a limit meant to stop runaway use.
// No imports, so a test can load it without a database.
export const LIMITS = {
  friend: { newFilm: 200, search: 300, place: 30, note: 300 },
  guest: { newFilm: 20, search: 30, place: 3, note: 0 },
};
export const WINDOW_MS = 3600 * 1000;
export const LIMIT_MESSAGE = 'Slow down a bit, try again in a few minutes.';

const hits = new Map(); // "kind|who" -> request times in the last hour, oldest first
let calls = 0;

function recent(k, now) {
  const list = hits.get(k);
  if (!list) return [];
  while (list.length && list[0] <= now - WINDOW_MS) list.shift();
  if (!list.length) hits.delete(k);
  return list;
}

// Room left for `who` (e.g. "user:3", "ip:203.0.113.9") in `kind`.
export function room(kind, who, role, now = Date.now()) {
  const cap = LIMITS[role]?.[kind];
  if (cap == null) return Infinity;
  return Math.max(0, cap - recent(`${kind}|${who}`, now).length);
}

// Counts `n` requests if they all fit; false (nothing counted) if they don't.
export function take(kind, who, role, now = Date.now(), n = 1) {
  if (++calls % 500 === 0) for (const k of [...hits.keys()]) recent(k, now);
  if (room(kind, who, role, now) < n) return false;
  const k = `${kind}|${who}`;
  const list = hits.get(k) || [];
  for (let i = 0; i < n; i++) list.push(now);
  hits.set(k, list);
  return true;
}
