// Year-in-review style stats + recommendation hit-rate and a weight suggestion.
import { all, get, getSettings } from '../db.js';
import { mean, round2 } from './util.js';
import { getProfileSummary } from './recommend.js';
import { savings } from './alist.js';
import { currentUserId } from './user.js';

// The current user's stats (lib/user.js).
export function getStats() {
  const settings = getSettings();
  const uid = currentUserId();
  const year = new Date().getFullYear();

  const seenThisYear = get(
    'SELECT COUNT(DISTINCT tmdb_id) AS n FROM watched WHERE user_id = ? AND substr(watched_at, 1, 4) = ?',
    uid, String(year),
  ).n;
  const seenAll = get('SELECT COUNT(*) AS n FROM watched WHERE user_id = ?', uid).n;

  const ratings = all('SELECT rating FROM ratings WHERE user_id = ?', uid).map((r) => r.rating);
  const avgRating = ratings.length ? round2(mean(ratings)) : null;

  const profile = getProfileSummary();

  // Recommendation hit-rate: of weekly-4 picks the user actually watched, how
  // did they rate them?
  const picks = all(
    `SELECT w.tmdb_id, r.rating FROM watched w
       LEFT JOIN ratings r ON r.tmdb_id = w.tmdb_id AND r.user_id = w.user_id
      WHERE w.user_id = ? AND w.in_weekly4 = 1`,
    uid,
  );
  const ratedPicks = picks.filter((p) => p.rating != null);
  const pickAvg = ratedPicks.length ? round2(mean(ratedPicks.map((p) => p.rating))) : null;
  const hitRate = ratedPicks.length
    ? round2(ratedPicks.filter((p) => p.rating >= 3.5).length / ratedPicks.length)
    : null;

  let suggestion = null;
  if (ratedPicks.length >= 5 && avgRating != null && pickAvg != null) {
    if (pickAvg < avgRating - 0.4) {
      suggestion = {
        text: 'Your weekly picks are rating below your average. Try weighting taste match higher.',
        weightPublic: 0.35,
        weightTaste: 0.65,
      };
    } else if (pickAvg >= avgRating) {
      suggestion = { text: 'Your picks are landing at or above your average. The current balance is working well.' };
    }
  }

  return {
    year,
    seenThisYear,
    seenAll,
    totalRatings: ratings.length,
    avgRating,
    topGenres: profile.topGenres,
    topDirectors: profile.topDirectors,
    topActors: profile.topActors,
    hitRate,
    pickAvg,
    ratedPicks: ratedPicks.length,
    totalPicksWatched: picks.length,
    savings: savings(settings),
    suggestion,
    profileConfidence: profile.confidence,
  };
}
