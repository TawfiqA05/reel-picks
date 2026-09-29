// Your year in movies (server/lib/year.js) through the API:
//
//   window    closed on Nov 30 and Jan 16, open on Dec 1 and Jan 15 for the
//             year that's ending (2026 both times), local time; the owner's
//             preview any day, a friend's refused; /api/status says which
//   numbers   every figure on every card equals an independent count from
//             the database for the same local-time year, and the ones Stats
//             shows too equal Stats (seen this year, this month's tickets and
//             savings, picks watched, the top rankings and ratings when the
//             whole history is in the year)
//   cards     each card only with enough behind it: the owner, the
//             700-rating friend, a 3-rating friend, a brand-new friend and a
//             friend whose whole history is this year each get their set;
//             short friendly versions, never an empty card; no theater card
//             when no theater is known
//   theater   a seen film keeps its theater when the app knows it (a Yes to
//             "Did you see it?", Mark seen on the day of a planned showing
//             that has started) and never otherwise; films seen before stay
//             empty; the card counts them with past plans; each person's
//             theaters show only in their own recap
//   privacy   the guest gets 403 and no window; each recap holds only its
//             own person's films, name and numbers; the poster route serves
//             only the caller's own recap posters; no invite link, place or
//             other person in any recap
//   readonly  opening, previewing and fetching posters for every recap
//             changes no row in any table, no score, no pick, not the four
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, GUEST, REPO } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';
import { seedYear, DEC1, NOV30, JAN15, JAN16 } from '../lib/year-seed.mjs';

const S = suite('year');

// ------------------------------------------------------------------ the world
// The year's data (test/lib/year-seed.mjs).
const R = C.RATED;
const seeds = {};
const w = S.world(await openWorld('year', {
  prepare(d) { Object.assign(seeds, seedYear(d)); },
}));
const F = w.friends;
const ROBIN = F.robin; const CASEY = F.casey; const JORDAN = F.jordan;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const get = async (as, p) => (await api(as, 'GET', p));
// Ratings made on Nov 2, so no later clock jump lands before them (a rating
// in the future would move a recency-weighted score by itself).
await w.jump('2026-11-02T12:00:00-05:00');
// A friend whose whole history is this year, for the Stats cross-check.
const avery = await makeFriend(w.base, 'Avery');
for (const f of R.slice(0, 9)) await api(avery, 'POST', '/api/ratings', { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year });
// Casey: three ratings.
for (const f of R.slice(10, 13)) await api(CASEY, 'POST', '/api/ratings', { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year });
await w.jump(DEC1);
const USERS = { owner: { as: null, id: 1 }, robin: { as: ROBIN, id: ROBIN.id }, casey: { as: CASEY, id: CASEY.id }, jordan: { as: JORDAN, id: JORDAN.id }, avery: { as: avery, id: avery.id } };

// ------------------------------------------------------------------ an independent count
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: C.TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (s) => (s == null ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : Number.isFinite(Date.parse(s)) ? dayFmt.format(new Date(s)) : null);
const list = (v) => { try { return JSON.parse(v) || []; } catch { return []; } };
async function expected(key, year, nowIso) {
  const { as, id } = USERS[key];
  const Y = String(year);
  const seenRows = w.q("SELECT tmdb_id, watched_date, in_weekly4, ticket_price, source FROM watched WHERE user_id = ? AND watched_date LIKE ? || '-%'", id, Y);
  const ratings = w.q('SELECT tmdb_id, rating, rated_at FROM ratings WHERE user_id = ?', id);
  const rating = new Map(ratings.map((r) => [r.tmdb_id, r.rating]));
  const ratedIn = ratings.filter((r) => (localDay(r.rated_at) || '').startsWith(`${Y}-`));
  const films = new Map();
  const add = (fid, day) => { const f = films.get(fid) || { id: fid, days: [] }; f.days.push(day); films.set(fid, f); };
  for (const s of seenRows) add(s.tmdb_id, s.watched_date);
  for (const r of ratedIn) add(r.tmdb_id, localDay(r.rated_at));
  const meta = new Map(w.q('SELECT tmdb_id, title, genres, director, "cast", poster FROM movies').map((m) => [m.tmdb_id, m]));
  for (const f of films.values()) { f.days.sort(); f.first = f.days[0]; f.last = f.days.at(-1); f.title = meta.get(f.id)?.title || `Movie ${f.id}`; f.rating = rating.get(f.id) ?? null; f.seen = seenRows.some((s) => s.tmdb_id === f.id); }
  const top = (kind) => {
    const m = new Map();
    for (const f of films.values()) {
      const mm = meta.get(f.id); if (!mm) continue;
      const keys = kind === 'genre' ? list(mm.genres) : kind === 'director' ? [mm.director] : list(mm.cast);
      for (const k of new Set(keys.filter(Boolean))) { const e = m.get(k) || { n: 0, s: 0, r: 0 }; e.n++; if (f.rating != null) { e.s += f.rating; e.r++; } m.set(k, e); }
    }
    const l = [...m].map(([name, e]) => ({ name, n: e.n, avg: e.r ? Math.round((e.s / e.r) * 100) / 100 : -1 })).sort((a, b) => b.n - a.n || b.avg - a.avg || a.name.localeCompare(b.name));
    return l[0] && l[0].n >= 2 ? { name: l[0].name, n: l[0].n } : null;
  };
  const all = [...films.values()];
  const settings = (await get(as, '/api/settings')).json;
  const sub = (settings.moviePlan || 'amc-alist') !== 'none';
  const fee = sub ? Number(settings.alistMonthlyFee) || 0 : 0;
  const tickets = seenRows.filter((s) => s.source == null);
  const now = new Date(nowIso);
  const nowParts = dayFmt.format(now).split('-').map(Number);
  const lastMonth = year < nowParts[0] ? 12 : nowParts[1];
  let plan = null;
  if (tickets.length) {
    const firstMonth = Math.min(...tickets.map((t) => Number(t.watched_date.slice(5, 7))));
    const months = [];
    for (let m = firstMonth; m <= lastMonth; m++) {
      const ym = `${Y}-${String(m).padStart(2, '0')}`;
      const rows = tickets.filter((t) => t.watched_date.startsWith(ym));
      const value = Math.round(rows.reduce((s, r) => s + (Number(r.ticket_price) || Number(settings.avgTicketPrice) || 0), 0) * 100) / 100;
      months.push({ month: ym, tickets: rows.length, value, saved: Math.round((value - fee) * 100) / 100 });
    }
    const value = Math.round(months.reduce((s, m) => s + m.value, 0) * 100) / 100;
    plan = { tickets: tickets.length, value, subscription: sub, saved: sub ? Math.round(months.reduce((s, m) => s + m.saved, 0) * 100) / 100 : null, months };
  }
  const nowMs = now.getTime();
  const visits = new Map();
  for (const p of w.q("SELECT theatre_name, start_epoch FROM plans WHERE user_id = ? AND date LIKE ? || '-%'", id, Y)) if (p.start_epoch <= nowMs && p.theatre_name) visits.set(p.theatre_name, (visits.get(p.theatre_name) || 0) + 1);
  for (const r of w.q("SELECT theatre FROM watched WHERE user_id = ? AND watched_date LIKE ? || '-%' AND theatre IS NOT NULL", id, Y)) visits.set(r.theatre, (visits.get(r.theatre) || 0) + 1);
  const theater = visits.size ? [...visits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] : null;
  const pickIds = new Set(seenRows.filter((s) => s.in_weekly4).map((s) => s.tmdb_id));
  const pickFilms = all.filter((f) => pickIds.has(f.id));
  const bestPick = pickFilms.filter((f) => f.rating != null).sort((a, b) => b.rating - a.rating || b.last.localeCompare(a.last) || a.title.localeCompare(b.title))[0] || null;
  const byRating = all.filter((f) => f.rating != null).sort((a, b) => b.rating - a.rating || Number(b.seen) - Number(a.seen) || b.last.localeCompare(a.last) || a.title.localeCompare(b.title));
  const byMonth = new Map(); for (const f of all) byMonth.set(f.first.slice(0, 7), (byMonth.get(f.first.slice(0, 7)) || 0) + 1);
  const busiest = [...byMonth].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
  const first = all.slice().sort((a, b) => a.first.localeCompare(b.first) || a.title.localeCompare(b.title))[0] || null;
  const last = all.slice().sort((a, b) => b.last.localeCompare(a.last) || a.title.localeCompare(b.title))[0] || null;
  const note = byRating[0] ? w.q1('SELECT note FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', id, byRating[0].id)?.note ?? null : null;
  return {
    films: all.length, seen: new Set(seenRows.map((s) => s.tmdb_id)).size, rated: ratedIn.length,
    director: top('director'), actor: top('actor'), genre: top('genre'), plan, theater, picks: pickIds.size, bestPick, best: byRating[0] || null, note,
    busiest, first, last, posters: byRating.filter((f) => meta.get(f.id)?.poster).slice(0, 4).map((f) => f.id), ids: new Set(all.map((f) => f.id)),
  };
}
const cardOf = (r, kind) => r?.cards?.find((c) => c.kind === kind) || null;
const kinds = (r) => (r?.cards || []).map((c) => c.kind).join(',');

// Every table but the shared TMDB response cache, which the background jobs
// fill on their own schedule (the weekly people warm-up runs when the clock
// jumps a week); the recap code has no write in it at all (checked below).
const TABLES = w.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'cache' ORDER BY name").map((r) => r.name);
const dump = () => {
  const h = crypto.createHash('sha256');
  const out = {};
  for (const t of TABLES) {
    // Signing a friend in stamps users.last_seen_at (at most every few
    // minutes, lib/accounts.js) on any request at all; that one column is
    // the sign-in's, not the recap's.
    const rows = w.q(`SELECT * FROM "${t}"`).map((r) => (t === 'users' ? { ...r, last_seen_at: null } : r));
    out[t] = rows.length; h.update(t); h.update(JSON.stringify(rows));
  }
  return { counts: out, hash: h.digest('hex') };
};
const changes = (a, b) => TABLES.filter((t) => a.counts[t] !== b.counts[t]).join(', ') || 'same counts, different rows';
// ------------------------------------------------------------------ window
await S.step('window: closed Nov 30 and Jan 16, open Dec 1 and Jan 15', async () => {
  const d0 = dump();
  for (const [label, at, open, year] of [['Nov 30', NOV30, false, 2026], ['Dec 1', DEC1, true, 2026], ['Jan 15', JAN15, true, 2026], ['Jan 16', JAN16, false, 2027]]) {
    await w.jump(at);
    for (const key of ['owner', 'robin', 'casey']) {
      const st = (await get(USERS[key].as, '/api/status')).json;
      S.check(`window: ${label} ${key}: /api/status says ${open ? 'open' : 'closed'}, ${year}`, st.year?.open === open && st.year?.year === year, JSON.stringify(st.year));
      const r = await get(USERS[key].as, '/api/year');
      S.check(`window: ${label} ${key}: /api/year ${open ? 'answers the recap for 2026' : 'is closed (404)'}`, open ? r.status === 200 && r.json.year === 2026 && r.json.preview === false : r.status === 404, `${r.status} ${r.text.slice(0, 120)}`);
    }
    const pv = await get(null, '/api/year?preview=1');
    S.check(`window: ${label} owner: the preview answers (${open ? 'the open year' : `this year, ${year}`})`, pv.status === 200 && pv.json.year === (open ? 2026 : year), `${pv.status} ${pv.json?.year}`);
    const fp = await get(ROBIN, '/api/year?preview=1');
    S.check(`window: ${label} friend: a preview request is refused (403)`, fp.status === 403, fp.status);
  }
  S.check('readonly: every open, closed and preview request across the four dates leaves every table\'s rows unchanged', (() => { const d = dump(); return [d.hash === d0.hash, changes(d0, d)]; })()[0], changes(d0, dump()));
  await w.jump(DEC1);
});

// ------------------------------------------------------------------ numbers
const NOW = DEC1;
const recaps = {};
const exp = {};
await S.step('numbers: each figure against an independent count and against Stats', async () => {
  for (const key of Object.keys(USERS)) {
    recaps[key] = (await get(USERS[key].as, '/api/year')).json;
    exp[key] = await expected(key, 2026, NOW);
  }
  for (const key of ['owner', 'robin', 'casey', 'avery']) {
    const r = recaps[key]; const e = exp[key];
    const n = cardOf(r, 'numbers');
    S.check(`numbers: ${key}: films seen in theaters ${e.seen}`, n?.seen === e.seen, `${n?.seen} vs ${e.seen}`);
    S.check(`numbers: ${key}: films rated this year ${e.rated}`, n?.rated === e.rated, `${n?.rated} vs ${e.rated}`);
    S.check(`numbers: ${key}: films seen or rated ${e.films}`, cardOf(r, 'intro')?.films === e.films && n?.films === e.films, `${n?.films} vs ${e.films}`);
    const st = (await get(USERS[key].as, '/api/stats')).json;
    S.check(`numbers: ${key}: seen equals Stats' seen this year`, n?.seen === st.seenThisYear, `${n?.seen} vs ${st.seenThisYear}`);
    const t = cardOf(r, 'tops');
    if (r.short) S.check(`numbers: ${key}: the short version leaves the rankings out`, !t);
    else if (t || e.director || e.actor || e.genre) {
      S.check(`numbers: ${key}: top director, actor and genre`, JSON.stringify([t?.director, t?.actor, t?.genre]) === JSON.stringify([e.director, e.actor, e.genre]), `${JSON.stringify([t?.director, t?.actor, t?.genre])} vs ${JSON.stringify([e.director, e.actor, e.genre])}`);
    }
    const b = cardOf(r, 'best');
    if (e.best) {
      S.check(`numbers: ${key}: highest rated film and its note`, b?.film.tmdb_id === e.best.id && b.film.rating === e.best.rating && b.film.note === e.note, `${b?.film.tmdb_id}/${b?.film.rating}/${b?.film.note} vs ${e.best.id}/${e.best.rating}/${e.note}`);
    }
    const s = cardOf(r, 'summary');
    if (s) S.check(`numbers: ${key}: summary numbers and posters`, s.seen === e.seen && s.rated === e.rated && JSON.stringify(s.posters.map((p) => p.tmdb_id)) === JSON.stringify(e.posters), `${s.seen}/${s.rated}/${s.posters.map((p) => p.tmdb_id)} vs ${e.seen}/${e.rated}/${e.posters}`);
    const m = cardOf(r, 'months');
    if (m) {
      S.check(`numbers: ${key}: busiest month`, m.busiest.month === e.busiest[0] && m.busiest.films === e.busiest[1], `${JSON.stringify(m.busiest)} vs ${e.busiest}`);
      S.check(`numbers: ${key}: first and last film`, m.first.tmdb_id === e.first.id && m.first.date === e.first.first && m.last.tmdb_id === e.last.id && m.last.date === e.last.last, `${m.first.tmdb_id}@${m.first.date} ${m.last.tmdb_id}@${m.last.date} vs ${e.first.id}@${e.first.first} ${e.last.id}@${e.last.last}`);
    }
    const p = cardOf(r, 'plan');
    if (e.plan) {
      S.check(`numbers: ${key}: tickets used ${e.plan.tickets}, value ${e.plan.value}, ${e.plan.subscription ? `saved ${e.plan.saved}` : 'spent'}`, p && p.tickets === e.plan.tickets && p.value === e.plan.value && p.saved === e.plan.saved && p.subscription === e.plan.subscription, JSON.stringify(p) + ' vs ' + JSON.stringify(e.plan));
      S.check(`numbers: ${key}: month by month as expected`, JSON.stringify(p?.months.map((x) => [x.month, x.tickets, x.value, x.saved])) === JSON.stringify(e.plan.months.map((x) => [x.month, x.tickets, x.value, x.saved])), JSON.stringify(p?.months));
      const wk = (await get(USERS[key].as, '/api/alist')).json;
      const cur = p?.months.at(-1);
      S.check(`numbers: ${key}: this month equals Stats (tickets, ticket value, saved)`, cur && cur.month === '2026-12' && cur.tickets === wk.savings.monthTickets && cur.value === wk.savings.ticketValue && (e.plan.subscription ? cur.saved === wk.savings.saved : true), `${JSON.stringify(cur)} vs ${JSON.stringify(wk.savings)}`);
    }
    if (e.picks) {
      const k = cardOf(r, 'picks');
      S.check(`numbers: ${key}: weekly picks seen ${e.picks} and the best one`, k?.seen === e.picks && (k.best?.tmdb_id ?? null) === (e.bestPick?.id ?? null), `${JSON.stringify(k)} vs ${e.picks} ${e.bestPick?.id}`);
    }
  }
  // Theater: the owner's past plans only.
  const th = cardOf(recaps.owner, 'theater');
  S.check('numbers: owner: most-visited theater from past plans this year', th?.name === exp.owner.theater?.[0] && th.showings === exp.owner.theater[1] && th.name === 'AMC Maple Grove 12' && th.showings === 2, JSON.stringify(th));
  // The seeded edges: a late Dec 31 rating counts, a 2025 one doesn't.
  S.check('numbers: owner: a rating at 11:30 pm Dec 31 local (Jan 1 in UTC) counts in 2026', exp.owner.ids.has(seeds.unrated[3]) && cardOf(recaps.owner, 'best')?.film && recaps.owner.cards.length > 0);
  S.check('numbers: owner: a 2025 rating and a 2025 ticket stay out', !exp.owner.ids.has(seeds.unrated[2]) && cardOf(recaps.owner, 'plan')?.months[0].month === '2026-01');
  // Stats covers everything when the whole history is in the year.
  const st = (await get(avery, '/api/stats')).json;
  const at = cardOf(recaps.avery, 'tops');
  S.check('numbers: avery (all history this year): films rated equals Stats\' ratings', cardOf(recaps.avery, 'numbers')?.rated === st.totalRatings, `${cardOf(recaps.avery, 'numbers')?.rated} vs ${st.totalRatings}`);
  S.check('numbers: avery: top director, actor and genre equal Stats\' first rows', at && at.director?.name === st.topDirectors[0].name && at.director.n === st.topDirectors[0].n
    && at.actor?.name === st.topActors[0].name && at.actor.n === st.topActors[0].n && at.genre?.name === st.topGenres[0].name && at.genre.n === st.topGenres[0].n,
  `${JSON.stringify(at)} vs ${st.topDirectors[0]?.name}/${st.topActors[0]?.name}/${st.topGenres[0]?.name}`);
  const ownerStats = (await get(null, '/api/stats')).json;
  S.check('numbers: owner: weekly picks seen equals Stats\' picks watched (all this year, no rewatch of a pick)', cardOf(recaps.owner, 'picks')?.seen === ownerStats.totalPicksWatched - 1, `${cardOf(recaps.owner, 'picks')?.seen} vs ${ownerStats.totalPicksWatched} less the 2025 one`);
  // Jan 15: the whole of 2026, December included, as of then.
  await w.jump(JAN15);
  const jan = (await get(null, '/api/year')).json;
  const ej = await expected('owner', 2026, JAN15);
  const pj = cardOf(jan, 'plan');
  S.check('numbers: owner on Jan 15: the plan runs January to December 2026', pj?.months.length === 12 && pj.months.at(-1).month === '2026-12' && pj.saved === ej.plan.saved, `${pj?.months.length} ${pj?.saved} vs ${ej.plan.saved}`);
  S.check('numbers: owner on Jan 15: the rating on the evening of Dec 31 is in, 2027\'s aren\'t', cardOf(jan, 'numbers')?.rated === ej.rated && ej.ids.has(seeds.unrated[3]) && !ej.ids.has(seeds.unrated[4]), `${cardOf(jan, 'numbers')?.rated} vs ${ej.rated}`);
  await w.jump(DEC1);
});

// ------------------------------------------------------------------ cards
await S.step('cards: which cards each person gets', async () => {
  const want = {
    owner: 'intro,numbers,tops,theater,months,plan,picks,best,summary',
    robin: 'intro,numbers,tops,months,plan,picks,best,summary',
    avery: 'intro,numbers,tops,months,best,summary',
    casey: 'intro,numbers,best,summary',
    jordan: 'intro,start',
  };
  for (const [key, list] of Object.entries(want)) S.check(`cards: ${key} gets ${list}`, kinds(recaps[key]) === list, kinds(recaps[key]));
  S.check('cards: the 3-rating friend gets the short version', recaps.casey.short === true && recaps.robin.short === false && recaps.owner.short === false);
  S.check('cards: the brand-new friend gets a friendly start, no numbers, nothing to share', recaps.jordan.short === true && recaps.jordan.share === null && !cardOf(recaps.jordan, 'numbers'));
  S.check('cards: no theater card when no theater is known (Robin, Casey, Avery)', ['robin', 'casey', 'avery'].every((k) => !cardOf(recaps[k], 'theater')));
  S.check('cards: Robin (no plan) gets ticket spend, not savings', cardOf(recaps.robin, 'plan')?.subscription === false && cardOf(recaps.robin, 'plan').saved === null);
  const empty = Object.entries(recaps).flatMap(([k, r]) => r.cards.filter((c) => (c.kind === 'numbers' && !c.seen && !c.rated) || (c.kind === 'tops' && !c.director && !c.actor && !c.genre) || (c.kind === 'summary' && !c.films)).map((c) => `${k} ${c.kind}`));
  S.check('cards: no card is empty', !empty.length, empty.join(', '));
});

// ------------------------------------------------------------------ privacy
await S.step('privacy: nobody else\'s recap, the guest gets nothing', async () => {
  const g = await get(GUEST, '/api/year');
  S.check('privacy: the guest gets 403 from /api/year', g.status === 403, g.status);
  const gp = await get(GUEST, '/api/year?preview=1');
  S.check('privacy: the guest gets 403 from the preview', gp.status === 403, gp.status);
  const gi = await get(GUEST, `/api/year/poster/${exp.owner.posters[0]}`);
  S.check('privacy: the guest gets 403 from the poster route', gi.status === 403, gi.status);
  const gs = (await get(GUEST, '/api/status')).json;
  S.check('privacy: the guest\'s status has no year', !('year' in gs), JSON.stringify(gs.year));
  const names = { owner: C.OWNER_NAME, robin: 'Robin', casey: 'Casey', jordan: 'Jordan', avery: 'Avery' };
  for (const [key, r] of Object.entries(recaps)) {
    const ids = [...JSON.stringify(r).matchAll(/"tmdb_id":(\d+)/g)].map((m) => Number(m[1]));
    const stray = ids.filter((i) => !exp[key].ids.has(i));
    S.check(`privacy: ${key}: every film in the recap is one they saw or rated this year`, !stray.length, stray.join(', '));
    S.check(`privacy: ${key}: the recap carries their own name only`, r.name === names[key] && Object.entries(names).every(([k, n]) => k === key || !JSON.stringify(r).includes(`"${n}`)), r.name);
    const text = JSON.stringify(r);
    S.check(`privacy: ${key}: no invite link, place or other address in the recap`, !/invite|token|lat"|lng"|lon"|"home"|address|distance|drive/i.test(text) && ![...text.matchAll(/https?:\/\/[^"]+/g)].some((m) => !m[0].startsWith('https://image.tmdb.org/')), text.slice(0, 200));
  }
  // Posters: only the caller's own.
  const mine = exp.owner.posters[0];
  const ok = await w.api('GET', `/api/year/poster/${mine}`, { raw: true });
  S.check('privacy: the owner gets their own recap poster, an image from this server', ok.status === 200 && /^image\//.test(ok.headers?.get?.('content-type') || ok.type || ''), `${ok.status} ${ok.headers?.get?.('content-type')}`);
  const notMine = [...exp.robin.posters].find((i) => !exp.owner.posters.includes(i));
  const other = await get(null, `/api/year/poster/${notMine}`);
  S.check('privacy: the owner can\'t fetch a poster from Robin\'s recap', other.status === 404, other.status);
  const robinTries = await get(ROBIN, `/api/year/poster/${exp.owner.posters.find((i) => !exp.robin.posters.includes(i))}`);
  S.check('privacy: Robin can\'t fetch a poster from the owner\'s recap', robinTries.status === 404, robinTries.status);
  const jt = await get(JORDAN, `/api/year/poster/${mine}`);
  S.check('privacy: the brand-new friend has no posters to fetch', jt.status === 404, jt.status);
  const bad = await get(null, '/api/year/poster/abc');
  S.check('privacy: a malformed poster id is a 404', bad.status === 404, bad.status);
});

// ------------------------------------------------------------------ readonly
const recsOf = async (as) => {
  const r = (await get(as, '/api/recommendations')).json;
  return JSON.stringify({ four: r.weekly4.map((e) => e.tmdb_id), list: r.list.map((e) => [e.tmdb_id, e.final]) });
};
await S.step('readonly: nothing moves', async () => {
  // The code: no write statement in lib/year.js or the /year routes.
  const src = fs.readFileSync(path.join(REPO, 'server/lib/year.js'), 'utf8');
  const routes = fs.readFileSync(path.join(REPO, 'server/routes.js'), 'utf8');
  const yearRoutes = routes.slice(routes.indexOf('// ---- your year in movies'), routes.indexOf('// ---- people'));
  const writes = /\brun\(|\bexec\(|INSERT|UPDATE |DELETE|REPLACE INTO|setSetting|updateSettings/;
  S.check('readonly: lib/year.js and the /year routes hold no database write', yearRoutes.length > 500 && !writes.test(src) && !writes.test(yearRoutes) && !/from '\.\.\/db\.js'.*\brun\b/.test(src), (src.match(writes) || yearRoutes.match(writes) || ['routes section missing'])[0]);
  const before = {};
  for (const key of Object.keys(USERS)) before[key] = await recsOf(USERS[key].as);
  const guestBefore = await recsOf(GUEST);
  const d0 = dump();
  for (const key of Object.keys(USERS)) {
    await get(USERS[key].as, '/api/year');
    await get(USERS[key].as, '/api/status');
    for (const id of exp[key].posters) await w.api('GET', `/api/year/poster/${id}`, { as: USERS[key].as, raw: true });
  }
  // The clock stays put here: rewinding it would put Avery's ratings (made at
  // 00:01) in the future and move a recency-weighted score on its own.
  await get(null, '/api/year?preview=1');
  const d1 = dump();

  S.check('readonly: every recap, preview and poster fetch leaves every table\'s rows unchanged', d0.hash === d1.hash, changes(d0, d1));
  const after = {};
  for (const key of Object.keys(USERS)) after[key] = await recsOf(USERS[key].as);
  const diff = Object.keys(USERS).filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k].slice(0, 300)} => ${after[k].slice(0, 300)}`);
  S.check('readonly: every person\'s scores and weekly four are unchanged', !diff.length, diff.join(' || '));
  S.check('readonly: the guest\'s picks are unchanged', guestBefore === await recsOf(GUEST));
});

// ------------------------------------------------------------------ theater
await S.step('theater: saved with a seen film when the app knows it, and counted', async () => {
  const P = (k) => C.PLAYING.find((f) => f.k === k);
  const MG = 'AMC Maple Grove 12'; const RS = 'AMC Riverside 8';
  await w.jump('2026-12-02T09:00:00-05:00');
  // Showings on Dec 2 (and one on Dec 5) at each person's theaters.
  const shows = {
    yes: { film: P(7), tid: '9102', date: '2026-12-02', time: '19:00' },
    mark: { film: P(8), tid: '9102', date: '2026-12-02', time: '20:00' },
    later: { film: P(9), tid: '9102', date: '2026-12-05', time: '19:00' },
    robin: { film: P(10), tid: '9101', date: '2026-12-02', time: '19:30' },
  };
  for (const [k, x] of Object.entries(shows)) {
    w.q('INSERT OR REPLACE INTO showtimes(id, amc_movie_id, tmdb_id, theatre_id, date, start_local, start_epoch, format, attributes, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      `yr-${k}`, String(x.film.amcId), x.film.id, x.tid, x.date, `${x.date}T${x.time}:00`, Date.parse(`${x.date}T${x.time}:00-05:00`), 'Standard', '[]', '2026-12-02T14:00:00.000Z');
  }
  const noted = new Set(w.q('SELECT id FROM watched WHERE theatre IS NOT NULL').map((r) => r.id));
  S.check('theater: films seen before this change have no theater', noted.size === 0, String(noted.size));
  const plan = async (as, k) => (await api(as, 'PUT', '/api/plans', { showtime_id: `yr-${k}` })).status;
  const planned = [await plan(null, 'yes'), await plan(null, 'mark'), await plan(null, 'later'), await plan(ROBIN, 'robin')];
  S.check('theater: the plans are made', planned.every((x) => x === 200), planned.join(','));
  await w.jump('2026-12-02T22:00:00-05:00');
  const row = (uid, film) => w.q1('SELECT theatre, watched_date FROM watched WHERE user_id = ? AND tmdb_id = ? ORDER BY id DESC', uid, film.id);

  const yes = await api(null, 'POST', `/api/plans/${shows.yes.film.id}/answer`, { seen: true });
  S.check('theater: a Yes to "Did you see it?" saves the plan\'s theater', yes.status === 200 && row(1, shows.yes.film)?.theatre === RS, `${yes.status} ${JSON.stringify(row(1, shows.yes.film))}`);
  await api(null, 'POST', '/api/watched', { tmdb_id: shows.mark.film.id, title: shows.mark.film.title });
  S.check('theater: Mark seen on the day of a planned showing that has started saves its theater', row(1, shows.mark.film)?.theatre === RS, JSON.stringify(row(1, shows.mark.film)));
  await api(null, 'POST', '/api/watched', { tmdb_id: shows.later.film.id, title: shows.later.film.title });
  S.check('theater: Mark seen with a plan for another day saves no theater', row(1, shows.later.film) && row(1, shows.later.film).theatre === null, JSON.stringify(row(1, shows.later.film)));
  await api(null, 'POST', '/api/watched', { tmdb_id: P(11).id, title: P(11).title });
  S.check('theater: Mark seen with no plan saves no theater', row(1, P(11)) && row(1, P(11)).theatre === null, JSON.stringify(row(1, P(11))));
  const ry = await api(ROBIN, 'POST', `/api/plans/${shows.robin.film.id}/answer`, { seen: true });
  S.check('theater: a friend\'s Yes saves their own theater on their own row', ry.status === 200 && row(ROBIN.id, shows.robin.film)?.theatre === MG, JSON.stringify(row(ROBIN.id, shows.robin.film)));
  const all = w.q('SELECT id, user_id, tmdb_id FROM watched WHERE theatre IS NOT NULL');
  S.check('theater: no other watch-log row gained a theater', all.length === 3, JSON.stringify(all));

  const mine = (await get(null, '/api/year')).json;
  const e = await expected('owner', 2026, '2026-12-02T22:00:00-05:00');
  const th = cardOf(mine, 'theater');
  S.check('theater: the owner\'s card counts seen films with their theater and past plans', th?.name === e.theater?.[0] && th.showings === e.theater[1] && th.name === RS && th.showings === 3, JSON.stringify(th));
  const rr = (await get(ROBIN, '/api/year')).json;
  const rth = cardOf(rr, 'theater');
  S.check('theater: a friend with a seen film at a known theater now gets the card', rth?.name === MG && rth.showings === 1, JSON.stringify(rth));
  S.check('theater: the friend\'s recap has none of the owner\'s theaters', !JSON.stringify(rr).includes('Riverside'));
  const cr = (await get(CASEY, '/api/year')).json;
  S.check('theater: another friend (at Riverside) sees no theater from anyone', !cardOf(cr, 'theater') && !/Riverside|Maple Grove/.test(JSON.stringify(cr)));
  const exp = (await get(ROBIN, '/api/state')).json;
  const theaters = (exp?.profile?.watched || []).map((x) => x.theatre).filter(Boolean);
  S.check('theater: a friend\'s own export carries only their own theater', JSON.stringify(theaters) === JSON.stringify([MG]), JSON.stringify(theaters));
});

await w.close();
S.finish();
