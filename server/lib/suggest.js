// "What should I watch?": three quick, skippable questions (where, how long,
// what mood) and three films that fit, for the person in context.
//
//   where   'theater'  films playing this week at their theaters, scored as
//                      the Picks page scores them (lib/recommend.js)
//           'home'     films included with their streaming services: this
//                      week's "At home" list (lib/home.js), plus, for a mood,
//                      that mood's films on those services
//           'either' or skipped: both
//   time    'short'    under two hours; 'any' or skipped: any length
//   mood    one of MOODS, 'surprise' or skipped: any genre
//
// Never suggested: anything they rated, marked seen or hidden, anything their
// genre and rating filters exclude, and anything already shown this session
// (the client sends those ids back with "Show me 3 more"). Ordered by the
// same final score as the picks; while the taste profile is thin (few
// ratings), popularity counts for more, so someone with no ratings at all
// still gets well-known films that fit the mood.
import { scoredLineup } from './recommend.js';
import {
  personal, done, excludedBySettings, scoreFilm, reasonFor, streamingCandidates, filmData, ensureDetails, confirmService, weeklyList,
} from './home.js';
import { becauseLine } from './because.js';
import { getMovie } from './movies.js';
import { servicesPhrase } from '../../public/js/services.js';

export const MOODS = {
  funny: { genres: ['Comedy'], ids: [35] },
  intense: { genres: ['Action', 'Thriller', 'Crime', 'War'], ids: [28, 53, 80, 10752] },
  'feel-good': { genres: ['Comedy', 'Family', 'Animation', 'Music', 'Romance'], not: ['Horror', 'War', 'Thriller', 'Crime'], ids: [35, 10751, 16, 10402, 10749] },
  'mind-bending': { genres: ['Science Fiction', 'Mystery'], ids: [878, 9648] },
  scary: { genres: ['Horror'], ids: [27] },
  romantic: { genres: ['Romance'], ids: [10749] },
};
export const WHERE = ['theater', 'home', 'either'];
export const TIME = ['short', 'any'];
const SHORT_MIN = 120;
const SHOW = 3;
const LAZY_CHECKS = 15; // home films confirmed on the spot per request, at most

// Validates the request body. Returns { where, time, mood, exclude } or throws a 400.
export function parseAsk(body = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const where = body.where ?? 'either';
  const time = body.time ?? 'any';
  const mood = body.mood ?? 'surprise';
  if (!WHERE.includes(where)) throw bad('where must be theater, home or either.');
  if (!TIME.includes(time)) throw bad('time must be short or any.');
  if (mood !== 'surprise' && !MOODS[mood]) throw bad(`mood must be one of ${Object.keys(MOODS).join(', ')} or surprise.`);
  const ex = Array.isArray(body.exclude) ? body.exclude : [];
  if (ex.length > 500 || ex.some((x) => !Number.isInteger(x) || x <= 0)) throw bad('exclude must be a list of film ids.');
  return { where, time, mood, exclude: new Set(ex) };
}

const fitsMood = (genres, mood) => {
  const m = MOODS[mood];
  if (!m) return true;
  const g = genres || [];
  return g.some((x) => m.genres.includes(x)) && !g.some((x) => (m.not || []).includes(x));
};

// Popularity, 0-10 points, from how many people rated it on TMDB.
const popPoints = (votes) => Math.max(0, Math.min(10, Math.log10(Math.max(1, votes || 0)) * 3 - 6));

const votesPhrase = (v) => (v ? `${v >= 1000 ? `${Math.round(v / 1000)}k` : v} votes` : null);

function card(m, extra) {
  return {
    tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster, genres: m.genres || [], runtime: m.runtime || null,
    tmdb_rating: m.tmdb_rating ?? null, ...extra,
  };
}

export async function suggest(body) {
  const ask = parseAsk(body);
  const p = personal();
  const wantTheater = ask.where !== 'home';
  const wantHome = ask.where !== 'theater';
  if (ask.where === 'home' && !p.services.length) return { films: [], more: false, needsServices: true };
  const skip = (id) => done(p, id) || ask.exclude.has(id);
  const pool = new Map(); // id -> candidate

  if (wantTheater) {
    for (const { m, e } of scoredLineup()) {
      if (skip(m.tmdb_id) || e.flags.excluded || pool.has(m.tmdb_id)) continue;
      pool.set(m.tmdb_id, {
        id: m.tmdb_id, where: 'theater', m, final: e.final, votes: m.tmdb_votes || 0, ready: true, reason: e.reason,
        theatre: e.theatre?.short || e.theatre?.name || null, next: e.nextShowtime ? { date: e.nextShowtime.date, time: e.nextShowtime.time } : null,
      });
    }
  }
  if (wantHome && p.services.length) {
    // This week's confirmed list first (already checked, full details)...
    for (const e of await weeklyList()) {
      if (skip(e.tmdb_id) || pool.has(e.tmdb_id)) continue;
      const m = getMovie(e.tmdb_id);
      if (!m) continue;
      pool.set(e.tmdb_id, { id: e.tmdb_id, where: 'home', m, final: e.final, votes: m.tmdb_votes || 0, ready: true, reason: e.reason, service: e.service });
    }
    // ...then, for a mood, that mood's films on their services, checked when chosen.
    if (MOODS[ask.mood]) {
      const extra = await streamingCandidates(p.services, { genreIds: MOODS[ask.mood].ids, pages: 1 });
      for (const [id, { light }] of extra) {
        if (skip(id) || pool.has(id)) continue;
        const m = filmData(id, light);
        if (excludedBySettings(m, p.settings)) continue;
        pool.set(id, { id, where: 'home', m, final: scoreFilm(m, p).final, votes: m.tmdb_votes || light.tmdb_votes || 0, ready: false });
      }
    }
  }

  const rank = (c) => c.final + (1 - p.conf) * popPoints(c.votes);
  const list = [...pool.values()].filter((c) => fitsMood(c.m.genres, ask.mood)).sort((a, b) => rank(b) - rank(a));

  const out = [];
  const used = new Map();
  let checks = 0;
  let i = 0;
  for (; i < list.length && out.length < SHOW; i++) {
    const c = list[i];
    if (!c.ready) {
      if (checks >= LAZY_CHECKS) continue;
      checks++;
      try {
        c.service = await confirmService(c.id, p.services);
        if (!c.service) continue;
        c.m = await ensureDetails(c.id);
      } catch { continue; }
      if (excludedBySettings(c.m, p.settings) || !fitsMood(c.m.genres, ask.mood)) continue;
      c.final = scoreFilm(c.m, p).final;
    }
    if (ask.time === 'short') {
      if (!c.m.runtime && c.where === 'home') {
        try { c.m = await ensureDetails(c.id); } catch { continue; }
      }
      if (!c.m.runtime || c.m.runtime >= SHORT_MIN) continue;
    }
    out.push(c);
  }

  const films = out.map((c) => {
    const because = becauseLine(c.m, p.liked, { used });
    let reason = because;
    if (!reason && p.conf < 0.3) {
      const where = c.where === 'theater' ? `at ${c.theatre || 'your theater'}` : `on ${c.service?.name || servicesPhrase(p.services)}`;
      const v = votesPhrase(c.m.tmdb_votes);
      reason = c.m.tmdb_rating ? `A crowd favorite ${where}: TMDB ${Number(c.m.tmdb_rating).toFixed(1)}${v ? ` from ${v}` : ''}` : `Popular right now ${where}`;
    }
    if (!reason) reason = c.reason ? c.reason.charAt(0).toUpperCase() + c.reason.slice(1) : reasonFor(c.m, scoreFilm(c.m, p), p);
    return card(c.m, {
      final: c.final, where: c.where, reason, watchlisted: p.watch.has(c.id),
      ...(c.where === 'theater' ? { theatre: c.theatre, next: c.next } : { service: c.service }),
    });
  });
  // More to show after these? (Unconfirmed home films may still fall away.)
  return { films, more: i < list.length };
}
