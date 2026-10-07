// Followed theatres: the primary (drives ranking, day picker, runway badges)
// plus any extras the user added, in their order. Also the drive-time lookup
// from home, computed once per theatre and cached for a year. Home coordinates
// only ever leave the app rounded to ~1 km (see outboundHome below).
import { get, all, getSettings, updateSettings, run } from '../db.js';
import { OWNER_ID, currentUserId } from './user.js';
import * as amc from './amc.js';
import { cachedJson, fetchJson, bustCache } from './cache.js';
import { localYMD, addDays } from './util.js';

// Primary + 4 followed for the owner, primary + 2 for a friend. Each theatre
// costs ~14 AMC calls per refresh (one per published day, more if a day
// paginates). There is no cap across everyone: what someone may follow
// depends only on their own list, so no answer can tell a friend what anyone
// else follows. The refresh pulls the union of everyone's theaters.
export const MAX_THEATRES = 5;
export const FRIEND_MAX_THEATRES = 3;
export const maxTheatres = (userId = currentUserId()) => (userId === OWNER_ID ? MAX_THEATRES : FRIEND_MAX_THEATRES);

// "AMC Riverside Square 12" -> "Riverside"; "AMC Northgate 8" -> "Northgate".
// Used wherever a theatre is named inside a sentence or a chip.
export function shortName(name) {
  let s = String(name || '')
    .replace(/^AMC\s+(CLASSIC\s+|DINE-IN\s+)?/i, '')
    .replace(/\s+(IMAX|Dine-In|ETX)\b.*$/i, '')
    .replace(/\s+\d+$/, '')
    .trim();
  s = s.replace(/\s+(Square|Mall|Center|Centre|Plaza|Commons|Town Center|Towne Center|Marketplace)$/i, '').trim();
  return s || String(name || '');
}

function normalize(t) {
  return { id: String(t.id), name: t.name || '', slug: t.slug || '' };
}

// Ordered list, primary first. Always has at least the primary entry (even
// before AMC has resolved it to an id) so single-theatre code paths stay simple.
export function followedTheatres(settings = getSettings()) {
  const list = [];
  const primary = { id: String(settings.theatreId || ''), name: settings.theatreName || '', slug: settings.theatreSlug || '', isPrimary: true };
  list.push(primary);
  for (const raw of Array.isArray(settings.extraTheatres) ? settings.extraTheatres : []) {
    if (!raw?.id) continue;
    const t = normalize(raw);
    if (list.some((x) => x.id === t.id)) continue;
    list.push({ ...t, isPrimary: false });
  }
  return list.map((t) => ({ ...t, short: shortName(t.name) }));
}

// What this person sees as playing this week and as coming soon, worked out
// from their own theaters only. Playing: a showtime this week at one of
// their theaters, or a film on the lineup with no showtime this week anywhere
// (the TMDB fallback). Coming soon: TMDB's upcoming list (movies.upcoming,
// a fact about the film, not a theater) plus advance screenings after this
// week at their theaters, less what is playing for them. Showtimes at
// theaters only other people follow change neither.
export function lineupIds(settings = getSettings()) {
  const today = localYMD();
  const weekEnd = localYMD(addDays(new Date(), 6));
  const mine = new Set(followedTheatres(settings).map((t) => t.id).filter(Boolean));
  const playing = new Set();
  const later = new Set();
  const weekAnywhere = new Set();
  for (const r of all('SELECT DISTINCT tmdb_id, theatre_id, date <= ? AS week FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ?', weekEnd, today)) {
    if (r.week) weekAnywhere.add(r.tmdb_id);
    if (!mine.has(String(r.theatre_id))) continue;
    (r.week ? playing : later).add(r.tmdb_id);
  }
  for (const r of all('SELECT tmdb_id FROM movies WHERE playing = 1')) if (!weekAnywhere.has(r.tmdb_id)) playing.add(r.tmdb_id);
  const coming = new Set();
  for (const id of [...all('SELECT tmdb_id FROM movies WHERE upcoming = 1').map((r) => r.tmdb_id), ...later]) if (!playing.has(id)) coming.add(id);
  return { playing, coming };
}

// Users whose theatres the refresh covers: the owner and every friend who
// hasn't been revoked, owner first.
export function activeUserIds() {
  const ids = all('SELECT id FROM users WHERE revoked_at IS NULL ORDER BY id').map((r) => r.id);
  return ids.includes(OWNER_ID) ? ids : [OWNER_ID, ...ids];
}

// The theatres the refresh pulls: the union of every active user's followed
// theatres, the owner's first (their primary stays the refresh's primary, which
// drives the TMDB fallback and the headline horizon), deduped. Each entry
// lists the users who follow it.
export function sharedTheatres() {
  const byId = new Map();
  for (const uid of activeUserIds()) {
    for (const t of followedTheatres(getSettings({ userId: uid }))) {
      if (!t.id) continue;
      if (!byId.has(t.id)) byId.set(t.id, { ...t, isPrimary: uid === OWNER_ID && t.isPrimary, users: [] });
      byId.get(t.id).users.push(uid);
    }
  }
  return [...byId.values()];
}

export const sharedTheatreIds = () => new Set(sharedTheatres().map((t) => t.id));

// The theater as AMC lists it (the cached list Settings searches). Only a
// theater in that list can be followed, under AMC's own name and slug, never
// what the caller sent.
export async function amcTheatre(id) {
  if (!amc.amcConfigured()) throw Object.assign(new Error('AMC_API_KEY is not set. Add it to .env to search theaters.'), { status: 400 });
  let t;
  try {
    t = await amc.getTheatre(id);
  } catch {
    throw Object.assign(new Error('Couldn\'t reach AMC to check that theater. Try again in a bit.'), { status: 502 });
  }
  if (!t) throw Object.assign(new Error('That isn\'t a theater in AMC\'s list. Pick one from the search.'), { status: 400 });
  return { id: String(t.id), name: t.name || t.longName || '', slug: t.slug || '' };
}

// Drop a theatre's current schedule when it's unfollowed. Its lineup history
// (snapshots, departures) is deliberately KEPT: it can't be rebuilt, the
// per-theatre queries ignore theatres that aren't followed, and it comes back
// intact if the theatre is followed again.
function purgeTheatreData(theatreId) {
  if (!theatreId) return;
  run('DELETE FROM showtimes WHERE theatre_id = ?', theatreId);
  bustCache(`${amc.SHOWTIMES_CACHE_PREFIX}${theatreId}:`);
  // A movie that only played at this theatre is no longer "playing" — the flag
  // is otherwise recomputed only on refresh, and until then it would sit in
  // the ranked list with no showtimes and no runway. (TMDB-fallback rows have
  // no showtimes by design and are left alone.)
  const today = localYMD();
  const weekEnd = localYMD(addDays(new Date(), 6));
  run(
    `UPDATE movies SET playing = 0
      WHERE playing = 1 AND playing_source = 'amc'
        AND tmdb_id NOT IN (SELECT DISTINCT tmdb_id FROM showtimes
                             WHERE tmdb_id IS NOT NULL AND date >= ? AND date <= ?)`,
    today, weekEnd,
  );
}

// After a revoke: drop the schedule of every theater nobody active follows
// now (the revoked friend's, and any other showtimes left behind), the way an
// unfollow does. `ids` are theaters known to have just lost a follower.
export function purgeUnfollowed(ids = []) {
  const followed = sharedTheatreIds();
  const left = all('SELECT DISTINCT theatre_id FROM showtimes').map((r) => String(r.theatre_id));
  const gone = [...new Set([...ids.map(String), ...left])].filter((id) => id && !followed.has(id));
  for (const id of gone) purgeTheatreData(id);
  return gone.length;
}

export function addFollowed(raw) {
  const t = normalize(raw);
  if (!t.id) throw Object.assign(new Error('A theater id is required.'), { status: 400 });
  const s = getSettings();
  if (String(s.theatreId) === t.id) throw Object.assign(new Error(`${t.name || 'That theater'} is already your primary theater.`), { status: 400 });
  const extras = (s.extraTheatres || []).map(normalize);
  if (extras.some((x) => x.id === t.id)) return s;
  const max = maxTheatres();
  if (extras.length + 1 >= max) {
    throw Object.assign(new Error(`You can follow up to ${max} theaters (primary + ${max - 1}). Remove one first.`), { status: 400 });
  }
  return updateSettings({ extraTheatres: [...extras, t] });
}

// Unfollow. The theatre's schedule is dropped only when no one else still
// follows it.
export function removeFollowed(id) {
  const s = getSettings();
  const extras = (s.extraTheatres || []).map(normalize).filter((x) => x.id !== String(id));
  const next = updateSettings({ extraTheatres: extras });
  if (!sharedTheatreIds().has(String(id))) purgeTheatreData(String(id));
  return next;
}

// Promote a followed theatre to primary; the old primary becomes a followed
// theatre (first in the list) so nothing stops being tracked.
export function promoteToPrimary(id) {
  const s = getSettings();
  const extras = (s.extraTheatres || []).map(normalize);
  const next = extras.find((x) => x.id === String(id));
  if (!next) throw Object.assign(new Error('That theater is not in your followed list.'), { status: 400 });
  const old = { id: String(s.theatreId || ''), name: s.theatreName || '', slug: s.theatreSlug || '' };
  const rest = extras.filter((x) => x.id !== next.id);
  return updateSettings({
    theatreId: next.id, theatreName: next.name, theatreSlug: next.slug,
    extraTheatres: old.id ? [old, ...rest] : rest,
  });
}

// Make any theatre the primary (Settings "Set primary"). The old primary is
// demoted to the front of the followed list — nothing stops being tracked and
// no schedule history is lost. If the new theatre was already followed this is
// just a role swap; if it is new and the swap would exceed the cap, it is
// rejected rather than silently dropping a followed theatre.
export function replacePrimary(raw) {
  const t = normalize(raw);
  if (!t.id) throw Object.assign(new Error('A theater id is required.'), { status: 400 });
  const s = getSettings();
  const oldId = String(s.theatreId || '');
  if (oldId === t.id) return s;
  const extras = (s.extraTheatres || []).map(normalize).filter((x) => x.id !== t.id);
  const old = oldId ? { id: oldId, name: s.theatreName || '', slug: s.theatreSlug || '' } : null;
  const next = old ? [old, ...extras] : extras;
  const max = maxTheatres();
  if (next.length + 1 > max) {
    throw Object.assign(
      new Error(`Making ${t.name || 'that theater'} primary would mean following ${next.length + 1} theaters (max ${max}). Remove one first.`),
      { status: 400 },
    );
  }
  return updateSettings({ theatreId: t.id, theatreName: t.name || s.theatreName, theatreSlug: t.slug, extraTheatres: next });
}

// ---- distance / drive time --------------------------------------------

const EARTH_MI = 3958.8;
const toRad = (d) => (d * Math.PI) / 180;

function haversineMiles(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(s));
}

// A person's home base, or null while they have none (a new friend, or after
// Clear home base): then no drive time is measured or shown for them.
export function homeBase(settings = getSettings()) {
  const h = settings.home || {};
  // null / '' mean "unset" (Number('') is 0, which would be a real coordinate).
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const lat = num(h.lat);
  const lng = num(h.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { label: h.label || 'Home', lat, lng };
}

const round2 = (v) => Math.round(v * 100) / 100;

// The origin as it is allowed to LEAVE the app: rounded to 2 decimals (~1.1 km
// of latitude, ~0.9 km of longitude at 40° north). Drive times come out
// the same within a minute or two, and neither OSRM nor any cache key ever
// carries a street-level home coordinate.
function outboundHome(home = homeBase()) {
  return { lat: round2(home.lat), lng: round2(home.lng) };
}

const geoKey = (theatreId, o) => `geo:drive:${theatreId}:${o.lat.toFixed(2)},${o.lng.toFixed(2)}`;

function shapeDistance({ miles, minutes, estimated }) {
  const mi = Math.round(miles);
  const min = Math.round(minutes);
  const tilde = estimated ? '~' : '';
  return { miles: mi, minutes: min, estimated, label: `${tilde}${mi} mi · ${tilde}${min} min` };
}

// Road distance + drive time from home. Tries OSRM's public router (no key),
// and falls back to a straight-line estimate scaled for suburban roads so the
// label still means something offline. Cached a year per (theatre, home).
export async function theatreDistance(theatreId, home = homeBase()) {
  if (!theatreId || !home) return null;
  const o = outboundHome(home); // rounded origin: the only form that goes out
  return cachedJson(geoKey(theatreId, o), 365 * 86400, async () => {
    const t = await amc.theatreDetail(theatreId);
    if (t?.lat == null || t?.lng == null) throw new Error(`No coordinates for theater ${theatreId}`);
    const there = { lat: t.lat, lng: t.lng };
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${there.lng},${there.lat}?overview=false`;
      const res = await fetchJson(url, { timeoutMs: 8000 });
      const route = res?.routes?.[0];
      if (route?.duration && route?.distance) {
        return shapeDistance({ miles: route.distance / 1609.344, minutes: route.duration / 60, estimated: false });
      }
    } catch {
      /* fall through to the estimate */
    }
    const straight = haversineMiles(o, there);
    const miles = straight * 1.3;          // road factor
    const minutes = (miles / 32) * 60 + 3; // suburban average + parking
    return shapeDistance({ miles, minutes, estimated: true });
  });
}

// Synchronous read of an already-computed distance (request paths never hit
// the network for this; the refresh computes it).
export function readDistance(theatreId, home = homeBase()) {
  if (!theatreId || !home) return null;
  const row = get('SELECT value FROM cache WHERE key = ?', geoKey(theatreId, outboundHome(home)));
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// Forget the cached drive times measured from `oldHome` (this user's previous
// origin; other people's origins are theirs and stay) and re-measure from the
// current home in the background, so a changed or cleared home base heals in
// seconds rather than at the next daily refresh. Per-theatre failures are
// swallowed here; the daily refresh logs its own attempt anyway.
export function refreshDistances(settings = getSettings(), oldHome = null) {
  if (oldHome) {
    const o = outboundHome(oldHome);
    run('DELETE FROM cache WHERE key LIKE ?', `geo:drive:%:${o.lat.toFixed(2)},${o.lng.toFixed(2)}`);
  }
  const home = homeBase(settings);
  return Promise.allSettled(
    followedTheatres(settings).filter((t) => t.id && home).map((t) => theatreDistance(t.id, home)),
  );
}
