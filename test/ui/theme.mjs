// The Theme switch (You > Settings > Appearance): Match system, Light, Dark.
//
//   control    the row reads Theme, with one three-part control on its right
//              (monitor, sun, moon); a radio group named Theme whose parts are
//              named and titled Match system, Light and Dark; the chosen one
//              filled with the accent and lifted, the others plain; arrow
//              keys, Home and End move and choose; 44px parts; WCAG AA
//              non-text contrast in both themes; owner, the 700-rating friend
//              and the brand-new friend at 320, 390 and 1280; the guest has no
//              Settings.
//   persist    Light or Dark applies at once, with no reload and no request,
//              and holds after a reload, a new page, the app closed and opened
//              again, and in the installed app (Chromium and WebKit as an
//              iPhone); Match system is the default; another device still
//              follows its own system.
//   flash      a kept choice is on <html> while the parser is still in <head>
//              (before the first paint), the page has the chosen background
//              when <body> starts, and the "Loading" screen paints it.
//   follow     every token and color-scheme, the poster glow, the browser-bar
//              colour and the status bar follow the choice; with Match system
//              a system flip switches the page live, with a choice it doesn't;
//              another tab follows; the Join page follows too; no
//              prefers-color-scheme rule is left unguarded.
//   identical  forced Light on a dark system is pixel for pixel the system
//              light page, and forced Dark on a light system the system dark
//              page, on every screen, for every role, at 320, 390 and 1280.
//   matrix     every role at 320, 390 and 1280, each choice with the system
//              either way, plus the installed app at 390: no console error,
//              failed request or sideways scroll, and the right theme.
//
// RP_THEME_SHOTS=<folder> also saves screenshots of the control there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, REPO } from '../lib/world.mjs';
import { launch, open, go, settle } from '../lib/browser.mjs';
import { parse, over, ratio, PNG, waitDialog } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';
import { CSS_FILES, readAll } from '../lib/sources.mjs';

const S = suite('theme');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const SHOTS = process.env.RP_THEME_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const MOVIE = C.PLAYING[0].id;
const PERSON = C.PEOPLE.ada.id;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const BG = { light: 'rgb(242, 234, 219)', dark: 'rgb(15, 21, 38)' };
const NAMES = ['Match system', 'Light', 'Dark'];
const KEY_OF = { 'Match system': 'system', Light: 'light', Dark: 'dark' };

const w = S.world(await openWorld('theme'));
const F = w.friends;
await w.api('PUT', '/api/settings', { as: F.robin, body: { watchTogether: true } });
const jf = await w.api('POST', '/api/friends', { body: { name: 'Morgan' } });
const joinToken = new URL(jf.json.invite, 'http://x').searchParams.get('invite');
const ROLES = { owner: 'owner', heavy: F.robin, fresh: F.jordan, guest: 'guest' };
const chromium = await launch();
const webkit = await launch('webkit');

// ---------------------------------------------------------------- helpers
// A device: the system set one way and, unless 'system', a Theme choice kept
// on it from before. storage: a storageState to reopen a closed app with.
async function device(b, { role = 'owner', width = 390, system = 'light', choice = 'system', standalone = false, storage = null, clock = true } = {}) {
  const kept = choice === 'system' ? null : { cookies: [], origins: [{ origin: w.base, localStorage: [{ name: 'rp.theme', value: choice }] }] };
  const state = storage || kept;
  const isWebkit = b.browserType().name() === 'webkit';
  const extraCtx = { ...(state ? { storageState: state } : {}), ...(isWebkit && standalone ? { userAgent: IPHONE_UA, isMobile: true, hasTouch: true } : {}) };
  const p = await open(b, w, { role: ROLES[role] ?? role, width, theme: system, extraCtx, clock });
  if (standalone) {
    await p.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
    });
  }
  return { ...p, role, system, choice, standalone };
}

// #/<hash>, twice when the first load was sent to the welcome setup (a new friend).
async function visit(p, hash, ms = 300) {
  await go(p.page, w, hash, ms);
  const want = `#/${hash}`;
  if (!p.page.url().endsWith(want) && p.role !== 'guest') await go(p.page, w, hash, ms);
}

function themeState() {
  const root = document.documentElement;
  const bar = [...document.querySelectorAll('meta[name="theme-color"]')].filter((m) => !m.media || matchMedia(m.media).matches).map((m) => m.content);
  let stored;
  try { stored = localStorage.getItem('rp.theme'); } catch { stored = 'ERR'; }
  return {
    attr: root.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(root).colorScheme,
    bar, stored, status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content, get: window.rpTheme?.get?.(),
  };
}
const hex = (rgb) => { const c = parse(rgb); return `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`; };
const barOk = (st) => st.bar.length === 1 && st.bar[0].toLowerCase() === hex(st.bg);
const want = (system, choice) => (choice === 'system' ? system : choice);

// Every custom property the palettes set, and color-scheme, as the page has them.
const TOKEN_NAMES = [...new Set([...readAll(CSS_FILES).matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]))];
const tokens = (page) => page.evaluate((names) => {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries([['color-scheme', cs.colorScheme], ...names.map((n) => [n, cs.getPropertyValue(n).trim()])]);
}, TOKEN_NAMES);
const diffTokens = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`);

// The Theme row as it stands.
function controlProbe() {
  const row = document.querySelector('.theme-row');
  if (!row) return null;
  const S2 = (e) => getComputedStyle(e);
  const rect = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const label = row.querySelector('#theme-label');
  const group = row.querySelector('[role="radiogroup"]');
  const lb = group && document.getElementById(group.getAttribute('aria-labelledby') || '');
  const layers = (el) => { const out = []; for (let a = el; a; a = a.parentElement) { const c = S2(a).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { out.push(c); if (!/rgba|\/ /.test(c)) break; } } return out; };
  return {
    label: label?.textContent.trim(), labelRect: label && rect(label), groupRect: group && rect(group), rowRect: rect(row),
    groupName: lb?.textContent.trim() || group?.getAttribute('aria-label'), trackLayers: group && layers(group), page: S2(document.body).backgroundColor,
    radios: [...(group?.querySelectorAll('[role="radio"]') || [])].map((b) => ({
      name: b.getAttribute('aria-label'), title: b.getAttribute('title'), checked: b.getAttribute('aria-checked'), tab: b.tabIndex,
      ...rect(b), bg: S2(b).backgroundColor, color: S2(b).color, shadow: S2(b).boxShadow, svg: b.querySelector('svg')?.innerHTML || '',
      svgHidden: b.querySelector('svg')?.getAttribute('aria-hidden'), text: b.textContent.trim(),
    })),
  };
}
const flatten = (layers, page) => { let under = parse(page); for (const c of layers.slice().reverse()) under = over(parse(c), under); return under; };
const accentOf = (page) => page.evaluate(() => { const t = document.createElement('span'); t.style.backgroundColor = 'var(--accent)'; document.body.appendChild(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; });

// Past the controls' 150ms colour transition.
const choose = async (page, name) => { await page.getByRole('radio', { name, exact: true }).click(); await page.waitForTimeout(350); };

// ---------------------------------------------------------------- control
await S.step('control: the Theme row, its radio group, keys, sizes and contrast', async () => {
  for (const role of ['owner', 'heavy', 'fresh']) {
    for (const width of [320, 390, 1280]) {
      for (const system of ['light', 'dark']) {
        const tag = `control ${role} ${width} ${system}`;
        const p = await device(chromium, { role, width, system });
        await visit(p, 'settings', 400);
        const c = await p.page.evaluate(controlProbe);
        if (!c) { S.check(`${tag}: the Theme row is in Settings`, false, p.page.url()); await p.ctx.close(); continue; }
        S.check(`${tag}: the Theme row is in Settings`, true);
        const L = c.labelRect; const G = c.groupRect; const R = c.rowRect;
        S.check(`${tag}: the word Theme on the left, the control on the right of the same line`,
          c.label === 'Theme' && L.r <= G.l && Math.abs(G.r - R.r) <= 1 && Math.abs((L.t + L.b) / 2 - (G.t + G.b) / 2) <= 2,
          JSON.stringify({ label: c.label, L, G, R }));
        S.check(`${tag}: a radio group named Theme`, (await p.page.getByRole('radiogroup', { name: 'Theme', exact: true }).count()) === 1 && c.groupName === 'Theme', c.groupName);
        S.check(`${tag}: three parts named and titled Match system, Light, Dark`,
          c.radios.map((r) => r.name).join('|') === NAMES.join('|') && c.radios.every((r) => r.title === r.name && !r.text && r.svgHidden === 'true'),
          JSON.stringify(c.radios.map((r) => [r.name, r.title, r.text])));
        for (const n of NAMES) if ((await p.page.getByRole('radio', { name: n, exact: true }).count()) !== 1) S.check(`${tag}: "${n}" is reachable by its name`, false);
        S.check(`${tag}: a monitor, a sun and a moon in the app's stroke icons`,
          /<rect x="3" y="4"/.test(c.radios[0]?.svg) && /<circle cx="12" cy="12" r="4"/.test(c.radios[1]?.svg) && /A8\.5 8\.5/.test(c.radios[2]?.svg),
          c.radios.map((r) => r.svg.slice(0, 40)).join(' | '));
        S.check(`${tag}: Match system is chosen on a device that never chose, with the only tab stop`,
          c.radios.map((r) => `${r.checked}/${r.tab}`).join(' ') === 'true/0 false/-1 false/-1', c.radios.map((r) => `${r.checked}/${r.tab}`).join(' '));
        S.check(`${tag}: every part is at least 44 by 44`, c.radios.every((r) => r.w >= 44 && r.h >= 44), c.radios.map((r) => `${r.w}x${r.h}`).join(' '));
        // Look and contrast, for each choice in turn.
        const looks = []; const low = [];
        for (const n of NAMES) {
          await choose(p.page, n);
          const accent = await accentOf(p.page); // the accent of the theme now showing
          const d = await p.page.evaluate(controlProbe);
          const track = flatten(d.trackLayers, d.page);
          for (const r of d.radios) {
            const on = r.name === n;
            if (on && (r.bg !== accent || r.shadow === 'none' || r.checked !== 'true')) looks.push(`${n} chosen: ${r.name} ${r.bg} ${r.shadow} ${r.checked}`);
            if (!on && (!/rgba\(0, 0, 0, 0\)|transparent/.test(r.bg) || r.shadow !== 'none' || r.checked !== 'false')) looks.push(`${n} chosen: ${r.name} not plain (${r.bg}, ${r.shadow})`);
            const fill = on ? over(parse(r.bg), track) : track;
            const ic = ratio(parse(r.color), fill);
            if (ic < 3) low.push(`${n} chosen: ${r.name} icon ${ic.toFixed(2)}:1`);
            if (on) { const f = ratio(fill, track); if (f < 3) low.push(`${n} chosen: its fill on the track ${f.toFixed(2)}:1`); }
          }
          if (SHOTS && role === 'owner' && width !== 1280) await p.page.locator('.theme-row').screenshot({ path: path.join(SHOTS, `control-${width}-system-${system}-${KEY_OF[n]}.png`) });
        }
        S.check(`${tag}: the chosen part is filled with the accent and lifted, the others plain`, !looks.length, looks.slice(0, 3).join(' || '));
        S.check(`${tag}: icons and the chosen fill pass 3:1 (WCAG AA non-text)`, !low.length, low.join(' || '));
        await choose(p.page, 'Match system');
        // The focus ring on the chosen part.
        // Reached by keyboard, so the ring is the keyboard one.
        await p.page.getByRole('radio', { name: 'Match system', exact: true }).focus();
        await p.page.keyboard.press('ArrowRight'); await p.page.keyboard.press('ArrowLeft'); await p.page.waitForTimeout(80);
        const ring = await p.page.evaluate(() => { const e = document.activeElement; const s = getComputedStyle(e); return { vis: e.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor }; });
        const cc = await p.page.evaluate(controlProbe);
        const rr = ratio(parse(ring.color), flatten(cc.trackLayers, cc.page));
        S.check(`${tag}: a visible focus ring at 3:1`, ring.vis && ring.style === 'solid' && parseFloat(ring.width) >= 2 && rr >= 3, `${JSON.stringify(ring)} ${rr.toFixed(2)}:1`);
        if (width === 390) {
          // Arrow keys, Home and End: focus moves and the theme follows.
          const steps = [['ArrowRight', 'Light'], ['ArrowRight', 'Dark'], ['ArrowRight', 'Match system'], ['ArrowLeft', 'Dark'], ['ArrowUp', 'Light'], ['ArrowDown', 'Dark'], ['Home', 'Match system'], ['End', 'Dark'], ['Home', 'Match system']];
          const bad = [];
          for (const [key, name] of steps) {
            await p.page.keyboard.press(key);
            await p.page.waitForTimeout(80);
            const s = await p.page.evaluate(() => ({ focus: document.activeElement?.getAttribute('aria-label'), checked: [...document.querySelectorAll('.theme-part[aria-checked="true"]')].map((b) => b.getAttribute('aria-label')), tabs: [...document.querySelectorAll('.theme-part')].filter((b) => b.tabIndex === 0).length, attr: document.documentElement.getAttribute('data-theme') }));
            const attr = KEY_OF[name] === 'system' ? null : KEY_OF[name];
            if (s.focus !== name || s.checked.join() !== name || s.tabs !== 1 || s.attr !== attr) bad.push(`${key}: ${JSON.stringify(s)} (wanted ${name})`);
          }
          S.check(`${tag}: arrow keys, Home and End move between the parts and choose`, !bad.length, bad.slice(0, 3).join(' || '));
          // Tab leaves the group in one step and Shift+Tab comes back to the chosen part.
          await p.page.keyboard.press('ArrowRight'); await p.page.waitForTimeout(60);
          await p.page.keyboard.press('Tab');
          const out = await p.page.evaluate(() => !document.activeElement?.closest('.theme-switch'));
          await p.page.keyboard.press('Shift+Tab');
          const back = await p.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
          S.check(`${tag}: one tab stop, on the chosen part`, out && back === 'Light', `left the group: ${out}, came back to ${back}`);
          await choose(p.page, 'Match system');
        }
        S.check(`${tag}: no console error or failed request`, !p.errors.length && !p.outside.length, [...p.errors, ...p.outside].slice(0, 3).join(' | '));
        await p.ctx.close();
      }
    }
  }
  // The guest link has no Settings; a choice kept on the device still applies.
  for (const system of ['light', 'dark']) {
    const p = await device(chromium, { role: 'guest', system, choice: system === 'light' ? 'dark' : 'light' });
    await go(p.page, w, 'settings', 400);
    const st = await p.page.evaluate(themeState);
    S.check(`control guest ${system}: Settings isn't reachable, so there's no Theme control`, !p.page.url().includes('#/settings') && (await p.page.locator('.theme-switch').count()) === 0, p.page.url());
    S.check(`control guest ${system}: the choice kept on this device still applies`, st.bg === BG[system === 'light' ? 'dark' : 'light'], JSON.stringify(st));
    await p.ctx.close();
  }
});

// ---------------------------------------------------------------- persist
await S.step('persist: at once, no reload, no request, kept on this device only', async () => {
  for (const role of ['owner', 'heavy', 'fresh']) {
    for (const [system, pick] of [['light', 'Dark'], ['dark', 'Light']]) {
      const tag = `persist ${role} ${system} system, ${pick}`;
      const key = KEY_OF[pick];
      const p = await device(chromium, { role, system });
      await visit(p, 'settings', 400);
      const before = await p.page.evaluate(themeState);
      S.check(`${tag}: a device that never chose follows the system`, before.attr === null && before.stored === null && before.get === 'system' && before.bg === BG[system], JSON.stringify(before));
      const settingsBefore = (await w.api('GET', '/api/settings', role === 'owner' ? {} : { as: ROLES[role] })).json;
      const reqs = []; const navs = [];
      p.page.on('request', (r) => { if (r.url().startsWith(w.base)) reqs.push(`${r.method()} ${r.url().replace(w.base, '')}`); });
      p.page.on('framenavigated', (f) => { if (f === p.page.mainFrame()) navs.push(f.url()); });
      await p.page.evaluate(() => { window.__sameDocument = true; });
      await choose(p.page, pick);
      const now = await p.page.evaluate(themeState);
      const same = await p.page.evaluate(() => window.__sameDocument === true);
      S.check(`${tag}: applies at once, in the same document`, now.attr === key && now.bg === BG[key] && now.stored === key && same && !navs.length, JSON.stringify({ now, same, navs }));
      S.check(`${tag}: choosing sends nothing to the server`, !reqs.length, reqs.join(', '));
      const settingsAfter = (await w.api('GET', '/api/settings', role === 'owner' ? {} : { as: ROLES[role] })).json;
      S.check(`${tag}: the account's settings are untouched`, JSON.stringify(settingsBefore) === JSON.stringify(settingsAfter) && !/theme/i.test(JSON.stringify(settingsAfter)));
      await p.page.reload(); await settle(p.page, 300);
      await visit(p, 'settings', 300); // a new friend's reload starts on the welcome setup
      const re = await p.page.evaluate(themeState);
      const checked = await p.page.evaluate(() => document.querySelector('.theme-part[aria-checked="true"]')?.getAttribute('aria-label'));
      S.check(`${tag}: holds after a reload, with ${pick} shown as chosen`, re.attr === key && re.bg === BG[key] && checked === pick, JSON.stringify({ re, checked }));
      const p2 = await p.ctx.newPage();
      await p2.goto(`${w.base}/#/home`); await settle(p2, 200);
      const again = await p2.evaluate(themeState);
      S.check(`${tag}: holds in a new page`, again.attr === key && again.bg === BG[key], JSON.stringify(again));
      const storage = await p.ctx.storageState();
      await p.ctx.close();
      const reopened = await device(chromium, { role, system, storage });
      await visit(reopened, 'home', 200);
      const ro = await reopened.page.evaluate(themeState);
      S.check(`${tag}: holds after the app is closed and opened again`, ro.attr === key && ro.bg === BG[key], JSON.stringify(ro));
      // Back to Match system: the attribute and the kept choice go, the system rules again.
      await visit(reopened, 'settings', 300);
      await choose(reopened.page, 'Match system');
      const sys = await reopened.page.evaluate(themeState);
      S.check(`${tag}: Match system goes back to the system`, sys.attr === null && sys.stored === null && sys.bg === BG[system], JSON.stringify(sys));
      await reopened.ctx.close();
      // Another device of the same person still follows its own system.
      const other = await device(chromium, { role, system });
      await visit(other, 'home', 200);
      const o = await other.page.evaluate(themeState);
      S.check(`${tag}: another device still follows its system`, o.attr === null && o.bg === BG[system], JSON.stringify(o));
      await other.ctx.close();
    }
  }
  // The installed app, in Chromium and in WebKit as an iPhone.
  for (const [engine, b] of [['chromium', chromium], ['webkit', webkit]]) {
    for (const [system, pick] of [['light', 'Dark'], ['dark', 'Light']]) {
      const tag = `persist standalone ${engine} 390 ${system} system, ${pick}`;
      const key = KEY_OF[pick];
      const p = await device(b, { width: 390, system, standalone: true });
      await visit(p, 'settings', 400);
      const inApp = await p.page.evaluate(() => navigator.standalone === true && matchMedia('(display-mode: standalone)').matches);
      await choose(p.page, pick);
      const now = await p.page.evaluate(themeState);
      S.check(`${tag}: applies at once in the installed app`, inApp && now.attr === key && now.bg === BG[key] && barOk(now) && now.status === 'default', JSON.stringify({ inApp, now }));
      await p.page.reload(); await settle(p.page, 300);
      const re = await p.page.evaluate(themeState);
      S.check(`${tag}: holds after a reload`, re.attr === key && re.bg === BG[key] && barOk(re), JSON.stringify(re));
      const storage = await p.ctx.storageState();
      const errs = [...p.errors, ...p.outside];
      await p.ctx.close();
      const again = await device(b, { width: 390, system, standalone: true, storage });
      await visit(again, 'home', 300);
      const a = await again.page.evaluate(themeState);
      S.check(`${tag}: holds when the app is opened again`, a.attr === key && a.bg === BG[key] && barOk(a) && a.status === 'default', JSON.stringify(a));
      errs.push(...again.errors, ...again.outside);
      S.check(`${tag}: no console error or failed request`, !errs.length, errs.slice(0, 3).join(' | '));
      await again.ctx.close();
    }
  }
});

// ---------------------------------------------------------------- flash
// The kept choice goes on <html> while the parser is still in <head> (so
// before anything can be painted), the page's --bg is the chosen one when
// <body> starts, and the "Loading" screen (app code held back) paints it.
const FIRST = () => {
  window.__themeSeen = null;
  new MutationObserver(() => {
    if (window.__themeSeen || !document.documentElement?.hasAttribute('data-theme')) return;
    window.__themeSeen = { at: performance.now(), body: Boolean(document.body), attr: document.documentElement.getAttribute('data-theme') };
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
};
// The probe is an inline script of the test's own: the page's
// Content-Security-Policy is given its hash, the way it lists the app's.
const PROBE = 'window.__bodyStart = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase();';
const PROBE_HASH = `'sha256-${crypto.createHash('sha256').update(PROBE).digest('base64')}'`;
async function bodyStartProbe(ctx, guest) {
  await ctx.route((u) => u.pathname === '/' || u.pathname === '/index.html', async (r) => {
    if (r.request().resourceType() !== 'document') return r.fallback();
    const res = await r.fetch({ headers: { ...r.request().headers(), ...(guest ? { 'cf-ray': 'test' } : {}) } });
    const html = (await res.text()).replace('<body>', `<body><script>${PROBE}</script>`);
    const h = res.headers();
    const csp = (h['content-security-policy'] || '').replace("script-src 'self'", `script-src 'self' ${PROBE_HASH}`);
    return r.fulfill({ response: res, body: html, headers: { ...h, 'content-type': 'text/html; charset=utf-8', ...(csp ? { 'content-security-policy': csp } : {}) } });
  });
}
await S.step('flash: the chosen theme is set before the first paint', async () => {
  const BGHEX = { light: '#f2eadb', dark: '#0f1526' };
  for (const [engine, b] of [['chromium', chromium], ['webkit', webkit]]) {
    for (const [system, choice] of [['light', 'dark'], ['dark', 'light']]) {
      for (const [role, hash, standalone] of [['owner', 'home'], ['owner', 'settings'], ['owner', `movie/${MOVIE}`], ['heavy', 'rate'], ['fresh', 'welcome'], ['guest', 'home'], ['owner', 'home', true]]) {
        const tag = `flash ${engine} ${role} ${hash.split('/')[0]}${standalone ? ' standalone' : ''} ${system} system, ${choice} kept`;
        const p = await device(b, { role, system, choice, standalone, clock: false });
        await p.ctx.addInitScript(FIRST);
        await bodyStartProbe(p.ctx, role === 'guest');
        await p.page.goto(`${w.base}/#/${hash}`);
        await settle(p.page, 200);
        const r = await p.page.evaluate(() => ({ seen: window.__themeSeen, body: window.__bodyStart, fp: performance.getEntriesByType('paint').find((e) => e.name === 'first-paint')?.startTime ?? null }));
        S.check(`${tag}: set while still in <head>, before the first paint`, r.seen && r.seen.attr === choice && r.seen.body === false && (r.fp == null ? engine === 'webkit' : r.seen.at < r.fp), JSON.stringify(r));
        S.check(`${tag}: <body> starts on the chosen background`, r.body === BGHEX[choice], JSON.stringify(r));
        S.check(`${tag}: no console error or failed request`, !p.errors.length && !p.outside.length, [...p.errors, ...p.outside].slice(0, 3).join(' | '));
        await p.ctx.close();
      }
      // The Loading screen, with the app's code held back for two seconds.
      // The page without the app's code, so it stays on the Loading screen.
      const p = await device(b, { system, choice, clock: false });
      await p.ctx.route((u) => u.pathname === '/', async (r) => {
        const res = await r.fetch();
        await r.fulfill({ response: res, body: (await res.text()).replace(/<script type="module" src="\/js\/app\.js"><\/script>/, ''), headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
      });
      await p.page.goto(`${w.base}/#/home`);
      await p.page.waitForSelector('.boot', { timeout: 10000 }).catch(() => {});
      await p.page.waitForTimeout(300);
      const px = PNG.read(await p.page.screenshot());
      const boot = await p.page.evaluate(() => Boolean(document.querySelector('.boot')) && !document.querySelector('.shell'));
      const at = (x, y) => { const i = (y * px.width + x) * 4; return [px.data[i], px.data[i + 1], px.data[i + 2]]; };
      // Within 2 per channel: WebKit's screenshots can round a colour by one.
      const near = (c) => { const e = parse(BG[choice]); return Math.abs(c[0] - e.r) <= 2 && Math.abs(c[1] - e.g) <= 2 && Math.abs(c[2] - e.b) <= 2; };
      S.check(`flash ${engine} ${system} system, ${choice} kept: the Loading screen paints the chosen background`, boot && near(at(4, 4)) && near(at(px.width - 4, px.height - 4)) && near(at(px.width >> 1, px.height - 4)), `${boot} ${at(4, 4)} ${at(px.width - 4, px.height - 4)}`);
      await p.ctx.close();
    }
  }
  // The Join page, which carries the same script.
  for (const [system, choice] of [['light', 'dark'], ['dark', 'light']]) {
    const p = await device(chromium, { role: 'guest', system, choice, clock: false });
    await p.ctx.addInitScript(FIRST);
    await p.page.goto(`${w.base}/?invite=${joinToken}`);
    await p.page.waitForTimeout(300);
    const r = await p.page.evaluate(() => ({ seen: window.__themeSeen, fp: performance.getEntriesByType('paint').find((e) => e.name === 'first-paint')?.startTime ?? null }));
    S.check(`flash join ${system} system, ${choice} kept: set before the first paint`, r.seen && r.seen.attr === choice && r.seen.body === false && r.fp != null && r.seen.at < r.fp, JSON.stringify(r));
    await p.ctx.close();
  }
});

// ---------------------------------------------------------------- follow
await S.step('follow: tokens, glow, browser bar, status bar, live system changes', async () => {
  // Static: one guarded media block, two dark blocks with the same values,
  // and nothing in the app's code asks for the system's scheme itself.
  const css = readAll(CSS_FILES);
  const media = [...css.matchAll(/@media[^{]*prefers-color-scheme[^{]*\{\s*([^{]*)\{/g)];
  S.check('follow: styles.css has one prefers-color-scheme block, and it yields to a chosen Light',
    media.length === 1 && media[0][1].trim() === ':root:not([data-theme="light"])', media.map((m) => m[0].replace(/\s+/g, ' ')).join(' || '));
  const decls = (s) => (s || '').replace(/\/\*[\s\S]*?\*\//g, '').split(';').map((x) => x.trim()).filter(Boolean).join(';');
  const sys = css.match(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/)?.[1];
  const forced = css.match(/\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)?.[1];
  S.check('follow: the forced-Dark block holds exactly the system dark values', sys && forced && decls(sys) === decls(forced), `${decls(sys).length} vs ${decls(forced).length}`);
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const js = walk('public/js').filter((f) => f.endsWith('.js')).filter((f) => /prefers-color-scheme/.test(read(f)));
  S.check('follow: no script asks for the system scheme itself', !js.length, js.join(', '));
  const html = read('public/index.html');
  const odd = [...html.matchAll(/<[^>]*prefers-color-scheme[^>]*>/g)].map((m) => m[0]).filter((t) => !/^<meta name="theme-color"|^<link rel="apple-touch-startup-image"/.test(t));
  S.check('follow: in index.html only the browser-bar colours and the launch screens name the system scheme', !odd.length, odd.join(' || '));

  // Every token, in each case, against the system's own.
  const tokenSets = {};
  for (const system of ['light', 'dark']) {
    for (const choice of ['system', 'light', 'dark']) {
      const p = await device(chromium, { system, choice });
      await visit(p, 'home', 200);
      tokenSets[`${system}/${choice}`] = await tokens(p.page);
      await p.ctx.close();
    }
  }
  const L = tokenSets['light/system']; const D = tokenSets['dark/system'];
  S.check('follow: the system light and dark token sets differ (the check can fail)', diffTokens(L, D).length > 20, diffTokens(L, D).length);
  for (const [k, v] of Object.entries(tokenSets)) {
    const [system, choice] = k.split('/');
    const d = diffTokens(v, want(system, choice) === 'light' ? L : D);
    S.check(`follow: ${system} system, ${choice}: every token and color-scheme is the ${want(system, choice)} set`, !d.length, d.slice(0, 4).join('; '));
  }

  // The poster glow: dark only, forced or not.
  const glow = {};
  for (const system of ['light', 'dark']) {
    for (const choice of ['system', 'light', 'dark']) {
      for (const hash of ['home', `movie/${MOVIE}`]) {
        const p = await device(chromium, { system, choice });
        await visit(p, hash, 400);
        glow[`${system}/${choice}/${hash}`] = await p.page.evaluate(() => { const g = document.querySelector('.page-glow'); const s = getComputedStyle(g); return { shell: document.querySelector('.shell').classList.contains('has-glow'), display: s.display, image: s.backgroundImage, height: s.height }; });
        await p.ctx.close();
      }
    }
  }
  for (const hash of ['home', `movie/${MOVIE}`]) {
    const sd = glow[`dark/system/${hash}`]; const sl = glow[`light/system/${hash}`];
    S.check(`follow: glow ${hash.split('/')[0]}: shows in system dark, not in system light`, sd.shell && sd.display === 'block' && /gradient/.test(sd.image) && sl.display === 'none', JSON.stringify({ sd, sl }));
    for (const system of ['light', 'dark']) {
      const fd = glow[`${system}/dark/${hash}`]; const fl = glow[`${system}/light/${hash}`];
      S.check(`follow: glow ${hash.split('/')[0]} ${system} system: Dark shows the same glow, Light none`, JSON.stringify(fd) === JSON.stringify(sd) && fl.display === 'none', JSON.stringify({ fd, fl }));
    }
  }

  // Browser bar and status bar, in the browser and the installed app.
  for (const standalone of [false, true]) {
    for (const system of ['light', 'dark']) {
      for (const choice of ['system', 'light', 'dark']) {
        const p = await device(chromium, { system, choice, standalone });
        await visit(p, 'home', 200);
        const st = await p.page.evaluate(themeState);
        const exp = want(system, choice);
        S.check(`follow: bar ${standalone ? 'standalone' : 'browser'} ${system} system, ${choice}: the page, the browser-bar colour and the status bar are ${exp}`,
          st.bg === BG[exp] && barOk(st) && st.status === 'default' && st.scheme === exp && st.attr === (choice === 'system' ? null : choice), JSON.stringify(st));
        await p.ctx.close();
      }
    }
  }

  // Live: Match system follows a system flip; a choice holds through one.
  for (const [start, choice] of [['light', 'system'], ['dark', 'system'], ['light', 'dark'], ['dark', 'light'], ['light', 'light'], ['dark', 'dark']]) {
    const p = await device(chromium, { system: start, choice });
    await visit(p, 'settings', 300);
    const navs = [];
    p.page.on('framenavigated', (f) => { if (f === p.page.mainFrame()) navs.push(f.url()); });
    await p.page.evaluate(() => { window.__sameDocument = true; });
    const seen = [];
    for (const flip of [start === 'light' ? 'dark' : 'light', start]) {
      await p.page.emulateMedia({ colorScheme: flip });
      await p.page.waitForTimeout(150);
      const st = await p.page.evaluate(themeState);
      seen.push({ flip, bg: st.bg, bar: barOk(st), want: BG[want(flip, choice)] });
    }
    const same = await p.page.evaluate(() => window.__sameDocument === true);
    S.check(`follow: live ${start} system, ${choice}: a system flip ${choice === 'system' ? 'switches the page' : 'changes nothing'}, no reload`,
      seen.every((s) => s.bg === s.want && s.bar) && same && !navs.length, JSON.stringify({ seen, same, navs }));
    await p.ctx.close();
  }

  // Another tab of the app follows a change.
  {
    const p = await device(chromium, { system: 'light' });
    await visit(p, 'settings', 300);
    const other = await p.ctx.newPage();
    await other.goto(`${w.base}/#/home`); await settle(other, 200);
    await choose(p.page, 'Dark');
    await other.waitForTimeout(300);
    const a = await other.evaluate(themeState);
    await choose(p.page, 'Match system');
    await other.waitForTimeout(300);
    const b = await other.evaluate(themeState);
    S.check('follow: another open tab follows Dark, then Match system', a.bg === BG.dark && a.attr === 'dark' && b.bg === BG.light && b.attr === null, JSON.stringify({ a, b }));
    await p.ctx.close();
  }

  // The Join page follows the choice too.
  for (const system of ['light', 'dark']) {
    for (const choice of ['system', 'light', 'dark']) {
      const p = await device(chromium, { role: 'guest', system, choice });
      await p.page.goto(`${w.base}/?invite=${joinToken}`);
      await p.page.waitForTimeout(300);
      const st = await p.page.evaluate(themeState);
      const title = await p.page.locator('h1').first().textContent();
      const exp = want(system, choice);
      S.check(`follow: join ${system} system, ${choice}: the Join page is ${exp}`, /invited/.test(title) && st.bg === BG[exp] && barOk(st), JSON.stringify({ title, st }));
      await p.ctx.close();
    }
  }
});

// ---------------------------------------------------------------- identical
const SCENES = {
  owner: ['home', `movie/${MOVIE}`, `person/${PERSON}`, 'schedule', 'schedule/coming', 'schedule/leaving', 'rate', 'watchlist', 'stats', 'together', 'settings', 'help', 'SEARCH', 'WSW'],
  heavy: ['home', 'rate', 'watchlist', 'stats', 'together', 'settings', 'help'],
  fresh: ['welcome', 'settings', 'help'],
  guest: ['home', `movie/${MOVIE}`, `person/${PERSON}`, 'schedule', 'schedule/leaving', 'JOIN'],
};
async function scene(p, s) {
  if (s === 'JOIN') { await p.page.goto(`${w.base}/?invite=${joinToken}`); await p.page.waitForTimeout(400); return; }
  if (s === 'SEARCH' || s === 'WSW') {
    await visit(p, 'home', 300);
    if (s === 'SEARCH') { await p.page.click('#search-btn'); await p.page.waitForSelector('.search-input'); await p.page.waitForTimeout(500); }
    else { await p.page.click('#wsw-btn'); await waitDialog(p.page); }
    return;
  }
  await visit(p, s, 400);
}
// A full-page shot with everything drawn (rows held back by content-visibility
// and lazy images included, the same in both pages), once two in a row agree.
// On Settings the Theme row is masked: it shows a different chosen part by
// design, and the control checks cover it.
async function shot(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(async () => {
    // A constructed sheet: the page's Content-Security-Policy refuses an added <style>.
    if (!window.__rpRenderAll) {
      const st = new CSSStyleSheet(); st.replaceSync('* { content-visibility: visible !important; }');
      window.__rpRenderAll = st;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, st];
    }
    for (const i of document.querySelectorAll('img[loading="lazy"]')) i.loading = 'eager';
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 3000); }))));
  });
  const opts = { fullPage: true, animations: 'disabled', caret: 'hide', mask: [page.locator('.theme-row')] };
  let last = await page.screenshot(opts);
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    const next = await page.screenshot(opts);
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}
// Pixels that differ by more than 8 levels in a channel. The rasteriser
// shades anti-aliased edges a little differently from one page to the next:
// the same search sheet opened twice with the same settings differed on 15
// glyph-edge pixels by up to 6 levels. That isn't a colour anyone can see;
// every theme colour is held exactly by the token checks under follow.
function pixelDiff(a, b) {
  if (a.equals(b)) return 0;
  const x = PNG.read(a); const y = PNG.read(b);
  if (x.width !== y.width || x.height !== y.height) return `size ${x.width}x${x.height} vs ${y.width}x${y.height}`;
  let n = 0;
  for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) > 8 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 8 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 8) n++;
  return n;
}
await S.step('identical: forced Light looks exactly like system light, forced Dark like system dark', async () => {
  const jobs = [];
  for (const role of Object.keys(SCENES)) for (const width of [320, 390, 1280]) jobs.push([role, width]);
  const errs = [];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (jobs.length) {
      const [role, width] = jobs.shift();
      try {
        for (const theme of ['light', 'dark']) {
          const other = theme === 'light' ? 'dark' : 'light';
          const sysP = await device(chromium, { role, width, system: theme });
          const forP = await device(chromium, { role, width, system: other, choice: theme });
          const bad = [];
          for (const s of SCENES[role]) {
            await scene(sysP, s); await scene(forP, s);
            let d = pixelDiff(await shot(sysP.page), await shot(forP.page));
            // More looks before calling it: something may still have been settling.
            for (let k = 0; d !== 0 && k < 3; k++) { await sysP.page.waitForTimeout(800); await forP.page.waitForTimeout(800); d = pixelDiff(await shot(sysP.page), await shot(forP.page)); }
            if (d !== 0) {
              bad.push(`${s}: ${typeof d === 'number' ? `${d} pixels differ` : d}`);
              if (SHOTS) { const n = `${role}-${width}-${theme}-${s.replace(/\//g, '_')}`; fs.writeFileSync(path.join(SHOTS, `diff-${n}-system.png`), await shot(sysP.page)); fs.writeFileSync(path.join(SHOTS, `diff-${n}-forced.png`), await shot(forP.page)); }
            }
          }
          S.check(`identical ${role} ${width}: forced ${theme} on a ${other} system matches system ${theme} on every screen`, !bad.length, bad.slice(0, 4).join(' || '));
          const e = [...sysP.errors, ...forP.errors, ...sysP.outside, ...forP.outside];
          S.check(`identical ${role} ${width} ${theme}: no console error or failed request`, !e.length, e.slice(0, 3).join(' | '));
          await sysP.ctx.close(); await forP.ctx.close();
        }
      } catch (e) { errs.push(`${role} ${width}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
    }
  }));
  for (const e of errs) S.check(`identical ${e.split(':')[0]} ran to the end`, false, e);
  // The comparison can fail: system light and system dark differ.
  const a = await device(chromium, { system: 'light' }); const c = await device(chromium, { system: 'dark' });
  await scene(a, 'home'); await scene(c, 'home');
  const n = pixelDiff(await shot(a.page), await shot(c.page));
  S.check('identical: the comparison tells system light from system dark', typeof n === 'string' || n > 10000, n);
  await a.ctx.close(); await c.ctx.close();
});

// ---------------------------------------------------------------- matrix
const REACH = {
  owner: ['home', `movie/${MOVIE}`, `person/${PERSON}`, 'schedule', 'schedule/coming', 'schedule/leaving', 'rate', 'watchlist', 'stats', 'together', 'settings', 'help'],
  heavy: ['home', `movie/${MOVIE}`, 'schedule', 'rate', 'watchlist', 'stats', 'together', 'settings', 'help'],
  fresh: ['welcome', 'home', 'rate', 'settings', 'help'],
  guest: ['home', `movie/${MOVIE}`, `person/${PERSON}`, 'schedule', 'schedule/leaving'],
};
await S.step('matrix: every role, width, choice and system, and the installed app', async () => {
  const jobs = [];
  for (const role of Object.keys(REACH)) {
    for (const width of [320, 390, 1280]) for (const system of ['light', 'dark']) for (const choice of ['system', 'light', 'dark']) jobs.push({ role, width, system, choice, standalone: false });
    for (const system of ['light', 'dark']) for (const choice of ['system', 'light', 'dark']) jobs.push({ role, width: 390, system, choice, standalone: true });
  }
  const errs = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (jobs.length) {
      const j = jobs.shift();
      const tag = `matrix ${j.role} ${j.width}${j.standalone ? ' standalone' : ''} ${j.system} system, ${j.choice}`;
      try {
        const p = await device(chromium, j);
        const exp = want(j.system, j.choice);
        const wrong = []; const wide = [];
        for (const s of REACH[j.role]) {
          await visit(p, s, 250);
          const r = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bg: getComputedStyle(document.body).backgroundColor, hash: location.hash }));
          if (r.sw > r.iw) wide.push(`${s} ${r.sw}>${r.iw}`);
          if (r.bg !== BG[exp]) wrong.push(`${s} ${r.bg}`);
        }
        const e = [...p.errors, ...p.outside];
        S.check(`${tag}: the ${exp} theme on every screen, no sideways scroll, no console error or failed request`, !wrong.length && !wide.length && !e.length, [...wrong, ...wide, ...e].slice(0, 4).join(' | '));
        await p.ctx.close();
      } catch (e) { errs.push(`${tag}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); }
    }
  }));
  for (const e of errs) S.check(`${e.split(':')[0]} ran to the end`, false, e);
});

await chromium.close();
await webkit.close();
await w.close();
S.finish();
