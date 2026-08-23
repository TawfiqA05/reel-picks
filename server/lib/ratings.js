// Persistence for the user's star ratings (0.5-5 scale) plus the queue of
// imported ratings we couldn't match to a TMDB id yet.
import { get, run, all } from '../db.js';

const y = (v) => (v ? Number(String(v).slice(0, 4)) || null : null);

export function upsertRating({ tmdb_id, title, year, rating, source = 'manual', rated_at }) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO ratings(tmdb_id, title, year, rating, source, rated_at, created_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       rating = excluded.rating, source = excluded.source, rated_at = excluded.rated_at,
       title = COALESCE(NULLIF(excluded.title, ''), ratings.title)`,
    tmdb_id, title, y(year), rating, source, rated_at || now, now,
  );
}

export function addUnmatched({ title, year, rating, source, rated_at }) {
  run(
    'INSERT INTO unmatched_ratings(title, year, rating, source, rated_at) VALUES(?,?,?,?,?)',
    title, y(year), rating, source, rated_at || null,
  );
}

export function getRating(tmdbId) {
  return get('SELECT * FROM ratings WHERE tmdb_id = ?', tmdbId);
}

export function deleteRating(tmdbId) {
  run('DELETE FROM ratings WHERE tmdb_id = ?', tmdbId);
}

export function listRatings() {
  return all(
    `SELECT r.*, m.poster, m.genres
       FROM ratings r LEFT JOIN movies m ON m.tmdb_id = r.tmdb_id
      ORDER BY r.rated_at DESC`,
  );
}

export function ratedIds() {
  return new Set(all('SELECT tmdb_id FROM ratings').map((r) => r.tmdb_id));
}

// Rows for taste-profile building (only ratings whose movie we have metadata for).
export function profileRows() {
  return all(
    `SELECT r.rating, r.rated_at, m.genres, m.director, m.cast
       FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id`,
  );
}

export function ratingsCount() {
  return get('SELECT COUNT(*) AS n FROM ratings').n;
}

export function unmatchedCount() {
  return get('SELECT COUNT(*) AS n FROM unmatched_ratings').n;
}
