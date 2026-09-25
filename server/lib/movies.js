// Persistence helpers for the `movies` table (light vs full records, scores).
import { get, run, all } from '../db.js';
import { jparse } from './util.js';

export function hydrate(m) {
  if (!m) return null;
  return {
    ...m,
    genres: jparse(m.genres, []),
    cast: jparse(m.cast, []),
    cast_ids: jparse(m.cast_ids, []),
    scores: jparse(m.scores, null),
  };
}

export function getMovie(tmdbId) {
  return hydrate(get('SELECT * FROM movies WHERE tmdb_id = ?', tmdbId));
}

export function getMovies(tmdbIds) {
  if (!tmdbIds.length) return [];
  const q = tmdbIds.map(() => '?').join(',');
  return all(`SELECT * FROM movies WHERE tmdb_id IN (${q})`, ...tmdbIds).map(hydrate);
}

const y = (v) => (v ? Number(String(v).slice(0, 4)) || null : null);

// Insert a lightweight record (from search / now-playing / upcoming) without
// clobbering richer detail fields we may already have.
export function upsertLightMovie(m) {
  const now = new Date().toISOString();
  const existing = get('SELECT tmdb_id FROM movies WHERE tmdb_id = ?', m.tmdb_id);
  if (existing) {
    run(
      `UPDATE movies SET
         title = COALESCE(NULLIF(title, ''), ?),
         year = COALESCE(year, ?),
         poster = COALESCE(poster, ?),
         backdrop = COALESCE(backdrop, ?),
         genres = CASE WHEN genres IS NULL OR genres = '[]' THEN ? ELSE genres END,
         tmdb_rating = COALESCE(tmdb_rating, ?),
         -- the count that goes with whichever rating is kept
         tmdb_votes = CASE WHEN tmdb_rating IS NULL THEN ? ELSE COALESCE(tmdb_votes, ?) END,
         synopsis = COALESCE(NULLIF(synopsis, ''), ?),
         release_date = COALESCE(release_date, ?),
         updated_at = ?
       WHERE tmdb_id = ?`,
      m.title, y(m.year), m.poster, m.backdrop, JSON.stringify(m.genres || []),
      m.tmdb_rating, m.tmdb_votes ?? null, m.tmdb_votes ?? null, m.synopsis, m.release_date, now, m.tmdb_id,
    );
    return;
  }
  run(
    `INSERT INTO movies(tmdb_id, title, year, poster, backdrop, genres, tmdb_rating, tmdb_votes, synopsis, release_date, first_seen_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    m.tmdb_id, m.title, y(m.year), m.poster, m.backdrop, JSON.stringify(m.genres || []),
    m.tmdb_rating, m.tmdb_votes ?? null, m.synopsis, m.release_date, now, now,
  );
}

// Insert/replace a fully-detailed record (from TMDB /movie/{id}).
export function upsertFullMovie(d) {
  const now = new Date().toISOString();
  const existing = get('SELECT first_seen_at FROM movies WHERE tmdb_id = ?', d.tmdb_id);
  const firstSeen = existing?.first_seen_at || now;
  run(
    `INSERT INTO movies(tmdb_id, imdb_id, title, year, poster, backdrop, genres, director, cast, runtime,
                        synopsis, tmdb_rating, tmdb_votes, trailer_key, mpaa, release_date, us_release_date,
                        director_id, cast_ids, first_seen_at, details_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tmdb_id) DO UPDATE SET
       imdb_id = excluded.imdb_id, title = excluded.title, year = excluded.year, poster = excluded.poster,
       backdrop = excluded.backdrop, genres = excluded.genres, director = excluded.director, cast = excluded.cast,
       runtime = excluded.runtime, synopsis = excluded.synopsis, tmdb_rating = excluded.tmdb_rating,
       tmdb_votes = excluded.tmdb_votes, us_release_date = excluded.us_release_date,
       trailer_key = excluded.trailer_key, mpaa = excluded.mpaa, release_date = excluded.release_date,
       director_id = excluded.director_id, cast_ids = excluded.cast_ids,
       details_at = excluded.details_at, updated_at = excluded.updated_at`,
    d.tmdb_id, d.imdb_id, d.title, y(d.year), d.poster, d.backdrop, JSON.stringify(d.genres || []),
    d.director, JSON.stringify(d.cast || []), d.runtime, d.synopsis, d.tmdb_rating, d.tmdb_votes ?? null, d.trailer_key,
    d.mpaa, d.release_date, d.us_release_date ?? null,
    d.director_id ?? null, JSON.stringify(d.cast_ids || []), firstSeen, now, now,
  );
}

export function setScores(tmdbId, raw) {
  run('UPDATE movies SET scores = ?, scores_at = ? WHERE tmdb_id = ?',
    JSON.stringify(raw), new Date().toISOString(), tmdbId);
}

export function setMpaaIfEmpty(tmdbId, mpaa) {
  if (!mpaa) return;
  run("UPDATE movies SET mpaa = ? WHERE tmdb_id = ? AND (mpaa IS NULL OR mpaa = '')", mpaa, tmdbId);
}
