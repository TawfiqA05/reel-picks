// "Because you loved Interstellar": the one-line reason on an "At home" pick
// and a "What should I watch?" suggestion, tied to a film the person rated
// highly. The film chosen is the one this candidate has most in common with:
// the same director counts most, then shared leading actors, then two or more
// shared genres. With nothing strong enough in common, the caller falls back
// to a public-score or popularity line.
import { all } from '../db.js';
import { jparse } from './util.js';

const LIKED = 4; // stars

// The person's well-liked films with what they're made of, best first.
export function likedFilms(userId) {
  return all(
    `SELECT r.tmdb_id, r.rating, r.rated_at, COALESCE(NULLIF(m.title, ''), r.title) AS title, m.genres, m.director, m.cast
       FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id
      WHERE r.user_id = ? AND r.rating >= ?
      ORDER BY r.rating DESC, r.rated_at DESC`,
    userId, LIKED,
  ).map((r) => ({
    tmdb_id: r.tmdb_id, rating: r.rating, title: r.title,
    genres: new Set(jparse(r.genres, []) || []), director: r.director || null, cast: new Set(jparse(r.cast, []) || []),
  }));
}

// The reason line for `movie` ({ tmdb_id, genres, director, cast }), or null.
// `used` (a Map of liked film id -> times already cited) spreads the reasons
// across a list: a film already cited counts for less each time, so four
// picks don't all say "Because you loved" the same thing when another fits.
export function becauseLine(movie, liked, { used = null } = {}) {
  const genres = movie.genres || [];
  const cast = movie.cast || [];
  let best = null;
  for (const f of liked) {
    if (f.tmdb_id === movie.tmdb_id || !f.title) continue;
    let score = 0;
    if (movie.director && f.director === movie.director) score += 6;
    score += Math.min(2, cast.filter((a) => f.cast.has(a)).length) * 3;
    const shared = genres.filter((g) => f.genres.has(g)).length;
    if (shared >= 2) score += 2 + (shared - 2) * 0.5;
    if (score < 2) continue;
    score += (f.rating - LIKED) * 2; // a 5-star favorite beats a 4
    score -= (used?.get(f.tmdb_id) || 0) * 2.5;
    if (!best || score > best.score) best = { score, f };
  }
  if (!best) return null;
  used?.set(best.f.tmdb_id, (used.get(best.f.tmdb_id) || 0) + 1);
  return `Because you ${best.f.rating >= 4.5 ? 'loved' : 'liked'} ${best.f.title}`;
}
