// Followed theatres: the primary (drives ranking, day picker, runway badges)
// plus any extras the user added, in their order. Also the drive-time lookup
// from home, computed once per theatre and cached for a year. Home coordinates
// only ever leave the app rounded to ~1 km (see outboundHome below).
import { get, getSettings, updateSettings, run, DEFAULT_SETTINGS } from '../db.js';
import * as amc from './amc.js';
import { cachedJson, fetchJson, bustCache } from './cache.js';
import { localYMD, addDays } from './util.js';

// Primary + 4 followed. Each theatre costs ~14 AMC calls per refresh (one per
// published day, more if a day paginates), so five keeps a refresh under ~100.
export const MAX_THEATRES = 5;

// "AMC Castleton Square 14" -> "Castleton"; "AMC Indianapolis 17" -> "Indianapolis".
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
  for (const raw of settings.extraTheatres || []) {
    if (!raw?.id) continue;
    const t = normalize(raw);
    if (list.some((x) => x.id === t.id)) continue;
    list.push({ ...t, isPrimary: false });
  }
  return list.map((t) => ({ ...t, short: shortName(t.name) }));
}

export function followedIds(settings = getSettings()) {
  return followedTheatres(settings).map((t) => t.id).filter(Boolean);
}

// Drop a theatre's current schedule when it's unfollowed. Its lineup history
// (snapshots, departures) is deliberately KEPT: it can't be rebuilt, the
// per-theatre queries ignore theatres that aren't followed, and it comes back
// intact if the theatre is followed again.
export function purgeTheatreData(theatreId) {
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

export function addFollowed(raw) {
  const t = normalize(raw);
  if (!t.id) throw Object.assign(new Error('Theatre id is required.'), { status: 400 });
  const s = getSettings();
  if (String(s.theatreId) === t.id) throw Object.assign(new Error(`${t.name || 'That theatre'} is already your primary theatre.`), { status: 400 });
  const extras = (s.extraTheatres || []).map(normalize);
  if (extras.some((x) => x.id === t.id)) return s;
  if (extras.length + 1 >= MAX_THEATRES) {
    throw Object.assign(new Error(`You can follow up to ${MAX_THEATRES} theatres (primary + ${MAX_THEATRES - 1}). Remove one first.`), { status: 400 });
  }
  return updateSettings({ extraTheatres: [...extras, t] });
}

export function removeFollowed(id) {
  const s = getSettings();
  const extras = (s.extraTheatres || []).map(normalize).filter((x) => x.id !== String(id));
  purgeTheatreData(String(id));
  return updateSettings({ extraTheatres: extras });
}

// Promote a followed theatre to primary; the old primary becomes a followed
// theatre (first in the list) so nothing stops being tracked.
export function promoteToPrimary(id) {
  const s = getSettings();
  const extras = (s.extraTheatres || []).map(normalize);
  const next = extras.find((x) => x.id === String(id));
  if (!next) throw Object.assign(new Error('That theatre is not in your followed list.'), { status: 400 });
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
  if (!t.id) throw Object.assign(new Error('Theatre id is required.'), { status: 400 });
  const s = getSettings();
  const oldId = String(s.theatreId || '');
  if (oldId === t.id) return s;
  const extras = (s.extraTheatres || []).map(normalize).filter((x) => x.id !== t.id);
  const old = oldId ? { id: oldId, name: s.theatreName || '', slug: s.theatreSlug || '' } : null;
  const next = old ? [old, ...extras] : extras;
  if (next.length + 1 > MAX_THEATRES) {
    throw Object.assign(
      new Error(`Making ${t.name || 'that theatre'} primary would mean following ${next.length + 1} theatres (max ${MAX_THEATRES}). Remove one first.`),
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

export function homeBase(settings = getSettings()) {
  const h = settings.home || {};
  const d = DEFAULT_SETTINGS.home;
  // null / '' mean "unset" (Number('') is 0, which would be a real coordinate).
  const num = (v) => (v == null || v === '' ? NaN : Number(v));
  const lat = num(h.lat);
  const lng = num(h.lng);
  return {
    label: h.label || d.label,
    lat: Number.isFinite(lat) ? lat : d.lat,
    lng: Number.isFinite(lng) ? lng : d.lng,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// The origin as it is allowed to LEAVE the app: rounded to 2 decimals (~1.1 km
// of latitude, ~0.9 km of longitude around Indianapolis). Drive times come out
// the same within a minute or two, and neither OSRM nor any cache key ever
// carries a street-level home coordinate.
export function outboundHome(home = homeBase()) {
  return { lat: round2(home.lat), lng: round2(home.lng) };
}

const geoKey = (theatreId, o) => `geo:drive:${theatreId}:${o.lat.toFixed(2)},${o.lng.toFixed(2)}`;
// Installs from before the rounding keyed this cache by the precise origin;
// read those too so existing drive times stay visible until recomputed.
const legacyGeoKey = (theatreId, home) => `geo:drive:${theatreId}:${home.lat.toFixed(4)},${home.lng.toFixed(4)}`;

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
  if (!theatreId) return null;
  const o = outboundHome(home); // rounded origin: the only form that goes out
  return cachedJson(geoKey(theatreId, o), 365 * 86400, async () => {
    const t = await amc.theatreDetail(theatreId);
    if (t?.lat == null || t?.lng == null) throw new Error(`No coordinates for theatre ${theatreId}`);
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
  if (!theatreId) return null;
  const row = get('SELECT value FROM cache WHERE key = ?', geoKey(theatreId, outboundHome(home)))
    || get('SELECT value FROM cache WHERE key = ?', legacyGeoKey(theatreId, home));
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// Forget every cached drive time (any origin, any theatre) and re-measure from
// the current home in the background, so a changed or cleared home base heals
// in seconds rather than at the next daily refresh. Per-theatre failures are
// swallowed here; the daily refresh logs its own attempt anyway.
export function refreshDistances(settings = getSettings()) {
  bustCache('geo:drive:');
  const home = homeBase(settings);
  return Promise.allSettled(
    followedTheatres(settings).filter((t) => t.id).map((t) => theatreDistance(t.id, home)),
  );
}
