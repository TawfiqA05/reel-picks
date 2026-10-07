// Theaters never give other people away. To a friend the app should look
// like it has two people in it: them and the owner.
//   follow:  what anyone may follow depends only on their own list (the owner
//            5, a friend 3, no cap across everyone); only theaters in AMC's
//            own list, under AMC's name; every friend theater change queues
//            the same ordinary refresh, followed by others or not.
//   revoke:  revoking a friend clears the data of a theater nobody follows
//            now (showtimes, cached pages, the playing flag), and showtimes
//            at a theater nobody follows are never filed under anyone's
//            primary.
//   coming:  Coming Soon, search and the movie page work out "coming soon"
//            and "playing" from the caller's own theaters.
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

// ---------------------------------------------------------------- follow and ids
{
  const w = S.world(await openWorld('theaters', { prepare: addTheaters }));
  const { robin: R, casey: K, jordan: J } = w.friends;
  const follow = (as, id, extra = {}) => w.api('POST', '/api/theatres/follow', { as, body: { id, name: `AMC Theater ${id}`, slug: `amc-theater-${id}`, ...extra } });
  const primary = (as, id, extra = {}) => w.api('POST', '/api/theatre', { as, body: { id, name: `AMC Theater ${id}`, slug: `amc-theater-${id}`, ...extra } });
  const lastRequest = async () => JSON.stringify((await w.api('GET', '/api/status')).json?.lastRefreshRequest ?? null);
  const refusals = [];
  const note = (r) => { if (r.status >= 400) refusals.push(r.json?.error || r.text); return r; };

  await S.step('follow: a friend theater change queues the same ordinary refresh, followed by others or not', async () => {
    let before = await lastRequest();
    const shared = note(await follow(J, '9102'));
    let after = await lastRequest();
    S.check('follow: setup: a friend follows a theater the owner follows', shared.status === 200, `${shared.status} ${shared.text.slice(0, 120)}`);
    S.check('follow: following a theater someone else follows queues a refresh', after !== before, after);
    const reqShared = JSON.parse(after);
    before = after;
    note(await follow(J, '9103'));
    after = await lastRequest();
    S.check('follow: following a theater nobody follows queues a refresh', after !== before, after);
    const reqNew = JSON.parse(after);
    S.check('follow: both are ordinary refreshes, never forced, with the same reason', reqShared?.force === false && reqNew?.force === false && reqShared.reason === reqNew.reason, JSON.stringify([reqShared, reqNew]));
    before = after;
    const p = note(await primary(J, '9102'));
    after = await lastRequest();
    S.check('follow: Set primary to a theater someone else follows queues the same refresh', p.status === 200 && after !== before && JSON.parse(after).force === false && JSON.parse(after).reason === reqNew.reason, `${p.status} ${after}`);
    // Back to how the sample had it: 9101 primary, nothing else.
    await primary(J, '9101');
    for (const t of ['9102', '9103']) await w.api('DELETE', `/api/theatres/follow/${t}`, { as: J });
  });

  await S.step('follow: what a friend may follow depends only on their own list', async () => {
    await w.api('DELETE', '/api/theatres/follow/9101', { as: K });
    S.check('follow: setup: casey follows 9102 only', JSON.stringify(await ids(K)(w)) === '["9102"]', JSON.stringify(await ids(K)(w)));
    // Nine theaters followed across everyone: more than the old cap of eight.
    for (const t of ['9103', '9104', '9105']) S.check(`follow: setup: the owner follows ${t}`, note(await follow(OWNER, t)).status === 200);
    for (const t of ['9106', '9107']) S.check(`follow: setup: a friend follows ${t}`, note(await follow(R, t)).status === 200);
    S.check('follow: setup: a third friend follows 9108', note(await follow(J, '9108')).status === 200);
    const taken = note(await follow(K, '9104'));
    const fresh = note(await follow(K, '9109'));
    S.check('follow: a friend can follow a theater someone else follows', taken.status === 200, `${taken.status} ${taken.text.slice(0, 160)}`);
    S.check('follow: and one nobody follows, the same way', fresh.status === 200, `${fresh.status} ${fresh.text.slice(0, 160)}`);
    const st = (await w.api('GET', '/api/status')).json;
    S.check('follow: every theater anyone follows is in the refresh (nine, no cap of eight)', st?.sharedTheatres === 9, `${st?.sharedTheatres}`);
    // At three, a theater someone follows and one nobody follows get the same answer.
    const a = note(await follow(K, '9105'));
    const b = note(await follow(K, '9110'));
    S.check('follow: a friend stops at three theaters', a.status === 400 && a.json?.error === 'You can follow up to 3 theaters (primary + 2). Remove one first.', `${a.status} ${a.text.slice(0, 160)}`);
    S.check('follow: with the same answer for a theater nobody follows', b.status === a.status && b.json?.error === a.json?.error, `${b.status} ${b.text.slice(0, 160)}`);
    const sp = note(await primary(K, '9110'));
    S.check('follow: Set primary that would make four says so, with AMC\'s name', sp.status === 400 && sp.json?.error === 'Making AMC Test Plaza 10 primary would mean following 4 theaters (max 3). Remove one first.', `${sp.status} ${sp.text.slice(0, 160)}`);
    S.check('follow: the refusals left the friend\'s theaters as they were', JSON.stringify(await ids(K)(w)) === JSON.stringify(['9102', '9104', '9109']), JSON.stringify(await ids(K)(w)));
    const o = note(await follow(OWNER, '9106'));
    S.check('follow: the owner still stops at five', o.status === 400 && o.json?.error === 'You can follow up to 5 theaters (primary + 4). Remove one first.', `${o.status} ${o.text.slice(0, 160)}`);
    const fs1 = (await w.api('GET', '/api/status', { as: K })).json;
    const os1 = (await w.api('GET', '/api/status')).json;
    S.check('follow: status tells a friend 3 and the owner 5', fs1?.maxTheatres === 3 && os1?.maxTheatres === 5, `${fs1?.maxTheatres} ${os1?.maxTheatres}`);
  });

  await S.step('follow: only theaters in AMC\'s own list, under AMC\'s name', async () => {
    await w.api('DELETE', '/api/theatres/follow/9108', { as: J });
    const before = await ids(J)(w);
    const f = note(await follow(J, '424242', { name: 'Made Up Cinema 9' }));
    S.check('follow: an id outside AMC\'s list is refused', f.status === 400 && f.json?.error === 'That isn\'t a theater in AMC\'s list. Pick one from the search.', `${f.status} ${f.text.slice(0, 160)}`);
    const p = note(await primary(J, '424242', { name: 'Made Up Cinema 9' }));
    S.check('follow: and so is Set primary to one', p.status === 400 && p.json?.error === 'That isn\'t a theater in AMC\'s list. Pick one from the search.', `${p.status} ${p.text.slice(0, 160)}`);
    S.check('follow: neither changed the friend\'s theaters', JSON.stringify(await ids(J)(w)) === JSON.stringify(before), JSON.stringify(await ids(J)(w)));
    const ok = note(await follow(J, '9110', { name: 'Totally Real Theater', slug: 'evil-slug' }));
    const s = (await w.api('GET', '/api/settings', { as: J })).json;
    const t = (s?.extraTheatres || []).find((x) => String(x.id) === '9110');
    S.check('follow: the stored name and slug are AMC\'s, not the caller\'s', ok.status === 200 && t?.name === 'AMC Test Plaza 10' && t?.slug === 'amc-test-plaza-10', JSON.stringify(t));
    const pp = note(await primary(J, '9103', { name: 'Not Its Name', slug: 'nope' }));
    const s2 = (await w.api('GET', '/api/settings', { as: J })).json;
    S.check('follow: Set primary stores AMC\'s name and slug too', pp.status === 200 && s2?.theatreName === 'AMC Lakeview 16' && s2?.theatreSlug === 'amc-lakeview-16', `${pp.status} ${s2?.theatreName} ${s2?.theatreSlug}`);
    await primary(J, '9101');
    for (const id of ['9103', '9110']) await w.api('DELETE', `/api/theatres/follow/${id}`, { as: J });
  });

  await S.step('follow: no refusal speaks of anyone else', async () => {
    S.check('follow: refusals were collected', refusals.length >= 5, `${refusals.length}`);
    const bad = refusals.filter((m) => /everyone|already followed|someone|other people|across|friend|shared/i.test(String(m)));
    S.check('follow: no refusal mentions other people or what they follow', !bad.length, bad.slice(0, 3).join(' | '));
  });

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

  await S.step('follow: AMC unreachable', async () => {
    const saved = w.q1("SELECT value FROM cache WHERE key = 'amc:theatres:all'").value;
    w.q("DELETE FROM cache WHERE key = 'amc:theatres:all'");
    w.amc.mode = '500';
    const before = await ids(J)(w);
    const r = await follow(J, '9103');
    w.amc.mode = 'ok';
    w.q("INSERT INTO cache(key, value, fetched_at, ttl) VALUES('amc:theatres:all', ?, ?, ?)", saved, new Date(C.T0_MS).toISOString(), 30 * 86400);
    S.check('follow: AMC down and no saved list: the follow says so', r.status === 502 && r.json?.error === 'Couldn\'t reach AMC to check that theater. Try again in a bit.', `${r.status} ${r.text.slice(0, 160)}`);
    S.check('follow: and changes nothing', JSON.stringify(await ids(J)(w)) === JSON.stringify(before), JSON.stringify(await ids(J)(w)));
  });
  await w.close();
}

// ---------------------------------------------------------------- revoke
{
  // Showtimes for a film nobody else has: at 9103, which only a new friend
  // follows, and at 9199, which nobody has ever followed.
  let X = null; let Y = null;
  const w = S.world(await openWorld('theaters-revoke', {
    prepare(d) {
      // Two coming-soon films nobody has rated or saved, made to play there.
      [X, Y] = [970002, 970003].filter((id) => d.prepare('SELECT 1 AS x FROM movies WHERE tmdb_id = ?').get(id));
      const tpl = d.prepare("SELECT * FROM showtimes WHERE theatre_id = '9101' AND tmdb_id = ? ORDER BY start_epoch LIMIT 1").get(film(1).id);
      const ins = d.prepare('INSERT INTO showtimes(id, amc_movie_id, tmdb_id, theatre_id, date, start_local, start_epoch, is_imax, is_advance, format, runtime_min, attributes, purchase_url, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const [tid, id] of [['9103', X], ['9199', Y]]) {
        for (let i = 0; i < 14; i++) {
          const day = ymd(i);
          const start = `${day}T19:00:00`;
          ins.run(`rp-test-${tid}-${day}`, null, id, tid, day, start, Date.parse(`${start}-04:00`), 0, 0, 'Standard', 110, '[]', tpl.purchase_url, tpl.fetched_at);
        }
        d.prepare("UPDATE movies SET playing = 1, playing_source = 'amc', upcoming = 0 WHERE tmdb_id = ?").run(id);
      }
      d.prepare("INSERT INTO cache(key, value, fetched_at, ttl) VALUES(?, '[]', ?, 86400)").run(`amc:showtimes:v2:9103:${ymd(0)}`, tpl.fetched_at);
    },
  }));
  const { robin: R } = w.friends;
  const inPicks = async (as, id) => { const r = (await w.api('GET', '/api/recommendations', { as })).json; return [...(r.list || []), ...(r.alsoNearby || [])].some((e) => e.tmdb_id === id); };

  await S.step('revoke: showtimes at a theater nobody follows are never filed under a primary', async () => {
    for (const [as, who] of [[OWNER, 'the owner'], [R, 'a friend'], [w.GUEST, 'the guest']]) {
      S.check(`revoke: ${who}: a film showing only at a theater nobody follows isn't in Picks`, !await inPicks(as, Y));
      const m = (await w.api('GET', `/api/movies/${Y}`, { as })).json;
      S.check(`revoke: ${who}: its movie page lists no showtimes`, m && !(m.showtimesByTheatre || []).length && !(m.showtimesByDay || []).length, JSON.stringify((m?.showtimesByTheatre || []).map((x) => x.theatre?.id)));
    }
  });
  await S.step('revoke: a revoked friend\'s theater leaves nobody\'s Picks', async () => {
    S.check('revoke: setup: two spare films', X && Y, JSON.stringify([X, Y]));
    const drew = await makeFriend(w.base, 'Drew');
    const set = await w.api('POST', '/api/theatre', { as: drew, body: { id: '9103', name: 'AMC Lakeview 16', slug: 'amc-lakeview-16' } });
    S.check('revoke: setup: the new friend makes 9103 their primary', set.status === 200, `${set.status} ${set.text.slice(0, 120)}`);
    S.check('revoke: setup: the friend sees the film at their theater', await inPicks(drew, X));
    S.check('revoke: before: the owner doesn\'t', !await inPicks(OWNER, X));
    const rv = await w.api('POST', `/api/friends/${drew.id}/revoke`, { body: {} });
    S.check('revoke: setup: the revoke answers', rv.status === 200, `${rv.status}`);
    S.check('revoke: its showtimes are gone', w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE theatre_id = '9103'").n === 0, `${w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE theatre_id = '9103'").n}`);
    S.check('revoke: its cached showtime pages are gone', showtimePages(w, 'amc:showtimes:v2:9103:%') === 0, `${showtimePages(w, 'amc:showtimes:v2:9103:%')}`);
    S.check('revoke: a film that played only there is no longer flagged playing', w.q1('SELECT playing FROM movies WHERE tmdb_id = ?', X).playing === 0);
    S.check('revoke: the other theaters keep their showtimes', w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE theatre_id IN ('9101', '9102')").n > 0);
    for (const [as, who] of [[OWNER, 'the owner'], [R, 'a friend'], [w.GUEST, 'the guest']]) {
      S.check(`revoke: after: ${who} doesn't get the film in Picks`, !await inPicks(as, X));
      const m = (await w.api('GET', `/api/movies/${X}`, { as })).json;
      S.check(`revoke: after: ${who}'s movie page lists no showtimes for it`, m && !(m.showtimesByTheatre || []).length && !(m.showtimesByDay || []).length, JSON.stringify((m?.showtimesByTheatre || []).map((x) => x.theatre?.id)));
    }
  });

  await w.close();
}

// ---------------------------------------------------------------- coming soon
{
  // The refresh runs here (the made-up AMC), so each version of the app
  // works its own flags out. TMDB's upcoming list also names a film that
  // plays only at 9101.
  const k9 = film(9);
  const w = S.world(await openWorld('theaters-coming', {
    refresh: true,
    prepare(d) {
      const row = d.prepare("SELECT value FROM cache WHERE key = 'tmdb:upcoming:1'").get();
      if (!row) throw new Error('the sample has no cached TMDB upcoming list');
      const v = JSON.parse(row.value);
      v.results = [...(v.results || []), C.light(k9)];
      d.prepare("UPDATE cache SET value = ? WHERE key = 'tmdb:upcoming:1'").run(JSON.stringify(v));
    },
  }));
  const { robin: R, casey: K } = w.friends; // robin follows 9101, casey 9102
  const refreshed = async () => {
    const before = (await w.api('GET', '/api/status')).json?.lastRefresh;
    const r = await w.api('POST', '/api/refresh', { body: {} });
    if (r.status !== 200) throw new Error(`refresh: ${r.status}`);
    const done = await until(async () => { const s = (await w.api('GET', '/api/status')).json; return s && !s.refreshing && s.lastRefresh && s.lastRefresh !== before && s; }, 60000, 200);
    if (!done) throw new Error('the refresh did not finish');
    await settled(w.base);
  };
  const coming = async (as) => ((await w.api('GET', '/api/coming-soon', { as })).json?.list || []).map((e) => e.tmdb_id);
  const page = async (as, id) => (await w.api('GET', `/api/movies/${id}`, { as })).json;

  await S.step('follow: a friend\'s theater change runs a refresh that locks no one\'s four', async () => {
    const eve = await makeFriend(w.base, 'Eve');
    const before = (await w.api('GET', '/api/status')).json?.lastRefresh;
    const set = await w.api('POST', '/api/theatre', { as: eve, body: { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8' } });
    S.check('follow: setup: a new friend picks a theater the owner follows', set.status === 200, `${set.status} ${set.text.slice(0, 120)}`);
    const done = await until(async () => { const s = (await w.api('GET', '/api/status')).json; return s && !s.refreshing && s.lastRefresh && s.lastRefresh !== before && s; }, 30000, 200);
    S.check('follow: that runs a refresh, as a theater nobody follows would', Boolean(done));
    await settled(w.base);
    S.check('follow: the refresh locked no four: the new friend has none yet', !w.q1('SELECT 1 AS x FROM weekly4_lock WHERE user_id = ?', eve.id));
    await w.api('GET', '/api/recommendations', { as: eve });
    S.check('follow: their four locks when they first open Picks', w.q1('SELECT how FROM weekly4_lock WHERE user_id = ?', eve.id)?.how === 'first-view', JSON.stringify(w.q1('SELECT how FROM weekly4_lock WHERE user_id = ?', eve.id)));
  });

  await S.step('coming: a film playing only at someone else\'s theater stays coming soon', async () => {
    // The sample's Set primary kept the owner's 9101 for casey: 9102 only now.
    await w.api('DELETE', '/api/theatres/follow/9101', { as: K });
    S.check('coming: setup: casey follows 9102 only', JSON.stringify(await ids(K)(w)) === '["9102"]', JSON.stringify(await ids(K)(w)));
    await refreshed();
    S.check('coming: setup: the film plays this week at 9101 only', w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE tmdb_id = ? AND theatre_id = '9102'", k9.id).n === 0 && w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE tmdb_id = ? AND theatre_id = '9101'", k9.id).n > 0);
    S.check('coming: a friend at 9102 has it in Coming Soon', (await coming(K)).includes(k9.id), JSON.stringify(await coming(K)));
    const pk = await page(K, k9.id);
    S.check('coming: their movie page says coming soon, not playing', pk?.upcoming === true && pk?.playing === false, JSON.stringify([pk?.upcoming, pk?.playing]));
    S.check('coming: a friend at 9101 doesn\'t: it\'s playing for them', !(await coming(R)).includes(k9.id));
    const pr = await page(R, k9.id);
    S.check('coming: their movie page says playing, not coming soon', pr?.upcoming === false && pr?.playing === true, JSON.stringify([pr?.upcoming, pr?.playing]));
    S.check('coming: nor does the owner (9101 and 9102)', !(await coming(OWNER)).includes(k9.id));
  });

  await S.step('coming: advance showtimes at someone else\'s theater put nothing in Coming Soon', async () => {
    // Nothing this week anywhere: every showtime left is an advance one.
    w.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes:%'");
    for (let i = 0; i < 7; i++) w.amc.missing.add(ymd(i));
    await refreshed();
    const only9101 = C.PLAYING.filter((f) => f !== k9 && f.at[9101] && !f.at[9102] && f.at[9101].some((s) => s.days.some((d) => d >= 7))).map((f) => f.id);
    const at9102 = C.PLAYING.filter((f) => f.at[9102] && f.at[9102].some((s) => s.days.some((d) => d >= 7))).map((f) => f.id);
    S.check('coming: setup: films with advance showtimes only at 9101, and some at 9102', only9101.length >= 3 && at9102.length >= 3 && w.q1("SELECT COUNT(*) AS n FROM showtimes WHERE date <= ?", ymd(6)).n === 0, JSON.stringify([only9101.length, at9102.length]));
    const k = await coming(K);
    S.check('coming: a friend at 9102 gets none of the films booked only at 9101', !only9101.some((id) => k.includes(id)), JSON.stringify(only9101.filter((id) => k.includes(id))));
    S.check('coming: and does get the ones booked at 9102', at9102.every((id) => k.includes(id)), JSON.stringify(at9102.filter((id) => !k.includes(id))));
    const r = await coming(R);
    S.check('coming: a friend at 9101 gets the films booked there', only9101.every((id) => r.includes(id)), JSON.stringify(only9101.filter((id) => !r.includes(id))));
    const p = await page(K, only9101[0]);
    S.check('coming: the 9102 friend\'s movie page doesn\'t call it coming soon', p && p.upcoming === false && p.playing === false, JSON.stringify([p?.upcoming, p?.playing]));
    // Search with TMDB down answers from the films the app holds for this
    // person: a film booked only at someone else's theater isn't one of them.
    w.ctrl.tmdb = 'down'; w.writeCtrl();
    const title = C.PLAYING.find((f) => f.id === only9101[0]).title;
    const sk = (await w.api('GET', `/api/search?q=${encodeURIComponent(title)}`, { as: K })).json;
    const sr = (await w.api('GET', `/api/search?q=${encodeURIComponent(title)}`, { as: R })).json;
    w.ctrl.tmdb = 'ok'; w.writeCtrl();
    S.check('coming: search: the 9101 friend finds it with TMDB down (control)', (sr?.results || []).some((x) => x.tmdb_id === only9101[0]), JSON.stringify((sr?.results || []).map((x) => x.tmdb_id)));
    S.check('coming: search: the 9102 friend doesn\'t get it from someone else\'s bookings', !(sk?.results || []).some((x) => x.tmdb_id === only9101[0]), JSON.stringify((sk?.results || []).map((x) => x.tmdb_id)));
  });
  await w.close();
}
S.finish();
