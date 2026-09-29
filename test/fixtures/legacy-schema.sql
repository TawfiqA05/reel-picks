-- The oldest Reel Picks database layout on record (August 2026, before
-- multi-theater, friends and every later column), with a few made-up rows,
-- for test/fast/migrations.mjs. Every name and number here is invented.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE movies (
  tmdb_id       INTEGER PRIMARY KEY,
  imdb_id       TEXT,
  title         TEXT,
  year          INTEGER,
  poster        TEXT,
  backdrop      TEXT,
  genres        TEXT,
  director      TEXT,
  cast          TEXT,
  runtime       INTEGER,
  synopsis      TEXT,
  tmdb_rating   REAL,
  trailer_key   TEXT,
  mpaa          TEXT,
  release_date  TEXT,
  scores        TEXT,
  scores_at     TEXT,
  first_seen_at TEXT,
  details_at    TEXT,
  playing       INTEGER DEFAULT 0,
  playing_source TEXT,
  upcoming      INTEGER DEFAULT 0,
  updated_at    TEXT
);
CREATE TABLE matches (
  amc_movie_id  TEXT PRIMARY KEY,
  amc_title     TEXT,
  amc_year      INTEGER,
  tmdb_id       INTEGER,
  confidence    REAL,
  manual        INTEGER DEFAULT 0,
  updated_at    TEXT
);
CREATE TABLE showtimes (
  id            TEXT PRIMARY KEY,
  amc_movie_id  TEXT,
  tmdb_id       INTEGER,
  theatre_id    TEXT,
  date          TEXT,
  start_local   TEXT,
  start_epoch   INTEGER,
  is_imax       INTEGER DEFAULT 0,
  is_advance    INTEGER DEFAULT 0,
  format        TEXT,
  runtime_min   INTEGER,
  attributes    TEXT,
  purchase_url  TEXT,
  fetched_at    TEXT
);
CREATE TABLE ratings (
  tmdb_id    INTEGER PRIMARY KEY,
  title      TEXT,
  year       INTEGER,
  rating     REAL,
  source     TEXT,
  rated_at   TEXT,
  created_at TEXT
);
CREATE TABLE unmatched_ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  year       INTEGER,
  rating     REAL,
  source     TEXT,
  rated_at   TEXT
);
CREATE TABLE watchlist (
  tmdb_id  INTEGER PRIMARY KEY,
  added_at TEXT
);
CREATE TABLE watched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id       INTEGER,
  title         TEXT,
  watched_at    TEXT,
  week_start    TEXT,
  in_weekly4    INTEGER DEFAULT 0,
  ticket_price  REAL
);
CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  fetched_at TEXT,
  ttl        INTEGER
);
CREATE TABLE lineup_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  refresh_at     TEXT,
  tmdb_id        INTEGER,
  last_date      TEXT,
  showtime_count INTEGER,
  horizon        TEXT,
  gap_days       INTEGER
);
CREATE TABLE departures (
  tmdb_id     INTEGER PRIMARY KEY,
  title       TEXT,
  last_date   TEXT,
  departed_at TEXT
);
CREATE INDEX idx_showtimes_date ON showtimes(date);
CREATE INDEX idx_showtimes_tmdb ON showtimes(tmdb_id);
CREATE INDEX idx_snap_movie ON lineup_snapshots(tmdb_id, refresh_at);
CREATE INDEX idx_snap_at ON lineup_snapshots(refresh_at);

INSERT INTO settings(key, value) VALUES
  ('theatreId', '"9101"'),
  ('theatreName', '"AMC Maple Grove 12"'),
  ('home', '{"label":"Testville, OH","lat":41.25,"lng":-81.45}'),
  ('avgTicketPrice', '13.5'),
  ('lastRefresh', '"2026-08-20T14:00:00.000Z"');
INSERT INTO movies(tmdb_id, title, year, genres, director, cast, runtime, tmdb_rating, release_date, first_seen_at, details_at, playing, playing_source, updated_at) VALUES
  (990001, 'The Paper Lantern', 2026, '["Drama","Thriller"]', 'Ada Lindqvist', '["June Calloway","Rafael Ostrow"]', 128, 7.9, '2026-08-11', '2026-08-15T12:00:00.000Z', '2026-08-15T12:00:00.000Z', 1, 'amc', '2026-08-15T12:00:00.000Z'),
  (990002, 'Northern Signal', 2026, '["Science Fiction"]', 'Marcus Oyelaran', '["Theo Achterberg"]', 141, 7.6, '2026-08-04', '2026-08-15T12:00:00.000Z', NULL, 1, 'amc', '2026-08-15T12:00:00.000Z');
INSERT INTO matches(amc_movie_id, amc_title, amc_year, tmdb_id, confidence, manual, updated_at) VALUES
  ('7001', 'The Paper Lantern', 2026, 990001, 0.97, 0, '2026-08-15T12:00:00.000Z');
INSERT INTO showtimes(id, amc_movie_id, tmdb_id, theatre_id, date, start_local, start_epoch, format, attributes, fetched_at) VALUES
  ('s1', '7001', 990001, NULL, '2026-08-21', '2026-08-21T19:30:00', 1787355000000, 'Standard', '[]', '2026-08-20T14:00:00.000Z');
INSERT INTO ratings(tmdb_id, title, year, rating, source, rated_at, created_at) VALUES
  (970101, 'Ember Road', 1980, 4.5, 'letterboxd', '2024-01-02', '2026-08-15T12:00:00.000Z'),
  (970102, 'Harbor Lights', 1995, 3, 'letterboxd', '2024-02-03', '2026-08-15T12:00:00.000Z'),
  (990001, 'The Paper Lantern', 2026, 4, 'manual', '2026-08-18T02:00:00.000Z', '2026-08-18T02:00:00.000Z');
INSERT INTO unmatched_ratings(title, year, rating, source, rated_at) VALUES ('Nowhere Film', 2001, 2.5, 'imdb', '2023-05-05');
INSERT INTO watchlist(tmdb_id, added_at) VALUES (990002, '2026-08-16T12:00:00.000Z');
INSERT INTO watched(tmdb_id, title, watched_at, week_start, in_weekly4, ticket_price) VALUES
  (990001, 'The Paper Lantern', '2026-08-17T23:30:00.000Z', '2026-08-14', 0, 13.5),
  (990001, 'The Paper Lantern', '2026-08-18T01:10:00.000Z', '2026-08-14', 1, 13.5),
  (990002, 'Northern Signal', '2026-08-19T23:00:00.000Z', '2026-08-14', 0, 13.5);
INSERT INTO cache(key, value, fetched_at, ttl) VALUES
  ('amc:showtimes:9101:2026-08-21', '[{"date":"2026-08-21","id":"s1"}]', '2026-08-20T14:00:00.000Z', 86400),
  ('tmdb:movie:990001', '{"id":990001,"title":"The Paper Lantern","vote_count":1840,"release_dates":{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"release_date":"2026-08-11T00:00:00.000Z"}]}]},"credits":{"crew":[{"job":"Director","name":"Ada Lindqvist","id":50001}],"cast":[{"name":"June Calloway","id":60001,"order":0},{"name":"Rafael Ostrow","id":60002,"order":1}]}}', '2026-08-15T12:00:00.000Z', 604800);
INSERT INTO lineup_snapshots(refresh_at, tmdb_id, last_date, showtime_count, horizon, gap_days) VALUES
  ('2026-08-20T14:00:00.000Z', 990001, '2026-08-27', 14, '2026-08-27', 0);
INSERT INTO departures(tmdb_id, title, last_date, departed_at) VALUES
  (970199, 'Gone Film', '2026-08-19', '2026-08-20T14:00:00.000Z');
