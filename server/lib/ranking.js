// Final score composition, showtime-window fit, end-time calc, and the
// one-line "why you should see it" reason string.
import { clamp } from './util.js';
import { topSourcePhrase } from './scoring.js';

// weights: { public, taste } (need not sum to 1; normalized here).
// conf: 0-1 taste confidence. When confidence is low we shift weight toward
// public scores so a cold profile can't dominate. boosts: additive points.
export function finalScore({ publicCombined, tasteScore, conf, weights, boosts = 0 }) {
  const total = (weights.public || 0) + (weights.taste || 0) || 1;
  const wP = (weights.public || 0) / total;
  const wT = (weights.taste || 0) / total;
  const effTaste = wT * conf;
  const effPublic = wP + wT * (1 - conf);
  const pub = publicCombined ?? 50;
  const tas = tasteScore ?? 50;
  const base = effPublic * pub + effTaste * tas;
  return clamp(Math.round(base + boosts), 0, 100);
}

// Urgency: extra points for a movie whose run at the theatre is CONFIRMED to
// be ending, scaled by how soon — so the weekly 4 answers "what should I see
// this week", not "what's best in the abstract". Only runway kind 'ending'
// (a committed end date: the filled calendar glyph) counts. 'open' and 'thin'
// are the publishing horizon, not scarcity; treating them as urgent would make
// the whole lineup look like it's leaving every Monday.
//
// The curve is concave (sqrt): the confirmed end itself carries most of the
// weight and the exact day the rest — full `max` on the last day, ~3/4 of it
// three days out, ~2/3 four days out, nothing at URGENCY_WINDOW_DAYS. A starred
// movie gets `watchlistMultiplier` × that: the user has already said they want
// to see it, so "it's leaving" matters more.
export const URGENCY_WINDOW_DAYS = 7;

export function urgencyFactor(daysLeft) {
  if (!Number.isFinite(daysLeft)) return 0;
  const d = Math.max(0, daysLeft);
  if (d >= URGENCY_WINDOW_DAYS) return 0;
  return Math.sqrt(1 - d / URGENCY_WINDOW_DAYS);
}

export function urgencyBoost({ runway, watchlisted = false, max = 0, watchlistMultiplier = 1 }) {
  if (!runway || runway.kind !== 'ending') return 0;
  const m = Number(max) || 0;
  if (m <= 0) return 0;
  const mult = watchlisted ? Math.max(1, Number(watchlistMultiplier) || 1) : 1;
  return m * mult * urgencyFactor(runway.daysLeft);
}

export function parseLocalDate(startLocal) {
  if (!startLocal) return null;
  const t = new Date(startLocal);
  return Number.isNaN(t.getTime()) ? null : t;
}

function hm(str) {
  const [h, m] = String(str || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Does a showtime land inside the user's preferred window for that day type?
export function showtimeFits(startLocal, windows) {
  const t = parseLocalDate(startLocal);
  if (!t || !windows) return false;
  const isWeekend = t.getDay() === 0 || t.getDay() === 6;
  const w = isWeekend ? windows.weekend : windows.weekday;
  if (!w || !w.enabled) return false;
  const minutes = t.getHours() * 60 + t.getMinutes();
  return minutes >= hm(w.after) && minutes <= hm(w.before);
}

function clockLabel(date) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

// start + runtime + previews → labeled end time.
export function endTimeLabel(startLocal, runtimeMin, previewsMin = 20) {
  const t = parseLocalDate(startLocal);
  if (!t || !runtimeMin) return null;
  const end = new Date(t.getTime() + (runtimeMin + previewsMin) * 60000);
  return clockLabel(end);
}

// AMC's listed time is when the PROGRAM starts — previews first, feature after.
// This is when the feature itself begins, i.e. the latest you can be in the seat
// without missing the opening. Null when no padding is configured, because then
// it would just restate the listed time.
export function beThereByLabel(startLocal, previewsMin = 20) {
  const mins = Number(previewsMin) || 0;
  if (mins <= 0) return null;
  const t = parseLocalDate(startLocal);
  if (!t) return null;
  return clockLabel(new Date(t.getTime() + mins * 60000));
}

// From a list of showtime rows, pick the best one: prefer window-fit, then IMAX
// (if the user prefers it), then soonest.
export function bestShowtime(showtimes, { windows, preferImax } = {}) {
  if (!showtimes?.length) return null;
  const scored = showtimes.map((s) => ({
    s,
    fits: showtimeFits(s.start_local, windows),
    imax: Boolean(s.is_imax) && Boolean(preferImax),
    epoch: s.start_epoch ?? Infinity,
  }));
  scored.sort(
    (a, b) => Number(b.fits) - Number(a.fits) || Number(b.imax) - Number(a.imax) || a.epoch - b.epoch,
  );
  return scored[0];
}

// Compose the one-line reason shown on cards. `owner` is null for the owner
// ("you rate…"); on the read-only guest link it is the owner's name, so the
// same facts read in the third person ("Tawfiq rates…").
export function buildReason({ pub, topTaste, conf, flags = {}, owner = null }) {
  const bits = [];

  if (pub && pub.combined != null) {
    const q =
      pub.combined >= 80 ? 'Excellent reviews'
        : pub.combined >= 70 ? 'Strong reviews'
        : pub.combined >= 55 ? 'Solid reviews'
        : 'Mixed reviews';
    const src = topSourcePhrase(pub);
    bits.push(src ? `${q} (${src})` : q);
  } else {
    // Say so: the final score is leaning on a neutral default, not reviews.
    bits.push('no public scores yet');
  }

  const rates = owner ? `${owner} rates` : 'you rate';
  if (topTaste) {
    const v = topTaste.avg.toFixed(1);
    if (topTaste.kind === 'genre') bits.push(`${rates} ${topTaste.label} ${v}/5 on average`);
    else bits.push(`${rates} ${topTaste.label} ${v}/5`);
  } else if (conf < 1) {
    bits.push(`leaning on public scores while ${owner ? `${owner}'s` : 'your'} taste profile fills in`);
  }

  let s = bits.join(' + ');

  const extra = [];
  if (flags.watchlist) extra.push(owner ? `★ on ${owner}'s watchlist` : '★ watchlisted');
  if (flags.imax) extra.push('IMAX available');
  if (pub?.divergence) extra.push(pub.divergence.label.toLowerCase());
  if (extra.length) s += ` · ${extra.join(' · ')}`;

  // Urgency lifted the score: say so, and when ("…and it's gone after Thursday").
  if (flags.goneAfter) s += ` — and ${flags.goneAfter}`;

  return s || 'Add API keys and ratings to personalize this.';
}
