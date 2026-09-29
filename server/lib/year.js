// "Your year in movies": a December recap of the caller's own year, read
// straight from their ratings, watch log, notes and plans. Read only: it
// writes nothing, so no score, pick or weekly four can move because of it.
//
// It opens from December 1 through January 15, local time (the server's TZ,
// the same local time Stats counts months in), for the year that's ending:
// in December that's this year, in January last year. The owner can open a
// preview any day from Settings; it shows this year so far (last year in the
// first half of January, as the real one does).
//
// The counting follows Stats wherever Stats shows the same thing:
//   films seen      distinct films in the watch log with a watched_date in
//                   the year (Stats' "seen in theaters, logged this year")
//   top rankings    films per genre, director and actor, deduped per film,
//                   ranked by films, then the person's average rating, then
//                   name (Stats' ranking, lib/recommend.js), over the films
//                   they saw or rated in the year
//   movie plan      each local month's tickets (watch-log rows not brought
//                   in from Letterboxd) at their logged price, less the plan's
//                   fee, as Stats' "saved this month" (lib/alist.js)
//   weekly picks    watch-log rows stamped in_weekly4, as the pick hit-rate
// A rating's day is its local day: an app rating carries a UTC time, an
// imported one often just a date.
import { all, get, getSettings } from '../db.js';
import { localYMD, round2 } from './util.js';
import { currentUser, currentUserId, OWNER_ID } from './user.js';
import { ownerName } from './guest.js';
import { userName } from './accounts.js';
import { notesOf } from './notes.js';
import { groupKeys } from './recommend.js';
import { planOf } from '../../public/js/plans.js';

// A film counts toward the full recap from this many films in the year;
// under it the recap is the short, friendly version.
export const FULL_FROM = 5;
const SHARE_POSTERS = 4;

// Is the recap open today, and for which year?
export function yearWindow(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = January
  if (m === 11) return { open: true, year: y };
  if (m === 0 && now.getDate() <= 15) return { open: true, year: y - 1 };
  // Closed. A preview shows this year so far.
  return { open: false, year: y };
}

// The local YYYY-MM-DD of a stored time: a plain date as it is, a timestamp
// in the server's local time.
export function localDay(s) {
  if (s == null || s === '') return null;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const t = Date.parse(str);
  return Number.isFinite(t) ? localYMD(new Date(t)) : null;
}

const parse = (v) => { try { return (typeof v === 'string' ? JSON.parse(v) : v) || []; } catch { return []; } };
const monthsOf = (year, lastMonth) => Array.from({ length: lastMonth }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

// The films the person saw or rated in `year`, one entry each, with what the
// recap needs about them.
function filmsOfYear(uid, year) {
  const Y = String(year);
  const seen = all(
    `SELECT w.tmdb_id, w.title, w.watched_date, w.in_weekly4, w.ticket_price, w.source, w.theatre
       FROM watched w WHERE w.user_id = ? AND substr(w.watched_date, 1, 4) = ?`,
    uid, Y,
  );
  const ratings = all('SELECT tmdb_id, title, year, rating, rated_at FROM ratings WHERE user_id = ?', uid)
    .map((r) => ({ ...r, day: localDay(r.rated_at) }));
  const rated = ratings.filter((r) => r.day && r.day.startsWith(`${Y}-`));
  const ratingOf = new Map(ratings.map((r) => [r.tmdb_id, r.rating]));
  const films = new Map();
  const film = (id, title) => {
    if (!films.has(id)) films.set(id, { tmdb_id: id, title: title || null, days: [], seen: false, ratedInYear: false, rating: ratingOf.get(id) ?? null });
    return films.get(id);
  };
  for (const w of seen) { const f = film(w.tmdb_id, w.title); f.days.push(w.watched_date); f.seen = true; }
  for (const r of rated) { const f = film(r.tmdb_id, r.title); f.days.push(r.day); f.ratedInYear = true; f.ratedDay = r.day; }
  if (films.size) {
    const ids = [...films.keys()];
    const meta = new Map(all(`SELECT tmdb_id, title, year, poster, genres, director, "cast" FROM movies WHERE tmdb_id IN (${ids.map(() => '?').join(',')})`, ...ids)
      .map((m) => [m.tmdb_id, m]));
    for (const f of films.values()) {
      const m = meta.get(f.tmdb_id);
      f.meta = m || null;
      f.title = (m?.title || f.title || `Movie ${f.tmdb_id}`);
      f.year = m?.year ?? null;
      f.poster = m?.poster || null;
      f.days.sort();
      f.first = f.days[0];
      f.last = f.days[f.days.length - 1];
    }
  }
  return { films: [...films.values()], seen, rated };
}

// Stats' ranking over the year's films: films per name (deduped per film),
// then the average of the person's ratings among them, then the name.
function topOf(films, kind) {
  const m = new Map();
  for (const f of films) {
    if (!f.meta) continue; // like Stats: a film with no details has no genres or people
    for (const k of groupKeys(kind, f.meta)) {
      const e = m.get(k) || { n: 0, sum: 0, rated: 0 };
      e.n++;
      if (f.rating != null) { e.sum += Number(f.rating); e.rated++; }
      m.set(k, e);
    }
  }
  const avg = (e) => (e.rated ? Math.round((e.sum / e.rated) * 100) / 100 : -1);
  const list = [...m].map(([name, e]) => ({ name, n: e.n, avg: avg(e) }))
    .sort((a, b) => b.n - a.n || b.avg - a.avg || a.name.localeCompare(b.name));
  const top = list[0];
  return top && top.n >= 2 ? { name: top.name, n: top.n } : null;
}

const filmShape = (f) => ({ tmdb_id: f.tmdb_id, title: f.title, year: f.year, poster: f.poster });

// The plan's year: each local month from the first with a ticket through the
// year's last month so far, counted as Stats counts one month.
function planYear(seen, settings, year, now) {
  const tickets = seen.filter((w) => w.source == null);
  if (!tickets.length) return null;
  const plan = planOf(settings);
  const fee = plan.subscription ? Number(settings.alistMonthlyFee) || 0 : 0;
  const lastMonth = year < now.getFullYear() ? 12 : now.getMonth() + 1;
  const firstMonth = Math.min(...tickets.map((w) => Number(w.watched_date.slice(5, 7))));
  const months = monthsOf(year, lastMonth).slice(firstMonth - 1).map((month) => {
    const rows = tickets.filter((w) => w.watched_date.startsWith(month));
    const value = rows.reduce((s, r) => s + (Number(r.ticket_price) || Number(settings.avgTicketPrice) || 0), 0);
    return { month, tickets: rows.length, value: round2(value), fee, saved: round2(value - fee) };
  });
  const value = round2(months.reduce((s, m) => s + m.value, 0));
  return {
    kind: 'plan',
    subscription: plan.subscription,
    planName: plan.subscription ? plan.name : null,
    units: plan.units,
    tickets: tickets.length,
    value,
    fees: round2(months.reduce((s, m) => s + m.fee, 0)),
    saved: plan.subscription ? round2(months.reduce((s, m) => s + m.saved, 0)) : null,
    months,
  };
}

// The caller's recap for `year`. Everything in it is theirs.
export function buildRecap(year, { now = new Date(), preview = false } = {}) {
  const uid = currentUserId();
  const me = currentUser();
  const settings = getSettings();
  const name = (uid === OWNER_ID ? ownerName() : userName(uid)) || 'You';
  const { films, seen, rated } = filmsOfYear(uid, year);
  const short = films.length < FULL_FROM;
  const cards = [];
  cards.push({ kind: 'intro', films: films.length });

  if (!films.length) {
    cards.push({ kind: 'start' });
    return { year, name, initial: name.trim().charAt(0).toUpperCase() || '?', preview, short: true, owner: Boolean(me?.isOwner), cards, share: null };
  }

  const seenCount = new Set(seen.map((w) => w.tmdb_id)).size;
  cards.push({ kind: 'numbers', seen: seenCount, rated: rated.length, films: films.length });

  if (!short) {
    const director = topOf(films, 'director');
    const actor = topOf(films, 'actor');
    const genre = topOf(films, 'genre');
    if (director || actor || genre) cards.push({ kind: 'tops', director, actor, genre });
  }

  // Where they went: the films they saw this year whose theater the watch
  // log knows (saved from an "I'm going" plan, lib/alist.js), and the
  // showings they said they were going to this year (plans still on file,
  // not answered yet) whose start has passed. A film seen with no theater on
  // record isn't counted anywhere.
  const visits = new Map();
  const visit = (name) => { const t = String(name || '').trim(); if (t) visits.set(t, (visits.get(t) || 0) + 1); };
  for (const w of seen) visit(w.theatre);
  for (const p of all('SELECT theatre_name, date FROM plans WHERE user_id = ? AND substr(date, 1, 4) = ? AND start_epoch <= ?', uid, String(year), now.getTime())) visit(p.theatre_name);
  if (visits.size) {
    const [theater, n] = [...visits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    cards.push({ kind: 'theater', name: theater, showings: n });
  }

  if (!short) {
    const byMonth = new Map();
    for (const f of films) byMonth.set(f.first.slice(0, 7), (byMonth.get(f.first.slice(0, 7)) || 0) + 1);
    const [month, n] = [...byMonth].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const first = films.slice().sort((a, b) => a.first.localeCompare(b.first) || a.title.localeCompare(b.title))[0];
    const last = films.slice().sort((a, b) => b.last.localeCompare(a.last) || a.title.localeCompare(b.title))[0];
    cards.push({
      kind: 'months',
      busiest: { month, films: n },
      first: { ...filmShape(first), date: first.first },
      last: { ...filmShape(last), date: last.last },
    });
  }

  const plan = planYear(seen, settings, year, now);
  if (plan) cards.push(plan);

  const pickIds = new Set(seen.filter((w) => w.in_weekly4).map((w) => w.tmdb_id));
  if (pickIds.size) {
    const picks = films.filter((f) => pickIds.has(f.tmdb_id));
    const best = picks.filter((f) => f.rating != null)
      .sort((a, b) => b.rating - a.rating || b.last.localeCompare(a.last) || a.title.localeCompare(b.title))[0];
    cards.push({ kind: 'picks', seen: pickIds.size, best: best ? { ...filmShape(best), rating: best.rating } : null });
  }

  const ratedFilms = films.filter((f) => f.rating != null);
  const notes = notesOf(uid);
  const byRating = ratedFilms.slice()
    .sort((a, b) => b.rating - a.rating || Number(b.seen) - Number(a.seen) || b.last.localeCompare(a.last) || a.title.localeCompare(b.title));
  if (byRating.length) {
    const top = byRating[0];
    cards.push({ kind: 'best', film: { ...filmShape(top), rating: top.rating, note: notes.get(top.tmdb_id)?.note || null } });
  }

  // The summary, and what the saved image carries: the numbers, the top
  // genre and director, and up to four posters of their highest-rated films.
  const tops = cards.find((c) => c.kind === 'tops');
  const posters = byRating.filter((f) => f.poster).slice(0, SHARE_POSTERS).map(filmShape);
  const summary = {
    kind: 'summary',
    seen: seenCount,
    rated: rated.length,
    films: films.length,
    genre: tops?.genre?.name || null,
    director: tops?.director?.name || null,
    posters,
  };
  cards.push(summary);
  return { year, name, initial: name.trim().charAt(0).toUpperCase() || '?', preview, short, owner: Boolean(me?.isOwner), cards, share: { posters: posters.map((p) => p.tmdb_id) } };
}

// GET /api/year: the open recap, or the owner's preview. null when closed
// for this caller.
export function recapFor({ preview = false, now = new Date() } = {}) {
  const w = yearWindow(now);
  if (w.open) return buildRecap(w.year, { now });
  if (preview && currentUser()?.isOwner) return buildRecap(w.year, { now, preview: true });
  return null;
}

// A poster on the caller's saved image: the film's stored TMDB poster at a
// size that fills a quarter of the image. Only films on their own recap.
export function sharePosterUrl(tmdbId, { preview = false } = {}) {
  const r = recapFor({ preview });
  if (!r?.share?.posters.includes(tmdbId)) return null;
  const p = get('SELECT poster FROM movies WHERE tmdb_id = ?', tmdbId)?.poster;
  return typeof p === 'string' && p.startsWith('https://image.tmdb.org/') ? p.replace(/\/(w\d+|original)\//, '/w500/') : null;
}
