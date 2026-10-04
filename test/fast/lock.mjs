// The weekly lock, its log and the Friday push (old D1, D2, D3 g-lock), on a
// mocked clock with the made-up AMC, TMDB, OMDb and push service. Roles: the
// owner, the 700-rating friend, the brand-new friend and the guest.
//
// Timeline: Thu 09-24 (last week's four is each user's lock) -> Fri 09-25
// 00:00 with AMC held, so the first refresh can't finish (last week's four
// shows, nothing is logged for the new week, no push) -> the refresh finishes
// (every four locks, each equal to the live ranking's top four at that moment)
// -> Friday push naming each user's locked #1 -> Sat: a film's score rises past
// the four (it stays out), a rating, Not for me and its undo, Mark seen ->
// Sun: a film leaves the theaters -> Mon: the thin film earns a score (one
// swap, tagged New this week) -> Tue: a second thin film earns a score (no
// second swap, no push) -> Fri 10-02: last week's four until the refresh,
// then a new lock and one new push.
//
// Then, in a second world, the AMC retry (old D4 g-retry).
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('lock');
const SWAP_MARGIN = 5;
const THIN = 990006; // Crimson Station: 12 TMDB votes, no OMDb record
const THIN2 = 990011; // Wild Letter: no votes, no OMDb record
const local = (s) => `${s}-04:00`;
const day = (iso) => (iso ? C.ymdLocal(new Date(iso)) : null);
const ids = (list) => (list || []).map((e) => e.tmdb_id);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const replaced = (four, gone, fill) => four.map((x) => (x === gone ? fill : x));
const eligible = (r) => (r.list || []).filter((e) => !e.flags.seen && !e.flags.excluded && !e.flags.hidden);

const w = S.world(await openWorld('lock', { refresh: true, push: true, env: { RP_TIMER_SCALE: '0.002' } }));
// The guest link has no lock: its four is the top four by public score
// (lib/recommend.js), whatever anyone's lock says.
const publicFour = (r) => {
  const s = (e) => (e.final == null ? -1 : e.final);
  return eq(ids(r.weekly4), ids(r.list.slice(0, 4))) && r.list.every((e, i) => !i || s(r.list[i - 1]) >= s(e)) && !r.weekly4.some((e) => e.pick) && !('lock' in r);
};
const roles = { owner: { id: 1, as: null }, robin: { id: w.friends.robin.id, as: w.friends.robin }, jordan: { id: w.friends.jordan.id, as: w.friends.jordan }, guest: { id: null, as: GUEST } };
const USERS = ['owner', 'robin', 'jordan'];
const recs = async (role) => (await w.api('GET', '/api/recommendations', { as: roles[role].as })).json;
const status = async () => (await w.api('GET', '/api/status')).json;
const settledOn = (d, ms = 30000) => until(async () => { const s = await status(); return s && !s.refreshing && day(s.lastRefresh) === d && s; }, ms, 100);
const idle = () => until(async () => { const s = await status(); return s && !s.refreshing; }, 30000, 100);
const lockRow = (uid, week) => {
  const r = w.q1('SELECT * FROM weekly4_lock WHERE user_id = ? AND week_start = ?', uid, week);
  if (!r) return null;
  const slots = JSON.parse(r.picks).map((x) => (Array.isArray(x) ? x : [x]));
  return { ...r, slots, picks: slots.map((x) => x[0]), all: slots.flat() };
};
const logRows = (uid, week) => w.q('SELECT tmdb_id, rank, first_seen_at FROM weekly4_log WHERE user_id = ? AND week_start = ? ORDER BY first_seen_at, rank', uid, week);
const tableSig = () => JSON.stringify([w.q('SELECT * FROM weekly4_lock ORDER BY user_id, week_start'), w.q('SELECT * FROM weekly4_log ORDER BY user_id, week_start, tmdb_id')]);
const weekly = (name) => w.push.hits.filter((h) => h.name === name && h.topic === 'weekly-picks');
const jump = (s) => w.jump(local(s));

await S.step('Thursday: last week\'s four is each user\'s lock', async () => {
  for (const r of USERS) {
    const res = await w.api('POST', '/api/push/subscribe', { as: roles[r].as, body: { subscription: w.push.newSub(r) } });
    S.check(`setup: ${r} subscribed to the weekly push`, res.status === 200, `${res.status} ${res.text.slice(0, 80)}`);
  }
  await jump('2026-09-24T10:00:00');
  S.check('Thursday: the day\'s refresh ran', Boolean(await settledOn('2026-09-24')));
  const thu = {};
  for (const r of USERS) thu[r] = await recs(r);
  const prev = Object.fromEntries(USERS.map((r) => [r, lockRow(roles[r].id, '2026-09-18')]));
  S.check('Thursday: every user has a lock for the week that began 09-18', USERS.every((r) => prev[r]?.picks.length === 4), USERS.map((r) => `${r}:${prev[r]?.picks.length}`).join(' '));
  S.check('Thursday: each four shown is that user\'s lock', USERS.every((r) => eq(ids(thu[r].weekly4), prev[r].picks.map((p) => p.tmdb_id))));
  S.check('setup: the thin film has no score and is outside every four', USERS.every((r) => thu[r].list.find((e) => e.tmdb_id === THIN)?.flags.noScores && !ids(thu[r].weekly4).includes(THIN)));
});

let lockAt; let fri;
await S.step('Friday 00:00: the first refresh is held', async () => {
  w.amc.mode = 'hold';
  await jump('2026-09-25T00:00:30');
  S.check('Friday 00:00: the first refresh has started and waits on AMC', Boolean(await until(() => w.amc.held.length > 0, 20000)));
  const pre = {};
  for (const r of Object.keys(roles)) pre[r] = await recs(r);
  const prev = Object.fromEntries(USERS.map((r) => [r, lockRow(roles[r].id, '2026-09-18')]));
  S.check('Friday before the first refresh: every user still sees last week\'s four, marked pending', USERS.every((r) => eq(ids(pre[r].weekly4), prev[r].picks.map((p) => p.tmdb_id)) && pre[r].lock?.pending === true),
    USERS.map((r) => `${r}:${ids(pre[r].weekly4).join(',')} pending=${pre[r].lock?.pending}`).join(' '));
  S.check('Friday before the first refresh: the guest sees the top four by public score, not the owner\'s lock', publicFour(pre.guest), ids(pre.guest.weekly4).join(','));
  S.check('Friday before the first refresh: no lock exists for the new week', w.q1("SELECT COUNT(*) n FROM weekly4_lock WHERE week_start = '2026-09-25'").n === 0);
  S.check('log: nothing is logged under the new week before its four lock (Picks opened by everyone)', w.q1("SELECT COUNT(*) n FROM weekly4_log WHERE week_start = '2026-09-25'").n === 0);
  S.check('push: no weekly push before the four lock', w.push.hits.filter((h) => h.topic === 'weekly-picks').length === 0, `${w.push.hits.length} pushes`);

  w.amc.mode = 'ok'; w.amc.release();
  S.check('Friday: the first refresh finished', Boolean(await settledOn('2026-09-25')));
  await until(() => USERS.every((r) => lockRow(roles[r].id, '2026-09-25')), 10000);
  lockAt = Object.fromEntries(USERS.map((r) => [r, lockRow(roles[r].id, '2026-09-25')]));
  S.check('Friday: each user\'s four locked at the first refresh', USERS.every((r) => lockAt[r]?.picks.length === 4 && lockAt[r].how === 'refresh'), USERS.map((r) => `${r}:${lockAt[r]?.how}/${lockAt[r]?.picks.length}`).join(' '));
  fri = {};
  for (const r of Object.keys(roles)) fri[r] = await recs(r);
  for (const r of USERS) {
    S.check(`Friday: ${r}'s locked four is the live ranking's top four at the lock`, eq(lockAt[r].picks.map((p) => p.tmdb_id), ids(eligible(fri[r]).slice(0, 4))),
      `lock ${lockAt[r].picks.map((p) => p.tmdb_id).join(',')} top ${ids(eligible(fri[r]).slice(0, 4)).join(',')}`);
    S.check(`Friday: ${r} sees the locked four`, eq(ids(fri[r].weekly4), lockAt[r].picks.map((p) => p.tmdb_id)));
    const lg = logRows(roles[r].id, '2026-09-25');
    S.check(`log: ${r}'s log for the new week is exactly the locked four, written at the lock`, eq(lg.map((x) => x.tmdb_id).sort(), lockAt[r].picks.map((p) => p.tmdb_id).sort()) && lg.every((x) => x.first_seen_at === lockAt[r].locked_at), `${lg.length} rows`);
  }
  S.check('Friday: the guest sees the top four by public score, not the owner\'s lock', publicFour(fri.guest), ids(fri.guest.weekly4).join(','));
  S.check('Friday: no pick is tagged New this week at the lock', Object.values(fri).every((x) => x.weekly4.every((e) => !e.pick?.newThisWeek)));
  const pushed = await until(() => USERS.every((n) => weekly(n).length >= 1), 15000);
  for (const r of USERS) {
    const hits = weekly(r);
    const top = fri[r].weekly4[0]?.title;
    S.check(`push: the Friday push to ${r} names the locked #1`, Boolean(pushed) && hits.length === 1 && hits[0].msg?.body === `#1 is ${top}`, JSON.stringify(hits.map((h) => h.msg?.body)));
  }
});

await S.step('Friday noon: a film whose reviews jump stays out of the four', async () => {
  // Same day, so no film has left the theaters since the lock; over 12 hours
  // after the last OMDb fetch, so a refresh asks OMDb again.
  await jump('2026-09-25T13:00:00');
  const f0 = await recs('owner');
  const drifter = eligible(f0).find((e) => !ids(f0.weekly4).includes(e.tmdb_id) && !e.flags.noScores && e.tmdb_id > 990000 && e.tmdb_id < 991000);
  if (drifter) w.ctrl.omdb[drifter.tmdb_id] = { imdb: 9.4, rt: 100, meta: 99 };
  w.writeCtrl();
  await sleep(100);
  await w.api('POST', '/api/refresh');
  await sleep(300); await idle();
  const f1 = await recs('owner');
  const rank = eligible(f1).findIndex((e) => e.tmdb_id === drifter?.tmdb_id);
  S.check('Friday: a film whose score rose past the four (not a thin film) stays out of it', Boolean(drifter) && rank >= 0 && rank < 4 && eq(ids(f1.weekly4), ids(f0.weekly4)),
    `drifter ${drifter?.tmdb_id} rank ${rank + 1}, four ${ids(f0.weekly4).join(',')} -> ${ids(f1.weekly4).join(',')}`);
  if (drifter) delete w.ctrl.omdb[drifter.tmdb_id];
  w.writeCtrl();
});

await S.step('Saturday: the four holds; a rating, Not for me and Mark seen each refill one place', async () => {
  await jump('2026-09-26T12:00:00');
  S.check('Saturday: the day\'s refresh ran', Boolean(await settledOn('2026-09-26')));
  const sat0 = await recs('owner');
  const o0 = ids(sat0.weekly4);
  const rated = sat0.weekly4[1];
  await w.api('POST', '/api/ratings', { body: { tmdb_id: rated.tmdb_id, rating: 4, title: rated.title, year: rated.year } });
  const sat1 = await recs('owner');
  const fill = eligible(sat1).find((e) => !o0.includes(e.tmdb_id));
  S.check('Saturday: the owner rates #2; it leaves, the others keep their places and the next best takes #2',
    eq(ids(sat1.weekly4), replaced(o0, rated.tmdb_id, fill?.tmdb_id)) && sat1.weekly4[1]?.pick?.via === 'refill' && !sat1.weekly4[1]?.pick?.newThisWeek, `${o0.join(',')} -> ${ids(sat1.weekly4).join(',')} (fill ${fill?.tmdb_id})`);
  S.check('log: the film that filled the place is logged under this week', logRows(1, '2026-09-25').some((x) => x.tmdb_id === fill?.tmdb_id));

  const r0 = await recs('robin');
  const hid = r0.weekly4[0];
  await w.api('POST', '/api/hidden', { as: roles.robin.as, body: { tmdb_id: hid.tmdb_id, title: hid.title } });
  const r1 = await recs('robin');
  const rFill = eligible(r1).find((e) => !ids(r0.weekly4).includes(e.tmdb_id));
  S.check('Saturday: the 700-rating friend taps Not for me on #1; it leaves and the next best takes #1', eq(ids(r1.weekly4), replaced(ids(r0.weekly4), hid.tmdb_id, rFill?.tmdb_id)), `${ids(r0.weekly4).join(',')} -> ${ids(r1.weekly4).join(',')}`);
  await w.api('DELETE', `/api/hidden/${hid.tmdb_id}`, { as: roles.robin.as });
  const r2 = await recs('robin');
  S.check('Saturday: undoing Not for me puts #1 back in its place', eq(ids(r2.weekly4), ids(r0.weekly4)), `${ids(r1.weekly4).join(',')} -> ${ids(r2.weekly4).join(',')}`);
  await w.api('POST', '/api/hidden', { as: roles.robin.as, body: { tmdb_id: hid.tmdb_id, title: hid.title } });
  S.check('Saturday: hiding it again brings back the same film that filled in', eq(ids((await recs('robin')).weekly4), ids(r1.weekly4)));

  const j0 = await recs('jordan');
  const seen = j0.weekly4[2];
  const ws = await w.api('POST', '/api/watched', { as: roles.jordan.as, body: { tmdb_id: seen.tmdb_id, title: seen.title } });
  const j1 = await recs('jordan');
  const jFill = eligible(j1).find((e) => !ids(j0.weekly4).includes(e.tmdb_id) && e.tmdb_id !== seen.tmdb_id);
  S.check('Saturday: the new friend marks #3 seen; it leaves and the next best takes #3', ws.status === 200 && eq(ids(j1.weekly4), replaced(ids(j0.weekly4), seen.tmdb_id, jFill?.tmdb_id)), `${ids(j0.weekly4).join(',')} -> ${ids(j1.weekly4).join(',')}`);
  S.check('log: the seen film counts as a pick (in_weekly4 read from the log)', w.q1('SELECT in_weekly4 FROM watched WHERE user_id = ? AND tmdb_id = ?', roles.jordan.id, seen.tmdb_id)?.in_weekly4 === 1);

  const again = await recs('owner');
  await w.api('POST', '/api/refresh');
  await sleep(300); await idle();
  const again2 = await recs('owner');
  S.check('Saturday: repeat views and a manual refresh leave the four as it is', eq(ids(again.weekly4), ids(sat1.weekly4)) && eq(ids(again2.weekly4), ids(sat1.weekly4)));
  const sig = tableSig();
  const g1 = await recs('guest');
  S.check('Saturday: the guest sees the top four by public score, not the owner\'s four', publicFour(g1), ids(g1.weekly4).join(','));
  S.check('log: guest views write nothing (lock and log unchanged)', tableSig() === sig);
});

await S.step('Sunday: a film leaves the theaters', async () => {
  const sun0 = {};
  for (const r of USERS) sun0[r] = await recs(r);
  // A film in the owner's four but not the 700-rating friend's, so her four
  // keeps its thin-film candidates for Monday.
  const leaving = (sun0.owner.weekly4.find((e) => !ids(sun0.robin.weekly4).includes(e.tmdb_id)) || sun0.owner.weekly4[0]).tmdb_id;
  const film = C.film(leaving);
  w.amc.gone.add(film.amcId);
  w.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
  await jump('2026-09-27T00:30:00');
  S.check('Sunday: the day\'s refresh ran', Boolean(await settledOn('2026-09-27')));
  const sun1 = {};
  for (const r of USERS) sun1[r] = await recs(r);
  const detail = [];
  const ok = USERS.every((r) => {
    const had = ids(sun0[r].weekly4);
    const now = ids(sun1[r].weekly4);
    detail.push(`${r}: ${had.join(',')} -> ${now.join(',')}`);
    // Every film still in the four has showtimes left; the film AMC dropped is out.
    const playing = new Set(ids(sun1[r].list));
    return !now.includes(leaving) && now.every((id) => playing.has(id)) && had.filter((id) => playing.has(id) && id !== leaving).every((id) => now.indexOf(id) === had.indexOf(id));
  });
  S.check('Sunday: a film with no showtimes left leaves every four it was in; the others keep their places', ok, detail.join(' | '));
  const fills = USERS.every((r) => {
    const had = ids(sun0[r].weekly4);
    if (!had.includes(leaving)) return true;
    const seenWeek = new Set(w.q("SELECT tmdb_id FROM watched WHERE user_id = ? AND watched_date >= '2026-09-25'", roles[r].id).map((x) => x.tmdb_id));
    const expect = eligible(sun1[r]).find((e) => !had.includes(e.tmdb_id) && !seenWeek.has(e.tmdb_id));
    return ids(sun1[r].weekly4)[had.indexOf(leaving)] === expect?.tmdb_id;
  });
  S.check('Sunday: the next best film by current score takes the place it left', fills);
});

let mon1;
await S.step('Monday: the thin film earns a score and swaps in once', async () => {
  const mon0 = {};
  for (const r of USERS) mon0[r] = await recs(r);
  w.ctrl.omdb[THIN] = { imdb: 9.5, rt: 100, meta: 99 };
  await jump('2026-09-28T00:30:00');
  S.check('Monday: the day\'s refresh ran', Boolean(await settledOn('2026-09-28')));
  mon1 = {};
  for (const r of USERS) mon1[r] = await recs(r);
  for (const r of USERS) {
    const before = mon0[r].weekly4; const after = mon1[r].weekly4;
    const t = mon1[r].list.find((e) => e.tmdb_id === THIN);
    const fourth = mon1[r].list.find((e) => e.tmdb_id === before[3]?.tmdb_id);
    const beats = t && !t.flags.noScores && fourth && t.final - fourth.final >= SWAP_MARGIN;
    const swapped = eq(ids(after), [...ids(before).slice(0, 3), THIN]);
    S.check(`Monday: ${r}: the thin film replaces #4, tagged New this week, exactly when it beats #4 by ${SWAP_MARGIN}+`,
      beats ? (swapped && after[3].pick?.via === 'swap' && after[3].pick?.newThisWeek === true && after.slice(0, 3).every((e) => !e.pick?.newThisWeek)) : eq(ids(after), ids(before)),
      `${t?.final} vs #4 ${fourth?.final}: ${ids(before).join(',')} -> ${ids(after).join(',')}`);
  }
  const swapped = USERS.filter((r) => mon1[r].weekly4[3]?.tmdb_id === THIN && mon1[r].weekly4[3]?.pick?.via === 'swap');
  S.check('Monday: at least one user\'s four got the swap (the test reached the rule)', swapped.length > 0, USERS.map((r) => `${r}:${ids(mon1[r].weekly4).join(',')}`).join(' '));
  const g = await recs('guest');
  S.check('Monday: the guest sees the top four by public score, with no swap and no tag', publicFour(g), ids(g.weekly4).join(','));
  S.check('log: the swapped-in film is logged under this week for each user who got it', swapped.every((r) => logRows(roles[r].id, '2026-09-25').some((x) => x.tmdb_id === THIN)));
});

await S.step('Monday noon: a second thin film earns a score; no second swap', async () => {
  // Same day as the swap, so no film has left the theaters since; over 12
  // hours after the last OMDb fetch, so the refresh asks OMDb again.
  w.ctrl.omdb[THIN] = { imdb: 3.1, rt: 8, meta: 12 };
  w.ctrl.omdb[THIN2] = { imdb: 9.6, rt: 100, meta: 100 };
  await jump('2026-09-28T13:00:00');
  await w.api('POST', '/api/refresh');
  await sleep(300); await idle();
  const tue = {};
  for (const r of USERS) tue[r] = await recs(r);
  for (const r of USERS) {
    const second = tue[r].list.find((e) => e.tmdb_id === THIN2);
    const had = mon1[r].weekly4.some((e) => e.pick?.via === 'swap');
    const firstSwap = !had && eq(ids(tue[r].weekly4), [...ids(mon1[r].weekly4).slice(0, 3), THIN2]) && tue[r].weekly4[3]?.pick?.via === 'swap';
    S.check(`Monday noon: ${r}: ${had ? 'having used the week\'s swap, the four is unchanged' : 'the four is unchanged or takes the second thin film as its first swap'}`,
      eq(ids(tue[r].weekly4), ids(mon1[r].weekly4)) || firstSwap,
      `${second ? `scores ${second.final}` : 'not listed'}; four ${ids(mon1[r].weekly4).join(',')} -> ${ids(tue[r].weekly4).join(',')}`);
    S.check(`Monday noon: ${r}: the swapped-in film keeps its place when its reviews cool`, !ids(mon1[r].weekly4).includes(THIN) || ids(tue[r].weekly4).includes(THIN));
  }
  const tested = USERS.filter((r) => mon1[r].weekly4.some((e) => e.pick?.via === 'swap')).filter((r) => {
    const second = tue[r].list.find((e) => e.tmdb_id === THIN2);
    const fourth = tue[r].list.find((e) => e.tmdb_id === tue[r].weekly4[3]?.tmdb_id);
    return second && !second.flags.noScores && fourth && !ids(tue[r].weekly4).includes(THIN2) && second.final - fourth.final >= SWAP_MARGIN;
  });
  S.check('Monday noon: for a user who already swapped, the second thin film beats #4 by 5+ (the one-swap rule was tested)', tested.length > 0, USERS.map((r) => `${r}: ${tue[r].list.find((e) => e.tmdb_id === THIN2)?.final} vs #4 ${tue[r].list.find((e) => e.tmdb_id === tue[r].weekly4[3]?.tmdb_id)?.final}`).join(' | '));
  S.check('at most one swap per user this week', USERS.every((r) => tue[r].weekly4.filter((e) => e.pick?.via === 'swap').length <= 1 && lockRow(roles[r].id, '2026-09-25').all.filter((p) => p.via === 'swap').length <= 1));
  S.check('push: no push for a swap (one weekly push per user this week)', USERS.every((n) => weekly(n).length === 1), USERS.map((n) => weekly(n).length).join(','));
});

await S.step('next Friday: last week\'s four until the refresh, then a new lock', async () => {
  const thu = {};
  await jump('2026-10-01T12:00:00');
  await settledOn('2026-10-01');
  for (const r of USERS) thu[r] = await recs(r);
  w.amc.mode = 'hold';
  await jump('2026-10-02T00:00:30');
  await until(() => w.amc.held.length > 0, 20000);
  const pre = {};
  for (const r of USERS) pre[r] = await recs(r);
  S.check('next Friday before the refresh: last week\'s four (with its swap) still shows, pending', USERS.every((r) => eq(ids(pre[r].weekly4), ids(thu[r].weekly4)) && pre[r].lock?.pending === true));
  S.check('log: nothing logged under 10-02 before its lock', w.q1("SELECT COUNT(*) n FROM weekly4_log WHERE week_start = '2026-10-02'").n === 0);
  w.amc.mode = 'ok'; w.amc.release();
  await settledOn('2026-10-02');
  await until(() => USERS.every((r) => lockRow(roles[r].id, '2026-10-02')), 10000);
  const nf = {};
  for (const r of Object.keys(roles)) nf[r] = await recs(r);
  for (const r of USERS) {
    const l = lockRow(roles[r].id, '2026-10-02');
    S.check(`next Friday: ${r}'s new four locks at the refresh and is the live ranking's top four`, l && l.how === 'refresh' && eq(l.picks.map((p) => p.tmdb_id), ids(eligible(nf[r]).slice(0, 4))) && !l.swapped_at && nf[r].weekly4.every((e) => !e.pick?.newThisWeek),
      `lock ${l?.picks.map((p) => p.tmdb_id).join(',')} top ${ids(eligible(nf[r]).slice(0, 4)).join(',')}`);
    S.check(`log: ${r}'s 10-02 log is the new locked four`, l && eq(logRows(roles[r].id, '2026-10-02').map((x) => x.tmdb_id).sort(), l.picks.map((p) => p.tmdb_id).sort()));
  }
  S.check('next Friday: the guest sees the top four by public score, not the owner\'s new lock', publicFour(nf.guest), ids(nf.guest.weekly4).join(','));
  await until(() => USERS.every((n) => weekly(n).length === 2), 15000);
  for (const r of USERS) {
    const hits = weekly(r);
    S.check(`push: next Friday ${r} gets one push naming the new locked #1`, hits.length === 2 && hits[1].msg?.body === `#1 is ${nf[r].weekly4[0]?.title}`, JSON.stringify(hits.map((h) => h.msg?.body)));
  }
  S.check('refreshes never ran two at once (AMC saw at most one request in flight)', w.amc.maxInflight === 1, `max ${w.amc.maxInflight}`);
  const errs = w.srv.log().split('\n').filter((l) => /\[api error\]|TypeError|ReferenceError|Unhandled/.test(l));
  S.check('no server errors in the log', errs.length === 0, errs.slice(0, 3).join(' | '));
});

await w.close();

// ================================================================= AMC retry (old D4 g-retry)
// A failed AMC day is retried every hour, up to six times, stopping at the
// first success; never two refreshes at once; the retry state survives a
// restart; the owner alert goes out only when all six retries fail; and a
// Friday with no good refresh by the last retry locks the four from the kept
// lineup (and alerts).
const r = S.world(await openWorld('retry', { refresh: true, env: { RP_TIMER_SCALE: '0.002' } }));
let fake = C.T0_MS; let fakeAt = Date.now();
const fakeNow = () => fake + (Date.now() - fakeAt);
const origPush = r.amc.hits.push.bind(r.amc.hits);
r.amc.hits.push = (h) => { h.fake = fakeNow(); return origPush(h); };
async function rjump(s) { await sleep(250); fake = Date.parse(local(s)); fakeAt = Date.now(); await r.jump(local(s)); await sleep(250); }
// A run's requests come within seconds of each other on the server's clock,
// and runs at least 49 minutes apart (each clock jump): the first request of
// each burst stands for its run.
const runsFor = (d) => {
  const hits = r.amc.hits.filter((h) => day(new Date(h.fake).toISOString()) === d).sort((a, b) => a.fake - b.fake);
  return hits.filter((h, i) => i === 0 || h.fake - hits[i - 1].fake > 10 * 60e3);
};
const rq1 = (sql, ...p) => r.q1(sql, ...p);
const rsetting = (k) => { const x = rq1('SELECT value FROM settings WHERE key = ?', k); try { return x ? JSON.parse(x.value) : null; } catch { return x?.value; } };
const ralerts = (d) => r.q("SELECT * FROM owner_alerts WHERE problem = 'refresh' AND kind = 'problem' ORDER BY id").filter((a) => !d || day(a.at) === d);
const rlock = (week) => { const x = rq1('SELECT * FROM weekly4_lock WHERE user_id = 1 AND week_start = ?', week); return x ? { ...x, picks: JSON.parse(x.picks).map((y) => (Array.isArray(y) ? y[0] : y)) } : null; };
const ridle = () => until(async () => { const x = (await r.api('GET', '/api/status')).json; return x && !x.refreshing; }, 30000, 100);
const chain = () => { const c = rsetting('refreshRetry'); return c && { a: c.attempts, next: c.nextAt, done: c.done }; };
async function stepHour(at, d, expect, label) {
  await sleep(200);
  await rjump(at);
  await until(() => runsFor(d).length >= expect, 8000);
  await sleep(300); await ridle();
  return S.check(label, runsFor(d).length === expect, `${runsFor(d).length} runs on ${d}; chain ${JSON.stringify(chain())}`);
}

await S.step('retry: a Thursday where all six retries fail', async () => {
  r.amc.mode = '500';
  fake = Date.parse(local('2026-09-24T10:00:00')); fakeAt = Date.now();
  await r.restart({ fakeNow: local('2026-09-24T10:00:00') });
  await until(() => runsFor('2026-09-24').length >= 1, 20000); await ridle();
  S.check('retry: the startup refresh failed on AMC and started a retry chain, with no alert', runsFor('2026-09-24').length === 1 && rsetting('refreshRetry')?.attempts === 0 && ralerts().length === 0, JSON.stringify(chain()));
  await stepHour('2026-09-24T10:50:00', '2026-09-24', 1, 'retry: none before the hour is up');
  for (let i = 1; i <= 6; i++) {
    await stepHour(`2026-09-24T${String(10 + i).padStart(2, '0')}:01:00`, '2026-09-24', 1 + i, `retry: retry ${i} runs an hour after the last`);
    if (i < 6) S.check(`retry: no alert after retry ${i}`, ralerts().length === 0);
  }
  const starts = runsFor('2026-09-24').map((h) => h.fake);
  S.check('retry: runs are at least an hour apart', starts.slice(1).every((t, i) => t - starts[i] >= 3600e3 - 1000));
  await until(() => ralerts().length >= 1, 5000);
  S.check('retry: one owner alert, sent only after all six retries failed', ralerts().length === 1 && Date.parse(ralerts()[0].at) >= starts[6] - 1000, `${ralerts().length} alert(s)`);
  await stepHour('2026-09-24T17:05:00', '2026-09-24', 7, 'retry: no seventh retry');
  await stepHour('2026-09-24T19:05:00', '2026-09-24', 7, 'retry: still none two hours later');
});

await S.step('retry: a Friday that fails twice, restarts, then succeeds', async () => {
  const prev = rlock('2026-09-18');
  await rjump('2026-09-25T00:00:30');
  await until(() => runsFor('2026-09-25').length >= 1, 20000); await ridle();
  const shown = (await r.api('GET', '/api/recommendations')).json;
  S.check('retry: Friday\'s first refresh failed: no lock for the new week, last week\'s four still shows', !rlock('2026-09-25') && shown.lock?.pending === true && (!prev || eq(ids(shown.weekly4), prev.picks.map((p) => p.tmdb_id))), `pending=${shown.lock?.pending}`);
  await stepHour('2026-09-25T01:01:00', '2026-09-25', 2, 'retry: Friday retry 1 fails');
  await stepHour('2026-09-25T02:01:00', '2026-09-25', 3, 'retry: Friday retry 2 fails');
  const before = runsFor('2026-09-25').length;
  fake = Date.parse(local('2026-09-25T02:30:00')); fakeAt = Date.now();
  await r.restart({ fakeNow: local('2026-09-25T02:30:00') });
  await sleep(2000);
  S.check('retry: a restart mid-chain runs no extra refresh and keeps the chain', runsFor('2026-09-25').length === before && rsetting('refreshRetry')?.attempts === 2, JSON.stringify(chain()));
  await stepHour('2026-09-25T03:01:00', '2026-09-25', 4, 'retry: retry 3 after the restart fails');
  r.amc.mode = 'hold';
  await rjump('2026-09-25T04:01:00');
  await until(() => r.amc.held.length > 0, 8000);
  const manual = await r.api('POST', '/api/refresh');
  S.check('retry: a manual refresh pressed during a retry is queued', manual.json?.queued === true);
  r.amc.mode = 'ok'; r.amc.release();
  await until(() => rlock('2026-09-25'), 20000); await sleep(400); await ridle();
  S.check('retry: retry 4 succeeded: the chain stopped and the four locked', !rsetting('refreshRetry') && rlock('2026-09-25')?.how === 'refresh', JSON.stringify(chain()));
  S.check('retry: no alert on Friday (a retry succeeded)', ralerts('2026-09-25').length === 0);
  const after = runsFor('2026-09-25').length;
  await stepHour('2026-09-25T05:05:00', '2026-09-25', after, 'retry: no more retries after the success');
  await stepHour('2026-09-25T06:05:00', '2026-09-25', after, 'retry: still none an hour later');
  S.check('retry: never two refreshes at once (AMC saw at most one request in flight)', r.amc.maxInflight === 1, `max ${r.amc.maxInflight}`);
});

await S.step('retry: the next Friday fails all day and locks from the kept lineup', async () => {
  r.amc.mode = '500';
  await rjump('2026-10-02T00:00:30');
  await until(() => runsFor('2026-10-02').length >= 1, 20000); await ridle();
  for (let i = 1; i <= 5; i++) await stepHour(`2026-10-02T0${i}:01:00`, '2026-10-02', 1 + i, `retry: 10-02 retry ${i} fails`);
  S.check('retry: before the last retry there is no lock for 10-02 and no alert', !rlock('2026-10-02') && ralerts('2026-10-02').length === 0);
  await stepHour('2026-10-02T06:01:00', '2026-10-02', 7, 'retry: 10-02 retry 6 fails');
  await until(() => rlock('2026-10-02') && ralerts('2026-10-02').length >= 1, 8000);
  const fb = rlock('2026-10-02');
  S.check('retry: after the last retry the four lock from the kept lineup', fb?.how === 'fallback' && fb.picks.length === 4, `how=${fb?.how}`);
  S.check('retry: and the owner gets one alert', ralerts('2026-10-02').length === 1);
  const recs = (await r.api('GET', '/api/recommendations')).json;
  S.check('retry: the fallback four is the live ranking\'s top four from the kept lineup', eq(fb?.picks.map((p) => p.tmdb_id), ids(eligible(recs).slice(0, 4))) && eq(ids(recs.weekly4), fb?.picks.map((p) => p.tmdb_id)),
    `lock ${fb?.picks.map((p) => p.tmdb_id).join(',')} top ${ids(eligible(recs).slice(0, 4)).join(',')}`);
  await stepHour('2026-10-02T07:05:00', '2026-10-02', 7, 'retry: no seventh retry on 10-02');
});

await r.close();
S.finish();
