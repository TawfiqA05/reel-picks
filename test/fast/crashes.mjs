// What a visitor or a failing disk can do to the server, and what people
// see when something goes wrong.
//
//   cookies     a cookie value that isn't valid %-encoding counts as no
//               cookie: the owner, a friend and the guest all still get in.
//   database    a statement that fails (the control file's dbFail, standing
//               in for a full disk) on a friend's last-seen write, or in a
//               timer (the 15-minute check, the refresh retry, the off-site
//               check), is logged and the server keeps answering. A write
//               waits out another connection's lock instead of failing.
//   upstream    TMDB or AMC failing shows a friend the plain server line,
//               never the upstream address or code. Errors the app writes
//               itself keep their own words and code.
//   bodies      a body too big, or one that can't be read, gets its own
//               line and code; the owner, push and settings handlers say
//               the plain server line on a 500, with the details in the log.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, sleep, until } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('crashes');
const { check, step } = S;

const SERVER_LINE = 'Something went wrong on the server. Try again.';
const UNREADABLE = 'Reel Picks couldn\'t read that request. Reload the page and try again.';
const TOO_BIG = 'That file is too big. Reel Picks takes files up to 20 MB.';

const alive = (w) => w.srv.child.exitCode == null && w.srv.child.signalCode == null;
const fails = (w) => { try { return fs.readFileSync(path.join(w.dir, 'ctrl.json.dbfail.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const failOn = (w, rules) => w.writeCtrl({ dbFail: rules });
const raw = async (w, method, p, { body, headers = {} } = {}) => {
  const res = await fetch(w.base + p, { method, headers, body, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};

const w = S.world(await openWorld('crashes', { push: true }));
try {
  const { robin, casey } = w.friends;

  // ============================================================== cookies
  await step('cookies: a value that isn\'t valid %-encoding counts as no cookie', async () => {
    const own = await w.api('GET', '/api/status', { headers: { cookie: 'rp_owner=%' } });
    check('the owner at localhost with "rp_owner=%" gets the app', own.status === 200, `${own.status} ${own.text.slice(0, 160)}`);
    const fr = await w.api('GET', '/api/settings', { headers: { 'cf-ray': 'test', cookie: `${robin.cookie}; rp_owner=%zz` } });
    check('a friend with a broken owner cookie beside theirs is still that friend', fr.status === 200 && fr.json && !('lastRefreshLog' in fr.json), `${fr.status} ${fr.text.slice(0, 160)}`);
    const guest = await w.api('GET', '/api/recommendations', { headers: { 'cf-ray': 'test', cookie: 'rp_user=%E0%A4%A' } });
    check('the guest with a broken friend cookie gets the guest view', guest.status === 200 && Array.isArray(guest.json?.weekly4), `${guest.status} ${guest.text.slice(0, 160)}`);
    check('the server is still running', alive(w));
  });

  // ============================================================== database
  await step('control: the dbFail switch makes the chosen statement throw', async () => {
    failOn(w, [{ sql: 'FROM ratings r LEFT JOIN movies m' }]);
    await sleep(120);
    const r = await w.api('GET', '/api/ratings');
    check('control: a read it covers fails with the plain server line', r.status === 500 && r.json?.error === SERVER_LINE, `${r.status} ${r.text.slice(0, 160)}`);
    check('control: the failure was written down', fails(w).some((f) => f.sql === 'FROM ratings r LEFT JOIN movies m'));
    failOn(w, []);
    await sleep(120);
    const ok = await w.api('GET', '/api/ratings');
    check('control: cleared, the same read answers again', ok.status === 200);
  });

  await step('database: a failed last-seen write doesn\'t stop a friend', async () => {
    w.q('UPDATE users SET last_seen_at = NULL WHERE id = ?', robin.id);
    const before = fails(w).length;
    failOn(w, [{ sql: 'UPDATE users SET last_seen_at' }]);
    await sleep(120);
    const read = await w.api('GET', '/api/settings', { as: robin });
    check('a friend\'s read answers while the last-seen write fails', read.status === 200, `${read.status} ${read.text.slice(0, 160)}`);
    const rate = await w.api('POST', '/api/ratings', { as: robin, body: { tmdb_id: C.RATED[3].id, rating: 3.5 } });
    check('and a friend\'s own write still goes through', rate.status === 200, `${rate.status} ${rate.text.slice(0, 160)}`);
    check('the last-seen write was really tried', fails(w).length > before);
    check('the failure is in the log', /\[last seen\] database or disk is full/.test(w.srv.log()), w.srv.log().slice(-400));
    failOn(w, []);
    await sleep(120);
    await w.api('GET', '/api/settings', { as: robin });
    check('once the disk has room, last seen is written again', Boolean(w.q1('SELECT last_seen_at FROM users WHERE id = ?', robin.id)?.last_seen_at));
  });

  await step('database: a write waits out another connection\'s lock', async () => {
    const d = w.db();
    d.exec('BEGIN IMMEDIATE');
    const p = w.api('POST', '/api/ratings', { body: { tmdb_id: C.RATED[4].id, rating: 2.5 } });
    await sleep(1500);
    d.exec('COMMIT');
    d.close();
    const r = await p;
    check('a rating saved while another connection held the write lock for 1.5 s goes through', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    check('and it is saved', w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', C.RATED[4].id)?.rating === 2.5);
  });

  // ============================================================== upstream
  await step('upstream: TMDB or AMC failing shows a friend the plain server line', async () => {
    w.q("DELETE FROM cache WHERE key LIKE 'tmdb:popular:%'");
    w.writeCtrl({ tmdbFail: { '/3/movie/popular': { status: 429, body: { status_message: 'Your request count is over the allowed limit.' } } } });
    await sleep(120);
    const t = await w.api('GET', '/api/onboarding/movies', { as: robin });
    check('a TMDB 429 gives the friend a 500 with the plain server line', t.status === 500 && t.json?.error === SERVER_LINE, `${t.status} ${t.text.slice(0, 200)}`);
    check('with no TMDB address or upstream code in it', !/themoviedb|HTTP \d|api_key/i.test(t.text), t.text.slice(0, 200));
    check('the details are in the log', /HTTP 429 for https:\/\/api\.themoviedb\.org/.test(w.srv.log()));
    w.writeCtrl({});
    w.amc.mode = '500';
    w.q("DELETE FROM cache WHERE key = 'amc:theatres:all'");
    const a = await w.api('GET', '/api/theatres?query=maple', { as: robin });
    w.amc.mode = 'ok';
    check('an AMC 500 gives the friend a 500 with the plain server line', a.status === 500 && a.json?.error === SERVER_LINE, `${a.status} ${a.text.slice(0, 200)}`);
    check('with no AMC address in it', !/127\.0\.0\.1|HTTP \d|v2\/theatres/.test(a.text), a.text.slice(0, 200));
  });

  await step('upstream: errors the app writes itself keep their words and code', async () => {
    const lb = await w.api('PUT', '/api/letterboxd', { as: robin, body: { username: 'not a name!' } });
    check('a bad Letterboxd name is a 400 with its own line', lb.status === 400 && /^That isn't a Letterboxd username/.test(lb.json?.error || ''), `${lb.status} ${lb.text.slice(0, 160)}`);
    const sent = await w.api('POST', '/api/sends', { as: robin, body: { to: 999, tmdb_id: C.RATED[0].id } });
    check('a pick sent to nobody is a 404 "Not found."', sent.status === 404 && sent.json?.error === 'Not found.', `${sent.status} ${sent.text.slice(0, 160)}`);
    const again = await w.api('POST', '/api/theatres/follow', { body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } });
    check('following the primary theater as an extra is a 400 with its own line', again.status === 400 && /already your primary theater/.test(again.json?.error || ''), `${again.status} ${again.text.slice(0, 160)}`);
  });

  // ============================================================== bodies
  await step('bodies: too big, or unreadable, each get their own line and code', async () => {
    const json = { 'content-type': 'application/json' };
    const bad = await raw(w, 'POST', '/api/ratings', { headers: json, body: '{"tmdb_id": 1, "rating": ' });
    check('bad JSON: 400 with the unreadable line', bad.status === 400 && bad.json?.error === UNREADABLE, `${bad.status} ${bad.text.slice(0, 160)}`);
    const url = await raw(w, 'GET', '/api/movies/%zz');
    check('a web address with broken %-escapes: 400 with the unreadable line', url.status === 400 && url.json?.error === UNREADABLE, `${url.status} ${url.text.slice(0, 160)}`);
    const enc = await raw(w, 'POST', '/api/ratings', { headers: { ...json, 'content-encoding': 'bogus' }, body: '{}' });
    check('an encoding it doesn\'t take: 415 with the unreadable line', enc.status === 415 && enc.json?.error === UNREADABLE, `${enc.status} ${enc.text.slice(0, 160)}`);
    const cs = await raw(w, 'POST', '/api/ratings', { headers: { 'content-type': 'application/json; charset=bogus' }, body: '{}' });
    check('a charset it doesn\'t take: 415 with the unreadable line', cs.status === 415 && cs.json?.error === UNREADABLE, `${cs.status} ${cs.text.slice(0, 160)}`);
    const big = await raw(w, 'POST', '/api/ratings', { headers: json, body: JSON.stringify({ pad: 'x'.repeat(300 * 1024) }) });
    check('300 KB to an ordinary route: 413 with the too-big line', big.status === 413 && big.json?.error === TOO_BIG, `${big.status} ${big.text.slice(0, 160)}`);
    const under = await raw(w, 'POST', '/api/ratings/import', { headers: json, body: JSON.stringify({ csv: `Name,Year,Rating\n${'x'.repeat(19 * 1024 * 1024)}` }) });
    check('a 19 MB upload is read (the line\'s 20 MB is the real limit)', under.status !== 413 && under.json?.error !== TOO_BIG, `${under.status} ${under.text.slice(0, 160)}`);
    const over = await raw(w, 'POST', '/api/ratings/import', { headers: json, body: JSON.stringify({ csv: 'x'.repeat(20 * 1024 * 1024 + 4096) }) });
    check('a just-over-20 MB upload: 413 with the too-big line', over.status === 413 && over.json?.error === TOO_BIG, `${over.status} ${over.text.slice(0, 160)}`);
    const log = w.srv.log();
    check('the raw parser messages are in the log', /request entity too large/.test(log) && /Failed to decode param/.test(log), log.slice(-600));
    check('the server is still running', alive(w));
  });

  await step('bodies: owner, push and settings handlers say the plain line on a 500', async () => {
    const tries = [
      ['POST /api/friends', [{ sql: 'users' }], () => w.api('POST', '/api/friends', { body: { name: 'Someone' } }), '[friends]'],
      ['POST /api/friends/:id/revoke', [{ sql: 'users' }], () => w.api('POST', `/api/friends/${casey.id}/revoke`), '[friends]'],
      ['POST /api/friends/:id/reissue', [{ sql: 'users' }], () => w.api('POST', `/api/friends/${casey.id}/reissue`), '[friends]'],
      ['POST /api/push/subscribe', [{ sql: 'push_subs' }], () => w.api('POST', '/api/push/subscribe', { body: { subscription: w.push.newSub('crash') } }), '[push]'],
      ['POST /api/theatre', [{ sql: 'user_settings' }], () => w.api('POST', '/api/theatre', { body: { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8' } }), '[theatre]'],
      ['POST /api/theatres/follow', [{ sql: 'user_settings' }], () => w.api('POST', '/api/theatres/follow', { body: { id: '9103', name: 'AMC Northgate 8', slug: 'amc-northgate-8' } }), '[theatre]'],
      ['POST /api/theatres/primary', [{ sql: 'user_settings' }], () => w.api('POST', '/api/theatres/primary', { body: { id: '9102' } }), '[theatre]'],
    ];
    const state = (await w.api('GET', '/api/state')).json;
    check('the full setup exports (for the import below)', Boolean(state?.version || state?.stateVersion || state?.ratings), JSON.stringify(state).slice(0, 120));
    tries.push(['POST /api/state', [{ sql: 'user_settings' }], () => w.api('POST', '/api/state', { body: state }), '[state]']);
    for (const [label, rules, go, tag] of tries) {
      const n = fails(w).length;
      failOn(w, rules);
      await sleep(120);
      const r = await go();
      failOn(w, []);
      await sleep(120);
      check(`${label}: 500 with the plain server line`, r.status === 500 && r.json?.error === SERVER_LINE, `${r.status} ${r.text.slice(0, 160)}`);
      check(`${label}: the failing statement was reached`, fails(w).length > n);
      check(`${label}: the details are in the log`, w.srv.log().includes(`${tag} database or disk is full`), w.srv.log().slice(-300));
    }
    check('casey is still a friend (the failed revoke changed nothing)', !w.q1('SELECT revoked_at FROM users WHERE id = ?', casey.id)?.revoked_at);
  });
} finally {
  await w.close();
}

// ============================================================== timers
// The 15-minute check, the refresh retry and the off-site check run every
// few hundred ms here (RP_TIMER_SCALE), each case on a server of its own so
// one crash can't hide the next. Off-site points at a closed local port, and
// this week's copy counts as made, so the check only reads when the last
// one was.
async function timerCase(label, rules, tags) {
  await step(`timers: ${label}`, async () => {
    const t = S.world(await openWorld('crashes-timers', {
      refresh: true,
      prepare: (d) => d.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('offsiteLast', ?)").run(JSON.stringify({ at: '2026-09-22T12:00:00.000Z' })),
      env: { RP_TIMER_SCALE: '0.004', BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9', BACKUP_S3_BUCKET: 'b', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's' },
    }));
    try {
      await until(async () => (await t.api('GET', '/api/status')).json?.refreshing === false, 30000, 150);
      failOn(t, rules);
      const reached = await until(() => fails(t).some((f) => f.sql === rules[0].sql && f.param === (rules[0].param ?? null)), 15000, 100);
      check(`${label}: the failing statement was reached`, Boolean(reached));
      await until(() => tags.every((tag) => t.srv.log().includes(`${tag} database or disk is full`)) || !alive(t), 15000, 100);
      await sleep(500);
      failOn(t, []);
      await sleep(150);
      check(`${label}: the server is still running`, alive(t), t.srv.log().slice(-600));
      for (const tag of tags) check(`${label}: ${tag} logged the failure`, t.srv.log().includes(`${tag} database or disk is full`), t.srv.log().slice(-400));
      const st = alive(t) ? await t.api('GET', '/api/status') : { status: 0 };
      check(`${label}: and it still answers`, st.status === 200);
    } finally {
      await t.close();
    }
  });
}
await timerCase('a failed read of the refresh retry', [{ sql: 'FROM settings WHERE key', param: 'refreshRetry' }], ['[refresh retry]', '[15-minute check]']);
await timerCase('a failed read of who is active', [{ sql: 'FROM users WHERE revoked_at IS NULL' }], ['[15-minute check]']);
await timerCase('a failed read of the last off-site copy', [{ sql: 'FROM settings WHERE key', param: 'offsiteLast' }], ['[offsite]']);

S.finish();
