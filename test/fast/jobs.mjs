// Background jobs on a mocked timeline (old G9 and R9 g-jobs-d, with the
// backup part of old G8): the daily refresh (AMC showtimes, TMDB and OMDb
// enrichment, matching, the credits backfill, the thin-rating rule), weekly
// picks steady within a week, At home picks once a week, the 3am nightly
// backup and its retention, the Sunday off-site upload, the daily Letterboxd
// sync, the Friday push and owner alerts: each runs on schedule, never twice,
// survives a restart, and fails safely with a clear message. A crash in the
// middle of a refresh loses nothing. Local stand-ins answer for AMC (with a
// 401 and a garbage mode added here), push, Letterboxd and S3.
//
// Timeline (all local, America/New_York): Thu 09-24 -> Fri 09-25 -> Sat 09-26
// crash -> Sun 09-27 off-site fails then retries -> Mon 09-28 AMC 500 and a
// failed backup -> Tue 09-29 AMC 401 -> Thu 10-01 AMC garbage -> Sun 10-04
// recovery with off-site switched off.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, until, sleep, GUEST } from '../lib/world.mjs';
import { serve } from '../lib/mocks.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('jobs');
const local = (s) => `${s}-04:00`;
const day = (iso) => (iso ? C.ymdLocal(new Date(iso)) : null);
const readBody = (req) => new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); });

// ---------------------------------------------------------------- stand-ins
// AMC through a proxy that can also answer 401 or an HTML page with a 200.
const proxy = { mode: 'pass', target: null, own: [] };
const amcProxy = await serve(async (req, res) => {
  if (proxy.mode === '401') { proxy.own.push(req.url); res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ errors: [{ code: 401, message: 'Unauthorized', exceptionMessage: 'Unauthorized VendorKey' }] })); }
  if (proxy.mode === 'garbage') { proxy.own.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>Service temporarily unavailable</body></html>'); }
  if (!proxy.target) { res.writeHead(503); return res.end(); }
  const up = http.request(`${proxy.target}${req.url}`, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* closed */ } });
  req.pipe(up);
});

const push = { hits: [] };
const pushSrv = await serve(async (req, res) => {
  await readBody(req);
  push.hits.push({ path: req.url, topic: req.headers.topic || '', auth: String(req.headers.authorization || '').startsWith('vapid t=') });
  res.writeHead(req.url.includes('/gone') ? 410 : 201); res.end();
});
const pushTo = (ep, re = /^weekly-picks$/) => push.hits.filter((h) => h.path === ep && re.test(h.topic)).length;
const sub = (name) => {
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  return { endpoint: `${pushSrv.origin}/push/${name}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
};
const EP = { owner: '/push/owner1', f1: '/push/friend1', gone: '/push/gone-friend3', f4: '/push/friend4' };

const lbx = { goodMode: 'ok', slowServed: 0, hits: [] };
const item = (i) => `<item><title>${i.t}</title><guid isPermaLink="false">${i.g}</guid><pubDate>${new Date(i.p).toUTCString()}</pubDate><letterboxd:watchedDate>${i.w}</letterboxd:watchedDate><letterboxd:filmTitle>${i.t}</letterboxd:filmTitle><letterboxd:filmYear>2026</letterboxd:filmYear>${i.r ? `<letterboxd:memberRating>${i.r}</letterboxd:memberRating>` : ''}<tmdb:movieId>${i.id}</tmdb:movieId></item>`;
const feed = (items) => `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel><title>x</title>${items.map(item).join('')}</channel></rss>`;
const [F1f, F3f, F4f, F5f] = [1, 3, 4, 5].map((k) => C.PLAYING.find((f) => f.k === k));
const GOOD_FEED = feed([
  { g: 'lb-a-1', t: F1f.title, id: F1f.id, r: '4.0', w: '2026-09-20', p: '2026-09-20T22:00:00Z' },
  { g: 'lb-a-3', t: F3f.title, id: F3f.id, r: '3.5', w: '2026-09-21', p: '2026-09-21T22:00:00Z' },
  { g: 'lb-a-4', t: F4f.title, id: F4f.id, r: null, w: '2026-09-22', p: '2026-09-22T22:00:00Z' },
]);
const SLOW_FEED = feed([{ g: 'lb-b-5', t: F5f.title, id: F5f.id, r: '3.0', w: '2026-09-22', p: '2026-09-22T22:00:00Z' }]);
const lbxSrv = await serve((req, res) => {
  const user = (req.url.match(/^\/([^/]+)\/rss\/?$/) || [])[1] || '?';
  lbx.hits.push({ user });
  if (user === 'rp_good') {
    if (lbx.goodMode === '500') { res.writeHead(500); return res.end('oops'); }
    res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(GOOD_FEED);
  }
  if (user === 'rp_slow') {
    // The first answer hangs past the app's 20 s timeout.
    if (lbx.slowServed++ === 0) { setTimeout(() => { try { res.destroy(); } catch { /* gone */ } }, 25000); return undefined; }
    res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end(SLOW_FEED);
  }
  res.writeHead(404); return res.end('not found');
});
const lbxHits = (user) => lbx.hits.filter((h) => h.user === user).length;

const s3 = { mode: 'ok', objects: new Map(), ops: [], badAuth: 0, badHash: 0 };
const OURS = (d) => `reel-picks/weekly/reelpicks-${d}.db`;
const FOREIGN = ['reel-picks/weekly/notes.txt', 'reel-picks/weekly/reelpicks-2026-01-01.db.bak', 'reel-picks/weekly/sub/reelpicks-2026-01-01.db', 'other/reelpicks-2026-01-01.db', 'reel-picks/reelpicks-2026-01-01.db'];
for (let i = 1; i <= 9; i++) s3.objects.set(OURS(`2026-08-0${i}`), 10);
for (const k of FOREIGN) s3.objects.set(k, 5);
const s3Srv = await serve(async (req, res) => {
  const body = await readBody(req);
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').slice(1).map(decodeURIComponent);
  const bucket = parts.shift();
  const key = parts.join('/');
  s3.ops.push({ method: req.method, key });
  if (!String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256 Credential=jobs-key-id/')) s3.badAuth++;
  if (req.headers['x-amz-content-sha256'] !== crypto.createHash('sha256').update(body).digest('hex')) s3.badHash++;
  if (s3.mode === 'fail') { res.writeHead(500, { 'content-type': 'application/xml' }); return res.end('<Error><Code>InternalError</Code><Message>test storage is down</Message></Error>'); }
  if (bucket !== 'jobs-bucket') { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
  if (req.method === 'PUT') { s3.objects.set(key, body.length); res.writeHead(200); return res.end(); }
  if (req.method === 'HEAD') { if (!s3.objects.has(key)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-length': s3.objects.get(key) }); return res.end(); }
  if (req.method === 'DELETE') { s3.objects.delete(key); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && !key) {
    const keys = [...s3.objects.keys()].filter((k) => k.startsWith(u.searchParams.get('prefix') || '')).sort();
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
  }
  res.writeHead(400); return res.end();
});
const s3Puts = () => s3.ops.filter((o) => o.method === 'PUT').length;
const ours = () => [...s3.objects.keys()].filter((k) => /^reel-picks\/weekly\/reelpicks-\d{4}-\d{2}-\d{2}\.db$/.test(k)).sort();
const S3ENV = { BACKUP_S3_ENDPOINT: s3Srv.origin, BACKUP_S3_BUCKET: 'jobs-bucket', BACKUP_S3_KEY_ID: 'jobs-key-id', BACKUP_S3_SECRET: 'jobs-test-secret' };
const NO_S3 = { BACKUP_S3_ENDPOINT: ' ', BACKUP_S3_BUCKET: ' ', BACKUP_S3_KEY_ID: ' ', BACKUP_S3_SECRET: ' ' };
const vk = crypto.createECDH('prime256v1'); vk.generateKeys();

// ---------------------------------------------------------------- the world
const w = S.world(await openWorld('jobs', {
  refresh: true,
  env: {
    RP_AMC_BASE: amcProxy.origin, RP_PUSH_TEST_ORIGIN: pushSrv.origin, RP_LETTERBOXD_ORIGIN: lbxSrv.origin,
    VAPID_PUBLIC_KEY: vk.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: vk.getPrivateKey().toString('base64url'),
  },
}));
proxy.target = w.amc.origin;
const PRIMARY = '9101';
const THEATRES = ['9101', '9102'];
const q = (sql, ...p) => w.q(sql, ...p);
const q1 = (sql, ...p) => w.q1(sql, ...p);
const setting = (key) => { const r = q1('SELECT value FROM settings WHERE key = ?', key); try { return r ? JSON.parse(r.value) : null; } catch { return r?.value; } };
const status = async () => (await w.api('GET', '/api/status')).json;
const settledOn = (d, ms = 30000) => until(async () => { const s = await status(); return s && !s.refreshing && day(s.lastRefresh) === d && s; }, ms, 100);
const idle = () => until(async () => { const s = await status(); return s && !s.refreshing; }, 30000, 100);
const stHits = (f = {}) => w.amc.hits.filter((h) => h.kind === 'showtimes' && Object.entries(f).every(([k, v]) => h[k] === v)).length;
const alerts = (problem, kind) => q('SELECT * FROM owner_alerts WHERE problem = ? AND kind = ? ORDER BY id', problem, kind);
const alertsOn = (problem, kind, d) => alerts(problem, kind).filter((a) => day(a.at) === d);
const playingCount = () => q1('SELECT COUNT(*) n FROM movies WHERE playing = 1').n;
const primaryShowtimes = (from) => q1('SELECT COUNT(*) n FROM showtimes WHERE theatre_id = ? AND date >= ?', PRIMARY, from).n;
const ownerRatings = () => q1('SELECT COUNT(*) n FROM ratings WHERE user_id = 1').n;
const backupLines = (name) => w.srv.log().split('\n').filter((l) => l.includes(`[backup] ✓ ${name}`)).length;
const BK = path.join(w.dataDir, 'backups');
const nightlies = () => fs.readdirSync(BK).filter((n) => /^reelpicks-\d{4}-\d{2}-\d{2}\.db$/.test(n));
const start = (fakeNow, { scale = 0, s3env = S3ENV } = {}) => w.restart({ fakeNow: local(fakeNow), env: { RP_TIMER_SCALE: scale ? String(scale) : '', ...s3env } });
const jump = (s) => w.jump(local(s));
const alertsBefore = q1('SELECT COUNT(*) n FROM owner_alerts').n;
let F1; let F2; let F3; let F4; let home1 = null;
// Kills the server outright. world.mjs's stop() waits for an exit event when
// exitCode is null, which is also the case for a process ended by a signal;
// marking the exit code keeps the next restart from waiting forever.
async function crash() {
  const c = w.srv.child;
  if (c.exitCode == null && c.signalCode == null) await new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
  if (c.exitCode == null) c.exitCode = 137;
}

// ============================================================ Thu 09-24 10:00
await S.step('Thursday: the day\'s first refresh, backups, off-site, friends, Letterboxd', async () => {
  fs.mkdirSync(BK, { recursive: true });
  for (let i = 1; i <= 16; i++) {
    const f = path.join(BK, `reelpicks-2026-09-${String(i).padStart(2, '0')}.db`);
    fs.writeFileSync(f, 'old');
    const t = new Date(`2026-09-${String(i).padStart(2, '0')}T03:00:00-04:00`); fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(BK, 'keep-me.db'), 'mine');
  w.amc.mode = 'hold';
  await start('2026-09-24T10:00:00');
  await until(() => w.amc.held.length > 0, 10000, 20);
  const p1 = await w.api('POST', '/api/refresh');
  const p2 = await w.api('POST', '/api/refresh');
  S.check('refresh: a trigger during a run is queued, not run alongside', p1.json?.queued === true && p2.json?.queued === true, `queued=${p1.json?.queued},${p2.json?.queued}`);
  // A rated film with no details yet, added while the refresh runs.
  q("INSERT INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at) VALUES(1, 950005, NULL, NULL, 4, 'manual', ?, ?)", '2026-09-24T14:00:00.000Z', '2026-09-24T14:00:00.000Z');
  w.amc.mode = 'ok'; w.amc.release();
  const st1 = await settledOn('2026-09-24');
  S.check('refresh: the startup refresh ran on a new local day', Boolean(st1), `lastRefresh ${st1?.lastRefresh}`);
  await sleep(300); await idle();
  S.check('refresh: never two at once (AMC saw at most one request in flight)', w.amc.maxInflight === 1, `max ${w.amc.maxInflight}`);
  S.check('refresh: the startup run plus exactly one queued rerun (today fetched twice)', stHits({ theatre: PRIMARY, date: '2026-09-24' }) === 2, `${stHits({ theatre: PRIMARY, date: '2026-09-24' })}x`);
  S.check('refresh: a day the forced rerun skips is fetched once', stHits({ theatre: PRIMARY, date: '2026-10-06' }) === 1, `${stHits({ theatre: PRIMARY, date: '2026-10-06' })}x`);
  const bad = [];
  for (const t of THEATRES) {
    for (let d = 1; d <= 13; d++) {
      const date = C.ymdLocal(new Date(C.T0_MS + d * 864e5));
      const want = new Set(C.amcShowtimes(t, date).map((s) => String(s.id))).size;
      const got = q1('SELECT COUNT(*) n FROM showtimes WHERE theatre_id = ? AND date = ?', t, date).n;
      if (got !== want) bad.push(`${t} ${date}: ${got}/${want}`);
    }
  }
  S.check('refresh: every scheduled showtime of the next two weeks is stored for every followed theater', !bad.length, bad.slice(0, 4).join(', '));
  const matched = q('SELECT amc_movie_id, tmdb_id FROM matches');
  S.check('refresh: every AMC title TMDB knows is matched to its film', C.PLAYING.every((f) => matched.some((m) => m.amc_movie_id === String(f.amcId) && m.tmdb_id === f.id)), `${matched.length} matches`);
  S.check('refresh: the title TMDB doesn\'t know stays unmatched', matched.some((m) => m.amc_movie_id === String(C.UNMATCHED.amcId) && m.tmdb_id == null));
  const enr = q(`SELECT tmdb_id, details_at, director, scores, playing, playing_source FROM movies WHERE tmdb_id IN (${C.PLAYING.map((f) => f.id).join(',')})`);
  S.check('refresh: TMDB details enriched for every matched film', enr.length === C.PLAYING.length && enr.every((m) => m.details_at && m.director), `${enr.filter((m) => m.details_at).length}/${C.PLAYING.length}`);
  const omdbOk = C.PLAYING.filter((f) => f.omdb).every((f) => { try { return JSON.parse(enr.find((m) => m.tmdb_id === f.id).scores).imdb === f.omdb.imdb; } catch { return false; } });
  const noRec = C.PLAYING.filter((f) => !f.omdb).every((f) => { try { return JSON.parse(enr.find((m) => m.tmdb_id === f.id).scores).noRecord === true; } catch { return false; } });
  S.check('refresh: OMDb scores stored, and "no record" remembered', omdbOk && noRec, `omdbOk=${omdbOk} noRecord=${noRec}`);
  S.check('refresh: the AMC lineup is what plays', enr.every((m) => m.playing === 1 && m.playing_source === 'amc'));
  S.check('refresh: Coming Soon comes from TMDB upcoming', C.UPCOMING.every((f) => q1('SELECT upcoming FROM movies WHERE tmdb_id = ?', f.id)?.upcoming === 1));
  const rec = (await w.api('GET', '/api/recommendations')).json;
  const thin = rec.list.find((e) => e.tmdb_id === 990006);
  S.check('refresh: the thin-rating rule (a TMDB 9.4 from 12 votes is ignored, so no score)', thin?.public?.tmdbIgnored?.reason === 'few-votes' && thin?.public?.combined == null && thin?.flags?.noScores === true, `reason=${thin?.public?.tmdbIgnored?.reason} combined=${thin?.public?.combined}`);
  S.check('refresh: a well-voted TMDB rating still counts', rec.list.find((e) => e.tmdb_id === 990001)?.public?.sources?.includes('TMDB'));
  const bf = await until(async () => { const s = await status(); return q1('SELECT details_at FROM movies WHERE tmdb_id = 950005')?.details_at && !s.creditsBackfill.running && s.creditsBackfill; }, 15000);
  S.check('refresh: the credits backfill runs after the refresh and fills the rated film', bf?.startedBy === 'refresh' && bf?.fetched >= 1, `startedBy=${bf?.startedBy} fetched=${bf?.fetched}`);
  S.check('refresh: no alert on a good refresh', q1('SELECT COUNT(*) n FROM owner_alerts').n === alertsBefore);

  S.check('backup: tonight\'s nightly is taken at startup (after 3am)', fs.existsSync(path.join(BK, 'reelpicks-2026-09-24.db')) && backupLines('reelpicks-2026-09-24.db') === 1);
  S.check('backup: retention keeps the newest 7 nightlies', nightlies().length === 7 && !nightlies().includes('reelpicks-2026-09-11.db') && ['24', '23', '16', '15', '14', '13', '12'].every((d) => nightlies().includes(`reelpicks-2026-09-${d}.db`)), `${nightlies().length} nightlies`);
  S.check('backup: a file put there by hand is left alone', fs.existsSync(path.join(BK, 'keep-me.db')));
  await until(() => setting('offsiteLast')?.key, 10000);
  S.check('offsite: the first upload goes up at once (the newest nightly)', setting('offsiteLast')?.key === OURS('2026-09-24') && s3.objects.get(OURS('2026-09-24')) > 1000, `key=${setting('offsiteLast')?.key}`);
  S.check('offsite: prunes to the newest 8 of its own keys', ours().length === 8 && !ours().includes(OURS('2026-08-01')) && !ours().includes(OURS('2026-08-02')), `${ours().length} kept`);
  S.check('offsite: never touches keys that are not exactly its own', FOREIGN.every((k) => s3.objects.has(k)));
  S.check('offsite: requests are SigV4-signed with the body hash', s3.badAuth === 0 && s3.badHash === 0, `badAuth=${s3.badAuth} badHash=${s3.badHash}`);

  F1 = await makeFriend(w.base, 'Jobs Friend One');
  F2 = await makeFriend(w.base, 'Jobs Friend Two');
  F3 = await makeFriend(w.base, 'Jobs Friend Three');
  F4 = await makeFriend(w.base, 'Jobs Friend Four');
  for (const f of [F1, F2, F3, F4]) {
    await w.api('POST', '/api/theatre', { as: f, body: { id: PRIMARY, name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } });
    await w.api('PUT', '/api/settings', { as: f, body: { onboardingDone: true, setupDone: true } });
  }
  const subOk = [
    await w.api('POST', '/api/push/subscribe', { body: { subscription: sub('owner1') } }),
    await w.api('POST', '/api/push/subscribe', { as: F1, body: { subscription: sub('friend1') } }),
    await w.api('POST', '/api/push/subscribe', { as: F3, body: { subscription: sub('gone-friend3') } }),
    await w.api('POST', '/api/push/subscribe', { as: F4, body: { subscription: sub('friend4') } }),
  ].every((r) => r.status === 200);
  await w.api('POST', `/api/friends/${F4.id}/revoke`);
  S.check('setup: push subscriptions saved (owner, two friends, one friend later revoked)', subOk);
  // The slow feed takes the app's 20 s timeout; it runs while the rest goes on.
  const slowT = Date.now();
  const slowP = w.api('PUT', '/api/letterboxd', { as: F2, body: { username: 'rp_slow' } });
  const before = ownerRatings();
  const lbOwner = (await w.api('PUT', '/api/letterboxd', { body: { username: 'rp_good' } })).json;
  S.check('letterboxd: a good feed imports (2 ratings, 3 watches)', lbOwner?.lastOkAt && lbOwner.ratingsAdded === 2 && lbOwner.watchedAdded === 3 && ownerRatings() === before + 2, `added=${lbOwner?.ratingsAdded}/${lbOwner?.watchedAdded}`);
  const lb1 = (await w.api('PUT', '/api/letterboxd', { as: F1, body: { username: 'rp_nosuch' } })).json;
  S.check('letterboxd: a username with no profile fails with a clear message', /no public profile/.test(lb1?.error || '') && q1('SELECT last_error_kind k FROM letterboxd_sync WHERE user_id = ?', F1.id)?.k === 'username', lb1?.error?.slice(0, 60));
  S.check('push: nothing sent on a Thursday', push.hits.filter((h) => h.topic === 'weekly-picks').length === 0);
  const oa = await w.api('GET', '/api/alerts');
  const fa = await w.api('GET', '/api/alerts', { as: F1 });
  const ga = await w.api('GET', '/api/alerts', { as: GUEST });
  S.check('alerts: GET /api/alerts is owner-only', oa.status === 200 && fa.status === 403 && ga.status === 403, `${oa.status}/${fa.status}/${ga.status}`);
  const lb2 = (await slowP).json;
  S.check('letterboxd: a feed that times out fails safely with a clear message', /too long/.test(lb2?.error || '') && q1('SELECT COUNT(*) n FROM ratings WHERE user_id = ?', F2.id).n === 0, `${Math.round((Date.now() - slowT) / 1000)}s · ${lb2?.error?.slice(0, 50)}`);
});

// ============================================================ restart Thu 11:00
await S.step('a restart the same day repeats nothing', async () => {
  const h = { amc: w.amc.hits.length, s3: s3.ops.length, lbx: lbx.hits.length, push: push.hits.length };
  const lr = setting('lastRefresh');
  await start('2026-09-24T11:00:00');
  await sleep(2500);
  S.check('restart same day: no second refresh', w.amc.hits.length === h.amc && setting('lastRefresh') === lr, `AMC +${w.amc.hits.length - h.amc}`);
  S.check('restart same night: no second nightly backup', backupLines('reelpicks-2026-09-24.db') === 0);
  S.check('restart: no second off-site upload', s3.ops.length === h.s3, `S3 +${s3.ops.length - h.s3}`);
  S.check('restart same day: no Letterboxd re-sync (ok, bad name, recent network error)', lbx.hits.length === h.lbx, `RSS +${lbx.hits.length - h.lbx}`);
  S.check('restart: no push', push.hits.length === h.push);
});

// ============================================================ Thu 23:58 -> Fri 09-25
await S.step('into Friday: the new day\'s refresh, the Friday push, the 3am backup', async () => {
  lbx.goodMode = '500';
  await start('2026-09-24T23:58:00', { scale: 0.002 });
  const f2ok = await until(() => q1('SELECT last_ok_at FROM letterboxd_sync WHERE user_id = ?', F2.id)?.last_ok_at, 8000);
  S.check('letterboxd: a network failure is retried after 3 hours and then works', Boolean(f2ok) && lbxHits('rp_slow') === 2, `rp_slow fetched ${lbxHits('rp_slow')}x`);
  const nosuchBefore = lbxHits('rp_nosuch'); const goodBefore = lbxHits('rp_good'); const ratingsBefore = ownerRatings();
  const h3 = stHits({ theatre: PRIMARY, date: '2026-10-08' });
  await jump('2026-09-25T00:20:00');
  S.check('refresh: the 15-minute tick refreshes once the local day rolls over', Boolean(await settledOn('2026-09-25', 20000)));
  await until(() => push.hits.filter((h) => h.topic === 'weekly-picks').length >= 3, 15000);
  await sleep(3000); // more ticks
  S.check('refresh: exactly one refresh for the new day across many ticks', stHits({ theatre: PRIMARY, date: '2026-10-08' }) - h3 === 1, `${stHits({ theatre: PRIMARY, date: '2026-10-08' }) - h3}x`);
  S.check('push: the Friday push goes once to each opted-in device (owner, friend)', pushTo(EP.owner) === 1 && pushTo(EP.f1) === 1, `owner=${pushTo(EP.owner)} friend=${pushTo(EP.f1)}`);
  S.check('push: not sent to a revoked friend or to anyone without a device', pushTo(EP.f4) === 0 && push.hits.filter((h) => h.topic === 'weekly-picks').length === 3);
  S.check('push: an expired subscription (410) is removed', pushTo(EP.gone) === 1 && q1('SELECT COUNT(*) n FROM push_subs WHERE endpoint LIKE ?', '%gone-friend3').n === 0);
  S.check('push: every push is VAPID-signed', push.hits.every((h) => h.auth));
  S.check('push: each person\'s push is recorded for the week of 09-25', q("SELECT user_id FROM push_sent WHERE week_start = '2026-09-25' ORDER BY user_id").map((r) => r.user_id).join(',') === `1,${F1.id}`);
  S.check('letterboxd: the new day syncs each linked person once', lbxHits('rp_good') - goodBefore === 1 && lbxHits('rp_nosuch') - nosuchBefore === 1, `good +${lbxHits('rp_good') - goodBefore}, bad name +${lbxHits('rp_nosuch') - nosuchBefore}`);
  const og = q1('SELECT last_error, last_error_kind FROM letterboxd_sync WHERE user_id = 1');
  S.check('letterboxd: an HTTP 500 fails safely with a clear status and no data lost', /HTTP 500/.test(og?.last_error || '') && og?.last_error_kind === 'network' && ownerRatings() === ratingsBefore, og?.last_error?.slice(0, 60));
  await jump('2026-09-25T02:59:30');
  await sleep(500);
  S.check('backup: not before 3am', !fs.existsSync(path.join(BK, 'reelpicks-2026-09-25.db')));
  await jump('2026-09-25T03:00:30');
  await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-09-25.db')), 5000);
  await sleep(1000);
  S.check('backup: taken once at 3am (across many minute ticks)', backupLines('reelpicks-2026-09-25.db') === 1, `${backupLines('reelpicks-2026-09-25.db')} run(s)`);
});

// ============================================================ restart Fri 03:30
await S.step('a Friday restart repeats nothing; weekly and At home picks hold', async () => {
  lbx.goodMode = 'ok';
  const h = { amc: w.amc.hits.length, push: push.hits.length };
  const r4 = ownerRatings();
  await start('2026-09-25T03:30:00', { scale: 0.002 });
  await sleep(3000);
  S.check('restart Friday: no second weekly push', push.hits.length === h.push, `+${push.hits.length - h.push}`);
  S.check('restart same night: no second backup', backupLines('reelpicks-2026-09-25.db') === 0);
  S.check('restart same day: no refresh', w.amc.hits.length === h.amc);
  const og = q1('SELECT last_error, last_ok_at FROM letterboxd_sync WHERE user_id = 1');
  S.check('letterboxd: the retry after the 500 works and adds no duplicates', !og?.last_error && day(og?.last_ok_at) === '2026-09-25' && ownerRatings() === r4);
  const reads = [];
  for (let i = 0; i < 3; i++) reads.push((await w.api('GET', '/api/recommendations')).json.weekly4.map((e) => e.tmdb_id));
  S.check('weekly: four picks, the same across reloads', reads[0].length === 4 && reads.every((r) => JSON.stringify(r) === JSON.stringify(reads[0])), reads.map((r) => r.join(',')).join(' | '));
  const first = (await w.api('GET', '/api/home-picks')).json;
  home1 = await until(async () => { const r = (await w.api('GET', '/api/home-picks')).json; return r?.status === 'ready' && r; }, 20000, 250);
  S.check('home picks: worked out once for the week and ready', ['computing', 'ready'].includes(first?.status) && home1?.weekStart === '2026-09-25' && home1?.picks?.length === 4, `${first?.status} -> ${home1?.status} ${home1?.weekStart} ${home1?.picks?.length}`);
});

// ============================================================ Sat 09-26: crash mid-refresh
await S.step('Saturday: a crash in the middle of a refresh loses nothing', async () => {
  const lr = setting('lastRefresh');
  const before = playingCount();
  w.amc.mode = 'hold';
  await start('2026-09-26T10:00:00');
  await until(() => w.amc.held.length > 0, 15000, 20);
  const mid = (await w.api('GET', '/api/recommendations')).json;
  S.check('refresh: Picks keep showing the lineup while a refresh runs', (mid?.weekly4?.length || 0) > 0);
  await crash();
  w.amc.mode = 'ok'; w.amc.release();
  S.check('crash mid-refresh: not marked done (the restart redoes it)', setting('lastRefresh') === lr);
  S.check('crash mid-refresh: the stored lineup survives', playingCount() > 0 && playingCount() === before, `${before} -> ${playingCount()}`);
  await start('2026-09-26T10:05:00');
  const st = await settledOn('2026-09-26');
  const rec = (await w.api('GET', '/api/recommendations')).json;
  S.check('crash mid-refresh: the restart completes the refresh', Boolean(st) && playingCount() >= 8 && primaryShowtimes('2026-09-26') > 0 && rec?.weekly4?.length === 4);
});

// ============================================================ Sun 09-27: off-site fails, then retries
await S.step('Sunday: the off-site upload fails, alerts, and retries an hour later', async () => {
  s3.mode = 'fail';
  const before = s3.ops.length;
  await start('2026-09-27T03:58:00', { scale: 0.002 });
  await settledOn('2026-09-27', 20000);
  S.check('offsite: not before Sunday 4am', s3.ops.length === before);
  await jump('2026-09-27T04:00:30');
  const fail = await until(() => alerts('offsite', 'problem')[0], 8000);
  const putsAfterFail = s3Puts();
  S.check('offsite: a failed upload raises an owner alert naming the storage error', Boolean(fail) && /storage answered 500/.test(fail?.message || ''), fail?.message?.slice(0, 70));
  await until(() => pushTo(EP.owner, /^alert-offsite$/) >= 1, 5000);
  S.check('alerts: the off-site alert is pushed to the owner\'s device', pushTo(EP.owner, /^alert-offsite$/) === 1);
  await jump('2026-09-27T04:30:00');
  await sleep(800);
  S.check('offsite: no retry within the hour', s3Puts() === putsAfterFail, `PUTs +${s3Puts() - putsAfterFail}`);
  s3.mode = 'ok';
  await jump('2026-09-27T05:01:00');
  const okKey = await until(() => setting('offsiteLast')?.key === OURS('2026-09-27'), 8000);
  const rec = await until(() => alerts('offsite', 'recovered')[0], 5000);
  await sleep(800);
  const putsAfterOk = s3Puts();
  await sleep(800);
  S.check('offsite: retried an hour later with this week\'s nightly', Boolean(okKey) && s3.objects.has(OURS('2026-09-27')));
  S.check('offsite: the next success resolves the alert', Boolean(rec) && q1("SELECT failing FROM alert_state WHERE problem = 'offsite'")?.failing === 0);
  S.check('offsite: uploads once (no repeat after a success)', s3Puts() === putsAfterOk);
  S.check('offsite: still 8 of its own keys, foreign keys untouched', ours().length === 8 && FOREIGN.every((k) => s3.objects.has(k)), `${ours().length} kept`);
  const n = s3.ops.length;
  await start('2026-09-27T06:00:00');
  await sleep(1500);
  S.check('restart Sunday: no second off-site upload', s3.ops.length === n);
});

// ============================================================ Mon 09-28: AMC 500 + a failed backup
await S.step('Monday: AMC answers 500 and the nightly backup fails', async () => {
  w.amc.mode = '500';
  const keep = primaryShowtimes('2026-09-28');
  fs.chmodSync(BK, 0o555);
  try {
    await start('2026-09-28T10:00:00', { scale: 0.002 });
    await settledOn('2026-09-28');
    await sleep(800);
    const chain = setting('refreshRetry');
    S.check('refresh: AMC 500 keeps yesterday\'s showtimes', primaryShowtimes('2026-09-28') >= keep && keep > 0, `${keep} -> ${primaryShowtimes('2026-09-28')}`);
    S.check('refresh: AMC 500 starts an hourly retry naming AMC, with no alert yet', alertsOn('refresh', 'problem', '2026-09-28').length === 0 && chain?.day === '2026-09-28' && /AMC didn't answer/.test(chain?.lastError || '') && /500/.test(chain?.lastError || ''), JSON.stringify(chain));
    const r = (await w.api('GET', '/api/recommendations')).json;
    S.check('refresh: AMC 500 leaves Picks usable on the AMC lineup', r?.weekly4?.length === 4 && q1("SELECT COUNT(*) n FROM movies WHERE playing = 1 AND playing_source <> 'amc'").n === 0);
    const b = await until(() => alertsOn('backup', 'problem', '2026-09-28')[0], 5000);
    S.check('backup: a failed nightly raises an owner alert', Boolean(b) && !fs.existsSync(path.join(BK, 'reelpicks-2026-09-28.db')), b?.message?.slice(0, 70));
    fs.chmodSync(BK, 0o755);
    const n = stHits();
    await w.api('POST', '/api/refresh');
    await until(() => stHits() > n, 10000);
    await idle();
    await sleep(300);
    S.check('alerts: a second failure the same day (manual refresh) still sends no alert', alertsOn('refresh', 'problem', '2026-09-28').length === 0);
    await jump('2026-09-28T11:00:30');
    const rec = await until(() => alerts('backup', 'recovered')[0], 6000);
    S.check('backup: the next good nightly (an hour later) resolves the alert', Boolean(rec) && fs.existsSync(path.join(BK, 'reelpicks-2026-09-28.db')));
  } finally { try { fs.chmodSync(BK, 0o755); } catch { /* restored */ } }
});

// ============================================================ Tue 09-29: AMC 401
await S.step('Tuesday: AMC answers 401', async () => {
  // Monday's server may still be in an hourly retry; the count is taken once
  // it has stopped, not halfway through a refresh rewriting the showtimes.
  await idle();
  await w.srv.stop();
  w.amc.mode = 'ok';
  proxy.mode = '401';
  const keep = primaryShowtimes('2026-09-29');
  await start('2026-09-29T10:00:00');
  await settledOn('2026-09-29');
  await sleep(800);
  const chain = setting('refreshRetry');
  S.check('refresh: AMC 401 keeps yesterday\'s showtimes', primaryShowtimes('2026-09-29') >= keep && keep > 0, `${keep} -> ${primaryShowtimes('2026-09-29')}`);
  S.check('refresh: AMC 401 starts a new day\'s retry chain naming the 401, with no alert yet', alertsOn('refresh', 'problem', '2026-09-29').length === 0 && chain?.day === '2026-09-29' && chain?.attempts === 0 && /401/.test(chain?.lastError || ''), JSON.stringify(chain));
});

// ============================================================ Thu 10-01: AMC answers garbage
await S.step('Thursday: AMC answers an HTML page with a 200', async () => {
  proxy.mode = 'garbage';
  const keep = primaryShowtimes('2026-10-01');
  await start('2026-10-01T10:00:00');
  await settledOn('2026-10-01');
  await sleep(800);
  const chain = setting('refreshRetry');
  S.check('refresh: garbage from AMC keeps yesterday\'s showtimes', primaryShowtimes('2026-10-01') >= keep && keep > 0, `${keep} -> ${primaryShowtimes('2026-10-01')}`);
  S.check('refresh: garbage from AMC counts as a failure (retry chain naming AMC, no alert yet)', alertsOn('refresh', 'problem', '2026-10-01').length === 0 && chain?.day === '2026-10-01' && /AMC didn't answer/.test(chain?.lastError || ''), chain?.lastError?.slice(0, 90));
  S.check('refresh: garbage from AMC puts no fallback films into Picks', q1("SELECT COUNT(*) n FROM movies WHERE playing = 1 AND playing_source <> 'amc'").n === 0 && (await w.api('GET', '/api/recommendations')).json.weekly4.length === 4);
  const rows = q('SELECT key, value, fetched_at FROM cache WHERE key LIKE ?', `amc:showtimes:v2:${PRIMARY}:%`);
  const empty = rows.filter((r) => { try { return !JSON.parse(r.value).length && C.amcShowtimes(PRIMARY, r.key.split(':').pop()).length; } catch { return true; } });
  const today = rows.filter((r) => day(r.fetched_at) === '2026-10-01');
  S.check('refresh: garbage from AMC writes no cached day (it can\'t overwrite a good one with an empty one)', empty.length === 0 && today.length === 0, `${rows.length} cached, ${empty.length} empty, ${today.length} written today`);
  const h = (await w.api('GET', '/api/home-picks')).json;
  S.check('home picks: unchanged later in the same week', h?.weekStart === '2026-09-25' && JSON.stringify((h.picks || []).map((p) => p.tmdb_id)) === JSON.stringify((home1?.picks || []).map((p) => p.tmdb_id)), `${h?.weekStart}`);
});

// ============================================================ Sun 10-04: recovery, off-site off
await S.step('Sunday: AMC is back; off-site switched off', async () => {
  proxy.mode = 'pass';
  const n = s3.ops.length;
  await start('2026-10-04T04:30:00', { s3env: NO_S3 });
  await settledOn('2026-10-04');
  await until(() => alerts('showtimes', 'recovered')[0] || !setting('refreshRetry'), 5000);
  const failing = q('SELECT problem FROM alert_state WHERE failing = 1').map((r) => r.problem);
  S.check('alerts: the next good refresh ends the retry chain and nothing is failing', !setting('refreshRetry') && failing.length === 0, `still failing: ${failing.join(',') || 'none'}`);
  const r = (await w.api('GET', '/api/recommendations')).json;
  S.check('refresh: recovery brings the AMC lineup back', r?.weekly4?.length === 4 && q1("SELECT COUNT(*) n FROM movies WHERE playing = 1 AND playing_source <> 'amc'").n === 0);
  await sleep(1000);
  const off = await w.api('GET', '/api/offsite');
  const up = await w.api('POST', '/api/offsite/upload');
  S.check('offsite: never runs when BACKUP_S3_* is unset', s3.ops.length === n && off.json?.enabled === false && up.status === 404, `S3 +${s3.ops.length - n} · enabled=${off.json?.enabled} · upload ${up.status}`);
  const oa = await w.api('GET', '/api/alerts');
  const kept = q1('SELECT COUNT(*) n FROM owner_alerts').n;
  S.check('alerts: the owner sees the history; a friend and the guest get 403', oa.status === 200 && oa.json?.alerts?.length === Math.min(10, kept) && kept >= 3 && (await w.api('GET', '/api/alerts', { as: F1 })).status === 403 && (await w.api('GET', '/api/alerts', { as: GUEST })).status === 403, `${oa.json?.alerts?.length} of ${kept}`);
  const fs1 = (await w.api('GET', '/api/status', { as: F1 })).json;
  const fset = (await w.api('GET', '/api/settings', { as: F1 })).json;
  S.check('alerts: a friend\'s status and settings carry no backup, alert or refresh-log data', fs1 && !('backup' in fs1) && !('lastRefreshLog' in fs1) && fset && !('lastRefreshLog' in fset));
  S.check('alerts: alert pushes only ever went to the owner\'s device', push.hits.filter((h) => h.topic.startsWith('alert-') && h.path !== EP.owner).length === 0 && pushTo(EP.owner, /^alert-/) >= 3, `owner alert pushes=${pushTo(EP.owner, /^alert-/)}`);
  const h = (await w.api('GET', '/api/home-picks')).json;
  S.check('home picks: a new week starts a new list', h?.status === 'computing' || (h?.weekStart && h.weekStart !== '2026-09-25'), `${h?.status} ${h?.weekStart}`);
});

await S.step('the weekly log stays in order', async () => {
  const log = q("SELECT user_id, week_start, tmdb_id, first_seen_at FROM weekly4_log WHERE week_start >= '2026-09-18'");
  const outside = log.filter((r) => { const t = Date.parse(r.first_seen_at); const s = Date.parse(`${r.week_start}T00:00:00-04:00`); return t < s || t >= s + 7 * 864e5 + 3600e3; });
  S.check('weekly: every log row falls inside its Friday-to-Thursday week', log.length > 0 && outside.length === 0, `${outside.length} of ${log.length} outside`);
  const lock = q1("SELECT locked_at FROM weekly4_lock WHERE user_id = 1 AND week_start = '2026-09-25'");
  const early = log.filter((r) => r.user_id === 1 && r.week_start === '2026-09-25' && (!lock || r.first_seen_at < lock.locked_at));
  S.check('weekly: nothing is logged under the week of 09-25 before its four locked at Friday\'s refresh', Boolean(lock) && early.length === 0, `${early.length} early, lock at ${lock?.locked_at}`);
  const errs = w.srv.log().split('\n').filter((l) => /TypeError|ReferenceError|Unhandled/.test(l));
  S.check('no crash-type errors in the server log', errs.length === 0, errs.slice(0, 3).join(' | '));
});

// ============================================================ backups you can download (old G8 part)
await S.step('backups: download the latest, export and import the full setup', async () => {
  const dl = await fetch(`${w.base}/api/backup/latest`);
  const buf = Buffer.from(await dl.arrayBuffer());
  S.check('the owner downloads the newest backup as a SQLite file', dl.status === 200 && buf.subarray(0, 15).toString() === 'SQLite format 3', `${dl.status} ${buf.length} bytes`);
  S.check('a friend and the guest can\'t download it', (await w.api('GET', '/api/backup/latest', { as: F1 })).status === 403 && (await w.api('GET', '/api/backup/latest', { as: GUEST })).status === 403);
  const exp = await w.api('GET', '/api/state');
  S.check('the full setup exports as a download', exp.status === 200 && /attachment/.test(exp.headers.get('content-disposition') || '') && exp.json && typeof exp.json === 'object');
  const ratingsBefore = ownerRatings();
  const del = await w.api('DELETE', `/api/ratings/${C.RATED[0].id}`);
  S.check('setup: one rating removed before the import', del.status === 200 && ownerRatings() === ratingsBefore - 1);
  const imp = await w.api('POST', '/api/state', { body: exp.json });
  S.check('importing the exported setup is accepted', imp.status === 200 && imp.json?.imported, `${imp.status} ${imp.text.slice(0, 120)}`);
  await idle();
  S.check('the import brings the removed rating back (round trip)', ownerRatings() === ratingsBefore, `${ratingsBefore} -> ${ownerRatings()}`);
  S.check('a friend can\'t import a setup', (await w.api('POST', '/api/state', { as: F1, body: exp.json })).status === 403);
});

// ============================================================ months follow local time (old D6)
await S.step('the plan month, the savings month and seen this year follow local time', async () => {
  // Sept 30, 10:30 pm local is Oct 1 in UTC; Dec 31, 9 pm local is Jan 1.
  await w.restart({ fakeNow: '2026-09-30T22:30:00-04:00', env: { RP_DISABLE_REFRESH: '1', ...NO_S3 } });
  const m = await makeFriend(w.base, 'Monthly');
  const st = await w.api('PUT', '/api/settings', { as: m, body: { moviePlan: 'cinemark-movie-club', planPeriod: 'month', alistWeeklyLimit: 1, setupDone: true, tourDone: true } });
  S.check('setup: the friend is on a monthly plan', st.status === 200, `${st.status} ${st.text.slice(0, 80)}`);
  await w.api('POST', '/api/watched', { as: m, body: { tmdb_id: F3f.id, title: F3f.title } });
  const a1 = (await w.api('GET', '/api/alist', { as: m })).json;
  S.check('Sept 30, 10:30 pm: the film counts toward September\'s plan month', a1?.used === 1, `used ${a1?.used}`);
  S.check('Sept 30, 10:30 pm: and toward September\'s savings', a1?.savings?.monthTickets === 1, `tickets ${a1?.savings?.monthTickets}`);
  await w.jump('2026-10-01T00:30:00-04:00');
  const a2 = (await w.api('GET', '/api/alist', { as: m })).json;
  S.check('Oct 1, 12:30 am: October starts empty', a2?.used === 0 && a2?.savings?.monthTickets === 0, `used ${a2?.used}, tickets ${a2?.savings?.monthTickets}`);
  await w.api('POST', '/api/watched', { as: m, body: { tmdb_id: F4f.id, title: F4f.title } });
  S.check('Oct 1, 12:30 am: a film then counts toward October', (await w.api('GET', '/api/alist', { as: m })).json?.used === 1);
  await w.jump('2026-12-31T21:00:00-05:00');
  const s0 = (await w.api('GET', '/api/stats', { as: m })).json?.seenThisYear;
  await w.api('POST', '/api/watched', { as: m, body: { tmdb_id: F5f.id, title: F5f.title } });
  const s1 = (await w.api('GET', '/api/stats', { as: m })).json;
  S.check('Dec 31, 9 pm: a film counts as seen in 2026', s1?.year === 2026 && s1.seenThisYear - s0 === 1, `year ${s1?.year} +${s1?.seenThisYear - s0}`);
});

await w.close();
await Promise.all([amcProxy.shut(), pushSrv.shut(), lbxSrv.shut(), s3Srv.shut()]);
S.finish();
