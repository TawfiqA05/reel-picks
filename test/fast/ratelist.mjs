// The Rate tab's "Your ratings" list (public/js/views/rate.js), what pressing
// things does:
//
//   show      the stars only show my rating: no click, tap or key on them
//             changes or clears it, and they are not a slider or a tab stop;
//             pressing a row anywhere but the x or a note control opens the
//             film's page (the title link stretched over the row), where I
//             rate under "Your rating", and the list shows it after Back
//   remove    the x asks first in a confirm box; Cancel, Escape, the box's
//             close button and a tap outside keep the rating and its note and
//             put focus back on that row's x; Remove deletes both
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, toastText } from '../lib/browser.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('ratelist');
const [, F1, F2, F3, F4, F5, F6, F7, F8] = C.RATED; // the owner rated them all
const NOTE = 'Saw it twice, the score carries it';
const w = S.world(await openWorld('ratelist', {
  prepare: (d) => {
    d.prepare('INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(1, ?, ?, NULL, ?, ?)')
      .run(F1.id, NOTE, 'app', new Date(C.T0_MS).toISOString());
  },
}));
const browser = await launch();
const ratingOf = (id) => w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', id)?.rating ?? null;
const noteOf = (id) => w.q1('SELECT note FROM rating_notes WHERE user_id = 1 AND tmdb_id = ?', id)?.note ?? null;
const rowSel = (id) => `#rating-list [data-rating-id="${id}"]`;
const hash = (page) => page.evaluate(() => location.hash);
async function toRate(page) {
  if (await hash(page) !== '#/rate') await go(page, w, '#/rate', 400);
  await page.waitForSelector('#rating-list .rating-item', { timeout: 15000 });
}
// The middle of a row's stars, and a point `frac` of the way along them.
async function starsAt(page, id, frac = 0.5) {
  const stars = page.locator(`${rowSel(id)} .stars`);
  await stars.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const b = await page.locator(`${rowSel(id)} .stars-base`).boundingBox();
  return { x: b.x + b.width * frac, y: b.y + b.height / 2 };
}
const onFilm = async (page, id) => {
  await page.waitForFunction((want) => location.hash === want, `#/movie/${id}`, { timeout: 5000 }).catch(() => {});
  return await hash(page) === `#/movie/${id}`;
};

await S.step('show: the stars only show the rating, the row opens the film', async () => {
  for (const [width, theme] of [[1280, 'light'], [390, 'dark']]) {
    const touch = width < 1024;
    const tag = `${width} ${theme}`;
    const p = await open(browser, w, { role: 'owner', width, theme });
    const { page } = p;
    await toRate(page);
    const press = async (pt) => (touch ? page.touchscreen.tap(pt.x, pt.y) : page.mouse.click(pt.x, pt.y));

    // The stars are a picture of the rating, not a control.
    const kinds = await page.locator('#rating-list .stars').evaluateAll((els) => els.map((e) => ({ role: e.getAttribute('role'), tab: e.tabIndex, label: e.getAttribute('aria-label') })));
    S.check(`show ${tag}: no star row in the list is a slider or a tab stop`, kinds.length > 20 && kinds.every((k) => k.role !== 'slider' && k.tab < 0), JSON.stringify(kinds.slice(0, 2)));
    S.check(`show ${tag}: each star row is an image named by its value`, kinds.every((k) => k.role === 'img' && /^(\d(\.5)? stars?|Not rated)$/.test(k.label || '')), JSON.stringify(kinds.slice(0, 2)));

    // What sits on top of the stars is the row's title link (CSS, no handler).
    const top = await starsAt(page, F2.id);
    const hit = await page.evaluate(({ x, y, sel }) => { const e = document.elementFromPoint(x, y); const a = e?.closest('a'); return { link: a?.matches(`${sel} a.ri-title`) || false, href: a?.getAttribute('href') || null, what: e ? `${e.tagName}.${e.className?.baseVal ?? e.className}` : null }; }, { ...top, sel: rowSel(F2.id) });
    S.check(`show ${tag}: the row's title link lies over its stars`, hit.link && hit.href === `#/movie/${F2.id}`, JSON.stringify(hit));

    // A click or tap on the stars, low on the row.
    const before2 = ratingOf(F2.id);
    await press(await starsAt(page, F2.id, 0.15));
    S.check(`show ${tag}: ${touch ? 'a tap' : 'a click'} on a row's stars opens the film's page`, await onFilm(page, F2.id), await hash(page));
    await page.waitForTimeout(500);
    S.check(`show ${tag}: and leaves the rating as it was`, ratingOf(F2.id) === before2, `${before2} -> ${ratingOf(F2.id)}`);
    await page.goBack();
    await toRate(page);

    // On the star already set (on main that cleared the rating).
    const before3 = ratingOf(F3.id);
    await press(await starsAt(page, F3.id, before3 / 5 - 0.04));
    S.check(`show ${tag}: ${touch ? 'a tap' : 'a click'} on the star already set opens the film's page`, await onFilm(page, F3.id), await hash(page));
    await page.waitForTimeout(500);
    S.check(`show ${tag}: and the rating is still there, unchanged`, ratingOf(F3.id) === before3, `${before3} -> ${ratingOf(F3.id)}`);
    await page.goBack();
    await toRate(page);

    // Keys sent straight at the stars change nothing.
    const before4 = ratingOf(F4.id);
    await page.locator(`${rowSel(F4.id)} .stars`).evaluate((el) => {
      for (const key of ['ArrowRight', 'ArrowRight', 'Enter', 'Home', ' ', 'Delete', 'Backspace']) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    S.check(`show ${tag}: arrow keys, Enter, Space, Delete and Backspace on the stars change nothing`, ratingOf(F4.id) === before4 && await hash(page) === '#/rate', `${before4} -> ${ratingOf(F4.id)}`);

    // Elsewhere on the row: the poster, the empty space after the title, the note line.
    for (const [what, sel, at] of [['the poster', '.ri-poster', 'mid'], ['the space after the title', '.ri-info', 'right'], ['the note line', '.note-line', 'mid']]) {
      const id = what === 'the note line' ? F1.id : F5.id;
      const el = page.locator(`${rowSel(id)} ${sel}`).first();
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      await press({ x: at === 'right' ? b.x + b.width - 4 : b.x + b.width / 2, y: b.y + b.height / 2 });
      S.check(`show ${tag}: pressing ${what} opens the film's page`, await onFilm(page, id), await hash(page));
      await page.goBack();
      await toRate(page);
    }

    // The x is its own control: it never opens the film.
    const before6 = ratingOf(F6.id);
    await page.locator(`${rowSel(F6.id)} .ri-remove`).click();
    await page.waitForTimeout(500);
    S.check(`show ${tag}: the x does not open the film's page`, await hash(page) === '#/rate', await hash(page));
    if (await page.locator('.modal-overlay').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
    if (ratingOf(F6.id) == null) { await w.api('POST', '/api/ratings', { body: { tmdb_id: F6.id, rating: before6, title: F6.title, year: F6.year } }); await go(page, w, '#/schedule', 200); await toRate(page); }

    // A note control on a row: rate a film from the search, then "Add a note" on its row.
    const film = C.CLASSICS[2 + (width === 390 ? 1 : 0)];
    await page.locator('.page > input.input.big').fill(film.title.replace(/^The /, ''));
    const res = page.locator('.search-row', { has: page.locator('.search-title', { hasText: film.title }) }).first();
    await res.waitFor({ timeout: 10000 });
    S.check(`show ${tag}: the search results' stars are still a control`, await res.locator('.stars[role="slider"][tabindex="0"]').count() === 1);
    const sb = await res.locator('.stars-base').boundingBox();
    await press({ x: sb.x + sb.width * 0.8 - 1, y: sb.y + sb.height / 2 });
    await page.waitForSelector(`${rowSel(film.id)} .note-add`, { timeout: 8000 }).catch(() => {});
    S.check(`show ${tag}: a film rated from the search is rated (4 stars)`, ratingOf(film.id) === 4, String(ratingOf(film.id)));
    const add = page.locator(`${rowSel(film.id)} .note-add`);
    await add.scrollIntoViewIfNeeded();
    const ab = await add.boundingBox();
    await press({ x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 });
    await page.waitForTimeout(300);
    S.check(`show ${tag}: "Add a note" on a row opens its field, not the film`, await hash(page) === '#/rate' && await page.locator(`${rowSel(film.id)} .note-input`).isVisible());
    await page.keyboard.press('Escape');
    await w.api('DELETE', `/api/ratings/${film.id}`);
    S.check(`show ${tag}: no console errors`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await S.step('show: keyboard: Tab goes link, then the x; focus after a reload goes to a row\'s link', async () => {
  const p = await open(browser, w, { role: 'owner', width: 1280, theme: 'light' });
  const { page } = p;
  await toRate(page);
  const link = page.locator(`${rowSel(F7.id)} a.ri-title`);
  await link.focus();
  const ring = await link.evaluate((a) => {
    const row = a.closest('.rating-item').getBoundingClientRect();
    const own = getComputedStyle(a); const after = getComputedStyle(a, '::after');
    return { own: own.outlineStyle !== 'none' ? parseFloat(own.outlineWidth) : 0, after: after.outlineStyle !== 'none' ? parseFloat(after.outlineWidth) : 0, w: parseFloat(after.width), h: parseFloat(after.height), rw: row.width, rh: row.height };
  });
  // Focus by script is not :focus-visible in every engine; use the keyboard.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ringKb = await link.evaluate((a) => { const after = getComputedStyle(a, '::after'); const row = a.closest('.rating-item').getBoundingClientRect(); return { focused: document.activeElement === a, after: after.outlineStyle !== 'none' ? parseFloat(after.outlineWidth) : 0, w: parseFloat(after.width), h: parseFloat(after.height), rw: row.width, rh: row.height }; });
  S.check('keys: the focused row link rings the whole row', ringKb.focused && ringKb.after >= 2 && ringKb.w >= ringKb.rw - 1 && ringKb.h >= ringKb.rh - 1, JSON.stringify({ ring, ringKb }));
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => { const e = document.activeElement; return { x: e?.matches('.ri-remove') || false, inStars: Boolean(e?.closest('.stars')), row: e?.closest('[data-rating-id]')?.dataset.ratingId || null }; });
  S.check('keys: Tab from a row\'s link goes to its x, past the stars', next.x && !next.inStars && next.row === String(F7.id), JSON.stringify(next));
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  S.check('keys: Enter on the row link opens the film\'s page', await onFilm(page, F7.id), await hash(page));
  await page.goBack();
  await toRate(page);
  // Remove a rating from the keyboard; the list reloads.
  const order = await page.locator('#rating-list .rating-item').evaluateAll((els) => els.map((e) => e.dataset.ratingId));
  const after = order[order.indexOf(String(F8.id)) + 1];
  const before8 = ratingOf(F8.id);
  await page.locator(`${rowSel(F8.id)} .ri-remove`).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  if (await page.locator('.modal-overlay').count()) await page.locator('.modal-card .btn', { hasText: /^Remove$/ }).click();
  await page.waitForSelector(rowSel(F8.id), { state: 'detached', timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  const focus = await page.evaluate(() => { const e = document.activeElement; return { link: e?.matches('a.ri-title') || false, row: e?.closest('[data-rating-id]')?.dataset.ratingId || null, what: e ? `${e.tagName}.${e.className}` : null }; });
  S.check('keys: after the list reloads, focus is on the link of the row now in its place', focus.link && focus.row === after, JSON.stringify({ focus, after }));
  await w.api('POST', '/api/ratings', { body: { tmdb_id: F8.id, rating: before8, title: F8.title, year: F8.year } });
  S.check('keys: no console errors', !p.errors.length, p.errors.slice(0, 3).join(' | '));
  await p.ctx.close();
});

await S.step('show: a rating made on the film\'s page shows in the list after Back', async () => {
  for (const [width, theme] of [[1280, 'dark'], [390, 'light']]) {
    const tag = `${width} ${theme}`;
    const p = await open(browser, w, { role: 'owner', width, theme });
    const { page } = p;
    await toRate(page);
    const was = ratingOf(F5.id);
    const want = was === 2 ? 3 : 2;
    await page.locator(`${rowSel(F5.id)} a.ri-title`).click();
    S.check(`back ${tag}: the row's title opens the film's page`, await onFilm(page, F5.id), await hash(page));
    const stars = page.locator(`.stars[role="slider"][aria-label="Your rating of ${F5.title}"]`);
    await stars.waitFor({ timeout: 10000 });
    // The film's page draws its stars again once its details arrive.
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);
    await stars.scrollIntoViewIfNeeded();
    const b = await page.locator(`.stars[role="slider"][aria-label="Your rating of ${F5.title}"] .stars-base`).boundingBox();
    await page.mouse.click(b.x + b.width * (want / 5) - 1, b.y + b.height / 2);
    await toastText(page, /Rated/);
    await page.waitForTimeout(300);
    S.check(`back ${tag}: rated ${want} under "Your rating"`, ratingOf(F5.id) === want, String(ratingOf(F5.id)));
    await page.goBack();
    await toRate(page);
    const shown = await page.locator(`${rowSel(F5.id)} .stars-fill`).evaluate((e) => e.style.width);
    const label = await page.locator(`${rowSel(F5.id)} .stars`).getAttribute('aria-label');
    S.check(`back ${tag}: after Back the list shows the new rating`, shown === `${(want / 5) * 100}%` && label === `${want} stars`, `${shown} / ${label}`);
    await w.api('POST', '/api/ratings', { body: { tmdb_id: F5.id, rating: was, title: F5.title, year: F5.year } });
    S.check(`back ${tag}: no console errors`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await S.step('remove: the x asks first; each way out keeps the rating and its note; Remove deletes both', async () => {
  for (const [width, theme] of [[1280, 'light'], [390, 'dark']]) {
    const touch = width < 1024;
    const tag = `${width} ${theme}`;
    const p = await open(browser, w, { role: 'owner', width, theme });
    const { page } = p;
    await toRate(page);
    const was = ratingOf(F1.id);
    S.check(`remove ${tag}: setup: the film has a rating and a note`, was != null && noteOf(F1.id) === NOTE);
    const x = page.locator(`${rowSel(F1.id)} .ri-remove`);
    const openBox = async () => {
      await x.scrollIntoViewIfNeeded();
      if (touch) { const b = await x.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); } else await x.click();
      await page.waitForSelector('.modal-overlay.show .modal-card', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(450);
    };
    await openBox();
    S.check(`remove ${tag}: the x alone deletes nothing`, ratingOf(F1.id) === was && noteOf(F1.id) === NOTE, `${ratingOf(F1.id)} / ${noteOf(F1.id)}`);
    const box = page.locator('.modal-overlay.show .modal-card');
    S.check(`remove ${tag}: it opens a confirm box`, await box.count() === 1 && (await box.getAttribute('role')) === 'dialog');
    if (!await box.count()) { await p.ctx.close(); continue; }
    const words = await box.evaluate((c) => ({ head: c.querySelector('h3')?.textContent.trim(), lines: [...c.querySelectorAll('.modal-body p')].map((x) => x.textContent.trim()), buttons: [...c.querySelectorAll('.modal-body button')].map((b) => b.textContent.trim()) }));
    S.check(`remove ${tag}: the box has a heading`, words.head === 'Remove rating', JSON.stringify(words));
    S.check(`remove ${tag}: a sentence naming the film`, words.lines[0] === `Remove your rating of ${F1.title}?`, JSON.stringify(words));
    S.check(`remove ${tag}: one more line because the rating has a note`, words.lines.length === 2 && words.lines[1] === 'Your note on it is deleted too.', JSON.stringify(words));
    S.check(`remove ${tag}: Remove and Cancel`, JSON.stringify(words.buttons) === '["Remove","Cancel"]', JSON.stringify(words));
    const ways = [
      ['Cancel', async () => box.locator('.btn', { hasText: /^Cancel$/ }).click()],
      ['Escape', async () => page.keyboard.press('Escape')],
      ['the close button', async () => box.locator('.modal-x').click()],
      ['a tap outside', async () => (touch ? page.touchscreen.tap(6, 6) : page.mouse.click(6, 6))],
    ];
    for (const [i, [name, act]] of ways.entries()) {
      if (i) await openBox();
      await act();
      await page.waitForTimeout(450);
      const st = await page.evaluate((sel) => ({ open: document.querySelectorAll('.modal-overlay').length, x: Boolean(document.activeElement?.matches(`${sel} .ri-remove`)), hash: location.hash }), rowSel(F1.id));
      S.check(`remove ${tag}: ${name} closes the box and keeps the rating and its note`, !st.open && ratingOf(F1.id) === was && noteOf(F1.id) === NOTE && await page.locator(rowSel(F1.id)).count() === 1, JSON.stringify(st));
      S.check(`remove ${tag}: after ${name}, focus is back on that row's x`, st.x && st.hash === '#/rate', JSON.stringify(st));
    }
    // A rating with no note: no note line.
    await page.locator(`${rowSel(F2.id)} .ri-remove`).click();
    await page.waitForSelector('.modal-overlay.show .modal-card', { timeout: 5000 }).catch(() => {});
    const plain = await page.locator('.modal-overlay.show .modal-card').evaluate((c) => [...c.querySelectorAll('.modal-body p')].map((x) => x.textContent.trim()));
    S.check(`remove ${tag}: with no note, just the sentence`, JSON.stringify(plain) === JSON.stringify([`Remove your rating of ${F2.title}?`]), JSON.stringify(plain));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    // Remove.
    const total = (await w.api('GET', '/api/ratings')).json.ratings.length;
    await openBox();
    await box.locator('.btn', { hasText: /^Remove$/ }).click();
    await toastText(page, /Removed your rating/);
    await page.waitForTimeout(400);
    S.check(`remove ${tag}: Remove deletes the rating and its note`, ratingOf(F1.id) == null && noteOf(F1.id) == null, `${ratingOf(F1.id)} / ${noteOf(F1.id)}`);
    S.check(`remove ${tag}: the row goes and the total drops by one`, await page.locator(rowSel(F1.id)).count() === 0 && (await page.locator('.section-title', { has: page.locator('h2', { hasText: /^Your ratings$/ }) }).textContent()).includes(`${total - 1} total`));
    // Put it back for the next width.
    await w.api('POST', '/api/ratings', { body: { tmdb_id: F1.id, rating: was, title: F1.title, year: F1.year } });
    await w.api('PUT', `/api/ratings/${F1.id}/note`, { body: { note: NOTE } });
    S.check(`remove ${tag}: no console errors`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await browser.close();
await w.close();
S.finish();
