// A person's page (#/person/<id>): who they are, their films playing at the
// viewer's own theaters this week, the ones the viewer rated, then every other
// feature film they directed or acted in, most popular first. TV isn't in it:
// TMDB's movie credits have no series, and TV movies are left out the way the
// Stats sheets leave them out.
//
// Their films come from TMDB /person/{id}/movie_credits through
// tmdb.personCredits, the same 7-day cache the Stats "More from" sheets fill,
// shared by everyone; their name and photo from /person/{id}, cached the same.
// Every live call waits on the shared throttle. The viewer's ratings and
// watchlist are the viewer's own; the guest link gets none. Read-only toward
// scoring: nothing here writes a movie row, a rating or a pick.
import { all } from '../db.js';
import * as tmdb from './tmdb.js';
import { tmdbThrottle } from './backfill.js';
import { playingIds } from './search.js';
import { isFeature, isActing, countedRating, SMALL_FILM_VOTES } from './statsMore.js';
import { usReleaseDate } from './scoring.js';
import { currentUserId } from './user.js';
import { localYMD, yearOf as year } from './util.js';

// What they're known for, in the words the page uses.
const ROLE = { Directing: 'Director', Acting: 'Actor', Writing: 'Writer', Production: 'Producer' };

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

// Both TMDB answers already cached and fresh: opening the page asks TMDB
// nothing, so it doesn't count against the hourly limit.
export const personCached = (id) => tmdb.personCached(id);

const mostPopular = (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (b.tmdb_votes ?? 0) - (a.tmdb_votes ?? 0) || a.title.localeCompare(b.title);

export async function getPerson(id, { guest = false } = {}) {
  const [p, credits] = await Promise.all([
    tmdb.person(id, { gate: tmdbThrottle }),
    tmdb.personCredits(id, { gate: tmdbThrottle }),
  ]);
  if (!p?.id || p.adult) throw Object.assign(new Error('Person not found'), { status: 404 });
  const today = localYMD();

  // One entry per film, whether they directed it, acted in it, or both.
  const films = new Map();
  const add = (c, how) => {
    if (!isFeature(c)) return;
    let f = films.get(c.id);
    if (!f) {
      f = {
        tmdb_id: c.id,
        title: c.title || c.original_title || `Movie ${c.id}`,
        year: year(c.release_date),
        poster: tmdb.img(c.poster_path, 'w342'),
        genres: (c.genre_ids || []).map((g) => tmdb.TMDB_GENRES[g]).filter(Boolean),
        popularity: c.popularity ?? 0,
        tmdb_rating: c.vote_average ?? null,
        tmdb_votes: c.vote_count ?? null,
        release_date: c.release_date,
        directed: false,
        acted: false,
      };
      films.set(c.id, f);
    }
    f[how] = true;
  };
  for (const c of credits?.crew || []) if (c.job === 'Director') add(c, 'directed');
  for (const c of credits?.cast || []) if (isActing(c)) add(c, 'acted');

  const ids = [...films.keys()];
  const stored = new Map(ids.length
    ? all(`SELECT * FROM movies WHERE tmdb_id IN (${placeholders(ids.length)})`, ...ids).map((m) => [m.tmdb_id, m])
    : []);
  const uid = currentUserId();
  const mine = guest ? new Map() : new Map(all('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r.rating]));
  const watch = guest ? new Set() : new Set(all('SELECT tmdb_id FROM watchlist WHERE user_id = ?', uid).map((r) => r.tmdb_id));
  // "Not for me" films stay out of the lists, as in the Stats sheets.
  const hidden = guest ? new Set() : new Set(all('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?', uid).map((r) => r.tmdb_id));
  const playing = playingIds();

  const list = [...films.values()].map((f) => {
    const m = stored.get(f.tmdb_id);
    // A credit only carries TMDB's primary date; the US one comes from the stored film.
    const date = (m && usReleaseDate(m)) || f.release_date;
    return {
      ...f,
      tmdb_rating: countedRating(f, m?.us_release_date),
      prerelease: date && date > today ? { opens: date } : null,
      playing: playing.has(f.tmdb_id),
      stored: Boolean(m),
      myRating: mine.get(f.tmdb_id) ?? null,
      watchlisted: watch.has(f.tmdb_id),
    };
  });

  const playingNow = list.filter((f) => f.playing && !hidden.has(f.tmdb_id)).sort(mostPopular);
  const rated = list.filter((f) => !f.playing && f.myRating != null)
    .sort((a, b) => b.myRating - a.myRating || mostPopular(a, b));
  const rest = list.filter((f) => !f.playing && f.myRating == null && !hidden.has(f.tmdb_id)).sort(mostPopular);
  // Acting: films few people have heard of go behind "Show smaller films",
  // the Stats sheets' rule.
  const big = (f) => f.tmdb_votes >= SMALL_FILM_VOTES;
  const acted = rest.filter((f) => f.acted);

  return {
    person: {
      id: p.id,
      name: p.name,
      role: ROLE[p.known_for_department] || null,
      department: p.known_for_department || null,
      photo: tmdb.img(p.profile_path, 'w185'),
    },
    playing: playingNow,
    rated,
    directed: rest.filter((f) => f.directed),
    acted: acted.filter(big),
    actedSmaller: acted.filter((f) => !big(f)),
  };
}
