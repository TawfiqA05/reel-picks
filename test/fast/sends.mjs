// Send a pick (server/lib/sends.js): the owner sends to any friend, a friend
// only to the owner, never friend to friend; every id a caller can't send to
// is the same 404; a friend's answers never name another friend; the note is
// optional plain text up to 140 characters; the recipient with push on gets
// "<sender> thinks you'd like <film>" once; the "Sent to you" row stays until
// it's dismissed or the film is saved, seen or rated; ten sends a day, a count
// that survives a restart and resets the next day; the guest can neither send
// nor receive; and sending changes no score and no pick.
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until, sleep, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('sends');
const w = S.world(await openWorld('sends', { push: true }));
const OWNER = null;
const { robin: R, casey: K, jordan: J } = w.friends;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const social = async (as) => (await api(as, 'GET', '/api/social')).json;
const send = (as, to, film, note) => api(as, 'POST', '/api/sends', { to, tmdb_id: film, ...(note !== undefined ? { note } : {}) });
const P = Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [k, C.PLAYING.find((f) => f.k === k)]));
const hits = (name) => w.push.hits.filter((h) => h.name === name && h.topic === 'sent-pick');
const recsOf = async (as) => {
  const r = (await api(as, 'GET', '/api/recommendations')).json;
  return JSON.stringify({ four: r.weekly4.map((e) => e.tmdb_id), list: r.list.map((e) => [e.tmdb_id, e.final]), worth: r.worthSeeing.map((e) => e.tmdb_id), near: r.alsoNearby.map((e) => [e.tmdb_id, e.final]) });
};
const ROLES = { owner: OWNER, heavy: R, empty: K, fresh: J, guest: GUEST };
const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(ROLES).map(async ([k, as]) => [k, await recsOf(as)])));
const counts = () => JSON.stringify(['ratings', 'watchlist', 'watched', 'hidden_movies', 'weekly4_log', 'weekly4_lock'].map((t) => w.q1(`SELECT COUNT(*) n FROM ${t}`).n));

let before; let tablesBefore;
await S.step('push devices and the picks before any send', async () => {
  for (const [who, as] of [['owner', OWNER], ['robin', R], ['casey', K]]) {
    S.check(`setup: ${who} turns push on`, (await api(as, 'POST', '/api/push/subscribe', { subscription: w.push.newSub(who) })).status === 200);
  }
  before = await snapshot();
  tablesBefore = counts();
});

let drew;
await S.step('who can send to whom', async () => {
  const o = await social(OWNER);
  S.check('who: the owner can send to every friend, by name', JSON.stringify(o.send.recipients.map((r) => r.name)) === JSON.stringify(['Casey', 'Jordan', 'Robin']) && o.send.left === 10 && o.send.noteMax === 140, JSON.stringify(o.send));
  for (const [name, as] of [['heavy', R], ['empty', K], ['fresh', J]]) {
    const s = await social(as);
    const others = ['Robin', 'Casey', 'Jordan'].filter((n) => n.toLowerCase() !== w.friends[{ heavy: 'robin', empty: 'casey', fresh: 'jordan' }[name]].name.toLowerCase());
    S.check(`who: the ${name} friend can send only to the owner`, JSON.stringify(s.send.recipients) === JSON.stringify([{ id: 1, name: C.OWNER_NAME }]), JSON.stringify(s.send.recipients));
    S.check(`who: nothing the ${name} friend reads names another friend`, !others.some((n) => JSON.stringify(s).includes(n)));
  }
  const toFriend = await send(R, K.id, P[1].id, 'hi');
  const madeUp = await send(R, 987654, P[1].id, 'hi');
  const self = await send(R, R.id, P[1].id, 'hi');
  const junk = await send(R, 'abc', P[1].id, 'hi');
  const none = await send(R, undefined, P[1].id, 'hi');
  S.check('who: a friend sending to another friend gets the same 404 as a made-up id', toFriend.status === 404 && toFriend.text === madeUp.text && madeUp.status === 404, `${toFriend.status} ${toFriend.text} / ${madeUp.text}`);
  S.check('who: yourself, a non-number and nobody are that same 404', [self, junk, none].every((r) => r.status === 404 && r.text === madeUp.text));
  S.check('who: the refused sends stored nothing', w.q1('SELECT COUNT(*) n FROM sends').n === 0);
  drew = await makeFriend(w.base, 'Drew');
  await api(OWNER, 'POST', `/api/friends/${drew.id}/revoke`, {});
  const revoked = await send(OWNER, drew.id, P[1].id);
  S.check('who: the owner sending to a revoked friend is that same 404', revoked.status === 404 && revoked.text === madeUp.text);
  S.check('who: a revoked friend isn\'t offered', !(await social(OWNER)).send.recipients.some((r) => r.name === 'Drew'));
  const gs = (await api(GUEST, 'GET', '/api/social')).json;
  S.check('guest: nothing sent to it and nobody to send to', gs.sent.length === 0 && gs.send.recipients.length === 0 && gs.send.left === 0);
  for (const [m, p, body] of [['POST', '/api/sends', { to: 1, tmdb_id: P[1].id }], ['DELETE', '/api/sends/1']]) {
    const g = await api(GUEST, m, p, body);
    S.check(`guest: refused ${m} ${p}`, g.status === 403, `${g.status}`);
  }
  S.check('guest: the owner can\'t send to a user id 0', (await send(OWNER, 0, P[1].id)).status === 404);
  S.check('who: a film that isn\'t stored is refused', (await send(OWNER, R.id, 123456789)).status === 404);
});

await S.step('sending, the push, and the Sent to you row', async () => {
  const a = await send(OWNER, R.id, P[1].id, 'You\'d love the lighthouse bits');
  S.check('send: the owner sends a pick with a note', a.status === 200 && a.json.sent === true && a.json.left === 9, a.text);
  await until(() => hits('robin').length >= 1, 8000);
  await sleep(400);
  const h = hits('robin');
  S.check('push: the recipient gets "<sender> thinks you\'d like <film>" once, with the note', h.length === 1 && h[0].msg?.title === `${C.OWNER_NAME} thinks you'd like ${P[1].title}` && h[0].msg?.body === 'You\'d love the lighthouse bits' && h[0].msg?.url === `/#/movie/${P[1].id}`, JSON.stringify(h.map((x) => x.msg)));
  const r = await social(R);
  S.check('row: it waits in the recipient\'s Sent to you', r.sent.length === 1 && r.sent[0].from === C.OWNER_NAME && r.sent[0].note === 'You\'d love the lighthouse bits' && r.sent[0].tmdb_id === P[1].id && r.sent[0].title === P[1].title, JSON.stringify(r.sent));
  S.check('row: nobody else has it', !(await social(K)).sent.length && !(await social(J)).sent.length && !(await social(OWNER)).sent.length);
  const b = await send(R, 1, P[2].id);
  S.check('send: a friend sends to the owner without a note', b.status === 200);
  await until(() => hits('owner').length >= 1, 8000);
  S.check('push: no note, a plain line', hits('owner')[0]?.msg?.title === `Robin thinks you'd like ${P[2].title}` && hits('owner')[0]?.msg?.body === 'Tap to see it.', JSON.stringify(hits('owner').map((x) => x.msg)));
  const c = await send(K, 1, P[3].id, 'This one?');
  S.check('send: a friend without Together can still send to the owner', c.status === 200);
  const o = await social(OWNER);
  S.check('row: the owner sees who sent each', JSON.stringify(o.sent.map((s) => s.from).sort()) === JSON.stringify(['Casey', 'Robin']), JSON.stringify(o.sent));
  const j = await send(OWNER, J.id, P[4].id, 'For your first week');
  await sleep(600);
  S.check('push: someone without push on gets none, but the row is there', j.status === 200 && w.push.hits.every((x) => ['owner', 'robin', 'casey'].includes(x.name)) && (await social(J)).sent.length === 1);
  const again = await send(OWNER, R.id, P[1].id, 'Still think so');
  const rr = await social(R);
  S.check('send: the same film to the same person again replaces the earlier one', again.status === 200 && rr.sent.length === 1 && rr.sent[0].note === 'Still think so', JSON.stringify(rr.sent));
  const after = await snapshot();
  const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
  S.check('picks: sending and receiving change no score and no pick for anyone', !moved.length, moved.join(', '));
  S.check('picks: no rating, save, watch, hide or weekly-4 row was written', counts() === tablesBefore, `${tablesBefore} -> ${counts()}`);
});

await S.step('the note: optional, plain text, up to 140 characters', async () => {
  const long = 'x'.repeat(141);
  const r141 = await send(OWNER, K.id, P[5].id, long);
  S.check('note: 141 characters are refused and nothing is stored', r141.status === 400 && /140/.test(r141.json?.error || '') && !w.q1('SELECT 1 x FROM sends WHERE to_user = ? AND tmdb_id = ?', K.id, P[5].id), `${r141.status} ${r141.text}`);
  S.check('note: a number is refused', (await send(OWNER, K.id, P[5].id, 42)).status === 400);
  const r140 = await send(OWNER, K.id, P[5].id, 'y'.repeat(140));
  S.check('note: exactly 140 is fine', r140.status === 200);
  const markup = '<b>bold</b> & "quotes"\n\nnew\u200b line\u0007';
  await send(OWNER, K.id, P[6].id, markup);
  const got = (await social(K)).sent.find((s) => s.tmdb_id === P[6].id);
  S.check('note: kept as plain text, line breaks and control characters folded away', got?.note === '<b>bold</b> & "quotes" new line', JSON.stringify(got?.note));
  S.check('note: blank is no note', (await send(OWNER, J.id, P[5].id, '   ')).status === 200 && (await social(J)).sent.find((s) => s.tmdb_id === P[5].id)?.note === '');
});

await S.step('the row clears on dismiss, save, seen or rated', async () => {
  const k = await social(K);
  const one = k.sent.find((s) => s.tmdb_id === P[5].id);
  S.check('dismiss: someone else can\'t dismiss it', (await api(R, 'DELETE', `/api/sends/${one.id}`)).status === 404 && (await api(OWNER, 'DELETE', `/api/sends/${one.id}`)).status === 404);
  const d = await api(K, 'DELETE', `/api/sends/${one.id}`);
  S.check('dismiss: the recipient dismisses it', d.status === 200 && !(await social(K)).sent.some((s) => s.id === one.id));
  S.check('dismiss: twice is a 404', (await api(K, 'DELETE', `/api/sends/${one.id}`)).status === 404);
  await api(K, 'POST', '/api/watchlist/toggle', { tmdb_id: P[6].id });
  S.check('clear: saving the film clears it', !(await social(K)).sent.some((s) => s.tmdb_id === P[6].id));
  await api(R, 'POST', '/api/watched', { tmdb_id: P[1].id, title: P[1].title });
  S.check('clear: marking it seen clears it', !(await social(R)).sent.length);
  await api(J, 'POST', '/api/ratings', { tmdb_id: P[4].id, rating: 3.5, title: P[4].title });
  S.check('clear: rating it clears it', !(await social(J)).sent.some((s) => s.tmdb_id === P[4].id));
  S.check('clear: each says how', ['replaced', 'dismissed', 'watchlisted', 'seen', 'rated'].every((x) => w.q1('SELECT 1 y FROM sends WHERE cleared_how = ?', x)), JSON.stringify(w.q('SELECT cleared_how FROM sends WHERE cleared_at IS NOT NULL')));
  // A revoked friend's picks stop showing.
  const e = await makeFriend(w.base, 'Ellis');
  await api(e, 'POST', '/api/sends', { to: 1, tmdb_id: P[2].id });
  S.check('revoked: the owner sees the new friend\'s pick', (await social(OWNER)).sent.some((s) => s.from === 'Ellis'));
  await api(OWNER, 'POST', `/api/friends/${e.id}/revoke`, {});
  S.check('revoked: once revoked, their pick is gone from the owner\'s row', !(await social(OWNER)).sent.some((s) => s.from === 'Ellis'));
});

await S.step('ten sends a day, a count that survives a restart', async () => {
  const sofar = w.q1("SELECT COUNT(*) n FROM sends WHERE from_user = 1 AND sent_day = '2026-09-23'").n;
  const left = (await social(OWNER)).send.left;
  S.check('limit: left counts down from 10', left === 10 - sofar, `${left} left after ${sofar}`);
  let last = null;
  for (let i = sofar; i < 10; i++) last = await send(OWNER, i % 2 ? R.id : J.id, C.PLAYING[i % C.PLAYING.length].id);
  S.check('limit: the 10th send of the day goes', last?.status === 200 && last.json.left === 0, `${last?.status} ${last?.text}`);
  const over = await send(OWNER, R.id, P[3].id, 'one more');
  S.check('limit: the 11th is refused with a plain message', over.status === 429 && over.json?.error === 'You\'ve sent 10 picks today. You can send more tomorrow.', `${over.status} ${over.text}`);
  S.check('limit: the refused one stored nothing', w.q1("SELECT COUNT(*) n FROM sends WHERE from_user = 1 AND sent_day = '2026-09-23'").n === 10);
  S.check('limit: it is per person (a friend can still send)', (await send(K, 1, P[4].id)).status === 200);
  await w.restart();
  S.check('limit: still refused after a restart', (await send(OWNER, R.id, P[3].id)).status === 429 && (await social(OWNER)).send.left === 0);
  await w.jump('2026-09-24T00:05:00-04:00');
  S.check('limit: the next local day starts again', (await send(OWNER, R.id, P[3].id)).status === 200 && (await social(OWNER)).send.left === 9);
});

await S.step('no friend ever reads another friend\'s name or picks', async () => {
  const friendsOf = { robin: R, casey: K, jordan: J };
  for (const [key, as] of Object.entries(friendsOf)) {
    const others = Object.values(w.friends).filter((f) => f.id !== as.id).map((f) => f.name).concat(['Drew', 'Ellis']);
    const texts = [(await api(as, 'GET', '/api/social')).text, (await send(as, K.id === as.id ? R.id : K.id, P[1].id)).text];
    S.check(`privacy: ${key}'s answers name no other friend`, !others.some((n) => texts.some((t) => t.includes(n))), others.filter((n) => texts.some((t) => t.includes(n))).join());
    S.check(`privacy: ${key} only ever received from the owner`, (await social(as)).sent.every((s) => s.from === C.OWNER_NAME));
    S.check(`privacy: ${key}'s pushes came only from the owner`, w.push.hits.filter((h) => h.name === key && h.topic === 'sent-pick').every((h) => h.msg?.title?.startsWith(`${C.OWNER_NAME} thinks`)));
  }
});

await w.close();
S.finish();
