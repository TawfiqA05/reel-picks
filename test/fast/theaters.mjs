// Theaters never give other people away. To a friend the app should look
// like it has two people in it: them and the owner.
//   ids:     a theater id from the caller is 1 to 10 digits everywhere, and
//            the showtime cache is cleared by plain-text prefix.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until, settled, PRELOAD } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('theaters');
const OWNER = null;
const ymd = (offset) => { const d = new Date(Date.parse(`${C.T0.slice(0, 10)}T12:00:00Z`) + offset * 864e5); return d.toISOString().slice(0, 10); };
const film = (k) => C.PLAYING.find((f) => f.k === k);

// Six more AMC theaters in the cached theater list (the list Settings
// searches), so there are more than eight to follow.
const MORE = [4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: String(9100 + n), name: `AMC Test Plaza ${n}`, longName: `AMC Test Plaza ${n}`, slug: `amc-test-plaza-${n}`, city: 'Testville', state: 'OH', address: '', lat: 41.2, lng: -81.5, utcOffset: null, timezone: null }));
function addTheaters(d) {
  const row = d.prepare("SELECT value FROM cache WHERE key = 'amc:theatres:all'").get();
  if (!row) throw new Error('the sample has no cached AMC theater list');
  d.prepare("UPDATE cache SET value = ? WHERE key = 'amc:theatres:all'").run(JSON.stringify([...JSON.parse(row.value), ...MORE]));
}

const ids = (as) => async (w) => {
  const s = (await w.api('GET', '/api/settings', { as })).json;
  return [String(s.theatreId), ...(s.extraTheatres || []).map((t) => String(t.id))];
};
const showtimePages = (w, like = 'amc:showtimes:v2:%') => w.q1('SELECT COUNT(*) AS n FROM cache WHERE key LIKE ?', like).n;

// ---------------------------------------------------------------- ids
{
  const w = S.world(await openWorld('theaters', { prepare: addTheaters }));
  const { robin: R, casey: K, jordan: J } = w.friends;
  const follow = (as, id, extra = {}) => w.api('POST', '/api/theatres/follow', { as, body: { id, name: `AMC Theater ${id}`, slug: `amc-theater-${id}`, ...extra } });
  const primary = (as, id, extra = {}) => w.api('POST', '/api/theatre', { as, body: { id, name: `AMC Theater ${id}`, slug: `amc-theater-${id}`, ...extra } });
  const lastRequest = async () => JSON.stringify((await w.api('GET', '/api/status')).json?.lastRefreshRequest ?? null);
  const refusals = [];
  const note = (r) => { if (r.status >= 400) refusals.push(r.json?.error || r.text); return r; };

  await S.step('ids: a theater id from the caller is 1 to 10 digits', async () => {
    const n0 = showtimePages(w);
    S.check('ids: setup: the sample has cached showtime pages', n0 > 0, `${n0}`);
    for (const [as, who] of [[R, 'a friend'], [OWNER, 'the owner']]) {
      for (const raw of ['%25', '_', '9_01', '9101%25', '%25%25', `${'9'.repeat(11)}`, 'abc']) {
        const r = await w.api('DELETE', `/api/theatres/follow/${raw}`, { as });
        S.check(`ids: ${who}: unfollow ${decodeURIComponent(raw)} is refused`, r.status === 400 && r.json?.error === 'That isn\'t an AMC theater id.', `${r.status} ${r.text.slice(0, 120)}`);
      }
      const p = await w.api('POST', '/api/theatres/primary', { as, body: { id: '%' } });
      S.check(`ids: ${who}: make primary % is refused`, p.status === 400 && p.json?.error === 'That isn\'t an AMC theater id.', `${p.status} ${p.text.slice(0, 120)}`);
    }
    S.check('ids: no cached showtime page was cleared', showtimePages(w) === n0, `${showtimePages(w)} of ${n0}`);
  });

  await S.step('ids: the showtime cache is cleared by plain-text prefix', async () => {
    // cache.js bustCache, run in a child on a copy of this world's database.
    const dir = path.join(w.dir, 'bust');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'reelpicks.db');
    const src = new DatabaseSync(w.dbFile, { readOnly: true });
    try { src.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } finally { src.close(); }
    // Pages of its own for two theaters, whatever the steps above did.
    const seed = new DatabaseSync(file);
    try {
      for (const t of ['9101', '9102']) for (const day of ['2099-01-01', '2099-01-02']) seed.prepare("INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?, '[]', ?, 86400)").run(`amc:showtimes:v2:${t}:${day}`, new Date(C.T0_MS).toISOString());
    } finally { seed.close(); }
    const count = (like) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare('SELECT COUNT(*) AS n FROM cache WHERE key LIKE ?').get(like).n; } finally { d.close(); } };
    const n9101 = count('amc:showtimes:v2:9101:%');
    const bust = (prefix) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${PRELOAD}`, '--input-type=module', '-e',
      "const { bustCache } = await import('./server/lib/cache.js'); bustCache(process.argv[1]); process.exit(0);", prefix], {
      cwd: w.app, encoding: 'utf8', timeout: 60000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: C.TZ, DATA_DIR: dir, RP_FAKE_NOW: C.T0, OWNER_NAME: C.OWNER_NAME },
    });
    const r1 = bust('amc:showtimes:v2:9_01:');
    S.check('ids: bustCache ran', r1.status === 0, (r1.stderr || r1.stdout || '').slice(-300));
    S.check('ids: a prefix with _ clears nothing it only looks like', n9101 > 0 && count('amc:showtimes:v2:9101:%') === n9101, `${count('amc:showtimes:v2:9101:%')} of ${n9101}`);
    bust('amc:showtimes:v2:%');
    S.check('ids: a prefix with % clears nothing it only looks like', count('amc:showtimes:v2:9101:%') === n9101, `${count('amc:showtimes:v2:9101:%')} of ${n9101}`);
    bust('amc:showtimes:v2:9101:');
    S.check('ids: the real prefix still clears that theater\'s pages', count('amc:showtimes:v2:9101:%') === 0 && count('amc:showtimes:v2:9102:%') > 0, `${count('amc:showtimes:v2:9101:%')} ${count('amc:showtimes:v2:9102:%')}`);
  });

  await S.step('ids: the owner\'s setup import skips theater ids that aren\'t digits', async () => {
    const before = (await w.api('GET', '/api/settings')).json;
    const doc = { kind: 'reelpicks-state', version: 1, profile: { settings: { theatreId: '%', extraTheatres: [{ id: '_', name: 'x', slug: 'x' }] } } };
    const r = await w.api('POST', '/api/state', { body: doc });
    const after = (await w.api('GET', '/api/settings')).json;
    S.check('ids: the import answers', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    S.check('ids: it skips both theater keys', ['theatreId', 'extraTheatres'].every((k) => r.json?.imported?.settingsSkipped?.includes(k)), JSON.stringify(r.json?.imported?.settingsSkipped));
    S.check('ids: the owner\'s theaters are as they were', after.theatreId === before.theatreId && JSON.stringify(after.extraTheatres) === JSON.stringify(before.extraTheatres), JSON.stringify([after.theatreId, (after.extraTheatres || []).map((t) => t.id)]));
  });

  await w.close();
}

S.finish();
