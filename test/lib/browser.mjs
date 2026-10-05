// Browsers for the checks that drive the app: Chromium (and WebKit for the
// iPhone checks), each context on the tests' clock and time zone, signed in
// as one role, with every request that would leave the machine answered
// locally (posters, the trailer player, the two web fonts) or refused and
// recorded.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import * as C from './catalog.mjs';
import { reqEntries } from './world.mjs';

const FONTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'fonts');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HEIGHT = (w) => ({ 320: 568, 375: 812, 390: 844, 430: 932, 768: 1024, 1024: 768, 1280: 800, 1440: 900 }[w] || 844);

// Playwright's own browser build when it is installed; otherwise the newest
// build of that browser in Playwright's cache (installed by another version).
function executable(type) {
  const own = type.executablePath();
  if (fs.existsSync(own)) return undefined;
  const name = type.name();
  const m = own.match(new RegExp(`^(.*[\\\\/])${name}-\\d+([\\\\/].*)$`));
  if (!m) return undefined;
  const cache = m[1];
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => new RegExp(`^${name}-\\d+$`).test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])); } catch { /* no cache */ }
  for (const d of dirs) {
    const guess = cache + d + m[2];
    if (fs.existsSync(guess)) return guess;
    // Another build may name its app differently (Chromium.app, say).
    const mac = path.join(cache, d, 'chrome-mac-arm64');
    try {
      const app = fs.readdirSync(mac).find((f) => f.endsWith('.app'));
      if (app) return path.join(mac, app, 'Contents/MacOS', app.replace('.app', ''));
    } catch { /* not this layout */ }
  }
  return undefined;
}

export async function launch(kind = 'chromium') {
  const type = kind === 'webkit' ? webkit : chromium;
  return type.launch({ executablePath: executable(type) });
}

// A context and page. role: 'owner' | 'guest' | a friend { headers: { cookie } }.
// Collected: errors (console errors, page errors, 4xx/5xx from the app,
// native dialogs) and outside (requests to anywhere else that nothing here
// answers; there should be none).
export async function open(browser, w, {
  role = 'owner', width = 390, theme = 'light', reducedMotion = 'no-preference', hash = null, sw = false,
  height = null, touch = null, mobile = null, extraCtx = {}, allow403 = false, clock = true,
} = {}) {
  const phone = width <= 430;
  const isWebkit = browser.browserType().name() === 'webkit';
  const ctx = await browser.newContext({
    viewport: { width, height: height || HEIGHT(width) }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion,
    timezoneId: C.TZ, locale: 'en-US', serviceWorkers: sw ? 'allow' : 'block', acceptDownloads: true,
    ...((touch ?? width <= 1024) ? { hasTouch: true } : {}), ...((mobile ?? phone) && !isWebkit ? { isMobile: true } : {}),
    ...extraCtx,
  });
  // The app's clock matches the server's (both run on from the tests' T0).
  // clock: false leaves the page on real time (service-worker checks).
  const start = w.srv.fakeNowMs === undefined ? C.T0_MS : w.srv.fakeNowMs;
  if (clock && start != null) await ctx.clock.install({ time: start + (Date.now() - w.srv.startedAt) });
  const outside = [];
  await ctx.route((u) => !['localhost', '127.0.0.1'].includes(u.hostname), async (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'image.tmdb.org') return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (u.hostname === 'www.youtube-nocookie.com') return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Player</title><p>Player</p>' });
    if (u.hostname === 'fonts.googleapis.com') return r.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(FONTS, 'google-fonts.css')) });
    if (u.hostname === 'fonts.gstatic.com') {
      const f = path.join(FONTS, path.basename(u.pathname));
      if (fs.existsSync(f)) return r.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(f), headers: { 'access-control-allow-origin': '*' } });
    }
    outside.push(`${r.request().method()} ${u.origin}${u.pathname}`);
    return r.abort('blockedbyclient');
  });
  const R = role === 'owner' || !role ? null : role === 'guest' ? 'guest' : role;
  if (R === 'guest') await ctx.route((u) => u.hostname === 'localhost', (r) => r.continue({ headers: { ...r.request().headers(), 'cf-ray': 'test' } }));
  else if (R?.headers?.cookie) {
    const [k, ...v] = R.headers.cookie.split('=');
    await ctx.addCookies([{ name: k, value: v.join('='), domain: 'localhost', path: '/' }]);
  }
  const page = await ctx.newPage();
  const errors = [];
  const tag = `${R === 'guest' ? 'guest' : R?.name || 'owner'} ${width} ${theme}`;
  watch(page, w, tag, errors, { allow403 });
  if (hash != null) await go(page, w, hash);
  return { ctx, page, errors, outside, width, phone, theme, tag };
}

export function watch(page, w, tag, errors, { allow403 = false } = {}) {
  const base = () => w.base;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/ERR_BLOCKED_BY_CLIENT/.test(t)) return; // a refused outside request, recorded in `outside`
    if (allow403 && /status of 403/.test(t)) return;
    errors.push(`${tag} console: ${t.slice(0, 200)} @${page.url().replace(base(), '')}`);
  });
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message.slice(0, 200)} @${page.url().replace(base(), '')}`));
  page.on('response', (r) => {
    if (r.status() < 400 || !r.url().startsWith(base())) return;
    if (allow403 && r.status() === 403) return;
    errors.push(`${tag} ${r.status()} ${r.request().method()} ${r.url().replace(base(), '')}`);
  });
  page.on('dialog', (d) => { errors.push(`${tag} native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
}

export async function settle(page, ms = 250) {
  await page.waitForFunction(() => {
    const m = document.querySelector('#main');
    return m && m.children.length && !m.querySelector('.spinner, .skeleton, .boot');
  }, null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

// Opens #/<hash> (a fresh load unless the page is already on the app, in which
// case the hash changes the way the app's own links do).
export async function go(page, w, hash, ms = 300, { fresh = false } = {}) {
  const h = hash.startsWith('#') ? hash : `#/${hash}`;
  if (fresh || !page.url().startsWith(w.base)) await page.goto(`${w.base}/${h}`);
  else if (new URL(page.url()).hash === h) await page.reload();
  else await page.evaluate((x) => { location.hash = x; }, h);
  await page.waitForTimeout(50);
  await settle(page, ms);
}

// Text of the first toast not read before that matches `re` (waits for it).
export async function toastText(page, re = null, timeout = 8000) {
  let text = '';
  try {
    const hnd = await page.waitForFunction((src) => {
      const t = [...document.querySelectorAll('.toast:not([data-read])')].find((x) => !src || new RegExp(src, 'i').test(x.textContent));
      return t ? t.textContent.trim() : false;
    }, re ? re.source : null, { timeout });
    text = await hnd.jsonValue();
  } catch {
    text = await page.evaluate(() => [...document.querySelectorAll('.toast:not([data-read])')].map((t) => t.textContent.trim()).join(' | '));
  }
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.setAttribute('data-read', '1'))).catch(() => {});
  return text;
}

// Visible: laid out and not hidden by any ancestor (for page.evaluate).
export const VISIBLE = `(el) => { if (!el || el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let a = el; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; } return true; }`;

// Picks files in an import input and waits until `done` (a page predicate)
// holds, counting it only once the result box has changed since the pick.
// Until the page writes something new the box still shows the upload before,
// and a slow page can spend a while reading the file first. Changes are
// counted, not compared: two uploads in a row can end with the same words.
// Never waits for good and never fails quietly: after `timeout` it returns
// text starting "TIMED OUT" that says where the import stopped: the page
// never sent it, the browser is still waiting for POST /api/ratings/import,
// or it was answered and the page never finished. With the world's request
// log on (openWorld reqLog), it says too whether the server got the request
// and answered it.
let importSeq = 0;
export async function importFiles(page, w, input, files, done, { result = '.import-result', timeout = 30000 } = {}) {
  const posts = [];
  const isImport = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/ratings/import';
  const onRequest = (r) => { if (isImport(r)) posts.push({ r, at: Date.now(), state: 'waiting' }); };
  const onFinished = (r) => { const p = posts.find((x) => x.r === r); if (p) p.state = 'answered'; };
  const onFailed = (r) => { const p = posts.find((x) => x.r === r); if (p) p.state = `failed (${r.failure()?.errorText || 'no reason'})`; };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  const key = `rpImport${++importSeq}`;
  const t0 = Date.now();
  try {
    // Counts every change in or to the box (text, children, attributes such
    // as hidden), and the box itself being put in or taken out.
    await page.evaluate(([key, sel]) => {
      const inBox = (n) => Boolean((n.nodeType === 1 ? n : n.parentElement)?.closest(sel));
      const holdsBox = (n) => n.nodeType === 1 && (n.matches(sel) || Boolean(n.querySelector(sel)));
      const seen = { changes: 0 };
      seen.observer = new MutationObserver((list) => {
        for (const m of list) if (inBox(m.target) || [...m.addedNodes, ...m.removedNodes].some(holdsBox)) seen.changes++;
      });
      seen.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      window[key] = seen;
    }, [key, result]);
    await page.locator(input).setInputFiles(files);
    const ok = await page.waitForFunction(`window[${JSON.stringify(key)}]?.changes > 0 && (${done})()`, null, { timeout }).then(() => true, () => false);
    const text = (await page.locator(result).first().textContent({ timeout: 2000 }).catch(() => null)) ?? '';
    if (ok) return text;
    const changes = await page.evaluate((key) => window[key]?.changes, key).catch(() => null);
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
    let why;
    const stuck = posts.filter((p) => p.state === 'waiting');
    if (!posts.length) why = `the page never sent POST /api/ratings/import${changes === 0 ? ' and never changed the result box after the pick' : ''}`;
    else if (!stuck.length) why = `every POST /api/ratings/import was answered (${posts.map((p) => p.state).join(', ')}), but the page never finished`;
    else {
      const p = stuck[0];
      const log = w?.srv ? reqEntries(w.srv) : null;
      let server = 'the server was not logging requests';
      if (log) {
        // Only what the server logged after this pick (the upload before can
        // end a moment earlier). Its answer is logged by request id, no url.
        const mine = log.filter((e) => e.at >= t0);
        const got = mine.find((e) => e.ev === 'in' && e.url === '/api/ratings/import');
        const out = got && mine.find((e) => e.id === got.id && e.ev !== 'in' && e.ev !== 'body read');
        server = !got ? 'the server never received it'
          : out ? `the server received it and ${out.ev === 'out' ? `answered ${out.status} after ${secs(out.ms)}` : `closed it unanswered after ${secs(out.ms)}`}`
            : `the server received it ${secs(got.at - p.at)} after it was sent and never answered`;
      }
      why = `POST /api/ratings/import was sent ${secs(Date.now() - p.at)} ago and the browser has no answer; ${server}`;
    }
    return `TIMED OUT after ${secs(Date.now() - t0)}: ${why}. The page says: "${text.slice(0, 200)}"`;
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    await page.evaluate((key) => { window[key]?.observer.disconnect(); delete window[key]; }, key).catch(() => {});
  }
}
