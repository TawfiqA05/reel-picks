// "What should I watch?" in the browser (js/wsw.js), on a fixed seed:
//
//   keep      the sheet keeps its place across a film visit: opening a
//             suggested film and coming back (Back, the back gesture in the
//             installed app at 390 in Chromium and WebKit, tapping Picks, the
//             trailer on the movie page) shows the same answers and the same
//             films, and "Show me 3 more" goes on from there; Start over, the
//             close button and 30 minutes end it; it is per person and per
//             device
//   score     each card reads "<match>% match · <public score>" with the
//             server's numbers
//   matrix    the owner, the 700-rating friend and a 3-rating friend at 320,
//             390 and 1280, light and dark: results with no layout, contrast,
//             tap or error findings and no sideways scroll; the guest has no
//             way in. RP_SHOTS_DIR saves a screenshot of each.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, settle } from '../lib/browser.mjs';
import { measure, contrastProbe, textPalette, waitDialog, ROUTES } from '../lib/ui-helpers.mjs';

const S = suite('wsw');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ONLY = process.env.WSW_ONLY ? new Set(process.env.WSW_ONLY.split(',')) : null;
const want = (k) => !ONLY || ONLY.has(k);
// Every film playing gets a trailer, so whichever film is suggested has one.
const w = S.world(await openWorld('wsw-ui', {
  env: { RP_WSW_SEED: 'wsw-ui' },
  prepare: (d) => { d.exec("UPDATE movies SET trailer_key = 'rp-trailer' WHERE trailer_key IS NULL OR trailer_key = ''"); },
}));
const F = w.friends;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const SCORE_RE = /^\d{1,3}% match · (RT \d{1,3}%|IMDb \d+\.\d|TMDB \d+\.\d|No scores yet)$/;

// The 3-rating friend: Casey (no ratings in the sample database) rates three.
await S.step('setup: a friend with 3 ratings', async () => {
  for (const [id, stars] of [[980001, 4], [980002, 3.5], [980003, 4.5]]) {
    const f = w.q1('SELECT title, year FROM movies WHERE tmdb_id = ?', id);
    await api(F.casey, 'POST', '/api/ratings', { tmdb_id: id, rating: stars, title: f.title, year: f.year });
  }
  S.check('setup: Casey has 3 ratings', w.q1('SELECT COUNT(*) n FROM ratings WHERE user_id = ?', F.casey.id).n === 3);
});

const browser = await launch();
const webkit = await launch('webkit');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

// A page; standalone: the installed iPhone app (as test/ui/iphone.mjs does it).
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

// Answers the three questions (a value, or null to skip) and waits for results.
async function answer(pg, [where, time, mood]) {
  await pg.locator('#wsw-btn').click();
  await waitDialog(pg);
  for (const a of [where, time, mood]) {
    if (a) await pg.locator(`.wsw [data-answer="${a}"]`).click();
    else await pg.locator('.wsw .wsw-skip').click();
  }
  await pg.waitForSelector('.wsw-film, .wsw-note', { timeout: 30000 });
  await pg.waitForTimeout(300);
}
// What the sheet is showing: the question step, or the heading and film ids.
const state = (pg) => pg.evaluate(() => {
  const s = document.querySelector('.wsw');
  if (!s) return { open: false };
  return {
    open: true, step: s.querySelector('.wsw-step')?.textContent || null, heading: s.querySelector('h3.wsw-q')?.textContent || null,
    films: [...s.querySelectorAll('.wsw-film')].map((e) => Number(e.dataset.id)),
  };
});
const waitSheet = (pg) => pg.waitForSelector('.modal-overlay.show .wsw', { timeout: 8000 }).then(() => true).catch(() => false);
const openFilm = async (pg, id) => {
  await pg.locator(`.wsw-film[data-id="${id}"] .pick-title`).click();
  await pg.waitForFunction((x) => location.hash === `#/movie/${x}` && document.querySelector('.detail'), id, { timeout: 15000 });
  await settle(pg, 300);
};
const same = (a, b) => b.open && !b.step && a.heading === b.heading && JSON.stringify(a.films) === JSON.stringify(b.films) && a.films.length > 0;
const desc = (s) => JSON.stringify(s);

// ============================================================ keep my place
if (want('keep')) {
  const ANSWERS = [['either', null, 'surprise'], ['theater', 'any', 'intense']];

  await S.step('keep: Back from the movie page (browser, 390)', async () => {
    for (const a of ANSWERS) {
      const p = await page('owner', 390, 'light');
      try {
        await go(p.page, w, '#/home', 400);
        await answer(p.page, a);
        const before = await state(p.page);
        await openFilm(p.page, before.films[0]);
        S.check(`keep: opening a film closes the sheet (${a.join('/')})`, !(await state(p.page)).open);
        await p.page.goBack();
        await waitSheet(p.page);
        await settle(p.page, 300);
        const after = await state(p.page);
        S.check(`keep: Back returns to the same answers and films (${a.join('/')})`, same(before, after), `${desc(before)} -> ${desc(after)}`);
        await shot(p.page, `keep-back-${a.join('-').replace(/null/g, 'skip')}`);
        // Show me 3 more goes on from the kept films.
        const more = p.page.locator('.wsw button', { hasText: 'Show me 3 more' });
        if (await more.isEnabled()) {
          await more.click();
          await p.page.waitForFunction((ids) => { const n = [...document.querySelectorAll('.wsw-film')].map((e) => Number(e.dataset.id)); return n.length && n.every((x) => !ids.includes(x)); }, before.films, { timeout: 15000 }).catch(() => {});
          const next = await state(p.page);
          S.check(`keep: Show me 3 more after coming back brings only new films (${a.join('/')})`, next.films.length > 0 && next.films.every((x) => !before.films.includes(x)), `${before.films} -> ${next.films}`);
        } else S.check(`keep: Show me 3 more after coming back brings only new films (${a.join('/')})`, (await state(p.page)).films.length > 0, 'disabled with nothing else passing');
        S.check(`keep: no console errors or failed requests (back, ${a.join('/')})`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
      } finally { await p.ctx.close(); }
    }
  });

  for (const [engineName, engine] of [['Chromium', browser], ['WebKit', webkit]]) {
    await S.step(`keep: the back gesture in the installed app (${engineName}, 390)`, async () => {
      const p = await page('owner', 390, 'dark', { standalone: true, engine });
      try {
        await go(p.page, w, '#/home', 400);
        S.check(`keep: the page runs as the installed app (${engineName})`, await p.page.evaluate(() => navigator.standalone === true && matchMedia('(display-mode: standalone)').matches));
        await answer(p.page, ANSWERS[0]);
        const before = await state(p.page);
        await openFilm(p.page, before.films[1] ?? before.films[0]);
        // The edge swipe is the history's back.
        await p.page.evaluate(() => history.back());
        await waitSheet(p.page);
        await settle(p.page, 300);
        const after = await state(p.page);
        S.check(`keep: the back gesture returns to the same results (${engineName})`, same(before, after), `${desc(before)} -> ${desc(after)}`);
        await shot(p.page, `keep-gesture-${engineName.toLowerCase()}`);
        S.check(`keep: no console errors or failed requests (gesture, ${engineName})`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
      } finally { await p.ctx.close(); }
    });
  }

  await S.step('keep: closing the movie page by tapping Picks, and the trailer', async () => {
    for (const standalone of [false, true]) {
      const tag = standalone ? 'installed app' : 'browser';
      const p = await page('owner', 390, 'light', { standalone });
      try {
        await go(p.page, w, '#/home', 400);
        await answer(p.page, ANSWERS[1]);
        const before = await state(p.page);
        await openFilm(p.page, before.films[0]);
        await p.page.locator('#bottom-nav .nav-item[data-name="home"]').click();
        await waitSheet(p.page);
        await settle(p.page, 300);
        const tapped = await state(p.page);
        S.check(`keep: tapping Picks from the movie page returns to the same results (${tag})`, same(before, tapped), `${desc(before)} -> ${desc(tapped)}`);
        // The trailer: open the film, play its trailer, close it, go back.
        await openFilm(p.page, before.films[before.films.length - 1]);
        await p.page.locator('.detail-actions button', { hasText: 'Trailer' }).click();
        await p.page.waitForSelector('.trailer-overlay.show iframe', { timeout: 8000 });
        await shot(p.page, `keep-trailer-${standalone ? 'app' : 'browser'}`);
        await p.page.locator('.trailer-overlay .modal-x').click();
        await p.page.waitForTimeout(400);
        S.check(`keep: closing the trailer leaves the movie page (${tag})`, /^#\/movie\//.test(await p.page.evaluate(() => location.hash)) && !(await state(p.page)).open);
        await p.page.goBack();
        await waitSheet(p.page);
        await settle(p.page, 300);
        const back = await state(p.page);
        S.check(`keep: back from the trailer's movie page returns to the same results (${tag})`, same(before, back), `${desc(before)} -> ${desc(back)}`);
        S.check(`keep: no console errors or failed requests (Picks and trailer, ${tag})`, !p.errors.length, p.errors.slice(0, 3).join(' || '));
      } finally { await p.ctx.close(); }
    }
  });

  await S.step('keep: Start over, the close button and 30 minutes end it', async () => {
    const p = await page('owner', 390, 'light');
    try {
      await go(p.page, w, '#/home', 400);
      // Start over.
      await answer(p.page, ANSWERS[0]);
      await p.page.locator('.wsw .wsw-restart').click();
      S.check('keep: Start over goes back to question 1', /^1 of 3$/.test((await state(p.page)).step || ''));
      await p.page.locator('.wsw [data-answer="either"]').click();
      await p.page.locator('.wsw .wsw-skip').click();
      await p.page.locator('.wsw [data-answer="surprise"]').click();
      await p.page.waitForSelector('.wsw-film', { timeout: 15000 });
      // The close button.
      await p.page.locator('.wsw-overlay .modal-x').click();
      await p.page.waitForTimeout(400);
      await p.page.locator('#wsw-btn').click();
      await waitDialog(p.page);
      S.check('keep: after the close button the sheet starts at question 1', /^1 of 3$/.test((await state(p.page)).step || ''), desc(await state(p.page)));
      await p.page.locator('.wsw-overlay .modal-x').click();
      await p.page.waitForTimeout(300);
      // 29 minutes on a film page: still kept.
      await answer(p.page, ANSWERS[0]);
      const before = await state(p.page);
      await openFilm(p.page, before.films[0]);
      await p.ctx.clock.fastForward('29:00');
      await p.page.goBack();
      S.check('keep: 29 minutes later it is still kept', await waitSheet(p.page) && same(before, await state(p.page)));
      // 31 minutes: gone.
      await openFilm(p.page, before.films[0]);
      await p.ctx.clock.fastForward('31:00');
      await p.page.goBack();
      await settle(p.page, 600);
      S.check('keep: 30 minutes after the last change it has ended (no sheet on return)', !(await state(p.page)).open);
      await p.page.locator('#wsw-btn').click();
      await waitDialog(p.page);
      S.check('keep: and the sheet starts at question 1', /^1 of 3$/.test((await state(p.page)).step || ''));
      S.check('keep: no console errors or failed requests (endings)', !p.errors.length, p.errors.slice(0, 3).join(' || '));
    } finally { await p.ctx.close(); }
  });

  await S.step('keep: per person, on this device only', async () => {
    const p = await page('owner', 390, 'light');
    try {
      await go(p.page, w, '#/home', 400);
      await answer(p.page, ANSWERS[0]);
      const before = await state(p.page);
      await openFilm(p.page, before.films[0]);
      const keys = await p.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rp-wsw:')));
      S.check('keep: the place is stored under the owner\'s id', JSON.stringify(keys) === '["rp-wsw:1"]', JSON.stringify(keys));
      // Another person signs in on this device.
      const [k, ...v] = F.robin.cookie.split('=');
      await p.ctx.addCookies([{ name: k, value: v.join('='), domain: 'localhost', path: '/' }]);
      await p.page.goto('about:blank');
      await p.page.goto(`${w.base}/#/home`);
      await settle(p.page, 500);
      S.check('keep: the page is now the other person\'s', await p.page.evaluate(async () => (await (await fetch('/api/status')).json()).user?.id) === F.robin.id);
      S.check('keep: the other person gets no sheet on Picks', !(await state(p.page)).open);
      await p.page.locator('#wsw-btn').click();
      await waitDialog(p.page);
      S.check('keep: and their sheet starts at question 1', /^1 of 3$/.test((await state(p.page)).step || ''), desc(await state(p.page)));
    } finally { await p.ctx.close(); }
    // The owner on another device.
    const q = await page('owner', 390, 'light');
    try {
      await go(q.page, w, '#/home', 400);
      await q.page.locator('#wsw-btn').click();
      await waitDialog(q.page);
      S.check('keep: the owner on another device starts at question 1', /^1 of 3$/.test((await state(q.page)).step || ''));
    } finally { await q.ctx.close(); }
  });

  await S.step('keep: what was done on the film page shows on the kept card', async () => {
    const p = await page('owner', 390, 'light');
    try {
      await go(p.page, w, '#/home', 400);
      await answer(p.page, ANSWERS[0]);
      const before = await state(p.page);
      const id = before.films[0];
      const was = await p.page.locator(`.wsw-film[data-id="${id}"] .wl-btn`).getAttribute('aria-pressed');
      await openFilm(p.page, id);
      await p.page.locator('.detail-actions .wl-btn').click();
      await p.page.waitForTimeout(500);
      await p.page.goBack();
      await waitSheet(p.page);
      await p.page.waitForTimeout(800);
      const now = await p.page.locator(`.wsw-film[data-id="${id}"] .wl-btn`).getAttribute('aria-pressed');
      S.check('keep: saving it on its page shows on the kept card', was !== now && now === String(was !== 'true'), `${was} -> ${now}`);
      await api(null, 'POST', '/api/watchlist/toggle', { tmdb_id: id });
    } finally { await p.ctx.close(); }
  });
}

// ============================================================ the score line
if (want('score')) {
  await S.step('score: each card reads "<match>% match · <public score>" with the server\'s numbers', async () => {
    for (const [who, role, as] of [['owner', 'owner', null], ['heavy', F.robin, F.robin]]) {
      const p = await page(role, 390, 'light');
      try {
        await go(p.page, w, '#/home', 400);
        const resp = p.page.waitForResponse((r) => r.url().endsWith('/api/suggest'));
        await answer(p.page, ['either', null, 'surprise']);
        const body = await (await resp).json();
        const cards = await p.page.evaluate(() => [...document.querySelectorAll('.wsw-film')].map((e) => ({ id: Number(e.dataset.id), score: e.querySelector('.wsw-score')?.textContent || '', pill: e.querySelector('.wsw-score .match')?.textContent || '' })));
        const recs = (await api(as, 'GET', '/api/recommendations')).json;
        const finals = new Map([...recs.list, ...recs.alsoNearby].map((e) => [e.tmdb_id, e.final]));
        S.check(`score: ${who} sees three cards`, cards.length === 3, String(cards.length));
        for (const c of cards) {
          const f = body.films.find((x) => x.tmdb_id === c.id);
          S.check(`score: ${who}'s card reads "<match>% match · <public score>"`, SCORE_RE.test(c.score), c.score);
          S.check(`score: ${who}'s card numbers are the server's`, f && c.score === `${f.final}% match · ${f.publicLine}` && (!finals.has(c.id) || finals.get(c.id) === f.final), `${c.score} vs ${f?.final} ${f?.publicLine} (picks ${finals.get(c.id)})`);
          S.check(`score: ${who}'s card leads with the usual match pill`, c.pill === `${body.films.find((x) => x.tmdb_id === c.id)?.final}% match`, c.pill);
        }
      } finally { await p.ctx.close(); }
    }
  });
}

// ============================================================ layout findings, inside the sheet
const NEW = '.wsw-overlay';
async function findings(pg, phone) {
  // Measured at rest: the pointer off anything (the last tap can leave it
  // over a card's button, which then shows its hover colours).
  await pg.mouse.move(1, 1);
  await pg.waitForTimeout(250);
  const palette = await textPalette(pg);
  const out = await pg.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES, scope: NEW });
  out.push(...(await pg.evaluate(contrastProbe, { scope: NEW })).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  const wide = await pg.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    if (document.scrollingElement.scrollWidth > vw + 1) bad.push({ kind: 'sideways', sel: 'html', detail: `${document.scrollingElement.scrollWidth} > ${vw}` });
    const body = document.querySelector('.wsw-overlay .modal-body');
    if (body && body.scrollWidth > body.clientWidth + 1) bad.push({ kind: 'sideways', sel: '.modal-body', detail: `${body.scrollWidth} > ${body.clientWidth}` });
    for (const e of document.querySelectorAll('.wsw-overlay .wsw *')) {
      const r = e.getBoundingClientRect();
      if (r.width && (r.right > vw + 1 || r.left < -1) && !e.closest('[hidden]')) bad.push({ kind: 'past-edge', sel: e.className?.toString?.() || e.tagName, detail: `${Math.round(r.left)}..${Math.round(r.right)} of ${vw}` });
    }
    return bad;
  });
  return [...out, ...wide];
}

// ============================================================ too few pass
if (want('relax')) {
  await S.step('relax: the sheet says so above the results, and says what to try when nothing fits', async () => {
    const x = S.world(await openWorld('wsw-ui-relax', {
      env: { RP_WSW_SEED: 'wsw-ui' },
      prepare: (d) => { d.exec(`UPDATE movies SET scores = '{"rt":72}', tmdb_rating = 6.6, tmdb_votes = 300 WHERE playing = 1`); },
    }));
    try {
      for (const [width, theme] of [[390, 'light'], [320, 'dark']]) {
        const p = await open(browser, x, { role: 'owner', width, theme });
        try {
          await go(p.page, x, '#/home', 400);
          await answer(p.page, ['theater', 'any', null]);
          const info = await p.page.evaluate(() => {
            const note = document.querySelector('.wsw .wsw-note');
            const list = document.querySelector('.wsw .wsw-list');
            return { note: note?.textContent || null, above: Boolean(note && list && (note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)), films: document.querySelectorAll('.wsw-film').length };
          });
          S.check(`relax: ${width} ${theme}: three films with the plain-words note above them`, info.films === 3 && info.above && info.note === 'Not much great in theaters. These are the closest.', JSON.stringify(info));
          const found = await findings(p.page, width <= 430);
          S.check(`relax: ${width} ${theme}: no layout, contrast, tap, sideways or error findings`, !found.length && !p.errors.length, [...found.map((f) => `${f.kind} ${f.sel} ${f.detail}`), ...p.errors].slice(0, 4).join(' || '));
          await shot(p.page, `relaxed-${width}-${theme}`);
        } finally { await p.ctx.close(); }
      }
      const d = x.db();
      try { d.exec(`UPDATE movies SET scores = '{"rt":50}', tmdb_rating = 5.0, tmdb_votes = 300 WHERE playing = 1`); } finally { d.close(); }
      const p = await open(browser, x, { role: 'owner', width: 390, theme: 'dark' });
      try {
        await go(p.page, x, '#/home', 400);
        await answer(p.page, ['theater', 'any', 'funny']);
        const note = await p.page.locator('.wsw .wsw-note').textContent().catch(() => null);
        S.check('relax: nothing at all says "Nothing fits right now. Try another mood or At home."', note === 'Nothing fits right now. Try another mood or At home.' && await p.page.locator('.wsw-film').count() === 0, note);
        S.check('relax: and Show me 3 more is off', await p.page.locator('.wsw button', { hasText: 'Show me 3 more' }).isDisabled());
        S.check('relax: no console errors or failed requests (nothing fits)', !p.errors.length, p.errors.slice(0, 3).join(' || '));
        await shot(p.page, 'nothing-fits-390-dark');
      } finally { await p.ctx.close(); }
    } finally { await x.close(); }
  });
}

// ============================================================ the matrix
if (want('matrix')) {
  const MEMBERS = [['owner', 'owner'], ['heavy', F.robin], ['three', F.casey]];
  for (const width of [320, 390, 1280]) {
    for (const theme of ['light', 'dark']) {
      await S.step(`matrix: ${width} ${theme}`, async () => {
        for (const [who, role] of MEMBERS) {
          const p = await page(role, width, theme);
          try {
            await go(p.page, w, '#/home', 400);
            await answer(p.page, ['either', null, 'surprise']);
            const st = await state(p.page);
            const scores = await p.page.locator('.wsw-film .wsw-score').allTextContents();
            S.check(`matrix: ${who} ${width} ${theme}: results, each with its match and public score`, st.films.length === 3 && scores.length === 3 && scores.every((x) => SCORE_RE.test(x)), `${st.films.length} films; ${scores.join(' / ')}`);
            const found = await findings(p.page, width <= 430);
            S.check(`matrix: ${who} ${width} ${theme}: no layout, contrast, tap, sideways or error findings`, !found.length && !p.errors.length && !p.outside.length, [...found.map((f) => `${f.kind} ${f.sel} ${f.detail}`), ...p.errors, ...p.outside].slice(0, 4).join(' || '));
            await shot(p.page, `results-${who}-${width}-${theme}`);
            await p.page.locator('.wsw-overlay .modal-body').evaluate((e) => { e.scrollTop = e.scrollHeight; });
            await p.page.waitForTimeout(200);
            await shot(p.page, `results-${who}-${width}-${theme}-end`);
          } finally { await p.ctx.close(); }
        }
        const g = await page('guest', width, theme);
        try {
          await go(g.page, w, '#/home', 400);
          const ways = await g.page.locator('#wsw-btn, .search-wsw').count();
          S.check(`matrix: guest ${width} ${theme}: no way into What should I watch?`, ways === 0, String(ways));
          S.check(`matrix: guest ${width} ${theme}: no console errors or failed requests`, !g.errors.length, g.errors.slice(0, 3).join(' || '));
          await shot(g.page, `guest-${width}-${theme}`);
        } finally { await g.ctx.close(); }
      });
    }
  }
}

await browser.close();
await webkit.close();
await w.close();
S.finish();
