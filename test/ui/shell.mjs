// The app's frame (real-app G8 g-tabs, G2 g-header, G6 g-header-pull;
// final-polish G10 g-three and fixes-3 X1 to X3; decisions D10 g-copy and the
// in-app half of D8): five tabs, You holding Stats, Together, Settings and
// Help, the one-time "now under You" note, the guided tour lighting real
// elements; the header's contents per role and width, still painted on a
// scrolled movie page; pull to refresh; the API keys text locally and on
// Railway; no stale highlight on a tab left by keyboard; the hero seat line's
// even wrapping; the limit message in both themes.
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend } from '../lib/world.mjs';
import { launch, open, go, VISIBLE } from '../lib/browser.mjs';
import { PNG, realSizePosters } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('shell');
const MOVIE = C.PLAYING[0].id;
const w = S.world(await openWorld('shell'));
const F = w.friends;
const browser = await launch();
const NOTE = 'Stats, Together and Settings are now under You.';
const page = async (role, { width = 390, theme = 'dark', hash = 'home', ...o } = {}) => {
  const p = await open(browser, w, { role, width, theme, ...o });
  await realSizePosters(p.ctx);
  if (hash) await go(p.page, w, hash, 400);
  return p;
};

// ---------------------------------------------------------------- tabs and You
async function tabs() {
  for (const [name, role, want] of [['owner', 'owner', ['Picks', 'Schedule', 'Rate', 'Watchlist', 'You']], ['heavy', F.robin, ['Picks', 'Schedule', 'Rate', 'Watchlist', 'You']], ['guest', 'guest', ['Picks', 'Schedule']]]) {
    for (const width of [390, 1280]) {
      const p = await page(role, { width });
      const got = await p.page.evaluate((vis) => { const v = eval(vis); return [...document.querySelectorAll('.bottom-nav .nav-item, .app-header .seg-item')].filter(v).map((e) => e.textContent.trim()); }, VISIBLE);
      S.check(`tabs ${name} ${width}: the tabs are ${want.join(', ')}`, got.join(',') === want.join(','), got.join(','));
      if (name !== 'guest') {
        for (const [hash, seg, sel] of [['you', null, '.you-seg'], ['stats', 'stats', '.stat-grid'], ['together', 'together', '.you-panel .section-title, .you-panel .empty'], ['settings', 'settings', '.settings-group'], ['help', 'help', '.guide']]) {
          await go(p.page, w, hash, 500);
          const st = await p.page.evaluate(({ vis, sel }) => {
            const v = eval(vis);
            return {
              segs: [...document.querySelectorAll('.you-seg .segment')].map((e) => e.textContent.trim()),
              current: document.querySelector('.you-seg .segment[aria-current="page"]')?.dataset.seg,
              lit: [...document.querySelectorAll('.nav-item.active, .seg-item.active')].filter(v).map((e) => e.dataset.name),
              body: Boolean([...document.querySelectorAll(sel)].find(v)), hash: location.hash,
            };
          }, { vis: VISIBLE, sel });
          const ok = st.segs.join(',') === 'Stats,Together,Settings,Help' && (!seg || (st.current === seg && st.hash === `#/${hash}`)) && st.lit.join(',') === 'you' && st.body;
          S.check(`tabs ${name} ${width} #/${hash}: opens inside You (Stats, Together, Settings, Help) with You lit`, ok, JSON.stringify(st));
        }
      } else {
        for (const hash of ['you', 'stats', 'settings', 'together', 'help']) {
          await go(p.page, w, hash, 300);
          S.check(`tabs guest ${width} #/${hash}: sends the guest back to Picks`, /#\/home/.test(p.page.url()), p.page.url());
        }
      }
      S.check(`tabs ${name} ${width}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 2).join(' | '));
      await p.ctx.close();
    }
  }

  // The one-time note: someone who knew the old tabs sees it once. Two
  // friends of this part's own, so no other part's pages use up their note.
  const vet = await makeFriend(w.base, 'Avery');
  const vet2 = await makeFriend(w.base, 'Riley');
  for (const v of [vet, vet2]) await w.api('PUT', '/api/settings', { as: v, body: { setupDone: true, tourDone: true, youNoteSeen: false } });
  const newbie = await makeFriend(w.base, 'Quinn');
  await w.api('PUT', '/api/settings', { as: newbie, body: { setupDone: true } });
  for (const [name, role] of [['returning friend', vet], ['second returning friend', vet2]]) {
    const p = await page(role, { theme: 'light' });
    await p.page.waitForTimeout(800);
    const first = await p.page.locator('.toast', { hasText: NOTE }).count();
    await go(p.page, w, 'rate', 500); await go(p.page, w, 'home', 600);
    await p.page.reload(); await p.page.waitForTimeout(1200);
    const again = await p.page.locator('.toast', { hasText: NOTE }).count();
    const saved = (await w.api('GET', '/api/status', { as: role })).json.youNoteSeen;
    S.check(`tabs: the "now under You" note shows once to the ${name} and is remembered`, first === 1 && !again && saved, JSON.stringify({ first, again, saved }));
    await p.ctx.close();
  }

  // The tour lights a real element on every step.
  for (const [name, role, width] of [['owner', 'owner', 390], ['owner', 'owner', 1280], ['heavy', F.robin, 390], ['heavy', F.robin, 1280], ['new friend', newbie, 390]]) {
    const p = await page(role, { width, theme: width === 390 ? 'dark' : 'light', hash: name === 'new friend' ? 'home' : 'help' });
    if (name === 'new friend') await p.page.waitForSelector('.tour-card', { timeout: 15000 }).catch(() => {});
    else await p.page.locator('button', { hasText: 'Replay tour' }).click();
    const steps = [];
    if (await p.page.waitForSelector('.tour-card', { timeout: 8000 }).catch(() => null)) {
      for (let i = 0; i < 20; i++) {
        await p.page.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 15000 }).catch(() => {});
        await p.page.waitForTimeout(200);
        steps.push(await p.page.evaluate(() => {
          const spot = document.querySelector('.tour-spot'); const r = spot.getBoundingClientRect();
          return { n: document.querySelector('.tour-count').textContent, title: document.querySelector('.tour-title').textContent, text: document.querySelector('.tour-text').textContent, lit: !spot.hidden && r.width > 0 && r.bottom > 0 && r.top < innerHeight };
        }));
        const next = p.page.locator('.tour-next');
        if ((await next.textContent()).trim() === 'Done') { await next.click(); break; }
        await next.click();
      }
    }
    const dark = steps.filter((s) => !s.lit);
    const bad = [];
    if (dark.length) bad.push(`${dark.map((s) => `${s.n} ${s.title}`).join('; ')} light nothing`);
    if (steps.length < 12) bad.push(`only ${steps.length} steps`);
    if (!steps.some((s) => s.title === 'You')) bad.push('no You step');
    if (name !== 'owner' && !steps.some((s) => s.title === 'You' && /Together/.test(s.text))) bad.push('the friend isn\'t told where Together is');
    if (steps.some((s) => /Settings button|the \? |header/i.test(s.text))) bad.push('a step points at the old header');
    if (name === 'new friend' && !(await w.api('GET', '/api/status', { as: newbie })).json.youNoteSeen) bad.push('finishing the tour did not mark the You note seen');
    S.check(`tabs: the tour lights a real, on-screen element on every step (${name} ${width})`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 3).join(' || '));
    await p.ctx.close();
  }
}

// ---------------------------------------------------------------- header paints (Chromium)
function inkShare(png, box) {
  const x0 = Math.round(box.x); const y0 = Math.round(box.y); const wd = Math.round(box.width); const ht = Math.round(box.height);
  const counts = new Map(); const px = [];
  for (let y = y0; y < y0 + ht; y++) for (let x = x0; x < x0 + wd; x++) {
    const i = (y * png.width + x) * 4; const c = [png.data[i], png.data[i + 1], png.data[i + 2]];
    px.push(c); const k = c.map((v) => v >> 3).join(','); counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bgKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map((v) => (+v << 3) + 4);
  return px.filter((c) => Math.abs(c[0] - bgKey[0]) + Math.abs(c[1] - bgKey[1]) + Math.abs(c[2] - bgKey[2]) > 90).length / px.length;
}
async function headerPaints() {
  for (const theme of ['dark', 'light']) {
    for (const standalone of [false, true]) {
      const p = await page('owner', { width: 390, theme, hash: null });
      if (standalone) {
        await p.ctx.addInitScript(() => {
          Object.defineProperty(navigator, 'standalone', { get: () => true });
          const mm = window.matchMedia.bind(window);
          window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
        });
        const cdp = await p.ctx.newCDPSession(p.page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
      }
      await go(p.page, w, `movie/${MOVIE}`, 700, { fresh: true });
      const top = {}; const bad = [];
      for (const y of [0, 300, 900, 1800, 99999]) {
        await p.page.evaluate((v) => window.scrollTo(0, v), y);
        await p.page.waitForTimeout(400);
        const boxes = await p.page.evaluate(() => {
          const pick = (sel) => { const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          return { brand: pick('.app-header .brand'), search: pick('.app-header #search-btn') };
        });
        const png = PNG.read(await p.page.screenshot());
        for (const [name, box] of Object.entries(boxes)) {
          if (!box) { bad.push(`no ${name} at y=${y}`); continue; }
          const share = inkShare(png, box);
          if (y === 0) { top[name] = share; if (share < 0.01) bad.push(`the ${name} doesn't paint even at the top`); continue; }
          if (share < Math.max(0.01, top[name] * 0.5)) bad.push(`the ${name} doesn't paint at y=${y} (${(share * 100).toFixed(1)}% ink, ${(top[name] * 100).toFixed(1)}% at the top)`);
        }
      }
      S.check(`header ${theme} ${standalone ? 'standalone 390' : '390'}: the logo and search still paint on a movie page scrolled past its hero`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 3).join(' || '));
      await p.ctx.close();
    }
  }
}

// ---------------------------------------------------------------- header contents and pull to refresh
async function headerPull() {
  for (const [name, role] of [['owner', 'owner'], ['heavy', F.robin], ['fresh', F.jordan], ['guest', 'guest']]) {
    for (const width of [320, 390, 1280]) {
      for (const theme of ['dark', 'light']) {
        const p = await page(role, { width, theme, hash: name === 'fresh' ? 'rate' : 'home' });
        const got = await p.page.evaluate((vis) => {
          const visible = eval(vis);
          const header = document.querySelector('.app-header');
          const items = [...header.querySelectorAll('a, button')].filter(visible).map((el) => (el.matches('.brand') ? 'logo' : el.id === 'search-btn' ? 'search' : el.matches('.seg-item') ? `tab:${el.dataset.name}` : `other:${el.outerHTML.slice(0, 60)}`));
          const gone = ['#help-btn', '#refresh-btn', '#settings-btn', '#user-chip', '#theatre-name'].filter((s) => document.querySelector(s));
          return { items, gone };
        }, VISIBLE);
        const setup = name === 'fresh'; // in the welcome setup the header keeps to the logo
        const wantSearch = name !== 'guest' && !setup;
        const wantTabs = width >= 900 && !setup ? (name === 'guest' ? ['home', 'schedule'] : ['home', 'schedule', 'rate', 'watchlist', 'you']) : [];
        const tabsGot = got.items.filter((x) => x.startsWith('tab:'));
        const bad = [];
        if (got.gone.length) bad.push(`${got.gone.join(', ')} still in the page`);
        if (got.items.some((x) => x.startsWith('other:'))) bad.push(`more than it should: ${got.items.filter((x) => x.startsWith('other:')).join(' | ')}`);
        if (got.items[0] !== 'logo') bad.push(`order ${got.items.join(' ')}`);
        if (got.items.includes('search') !== wantSearch) bad.push(`search ${wantSearch ? 'missing' : 'shown'}`);
        if (wantSearch && got.items[got.items.length - 1] !== 'search') bad.push('search isn\'t last');
        if (tabsGot.join(',') !== wantTabs.map((t) => `tab:${t}`).join(',')) bad.push(`header tabs ${tabsGot.join(',') || 'none'}, expected ${wantTabs.join(',') || 'none'}`);
        S.check(`header ${name} ${theme} ${width}: ${wantTabs.length ? 'logo, tab links and search' : wantSearch ? 'logo and search' : 'the logo alone'}`, !bad.length && !p.errors.length, [...bad, ...p.errors].slice(0, 3).join(' || '));
        await p.ctx.close();
      }
    }
  }
  const pull = async (role, { dy = 180, reduced = false } = {}) => {
    const p = await page(role, { reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const reqs = [];
    p.page.on('request', (r) => { if (r.url().startsWith(`${w.base}/api/`)) reqs.push(`${r.method()} ${r.url().replace(w.base, '')}`); });
    await p.page.evaluate(() => window.scrollTo(0, 0));
    const cdp = await p.ctx.newCDPSession(p.page);
    const pt = (y) => [{ x: 195, y }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(200) });
    let turn = null; let moved = null;
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(200 + (dy * i) / 10) });
      if (i === 6) ({ turn, moved } = await p.page.evaluate(() => { const m = document.querySelector('.pull'); return { turn: m?.style.getPropertyValue('--turn'), moved: m?.style.getPropertyValue('--pull') }; }));
    }
    const shown = await p.page.evaluate(() => document.querySelector('.pull')?.classList.contains('show'));
    reqs.length = 0;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.page.waitForTimeout(2000);
    await p.ctx.close();
    return { reqs, shown, turn, moved };
  };
  const o = await pull('owner');
  S.check('pull: the owner\'s pull shows the arrow and starts a real refresh (POST /api/refresh)', o.shown && o.reqs.includes('POST /api/refresh'), JSON.stringify(o));
  const f = await pull(F.robin);
  S.check('pull: a friend\'s pull only fetches the picks again', !f.reqs.some((r) => /\/api\/refresh/.test(r)) && f.reqs.some((r) => /GET \/api\/recommendations/.test(r)), f.reqs.join(', '));
  const g = await pull('guest');
  S.check('pull: the guest\'s pull sends no write and fetches the picks again', !g.reqs.some((r) => /POST/.test(r)) && g.reqs.some((r) => /GET \/api\/recommendations/.test(r)), g.reqs.join(', '));
  const s = await pull('owner', { dy: 40 });
  S.check('pull: a short pull does nothing', !s.reqs.length, s.reqs.join(', '));
  const r = await pull(F.robin, { reduced: true });
  S.check('pull: with reduced motion the arrow neither turns nor moves', r.turn === '0deg' && r.moved === '0px', `${r.turn}, ${r.moved}`);
}

// ---------------------------------------------------------------- no stale tab highlight (X2)
// Keyboard only: Tab (then Shift+Tab) until the target has focus.
async function tabTo(p, sel) {
  for (const key of ['Tab', 'Shift+Tab']) {
    await p.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    for (let i = 0; i < 250; i++) {
      await p.keyboard.press(key);
      if (await p.evaluate((s) => document.activeElement?.matches(s), sel)) return true;
    }
  }
  return false;
}
async function staleGlow() {
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1280]) {
      for (const how of ['back', 'hash']) {
        const p = await page('owner', { width, theme, hash: 'settings' });
        const pg = p.page;
        const reached = await tabTo(pg, '.you-seg .segment[data-seg="together"]');
        await pg.keyboard.press('Enter');
        await pg.waitForFunction(() => location.hash.startsWith('#/together'), null, { timeout: 5000 }).catch(() => {});
        await pg.waitForTimeout(300);
        if (how === 'back') await pg.goBack(); else await pg.evaluate(() => { location.hash = '#/settings'; });
        await pg.waitForFunction(() => location.hash.startsWith('#/settings'), null, { timeout: 5000 }).catch(() => {});
        await pg.waitForTimeout(400);
        const state = await pg.evaluate(() => {
          const probe = document.createElement('span'); probe.style.color = 'var(--accent-text)'; document.body.appendChild(probe);
          const accent = getComputedStyle(probe).color; probe.remove();
          const look = (e) => ({ name: e.dataset.name || e.dataset.seg, active: e.classList.contains('active') || e.getAttribute('aria-current') === 'page', ring: e.matches(':focus-visible') && getComputedStyle(e).outlineStyle !== 'none', accent: getComputedStyle(e).color === accent });
          return {
            tabs: [...document.querySelectorAll('#bottom-nav .nav-item, .app-header .seg-item')].filter((e) => e.getBoundingClientRect().width > 0).map(look),
            segs: [...document.querySelectorAll('.you-seg .segment')].map(look),
          };
        });
        const stale = [...state.tabs, ...state.segs].filter((t) => !t.active && (t.ring || t.accent)).map((t) => `${t.name}${t.ring ? ' ring' : ''}${t.accent ? ' accent' : ''}`);
        const lit = state.tabs.filter((t) => t.active).map((t) => t.name);
        const seg = state.segs.filter((t) => t.active).map((t) => t.name);
        S.check(`stale glow ${theme} ${width} ${how}: after leaving Together by keyboard, no inactive tab or segment keeps a ring or accent`, reached && !stale.length && lit.join(',') === 'you' && seg.join(',') === 'settings', JSON.stringify({ reached, stale, lit, seg }));
        await p.ctx.close();
      }
    }
  }
}

// ---------------------------------------------------------------- hero seat line (X3)
async function seatLine() {
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 390, 1280]) {
      const p = await page('owner', { width, theme });
      const m = await p.page.evaluate(() => {
        const el = document.querySelector('.hero-pick .seat-line');
        if (!el) return null;
        const text = el.firstElementChild || el;
        const lh = parseFloat(getComputedStyle(text).lineHeight);
        const rg = document.createRange(); rg.selectNodeContents(text);
        const bottoms = [...new Set([...rg.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom)))].sort((a, b) => a - b);
        const lines = []; for (const t of bottoms) if (!lines.length || t - lines[lines.length - 1] > 3) lines.push(t);
        const cal = el.querySelector('.cal-btn');
        let tap = null;
        if (cal) {
          cal.scrollIntoView({ block: 'center' });
          const r = cal.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
          const hit = (x, y) => document.elementFromPoint(x, y)?.closest('.cal-btn') === cal;
          tap = { w: r.width, h: r.height, edges: hit(cx, cy - 21) && hit(cx, cy + 21) && hit(cx - 21, cy) && hit(cx + 21, cy) };
        }
        return { lh, lines, height: text.getBoundingClientRect().height, tap };
      });
      const gaps = m ? m.lines.slice(1).map((y, i) => y - m.lines[i]) : [];
      const even = m && gaps.every((g) => Math.abs(g - m.lh) <= 1.5) && m.height <= m.lines.length * m.lh + 2;
      const touch = width <= 1024;
      S.check(`seat line ${theme} ${width}: its lines step one line-height apart and the calendar button is a ${touch ? '44px' : 'real'} target`, m && even && m.tap && (!touch || (m.tap.w >= 43.5 && m.tap.h >= 43.5) || m.tap.edges), JSON.stringify({ ...m, gaps }));
      await p.ctx.close();
    }
  }
}

// ---------------------------------------------------------------- limit message (D8, in the app)
async function limitMessage() {
  // Spend the empty friend's hour of rating searches through the API.
  let last = null;
  for (let i = 0; i < 300; i++) last = await w.api('GET', `/api/ratings/search?q=harbor${i}`, { as: F.casey });
  const over = await w.api('GET', '/api/ratings/search?q=harbor', { as: F.casey });
  S.check('limit: the 301st rating search in an hour answers 429 with the message', last.status === 200 && over.status === 429 && over.json?.error === 'Slow down a bit, try again in a few minutes.', `${last.status} then ${over.status} ${over.text.slice(0, 80)}`);
  for (const theme of ['light', 'dark']) {
    const p = await page(F.casey, { theme, hash: 'rate' });
    await p.page.locator('#main input[type="search"]').first().fill('harbor');
    const shown = await p.page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Slow down a bit, try again in a few minutes\./.test(t.textContent)), null, { timeout: 5000 }).then(() => true).catch(() => false);
    const readable = shown && await p.page.evaluate(() => {
      const t = [...document.querySelectorAll('.toast')].find((x) => /Slow down/.test(x.textContent));
      const r = t.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0;
    });
    const others = p.errors.filter((e) => !/429/.test(e));
    S.check(`limit ${theme}: the Rate search shows "Slow down a bit, try again in a few minutes." on screen`, shown && readable && !others.length, others.slice(0, 2).join(' | '));
    await p.ctx.close();
  }
  const owner = await w.api('GET', '/api/ratings/search?q=harbor');
  const other = await w.api('GET', '/api/ratings/search?q=harbor', { as: F.robin });
  S.check('limit: the owner and another friend are not limited by it', owner.status === 200 && other.status === 200, `${owner.status} / ${other.status}`);
}

// ---------------------------------------------------------------- API keys text (X1, D10)
// Last: it restarts the server as it would run on Railway.
async function keysText() {
  const LOCAL = 'Keys live in the .env file in the project root. Edit it, then restart the server.';
  const RAIL = 'Keys are set as Railway variables. Change them there, then redeploy.';
  const TOKEN = 'test-owner-token-for-the-railway-check-0123';
  const keysGroup = (pg) => pg.evaluate(() => {
    const g = [...document.querySelectorAll('.settings-group, .group')].find((x) => /^API keys$/.test(x.querySelector('.group-title, h2, h3')?.textContent.trim() || ''));
    return g ? g.textContent.replace(/\s+/g, ' ') : null;
  });
  for (const [where, env] of [['local', {}], ['railway', { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PROJECT_ID: 'test-project', GUEST_MODE: '1', OWNER_TOKEN: TOKEN }]]) {
    if (where === 'railway') await w.restart({ env });
    let cookie = null;
    if (where === 'railway') { const r = await fetch(`${w.base}/?owner=${TOKEN}`, { redirect: 'manual' }); cookie = (r.headers.get('set-cookie') || '').split(';')[0]; }
    const asOwner = cookie ? { headers: { cookie } } : null;
    const st = (await w.api('GET', '/api/status', { as: asOwner })).json;
    S.check(`keys ${where}: the owner's status says the app runs ${where}`, st?.host === where, JSON.stringify(st?.host));
    const fst = (await w.api('GET', '/api/status', { as: F.casey })).json;
    S.check(`keys ${where}: a friend's status says nothing about where the app runs`, fst?.user && fst.user.isOwner === false && !('host' in fst), JSON.stringify(fst?.host));
    for (const theme of ['light', 'dark']) {
      for (const width of [390, 1280]) {
        const p = await open(browser, w, { role: null, width, theme });
        if (cookie) { const [k, ...v] = cookie.split('='); await p.ctx.addCookies([{ name: k, value: v.join('='), domain: 'localhost', path: '/' }]); }
        await go(p.page, w, 'settings', 600);
        const text = await keysGroup(p.page) || '';
        const wide = await p.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
        const want = where === 'railway' ? RAIL : LOCAL;
        S.check(`keys ${where} ${theme} ${width}: the API keys card says "${want}"`, text.includes(want) && !/hit Refresh/.test(text) && (where === 'local' || !/\.env/.test(text)) && wide && !p.errors.length, `${p.errors.slice(0, 2).join(' | ')} …${text.slice(-120)}`);
        await p.ctx.close();
      }
    }
  }
}

await S.step('tabs, header, pull, stale glow, seat line and the limit message', async () => {
  const parts = [tabs, headerPaints, headerPull, staleGlow, seatLine, limitMessage];
  const errs = [];
  await Promise.all(Array.from({ length: 4 }, async () => { while (parts.length) { const f = parts.shift(); try { await f(); } catch (e) { errs.push(`${f.name}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } } }));
  for (const e of errs) S.check(`${e.split(':')[0]} ran to the end`, false, e);
});
await S.step('the API keys text, locally and on Railway', keysText);

await browser.close();
await w.close();
S.finish();
