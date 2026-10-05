// Privacy between friends (old G6's privacy part and person search S8
// g-privacy): no friend ever sees another friend's (or the owner's) data.
//
// Friend A (the heavy friend) gets marked data: ratings, a watchlist film, a
// hidden film, a watched film, search recents, settings, a Letterboxd name,
// a push device. Then every GET route in the security suite's route table,
// and the movie pages of those films, is read as friend B, the other friend,
// the owner (local and through the owner link) and the guest: none shows
// any of A's data, and none but the owner names A. B deleting or unsubscribing
// A's things by id changes nothing. Watch together pairs only the owner and
// an opted-in friend, and every other id gets the same 404. On a person page
// each person sees exactly their own ratings and saves.
import { suite } from '../lib/check.mjs';
import { openWorld, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';
import { ROUTES, fill } from './security.mjs';
import crypto from 'node:crypto';

const S = suite('privacy');
const TOKEN = 'privacy-test-owner-token-0123456789abcdef';
const w = S.world(await openWorld('privacy', { push: true, env: { OWNER_TOKEN: TOKEN, GUEST_MODE: '' } }));
const A = { name: 'friend A', ...w.friends.robin };
const B = { name: 'friend B', ...w.friends.casey };
const Cf = { name: 'friend C', ...w.friends.jordan };
const OWNER = { name: 'owner', headers: {} };
const GUESTR = { name: 'guest', headers: GUEST };
const get = (who, p, o = {}) => w.api('GET', p, { as: who, ...o });
const send = (who, m, p, body) => w.api(m, p, { as: who, body });

const [X_RATED, Y_WATCH, H_HIDDEN, W_SEEN, R_RECENT] = [960003, 960004, 960005, 960006, 960007];
const CAN = 'QZXCANARY';

await S.step('friend A\'s marked data goes in', async () => {
  const r1 = await send(A, 'POST', '/api/ratings', { tmdb_id: X_RATED, rating: 4.5, title: `${CAN}-RATED` });
  S.check('friend A can rate', r1.status === 200, `${r1.status}`);
  S.check('friend A can save a film', (await send(A, 'POST', '/api/watchlist/toggle', { tmdb_id: Y_WATCH })).json?.watchlisted === true);
  S.check('friend A can hide a film', (await send(A, 'POST', '/api/hidden', { tmdb_id: H_HIDDEN, title: `${CAN}-HIDDEN` })).status === 200);
  S.check('friend A can mark a film seen', (await send(A, 'POST', '/api/watched', { tmdb_id: W_SEEN, title: `${CAN}-WATCHED`, in_weekly4: false })).status === 200);
  await send(A, 'POST', '/api/search/recents', { query: `${CAN.toLowerCase()} recent canary` });
  await send(A, 'POST', '/api/search/recents', { movie: { tmdb_id: R_RECENT, title: `${CAN}-RECENT-MOVIE` } });
  const s = await send(A, 'PUT', '/api/settings', { streamingServices: ['hulu'], moviePlan: 'regal-unlimited', home: { label: `${CAN}-HOME` }, excludedGenres: [`${CAN}-GENRE`] });
  S.check('friend A can save settings', s.status === 200, `${s.status} ${s.text.slice(0, 80)}`);
  const l = await send(A, 'PUT', '/api/letterboxd', { username: `${CAN.toLowerCase()}lbxuser` });
  S.check('friend A can link Letterboxd', l.status === 200, `${l.status}`);
});

await S.step('friend B can\'t change friend A\'s things by id', async () => {
  await send(B, 'DELETE', `/api/ratings/${X_RATED}`);
  await send(B, 'DELETE', `/api/hidden/${H_HIDDEN}`);
  await send(B, 'DELETE', `/api/search/recents?kind=query&key=${encodeURIComponent(`${CAN.toLowerCase()} recent canary`)}`);
  await send(B, 'DELETE', `/api/search/recents?kind=movie&key=${R_RECENT}`);
  const watchedId = w.q1('SELECT id FROM watched WHERE user_id = ? AND tmdb_id = ?', A.id, W_SEEN)?.id;
  S.check('friend A has a watched row', Boolean(watchedId));
  await send(B, 'DELETE', `/api/watched/${watchedId}`);
  await send(OWNER, 'DELETE', `/api/watched/${watchedId}`);
  await send(OWNER, 'DELETE', `/api/ratings/${X_RATED}`);
  S.check('B and the owner deleting by id leave A\'s rating', (await get(A, '/api/ratings')).json?.ratings?.some((r) => r.tmdb_id === X_RATED));
  S.check('B deleting by id leaves A\'s hidden film', (await get(A, '/api/hidden')).json?.movies?.some((m) => m.tmdb_id === H_HIDDEN));
  const rc = (await get(A, '/api/search/recents')).json;
  S.check('B deleting recents leaves A\'s recents', rc?.queries?.length === 1 && rc?.movies?.length === 1);
  S.check('B and the owner undoing a watched id leave A\'s watched row', JSON.stringify((await get(A, '/api/alist')).json).includes(`${CAN}-WATCHED`));
});

await S.step('friend B can\'t see or move friend A\'s push device', async () => {
  const sub = w.push.newSub('friend-a');
  const s1 = await send(A, 'POST', '/api/push/subscribe', { subscription: sub });
  S.check('friend A can turn on notifications', s1.status === 200, `${s1.status} ${s1.text.slice(0, 80)}`);
  S.check('B can\'t see A\'s push device', (await send(B, 'POST', '/api/push/check', { endpoint: sub.endpoint })).json?.subscribed === false);
  await send(B, 'POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
  S.check('B unsubscribing A\'s device leaves A subscribed', (await send(A, 'POST', '/api/push/check', { endpoint: sub.endpoint })).json?.subscribed === true);
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const forged = { endpoint: sub.endpoint, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const s2 = await send(B, 'POST', '/api/push/subscribe', { subscription: forged });
  const c3 = await send(A, 'POST', '/api/push/check', { endpoint: sub.endpoint });
  S.check('B re-subscribing A\'s device with other keys doesn\'t move it', s2.status === 409 && c3.json?.subscribed === true, `B ${s2.status}, A ${c3.json?.subscribed}`);
});

await S.step('watch together pairs only the owner and an opted-in friend', async () => {
  const bodies = [];
  for (const [who, id] of [[B, A.id], [A, B.id], [B, 1], [OWNER, A.id], [B, 999999]]) {
    const r = await get(who, `/api/together/${id}`);
    bodies.push(r.text);
    S.check(`${who.name} /together/<${id === 1 ? 'owner' : id === 999999 ? 'made-up' : 'friend'}> is a 404 while nobody opted in`, r.status === 404, `${r.status}`);
  }
  S.check('every refused id gets the identical answer', new Set(bodies).size === 1, [...new Set(bodies)].join(' | ').slice(0, 200));
  await send(A, 'PUT', '/api/settings', { watchTogether: true });
  const t1 = await get(B, `/api/together/${A.id}`);
  S.check('friend B can\'t pair with opted-in friend A (the same 404)', t1.status === 404 && t1.text === bodies[0], `${t1.status}`);
  const t2 = await get(OWNER, `/api/together/${A.id}`);
  S.check('the owner can pair with opted-in friend A', t2.status === 200, `${t2.status}`);
  const tx = JSON.stringify(t2.json || {});
  S.check('the Together answer carries no ratings or scores', !/"(rating|myRating|score|match|matchScore)"\s*:/.test(tx) && !tx.includes(CAN));
  const t3 = await get(B, '/api/together');
  S.check('B\'s Together overview names nobody but the owner', !t3.text.includes('Robin') && !t3.text.includes('Jordan'), t3.text.slice(0, 160));
  const t4 = await get(A, '/api/together');
  S.check('A\'s Together overview doesn\'t name the other friends', !t4.text.includes('Casey') && !t4.text.includes('Jordan'), t4.text.slice(0, 160));
  await send(A, 'PUT', '/api/settings', { watchTogether: false });
  S.check('after opting out, the owner gets the 404 again', (await get(OWNER, `/api/together/${A.id}`)).status === 404);
});

await S.step('no one else ever reads friend A\'s data', async () => {
  const oc = (await fetch(`${w.base}/?owner=${TOKEN}`, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0];
  const REMOTE = { name: 'owner-remote', headers: { 'cf-ray': 'test', cookie: oc } };
  S.check('setup: the owner link works', (await get(REMOTE, '/api/status')).json?.user?.isOwner === true);
  const vals = { film: X_RATED, person: C.PEOPLE.ada.id, showtime: w.q1("SELECT id FROM showtimes WHERE theatre_id = '9101' AND tmdb_id IS NOT NULL ORDER BY date DESC, id LIMIT 1")?.id || 'x' };
  const gets = ROUTES.filter(([m]) => m === 'GET').map(([, p]) => p)
    .filter((p) => p !== '/api/backup/latest') // the newest backup is the whole database by design (owner only)
    .concat([`/api/movies/${Y_WATCH}`, `/api/movies/${H_HIDDEN}`, `/api/movies/${R_RECENT}`, `/api/movies/${W_SEEN}`, '/api/search?q=blue', `/api/providers?ids=${X_RATED},${Y_WATCH}`, '/api/stats/group?kind=genre&name=Drama', '/api/person/60005']);
  for (const who of [B, Cf, OWNER, REMOTE, GUESTR]) {
    const leaks = []; const named = [];
    for (const tp of gets) {
      const p = fill(tp, vals);
      const r = await get(who, p);
      if (r.text.includes(CAN) || r.text.includes(CAN.toLowerCase())) leaks.push(`${p} (${r.status})`);
      if (who !== OWNER && who !== REMOTE && r.text.includes('Robin')) named.push(p);
    }
    S.check(`${who.name}: no GET route shows any of friend A's data`, !leaks.length, leaks.join(', '));
    if (who !== OWNER && who !== REMOTE) S.check(`${who.name}: no GET route names friend A`, !named.length, named.join(', '));
    const wl = await get(who, '/api/watchlist');
    if (wl.status === 200) S.check(`${who.name}: the watchlist excludes A's film`, !wl.json.movies.some((m) => m.tmdb_id === Y_WATCH));
    const rt = await get(who, '/api/ratings');
    if (rt.status === 200) S.check(`${who.name}: ratings exclude A's film`, !rt.json.ratings.some((m) => m.tmdb_id === X_RATED));
    const hd = await get(who, '/api/hidden');
    if (hd.status === 200) S.check(`${who.name}: hidden films exclude A's`, !hd.json.movies.some((m) => m.tmdb_id === H_HIDDEN));
    const md = await get(who, `/api/movies/${X_RATED}`);
    S.check(`${who.name}: A's rated film's page shows no rating from A`, md.json?.myRating == null && md.json?.watchlisted !== true);
    const mw = await get(who, `/api/movies/${Y_WATCH}`);
    S.check(`${who.name}: A's saved film's page shows no save from A`, mw.json?.watchlisted !== true);
    const mh = await get(who, '/api/recommendations');
    if (mh.status === 200) S.check(`${who.name}: A's hidden film isn't counted as hidden for them`, !mh.json.hiddenCount, `${mh.json.hiddenCount}`);
  }
  const own = await get(A, '/api/state');
  S.check('friend A\'s own export has A\'s data (the marked data is real)', own.text.includes(`${CAN}-RATED`) && own.text.includes(`${CAN}-HOME`));
  S.check('friend A\'s export carries none of the owner\'s shared settings or matches', !own.text.includes('"matches"') && !/lastRefreshLog|goodMatchMinScore/.test(own.text));
  const csv = await get(A, '/api/export');
  S.check('friend A\'s CSV export is A\'s own', csv.text.includes(`${CAN}-RATED`) && !csv.text.includes(`rating,${C.RATED[10].id},`));
  const ownerCsv = await get(OWNER, '/api/export');
  S.check('the owner\'s CSV export has none of A\'s rows', !ownerCsv.text.includes(CAN) && ownerCsv.text.includes(`rating,${C.RATED[10].id},`) && !ownerCsv.text.includes(`,${X_RATED},`));
  S.check('friend settings omit the owner\'s refresh log', !('lastRefreshLog' in ((await get(A, '/api/settings')).json || {})));
  const fst = (await get(A, '/api/status')).json || {};
  S.check('friend status has no key fingerprints, data folder or backup info', !('keyMeta' in fst) && !('data' in fst) && !('backup' in fst));
  const lb = (await get(B, '/api/letterboxd')).json;
  S.check('B\'s Letterboxd link is B\'s own (none)', !lb?.username, JSON.stringify(lb).slice(0, 80));
  for (const [who, uid] of [[B, B.id], [A, A.id], [OWNER, 1]]) {
    const st = (await get(who, '/api/stats')).json;
    const n = w.q1('SELECT COUNT(*) n FROM ratings WHERE user_id = ?', uid).n;
    const seen = w.q1('SELECT COUNT(*) n FROM watched WHERE user_id = ?', uid).n;
    S.check(`${who.name}: Stats count only their own ratings and watch log`, st?.totalRatings === n && st?.seenAll === seen && !JSON.stringify(st).includes(CAN), `${st?.totalRatings}/${n} rated, ${st?.seenAll}/${seen} seen`);
  }
});

// ---------------------------------------------------------------- S8: person pages
await S.step('on a person page each person sees only their own ratings and saves', async () => {
  const PID = C.PEOPLE.ada.id;
  const films = [950001, 950007, 950013, 950019];
  const [f1, f2, f3, f4] = films;
  await send(OWNER, 'POST', '/api/ratings', { tmdb_id: f1, rating: 5, title: C.film(f1).title });
  await send(OWNER, 'POST', '/api/watchlist/toggle', { tmdb_id: f2 });
  await send(A, 'POST', '/api/ratings', { tmdb_id: f3, rating: 1.5, title: C.film(f3).title });
  await send(A, 'POST', '/api/watchlist/toggle', { tmdb_id: f4 });
  await send(Cf, 'POST', '/api/ratings', { tmdb_id: f2, rating: 3, title: C.film(f2).title });
  const theirs = new Set(C.credits(C.PEOPLE.ada).crew.map((c) => c.id));
  for (const [who, uid] of [[OWNER, 1], [A, A.id], [B, B.id], [Cf, Cf.id]]) {
    const wantRated = Object.fromEntries(w.q('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', uid).filter((r) => theirs.has(r.tmdb_id)).map((r) => [r.tmdb_id, r.rating]));
    const wantSaved = w.q('SELECT tmdb_id FROM watchlist WHERE user_id = ?', uid).map((r) => r.tmdb_id).filter((id) => theirs.has(id)).sort();
    const d = (await get(who, `/api/person/${PID}`)).json;
    const all = [...d.playing, ...d.rated, ...d.directed, ...d.acted, ...d.actedSmaller];
    const ratedGot = Object.fromEntries(all.filter((f) => f.myRating != null).map((f) => [f.tmdb_id, f.myRating]));
    const savedGot = [...new Set(all.filter((f) => f.watchlisted).map((f) => f.tmdb_id))].sort();
    const sortObj = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
    S.check(`${who.name}: the ratings on the person page are exactly their own`, sortObj(ratedGot) === sortObj(wantRated), `${sortObj(ratedGot)} vs ${sortObj(wantRated)}`);
    S.check(`${who.name}: the saves on the person page are exactly their own`, JSON.stringify(savedGot) === JSON.stringify(wantSaved), `${savedGot} vs ${wantSaved}`);
  }
  S.check('friend B, who rated none of them, sees no You rated', !(await get(B, `/api/person/${PID}`)).json.rated.length);
});

// ---------------------------------------------------------------- account numbers
// Accounts are numbered in the order they were made, so a friend told "you
// are account 3" learns that someone else joined before them. A friend is
// never given their own number: /api/status names them by a handle, and the
// friend cookie carries the handle too. A cookie from before (v1, with the
// number) still works and is swapped for the new kind on the next answer.
await S.step('a friend is never told their own account number', async () => {
  const handles = new Set();
  for (const f of [A, B, Cf]) {
    const st = (await get(f, '/api/status')).json;
    const again = (await get(f, '/api/status')).json;
    const id = st?.user?.id;
    S.check(`${f.name}: status names them, but not by their account number`, st?.user?.isOwner === false && id != null && String(id) !== String(f.id) && !/^\d+$/.test(String(id)), JSON.stringify(id));
    S.check(`${f.name}: the handle stays the same from one answer to the next`, again?.user?.id === id);
    handles.add(id);
  }
  S.check('each friend has their own handle', handles.size === 3);
  S.check('the owner is still account 1', (await get(OWNER, '/api/status')).json?.user?.id === 1);
  // A new friend's cookie, as the Join page sets it.
  const r = await w.api('POST', '/api/friends', { body: { name: 'Numbered Later' } });
  const token = new URL(r.json.invite, 'http://x').searchParams.get('invite');
  const j = await fetch(`${w.base}/invite/join`, { method: 'POST', redirect: 'manual', headers: { origin: w.base, 'cf-ray': 'test', 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
  const cookie = (j.headers.get('set-cookie') || '').split(';')[0];
  const parts = decodeURIComponent(cookie.slice('rp_user='.length)).split('.');
  S.check('the friend cookie carries no account number', parts[0] === 'v2' && parts.length === 5 && !/^\d+$/.test(parts[1]) && parts[1] !== String(r.json.friend.id), parts.slice(0, 2).join('.'));
  const NEW = { headers: { 'cf-ray': 'test', cookie } };
  S.check('the new kind of cookie signs them in', (await get(NEW, '/api/status')).json?.user?.name === 'Numbered Later');
  // A cookie from before the change: v1.<id>.<version>.<expiry>.<hmac>.
  const secret = JSON.parse(w.q1("SELECT value FROM settings WHERE key = 'friendCookieSecret'").value);
  const row = w.q1('SELECT id, session_version FROM users WHERE id = ?', A.id);
  // Its expiry is on the server's made-up clock, so the cookie is good whatever
  // today's date is.
  const now = w.srv.fakeNowMs + (Date.now() - w.srv.startedAt);
  const payload = `v1.${row.id}.${row.session_version}.${now + 864e5 * 30}`;
  const v1 = `rp_user=${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const old = await w.api('GET', '/api/ratings', { as: { headers: { 'cf-ray': 'test', cookie: v1 } } });
  const swapped = (old.headers.get('set-cookie') || '').split(';')[0];
  S.check('a cookie from before still signs the friend in', old.status === 200);
  S.check('and is swapped for one without the account number', swapped.startsWith('rp_user=v2.') && !swapped.includes(`v2.${A.id}.`), swapped.slice(0, 12));
  S.check('the swapped cookie is HttpOnly, Secure and SameSite=Lax', /HttpOnly/i.test(old.headers.get('set-cookie') || '') && /Secure/i.test(old.headers.get('set-cookie') || '') && /SameSite=Lax/i.test(old.headers.get('set-cookie') || ''));
  S.check('the swapped cookie signs the same friend in', (await get({ headers: { 'cf-ray': 'test', cookie: swapped } }, '/api/status')).json?.user?.name === w.q1('SELECT name FROM users WHERE id = ?', A.id).name);
  S.check('a new-kind cookie isn\'t swapped again', !(await w.api('GET', '/api/ratings', { as: { headers: { 'cf-ray': 'test', cookie: swapped } } })).headers.get('set-cookie'));
  // Forgeries of either kind are refused.
  const p2 = decodeURIComponent(swapped.slice('rp_user='.length)).split('.');
  const otherHandle = (await get(B, '/api/status')).json.user.id;
  S.check('a cookie with another friend\'s handle swapped in is refused', (await w.api('GET', '/api/ratings', { as: { headers: { 'cf-ray': 'test', cookie: `rp_user=${[p2[0], otherHandle, ...p2.slice(2)].join('.')}` } } })).status === 403);
  S.check('an old-kind cookie edited to user 1 is refused', (await w.api('GET', '/api/friends', { as: { headers: { 'cf-ray': 'test', cookie: v1.replace(/^rp_user=v1\.\d+\./, 'rp_user=v1.1.') } } })).status === 403);
});

await w.close();
S.finish();
