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

S.finish();
