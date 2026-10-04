// The guest link carries nothing of the owner's. The owner plants a rating, a
// watchlist entry, a hidden film and a watched film in every list a guest can
// reach (the four, Also worth seeing, the full list, Also nearby, Last chance,
// leavingSoon and Coming Soon) and changes the settings a guest must not see.
// Then, as the guest, every route on the allowlist (read from
// server/lib/guest.js as text) must answer exactly as it did before, with no
// owner-only key name anywhere, no reason line about the owner, nothing
// ordered by the owner's watchlist, no real theater id, and a movie page that
// asks the outside for nothing and writes nothing.
//
// The guest's lists are public: films ranked by their public score, the four
// is the top four, Worth seeing and Last chance need 75, and Coming Soon puts
// advance screenings first, then the soonest release.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, GUEST, REPO, sleep } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('guest');
const PALE = 990003; // a film whose poster colour the test forgets
const w = S.world(await openWorld('guest'));

// Key names that would say something about the owner, whatever their value.
const BANNED = ['myRating', 'watchlisted', 'seen', 'hidden', 'taste', 'predicted', 'weights', 'hiddenCount',
  // and the owner's settings, activity and name (answer 2)
  'windowFit', 'fits_window', 'excluded', 'lastChanceDiagnostics', 'urgencyBoost', 'finalBeforeUrgency', 'lock', 'pick', 'match', 'profile', 'ownerName'];
// Reason words that only ever describe the owner.
const OWNER_WORDS = new RegExp(`watchlist|\\brates\\b|taste profile|★|\\b${C.OWNER_NAME}\\b`, 'i');

function keysIn(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
  return out;
}
const bannedIn = (v) => [...keysIn(v)].filter((k) => BANNED.includes(k));
// Every reason line in an answer: `reason` strings and the facts behind them.
function reasonsIn(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => reasonsIn(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'reason' && typeof x === 'string') out.push(x);
      else if (k === 'why' && x && typeof x === 'object') out.push(JSON.stringify(x));
      else reasonsIn(x, out);
    }
  }
  return out;
}

// The allowlist, read as text so a route added there must be read here too.
const guestSrc = fs.readFileSync(path.join(REPO, 'server', 'lib', 'guest.js'), 'utf8');
const ALLOW = [...guestSrc.slice(guestSrc.indexOf('const ALLOW = ['), guestSrc.indexOf('];', guestSrc.indexOf('const ALLOW = ['))).matchAll(/^\s*\/(\^.*\$)\/,\s*$/gm)].map((m) => new RegExp(m[1]));

const PLANT = {
  rated: [990007, 970003], // Hollow Summer leaves first; Night Ferry is coming soon
  watchlist: [990010, 990005], // Distant Tide leaves after Hollow Summer; Iron Chorus is only nearby
  hidden: [990004, 990011, 970002],
  watched: [990001],
};
const MARKED = new Set(Object.values(PLANT).flat().concat([990002, 970001])); // the world's own watchlist too
const LISTS = ['weekly4', 'worthSeeing', 'list', 'alsoNearby', 'lastChance', 'leavingSoon'];

// A calendar file is stamped with the time it was made.
const stamped = (text) => text.replace(/^DTSTAMP:.*$/m, 'DTSTAMP:-');
let paths = [];
const before = {};
await S.step('every route on the guest allowlist has a sample path', async () => {
  S.check('the allowlist in guest.js reads as eight routes', ALLOW.length === 8, ALLOW.map(String).join(' '));
  const recs = (await w.api('GET', '/api/recommendations', { as: GUEST })).json;
  const st = [...(recs.list || []), ...(recs.alsoNearby || [])].find((e) => e.tmdb_id === 990010)?.bestShowtime;
  const ids = [...C.PLAYING.map((f) => f.id), ...C.UPCOMING.map((f) => f.id)];
  paths = [
    '/api/status', '/api/version', '/api/recommendations', '/api/coming-soon', '/api/social',
    ...ids.map((id) => `/api/movies/${id}`),
    `/api/person/${C.PEOPLE.ada.id}`, `/api/person/${C.PEOPLE.june.id}`,
    `/api/showtimes/${st?.id}/calendar.ics`,
  ];
  for (const re of ALLOW) S.check(`the test reads ${re}`, paths.some((p) => re.test(p)), paths.join(' '));
  // A Coming Soon film is a light record until someone with an account opens
  // or rates it, which fetches its details for everyone. The owner opens each
  // first, so what follows tells the marks apart from that.
  for (const f of C.UPCOMING) S.check(`owner opens upcoming ${f.id}`, (await w.api('GET', `/api/movies/${f.id}`)).status === 200);
  for (const p of paths) {
    const r = await w.api('GET', p, { as: GUEST });
    S.check(`guest GET ${p.replace(/\d{6,}/g, (d) => (p.includes('calendar') ? '<showtime>' : d))} answers 200`, r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    before[p] = r.json ?? stamped(r.text);
  }
});

await S.step('the owner plants marks in every list and changes the settings a guest must not see', async () => {
  const must = async (r, what) => S.check(`owner: ${what}`, r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  for (const id of PLANT.rated) await must(await w.api('POST', '/api/ratings', { body: { tmdb_id: id, rating: 4.5, title: C.film(id)?.title, year: C.film(id)?.year, source: 'manual' } }), `rate ${id}`);
  for (const id of PLANT.watchlist) await must(await w.api('POST', '/api/watchlist/toggle', { body: { tmdb_id: id } }), `watchlist ${id}`);
  for (const id of PLANT.hidden) await must(await w.api('POST', '/api/hidden', { body: { tmdb_id: id } }), `hide ${id}`);
  for (const id of PLANT.watched) await must(await w.api('POST', '/api/watched', { body: { tmdb_id: id, title: C.film(id)?.title } }), `mark ${id} seen`);
  await must(await w.api('PUT', '/api/settings', {
    body: {
      excludedGenres: ['Comedy'], previewsMinutes: 35, weightPublic: 0.2, weightTaste: 0.8, goodMatchMinScore: 60, lastChanceMinScore: 60,
      watchlistBoost: 15, urgencyBoost: 12, preferImax: false,
      showtimeWindows: { weekday: { enabled: true, after: '18:00', before: '21:00' }, weekend: { enabled: true, after: '12:00', before: '22:00' } },
    },
  }), 'change settings');
  // The marks reach the owner's own answer (the control the guest checks lean on).
  const own = (await w.api('GET', '/api/recommendations')).json;
  const e = (id) => [...own.list, ...own.alsoNearby].find((x) => x.tmdb_id === id);
  S.check('control: the owner\'s answer carries the planted marks', e(990007)?.myRating === 4.5 && e(990010)?.flags?.watchlisted === true && e(990004)?.flags?.hidden === true,
    JSON.stringify([e(990007)?.myRating, e(990010)?.flags?.watchlisted, e(990004)?.flags?.hidden]));
  S.check('control: the key check finds myRating in the owner\'s answer', bannedIn(own).includes('myRating'), bannedIn(own).join(','));
  S.check('control: the reason check finds the owner\'s watchlist in the owner\'s answer', reasonsIn(own).some((r) => /watchlist/i.test(r)));
});

const after = {};
await S.step('as the guest, nothing the owner did shows', async () => {
  for (const p of paths) {
    const r = await w.api('GET', p, { as: GUEST });
    after[p] = r.json ?? stamped(r.text);
    const name = p.replace(/\d{6,}/g, (d) => (p.includes('calendar') ? '<showtime>' : d));
    const same = JSON.stringify(after[p]) === JSON.stringify(before[p]);
    S.check(`guest GET ${name}: the same answer as before the owner's marks and settings`, same,
      same ? '' : diffAt(before[p], after[p]).slice(0, 4).join(' | '));
    const bad = bannedIn(after[p]);
    S.check(`guest GET ${name}: no owner-only key name`, !bad.length, bad.join(','));
    const lines = reasonsIn(after[p]).filter((t) => OWNER_WORDS.test(t));
    S.check(`guest GET ${name}: no reason line about the owner`, !lines.length, lines.slice(0, 2).join(' | '));
    S.check(`guest GET ${name}: the owner's name is nowhere`, !new RegExp(`\\b${C.OWNER_NAME}\\b`).test(typeof after[p] === 'string' ? after[p] : JSON.stringify(after[p])));
  }
});

function diffAt(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffAt(a[k], b[k], `${at}.${k}`));
  }
  return [`${at}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`];
}

await S.step('the planted films sit in every list the guest sees', async () => {
  const recs = after['/api/recommendations'];
  for (const k of LISTS) {
    const hit = (recs[k] || []).filter((e) => MARKED.has(e.tmdb_id)).map((e) => e.tmdb_id);
    S.check(`guest ${k}: holds a film the owner marked`, hit.length > 0, JSON.stringify((recs[k] || []).map((e) => e.tmdb_id)));
  }
  const cs = after['/api/coming-soon'];
  S.check('guest Coming Soon: holds the films the owner rated, watchlisted and hid', [970001, 970002, 970003].every((id) => cs.list.some((e) => e.tmdb_id === id)), JSON.stringify(cs.list.map((e) => e.tmdb_id)));
  S.check('guest person page: holds a film the owner marked', (after[`/api/person/${C.PEOPLE.ada.id}`]?.playing || []).some((f) => MARKED.has(f.tmdb_id)));
  for (const k of ['lastChance', 'leavingSoon']) {
    const dates = (recs[k] || []).map((e) => e.lastDate);
    S.check(`guest ${k}: soonest to leave first, no watchlisted film ahead`, dates.every((d, i) => !i || dates[i - 1] <= d), JSON.stringify((recs[k] || []).map((e) => [e.tmdb_id, e.lastDate])));
  }
});

await S.step('the guest\'s lists follow public scores only', async () => {
  const recs = after['/api/recommendations'];
  const pub = (e) => e.public?.combined ?? null;
  const score = (e) => (pub(e) == null ? -1 : pub(e));
  S.check('guest: every match is the rounded public score, or none without one', [...recs.list, ...recs.alsoNearby].every((e) => e.final === (pub(e) == null ? null : Math.round(pub(e)))),
    JSON.stringify(recs.list.map((e) => [e.tmdb_id, e.final, pub(e)])));
  S.check('guest: Everything playing is in public-score order', recs.list.every((e, i) => !i || score(recs.list[i - 1]) >= score(e)), JSON.stringify(recs.list.map((e) => [e.tmdb_id, pub(e)])));
  S.check('guest: the four is the top four by public score', JSON.stringify(recs.weekly4.map((e) => e.tmdb_id)) === JSON.stringify(recs.list.slice(0, 4).map((e) => e.tmdb_id)), JSON.stringify(recs.weekly4.map((e) => e.tmdb_id)));
  const worth = recs.list.slice(4).filter((e) => pub(e) != null && e.final >= 75).map((e) => e.tmdb_id);
  S.check('guest: Also worth seeing is the rest scoring 75 or more', JSON.stringify(recs.worthSeeing.map((e) => e.tmdb_id)) === JSON.stringify(worth) && recs.goodMatchMinScore === 75, JSON.stringify(recs.worthSeeing.map((e) => e.tmdb_id)));
  S.check('guest: Last chance needs a public score of 75', recs.lastChance.every((e) => e.final >= 75) && recs.lastChance.length > 0, JSON.stringify(recs.lastChance.map((e) => [e.tmdb_id, e.final])));
  const cs = after['/api/coming-soon'].list;
  S.check('guest Coming Soon: advance screenings first, then the soonest release', cs.every((e, i) => !i || Number(cs[i - 1].advance) > Number(e.advance) || (cs[i - 1].advance === e.advance && (cs[i - 1].release_date || '') <= (e.release_date || ''))),
    JSON.stringify(cs.map((e) => [e.tmdb_id, e.advance, e.release_date])));
  const st = after['/api/status'];
  S.check('guest status: names the theaters', Boolean(st.theatre?.name) && st.theatres?.length === 2 && st.theatres.every((t) => t.name));
});

await S.step('guest answers carry no real theater id', async () => {
  const ids = [];
  const walk = (v, at) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'theatre' || k === 'theatres') && x) for (const t of [].concat(x)) if (t && typeof t === 'object' && t.id) ids.push(`${at}.${k}: ${t.id}`);
      walk(x, `${at}.${k}`);
    }
  };
  for (const p of ['/api/status', '/api/recommendations', '/api/coming-soon', `/api/movies/${C.PLAYING[0].id}`]) {
    ids.length = 0;
    walk(after[p], '');
    S.check(`guest GET ${p}: every theater id is blank`, !ids.length, ids.slice(0, 3).join(' | '));
  }
});

await S.step('a guest movie page asks the outside for nothing and writes nothing', async () => {
  const posterCalls = () => w.net().filter((e) => e.host === 'image.tmdb.org').length;
  const color = () => w.q1('SELECT poster_color FROM movies WHERE tmdb_id = ?', PALE)?.poster_color ?? null;
  // The server works out missing colours as it starts; once that's done, the
  // film forgets its colour, the way a film found by search has none.
  for (let i = 0; i < 50 && color() == null; i++) await sleep(100);
  const d = w.db();
  try { d.prepare('UPDATE movies SET poster_color = NULL, poster_color_src = NULL WHERE tmdb_id = ?').run(PALE); } finally { d.close(); }
  const n0 = posterCalls();
  const r = await w.api('GET', `/api/movies/${PALE}`, { as: GUEST });
  await sleep(1500);
  S.check('guest movie page answers', r.status === 200);
  S.check('guest movie page: no poster fetched', posterCalls() === n0, `${posterCalls() - n0} poster request(s)`);
  S.check('guest movie page: the film\'s poster colour is still unset', color() == null, color());
  // Control: the owner's read does fetch it and store the colour.
  await w.api('GET', `/api/movies/${PALE}`);
  let stored = null;
  for (let i = 0; i < 40 && stored == null; i++) { await sleep(100); stored = color(); }
  S.check('control: the owner\'s read fetches the poster and stores its colour', stored != null && posterCalls() > n0, `${stored} ${posterCalls() - n0}`);
});

await w.close();
S.finish();
