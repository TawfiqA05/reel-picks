// The test world: the app copied into a temp folder, a sample database built
// from the made-up catalog, and servers started on free ports with no key,
// no .env and no network (preload.mjs).
//
// buildBase() makes the sample database once per run: the owner picks two
// theaters, the real refresh pulls the made-up AMC lineup, the owner rates
// thirty films through the API, and three friends join through real invite
// links (one with 700 ratings, one empty, one brand new). openWorld() copies
// that database for one suite and starts a server on it.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import * as C from './catalog.mjs';
import { amcMock, pushMock, letterboxdMock, sleep } from './mocks.mjs';

export { sleep };
export const HERE = path.dirname(new URL(import.meta.url).pathname);
export const REPO = path.resolve(HERE, '..', '..');
export const PRELOAD = path.join(HERE, 'preload.mjs');
export const GUEST = { 'cf-ray': 'test' };
const TMP = fs.realpathSync(os.tmpdir());

const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ } });

export async function until(fn, ms = 20000, step = 100) {
  const t = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export function tempDir(tag) {
  return fs.mkdtempSync(path.join(TMP, `reel-picks-test-${tag}-`));
}

// The app as it is in the working tree, copied so the server reads no .env
// and can't reach the repo's data folder.
export function copyApp(dir) {
  const app = path.join(dir, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const p of ['server', 'public', 'package.json']) fs.cpSync(path.join(REPO, p), path.join(app, p), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  return app;
}

// A JSON API call. `as`: undefined for the owner (localhost), GUEST, or a
// friend { headers }. One the server doesn't answer within CALL_TIMEOUT_MS
// fails with a message saying so, instead of waiting for good.
const CALL_TIMEOUT_MS = 90000;
export async function call(base, method, p, { body, headers = {}, as = null, raw = false } = {}) {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let res; let text;
  try {
    res = await fetch(base + p, {
      method, redirect: 'manual', signal,
      headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(as?.headers || as || {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`${method} ${p.slice(0, 80)}: the test server gave no answer in ${CALL_TIMEOUT_MS / 1000}s`);
    throw e;
  }
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// Only these reach the server: no key or other secret from the caller's
// environment can leak into a test server.
function cleanEnv(extra) {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SystemRoot'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

// A port found free can be taken by another process before the server
// listens on it (other suites start servers at the same time); the server
// then starts again on a new one, up to three times.
export async function startServer({ app, dataDir, env = {}, label = 'server' }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce({ app, dataDir, env, label });
    } catch (e) {
      if (attempt >= 3 || !/EADDRINUSE/.test(String(e.message))) throw e;
    }
  }
}

async function startOnce({ app, dataDir, env, label }) {
  const port = await freePort();
  const startedAt = Date.now();
  const fakeNow = env.RP_FAKE_NOW ?? C.T0;
  const netLog = path.join(dataDir, '..', `net-${label}-${port}.jsonl`);
  const reqLog = env.RP_REQ_LOG || process.env.RP_REQ_LOG || null;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${PRELOAD}`, 'server/index.js'], {
    cwd: app,
    env: cleanEnv({
      TZ: C.TZ, DATA_DIR: dataDir, PORT: String(port), RP_NET_LOG: netLog, RP_FAKE_NOW: C.T0,
      RP_DISABLE_REFRESH: '1', OWNER_NAME: C.OWNER_NAME,
      TMDB_API_KEY: 'test-tmdb-key', OMDB_API_KEY: 'test-omdb-key', AMC_API_KEY: 'test-amc-key',
      RP_LETTERBOXD_ORIGIN: 'http://127.0.0.1:9',
      ...(reqLog ? { RP_REQ_LOG: reqLog } : {}),
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (!out.includes('Reel Picks running')) {
    if (child.exitCode != null || Date.now() - t0 > 20000) {
      if (child.exitCode == null) child.kill('SIGKILL');
      children.delete(child);
      throw new Error(`server did not start:\n${out.slice(-2000)}`);
    }
    await sleep(50);
  }
  child.on('exit', () => children.delete(child));
  return {
    child, port, dataDir, netLog, reqLog, startedAt, fakeNowMs: fakeNow ? Date.parse(fakeNow) : null, base: `http://localhost:${port}`, log: () => out,
    stop: (sig = 'SIGTERM') => new Promise((r) => { if (child.exitCode != null || child.signalCode != null) return r(); child.once('exit', () => r()); child.kill(sig); }),
  };
}

// What the server logged about each request (RP_REQ_LOG; test/lib/preload.mjs).
export function reqEntries(server) {
  if (!server.reqLog) return null;
  try { return fs.readFileSync(server.reqLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.port === server.port); } catch { return []; }
}

// Every outside request the server made, from its network log.
function netEntries(server) {
  try { return fs.readFileSync(server.netLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

const snapshot = (dbFile, to) => {
  const src = new DatabaseSync(dbFile, { readOnly: true });
  try { src.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { src.close(); }
};

// ---------------------------------------------------------------- the base world
export async function makeFriend(base, name) {
  const r = await call(base, 'POST', '/api/friends', { body: { name } });
  if (r.status !== 200) throw new Error(`create friend ${name}: ${r.status} ${r.text}`);
  const token = new URL(r.json.invite, 'http://x').searchParams.get('invite');
  const j = await fetch(`${base}/invite/join`, {
    method: 'POST', redirect: 'manual',
    headers: { origin: base, 'cf-ray': 'test', 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${token}`,
  });
  const cookie = (j.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('rp_user=')) throw new Error(`join gave no friend cookie (${j.status})`);
  return { id: r.json.friend.id, name, cookie, headers: { 'cf-ray': 'test', cookie } };
}

// 700 ratings for the heavy friend, made straight in the database (generated
// films spread over years), as the earlier seeds did.
function seedHeavy(dbFile, userId) {
  const d = new DatabaseSync(dbFile);
  const W1 = ['Silent', 'Crimson', 'Last', 'Hidden', 'Broken', 'Golden', 'Midnight', 'Northern', 'Burning', 'Paper', 'Glass', 'Iron', 'Velvet', 'Hollow', 'Wild', 'Distant', 'Quiet', 'Electric', 'Frozen', 'Scarlet', 'Lonely', 'Secret', 'Bitter', 'Endless', 'Fallen', 'Savage', 'Tender', 'Restless', 'Wicked'];
  const W2 = ['River', 'Harbor', 'Garden', 'Engine', 'Kingdom', 'Letter', 'Summer', 'Station', 'Mirror', 'Island', 'Circus', 'Orchard', 'Signal', 'Frontier', 'Lantern', 'Canyon', 'Parade', 'Voyage', 'Empire', 'Winter', 'Chorus', 'Tide', 'Border', 'Theory'];
  const GEN = ['Drama', 'Comedy', 'Thriller', 'Horror', 'Romance', 'Science Fiction', 'Action', 'Documentary', 'Animation', 'Crime'];
  const now = new Date(C.BUILD_AT).toISOString();
  const insMovie = d.prepare('INSERT OR IGNORE INTO movies(tmdb_id, title, year, genres, director, cast, tmdb_rating, tmdb_votes, details_at, first_seen_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const insRating = d.prepare('INSERT OR REPLACE INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at) VALUES(?,?,?,?,?,?,?,?)');
  d.exec('PRAGMA busy_timeout = 5000');
  d.exec('BEGIN');
  for (let i = 0; i < 700; i++) {
    const title = `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]}${i >= W1.length * W2.length ? ` ${Math.floor(i / (W1.length * W2.length)) + 1}` : ''}`;
    const id = 90000000 + i;
    const genres = [...new Set([GEN[i % GEN.length], GEN[(i * 3 + 1) % GEN.length]])];
    insMovie.run(id, title, 1970 + (i % 55), JSON.stringify(genres), `Director ${i % 60}`, JSON.stringify([`Actor ${i % 250}`, `Actor ${(i * 7) % 250}`, `Actor ${(i * 3) % 250}`]), 6 + (i % 30) / 10, 50 + i, now, now, now);
    insRating.run(userId, id, title, 1970 + (i % 55), 0.5 + (i % 10) / 2, 'letterboxd', new Date(Date.parse('2026-09-20T12:00:00Z') - (i + 1) * 2.6 * 864e5).toISOString(), now);
  }
  d.exec('COMMIT');
  d.close();
}

const BASE_ENV = (amc) => ({ RP_AMC_BASE: amc.origin, RP_FAKE_NOW: C.BUILD_AT, RP_TIMEOUT_SCALE: '0.02' });

// Waits until no refresh, matching run or credits backfill is going.
export async function settled(base, ms = 60000) {
  let quiet = 0;
  return until(async () => {
    const s = (await call(base, 'GET', '/api/status')).json;
    quiet = s && !s.refreshing && !s.matching && !s.enriching ? quiet + 1 : 0;
    return quiet >= 3 && s;
  }, ms, 150);
}

export async function buildBase(dir = tempDir('base')) {
  const t0 = Date.now();
  const app = copyApp(dir);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const amc = await amcMock();
  try {
    // 1. Schema and owner, theaters chosen the way Settings does it.
    let srv = await startServer({ app, dataDir, env: BASE_ENV(amc), label: 'build1' });
    const B = srv.base;
    const must = async (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r; };
    await must(await call(B, 'POST', '/api/theatre', { body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } }), 'owner primary theater');
    await must(await call(B, 'POST', '/api/theatres/follow', { body: { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8' } }), 'owner second theater');
    await must(await call(B, 'PUT', '/api/settings', { body: { home: C.HOME, setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true, streamingServices: ['netflix'] } }), 'owner settings');
    await srv.stop();

    // 2. The real refresh pulls the made-up lineup.
    srv = await startServer({ app, dataDir, env: { ...BASE_ENV(amc), RP_DISABLE_REFRESH: '0' }, label: 'build2' });
    const B2 = srv.base;
    const done = await until(async () => { const s = (await call(B2, 'GET', '/api/status')).json; return s?.lastRefresh && !s.refreshing && s; }, 60000, 200);
    if (!done) throw new Error(`the first refresh did not finish:\n${srv.log().slice(-1500)}`);

    // 3. The owner rates, watchlists; friends join.
    for (const f of C.RATED) {
      await must(await call(B2, 'POST', '/api/ratings', { body: { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year, source: 'manual' } }), `rate ${f.title}`);
    }
    await must(await call(B2, 'POST', '/api/watchlist/toggle', { body: { tmdb_id: 990002 } }), 'watchlist');
    await must(await call(B2, 'POST', '/api/watchlist/toggle', { body: { tmdb_id: 970001 } }), 'watchlist upcoming');
    const robin = await makeFriend(B2, 'Robin');
    const casey = await makeFriend(B2, 'Casey');
    const jordan = await makeFriend(B2, 'Jordan');
    await must(await call(B2, 'POST', '/api/theatre', { as: robin, body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } }), 'robin theater');
    await must(await call(B2, 'PUT', '/api/settings', { as: robin, body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true, streamingServices: ['netflix', 'max'], moviePlan: 'none' } }), 'robin settings');
    await must(await call(B2, 'POST', '/api/theatre', { as: casey, body: { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8' } }), 'casey theater');
    await must(await call(B2, 'POST', '/api/theatre', { as: jordan, body: { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12' } }), 'jordan theater');
    await must(await call(B2, 'PUT', '/api/settings', { as: casey, body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true } }), 'casey settings');
    for (const f of C.RATED.slice(0, 8)) {
      await must(await call(B2, 'POST', '/api/ratings', { as: robin, body: { tmdb_id: f.id, rating: 5.5 - f.stars > 0.5 ? 5.5 - f.stars : 1, title: f.title, year: f.year } }), `robin rates ${f.title}`);
    }
    await must(await call(B2, 'POST', '/api/watchlist/toggle', { as: robin, body: { tmdb_id: 990004 } }), 'robin watchlist');
    if (!await settled(B2)) throw new Error('background work did not settle');
    // The people warm-up (a week's cache) finishes before the snapshot.
    await until(async () => netEntries(srv).filter((e) => /\/movie\/\d+\/credits$/.test(e.path)).length >= C.CLASSICS.length - 10, 60000, 250);
    await sleep(500);
    await srv.stop();
    seedHeavy(path.join(dataDir, 'reelpicks.db'), robin.id);

    const snap = path.join(dir, 'base.db');
    snapshot(path.join(dataDir, 'reelpicks.db'), snap);
    const meta = {
      dir, snap, builtMs: Date.now() - t0,
      friends: Object.fromEntries([robin, casey, jordan].map((f) => [f.name.toLowerCase(), { id: f.id, name: f.name, cookie: f.cookie }])),
    };
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(meta, null, 2));
    return meta;
  } finally {
    await amc.srv.shut();
  }
}

function loadBase() {
  const p = process.env.RP_TEST_BASE;
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(path.join(p, 'base.json'), 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- one suite's world
// opts: env (extra server env), refresh (let refreshes run), push (a push
// stand-in with test VAPID keys), letterboxd (feeds), ctrl (a control file
// for clock jumps), prepare(db) (edits the copied database before start),
// reqLog (the server logs every request, see reqEntries).
export async function openWorld(name, opts = {}) {
  let baseMeta = loadBase();
  let ownBase = null;
  if (!baseMeta) { ownBase = tempDir('base'); baseMeta = await buildBase(ownBase); }
  const dir = tempDir(name);
  const app = copyApp(dir);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'reelpicks.db');
  fs.copyFileSync(baseMeta.snap, dbFile);
  if (opts.prepare) { const d = new DatabaseSync(dbFile); try { await opts.prepare(d); } finally { d.close(); } }

  const amc = await amcMock();
  const push = opts.push ? await pushMock() : null;
  const lb = opts.letterboxd ? await letterboxdMock(opts.letterboxd) : null;
  const ctrlFile = path.join(dir, 'ctrl.json');
  let ctrlSeq = 0;
  const ctrlState = { tmdb: 'ok', omdb: {} };
  const writeCtrl = (extra = {}) => fs.writeFileSync(ctrlFile, JSON.stringify({ seq: ++ctrlSeq, ...ctrlState, ...extra }));
  writeCtrl();
  const vapid = (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return { VAPID_PUBLIC_KEY: e.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: e.getPrivateKey().toString('base64url') }; })();
  const envFor = (extra = {}) => ({
    RP_AMC_BASE: amc.origin, RP_CTRL_FILE: ctrlFile,
    ...(opts.refresh ? { RP_DISABLE_REFRESH: '0' } : {}),
    ...(push ? { RP_PUSH_TEST_ORIGIN: push.origin, ...vapid } : {}),
    ...(lb ? { RP_LETTERBOXD_ORIGIN: lb.origin } : {}),
    ...(opts.reqLog ? { RP_REQ_LOG: path.join(dir, `req-${name}.jsonl`) } : {}),
    ...(opts.env || {}), ...extra,
  });
  let srv = await startServer({ app, dataDir, env: envFor(), label: name });
  const friends = Object.fromEntries(Object.entries(baseMeta.friends).map(([k, f]) => [k, { ...f, headers: { 'cf-ray': 'test', cookie: f.cookie } }]));
  const w = {
    name, dir, app, dataDir, dbFile, amc, push, lb, ctrl: ctrlState, writeCtrl, friends, GUEST,
    get srv() { return srv; },
    get base() { return srv.base; },
    api: (m, p, o = {}) => call(srv.base, m, p, o),
    // Jump the server's clock (a running server picks it up within ~20 ms).
    async jump(iso) { writeCtrl({ now: iso }); await sleep(120); },
    async restart({ env = {}, fakeNow = null } = {}) {
      await srv.stop();
      srv = await startServer({ app, dataDir, env: envFor({ ...(fakeNow ? { RP_FAKE_NOW: fakeNow } : {}), ...env }), label: `${name}-r` });
      return srv;
    },
    db() { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 5000'); return d; },
    q(sql, ...p) { const d = w.db(); try { return d.prepare(sql).all(...p); } finally { d.close(); } },
    q1(sql, ...p) { return w.q(sql, ...p)[0]; },
    net: () => netEntries(srv),
    // Outside requests the server made that nothing answered.
    unanswered() {
      const all = [];
      for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('net-'))) {
        for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
          const e = JSON.parse(l);
          if (e.how === 'refused' || e.how === 'miss') all.push(e);
        }
      }
      return all;
    },
    async close() {
      await srv.stop();
      await amc.srv.shut();
      if (push) await push.srv.shut();
      if (lb) await lb.shut();
      if (!process.env.RP_KEEP_TEMP) {
        fs.rmSync(dir, { recursive: true, force: true });
        if (ownBase) fs.rmSync(ownBase, { recursive: true, force: true });
      }
    },
  };
  return w;
}
