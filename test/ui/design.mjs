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
import { launch, open, go, settle, VISIBLE } from '../lib/browser.mjs';
import { parse, over, ratio, PNG, platformFonts, extras, waitDialog, realSizePosters } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('design');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const css = read('public/styles.css');
const MOVIE = C.PLAYING[0].id;

// ---------------------------------------------------------------- tokens (static)
await S.step('tokens: Midnight marquee dark, Ticket stub light, AA pairs', async () => {
  const block = (re) => { const m = css.match(re); const out = {}; if (m) for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[k] = v.trim(); return out; };
  const light = block(/\/\* ---- palettes ----[\s\S]*?:root \{([\s\S]*?)\n\}/);
  const dark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/);
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
    for (const f of ['public/styles.css', 'public/index.html', 'public/manifest.webmanifest', 'public/icons/icon.svg', 'server/lib/invitePage.js']) if (read(f).toLowerCase().includes(hex.toLowerCase())) old.push(`${hex} in ${f}`);
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
const page = async (role, { width = 390, theme = 'dark', hash = 'home', guestJoin = false, ...o } = {}) => {
  const p = await open(browser, w, { role: ROLES[role], width, theme, ...o });
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

// ---------------------------------------------------------------- buttons
function buttonsProbe(vis) {
  const visible = eval(vis);
  const S2 = (e) => getComputedStyle(e);
  const tok = (n) => { const t = document.createElement('span'); t.style.color = `var(--${n})`; document.body.appendChild(t); const c = S2(t).color; t.remove(); return c; };
  const bg = (n) => { const t = document.createElement('span'); t.style.backgroundColor = `var(--${n})`; document.body.appendChild(t); const c = S2(t).backgroundColor; t.remove(); return c; };
  const T = { accent: bg('accent'), onAccent: tok('on-accent'), soft: bg('accent-soft'), accentText: tok('accent-text'), badSoft: bg('bad-soft'), bad: tok('bad'), gold: tok('gold') };
  const out = { bad: [], n: 0 };
  const d = (e) => `${e.tagName.toLowerCase()}.${String(e.className).trim().split(/\s+/).join('.')} "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24)}"`;
  const radius = (e) => S2(e).borderTopLeftRadius;
  for (const e of [...document.querySelectorAll('.btn, .icon-btn, .chip, .day-btn, .cal-btn, .modal-x')].filter(visible)) {
    out.n++;
    if (radius(e) !== '12px') out.bad.push(`radius ${radius(e)}: ${d(e)}`);
    for (const k of e.querySelectorAll('.tag, .match, .badge')) out.bad.push(`a pill inside a button: ${d(e)} holds ${d(k)}`);
  }
  for (const e of [...document.querySelectorAll('.icon-btn')].filter(visible)) { const r = e.getBoundingClientRect(); if (Math.round(r.width) !== 44 || Math.round(r.height) !== 44) out.bad.push(`icon button ${Math.round(r.width)}x${Math.round(r.height)}: ${d(e)}`); }
  for (const e of [...document.querySelectorAll('button, a.btn, a.icon-btn, .chip')].filter(visible)) if (/50%|9999px|999px/.test(radius(e)) && !e.matches('.seg-item, .nav-item')) out.bad.push(`round control: ${d(e)}`);
  const is = (e, fill, text) => S2(e).backgroundColor === fill && (!text || S2(e).color === text);
  for (const e of [...document.querySelectorAll('.btn.book:not([aria-disabled="true"]), .btn:not(.soft):not(.danger):not(:disabled)')].filter(visible)) if (!is(e, T.accent, T.onAccent)) out.bad.push(`main action not filled accent: ${d(e)} ${S2(e).backgroundColor}`);
  for (const e of [...document.querySelectorAll('.btn.soft:not(.wl-btn.active):not(:disabled), .icon-btn.soft:not(.wl-btn.active)')].filter(visible)) if (!is(e, T.soft, T.accentText)) out.bad.push(`secondary not soft accent: ${d(e)} ${S2(e).backgroundColor} / ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.btn.danger:not(:disabled), .icon-btn.danger:not(:disabled)')].filter(visible)) if (!is(e, T.badSoft, T.bad)) out.bad.push(`remove/hide not soft red: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.not-for-me, [aria-label^="Revoke"], [aria-label^="Stop following"], [aria-label*="from your watch log"], .ri-remove')].filter(visible)) if (!e.matches('.danger')) out.bad.push(`remove/revoke/Not for me isn't a soft red control: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.wl-btn.active')].filter(visible)) if (S2(e).color !== T.gold) out.bad.push(`saved bookmark not gold: ${d(e)} ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.stars-fill')].filter(visible)) if (S2(e).color !== T.gold) out.bad.push(`filled stars not gold: ${S2(e).color}`);
  for (const e of [...document.querySelectorAll('.day-btn')].filter(visible)) {
    const on = e.classList.contains('active');
    if (on && S2(e).backgroundColor !== T.accent) out.bad.push(`chosen day not filled accent: ${d(e)}`);
    if (!on && S2(e).backgroundColor === T.accent) out.bad.push(`an unchosen day is filled: ${d(e)}`);
  }
  for (const e of [...document.querySelectorAll('.chip.active')].filter(visible)) if (S2(e).backgroundColor !== T.accent) out.bad.push(`picked choice not filled accent: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.tag.accent, .tag.watch, .match')].filter(visible)) if (S2(e).backgroundColor !== T.soft) out.bad.push(`positive tag not soft accent: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.tag, .match')].filter(visible)) if ((S2(e).borderTopStyle !== 'none' && parseFloat(S2(e).borderTopWidth) > 0) || /inset/.test(S2(e).boxShadow)) out.bad.push(`outlined tag: ${d(e)}`);
  for (const e of [...document.querySelectorAll('.status-dot, .key-dot')].filter(visible)) {
    if (!(e.parentElement.textContent || '').trim()) out.bad.push(`status dot with no word: ${d(e.parentElement)}`);
    const want = e.matches('.ok, .on') ? tok('good') : e.matches('.bad, .off') ? tok('bad') : e.matches('.warn') ? tok('warn') : null;
    if (want && S2(e).backgroundColor !== want) out.bad.push(`status dot colour ${S2(e).backgroundColor}: ${d(e.parentElement)}`);
  }
  return out;
}
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
async function buttons() {
  const pages = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'settings'], ['owner', 'stats'], ['heavy', 'rate'], ['heavy', 'watchlist'], ['heavy', 'home'], ['owner', 'help'], ['guest', 'home']];
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 1280]) {
      for (const [role, hash] of pages) {
        const p = await page(role, { width, theme, hash });
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
function outlined(vis) {
  const v = eval(vis); const S2 = (e) => getComputedStyle(e); const out = [];
  for (const e of document.querySelectorAll('#main *, .modal-card *')) {
    if (!v(e) || e.matches('input, textarea, select, .input, iframe')) continue;
    const s = S2(e);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(s[`border${k}Color`]));
    if (sides.length === 4) out.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`);
    if (/inset 0px 0px 0px 1px/.test(s.boxShadow)) out.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} (ring)`);
  }
  return [...new Set(out)];
}
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
async function boxes() {
  for (const theme of ['dark', 'light']) {
    for (const width of [390, 1280]) {
      for (const [role, hash] of [['owner', 'stats'], ['heavy', 'stats'], ['owner', 'settings'], ['heavy', 'settings'], ['owner', 'home'], ['owner', `movie/${MOVIE}`], ['heavy', 'rate'], ['heavy', 'together'], ['owner', 'help'], ['owner', 'schedule/leaving']]) {
        const p = await page(role, { width, theme, hash });
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
const BUZZ = /\b(seamless(ly)?|effortless(ly)?|unlock (your|the power)|elevate|curated|delve|leverage|game[- ]changer|supercharge|AI[- ]powered|harness the|revolutioni[sz]e|cutting[- ]edge)\b|✨/i;
function wordScan(vis) {
  const v = eval(vis); const S2 = (e) => getComputedStyle(e);
  const out = { caps: [], reasons: [], seats: [], matches: [], wsw: null };
  for (const e of document.querySelectorAll('body *')) {
    if (!v(e)) continue;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!own) continue;
    const s = S2(e);
    if (s.textTransform === 'uppercase' || (parseFloat(s.letterSpacing) > 0.5 && /[A-Z]{3}/.test(own))) out.caps.push(`${e.className} "${own.slice(0, 30)}"`);
  }
  for (const e of document.querySelectorAll('.reason-line')) if (v(e)) out.reasons.push({ text: e.textContent, scores: [...e.querySelectorAll('.rs-score')].map((x) => ({ t: x.textContent, cls: x.className })) });
  for (const e of document.querySelectorAll('.seat-line > span')) if (v(e)) out.seats.push(e.textContent);
  for (const e of document.querySelectorAll('.match')) if (v(e)) out.matches.push(e.textContent);
  const wsw = document.querySelector('#wsw-btn .icon, .search-wsw .icon');
  if (wsw) out.wsw = wsw.innerHTML;
  out.body = document.body.innerText;
  return out;
}
function wordProblems(r) {
  const bad = [];
  for (const c of r.caps) bad.push(`capitals or tracked label: ${c}`);
  const body = r.body;
  if (/—/.test(body)) bad.push(`an em dash on screen: …${body.slice(Math.max(0, body.indexOf('—') - 40), body.indexOf('—') + 20).replace(/\n/g, ' ')}…`);
  const th = body.match(/[^\n]{0,30}\btheatres?\b[^\n]{0,20}/i);
  if (th) bad.push(`"theatre" on screen: ${th[0]}`);
  const bz = body.match(BUZZ); if (bz) bad.push(`buzzword "${bz[0]}"`);
  if (/Through at least/i.test(body)) bad.push('"Through at least" is still on screen');
  const oldW = body.match(/\bNO\. \d|\bMATCH\b|BACK IN THEATERS|ON WATCHLIST|IMAX available|watchlisted|Be in your seat|be there by/);
  if (oldW) bad.push(`old wording on screen: ${oldW[0]}`);
  for (const m of r.matches) if (!/^\d+% match( ?early)?$|^No match yet$/.test(m.trim())) bad.push(`match reads "${m}"`);
  for (const s of r.seats) if (!/^Seat by \d{1,2}:\d\d [AP]M · out around \d{1,2}:\d\d [AP]M$|^(Seat by|Out around) \d{1,2}:\d\d [AP]M$/.test(s)) bad.push(`seat line "${s}"`);
  for (const x of r.reasons) {
    const t = x.text.trim();
    if (!/^[A-Z#0-9]/.test(t)) bad.push(`reason starts lowercase: "${t}"`);
    if (/\+/.test(t)) bad.push(`reason has a +: "${t}"`);
    if (t.split(' · ').length > 2) bad.push(`more than two reasons: "${t}"`);
    if (/watchlist|IMAX|no public scores/i.test(t)) bad.push(`reason repeats a tag: "${t}"`);
    for (const sc of x.scores) {
      const [src, raw] = sc.t.split(' '); const v = parseFloat(raw);
      const pct = /RT|Metacritic/.test(src); const n = pct ? v : v * 10;
      const want = n >= (pct ? 75 : 70) ? 'good' : n < 60 ? 'bad' : '';
      const got = /\bgood\b/.test(sc.cls) ? 'good' : /\bbad\b/.test(sc.cls) ? 'bad' : '';
      if (want !== got) bad.push(`${sc.t} coloured "${got || 'plain'}", should be "${want || 'plain'}"`);
    }
  }
  if (r.wsw != null && !/M3 8\.5V6\.5/.test(r.wsw)) bad.push('What should I watch? doesn\'t use the ticket icon');
  return bad;
}
async function words() {
  const scenes = [['owner', 'home'], ['owner', `movie/${MOVIE}`], ['owner', 'schedule/leaving'], ['owner', 'schedule/coming'], ['owner', 'stats'], ['owner', 'settings'], ['owner', 'help'], ['owner', 'watchlist'],
    ['heavy', 'home'], ['heavy', 'rate'], ['heavy', 'together'], ['heavy', 'settings'], ['heavy', 'stats'], ['empty', 'home'], ['fresh', 'home'], ['guest', 'home'], ['guest', `movie/${MOVIE}`], ['guest', 'schedule/leaving'], ['owner', `person/${C.PEOPLE.ada.id}`]];
  for (const width of [390, 1280]) {
    for (const [role, hash] of scenes) {
      const p = await page(role, { width, theme: 'dark', hash });
      const tag = `words ${width} ${role} ${hash.split('/').slice(0, 2).join(' ')}`;
      const b = wordProblems(await p.page.evaluate(wordScan, VISIBLE));
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
  for (const f of ['server/lib/theatres.js', 'server/lib/runway.js', 'server/lib/leaving.js', 'server/routes.js']) {
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
function paintedColours() {
  const out = [];
  const add = (c, el, what) => { if (!c || /rgba\(0, 0, 0, 0\)|transparent/.test(c)) return; out.push({ c, what, el: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}` }); };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none') continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) add(s.color, el, 'text');
    if (!el.matches('input[type=checkbox], input[type=radio], input[type=range], input[type=file]')) add(s.backgroundColor, el, 'fill');
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none') add(s.borderTopColor, el, 'border');
  }
  return out;
}
function paletteNow() {
  const names = ['--bg', '--raised', '--chip', '--tabbar', '--divider', '--text', '--muted', '--accent', '--on-accent', '--accent-text', '--accent-soft', '--gold', '--good', '--warn', '--bad', '--bad-soft', '--field-edge', '--focus', '--blue', '--blue-soft', '--purple', '--purple-soft', '--teal', '--teal-soft', '--amber', '--amber-soft'];
  const tmp = document.createElement('span'); document.body.appendChild(tmp);
  const out = names.map((n) => { tmp.style.color = `var(${n})`; return getComputedStyle(tmp).color; });
  tmp.remove(); return out;
}
const rgba = (c) => { const m = c.match(/[\d.]+/g).map(Number); if (/^color\(srgb/.test(c)) return { r: m[0] * 255, g: m[1] * 255, b: m[2] * 255, a: m.length > 3 ? m[3] : 1 }; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
function inPalette(c, pal, surfaces) {
  const x = rgba(c);
  for (const p of pal) {
    const y = rgba(p);
    if (Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) <= 6 && Math.abs(x.a - y.a) < 0.05) return true;
    for (const sfc of surfaces) {
      const z = rgba(sfc);
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const m = { r: z.r + (y.r - z.r) * t, g: z.g + (y.g - z.g) * t, b: z.b + (y.b - z.b) * t };
        if (Math.abs(x.r - m.r) + Math.abs(x.g - m.g) + Math.abs(x.b - m.b) <= 8 && x.a > 0.95) return true;
      }
      if (x.a < 0.95 && Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) <= 8) return true;
    }
  }
  return false;
}
async function cleanRendered() {
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
  for (const theme of ['dark', 'light']) {
    for (const [name, run] of scenes) {
      const guest = name === 'join' || name === 'expired';
      const p = await page(guest ? 'guest' : 'owner', { width: 390, theme, hash: guest ? null : 'home', allow403: false });
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

// The browser half runs its parts side by side, one browser.
await S.step('browser: type, buttons, boxes, words, rendered colours', async () => {
  const parts = [typeFonts, typeShift, typeScale, buttons, boxes, words, cleanRendered];
  const errs = [];
  await Promise.all(Array.from({ length: 4 }, async () => { while (parts.length) { const f = parts.shift(); try { await f(); } catch (e) { errs.push(`${f.name}: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } } }));
  for (const e of errs) S.check(`${e.split(':')[0]} ran to the end`, false, e);
});

await browser.close();
await w.close();
S.finish();
