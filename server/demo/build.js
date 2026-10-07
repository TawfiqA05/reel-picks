// Builds the demo's sample database: the made-up people of world.js with a
// history that gives every screen something to show (about 150 ratings, a
// watch log, a watchlist, notes, an "I'm going" plan, picks sent both ways,
// two friends to plan with), then the app's own refresh against the made-up
// theaters, so the scores, the weekly four, Last chance and Coming soon are
// worked out by the same code as on the real app.
//
// It runs in the database bound by server/demo/scope.js (a fresh copy of the
// empty schema), through lib/ code only. Every TMDB, OMDb and AMC call is
// answered in-process (net.js), or recorded once by scripts/demo-snapshot.mjs.
import { run, all, get, getSettings, setSetting } from '../db.js';
import { runAs, currentUser, OWNER_ID } from '../lib/user.js';
import { refreshAll, ingestOne, state as refreshState } from '../lib/refresh.js';
import { upsertRating } from '../lib/ratings.js';
import { logWatchedOn } from '../lib/alist.js';
import { setNote } from '../lib/notes.js';
import { planShowtime } from '../lib/plans.js';
import { sendPick } from '../lib/sends.js';
import { weeklyList } from '../lib/home.js';
import { getRecommendations } from '../lib/recommend.js';
import { backfillState } from '../lib/backfill.js';
import { initLockWeek } from '../lib/lock.js';
import { weekStartFriday, localYMD, addDays } from '../lib/util.js';
import * as tmdb from '../lib/tmdb.js';
import * as W from './world.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const at = (date, time) => new Date(`${date}T${time}:00`).toISOString();

// A film's stored record, as the ratings generator wants it.
function filmFacts(id) {
  const m = get('SELECT tmdb_id, title, year, genres, tmdb_rating, release_date FROM movies WHERE tmdb_id = ?', id);
  if (!m) return null;
  let genres = [];
  try { genres = JSON.parse(m.genres || '[]'); } catch { genres = []; }
  return { id, title: m.title, year: m.year, genres, vote_average: m.tmdb_rating, release_date: m.release_date };
}

async function ensureFilms(ids, { scores = true } = {}) {
  for (const id of ids) await ingestOne(id, scores ? {} : { detailsOnly: true });
  return ids.map(filmFacts).filter(Boolean);
}

function settingsFor(uid, patch) {
  for (const [k, v] of Object.entries(patch)) setSetting(k, v, { userId: uid });
}

const theatre = (t) => ({ theatreId: t.id, theatreName: t.name, theatreSlug: t.slug });

function people(now) {
  const created = new Date(now - 200 * 864e5).toISOString();
  run('UPDATE users SET name = ?, created_at = ? WHERE id = ?', W.SAM.name, created, OWNER_ID);
  for (const f of W.FRIENDS) {
    run('INSERT INTO users(id, name, created_at, last_seen_at, session_version) VALUES(?,?,?,?,1)',
      f.id, f.name, created, new Date(now - 864e5).toISOString());
  }
  const done = { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true, home: W.HOME };
  settingsFor(OWNER_ID, {
    ...done, ...theatre(W.RIVERSIDE),
    extraTheatres: [{ id: W.NORTHGATE.id, name: W.NORTHGATE.name, slug: W.NORTHGATE.slug }],
    streamingServices: W.SAM_SERVICES,
  });
  for (const f of W.FRIENDS) {
    settingsFor(f.id, { ...done, ...theatre(W.RIVERSIDE), extraTheatres: [], streamingServices: f.services, watchTogether: f.together });
  }
}

// Ratings spread over the last few years, newest densest.
function ratedAt(r, now) {
  const daysAgo = Math.floor(Math.pow(r(), 1.6) * 1000) + 12;
  const d = new Date(now - daysAgo * 864e5);
  d.setHours(19 + Math.floor(r() * 4), Math.floor(r() * 60), 0, 0);
  return d.toISOString();
}

export async function buildSample({ now = Date.now(), log = () => {} } = {}) {
  const t0 = Date.now();
  const snap = (await import('./snapshot.js')).snapshot();
  const F = snap.films;
  const today = localYMD(new Date(now));
  initLockWeek();
  people(now);

  // ---- what Sam and the friends have seen and rated --------------------------
  const classics = await ensureFilms(F.classics);
  const recent = await ensureFilms(F.recent);
  const playingIds = F.playing.map((f) => f.id);
  await ensureFilms(playingIds);
  log(`films: ${classics.length} classics, ${recent.length} from this year, ${playingIds.length} playing`);

  const samR = W.rng(7);
  // This year's releases Sam saw in theaters (the watch log and the year
  // recap), each rated the next day; then classics up to 150.
  const seenThisYear = recent.filter((f) => f.release_date && f.release_date < localYMD(new Date(now - 21 * 864e5))).slice(0, 18);
  const yearStart = `${today.slice(0, 4)}-01-04`;
  seenThisYear.forEach((f, i) => {
    const after = W.ymd(W.addDays(new Date(`${f.release_date}T12:00:00`), 3 + Math.floor(samR() * 12)));
    const date = after < yearStart ? W.ymd(W.addDays(new Date(`${yearStart}T12:00:00`), i * 9)) : after;
    if (date >= today) return;
    const where = i % 4 === 3 ? W.NORTHGATE : W.RIVERSIDE;
    runAs(OWNER_ID, () => logWatchedOn({ tmdb_id: f.id, title: f.title, date, at: at(date, '19:10'), in_weekly4: i % 3 !== 2, theatre: where.name }));
    upsertRating({ tmdb_id: f.id, title: f.title, year: f.year, rating: W.starsFor(f, W.SAM_LIKES, samR), source: 'manual', rated_at: at(W.ymd(W.addDays(new Date(`${date}T12:00:00`), 1)), '21:30'), userId: OWNER_ID });
  });
  const samClassics = W.shuffled(classics, 11).slice(0, 150 - seenThisYear.length - 1);
  for (const f of samClassics) {
    upsertRating({ tmdb_id: f.id, title: f.title, year: f.year, rating: W.starsFor(f, W.SAM_LIKES, samR), source: 'letterboxd', rated_at: ratedAt(samR, now), userId: OWNER_ID });
  }
  // One film from this week's lineup, seen this week: the A-List week has one used.
  const week = weekStartFriday(new Date(now));
  const seenDay = localYMD(new Date(now - 864e5)) >= week ? localYMD(new Date(now - 864e5)) : today;
  const seenNow = filmFacts(playingIds[3]);
  if (seenNow) {
    runAs(OWNER_ID, () => logWatchedOn({ tmdb_id: seenNow.id, title: seenNow.title, date: seenDay, at: at(seenDay, '13:50'), in_weekly4: true, theatre: W.RIVERSIDE.name }));
    upsertRating({ tmdb_id: seenNow.id, title: seenNow.title, year: seenNow.year, rating: 4.5, source: 'manual', rated_at: new Date(Math.min(now, Date.parse(at(seenDay, '22:40')))).toISOString(), userId: OWNER_ID });
  }

  W.FRIENDS.forEach((fr, n) => {
    const r = W.rng(100 + n);
    for (const f of W.shuffled([...classics, ...recent], 200 + n).slice(0, fr.count)) {
      upsertRating({ tmdb_id: f.id, title: f.title, year: f.year, rating: W.starsFor(f, fr.likes, r), source: 'letterboxd', rated_at: ratedAt(r, now), userId: fr.id });
    }
  });

  // A few lines Sam wrote, on films Sam rated highly.
  const notesDone = new Set();
  for (const row of all('SELECT r.tmdb_id, m.genres FROM ratings r JOIN movies m ON m.tmdb_id = r.tmdb_id WHERE r.user_id = ? AND r.rating >= 4 ORDER BY r.rated_at DESC', OWNER_ID)) {
    let genres = [];
    try { genres = JSON.parse(row.genres || '[]'); } catch { genres = []; }
    const g = genres.find((x) => W.NOTES[x] && !notesDone.has(x));
    if (!g) continue;
    notesDone.add(g);
    setNote(OWNER_ID, row.tmdb_id, W.NOTES[g]);
    if (notesDone.size >= Object.keys(W.NOTES).length) break;
  }

  // Not for me: one film in the lineup Sam would never pick.
  const hide = playingIds.map(filmFacts).find((f) => f && f.genres.includes('Horror')) || filmFacts(playingIds[playingIds.length - 2]);
  if (hide) run('INSERT INTO hidden_movies(user_id, tmdb_id, title, hidden_at) VALUES(?,?,?,?)', OWNER_ID, hide.id, hide.title, new Date(now - 3 * 864e5).toISOString());

  // ---- the week: the refresh against the made-up theaters --------------------
  log('refresh');
  const result = await refreshAll({ force: true });
  if (!result?.finishedAt) throw new Error(`the demo refresh did not finish: ${JSON.stringify(result).slice(0, 300)}`);

  // Watchlists: films playing, two coming soon, two classics nobody rated.
  // Coming soon as the refresh used to flag it for everyone: TMDB's list or
  // an advance showing after this week, and not playing.
  const weekEnd = localYMD(addDays(new Date(result.startedAt), 6));
  const coming = all(`SELECT tmdb_id FROM movies WHERE playing = 0 AND (upcoming = 1
    OR tmdb_id IN (SELECT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date > ?)) ORDER BY release_date LIMIT 6`, weekEnd).map((r) => r.tmdb_id);
  const unrated = F.classics.filter((id) => !get('SELECT 1 FROM ratings WHERE user_id = ? AND tmdb_id = ?', OWNER_ID, id));
  const samList = [playingIds[2], playingIds[6], playingIds[9], coming[0], coming[2], ...unrated.slice(0, 2)].filter(Boolean);
  await ensureFilms(samList, { scores: false });
  samList.forEach((id, i) => run('INSERT OR IGNORE INTO watchlist(user_id, tmdb_id, added_at) VALUES(?,?,?)', OWNER_ID, id, new Date(now - (i + 1) * 2.3 * 864e5).toISOString()));
  for (const [uid, ids] of [[2, [playingIds[2], playingIds[7], coming[1]]], [3, [playingIds[4], playingIds[0]]]]) {
    for (const id of ids.filter(Boolean)) run('INSERT OR IGNORE INTO watchlist(user_id, tmdb_id, added_at) VALUES(?,?,?)', uid, id, new Date(now - 4 * 864e5).toISOString());
  }

  // Sam's weekly four, locked by the refresh.
  const four = runAs(OWNER_ID, () => getRecommendations(), { isOwner: true, guest: false }).weekly4 || [];
  const top = four[0]?.tmdb_id ?? playingIds[0];
  const evening = (id, day, theatreId) => get(`SELECT id FROM showtimes WHERE tmdb_id = ? AND theatre_id = ? AND date = ? AND start_local >= ?
    ORDER BY start_local LIMIT 1`, id, theatreId, day, `${day}T18:30`)?.id;

  // I'm going: Sam to the top pick in two days, Maya to the film they both saved.
  const inTwo = localYMD(new Date(now + 2 * 864e5));
  const tomorrow = localYMD(new Date(now + 864e5));
  const samShow = evening(top, inTwo, W.RIVERSIDE.id) || evening(top, tomorrow, W.RIVERSIDE.id);
  if (samShow) planShowtime(OWNER_ID, samShow, now);
  const mayaFilm = four.map((f) => f.tmdb_id).find((id) => id !== top) || playingIds[2];
  const mayaShow = evening(mayaFilm, tomorrow, W.RIVERSIDE.id) || evening(mayaFilm, inTwo, W.RIVERSIDE.id);
  if (mayaShow) planShowtime(2, mayaShow, now);

  // Send a pick: one from Maya waiting for Sam, one Sam sent Theo.
  const fromMaya = playingIds.find((id) => id !== top && id !== mayaFilm && !four.some((f) => f.tmdb_id === id) && id !== hide?.id && id !== seenNow?.id);
  const as = (userId, isOwner, fn) => runAs(userId, () => fn(currentUser()), { isOwner, guest: false });
  if (fromMaya) as(2, false, (me) => sendPick(me, { to: OWNER_ID, tmdb_id: fromMaya, note: W.SEND_TO_SAM }, now - 5 * 3600e3));
  if (seenNow) as(OWNER_ID, true, (me) => sendPick(me, { to: 3, tmdb_id: seenNow.id, note: W.SEND_FROM_SAM }, now - 20 * 3600e3));

  // At home and What should I watch?: this week's streaming picks, worked out now.
  for (const uid of [OWNER_ID, 2, 3]) await runAs(uid, () => weeklyList());

  // The header search's list of names it can correct a typo to (lib/people.js).
  for (let page = 1; page <= 5; page++) {
    for (const f of await tmdb.wellKnown(page).catch(() => [])) await tmdb.filmPeople(f.id).catch(() => {});
  }

  // Background work the refresh started (credits, poster colours) finishes first.
  for (let i = 0; i < 600 && (backfillState.running || refreshState.running); i++) await sleep(50);
  // Poster colours for the dark theme's glow come with the snapshot.
  for (const [id, [color, src]] of Object.entries(snap.colors || {})) {
    run('UPDATE movies SET poster_color = ?, poster_color_src = ? WHERE tmdb_id = ?', color, src, Number(id));
  }
  setSetting('lastRefresh', new Date(now).toISOString());
  log(`built in ${Date.now() - t0} ms: ${get('SELECT COUNT(*) AS n FROM ratings WHERE user_id = 1').n} ratings for Sam, four: ${four.map((f) => f.title || f.tmdb_id).join(', ')}`);
  return { today, four: four.map((f) => f.tmdb_id), settings: getSettings({ userId: OWNER_ID }) };
}
