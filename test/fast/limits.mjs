// Hourly limits (old D8 g-limits, S9 g-limit, S15): friends get 200 new-film
// lookups, 300 rating searches and 30 home-base lookups an hour, then 429
// with "Slow down a bit, try again in a few minutes."; the limits are per
// user; the owner has none; the guest link is held to stricter ones; a heavy
// but normal hour never hits a limit; the window resets after an hour. A
// person lookup counts as one new-film lookup in the same bucket, and over the
// limit the header search still returns films, just no people.
//
// The message shown in the app is a browser check (function suite).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, call, REPO, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('limits');
const MSG = 'Slow down a bit, try again in a few minutes.';
// The place lookup waits a second between calls (Nominatim's rule); the
// shortened timers make that instant here.
const w = S.world(await openWorld('limits', { env: { RP_TIMEOUT_SCALE: '0.01' } }));
const count = (arr, s) => arr.filter((x) => x === s).length;
async function burst(n, fn) { const out = []; for (let i = 0; i < n; i++) out.push((await fn(i)).status); return out; }
let nextId = 7200000;
const cold = (as) => w.api('GET', `/api/movies/${nextId++}`, { as });
const search = (as, i) => w.api('GET', `/api/ratings/search?q=${encodeURIComponent(`query ${i}`)}`, { as });
const place = (as, i) => w.api('GET', `/api/geocode?q=${encodeURIComponent(`Town ${i}`)}`, { as });
const person = (as, id) => w.api('GET', `/api/person/${id}`, { as });

const sam = await makeFriend(w.base, 'Taylor');
const casey = await makeFriend(w.base, 'Morgan');
for (const f of [sam, casey]) await w.api('PUT', '/api/settings', { as: f, body: { setupDone: true, tourDone: true, onboardingDone: true } });

await S.step('a heavy but normal hour never hits a limit', async () => {
  const normal = [];
  normal.push((await w.api('POST', '/api/onboarding/rate', { as: casey, body: { ratings: Array.from({ length: 24 }, (_, i) => ({ tmdb_id: 7100000 + i, rating: 3.5, title: `Onboard ${i}` })) } })).status);
  normal.push(...await burst(150, (i) => search(casey, i)));
  normal.push(...await burst(60, (i) => w.api('POST', '/api/ratings', { as: casey, body: { tmdb_id: 7150000 + i, rating: 4, title: `Found ${i}` } })));
  normal.push(...await burst(40, () => cold(casey)));
  normal.push(...await burst(5, (i) => place(casey, i)));
  S.check('24 onboarding films, 150 searches, 60 ratings, 40 new film pages and 5 place lookups get no 429', count(normal, 429) === 0, `${normal.length} requests, ${count(normal, 429)} x 429, statuses ${[...new Set(normal)].join('/')}`);
});

await S.step('friend limits', async () => {
  const films = await burst(200, () => cold(sam));
  const over = await cold(sam);
  S.check('friend: 200 new-film lookups in an hour are answered', count(films, 429) === 0 && films.length === 200, `${count(films, 429)} x 429`);
  S.check('friend: the 201st gets 429 with the message', over.status === 429 && over.json?.error === MSG, `${over.status} ${over.text.slice(0, 80)}`);
  S.check('friend: a film already stored still opens (only new-film lookups count)', (await w.api('GET', `/api/movies/${C.PLAYING[0].id}`, { as: sam })).status === 200);
  const rate = await w.api('POST', '/api/ratings', { as: sam, body: { tmdb_id: 7299999, rating: 4, title: 'One more' } });
  S.check('friend: rating a film not yet stored is a new-film lookup too', rate.status === 429 && rate.json?.error === MSG, `${rate.status}`);
  const wl = await w.api('POST', '/api/watchlist/toggle', { as: sam, body: { tmdb_id: 7299998 } });
  S.check('friend: watchlisting a film not yet stored is a new-film lookup too', wl.status === 429, `${wl.status}`);
  const srch = await burst(300, (i) => search(sam, i));
  const srchOver = await search(sam, 301);
  S.check('friend: 300 rating searches in an hour are answered, the 301st gets 429', count(srch, 200) === 300 && srchOver.status === 429 && srchOver.json?.error === MSG, `${count(srch, 200)} ok, then ${srchOver.status}`);
  const pl = await burst(30, (i) => place(sam, i));
  const plOver = await w.api('GET', `/api/geocode/reverse?lat=${C.HOME.lat}&lng=${C.HOME.lng}`, { as: sam });
  S.check('friend: 30 home-base lookups in an hour are answered, the 31st (reverse too) gets 429', count(pl, 200) === 30 && plOver.status === 429 && plOver.json?.error === MSG, `${count(pl, 200)} ok, then ${plOver.status}`);
  const other = await burst(3, () => cold(casey));
  S.check('the limits are per user: another friend is unaffected', count(other, 429) === 0);
});

await S.step('the owner is exempt', async () => {
  const o1 = await burst(260, () => cold(null));
  const o2 = await burst(330, (i) => search(null, i));
  const o3 = await burst(40, (i) => place(null, i));
  S.check('owner: 260 new films, 330 searches and 40 place lookups get no 429', count([...o1, ...o2, ...o3], 429) === 0, `${count([...o1, ...o2, ...o3], 429)} x 429`);
  const own = await burst(5, (i) => person(null, 7500000 + i));
  S.check('owner: person lookups after all that still get no 429', count(own, 429) === 0);
});

await S.step('an hour later the window has moved on', async () => {
  await w.jump(new Date(Date.parse(C.T0) + 65 * 60e3).toISOString());
  S.check('an hour later the friend can search again', (await search(sam, 999)).status === 200);
  S.check('an hour later the friend can look up a new film again', (await cold(sam)).status !== 429);
});

await S.step('a person lookup is a new-film lookup', async () => {
  const p1 = await makeFriend(w.base, 'Avery');
  const p2 = await makeFriend(w.base, 'Quinn');
  const p3 = await makeFriend(w.base, 'Rowan');
  // Each live person lookup waits its turn on the shared TMDB throttle
  // (about half a second), so most of the bucket is filled with film lookups.
  const cached = await person(p1, C.PEOPLE.ada.id);
  S.check('a person page opens for a friend', cached.status === 200, `${cached.status}`);
  const fill = await burst(198, () => cold(p1));
  const last = await person(p1, 7100000);
  const over = await person(p1, 7100999);
  S.check('198 film lookups and 2 person lookups are answered (200 in all)', count(fill, 429) === 0 && last.status !== 429, `${count(fill, 429)} x 429, person ${last.status}`);
  S.check('the 201st lookup, a person, gets 429 with the message', over.status === 429 && over.json?.error === MSG, `${over.status} ${over.text.slice(0, 80)}`);
  S.check('a person already cached still opens (it asks TMDB nothing)', (await person(p1, C.PEOPLE.ada.id)).status === 200);
  S.check('a new film is refused too: one bucket', (await w.api('GET', '/api/movies/7300001', { as: p1 })).status === 429);
  const s = (await w.api('GET', '/api/search?q=quentin%20tarantino', { as: p1 })).json;
  S.check('over the limit the header search still returns the films, without people', s && s.results.length > 0 && s.people.length === 0, JSON.stringify({ films: s?.results?.length, people: s?.people?.length }));
  const c = (await w.api('GET', '/api/search?q=quentin%20tarantino', { as: p2 })).json;
  S.check('control: a friend under the limit gets the person for the same query', c && c.people.length === 1, JSON.stringify(c?.people?.map((p) => p.name)));
  const films = await burst(199, (i) => w.api('GET', `/api/movies/${7400000 + i}`, { as: p3 }));
  S.check('film lookups and person lookups share the bucket: 199 new films are answered', count(films, 429) === 0);
  S.check('the 200th lookup, a person, is answered', (await person(p3, 7200001)).status !== 429);
  const over3 = await person(p3, 7200002);
  S.check('the 201st, a person, gets 429 with the message', over3.status === 429 && over3.json?.error === MSG);
});

await S.step('the guest link is held to stricter limits', async () => {
  // Read from the limits module's text (the tests never import server code).
  const src = fs.readFileSync(path.join(REPO, 'server/lib/limits.js'), 'utf8');
  const caps = (role) => Object.fromEntries([...(src.match(new RegExp(`${role}:\\s*\\{([^}]*)\\}`))?.[1] || '').matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const friend = caps('friend'); const guest = caps('guest');
  S.check('friend caps are 200 new films, 300 searches and 30 place lookups', friend.newFilm === 200 && friend.search === 300 && friend.place === 30, JSON.stringify(friend));
  // The fourth kind, note writes (notes on ratings), is checked in notes.mjs.
  S.check('guests have stricter caps than friends for every kind', Object.keys(friend).length === 4 && friend.note === 300 && Object.keys(friend).every((k) => guest[k] < friend[k]), JSON.stringify(guest));
  const G = { 'cf-ray': 'test', 'cf-connecting-ip': '203.0.113.77' };
  const g = await burst(guest.newFilm, (i) => person(G, 7600000 + i));
  const gOver = await person(G, 7600999);
  S.check(`the guest: ${guest.newFilm} person lookups answered, the next gets 429`, count(g, 429) === 0 && gOver.status === 429 && gOver.json?.error === MSG, `${count(g, 429)} x 429 then ${gOver.status}`);
  S.check('another guest address has its own allowance', (await person({ 'cf-ray': 'test', 'cf-connecting-ip': '203.0.113.78' }, 7600998)).status !== 429);
  const guestCold = await w.api('GET', `/api/movies/${nextId++}`, { as: GUEST });
  const guestSearch = await w.api('GET', '/api/ratings/search?q=x', { as: GUEST });
  S.check('the guest link can\'t look films up at all (404 for an unstored film, 403 for search)', guestCold.status === 404 && guestSearch.status === 403, `${guestCold.status}/${guestSearch.status}`);
});

// Who a guest is counted as: on Railway, X-Real-IP (Railway's edge sets it);
// through the share tunnel on this machine, cf-connecting-ip (Cloudflare's
// edge sets it); anything else, the socket address. A caller can type any
// cf-connecting-ip or X-Forwarded-For, so on Railway those buy nothing.
await S.step('made-up headers don\'t buy a guest more requests', async () => {
  const src = fs.readFileSync(path.join(REPO, 'server/lib/limits.js'), 'utf8');
  const cap = Number(src.match(/guest:\s*\{[^}]*newFilm:\s*(\d+)/)?.[1]);
  let ip = 0;
  const madeUp = () => { ip++; return { 'cf-connecting-ip': `203.0.113.${ip % 250}`, 'x-forwarded-for': `198.18.${ip % 250}.1, 10.0.0.${ip % 250}`, 'cf-ray': `made-up-${ip}` }; };
  let pid = 7700000;
  await w.restart({ env: { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PROJECT_ID: 'test-project-id', GUEST_MODE: '1' } });
  const st = (await w.api('GET', '/api/status', { as: { 'x-real-ip': '198.51.100.7' } })).json;
  S.check('Railway: a visitor with no cookie is the guest', st?.guest === true, JSON.stringify({ guest: st?.guest }));
  const one = await burst(cap, () => person({ 'x-real-ip': '198.51.100.7', ...madeUp() }, pid++));
  const oneOver = await person({ 'x-real-ip': '198.51.100.7', ...madeUp() }, pid++);
  S.check(`Railway: ${cap} person lookups from one X-Real-IP, each with new made-up cf-connecting-ip and X-Forwarded-For values, then a 429`, cap > 0 && count(one, 429) === 0 && oneOver.status === 429 && oneOver.json?.error === MSG, `${count(one, 429)} x 429, then ${oneOver.status}`);
  S.check('Railway: another X-Real-IP has its own allowance', (await person({ 'x-real-ip': '198.51.100.8', ...madeUp() }, pid++)).status !== 429);
  const none = await burst(cap, () => person(madeUp(), pid++));
  const noneOver = await person(madeUp(), pid++);
  S.check(`Railway: with no X-Real-IP, guests share one allowance whatever else they send (${cap}, then a 429)`, count(none, 429) === 0 && noneOver.status === 429, `${count(none, 429)} x 429, then ${noneOver.status}`);
  const log = w.srv.log();
  S.check('the server prints none of the addresses it counted', !/198\.51\.100\.|203\.0\.113\.|198\.18\./.test(log), log.match(/.{0,60}(198\.51\.100\.|203\.0\.113\.|198\.18\.).{0,20}/)?.[0]);

  // Off Railway, cf-connecting-ip counts only when the request came through
  // the tunnel: Cloudflare's connector on this machine, so over loopback. A
  // device on the network typing the tunnel's headers is counted by its own
  // address.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4')?.address;
  if (!lan) { console.log('  - skipped: this machine has no network address, so the check from the network was not run'); return; }
  await w.restart({ env: { RP_ALLOW_LAN: '1', GUEST_MODE: '1' } });
  const fromLan = (h, id) => call(`http://${lan}:${w.srv.port}`, 'GET', `/api/person/${id}`, { as: h }).catch((e) => ({ status: 0, text: String(e.cause?.code || e.message) }));
  const l = await burst(cap, () => fromLan(madeUp(), pid++));
  const lOver = await fromLan(madeUp(), pid++);
  S.check(`off Railway: a device on the network sending made-up tunnel headers gets ${cap} person lookups, then a 429`, count(l, 429) === 0 && l.every((s) => s !== 0) && lOver.status === 429, `${count(l, 429)} x 429, statuses ${[...new Set(l)].join('/')}, then ${lOver.status}`);
  S.check('off Railway: the tunnel (over loopback) still counts each cf-connecting-ip on its own', (await person({ 'cf-ray': 'test', 'cf-connecting-ip': '203.0.113.201' }, pid++)).status !== 429);
});

await w.close();
S.finish();
