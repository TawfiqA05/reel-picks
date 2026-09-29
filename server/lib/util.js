// Small shared helpers.
import crypto from 'node:crypto';

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function jparse(s, fallback) {
  if (s == null) return fallback;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Local (not UTC) YYYY-MM-DD — matters for "today" in the evening.
export function localYMD(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// A-List weeks reset on Friday. Returns the YYYY-MM-DD of the current week's Friday.
export function weekStartFriday(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const off = (d.getDay() - 5 + 7) % 7; // days since last Friday (Fri = 5)
  d.setDate(d.getDate() - off);
  return localYMD(d);
}

export function daysBetween(aIso, b = new Date()) {
  const a = typeof aIso === 'string' ? Date.parse(aIso) : aIso;
  if (!Number.isFinite(a)) return null;
  return (b.getTime() - a) / 86400000;
}

// "8:15 PM" from an ISO-ish local datetime string.
export function timeLabel(startLocal) {
  if (!startLocal) return '';
  const m = String(startLocal).match(/T(\d\d):(\d\d)/);
  if (!m) return '';
  let h = Number(m[1]);
  const min = m[2];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

export const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// The year from a year or a YYYY-MM-DD date (number or string), or null.
export const yearOf = (v) => (v ? Number(String(v).slice(0, 4)) || null : null);

// "12k votes" / "640 votes", or null when there are none.
export const votesPhrase = (v) => (v ? `${v >= 1000 ? `${Math.round(v / 1000)}k` : v} votes` : null);

// A TMDB image URL at another size (w92, w500, …), or null for anything else.
export const tmdbImageAt = (url, size) => (typeof url === 'string' && url.startsWith('https://image.tmdb.org/') ? url.replace(/\/(w\d+|original)\//, `/${size}/`) : null);

// Constant-time, length-independent comparison of two secrets: both are
// hashed to a fixed 32 bytes first, so neither timing nor length leaks
// anything about either.
export function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

// Quote a value for CSV output.
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
