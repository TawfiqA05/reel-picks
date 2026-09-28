// Browsers for the checks that drive the app: Chromium (and WebKit for the
// iPhone checks), each context on the tests' clock and time zone, signed in
// as one role, with every request that would leave the machine answered
// locally (posters, the trailer player, the two web fonts) or refused and
// recorded.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import * as C from './catalog.mjs';

const FONTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'fonts');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
export const HEIGHT = (w) => ({ 320: 568, 375: 812, 390: 844, 430: 932, 768: 1024, 1024: 768, 1280: 800, 1440: 900 }[w] || 844);

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

// WCAG contrast helpers, for page.evaluate (addInitScript) use.
export const COLOR_LIB = `
window.__rp = window.__rp || {};
__rp.parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
__rp.lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
__rp.ratio = (a, b) => { const x = __rp.lum(a), y = __rp.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
__rp.over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
__rp.bgOf = (el) => { const stack = []; for (let a = el; a; a = a.parentElement) { const c = __rp.parse(getComputedStyle(a).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let col = { r: 255, g: 255, b: 255, a: 1 }; if (!stack.length || stack[stack.length - 1].a < 1) col = __rp.parse(getComputedStyle(document.body).backgroundColor) || col; for (let i = stack.length - 1; i >= 0; i--) col = __rp.over(stack[i], col); return col; };
`;
