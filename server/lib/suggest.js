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
// (the client sends those ids back with "Show me 3 more").
//
// The bar. A film needs a match (the same final score every other page
// shows) of MATCH_FLOOR or more and a solid public score: TMDB 7.0+ from 200+
// votes, or Rotten Tomatoes 75%+, or IMDb 7.0+. A film with no public score
// at all (the thin-rating rule, lib/scoring.js) only counts when it's a
// theater film showing in the next 48 hours, and then on its match alone.
// When fewer than three pass, the bar comes down a step at a time (TIERS)
// and the answer says so in plain words.
//
// The order. Films that pass are ranked by a blend of match and public
// score: 60/40 from 20 ratings, 50/50 from 5 to 19, public score alone under
// 5 (the match means little yet). Three are then drawn by weighted random, a
// better-ranked film more likely (TEMPER), so the same answers don't always
// give the same three. In each set no two films share a director, and for
// "Surprise me" no three share a main genre.
//
// Memory. Every film shown is stored per person (wsw_shown) and not shown to
// them again for 7 days, unless fewer than three that pass would be left.
// RP_WSW_SEED (tests only) makes the draws repeatable.
import crypto from 'node:crypto';
import { all, run } from '../db.js';
import { scoredLineup } from './recommend.js';
import {
  personal, done, scoreFilm, reasonFor, streamingCandidates, filmData, ensureDetails, confirmService, weeklyList, currentLabel,
} from './home.js';
import { becauseLine } from './because.js';
import { getMovie } from './movies.js';
import { publicScoreForMovie } from './scoring.js';
import { servicesPhrase } from '../../public/js/services.js';
import { votesPhrase } from './util.js';
import { excludedBySettings } from './ranking.js';

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

// Calibrated on a copy of the real database (Either, Surprise me, Any
// length): 75 left the 700-rating friend 5 films and 70 left 9, so the floor
// came down to 65, the lowest allowed. What holds them back is how few films
// at their one theater they haven't rated, not the floor.
export const MATCH_FLOOR = 65;
export const MIN_TMDB_VOTES = 200;
// The bar and its two relaxed steps.
export const TIERS = [
  { match: MATCH_FLOOR, tmdb: 7.0, rt: 75, imdb: 7.0 },
  { match: Math.min(MATCH_FLOOR, 70), tmdb: 6.5, rt: 70, imdb: 6.5 },
  { match: Math.min(MATCH_FLOOR, 65), tmdb: 6.0, rt: 65, imdb: 6.0 },
];
const SOON_MS = 48 * 3600 * 1000;
const MEMORY_MS = 7 * 864e5;
// Rank points between films for e (2.7) times the chance of being drawn.
const TEMPER = 6;

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

// The public scores that clear a tier's bar, best first, as the card shows
// them ("RT 92%"). pub: publicScoreForMovie(); a thin TMDB rating is already
// left out of it.
export function publicPasses(pub, votes, tier = TIERS[0]) {
  const d = pub?.display || {};
  const out = [];
  if (d.rt != null && d.rt >= tier.rt) out.push({ v: d.rt, text: `RT ${d.rt}%` });
  if (d.imdb != null && d.imdb >= tier.imdb) out.push({ v: d.imdb * 10, text: `IMDb ${Number(d.imdb).toFixed(1)}` });
  if (d.tmdb != null && d.tmdb >= tier.tmdb && (votes ?? 0) >= MIN_TMDB_VOTES) out.push({ v: d.tmdb * 10, text: `TMDB ${Number(d.tmdb).toFixed(1)}` });
  return out.sort((a, b) => b.v - a.v);
}

// How much the match and the public score count in the ranking, by how many
// films the person has rated.
export function blendWeights(ratings) {
  if (ratings >= 20) return { match: 0.6, public: 0.4 };
  if (ratings >= 5) return { match: 0.5, public: 0.5 };
  return { match: 0, public: 1 };
}
export const rankScore = (match, publicCombined, w) => w.match * match + w.public * (publicCombined ?? 50);

// Does candidate c clear this tier? Returns the public line to show, or null.
function clears(c, tier) {
  if (c.final < tier.match) return null;
  if (c.pub.combined == null) return c.soon ? { text: 'No scores yet' } : null;
  return publicPasses(c.pub, c.votes, tier)[0] || null;
}

// A small seeded generator (mulberry32), so a test seed repeats exactly.
function seeded(str) {
  let a = crypto.createHash('sha256').update(str).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomFor(uid, ask, recent) {
  const seed = process.env.RP_WSW_SEED;
  if (!seed) return Math.random;
  return seeded([seed, uid, ask.where, ask.time, ask.mood, [...ask.exclude].sort((a, b) => a - b).join(','), [...recent].sort((a, b) => a - b).join(',')].join('|'));
}

// ---- memory ----------------------------------------------------------------
function recentlyShown(uid, now) {
  return new Set(all('SELECT tmdb_id FROM wsw_shown WHERE user_id = ? AND shown_at > ?', uid, now - MEMORY_MS).map((r) => r.tmdb_id));
}
function remember(uid, ids, now) {
  run('DELETE FROM wsw_shown WHERE user_id = ? AND shown_at <= ?', uid, now - MEMORY_MS);
  for (const id of ids) {
    run('INSERT INTO wsw_shown(user_id, tmdb_id, shown_at) VALUES(?,?,?) ON CONFLICT(user_id, tmdb_id) DO UPDATE SET shown_at = excluded.shown_at', uid, id, now);
  }
}

// ---- wording -----------------------------------------------------------------
const PLACE = { theater: ' in theaters', home: ' at home', either: ' right now' };
function relaxedNote(ask) {
  return `Not much great${MOODS[ask.mood] ? ' for this mood' : ''}${PLACE[ask.where]}. These are the closest.`;
}
function tryInstead(ask) {
  const t = [];
  if (MOODS[ask.mood]) t.push('another mood');
  if (ask.where === 'theater') t.push('At home');
  if (ask.where === 'home') t.push('Theater');
  if (ask.time === 'short') t.push('Any length');
  if (!t.length) return '';
  return ` Try ${t.length > 1 ? `${t.slice(0, -1).join(', ')} or ${t[t.length - 1]}` : t[0]}.`;
}


function card(m, extra) {
  return {
    tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster, genres: m.genres || [], runtime: m.runtime || null,
    tmdb_rating: m.tmdb_rating ?? null, ...extra,
  };
}

// ---- the candidates ------------------------------------------------------------
async function candidates(ask, p, now) {
  const wantTheater = ask.where !== 'home';
  const wantHome = ask.where !== 'theater';
  const skip = (id) => done(p, id) || ask.exclude.has(id);
  const pool = new Map(); // id -> candidate

  if (wantTheater) {
    for (const { m, e } of scoredLineup()) {
      if (skip(m.tmdb_id) || e.flags.excluded || pool.has(m.tmdb_id)) continue;
      // Any showing (not only the best one) in the next 48 hours.
      const soon = (e.showtimesByDay || []).some((d) => d.showtimes.some((s) => (s.start_epoch ?? 0) >= now && s.start_epoch - now <= SOON_MS));
      pool.set(m.tmdb_id, {
        id: m.tmdb_id, where: 'theater', m, final: e.final, votes: m.tmdb_votes ?? null, ready: true, reason: e.reason,
        pub: publicScoreForMovie(m, m.scores), soon,
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
      pool.set(e.tmdb_id, {
        id: e.tmdb_id, where: 'home', m, final: e.final, votes: m.tmdb_votes ?? null, ready: true, reason: e.reason, service: currentLabel(e.service),
        pub: publicScoreForMovie(m, m.scores), soon: false,
      });
    }
    // ...then, for a mood, that mood's films on their services, checked when drawn.
    if (MOODS[ask.mood]) {
      const extra = await streamingCandidates(p.services, { genreIds: MOODS[ask.mood].ids, pages: 1 });
      for (const [id, { light }] of extra) {
        if (skip(id) || pool.has(id)) continue;
        const m = filmData(id, light);
        if (excludedBySettings(m, p.settings)) continue;
        pool.set(id, {
          id, where: 'home', m, final: scoreFilm(m, p).final, votes: m.tmdb_votes ?? light.tmdb_votes ?? null, ready: false,
          pub: publicScoreForMovie(m, m.scores), soon: false,
        });
      }
    }
  }
  return [...pool.values()].filter((c) => fitsMood(c.m.genres, ask.mood) && !(ask.time === 'short' && c.m.runtime && c.m.runtime >= SHORT_MIN));
}

// Makes an unconfirmed home film ready (on the service, full details, scored
// again) and checks the runtime when "Under 2h" was asked. False: drop it.
async function settle(c, ask, p, budget) {
  if (!c.ready) {
    if (budget.checks >= LAZY_CHECKS) return false;
    budget.checks++;
    try {
      c.service = await confirmService(c.id, p.services);
      if (!c.service) return false;
      c.m = await ensureDetails(c.id);
    } catch { return false; }
    if (excludedBySettings(c.m, p.settings) || !fitsMood(c.m.genres, ask.mood)) return false;
    c.final = scoreFilm(c.m, p).final;
    c.pub = publicScoreForMovie(c.m, c.m.scores);
    c.votes = c.m.tmdb_votes ?? c.votes;
    c.ready = true;
  }
  if (ask.time === 'short') {
    if (!c.m.runtime && c.where === 'home') {
      try { c.m = await ensureDetails(c.id); } catch { return false; }
    }
    if (!c.m.runtime || c.m.runtime >= SHORT_MIN) return false;
  }
  return true;
}

// Would c fit beside the films already chosen?
function fitsSet(c, chosen, ask) {
  const dir = c.m.director;
  if (dir && chosen.some((x) => x.m.director === dir)) return false;
  if (ask.mood === 'surprise') {
    const g = (c.m.genres || [])[0];
    if (g && chosen.filter((x) => (x.m.genres || [])[0] === g).length >= 2) return false;
  }
  return true;
}

export async function suggest(body) {
  const ask = parseAsk(body);
  const p = personal();
  if (ask.where === 'home' && !p.services.length) return { films: [], more: false, needsServices: true };
  const now = Date.now();
  const recent = recentlyShown(p.uid, now);
  const w = blendWeights(p.rated.size);
  const list = await candidates(ask, p, now);
  for (const c of list) c.rank = rankScore(c.final, c.pub.combined, w);
  const random = randomFor(p.uid, ask, recent);
  const budget = { checks: 0 };
  const dropped = new Set();
  const chosen = [];

  // One weighted draw at a time from `group` until the set is full.
  const drawFrom = async (group, tierIdx) => {
    let left = group.filter((c) => !dropped.has(c.id) && !chosen.includes(c));
    while (chosen.length < SHOW && left.length) {
      left = left.filter((c) => fitsSet(c, chosen, ask));
      if (!left.length) break;
      const top = Math.max(...left.map((c) => c.rank));
      const weights = left.map((c) => Math.exp((c.rank - top) / TEMPER));
      let r = random() * weights.reduce((s, x) => s + x, 0);
      let i = 0;
      while (i < left.length - 1 && r >= weights[i]) { r -= weights[i]; i++; }
      const c = left[i];
      left.splice(i, 1);
      if (!await settle(c, ask, p, budget)) { dropped.add(c.id); continue; }
      // Settling can change the score; check the bar again.
      const line = clears(c, TIERS[tierIdx]);
      if (!line || !fitsSet(c, chosen, ask)) continue;
      c.line = line;
      c.tier = tierIdx;
      chosen.push(c);
    }
  };

  for (let t = 0; t < TIERS.length && chosen.length < SHOW; t++) {
    const passing = list.filter((c) => clears(c, TIERS[t]));
    await drawFrom(passing.filter((c) => !recent.has(c.id)), t);
    // Shown in the last 7 days: only when fewer than three others pass.
    await drawFrom(passing.filter((c) => recent.has(c.id)), t);
  }
  // The set in rank order, best first.
  chosen.sort((a, b) => b.rank - a.rank);

  const used = new Map();
  const films = chosen.map((c) => {
    const because = becauseLine(c.m, p.liked, { used });
    let reason = because;
    if (!reason && p.conf < 0.3) {
      const where = c.where === 'theater' ? `at ${c.theatre || 'your theater'}` : `on ${c.service?.name || servicesPhrase(p.services)}`;
      const v = votesPhrase(c.m.tmdb_votes);
      reason = c.m.tmdb_rating ? `A crowd favorite ${where}: TMDB ${Number(c.m.tmdb_rating).toFixed(1)}${v ? ` from ${v}` : ''}` : `Popular right now ${where}`;
    }
    if (!reason) reason = c.reason ? c.reason.charAt(0).toUpperCase() + c.reason.slice(1) : reasonFor(c.m, scoreFilm(c.m, p), p);
    return card(c.m, {
      final: c.final, publicLine: c.line.text, where: c.where, reason, watchlisted: p.watch.has(c.id),
      ...(c.where === 'theater' ? { theatre: c.theatre, next: c.next } : { service: c.service }),
    });
  });
  if (films.length) remember(p.uid, films.map((f) => f.tmdb_id), now);

  const relaxed = chosen.some((c) => c.tier > 0);
  const deepest = TIERS[TIERS.length - 1];
  const more = list.some((c) => !chosen.includes(c) && !dropped.has(c.id) && clears(c, deepest));
  let note = null;
  if (!films.length) note = `${ask.exclude.size ? 'That\'s everything that fits these answers.' : 'Nothing fits right now.'}${tryInstead(ask)}`;
  else if (relaxed) note = relaxedNote(ask);
  return { films, more, relaxed, note };
}

// Where the person stands with films the sheet showed them (it asks when it
// opens again on kept results): saved, rated (the stars), hidden.
export function suggestState(body = {}) {
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length > 30 || ids.some((x) => !Number.isInteger(x) || x <= 0)) throw Object.assign(new Error('ids must be a list of film ids.'), { status: 400 });
  const p = personal();
  const stars = new Map(all(`SELECT tmdb_id, rating FROM ratings WHERE user_id = ? AND tmdb_id IN (${ids.map(() => '?').join(',') || 'NULL'})`, p.uid, ...ids).map((r) => [r.tmdb_id, r.rating]));
  return { films: ids.map((id) => ({ tmdb_id: id, watchlisted: p.watch.has(id), rating: stars.get(id) ?? null, hidden: p.hidden.has(id) })) };
}
