// A year of data for the year-in-movies suites (test/fast/year.mjs,
// test/ui/year.mjs), written into a copied database before the server starts:
// the owner's cinema going across 2026 (a rewatch, a Letterboxd diary row, a
// film seen but never rated, one from 2025), a little of Robin's, ratings on
// the year's edges (2025, 11:30 pm on Dec 31, which is Jan 1 in UTC, and
// 1 am on Jan 1), "I'm
// going" plans at two theaters (past, still to come and from 2025) and a note.
// Returns the films it used that nobody had rated: { unrated: [5 ids] }.
import * as C from './catalog.mjs';

export const DEC1 = '2026-12-01T00:01:00-05:00';
export const NOV30 = '2026-11-30T23:59:00-05:00';
export const JAN15 = '2027-01-15T23:59:00-05:00';
export const JAN16 = '2027-01-16T00:01:00-05:00';
export const NOTE = 'The last shot stays with you.';

export function seedYear(d) {
  const R = C.RATED;
  const extra = d.prepare("SELECT tmdb_id FROM movies WHERE director IS NOT NULL AND tmdb_id NOT IN (SELECT tmdb_id FROM ratings WHERE user_id = 1) AND tmdb_id < 90000000 ORDER BY tmdb_id LIMIT 5").all().map((r) => r.tmdb_id);
  const ins = d.prepare('INSERT INTO watched(user_id, tmdb_id, title, watched_at, watched_date, week_start, in_weekly4, ticket_price, source) VALUES(?,?,?,?,?,?,?,?,?)');
  const row = (uid, id, date, { pick = 0, price = 14.5, source = null } = {}) => ins.run(uid, id, `Film ${id}`, `${date}T23:00:00.000Z`, date, date, pick, price, source);
  // The owner (A-List, the default plan): January, March (a rewatch too),
  // May from Letterboxd, September, and today, Dec 1.
  row(1, R[0].id, '2026-01-09', { pick: 1 });
  row(1, R[1].id, '2026-01-20', { price: 16 });
  row(1, R[2].id, '2026-03-03');
  row(1, R[3].id, '2026-03-14', { pick: 1 });
  row(1, R[2].id, '2026-03-28'); // a rewatch: one film, two tickets
  row(1, R[5].id, '2026-05-05', { source: 'letterboxd' });
  row(1, extra[0], '2026-09-12'); // seen, never rated
  row(1, R[6].id, '2026-12-01', { pick: 1, price: 18 });
  row(1, R[7].id, '2025-12-31', { pick: 1 }); // last year
  // Robin (no plan): three tickets this year, one a weekly pick.
  row(2, R[0].id, '2026-02-14', { price: 12 });
  row(2, R[1].id, '2026-06-01', { pick: 1, price: 13.25 });
  row(2, extra[1], '2026-08-08', { price: 12 });
  // Rating days at the year's edges (owner): 2025, late Dec 31, early Jan 1.
  const rate = d.prepare('INSERT OR REPLACE INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at) VALUES(?,?,?,?,?,?,?,?)');
  rate.run(1, extra[2], 'Edge A', 2000, 2, 'letterboxd', '2025-06-10', '2025-06-10');
  rate.run(1, extra[3], 'Edge B', 2000, 5, 'manual', '2027-01-01T04:30:00.000Z', '2027-01-01T04:30:00.000Z'); // Dec 31, 11:30 pm local
  rate.run(1, extra[4], 'Edge C', 2000, 4, 'manual', '2027-01-01T06:00:00.000Z', '2027-01-01T06:00:00.000Z'); // Jan 1, 1 am local
  // Plans (I'm going): two past showings at Maple Grove, one at Riverside,
  // one still to come, and one from 2025.
  const plan = d.prepare('INSERT INTO plans(user_id, tmdb_id, showtime_id, theatre_id, theatre_name, date, start_local, start_epoch, title, created_at, ask_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const far = Date.parse('2030-01-01T00:00:00Z');
  const p = (id, tid, tname, date) => plan.run(1, id, `st-${id}`, tid, tname, date, `${date}T19:00:00`, Date.parse(`${date}T19:00:00-05:00`), `Film ${id}`, '2026-01-01T00:00:00Z', far, far);
  p(C.PLAYING[0].id, '9101', 'AMC Maple Grove 12', '2026-10-02');
  p(C.PLAYING[1].id, '9101', 'AMC Maple Grove 12', '2026-11-20');
  p(C.PLAYING[2].id, '9102', 'AMC Riverside 8', '2026-11-25');
  p(C.PLAYING[3].id, '9102', 'AMC Riverside 8', '2026-12-05'); // not yet
  p(C.PLAYING[4].id, '9102', 'AMC Riverside 8', '2025-11-02'); // last year
  // The owner's note on a five-star film.
  d.prepare("INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(1, ?, ?, NULL, 'app', '2026-09-24T00:00:00Z')").run(R[2].id, NOTE);
  return { unrated: extra };
}
