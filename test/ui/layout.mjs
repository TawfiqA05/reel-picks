// Layout sweep (real-app G17 g-visual, final-polish G2 / decisions R2,
// fixes-3 X4, person search S12): every screen and state, light and dark, at
// 320, 390 and 1280, as the owner, the 700-rating friend, the empty friend,
// the brand-new friend and the guest. Measured in the page (ui-helpers.mjs):
// no sideways scroll, no clipped or spilling text, nothing covered by the
// header, tab bar or Save bar (last item included), header items apart, 44px
// taps on touch, WCAG AA contrast for text, icons and field edges, only the
// active tab highlighted, wrapped lines stepping evenly, no console error or
// failed request. The full scene list runs at 390; 320 and 1280 run the key
// scenes. Findings outside the ALLOW list below fail, one check per scene.
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, watch, settle } from '../lib/browser.mjs';
import { measure, contrastProbe, extras, toBottom, loadImages, waitDialog, textPalette, realSizePosters, ROUTES } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('layout');
const LONG_ID = 980001; // renamed below to a long title for the 320 wrap
const LONG_TITLE = 'The Silent River and the Long Winter of Letters Nobody Ever Sent Home';
// A made-up person who both directs and acts (the catalog's people do one or
// the other), so the person page's Directed / Acted toggle shows. Their TMDB
// answers go straight into this copy's cache, as a first visit would leave them.
const BOTH = { id: 50099, name: 'Noor Haddad' };
const w = S.world(await openWorld('layout', {
  prepare: (d) => {
    d.prepare('UPDATE movies SET title = ? WHERE tmdb_id = ?').run(LONG_TITLE, LONG_ID);
    const put = d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)');
    const at = new Date(C.T0_MS - 60e3).toISOString();
    put.run(`tmdb:person:${BOTH.id}`, JSON.stringify({ id: BOTH.id, name: BOTH.name, known_for_department: 'Directing', profile_path: null, popularity: 30, adult: false }), at, 7 * 86400);
    const credits = {
      id: BOTH.id,
      crew: [C.PLAYING[3], ...C.CLASSICS.slice(0, 3)].map((f) => ({ ...C.light(f), job: 'Director', department: 'Directing', credit_id: `n${f.id}d` })),
      cast: [C.PLAYING[1], ...C.STREAMING.slice(0, 3)].map((f, i) => ({ ...C.light(f), character: `Role ${i + 1}`, order: i, credit_id: `n${f.id}a` })),
    };
    put.run(`tmdb:person:${BOTH.id}:movie_credits`, JSON.stringify(credits), at, 7 * 86400);
  },
}));
const F = w.friends;
// The heavy friend opts in to planning with the owner, so Together has a partner.
await w.api('PUT', '/api/settings', { as: F.robin, body: { watchTogether: true } });
// An unused invite for the Join page.
const jf = await w.api('POST', '/api/friends', { body: { name: 'Morgan' } });
const joinToken = new URL(jf.json.invite, 'http://x').searchParams.get('invite');
const MOVIE = C.PLAYING[0].id;
const ROLES = { owner: 'owner', heavy: F.robin, empty: F.casey, fresh: F.jordan, guest: 'guest' };

// Accepted, each for a reason.
const ALLOW = [
  // The browser logs every 4xx/5xx it receives; these scenes ask for one on purpose.
  (f, sc) => f.kind === 'error' && ['movie-404', 'error', 'join-expired'].includes(sc),
  // The offline scene cuts the network on purpose; the browser logs the failed loads.
  (f, sc) => f.kind === 'error' && sc === 'offline' && /ERR_INTERNET_DISCONNECTED/.test(f.detail),
];

const ALL = ['owner', 'heavy', 'empty', 'fresh', 'guest'];
const MEMBERS = ['owner', 'heavy', 'empty'];
const click = (p, sel) => p.locator(sel).first().click({ timeout: 8000 });
const openHash = async (p, hash) => { await p.goto('about:blank'); await p.goto(`${w.base}/#/${hash}`); await settle(p, 350); };
const typeSearch = async (p, q) => {
  await click(p, '#search-btn'); await waitDialog(p);
  await p.locator('.search-input').fill(q);
  await p.waitForFunction((qq) => { const s = document.querySelector('.search-status')?.textContent || ''; return document.querySelector('.search-input')?.value === qq && /\d+ results?|No matches|\d+ (person|people)/.test(s) && !/Searching/.test(s); }, q, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(400);
};

// key: also run at 320 and 1280.
const SCENES = [
  { name: 'picks', roles: [...MEMBERS, 'guest'], key: true, run: async (p) => { await openHash(p, 'home'); await loadImages(p); } },
  { name: 'picks-bottom', roles: [...MEMBERS, 'guest'], key: true, bottom: true, run: async (p) => { await openHash(p, 'home'); await toBottom(p); } },
  { name: 'picks-filter', roles: ['owner', 'heavy'], run: async (p) => { await openHash(p, 'home'); const f = p.locator('#main .filter-input').first(); await f.scrollIntoViewIfNeeded(); await f.fill('the'); await p.waitForTimeout(400); } },
  { name: 'picks-day2', roles: ['owner', 'heavy'], run: async (p) => { await openHash(p, 'home'); const d = p.locator('.day-btn').nth(1); await d.scrollIntoViewIfNeeded(); await d.click(); await settle(p); } },
  { name: 'wsw-1', roles: MEMBERS, run: async (p) => { await openHash(p, 'home'); await click(p, '#wsw-btn'); await waitDialog(p); } },
  { name: 'wsw-results', roles: MEMBERS, key: true, run: async (p) => {
    await openHash(p, 'home'); await click(p, '#wsw-btn'); await waitDialog(p);
    await click(p, '[data-answer="either"]'); await click(p, '[data-answer="any"]'); await click(p, '[data-answer="surprise"]');
    await p.waitForFunction(() => document.querySelector('.wsw-film, .wsw .muted, .wsw .btn'), null, { timeout: 30000 }); await p.waitForTimeout(700);
  } },
  { name: 'schedule-leaving', roles: [...MEMBERS, 'guest'], key: true, run: async (p) => { await openHash(p, 'schedule/leaving'); await loadImages(p); } },
  { name: 'schedule-leaving-bottom', roles: [...MEMBERS, 'guest'], bottom: true, run: async (p) => { await openHash(p, 'schedule/leaving'); await toBottom(p); } },
  { name: 'schedule-coming', roles: [...MEMBERS, 'guest'], key: true, run: async (p) => { await openHash(p, 'schedule/coming'); await loadImages(p); } },
  { name: 'rate', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'rate'); } },
  { name: 'rate-all-bottom', roles: ['owner', 'heavy'], bottom: true, run: async (p) => { await openHash(p, 'rate'); const b = p.locator('#main .show-all:visible').first(); if (await b.count()) { await b.scrollIntoViewIfNeeded(); await b.click(); await p.waitForTimeout(500); } await toBottom(p); } },
  { name: 'rate-search', roles: ['owner', 'heavy'], run: async (p) => {
    await openHash(p, 'rate'); const i = p.locator('#main input[type="search"], #main input.input').first(); await i.fill('harbor'); await i.press('Enter');
    await p.waitForSelector('.search-row', { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(500);
  } },
  { name: 'watchlist', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'watchlist'); await loadImages(p); } },
  { name: 'together', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'together'); } },
  { name: 'together-person', roles: ['owner', 'heavy'], run: async (p) => { await openHash(p, 'together'); const b = p.locator('.tg-person').first(); if (await b.count()) { await b.click(); await settle(p); } } },
  { name: 'stats', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'stats'); } },
  { name: 'stats-bottom', roles: MEMBERS, bottom: true, run: async (p) => { await openHash(p, 'stats'); for (const b of await p.locator('#main .show-all').all()) { await b.scrollIntoViewIfNeeded(); await b.click(); } await toBottom(p); } },
  { name: 'stats-sheet', roles: ['owner', 'heavy'], key: true, run: async (p) => {
    await openHash(p, 'stats'); await click(p, '.bar-row'); await waitDialog(p);
    await p.waitForFunction(() => document.querySelectorAll('.modal-card .sheet-film, .modal-card .more-film').length > 0, null, { timeout: 20000 }).catch(() => {}); await p.waitForTimeout(500);
  } },
  { name: 'search-empty', roles: MEMBERS, run: async (p) => { await openHash(p, 'home'); await click(p, '#search-btn'); await waitDialog(p); } },
  { name: 'search-results', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'home'); await typeSearch(p, 'the paper lantern'); } },
  // S12: a person row in the search, the person page both ways, a movie page's names.
  { name: 'search-person', roles: ['owner', 'heavy', 'fresh'], key: true, pre: 'setup', run: async (p) => { await openHash(p, 'home'); await typeSearch(p, 'ada lindqvist'); if (!(await p.locator('.sr-person').count())) throw new Error('no person row'); } },
  { name: 'person-directed', roles: ['owner', 'heavy', 'fresh', 'guest'], key: true, pre: 'setup', run: async (p) => { await openHash(p, `person/${BOTH.id}`); const b = p.locator('.person-toggle button', { hasText: 'Directed' }); if (await b.count()) await b.click(); await p.waitForTimeout(200); } },
  { name: 'person-acted', roles: ['owner', 'heavy', 'fresh', 'guest'], key: true, pre: 'setup', run: async (p) => { await openHash(p, `person/${BOTH.id}`); const b = p.locator('.person-toggle button', { hasText: 'Acted' }); if (!(await b.count())) throw new Error('no Directed / Acted toggle'); await b.click(); await p.waitForTimeout(200); } },
  { name: 'movie', roles: [...MEMBERS, 'guest'], key: true, run: async (p) => { await openHash(p, `movie/${MOVIE}`); await loadImages(p); } },
  { name: 'movie-bottom', roles: [...MEMBERS, 'guest'], key: true, bottom: true, run: async (p) => { await openHash(p, `movie/${MOVIE}`); await toBottom(p); } },
  { name: 'movie-names', roles: ['owner', 'fresh', 'guest'], pre: 'setup', run: async (p) => { await openHash(p, `movie/${MOVIE}`); await p.locator('.about').scrollIntoViewIfNeeded(); await p.waitForTimeout(200); if ((await p.locator('.about .person-link').count()) < 3) throw new Error('fewer than 3 name links'); } },
  { name: 'movie-long', roles: ['owner', 'heavy'], key: true, run: async (p) => { await openHash(p, `movie/${LONG_ID}`); await loadImages(p); } },
  { name: 'trailer', roles: ['owner', 'heavy'], run: async (p) => { await openHash(p, `movie/${MOVIE}`); const t = p.locator('.detail-actions .btn', { hasText: 'Trailer' }); if (!(await t.count())) throw new Error('no trailer button'); await t.click(); await waitDialog(p); } },
  { name: 'movie-showtimes', roles: ['owner', 'heavy', 'guest'], run: async (p) => { await openHash(p, `movie/${MOVIE}`); await p.evaluate(() => { const el = document.querySelector('#showtimes'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 80); }); await p.waitForTimeout(300); } },
  { name: 'settings', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'settings'); } },
  { name: 'settings-bottom', roles: MEMBERS, bottom: true, run: async (p) => { await openHash(p, 'settings'); await toBottom(p); } },
  { name: 'settings-dirty-bottom', roles: ['owner', 'heavy'], key: true, bottom: true, run: async (p) => {
    await openHash(p, 'settings'); const box = p.locator('label.switch-row:has-text("Prefer IMAX") input').first(); await box.scrollIntoViewIfNeeded(); await box.click(); await p.waitForTimeout(500); await toBottom(p);
  } },
  { name: 'you', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'you'); } },
  { name: 'help', roles: MEMBERS, key: true, run: async (p) => { await openHash(p, 'help'); } },
  { name: 'help-bottom', roles: ['owner'], bottom: true, run: async (p) => { await openHash(p, 'help'); await toBottom(p); } },
  { name: 'picks-pull', roles: ['owner'], run: async (p) => { await openHash(p, 'home'); await p.evaluate(() => { const m = document.querySelector('.pull'); if (m) { m.classList.add('show', 'busy'); m.style.opacity = '1'; } }); await p.waitForTimeout(300); } },
  { name: 'update-toast', roles: ['owner', 'heavy'], run: async (p) => {
    await openHash(p, 'home'); await p.evaluate(async () => { const { toast } = await import('/js/ui.js'); toast('Update ready', '', { duration: 0, action: { label: 'Refresh', onClick: () => {} } }); }); await p.waitForTimeout(500);
  } },
  { name: 'settings-toast', roles: ['owner'], run: async (p) => {
    await openHash(p, 'settings'); await p.evaluate(async () => { const { toast } = await import('/js/ui.js'); toast('Update ready', '', { duration: 0, action: { label: 'Refresh', onClick: () => {} } }); toast('Saved', 'success', { duration: 0 }); }); await p.waitForTimeout(500);
  } },
  { name: 'services-sheet', roles: ['empty'], run: async (p) => { await openHash(p, 'home'); const b = p.locator('.home-setup .btn').first(); await b.scrollIntoViewIfNeeded(); await b.click(); await waitDialog(p); } },
  { name: 'notfound', roles: ALL, run: async (p) => { await openHash(p, 'nowhere-at-all'); } },
  { name: 'movie-404', roles: ['owner'], run: async (p) => { await openHash(p, 'movie/999999999'); } },
  { name: 'offline', roles: ['owner', 'guest'], run: async (p, ctx) => { await openHash(p, 'home'); await ctx.setOffline(true); await p.evaluate(() => { location.hash = '#/schedule/coming'; }); await p.waitForTimeout(1500); } },
  { name: 'loading', roles: ['owner'], run: async (p) => {
    await p.route('**/api/recommendations*', async (r) => { await new Promise((x) => setTimeout(x, 3000)); r.continue().catch(() => {}); });
    await p.goto('about:blank'); await p.goto(`${w.base}/#/home`); await p.waitForSelector('.skeleton', { timeout: 8000 }); await p.waitForTimeout(400);
  } },
  { name: 'error', roles: ['owner'], run: async (p) => {
    await p.route('**/api/stats*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The database is locked. Try again in a minute."}' }));
    await openHash(p, 'stats');
  } },
  { name: 'welcome-1', roles: ['fresh'], key: true, run: async (p) => { await openHash(p, 'home'); await p.waitForSelector('.welcome', { timeout: 10000 }); } },
  { name: 'welcome-2', roles: ['fresh'], run: async (p) => { await openHash(p, 'home'); await p.waitForSelector('.welcome'); await click(p, '.wc-foot .btn:has-text("Next")'); await p.waitForTimeout(500); } },
  { name: 'welcome-3', roles: ['fresh'], run: async (p) => { await openHash(p, 'home'); await p.waitForSelector('.welcome'); await click(p, '.wc-foot .btn:has-text("Next")'); await p.waitForTimeout(400); await click(p, '.wc-foot .btn:has-text("Next"), .wc-foot .link-btn:has-text("Skip")'); await p.waitForTimeout(500); } },
  { name: 'join', roles: ['guest'], key: true, run: async (p) => { await p.goto('about:blank'); await p.goto(`${w.base}/?invite=${joinToken}`); await p.waitForTimeout(500); } },
  { name: 'join-expired', roles: ['guest'], run: async (p) => { await p.goto('about:blank'); const r = await p.goto(`${w.base}/?invite=not-a-real-token-at-all`); if (r.status() !== 410) throw new Error(`expired page status ${r.status()}`); await p.waitForTimeout(300); } },
];
// The guided tour: every step measured in one walk (owner, 390 light only).
SCENES.push({ name: 'tour', roles: ['owner'], tour: true, steps: true, run: async (p) => {
  await openHash(p, 'help'); await click(p, 'button:has-text("Replay tour")'); await p.waitForSelector('.tour-card', { timeout: 8000 });
} });

// The fresh friend is in the welcome setup; the person-search scenes run as
// someone past it, so they finish it on a copy of the flags first.
async function passSetup(role) { if (role === 'fresh') await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: true, tourDone: true, youNoteSeen: true } }); }
async function backToSetup(role) { if (role === 'fresh') await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: false, tourDone: false, youNoteSeen: false } }); }

async function measureAll(page, phone, atBottom) {
  const palette = await textPalette(page);
  const findings = await page.evaluate(measure, { phone, atBottom: Boolean(atBottom), palette, routes: ROUTES });
  findings.push(...(await page.evaluate(extras)).out);
  findings.push(...(await page.evaluate(contrastProbe)).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  return findings;
}

const browser = await launch();
let runs = 0;
async function combo(role, theme, width) {
  const { ctx } = await open(browser, w, { role: ROLES[role], width, theme });
  await realSizePosters(ctx);
  const phone = width <= 1024;
  // At 1280 there is no tab bar to hide the end of a page, so only the Save
  // bar's bottom scene runs there.
  const list = SCENES.filter((s) => s.roles.includes(role) && (width === 390 || s.key) && (!s.tour || (width === 390 && theme === 'light'))
    && !(width === 1280 && s.bottom && s.name !== 'settings-dirty-bottom'));
  // Setup-bound scenes last for the fresh friend, so its setup flags flip once.
  list.sort((a, b) => Number(Boolean(a.pre)) - Number(Boolean(b.pre)));
  let passed = false;
  for (const sc of list) {
    if (sc.pre && !passed) { await passSetup(role); passed = true; }
    const page = await ctx.newPage();
    const errors = [];
    watch(page, w, `${role} ${width} ${theme}`, errors);
    const record = (name, findings) => {
      const all = [...findings, ...errors.splice(0).map((e) => ({ kind: 'error', sel: '', detail: e }))];
      const bad = all.filter((f) => !ALLOW.some((a) => a(f, sc.name)));
      runs++;
      S.check(`${role} ${theme} ${width} ${name}: no layout, contrast, tap or error findings`, !bad.length, bad.slice(0, 4).map((f) => `${f.kind} ${f.sel} ${f.detail}`).join(' || '));
    };
    try {
      await sc.run(page, ctx);
      if (!sc.steps) record(sc.name, await measureAll(page, phone, sc.bottom));
      else {
        for (let i = 1; i <= 20; i++) {
          await page.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(250);
          record(`tour step ${i}`, await measureAll(page, phone, false));
          const next = page.locator('.tour-next');
          if ((await next.textContent()).trim() === 'Done') break;
          await next.click();
        }
      }
    } catch (e) {
      record(sc.name, [{ kind: 'scene-error', sel: sc.name, detail: e.message.split('\n')[0].slice(0, 200) }]);
    }
    await page.close();
    await ctx.setOffline(false);
  }
  if (passed) await backToSetup(role);
  await ctx.close();
}

// Each role and theme in parallel (five at a time); the brand-new friend's
// two themes in turn, since its setup flags flip on the server.
await S.step('sweep every screen', async () => {
  const tasks = [];
  for (const role of Object.keys(ROLES)) {
    const themes = role === 'fresh' ? [['light', 'dark']] : [['light'], ['dark']];
    for (const ts of themes) tasks.push(async () => { for (const theme of ts) for (const width of [390, 320, 1280]) await combo(role, theme, width); });
  }
  await Promise.all(Array.from({ length: 5 }, async () => { while (tasks.length) await tasks.shift()(); }));
});
S.check('the sweep measured enough scene runs', runs >= 300, String(runs));

await browser.close();
await w.close();
S.finish();
