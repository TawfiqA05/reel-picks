// Small shared helpers.
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

// Quote a value for CSV output.
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Minutes -> "2h 16m".
export function runtimeLabel(min) {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
