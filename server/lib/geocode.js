// Free-form place → coordinates via Nominatim (OpenStreetMap) — keyless, like
// the OSRM router the drive times already use, and OWNER-ONLY: the geocode
// endpoints are deliberately not on the guest allowlist, and nothing here is
// ever sent to the shared link.
//
// Nominatim usage policy (operations.osmfoundation.org/policies/nominatim):
// identify the app with a real User-Agent, at most 1 request/second, cache
// results. All requests funnel through a serialized ≥1.1s throttle, and every
// answer is cached for months (a town's coordinates don't move), so repeated
// lookups never touch the network at all.
import { cachedJson, fetchJson } from './cache.js';

const BASE = 'https://nominatim.openstreetmap.org';
const UA = 'ReelPicks/0.1 (self-hosted single-user movie planner; not distributed)';
const TTL = 180 * 86400; // ~6 months
const MIN_INTERVAL_MS = 1100;

// Serialize requests and space them out; concurrent callers queue up rather
// than hitting the API in parallel.
let chain = Promise.resolve();
let lastAt = 0;
function throttled(fn) {
  const p = chain.then(async () => {
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastAt = Date.now();
    }
  });
  chain = p.then(() => {}, () => {}); // keep the queue alive after a failure
  return p;
}

function nominatim(path, params) {
  const qs = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', ...params });
  return throttled(() => fetchJson(`${BASE}${path}?${qs}`, { headers: { 'User-Agent': UA }, timeoutMs: 10000 }));
}

// Nominatim can answer HTTP 200 with an error payload ({"error": …}) or, via a
// block page, non-JSON. Those must never enter the months-long cache as data —
// a transient hiccup would otherwise become a durable wrong answer — so the
// fetchers throw on anything unexpected and cachedJson caches nothing.
function unexpected(r) {
  return new Error(`Unexpected geocoder response: ${JSON.stringify(r).slice(0, 120)}`);
}

// "Fishers, IN" from a Nominatim record: the most local named place plus the
// US state code (ISO3166-2 "US-IN" → "IN"); falls back to the first parts of
// display_name for anything that doesn't fit that mold.
export function shortLabel(r) {
  const a = r?.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || null;
  const iso = String(a['ISO3166-2-lvl4'] || '');
  const region = iso.startsWith('US-') ? iso.slice(3) : (a.state || a.country || null);
  if (city && region) return `${city}, ${region}`;
  const parts = String(r?.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 2).join(', ') || null;
}

function shape(r) {
  const lat = Number(r?.lat);
  const lng = Number(r?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    label: shortLabel(r) || `${lat.toFixed(3)}, ${lng.toFixed(3)}`,
    place: r.display_name || '',     // the full name, so a wrong hit is obvious
    lat: Math.round(lat * 1e5) / 1e5, // ~1 m; nobody needs 14 decimals
    lng: Math.round(lng * 1e5) / 1e5,
    type: r.addresstype || r.type || null,
  };
}

// City/state, ZIP, or street address → up to 5 candidates. [] when Nominatim
// has nothing; the caller decides how to say that. Throws on network failure
// (unless an older cached answer exists — cachedJson serves stale then).
export async function geocode(q) {
  const query = String(q || '').trim().replace(/\s+/g, ' ');
  if (!query) return [];
  const key = `nominatim:search:v1:${query.toLowerCase()}`;
  const rows = await cachedJson(key, TTL, () => nominatim('/search', { q: query, limit: '5' }).then((r) => {
    if (!Array.isArray(r)) throw unexpected(r);
    return r;
  }));
  return (Array.isArray(rows) ? rows : []).map(shape).filter(Boolean);
}

// Coordinates → a nameable place (for the "use my current location" button).
// zoom 14 ≈ town/suburb: right granularity for a home-base label. Coordinates
// are rounded to 2 decimals (~1 km) BEFORE anything is sent — Nominatim never
// sees a street-level fix — and the same rounded point keys the cache and is
// returned to the caller. Returns null when the point can't be named (open
// water, API error payload).
export async function reverseGeocode(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  const la2 = Math.round(la * 100) / 100;
  const ln2 = Math.round(ln * 100) / 100;
  const key = `nominatim:reverse:v1:${la2.toFixed(2)},${ln2.toFixed(2)}`;
  const r = await cachedJson(key, TTL, () => nominatim('/reverse', { lat: la2.toFixed(2), lon: ln2.toFixed(2), zoom: '14' }).then((v) => {
    // A real hit, or Nominatim's genuine "this point has no name" — both are
    // cacheable answers. Anything else (rate-limit text, HTML, odd errors) is not.
    if (v && typeof v === 'object' && !Array.isArray(v) && (!v.error || /unable to geocode/i.test(String(v.error)))) return v;
    throw unexpected(v);
  }));
  if (!r || r.error) return null;
  const s = shape(r);
  return s ? { ...s, lat: la2, lng: ln2 } : null;
}
