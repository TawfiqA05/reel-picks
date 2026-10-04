// Design system (real-app G3 g-tokens, G5 g-type, G7 g-buttons, G9 g-boxes,
// G10 g-words, G16 g-clean; they supersede final-polish G3 and the palette /
// palette-final token gates): Midnight marquee dark and Ticket stub light
// tokens, the browser bar, manifest, status bar, icons and launch screens;
// only Big Shoulders Display and IBM Plex Sans downloaded and painted, no
// layout shift when they land, sizes and line heights from the type scale;
// one button system; grouped lists instead of outlined cards; plain sentence
// case wording; nothing old left in the stylesheet, and every rendered state
// painting only palette colours.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, REPO } from '../lib/world.mjs';
import { launch, open, go, VISIBLE } from '../lib/browser.mjs';
import { parse, over, ratio, PNG, platformFonts, extras, waitDialog, realSizePosters } from '../lib/ui-helpers.mjs';
import { buttonsProbe, outlined, BUZZ, wordScan, wordProblems, paintedColours, paletteNow, inPalette } from '../lib/design-probes.mjs';
import * as C from '../lib/catalog.mjs';
import { CSS_FILES, ROUTE_FILES, readAll } from '../lib/sources.mjs';

const S = suite('design');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const css = readAll(CSS_FILES);
const MOVIE = C.PLAYING[0].id;

// ---------------------------------------------------------------- tokens (static)
await S.step('tokens: Midnight marquee dark, Ticket stub light, AA pairs', async () => {
  const block = (re) => { const m = css.match(re); const out = {}; if (m) for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[k] = v.trim(); return out; };
  const light = block(/\/\* ---- palettes ----[\s\S]*?:root \{([\s\S]*?)\n\}/);
  const dark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const BRIEF = {
    bg: '#0f1526', raised: '#18203a', chip: '#1c2540', tabbar: '#121a2e', text: '#f4efe6', muted: '#9aa4bd', divider: '#232d48',
    accent: '#f2a93b', 'on-accent': '#1a1206', 'accent-soft': 'rgba(242, 169, 59, .14)', gold: '#f5c04e', good: '#5fd3a4',
    bad: '#ff7b72', 'bad-soft': 'rgba(255, 123, 114, .13)', warn: '#f2a93b',
  };
  const same = (a, b) => { if (!a || !b) return false; const x = parse(a); const y = parse(b); return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) < 2 && Math.abs(x.a - y.a) < 0.01; };
  const moved = Object.entries(BRIEF).filter(([k, v]) => !same(dark[k], v)).map(([k, v]) => `--${k}: ${dark[k]} instead of ${v}`);
  S.check('dark tokens are the Midnight marquee values', !moved.length, moved.join('; '));
  const L = (k) => parse(light[k] || '#000');
  S.check('light --bg is cream paper', L('bg').r > 230 && L('bg').g > 220 && L('bg').b > 200, light.bg);
  S.check('light --text is ink on the cream', ratio(L('text'), L('bg')) >= 12, light.text);
  { const a = L('accent'); S.check('light --accent is teal', a.g > a.r && a.b > a.r && a.g < 140, light.accent); }
  for (const [theme, t] of [['light', light], ['dark', { ...light, ...dark }]]) {
    const T = (k) => parse(t[k]);
    const bad = [];
    const surfaces = ['bg', 'raised', 'chip'];
    for (const s of surfaces) for (const x of ['text', 'muted', 'accent-text', 'good', 'bad', 'warn', 'gold', 'blue', 'purple', 'teal', 'amber']) { const r = ratio(T(x), T(s)); if (r < 4.5) bad.push(`--${x} on --${s} ${r.toFixed(2)}:1`); }
    for (const [fill, fg] of [['accent-soft', 'accent-text'], ['bad-soft', 'bad'], ['blue-soft', 'blue'], ['purple-soft', 'purple'], ['teal-soft', 'teal'], ['amber-soft', 'amber']]) for (const s of surfaces) { const r = ratio(T(fg), over(T(fill), T(s))); if (r < 4.5) bad.push(`--${fg} on --${fill} over --${s} ${r.toFixed(2)}:1`); }
    { const r = ratio(T('on-accent'), T('accent')); if (r < 4.5) bad.push(`--on-accent on --accent ${r.toFixed(2)}:1`); }
    for (const s of surfaces) { const r = ratio(T('field-edge'), T(s)); if (r < 3) bad.push(`--field-edge on --${s} ${r.toFixed(2)}:1`); }
    S.check(`${theme}: every text, tag, button and field-edge token pair passes AA`, !bad.length, bad.join('; '));
  }
});

await S.step('tokens: browser bar, manifest, status bar, icons and launch screens', async () => {
  const html = read('public/index.html');
  S.check('dark theme-color is #0f1526', /<meta name="theme-color" content="#0f1526" media="\(prefers-color-scheme: dark\)"/i.test(html));
  S.check('light theme-color is the cream', /<meta name="theme-color" content="#F2EADB" media="\(prefers-color-scheme: light\)"/i.test(html));
  S.check('iOS status bar style is "default" (text follows the theme colour)', /apple-mobile-web-app-status-bar-style" content="default"/.test(html));
  const man = JSON.parse(read('public/manifest.webmanifest'));
  S.check('manifest background and theme colours are navy', man.background_color.toLowerCase() === '#0f1526' && man.theme_color.toLowerCase() === '#0f1526', `${man.background_color} / ${man.theme_color}`);
  const corner = (file) => { const p = PNG.read(fs.readFileSync(path.join(REPO, file))); const i = (2 * p.width + 2) * 4; return `#${[0, 1, 2].map((k) => p.data[i + k].toString(16).padStart(2, '0')).join('')}`; };
  const near = (a, b) => { const x = parse(a); const y = parse(b); return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) < 2; };
  const icons = ['public/icons/icon-192.png', 'public/icons/icon-512.png', 'public/icons/maskable-512.png', 'public/icons/apple-touch-icon.png'].filter((f) => !near(corner(f), '#0f1526'));
  S.check('app icons have the navy background', !icons.length, icons.join(', '));
  S.check('icon.svg tile is navy', /fill="#0f1526"/.test(read('public/icons/icon.svg')));
  const launchLinks = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)"/g)];
  S.check('at least 8 dark launch screens are linked', launchLinks.filter((m) => /prefers-color-scheme: dark/.test(m[1])).length >= 8);
  const wrong = [];
  for (const [, , href] of launchLinks) {
    const f = path.join('public', href);
    if (!fs.existsSync(path.join(REPO, f))) { wrong.push(`${href} missing`); continue; }
    const want = /-dark\.png$/.test(href) ? '#0f1526' : '#f2eadb';
    if (!near(corner(f), want)) wrong.push(`${href} is ${corner(f)}`);
  }
  S.check('every launch screen exists with its theme\'s background', !wrong.length, wrong.join('; '));
});

// ---------------------------------------------------------------- clean (static)
await S.step('clean: nothing old left in the stylesheet', async () => {
  const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const sources = [...walk('public/js').filter((f) => f.endsWith('.js')), 'public/index.html', 'server/lib/invitePage.js', 'server/lib/alerts.js', 'server/lib/together.js'].map((f) => read(f)).join('\n');
  const dynamic = [...sources.matchAll(/([a-z][\w-]*-)\$\{/g)].map((m) => m[1]);
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set([...noComments.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]).filter((c) => !/^\d/.test(c)));
  const unused = [...classes].filter((c) => !dynamic.some((pre) => c.startsWith(pre) && c.length > pre.length)).filter((c) => !new RegExp(`(^|[^\\w-])${c.replace(/[-]/g, '\\-')}([^\\w-]|$)`).test(sources));
  S.check('clean: every class in styles.css is used', !unused.length, unused.join(', '));
  const gone = {
    'scorePill (old score pill)': /scorePill|score-pill/, 'showtimeChip / showtime-chip': /showtimeChip|showtime-chip/, flagBadges: /flagBadges/,
    eyebrow: /\beyebrow/, 'chip-btn': /chip-btn/, 'btn ghost': /btn ghost|\.ghost\b/, 'the 320px Book-button rule': /hero-actions \.btn\.book \{ padding/,
    'sparkle icon': /sparkle/, 'round icon buttons': /icon-btn round|\.icon-btn\.round/,
    'the header refresh/help/settings/user chip': /#refresh-btn|refresh-btn|help-btn|settings-btn|user-chip|theatre-name/,
  };
  const all = `${css}\n${sources}`;
  const still = Object.entries(gone).filter(([, re]) => re.test(all)).map(([k]) => k);
  S.check('the helpers and rules the redesign replaced are gone', !still.length, still.join(', '));
  const old = [];
  for (const hex of ['#1C1A18', '#252220', '#2E2B28', '#3F3A35', '#F0A43A', '#F3AE4C', '#FF939C', '#F56B78', '#0b0b0f', '#ffb03a']) {
    for (const f of [...CSS_FILES, 'public/index.html', 'public/manifest.webmanifest', 'public/icons/icon.svg', 'server/lib/invitePage.js']) if (read(f).toLowerCase().includes(hex.toLowerCase())) old.push(`${hex} in ${f}`);
  }
  S.check('no colour of the old Projector palette is left', !old.length, old.join('; '));
  S.check('Zilla Slab and Work Sans are named nowhere', !/Zilla|Work Sans|Work\+Sans/.test(`${all}\n${read('server/lib/invitePage.js')}`));
  S.check('no uppercase text-transform in styles.css', !/text-transform:\s*uppercase/.test(css));
  S.check('no tracked-out (positive letter-spacing) labels in styles.css', !/letter-spacing:\s*0?\.0[2-9]|letter-spacing:\s*0?\.[1-9]/.test(css));
  const legacy = ['--surface', '--surface-2', '--surface-3', '--line)', '--line-strong', '--text-2', '--danger', '--urgent', '--score-hi', '--green', '--red)', '--star-fill', '--selected-bg', '--control', '--shadow-soft', '--low'].filter((t) => css.includes(t));
  S.check('no legacy role token in styles.css', !legacy.length, legacy.join(', '));
});

// ---------------------------------------------------------------- the browser half
const w = S.world(await openWorld('design'));
const F = w.friends;
const ROLES = { owner: 'owner', heavy: F.robin, empty: F.casey, fresh: F.jordan, guest: 'guest' };
await w.api('PUT', '/api/settings', { as: F.robin, body: { watchTogether: true } });
// A saved film so Save shows its gold state.
await w.api('POST', '/api/watchlist/toggle', { body: { tmdb_id: MOVIE } });
const jf = await w.api('POST', '/api/friends', { body: { name: 'Morgan' } });
const joinToken = new URL(jf.json.invite, 'http://x').searchParams.get('invite');
const browser = await launch();
// choice: a Theme switch choice kept on the device ('light' or 'dark').
const page = async (role, { width = 390, theme = 'dark', hash = 'home', guestJoin = false, choice = null, ...o } = {}) => {
  const kept = choice ? { extraCtx: { storageState: { cookies: [], origins: [{ origin: w.base, localStorage: [{ name: 'rp.theme', value: choice }] }] } } } : {};
  const p = await open(browser, w, { role: ROLES[role], width, theme, ...kept, ...o });
  await realSizePosters(p.ctx);
  if (guestJoin) { await p.page.goto(`${w.base}/?invite=${joinToken}`); await p.page.waitForTimeout(500); } else if (hash) await go(p.page, w, hash, 400);
  return p;
};

// ---------------------------------------------------------------- type
const FAMILY = (n) => n.replace(/ (Thin|Regular|SemiBold|Bold|Medium|Light|ExtraBold|Black)$/i, '');
const EXPECT = ['Big Shoulders Display', 'IBM Plex Sans'];
async function typeFonts() {
  const screens = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'stats'], ['heavy', 'stats'], ['owner', 'settings'], ['heavy', 'rate'], ['owner', 'schedule/leaving'], ['owner', 'together'], ['heavy', 'watchlist'], ['owner', 'help'], ['fresh', 'home'], ['guest', 'home'], ['guest', 'JOIN']];
  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1280]) {
      const files = new Set();
      const bad = []; const missing = [];
      for (const [role, hash] of screens) {
        const p = await page(role, { width, theme, hash: null });
        p.page.on('request', (r) => { if (/fonts\.gstatic\.com/.test(r.url())) files.add(r.url().split('/s/')[1]?.split('/')[0]); });
        if (hash === 'JOIN') await p.page.goto(`${w.base}/?invite=${joinToken}`); else await go(p.page, w, hash, 400);
        await p.page.waitForTimeout(600);
        const pf = await platformFonts(p.page);
        for (const [fam, v] of Object.entries(pf)) if (!EXPECT.includes(FAMILY(fam))) bad.push(`${role} ${hash}: ${fam} paints ${v.glyphs} glyphs (${v.samples.slice(0, 2).join(' | ')})`);
        if (hash !== 'JOIN' && !Object.keys(pf).some((f) => FAMILY(f) === EXPECT[0])) missing.push(`${role} ${hash}`);
        S.check(`type ${theme} ${width} ${role} ${hash}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 2).join(' | '));
        await p.ctx.close();
      }
      S.check(`type ${theme} ${width}: only Big Shoulders Display and IBM Plex Sans paint`, !bad.length, bad.slice(0, 4).join(' || '));
      S.check(`type ${theme} ${width}: Big Shoulders Display paints every page title`, !missing.length, missing.join(', '));
      // The font files come from the page's own requests (not the cache).
      const fams = [...files];
      S.check(`type ${theme} ${width}: only the two families' files are downloaded`, fams.every((f) => ['bigshouldersdisplay', 'ibmplexsans'].includes(f)) && fams.includes('ibmplexsans') && fams.includes('bigshouldersdisplay'), fams.join(', '));
    }
  }
}

// Layout shift when the fonts land late (held back 3 s, after the page's own
// data has arrived even on a busy machine), real clock.
async function typeShift() {
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[320, 568], [390, 844], [1280, 800]]) {
      for (const hash of ['home', `movie/${MOVIE}`, 'settings']) {
        const { ctx, page: p } = await open(browser, w, { role: null, width, height, theme, clock: false });
        await realSizePosters(ctx);
        let landed = null;
        await p.route(/fonts\.gstatic\.com/, async (r) => { await new Promise((x) => setTimeout(x, 3000)); landed ??= Date.now(); await r.fallback(); });
        await p.addInitScript(() => {
          window.__shifts = [];
          new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts.push({ t: e.startTime + performance.timeOrigin, v: e.value, src: (e.sources || []).map((s) => s.node && (s.node.className || s.node.nodeName)).slice(0, 3).join(' ') }); }).observe({ type: 'layout-shift', buffered: true });
        });
        await p.goto(`${w.base}/#/${hash}`);
        await p.waitForTimeout(5000);
        await p.evaluate(() => document.fonts.ready);
        await p.waitForTimeout(300);
        const shifts = await p.evaluate(() => window.__shifts);
        await ctx.close();
        const near = shifts.filter((s) => landed && s.t >= landed - 100 && s.t <= landed + 1200);
        const total = near.reduce((a, s) => a + s.v, 0);
        S.check(`type ${theme} ${width} ${hash.split('/')[0]}: font-swap layout shift under 0.01`, landed && total < 0.01, `${total.toFixed(4)} ${near.map((s) => s.src).join('; ')}`);
      }
    }
  }
}

// Every font size a type token; every line height a line-height token (or a
// control's fixed height); measured from what's on screen.
async function typeScale() {
  const SIZES = new Set([12, 13, 15, 17, 22, 30, 40, 46, 64, 72]);
  const RATIOS = [1, 0.98, 1.05, 1.2, 1.25, 1.35, 1.5];
  const PX = new Set([18, 20, 22, 24, 40]);
  const stray = new Map();
  const scenes = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'stats'], ['owner', 'settings'], ['heavy', 'rate'], ['heavy', 'watchlist'], ['owner', 'schedule/leaving'], ['owner', 'schedule/coming'], ['owner', 'together'], ['owner', 'help'], ['fresh', 'home'], ['guest', 'home'], ['owner', `person/${C.PEOPLE.ada.id}`], ['owner', 'movie/980001']];
  for (const width of [320, 390, 1280]) {
    for (const [role, hash] of scenes) {
      const p = await page(role, { width, theme: 'light', hash });
      const { inv } = await p.page.evaluate(extras);
      for (const [k, cls] of Object.entries(inv)) {
        const [fsz, , lh] = k.split('|'); const size = parseFloat(fsz);
        if (cls.every((c) => c === '.poster-fallback-title')) continue; // scales with its poster (container query), by design
        if (!SIZES.has(size)) stray.set(`size ${size}px: ${cls.join(' ')}`, `${role} ${hash}`);
        if (lh === 'normal') { stray.set(`line-height normal at ${size}px: ${cls.join(' ')}`, hash); continue; }
        const l = parseFloat(lh);
        if (!PX.has(Math.round(l)) && !RATIOS.some((r) => Math.abs(l - r * size) < 0.6)) stray.set(`line-height ${l}px at ${size}px: ${cls.join(' ')}`, `${role} ${hash}`);
      }
      await p.ctx.close();
    }
  }
  S.check('type: every font size and line height in use is on the type scale', !stray.size, [...stray].slice(0, 6).map(([k, v]) => `${k} (${v})`).join(' || '));
  // The stars are drawn, not a font glyph (no fallback face paints ★).
  const p = await page('owner', { width: 390, theme: 'light', hash: 'rate' });
  const glyphStars = await p.page.evaluate(() => [...document.querySelectorAll('.stars')].filter((e) => /[★☆]/.test(e.textContent)).length);
  S.check('type: stars are drawn shapes, not ★ glyphs', glyphStars === 0, `${glyphStars} star groups made of glyphs`);
  await p.ctx.close();
}

// The looks the checks below run in: the system's own dark and light, and
// (FORCED) the same two chosen with the Theme switch on a device set the other
// way, which must pass exactly the same checks.
const SYSTEM = [{ theme: 'dark', system: 'dark', choice: null, label: 'dark' }, { theme: 'light', system: 'light', choice: null, label: 'light' }];
const FORCED = [{ theme: 'dark', system: 'light', choice: 'dark', label: 'forced dark' }, { theme: 'light', system: 'dark', choice: 'light', label: 'forced light' }];

// ---------------------------------------------------------------- buttons
function disabledLook(vis) {
  const visible = eval(vis);
  const e = [...document.querySelectorAll('.btn:not(.soft):not(.danger)')].find(visible);
  if (!e) return 'no main button to disable';
  e.style.transition = 'none';
  const before = getComputedStyle(e).backgroundColor;
  e.setAttribute('aria-disabled', 'true');
  const s = getComputedStyle(e);
  const res = { before, after: s.backgroundColor, outline: `${s.outlineStyle} ${s.outlineWidth}`, cursor: s.cursor };
  e.removeAttribute('aria-disabled'); e.style.transition = '';
  return res;
}
async function buttons(modes = SYSTEM) {
  const pages = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'settings'], ['owner', 'stats'], ['heavy', 'rate'], ['heavy', 'watchlist'], ['heavy', 'home'], ['owner', 'help'], ['guest', 'home']];
  for (const { system, choice, label: theme } of modes) {
    for (const width of [390, 1280]) {
      for (const [role, hash] of pages) {
        const p = await page(role, { width, theme: system, choice, hash });
        if (hash === 'home' && role === 'heavy') { await p.page.locator('#wsw-btn').click(); await waitDialog(p.page); await p.page.click('[data-answer="theater"]'); await p.page.waitForTimeout(300); }
        const r = await p.page.evaluate(buttonsProbe, VISIBLE);
        S.check(`buttons ${theme} ${width} ${role} ${hash.split('/')[0]}: one button system`, !r.bad.length && !p.errors.length, [...r.bad, ...p.errors].slice(0, 4).join(' || '));
        if (role === 'owner' && hash === 'home') {
          const dl = await p.page.evaluate(disabledLook, VISIBLE);
          S.check(`buttons ${theme} ${width}: a disabled main button looks disabled`, typeof dl !== 'string' && dl.after !== dl.before && /rgba\(0, 0, 0, 0\)|transparent/.test(dl.after) && /dashed/.test(dl.outline) && dl.cursor === 'not-allowed', JSON.stringify(dl));
        }
        await p.ctx.close();
      }
    }
  }
}

// ---------------------------------------------------------------- boxes
function grouped(vis) {
  const v = eval(vis); const S2 = (e) => getComputedStyle(e);
  const groups = [...document.querySelectorAll('#main .group')].filter(v);
  const bodies = groups.map((g) => g.querySelector(':scope > .group-body')).filter(Boolean);
  let rows = 0; let dividers = 0; const bad = [];
  for (const body of bodies) {
    const s = S2(body);
    if (parseFloat(s.borderTopWidth) > 0) bad.push('a group body has an outline');
    if (/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor)) bad.push('a group body has no fill');
    for (const k of body.querySelectorAll('*')) {
      if (!v(k)) continue;
      const ks = S2(k);
      if (k.parentElement === body) rows++;
      if ((parseFloat(ks.borderTopWidth) === 1 && ks.borderTopStyle === 'solid') || (parseFloat(ks.borderLeftWidth) === 1 && ks.borderLeftStyle === 'solid' && !k.matches('input, .input, select, textarea'))) dividers++;
    }
  }
  return { groups: groups.length, bodies: bodies.length, rows, dividers, bad };
}
async function boxes(modes = SYSTEM) {
  for (const { system, choice, label: theme } of modes) {
    for (const width of [390, 1280]) {
      for (const [role, hash] of [['owner', 'stats'], ['heavy', 'stats'], ['owner', 'settings'], ['heavy', 'settings'], ['owner', 'home'], ['owner', `movie/${MOVIE}`], ['heavy', 'rate'], ['heavy', 'together'], ['owner', 'help'], ['owner', 'schedule/leaving']]) {
        const p = await page(role, { width, theme: system, choice, hash });
        const tag = `boxes ${theme} ${width} ${role} ${hash.split('/').slice(0, 2).join(' ')}`;
        const o = await p.page.evaluate(outlined, VISIBLE);
        S.check(`${tag}: no outlined boxes (only fields have an edge)`, !o.length, o.join(', '));
        if (/stats|settings/.test(hash)) {
          const g = await p.page.evaluate(grouped, VISIBLE);
          const old = await p.page.locator('.settings-card, .stat-card, .cards-2').count();
          S.check(`${tag}: grouped lists with divided rows`, g.groups >= 3 && g.bodies >= g.groups - 1 && g.dividers >= 2 && !g.bad.length && !old, JSON.stringify({ ...g, old }));
        }
        if (hash === 'home' && width === 1280) {
          const hb = await p.page.evaluate(() => { const s = getComputedStyle(document.querySelector('.hero-pick')); return `${s.borderTopWidth} ${s.borderTopStyle}`; });
          S.check(`${tag}: the desktop hero has no border`, /^0px|none/.test(hb), hb);
        }
        await p.ctx.close();
      }
    }
  }
}

// ---------------------------------------------------------------- words
async function words() {
  const scenes = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'schedule/leaving'], ['owner', 'schedule/coming'], ['owner', 'stats'], ['owner', 'settings'], ['owner', 'help'], ['owner', 'watchlist'],
    ['heavy', 'home'], ['heavy', 'rate'], ['heavy', 'together'], ['heavy', 'settings'], ['heavy', 'stats'], ['empty', 'home'], ['fresh', 'home'], ['guest', 'home'], ['guest', `movie/${MOVIE}`], ['guest', 'schedule/leaving'], ['owner', `person/${C.PEOPLE.ada.id}`]];
  for (const width of [390, 1280]) {
    for (const [role, hash] of scenes) {
      const p = await page(role, { width, theme: 'dark', hash });
      const tag = `words ${width} ${role} ${hash.split('/').slice(0, 2).join(' ')}`;
      const b = wordProblems(await p.page.evaluate(wordScan, VISIBLE), { guest: role === 'guest' });
      S.check(`${tag}: plain sentence-case wording`, !b.length && !p.errors.length, [...b, ...p.errors].slice(0, 4).join(' || '));
      if (hash === 'home' && ['owner', 'heavy'].includes(role)) {
        const pg = p.page;
        await pg.locator('#wsw-btn').click(); await waitDialog(pg);
        await pg.click('[data-answer="either"]'); await pg.click('[data-answer="any"]'); await pg.click('[data-answer="surprise"]');
        await pg.waitForSelector('.wsw-film', { timeout: 30000 }).catch(() => {}); await pg.waitForTimeout(400);
        const b2 = wordProblems(await pg.evaluate(wordScan, VISIBLE));
        S.check(`${tag} what should I watch: plain wording`, !b2.length, b2.slice(0, 4).join(' || '));
        await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
        await pg.click('#search-btn'); await pg.fill('.search-input', 'lantern'); await pg.waitForSelector('.sr-row', { timeout: 20000 }).catch(() => {}); await pg.waitForTimeout(400);
        const b3 = wordProblems(await pg.evaluate(wordScan, VISIBLE));
        S.check(`${tag} search: plain wording`, !b3.length, b3.slice(0, 4).join(' || '));
        await pg.keyboard.press('Escape');
        await go(pg, w, 'help', 300); await pg.locator('button', { hasText: 'Replay tour' }).click(); await pg.waitForSelector('.tour-card');
        const tb = [];
        for (let i = 0; i < 20; i++) {
          await pg.waitForTimeout(500);
          tb.push(...wordProblems(await pg.evaluate(wordScan, VISIBLE)).map((x) => `step ${i + 1}: ${x}`));
          const n = pg.locator('.tour-next'); if ((await n.textContent()).trim() === 'Done') { await n.click(); break; } await n.click();
        }
        S.check(`${tag} tour: plain wording on every step`, !tb.length, tb.slice(0, 4).join(' || '));
      }
      await p.ctx.close();
    }
  }
  const pagesBad = [];
  for (const url of [`/?invite=${joinToken}`, '/?invite=nope-not-a-token']) {
    const html = await (await fetch(w.base + url, { headers: { 'cf-ray': 'test' } })).text();
    const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
    if (/—/.test(text) || /\btheatres?\b/i.test(text) || BUZZ.test(text)) pagesBad.push(url.slice(0, 12));
  }
  S.check('words: the Join and expired pages have no em dash, "theatre" or buzzword', !pagesBad.length, pagesBad.join(', '));
  const srcBad = [];
  for (const f of ['server/lib/theatres.js', 'server/lib/runway.js', 'server/lib/leaving.js', ...ROUTE_FILES]) {
    for (const l of read(f).split('\n').filter((x) => !/^\s*(\/\/|\*)/.test(x) && !/console\./.test(x))) {
      for (const s of l.match(/'[^']*'|`[^`]*`|"[^"]*"/g) || []) {
        if (/—/.test(s)) srcBad.push(`${f}: em dash in "${s.slice(0, 60)}"`);
        if (/[A-Z][a-z]+ [^'`"]*\btheatre\b|\btheatre\b [a-z]+ [a-z]/.test(s) && !/theatre[_A-Z(]|\/theatre|theatres\.js/.test(s)) srcBad.push(`${f}: "theatre" in "${s.slice(0, 70)}"`);
      }
    }
  }
  S.check('words: server messages that reach the page say "theater" and use no em dash', !srcBad.length, srcBad.slice(0, 4).join(' || '));
  const readme = read('README.md');
  S.check('words: the README has no em dash or buzzword', !/—/.test(readme) && !BUZZ.test(readme), (readme.match(BUZZ) || readme.match(/.{20}—.{20}/) || [''])[0]);
}

// ---------------------------------------------------------------- clean (rendered)
async function cleanRendered(modes = SYSTEM) {
  const scenes = [
    ['picks', async () => {}],
    ['search', async (p) => { await p.click('#search-btn'); await p.waitForTimeout(500); }],
    ['wsw', async (p) => { await p.click('#wsw-btn'); await p.waitForTimeout(500); }],
    ['toast', async (p) => { await p.evaluate(async () => { const { toast } = await import('/js/ui.js'); toast('Update ready', '', { duration: 0, action: { label: 'Refresh', onClick() {} } }); toast('Saved', 'success', { duration: 0 }); toast('That failed', 'error', { duration: 0 }); }); await p.waitForTimeout(500); }],
    ['tour', async (p) => { await go(p, w, 'help', 300); await p.locator('button:has-text("Replay tour")').click(); await p.waitForSelector('.tour-card'); await p.waitForTimeout(900); }],
    ['stats-sheet', async (p) => { await go(p, w, 'stats', 300); await p.locator('.bar-row').first().click(); await waitDialog(p); await p.waitForTimeout(600); }],
    ['settings', async (p) => { await go(p, w, 'settings', 500); }],
    ['movie', async (p) => { await go(p, w, `movie/${MOVIE}`, 500); }],
    ['person', async (p) => { await go(p, w, `person/${C.PEOPLE.ada.id}`, 500); }],
    ['empty', async (p) => { await go(p, w, 'nowhere', 300); }],
    ['error', async (p) => { await p.route('**/api/stats*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The database is busy. Try again."}' })); await go(p, w, 'stats', 500); }],
    ['skeleton', async (p) => { await p.route('**/api/recommendations*', async (r) => { await new Promise((x) => setTimeout(x, 3000)); r.continue().catch(() => {}); }); await p.goto('about:blank'); await p.goto(`${w.base}/#/home`); await p.waitForSelector('.skeleton'); await p.waitForTimeout(300); }],
    ['join', null], ['expired', null],
  ];
  for (const { system, choice, label: theme } of modes) {
    for (const [name, run] of scenes) {
      const guest = name === 'join' || name === 'expired';
      const p = await page(guest ? 'guest' : 'owner', { width: 390, theme: system, choice, hash: guest ? null : 'home', allow403: false });
      if (name === 'join') { await p.page.goto(`${w.base}/?invite=${joinToken}`); await p.page.waitForTimeout(500); }
      else if (name === 'expired') { await p.page.goto(`${w.base}/?invite=not-a-token-at-all`); await p.page.waitForTimeout(500); }
      else await run(p.page);
      await p.page.evaluate(() => document.fonts.ready);
      const pal = await p.page.evaluate(paletteNow);
      const got = await p.page.evaluate(paintedColours);
      const bad = new Map();
      for (const g of got) if (!inPalette(g.c, pal, pal.slice(0, 5))) bad.set(g.c, `${g.what} ${g.el}`);
      const fams = await p.page.evaluate(() => [...new Set([...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '').trim()))]);
      const odd = fams.filter((f) => !EXPECT.includes(f));
      S.check(`clean ${theme} ${name}: paints only palette colours and the two fonts`, !bad.size && !odd.length, [...[...bad].slice(0, 4).map(([c, x]) => `${c} (${x})`), ...odd].join('; '));
      await p.ctx.close();
    }
  }
}

// ---------------------------------------------------------------- the soft red button's hover
// Not for me, Revoke, Remove: hovered, the label keeps 4.5:1 on whatever the
// button sits on (the page on Picks, a card or a Settings group, the chip fill
// of a What should I watch? film, where the label is 12px at 390). Hover is
// forced through the DevTools protocol, since the phone-sized contexts are
// touch ones. Resting colours stay what they were; light's hover is the 17%
// wash that gives 4.5:1 on the cream page (22% gave 4.16:1), laid over the
// card colour on a What should I watch? film (the chip fill), where the bare
// wash gave 4.13:1.
const DANGER = {
  dark: { rest: ['rgba(255, 123, 114, 0.13)', 'rgb(255, 123, 114)'] },
  light: { rest: ['rgba(168, 38, 26, 0.1)', 'rgb(168, 38, 26)'], hover: ['rgba(168, 38, 26, 0.17)', 'rgb(168, 38, 26)'] },
};
function dangerLook(i) {
  const e = document.querySelector(`[data-dh="${i}"]`);
  const s = getComputedStyle(e);
  const layers = [];
  for (let a = e; a && a.nodeType === 1; a = a.parentElement) {
    const c = getComputedStyle(a).backgroundColor;
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { layers.push(c); if (!/rgba|\/ /.test(c)) break; }
  }
  return { fill: s.backgroundColor, color: s.color, layers, page: getComputedStyle(document.body).backgroundColor, size: s.fontSize, what: `${String(e.className).trim().split(/\s+/).join('.')} "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24)}"` };
}
async function dangerHover(modes = SYSTEM) {
  const same = (a, b) => { const x = parse(a); const y = parse(b); return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) <= 2 && Math.abs(x.a - y.a) < 0.006; };
  const scenes = [
    ['picks', 'owner', 'home', '#main', null],
    ['what should I watch', 'heavy', 'home', '.modal-card', async (pg) => {
      await pg.locator('#wsw-btn').click(); await waitDialog(pg);
      await pg.click('[data-answer="either"]'); await pg.click('[data-answer="any"]'); await pg.click('[data-answer="surprise"]');
      await pg.waitForSelector('.wsw-film .btn.danger', { timeout: 30000 }).catch(() => {}); await pg.waitForTimeout(400);
    }],
    ['settings', 'owner', 'settings', '#main', null],
  ];
  for (const { theme, system, choice, label } of modes) {
    const low = []; const rest = []; const hov = []; const blind = []; let small = 0; let n = 0;
    for (const [scene, role, hash, scope, prep] of scenes) {
      const p = await page(role, { width: 390, theme: system, choice, hash });
      if (prep) await prep(p.page);
      const count = await p.page.evaluate(({ vis, scope }) => {
        const v = eval(vis);
        const els = [...document.querySelectorAll(`${scope} :is(.btn.danger, .icon-btn.danger)`)].filter(v).filter((e) => !e.matches(':disabled, [aria-disabled="true"]'));
        els.forEach((e, i) => e.setAttribute('data-dh', String(i)));
        return els.length;
      }, { vis: VISIBLE, scope });
      if (!count) blind.push(`${scene}: no soft red button on screen`);
      // The wash laid over the card colour (a What should I watch? film in light).
      const onCard = await p.page.evaluate(() => { const t = document.createElement('span'); t.style.backgroundColor = 'color-mix(in srgb, var(--bad) 17%, var(--raised))'; document.body.appendChild(t); const c = getComputedStyle(t).backgroundColor; t.remove(); return c; });
      const cdp = await p.ctx.newCDPSession(p.page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      for (let i = 0; i < count; i++) {
        const before = await p.page.evaluate(dangerLook, i);
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-dh="${i}"]` });
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        await p.page.waitForTimeout(400); // past the 150ms colour transition
        const after = await p.page.evaluate(dangerLook, i);
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        n++;
        if (parseFloat(after.size) <= 12.5) small++;
        const tag = `${scene} ${after.what}`;
        if (!same(before.fill, DANGER[theme].rest[0]) || !same(before.color, DANGER[theme].rest[1])) rest.push(`${tag} rests ${before.fill} / ${before.color}`);
        if (same(after.fill, before.fill)) blind.push(`${tag}: hover changed nothing (${after.fill})`);
        const wantFill = DANGER[theme].hover && (scene === 'what should I watch' ? onCard : DANGER[theme].hover[0]);
        if (DANGER[theme].hover && (!same(after.fill, wantFill) || !same(after.color, DANGER[theme].hover[1]))) hov.push(`${tag} hovers ${after.fill} / ${after.color}`);
        let under = parse(after.page);
        for (const c of after.layers.slice().reverse()) under = over(parse(c), under);
        const r = ratio(parse(after.color), under);
        if (r < 4.5) low.push([r, `${tag} ${after.size} ${r.toFixed(2)}:1`]);
      }
      await p.ctx.close();
    }
    if (!small) blind.push('no 12px soft red button was hovered');
    const worst = (xs) => xs.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    S.check(`buttons ${label} 390: the soft red button's hovered label keeps 4.5:1 on every surface`, n > 0 && !blind.length && !low.length, [...blind, ...worst(low)].slice(0, 4).join(' || '));
    S.check(`buttons ${label} 390: the soft red button's resting colours are unchanged`, n > 0 && !rest.length, rest.slice(0, 3).join(' || '));
    if (DANGER[theme].hover) S.check(`buttons ${label} 390: the soft red button's hover colours are the 4.5:1 ones`, n > 0 && !hov.length, hov.slice(0, 3).join(' || '));
  }
}

// The browser half runs its parts side by side, one browser.
await S.step('browser: type, buttons, boxes, words, rendered colours', async () => {
  // The same checks with each theme chosen on the Theme switch against the system.
  async function buttonsForced() { await buttons(FORCED); }
  async function dangerHoverForced() { await dangerHover(FORCED); }
  async function boxesForced() { await boxes(FORCED); }
  async function cleanRenderedForced() { await cleanRendered(FORCED); }
  const parts = [typeFonts, typeShift, typeScale, buttons, dangerHover, boxes, words, cleanRendered, buttonsForced, dangerHoverForced, boxesForced, cleanRenderedForced];
  const errs = [];
  await Promise.all(Array.from({ length: 4 }, async () => { while (parts.length) { const f = parts.shift(); try { await f(); } catch (e) { errs.push(`${f.name}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } } }));
  for (const e of errs) S.check(`${e.split(':')[0]} ran to the end`, false, e);
});

await browser.close();
await w.close();
S.finish();
