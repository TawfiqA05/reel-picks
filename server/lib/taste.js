// Builds a taste profile from the user's ratings (by genre / director / actor,
// recency-weighted) and scores how well a candidate movie matches it.
import { mean, sum, clamp, jparse } from './util.js';

// Ratings are stored 0.5-5 stars. Recent ratings count slightly more.
function recencyWeight(ratedAt, now) {
  if (!ratedAt) return 0.7;
  const days = (now.getTime() - Date.parse(ratedAt)) / 86400000;
  if (!Number.isFinite(days) || days < 0) return 1;
  return 0.6 + 0.4 * Math.exp(-days / 900); // ~1.0 recent → ~0.6 for old ratings
}

function accum(map, key, rating, w) {
  if (!key) return;
  const e = map.get(key) || { wsum: 0, wrsum: 0, n: 0 };
  e.wsum += w;
  e.wrsum += w * rating;
  e.n += 1;
  map.set(key, e);
}

function finalize(map) {
  const out = {};
  for (const [k, e] of map) out[k] = { avg: e.wsum ? e.wrsum / e.wsum : 0, n: e.n };
  return out;
}

// rows: ratings joined with movie genres/director/cast (JSON strings or arrays).
export function buildProfile(rows, now = new Date()) {
  const genre = new Map();
  const director = new Map();
  const actor = new Map();
  let wsum = 0;
  let wrsum = 0;
  let n = 0;

  for (const r of rows) {
    if (r.rating == null) continue;
    const w = recencyWeight(r.rated_at, now);
    const rating = r.rating;
    n += 1;
    wsum += w;
    wrsum += w * rating;
    for (const g of jparse(r.genres, []) || []) accum(genre, g, rating, w);
    if (r.director) accum(director, r.director, rating, w);
    for (const a of jparse(r.cast, []) || []) accum(actor, a, rating, w);
  }

  return {
    count: n,
    overall: wsum ? wrsum / wsum : 3.0,
    genre: finalize(genre),
    director: finalize(director),
    actor: finalize(actor),
  };
}

// Confidence in the taste signal: full weight at >= 10 ratings.
export function confidence(profile) {
  return clamp((profile?.count || 0) / 10, 0, 1);
}

// Predict how much the user will like `movie` and express it as 0-100.
// movie: { genres:[], director, cast:[] }
export function tasteMatch(movie, profile) {
  const parts = [];

  const genres = movie.genres || [];
  const gvals = genres.map((g) => profile.genre[g]?.avg).filter((v) => v != null);
  if (gvals.length) parts.push({ w: 0.5, stars: mean(gvals), kind: 'genre' });

  if (movie.director && profile.director[movie.director]) {
    parts.push({ w: 0.3, stars: profile.director[movie.director].avg, kind: 'director' });
  }

  const cast = movie.cast || [];
  const avals = cast.map((a) => profile.actor[a]?.avg).filter((v) => v != null);
  if (avals.length) parts.push({ w: 0.2, stars: mean(avals), kind: 'actor' });

  let predicted;
  if (parts.length) {
    const wtot = sum(parts.map((p) => p.w));
    predicted = sum(parts.map((p) => p.w * p.stars)) / wtot;
  } else {
    predicted = profile.overall ?? 3.0; // no overlap with taste → user's baseline
  }

  return {
    score: Math.round(clamp((predicted / 5) * 100, 0, 100)),
    predicted,
    hasSignal: parts.length > 0,
    parts,
  };
}

// The strongest taste factor, for the reason line and detail breakdown.
export function topTasteFactor(movie, profile) {
  const candidates = [];
  const genres = movie.genres || [];
  for (const g of genres) {
    const e = profile.genre[g];
    if (e && e.n) candidates.push({ kind: 'genre', label: g.toLowerCase(), avg: e.avg, n: e.n });
  }
  if (movie.director && profile.director[movie.director]) {
    const e = profile.director[movie.director];
    candidates.push({ kind: 'director', label: movie.director, avg: e.avg, n: e.n });
  }
  for (const a of movie.cast || []) {
    const e = profile.actor[a];
    if (e && e.n) candidates.push({ kind: 'actor', label: a, avg: e.avg, n: e.n });
  }
  if (!candidates.length) return null;
  // Prefer the highest-rated factor with at least a little support.
  candidates.sort((a, b) => b.avg - a.avg || b.n - a.n);
  return candidates[0];
}
