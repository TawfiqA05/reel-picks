// The second section of a Stats drill-down sheet, under "You rated":
//   director → "More from <name>": every feature film they directed
//   actor    → "More from <name>": every feature film they acted in
//   genre    → "<Genre> playing now": that genre at the user's theatres this
//              week, plus Coming Soon
// Films listed under "You rated" are left out, and so are the user's "Not for
// me" films. Newest first. Each film carries the caller's own rating and
// watchlist state.
//
// Filmographies come from TMDB /person/{id}/movie_credits, cached for 7 days
// in the shared cache table (so a friend opening the same person costs
// nothing), and every live call goes through the backfill's 4-per-second
// throttle. Person ids come from the rated films' stored credits; a film whose
// ids aren't stored yet has its details fetched once (same throttle, 7-day
// cache) to learn them.
import { all } from '../db.js';
import * as tmdb from './tmdb.js';
import { getMovies, upsertFullMovie } from './movies.js';
import { getStatsGroup, userLineup } from './recommend.js';
import { usReleaseDate, tmdbIgnoredReason } from './scoring.js';
import { tmdbThrottle } from './backfill.js';
import { currentUserId } from './user.js';
import { localYMD } from './util.js';

// Actors: films with fewer votes than this go behind "Show smaller films".
export const SMALL_FILM_VOTES = 50;
const TV_MOVIE = 10770;
// "Himself", "Self - Host", "Themselves (archive footage)", …
const SELF = /\b(self|himself|herself|themselves|themself)\b/i;

// What TMDB's credits call a feature film for this list: a dated theatrical
// film. Direct-to-video extras ("video") and TV movies are left out, and so
// are undated projects, which are announcements rather than films.
function isFeature(c) {
  return !c.adult && !c.video && Boolean(c.release_date)
    && !(c.genre_ids || []).includes(TV_MOVIE);
}

const isActing = (c) => !SELF.test(c.character || '') && !/uncredited/i.test(c.character || '');

// The TMDB person id behind a name in the user's rated films: the id stored
// with most of those films. Films whose ids aren't stored yet are asked of
// TMDB (details, cached 7 days), up to three, until one answers.
async function personId(kind, name, films) {
  const count = new Map();
  const tally = (m) => {
    const id = kind === 'director'
      ? (m.director === name ? m.director_id : null)
      : m.cast_ids?.[m.cast.indexOf(name)];
    if (id) count.set(id, (count.get(id) || 0) + 1);
  };
  const movies = getMovies(films.map((f) => f.tmdb_id));
  movies.forEach(tally);
  for (const m of movies.slice(0, 3)) {
    if (count.size) break;
    upsertFullMovie(tmdb.normalizeDetails(await tmdb.details(m.tmdb_id, { gate: tmdbThrottle })));
    getMovies([m.tmdb_id]).forEach(tally);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const year = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);
const opensOn = (date, today) => (date && date > today ? { opens: date } : null);

function fromCredit(c, today) {
  return {
    tmdb_id: c.id,
    title: c.title || c.original_title || `Movie ${c.id}`,
    year: year(c.release_date),
    poster: tmdb.img(c.poster_path, 'w342'),
    genres: (c.genre_ids || []).map((g) => tmdb.TMDB_GENRES[g]).filter(Boolean),
    tmdb_rating: c.vote_average ?? null,
    tmdb_votes: c.vote_count ?? null,
    release_date: c.release_date,
    prerelease: opensOn(c.release_date, today),
  };
}

function fromMovie(m, today) {
  const date = usReleaseDate(m);
  return {
    tmdb_id: m.tmdb_id,
    title: m.title || `Movie ${m.tmdb_id}`,
    year: m.year ?? year(date),
    poster: m.poster || null,
    genres: m.genres || [],
    tmdb_rating: m.tmdb_rating ?? null,
    tmdb_votes: m.tmdb_votes ?? null,
    release_date: date,
    prerelease: opensOn(date, today),
  };
}

// The app-wide thin-rating rule (lib/scoring.js): a TMDB rating from fewer
// than MIN_TMDB_VOTES votes, or on a film not yet out in the US, isn't shown
// as a number; the sheet says "No TMDB rating yet" instead. A filmography
// credit only carries TMDB's primary date, often a festival premiere, so the
// US release date is taken from the stored film when there is one.
export function countedRating(f, usDate = null, now = new Date()) {
  const ignored = tmdbIgnoredReason({ ...f, us_release_date: usDate || null }, now);
  return ignored || !(f.tmdb_rating > 0) ? null : f.tmdb_rating;
}

const newestFirst = (a, b) => String(b.release_date || '').localeCompare(String(a.release_date || ''))
  || a.title.localeCompare(b.title);

export async function getStatsMore(kind, name) {
  const uid = currentUserId();
  const group = getStatsGroup(kind, name);
  const listed = new Set(group.films.map((f) => f.tmdb_id));
  const hidden = new Set(all('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?', uid).map((r) => r.tmdb_id));
  const watch = new Set(all('SELECT tmdb_id FROM watchlist WHERE user_id = ?', uid).map((r) => r.tmdb_id));
  const mine = new Map(all('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r.rating]));
  const today = localYMD();

  let films;
  if (kind === 'genre') {
    const { playing, upcoming } = userLineup();
    const seen = new Set();
    films = [...playing, ...upcoming]
      .filter((m) => (m.genres || []).includes(name) && !seen.has(m.tmdb_id) && seen.add(m.tmdb_id))
      .map((m) => fromMovie(m, today));
  } else {
    const pid = await personId(kind, name, group.films);
    if (!pid) return { kind, name, films: [], smaller: [], unknownPerson: true };
    const credits = await tmdb.personCredits(pid, { gate: tmdbThrottle });
    const pool = kind === 'director'
      ? (credits?.crew || []).filter((c) => c.job === 'Director')
      : (credits?.cast || []).filter(isActing);
    const seen = new Set();
    films = pool.filter((c) => isFeature(c) && !seen.has(c.id) && seen.add(c.id)).map((c) => fromCredit(c, today));
  }

  const ids = films.map((f) => f.tmdb_id);
  const usDates = new Map(ids.length
    ? all(`SELECT tmdb_id, us_release_date FROM movies WHERE us_release_date IS NOT NULL AND tmdb_id IN (${ids.map(() => '?').join(',')})`, ...ids)
      .map((r) => [r.tmdb_id, r.us_release_date])
    : []);
  films = films
    .filter((f) => !listed.has(f.tmdb_id) && !hidden.has(f.tmdb_id))
    .map((f) => ({ ...f, tmdb_rating: countedRating(f, usDates.get(f.tmdb_id)), watchlisted: watch.has(f.tmdb_id), myRating: mine.get(f.tmdb_id) ?? null }))
    .sort(newestFirst);
  // Actors only: keep a big career's list to films people have heard of.
  const small = (f) => kind === 'actor' && !(f.tmdb_votes >= SMALL_FILM_VOTES);
  return { kind, name, films: films.filter((f) => !small(f)), smaller: films.filter(small) };
}
