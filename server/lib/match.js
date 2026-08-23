// Title matching: AMC movie name / imported CSV title -> TMDB id, with a fuzzy
// + year-aware scorer. Records go in the `matches` table and can be manually
// overridden from the UI.
import { get, run, all } from '../db.js';
import * as tmdb from './tmdb.js';

function norm(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Release qualifiers AMC appends to a title that TMDB knows nothing about.
// "La La Land 10th Anniversary", "Coyote vs. Acme Early Access", "Castle in
// the Sky 40th Anniversary - Studio Ghibli Fest 2026" all need these gone
// before a search has a chance.
const QUALIFIERS = [
  /\b\d+(?:st|nd|rd|th)[\s-]*anniversary(?:\s+(?:edition|event|screening|re-?release))?\b/gi,
  /\banniversary(?:\s+(?:edition|event|screening|re-?release))?\b/gi,
  /\bearly[\s-]*access(?:\s+(?:screening|event|showing))?\b/gi,
  /\bfan[\s-]*(?:event|first|premieres?|screening|celebration)\b/gi,
  /\b(?:studio ghibli|ghibli)?\s*fest(?:ival)?\s*\d{4}\b/gi,
  /\b(?:the )?imax experience\b/gi,
  /\b(?:imax|3d|4k|70mm|35mm|dolby cinema|dolby)\b/gi,
  /\bre-?release(?:d)?\b/gi,
  /\b(?:remastered|restored|restoration)\b/gi,
  /\b(?:extended|director'?s|final|theatrical|ultimate)\s+(?:cut|edition|version)\b/gi,
  /\bspecial\s+(?:screening|event|presentation|engagement)\b/gi,
  /\b(?:sneak\s+(?:peek|preview)|opening\s+night|encore)\b/gi,
  /\b(?:sing-?along|marathon|double\s+feature)\b/gi,
  // AMC event codes, e.g. "(HPD26)" = Harry Potter Day 2026 — a re-release tag.
  /\(\s*[A-Z]{2,6}\d{2,4}\s*\)/g,
];

// Remove qualifiers and the punctuation they leave behind.
export function stripQualifiers(t) {
  let s = String(t || '').replace(/\(\d{4}\)/g, ' ');
  for (const re of QUALIFIERS) s = s.replace(re, ' ');
  return s
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s*[-–—:|]\s*(?=[-–—:|]|$)/g, ' ')  // dangling separators
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
    .trim();
}

// "10th Anniversary" → 10, so the original release year can be inferred.
export function anniversaryYears(t) {
  const m = String(t || '').match(/\b(\d+)(?:st|nd|rd|th)[\s-]*anniversary\b/i);
  return m ? Number(m[1]) : null;
}

function coreTitle(t) {
  // Drop subtitles / release qualifiers to widen a failed search.
  return stripQualifiers(t)
    .replace(/[:\-–—|].*$/, '')
    .trim();
}

function bigrams(s) {
  const b = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    b.set(g, (b.get(g) || 0) + 1);
  }
  return b;
}

// Sørensen–Dice coefficient on character bigrams (0-1).
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

// Find the best TMDB match for a (title, year). Returns
// { tmdb_id, confidence, result(lightMovie), auto } or null.
export async function findTmdbMatch(title, year) {
  if (!tmdb.tmdbConfigured()) return null;
  const amcYear = year ? Number(String(year).slice(0, 4)) || null : null;

  // Search attempts, most specific first. For an "Nth Anniversary" re-release
  // AMC's year is the re-release year, so the original is expected N years
  // earlier — that becomes the year hint for the stripped title.
  const stripped = stripQualifiers(title);
  const core = coreTitle(title);
  const nth = anniversaryYears(title);
  const origYear = nth && amcYear ? amcYear - nth : null;
  const lc = (s) => String(s || '').toLowerCase();
  const attempts = [[title, amcYear], [title, null]];
  if (stripped && lc(stripped) !== lc(title)) {
    if (origYear) attempts.push([stripped, origYear]);
    attempts.push([stripped, amcYear], [stripped, null]);
  }
  if (core && lc(core) !== lc(stripped) && lc(core) !== lc(title)) attempts.push([core, null]);

  let pool = [];
  let used = { q: title, y: amcYear };
  const seen = new Set();
  for (const [q, y] of attempts) {
    if (!q) continue;
    const key = `${lc(q)}|${y || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool = await tmdb.search(q, y);
    if (pool.length) { used = { q, y }; break; }
  }
  if (!pool.length) return null;

  // Score against the query that actually hit, and against the year it implies
  // (the inferred original year for an anniversary re-release).
  const target = norm(used.q);
  const yr = used.y || (origYear && lc(used.q) !== lc(title) ? origYear : amcYear);
  let best = null;
  for (const r of pool.slice(0, 12)) {
    const sim = dice(target, norm(r.title || r.original_title || ''));
    const ry = Number((r.release_date || '').slice(0, 4)) || null;
    let yb = 0;
    if (yr && ry) {
      const dy = Math.abs(ry - yr);
      yb = dy === 0 ? 0.15 : dy === 1 ? 0.05 : -0.12;
    }
    const pop = r.popularity ? Math.min(r.popularity, 60) / 1200 : 0;
    const score = sim + yb + pop;
    if (!best || score > best.score) best = { score, sim, r };
  }
  if (!best) return null;

  const confidence = Math.max(0, Math.min(1, best.sim));
  return {
    tmdb_id: best.r.id,
    confidence,
    result: tmdb.lightMovie(best.r),
    auto: confidence >= 0.5 || (confidence >= 0.4 && Boolean(yr)),
  };
}

export function getMatch(amcMovieId) {
  return get('SELECT * FROM matches WHERE amc_movie_id = ?', amcMovieId);
}

export function recordMatch(amcMovieId, amcTitle, amcYear, tmdbId, confidence, manual = false) {
  run(
    `INSERT INTO matches(amc_movie_id, amc_title, amc_year, tmdb_id, confidence, manual, updated_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(amc_movie_id) DO UPDATE SET
       amc_title = excluded.amc_title, amc_year = excluded.amc_year,
       tmdb_id = excluded.tmdb_id, confidence = excluded.confidence,
       manual = excluded.manual, updated_at = excluded.updated_at`,
    amcMovieId, amcTitle, amcYear ? Number(String(amcYear).slice(0, 4)) || null : null,
    tmdbId, confidence, manual ? 1 : 0, new Date().toISOString(),
  );
}

// Point an AMC movie at a specific TMDB id and re-tag its showtimes. Clears
// any review flag: the owner has decided.
export function setManualMatch(amcMovieId, amcTitle, tmdbId) {
  const cur = getMatch(amcMovieId);
  recordMatch(amcMovieId, amcTitle || cur?.amc_title || '', cur?.amc_year ?? null, tmdbId, 1, true);
  run('UPDATE matches SET review = NULL WHERE amc_movie_id = ?', amcMovieId);
  run('UPDATE showtimes SET tmdb_id = ? WHERE amc_movie_id = ?', tmdbId, amcMovieId);
}

// Flag an automatic match as suspect; it stays in effect (the movie keeps its
// showtimes) but is listed for review until the owner keeps or changes it.
export function setReview(amcMovieId, reason) {
  run('UPDATE matches SET review = ? WHERE amc_movie_id = ?', reason, amcMovieId);
}

// Owner confirmed the automatic match: make it manual so it's never re-flagged.
export function keepMatch(amcMovieId) {
  run('UPDATE matches SET manual = 1, review = NULL, updated_at = ? WHERE amc_movie_id = ?', new Date().toISOString(), amcMovieId);
}

export function setAmcYear(amcMovieId, year) {
  run('UPDATE matches SET amc_year = ? WHERE amc_movie_id = ?', year, amcMovieId);
}

// Automatic matches flagged for review that still have upcoming showtimes.
export function reviewTitles(today) {
  return all(
    `SELECT m.amc_movie_id, m.amc_title, m.amc_year, m.tmdb_id, m.confidence, m.review,
            mv.title AS matched_title, mv.year AS matched_year, mv.poster AS matched_poster,
            COUNT(s.id) AS showtimes, MIN(s.date) AS first_date, MAX(s.date) AS last_date,
            GROUP_CONCAT(DISTINCT s.theatre_id) AS theatre_ids
       FROM matches m
       JOIN movies mv ON mv.tmdb_id = m.tmdb_id
       JOIN showtimes s ON s.amc_movie_id = m.amc_movie_id AND s.date >= ?
      WHERE m.review IS NOT NULL AND m.manual = 0
      GROUP BY m.amc_movie_id ORDER BY showtimes DESC`,
    today,
  ).map((r) => ({
    amc_movie_id: r.amc_movie_id, amc_title: r.amc_title, amc_year: r.amc_year,
    tmdb_id: r.tmdb_id, confidence: r.confidence, review: r.review,
    matched: { tmdb_id: r.tmdb_id, title: r.matched_title, year: r.matched_year, poster: r.matched_poster },
    suggested: stripQualifiers(r.amc_title),
    showtimes: r.showtimes, first_date: r.first_date, last_date: r.last_date,
    theatre_ids: (r.theatre_ids || '').split(',').filter(Boolean),
  }));
}

// Mark an AMC title as deliberately unmatched (e.g. "AMC Screen Unseen"): a
// manual row with no TMDB id, which the refresh never retries and the
// unmatched list hides.
export function ignoreMatch(amcMovieId, amcTitle) {
  const cur = getMatch(amcMovieId);
  recordMatch(amcMovieId, amcTitle || cur?.amc_title || '', cur?.amc_year ?? null, null, 0, true);
}

// Back to plain unmatched: listed again immediately, retried on the next refresh.
export function unignoreMatch(amcMovieId) {
  run('UPDATE matches SET manual = 0, updated_at = ? WHERE amc_movie_id = ? AND tmdb_id IS NULL',
    new Date().toISOString(), amcMovieId);
}

// AMC titles with upcoming showtimes that have no TMDB id. These are invisible
// to ranking, runway, horizon and departures, so they're surfaced for a manual
// match. `ignored` rows are the ones the owner chose to leave alone.
export function unmatchedTitles(today) {
  const rows = all(
    `SELECT m.amc_movie_id, m.amc_title, m.amc_year, m.manual,
            COUNT(s.id) AS showtimes, MIN(s.date) AS first_date, MAX(s.date) AS last_date,
            GROUP_CONCAT(DISTINCT s.theatre_id) AS theatre_ids
       FROM matches m
       JOIN showtimes s ON s.amc_movie_id = m.amc_movie_id AND s.date >= ?
      WHERE m.tmdb_id IS NULL
      GROUP BY m.amc_movie_id
      ORDER BY showtimes DESC, m.amc_title`,
    today,
  );
  const shape = (r) => ({
    amc_movie_id: r.amc_movie_id, amc_title: r.amc_title, amc_year: r.amc_year,
    suggested: stripQualifiers(r.amc_title),
    showtimes: r.showtimes, first_date: r.first_date, last_date: r.last_date,
    theatre_ids: (r.theatre_ids || '').split(',').filter(Boolean),
  });
  return {
    unmatched: rows.filter((r) => !r.manual).map(shape),
    ignored: rows.filter((r) => r.manual).map(shape),
  };
}
