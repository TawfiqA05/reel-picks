// Normalizes public scores (IMDb / Rotten Tomatoes / Metacritic / TMDB) to a
// single 0-100 number, splits critic vs audience, and flags divergence + the
// "scores still settling" window for new releases.
import { mean, daysBetween } from './util.js';

// raw: { imdb: 0-10|null, rt: 0-100|null, metacritic: 0-100|null }
// tmdbRating: 0-10|null (audience-side signal from TMDB)
export function computePublicScore(raw = {}, tmdbRating = null) {
  const { imdb = null, rt = null, metacritic = null } = raw;
  const sources = [];
  const norm = {};

  if (rt != null) {
    norm.rt = rt;
    sources.push('Rotten Tomatoes');
  }
  if (metacritic != null) {
    norm.metacritic = metacritic;
    sources.push('Metacritic');
  }
  if (imdb != null) {
    norm.imdb = imdb * 10;
    sources.push('IMDb');
  }
  if (tmdbRating != null && tmdbRating > 0) {
    norm.tmdb = tmdbRating * 10;
    sources.push('TMDB');
  }

  const criticVals = [norm.rt, norm.metacritic].filter((x) => x != null);
  const audienceVals = [norm.imdb, norm.tmdb].filter((x) => x != null);
  const critic = criticVals.length ? Math.round(mean(criticVals)) : null;
  const audience = audienceVals.length ? Math.round(mean(audienceVals)) : null;

  const all = Object.values(norm);
  const combined = all.length ? Math.round(mean(all)) : null;

  let divergence = null;
  if (critic != null && audience != null && Math.abs(critic - audience) >= 25) {
    const criticsHigher = critic > audience;
    divergence = {
      gap: Math.abs(critic - audience),
      direction: criticsHigher ? 'critics-higher' : 'audience-higher',
      label: criticsHigher
        ? 'Critics loved it more than audiences'
        : 'Audiences loved it more than critics',
    };
  }

  return {
    combined, // 0-100 or null
    critic,
    audience,
    sources,
    // Original display values (RT/MC on 0-100, IMDb/TMDB on 0-10). A TMDB
    // rating of 0 means "no votes yet", not a score, so it's shown as absent.
    display: {
      rt: rt ?? null,
      metacritic: metacritic ?? null,
      imdb: imdb ?? null,
      tmdb: tmdbRating != null && tmdbRating > 0 ? tmdbRating : null,
    },
    divergence,
  };
}

// A TMDB rating counts as a review only once enough people have voted and the
// film is out in the US. A 9.5 from six early voters on a film that opens next
// week is not "Excellent reviews"; it's no reviews yet, and gets the same
// neutral default, dashed pill and "No scores yet" badge as a film with nothing.
export const MIN_TMDB_VOTES = 50;

const localYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The date a US audience can first see it: the US theatrical/limited release
// when TMDB has one, else TMDB's primary date.
export function usReleaseDate(movie) {
  return movie?.us_release_date || movie?.release_date || null;
}

export function isReleased(movie, now = new Date()) {
  const d = usReleaseDate(movie);
  return !d || d <= localYMD(now);
}

// Why a stored TMDB rating isn't being counted, or null when it is. An unknown
// vote count (not fetched yet) is given the benefit of the doubt; the refresh
// fetches it.
export function tmdbIgnoredReason(movie, now = new Date()) {
  if (!(movie?.tmdb_rating > 0)) return null;
  if (!isReleased(movie, now)) return 'unreleased';
  if (movie.tmdb_votes != null && movie.tmdb_votes < MIN_TMDB_VOTES) return 'few-votes';
  return null;
}

// Convenience: compute from a stored movie row (scores JSON holds raw omdb values).
export function publicScoreForMovie(movie, rawScores, now = new Date()) {
  const ignored = tmdbIgnoredReason(movie, now);
  const pub = computePublicScore(rawScores || {}, ignored ? null : (movie?.tmdb_rating ?? null));
  if (ignored) pub.tmdbIgnored = { reason: ignored, rating: movie.tmdb_rating, votes: movie.tmdb_votes ?? null, opens: usReleaseDate(movie) };
  return pub;
}

// New releases keep getting reviews for ~14 days; show a "settling" badge and
// re-pull scores daily during this window.
export function isSettling(movie, now = new Date()) {
  const ref = movie?.release_date || movie?.first_seen_at;
  if (!ref) return false;
  const age = daysBetween(ref, now);
  return age != null && age >= -1 && age <= 14;
}

// A best single-source phrase for the reason line, e.g. "RT 91%".
export function topSourcePhrase(pub) {
  if (!pub) return null;
  const d = pub.display || {};
  const opts = [];
  if (d.rt != null) opts.push({ v: d.rt, s: `RT ${d.rt}%` });
  if (d.metacritic != null) opts.push({ v: d.metacritic, s: `Metacritic ${d.metacritic}` });
  if (d.imdb != null) opts.push({ v: d.imdb * 10, s: `IMDb ${d.imdb}` });
  if (d.tmdb != null) opts.push({ v: d.tmdb * 10, s: `TMDB ${d.tmdb.toFixed(1)}` });
  if (!opts.length) return null;
  opts.sort((a, b) => b.v - a.v);
  return opts[0].s;
}
