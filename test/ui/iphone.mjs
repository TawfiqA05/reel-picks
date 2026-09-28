// iPhone checks (real-app G1 scroll end, the WebKit part of G2 header paint,
// final-polish G11 standalone):
//
//   scroll end   scrolled to the very end, the last content sits fully above
//                the tab bar (and the Save bar when it shows) with the same
//                gap on every page and state, in WebKit as an iPhone (and as
//                the installed app with a 34px home-indicator inset) and in
//                Chromium with the same inset; closing any sheet leaves the
//                page scrollable and touchable.
//   header       on a movie page scrolled past the hero, WebKit still paints
//                the header's logo and search button (judged from screenshot
//                pixels, not the DOM).
//   standalone   the installed app at 390 with 47/34px insets: nothing sits
//                under the notch or the home indicator (header, search sheet,
//                tab bar, Save bar, toasts, tour, welcome, guest, Join page),
//                and the status bar style and theme colour are readable.
//
// WebKit can't be told a safe-area inset, so its copy of styles.css is served
// with env(safe-area-inset-*) replaced by the inset in px, which is what an
// iPhone resolves them to. Chromium gets the inset through CDP.
import zlib from 'node:zlib';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';

const S = suite('iphone');
const w = S.world(await openWorld('iphone'));
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const HEIGHTS = { 320: 568, 390: 844 };
const MOVIE = 990001; // the owner's #1, with a trailer
const robin = w.friends.robin;
await w.api('PUT', '/api/settings', { as: robin, body: { watchTogether: true } });
// Something in the heavy friend's hidden list, for the hidden films sheet.
await w.api('POST', '/api/hidden', { as: robin, body: { tmdb_id: 990008, title: 'Quiet Frontier' } });

async function iphone(b, { engine, theme, width = 390, standalone = false, role = 'owner', insets = null, dsf = 2 }) {
  const ins = insets || (standalone ? { top: 47, bottom: 34 } : { top: 0, bottom: 0 });
  const p = await open(b, w, { role, width, theme, height: HEIGHTS[width] || 844, touch: true, extraCtx: { isMobile: true, userAgent: IPHONE_UA, deviceScaleFactor: dsf } });
  if (standalone) {
    await p.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
    });
  }
  if (engine === 'webkit' && (ins.top || ins.bottom)) {
    await p.ctx.route(/\/styles\.css(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const css = (await res.text()).replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(,[^()]*(\([^()]*\))?[^()]*)?\)/g, (m, side) => `${{ top: ins.top, bottom: ins.bottom, left: 0, right: 0 }[side]}px`);
      await route.fulfill({ response: res, body: css, headers: { ...res.headers(), 'content-type': 'text/css; charset=utf-8' } });
    });
  }
  if (engine !== 'webkit' && (ins.top || ins.bottom)) {
    const cdp = await p.ctx.newCDPSession(p.page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: ins.top, bottom: ins.bottom, left: 0, right: 0 } });
  }
  return { ...p, insets: ins, height: HEIGHTS[width] || 844 };
}

const load = async (page, hash, ms = 250) => { await page.goto('about:blank'); await page.goto(`${w.base}/#/${hash}`); await settle(page, ms); };

// ---------------------------------------------------------------- scroll end
// In the page: the lowest painted pixel of #main's content, and the top of
// the chrome in front of it (tab bar, Save bar), both in viewport px.
function measureEnd() {
  const vh = window.innerHeight;
  const S = (e) => getComputedStyle(e);
  const shown = (el) => {
    if (el.closest('[hidden]')) return false;
    const d = el.closest('details:not([open])');
    if (d && d !== el && !el.closest('summary')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) { const s = S(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
    return true;
  };
  const paints = (el) => {
    if (el.matches('img, svg, video, iframe, input, button, select, textarea, canvas')) return true;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return true;
    const s = S(el);
    if (s.backgroundImage !== 'none') return true;
    if (!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(s.backgroundColor)) return true;
    if (s.boxShadow !== 'none') return true;
    return ['Top', 'Bottom', 'Left', 'Right'].some((k) => parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== 'none');
  };
  const floating = (el) => { for (let a = el; a && a.id !== 'main'; a = a.parentElement) { const p = S(a).position; if (p === 'fixed' || p === 'sticky') return a; } return null; };
  const chrome = [];
  const nav = document.querySelector('#bottom-nav');
  if (nav && shown(nav)) chrome.push({ what: 'tab bar', top: nav.getBoundingClientRect().top });
  for (const el of document.querySelectorAll('.save-bar')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < vh && r.bottom > 0) chrome.push({ what: 'save bar', top: r.top });
  }
  const chromeTop = Math.min(vh, ...chrome.map((c) => c.top));
  let bottom = -Infinity; let last = null;
  const main = document.querySelector('#main');
  for (const el of main.querySelectorAll('*')) {
    if (el instanceof SVGElement && el.tagName !== 'svg') continue;
    if (floating(el) || !shown(el) || !paints(el)) continue;
    let r = el.getBoundingClientRect(); r = { top: r.top, bottom: r.bottom };
    for (let a = el.parentElement; a && a !== main; a = a.parentElement) {
      const s = S(a); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect(); r = { top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
    }
    if (r.bottom - r.top < 1) continue;
    if (r.bottom > bottom) { bottom = r.bottom; last = el; }
  }
  const se = document.scrollingElement;
  const atEnd = Math.abs(se.scrollTop + vh - se.scrollHeight) <= 2;
  const scrolls = se.scrollHeight > vh + 2;
  const label = last ? `${last.tagName.toLowerCase()}.${String(last.className).split(' ')[0]} "${(last.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"` : '';
  return { chromeTop, chrome: chrome.map((c) => c.what), bottom, gap: chromeTop - bottom, atEnd, scrolls, label };
}

async function toEnd(page) {
  for (let i = 0; i < 30; i++) {
    const moved = await page.evaluate(() => { const y = scrollY; window.scrollTo(0, document.scrollingElement.scrollHeight); return Math.abs(scrollY - y) > 1; });
    await page.waitForTimeout(moved ? 150 : 80);
    if (!moved) break;
  }
  await page.waitForTimeout(200);
}

// After a sheet closes: nothing left on top, nothing inert, and the page moves.
async function stillScrolls(page) {
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => {
    const cs = (e) => getComputedStyle(e);
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      overlay: document.querySelectorAll('.modal-overlay').length,
      inert: Boolean(document.querySelector('.shell[inert], #main[inert]')),
      locked: [document.documentElement, document.body].some((e) => /hidden|clip/.test(cs(e).overflowY) || cs(e).position === 'fixed'),
      hitOk: Boolean(hit && hit.closest('#main, .app-header, #bottom-nav')),
      canScroll: document.scrollingElement.scrollHeight > innerHeight + 2,
    };
  });
  const bad = [];
  if (st.overlay) bad.push('an overlay is left in the page');
  if (st.inert) bad.push('the page is left inert');
  if (st.locked) bad.push('html/body left scroll-locked');
  if (!st.hitOk) bad.push('a tap in the middle of the screen does not reach the page');
  if (st.canScroll) {
    await page.evaluate(() => window.scrollTo(0, 0));
    try { await page.mouse.move(150, 300); await page.mouse.wheel(0, 500); } catch { await page.evaluate(() => window.scrollBy(0, 500)); }
    await page.waitForTimeout(350);
    let y = await page.evaluate(() => scrollY);
    // Mobile WebKit has no wheel; the checks above plus a script scroll carry it there.
    if (y < 50) { await page.evaluate(() => window.scrollBy(0, 500)); await page.waitForTimeout(200); y = await page.evaluate(() => scrollY); }
    if (y < 50) bad.push(`the page moved only ${y}px`);
  }
  return bad;
}

const PAGES = [
  { name: 'Picks', hash: 'home' },
  { name: 'a movie page', hash: `movie/${MOVIE}` },
  { name: 'Schedule leaving', hash: 'schedule/leaving' },
  { name: 'Schedule coming soon', hash: 'schedule/coming' },
  { name: 'Rate with all ratings open', hash: 'rate', prep: async (p) => { const b = p.locator('#main .show-all:visible').first(); if (await b.count()) { await b.click(); await p.waitForTimeout(400); } } },
  { name: 'Watchlist', hash: 'watchlist', role: 'heavy' },
  { name: 'You', hash: 'you' },
  { name: 'Stats', hash: 'stats' },
  { name: 'Together', hash: 'together', role: 'heavy' },
  { name: 'Settings', hash: 'settings' },
  { name: 'Settings with the Save bar', hash: 'settings', wantSave: true, prep: async (p) => {
    const box = p.locator('label.switch-row:has-text("Prefer IMAX") input').first();
    await box.scrollIntoViewIfNeeded(); await box.click(); await p.waitForTimeout(500);
  } },
];
const SHEETS = [
  { name: 'search', hash: 'home', open: async (p) => { await p.click('#search-btn'); }, close: async (p) => { await p.keyboard.press('Escape'); } },
  { name: 'What should I watch?', hash: 'home', open: async (p) => { const b = p.locator('#wsw-btn'); await b.scrollIntoViewIfNeeded(); await b.click(); }, close: async (p) => { await p.locator('.modal-x').last().click(); } },
  { name: 'trailer', hash: `movie/${MOVIE}`, open: async (p) => { await p.locator('button:has-text("Trailer")').first().click(); }, close: async (p) => { await p.locator('.modal-x').last().click(); } },
  { name: 'Stats drill-down', hash: 'stats', open: async (p) => { const b = p.locator('.bar-row').first(); await b.scrollIntoViewIfNeeded(); await b.click(); }, close: async (p) => { await p.keyboard.press('Escape'); } },
  { name: 'hidden films', hash: 'settings', role: 'heavy', open: async (p) => { const b = p.locator('button:has-text("Show hidden films")').first(); await b.scrollIntoViewIfNeeded(); await b.click(); }, close: async (p) => { await p.keyboard.press('Escape'); } },
];

const browsers = { webkit: await launch('webkit'), chromium: await launch('chromium') };
const gaps = [];
const configs = [];
for (const theme of ['dark', 'light']) {
  for (const width of [320, 390]) configs.push({ engine: 'webkit', theme, width, standalone: false });
  configs.push({ engine: 'webkit', theme, width: 390, standalone: true });
  configs.push({ engine: 'chromium', theme, width: 390, standalone: true });
}
// Closing a sheet doesn't depend on the width or theme: sheets run in three
// of the configurations above.
const SHEET_CONFIGS = new Set(['webkit dark 390', 'webkit light 390 standalone', 'chromium dark 390 standalone']);

for (const c of configs) {
  const tag = `${c.engine} ${c.theme} ${c.width}${c.standalone ? ' standalone' : ''}`;
  await S.step(`scroll end and sheets: ${tag}`, async () => {
    const t0 = Date.now();
    const contexts = {};
    const pageFor = async (r) => {
      if (!contexts[r]) contexts[r] = await iphone(browsers[c.engine], { ...c, role: r === 'heavy' ? robin : 'owner' });
      return contexts[r];
    };
    try {
      for (const pg of PAGES) {
        const { page, errors } = await pageFor(pg.role || 'owner');
        await load(page, pg.hash);
        if (pg.prep) await pg.prep(page);
        await toEnd(page);
        let m = await page.evaluate(measureEnd);
        // Late content (a list filling in) can grow the page after the first
        // scroll; scroll again until the height holds.
        for (let i = 0; i < 3 && m.scrolls && !m.atEnd; i++) { await page.waitForTimeout(300); await toEnd(page); m = await page.evaluate(measureEnd); }
        if (pg.wantSave) S.check(`scroll end ${tag} ${pg.name}: the Save bar shows with an unsaved change`, m.chrome.includes('save bar'), m.chrome.join(','));
        if (m.scrolls) {
          S.check(`scroll end ${tag} ${pg.name}: reaches the end`, m.atEnd);
          S.check(`scroll end ${tag} ${pg.name}: last content clears the ${pg.wantSave ? 'Save bar' : 'tab bar'}`, m.gap >= 8, `${m.label} ends ${Math.round(m.bottom)}, chrome top ${Math.round(m.chromeTop)} (gap ${Math.round(m.gap)})`);
          gaps.push({ tag, page: pg.name, gap: Math.round(m.gap * 10) / 10 });
        }
        S.check(`scroll end ${tag} ${pg.name}: no console error or failed request`, !errors.length, errors.join(' | '));
        errors.length = 0;
      }
      for (const sh of SHEET_CONFIGS.has(tag) ? SHEETS : []) {
        const { page, errors } = await pageFor(sh.role || 'owner');
        await load(page, sh.hash);
        let opened = false;
        try {
          await sh.open(page);
          await page.waitForSelector('.modal-overlay.show', { timeout: 10000 });
          opened = true;
          await page.waitForTimeout(400);
          await sh.close(page);
          await page.waitForFunction(() => !document.querySelector('.modal-overlay'), null, { timeout: 5000 }).catch(() => {});
        } catch { /* reported below */ }
        S.check(`sheets ${tag}: the ${sh.name} sheet opens`, opened);
        const bad = opened ? await stillScrolls(page) : [];
        S.check(`sheets ${tag}: the page still scrolls and takes taps after the ${sh.name} sheet closes`, opened && !bad.length, bad.join('; '));
        S.check(`sheets ${tag}: ${sh.name} raises no console error`, !errors.length, errors.join(' | '));
        errors.length = 0;
      }
    } finally {
      for (const x of Object.values(contexts)) await x.ctx.close();
      console.log(`    (${tag}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  });
}
{
  const vals = gaps.map((g) => g.gap);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  const byGap = {}; for (const g of gaps) (byGap[g.gap] ||= []).push(`${g.tag} ${g.page}`);
  S.check('scroll end: the gap above the tab bar or Save bar is the same everywhere (spread at most 2px)', vals.length > 20 && spread <= 2,
    `${vals.length} ends, spread ${spread.toFixed(1)}px: ${Object.entries(byGap).map(([k, v]) => `${k}px x${v.length} [${v.slice(0, 2).join('; ')}]`).join('  ')}`);
}

// ---------------------------------------------------------------- header paint (WebKit)
function readPng(buf) {
  let pos = 8; let width = 0; let height = 0; let type = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const kind = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9]; } else if (kind === 'IDAT') idat.push(body); else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp; const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) { const o = (y * width + x) * 4; const s = x * bpp; out[o] = line[s]; out[o + 1] = line[s + 1]; out[o + 2] = line[s + 2]; out[o + 3] = 255; }
    prev = line;
  }
  return { width, height, data: out };
}
// Share of pixels in the box that differ from the box's most common colour.
function inkShare(png, box, scale) {
  const x0 = Math.round(box.x * scale); const y0 = Math.round(box.y * scale);
  const bw = Math.round(box.width * scale); const bh = Math.round(box.height * scale);
  const counts = new Map(); const px = [];
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
    const i = (y * png.width + x) * 4; const c = [png.data[i], png.data[i + 1], png.data[i + 2]];
    px.push(c); const k = c.map((v) => v >> 3).join(','); counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map((v) => (+v << 3) + 4);
  return px.filter((c) => Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 90).length / px.length;
}

for (const theme of ['dark', 'light']) {
  for (const standalone of [false, true]) {
    const tag = `webkit ${theme} ${standalone ? 'standalone 390' : '390'}`;
    await S.step(`header paints: ${tag}`, async () => {
      const { ctx, page, errors } = await iphone(browsers.webkit, { engine: 'webkit', theme, width: 390, standalone, dsf: 3 });
      try {
        await load(page, `movie/${MOVIE}`, 800);
        const top = {};
        for (const y of [0, 300, 900, 99999]) {
          await page.evaluate((v) => window.scrollTo(0, v), y);
          await page.waitForTimeout(450);
          const boxes = await page.evaluate(() => {
            const pick = (sel) => { const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            return { logo: pick('.app-header .brand'), 'search button': pick('.app-header #search-btn') };
          });
          const png = readPng(await page.screenshot());
          const scale = png.width / 390;
          for (const [name, box] of Object.entries(boxes)) {
            if (!S.check(`header ${tag}: the ${name} is in the header at y=${y}`, Boolean(box))) continue;
            const share = inkShare(png, box, scale);
            if (y === 0) { top[name] = share; S.check(`header ${tag}: the ${name} paints at the top`, share >= 0.01, `${(share * 100).toFixed(1)}% ink`); continue; }
            S.check(`header ${tag}: the ${name} still paints scrolled to y=${y}`, share >= Math.max(0.01, (top[name] || 0) * 0.5), `${(share * 100).toFixed(1)}% ink, ${((top[name] || 0) * 100).toFixed(1)}% at the top`);
          }
        }
        S.check(`header ${tag}: no console error`, !errors.length, errors.join(' | '));
      } finally { await ctx.close(); }
    });
  }
}

// ---------------------------------------------------------------- standalone (Chromium with CDP insets)
const TOP = 47; const BOTTOM = 34; const VH = 844;
// Everything that paints content (text, a control, an image) and floats
// (fixed or sticky) stays inside the safe area; the bars reach the edges.
function outsideSafe({ TOP, BOTTOM, VH }) {
  const bad = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let a = el; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; } return true; };
  const fixedish = (el) => { for (let a = el; a; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  for (const el of document.querySelectorAll('body *')) {
    if (!fixedish(el) || !vis(el)) continue;
    const content = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || el.matches('button, a[href], input, img, svg');
    if (!content || el.closest('.tour-spot')) continue;
    if (el.closest('.modal-overlay') && !el.closest('.modal-card')) continue;
    let r = el.getBoundingClientRect(); r = { top: r.top, bottom: r.bottom };
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a); if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect(); r = { top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
    }
    if (r.bottom - r.top < 1) continue;
    const name = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 24)}"`;
    if (r.top < TOP - 0.5 && r.bottom > 0) bad.push(`${name} top ${Math.round(r.top)} < ${TOP}`);
    if (r.bottom > VH - BOTTOM + 0.5 && r.top < VH) bad.push(`${name} bottom ${Math.round(r.bottom)} > ${VH - BOTTOM}`);
  }
  const hdr = document.querySelector('.app-header'); const nav = document.querySelector('.bottom-nav');
  if (hdr && vis(hdr) && hdr.getBoundingClientRect().top > 0.5) bad.push(`header starts ${hdr.getBoundingClientRect().top}px below the top edge`);
  if (nav && vis(nav) && Math.abs(nav.getBoundingClientRect().bottom - VH) > 0.5) bad.push(`tab bar ends at ${nav.getBoundingClientRect().bottom}, not the bottom edge`);
  return bad;
}

const jf = await w.api('POST', '/api/friends', { body: { name: 'Avery' } });
const joinToken = new URL(jf.json.invite, 'http://x').searchParams.get('invite');
const bottomOut = async (p) => { for (let i = 0; i < 20; i++) { await p.evaluate(() => scrollTo(0, 1e6)); await p.waitForTimeout(100); } await p.waitForTimeout(250); };
const showToast = (text, action) => async (p) => {
  await p.evaluate(async ([t, a]) => { const { toast } = await import('/js/ui.js'); toast(t, a ? '' : 'success', { duration: 0, ...(a ? { action: { label: a, onClick: () => {} } } : {}) }); }, [text, action]);
  await p.waitForTimeout(600);
};
const startTour = async (p) => { await load(p, 'help'); await p.locator('.tour-replay').click(); await p.waitForSelector('.tour-card'); await p.waitForTimeout(700); };
const SCENES = [
  ['Picks', 'owner', async (p) => load(p, 'home', 500)],
  ['Picks at the bottom', 'owner', async (p) => { await load(p, 'home', 500); await bottomOut(p); }, true],
  ['Settings at the bottom', 'owner', async (p) => { await load(p, 'settings', 500); await bottomOut(p); }, true],
  ['Settings at the bottom with the Save bar', 'owner', async (p) => {
    await load(p, 'settings', 500);
    const box = p.locator('label.switch-row:has-text("Prefer IMAX") input').first(); await box.scrollIntoViewIfNeeded(); await box.click(); await p.waitForTimeout(500);
    await bottomOut(p);
  }, true],
  ['an update toast on Settings', 'owner', async (p) => { await load(p, 'settings', 500); await showToast('Update ready', 'Refresh')(p); }],
  ['a toast on Stats', 'owner', async (p) => { await load(p, 'stats', 500); await showToast('Saved')(p); }],
  ['the search sheet', 'owner', async (p) => { await load(p, 'home', 500); await p.click('#search-btn'); await p.waitForSelector('.modal-overlay.show'); await p.waitForTimeout(500); }],
  ['a Stats drill-down', 'heavy', async (p) => { await load(p, 'stats', 500); await p.locator('.bar-row').first().click(); await p.waitForSelector('.modal-overlay.show'); await p.waitForTimeout(800); }],
  ['What should I watch?', 'owner', async (p) => { await load(p, 'home', 500); await p.click('#wsw-btn'); await p.waitForSelector('.modal-overlay.show'); await p.waitForTimeout(500); }],
  ['the tour', 'owner', startTour],
  ['the tour\'s last step', 'owner', async (p) => {
    await startTour(p);
    for (let i = 0; i < 14; i++) { const t = (await p.locator('.tour-count').textContent()).trim(); if (/(\d+) of \1$/.test(t)) break; await p.click('.tour-next'); await p.waitForTimeout(450); }
    await p.waitForTimeout(400);
  }],
  ['a movie page', 'owner', async (p) => load(p, `movie/${MOVIE}`, 500)],
  ['the welcome setup', 'fresh', async (p) => load(p, 'home', 500)],
  ['the guest view', 'guest', async (p) => load(p, 'home', 500)],
  ['the Join page', 'guest', async (p) => { await p.goto(`${w.base}/?invite=${joinToken}`); await p.waitForTimeout(500); }],
];
const roleOf = (r) => (r === 'heavy' ? robin : r === 'fresh' ? w.friends.jordan : r);
for (const theme of ['light', 'dark']) {
  await S.step(`standalone 390 ${theme}`, async () => {
    for (const [name, role, run, atBottom] of SCENES) {
      const { ctx, page, errors } = await iphone(browsers.chromium, { engine: 'chromium', theme, width: 390, standalone: true, role: roleOf(role) });
      try {
        await run(page);
        const bad = await page.evaluate(outsideSafe, { TOP, BOTTOM, VH });
        S.check(`standalone ${theme}: ${name} keeps clear of the notch and the home indicator`, !bad.length, bad.slice(0, 4).join('; '));
        if (atBottom) {
          const m = await page.evaluate(measureEnd);
          S.check(`standalone ${theme}: ${name}, the last content isn't covered`, !m.scrolls || m.gap >= 8, `${m.label} gap ${Math.round(m.gap)} under ${m.chrome.join('/')}`);
        }
        S.check(`standalone ${theme}: ${name} raises no console error`, !errors.length, errors.join(' | '));
      } catch (e) {
        S.check(`standalone ${theme}: ${name} could be set up`, false, e.message.split('\n')[0]);
      } finally { await ctx.close(); }
    }
    // Status bar: "default" (the system draws a readable bar in the theme colour)
    // and the theme colour for this scheme equals the page's own colour.
    const { ctx, page } = await iphone(browsers.chromium, { engine: 'chromium', theme, width: 390, standalone: true });
    try {
      await load(page, 'home', 500);
      const sb = await page.evaluate(() => ({
        style: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
        theme: [...document.querySelectorAll('meta[name="theme-color"]')].filter((m) => !m.media || matchMedia(m.media).matches).map((m) => m.content),
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      const hex = (c) => `#${(c.match(/\d+/g) || []).slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      S.check(`standalone ${theme}: the status-bar style is default`, sb.style === 'default', sb.style);
      S.check(`standalone ${theme}: theme-color matches the page colour`, sb.theme.length === 1 && sb.theme[0].toUpperCase() === hex(sb.bg), `${sb.theme} vs ${hex(sb.bg)}`);
    } finally { await ctx.close(); }
  });
}
await S.step('the manifest opens the installed app standalone', async () => {
  const man = (await w.api('GET', '/manifest.webmanifest')).json;
  S.check('manifest: display is standalone', man?.display === 'standalone', man?.display);
});

// Each measure above can fail: planted faults it has to catch.
await S.step('controls: the measures catch planted faults', async () => {
  const { ctx, page } = await iphone(browsers.webkit, { engine: 'webkit', theme: 'light', width: 390 });
  try {
    await load(page, 'settings');
    await page.evaluate(() => { const d = document.createElement('p'); d.textContent = 'planted'; d.style.cssText = 'height:20px;margin:0 0 -200px;background:red'; document.querySelector('#main').appendChild(d); });
    await toEnd(page);
    const m = await page.evaluate(measureEnd);
    S.check('control: content pushed under the tab bar is caught by the scroll-end measure', m.gap < 8, `gap ${Math.round(m.gap)}`);
    await load(page, 'home');
    await page.click('#search-btn'); await page.waitForSelector('.modal-overlay.show');
    const bad = await stillScrolls(page);
    S.check('control: a sheet left open is caught by the still-scrolls check', bad.length > 0, bad.join('; '));
    await load(page, `movie/${MOVIE}`, 600);
    const brandBox = () => page.evaluate(() => { const r = document.querySelector('.app-header .brand').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const inkNow = async () => { const png = readPng(await page.screenshot()); return inkShare(png, await brandBox(), png.width / 390); };
    const top = await inkNow();
    await page.addStyleTag({ content: '.app-header .brand { color: transparent !important; text-shadow: none !important; } .app-header .brand > * { visibility: hidden !important; }' });
    await page.evaluate(() => window.scrollTo(0, 900)); await page.waitForTimeout(400);
    const share = await inkNow();
    // The same rule the header checks use: under half the ink it had at the top.
    S.check('control: an invisible logo is caught by the pixel check', share < Math.max(0.01, top * 0.5), `${(share * 100).toFixed(1)}% ink, ${(top * 100).toFixed(1)}% at the top`);
  } finally { await ctx.close(); }
  const st = await iphone(browsers.chromium, { engine: 'chromium', theme: 'dark', width: 390, standalone: true });
  try {
    await load(st.page, 'home');
    await st.page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'under the notch'; d.style.cssText = 'position:fixed;top:4px;left:20px;z-index:99'; document.body.appendChild(d); });
    const bad = await st.page.evaluate(outsideSafe, { TOP, BOTTOM, VH });
    S.check('control: text under the notch is caught by the safe-area check', bad.some((x) => /under the notch/.test(x)), bad.join('; '));
  } finally { await st.ctx.close(); }
});

for (const b of Object.values(browsers)) await b.close();
await w.close();
S.finish();
