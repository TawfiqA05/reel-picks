// "At home": each person's 4 best matches this week from films included with
// the streaming services they chose (public/js/services.js), in the US.
//
// Candidates come from TMDB's discover, per service: the most popular films
// and the best rated, all with 50+ votes. Each is scored with the same taste
// model and the same final-score formula as the theater picks (lib/taste.js,
// lib/ranking.js), with the user's own weights; the theater-only boosts (IMAX,
// showtime windows, urgency) don't apply at home, the watchlist boost does.
// The best-scoring ones get full details (director, cast, runtime) and are
// scored again, then each is confirmed with TMDB's watch providers: included
// with one of the person's paid services ("flatrate"), or free with ads for
// the free option. Rent and buy never count.
//
// Weekly and stable: the ranked list is worked out once per A-List week (from
// Friday) and per set of services, stored, and served from storage all week.
// Serving only drops what the person has rated, marked seen or hidden since,
// so the next film moves up and nothing else moves. Choosing different
// services starts a new list.
//
// Every TMDB call goes through the shared throttle (lib/backfill.js), and
// discover lists, details and provider lookups are all cached, so a repeat
// costs nothing and other people with the same services share the work.
import { get, run, all, getSettings } from '../db.js';
import { runAs, currentUserId } from './user.js';
import * as tmdb from './tmdb.js';
import { tmdbThrottle } from './backfill.js';
import { getMovie, upsertFullMovie } from './movies.js';
import { buildProfile, confidence, tasteMatch, topTasteFactor } from './taste.js';
import { finalScore, buildReason } from './ranking.js';
import { publicScoreForMovie } from './scoring.js';
import { profileRows } from './ratings.js';
import { likedFilms, becauseLine } from './because.js';
import { weekStartFriday } from './util.js';
import { SERVICES, cleanServices, serviceByKey } from '../../public/js/services.js';

const MIN_VOTES = 50;
const PICKS = 4;
const DETAILS_TOP = 48; // candidates that get full details and a second scoring
const KEEP = 36; // confirmed films kept per week (the four, and what moves up)

// ---- the person ------------------------------------------------------------

// What scoring needs to know about the person in context.
export function personal() {
  const uid = currentUserId();
  const settings = getSettings();
  const profile = buildProfile(profileRows());
  const ids = (sql) => new Set(all(sql, uid).map((r) => r.tmdb_id));
  return {
    uid,
    settings,
    profile,
    conf: confidence(profile),
    weights: { public: Number(settings.weightPublic) || 0, taste: Number(settings.weightTaste) || 0 },
    rated: ids('SELECT tmdb_id FROM ratings WHERE user_id = ?'),
    seen: ids('SELECT DISTINCT tmdb_id FROM watched WHERE user_id = ?'),
    hidden: ids('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?'),
    watch: ids('SELECT tmdb_id FROM watchlist WHERE user_id = ?'),
    liked: likedFilms(uid),
    services: cleanServices(settings.streamingServices),
  };
}

export const done = (p, id) => p.rated.has(id) || p.seen.has(id) || p.hidden.has(id);

export function excludedBySettings(movie, settings) {
  const exG = new Set(settings.excludedGenres || []);
  if (movie.mpaa && (settings.excludedMpaa || []).includes(movie.mpaa)) return true;
  return (movie.genres || []).some((g) => exG.has(g));
}

// The theater picks' score, minus the theater-only boosts.
export function scoreFilm(movie, p) {
  const pub = publicScoreForMovie(movie, movie.scores);
  const t = { genres: movie.genres, director: movie.director, cast: movie.cast };
  const tm = tasteMatch(t, p.profile);
  const boosts = p.watch.has(movie.tmdb_id) ? Number(p.settings.watchlistBoost) || 0 : 0;
  const final = finalScore({ publicCombined: pub.combined, tasteScore: tm.score, conf: p.conf, weights: p.weights, boosts });
  return { final, pub, topTaste: topTasteFactor(t, p.profile) };
}

// The one-line reason: a film they rated highly, or else what the score rests on.
export function reasonFor(movie, scored, p, { fallback = null, used = null } = {}) {
  const because = becauseLine(movie, p.liked, { used });
  if (because) return because;
  if (fallback) return fallback;
  if (p.conf < 0.5 || !scored.topTaste) {
    const votes = movie.tmdb_votes ? `${movie.tmdb_votes >= 1000 ? `${Math.round(movie.tmdb_votes / 1000)}k` : movie.tmdb_votes} votes` : null;
    return movie.tmdb_rating ? `Loved by viewers: TMDB ${Number(movie.tmdb_rating).toFixed(1)}${votes ? ` from ${votes}` : ''}` : 'Popular right now';
  }
  const r = buildReason({ pub: scored.pub, topTaste: scored.topTaste, conf: p.conf });
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// ---- candidates --------------------------------------------------------------

// Films the chosen services carry, by id, each with the services it came
// from. `genreIds` narrows the lists to those TMDB genres ("What should I
// watch?" moods).
export async function streamingCandidates(serviceKeys, { genreIds = null, pages = 2 } = {}) {
  const out = new Map();
  for (const key of serviceKeys) {
    const svc = serviceByKey(key);
    if (!svc) continue;
    const monetization = svc.free ? 'ads|free' : 'flatrate';
    const lists = [];
    for (let page = 1; page <= pages; page++) lists.push({ sort: 'popularity.desc', page });
    lists.push({ sort: 'vote_average.desc', page: 1, minVotes: 1000 });
    for (const l of lists) {
      const rows = await tmdb.discoverStreaming(svc.providers, {
        monetization, sort: l.sort, page: l.page, minVotes: l.minVotes || MIN_VOTES, gate: tmdbThrottle,
        ...(genreIds ? { genres: genreIds } : {}),
      });
      for (const r of rows) {
        if ((r.tmdb_votes ?? 0) < MIN_VOTES) continue;
        const e = out.get(r.tmdb_id) || { light: r, from: new Set() };
        e.from.add(key);
        out.set(r.tmdb_id, e);
      }
    }
  }
  return out;
}

// The stored record when it has details, else the discover row.
export function filmData(id, light) {
  const m = getMovie(id);
  return m?.details_at ? m : { ...light, ...(m ? { scores: m.scores } : {}) };
}

// Full details (director, cast, runtime), fetched once and kept for everyone.
export async function ensureDetails(id) {
  const m = getMovie(id);
  if (m?.details_at) return m;
  upsertFullMovie(tmdb.normalizeDetails(await tmdb.details(id, { gate: tmdbThrottle })));
  return getMovie(id);
}

// Is the film included with (or free on) one of these services right now?
// Returns { key, name, logo } for the first that has it, or null.
export async function confirmService(id, serviceKeys) {
  const wp = await tmdb.watchProviders(id, { gate: tmdbThrottle });
  if (!wp) return null;
  for (const key of serviceKeys) {
    const svc = serviceByKey(key);
    const offered = svc.free ? (wp.free || []) : (wp.flatrate || []);
    // The service's own listing first (HBO Max itself, not HBO Max as an Amazon channel).
    const hit = svc.providers.map((pid) => offered.find((x) => x.id === pid)).find(Boolean);
    if (hit) return { key, name: svc.name, provider: hit.name, logo: hit.logo };
  }
  return null;
}

// The TMDB collection (franchise) a film belongs to, from its cached details.
async function collectionOf(id) {
  try { return (await tmdb.details(id, { gate: tmdbThrottle }))?.belongs_to_collection?.id ?? null; } catch { return null; }
}

// ---- the weekly list -----------------------------------------------------------

const servicesKey = (keys) => cleanServices(keys).join(',');
const computing = new Map(); // userId -> Promise
const failed = new Map(); // userId -> { at, message }

async function compute(uid, week, keys) {
  return runAs(uid, async () => {
    const p = personal();
    const cands = await streamingCandidates(keys);
    let ranked = [];
    for (const [id, { light }] of cands) {
      if (done(p, id)) continue;
      const m = filmData(id, light);
      if (excludedBySettings(m, p.settings)) continue;
      ranked.push({ id, light, m, popularity: light.popularity || 0, score: scoreFilm(m, p).final });
    }
    ranked.sort((a, b) => b.score - a.score || b.popularity - a.popularity);
    // The front of the list gets full details, then everything is scored again.
    for (const c of ranked.slice(0, DETAILS_TOP)) {
      try { c.m = await ensureDetails(c.id); } catch (e) { if (e.status !== 404) throw e; }
    }
    ranked = ranked.filter((c) => !excludedBySettings(c.m, p.settings));
    for (const c of ranked) c.scored = scoreFilm(c.m, p);
    ranked.sort((a, b) => b.scored.final - a.scored.final || b.popularity - a.popularity);
    const keep = [];
    const reasonsUsed = new Map(); // liked film -> times cited, so four picks don't all cite one film
    for (const c of ranked) {
      if (keep.length >= KEEP) break;
      const service = await confirmService(c.id, keys);
      if (!service) continue;
      // Every kept film has a full record: its card, its movie page, its runtime.
      if (!c.m.details_at) {
        try { c.m = await ensureDetails(c.id); c.scored = scoreFilm(c.m, p); } catch (e) { if (e.status === 404) continue; throw e; }
        if (excludedBySettings(c.m, p.settings)) continue;
      }
      keep.push({ tmdb_id: c.id, final: c.scored.final, reason: reasonFor(c.m, c.scored, p, { used: reasonsUsed }), service, collection: await collectionOf(c.id) });
    }
    // One film per franchise up front: a second Harry Potter waits behind
    // everything else (it moves up when the first is rated, seen or hidden).
    const seenCollections = new Set();
    const firsts = [];
    const repeats = [];
    for (const e of keep) {
      if (e.collection && seenCollections.has(e.collection)) repeats.push(e);
      else { if (e.collection) seenCollections.add(e.collection); firsts.push(e); }
    }
    keep.splice(0, keep.length, ...firsts, ...repeats);
    run(`INSERT INTO home_picks(user_id, week_start, services_key, computed_at, ranked) VALUES(?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET week_start = excluded.week_start, services_key = excluded.services_key,
           computed_at = excluded.computed_at, ranked = excluded.ranked`,
    uid, week, servicesKey(keys), new Date().toISOString(), JSON.stringify(keep));
    return keep.length;
  });
}

function startCompute(uid, week, keys) {
  if (computing.has(uid)) return computing.get(uid);
  failed.delete(uid);
  const job = compute(uid, week, keys)
    .catch((e) => {
      failed.set(uid, { at: new Date().toISOString(), message: e.message });
      console.error(`[home] picks for user ${uid}: ${e.message}`);
    })
    .finally(() => computing.delete(uid));
  computing.set(uid, job);
  return job;
}

// The stored list for this week and these services, or null.
function stored(uid, week, keys) {
  const row = get('SELECT * FROM home_picks WHERE user_id = ?', uid);
  if (!row || row.week_start !== week || row.services_key !== servicesKey(keys)) return null;
  try { return JSON.parse(row.ranked); } catch { return null; }
}

// A stored entry's service under today's name for it (a list saved before a
// rename, "Max" to "HBO Max", still shows the new name).
export function currentLabel(service) {
  if (!service) return service;
  const svc = serviceByKey(service.key);
  return svc ? { ...service, name: svc.name } : service;
}

// Card data for one stored entry.
export function homeCard(entry, p) {
  const m = getMovie(entry.tmdb_id) || {};
  return {
    tmdb_id: entry.tmdb_id,
    title: m.title,
    year: m.year,
    poster: m.poster,
    backdrop: m.backdrop,
    genres: m.genres || [],
    runtime: m.runtime || null,
    tmdb_rating: m.tmdb_rating ?? null,
    tmdb_votes: m.tmdb_votes ?? null,
    final: entry.final,
    reason: entry.reason,
    service: currentLabel(entry.service),
    watchlisted: p.watch.has(entry.tmdb_id),
    myRating: null,
  };
}

// GET /api/home-picks for the person in context.
//   { status: 'none' }                      no services chosen
//   { status: 'computing', services }       this week's list is being worked out
//   { status: 'ready', services, weekStart, picks: [4] }
//   { status: 'error', services, message }  TMDB was unreachable; try again later
export function homePicks() {
  const p = personal();
  if (!p.services.length) return { status: 'none', services: [] };
  const week = weekStartFriday();
  const list = stored(p.uid, week, p.services);
  if (!list) {
    const err = failed.get(p.uid);
    if (err && !computing.has(p.uid) && Date.now() - Date.parse(err.at) < 5 * 60 * 1000) {
      return { status: 'error', services: p.services, message: 'Couldn\'t reach TMDB to find your home picks. Try again in a few minutes.' };
    }
    startCompute(p.uid, week, p.services);
    return { status: 'computing', services: p.services };
  }
  const picks = list.filter((e) => !done(p, e.tmdb_id)).slice(0, PICKS).map((e) => homeCard(e, p));
  return { status: 'ready', services: p.services, weekStart: week, picks };
}

// This week's confirmed list (for "What should I watch?"), computing it first
// if needed.
export async function weeklyList() {
  const p = personal();
  if (!p.services.length) return [];
  const week = weekStartFriday();
  let list = stored(p.uid, week, p.services);
  if (!list) {
    await startCompute(p.uid, week, p.services);
    list = stored(p.uid, week, p.services) || [];
  }
  return list;
}

// Background: work out this week's list for everyone who chose services and
// doesn't have one yet, one person at a time (the server's 15-minute tick).
let warming = false;
export async function warmHomePicks(userIds) {
  if (warming) return;
  warming = true;
  try {
    const week = weekStartFriday();
    for (const uid of userIds) {
      const keys = cleanServices(getSettings({ userId: uid }).streamingServices);
      if (!keys.length || stored(uid, week, keys)) continue;
      await startCompute(uid, week, keys);
    }
  } finally {
    warming = false;
  }
}

export { SERVICES };
