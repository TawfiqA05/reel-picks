// How the Rate tab's "Your ratings" list looks (public/js/views/rate.js,
// public/css/pages.css), at 320, 390 and 1280 in light and dark:
//
//   posters   at least 51 px wide (half again main's 34), 2:3, the file asked
//             for at least twice as wide as drawn; a long title still has room
//             at 320; the phone grid, the note's indent and the row estimate
//             for rows past the first 60 follow the poster
//   x         a small grey x with no box, still a 44 x 44 tap area
//   stars     empty stars are outlines and filled ones solid gold, so the two
//             differ in shape, not colour alone; as big as main's on a touch
//             screen; stars elsewhere keep their look
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go } from '../lib/browser.mjs';
import { measure, contrastProbe, textPalette, realSizePosters, ROUTES, token, parse, ratio } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('ratelist');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const [F0, F1, F2, F3] = C.RATED;
const LONG = 'The Remarkable and Entirely Unlikely Voyage of the Lighthouse Keeper\'s Daughter';
const w = S.world(await openWorld('ratelist-ui', {
  prepare: (d) => {
    // Every rated film has a poster but one, one has a long title, one a note.
    d.prepare("UPDATE movies SET poster = 'https://image.tmdb.org/t/p/w342/rp-' || tmdb_id || '.jpg' WHERE tmdb_id IN (SELECT tmdb_id FROM ratings)").run();
    d.prepare('UPDATE movies SET poster = NULL WHERE tmdb_id = ?').run(F3.id);
    d.prepare('UPDATE ratings SET title = ? WHERE user_id = 1 AND tmdb_id = ?').run(LONG, F0.id);
    // Newest first: the long title, the note and the missing poster on top.
    const at = (i) => new Date(C.T0_MS + 864e5 - i * 60000).toISOString();
    [F0, F1, F3].forEach((f, i) => d.prepare('UPDATE ratings SET rated_at = ? WHERE user_id = 1 AND tmdb_id = ?').run(at(i), f.id));
    d.prepare('INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(1, ?, ?, NULL, ?, ?)')
      .run(F1.id, 'Saw it twice, the score carries it', 'app', at(0));
  },
}));
const F = w.friends;
const browser = await launch();
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
// Main's sizes for the list's stars: 26 on a touch screen, 18 with a mouse.
const MAIN_STARS = { 320: 26, 390: 26, 1280: 18 };

async function findings(page, phone, scope) {
  const palette = await textPalette(page);
  const out = await page.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES, scope });
  out.push(...(await page.evaluate(contrastProbe, { scope })).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  const vw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  if (vw[0] > vw[1] + 1) out.push({ kind: 'sideways', sel: 'html', detail: `${vw[0]} > ${vw[1]}` });
  return out;
}
const list = (f) => f.map((x) => `${x.kind} ${x.sel} ${x.detail}`).slice(0, 4).join(' || ');

async function openList(width, theme, role = 'owner') {
  const p = await open(browser, w, { role, width, theme });
  await realSizePosters(p.ctx);
  await go(p.page, w, '#/rate', 500);
  await p.page.waitForSelector('#rating-list .rating-item', { timeout: 15000 });
  await p.page.evaluate(() => { document.querySelector('#rating-list').scrollIntoView({ block: 'start' }); window.scrollBy(0, -140); });
  await p.page.waitForTimeout(300);
  await p.page.evaluate(() => Promise.all([...document.querySelectorAll('#rating-list .rating-item:nth-child(-n+8) img')].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; setTimeout(r, 5000); })))));
  return p;
}

// ------------------------------------------------------------------ posters
await S.step('posters: bigger, sharp, and a long title still has room', async () => {
  for (const width of [320, 390, 1280]) {
    for (const theme of ['light', 'dark']) {
      const tag = `${width} ${theme}`;
      const p = await openList(width, theme);
      const { page } = p;
      const m = await page.evaluate(() => [...document.querySelectorAll('#rating-list .rating-item:nth-child(-n+8) .ri-poster')].map((e) => {
        const r = e.getBoundingClientRect();
        return { img: e.tagName === 'IMG', w: r.width, h: r.height, file: Number((e.getAttribute('src') || '').match(/\/w(\d+)\//)?.[1] || 0), natural: e.naturalWidth || 0 };
      }));
      const imgs = m.filter((x) => x.img);
      S.check(`posters ${tag}: setup: posters and one missing in view`, imgs.length >= 6 && m.some((x) => !x.img), JSON.stringify(m.slice(0, 3)));
      S.check(`posters ${tag}: at least 51 px wide, 2:3`, m.every((x) => x.w >= 51 && Math.abs(x.h / x.w - 1.5) < 0.03), JSON.stringify(m.map((x) => `${x.w}x${x.h}`)));
      S.check(`posters ${tag}: the file asked for is at least twice the drawn width`, imgs.every((x) => x.file >= 2 * x.w && x.natural >= 2 * x.w), JSON.stringify(imgs.map((x) => `${x.w} drawn, w${x.file}, ${x.natural} loaded`)));
      // The long title: room to read, wraps whole, nothing cut.
      const t = await page.locator(`#rating-list [data-rating-id="${F0.id}"] .ri-title`).evaluate((a) => {
        const r = a.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(a).lineHeight) || 20;
        return { w: r.width, lines: Math.round(r.height / lh), cut: a.scrollWidth > a.clientWidth + 1, text: a.textContent };
      });
      S.check(`posters ${tag}: a long title keeps at least 150 px and wraps in full`, t.w >= 150 && !t.cut && t.lines <= 4, JSON.stringify(t));
      // The phone grid's first column is the poster; the note lines up under the title.
      const grid = await page.evaluate(() => {
        const row = document.querySelector('#rating-list .rating-item');
        const s = getComputedStyle(row);
        return { display: s.display, first: parseFloat(s.gridTemplateColumns.split(' ')[0]), poster: row.querySelector('.ri-poster').getBoundingClientRect().width };
      });
      if (width <= 480) S.check(`posters ${tag}: the phone grid's first column is the poster's width`, grid.display === 'grid' && Math.abs(grid.first - grid.poster) < 0.6, JSON.stringify(grid));
      const found = await findings(page, width <= 1024, '#rating-list');
      S.check(`posters ${tag}: no layout, contrast, tap or sideways findings in the list`, !found.length, list(found));
      await shot(page, `ratelist-${width}-${theme}`);
      S.check(`posters ${tag}: no console errors`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
      await p.ctx.close();
    }
  }
});

await S.step('posters: the note lines up under the title; rows past 60 are estimated at their real height', async () => {
  for (const width of [390, 1280]) {
    const tag = `${width}`;
    const p = await openList(width, 'light');
    const { page } = p;
    // Rate a film from the search: its row in the list gets "Add a note".
    const film = C.CLASSICS[4];
    await page.locator('.page > input.input.big').fill(film.title.replace(/^The /, ''));
    const res = page.locator('.search-row', { has: page.locator('.search-title', { hasText: film.title }) }).first();
    await res.waitFor({ timeout: 10000 });
    const sb = await res.locator('.stars-base').boundingBox();
    await page.mouse.click(sb.x + sb.width * 0.7 - 1, sb.y + sb.height / 2);
    await page.waitForSelector(`#rating-list [data-rating-id="${film.id}"] .note-add`, { timeout: 8000 }).catch(() => {});
    const al = await page.locator(`#rating-list [data-rating-id="${film.id}"]`).evaluate((row) => {
      const slot = row.querySelector('.note-slot'); const info = row.querySelector('.ri-info');
      if (!slot) return null;
      const s = getComputedStyle(slot);
      return { slot: slot.getBoundingClientRect().left + parseFloat(s.paddingLeft), add: row.querySelector('.note-add')?.getBoundingClientRect().left, title: info.getBoundingClientRect().left };
    });
    S.check(`posters ${tag}: "Add a note" starts where the title does`, al && Math.abs(al.slot - al.title) < 1.5, JSON.stringify(al));
    await w.api('DELETE', `/api/ratings/${film.id}`);
    await p.ctx.close();
    // Robin has 700 ratings: rows past the first 60 skip layout until scrolled to.
    const r = await openList(width, 'light', F.robin);
    await r.page.locator('.show-all').click();
    await r.page.waitForTimeout(300);
    const est = await r.page.evaluate(() => {
      const rows = [...document.querySelectorAll('#rating-list .rating-item')];
      const real = rows.slice(0, 60).filter((x) => !x.querySelector('.note-line, .note-slot:not([hidden])')).map((x) => x.getBoundingClientRect().height).sort((a, b) => a - b);
      const s = getComputedStyle(rows[60]);
      return { median: real[Math.floor(real.length / 2)], estimate: parseFloat(String(s.containIntrinsicHeight || s.containIntrinsicSize).replace('auto', '').trim()), cv: s.contentVisibility, n: rows.length };
    });
    S.check(`posters ${tag}: rows past 60 are estimated within 12 px of a real row`, est.cv === 'auto' && Math.abs(est.estimate - est.median) <= 12, JSON.stringify(est));
    await r.ctx.close();
  }
});

// ------------------------------------------------------------------ x
await S.step('x: a small grey x with no box, 44 x 44', async () => {
  for (const width of [390, 1280]) {
    for (const theme of ['light', 'dark']) {
      const tag = `${width} ${theme}`;
      const p = await openList(width, theme);
      const { page } = p;
      const muted = await token(page, 'muted');
      const x = page.locator(`#rating-list [data-rating-id="${F1.id}"] .ri-remove`);
      const look = async () => x.evaluate((b) => {
        const s = getComputedStyle(b); const r = b.getBoundingClientRect(); const svg = b.querySelector('svg').getBoundingClientRect();
        return { danger: b.classList.contains('danger'), bg: s.backgroundColor, border: parseFloat(s.borderTopWidth) && s.borderTopStyle !== 'none' ? s.borderTopColor : 'none', shadow: s.boxShadow, color: s.color, w: r.width, h: r.height, icon: svg.width };
      });
      const rest = await look();
      S.check(`x ${tag}: no soft red box`, !rest.danger && /rgba\(0, 0, 0, 0\)|transparent/.test(rest.bg) && (rest.border === 'none' || /rgba\(0, 0, 0, 0\)/.test(rest.border)) && rest.shadow === 'none', JSON.stringify(rest));
      S.check(`x ${tag}: a small grey x`, rest.icon < 18 && rest.icon >= 12 && rest.color === muted, JSON.stringify({ ...rest, muted }));
      S.check(`x ${tag}: still a 44 x 44 tap area`, Math.round(rest.w) === 44 && Math.round(rest.h) === 44, JSON.stringify(rest));
      if (width === 1280) {
        await x.hover();
        await page.waitForTimeout(200);
        const hov = await look();
        S.check(`x ${tag}: no box on hover either`, /rgba\(0, 0, 0, 0\)|transparent/.test(hov.bg), JSON.stringify(hov));
        await page.mouse.move(0, 0);
      }
      await p.ctx.close();
    }
  }
});

// ------------------------------------------------------------------ stars
await S.step('stars: empty ones are outlines, filled ones solid gold; as big as before', async () => {
  for (const width of [320, 390, 1280]) {
    for (const theme of ['light', 'dark']) {
      const tag = `${width} ${theme}`;
      const p = await openList(width, theme);
      const { page } = p;
      const gold = await token(page, 'gold');
      const st = await page.locator(`#rating-list [data-rating-id="${F2.id}"] .stars`).evaluate((wrap) => {
        const base = getComputedStyle(wrap.querySelector('.stars-base svg')); const fill = getComputedStyle(wrap.querySelector('.stars-fill svg'));
        let bg = null;
        for (let e = wrap; e && !bg; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)') bg = c; }
        return { baseFill: base.fill, baseStroke: base.stroke, baseWidth: parseFloat(base.strokeWidth), baseColor: base.color, fillFill: fill.fill, size: wrap.querySelector('.stars-base svg').getBoundingClientRect().height, bg: bg || getComputedStyle(document.body).backgroundColor };
      });
      const pal = await Promise.all(['muted', 'field-edge', 'text'].map((n) => token(page, n)));
      const strokeRatio = st.baseStroke === 'none' ? 0 : ratio(parse(st.baseStroke), parse(st.bg));
      S.check(`stars ${tag}: empty stars are outlines`, st.baseFill === 'none' && st.baseStroke !== 'none' && st.baseWidth >= 1.5, JSON.stringify(st));
      S.check(`stars ${tag}: the outline is a palette colour at 3:1 or more on the page`, pal.includes(st.baseStroke) && strokeRatio >= 3, `${st.baseStroke} on ${st.bg}: ${strokeRatio.toFixed(2)}:1`);
      S.check(`stars ${tag}: filled stars are solid gold`, st.fillFill === gold, `${st.fillFill} vs ${gold}`);
      S.check(`stars ${tag}: at least as big as on main (${MAIN_STARS[width]} px)`, st.size >= MAIN_STARS[width] - 0.5, String(st.size));
      if (width === 1280) {
        // Stars elsewhere keep their look: the search results' stars on Rate.
        await page.locator('.page > input.input.big').fill(C.CLASSICS[0].title.replace(/^The /, ''));
        await page.waitForSelector('.search-row .stars', { timeout: 10000 });
        const sr = await page.locator('.search-row .stars-base svg').first().evaluate((s) => getComputedStyle(s).fill);
        S.check(`stars ${tag}: the search results' empty stars are still solid`, sr !== 'none', sr);
        await page.locator('.page > input.input.big').fill('');
        await go(page, w, '#/stats', 600);
        await page.waitForSelector('.bar-row .stars', { timeout: 15000 });
        const stats = await page.locator('.bar-row .stars-base svg').first().evaluate((s) => getComputedStyle(s).fill);
        S.check(`stars ${tag}: the Stats stars are still solid`, stats !== 'none', stats);
      }
      await p.ctx.close();
    }
  }
});

await browser.close();
await w.close();
S.finish();
