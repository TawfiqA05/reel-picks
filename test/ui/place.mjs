// Keeping my place (public/js/place.js, keep.js, search.js):
//
//   search    opening a film, a person or a recent from the header search and
//             coming back (the Back button, the browser's back, the back
//             gesture in the installed app, Chromium and WebKit) reopens it
//             with the same text, results and scroll; film to person and
//             back, and the trailer, still end on it; clearing the box, the
//             close button, Escape, a tap outside and 30 minutes end it; the
//             guest has no search
//   back      the Back button (44px, named "Back") on a film or person page
//             goes where the back gesture goes, and to Picks, never out of
//             the app, when nothing came before
//   lists     Picks, Schedule, Watchlist, Rate, Stats, You and a person page
//             come back to the same scroll (within a few pixels), filter text,
//             day and open sections by each back method, in the browser and
//             the installed app; a tab tapped starts at the top, and tapping
//             the tab you're on scrolls it to the top
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, settle } from '../lib/browser.mjs';
import { waitDialog } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('place');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const now = new Date(C.T0_MS).toISOString();
const w = S.world(await openWorld('place', {
  prepare: (d) => {
    d.exec("UPDATE movies SET trailer_key = 'rp-trailer' WHERE trailer_key IS NULL OR trailer_key = ''");
    // A watchlist long enough to scroll, with plenty of "The …" titles.
    const wl = d.prepare('INSERT OR IGNORE INTO watchlist(user_id, tmdb_id, added_at) VALUES(1, ?, ?)');
    for (const f of [...C.RATED, ...C.PLAYING]) wl.run(f.id, now);
  },
}));
const F = w.friends;
await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: true, tourDone: true, youNoteSeen: true } });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const browser = await launch();
const webkit = await launch('webkit');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

async function page(role, width, theme, { standalone = false, engine = browser } = {}) {
  const extra = standalone ? { extraCtx: { isMobile: engine === browser, userAgent: IPHONE_UA } } : {};
  const p = await open(engine, w, { role, width, theme, ...(standalone ? { touch: true } : {}), ...extra });
  if (standalone) {
    await p.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
    });
  }
  return p;
}

// The three ways back: the Back button on the page, the browser's back, and
// the installed app's edge swipe (which is the history's back).
async function goBack(pg, how) {
  if (how === 'button') await pg.locator('#back-btn').click();
  else if (how === 'browser') await pg.goBack();
  else await pg.evaluate(() => history.back());
}
const METHODS = [['button', {}], ['browser', {}], ['gesture', { standalone: true }], ['gesture-webkit', { standalone: true, engine: webkit }]];

// ------------------------------------------------------------------ search
const sheet = (pg) => pg.evaluate(() => {
  const o = document.querySelector('.search-overlay.show');
  if (!o) return { open: false };
  const b = o.querySelector('.search-body');
  return {
    open: true, q: o.querySelector('.search-input').value,
    ids: [...b.querySelectorAll('[role="option"]')].map((e) => e.getAttribute('href') || e.textContent.trim()),
    scroll: b.scrollTop, status: o.querySelector('.search-status').textContent,
  };
});
const waitSheet = (pg) => pg.waitForSelector('.search-overlay.show .search-body', { timeout: 8000 }).then(() => pg.waitForTimeout(400)).then(() => true).catch(() => false);
async function openSearch(pg) {
  await pg.locator('#search-btn').click();
  await waitSheet(pg);
}
async function searchFor(pg, q, min = 6) {
  await openSearch(pg);
  await pg.locator('.search-input').fill(q);
  await pg.waitForFunction((n) => document.querySelectorAll('.search-body .sr-row').length >= n, min, { timeout: 10000 });
  await pg.waitForTimeout(300);
}
// Scrolls the results, then opens the first film row fully in view (or the
// one given).
async function scrollAndOpen(pg, y = 240, want = null) {
  await pg.locator('.search-body').evaluate((b, v) => { b.scrollTop = v; }, y);
  await pg.waitForTimeout(250);
  const href = want || await pg.evaluate(() => {
    const b = document.querySelector('.search-body').getBoundingClientRect();
    const row = [...document.querySelectorAll('.search-body .sr-row, .search-body .recent-main[href]')].find((r) => { const x = r.getBoundingClientRect(); return x.top >= b.top && x.bottom <= b.bottom; });
    return row?.getAttribute('href');
  });
  const before = await sheet(pg);
  await pg.locator(`.search-body [href="${href}"]`).first().click();
  await pg.waitForFunction((h) => location.hash === h, href, { timeout: 10000 });
  await settle(pg, 300);
  return { before, href };
}
const sameSheet = (a, b) => b.open && a.q === b.q && JSON.stringify(a.ids) === JSON.stringify(b.ids) && Math.abs(a.scroll - b.scroll) <= 4 && a.ids.length > 0;
const desc = (s) => JSON.stringify({ ...s, ids: s.ids?.length });

for (const [how, opts] of METHODS) {
  await S.step(`search: back by ${how} (390)`, async () => {
    const p = await page('owner', 390, 'dark', opts);
    try {
      await go(p.page, w, '#/home', 400);
      await searchFor(p.page, 'the');
      const { before } = await scrollAndOpen(p.page);
      S.check(`search ${how}: opening a film closes the sheet`, !(await sheet(p.page)).open);
      S.check(`search ${how}: the film page has the Back button`, await p.page.locator('#back-btn').isVisible());
      await goBack(p.page, how);
      const back = await waitSheet(p.page) && await sheet(p.page);
      S.check(`search ${how}: back on Picks, the search is open with the same text, results and scroll`, back && sameSheet(before, back) && await p.page.evaluate(() => location.hash) === '#/home', `${desc(before)} -> ${desc(back)}`);
      await shot(p.page, `search-back-${how}-owner-390-dark`);
      S.check(`search ${how}: no console errors or failed requests`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
    } finally { await p.ctx.close(); }
  });
}

await S.step('search: film, person, trailer, and a recent', async () => {
  const p = await page('owner', 390, 'light');
  try {
    await go(p.page, w, '#/rate', 400);
    // A film playing now, which has a trailer.
    const film = C.PLAYING[0];
    await searchFor(p.page, film.title, 1);
    const { before } = await scrollAndOpen(p.page, 0, `#/movie/${film.id}`);
    // To a person from the film, then back twice.
    const person = p.page.locator('.person-link[href^="#/person/"]').first();
    await person.scrollIntoViewIfNeeded();
    await person.click();
    await p.page.waitForFunction(() => location.hash.startsWith('#/person/'), null, { timeout: 10000 });
    await settle(p.page, 300);
    S.check('trip: the person page has the Back button', await p.page.locator('#back-btn').isVisible());
    S.check('trip: on the person page the search stays shut', !(await sheet(p.page)).open);
    await p.page.locator('#back-btn').click();
    await settle(p.page, 300);
    S.check('trip: Back from the person goes to the film', /^#\/movie\//.test(await p.page.evaluate(() => location.hash)) && !(await sheet(p.page)).open);
    // The trailer on the way.
    await p.page.locator('.detail-actions button', { hasText: 'Trailer' }).click();
    await p.page.waitForSelector('.trailer-overlay.show iframe', { timeout: 8000 });
    await p.page.locator('.trailer-overlay .modal-x').click();
    await p.page.waitForTimeout(300);
    await p.page.locator('#back-btn').click();
    const back = await waitSheet(p.page) && await sheet(p.page);
    S.check('trip: film, person, trailer, then back twice ends on the search, as it was', back && sameSheet(before, back) && await p.page.evaluate(() => location.hash) === '#/rate', `${desc(before)} -> ${desc(back)}`);
    // A recent: the box empty, a recently viewed film opened.
    await p.page.locator('.search-clear').click();
    await p.page.waitForSelector('.search-body .recent-main[href]', { timeout: 8000 });
    const rec = await scrollAndOpen(p.page, 0);
    await p.page.locator('#back-btn').click();
    const r2 = await waitSheet(p.page) && await sheet(p.page);
    S.check('recent: back from a recent reopens the search with the empty box and the same recents', r2 && r2.q === '' && JSON.stringify(r2.ids) === JSON.stringify(rec.before.ids) && r2.ids.length > 0, `${desc(rec.before)} -> ${desc(r2)}`);
    S.check('recent: no console errors', !p.errors.length, p.errors.slice(0, 3).join(' || '));
  } finally { await p.ctx.close(); }
});

await S.step('search: clearing, the close button, Escape, a tap outside and 30 minutes end it', async () => {
  const kept = (pg) => pg.evaluate(() => localStorage.getItem('rp-search:1'));
  const endedBy = async (pg, what, end) => {
    await searchFor(pg, 'comet', 1);
    await scrollAndOpen(pg, 0);
    await pg.locator('#back-btn').click();
    S.check(`end ${what}: first it comes back`, await waitSheet(pg));
    await end();
    await pg.waitForTimeout(300);
    S.check(`end ${what}: then nothing is kept`, !(await kept(pg)), await kept(pg));
    // A film opened another way, and back: no sheet.
    if (await pg.locator('.search-overlay.show').count()) await pg.keyboard.press('Escape');
    await pg.waitForTimeout(300);
    await go(pg, w, `#/movie/${C.RATED[0].id}`, 300);
    await pg.locator('#back-btn').click();
    await settle(pg, 500);
    S.check(`end ${what}: coming back later opens no search`, !(await sheet(pg)).open);
  };
  const p = await page('owner', 1280, 'light');
  try {
    await go(p.page, w, '#/home', 400);
    await endedBy(p.page, 'clear', () => p.page.locator('.search-clear').click());
    await endedBy(p.page, 'close button', () => p.page.locator('.search-overlay .modal-x').click());
    await endedBy(p.page, 'Escape', () => p.page.keyboard.press('Escape'));
    await endedBy(p.page, 'tap outside', () => p.page.mouse.click(10, 790));
    // 30 minutes.
    await searchFor(p.page, 'comet', 1);
    const { before } = await scrollAndOpen(p.page, 0);
    await p.ctx.clock.fastForward('29:00');
    await p.page.locator('#back-btn').click();
    const b29 = await waitSheet(p.page) && await sheet(p.page);
    S.check('end 30 min: 29 minutes later it is still kept', b29 && sameSheet(before, b29), desc(b29));
    await scrollAndOpen(p.page, 0);
    await p.ctx.clock.fastForward('31:00');
    await p.page.locator('#back-btn').click();
    await settle(p.page, 600);
    S.check('end 30 min: 31 minutes later it has ended', !(await sheet(p.page)).open);
    S.check('end: no console errors', !p.errors.length, p.errors.slice(0, 3).join(' || '));
  } finally { await p.ctx.close(); }
});

await S.step('search: per person, and the guest has none', async () => {
  const p = await page(F.robin, 390, 'light');
  try {
    await go(p.page, w, '#/home', 400);
    await searchFor(p.page, 'the');
    await scrollAndOpen(p.page, 0);
    const keys = await p.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rp-search:')));
    S.check('person: kept under Robin\'s id', JSON.stringify(keys) === JSON.stringify([`rp-search:${F.robin.id}`]), JSON.stringify(keys));
  } finally { await p.ctx.close(); }
  const g = await page('guest', 390, 'light');
  try {
    await go(g.page, w, `#/movie/${C.PLAYING[0].id}`, 400);
    S.check('guest: no search button', !(await g.page.locator('#search-btn').isVisible()));
    await g.page.keyboard.press('/');
    await g.page.waitForTimeout(300);
    S.check('guest: "/" opens nothing', !(await sheet(g.page)).open);
    S.check('guest: the Back button is there on a film page', await g.page.locator('#back-btn').isVisible());
    S.check('guest: nothing kept', await g.page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('rp-search:'))));
  } finally { await g.ctx.close(); }
});

// ------------------------------------------------------------------ back
await S.step('back: the button, and nothing to go back to', async () => {
  for (const hash of [`#/movie/${C.PLAYING[1].id}`, `#/person/${C.PEOPLE.ada.id}`]) {
    for (const standalone of [false, true]) {
      const tag = `${hash.split('/')[1]} ${standalone ? 'installed' : 'browser'}`;
      const p = await page('owner', 390, 'light', { standalone });
      try {
        await p.page.goto(`${w.base}/${hash}`);
        await settle(p.page, 400);
        const btn = p.page.locator('#back-btn');
        const box = await btn.boundingBox();
        S.check(`back ${tag}: a Back button at the top left, 44px, named Back`, await btn.isVisible() && box.x < 60 && box.y < 80 && Math.round(box.width) >= 44 && Math.round(box.height) >= 44 && (await btn.getAttribute('aria-label')) === 'Back', JSON.stringify(box));
        const len = await p.page.evaluate(() => history.length);
        await btn.click();
        await settle(p.page, 400);
        S.check(`back ${tag}: with nothing before it, Back lands on Picks in the app`, p.page.url() === `${w.base}/#/home` && await p.page.locator('.hero-pick, .pick-card').count() > 0 && await p.page.evaluate(() => history.length) === len, p.page.url());
        S.check(`back ${tag}: Picks has no Back button`, !(await btn.isVisible()));
        await shot(p.page, `back-fresh-${tag.replace(' ', '-')}`);
        S.check(`back ${tag}: no console errors`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
      } finally { await p.ctx.close(); }
    }
  }
  const p = await page('owner', 390, 'dark');
  try {
    await go(p.page, w, '#/watchlist', 400);
    for (const hash of ['#/home', '#/schedule/leaving', '#/rate', '#/watchlist', '#/stats', '#/settings']) {
      await go(p.page, w, hash, 200);
      S.check(`back: no Back button on ${hash}`, !(await p.page.locator('#back-btn').isVisible()));
    }
    await p.page.locator('#bottom-nav .nav-item[data-name="rate"]').click();
    await settle(p.page, 300);
    await p.page.locator('#rating-list .ri-title').first().click();
    await settle(p.page, 300);
    await p.page.locator('#back-btn').focus();
    S.check('back: the Back button is a real button in the tab order', await p.page.evaluate(() => { const b = document.activeElement; return b?.id === 'back-btn' && b.tagName === 'BUTTON' && b.tabIndex === 0; }));
    await p.page.keyboard.press('Enter');
    await settle(p.page, 300);
    S.check('back: Enter on Back goes back to Rate', await p.page.evaluate(() => location.hash) === '#/rate');
    await shot(p.page, 'back-button-dark-390');
  } finally { await p.ctx.close(); }
});

// ------------------------------------------------------------------ lists
const scrollState = (pg) => pg.evaluate(() => ({
  y: Math.round(scrollY),
  filters: [...document.querySelectorAll('#main .filter-input')].map((i) => i.value),
  day: document.querySelector('.day-btn.active')?.dataset.date || null,
  open: [...document.querySelectorAll('#main .show-all[aria-expanded], #main .section-toggle[aria-expanded]')].map((b) => b.getAttribute('aria-expanded')),
  kind: document.querySelector('.person-toggle .segment.active')?.textContent || null,
}));
// A film link fully on screen, below the header.
const filmInView = (pg) => pg.evaluate(() => {
  const top = document.querySelector('.app-header').getBoundingClientRect().bottom;
  const bottom = (document.querySelector('#bottom-nav')?.getBoundingClientRect().top) || innerHeight;
  const a = [...document.querySelectorAll('#main a[href^="#/movie/"]')].find((x) => { const r = x.getBoundingClientRect(); return r.width && r.top >= top + 4 && r.bottom <= Math.min(bottom, innerHeight) - 4 && !x.closest('[hidden]') && getComputedStyle(x).visibility !== 'hidden'; });
  if (!a) return null;
  a.setAttribute('data-test-open', '1');
  return a.getAttribute('href');
});
async function scrollTo(pg, frac) {
  await pg.evaluate((f) => { const max = document.documentElement.scrollHeight - innerHeight; window.scrollTo(0, Math.round(Math.min(max * f, 4000))); }, frac);
  await pg.waitForTimeout(350);
}

const PAGES = [
  { name: 'Picks', hash: '#/home', tab: 'home', role: 'owner', set: async (pg) => {
    await pg.locator('.day-picker .day-btn').nth(3).click();
    await pg.locator('.filter-input[aria-label="Filter everything playing"]').fill('a');
    await pg.waitForTimeout(200);
  } },
  // Leaving is wider than the screen at 390 on main already (a showtime row
  // with Fits and Book, test/known-bugs.json), which also pushes the tab bar
  // aside: its sideways check is left to that bug, and its tab is tapped in
  // script.
  { name: 'Schedule', hash: '#/schedule/leaving', tab: 'schedule', role: 'owner', set: null, wide: true },
  { name: 'Watchlist', hash: '#/watchlist', tab: 'watchlist', role: 'owner', set: async (pg) => { await pg.locator('.filter-input').fill('e'); await pg.waitForTimeout(200); } },
  { name: 'Rate', hash: '#/rate', tab: 'rate', role: 'robin', set: async (pg) => {
    await pg.waitForSelector('#rating-list .rating-item', { timeout: 10000 });
    await pg.locator('.show-all').click();
    await pg.locator('.filter-input[aria-label="Filter your ratings"]').fill('r');
    await pg.waitForTimeout(300);
  } },
  { name: 'Stats', hash: '#/stats', tab: 'you', role: 'robin', set: null, open: async (pg) => {
    // A row on screen, so nothing scrolls to reach it.
    await pg.evaluate(() => { const top = document.querySelector('.app-header').getBoundingClientRect().bottom; const r = [...document.querySelectorAll('.bar-row')].find((b) => { const x = b.getBoundingClientRect(); return x.top > top + 4 && x.bottom < innerHeight - 70; }); r?.setAttribute('data-test-row', '1'); });
    await pg.locator('[data-test-row="1"]').click();
    await waitDialog(pg);
    await pg.locator('.sheet-rated a[href^="#/movie/"]').first().click();
  } },
  { name: 'You (Settings)', hash: '#/settings', tab: 'you', role: 'owner', set: null, open: async (pg) => {
    await pg.evaluate(() => { location.hash = `#/movie/${document.querySelector('#main a[href^="#/movie/"]')?.getAttribute('href')?.split('/')[2] || '980001'}`; });
  } },
  { name: 'Person', hash: `#/person/${C.PEOPLE.ada.id}`, tab: null, role: 'robin', set: null },
];

for (const pg of PAGES) {
  for (const [how, opts] of METHODS) {
    if (how === 'gesture-webkit' && !['Picks', 'Rate', 'Watchlist'].includes(pg.name)) continue;
    await S.step(`lists: ${pg.name}, back by ${how}`, async () => {
      const as = pg.role === 'owner' ? 'owner' : F[pg.role];
      const p = await page(as, 390, how.includes('webkit') ? 'dark' : 'light', opts);
      const tag = `${pg.name} ${how}`;
      try {
        await go(p.page, w, pg.hash, 500);
        if (pg.set) await pg.set(p.page);
        await scrollTo(p.page, 0.7);
        const before = await scrollState(p.page);
        S.check(`${tag}: the page scrolls far`, before.y > 300, JSON.stringify(before));
        if (pg.open) await pg.open(p.page);
        else {
          const href = await filmInView(p.page);
          if (!href) throw new Error('no film link on screen');
          await p.page.locator('[data-test-open="1"]').click();
        }
        await p.page.waitForFunction(() => location.hash.startsWith('#/movie/') && document.querySelector('.detail'), null, { timeout: 15000 });
        await settle(p.page, 300);
        S.check(`${tag}: the film page starts at the top`, await p.page.evaluate(() => scrollY) === 0);
        await goBack(p.page, how.replace('-webkit', ''));
        await settle(p.page, 400);
        await p.page.waitForFunction((y) => Math.abs(scrollY - y) <= 4, before.y, { timeout: 5000 }).catch(() => {});
        const after = await scrollState(p.page);
        S.check(`${tag}: back on the same page`, await p.page.evaluate(() => location.hash) === pg.hash);
        S.check(`${tag}: the same scroll within a few pixels`, Math.abs(after.y - before.y) <= 4, `${before.y} -> ${after.y}`);
        S.check(`${tag}: the same filter text, day and open sections`, JSON.stringify({ ...after, y: 0 }) === JSON.stringify({ ...before, y: 0 }), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        if (how === 'button') await shot(p.page, `lists-back-${pg.name.split(' ')[0].toLowerCase()}-390`);
        if (pg.tab && how === 'button') {
          // A tab tapped on another page starts at the top, fresh.
          const href = await filmInView(p.page);
          if (href) await p.page.locator('[data-test-open="1"]').click(); else await go(p.page, w, `#/movie/${C.RATED[0].id}`, 200);
          await settle(p.page, 300);
          const tapTab = () => (pg.wide ? p.page.locator(`#bottom-nav .nav-item[data-name="${pg.tab}"]`).evaluate((el) => el.click()) : p.page.locator(`#bottom-nav .nav-item[data-name="${pg.tab}"]`).click());
          await tapTab();
          await settle(p.page, 400);
          const fresh = await scrollState(p.page);
          S.check(`${tag}: tapping its tab from a film starts at the top with nothing typed`, fresh.y === 0 && fresh.filters.every((f) => f === ''), JSON.stringify(fresh));
          // The tab you're on, tapped: to the top.
          await scrollTo(p.page, 0.5);
          await tapTab();
          await p.page.waitForFunction(() => scrollY === 0, null, { timeout: 3000 }).catch(() => {});
          S.check(`${tag}: tapping the tab you're on scrolls it to the top`, await p.page.evaluate(() => scrollY) === 0);
        }
        if (!pg.wide) S.check(`${tag}: no sideways scroll`, await p.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
        S.check(`${tag}: no console errors or failed requests`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
      } finally { await p.ctx.close(); }
    });
  }
}

await S.step('lists: a person page keeps Directed or Acted and smaller films opened', async () => {
  const p = await page(F.robin, 1280, 'light');
  try {
    // Someone who has done both, from the catalog.
    const who = C.PEOPLE.june;
    await go(p.page, w, `#/person/${who.id}`, 500);
    const toggles = await p.page.locator('.person-toggle .segment').count();
    if (toggles > 1) await p.page.locator('.person-toggle .segment').nth(1).click();
    const more = p.page.locator('.person-more .show-all');
    if (await more.count()) await more.first().click();
    await scrollTo(p.page, 0.6);
    const before = await scrollState(p.page);
    const href = await filmInView(p.page);
    if (href) {
      await p.page.locator('[data-test-open="1"]').click();
      await settle(p.page, 300);
      await p.page.locator('#back-btn').click();
      await settle(p.page, 400);
      const after = await scrollState(p.page);
      S.check('person: the same switch, smaller films and scroll', after.kind === before.kind && JSON.stringify(after.open) === JSON.stringify(before.open) && Math.abs(after.y - before.y) <= 4, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    } else S.check('person: the same switch, smaller films and scroll', false, 'no film on screen');
  } finally { await p.ctx.close(); }
});

await browser.close();
await webkit.close();
await w.close();
S.finish();
