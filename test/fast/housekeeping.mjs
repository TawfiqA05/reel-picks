// Cache cleanup after the nightly backup (old D5): right after the 3am backup
// succeeds, and only then, cache rows more than 3x past their lifetime are
// deleted and nothing outside the cache table changes; the backup still holds
// them; a one-time VACUUM follows the first cleanup and never runs again; a
// failed backup deletes nothing; a restart the same night cleans nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep } from '../lib/world.mjs';

const S = suite('housekeeping');
const at = (local) => `${local}-04:00`;
// The first start is before 3am, so no backup is due yet; the sample
// database's one-time VACUUM is forgotten so this world does its own.
const w = S.world(await openWorld('housekeeping', {
  env: { RP_FAKE_NOW: at('2026-10-02T01:00:00') },
  prepare: (d) => d.exec("DELETE FROM settings WHERE key = 'cacheVacuumedAt'"),
}));
const BK = path.join(w.dataDir, 'backups');
const PROTECTED = ['ratings', 'watchlist', 'watched', 'hidden_movies', 'users', 'user_settings', 'weekly4_log', 'owner_alerts', 'alert_state', 'push_subs', 'push_sent',
  'search_recents', 'movies', 'showtimes', 'matches', 'departures', 'lineup_snapshots', 'home_picks', 'letterboxd_seen', 'unmatched_ratings'];
const VOLATILE = new Set(['cacheVacuumedAt']);

function snapshot() {
  const d = new DatabaseSync(w.dbFile, { readOnly: true });
  try {
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const out = {};
    for (const t of PROTECTED) if (tables.has(t)) out[t] = crypto.createHash('sha256').update(JSON.stringify(d.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all())).digest('hex');
    out.settings = crypto.createHash('sha256').update(JSON.stringify(d.prepare('SELECT * FROM settings ORDER BY key').all().filter((r) => !VOLATILE.has(r.key)))).digest('hex');
    out.cache = new Map(d.prepare('SELECT key, fetched_at, ttl, length(value) n FROM cache').all().map((r) => [r.key, r]));
    out.pages = d.prepare('PRAGMA page_count').get().page_count;
    return out;
  } finally { d.close(); }
}
const deadAt = (row, nowMs) => row.ttl != null && row.ttl > 0 && (nowMs - Date.parse(row.fetched_at)) / 1000 > 3 * row.ttl;
function plant(rows) {
  const d = w.db();
  const ins = d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?,?,?,?)');
  for (const r of rows) ins.run(r.key, 'x'.repeat(r.bytes || 10), new Date(at(r.fetched)).toISOString(), r.ttl);
  d.close();
}
const log = () => w.srv.log();

await S.step('the first start, before 3am, takes no backup', async () => {
  await sleep(1500);
  S.check('no backup before 3am', !fs.existsSync(BK) || !fs.readdirSync(BK).some((f) => f.endsWith('.db')), fs.existsSync(BK) ? fs.readdirSync(BK).join(', ') : '');
  await w.srv.stop();
});

await S.step('night 1: backup, then exactly the long-dead rows go, then one VACUUM', async () => {
  plant([
    { key: 'test:dead-4d', fetched: '2026-09-28T03:00:00', ttl: 86400 },
    { key: 'test:edge-2.9d', fetched: '2026-09-29T06:00:00', ttl: 86400 },
    { key: 'test:fresh', fetched: '2026-10-02T02:00:00', ttl: 86400 },
    { key: 'test:long-100d', fetched: '2026-06-24T03:00:00', ttl: 31536000 },
    { key: 'test:nottl', fetched: '2020-01-01T00:00:00', ttl: null },
    { key: 'test:big-dead', fetched: '2026-01-01T00:00:00', ttl: 86400, bytes: 4_000_000 },
  ]);
  const before = snapshot();
  const night = Date.parse(at('2026-10-02T03:01:00'));
  const expectDead = [...before.cache.values()].filter((r) => deadAt(r, night)).map((r) => r.key).sort();
  const sizeBefore = fs.statSync(w.dbFile).size;
  await w.restart({ fakeNow: at('2026-10-02T03:01:00') });
  const done = await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-10-02.db')) && /\[housekeeping\] VACUUM/.test(log()), 30000);
  S.check('night 1: the nightly backup ran once', Boolean(done) && (log().match(/\[backup\] ✓ reelpicks-2026-10-02\.db/g) || []).length === 1);
  const after = snapshot();
  const gone = [...before.cache.keys()].filter((k) => !after.cache.has(k)).sort();
  S.check('night 1: exactly the rows more than 3x past their lifetime were deleted', JSON.stringify(gone) === JSON.stringify(expectDead) && expectDead.includes('test:dead-4d') && expectDead.includes('test:big-dead'), `${gone.length} deleted, ${expectDead.length} expected`);
  S.check('night 1: rows at 2.9x, fresh, long-lived and TTL-less rows were kept', ['test:edge-2.9d', 'test:fresh', 'test:long-100d', 'test:nottl'].every((k) => after.cache.has(k)));
  const touched = [...after.cache].filter(([k, r]) => { const b = before.cache.get(k); return b && (b.fetched_at !== r.fetched_at || b.n !== r.n); }).map(([k]) => k);
  S.check('night 1: every kept cache row is unchanged, apart from what start-up refetched', touched.every((k) => !k.startsWith('test:') && Date.parse(after.cache.get(k).fetched_at) >= night - 60e3), touched.slice(0, 5).join(', '));
  S.check('night 1: no row that should stay was lost', [...before.cache.keys()].filter((k) => !expectDead.includes(k)).every((k) => after.cache.has(k)));
  const changed = [...PROTECTED, 'settings'].filter((t) => before[t] !== after[t]);
  S.check('night 1: no other table changed', changed.length === 0, changed.join(', '));
  const bk = new DatabaseSync(path.join(BK, 'reelpicks-2026-10-02.db'), { readOnly: true });
  const inBackup = bk.prepare("SELECT COUNT(*) n FROM cache WHERE key IN ('test:dead-4d', 'test:big-dead')").get().n;
  bk.close();
  S.check('night 1: the backup was taken before the cleanup (it still holds the dead rows)', inBackup === 2);
  S.check('night 1: the one-time VACUUM ran and the file shrank', (log().match(/\[housekeeping\] VACUUM/g) || []).length === 1 && after.pages < before.pages && fs.statSync(w.dbFile).size < sizeBefore,
    `${(sizeBefore / 1048576).toFixed(1)} MB to ${(fs.statSync(w.dbFile).size / 1048576).toFixed(1)} MB`);
  S.check('night 1: the VACUUM is remembered', Boolean(w.q1("SELECT value FROM settings WHERE key = 'cacheVacuumedAt'")));
  await w.srv.stop();
});

await S.step('night 2: newly dead rows go, no second VACUUM', async () => {
  plant([{ key: 'test:dead-night2', fetched: '2026-09-29T00:00:00', ttl: 86400 }, { key: 'test:big-dead-2', fetched: '2026-01-01T00:00:00', ttl: 86400, bytes: 2_000_000 }]);
  const before = snapshot();
  await w.restart({ fakeNow: at('2026-10-03T03:01:00') });
  await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-10-03.db')) && /\[housekeeping\] cache/.test(log()), 30000);
  await sleep(1500);
  const after = snapshot();
  S.check('night 2: the newly dead rows were deleted', !after.cache.has('test:dead-night2') && !after.cache.has('test:big-dead-2'));
  S.check('night 2: no second VACUUM (the freed pages stay free)', !/\[housekeeping\] VACUUM/.test(log()) && after.pages === before.pages, `pages ${before.pages} to ${after.pages}`);
  S.check('night 2: other tables unchanged', [...PROTECTED, 'settings'].every((t) => before[t] === after[t]));
  await w.srv.stop();
});

await S.step('night 3: a failed backup deletes nothing', async () => {
  plant([{ key: 'test:dead-night3', fetched: '2026-09-29T00:00:00', ttl: 86400 }]);
  fs.chmodSync(BK, 0o555);
  try {
    const before = snapshot();
    await w.restart({ fakeNow: at('2026-10-04T03:01:00') });
    await until(() => /\[backup\] ✗/.test(log()), 20000);
    await sleep(1500);
    const after = snapshot();
    S.check('night 3: the backup failed', /\[backup\] ✗ reelpicks-2026-10-04\.db/.test(log()));
    S.check('night 3: so no cache row was deleted', after.cache.size === before.cache.size && after.cache.has('test:dead-night3') && !/\[housekeeping\] cache/.test(log()));
    await w.srv.stop();
  } finally { fs.chmodSync(BK, 0o755); }
});

await S.step('a restart the same night after a good backup cleans nothing', async () => {
  await w.restart({ fakeNow: at('2026-10-03T05:00:00') });
  await sleep(2000);
  S.check('a restart after that night\'s backup runs no cleanup', !/\[housekeeping\]/.test(log()) && w.q1("SELECT COUNT(*) n FROM cache WHERE key = 'test:dead-night3'").n === 1);
});

await w.close();
S.finish();
