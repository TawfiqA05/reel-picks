// Backups and the space they take (server/lib/backup.js), on a made-up
// volume (test/lib/preload.mjs: its size is set here, its used space is what
// the data folder really holds plus `other`):
//
//   retention  the newest 7 nightly and 3 pre-migration copies stay, after a
//              nightly and after a pre-migration backup; a file put in the
//              folder by hand is left alone; half-written copies an hour old
//              are cleared, newer ones left
//   space      short of room for one more copy plus the margin, the copies
//              past 7 and 3 go first, oldest first, stopping once there is
//              room; then the oldest of the rest, never the newest nightly or
//              pre-migration copy; with no way to make room nothing is
//              written and the failure says so; the live database is never
//              touched
//   recover    that failure alerts the owner once, a second one the same day
//              sends nothing, the next good backup sends one "back to
//              normal" and the cache cleanup runs after it; the one-time
//              VACUUM waits while space is short
//   alert      more than 80% full: one owner alert a day, one "has room
//              again" at 75% or less; friends and the guest never see the
//              volume's figures
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep, GUEST } from '../lib/world.mjs';

const S = suite('backups');
const MB = 1024 * 1024;
const L = (s) => `${s}-04:00`; // the test servers run on New York time, EDT in October
const w = S.world(await openWorld('backups', { env: { RP_FAKE_NOW: L('2026-10-02T01:00:00') } }));
const BK = path.join(w.dataDir, 'backups');
const F = w.friends;
const friend = Object.values(F)[0];

// ---------------------------------------------------------------- helpers
const files = () => (fs.existsSync(BK) ? fs.readdirSync(BK).sort() : []);
const nightly = () => files().filter((n) => /^reelpicks-\d{4}-\d{2}-\d{2}\.db$/.test(n));
const pre = () => files().filter((n) => /^reelpicks-pre-/.test(n) && n.endsWith('.db'));
const temps = () => files().filter((n) => /\.tmp(-journal)?$/.test(n));
const du = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const liveSize = () => ['', '-wal'].reduce((n, x) => n + (fs.existsSync(w.dbFile + x) ? fs.statSync(w.dbFile + x).size : 0), 0);
// What one more copy needs, as backup.js reckons it.
const needed = () => liveSize() + Math.max(64 * MB, Math.round(liveSize() / 4));
const disk = (d) => { w.ctrl.disk = d; w.writeCtrl(); };
const log = () => w.srv.log();
const lines = (re) => log().split('\n').filter((l) => re.test(l));
const alerts = (problem, kind) => w.q('SELECT * FROM owner_alerts WHERE problem = ? AND kind = ? ORDER BY id', problem, kind);
const setting = (k) => w.q1('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;
const start = (at, env = {}) => w.restart({ fakeNow: L(at), env: { RP_TIMER_SCALE: '0.002', ...env } });
const jump = (at) => w.jump(L(at));

// A backup file of `mb` megabytes, dated by its name.
function plant(name, mb, when) {
  fs.mkdirSync(BK, { recursive: true });
  const f = path.join(BK, name);
  fs.writeFileSync(f, Buffer.alloc(Math.round(mb * MB), 1));
  const t = new Date(when); fs.utimesSync(f, t, t);
}
const nightlyName = (ymd) => `reelpicks-${ymd}.db`;
const preName = (what, iso) => `reelpicks-pre-${what}-${new Date(iso).toISOString().replace(/[:.]/g, '-')}.db`;
const day = (i) => `2026-08-${String(i).padStart(2, '0')}`;

// The rows of every table people's data lives in, and the live files.
const USER_TABLES = ['ratings', 'watchlist', 'watched', 'hidden_movies', 'users', 'user_settings', 'weekly4_log', 'weekly4_lock', 'movies', 'showtimes', 'matches', 'push_subs', 'rating_notes'];
function rows() {
  const d = new DatabaseSync(w.dbFile, { readOnly: true });
  try {
    const have = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    return crypto.createHash('sha256').update(JSON.stringify(USER_TABLES.filter((t) => have.has(t)).map((t) => d.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all()))).digest('hex');
  } finally { d.close(); }
}
// The live files' identities. A restart closes the database, which removes
// its WAL and index, so those are compared within one server's run.
const liveFiles = () => ['', '-wal', '-shm'].map((x) => (fs.existsSync(w.dbFile + x) ? fs.statSync(w.dbFile + x).ino : null));
const integrity = () => { const d = new DatabaseSync(w.dbFile, { readOnly: true }); try { return d.prepare('PRAGMA integrity_check').get().integrity_check; } finally { d.close(); } };

const rowsBefore = rows();
const dbInode = liveFiles()[0];
// Log lines of the running server from here on.
let mark = 0;
const since = (re) => log().split('\n').slice(mark).filter((l) => re.test(l));
const markNow = () => { mark = log().split('\n').length - 1; };

// ============================================================ retention
await S.step('retention: 7 nightly and 3 pre-migration copies are kept', async () => {
  await w.srv.stop();
  for (let i = 1; i <= 20; i++) plant(nightlyName(day(i)), 0.1, L(`${day(i)}T03:00:00`));
  for (let i = 1; i <= 8; i++) plant(preName(`step-${'abcdefgh'[i - 1]}`, L(`2026-07-${String(i).padStart(2, '0')}T12:00:00`)), 0.1, L(`2026-07-${String(i).padStart(2, '0')}T12:00:00`));
  fs.writeFileSync(path.join(BK, 'keep-me.db'), 'mine');
  // Half-written copies: one left two hours ago, one from a minute ago.
  plant('reelpicks-2026-08-15.db.4242.tmp', 0.1, L('2026-10-02T01:00:00'));
  plant('reelpicks-2026-08-16.db.4243.tmp', 0.1, L('2026-10-02T02:59:00'));
  plant('reelpicks-2026-08-15.db.4242.tmp-journal', 0.01, L('2026-10-02T01:00:00'));
  await start('2026-10-02T03:00:30');
  await until(() => lines(/\[backup\] ✓ reelpicks-2026-10-02\.db/).length, 10000);
  await sleep(300);
  const want = ['2026-10-02', day(20), day(19), day(18), day(17), day(16), day(15)].map(nightlyName).sort();
  S.check('retention: a nightly leaves exactly the newest 7 nightly copies', JSON.stringify(nightly()) === JSON.stringify(want), nightly().join(', '));
  S.check('retention: a nightly leaves exactly the newest 3 pre-migration copies', pre().length === 3 && ['f', 'g', 'h'].every((x) => pre().some((n) => n.includes(`step-${x}`))), pre().join(', '));
  S.check('retention: a file put there by hand is left alone', fs.existsSync(path.join(BK, 'keep-me.db')));
  S.check('retention: a half-written copy an hour old is cleared, a newer one is left', !files().includes('reelpicks-2026-08-15.db.4242.tmp') && files().includes('reelpicks-2026-08-16.db.4243.tmp'), temps().join(', '));
  S.check('retention: the journal a failed copy left behind is cleared too', !files().includes('reelpicks-2026-08-15.db.4242.tmp-journal'), files().filter((n) => n.includes('journal')).join(', '));
  fs.rmSync(path.join(BK, 'reelpicks-2026-08-16.db.4243.tmp'));
});

await S.step('retention: a pre-migration backup keeps the same limits', async () => {
  await w.srv.stop();
  for (let i = 1; i <= 5; i++) plant(preName(`older-${'vwxyz'[i - 1]}`, L(`2026-06-0${i}T12:00:00`)), 0.1, L(`2026-06-0${i}T12:00:00`));
  // Take a column away, so the next start migrates it back after a backup.
  const d = w.db(); try { d.exec('ALTER TABLE watched DROP COLUMN theatre'); } finally { d.close(); }
  await start('2026-10-02T09:00:00');
  await sleep(300);
  const mine = pre().filter((n) => n.includes('watched-theatre'));
  S.check('retention: the migration wrote its backup', mine.length === 1, pre().join(', '));
  S.check('retention: a pre-migration backup leaves exactly the newest 3 pre-migration copies', pre().length === 3 && ['g', 'h'].every((x) => pre().some((n) => n.includes(`step-${x}`))) && !pre().some((n) => n.includes('older-')), pre().join(', '));
  S.check('retention: and the 7 nightly copies are still there', nightly().length === 7, nightly().join(', '));
});

// ============================================================ space
await S.step('space: short of room, copies past 7 and 3 go first, oldest first, and only as many as needed', async () => {
  await w.srv.stop();
  // Five more old nightly and three old pre-migration copies, 8 MB each.
  for (let i = 1; i <= 5; i++) plant(nightlyName(`2026-07-2${i}`), 8, L(`2026-07-2${i}T03:00:00`));
  for (let i = 1; i <= 3; i++) plant(preName(`old-${'pqr'[i - 1]}`, L(`2026-05-0${i}T12:00:00`)), 8, L(`2026-05-0${i}T12:00:00`));
  // Room for the copy only once 20 MB more is free: three of the 8 MB files.
  disk({ total: du(w.dataDir) + needed() - 20 * MB });
  await start('2026-10-03T03:00:30');
  const ok = await until(() => lines(/\[backup\] ✓ reelpicks-2026-10-03\.db/).length, 10000);
  const low = lines(/low on space: removed/)[0] || '';
  const gone = (low.match(/\((.*)\)/)?.[1] || '').split(', ');
  // Oldest first across both kinds: the three May pre-migration copies.
  S.check('space: it pruned before the copy, the three oldest past the limits, oldest first', gone.length === 3 && ['old-p', 'old-q', 'old-r'].every((x, i) => gone[i]?.includes(x)), low);
  S.check('space: then the copy was written', Boolean(ok) && nightly().includes(nightlyName('2026-10-03')));
  S.check('space: after the copy the usual pruning brings both kinds back to 7 and 3', nightly().length === 7 && pre().length === 3, `${nightly().length} nightly, ${pre().length} pre`);
});

await S.step('space: still short at 7 and 3, the oldest of the rest go, never the newest of either kind', async () => {
  await w.srv.stop();
  const newestPre = pre().sort((a, b) => b.localeCompare(a)).find((n) => n.includes('watched-theatre'));
  // Each copy we keep is 8 MB now, so each one removed frees 8 MB.
  for (const n of [...nightly(), ...pre()]) { const f = path.join(BK, n); const st = fs.statSync(f); fs.writeFileSync(f, Buffer.alloc(8 * MB, 1)); fs.utimesSync(f, st.atime, st.mtime); }
  const before = { nightly: nightly(), pre: pre() };
  // 36 MB short: four 8 MB copies aren't enough, five are.
  disk({ total: du(w.dataDir) + needed() - 36 * MB });
  await start('2026-10-04T03:00:30');
  const ok = await until(() => lines(/\[backup\] ✓ reelpicks-2026-10-04\.db/).length, 10000);
  const gone = (lines(/low on space: removed/)[0]?.match(/\((.*)\)/)?.[1] || '').split(', ').filter(Boolean);
  const oldestFirst = [...before.nightly.slice(0, -1), ...before.pre.filter((n) => n !== newestPre)]
    .sort((a, b) => a.match(/\d{4}-\d{2}-\d{2}/)[0].localeCompare(b.match(/\d{4}-\d{2}-\d{2}/)[0]));
  S.check('space: it went below the limits, oldest first, only as far as needed (5 copies for 36 MB)', gone.length === 5 && gone.every((n, i) => n === oldestFirst[i]), `${gone.join(', ')} vs ${oldestFirst.slice(0, 5).join(', ')}`);
  S.check('space: the newest nightly and the newest pre-migration copy were kept', !gone.includes(before.nightly[before.nightly.length - 1]) && !gone.includes(newestPre) && pre().includes(newestPre));
  S.check('space: then the copy was written', Boolean(ok));
});

await S.step('space: no way to make room, so nothing is written and the failure says why', async () => {
  const newestNightly = nightly()[nightly().length - 1];
  const newestPre = pre().sort((a, b) => b.localeCompare(a))[0];
  disk({ total: du(w.dataDir) + 10 * MB });
  const n0 = alerts('backup', 'problem').length;
  const running = liveFiles();
  await jump('2026-10-05T03:00:30');
  const fail = await until(() => lines(/reelpicks-2026-10-05\.db skipped: Not enough free space/)[0], 10000);
  await sleep(300);
  S.check('space: the copy was not attempted', Boolean(fail) && !nightly().includes(nightlyName('2026-10-05')) && !temps().length, fail || log().slice(-400));
  S.check('space: the failure says how much is free and how much a copy needs', /Not enough free space on the data volume for a backup: \d+ MB free, and a copy needs about \d+ MB/.test(fail || ''));
  S.check('space: only the newest nightly and the newest pre-migration copy are left, both intact', nightly().join() === newestNightly && pre().join() === newestPre
    && fs.statSync(path.join(BK, newestNightly)).size > 0 && fs.statSync(path.join(BK, newestPre)).size > 0, files().join(', '));
  const st = (await w.api('GET', '/api/status')).json;
  S.check('space: Settings shows the failure', /Not enough free space/.test(st?.backup?.lastError?.message || ''), JSON.stringify(st?.backup?.lastError));
  const b = await until(() => alerts('backup', 'problem').length > n0 && alerts('backup', 'problem').at(-1), 5000);
  S.check('recover: the failure raises one owner alert', Boolean(b) && /Not enough free space/.test(b.message), b?.message);
  S.check('space: the live database, its WAL and index are the same files through the failed attempt', JSON.stringify(liveFiles()) === JSON.stringify(running) && running.every(Boolean), `${liveFiles()} vs ${running}`);
});

await S.step('space: the live database was never touched', async () => {
  S.check('space: the live database is the same file it was when the suite started', liveFiles()[0] === dbInode, `${liveFiles()[0]} vs ${dbInode}`);
  S.check('space: every person\'s rows are what they were', rows() === rowsBefore);
  S.check('space: the live database passes an integrity check', integrity() === 'ok');
});

// ============================================================ recover
await S.step('recover: a second failure the same day sends nothing, the next good one says so once', async () => {
  const n0 = alerts('backup', 'problem').length;
  // As on a server that hasn't had its one-time VACUUM yet.
  const d = w.db(); try { d.exec("DELETE FROM settings WHERE key = 'cacheVacuumedAt'"); } finally { d.close(); }
  markNow();
  await jump('2026-10-05T04:00:30');
  await until(() => lines(/reelpicks-2026-10-05\.db skipped/).length >= 2, 10000);
  await sleep(500);
  S.check('recover: a second failure the same day sends no new alert', alerts('backup', 'problem').length === n0, `${alerts('backup', 'problem').length} vs ${n0}`);
  S.check('recover: the failing state is kept', w.q1("SELECT failing FROM alert_state WHERE problem = 'backup'")?.failing === 1);
  S.check('recover: no cache cleanup after a failed backup', !since(/\[housekeeping\] cache/).length);
  // Room for a copy, but not for a copy and the VACUUM after it.
  // Just room for the copy (512 KB spare); once written, not for another.
  disk({ total: du(w.dataDir) + needed() + 512 * 1024 });
  await jump('2026-10-05T05:00:30');
  const rec = await until(() => alerts('backup', 'recovered')[0], 8000);
  S.check('recover: the next good backup writes the copy', nightly().includes(nightlyName('2026-10-05')));
  S.check('recover: and sends one "back to normal"', Boolean(rec) && alerts('backup', 'recovered').length === 1 && /worked again/.test(rec.message), rec?.message);
  await until(() => since(/\[housekeeping\] (VACUUM|cache)/).length >= 2, 5000);
  S.check('recover: the cache cleanup runs after it', since(/\[housekeeping\] cache: removed/).length === 1);
  S.check('recover: the one-time VACUUM waits while space is short', since(/\[housekeeping\] VACUUM waits/).length === 1 && !setting('cacheVacuumedAt'), `${since(/VACUUM/).join(' | ')}; live ${liveSize()} bytes, copy ${fs.statSync(path.join(BK, nightlyName('2026-10-05'))).size}`);
  await sleep(1000);
  S.check('recover: still one "back to normal" a while later', alerts('backup', 'recovered').length === 1);
});

await S.step('recover: with room again the VACUUM runs after the next backup', async () => {
  disk({ total: 8 * 1024 * MB });
  markNow();
  await jump('2026-10-06T03:00:30');
  await until(() => setting('cacheVacuumedAt'), 10000);
  S.check('recover: the VACUUM ran once there was room', Boolean(setting('cacheVacuumedAt')) && since(/VACUUM done/).length === 1, since(/VACUUM/).join(' | '));
  S.check('recover: rows still the same after the VACUUM', rows() === rowsBefore);
});

// ============================================================ alert
await S.step('alert: more than 80% full alerts the owner once a day, 75% or less says it has room', async () => {
  const total = du(w.dataDir) + 500 * MB;
  disk({ total, other: Math.round(total * 0.85) - du(w.dataDir) });
  await jump('2026-10-06T10:00:30');
  const a = await until(() => alerts('disk', 'problem')[0], 5000);
  S.check('alert: over 80% full raises an owner alert', Boolean(a), log().slice(-300));
  S.check('alert: it says how full, used and free, the database and the backups', /^The data volume is 8[45]% full: [\d.]+ [MG]B of [\d.]+ [MG]B used, [\d.]+ [MG]B free\. The database is [\d.]+ [MG]B and the backups take [\d.]+ [MG]B\.$/.test(a?.message || ''), a?.message);
  await jump('2026-10-06T11:00:30');
  await sleep(600);
  await jump('2026-10-06T15:00:30');
  await sleep(600);
  S.check('alert: later checks the same day send nothing more', alerts('disk', 'problem').length === 1, `${alerts('disk', 'problem').length}`);
  await jump('2026-10-07T10:00:30');
  await until(() => alerts('disk', 'problem').length === 2, 5000);
  S.check('alert: the next day sends one reminder', alerts('disk', 'problem').length === 2);
  disk({ total, other: Math.round(total * 0.78) - du(w.dataDir) });
  await jump('2026-10-07T11:00:30');
  await sleep(800);
  S.check('alert: between 75% and 80% it is still failing and quiet', alerts('disk', 'recovered').length === 0 && w.q1("SELECT failing FROM alert_state WHERE problem = 'disk'")?.failing === 1);
  disk({ total, other: Math.round(total * 0.6) - du(w.dataDir) });
  await jump('2026-10-07T12:00:30');
  const r = await until(() => alerts('disk', 'recovered')[0], 5000);
  S.check('alert: at 75% or less one "has room again" goes out', Boolean(r) && alerts('disk', 'recovered').length === 1 && /75% full or less/.test(r.message), r?.message);
  const list = (await w.api('GET', '/api/alerts')).json;
  S.check('alert: the Alerts card lists it as Data volume', JSON.stringify(list || {}).includes('Data volume'), JSON.stringify(list).slice(0, 300));
});

await S.step('alert: friends and the guest never see the volume', async () => {
  const own = (await w.api('GET', '/api/status')).json;
  const fr = (await w.api('GET', '/api/status', { as: friend })).json;
  const gu = (await w.api('GET', '/api/status', { as: GUEST })).json;
  S.check('alert: the owner\'s status carries the volume, database and backups', own?.disk && own.disk.total > 0 && own.disk.free >= 0 && own.disk.dbBytes > 0 && own.disk.backups.bytes > 0, JSON.stringify(own?.disk));
  const leak = (j) => ['disk', 'backup', 'data'].filter((k) => j && k in j);
  S.check('alert: a friend\'s status has no disk, backup or data fields', fr && !leak(fr).length, leak(fr).join());
  S.check('alert: the guest\'s status has no disk, backup or data fields', gu && !leak(gu).length, leak(gu).join());
  S.check('alert: a friend and the guest can\'t read the owner alerts', (await w.api('GET', '/api/alerts', { as: friend })).status === 403 && (await w.api('GET', '/api/alerts', { as: GUEST })).status === 403);
});

await w.close();
S.finish();
