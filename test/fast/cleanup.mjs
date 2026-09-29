// The cleanup fixes (run #10), one step each. Each step names what it proves
// in its title; every check in it failed before the fix and passes after.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep } from '../lib/world.mjs';
import { serve } from '../lib/mocks.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('cleanup');
const { check, step } = S;
const status = async (w) => (await w.api('GET', '/api/status')).json;
const lbCsv = (rows) => ['Date,Name,Year,Letterboxd URI,Rating', ...rows.map((r, i) => `2024-01-01,"${r.title}",${r.year},https://boxd.it/c${i},${r.rating}`)].join('\n');
// The most calls that landed in any one second.
const busiestSecond = (times) => {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
};
const tableHash = (d, t) => crypto.createHash('sha256').update(JSON.stringify(d.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all())).digest('hex');

await step('throttle: the import matcher waits for the shared TMDB throttle', async () => {
  const w = S.world(await openWorld('cleanup-throttle'));
  try {
    // Titles nobody has searched for, so every search is a live call (two
    // each: with the year, then without).
    const rows = Array.from({ length: 16 }, (_, i) => ({ title: `Qqzx Throttle Nonfilm ${i + 1}`, year: 1990 + i, rating: 3 }));
    const since = Date.now();
    const before = (await status(w)).lastDrain?.finishedAt || null;
    const r = await w.api('POST', '/api/ratings/import', { body: { csv: lbCsv(rows) } });
    check('throttle: the import is queued for matching', r.status === 200 && r.json?.received === 16, `${r.status} ${r.text.slice(0, 200)}`);
    const done = await until(async () => { const s = await status(w); return s && !s.matching && (s.lastDrain?.finishedAt || null) !== before && s; }, 60000, 150);
    check('throttle: the matching run finished', Boolean(done));
    const times = w.net().filter((e) => e.path === '/3/search/movie' && e.at >= since).map((e) => e.at).sort((a, b) => a - b);
    check('throttle: every title was searched live', times.length >= 32, String(times.length));
    const most = busiestSecond(times);
    check('throttle: at most 4 live TMDB searches in any second while an import drains', most <= 4, `${most} in one second (${times.length} calls over ${times.length ? times[times.length - 1] - times[0] : 0} ms)`);
  } finally { await w.close(); }
});

await step('backfill: films already tried can\'t crowd out the ones after them', async () => {
  // 21 rated films whose cached TMDB answer never fills them in (it describes
  // another film), all with lower ids than three films really waiting.
  const stuck = Array.from({ length: 21 }, (_, i) => 101 + i);
  const waiting = C.RATED.slice(0, 3).map((f) => f.id);
  const w = S.world(await openWorld('cleanup-backfill', {
    prepare: (d) => {
      const now = new Date(C.BUILD_AT).toISOString();
      for (const id of stuck) {
        d.prepare('INSERT INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at) VALUES(1,?,?,2001,3,?,?,?)').run(id, `Stuck ${id}`, 'letterboxd', now, now);
        d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?,?,?,?)').run(`tmdb:movie:${id}`, JSON.stringify({ id: 1, title: 'Somewhere Else' }), now, 7 * 86400);
      }
      for (const id of waiting) d.prepare('UPDATE movies SET details_at = NULL WHERE tmdb_id = ?').run(id);
    },
  }));
  try {
    const filled = () => w.q(`SELECT COUNT(*) n FROM movies WHERE tmdb_id IN (${waiting.join(',')}) AND details_at IS NOT NULL`)[0].n;
    // The start-up run.
    const ran = await until(async () => { const s = await status(w); return s?.creditsBackfill?.finishedAt && !s.creditsBackfill.running && s; }, 60000, 200);
    check('backfill: the start-up run finished', Boolean(ran));
    check('backfill: one run fills every film really waiting, past 21 that stay stuck', filled() === waiting.length, `${filled()} of ${waiting.length}`);
    check('backfill: the stuck films are still waiting (their answer describes another film)', w.q(`SELECT COUNT(*) n FROM movies WHERE tmdb_id IN (${stuck.join(',')}) AND details_at IS NOT NULL`)[0].n === 0);

    // A run stopped by TMDB trouble picks up at the next trigger.
    await w.srv.stop();
    { const d = w.db(); d.prepare(`UPDATE movies SET details_at = NULL WHERE tmdb_id IN (${waiting.join(',')})`).run(); d.prepare(`DELETE FROM cache WHERE key IN (${waiting.map((id) => `'tmdb:movie:${id}'`).join(',')})`).run(); d.close(); }
    w.ctrl.tmdb = 'down'; w.writeCtrl();
    await w.restart();
    await until(async () => { const s = await status(w); return s?.creditsBackfill?.finishedAt && !s.creditsBackfill.running && s; }, 60000, 200);
    check('backfill: with TMDB down the run stops and fills nothing', filled() === 0);
    w.ctrl.tmdb = 'ok'; w.writeCtrl();
    await w.restart();
    await until(async () => filled() === waiting.length, 60000, 200);
    check('backfill: the next run picks up where it stopped', filled() === waiting.length, `${filled()} of ${waiting.length}`);
  } finally { await w.close(); }
});

await step('import: a full-setup file that fails partway changes nothing', async () => {
  const w = S.world(await openWorld('cleanup-import'));
  try {
    const TABLES = ['settings', 'user_settings', 'ratings', 'watchlist', 'watched', 'matches', 'hidden_movies', 'rating_notes'];
    const hashes = () => { const d = w.db(); try { return Object.fromEntries(TABLES.map((t) => [t, tableHash(d, t)])); } finally { d.close(); } };
    const good = {
      version: 1, kind: 'reelpicks-state',
      profile: {
        settings: { avgTicketPrice: 21.5, excludedGenres: ['Horror'] },
        ratings: [{ tmdb_id: 424201, title: 'Import Test One', year: 2001, rating: 4, source: 'import', rated_at: '2026-01-02T00:00:00.000Z' }],
        watchlist: [{ tmdb_id: 424202, title: 'Import Test Two', year: 2002 }],
        watched: [{ tmdb_id: 424201, title: 'Import Test One', watched_at: '2026-01-03T20:00:00.000Z', in_weekly4: 0, ticket_price: 12 }],
        hidden: [{ tmdb_id: 424203, title: 'Import Test Three' }],
      },
    };
    // The last match row can't be stored (an object where an id goes), so
    // the import fails after everything before it went in.
    const bad = { ...good, profile: { ...good.profile, matches: [{ amc_movie_id: '8801', amc_title: 'Fine', tmdb_id: 424201, updated_at: '2026-01-01T00:00:00.000Z' }, { amc_movie_id: { not: 'an id' } }] } };
    await sleep(1500); // start-up work settles first
    const h0 = hashes();
    const r = await w.api('POST', '/api/state', { body: bad });
    check('import: the broken file is refused', r.status >= 400, `${r.status} ${r.text.slice(0, 120)}`);
    const h1 = hashes();
    const changed = TABLES.filter((t) => h0[t] !== h1[t]);
    check('import: every table is exactly as it was before the failed import', changed.length === 0, changed.join(', '));
    check('import: none of its rows are left behind', !w.q1('SELECT 1 x FROM ratings WHERE tmdb_id = 424201') && !w.q1("SELECT 1 x FROM matches WHERE amc_movie_id = '8801'") && !w.q1('SELECT 1 x FROM movies WHERE tmdb_id IN (424201, 424202, 424203)'));
    const ok = await w.api('POST', '/api/state', { body: good });
    check('import: the same file without the bad row imports as before', ok.status === 200 && ok.json?.imported?.ratings === 1 && ok.json?.imported?.watchlist === 1 && ok.json?.imported?.watched === 1 && ok.json?.imported?.hidden === 1, `${ok.status} ${ok.text.slice(0, 200)}`);
    check('import: its rows are there', Boolean(w.q1('SELECT 1 x FROM ratings WHERE user_id = 1 AND tmdb_id = 424201')) && JSON.parse(w.q1("SELECT value FROM user_settings WHERE user_id = 1 AND key = 'avgTicketPrice'")?.value || 'null') === 21.5);
  } finally { await w.close(); }
});

await step('letterboxd: an oversized feed is cut off while it is read', async () => {
  // A "feed" of 40 MB, sent in 64 KB pieces only as fast as the app reads it.
  const TOTAL = 40 * 1024 * 1024;
  const big = { sent: 0, closed: false };
  const chunk = Buffer.alloc(64 * 1024, 'x');
  const feedSrv = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.write('<?xml version="1.0"?><rss version="2.0"><channel>');
    const pump = () => {
      while (big.sent < TOTAL) {
        big.sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end('</channel></rss>');
      return undefined;
    };
    res.on('close', () => { big.closed = true; });
    pump();
  });
  const w = S.world(await openWorld('cleanup-letterboxd', { env: { RP_LETTERBOXD_ORIGIN: feedSrv.origin } }));
  try {
    const r = await w.api('PUT', '/api/letterboxd', { body: { username: 'bigfeed' } });
    await until(() => big.closed, 20000, 50);
    check('letterboxd: the oversized feed is refused as not a feed', r.status === 200 && /isn't a feed/.test(JSON.stringify(r.json)), `${r.status} ${r.text.slice(0, 200)}`);
    check('letterboxd: reading stopped near the 5 MB limit instead of taking all 40 MB', big.sent < 12 * 1024 * 1024, `${(big.sent / 1048576).toFixed(1)} MB sent`);
    check('letterboxd: nothing was imported from it', !w.q1("SELECT 1 x FROM letterboxd_seen WHERE user_id = 1"));

    // An uploaded file is held to its limit (20 MB) while it arrives too:
    // express.json stops reading, and the rest is never taken in.
    const up = await new Promise((resolve) => {
      let sent = 0; let answered = null;
      const req = http.request(`${w.base}/api/ratings/import`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { answered = res.statusCode; res.resume(); res.on('end', () => resolve({ status: answered, sent })); });
      req.on('error', () => resolve({ status: answered, sent }));
      const piece = Buffer.alloc(256 * 1024, 'a');
      req.write('{"csv":"');
      const more = () => {
        while (answered == null && sent < 60 * 1024 * 1024) {
          sent += piece.length;
          if (!req.write(piece)) return req.once('drain', more);
        }
        if (answered == null) req.end('"}');
        return undefined;
      };
      more();
    });
    check('letterboxd: an oversized upload is refused with 413', up.status === 413, String(up.status));
    check('letterboxd: the upload was cut off well before all 60 MB arrived', up.sent < 40 * 1024 * 1024, `${(up.sent / 1048576).toFixed(1)} MB sent`);
  } finally { await w.close(); await feedSrv.shut(); }
});

await step('alerts: owner alerts older than 90 days go after a good nightly backup', async () => {
  const at = (local) => `${local}-04:00`;
  // Ages on the night that cleans (Oct 3); the night before, the backup fails.
  const night = at('2026-10-03T03:01:00');
  const ages = { old200: 200, old91: 91, keep89: 89, keep10: 10 };
  const w = S.world(await openWorld('cleanup-alerts', {
    env: { RP_FAKE_NOW: at('2026-10-02T01:00:00') },
    prepare: (d) => {
      const ins = d.prepare("INSERT INTO owner_alerts(problem, kind, message, at, pushed) VALUES('refresh', 'problem', ?, ?, 0)");
      for (const [k, days] of Object.entries(ages)) ins.run(k, new Date(Date.parse(night) - days * 864e5).toISOString());
      d.prepare("INSERT OR REPLACE INTO alert_state(problem, failing, alerted, since, last_alert_day, last_reason) VALUES('refresh', 1, 1, ?, '2026-06-01', 'old trouble')").run(new Date(Date.parse(night) - 150 * 864e5).toISOString());
    },
  }));
  const BK = path.join(w.dataDir, 'backups');
  const left = () => w.q("SELECT message FROM owner_alerts WHERE message IN ('old200', 'old91', 'keep89', 'keep10') ORDER BY message").map((r) => r.message).join(',');
  try {
    await sleep(800);
    check('alerts: nothing goes before the nightly backup', left() === 'keep10,keep89,old200,old91', left());
    await w.srv.stop();
    // A failed backup deletes nothing.
    fs.mkdirSync(BK, { recursive: true });
    fs.chmodSync(BK, 0o555);
    try {
      await w.restart({ fakeNow: at('2026-10-02T03:01:00') });
      await until(() => /\[backup\] ✗/.test(w.srv.log()), 20000);
      await sleep(1000);
      check('alerts: a failed backup deletes no alert', left() === 'keep10,keep89,old200,old91' && !/owner alerts: removed/.test(w.srv.log()), left());
      await w.srv.stop();
    } finally { fs.chmodSync(BK, 0o755); }
    await w.restart({ fakeNow: night });
    await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-10-03.db')) && /\[housekeeping\]/.test(w.srv.log()), 30000);
    await sleep(800);
    check('alerts: after a good backup only alerts more than 90 days old are gone', left() === 'keep10,keep89', left());
    const bk = new DatabaseSync(path.join(BK, 'reelpicks-2026-10-03.db'), { readOnly: true });
    const inBackup = bk.prepare("SELECT COUNT(*) n FROM owner_alerts WHERE message IN ('old200', 'old91')").get().n;
    bk.close();
    check('alerts: that night\'s backup still holds them', inBackup === 2);
    check('alerts: each problem\'s current state is untouched', w.q1("SELECT last_reason FROM alert_state WHERE problem = 'refresh'")?.last_reason === 'old trouble');
  } finally { await w.close(); }
});

await step('departures: a film that leaves is logged but not written to departures', async () => {
  const w = S.world(await openWorld('cleanup-departures', { refresh: true, prepare: (d) => d.exec('DELETE FROM departures') }));
  try {
    const film = C.PLAYING.find((f) => f.k === 3);
    w.amc.gone.add(film.amcId);
    w.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
    const before = (await status(w))?.lastRefresh;
    const r = await w.api('POST', '/api/refresh');
    check('departures: a forced refresh starts', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    const done = await until(async () => { const s = await status(w); return s && !s.refreshing && s.lastRefresh !== before && s; }, 60000, 150);
    check('departures: the refresh finished', Boolean(done));
    const log = JSON.parse(w.q1("SELECT value FROM settings WHERE key = 'lastRefreshLog'")?.value || '{}');
    check('departures: the refresh log still says the film left', (log.errors || []).some((e) => e.startsWith('Left ') && e.includes(film.title)), (log.errors || []).filter((e) => e.startsWith('Left')).join(' | '));
    check('departures: nothing was written to departures', w.q('SELECT COUNT(*) n FROM departures')[0].n === 0, String(w.q('SELECT COUNT(*) n FROM departures')[0].n));
    check('departures: the table is still there', Boolean(w.q1("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'departures'")));
  } finally { await w.close(); }
});

await step('geocode: clearing a home base forgets only that person\'s own lookups', async () => {
  const w = S.world(await openWorld('cleanup-geocode'));
  try {
    const { robin, casey } = w.friends;
    const keys = () => w.q("SELECT key FROM cache WHERE key LIKE 'nominatim:%' ORDER BY key").map((r) => r.key);
    // The owner looks up "two testville" and takes its second place as home,
    // and also asks what's at that point.
    const g = await w.api('GET', '/api/geocode?q=two%20testville');
    const pick = g.json?.results?.[1];
    check('geocode: the owner\'s search offers the place', Boolean(pick) && pick.lat === 40.5 && pick.lng === -82.5, JSON.stringify(g.json).slice(0, 200));
    await w.api('PUT', '/api/settings', { body: { home: { label: pick.label, lat: pick.lat, lng: pick.lng } } });
    await w.api('GET', '/api/geocode/reverse?lat=40.5&lng=-82.5');
    // A friend's own lookups, for another place.
    await w.api('GET', '/api/geocode?q=somewhere', { as: robin });
    await w.api('GET', `/api/geocode/reverse?lat=${C.HOME.lat}&lng=${C.HOME.lng}`, { as: robin });
    const all0 = keys();
    const ownerKeys = ['nominatim:reverse:v1:40.50,-82.50', 'nominatim:search:v1:two testville'];
    const robinKeys = [`nominatim:reverse:v1:${C.HOME.lat.toFixed(2)},${C.HOME.lng.toFixed(2)}`, 'nominatim:search:v1:somewhere'];
    check('geocode: all four lookups are cached', [...ownerKeys, ...robinKeys].every((k) => all0.includes(k)), all0.join(', '));

    // A friend who never set a home base clears it: nothing to forget.
    const c = await w.api('DELETE', '/api/home', { as: casey });
    check('geocode: clearing a home base that was never set forgets nothing', c.status === 200 && JSON.stringify(keys()) === JSON.stringify(all0), keys().join(', '));

    const r = await w.api('DELETE', '/api/home');
    check('geocode: the owner\'s clear works', r.status === 200 && r.json?.cleared === true, `${r.status} ${r.text.slice(0, 120)}`);
    const all1 = keys();
    check('geocode: the owner\'s own lookups for that home are gone', ownerKeys.every((k) => !all1.includes(k)), all1.join(', '));
    check('geocode: the friend\'s lookups stay cached', robinKeys.every((k) => all1.includes(k)), all1.join(', '));
  } finally { await w.close(); }
});

S.finish();
