// "I'm going" plans on a mocked clock (server/lib/plans.js): making, moving
// and cancelling a plan; the reminder push two hours before (none for a plan
// made with less than two hours left, none for someone without push on); the
// next morning's "Did you see it?" push at 10; Yes logging the film seen on
// the showing's own day, counted like Mark seen; No; no answer for three
// days; marking seen or rating elsewhere clearing a plan; a restart between
// plan and reminder; nothing ever sent twice or for a cancelled or moved plan.
// And who sees a plan: the owner sees only opted-in friends', an opted-in
// friend only the owner's, nobody else anybody's, the guest nothing. Plans
// change no score and no pick.
//
// Timeline (America/New_York): Wed 09-23 10:00 plans made -> 10:31 -> 12:11
// -> restart 12:20 -> 16:46 -> 17:01 -> 19:16 -> 21:20 -> Thu 09-24 09:59 ->
// 10:01 questions -> Fri 09-25 10:05 -> Sun 09-27 10:01 the last one lapses.
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until, sleep, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('going');
const w = S.world(await openWorld('going', { push: true, env: { RP_TIMER_SCALE: '0.004' } }));
const OWNER = null;
const { robin: R, casey: K, jordan: J } = w.friends;
const local = (s) => `${s}-04:00`;
const jump = (s) => w.jump(local(s));
const api = (as, m, p, body) => w.api(m, p, { as, body });
const social = async (as) => (await api(as, 'GET', '/api/social')).json;
const P = Object.fromEntries([1, 2, 3, 4].map((k) => [k, C.PLAYING.find((f) => f.k === k)]));
// A showing of film k at theater t on the day `ymd` at HH:MM.
const show = (k, t, ymd, hhmm) => w.q1('SELECT * FROM showtimes WHERE tmdb_id = ? AND theatre_id = ? AND date = ? AND start_local LIKE ?', P[k].id, t, ymd, `%T${hhmm}%`);
const plan = (uid, k) => w.q1('SELECT * FROM plans WHERE user_id = ? AND tmdb_id = ?', uid, P[k].id);
const hits = (name, topic = /^plan-/) => w.push.hits.filter((h) => h.name === name && topic.test(h.topic));
const settle = () => sleep(1500); // six job ticks: long enough to catch a second send
const WED = '2026-09-23';
const recsOf = async (as) => {
  const r = (await api(as, 'GET', '/api/recommendations')).json;
  return JSON.stringify({ four: r.weekly4.map((e) => e.tmdb_id), list: r.list.map((e) => [e.tmdb_id, e.final]), worth: r.worthSeeing.map((e) => e.tmdb_id), near: r.alsoNearby.map((e) => [e.tmdb_id, e.final]) });
};
const ROLES = { owner: OWNER, heavy: R, empty: K, fresh: J, guest: GUEST };
const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(ROLES).map(async ([k, as]) => [k, await recsOf(as)])));

let before;
await S.step('push devices, Together, and the picks before any plan', async () => {
  for (const [who, as] of [['owner', OWNER], ['robin', R], ['casey', K]]) {
    const r = await api(as, 'POST', '/api/push/subscribe', { subscription: w.push.newSub(who) });
    S.check(`setup: ${who} turns push on`, r.status === 200, `${r.status} ${r.text}`);
  }
  S.check('setup: Robin switches Together on', (await api(R, 'PUT', '/api/settings', { watchTogether: true })).status === 200);
  before = await snapshot();
});

// ============================================================ Wed 10:00
await S.step('Wednesday 10:00: plans are made, moved and cancelled', async () => {
  const a = await api(OWNER, 'PUT', '/api/plans', { showtime_id: show(1, '9101', WED, '19:30').id });
  S.check('plan: I\'m going on a showtime makes a plan', a.status === 200 && a.json.plan.tmdb_id === P[1].id && a.json.plan.time === '7:30 PM' && a.json.plan.theatre === 'Maple Grove' && a.json.moved === false, `${a.status} ${a.text.slice(0, 200)}`);
  const b = await api(OWNER, 'PUT', '/api/plans', { showtime_id: show(1, '9101', WED, '21:15').id });
  S.check('plan: another showing of the same film moves the plan', b.status === 200 && b.json.moved === true && b.json.plan.time === '9:15 PM', b.text.slice(0, 200));
  S.check('plan: one plan per person per film', w.q1('SELECT COUNT(*) n FROM plans WHERE user_id = 1 AND tmdb_id = ?', P[1].id).n === 1);
  const p1 = plan(1, 1);
  S.check('plan: the reminder is set for two hours before the new showing', p1.remind_at === p1.start_epoch - 2 * 3600e3 && p1.reminded_at == null, JSON.stringify(p1));
  S.check('plan: the question is set for 10am the next morning, for three days', p1.ask_at === Date.parse(local('2026-09-24T10:00:00')) && p1.expires_at === Date.parse(local('2026-09-27T10:00:00')), `${new Date(p1.ask_at).toISOString()} ${new Date(p1.expires_at).toISOString()}`);

  const c = await api(OWNER, 'PUT', '/api/plans', { showtime_id: show(3, '9101', WED, '11:00').id });
  S.check('plan: a plan with under two hours left gets no reminder', c.status === 200 && plan(1, 3).remind_at == null, JSON.stringify(plan(1, 3)));
  S.check('plan: owner plans Northern Signal at 12:30', (await api(OWNER, 'PUT', '/api/plans', { showtime_id: show(2, '9101', WED, '12:30').id })).status === 200);
  S.check('plan: the heavy friend plans Northern Signal at 7:00 PM', (await api(R, 'PUT', '/api/plans', { showtime_id: show(2, '9101', WED, '19:00').id })).status === 200);
  S.check('plan: the heavy friend plans Glass Orchard', (await api(R, 'PUT', '/api/plans', { showtime_id: show(4, '9101', WED, '20:10').id })).status === 200);
  const x = await api(R, 'DELETE', `/api/plans/${P[4].id}`);
  S.check('plan: cancel takes the plan away', x.status === 200 && x.json.cancelled === true && !plan(R.id, 4), x.text);
  S.check('plan: the second friend plans at their own theater', (await api(K, 'PUT', '/api/plans', { showtime_id: show(1, '9102', WED, '18:45').id })).status === 200);
  S.check('plan: the brand-new friend (push off) plans Glass Orchard at 2:10 PM', (await api(J, 'PUT', '/api/plans', { showtime_id: show(4, '9101', WED, '14:10').id })).status === 200);

  const notMine = await api(R, 'PUT', '/api/plans', { showtime_id: show(2, '9102', WED, '20:00').id });
  const madeUp = await api(K, 'PUT', '/api/plans', { showtime_id: 'no-such-showtime' });
  const noBody = await api(K, 'PUT', '/api/plans', {});
  const weird = await api(K, 'PUT', '/api/plans', { showtime_id: ['x'] });
  S.check('plan: a showing at a theater the caller doesn\'t follow is the same 404 as a made-up one', notMine.status === 404 && madeUp.status === 404 && noBody.status === 404 && weird.status === 404 && notMine.text === madeUp.text, `${notMine.status} ${madeUp.status} ${noBody.status} ${weird.status}`);
  S.check('plan: a refused plan stores nothing', plan(R.id, 2)?.theatre_id === '9101' && !plan(K.id, 4));

  const after = await snapshot();
  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  S.check('picks: making, moving and cancelling plans changes no score and no pick for anyone', !moved.length, moved.join(', '));
});

await S.step('Wednesday 10:00: who sees a plan', async () => {
  const o = await social(OWNER);
  S.check('see: the owner has their own three plans', o.plans.map((p) => p.tmdb_id).sort().join() === [P[1].id, P[2].id, P[3].id].sort().join(), JSON.stringify(o.plans.map((p) => p.title)));
  S.check('see: the owner sees the opted-in friend going', o.going.length === 1 && o.going[0].name === 'Robin' && o.going[0].tmdb_id === P[2].id && o.going[0].time === '7:00 PM', JSON.stringify(o.going));
  S.check('see: the owner sees nothing of friends without Together', !JSON.stringify(o.going).includes('Casey') && !JSON.stringify(o.going).includes('Jordan'));
  S.check('see: nothing in going identifies an account', o.going.every((g) => !('user_id' in g) && !('id' in g)));
  const r = await social(R);
  S.check('see: the opted-in friend sees only the owner\'s plans', r.going.length === 3 && r.going.every((g) => g.name === C.OWNER_NAME), JSON.stringify(r.going.map((g) => g.name)));
  const rText = JSON.stringify(r);
  S.check('see: the opted-in friend\'s answer names no other friend', !/Casey|Jordan/.test(rText));
  const k = await social(K);
  S.check('see: a friend without Together sees nobody\'s plan', k.going.length === 0 && !/Robin|Jordan/.test(JSON.stringify(k)));
  S.check('see: the brand-new friend sees nobody\'s plan', (await social(J)).going.length === 0);
  S.check('see: each friend has only their own plans', (await social(K)).plans.length === 1 && (await social(J)).plans.length === 1 && r.plans.length === 1);
  const gs = await api(GUEST, 'GET', '/api/social');
  S.check('see: the guest\'s social answer is empty', gs.status === 200 && gs.text === JSON.stringify({ plans: [], going: [], sent: [], send: { recipients: [], left: 0, limit: 10, noteMax: 140 } }), gs.text);
  for (const [m, p, body] of [['PUT', '/api/plans', { showtime_id: show(1, '9101', WED, '21:15').id }], ['DELETE', `/api/plans/${P[1].id}`], ['POST', `/api/plans/${P[1].id}/answer`, { seen: true }]]) {
    const g = await api(GUEST, m, p, body);
    S.check(`see: the guest is refused ${m} ${p.replace(/\d{5,}/, '<film>')}`, g.status === 403, `${g.status}`);
  }
  S.check('see: the guest\'s cancel changed nothing', Boolean(plan(1, 1)));
  const guestRecs = (await api(GUEST, 'GET', '/api/recommendations')).text + (await api(GUEST, 'GET', `/api/movies/${P[1].id}`)).text;
  S.check('see: nothing the guest can read carries a plan', !/showtime_id|reminded_at|ask_at|expires_at/.test(guestRecs));
  // Robin switches Together off: the pair is gone both ways.
  await api(R, 'PUT', '/api/settings', { watchTogether: false });
  S.check('see: Together off hides the friend\'s plan from the owner', (await social(OWNER)).going.length === 0);
  S.check('see: Together off hides the owner\'s plans from the friend', (await social(R)).going.length === 0);
  await api(R, 'PUT', '/api/settings', { watchTogether: true });
  // A revoked friend's plan goes out of sight, and they get no push.
  const drew = await makeFriend(w.base, 'Drew');
  await api(drew, 'PUT', '/api/settings', { watchTogether: true, setupDone: true });
  await api(drew, 'POST', '/api/theatre', { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' });
  await api(drew, 'POST', '/api/push/subscribe', { subscription: w.push.newSub('drew') });
  S.check('see: a new opted-in friend can plan', (await api(drew, 'PUT', '/api/plans', { showtime_id: show(3, '9101', WED, '18:40').id })).status === 200);
  S.check('see: the owner sees them going', (await social(OWNER)).going.some((g) => g.name === 'Drew'));
  S.check('see: the other opted-in friend never sees them', !JSON.stringify(await social(R)).includes('Drew'));
  await api(OWNER, 'POST', `/api/friends/${drew.id}/revoke`, {});
  S.check('see: once revoked, their plan is gone from the owner\'s view', !(await social(OWNER)).going.some((g) => g.name === 'Drew'));
});

// ============================================================ reminders
await S.step('Wednesday: reminders two hours before, once, only with push on', async () => {
  await jump('2026-09-23T10:31:00');
  await until(() => hits('owner', /^plan-reminder$/).length >= 1, 8000);
  await settle();
  const ow = hits('owner', /^plan-reminder$/);
  S.check('remind: the 12:30 showing\'s reminder reached the owner once', ow.length === 1 && ow[0].msg?.title === `${P[2].title} at 12:30 PM` && ow[0].msg?.body === 'Today at Maple Grove. You said you\'re going.' && ow[0].msg?.url === `/#/movie/${P[2].id}`, JSON.stringify(ow.map((h) => h.msg)));
  S.check('remind: the plan made with under two hours left never reminds', !plan(1, 3).reminded_at && !ow.some((h) => h.msg?.title?.startsWith(P[3].title)));

  await jump('2026-09-23T12:11:00');
  await until(() => plan(J.id, 4)?.reminded_at, 8000);
  await settle();
  S.check('remind: someone without push on is claimed but sent nothing', Boolean(plan(J.id, 4)?.reminded_at) && w.push.hits.every((h) => ['owner', 'robin', 'casey', 'drew'].includes(h.name)));
  const p = await api(OWNER, 'PUT', '/api/plans', { showtime_id: show(3, '9101', WED, '11:00').id });
  S.check('plan: a showing that has started is refused', p.status === 409 && /started/.test(p.json?.error || ''), `${p.status} ${p.text}`);
  const early = await api(OWNER, 'POST', `/api/plans/${P[1].id}/answer`, { seen: true });
  S.check('answer: before the showing it is refused', early.status === 409 && Boolean(plan(1, 1)), `${early.status}`);
  S.check('answer: a non-boolean answer is refused', (await api(OWNER, 'POST', `/api/plans/${P[1].id}/answer`, { seen: 'yes' })).status === 400);
  S.check('answer: a film with no plan is a 404', (await api(K, 'POST', `/api/plans/${P[2].id}/answer`, { seen: false })).status === 404);
});

await S.step('a restart between plan and reminder still sends it once', async () => {
  const n = w.push.hits.length;
  await w.restart({ fakeNow: local('2026-09-23T12:20:00'), env: { RP_TIMER_SCALE: '0.004' } });
  await settle();
  S.check('restart: nothing already sent goes again', w.push.hits.length === n, `+${w.push.hits.length - n}`);
  S.check('restart: the second friend\'s plan is still there', Boolean(plan(K.id, 1)) && !plan(K.id, 1).reminded_at);
  await jump('2026-09-23T16:46:00');
  await until(() => hits('casey').length >= 1, 8000);
  await settle();
  const k = hits('casey');
  S.check('restart: the reminder made before the restart went once, after it', k.length === 1 && k[0].msg?.title === `${P[1].title} at 6:45 PM` && /Riverside/.test(k[0].msg?.body || ''), JSON.stringify(k.map((h) => h.msg)));
});

await S.step('cancelled and moved plans never fire for their old showing', async () => {
  await jump('2026-09-23T17:01:00');
  await until(() => hits('robin').length >= 1, 8000);
  await settle();
  S.check('remind: the heavy friend\'s 7:00 PM reminder, once', hits('robin').length === 1 && hits('robin')[0].msg?.title === `${P[2].title} at 7:00 PM`, JSON.stringify(hits('robin').map((h) => h.msg)));
  await jump('2026-09-23T18:11:00'); // Glass Orchard 8:10 PM's reminder time, cancelled
  await settle();
  S.check('cancel: the cancelled plan sent nothing', !hits('robin').some((h) => h.msg?.title?.startsWith(P[4].title)));
  S.check('move: nothing for the 7:30 PM showing the plan moved away from', !hits('owner').some((h) => /7:30 PM/.test(h.msg?.title || '')));
  await jump('2026-09-23T19:16:00');
  await until(() => hits('owner', /^plan-reminder$/).length >= 2, 8000);
  await settle();
  S.check('move: the moved plan reminds for its new showing, once', hits('owner', /^plan-reminder$/).filter((h) => h.msg?.title === `${P[1].title} at 9:15 PM` && /^Tonight at Maple Grove/.test(h.msg?.body)).length === 1, JSON.stringify(hits('owner').map((h) => h.msg?.title)));
});

await S.step('seen or rated elsewhere clears the plan and its question', async () => {
  await jump('2026-09-23T21:20:00');
  const seen = await api(J, 'POST', '/api/watched', { tmdb_id: P[4].id, title: P[4].title });
  S.check('clear: Mark seen takes the plan away', seen.status === 200 && !plan(J.id, 4));
  const rated = await api(OWNER, 'POST', '/api/ratings', { tmdb_id: P[3].id, rating: 4, title: P[3].title });
  S.check('clear: rating the film takes the plan away', rated.status === 200 && !plan(1, 3));
  S.check('clear: the rest stay', Boolean(plan(1, 1) && plan(1, 2) && plan(R.id, 2) && plan(K.id, 1)));
});

// ============================================================ Thu 10:00
let alistBefore;
await S.step('Thursday 10:00: the morning question, once', async () => {
  await jump('2026-09-24T09:59:00');
  await settle();
  S.check('ask: nothing asked before 10', w.push.hits.filter((h) => h.topic === 'plan-question').length === 0 && !(await social(OWNER)).plans.some((p) => p.ask));
  alistBefore = (await api(OWNER, 'GET', '/api/alist')).json;
  await jump('2026-09-24T10:01:00');
  await until(() => w.push.hits.filter((h) => h.topic === 'plan-question').length >= 4, 8000);
  await settle();
  const q = w.push.hits.filter((h) => h.topic === 'plan-question');
  const by = (n) => q.filter((h) => h.name === n).map((h) => h.msg?.title).sort();
  S.check('ask: the owner is asked about each planned film once', JSON.stringify(by('owner')) === JSON.stringify([`Did you see ${P[2].title}?`, `Did you see ${P[1].title}?`].sort()), JSON.stringify(by('owner')));
  S.check('ask: each friend is asked about their own film once', JSON.stringify(by('robin')) === JSON.stringify([`Did you see ${P[2].title}?`]) && JSON.stringify(by('casey')) === JSON.stringify([`Did you see ${P[1].title}?`]), `${by('robin')} ${by('casey')}`);
  S.check('ask: nothing about a cleared plan, nothing to someone without push', q.length === 4 && !q.some((h) => h.msg?.title?.includes(P[3].title) || h.msg?.title?.includes(P[4].title)));
  S.check('ask: the question opens Picks', q.every((h) => h.msg?.url === '/#/home'));
  const o = await social(OWNER);
  S.check('ask: the Picks card is up for both of the owner\'s films', o.plans.filter((p) => p.ask).length === 2 && o.plans.every((p) => p.started));
});

await S.step('Yes logs it seen on the showing\'s day, like Mark seen; No clears', async () => {
  const yes = await api(OWNER, 'POST', `/api/plans/${P[1].id}/answer`, { seen: true });
  const row = w.q1('SELECT * FROM watched WHERE user_id = 1 AND tmdb_id = ?', P[1].id);
  const p = show(1, '9101', WED, '21:15');
  const logged = Boolean(w.q1("SELECT 1 x FROM weekly4_log WHERE user_id = 1 AND week_start = '2026-09-18' AND tmdb_id = ?", P[1].id));
  S.check('yes: answered', yes.status === 200 && yes.json.seen === true && yes.json.date === WED, yes.text.slice(0, 200));
  S.check('yes: the watch is dated to the showing\'s day and time', row?.watched_date === WED && row?.watched_at === new Date(p.start_epoch).toISOString() && row?.week_start === '2026-09-18', JSON.stringify(row));
  S.check('yes: counted like Mark seen (plan ticket, weekly-4 flag from the log)', logged && row?.source == null && row?.ticket_price === 14.5 && row?.in_weekly4 === 1, `price ${row?.ticket_price} flag ${row?.in_weekly4} log ${logged}`);
  const alist = (await api(OWNER, 'GET', '/api/alist')).json;
  S.check('yes: the movie plan counts it', alist.used === alistBefore.used + 1 && alist.movies.some((m) => m.tmdb_id === P[1].id), `${alistBefore.used} -> ${alist.used}`);
  S.check('yes: the plan and its question are gone', !plan(1, 1) && !(await social(OWNER)).plans.some((x) => x.tmdb_id === P[1].id));
  const no = await api(OWNER, 'POST', `/api/plans/${P[2].id}/answer`, { seen: false });
  S.check('no: clears the plan and logs nothing', no.status === 200 && !plan(1, 2) && !w.q1('SELECT 1 x FROM watched WHERE user_id = 1 AND tmdb_id = ?', P[2].id));
  S.check('answer: a second answer is a 404', (await api(OWNER, 'POST', `/api/plans/${P[2].id}/answer`, { seen: true })).status === 404);
});

await S.step('no answer: the card stays three days, then the plan goes', async () => {
  const n = w.push.hits.length;
  await jump('2026-09-25T10:05:00');
  await settle();
  S.check('lapse: on Friday the card is still up, and nothing is asked again', (await social(R)).plans.some((p) => p.ask && p.tmdb_id === P[2].id) && w.push.hits.length === n, `+${w.push.hits.length - n}`);
  const late = await api(K, 'POST', `/api/plans/${P[1].id}/answer`, { seen: true });
  const kr = w.q1('SELECT * FROM watched WHERE user_id = ? AND tmdb_id = ?', K.id, P[1].id);
  S.check('yes: answered a day late, still dated to the showing\'s day', late.status === 200 && kr?.watched_date === WED, JSON.stringify(kr));
  await w.restart({ fakeNow: local('2026-09-27T09:59:00'), env: { RP_TIMER_SCALE: '0.004' } });
  await settle();
  S.check('lapse: still up just before three days', (await social(R)).plans.some((p) => p.ask));
  await jump('2026-09-27T10:01:00');
  await until(() => !plan(R.id, 2), 8000);
  S.check('lapse: after three days the plan is gone', !plan(R.id, 2) && !(await social(R)).plans.length);
  S.check('lapse: nothing was ever sent twice', (() => { const seen = new Set(); for (const h of w.push.hits) { const k = `${h.name}|${h.topic}|${h.msg?.title}`; if (seen.has(k)) return false; seen.add(k); } return true; })());
  S.check('push: every plan push went only to the plan\'s own person', w.push.hits.filter((h) => /^plan-/.test(h.topic)).every((h) => ['owner', 'robin', 'casey'].includes(h.name)) && !w.push.hits.some((h) => h.name === 'drew'));
});

await w.close();
S.finish();
