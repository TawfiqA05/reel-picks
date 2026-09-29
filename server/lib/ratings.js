// Persistence for each user's star ratings (0.5-5 scale) plus the queue of
// imported ratings we couldn't match to a TMDB id yet. Everything is scoped to
// the user in context (lib/user.js); the background matcher, which works for
// whoever imported the row, passes userId explicitly.
import { get, run, all } from '../db.js';
import { currentUserId } from './user.js';
import { filmDone } from './done.js';
import { dropNote } from './notes.js';
import { yearOf as y } from './util.js';


export function upsertRating({ tmdb_id, title, year, rating, source = 'manual', rated_at, userId = currentUserId() }) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, tmdb_id) DO UPDATE SET
       rating = excluded.rating, source = excluded.source, rated_at = excluded.rated_at,
       title = COALESCE(NULLIF(excluded.title, ''), ratings.title)`,
    userId, tmdb_id, title, y(year), rating, source, rated_at || now, now,
  );
  // Rated: an "I'm going" plan or a pick sent for it made before now goes.
  filmDone(userId, tmdb_id, 'rated', rated_at || now);
}

export function addUnmatched({ title, year, rating, source, rated_at }) {
  run(
    'INSERT INTO unmatched_ratings(user_id, title, year, rating, source, rated_at) VALUES(?,?,?,?,?,?)',
    currentUserId(), title, y(year), rating, source, rated_at || null,
  );
}

export function getRating(tmdbId) {
  return get('SELECT * FROM ratings WHERE user_id = ? AND tmdb_id = ?', currentUserId(), tmdbId);
}

// The rating's note (lib/notes.js) goes with it.
export function deleteRating(tmdbId) {
  run('DELETE FROM ratings WHERE user_id = ? AND tmdb_id = ?', currentUserId(), tmdbId);
  dropNote(currentUserId(), tmdbId);
}

// With this person's own note on each (lib/notes.js), for the Rate list.
export function listRatings() {
  return all(
    `SELECT r.*, m.poster, m.genres, n.note, n.full AS note_full, n.source AS note_source
       FROM ratings r LEFT JOIN movies m ON m.tmdb_id = r.tmdb_id
       LEFT JOIN rating_notes n ON n.user_id = r.user_id AND n.tmdb_id = r.tmdb_id AND n.note IS NOT NULL
      WHERE r.user_id = ?
      ORDER BY r.rated_at DESC`,
    currentUserId(),
  );
}

export function ratedIds() {
  return new Set(all('SELECT tmdb_id FROM ratings WHERE user_id = ?', currentUserId()).map((r) => r.tmdb_id));
}

// Rows for taste-profile building (only ratings whose movie we have metadata for).
export function profileRows() {
  return all(
    `SELECT r.rating, r.rated_at, m.genres, m.director, m.cast
       FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id
      WHERE r.user_id = ?`,
    currentUserId(),
  );
}

// Rows for the Stats rankings and their drill-down sheets: the same rated
// films as profileRows() (same join, same user), plus what a film list shows.
export function statsRows() {
  return all(
    `SELECT r.tmdb_id, r.rating, COALESCE(NULLIF(m.title, ''), r.title) AS title, COALESCE(m.year, r.year) AS year,
            m.poster, m.genres, m.director, m.cast
       FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id
      WHERE r.user_id = ?`,
    currentUserId(),
  );
}

export function ratingsCount() {
  return get('SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?', currentUserId()).n;
}

// Ratings and reviews (reviews.csv) still waiting for a TMDB match.
export function unmatchedCount() {
  return get('SELECT (SELECT COUNT(*) FROM unmatched_ratings WHERE user_id = ?) + (SELECT COUNT(*) FROM unmatched_notes WHERE user_id = ?) AS n', currentUserId(), currentUserId()).n;
}
