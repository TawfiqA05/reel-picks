// Service worker and new deploys (final-polish G8 service-worker part, R8,
// real-app G11 update reaches the installed app):
//
//   update     a new deploy (sw.js cache version moves on and the server
//              restarts, as on Railway) reaches an open page: with a sheet open
//              "Update ready" shows and Refresh reloads onto the new version;
//              with nothing open it reloads once by itself; one cache is kept.
//   offline    offline, a reload is served the cached shell with its styles,
//              pages say "You're offline", Add to calendar says so, and Retry
//              works once back online.
//   installed  WebKit as an iPhone in standalone mode, service workers on: an
//              app running an old build picks up the new build within one open
//              without a tap, when it comes back to the foreground (on a good
//              network and on one that fails for the first 3s), when it is
//              launched again (good network, a network that fails at launch,
//              a network that answers every request with an error), never in a
//              reload loop, and not while a sheet is open.
//
// A deploy edits the world's own temp copy of the app (never the repo's
// public/). A small proxy sits in front of the server so the origin, and
// with it the service worker's scope, stays the same across restarts, and so
// the network can be dropped for a few seconds.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { suite } from '../lib/check.mjs';
import { openWorld, call } from '../lib/world.mjs';
import { launch, open, settle, toastText } from '../lib/browser.mjs';

const S = suite('sw');
const w = S.world(await openWorld('sw'));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const SW = path.join(w.app, 'public/sw.js');
const APPJS = path.join(w.app, 'public/js/app.js');
const baseVersion = fs.readFileSync(SW, 'utf8').match(/const CACHE = '([^']+)'/)[1];

// ---- proxy -----------------------------------------------------------------------
const px = { down: false, errors: false };
const proxy = http.createServer((req, res) => {
  if (px.down) { req.socket.destroy(); return; }
  if (px.errors) { res.writeHead(408, { 'content-type': 'text/plain', connection: 'close' }); res.end('Request Timeout'); return; }
  const up = http.request({ host: '127.0.0.1', port: w.srv.port, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${proxy.address().port}`;
// The browser helper's view of this world: the proxy's origin, the live server.
const viaProxy = { get srv() { return w.srv; }, base: origin };

// A deploy: a new cache version (and a build marker in app.js), then a restart.
let build = 0;
async function deploy(tag = null) {
  build++;
  fs.writeFileSync(SW, fs.readFileSync(SW, 'utf8').replace(/const CACHE = '[^']+';/, `const CACHE = '${tag || `${baseVersion}-b${build}`}';`));
  fs.writeFileSync(APPJS, fs.readFileSync(APPJS, 'utf8').replace(/\nwindow\.__rpBuild = \d+;\n?$/, '') + `\nwindow.__rpBuild = ${build};\n`);
  // A busy machine can miss the start-up window once; a deploy tries again.
  for (let i = 0; ; i++) {
    try { await w.restart(); return; } catch (e) { if (i >= 2) throw e; }
  }
}

const version = (page) => page.evaluate(() => new Promise((resolve) => {
  const c = navigator.serviceWorker.controller;
  if (!c) return resolve(null);
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data?.version || null);
  c.postMessage({ type: 'version' }, [ch.port2]);
  setTimeout(() => resolve('timeout'), 3000);
})).catch(() => null);
const waitControlled = (page, v = null) => page.waitForFunction(async (want) => {
  const c = navigator.serviceWorker.controller;
  if (!c) return false;
  if (!want) return true;
  const got = await new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => resolve(e.data?.version); c.postMessage({ type: 'version' }, [ch.port2]); setTimeout(() => resolve(null), 1000); });
  return got === want;
}, v, { timeout: 20000, polling: 300 }).catch(() => {});

const chromium = await launch('chromium');

await S.step('update: a new deploy reaches an open page', async () => {
  await deploy(baseVersion); // a build marker from here on; the version is still today's
  const { page, ctx, errors } = await open(chromium, viaProxy, { width: 1280, theme: 'light', sw: true });
  try {
    await page.goto(`${origin}/#/home`); await settle(page, 500);
    await waitControlled(page);
    S.check('update: the page is controlled by the service worker', await version(page) === baseVersion, String(await version(page)));
    // Busy (a sheet open): the toast, then the tap.
    await page.evaluate(() => { window.__marker = 1; });
    await page.locator('#search-btn').click();
    await page.waitForSelector('.modal-overlay.show');
    await deploy(`${baseVersion}-next`);
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update())).catch(() => {});
    const toast = page.locator('.toast', { hasText: 'Update ready' });
    await toast.waitFor({ timeout: 30000 }).catch(() => {});
    S.check('update: with a sheet open, "Update ready" shows instead of a reload', await toast.count() === 1 && await page.evaluate(() => window.__marker === 1));
    const [nav] = await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => null), toast.locator('.toast-action', { hasText: 'Refresh' }).click().catch((e) => e)]);
    await settle(page, 500);
    await waitControlled(page, `${baseVersion}-next`);
    S.check('update: tapping Refresh reloads the page', Boolean(nav) && await page.evaluate(() => window.__marker === undefined));
    S.check('update: the reloaded page runs the new version', await version(page) === `${baseVersion}-next`, String(await version(page)));
    // Not busy: it reloads once on its own.
    await page.evaluate(() => { window.__marker = 2; });
    await deploy(`${baseVersion}-next2`);
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }).catch(() => null),
      page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update())).catch(() => {}),
    ]);
    await settle(page, 500);
    await waitControlled(page, `${baseVersion}-next2`);
    S.check('update: with nothing open, the page reloads onto the new version by itself', await page.evaluate(() => window.__marker === undefined) && await version(page) === `${baseVersion}-next2`, String(await version(page)));
    S.check('update: no Update ready toast is left behind', await page.locator('.toast', { hasText: 'Update ready' }).count() === 0);
    const keys = await page.evaluate(() => caches.keys());
    S.check('update: only the current version\'s cache is kept', keys.length === 1 && keys[0] === `${baseVersion}-next2`, keys.join(','));
    S.check('update: no console error or failed request', !errors.length, errors.slice(0, 4).join(' | '));
  } finally { await ctx.close(); }
});

await S.step('offline: cached shell, offline state, calendar guard, Retry', async () => {
  const { page, ctx, errors } = await open(chromium, viaProxy, { width: 390, theme: 'dark', sw: true });
  try {
    await page.goto(`${origin}/#/home`); await settle(page, 500);
    await waitControlled(page);
    await page.reload(); await settle(page, 500);
    const film = (await call(w.base, 'GET', '/api/recommendations')).json.weekly4[0];
    await page.evaluate((id) => { location.hash = `#/movie/${id}`; }, film.tmdb_id);
    await settle(page, 500);
    const m0 = errors.length;
    await ctx.setOffline(true);
    const cal = page.locator('.cal-btn').first();
    S.check('offline: the movie page has an Add to calendar button', await cal.count() > 0);
    if (await cal.count()) {
      await cal.scrollIntoViewIfNeeded();
      await cal.click();
      S.check('offline: Add to calendar says you\'re offline', /offline/i.test(await toastText(page, /offline/)));
    }
    const nav = await page.reload().then(() => true).catch((e) => e.message);
    await page.waitForTimeout(1500);
    S.check('offline: a reload is served the cached app shell', nav === true && await page.locator('.app-header .brand').count() === 1, String(nav));
    S.check('offline: styles come from the cache too', await page.evaluate(() => getComputedStyle(document.querySelector('.app-header')).position).catch(() => '') === 'sticky');
    S.check('offline: the page says you\'re offline', /You're offline/.test(await page.locator('#main').textContent()), (await page.locator('#main').textContent()).slice(0, 120));
    await page.evaluate(() => { location.hash = '#/stats'; });
    await page.waitForTimeout(800);
    S.check('offline: other pages say it too', /You're offline/.test(await page.locator('#main').textContent()));
    await ctx.setOffline(false);
    await page.locator('#main button', { hasText: 'Retry' }).click();
    await settle(page, 800);
    S.check('offline: Retry loads the page once back online', await page.locator('.big-stat').count() > 0);
    // The offline 503s are the worker's own answer; nothing else may fail.
    const bad = errors.slice(m0).filter((e) => !/503 GET \/api\/|status of 503|ERR_INTERNET_DISCONNECTED/.test(e));
    S.check('offline: no unexpected errors', !bad.length && m0 === 0, [...errors.slice(0, m0), ...bad].slice(0, 4).join(' || '));
  } finally { await ctx.close(); }
});
await chromium.close();

// ---- the installed app (WebKit, iPhone, standalone) -----------------------------
const webkit = await launch('webkit');
const WAIT_MS = 40000;
const buildOf = (page) => page.evaluate(() => window.__rpBuild).catch(() => null);
async function installed() {
  const p = await open(webkit, viaProxy, { width: 390, theme: 'light', sw: true, touch: true, clock: false, extraCtx: { isMobile: true, userAgent: IPHONE_UA } });
  await p.ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
  });
  await p.page.goto(`${origin}/#/home`);
  await p.page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 });
  await p.page.waitForTimeout(1500);
  const loads = { n: 0 };
  p.page.on('load', () => { loads.n++; });
  return { ...p, loads };
}
async function resume(page) {
  await page.evaluate(() => {
    const set = (v) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    set('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    set('visible'); document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('focus'));
  });
}
async function waitFor(page, want) {
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_MS) {
    if ((await buildOf(page)) === want) return Date.now() - t0;
    await page.waitForTimeout(250);
  }
  return null;
}
async function relaunch(ctx, page) {
  await page.close();
  const p2 = await ctx.newPage();
  const loads = { n: 0 }; p2.on('load', () => { loads.n++; });
  return { p2, loads };
}
const scenario = (name, what, fn) => S.step(`installed app: ${name}`, async () => {
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, why: e.message.split('\n')[0] }; }
  px.down = false; px.errors = false;
  S.check(`installed app: ${what}`, r.ok, JSON.stringify(r));
});

await deploy();
await scenario('resume on a flaky network', 'back in the foreground while the first requests fail for 3s, it reaches the new build within one open, reloading at most once', async () => {
  const { ctx, page, loads } = await installed();
  const was = await buildOf(page);
  await deploy();
  px.down = true;
  await resume(page);
  await page.waitForTimeout(3000);
  px.down = false;
  const ms = await waitFor(page, build);
  await page.waitForTimeout(4000);
  const r = { ok: ms != null && loads.n <= 1 && was === build - 1, was, now: await buildOf(page), ms, reloads: loads.n };
  await ctx.close();
  return r;
});
await scenario('resume', 'back in the foreground on a good network, it reaches the new build within one open, reloading at most once', async () => {
  const { ctx, page, loads } = await installed();
  await deploy();
  await resume(page);
  const ms = await waitFor(page, build);
  await page.waitForTimeout(4000);
  const r = { ok: ms != null && loads.n <= 1, now: await buildOf(page), ms, reloads: loads.n };
  await ctx.close();
  return r;
});
await scenario('cold launch', 'launched again on a good network, it reaches the new build within that launch', async () => {
  const { ctx, page } = await installed();
  await deploy();
  const { p2, loads } = await relaunch(ctx, page);
  await p2.goto(`${origin}/#/home`);
  const ms = await waitFor(p2, build);
  await p2.waitForTimeout(4000);
  const r = { ok: ms != null && loads.n <= 2, now: await buildOf(p2), ms, loads: loads.n };
  await ctx.close();
  return r;
});
await scenario('cold launch on a flaky network', 'launched while the network is down (3 launches): the cached shell opens and every launch reaches the new build within its open', async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { ctx, page } = await installed();
    await deploy();
    const { p2, loads } = await relaunch(ctx, page);
    px.down = true;
    await p2.goto(`${origin}/#/home`).catch(() => {});
    await p2.waitForTimeout(3000);
    px.down = false;
    const ms = await waitFor(p2, build);
    await p2.waitForTimeout(2000);
    // A stalled start is reloaded by the watchdog (index.html): up to three loads.
    runs.push({ ok: ms != null && loads.n <= 3, ms, loads: loads.n });
    await ctx.close();
  }
  return { ok: runs.every((x) => x.ok), runs };
});
await scenario('cold launch while every request errors', 'launched while the network answers every request with a 408: the cached files are used, then the new build arrives', async () => {
  const { ctx, page } = await installed();
  await deploy();
  const { p2, loads } = await relaunch(ctx, page);
  px.errors = true;
  await p2.goto(`${origin}/#/home`).catch(() => {});
  await p2.waitForTimeout(3000);
  px.errors = false;
  const ms = await waitFor(p2, build);
  await p2.waitForTimeout(4000);
  const r = { ok: ms != null && loads.n <= 2, now: await buildOf(p2), ms, loads: loads.n };
  await ctx.close();
  return r;
});
await scenario('busy', 'with a sheet open on resume, it waits (no reload for 8s), then moves to the new build once the sheet closes', async () => {
  const { ctx, page, loads } = await installed();
  await page.waitForSelector('#search-btn:not([hidden])', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#search-btn').click());
  await page.waitForSelector('.modal-overlay.show');
  await deploy();
  await resume(page);
  await page.waitForTimeout(8000);
  const during = await buildOf(page);
  const stillOpen = Boolean(await page.$('.modal-overlay'));
  await page.keyboard.press('Escape');
  const ms = await waitFor(page, build);
  await page.waitForTimeout(3000);
  const r = { ok: during === build - 1 && stillOpen && ms != null && loads.n <= 1, during, stillOpen, now: await buildOf(page), ms, reloads: loads.n };
  await ctx.close();
  return r;
});

await webkit.close();
await new Promise((r) => { proxy.closeAllConnections?.(); proxy.close(r); });
await w.close();
S.finish();
