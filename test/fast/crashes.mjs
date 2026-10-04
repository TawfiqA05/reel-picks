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
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, sleep, until } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('crashes');
const { check, step } = S;

const SERVER_LINE = 'Something went wrong on the server. Try again.';

const alive = (w) => w.srv.child.exitCode == null && w.srv.child.signalCode == null;
const fails = (w) => { try { return fs.readFileSync(path.join(w.dir, 'ctrl.json.dbfail.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const failOn = (w, rules) => w.writeCtrl({ dbFail: rules });

const w = S.world(await openWorld('crashes'));
try {
  const { robin } = w.friends;

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
