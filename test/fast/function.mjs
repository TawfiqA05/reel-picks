// Function (old G4, real-app G19, R4, and the browser parts of person search
// S3, S5, S6 and header search G5 / S2): every feature of Reel Picks, end to
// end in a real browser, and each change showing up on every page that shows
// the same data. Every console error, page error, 4xx/5xx and native dialog is
// recorded per section and must be expected.
//
// Roles: the owner (localhost); Robin, the heavy friend (700 ratings, movie
// plan None, Netflix and HBO Max); Casey, the empty friend; Jordan, a brand-new
// friend who goes through the welcome setup; friends made here through the
// real invite flow; and the guest (cf-ray header, no cookie).
//
// Three groups of sections run side by side, each on its own copy of the
// sample database and its own server, so no group sees another's changes.
//   FN_ONLY=picks,cross   runs only some sections (for working on the suite)
import fs from 'node:fs';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend, call, sleep, until, GUEST } from '../lib/world.mjs';
import { launch, open as openPage, go, settle, toastText } from '../lib/browser.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('function');
const { check, step } = S;
const ONLY = process.env.FN_ONLY ? new Set(process.env.FN_ONLY.split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
const browser = await launch();
const T0 = Date.now();

// ---- a made-up person who both directed and acted (the catalog's people do
// one or the other), put straight into the TMDB cache the person page reads.
const NELL = { id: 50099, name: 'Nell Varga' };
const NELL_DIRECTED = [C.CLASSICS[1], C.CLASSICS[7], C.PLAYING.find((f) => f.k === 12)];
const NELL_ACTED = [C.CLASSICS[2], C.CLASSICS[8], C.RATED[0]];
function seedNell(d) {
  const at = new Date(C.T0_MS - 3600e3).toISOString();
  const put = d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)');
  put.run(`tmdb:person:${NELL.id}`, JSON.stringify({ id: NELL.id, name: NELL.name, known_for_department: 'Directing', profile_path: `/rp-p-${NELL.id}.jpg`, popularity: 12, adult: false }), at, 7 * 86400);
  put.run(`tmdb:person:${NELL.id}:movie_credits`, JSON.stringify({
    id: NELL.id,
    crew: NELL_DIRECTED.map((f) => ({ ...C.light(f), job: 'Director', department: 'Directing' })),
    cast: NELL_ACTED.map((f, i) => ({ ...C.light(f), character: `Role ${i + 1}`, order: i })),
  }), at, 7 * 86400);
}

// ---- per-group plumbing ----------------------------------------------------------
function group(w) {
  const pages = [];
  const g = {
    w,
    api: (who, method, p, body) => w.api(method, p, { as: who, ...(body !== undefined ? { body } : {}) }),
    recs: async (who) => (await w.api('GET', '/api/recommendations', { as: who })).json,
    async open(role, width, theme = 'light', opts = {}) {
      const c = await openPage(browser, w, { role: role || 'owner', width, theme, ...opts });
      pages.push(c);
      return c;
    },
    mark: () => new Map(pages.map((p) => [p, p.errors.length])),
    noErrors(label, m, allow = []) {
      const extra = pages.flatMap((p) => p.errors.slice(m.get(p) ?? 0)).filter((e) => !allow.some((re) => re.test(e)));
      check(`${label}: no console errors, page errors or unexpected 4xx/5xx`, !extra.length, extra.slice(0, 6).join(' || '));
    },
    outside: () => pages.flatMap((p) => p.outside),
    async closeAll() { for (const p of pages) await p.ctx.close().catch(() => {}); },
  };
  return g;
}
const inFour = (r, id) => r.weekly4.some((e) => e.tmdb_id === id);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Click a star rating control at `v` stars (half stars allowed).
async function rateStars(page, loc, v) {
  const base = loc.locator('.stars-base').first();
  const wrap = base.locator('xpath=..');
  await base.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200); // rows with content-visibility: auto settle their real height once drawn
  await base.scrollIntoViewIfNeeded();
  const b = await base.boundingBox();
  const wr = await wrap.boundingBox();
  await wrap.click({ position: { x: b.x - wr.x + b.width * (v / 5) - 1, y: b.y - wr.y + b.height / 2 } });
}
const card = (page, title) => page.locator('.settings-group', { has: page.locator('.group-title', { hasText: new RegExp(`^${title}$`) }) });
const hiddenCard = (page) => card(page, 'Hidden films');
const bigStat = (page, label) => page.evaluate((l) => [...document.querySelectorAll('.big-stat')].find((b) => b.querySelector('.bs-label')?.textContent === l)?.querySelector('.bs-value')?.textContent || null, label);
async function closeSearch(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await page.locator('.search-overlay').count()) await page.locator('.search-overlay .modal-x').click().catch(() => {});
  await page.waitForTimeout(250);
}
async function typeSearch(page, q) {
  // A sheet still fading out after a row was tapped is not an open sheet.
  await page.waitForFunction(() => !document.querySelector('.search-overlay:not(.show)'), null, { timeout: 5000 }).catch(() => {});
  if (!(await page.locator('.search-overlay.show .search-input').count())) await page.locator('#search-btn').click();
  await page.locator('.search-input').fill(q);
  await page.waitForFunction((qq) => {
    const s = document.querySelector('.search-status')?.textContent || '';
    return document.querySelector('.search-input')?.value === qq && /\d+ results?|No matches|\d+ (person|people)/.test(s) && !/Searching/.test(s);
  }, q, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(150);
}
async function searchBadges(page, title) {
  await page.locator('#search-btn').click();
  await page.locator('.search-input').fill(title);
  await page.waitForFunction((t) => /No matches/.test(document.querySelector('.search-status')?.textContent || '')
    || [...document.querySelectorAll('.sr-row .sr-title')].some((e) => e.firstChild?.nodeValue?.toLowerCase() === t.toLowerCase()), title, { timeout: 30000 }).catch(() => {});
  const rows = await page.evaluate(() => [...document.querySelectorAll('.sr-row')].map((r) => ({ id: r.getAttribute('href').split('/').pop(), badges: [...r.querySelectorAll('.sr-badge')].map((b) => b.textContent.trim()) })));
  await closeSearch(page);
  return rows;
}
const sheetRows = (page) => page.locator('.search-body > .sr-person, .search-body > .sr-row').evaluateAll((els) => els.map((e) => ({
  kind: e.classList.contains('sr-person') ? 'person' : 'film', id: Number(e.getAttribute('href').split('/').pop()),
})));

// A trailer player stand-in with two controls, like YouTube's own, served for
// its cross-origin address so focus behaves as it would.
const PLAYER = '<!doctype html><title>player</title><button>Play</button><button>Full screen</button>';

// =================================================================================
// Group A: the heavy friend's pages.
async function groupA() {
  const w = S.world(await openWorld('function-a'));
  const g = group(w);
  const { api, recs } = g;
  const heavy = w.friends.robin;
  // Robin's saved film from the sample database is taken off, so the Watchlist
  // counts below start at zero; Robin plans with the owner.
  await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: 990004 });
  await api(heavy, 'PUT', '/api/settings', { watchTogether: true, youNoteSeen: true, tourDone: true, setupDone: true });

  if (want('picks')) await step('Picks (Robin, 390 light): hero, weekly 4, At home, sections, filter, day picker', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 390, 'light');
    const r = await recs(heavy);
    check('picks: heavy has a weekly 4', r.weekly4.length === 4, `got ${r.weekly4.length}`);
    await go(page, w, '#/home', 600);
    check('picks: hero drawn', await page.locator('.hero-pick .hero-title').count() === 1);
    check('picks: three more pick cards', await page.locator('.pick-grid:not(.home-grid) .pick-card').count() === 3);
    const days = await page.locator('.day-btn').count();
    check('picks: day picker has days', days >= 2, String(days));
    if (days >= 2) {
      await page.locator('.day-btn').nth(1).click();
      check('picks: day picker selects day 2', await page.locator('.day-btn').nth(1).getAttribute('aria-pressed') === 'true');
      await page.locator('.day-btn').nth(0).click();
    }
    await page.locator('.hero-actions a.btn.soft', { hasText: 'Details' }).click();
    await settle(page, 300);
    check('picks: hero Details opens its movie page', page.url().includes(`#/movie/${r.weekly4[0].tmdb_id}`), page.url());
    await page.goBack(); await settle(page, 400);
    await page.waitForFunction(() => document.querySelectorAll('#at-home .home-card').length || document.querySelector('#at-home .home-setup') || /Nothing left|error|couldn/i.test(document.querySelector('#at-home .home-body')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const homeCards = await page.locator('#at-home .home-card').count();
    check('picks: At home shows 4 picks for Netflix + HBO Max', homeCards === 4, `cards ${homeCards}; body "${(await page.locator('#at-home .home-body').textContent().catch(() => '')).slice(0, 120)}"`);
    check('picks: At home names the services', /Netflix and HBO Max/.test(await page.locator('#at-home .section-sub').textContent().catch(() => '')));
    const worth = await page.locator('.worth-list .list-row').count();
    check('picks: Also worth seeing count matches the API', worth === (r.worthSeeing || []).length, `${worth} vs ${(r.worthSeeing || []).length}`);
    const playing = await page.locator('.playing-list .list-row').count();
    check('picks: Everything playing lists every film', playing === r.list.length, `${playing} vs ${r.list.length}`);
    check('picks: Last chance cards match the API', await page.locator('.lc-card').count() === (r.lastChance || []).length);
    const target = r.list[Math.floor(r.list.length / 2)];
    const filter = page.locator('.playing-list').locator('xpath=preceding-sibling::div[contains(@class,"filter")][1]').locator('input');
    await filter.fill(target.title);
    await page.waitForTimeout(150);
    const shown = await page.locator('.playing-list .list-row:not([hidden])').allTextContents();
    check('picks: filter keeps the typed film', shown.some((t) => t.includes(target.title)), `${shown.length} shown`);
    check('picks: filter narrows the list', shown.length < r.list.length, `${shown.length}`);
    await filter.fill('zzqqxx');
    check('picks: filter says no matches', /No matches/.test(await page.locator('.filter-none:not([hidden])').first().textContent().catch(() => '')));
    await filter.fill('');
    await page.locator('.section-toggle').click();
    check('picks: Hide collapses Everything playing', await page.locator('.playing-list').isHidden());
    await page.waitForTimeout(300);
    await page.reload(); await settle(page, 500);
    check('picks: collapsed state survives a reload', await page.locator('.playing-list').isHidden() && /Show all/.test(await page.locator('.section-toggle').textContent()));
    await page.locator('.section-toggle').click();
    check('picks: Show all expands again', await page.locator('.playing-list').isVisible());
    const more = page.locator('.playing-list .row-more').first();
    check('picks: rows offer All times', await more.count() === 1);
    if (await more.count()) {
      await more.click();
      check('picks: All times opens the showtime panel', await page.locator('.playing-list .row-expand:not([hidden])').count() >= 1);
    }
    g.noErrors('picks', m0);
  });

  if (want('cross')) await step('Cross-page: rate, Seen and Undo, Not for me and Undo, watchlist everywhere (Robin, 390 light)', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 390, 'light');
    let r = await recs(heavy);
    const film = r.weekly4[1];
    const id = film.tmdb_id;
    const ratingsBefore = (await api(heavy, 'GET', '/api/ratings')).json.ratings.length;
    await go(page, w, `#/movie/${id}`, 400);
    await rateStars(page, page.locator('.rating-row .rater'), 4);
    check('cross: movie page rating toast', /Rated 4/.test(await toastText(page, /Rated/)));
    await page.waitForTimeout(400);
    const mine = (await api(heavy, 'GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === id);
    check('cross: rating stored as 4', mine?.rating === 4, JSON.stringify(mine?.rating));
    await go(page, w, '#/rate', 500);
    await page.waitForSelector('#rating-list', { timeout: 10000 }).catch(() => {});
    check('cross: Rate list shows the film', await page.locator(`#rating-list [data-rating-id="${id}"]`).count() === 1);
    check('cross: Rate list count went up', (await page.locator('.section-title', { has: page.locator('h2', { hasText: /^Your ratings$/ }) }).textContent()).includes(`${ratingsBefore + 1} total`));
    r = await recs(heavy);
    check('cross: rated film leaves the weekly 4', !inFour(r, id));
    await go(page, w, '#/home', 500);
    check('cross: Picks no longer shows it in the four', !(await page.locator(`.pick-card[data-id="${id}"]`).count()) && !(await page.locator(`.hero-pick a[href="#/movie/${id}"]`).count()));
    check('cross: Everything playing greys it as seen', await page.locator('.playing-list .list-row.seen', { hasText: film.title }).count() >= 1);
    await go(page, w, '#/stats', 500);
    check('cross: Stats ratings tile counts it', (await bigStat(page, 'ratings'))?.replace(/,/g, '') === String(ratingsBefore + 1), await bigStat(page, 'ratings'));
    const rows = await searchBadges(page, film.title);
    const row = rows.find((x) => Number(x.id) === id);
    check('cross: search shows the drawn star and "4" on the film', row?.badges.some((b) => b.trim() === '4'), JSON.stringify(row || rows.slice(0, 3)));
    await go(page, w, `#/movie/${id}`, 400);
    await page.locator('.rating-row .rater-clear').click();
    check('cross: Clear toast', /cleared/i.test(await toastText(page, /cleared/)));
    await page.waitForTimeout(400);
    r = await recs(heavy);
    check('cross: unrated film is back in the four', inFour(r, id));
    await go(page, w, '#/rate', 500);
    check('cross: Rate list drops the film', await page.locator(`#rating-list [data-rating-id="${id}"]`).count() === 0);

    await go(page, w, `#/movie/${id}`, 400);
    const seenBtn = page.locator('.seen-slot .btn');
    check('cross: plan None says "Mark seen"', (await seenBtn.textContent()).trim() === 'Mark seen', await seenBtn.textContent());
    await seenBtn.click();
    check('cross: Mark seen toast is about tickets', /Logged\..*on tickets/.test(await toastText(page, /Logged/)));
    check('cross: Seen and Undo shows', await page.locator('.seen-slot .seen-undo').isVisible());
    await go(page, w, '#/stats', 500);
    check('cross: Stats watch log lists the film', await page.locator('.log-row .row-title', { hasText: film.title }).count() === 1);
    check('cross: Stats tickets tile says 1', await bigStat(page, 'ticket this week') === '1', await page.locator('.stat-grid').first().textContent());
    await go(page, w, `#/movie/${id}`, 400);
    check('cross: movie page still shows Seen after a reload', await page.locator('.seen-slot .seen-undo').count() === 1);
    await page.locator('.seen-slot .seen-undo').click();
    await toastText(page, /Removed/);
    check('cross: Undo puts back Mark seen', await page.locator('.seen-slot .btn').isVisible());
    await go(page, w, '#/stats', 500);
    check('cross: Stats watch log empty again', await page.locator('.log-row .row-title', { hasText: film.title }).count() === 0);
    r = await recs(heavy);

    await go(page, w, '#/home', 500);
    const heroId = r.weekly4.find((e) => !e.prerelease || e.prerelease.soon)?.tmdb_id;
    const heroTitle = r.weekly4.find((e) => e.tmdb_id === heroId)?.title;
    await page.locator('.hero-pick .not-for-me').click();
    const t1 = await toastText(page, /Hid /);
    check('cross: Not for me toast names the film and who moved up', t1.includes(`Hid ${heroTitle}`) && /moved into your four/.test(t1), t1);
    r = await recs(heavy);
    check('cross: hidden film leaves the four', !inFour(r, heroId));
    const hiddenRow = page.locator('.playing-list .list-row.is-hidden', { hasText: heroTitle });
    check('cross: Everything playing marks it Hidden with Unhide', await hiddenRow.count() === 1 && await hiddenRow.locator('button', { hasText: 'Unhide' }).count() === 1);
    check('cross: "1 hidden, Show hidden" line', /1 hidden/.test(await page.locator('.hidden-line').textContent().catch(() => '')));
    const sr = (await searchBadges(page, heroTitle)).find((x) => Number(x.id) === heroId);
    check('cross: search shows "Hidden" on it', sr?.badges.includes('Hidden'), JSON.stringify(sr));
    await page.locator('.hero-pick .not-for-me').click();
    await toastText(page, /Hid /);
    await page.locator('.toast-action', { hasText: 'Undo' }).last().click();
    await page.waitForTimeout(800);
    r = await recs(heavy);
    check('cross: toast Undo brings the second hidden film back', r.weekly4.length === 4 && (await api(heavy, 'GET', '/api/hidden')).json.movies.length === 1);
    await go(page, w, '#/settings', 600);
    check('cross: Settings counts 1 hidden film', /1 film marked Not for me/.test(await hiddenCard(page).textContent()));
    await hiddenCard(page).locator('button', { hasText: 'Show hidden films' }).click();
    await page.locator('.hidden-row', { hasText: heroTitle }).locator('button', { hasText: 'Unhide' }).click();
    check('cross: Settings unhide toast', /back in your picks/.test(await toastText(page, /back in your picks/)));
    await page.waitForTimeout(400);
    check('cross: Settings hidden count updates to none', /Nothing is hidden/.test(await hiddenCard(page).textContent()));
    r = await recs(heavy);
    check('cross: unhidden film is back in the four', inFour(r, heroId));

    await go(page, w, '#/home', 500);
    const hid = r.weekly4.find((e) => !e.prerelease || e.prerelease.soon).tmdb_id;
    const htitle = r.weekly4.find((e) => e.tmdb_id === hid).title;
    await page.locator('.hero-pick .hero-actions .wl-btn').click();
    check('cross: watchlist toast', /Saved to your watchlist/.test(await toastText(page, /watchlist/)));
    await go(page, w, '#/watchlist', 500);
    check('cross: Watchlist page lists the hero film', await page.locator(`.tile-link[href="#/movie/${hid}"]`).count() === 1);
    check('cross: Watchlist heading counts 1', /1 saved/.test(await page.locator('.section-title').first().textContent()));
    const wr = (await searchBadges(page, htitle)).find((x) => Number(x.id) === hid);
    check('cross: search shows "Watchlist" on it', wr?.badges.includes('Watchlist'), JSON.stringify(wr));
    await go(page, w, '#/home', 500);
    check('cross: hero shows Saved (gold) after a reload', await page.locator('.hero-pick .wl-btn.active[aria-pressed="true"]', { hasText: 'Saved' }).count() === 1);
    await go(page, w, `#/movie/${hid}`, 400);
    await page.locator('.detail-actions .wl-btn[aria-pressed="true"]').click();
    await toastText(page, /Taken off your watchlist/);
    await go(page, w, '#/watchlist', 500);
    check('cross: Watchlist empty after removing on the movie page', await page.locator('.tile').count() === 0);
    await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: hid });
    await go(page, w, '#/watchlist', 500);
    await page.locator('.tile .icon-btn[aria-pressed="true"]').first().click();
    await toastText(page, /Taken off/);
    await page.waitForTimeout(300);
    const heading = await page.locator('.section-title').first().textContent();
    const emptyShown = await page.locator('.empty-title', { hasText: 'Nothing saved yet' }).count();
    check('cross: Watchlist page heading and empty state follow a removal made on it', /0 saved/.test(heading) && emptyShown === 1, `heading "${heading}", empty state ${emptyShown}`);
    await go(page, w, '#/home', 500);
    await page.locator('.hero-pick .not-for-me').click();
    await toastText(page, /Hid /);
    await page.locator('#bottom-nav .nav-item[data-name="rate"]').click();
    await settle(page, 500);
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await page.waitForTimeout(1200);
    const onRate = await page.locator('#main input.input.big').count() === 1 && await page.locator('#main .hero-pick').count() === 0;
    check('cross: Undo on the hide toast after moving to Rate leaves the Rate page in place', onRate, `url ${page.url().replace(w.base, '')}, hero in #main: ${await page.locator('#main .hero-pick').count()}`);
    check('cross: that Undo still unhides the film', (await api(heavy, 'GET', '/api/hidden')).json.movies.length === 0);
    g.noErrors('cross', m0);
  });

  if (want('wsw')) await step('What should I watch? (Robin, 390 dark): every step, Back, Skip, results, 3 more, Seen it, Save, Not for me', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 390, 'dark');
    await go(page, w, '#/home', 500);
    await page.locator('#wsw-btn').click();
    const sheet = page.locator('.wsw');
    check('wsw: step 1 of 3', /1 of 3/.test(await sheet.locator('.wsw-step').textContent()));
    await sheet.locator('[data-answer="theater"]').click();
    check('wsw: step 2 of 3', /2 of 3/.test(await sheet.locator('.wsw-step').textContent()));
    await sheet.locator('button', { hasText: 'Back' }).click();
    check('wsw: Back returns to step 1 with the answer kept', /1 of 3/.test(await sheet.locator('.wsw-step').textContent()) && await sheet.locator('[data-answer="theater"].active').count() === 1);
    await sheet.locator('[data-answer="either"]').click();
    await sheet.locator('.wsw-skip').click();
    check('wsw: Skip moves to step 3', /3 of 3/.test(await sheet.locator('.wsw-step').textContent()));
    await sheet.locator('[data-answer="surprise"]').click();
    await page.waitForSelector('.wsw-film, .wsw .muted', { timeout: 30000 }).catch(() => {});
    const films = await sheet.locator('.wsw-film').count();
    check('wsw: three films', films === 3, String(films));
    // Show me 3 more is checked as the owner below: only three of Robin's
    // films clear the suggestion bar here (test/fast/wsw.mjs).
    const c1 = sheet.locator('.wsw-film').first();
    const fid = Number(await c1.getAttribute('data-id'));
    await c1.locator('.wsw-seen').click();
    await rateStars(page, c1.locator('.wsw-rate'), 3.5);
    check('wsw: Seen it rating toast', /Rated/.test(await toastText(page, /Rated/)));
    await page.waitForTimeout(400);
    check('wsw: rating stored', (await api(heavy, 'GET', '/api/ratings')).json.ratings.some((x) => x.tmdb_id === fid && x.rating === 3.5));
    const c2 = sheet.locator('.wsw-film').nth(1);
    const wid = Number(await c2.getAttribute('data-id'));
    await c2.locator('.wl-btn', { hasText: 'Save' }).click();
    await toastText(page, /watchlist/);
    check('wsw: Save from the sheet saved', (await api(heavy, 'GET', '/api/watchlist')).json.movies.some((m) => m.tmdb_id === wid));
    const c3 = sheet.locator('.wsw-film').nth(2);
    const hidId = Number(await c3.getAttribute('data-id'));
    await c3.locator('.wsw-hide').click();
    await page.waitForSelector('.wsw-hidden-note', { timeout: 5000 }).catch(() => {});
    check('wsw: Not for me hides it', (await api(heavy, 'GET', '/api/hidden')).json.movies.some((m) => m.tmdb_id === hidId));
    await c3.locator('.wsw-hidden-note button', { hasText: 'Undo' }).click();
    await page.waitForTimeout(400);
    check('wsw: Undo unhides it', !(await api(heavy, 'GET', '/api/hidden')).json.movies.some((m) => m.tmdb_id === hidId));
    await sheet.locator('.wsw-restart').first().click();
    check('wsw: Change answers restarts at 1 of 3', /1 of 3/.test(await sheet.locator('.wsw-step').textContent()));
    // Show me 3 more and At home, as the owner (Netflix): Robin's films on
    // Netflix and HBO Max all match under the suggestion floor.
    {
      const op = (await g.open(null, 390, 'dark')).page;
      await go(op, w, '#/home', 500);
      await op.locator('#wsw-btn').click();
      const os = op.locator('.wsw');
      await os.locator('[data-answer="either"]').click();
      await os.locator('.wsw-skip').click();
      await os.locator('[data-answer="surprise"]').click();
      await op.waitForSelector('.wsw-film', { timeout: 30000 }).catch(() => {});
      const firstIds = await os.locator('.wsw-film').evaluateAll((els) => els.map((e) => e.dataset.id));
      const moreBtn = os.locator('button', { hasText: 'Show me 3 more' });
      if (await moreBtn.isEnabled()) {
        await moreBtn.click();
        await op.waitForFunction((ids) => { const now = [...document.querySelectorAll('.wsw-film')].map((e) => e.dataset.id); return now.length && now.every((x) => !ids.includes(x)); }, firstIds, { timeout: 30000 }).catch(() => {});
        const next = await os.locator('.wsw-film').evaluateAll((els) => els.map((e) => e.dataset.id));
        check('wsw: Show me 3 more brings new films', next.length && next.every((x) => !firstIds.includes(x)), `${firstIds} -> ${next}`);
      } else check('wsw: Show me 3 more brings new films', false, 'disabled');
      await os.locator('.wsw-restart').first().click();
      await os.locator('[data-answer="home"]').click();
      await os.locator('.wsw-skip').click();
      await os.locator('[data-answer="surprise"]').click();
      await op.waitForSelector('.wsw-film, .wsw h3.wsw-q', { timeout: 30000 }).catch(() => {});
      await op.waitForFunction(() => !document.querySelector('.wsw .spinner'), null, { timeout: 30000 }).catch(() => {});
      const homeFilms = await os.locator('.wsw-film').count();
      const tags = await os.locator('.wsw-film .service-tag').allTextContents();
      check('wsw: at-home answers give films on Netflix or HBO Max', homeFilms > 0 && tags.length === homeFilms && tags.every((t) => /On (Netflix|HBO Max)/.test(t)), `${homeFilms} films; ${tags.join(' / ')}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('wsw: Escape closes the sheet', await page.locator('.wsw').count() === 0);
    await go(page, w, '#/home', 500);
    const four = await page.evaluate(() => [...document.querySelectorAll('.pick-grid:not(.home-grid) .pick-card[data-id]')].map((e) => Number(e.dataset.id))
      .concat(Number(document.querySelector('.hero-pick .hero-title a')?.getAttribute('href').split('/').pop())));
    await page.locator('#wsw-btn').click();
    await sheet.locator('[data-answer="theater"]').click();
    await sheet.locator('.wsw-skip').click();
    await sheet.locator('[data-answer="surprise"]').click();
    await page.waitForSelector('.wsw-film', { timeout: 30000 }).catch(() => {});
    const overlap = (await sheet.locator('.wsw-film').evaluateAll((els) => els.map((e) => Number(e.dataset.id)))).find((x) => four.includes(x));
    if (overlap) {
      await sheet.locator(`.wsw-film[data-id="${overlap}"] .wsw-hide`).click();
      await page.waitForSelector('.wsw-hidden-note', { timeout: 5000 }).catch(() => {});
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      const still = await page.locator(`.pick-card[data-id="${overlap}"], .hero-pick a[href="#/movie/${overlap}"]`).count();
      check('wsw: a film hidden in the sheet leaves the Picks page behind it', still === 0, `still shown in the four after closing the sheet (${still})`);
      await api(heavy, 'DELETE', `/api/hidden/${overlap}`);
    } else check('wsw: a film hidden in the sheet leaves the Picks page behind it', false, 'no theater suggestion overlapped the four (test setup)');
    await go(page, w, '#/watchlist', 500);
    check('wsw: Watchlist page shows the film saved in the sheet', await page.locator(`.tile-link[href="#/movie/${wid}"]`).count() === 1);
    await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: wid });
    await api(heavy, 'DELETE', `/api/ratings/${fid}`);
    g.noErrors('wsw', m0);
  });

  if (want('rate')) await step('Rate (Robin, 1280 light): list, Show all, filter, rate, clear, remove, search', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 1280, 'light');
    await go(page, w, '#/rate', 500);
    await page.waitForSelector('#rating-list', { timeout: 15000 });
    const total = (await api(heavy, 'GET', '/api/ratings')).json.ratings.length;
    const titleOf = async () => page.locator('.section-title', { has: page.locator('h2', { hasText: /^Your ratings$/ }) }).textContent();
    check('rate: heading counts every rating', (await titleOf()).includes(`${total} total`), await titleOf());
    check('rate: 60 shown before Show all', await page.locator('#rating-list .rating-item:not([hidden])').count() === 60);
    const more = page.locator('.show-all');
    check('rate: Show all names the total', (await more.textContent()).trim() === `Show all (${total})`, await more.textContent());
    await more.click();
    check('rate: Show all shows every rating', await page.locator('#rating-list .rating-item:not([hidden])').count() === total);
    check('rate: button turns into Show fewer', (await more.textContent()).trim() === 'Show fewer');
    await more.click();
    const deep = (await api(heavy, 'GET', '/api/ratings')).json.ratings[total - 3];
    await page.locator('.filter-input').fill(deep.title);
    await page.waitForTimeout(200);
    const vis = await page.locator('#rating-list .rating-item:not([hidden]) .ri-title').allTextContents();
    check('rate: filter finds a film past the first 60', vis.some((t) => t.startsWith(deep.title)), `${vis.length} shown`);
    check('rate: Show all hides while filtering', await more.isHidden());
    await page.locator('.filter-clear').click();
    const row = page.locator(`#rating-list [data-rating-id="${deep.tmdb_id}"]`);
    await page.locator('.filter-input').fill(deep.title);
    await rateStars(page, row.locator('.stars'), 5);
    await toastText(page, /Rated/);
    await page.waitForTimeout(300);
    check('rate: list re-rate saved', (await api(heavy, 'GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === deep.tmdb_id)?.rating === 5);
    check('rate: filter text kept after the list reloads', await page.locator('.filter-input').inputValue() === deep.title);
    await page.locator(`#rating-list [data-rating-id="${deep.tmdb_id}"] .ri-remove`).click();
    await toastText(page, /Removed your rating/);
    await page.waitForTimeout(400);
    check('rate: remove drops the row', await page.locator(`#rating-list [data-rating-id="${deep.tmdb_id}"]`).count() === 0);
    check('rate: remove updates the total', (await titleOf()).includes(`${total - 1} total`));
    await api(heavy, 'POST', '/api/ratings', { tmdb_id: deep.tmdb_id, rating: deep.rating, title: deep.title });
    await page.locator('input.input.big').fill('harbor');
    await page.waitForSelector('.search-results .search-row', { timeout: 20000 }).catch(() => {});
    const res = page.locator('.search-results .search-row').first();
    check('rate: search finds films', await res.count() === 1);
    const sid = Number((await res.locator('.search-title').getAttribute('href')).split('/').pop());
    const had = (await api(heavy, 'GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === sid);
    if (had) { await api(heavy, 'DELETE', `/api/ratings/${sid}`); await page.locator('input.input.big').fill('harbo'); await page.locator('input.input.big').fill('harbor'); await page.waitForTimeout(800); }
    await rateStars(page, res.locator('.stars'), 4.5);
    await toastText(page, /Rated/);
    await page.waitForTimeout(400);
    check('rate: rating from search saved', (await api(heavy, 'GET', '/api/ratings')).json.ratings.find((x) => x.tmdb_id === sid)?.rating === 4.5);
    await rateStars(page, res.locator('.stars'), 4.5); // tapping the same value clears it
    await toastText(page, /Cleared rating/);
    await page.waitForTimeout(400);
    check('rate: tapping the same stars clears the rating', !(await api(heavy, 'GET', '/api/ratings')).json.ratings.some((x) => x.tmdb_id === sid));
    if (had) await api(heavy, 'POST', '/api/ratings', { tmdb_id: sid, rating: had.rating, title: had.title });
    g.noErrors('rate', m0);
  });

  if (want('together')) await step('Together: owner and friend views, both-watchlists label, switch off and on, privacy 404 (1280 light)', async () => {
    const m0 = g.mark();
    const r = await recs(heavy);
    const F = r.list.find((e) => !e.flags?.seen && !e.flags?.hidden && e.showtimesByDay?.length);
    await api(null, 'POST', '/api/watchlist/toggle', { tmdb_id: F.tmdb_id });
    await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: F.tmdb_id });
    const { page } = await g.open(null, 1280, 'light');
    await go(page, w, '#/together', 800);
    check('together: owner sees Robin to plan with', await page.locator('.tg-person', { hasText: 'Robin' }).count() === 1);
    const row = page.locator('.tg-film', { hasText: F.title });
    check('together: a film on both watchlists is listed for the owner', await row.count() === 1);
    check('together: it says "On both watchlists"', /On both watchlists/.test(await row.textContent().catch(() => '')));
    const fr = await g.open(heavy, 390, 'dark');
    await go(fr.page, w, '#/together', 800);
    check('together: the friend sees the owner', /You and /.test(await fr.page.locator('.you-panel .section-title').first().textContent().catch(() => '')));
    check('together: the friend sees the same film and label', /On both watchlists/.test(await fr.page.locator('.tg-film', { hasText: F.title }).textContent().catch(() => '')));
    await go(fr.page, w, '#/settings', 600);
    const sw = card(fr.page, 'Watch together').locator('input[type=checkbox]');
    check('together: Settings switch shows on', await sw.isChecked());
    await sw.uncheck();
    await toastText(fr.page, /Watch together is off/);
    await go(page, w, '#/together', 800);
    check('together: owner page empties when the friend switches off', await page.locator('.empty-title', { hasText: 'No friends have turned this on yet' }).count() === 1);
    await go(fr.page, w, '#/together', 600);
    const turnOn = fr.page.locator('button', { hasText: /[Pp]lan movies with/ });
    check('together: friend page offers to switch on again', await turnOn.count() === 1);
    await turnOn.click();
    await settle(fr.page, 600);
    check('together: switching on from the page shows the pair', /You and /.test(await fr.page.locator('.you-panel .section-title').first().textContent()) && await fr.page.locator('.tg-body').count() === 1);
    await go(fr.page, w, '#/settings', 600);
    check('together: Settings switch follows the page', await card(fr.page, 'Watch together').locator('input[type=checkbox]').isChecked());
    await api(heavy, 'POST', '/api/ratings', { tmdb_id: F.tmdb_id, rating: 3, title: F.title });
    await go(page, w, '#/together', 800);
    check('together: a film the friend rated leaves Together', await page.locator('.tg-film', { hasText: F.title }).count() === 0);
    await api(heavy, 'DELETE', `/api/ratings/${F.tmdb_id}`);
    const a = await api(heavy, 'GET', `/api/together/${w.friends.casey.id}`);
    const b = await api(heavy, 'GET', '/api/together/987654');
    check('together: other friend and made-up id give the same 404', a.status === 404 && b.status === 404 && a.text === b.text, `${a.status} ${b.status}`);
    await api(null, 'POST', '/api/watchlist/toggle', { tmdb_id: F.tmdb_id });
    await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: F.tmdb_id });
    g.noErrors('together', m0);
  });

  if (want('stats')) await step('Stats (Robin 1280 dark, owner for filmographies): tiles, lists, Show all, filters, sheets, rating inside sheets', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 1280, 'dark');
    for (let i = 0; i < 60 && (await api(heavy, 'GET', '/api/stats')).json.backfilling; i++) await sleep(500);
    const s = (await api(heavy, 'GET', '/api/stats')).json;
    await go(page, w, '#/stats', 600);
    check('stats: plan None titles the page "Your tickets"', /Your tickets/.test(await page.locator('.you-panel .group-title').first().textContent()));
    check('stats: ratings tile matches the API', (await bigStat(page, 'ratings'))?.replace(/,/g, '') === String(s.totalRatings), `${await bigStat(page, 'ratings')} vs ${s.totalRatings}`);
    check('stats: average rating tile', ((await bigStat(page, 'average rating')) || '').trim() === `${s.avgRating}`);
    const gl = page.locator('#top-genre');
    check('stats: top genres list shows 10', await gl.locator('.bar-item:not([hidden])').count() === Math.min(10, s.topGenres.length));
    const gShow = page.locator('.stat-list', { has: gl }).locator('.show-all');
    if (s.topGenres.length > 10) {
      await gShow.click();
      check('stats: Show all genres', await gl.locator('.bar-item:not([hidden])').count() === s.topGenres.length);
      const f = page.locator('.stat-list', { has: gl }).locator('.filter-input');
      await f.fill(s.topGenres[s.topGenres.length - 1].name);
      await page.waitForTimeout(150);
      const n = await gl.locator('.bar-item:not([hidden])').count();
      check('stats: genre filter narrows the list', n >= 1 && n < s.topGenres.length, String(n));
      await f.fill('');
      await gShow.click();
    }
    const g0 = s.topGenres[0];
    await gl.locator('.bar-row').first().click();
    const sheet = page.locator('.modal-card');
    await page.waitForSelector('.sheet-rated .sheet-films', { timeout: 15000 }).catch(() => {});
    check('stats: genre sheet lists every rated film in it', await sheet.locator('.sheet-rated .sheet-film').count() === g0.n, `${await sheet.locator('.sheet-rated .sheet-film').count()} vs ${g0.n}`);
    await page.waitForFunction(() => !/Checking your theaters/.test(document.querySelector('.sheet-more .sheet-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const playingNow = sheet.locator('.sheet-more .more-film');
    check('stats: "<Genre> playing now" loads', await playingNow.count() > 0, await sheet.locator('.sheet-more').textContent().catch(() => ''));
    let ratedInSheet = null;
    if (await playingNow.count()) {
      const first = playingNow.first();
      ratedInSheet = { title: (await first.locator('.sheet-title').textContent()).trim(), href: await first.locator('a').first().getAttribute('href') };
      await rateStars(page, first.locator('.stars.interactive'), 4);
      await toastText(page, /Rated/);
      await page.waitForTimeout(1500);
      check('stats: a film rated in the sheet moves into "You rated"', await sheet.locator('.sheet-rated .sheet-film a', { hasText: ratedInSheet.title }).count() >= 1);
      check('stats: sheet subtitle counts it', (await sheet.locator('.sheet-sub').textContent()).replace(/,/g, '').startsWith(`${g0.n + 1} films`), await sheet.locator('.sheet-sub').textContent());
    }
    if (g0.n > 12) {
      const sf = sheet.locator('.filter-input');
      const one = (await sheet.locator('.sheet-rated .sheet-title').first().evaluate((e) => e.firstChild.nodeValue)).trim();
      await sf.fill(one);
      await page.waitForTimeout(200);
      const left = await sheet.locator('.sheet-rated .sheet-film:not([hidden])').count();
      check('stats: the sheet filter narrows "You rated"', left >= 1 && left < g0.n, `${left}`);
      await sf.fill('');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    if (ratedInSheet) {
      check('stats: page redraws with the new count after the sheet closes', (await bigStat(page, 'ratings'))?.replace(/,/g, '') === String(s.totalRatings + 1), await bigStat(page, 'ratings'));
      const id = Number(ratedInSheet.href.split('/').pop());
      await go(page, w, '#/rate', 500);
      check('stats: film rated in the sheet shows on the Rate page', await page.locator(`#rating-list [data-rating-id="${id}"]`).count() === 1);
      check('stats: film rated in the sheet leaves the weekly 4', !inFour(await recs(heavy), id));
      await api(heavy, 'DELETE', `/api/ratings/${id}`);
    }
    // Filmographies: the owner's top director and actor are catalog people with
    // TMDB ids (the heavy friend's generated films have none).
    const o = await g.open(null, 1280, 'dark');
    const os = (await api(null, 'GET', '/api/stats')).json;
    await go(o.page, w, '#/stats', 600);
    if (os.topDirectors.length) {
      await o.page.locator('#top-director .bar-row').first().click();
      await o.page.waitForFunction(() => !/Loading films from TMDB/.test(document.querySelector('.sheet-more .sheet-status')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
      const mf = o.page.locator('.modal-card .sheet-more .more-film');
      check('stats: "More from <director>" loads films', await mf.count() > 0, await o.page.locator('.modal-card .sheet-more').textContent().catch(() => ''));
      if (await mf.count()) {
        const btn = o.page.locator('.modal-card .sheet-more .more-film .icon-btn[aria-pressed="false"]').first();
        const href = await btn.locator('xpath=ancestor::*[contains(@class,"more-film")][1]').locator('a').first().getAttribute('href');
        await btn.click();
        await toastText(o.page, /watchlist/);
        await o.page.keyboard.press('Escape');
        await go(o.page, w, '#/watchlist', 500);
        check('stats: watchlist toggle in a "More from" sheet shows on the Watchlist page', await o.page.locator(`.tile-link[href="${href}"]`).count() === 1, href);
        await api(null, 'POST', '/api/watchlist/toggle', { tmdb_id: Number(href.split('/').pop()) });
        await go(o.page, w, '#/stats', 600);
      } else await o.page.keyboard.press('Escape');
    } else check('stats: "More from <director>" loads films', false, 'the owner has no top directors');
    if (os.topActors.length) {
      await o.page.locator('#top-actor .bar-row').first().click();
      await o.page.waitForFunction(() => !/Loading films from TMDB/.test(document.querySelector('.sheet-more .sheet-status')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
      check('stats: actor sheet "You rated" lists films', await o.page.locator('.modal-card .sheet-rated .sheet-film').count() > 0);
      check('stats: "More from <actor>" loads films', await o.page.locator('.modal-card .sheet-more .more-film').count() > 0);
      await o.page.keyboard.press('Escape');
    } else check('stats: actor sheet "You rated" lists films', false, 'the owner has no top actors');
    g.noErrors('stats', m0);
  });

  if (want('friendsettings')) await step('A friend\'s Settings (Robin, 1280 light): own cards only, own values, export my data, Everything playing Unhide', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 1280, 'light');
    await go(page, w, '#/settings', 800);
    const titles = await page.locator('.settings-group > .group-title').allTextContents();
    const ownerOnlyCards = ['API keys', 'Friends', 'AMC title matching', 'Now-playing fallback', 'Also worth seeing', 'Last chance', 'Alerts'];
    check('friend settings: none of the owner\'s cards', !titles.some((t) => ownerOnlyCards.includes(t)), titles.join(', '));
    check('friend settings: has Watch together, Letterboxd, Streaming services', ['Watch together', 'Letterboxd', 'Streaming services'].every((t) => titles.includes(t)), titles.join(', '));
    check('friend settings: plan None is selected', await page.locator('.plan-chips [data-plan="none"][aria-checked="true"]').count() === 1);
    const ownerTicket = (await api(null, 'GET', '/api/settings')).json.avgTicketPrice;
    const f = (label) => page.locator('.field', { has: page.locator('.field-label', { hasText: label }) }).locator('input').first();
    await f('Avg ticket').fill('12.5');
    await page.locator('.save-bar button').click();
    check('friend settings: saving works', /Settings saved/.test(await toastText(page, /saved|fixing|error/)));
    await page.reload(); await settle(page, 700);
    check('friend settings: the value survives a reload', await f('Avg ticket').inputValue() === '12.5');
    check('friend settings: the owner\'s value is untouched', (await api(null, 'GET', '/api/settings')).json.avgTicketPrice === ownerTicket);
    const [dl] = await Promise.all([page.waitForEvent('download'), card(page, 'Data').locator('a', { hasText: 'Export my data' }).click()]);
    const doc = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    const hvCount = (await api(heavy, 'GET', '/api/ratings')).json.ratings.length;
    check('friend settings: Export my data carries only their own data', doc.profile.ratings.length === hvCount && !doc.profile.matches && !('goodMatchMinScore' in doc.profile.settings));
    check('friend settings: a friend can\'t import a full setup', (await api(heavy, 'POST', '/api/state', doc)).status === 403);
    const r = await recs(heavy);
    const film = r.weekly4[0];
    await api(heavy, 'POST', '/api/hidden', { tmdb_id: film.tmdb_id, title: film.title });
    await go(page, w, '#/home', 600);
    await page.locator('.playing-list .list-row.is-hidden', { hasText: film.title }).locator('button', { hasText: 'Unhide' }).click();
    await toastText(page, /Unhid/);
    await page.waitForTimeout(500);
    check('picks: Everything playing Unhide puts it back', inFour(await recs(heavy), film.tmdb_id) && await page.locator('.playing-list .list-row.is-hidden', { hasText: film.title }).count() === 0);
    g.noErrors('friendsettings', m0);
  });

  if (want('watchlog')) await step('Watch log removal and Show hidden (Robin, 390 light)', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 390, 'light');
    const rr = await recs(heavy);
    await api(heavy, 'POST', '/api/watched', { tmdb_id: rr.weekly4[2].tmdb_id, title: rr.weekly4[2].title });
    await go(page, w, '#/stats', 600);
    check('stats: watch log lists the film', await page.locator('.log-row .row-title', { hasText: rr.weekly4[2].title }).count() === 1);
    await page.locator(`.log-row button[aria-label="Remove ${rr.weekly4[2].title} from your watch log"]`).click();
    check('stats: the confirm names the plan (None: ticket spend)', /ticket spend/.test(await page.locator('.modal-card').textContent()));
    await page.locator('.modal-card button', { hasText: /^Remove$/ }).click();
    await toastText(page, /Removed from your watch log/);
    await settle(page, 500);
    check('stats: removal clears the log and the tile', await page.locator('.log-row .row-title', { hasText: rr.weekly4[2].title }).count() === 0 && await bigStat(page, 'tickets this week') === '0', await bigStat(page, 'tickets this week'));
    await api(heavy, 'POST', '/api/hidden', { tmdb_id: rr.weekly4[3].tmdb_id, title: rr.weekly4[3].title });
    await go(page, w, '#/home', 600);
    await page.locator('.hidden-line button', { hasText: 'Show hidden' }).click();
    await page.locator('.hidden-row button', { hasText: 'Unhide' }).first().click();
    await toastText(page, /Unhid/);
    await page.waitForTimeout(500);
    check('picks: Show hidden then Unhide puts it back in the four', inFour(await recs(heavy), rr.weekly4[3].tmdb_id) && await page.locator('.hidden-line').count() === 0);
    g.noErrors('watchlog', m0);
  });

  const out = g.outside();
  console.log(`group A done at ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  check('group A: no request left the machine from the browser', !out.length, out.slice(0, 5).join(', '));
  await g.closeAll();
  await w.close();
}

// =================================================================================
// Group B: the owner's Settings, notifications, the invite flow, the owner tour.
async function groupB() {
  const w = S.world(await openWorld('function-b', { push: true }));
  const g = group(w);
  const { api, recs } = g;
  const heavy = w.friends.robin;
  const primary = (await api(null, 'GET', '/api/status')).json.theatres.find((t) => t.isPrimary);

  if (want('settings')) await step('Settings (owner 1280 dark): every card saves, survives a reload, refuses bad values', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'dark');
    const Sget = () => api(null, 'GET', '/api/settings').then((x) => x.json);
    await go(page, w, '#/settings', 800);
    const save = async () => { await page.locator('.save-bar button').click(); return toastText(page, /saved|fixing/); };
    const field = (label) => page.locator('.field', { has: page.locator('.field-label', { hasText: label }) }).locator('input, select').first();
    const keys = await card(page, 'API keys').textContent();
    check('settings: API keys card shows TMDB, OMDb and AMC connected', /TMDB.*connected/.test(keys) && /OMDb.*connected/.test(keys) && /AMC.*connected/.test(keys), keys.slice(0, 240));
    check('settings: local key note points at .env', /\.env/.test(keys));
    for (const [id, exp] of [['regal-unlimited', { alistWeeklyLimit: 0, alistMonthlyFee: 21.99, avgTicketPrice: 15 }], ['cinemark-movie-club', { alistWeeklyLimit: 1, alistMonthlyFee: 10.99, avgTicketPrice: 13, planPeriod: 'month' }], ['other', { alistWeeklyLimit: 2, alistMonthlyFee: 20, avgTicketPrice: 14 }], ['none', { avgTicketPrice: 14.5 }], ['amc-alist', { alistWeeklyLimit: 3, alistMonthlyFee: 25.99, avgTicketPrice: 14.5 }]]) {
      await page.locator(`.plan-chips [data-plan="${id}"]`).click();
      const t = await save();
      const s = await Sget();
      check(`settings: plan ${id} saves`, /saved/.test(t) && s.moviePlan === id && Object.entries(exp).every(([k, v]) => s[k] === v), `${t} ${JSON.stringify(Object.fromEntries(Object.keys(exp).map((k) => [k, s[k]])))}`);
      await page.reload(); await settle(page, 600);
      check(`settings: plan ${id} survives a reload`, await page.locator(`.plan-chips [data-plan="${id}"][aria-checked="true"]`).count() === 1);
    }
    await go(page, w, '#/stats', 500);
    check('settings: A-List plan titles Stats "This A-List week"', /This A-List week/.test(await page.locator('.you-panel .group-title').first().textContent()));
    await go(page, w, '#/settings', 700);
    const before = await Sget();
    const bad = [['Avg ticket', '-5', /from 0 to 1000/], ['Monthly fee', '99999', /from 0 to 1000/], ['Reservations / week', '2.5', /whole number/], ['Preview length', '', /Enter a number/], ['Watchlist +', '150', /from 0 to 100/], ['Minimum score', '101', /from 0 to 100/], ['Days before horizon', '0', /1 to 14/], ['Max entries', '13', /1 to 12/], ['Only show films released', '0', /1 to 104/], ['Watchlist urgency', '0.5', /1 to 5/]];
    for (const [label, value, re] of bad) {
      await field(label).fill(value);
      const t = await save();
      const err = await page.locator('.form-error').allTextContents();
      check(`settings: "${label}" = "${value}" is refused with a visible message`, /needs fixing/.test(t) && err.some((e) => re.test(e)), `${t} | ${err.join(' / ')}`);
      await page.reload(); await settle(page, 600);
    }
    const after = await Sget();
    check('settings: refused saves changed nothing', JSON.stringify({ ...before, lastRefresh: 0, lastRefreshLog: 0 }) === JSON.stringify({ ...after, lastRefresh: 0, lastRefreshLog: 0 }));
    for (const [k, v] of [['avgTicketPrice', -1], ['alistMonthlyFee', 1e9], ['previewsMinutes', 'abc'], ['moviePlan', 'bogus'], ['streamingServices', ['netflix', 'bogus']]]) {
      const x = await api(null, 'PUT', '/api/settings', { [k]: v });
      check(`settings: server refuses ${k}=${JSON.stringify(v)}`, x.status === 400, `${x.status}`);
    }
    const tw = await api(null, 'PUT', '/api/settings', { showtimeWindows: { weekday: { enabled: true, after: '99:99', before: 'soon' }, weekend: 'x' } });
    check('settings: server refuses a malformed showtime window', tw.status === 400, `${tw.status}`);
    if (tw.status === 200) await api(null, 'PUT', '/api/settings', { showtimeWindows: before.showtimeWindows });
    await page.locator('.window-row input[type=time]').first().fill('');
    const tt = await save();
    check('settings: an empty time is refused', /needs fixing/.test(tt) && (await page.locator('.form-error').allTextContents()).some((e) => /Enter a time/.test(e)), tt);
    await page.reload(); await settle(page, 600);
    await page.locator('input[type=range][aria-label^="Balance"]').fill('30');
    await page.locator('input[type=range][aria-label^="Urgency"]').fill('9');
    await card(page, 'Preferences').locator('input[type=checkbox]').setChecked(!before.preferImax);
    await card(page, 'Preferences').locator('.chip', { hasText: /^Horror$/ }).click();
    await card(page, 'Preferences').locator('.chip', { hasText: /^NC-17$/ }).click();
    await page.locator('.window-row').first().locator('input[type=time]').first().fill('17:15');
    for (const [l, v] of [['Avg ticket', '16.25'], ['Preview length', '25'], ['Watchlist +', '11'], ['IMAX +', '3'], ['Fits window +', '7'], ['Watchlist urgency', '2'], ['Minimum score', '72'], ['Min score', '77'], ['Days before horizon', '4'], ['Max entries', '5'], ['Only show films released', '10']]) await field(l).fill(v);
    const t2 = await save();
    check('settings: a full valid save succeeds', /Settings saved/.test(t2), t2);
    await page.reload(); await settle(page, 700);
    const s2 = await Sget();
    const got = {
      balance: await page.locator('input[type=range][aria-label^="Balance"]').inputValue(), urgency: await page.locator('input[type=range][aria-label^="Urgency"]').inputValue(),
      imax: await card(page, 'Preferences').locator('input[type=checkbox]').isChecked(),
      horror: await card(page, 'Preferences').locator('.chip.active', { hasText: /^Horror$/ }).count(), nc17: await card(page, 'Preferences').locator('.chip.active', { hasText: /^NC-17$/ }).count(),
      after: await page.locator('.window-row').first().locator('input[type=time]').first().inputValue(),
      ticket: await field('Avg ticket').inputValue(), previews: await field('Preview length').inputValue(), wl: await field('Watchlist +').inputValue(), imaxB: await field('IMAX +').inputValue(),
      fit: await field('Fits window +').inputValue(), mult: await field('Watchlist urgency').inputValue(), good: await field('Minimum score').inputValue(), lc: await field('Min score').inputValue(),
      gap: await field('Days before horizon').inputValue(), max: await field('Max entries').inputValue(), weeks: await field('Only show films released').inputValue(),
    };
    const exp = { balance: '30', urgency: '9', imax: !before.preferImax, horror: 1, nc17: 1, after: '17:15', ticket: '16.25', previews: '25', wl: '11', imaxB: '3', fit: '7', mult: '2', good: '72', lc: '77', gap: '4', max: '5', weeks: '10' };
    const diff = Object.keys(exp).filter((k) => got[k] !== exp[k]);
    check('settings: every field survives a reload', !diff.length, diff.map((k) => `${k}: ${got[k]} vs ${exp[k]}`).join(', '));
    check('settings: server has the saved values', s2.avgTicketPrice === 16.25 && s2.previewsMinutes === 25 && s2.goodMatchMinScore === 72 && s2.excludedGenres.includes('Horror') && Math.abs(s2.weightPublic - 0.3) < 1e-9);
    const svc = card(page, 'Streaming services');
    await svc.locator('[data-service="hulu"]').click();
    await page.waitForFunction(() => /Saved/.test([...document.querySelectorAll('.settings-group')].find((c) => c.querySelector('.group-title')?.textContent === 'Streaming services')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
    check('settings: a service tap saves', (await Sget()).streamingServices.includes('hulu'));
    await page.reload(); await settle(page, 600);
    check('settings: service survives a reload', await card(page, 'Streaming services').locator('[data-service="hulu"][aria-pressed="true"]').count() === 1);
    await card(page, 'Streaming services').locator('[data-service="hulu"]').click();
    await page.waitForTimeout(500);
    const hb = card(page, 'Home base');
    await hb.locator('input[type=search]').fill('Testville');
    await hb.locator('button', { hasText: 'Look up' }).click();
    await page.waitForFunction(() => /Found/.test(document.querySelector('.geo-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('settings: look up fills the fields', /Found Testville, OH/.test(await hb.locator('.geo-status').textContent()) && await field('Label').inputValue() === 'Testville, OH', `${await hb.locator('.geo-status').textContent()} / ${await field('Label').inputValue()}`);
    await hb.locator('input[type=search]').fill('two Testvilles');
    await hb.locator('button', { hasText: 'Look up' }).click();
    await page.waitForFunction(() => /More than one/.test(document.querySelector('.geo-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('settings: several matches offer a choice', await hb.locator('.theatre-results button', { hasText: 'Use' }).count() === 2);
    await hb.locator('.theatre-results button', { hasText: 'Use' }).nth(1).click();
    check('settings: choosing one fills its coordinates', await field('Latitude').inputValue() === '40.5', await field('Latitude').inputValue());
    await hb.locator('input[type=search]').fill('nowhere at all');
    await hb.locator('button', { hasText: 'Look up' }).click();
    await page.waitForFunction(() => /Nothing found/.test(document.querySelector('.geo-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('settings: no match says so and keeps the fields', /Nothing found/.test(await hb.locator('.geo-status').textContent()) && await field('Latitude').inputValue() === '40.5');
    await field('Longitude').fill('');
    const t3 = await save();
    check('settings: latitude without longitude is refused', /needs fixing/.test(t3) && (await page.locator('.form-error').allTextContents()).some((e) => /both latitude and longitude/.test(e)));
    await field('Longitude').fill('-82.5');
    await field('Latitude').fill('91');
    check('settings: latitude 91 is refused', /needs fixing/.test(await save()));
    await field('Latitude').fill('40.5');
    check('settings: a valid home base saves', /Settings saved/.test(await save()));
    await page.reload(); await settle(page, 600);
    check('settings: home base survives a reload', await field('Label').inputValue() === 'Testville, OH' && await field('Latitude').inputValue() === '40.5', `${await field('Label').inputValue()} ${await field('Latitude').inputValue()}`);
    await card(page, 'Home base').locator('button', { hasText: 'Clear home base' }).click();
    await toastText(page, /Home base cleared/);
    check('settings: Clear home base empties the fields', await field('Label').inputValue() === '' && await field('Latitude').inputValue() === '');
    const th = card(page, 'Theaters');
    const nBefore = (await api(null, 'GET', '/api/status')).json.theatres.length;
    await th.locator('input[type=search]').fill('lakeview');
    await th.locator('button', { hasText: 'Search' }).click();
    await page.waitForSelector('.theatre-results .theatre-row', { timeout: 8000 }).catch(() => {});
    const rowT = page.locator('.theatre-results .theatre-row').first();
    check('settings: theatre search finds theatres', await rowT.count() === 1);
    const tname = 'AMC Lakeview 16';
    await rowT.locator('button', { hasText: 'Follow' }).click();
    await toastText(page, /Following/);
    await page.waitForTimeout(500);
    const st1 = (await api(null, 'GET', '/api/status')).json;
    check('settings: Follow adds the theatre', st1.theatres.length === nBefore + 1 && await th.locator('.theatre-item', { hasText: tname }).count() === 1);
    check('settings: Theaters lists the primary and every followed theater', await th.locator('.theatre-item').count() === nBefore + 1);
    await th.locator('.theatre-item', { hasText: tname }).locator('button', { hasText: 'Make primary' }).click();
    await toastText(page, /primary/);
    await page.waitForTimeout(400);
    check('settings: Make primary moves the badge', (await api(null, 'GET', '/api/status')).json.theatres.find((t) => t.isPrimary).name === tname && await th.locator('.theatre-item', { hasText: tname }).locator('.tag', { hasText: 'Primary' }).count() === 1);
    await page.reload(); await settle(page, 600);
    check('settings: primary survives a reload', await card(page, 'Theaters').locator('.theatre-item').first().textContent().then((t) => t.includes(tname)));
    await card(page, 'Theaters').locator('.theatre-item', { hasText: primary.name }).locator('button', { hasText: 'Make primary' }).click();
    await toastText(page, /primary/);
    await page.waitForTimeout(400);
    await card(page, 'Theaters').locator('.theatre-item', { hasText: tname }).locator(`button[aria-label="Stop following ${tname}"]`).click();
    await page.locator('.modal-card button', { hasText: 'Stop following' }).click();
    await toastText(page, /Stopped following/);
    await page.waitForTimeout(400);
    const st2 = (await api(null, 'GET', '/api/status')).json;
    check('settings: unfollow puts the theatres back as they were', st2.theatres.length === nBefore && st2.theatres.find((t) => t.isPrimary).id === primary.id);
    const fc = card(page, 'Friends');
    await fc.locator('input[aria-label="Friend\'s name"]').fill('Pal');
    await fc.locator('button', { hasText: 'Create invite link' }).click();
    await page.waitForSelector('input[aria-label="Invite link for Pal"]', { timeout: 5000 }).catch(() => {});
    const link1 = await page.locator('input[aria-label="Invite link for Pal"]').inputValue().catch(() => '');
    check('settings: create shows a one-time invite link', /\/\?invite=[\w-]{20,}/.test(link1), link1.replace(/invite=.*/, 'invite=…'));
    check('settings: the new friend is listed as invite not used', /Invite not used yet/.test(await fc.locator('.theatre-item', { hasText: 'Pal' }).textContent()));
    await fc.locator('button[aria-label="New link for Pal"]').click();
    await toastText(page, /New link for Pal/);
    const link2 = await page.locator('input[aria-label="Invite link for Pal"]').inputValue().catch(() => '');
    check('settings: New link gives a different link', link2 && link2 !== link1);
    await fc.locator('button[aria-label="Revoke Pal"]').click();
    await page.locator('.modal-card button', { hasText: /^Revoke$/ }).click();
    await toastText(page, /Revoked Pal/);
    await page.waitForTimeout(400);
    check('settings: revoked friend shows Revoked and only New link', await fc.locator('.theatre-item', { hasText: 'Pal' }).locator('.tag', { hasText: 'Revoked' }).count() === 1 && await fc.locator('button[aria-label="Revoke Pal"]').count() === 0);
    check('settings: a revoked link no longer opens the Join page', (await call(w.base, 'GET', new URL(link2).pathname + new URL(link2).search, { headers: GUEST })).status === 410);
    const n0 = (await api(null, 'GET', '/api/friends')).json.friends.length;
    await fc.locator('input[aria-label="Friend\'s name"]').fill('   ');
    await fc.locator('button', { hasText: 'Create invite link' }).click();
    await page.waitForTimeout(300);
    check('settings: an empty friend name creates nothing', (await api(null, 'GET', '/api/friends')).json.friends.length === n0);
    const diag = card(page, 'Schedule diagnostics');
    check('settings: Schedule diagnostics lists each theatre', await diag.count() === 0 || await diag.locator('tbody tr').count() >= 1);
    check('settings: Alerts card says what is failing or that all is well', /Everything is working|Failing now/.test(await card(page, 'Alerts').textContent()));
    check('settings: off-site backup stays hidden when not configured', await page.locator('.offsite').isHidden());
    const data = card(page, 'Data');
    const bkLink = data.locator('a', { hasText: 'Download latest backup' });
    const bkStatus = (await api(null, 'GET', '/api/status')).json.backup;
    if (bkStatus.last) {
      const [dl] = await Promise.all([page.waitForEvent('download'), bkLink.click()]);
      const head = fs.readFileSync(await dl.path()).subarray(0, 16).toString();
      check('settings: Download latest backup is a SQLite file', head.startsWith('SQLite format 3') && /\.db$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    } else check('settings: with no backup yet, no download link', await bkLink.count() === 0);
    const [csvDl] = await Promise.all([page.waitForEvent('download'), data.locator('a', { hasText: 'Export backup CSV' }).click()]);
    const csv = fs.readFileSync(await csvDl.path(), 'utf8');
    const ownerRatings = (await api(null, 'GET', '/api/ratings')).json.ratings.length;
    check('settings: Export backup CSV carries every rating', csv.startsWith('Type,tmdb_id,Title') && csv.split('\n').filter((l) => l.startsWith('rating,')).length === ownerRatings);
    const [stDl] = await Promise.all([page.waitForEvent('download'), data.locator('a', { hasText: 'Export full setup' }).click()]);
    const stFile = await stDl.path();
    const doc = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    check('settings: full setup export is a reelpicks-state JSON', doc.kind === 'reelpicks-state' && doc.profile.ratings.length === ownerRatings && /reelpicks-setup-\d{4}-\d{2}-\d{2}\.json/.test(stDl.suggestedFilename()));
    const stInput = data.locator('input[type=file]');
    await stInput.setInputFiles({ name: 'setup.json', mimeType: 'application/json', buffer: fs.readFileSync(stFile) });
    check('settings: importing the export says what it brought in', new RegExp(`Setup imported: ${ownerRatings} ratings`).test(await toastText(page, /Setup imported|error|valid/)));
    await page.waitForTimeout(2500);
    await stInput.setInputFiles({ name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
    check('settings: a broken setup file says it isn\'t valid JSON', /isn't valid JSON/.test(await toastText(page, /valid JSON/)));
    await stInput.setInputFiles({ name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    check('settings: a JSON that isn\'t a setup file is named', /Not a Reel Picks full-setup file/.test(await toastText(page, /full-setup/)));
    check('settings: import changed no rating count', (await api(null, 'GET', '/api/ratings')).json.ratings.length === ownerRatings);
    await go(page, w, '#/help', 600);
    await page.locator('button', { hasText: 'Replay tour' }).click();
    await page.waitForSelector('.tour-card', { timeout: 5000 }).catch(() => {});
    check('settings: Replay tour starts the tour', await page.locator('.tour-card').count() === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await api(null, 'PUT', '/api/settings', { tourDone: true, youNoteSeen: true });
    g.noErrors('settings', m0, [/400 POST \/api\/state/, /status of 400 \(Bad Request\) @\/#\/settings/]);
  });

  if (want('owner2')) await step('Owner tools (1280 dark): AMC matching Ignore, Restore with the You dot and Picks note, Fix match, Refresh, Stats tip Apply', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'dark');
    const dot = async () => (((await page.locator('.seg-item[data-name="you"]').getAttribute('aria-label')) || '').split('Settings:')[1] || '').match(/\d+/g)?.map(Number).reduce((a, b) => a + b, 0) || 0;
    await go(page, w, '#/settings', 800);
    const um = card(page, 'AMC title matching');
    await page.waitForSelector('.unmatched-row', { timeout: 8000 }).catch(() => {});
    const st = (await api(null, 'GET', '/api/status')).json;
    const st0 = st.counts;
    const missingKeys = Object.values(st.keys).filter((v) => !v).length;
    const dot0 = await dot();
    check('matching: the You tab counts missing keys, unmatched and review items', dot0 === st0.unmatchedAmc + st0.reviewAmc + missingKeys, `${dot0} vs ${st0.unmatchedAmc}+${st0.reviewAmc}+${missingKeys}`);
    check('matching: the made-up unmatched AMC title is listed', st0.unmatchedAmc === 1 && /Mystery Screening Night/.test(await um.textContent()), `${st0.unmatchedAmc}`);
    if (st0.unmatchedAmc) {
      const row = um.locator('.unmatched-row:not(.review):not(.ignored)').first();
      await row.locator('button', { hasText: 'Ignore' }).click();
      await toastText(page, /Ignoring/);
      await page.waitForTimeout(600);
      const st1 = (await api(null, 'GET', '/api/status')).json.counts;
      check('matching: Ignore takes it off the unmatched count', st1.unmatchedAmc === st0.unmatchedAmc - 1);
      check('matching: the You dot follows', await dot() === dot0 - 1, `${await dot()}`);
      check('matching: it is listed under ignored', /1 ignored/.test(await um.textContent()));
      await go(page, w, '#/home', 500);
      const note = await page.locator('.note', { hasText: 'missing from this list' }).textContent().catch(() => '');
      check('matching: Picks note counts the rest', st1.unmatchedAmc ? note.startsWith(`${st1.unmatchedAmc} AMC title`) : !note, note);
      await go(page, w, '#/settings', 800);
      await page.locator('details.log summary', { hasText: 'ignored' }).click();
      await card(page, 'AMC title matching').locator('.unmatched-row.ignored button', { hasText: 'Restore' }).first().click();
      await toastText(page, /retry matching/);
      await page.waitForTimeout(600);
      check('matching: Restore puts it back', (await api(null, 'GET', '/api/status')).json.counts.unmatchedAmc === st0.unmatchedAmc);
      await go(page, w, '#/home', 500);
      check('matching: Picks names the unmatched title count', /^1 AMC title/.test((await page.locator('.note', { hasText: 'missing from this list' }).textContent().catch(() => '')).trim()));
    }
    const r = await recs(null);
    await go(page, w, `#/movie/${r.weekly4[0].tmdb_id}`, 500);
    const fix = page.locator('.showtimes .match-fix', { hasText: 'Fix' });
    check('matching: an AMC-matched film offers Fix', await fix.count() === 1);
    if (await fix.count()) {
      await fix.click();
      await page.locator('.modal-card input[type=search]').fill(r.weekly4[0].title);
      await page.waitForSelector('.fix-results .fix-item', { timeout: 15000 }).catch(() => {});
      check('matching: Fix match searches TMDB', await page.locator('.fix-results .fix-item').count() > 0);
      await page.keyboard.press('Escape');
    }
    await go(page, w, '#/settings', 800);
    await page.locator('button', { hasText: 'Refresh now' }).click();
    check('refresh: Refresh now reports progress then Up to date', /Up to date/.test(await toastText(page, /Up to date|queued|error|Only/, 15000)));
    await go(page, w, '#/stats', 600);
    const tip = page.locator('.alert.tip');
    if (await tip.locator('button', { hasText: 'Apply' }).count()) {
      await tip.locator('button', { hasText: 'Apply' }).click();
      await toastText(page, /Weights updated/);
      const s = (await api(null, 'GET', '/api/settings')).json;
      await go(page, w, '#/settings', 600);
      const bal = await page.locator('input[type=range][aria-label^="Balance"]').inputValue();
      check('stats: Apply sets the Ranking balance Settings shows', String(Math.round(s.weightPublic * 100)) === bal, `${bal} vs ${s.weightPublic}`);
      await go(page, w, '#/stats', 600);
      const again = await page.locator('.alert.tip button', { hasText: 'Apply' }).count();
      check('stats: once applied, the tip stops offering the same weights', again === 0, `tip still offers Apply at weights ${s.weightPublic}/${s.weightTaste}`);
    }
    g.noErrors('owner2', m0);
  });

  if (want('notify')) await step('Notifications opt-in (owner 390 light, push stand-in) and a server with no VAPID keys', async () => {
    const m0 = g.mark();
    const { page, ctx } = await g.open(null, 390, 'light', { sw: true, clock: false });
    await ctx.grantPermissions(['notifications'], { origin: w.base });
    await ctx.addInitScript((endpoint) => {
      const fake = { endpoint, options: { applicationServerKey: null }, toJSON() { return { endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }; }, unsubscribe: async () => { localStorage.removeItem('fake-sub'); return true; } };
      PushManager.prototype.subscribe = async function (o) { fake.options.applicationServerKey = o.applicationServerKey; localStorage.setItem('fake-sub', '1'); return fake; };
      PushManager.prototype.getSubscription = async function () { return localStorage.getItem('fake-sub') ? fake : null; };
    }, `${w.push.origin}/push/device-1`);
    await go(page, w, '#/settings', 800, { fresh: true });
    const nc = card(page, 'Notifications');
    check('notify: card shows with VAPID keys set', await nc.count() === 1);
    // The weekly picks switch (the card also has Watchlist alerts).
    const sw = nc.getByRole('checkbox', { name: 'Notify me when my weekly picks are ready' });
    await page.waitForFunction(() => { const c = [...document.querySelectorAll('.settings-group')].find((x) => x.querySelector('.group-title')?.textContent === 'Notifications'); return c && !c.querySelector('input').disabled; }, null, { timeout: 12000 }).catch(() => {});
    check('notify: switch starts off', !(await sw.isChecked()));
    await sw.check();
    check('notify: turning on confirms', /You'll get a notification/.test(await toastText(page, /notification/)));
    check('notify: the subscription is stored for the owner', w.q1('SELECT COUNT(*) n FROM push_subs WHERE user_id = 1').n === 1);
    await page.reload(); await settle(page, 800);
    await page.waitForTimeout(1500);
    check('notify: switch is on after a reload', await card(page, 'Notifications').getByRole('checkbox', { name: 'Notify me when my weekly picks are ready' }).isChecked());
    check('notify: Alerts card counts the device', /Alerts also go to the device/.test(await card(page, 'Alerts').textContent()));
    await card(page, 'Notifications').getByRole('checkbox', { name: 'Notify me when my weekly picks are ready' }).uncheck();
    check('notify: turning off confirms', /off on this device/.test(await toastText(page, /off on this device/)));
    check('notify: the subscription is removed', w.q1('SELECT COUNT(*) n FROM push_subs WHERE user_id = 1').n === 0);
    const bare = S.world(await openWorld('function-bare'));
    try {
      const cfg = await bare.api('GET', '/api/push/config');
      check('notify: without VAPID, push/config says disabled', cfg.status === 200 && cfg.json.enabled === false);
      const bp = await openPage(browser, bare, { role: 'owner', width: 390, theme: 'light' });
      await go(bp.page, bare, '#/settings', 800);
      check('notify: without VAPID, no Notifications switch', await card(bp.page, 'Notifications').locator('input[type=checkbox]').count() === 0);
      check('notify: without VAPID, the Alerts card says push is off on this server', /Push notifications are off on this server/.test(await card(bp.page, 'Alerts').textContent()));
      check('notify: the bare server page raised no errors', !bp.errors.length, bp.errors.slice(0, 3).join(' || '));
      await bp.ctx.close();
    } finally { await bare.close(); }
    g.noErrors('notify', m0);
  });

  if (want('invite')) await step('Invite flow in the browser: new link, Join page (GET never redeems), redeem, revoke, new link', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'light');
    await go(page, w, '#/settings', 700);
    const fc = card(page, 'Friends');
    await fc.locator('input[aria-label="Friend\'s name"]').fill('Joiner');
    await fc.locator('button', { hasText: 'Create invite link' }).click();
    const link = await page.locator('input[aria-label="Invite link for Joiner"]').inputValue();
    const rel = new URL(link).pathname + new URL(link).search;
    const pending = async () => (await api(null, 'GET', '/api/friends')).json.friends.find((f) => f.name === 'Joiner')?.invite_pending;
    await call(w.base, 'GET', rel, { headers: { ...GUEST, 'user-agent': 'facebookexternalhit/1.1' } });
    await fetch(w.base + rel, { method: 'HEAD', headers: GUEST });
    check('invite: previews leave the invite unused', await pending() === true);
    const gp = await g.open('guest', 390, 'light');
    await gp.page.goto(w.base + rel);
    check('invite: the Join page shows a Join button', await gp.page.locator('form[action="/invite/join"] button', { hasText: 'Join' }).count() === 1);
    check('invite: opening the Join page redeems nothing', await pending() === true);
    check('invite: the Join page sets no cookie', !(await gp.ctx.cookies()).some((c) => c.name === 'rp_user'));
    await gp.page.locator('form[action="/invite/join"] button').click();
    await gp.page.waitForLoadState('load'); await settle(gp.page, 600);
    check('invite: Join signs in and opens the welcome setup', gp.page.url().endsWith('#/welcome') && /Welcome, Joiner/.test(await gp.page.locator('h1').first().textContent()), gp.page.url());
    check('invite: the invite is used now', await pending() === false);
    check('invite: the same link is dead after use', (await call(w.base, 'GET', rel, { headers: GUEST })).status === 410);
    const own = await g.open(null, 390, 'light');
    await own.page.goto(w.base + rel);
    await settle(own.page, 300);
    check('invite: the owner opening a link lands on Settings', own.page.url().endsWith('#/settings'), own.page.url());
    const x = await fetch(`${w.base}/invite/join`, { method: 'POST', redirect: 'manual', headers: { ...GUEST, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=abc' });
    check('invite: a cross-site Join POST is refused', x.status === 403);
    await page.reload(); await settle(page, 600);
    await card(page, 'Friends').locator('button[aria-label="Revoke Joiner"]').click();
    await page.locator('.modal-card button', { hasText: /^Revoke$/ }).click();
    await toastText(page, /Revoked/);
    await gp.page.goto(`${w.base}/#/home`); await gp.page.reload(); await settle(gp.page, 600);
    check('invite: a revoked friend sees the read-only guest view', /You're viewing/.test(await gp.page.locator('#guest-banner').textContent().catch(() => '')));
    await card(page, 'Friends').locator('button[aria-label="New link for Joiner"]').click();
    await toastText(page, /New link/);
    const link2 = await page.locator('input[aria-label="Invite link for Joiner"]').inputValue();
    await gp.page.goto(link2);
    check('invite: the new link opens the Join page', await gp.page.locator('form[action="/invite/join"] button').count() === 1);
    await gp.page.locator('form[action="/invite/join"] button').click();
    await gp.page.waitForLoadState('load'); await settle(gp.page, 600);
    check('invite: the friend is back in as Joiner', /Welcome, Joiner/.test(await gp.page.locator('h1').first().textContent().catch(() => '')) || (await api(null, 'GET', '/api/friends')).json.friends.find((f) => f.name === 'Joiner')?.invite_pending === false, gp.page.url());
    await gp.page.goto(link);
    check('invite: the first link shows the expired page', /expired|no longer|used/i.test(await gp.page.locator('body').textContent()));
    g.noErrors('invite', m0, [/410 GET \/\?invite=/, /status of 410 \(Gone\)/]);
  });

  if (want('tour')) await step('Owner tour from Help (1280 light): every step lights its element', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'light');
    await go(page, w, '#/help', 600);
    await page.locator('button', { hasText: 'Replay tour' }).click();
    await page.waitForSelector('.tour-card', { timeout: 5000 });
    const steps = [];
    for (let i = 0; i < 14; i++) {
      await page.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 15000 }).catch(() => {});
      steps.push(await page.evaluate(() => ({ count: document.querySelector('.tour-count')?.textContent, title: document.querySelector('.tour-title')?.textContent, spot: !document.querySelector('.tour-spot')?.hidden })));
      const btn = page.locator('.tour-next');
      if ((await btn.textContent()) === 'Done') { await btn.click(); break; }
      await btn.click();
    }
    const dark = steps.filter((s) => !s.spot).map((s) => `${s.count} ${s.title}`);
    check('tour: every owner tour step lights its element', !dark.length, dark.join('; '));
    check('tour: the owner tour has no Together step', !steps.some((s) => s.title === 'Together'));
    await page.waitForTimeout(500);
    check('tour: Done lands on Picks', page.url().endsWith('#/home'), page.url());
    g.noErrors('tour', m0);
  });

  if (want('smoke')) await step('Every page, every role, 390 light and 1280 dark: no broken text, no errors', async () => {
    const m0 = g.mark();
    const r = await recs(null);
    const movie = `#/movie/${r.weekly4[0].tmdb_id}`;
    const all = ['#/home', '#/schedule/leaving', '#/schedule/coming', '#/rate', '#/watchlist', '#/together', '#/stats', '#/settings', '#/help', '#/you', movie, `#/person/${C.PEOPLE.ada.id}`, '#/onboarding'];
    for (const [role, name, routes] of [[null, 'owner', all], [heavy, 'Robin', all], ['guest', 'guest', ['#/home', '#/schedule/leaving', '#/schedule/coming', movie, `#/person/${C.PEOPLE.ada.id}`]]]) {
      for (const [width, theme] of [[390, 'light'], [1280, 'dark']]) {
        const { page } = await g.open(role, width, theme);
        for (const h of routes) {
          await go(page, w, h, 120);
          const bad = await page.evaluate(() => (/Something went wrong|undefined|NaN|\[object Object\]/.test(document.querySelector('#main')?.innerText || '') ? document.querySelector('#main').innerText.match(/.{0,40}(Something went wrong|undefined|NaN|\[object Object\]).{0,40}/)?.[0] : null));
          check(`smoke ${name} ${width} ${theme} ${h}: no broken text`, !bad, bad);
        }
        await page.context().close();
      }
    }
    g.noErrors('smoke', m0);
  });

  if (want('cap')) await step('Friends cap (owner 390 light): the card says so when full', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 390, 'light');
    const { friends, max } = (await api(null, 'GET', '/api/friends')).json;
    for (let i = friends.length + 1; i < max - 1; i++) await api(null, 'POST', '/api/friends', { name: `Filler ${i}` });
    await go(page, w, '#/settings', 700);
    const fc = card(page, 'Friends');
    await fc.locator('input[aria-label="Friend\'s name"]').fill('Last one');
    await fc.locator('button', { hasText: 'Create invite link' }).click();
    await page.waitForSelector('input[aria-label="Invite link for Last one"]', { timeout: 8000 }).catch(() => {});
    check('cap: the last free place still works', await page.locator('input[aria-label="Invite link for Last one"]').count() === 1, `${(await api(null, 'GET', '/api/friends')).json.friends.length} friends of max ${max}`);
    await fc.locator('input[aria-label="Friend\'s name"]').fill('One too many');
    await fc.locator('button', { hasText: 'Create invite link' }).click();
    check('cap: past the cap, a clear message', new RegExp(`up to ${max} people`).test(await toastText(page, /people|error/)));
    g.noErrors('cap', m0, [/400 POST \/api\/friends/, /status of 400 \(Bad Request\) @\/#\/settings/]);
  });

  const out = g.outside();
  console.log(`group B done at ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  check('group B: no request left the machine from the browser', !out.length, out.slice(0, 5).join(', '));
  await g.closeAll();
  await w.close();
}

// =================================================================================
// Group C: search, the movie page, people, the welcome setup, imports,
// Letterboxd, the guest, error and empty states, owner extras.
async function groupC() {
  const lbFeed = C.CLASSICS.slice(10, 13).map((m, i) => ({ id: m.id, title: m.title, year: m.year, rating: [4, 3.5, 5][i], guid: `g${i}` }));
  const w = S.world(await openWorld('function-c', { letterboxd: { heavyfan: lbFeed, newfan: [] }, prepare: seedNell }));
  const g = group(w);
  const { api, recs } = g;
  const heavy = w.friends.robin;
  const casey = w.friends.casey;
  const jordan = w.friends.jordan;
  const primary = (await api(null, 'GET', '/api/status')).json.theatres.find((t) => t.isPrimary);

  if (want('schedule')) await step('Schedule: both segments, remembered segment, old addresses (owner, 1280 dark)', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'dark');
    await go(page, w, '#/schedule', 500);
    check('schedule: bare #/schedule lands on a segment address', /#\/schedule\/(leaving|coming)$/.test(page.url()), page.url());
    await go(page, w, '#/schedule/leaving', 500);
    check('schedule: Leaving draws its week', await page.locator('.lv-week').count() === 1);
    await page.locator('.segment[data-seg="coming"]').click();
    await settle(page, 400);
    check('schedule: Coming soon segment draws tiles', await page.locator('.tile-grid .tile').count() === C.UPCOMING.length, String(await page.locator('.tile-grid .tile').count()));
    check('schedule: Coming soon is marked current', await page.locator('.segment[data-seg="coming"][aria-current="page"]').count() === 1);
    await go(page, w, '#/home', 300);
    await go(page, w, '#/schedule', 400);
    check('schedule: the last segment is remembered', page.url().endsWith('#/schedule/coming'), page.url());
    await go(page, w, '#/leaving', 400);
    check('schedule: old #/leaving opens the Leaving segment', page.url().endsWith('#/schedule/leaving'), page.url());
    check('schedule: Schedule tab lit', await page.locator('.seg-item[data-name="schedule"].active').count() === 1);
    g.noErrors('schedule', m0);
  });

  if (want('search')) await step('Header search (owner 1280 light, Robin 390): results, keyboard, recents, remove, Clear all and Undo, privacy', async () => {
    const m0 = g.mark();
    await api(null, 'POST', '/api/search/recents/clear');
    const { page } = await g.open(null, 1280, 'light');
    await go(page, w, '#/home', 500);
    await page.keyboard.press('/');
    check('search: "/" opens the search sheet', await page.locator('.search-overlay .search-input').count() === 1);
    await page.locator('.search-input').fill('harbor');
    await page.waitForFunction(() => /\d+ results?/.test(document.querySelector('.search-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const n = await page.locator('.sr-row').count();
    check('search: results for "harbor"', n > 0, String(n));
    await page.keyboard.press('ArrowDown');
    const firstTitle = (await page.locator('.sr-row').first().locator('.sr-title').evaluate((e) => e.firstChild.nodeValue)).trim();
    await page.keyboard.press('Enter');
    await settle(page, 500);
    check('search: ArrowDown and Enter open the first result', page.url().includes('#/movie/') && (await page.locator('h1.hero-title').textContent()).trim() === firstTitle, page.url());
    await page.waitForTimeout(400);
    await page.locator('#search-btn').click();
    await page.waitForSelector('.recents-head', { timeout: 8000 }).catch(() => {});
    check('search: the query is in Recent searches', await page.locator('.recent-row .recent-text', { hasText: /^harbor$/ }).count() === 1);
    check('search: the film is in Recently viewed', await page.locator('.recent-row .recent-text', { hasText: new RegExp(`^${esc(firstTitle)}`) }).count() === 1, JSON.stringify(await page.locator('.recent-row .recent-text').allTextContents()));
    await page.locator('.recent-main', { hasText: /^harbor$/ }).click();
    await page.waitForFunction(() => /\d+ results?/.test(document.querySelector('.search-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    check('search: tapping a recent search runs it', await page.locator('.search-input').inputValue() === 'harbor' && await page.locator('.sr-row').count() > 0);
    await page.locator('.search-clear').click();
    await page.locator('.recent-x[aria-label^="Remove \\"harbor\\""]').click();
    await page.waitForTimeout(400);
    check('search: removing a recent search drops it', await page.locator('.recent-row .recent-text', { hasText: /^harbor$/ }).count() === 0);
    check('search: removal is saved', !(await api(null, 'GET', '/api/search/recents')).json.queries.some((q) => q.query === 'harbor'));
    await page.locator('.recents-clear').click();
    check('search: Clear all empties the list', await page.locator('.recent-row').count() === 0);
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await page.waitForTimeout(600);
    check('search: Undo brings recents back on screen', await page.locator('.recent-row .recent-text', { hasText: firstTitle }).count() === 1);
    check('search: Undo restores them on the server', (await api(null, 'GET', '/api/search/recents')).json.movies.some((m) => m.title === firstTitle));
    await page.locator('.search-input').fill('q');
    check('search: one letter says keep typing', /Keep typing/.test(await page.locator('.search-status').textContent()));
    await page.locator('.search-input').fill('qqzxvvq zzqqx');
    await page.waitForFunction(() => /No matches|results?/.test(document.querySelector('.search-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    check('search: nonsense says No matches', /No matches for/.test(await page.locator('.search-status').textContent()), await page.locator('.search-status').textContent());
    await page.locator('.search-wsw').click();
    await page.waitForTimeout(400);
    check('search: "Not sure?" opens What should I watch', await page.locator('.wsw').count() === 1 && await page.locator('.search-overlay').count() === 0);
    await page.keyboard.press('Escape');
    const hv = (await api(heavy, 'GET', '/api/search/recents')).json;
    check('search: a friend\'s recents never include the owner\'s', !hv.movies.some((m) => m.title === firstTitle) && !hv.queries.some((q) => q.query === 'harbor'));
    const fr = await g.open(heavy, 390, 'light');
    await go(fr.page, w, '#/home', 400);
    await fr.page.locator('#search-btn').click();
    await fr.page.waitForTimeout(800);
    check('search: the friend\'s sheet shows none of the owner\'s recents', await fr.page.locator('.recent-row .recent-text', { hasText: firstTitle }).count() === 0);
    await closeSearch(fr.page);
    check('search: guest gets a 403 from the search API', (await call(w.base, 'GET', '/api/search?q=harbor', { headers: GUEST })).status === 403);
    g.noErrors('search', m0);
  });

  if (want('sheet')) await step('Search sheet rows follow the API, people first (owner 1280 dark, Casey 390 light)', async () => {
    const m0 = g.mark();
    for (const [who, as, width, theme] of [['owner', null, 1280, 'dark'], ['Casey', casey, 390, 'light']]) {
      const { page } = await g.open(as, width, theme);
      await go(page, w, '#/home', 400);
      for (const q of ['quentin tarantino', 'june calloway', 'lantern']) {
        await typeSearch(page, q);
        const rows = await sheetRows(page);
        const a = (await api(as, 'GET', `/api/search?q=${encodeURIComponent(q)}`)).json;
        const want2 = [...(a.people || []).map((p) => ({ kind: 'person', id: p.id })), ...(a.results || []).map((f) => ({ kind: 'film', id: f.tmdb_id }))];
        check(`sheet: ${who}: "${q}" shows exactly the API's rows, people first`, want2.length > 0 && JSON.stringify(rows) === JSON.stringify(want2), `${JSON.stringify(rows).slice(0, 160)} vs ${JSON.stringify(want2).slice(0, 160)}`);
        if (a.people?.length) {
          const top = page.locator('.search-body > .sr-person').first();
          const label = await top.getAttribute('aria-label');
          check(`sheet: ${who}: "${q}" person row's accessible name says who and what`, label?.startsWith(`${a.people[0].name}, ${a.people[0].role}`), label);
          check(`sheet: ${who}: "${q}" person row has a photo slot and known-for titles`, await top.locator('.sr-face').count() === 1 && (await top.locator('.sr-known').textContent()).split(', ').length === a.people[0].knownFor.length);
        }
      }
      await closeSearch(page);
    }
    g.noErrors('sheet', m0);
  });

  if (want('movie')) await step('Movie page (owner 390 dark): trailer dialog, where to stream, add to calendar (.ics), guest view', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 390, 'dark');
    const withTrailer = C.PLAYING.find((f) => f.trailer);
    await go(page, w, `#/movie/${withTrailer.id}`, 500);
    const tbtn = page.locator('.detail-actions .btn', { hasText: 'Trailer' });
    check('movie: Trailer button on a film with a trailer', await tbtn.count() === 1);
    await tbtn.click();
    await page.waitForSelector('.trailer-overlay iframe', { timeout: 5000 }).catch(() => {});
    const src = await page.locator('.trailer-overlay iframe').getAttribute('src').catch(() => '');
    check('movie: trailer dialog embeds youtube-nocookie without autoplay', /youtube-nocookie\.com\/embed\//.test(src) && !/autoplay=1/.test(src), src);
    await page.locator('.trailer-overlay .modal-x').click();
    await page.waitForTimeout(400);
    check('movie: closing removes the player', await page.locator('.trailer-overlay').count() === 0);
    check('movie: focus returns to the Trailer button', await page.evaluate(() => document.activeElement?.textContent?.includes('Trailer')));
    const cal = page.locator('.showtimes .cal-btn').first();
    check('movie: showtimes have calendar buttons', await cal.count() === 1);
    if (await cal.count()) {
      const href = await cal.getAttribute('href');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), cal.click()]);
      const ics = fs.readFileSync(await dl.path(), 'utf8');
      const title = (await page.locator('h1.hero-title').textContent()).trim();
      check('movie: .ics file name ends in .ics', /\.ics$/.test(dl.suggestedFilename()), dl.suggestedFilename());
      check('movie: .ics is a valid VCALENDAR with one VEVENT', /^BEGIN:VCALENDAR\r\n/.test(ics) && /\r\nEND:VCALENDAR\r?\n?$/.test(ics) && (ics.match(/BEGIN:VEVENT/g) || []).length === 1 && /\r\nDTSTART[:;]/.test(ics) && /\r\nDTEND[:;]/.test(ics) && /\r\nUID:/.test(ics) && /\r\nDTSTAMP:/.test(ics), ics.slice(0, 200));
      check('movie: .ics names the film', ics.replace(/\r\n[ \t]/g, '').includes(title.replace(/([,;])/g, '\\$1')), title);
      check('movie: .ics lines are folded at 75 octets', ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
      const gg = await call(w.base, 'GET', href, { headers: GUEST });
      check('movie: the guest link can add to calendar too', gg.status === 200 && /text\/calendar/.test(gg.headers.get('content-type')));
      check('movie: a made-up showtime is a 404', (await call(w.base, 'GET', '/api/showtimes/nope-123/calendar.ics')).status === 404);
    }
    // Where to watch, on a film that isn't playing (a streaming one, then one
    // whose rent and buy offers are the same).
    const streamer = C.RATED.find((f) => f.id % 3 === 1);
    await go(page, w, `#/movie/${streamer.id}`, 800);
    await page.waitForFunction(() => document.querySelector('.stream-card:not([hidden])') || !document.querySelector('.stream-card'), null, { timeout: 20000 }).catch(() => {});
    const sc = page.locator('.stream-card');
    check('movie: "Where to watch" shows for a streaming film', await sc.count() === 1 && await sc.isVisible(), await sc.count() ? await sc.textContent() : 'no card');
    if (await sc.count()) check('movie: credits JustWatch', /Streaming data from JustWatch/.test(await sc.textContent()));
    check('movie: a film not playing says so', /Not playing at your theater/.test(await page.locator('.showtimes').textContent()));
    const renter = C.RATED.find((f) => f.id % 3 === 0);
    await go(page, w, `#/movie/${renter.id}`, 800);
    await page.waitForFunction(() => document.querySelector('.stream-card:not([hidden])'), null, { timeout: 20000 }).catch(() => {});
    check('movie: the same rent and buy offers merge into "Rent or buy"', /Rent or buy/.test(await page.locator('.stream-card').textContent().catch(() => '')), await page.locator('.stream-card').textContent().catch(() => 'no card'));
    const gp = await g.open('guest', 390, 'light');
    await go(gp.page, w, `#/movie/${withTrailer.id}`, 500);
    check('movie: guest sees no rating row or watchlist', await gp.page.locator('.rating-row').count() === 0 && await gp.page.locator('.detail-actions [aria-pressed]').count() === 0);
    check('movie: guest sees the match pill', /^\d+% match/.test((await gp.page.locator('.hero-line .match').textContent().catch(() => '')).trim()));
    g.noErrors('movie', m0);
  });

  if (want('trailer')) await step('Trailer dialog keyboard focus, with and without the one-time "Open You" toast (owner 390 dark)', async () => {
    const m0 = g.mark();
    const film = C.PLAYING.find((f) => f.trailer);
    for (const toastOn of [false, true]) {
      await api(null, 'PUT', '/api/settings', { youNoteSeen: !toastOn });
      const { page, ctx } = await g.open(null, 390, 'dark');
      await ctx.route(/youtube-nocookie\.com\/embed/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PLAYER }));
      await go(page, w, `#/movie/${film.id}`, 400);
      const label = toastOn ? 'with the toast' : 'without the toast';
      check(`trailer ${label}: the "Open You" toast is ${toastOn ? '' : 'not '}on screen`, (await page.locator('.toast', { hasText: 'now under You' }).count() === 1) === toastOn);
      await page.keyboard.press('Shift'); // keyboard modality
      await page.locator('.detail-actions button', { hasText: 'Trailer' }).focus();
      await page.evaluate(() => { window.__trig = document.activeElement; });
      await page.keyboard.press('Enter');
      await page.locator('.trailer-overlay [role=dialog]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(350);
      check(`trailer ${label}: focus moves into the dialog`, await page.evaluate(() => Boolean(document.querySelector('.trailer-overlay [role=dialog]')?.contains(document.activeElement))));
      const left = []; const noRing = [];
      for (const dir of ['Tab', 'Shift+Tab']) {
        for (let k = 0; k < 6; k++) {
          await page.keyboard.press(dir);
          // The app rings the player a moment after focus lands in it; wait for it.
          // Leaving the player, focus passes through the dialog's wrap-around
          // stop (or the page) before the app moves it on: wait until it settles.
          await page.waitForFunction(() => {
            const a = document.activeElement;
            if (!a || a === document.body || a.classList.contains('focus-wrap')) return false;
            return a.tagName !== 'IFRAME' || a.classList.contains('kb-focus');
          }, null, { timeout: 2000 }).catch(() => {});
          const s = await page.evaluate(() => { const a = document.activeElement; return { inside: Boolean(document.querySelector('.trailer-overlay [role=dialog]')?.contains(a)), frame: a?.tagName === 'IFRAME', ring: a?.classList.contains('kb-focus'), what: `${a?.tagName}.${a?.className}` }; });
          if (!s.inside) left.push(`${dir} #${k + 1} to ${s.what}`);
          if (s.frame && !s.ring) noRing.push(`${dir} #${k + 1}`);
        }
      }
      check(`trailer ${label}: Tab and Shift+Tab stay inside the dialog`, !left.length, left.join('; '));
      check(`trailer ${label}: the player shows a focus ring when tabbed into`, !noRing.length, noRing.join('; '));
      if (await page.evaluate(() => document.activeElement?.tagName === 'IFRAME')) await page.evaluate(() => document.querySelector('.trailer-overlay .modal-x')?.focus());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.trailer-overlay') && document.activeElement === window.__trig, null, { timeout: 3000 }).catch(() => {});
      const after = await page.evaluate(() => ({ open: Boolean(document.querySelector('.trailer-overlay')), back: document.activeElement === window.__trig }));
      check(`trailer ${label}: Escape closes it and focus returns to the Trailer button`, !after.open && after.back, JSON.stringify(after));
      await ctx.close();
    }
    await api(null, 'PUT', '/api/settings', { youNoteSeen: true });
    g.noErrors('trailer', m0);
  });

  if (want('person')) await step('Person pages (S3): sections, lists, order, the Directed / Acted switch', async () => {
    const m0 = g.mark();
    const theatres = ['9101', '9102'];
    const showing = new Set(w.q(`SELECT DISTINCT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ? AND theatre_id IN (${theatres.map(() => '?').join(',')})`, C.ymdLocal(new Date(C.T0_MS)), ...theatres).map((r) => r.tmdb_id));
    const mine = new Map(w.q('SELECT tmdb_id, rating FROM ratings WHERE user_id = 1').map((r) => [r.tmdb_id, r.rating]));
    const sameSet = (a, b) => a.length === b.length && [...a].every((x) => b.includes(x));
    const ids = (list) => list.map((f) => f.tmdb_id);
    // Expected lists from the catalog's own credits (a made-up world, so its
    // raw credits are the source of truth), for Ada Lindqvist (directs only)
    // and the seeded Nell Varga (directs and acts).
    const people = [
      { id: C.PEOPLE.ada.id, name: C.PEOPLE.ada.name, directed: C.credits(C.PEOPLE.ada).crew.map((c) => c.id), acted: [] },
      { id: NELL.id, name: NELL.name, directed: NELL_DIRECTED.map((f) => f.id), acted: NELL_ACTED.map((f) => f.id) },
    ];
    const { page } = await g.open(null, 390, 'light');
    for (const p of people) {
      const d = (await api(null, 'GET', `/api/person/${p.id}`)).json;
      const allIds = [...new Set([...p.directed, ...p.acted])];
      const wantPlaying = allIds.filter((id) => showing.has(id));
      const wantRated = allIds.filter((id) => mine.has(id) && !showing.has(id));
      const restD = p.directed.filter((id) => !showing.has(id) && !mine.has(id));
      const restA = p.acted.filter((id) => !showing.has(id) && !mine.has(id));
      check(`person ${p.name}: Playing now is exactly their films at the owner's theaters`, sameSet(ids(d.playing), wantPlaying), `${ids(d.playing)} vs ${wantPlaying}`);
      check(`person ${p.name}: You rated is exactly the owner's rated films of theirs, with the owner's stars`, sameSet(ids(d.rated), wantRated) && d.rated.every((f) => f.myRating === mine.get(f.tmdb_id)), `${ids(d.rated)} vs ${wantRated}`);
      check(`person ${p.name}: Directed and Acted hold exactly the rest`, sameSet(ids(d.directed), restD) && sameSet(ids([...d.acted, ...(d.actedSmaller || [])]), restA), `${ids(d.directed)} / ${ids(d.acted)}`);
      check(`person ${p.name}: most popular first`, [d.directed, d.acted].every((l) => l.every((f, i) => i === 0 || (l[i - 1].popularity ?? 0) >= (f.popularity ?? 0))));
      await go(page, w, `#/person/${p.id}`, 500);
      const s = await page.evaluate(() => ({
        h1: [...document.querySelectorAll('.person h1')].map((e) => e.textContent),
        h2: [...document.querySelectorAll('.person h2')].map((e) => e.textContent),
        toggle: [...document.querySelectorAll('.person-toggle button')].map((b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed') })),
      }));
      check(`person ${p.name}: one h1, the name`, s.h1.length === 1 && s.h1[0] === p.name, s.h1.join('|'));
      const order = ['Playing now', 'You rated', 'Films'].filter((t) => s.h2.includes(t));
      check(`person ${p.name}: sections in order Playing now, You rated, Films`, JSON.stringify(s.h2) === JSON.stringify(order) && s.h2.includes('Playing now') === Boolean(wantPlaying.length) && s.h2.includes('You rated') === Boolean(wantRated.length) && s.h2.includes('Films') === Boolean(restD.length || restA.length), s.h2.join(' > '));
      if (wantPlaying.length) {
        const hrefs = await page.locator('section[aria-labelledby=person-playing]').locator('a.more-link').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
        check(`person ${p.name}: each Playing now film links to its movie page`, sameSet(hrefs, wantPlaying.map((id) => `#/movie/${id}`)), hrefs.join(','));
      }
      const both = restD.length > 0 && restA.length > 0;
      check(`person ${p.name}: the Directed / Acted switch shows exactly when both have films (${both})`, (s.toggle.length === 2) === both, JSON.stringify(s.toggle));
      if (both) {
        for (const [lab, list] of [['Acted', d.acted], ['Directed', d.directed]]) {
          await page.locator('.person-toggle button', { hasText: lab }).click();
          await page.waitForTimeout(150);
          const st = await page.evaluate(() => ({
            shown: [...document.querySelectorAll('section[aria-labelledby=person-films] .person-films:not([hidden]) > li')].map((li) => Number((li.querySelector('a.more-link')?.getAttribute('href') || '').split('/').pop())),
            pressed: [...document.querySelectorAll('.person-toggle button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
          }));
          check(`person ${p.name}: ${lab} shows their ${lab.toLowerCase()} films, most popular first`, JSON.stringify(st.shown) === JSON.stringify(ids(list)) && st.pressed.some(([t, pr]) => t.startsWith(lab) && pr === 'true'), `${st.shown} vs ${ids(list)}`);
        }
      }
    }
    g.noErrors('person', m0);
  });

  if (want('personrate')) await step('Person page: rating and saving write only that user\'s rows, and a rated film moves up (S3)', async () => {
    const m0 = g.mark();
    const pid = NELL.id;
    const filmsRows = (pg) => pg.locator('section[aria-labelledby=person-films]').locator('.person-films:not([hidden]) > li');
    const youRated = (pg) => pg.evaluate(() => [...document.querySelectorAll('section[aria-labelledby=person-rated] .person-films > li')].map((li) => ({ id: Number((li.querySelector('a.more-link')?.getAttribute('href') || '').split('/').pop()), stars: li.querySelector('.stars.interactive')?.getAttribute('aria-valuenow') ?? null })));
    const o = await g.open(null, 390, 'dark');
    await go(o.page, w, `#/person/${pid}`, 500);
    const firstFilm = filmsRows(o.page).first();
    const fid = Number((await firstFilm.locator('a.more-link').getAttribute('href')).split('/').pop());
    const box = await firstFilm.locator('.stars.interactive').boundingBox();
    await o.page.mouse.click(box.x + box.width * 0.95, box.y + box.height / 2);
    await until(async () => w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', fid), 20000);
    await until(async () => (await youRated(o.page)).some((r) => r.id === fid), 20000);
    check('person owner: the tapped film is rated 5 in the owner\'s own row', w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', fid)?.rating === 5);
    const yr = await youRated(o.page);
    check('person owner: the film moved from Films up into You rated, with its stars', yr.some((r) => r.id === fid && r.stars === '5') && !(await filmsRows(o.page).locator(`a.more-link[href="#/movie/${fid}"]`).count()), JSON.stringify(yr));
    check('person owner: nobody else got a rating for it', w.q1('SELECT COUNT(*) n FROM ratings WHERE tmdb_id = ? AND user_id <> 1', fid).n === 0);
    await go(o.page, w, `#/person/${pid}`, 500);
    check('person owner: after a reload it is in You rated', (await youRated(o.page)).some((r) => r.id === fid && r.stars === '5'));
    await api(null, 'DELETE', `/api/ratings/${fid}`);
    const hv = await g.open(heavy, 390, 'light');
    await go(hv.page, w, `#/person/${pid}`, 500);
    const rows = filmsRows(hv.page);
    const wid = Number((await rows.nth(0).locator('a.more-link').getAttribute('href')).split('/').pop());
    const before = w.q1('SELECT COUNT(*) n FROM watchlist WHERE user_id = 1').n;
    await rows.nth(0).locator('.wl-btn').click();
    await until(async () => w.q1('SELECT 1 x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', heavy.id, wid), 20000);
    check('person friend: Save puts the film on the friend\'s own watchlist only', Boolean(w.q1('SELECT 1 x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', heavy.id, wid)) && w.q1('SELECT COUNT(*) n FROM watchlist WHERE user_id = 1').n === before && !w.q('SELECT 1 FROM watchlist WHERE user_id <> ? AND tmdb_id = ?', heavy.id, wid).length);
    // The row is written before the page has the answer: wait for the button.
    await rows.nth(0).locator('.wl-btn[aria-pressed="true"]').waitFor({ timeout: 5000 }).catch(() => {});
    check('person friend: the button says it is saved', await rows.nth(0).locator('.wl-btn').getAttribute('aria-pressed') === 'true');
    await rows.nth(0).locator('.wl-btn').click();
    await until(async () => !w.q1('SELECT 1 x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', heavy.id, wid), 20000);
    check('person friend: tapping again takes it off', !w.q1('SELECT 1 x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', heavy.id, wid));
    const rid = Number((await rows.nth(1).locator('a.more-link').getAttribute('href')).split('/').pop());
    await rows.nth(1).locator('.stars.interactive').focus();
    for (let i = 0; i < 7; i++) await hv.page.keyboard.press('ArrowRight');
    await hv.page.keyboard.press('Enter');
    await until(async () => w.q1('SELECT rating FROM ratings WHERE user_id = ? AND tmdb_id = ?', heavy.id, rid), 20000);
    check('person friend: rated 3.5 from the keyboard, in the friend\'s own row only', w.q1('SELECT rating FROM ratings WHERE user_id = ? AND tmdb_id = ?', heavy.id, rid)?.rating === 3.5 && !w.q('SELECT 1 FROM ratings WHERE user_id <> ? AND tmdb_id = ?', heavy.id, rid).length);
    await until(async () => (await youRated(hv.page)).some((r) => r.id === rid), 20000);
    check('person friend: the rated film moved up into the friend\'s You rated', (await youRated(hv.page)).some((r) => r.id === rid && r.stars === '3.5'));
    check('person friend: focus stays on a film\'s stars, not lost', await hv.page.evaluate(() => document.activeElement?.classList.contains('interactive') && document.activeElement.closest('.person-films') != null));
    await api(heavy, 'DELETE', `/api/ratings/${rid}`);
    const fr = await g.open(casey, 1280, 'dark');
    await go(fr.page, w, `#/person/${pid}`, 500);
    const h2 = await fr.page.evaluate(() => [...document.querySelectorAll('.person h2')].map((e) => e.textContent));
    check('person empty friend: the page shows Films and no You rated', h2.includes('Films') && !h2.includes('You rated'), h2.join('>'));
    const gp = await g.open('guest', 390, 'light');
    await go(gp.page, w, `#/person/${pid}`, 500);
    check('person guest: read only, no stars, no Save, no You rated', await gp.page.locator('.person .stars.interactive, .person .wl-btn').count() === 0 && !(await gp.page.evaluate(() => [...document.querySelectorAll('.person h2')].map((e) => e.textContent))).includes('You rated'));
    g.noErrors('personrate', m0);
  });

  if (want('movielinks')) await step('Movie page: director and cast link to their person pages (S5)', async () => {
    const m0 = g.mark();
    const films = w.q('SELECT tmdb_id, title, director, director_id, "cast" AS cast, cast_ids FROM movies WHERE playing = 1 AND director_id IS NOT NULL ORDER BY tmdb_id LIMIT 8')
      .map((m) => ({ ...m, cast: JSON.parse(m.cast || '[]').slice(0, 6), cast_ids: JSON.parse(m.cast_ids || '[]').slice(0, 6) }));
    check('movielinks: playing films with stored person ids to test', films.length >= 3, String(films.length));
    for (const [who, role, width, theme] of [['owner', null, 390, 'dark'], ['friend', casey, 1280, 'light']]) {
      const { page } = await g.open(role, width, theme);
      for (const m of films) {
        await go(page, w, `#/movie/${m.tmdb_id}`, 250);
        const lines = await page.locator('.about .credit-line').evaluateAll((els) => els.map((e) => ({
          label: e.querySelector('.credit-label')?.textContent,
          people: [...e.querySelectorAll('.person-link')].map((a) => ({ name: a.textContent, href: a.getAttribute('href') })),
        })));
        const dir = lines.find((l) => l.label === 'Directed by');
        const cast = lines.find((l) => l.label === 'Starring');
        check(`movielinks ${who}: ${m.title}: the director links to #/person/${m.director_id}`, dir?.people.length === 1 && dir.people[0].name === m.director && dir.people[0].href === `#/person/${m.director_id}`, JSON.stringify(dir));
        const exp = m.cast.map((name, i) => ({ name, href: m.cast_ids[i] ? `#/person/${m.cast_ids[i]}` : null }));
        check(`movielinks ${who}: ${m.title}: every billed actor links to their page, in billing order`, JSON.stringify(cast?.people || []) === JSON.stringify(exp), `${JSON.stringify(cast?.people).slice(0, 160)} vs ${JSON.stringify(exp).slice(0, 160)}`);
      }
      const m = films[0];
      for (const [nth, id, name] of [[0, m.director_id, m.director], [1, m.cast_ids[0], m.cast[0]]]) {
        await go(page, w, `#/movie/${m.tmdb_id}`, 250);
        await page.locator('.about .credit-line').nth(nth).locator('.person-link').first().click();
        await page.waitForFunction((pid) => location.hash === `#/person/${pid}` && document.querySelector('.person h1'), id, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(150);
        const h1 = await page.locator('.person h1').textContent().catch(() => null);
        check(`movielinks ${who}: tapping ${name} opens their person page`, new URL(page.url()).hash === `#/person/${id}` && h1 === name, `${page.url()} / ${h1}`);
      }
    }
    g.noErrors('movielinks', m0);
  });

  if (want('recents')) await step('Person search recents (S6): own Recently viewed only, reopen, Clear all and Undo, remove one', async () => {
    const m0 = g.mark();
    const me = await makeFriend(w.base, 'Rae');
    await api(me, 'PUT', '/api/settings', { tourDone: true, setupDone: true, youNoteSeen: true });
    const recents = async (u) => (await api(u, 'GET', '/api/search/recents')).json;
    const viewedOrder = (r) => [...r.movies.map((m) => ({ k: `movie:${m.tmdb_id}`, at: m.at })), ...r.people.map((p) => ({ k: `person:${p.id}`, at: p.at }))].sort((a, b) => b.at - a.at).map((x) => x.k);
    const sheetViewed = (pg) => pg.locator('.recent-row .recent-main').evaluateAll((els) => els.filter((e) => e.tagName === 'A').map((e) => e.getAttribute('href').replace('#/', '').replace('/', ':')));
    const ownBefore = await recents(null);
    const othBefore = await recents(casey);
    const { page } = await g.open(me, 390, 'light');
    await go(page, w, '#/home', 300);
    await typeSearch(page, 'june calloway');
    const row = page.locator('.search-body > .sr-person').first();
    const pid = Number((await row.getAttribute('href')).split('/').pop());
    await row.click();
    await page.waitForFunction((id) => location.hash === `#/person/${id}` && document.querySelector('.person h1'), pid, { timeout: 20000 }).catch(() => {});
    check('recents: tapping the person opens their page', new URL(page.url()).hash === `#/person/${pid}`);
    await until(async () => (await recents(me)).people.length, 10000);
    await typeSearch(page, 'lantern');
    const film = page.locator('.search-body > .sr-row').first();
    const fid = Number((await film.getAttribute('href')).split('/').pop());
    await film.click();
    await settle(page, 300);
    await until(async () => (await recents(me)).movies.length, 10000);
    const r = await recents(me);
    check('recents: the person is in the friend\'s recents with name, role and photo', r.people.length === 1 && r.people[0].id === pid && r.people[0].name === 'June Calloway' && r.people[0].role === 'Actor' && /^https:\/\/image\.tmdb\.org\//.test(r.people[0].photo || ''), JSON.stringify(r.people));
    check('recents: Recently viewed is newest first: the film, then the person', JSON.stringify(viewedOrder(r)) === JSON.stringify([`movie:${fid}`, `person:${pid}`]), viewedOrder(r).join(','));
    check('recents: the queries were kept too', ['june calloway', 'lantern'].every((q) => r.queries.some((x) => x.query === q)));
    check('recents: the owner and another friend see none of it', JSON.stringify(await recents(null)) === JSON.stringify(ownBefore) && JSON.stringify(await recents(casey)) === JSON.stringify(othBefore));
    await page.locator('#search-btn').click();
    await page.waitForSelector('.recent-row', { timeout: 5000 }).catch(() => {});
    check('recents: the sheet shows the film then the person under Recently viewed', JSON.stringify(await sheetViewed(page)) === JSON.stringify([`movie:${fid}`, `person:${pid}`]), (await sheetViewed(page)).join(','));
    const pr = page.locator('.recent-person');
    check('recents: the person\'s recent row names them and their role', (await pr.getAttribute('aria-label')) === 'June Calloway, Actor');
    await pr.click();
    await page.waitForFunction((id) => location.hash === `#/person/${id}` && document.querySelector('.person h1'), pid, { timeout: 20000 }).catch(() => {});
    check('recents: opening the person from recents opens their page', new URL(page.url()).hash === `#/person/${pid}`);
    await page.waitForTimeout(300);
    const before = await recents(me);
    check('recents: reopening from recents made the person the newest', JSON.stringify(viewedOrder(before)) === JSON.stringify([`person:${pid}`, `movie:${fid}`]), viewedOrder(before).join(','));
    await page.locator('#search-btn').click();
    await page.waitForSelector('.recents-clear', { timeout: 5000 });
    await page.locator('.recents-clear').click();
    await page.waitForTimeout(300);
    const cleared = await recents(me);
    check('recents: Clear all empties the friend\'s recents, people included', !cleared.people.length && !cleared.movies.length && !cleared.queries.length);
    await page.locator('.toast .toast-action, .toast button', { hasText: 'Undo' }).first().click();
    await until(async () => (await recents(me)).people.length, 10000);
    const back = await recents(me);
    check('recents: Undo brings the people back', JSON.stringify(back.people.map((p) => [p.id, p.name, p.role, p.photo])) === JSON.stringify(before.people.map((p) => [p.id, p.name, p.role, p.photo])));
    check('recents: Undo keeps films and people in their order', JSON.stringify(viewedOrder(back)) === JSON.stringify(viewedOrder(before)), `${viewedOrder(back)} vs ${viewedOrder(before)}`);
    check('recents: Undo brings the queries back in order', JSON.stringify(back.queries.map((q) => q.query)) === JSON.stringify(before.queries.map((q) => q.query)));
    await page.waitForTimeout(300);
    check('recents: the open sheet shows them again in the same order', JSON.stringify(await sheetViewed(page)) === JSON.stringify(viewedOrder(before)), (await sheetViewed(page)).join(','));
    await page.locator('.recent-row', { has: page.locator('.recent-person') }).locator('.recent-x').click();
    await page.waitForTimeout(400);
    const after = await recents(me);
    check('recents: removing the person takes only the person away', !after.people.length && after.movies.length === 1);
    await closeSearch(page);
    check('recents: the guest link can\'t read recents', (await call(w.base, 'GET', '/api/search/recents', { headers: GUEST })).status === 403);
    check('recents: the guest link can\'t write a person recent', (await call(w.base, 'POST', '/api/search/recents', { headers: GUEST, body: { person: { id: pid, name: 'June Calloway', role: 'Actor' } } })).status === 403);
    check('recents: a bad person recent is refused (400)', (await api(me, 'POST', '/api/search/recents', { person: { id: -1, name: 'x' } })).status === 400);
    const odd = await api(me, 'POST', '/api/search/recents', { person: { id: 5, name: 'Test Person', role: 'Wizard', photo: 'https://evil.example/x.jpg' } });
    check('recents: an unknown role and a photo off TMDB are not stored', odd.status === 200 && odd.json.people[0].role === null && odd.json.people[0].photo === null, JSON.stringify(odd.json?.people?.[0]));
    g.noErrors('recents', m0);
  });

  if (want('welcome')) await step('Welcome setup (Jordan, 390 dark): every step, then the friend tour, Help', async () => {
    const m0 = g.mark();
    const { page } = await g.open(jordan, 390, 'dark');
    await page.goto(`${w.base}/#/home`); await settle(page, 700);
    check('welcome: a new friend starts in the welcome setup', page.url().endsWith('#/welcome'), page.url());
    check('welcome: the header tabs step aside', await page.locator('.shell.in-setup').count() === 1);
    check('welcome: step 1 of 3', /Step 1 of 3/.test(await page.locator('.wc-step').textContent()));
    check('welcome: a new friend starts on their theater', /Your theater/.test(await page.locator('.wc-current').textContent()));
    const pickTheatre = async (q, exact) => {
      await page.locator('.welcome input[type=search]').fill(q);
      await page.locator('.welcome button', { hasText: 'Search' }).click();
      await page.waitForSelector('.wc-row button', { timeout: 10000 }).catch(() => {});
      const i = await page.locator('.wc-row').evaluateAll((rs, name) => rs.findIndex((r) => !name || r.querySelector('.wc-row-title')?.textContent === name), exact);
      await page.locator('.wc-row').nth(Math.max(0, i)).locator('button').click();
      return toastText(page, /is your theater/);
    };
    check('welcome: choosing another theater confirms it', /is your theater/.test(await pickTheatre('lakeview', null)));
    check('welcome: the choice is saved', /Lakeview/.test((await api(jordan, 'GET', '/api/status')).json.theatre?.name || ''));
    await pickTheatre('maple', primary.name);
    check('welcome: choosing shows "Your theater"', (await api(jordan, 'GET', '/api/status')).json.theatre.id === primary.id);
    await page.locator('.wc-foot button', { hasText: 'Next' }).click();
    check('welcome: step 2 of 3', /Step 2 of 3/.test(await page.locator('.wc-step').textContent()));
    const next = page.locator('.wc-foot button', { hasText: 'Next' });
    check('welcome: Next is off until 10 are rated', await next.isDisabled());
    await page.waitForSelector('.wc-tile', { timeout: 30000 }).catch(() => {});
    const tiles = page.locator('.wc-tile');
    check('welcome: well-known films to rate', await tiles.count() >= 10, String(await tiles.count()));
    const two = C.STREAMING.slice(0, 2);
    const lbCsv = (rows) => ['Date,Name,Year,Letterboxd URI,Rating', ...rows.map((r, i) => `2024-01-0${i + 1},"${r.title}",${r.year},https://boxd.it/x${i},${r.rating}`)].join('\n');
    await page.locator('.wc-import input[type=file]').setInputFiles({ name: 'ratings.csv', mimeType: 'text/csv', buffer: Buffer.from(lbCsv(two.map((m) => ({ title: m.title, year: m.year, rating: 4 })))) });
    await page.waitForFunction(() => /Imported|weren't changed/.test(document.querySelector('.wc-import-note')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
    check('welcome: importing ratings.csv in step 2 counts them', /Imported 2 ratings/.test(await page.locator('.wc-import-note').textContent()) && /2 rated/.test(await page.locator('.wc-count').textContent()), `${await page.locator('.wc-import-note').textContent()} / ${await page.locator('.wc-count').textContent()}`);
    for (let i = 0; i < 8; i++) { await rateStars(page, tiles.nth(i), [4, 3, 5, 2.5, 4.5, 3.5, 4, 5][i]); await page.waitForTimeout(250); }
    await page.waitForTimeout(500);
    check('welcome: counts to 10', /10 rated/.test(await page.locator('.wc-count').textContent()), await page.locator('.wc-count').textContent());
    check('welcome: Next turns on at 10', await next.isEnabled());
    check('welcome: the 10 ratings are saved', (await api(jordan, 'GET', '/api/ratings')).json.ratings.length === 10);
    await page.locator('.wc-foot button', { hasText: 'Back' }).click();
    check('welcome: Back goes to step 1', /Step 1 of 3/.test(await page.locator('.wc-step').textContent()));
    await page.locator('.wc-foot button', { hasText: 'Next' }).click();
    check('welcome: step 2 keeps the count', /10 rated/.test(await page.locator('.wc-count').textContent()));
    await next.click();
    check('welcome: step 3 of 3', /Step 3 of 3/.test(await page.locator('.wc-step').textContent()));
    await page.locator('.wc-foot button', { hasText: 'See my picks' }).click();
    await page.waitForSelector('.tour-card', { timeout: 15000 }).catch(() => {});
    check('welcome: finishing opens Picks', page.url().includes('#/home'));
    check('welcome: setupDone saved', (await api(jordan, 'GET', '/api/status')).json.setupDone === true);
    check('welcome: the tour starts on its own after the setup', await page.locator('.tour-card').count() === 1);
    const steps = [];
    for (let i = 0; i < 14; i++) {
      await page.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 15000 }).catch(() => {});
      steps.push(await page.evaluate(() => ({ count: document.querySelector('.tour-count')?.textContent, title: document.querySelector('.tour-title')?.textContent, text: document.querySelector('.tour-text')?.textContent, spot: !document.querySelector('.tour-spot')?.hidden, hash: location.hash })));
      const btn = page.locator('.tour-next');
      if ((await btn.textContent()) === 'Done') { await btn.click(); break; }
      await btn.click();
    }
    const dark = steps.filter((s) => !s.spot).map((s) => `${s.count} ${s.title} (${s.hash})`);
    check('welcome: every friend tour step lights its element', !dark.length, dark.join('; '));
    check('welcome: the friend tour points to Together under You', steps.some((s) => s.title === 'You' && /Together/.test(s.text || '')));
    await page.waitForTimeout(600);
    check('welcome: Done returns to Picks and saves tourDone', page.url().endsWith('#/home') && (await api(jordan, 'GET', '/api/status')).json.tourDone === true, page.url());
    await go(page, w, '#/help', 500);
    await page.locator('button', { hasText: 'Replay tour' }).click();
    await page.waitForSelector('.tour-card', { timeout: 5000 });
    await page.locator('.tour-next').click();
    await page.waitForFunction(() => /2 of/.test(document.querySelector('.tour-count')?.textContent || ''), null, { timeout: 8000 });
    await page.locator('.tour-back').click();
    await page.waitForFunction(() => /^1 of/.test(document.querySelector('.tour-count')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check('welcome: tour Back goes to step 1', /^1 of/.test(await page.locator('.tour-count').textContent()));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('welcome: Escape ends the tour', await page.locator('.tour-layer').count() === 0);
    g.noErrors('welcome', m0);
  });

  if (want('imports')) await step('Rate imports (friend "Importer", 390 light): Letterboxd, IMDb, backup CSV, malformed files', async () => {
    const m0 = g.mark();
    const imp = await makeFriend(w.base, 'Importer');
    await api(imp, 'PUT', '/api/settings', { setupDone: true, tourDone: true, youNoteSeen: true });
    const { page } = await g.open(imp, 390, 'light');
    await go(page, w, '#/rate', 500);
    await page.locator('button', { hasText: 'Show me how' }).click();
    const upload = async (name, text) => {
      await page.locator('input[type=file][accept=".csv,text/csv"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
      await page.waitForFunction(() => { const r = document.querySelector('.import-result'); return r && !r.hidden && !/Reading the file|Matching titles/.test(r.textContent); }, null, { timeout: 30000 }).catch(() => {});
      return page.locator('.import-result').textContent();
    };
    const c = C.CLASSICS.slice(0, 7);
    const lb = ['Date,Name,Year,Letterboxd URI,Rating', ...c.slice(0, 3).map((m, i) => `2024-01-0${i + 1},${m.title},${m.year},https://boxd.it/x${i},${[4, 2.5, 5][i]}`), '2024-02-02,Watched Only,2001,https://boxd.it/w,'].join('\n');
    let t = await upload('ratings.csv', lb);
    check('imports: Letterboxd ratings.csv imports 3', /3 ratings imported/.test(t), t);
    check('imports: the unrated row is reported as skipped', /1 row skipped/.test(t), t);
    await page.waitForFunction(() => document.querySelectorAll('#rating-list .rating-item').length === 3, null, { timeout: 8000 }).catch(() => {});
    check('imports: ratings land in the list', await page.locator('#rating-list .rating-item').count() === 3);
    const imdb = ['Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors',
      ...c.slice(3, 5).map((m, i) => `tt000000${i},${[8, 6][i]},2024-01-0${i + 1},"${m.title}",https://imdb.example,Movie,7,100,${m.year},Drama,1000,${m.year}-01-01,X`)].join('\n');
    t = await upload('imdb.csv', imdb);
    check('imports: IMDb export imports 2', /2 ratings imported/.test(t), t);
    check('imports: IMDb 8/10 became 4 stars', (await api(imp, 'GET', '/api/ratings')).json.ratings.some((r) => r.tmdb_id === c[3].id && r.rating === 4));
    const before = (await api(imp, 'GET', '/api/ratings')).json.ratings.length;
    t = await upload('letterboxd-export.zip', 'PK\u0003\u0004junk');
    check('imports: a .zip is refused by name', /whole ZIP/.test(t), t);
    t = await upload('watched.csv', 'Date,Name,Year,Letterboxd URI\n2024-01-01,The Ember,1980,https://boxd.it/a');
    check('imports: watched.csv is named as the wrong file', /watched\.csv or watchlist\.csv/.test(t), t);
    t = await upload('list.csv', 'Position,Const,Created,Modified,Description,Title\n1,tt0000001,2024,2024,,The Ember');
    check('imports: an IMDb list export is explained', /list or watchlist export/.test(t), t);
    t = await upload('notes.csv', 'hello,world\n1,2');
    check('imports: an unknown CSV is explained', /Could not detect/.test(t), t);
    t = await upload('empty.csv', '');
    check('imports: an empty file says the file is empty', /empty/i.test(t), t);
    t = await upload('ratings.csv', 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,The Ember,1980,https://boxd.it/a,');
    check('imports: a ratings.csv with no stars explains watched vs rated', /no ratings in it/.test(t) && /not the same as rating/.test(t), t);
    check('imports: failed imports change nothing', (await api(imp, 'GET', '/api/ratings')).json.ratings.length === before);
    const csv = (await call(w.base, 'GET', '/api/export', { headers: imp.headers })).text;
    check('imports: backup CSV has a header and every rating', csv.split('\n')[0].startsWith('Type,tmdb_id') && csv.split('\n').filter((l) => l.startsWith('rating,')).length === before, csv.split('\n').length);
    await api(imp, 'DELETE', `/api/ratings/${c[0].id}`);
    t = await upload('reel-picks-backup.csv', csv);
    check('imports: backup CSV restores ratings', new RegExp(`Restored ${before} rating`).test(t), t);
    check('imports: the deleted rating is back', (await api(imp, 'GET', '/api/ratings')).json.ratings.length === before);
    t = await upload('ratings.csv', 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Qqzx Vorpal Nonfilm Xyzzy,1901,https://boxd.it/q,3');
    check('imports: an unmatched title is reported as kept for retry', /couldn't be matched/.test(t) || /0 ratings imported/.test(t), t);
    g.noErrors('imports', m0, [/400 POST \/api\/ratings\/import/, /status of 400 \(Bad Request\) @\/#\/rate/]);
  });

  if (want('letterboxd')) await step('Letterboxd link and sync (Robin, Settings, 390 light; stand-in feed)', async () => {
    const m0 = g.mark();
    const { page } = await g.open(heavy, 390, 'light');
    await go(page, w, '#/settings', 600);
    const lbc = card(page, 'Letterboxd');
    check('letterboxd: starts Not linked', /Not linked/.test(await lbc.locator('.lb-status').textContent()));
    const before = (await api(heavy, 'GET', '/api/ratings')).json.ratings.length;
    await lbc.locator('input').fill('bad name!');
    await lbc.locator('button', { hasText: 'Save' }).click();
    check('letterboxd: an invalid name is refused with a message', /isn't a Letterboxd username/.test(await toastText(page, /Letterboxd username/)));
    await lbc.locator('input').fill('ghost');
    await lbc.locator('button', { hasText: 'Save' }).click();
    await page.waitForFunction(() => !/Syncing/.test(document.querySelector('.lb-status')?.textContent || ''), null, { timeout: 15000 });
    check('letterboxd: an unknown user says so', /no public profile called "ghost"/.test(await lbc.locator('.lb-status').textContent()), await lbc.locator('.lb-status').textContent());
    await lbc.locator('input').fill('https://letterboxd.com/heavyfan/');
    await lbc.locator('button', { hasText: 'Save' }).click();
    await page.waitForFunction(() => /Last synced/.test(document.querySelector('.lb-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const line = await lbc.locator('.lb-status').textContent();
    check('letterboxd: a pasted profile link links and syncs 3 films', /3 films added/.test(line), line);
    check('letterboxd: the name field shows the clean username', await lbc.locator('input').inputValue() === 'heavyfan');
    const after = (await api(heavy, 'GET', '/api/ratings')).json.ratings;
    check('letterboxd: synced ratings are in the ratings list', after.length === before + 3 && lbFeed.every((f) => after.some((r) => r.tmdb_id === f.id && r.source === 'letterboxd')));
    await go(page, w, '#/rate', 500);
    await page.locator('.filter-input').fill(lbFeed[0].title);
    await page.waitForTimeout(200);
    check('letterboxd: Rate list labels them Letterboxd', await page.locator(`#rating-list [data-rating-id="${lbFeed[0].id}"]`, { hasText: 'Letterboxd' }).count() === 1);
    await go(page, w, '#/stats', 500);
    check('letterboxd: synced watches never count as tickets (plan None)', await bigStat(page, 'ticket this week') === '0' || await bigStat(page, 'tickets this week') === '0', await page.locator('.stat-grid').first().textContent());
    await go(page, w, '#/settings', 600);
    await sleep(10500); // Sync now has a 10 s floor
    await card(page, 'Letterboxd').locator('button', { hasText: 'Sync now' }).click();
    await page.waitForFunction(() => /Last synced/.test(document.querySelector('.lb-status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);
    check('letterboxd: a second sync adds nothing twice', (await api(heavy, 'GET', '/api/ratings')).json.ratings.length === before + 3);
    await card(page, 'Letterboxd').locator('input').fill('');
    await card(page, 'Letterboxd').locator('button', { hasText: 'Save' }).click();
    await page.waitForTimeout(500);
    check('letterboxd: clearing the name unlinks', /Not linked/.test(await card(page, 'Letterboxd').locator('.lb-status').textContent()));
    await page.reload(); await settle(page, 600);
    check('letterboxd: unlinked survives a reload', /Not linked/.test(await card(page, 'Letterboxd').locator('.lb-status').textContent()));
    for (const m of lbFeed) await api(heavy, 'DELETE', `/api/ratings/${m.id}`);
    g.noErrors('letterboxd', m0, [/400 PUT \/api\/letterboxd/, /status of 400 \(Bad Request\) @\/#\/settings/]);
  });

  if (want('guest')) await step('Guest link (390 light, 1280 dark): banner, confined routes, read only', async () => {
    const m0 = g.mark();
    for (const [width, theme] of [[390, 'light'], [1280, 'dark']]) {
      const { page } = await g.open('guest', width, theme);
      await page.goto(`${w.base}/#/home`); await settle(page, 700);
      const banner = await page.locator('#guest-banner').textContent();
      check(`guest ${width}: banner names the owner`, new RegExp(`You're viewing ${C.OWNER_NAME}'s picks`).test(banner), banner);
      check(`guest ${width}: no search, help, settings or refresh`, await page.locator('#search-btn:visible, #help-btn:visible, #settings-btn:visible, #refresh-btn:visible').count() === 0);
      check(`guest ${width}: no You tab`, await page.locator('[data-name="you"]:visible').count() === 0);
      check(`guest ${width}: no What should I watch, At home or owner tools`, await page.locator('#wsw-btn, #at-home, .owner-tools, .not-for-me').count() === 0);
      check(`guest ${width}: picks drawn`, await page.locator('.hero-pick').count() === 1);
      for (const r of ['rate', 'watchlist', 'stats', 'settings', 'together', 'welcome', 'you']) {
        await go(page, w, `#/${r}`, 300);
        check(`guest ${width}: #/${r} sends the guest back to Picks`, page.url().endsWith('#/home'), page.url());
      }
      await go(page, w, '#/schedule/leaving', 400);
      check(`guest ${width}: Schedule works`, await page.locator('.lv-week').count() === 1);
    }
    const w1 = await call(w.base, 'POST', '/api/ratings', { headers: GUEST, body: { tmdb_id: 990001, rating: 5 } });
    const w2 = await call(w.base, 'PUT', '/api/settings', { headers: GUEST, body: { avgTicketPrice: 1 } });
    check('guest: writes are refused', w1.status === 403 && w2.status === 403);
    g.noErrors('guest', m0);
  });

  if (want('states')) await step('Not found, movie 404, error state, loading states, empty states (new friend "Empty")', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 390, 'light');
    await go(page, w, '#/nope', 300);
    check('states: unknown route says Page not found', /Page not found/.test(await page.locator('.empty-title').textContent()));
    await page.locator('.empty a', { hasText: 'Go to Picks' }).click();
    await settle(page, 400);
    check('states: Go to Picks works', page.url().endsWith('#/home'));
    await go(page, w, '#/movie/999999999', 400);
    check('states: a movie id TMDB doesn\'t know says Not found', /Not found/.test(await page.locator('.empty-title').textContent()) && /no movie at this address/.test(await page.locator('.empty-msg').textContent()));
    await go(page, w, '#/movie/abc', 400);
    check('states: a non-numeric movie id says Not found', /Not found/.test(await page.locator('.empty-title').textContent().catch(() => '')));
    await page.route('**/api/stats', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Stats are broken right now.' }) }));
    await go(page, w, '#/stats', 400);
    check('states: a failing API shows Something went wrong with its message', /Something went wrong/.test(await page.locator('.empty-title').textContent()) && /Stats are broken/.test(await page.locator('.empty-msg').textContent()));
    await page.unroute('**/api/stats');
    await page.locator('.empty button', { hasText: 'Retry' }).click();
    await settle(page, 500);
    check('states: Retry loads the page', await page.locator('.big-stat').count() > 0);
    await page.route('**/api/home-picks', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Home picks failed.' }) }));
    await go(page, w, '#/home', 500);
    check('states: At home failure is contained to its section', await page.locator('.hero-pick').count() === 1 && /Home picks failed/.test(await page.locator('#at-home').textContent()));
    await page.unroute('**/api/home-picks');
    await page.route('**/api/watchlist', async (r) => { await sleep(1500); await r.continue(); });
    await page.evaluate(() => { location.hash = '#/watchlist'; });
    await page.waitForTimeout(300);
    check('states: Watchlist shows its loading spinner', /Loading watchlist/.test(await page.locator('#main .spinner').textContent().catch(() => '')));
    await settle(page, 300);
    await page.unroute('**/api/watchlist');
    await page.route('**/api/recommendations', async (r) => { await sleep(1500); await r.continue(); });
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForTimeout(300);
    check('states: Picks shows its skeleton while loading', await page.locator('#main .skeleton').count() === 1);
    await settle(page, 300);
    await page.unroute('**/api/recommendations');
    const empty = await makeFriend(w.base, 'Empty');
    const e = await g.open(empty, 390, 'dark');
    await e.page.goto(`${w.base}/`); await settle(e.page, 600);
    await e.page.locator('.wc-skip').click();
    await settle(e.page, 600);
    check('states: Skip setup goes to Picks', e.page.url().includes('#/home'));
    await e.page.waitForSelector('.tour-card', { timeout: 8000 }).catch(() => {});
    if (await e.page.locator('.tour-card').count()) { await e.page.locator('.tour-skip').click(); await e.page.waitForTimeout(300); }
    await go(e.page, w, '#/rate', 500);
    check('states: Rate says No ratings yet', /No ratings yet/.test(await e.page.locator('#main').textContent()));
    await go(e.page, w, '#/watchlist', 500);
    check('states: Watchlist empty state', await e.page.locator('.empty-title', { hasText: 'Nothing saved yet' }).count() === 1);
    await go(e.page, w, '#/stats', 500);
    check('states: Stats invites rating', /No ratings yet/.test(await e.page.locator('#main').textContent()));
    await go(e.page, w, '#/together', 500);
    check('states: Together offers to switch on', await e.page.locator('.empty button', { hasText: /[Pp]lan movies with/ }).count() === 1);
    await e.page.locator('.empty button', { hasText: /[Pp]lan movies with/ }).click();
    await settle(e.page, 600);
    check('states: switching on shows the pair', /You and /.test(await e.page.locator('#main').textContent()));
    const others = (await api(null, 'GET', '/api/status')).json.theatres;
    await api(empty, 'POST', '/api/theatre', { id: '999001', name: 'AMC Nowhere 1', slug: 'amc-nowhere-1' });
    for (const t of others) await api(empty, 'DELETE', `/api/theatres/follow/${t.id}`);
    await go(e.page, w, '#/together', 600);
    check('states: Together with no shared theatre says so', /don't follow any of the same theaters/.test(await e.page.locator('#main').textContent()));
    await go(e.page, w, '#/home', 600);
    const noShow = await e.page.locator('#main').textContent();
    const refreshBtn = e.page.locator('#main button', { hasText: 'Refresh now' });
    if (await refreshBtn.count()) {
      await refreshBtn.click();
      const t = await toastText(e.page, /./);
      check('states: a friend at a theatre with no showtimes gets guidance, never a Refresh only the owner can run', false, `Picks says "${noShow.slice(0, 90)}"; tapping Refresh now gives "${t}"`);
    } else check('states: a friend at a theatre with no showtimes gets guidance, never a Refresh only the owner can run', /showtimes|theat/i.test(noShow), noShow.slice(0, 120));
    g.noErrors('states', m0, [/500 GET \/api\/(stats|home-picks)/, /status of 500 \(Internal Server Error\)/, /404 GET \/api\/movies\/(999999999|abc)/, /status of 404 \(Not Found\) @\/#\/movie/, /403 POST \/api\/refresh/, /status of 403 \(Forbidden\) @\/#\/home/]);
  });

  if (want('extras')) await step('Owner extras (1280 light): Book link, Last chance, At home setup, WSW needs services, cutoffs change Picks, Watchlist filter, Quick rate', async () => {
    const m0 = g.mark();
    const { page } = await g.open(null, 1280, 'light');
    await api(null, 'PUT', '/api/settings', { streamingServices: [] });
    let r = await recs(null);
    await go(page, w, '#/home', 600);
    const book = page.locator('.hero-actions a.btn.book');
    check('extras: hero Book opens AMC in a new tab', await book.count() === 1 && /^https:\/\//.test(await book.getAttribute('href')) && await book.getAttribute('target') === '_blank', await book.getAttribute('href').catch(() => 'no Book link'));
    check('extras: the owner has Last chance films to test', (r.lastChance || []).length > 0);
    if ((r.lastChance || []).length) {
      await page.locator('.section-link', { hasText: 'See the week' }).click();
      await settle(page, 400);
      check('extras: Last chance "See the week" opens Schedule, Leaving', page.url().endsWith('#/schedule/leaving'), page.url());
      await go(page, w, '#/home', 500);
    }
    check('extras: At home asks for services when none are chosen', /Staying in\?/.test(await page.locator('#at-home').textContent()));
    await page.locator('#wsw-btn').click();
    await page.locator('.wsw [data-answer="home"]').click();
    await page.locator('.wsw .wsw-skip').click();
    await page.locator('.wsw .wsw-skip').click();
    await page.waitForSelector('.wsw button:has-text("Choose your services")', { timeout: 10000 }).catch(() => {});
    check('extras: WSW at home with no services asks for them', await page.locator('.wsw button', { hasText: 'Choose your services' }).count() === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.locator('#at-home button', { hasText: 'Choose your services' }).click();
    const sheet = page.locator('.services-sheet');
    check('extras: Show my picks is off until a service is picked', await sheet.locator('button', { hasText: 'Show my picks' }).isDisabled());
    await sheet.locator('[data-service="netflix"]').click();
    await sheet.locator('button', { hasText: 'Show my picks' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#at-home .home-card').length === 4, null, { timeout: 30000 }).catch(() => {});
    check('extras: choosing Netflix fills At home with 4 picks', await page.locator('#at-home .home-card').count() === 4, (await page.locator('#at-home').textContent()).slice(0, 150));
    check('extras: the choice is saved', JSON.stringify((await api(null, 'GET', '/api/settings')).json.streamingServices) === '["netflix"]');
    await go(page, w, '#/settings', 600);
    check('extras: Settings shows the services chosen on Picks', await card(page, 'Streaming services').locator('[data-service="netflix"][aria-pressed="true"]').count() === 1);
    await go(page, w, '#/home', 600);
    await page.waitForFunction(() => document.querySelectorAll('#at-home .home-card').length === 4, null, { timeout: 30000 }).catch(() => {});
    const hc = page.locator('#at-home .home-card').first();
    const hcId = Number(await hc.getAttribute('data-id'));
    await hc.locator('.not-for-me').click();
    await toastText(page, /Hid /);
    await page.waitForTimeout(800);
    check('extras: an At home card hidden leaves the section', await page.locator(`#at-home .home-card[data-id="${hcId}"]`).count() === 0);
    await api(null, 'DELETE', `/api/hidden/${hcId}`);
    const worth0 = (r.worthSeeing || []).length;
    await api(null, 'PUT', '/api/settings', { goodMatchMinScore: 100, lastChanceMaxEntries: 1 });
    r = await recs(null);
    await go(page, w, '#/home', 600);
    check('extras: a 100 cutoff empties Also worth seeing', await page.locator('.worth-list .list-row').count() === (r.worthSeeing || []).length && (r.worthSeeing || []).length <= worth0 && (r.worthSeeing || []).length === 0, `${(r.worthSeeing || []).length}`);
    check('extras: Last chance cap of 1 shows at most 1', await page.locator('.lc-card').count() <= 1);
    await api(null, 'PUT', '/api/settings', { goodMatchMinScore: 75, lastChanceMaxEntries: 3 });
    await go(page, w, `#/movie/${r.weekly4[0].tmdb_id}`, 500);
    check('extras: A-List owner sees "Mark seen (A-List)"', (await page.locator('.seen-slot .btn').textContent()).trim() === 'Mark seen (A-List)');
    const ids = r.list.slice(0, 10).map((e) => e.tmdb_id);
    const hvWl = new Set((await api(heavy, 'GET', '/api/watchlist')).json.movies.map((m) => m.tmdb_id));
    for (const id of ids) if (!hvWl.has(id)) await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: id });
    const hp = await g.open(heavy, 390, 'light');
    await go(hp.page, w, '#/watchlist', 500);
    const f = hp.page.locator('.filter-input');
    check('extras: Watchlist gets a filter past 8 films', await f.count() === 1);
    await f.fill(r.list[3].title);
    await hp.page.waitForTimeout(150);
    const nShown = await hp.page.locator('.tile:not([hidden])').count();
    check('extras: Watchlist filter narrows the grid', nShown >= 1 && nShown < 10, String(nShown));
    for (const id of ids) if (!hvWl.has(id)) await api(heavy, 'POST', '/api/watchlist/toggle', { tmdb_id: id });
    const qr = await makeFriend(w.base, 'Quick');
    await api(qr, 'PUT', '/api/settings', { setupDone: true, tourDone: true, youNoteSeen: true });
    const q = await g.open(qr, 390, 'light');
    await q.page.goto(`${w.base}/#/onboarding`); await settle(q.page, 800);
    check('extras: Quick rate shows a film', await q.page.locator('.ob-card').count() === 1);
    await q.page.locator('.ob-star').nth(3).click();
    await q.page.locator('button', { hasText: /Haven.t seen/ }).click();
    await q.page.locator('.ob-star').nth(4).click();
    check('extras: Quick rate counts what was rated', /4 of \d+ · 2 rated/.test(await q.page.locator('.onboard .muted.small').first().textContent()), await q.page.locator('.onboard .muted.small').first().textContent());
    await q.page.locator('button', { hasText: 'Done, build my profile' }).click();
    await toastText(q.page, /Saved 2 ratings/);
    await settle(q.page, 500);
    check('extras: Quick rate saves and goes to Picks', (await api(qr, 'GET', '/api/ratings')).json.ratings.length === 2 && q.page.url().endsWith('#/home'));
    check('extras: the onboarding banner is gone after Quick rate', await q.page.locator('.banner-title', { hasText: 'Build your taste profile' }).count() === 0);
    await api(null, 'PUT', '/api/settings', { streamingServices: ['netflix'] });
    g.noErrors('extras', m0);
  });

  const out = g.outside();
  console.log(`group C done at ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  check('group C: no request left the machine from the browser', !out.length, out.slice(0, 5).join(', '));
  await g.closeAll();
  await w.close();
}

await Promise.all([groupA(), groupB(), groupC()].map((p) => p.catch((e) => check('a group of sections ran to the end', false, String(e?.stack || e).split('\n').slice(0, 4).join(' | ')))));
await browser.close();
S.finish();
