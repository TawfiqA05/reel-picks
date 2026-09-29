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

S.finish();
