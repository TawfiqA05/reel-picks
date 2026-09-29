// Watchlist alerts on a mocked clock (server/lib/watchalerts.js), with the
// server in America/Indianapolis time and sample refreshes from the AMC
// stand-in (films held back and let in, one film's run cut short, the whole
// schedule moved weeks ahead):
//
//   switch    "Watchlist alerts" is off for everyone until each person turns
//             their own on; the guest can't read or change it
//   now       a watchlisted film's first showtimes at the person's theaters
//             send one push that opens the film; a film already showing when
//             it was watchlisted, or only at a theater just followed, doesn't
//   group     several at once are one push naming up to 3, opening Watchlist
//   last      entering Last chance sends one "Last week for" push per run
//   return    back after 14 days away alerts again, after 5 days doesn't
//   skip      rated (before it arrives or while it waits), marked seen, Not
//             for me, an I'm going plan, taken off the watchlist before the
//             send, the switch off, push off
//   hold      found at 10 PM, nothing until 9 AM, then one push at 9 AM
//   restart   a restart between the refresh and the send still sends once,
//             and nothing is ever sent twice
//   privacy   each person's own watchlist and theaters only, no names, the
//             guest gets nothing
//   picks     the alerts change no score, pick or weekly four
//
// Roles: the owner, Robin (700 ratings), Casey (the second friend, following
// Riverside first), Jordan (brand new, no push device) and the guest.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep, GUEST, REPO } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('alerts');
const K = (k) => C.PLAYING.find((f) => f.k === k);
const NEW = [3, 5, 6, 8, 9, 10, 12].map(K);
const TZ = 'America/Indianapolis';
const L = (s) => `${s}-04:00`; // Indianapolis is on EDT through Nov 1
const NAMES = [C.OWNER_NAME, 'Robin', 'Casey', 'Jordan'];
const ENV = { RP_TIMER_SCALE: '0.004', TZ };

// A world where the held-back films have never been at any theater.
const makeWorld = (name) => openWorld(name, {
  push: true, refresh: true, env: ENV,
  prepare: (d) => {
    for (const f of NEW) {
      d.prepare('DELETE FROM showtimes WHERE tmdb_id = ?').run(f.id);
      d.prepare('DELETE FROM watch_presence WHERE tmdb_id = ?').run(f.id);
    }
  },
});

function helpers(w) {
  const api = (as, m, p, body) => w.api(m, p, { as, body });
  const status = async () => (await w.api('GET', '/api/status')).json;
  const settle = () => sleep(1500); // six send ticks
  // A forced refresh that re-pulls every day from the AMC stand-in, and the
  // sends right after it.
  const refresh = async () => {
    w.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
    const before = (await status())?.lastRefresh;
    const r = await w.api('POST', '/api/refresh');
    if (r.status !== 200) throw new Error(`refresh ${r.status} ${r.text}`);
    const done = await until(async () => { const s = await status(); return s && !s.refreshing && s.lastRefresh !== before && s; }, 60000, 150);
    if (!done) throw new Error('the refresh did not finish');
    await settle();
  };
  const settledOn = (ymd) => until(async () => { const s = await status(); return s && !s.refreshing && s.lastRefresh && new Date(s.lastRefresh).toLocaleDateString('en-CA', { timeZone: TZ }) === ymd && s; }, 60000, 150);
  const pushes = (name) => w.push.hits.filter((h) => h.topic === 'watchlist' && (!name || h.name === name));
  const presence = (uid, k) => w.q1('SELECT * FROM watch_presence WHERE user_id = ? AND tmdb_id = ?', uid, K(k).id);
  const alerts = (uid) => w.q('SELECT * FROM watch_alerts WHERE user_id = ? ORDER BY id', uid);
  const watch = (as, k) => api(as, 'POST', '/api/watchlist/toggle', { tmdb_id: K(k).id });
  const setSwitch = (as, on) => api(as, 'PUT', '/api/settings', { watchlistAlerts: on });
  const recsOf = async (as) => {
    const r = (await api(as, 'GET', '/api/recommendations')).json;
    return JSON.stringify({ four: r.weekly4.map((e) => e.tmdb_id), list: r.list.map((e) => [e.tmdb_id, e.final]), worth: r.worthSeeing.map((e) => e.tmdb_id), near: r.alsoNearby.map((e) => [e.tmdb_id, e.final]), last: r.lastChance.map((e) => e.tmdb_id) });
  };
  return { api, status, settle, refresh, settledOn, pushes, presence, alerts, watch, setSwitch, recsOf };
}

// Every film title a push names.
const named = (h) => C.PLAYING.filter((f) => `${h.msg?.title} ${h.msg?.body}`.includes(f.title)).map((f) => f.k);
const allPushes = [];
const watchlists = new Map(); // "<world>:<name>" -> Set of k ever watchlisted there

// ================================================================== world A
const A = S.world(await makeWorld('alerts-a'));
const { robin: R, casey: Ca, jordan: J } = A.friends;
const a = helpers(A);
const OWNER = null;
const note = (who, ...ks) => { const key = `a:${who}`; if (!watchlists.has(key)) watchlists.set(key, new Set()); for (const k of ks) watchlists.get(key).add(k); };
note('owner', 2); note('robin', 4);

await S.step('Wednesday 10:00: the switch, devices and watchlists', async () => {
  for (const f of NEW) A.amc.gone.add(f.amcId);
  for (const [who, as] of [['owner', OWNER], ['robin', R], ['casey', Ca], ['jordan', J]]) {
    const s = await a.api(as, 'GET', '/api/settings');
    S.check(`switch: off by default for ${who}`, s.status === 200 && s.json.watchlistAlerts === false, `${s.status} ${s.json?.watchlistAlerts}`);
  }
  S.check('switch: the owner turns theirs on', (await a.setSwitch(OWNER, true)).status === 200 && (await a.api(OWNER, 'GET', '/api/settings')).json.watchlistAlerts === true);
  S.check('switch: the owner\'s switch changes no friend\'s', (await a.api(R, 'GET', '/api/settings')).json.watchlistAlerts === false && (await a.api(Ca, 'GET', '/api/settings')).json.watchlistAlerts === false);
  for (const as of [R, Ca, J]) await a.setSwitch(as, true);
  await a.setSwitch(Ca, false); await a.setSwitch(Ca, true);
  S.check('switch: each friend\'s own switch is theirs alone', (await a.api(R, 'GET', '/api/settings')).json.watchlistAlerts === true && (await a.api(J, 'GET', '/api/settings')).json.watchlistAlerts === true && A.q('SELECT COUNT(*) n FROM user_settings WHERE key = \'watchlistAlerts\'')[0].n === 4);
  const bad = await a.setSwitch(OWNER, 'yes');
  S.check('switch: anything but true or false is refused', bad.status === 400 && (await a.api(OWNER, 'GET', '/api/settings')).json.watchlistAlerts === true, `${bad.status}`);
  const gGet = await a.api(GUEST, 'GET', '/api/settings');
  const gPut = await a.api(GUEST, 'PUT', '/api/settings', { watchlistAlerts: true });
  const gSub = await a.api(GUEST, 'POST', '/api/push/subscribe', { subscription: A.push.newSub('guest') });
  S.check('switch: the guest can\'t read or change it, or add a device', gGet.status === 403 && gPut.status === 403 && gSub.status === 403, `${gGet.status} ${gPut.status} ${gSub.status}`);

  for (const [who, as] of [['owner', OWNER], ['robin', R], ['casey', Ca]]) {
    const r = await a.api(as, 'POST', '/api/push/subscribe', { subscription: A.push.newSub(who) });
    if (r.status !== 200) throw new Error(`subscribe ${who}: ${r.status}`);
  }
  // Jordan: switch on, no device (push off).
  for (const k of [5, 3, 6, 9, 12, 8, 10, 4, 1]) await a.watch(OWNER, k);
  note('owner', 5, 3, 6, 9, 12, 8, 10, 4, 1);
  for (const k of [12, 2]) await a.watch(R, k);
  note('robin', 12, 2);
  for (const k of [5, 2]) await a.watch(Ca, k);
  note('casey', 5, 2);
  await a.watch(J, 3); note('jordan', 3);
  await a.refresh();
  S.check('now: the first look for each friend and nothing new sends nothing', a.pushes().length === 0, JSON.stringify(a.pushes().map((h) => h.msg)));
});

await S.step('Wednesday 10:30: one new film', async () => {
  await A.jump(L('2026-09-23T10:30:00'));
  A.amc.gone.delete(K(5).amcId);
  const t0 = Date.now();
  await a.refresh();
  await until(() => a.pushes('owner').length >= 1 && a.pushes('casey').length >= 1, 8000);
  const took = Date.now() - t0;
  await a.settle();
  const o = a.pushes('owner');
  S.check('now: the owner gets one push, "Iron Chorus is now showing at Riverside"', o.length === 1 && o[0].msg?.title === `${K(5).title} is now showing at Riverside` && o[0].msg?.body === 'It\'s on your watchlist.', JSON.stringify(o.map((h) => h.msg)));
  S.check('now: a single-film alert opens that film\'s page', o[0]?.msg?.url === `/#/movie/${K(5).id}`, o[0]?.msg?.url);
  S.check('hold: found in the day, it goes out right after the refresh (no clock move)', o.length === 1 && took < 20000, `${took}ms`);
  const c = a.pushes('casey');
  S.check('privacy: the second friend gets their own push for their own watchlisted film', c.length === 1 && c[0].msg?.title === `${K(5).title} is now showing at Riverside`, JSON.stringify(c.map((h) => h.msg)));
  S.check('privacy: the 700-rating friend, who hasn\'t watchlisted it, gets nothing', a.pushes('robin').length === 0);
  S.check('now: a film already showing when it was watchlisted (Glass Orchard, The Paper Lantern) sends nothing', !a.pushes().some((h) => named(h).some((k) => [4, 1].includes(k))) && !A.q('SELECT 1 FROM watch_alerts WHERE tmdb_id IN (?, ?)', K(4).id, K(1).id).length);
});

let groupPush;
await S.step('Wednesday 11:00: six films at once, some the owner already rated, hid or can\'t get', async () => {
  await A.jump(L('2026-09-23T11:00:00'));
  await a.api(OWNER, 'POST', '/api/ratings', { tmdb_id: K(10).id, rating: 4, title: K(10).title, year: K(10).year });
  await a.api(OWNER, 'POST', '/api/hidden', { tmdb_id: K(8).id, title: K(8).title });
  await a.setSwitch(R, false);
  const before = a.pushes().length;
  for (const k of [3, 6, 8, 9, 10, 12]) A.amc.gone.delete(K(k).amcId);
  await a.refresh();
  await until(() => a.pushes('owner').length >= 2, 8000);
  await a.settle();
  const o = a.pushes('owner').slice(1);
  groupPush = o[0];
  const names = named(o[0] || {});
  S.check('group: one push for the owner\'s four films', o.length === 1 && o[0].msg?.title === '4 films from your watchlist are now showing', JSON.stringify(o.map((h) => h.msg)));
  S.check('group: it names 3 of them and says how many more', names.length === 3 && names.every((k) => [3, 6, 9, 12].includes(k)) && / and 1 more$/.test(o[0]?.msg?.body || ''), o[0]?.msg?.body);
  S.check('group: a grouped alert opens Watchlist', o[0]?.msg?.url === '/#/watchlist', o[0]?.msg?.url);
  const onList = (k) => Boolean(A.q1('SELECT 1 AS x FROM watchlist WHERE user_id = 1 AND tmdb_id = ?', K(k).id));
  S.check('skip: rated before it arrived (still on the watchlist): no alert', onList(10) && !A.q('SELECT 1 FROM watch_alerts WHERE user_id = 1 AND tmdb_id = ?', K(10).id).length && !names.includes(10));
  S.check('skip: hidden with Not for me (still on the watchlist): no alert', onList(8) && !A.q('SELECT 1 FROM watch_alerts WHERE user_id = 1 AND tmdb_id = ?', K(8).id).length && !names.includes(8));
  S.check('skip: the 700-rating friend with the switch off gets nothing for their watchlisted film', a.pushes('robin').length === 0 && !a.alerts(R.id).length && Boolean(a.presence(R.id, 12)));
  const jr = a.alerts(J.id);
  S.check('skip: push off (switch on, no device): nothing sent, the alert is marked', jr.length === 1 && jr[0].tmdb_id === K(3).id && jr[0].outcome === 'no device' && a.pushes('jordan').length === 0, JSON.stringify(jr));
  S.check('privacy: the second friend got nothing more (none of these are on their watchlist)', a.pushes('casey').length === 1);
  S.check('now: sent alerts are marked sent', a.alerts(1).filter((x) => x.outcome === 'sent').length === 5, JSON.stringify(a.alerts(1).map((x) => [x.tmdb_id, x.outcome])));
  void before;
});

await S.step('Wednesday 11:30 to 12:45: Last chance', async () => {
  await A.jump(L('2026-09-23T11:30:00'));
  const st = A.q1("SELECT id FROM showtimes WHERE tmdb_id = ? AND theatre_id = '9101' AND start_local LIKE '2026-09-23T19:30%'", K(1).id);
  const p = await a.api(OWNER, 'PUT', '/api/plans', { showtime_id: st?.id });
  if (p.status !== 200) throw new Error(`plan ${p.status} ${p.text}`);
  const n0 = a.pushes('owner').length;
  A.amc.until.set(K(1).amcId, '2026-09-24');
  await a.refresh();
  S.check('skip: a film with a live I\'m going plan entering Last chance sends nothing', a.pushes('owner').length === n0 && a.presence(1, 1)?.in_last === 1, `pushes +${a.pushes('owner').length - n0}, in_last ${a.presence(1, 1)?.in_last}`);

  await A.jump(L('2026-09-23T12:00:00'));
  await a.setSwitch(R, true);
  A.amc.until.delete(K(1).amcId);
  A.amc.until.set(K(2).amcId, '2026-09-24');
  const r0 = a.pushes('robin').length; const c0 = a.pushes('casey').length;
  await a.refresh();
  await until(() => a.pushes('owner').length > n0 && a.pushes('robin').length > r0, 8000);
  await a.settle();
  const o = a.pushes('owner').slice(n0);
  S.check('last: entering Last chance sends one "Last week for Northern Signal at Maple Grove"', o.length === 1 && o[0].msg?.title === `Last week for ${K(2).title} at Maple Grove` && o[0].msg?.url === `/#/movie/${K(2).id}`, JSON.stringify(o.map((h) => h.msg)));
  const r = a.pushes('robin').slice(r0);
  S.check('privacy: the 700-rating friend gets their own, at their theater', r.length === 1 && r[0].msg?.title === `Last week for ${K(2).title} at Maple Grove`, JSON.stringify(r.map((h) => h.msg)));
  const c = a.pushes('casey').slice(c0);
  S.check('last: the second friend\'s names their own first theater (Riverside)', c.length === 1 && c[0].msg?.title === `Last week for ${K(2).title} at Riverside`, JSON.stringify(c.map((h) => h.msg)));

  const all0 = a.pushes().length;
  await A.jump(L('2026-09-23T12:15:00'));
  await a.refresh();
  S.check('last: still in Last chance at the next refresh: nothing more', a.pushes().length === all0 && a.presence(1, 2)?.in_last === 1);
  await A.jump(L('2026-09-23T12:30:00'));
  A.amc.until.delete(K(2).amcId);
  await a.refresh();
  const outOf = a.presence(1, 2)?.in_last === 0;
  await A.jump(L('2026-09-23T12:45:00'));
  A.amc.until.set(K(2).amcId, '2026-09-24');
  await a.refresh();
  S.check('last: out of Last chance and back in, the same run: nothing more', outOf && a.presence(1, 2)?.in_last === 1 && a.pushes().length === all0, `out ${outOf} in ${a.presence(1, 2)?.in_last} +${a.pushes().length - all0}`);
});

await S.step('Wednesday 12:50: a theater the friend just followed', async () => {
  await A.jump(L('2026-09-23T12:50:00'));
  await a.watch(R, 5); note('robin', 5);
  const f = await a.api(R, 'POST', '/api/theatres/follow', { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8' });
  if (f.status !== 200) throw new Error(`follow ${f.status} ${f.text}`);
  const r0 = a.pushes('robin').length;
  await a.refresh();
  const scanned = JSON.parse(A.q1('SELECT theatres FROM watch_scan WHERE user_id = ?', R.id)?.theatres || '[]');
  S.check('now: a film only at a theater the person just followed isn\'t new to them', a.pushes('robin').length === r0 && !a.alerts(R.id).some((x) => x.tmdb_id === K(5).id) && Boolean(a.presence(R.id, 5)) && scanned.includes('9102'), `+${a.pushes('robin').length - r0} scanned ${scanned}`);
});

await S.step('a film away 5 days, and one away 15 days', async () => {
  await A.jump(L('2026-09-23T13:00:00'));
  A.amc.until.delete(K(2).amcId);
  A.amc.gone.add(K(5).amcId); A.amc.gone.add(K(3).amcId);
  await a.refresh();
  const since3 = a.presence(1, 3)?.since;
  S.check('return: both are marked gone from every theater of theirs', Boolean(a.presence(1, 5)?.gone_since) && Boolean(a.presence(1, 3)?.gone_since) && Boolean(a.presence(Ca.id, 5)?.gone_since));

  A.amc.gone.delete(K(3).amcId);
  A.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
  const n0 = a.pushes().length;
  await A.jump(L('2026-09-28T10:00:00'));
  if (!await a.settledOn('2026-09-28')) throw new Error('Monday\'s refresh did not run');
  await a.settle();
  const mon = a.pushes().slice(n0);
  S.check('return: back after 5 days sends nothing', !mon.some((h) => named(h).includes(3)) && a.presence(1, 3)?.gone_since == null && a.presence(1, 3)?.since === since3, JSON.stringify(mon.map((h) => h.msg)));

  A.amc.shift = 15;
  A.amc.gone.delete(K(5).amcId);
  A.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
  const o0 = a.pushes('owner').length; const c0 = a.pushes('casey').length; const r0 = a.pushes('robin').length;
  await A.jump(L('2026-10-08T10:00:00'));
  if (!await a.settledOn('2026-10-08')) throw new Error('the 10-08 refresh did not run');
  await until(() => a.pushes('owner').length > o0, 8000);
  await a.settle();
  const o = a.pushes('owner').slice(o0);
  S.check('return: back after 15 days alerts once more', o.length === 1 && o[0].msg?.title === `${K(5).title} is now showing at Riverside`, JSON.stringify(o.map((h) => h.msg)));
  const c = a.pushes('casey').slice(c0); const r = a.pushes('robin').slice(r0);
  S.check('return: so does everyone else who watchlisted it at that theater', c.length === 1 && r.length === 1 && c[0].msg?.title === o[0]?.msg?.title && r[0].msg?.title === o[0]?.msg?.title, JSON.stringify([...c, ...r].map((h) => h.msg)));
  await a.settle(); await a.settle();
  S.check('restart: more ticks send nothing twice', a.pushes('owner').length === o0 + 1);
});

await S.step('world A: privacy', async () => {
  const pushes = a.pushes();
  allPushes.push(...pushes.map((h) => ({ ...h, world: 'a' })));
  S.check('privacy: pushes went only to the three people with devices', pushes.every((h) => ['owner', 'robin', 'casey'].includes(h.name)), [...new Set(pushes.map((h) => h.name))].join());
  const rows = A.q('SELECT a.user_id, a.tmdb_id FROM watch_alerts a LEFT JOIN watchlist w ON w.user_id = a.user_id AND w.tmdb_id = a.tmdb_id WHERE w.tmdb_id IS NULL');
  S.check('privacy: every alert row is for a film on that person\'s own watchlist', rows.length === 0, JSON.stringify(rows));
});
await A.close();

// ================================================================== world B
const B = S.world(await makeWorld('alerts-b'));
const b = helpers(B);
const { robin: RB, casey: CB } = B.friends;

await S.step('world B, Wednesday 10:00: switches, devices, watchlists', async () => {
  for (const f of NEW) B.amc.gone.add(f.amcId);
  for (const [who, as] of [['owner', OWNER], ['robin', RB], ['casey', CB]]) {
    await b.setSwitch(as, true);
    const r = await b.api(as, 'POST', '/api/push/subscribe', { subscription: B.push.newSub(who) });
    if (r.status !== 200) throw new Error(`subscribe ${who}: ${r.status}`);
  }
  for (const k of [3, 6, 8, 9, 12]) await b.watch(OWNER, k);
  await b.watch(RB, 3);
  await b.watch(CB, 5);
  for (const [who, ks] of [['owner', [2, 3, 6, 8, 9, 12]], ['robin', [4, 3]], ['casey', [5]]]) watchlists.set(`b:${who}`, new Set(ks));
  await b.refresh();
});

let before;
await S.step('world B: found at 10 PM, held until 9 AM, through a restart', async () => {
  await B.jump(L('2026-09-23T22:00:00'));
  for (const f of NEW) B.amc.gone.delete(f.amcId);
  await b.refresh();
  await b.settle();
  const due = Date.parse(L('2026-09-24T09:00:00'));
  const rows = B.q('SELECT user_id, tmdb_id, due_at, done_at FROM watch_alerts ORDER BY id');
  S.check('hold: found at 10 PM, each alert is due at 9 AM Indianapolis time', rows.length === 7 && rows.every((r) => r.due_at === due && r.done_at == null), JSON.stringify(rows.map((r) => [r.user_id, r.tmdb_id, new Date(r.due_at).toISOString()])));
  S.check('hold: nothing is sent at 10 PM', b.pushes().length === 0, JSON.stringify(b.pushes().map((h) => h.msg)));

  await B.jump(L('2026-09-23T22:30:00'));
  await b.watch(OWNER, 6); // off the watchlist
  await b.api(OWNER, 'POST', '/api/ratings', { tmdb_id: K(9).id, rating: 3.5, title: K(9).title, year: K(9).year });
  await b.api(OWNER, 'POST', '/api/watched', { tmdb_id: K(8).id, title: K(8).title });
  await b.setSwitch(CB, false);
  await b.settle();
  S.check('hold: still nothing at 10:30 PM', b.pushes().length === 0);

  // A restart between the refresh and the send; no refresh runs from here on.
  await B.restart({ fakeNow: L('2026-09-24T02:00:00'), env: { RP_DISABLE_REFRESH: '1' } });
  await b.settle();
  await B.jump(L('2026-09-24T08:59:00'));
  await b.settle();
  S.check('hold: nothing at 2 AM or 8:59 AM, across the restart', b.pushes().length === 0, JSON.stringify(b.pushes().map((h) => h.msg)));
  before = {};
  for (const [k, as] of Object.entries({ owner: OWNER, robin: RB, casey: CB, jordan: B.friends.jordan, guest: GUEST })) before[k] = await b.recsOf(as);
});

await S.step('world B: 9 AM', async () => {
  await B.jump(L('2026-09-24T09:00:20'));
  await until(() => b.pushes('owner').length >= 1 && b.pushes('robin').length >= 1, 8000);
  await b.settle();
  const o = b.pushes('owner');
  S.check('hold: at 9 AM the owner gets one push', o.length === 1, JSON.stringify(o.map((h) => h.msg)));
  S.check('restart: what the restart interrupted is sent once, after it', o.length === 1 && b.pushes('robin').length === 1);
  const names = named(o[0] || {});
  S.check('group: the two left are one push, "2 films from your watchlist are now showing", opening Watchlist', o[0]?.msg?.title === '2 films from your watchlist are now showing' && names.sort().join() === '12,3' && o[0]?.msg?.url === '/#/watchlist' && /^(Velvet Harbor and Scarlet Engine|Scarlet Engine and Velvet Harbor)$/.test(o[0]?.msg?.body || ''), JSON.stringify(o.map((h) => h.msg)));
  const out = Object.fromEntries(B.q('SELECT tmdb_id, outcome FROM watch_alerts WHERE user_id = 1').map((r) => [r.tmdb_id, r.outcome]));
  S.check('skip: taken off the watchlist before the send: no alert', out[K(6).id] === 'dropped: off watchlist' && !names.includes(6), JSON.stringify(out));
  S.check('skip: rated while its alert waited (still on the watchlist): no alert', out[K(9).id] === 'dropped: rated' && !names.includes(9) && Boolean(B.q1('SELECT 1 AS x FROM watchlist WHERE user_id = 1 AND tmdb_id = ?', K(9).id)), JSON.stringify(out));
  S.check('skip: marked seen while it waited (still on the watchlist): no alert', out[K(8).id] === 'dropped: seen' && !names.includes(8) && Boolean(B.q1('SELECT 1 AS x FROM watchlist WHERE user_id = 1 AND tmdb_id = ?', K(8).id)), JSON.stringify(out));
  const cas = B.q('SELECT outcome FROM watch_alerts WHERE user_id = ?', CB.id);
  S.check('skip: the switch turned off while it waited: no alert', cas.length === 1 && cas[0].outcome === 'dropped: switch off' && b.pushes('casey').length === 0, JSON.stringify(cas));
  const r = b.pushes('robin');
  S.check('privacy: the 700-rating friend\'s one film, one push, opening it', r.length === 1 && r[0].msg?.title === `${K(3).title} is now showing at Maple Grove` && r[0].msg?.url === `/#/movie/${K(3).id}`, JSON.stringify(r.map((h) => h.msg)));

  const after = {};
  for (const [k, as] of Object.entries({ owner: OWNER, robin: RB, casey: CB, jordan: B.friends.jordan, guest: GUEST })) after[k] = await b.recsOf(as);
  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  S.check('picks: every role\'s scores, picks and weekly four are the same before and after the alerts went out', !moved.length, moved.join(', '));
});

await S.step('world B: never twice', async () => {
  const n = b.pushes().length;
  await b.settle(); await b.settle();
  await B.restart({ fakeNow: L('2026-09-24T09:10:00'), env: { RP_DISABLE_REFRESH: '1' } });
  await b.settle(); await b.settle();
  S.check('restart: later ticks and another restart send nothing again', b.pushes().length === n && B.q('SELECT COUNT(*) n FROM watch_alerts WHERE done_at IS NULL')[0].n === 0, `+${b.pushes().length - n}`);
  allPushes.push(...b.pushes().map((h) => ({ ...h, world: 'b' })));
});
await B.close();

// ================================================================== both
await S.step('privacy and picks across both worlds', async () => {
  const leaks = allPushes.filter((h) => NAMES.some((n) => `${h.msg?.title} ${h.msg?.body} ${h.msg?.url}`.includes(n)));
  S.check('privacy: no push names a person', allPushes.length >= 10 && !leaks.length, `${allPushes.length} pushes; ${JSON.stringify(leaks.map((h) => h.msg))}`);
  const foreign = allPushes.filter((h) => named(h).some((k) => !watchlists.get(`${h.world}:${h.name}`)?.has(k)));
  S.check('privacy: every film a push names is on that person\'s own watchlist', !foreign.length, JSON.stringify(foreign.map((h) => [h.name, h.msg?.title])));

  const src = fs.readFileSync(path.join(REPO, 'server/lib/watchalerts.js'), 'utf8');
  const writes = [...src.matchAll(/\brun\(\s*[`'"]([\s\S]*?)[`'"]\s*,/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  const other = writes.filter((sql) => !/^(INSERT INTO|UPDATE|DELETE FROM) watch_(presence|scan|alerts)\b/.test(sql));
  const rec = fs.readFileSync(path.join(REPO, 'server/lib/recommend.js'), 'utf8');
  const lcBody = rec.slice(rec.indexOf('export function lastChanceNow'), rec.indexOf('\n}\n', rec.indexOf('export function lastChanceNow')));
  S.check('picks: the alert code writes only its own tables and reads Last chance without locking or logging picks', writes.length >= 8 && !other.length && !/lock\.js|getRecommendations|createLock|saveLock|weekly4_/.test(src) && lcBody.length > 50 && !/weeklyFour|createLock|saveLock|\brun\(/.test(lcBody), `${writes.length} writes; other: ${other.join(' | ')}`);
});

S.finish();
