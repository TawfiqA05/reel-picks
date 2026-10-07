// Notes on ratings in the browser (public/js/notes.js):
//
//   movie     "Add a note" after the stars (no popup, never in the way of a
//             star tap); Save, Edit, Delete with Undo, Enter and Escape; an
//             HTML note is refused in place; a Letterboxd review cut short
//             opens in full
//   places    Rate (search and the list), a Stats sheet, a person page and
//             "Did you see it?" each offer "Add a note" after a rating; the
//             note is a short second line in Stats, the person page's You
//             rated and the Rate list
//   filters   Watchlist, Stats and Rate filters find a note's words
//   private   no one sees another person's note; the guest sees none
//   looks     owner, the 700-rating friend, the brand-new friend, the second
//             friend and the guest at 320, 390 and 1280, light and dark: no
//             layout, contrast, tap-size, font or console findings in the
//             note parts, no sideways scroll (RP_SHOTS_DIR saves screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, makeFriend } from '../lib/world.mjs';
import { launch, open, go, toastText, importFiles } from '../lib/browser.mjs';
import { measure, contrastProbe, textPalette, waitDialog, ROUTES } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('notes');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const [F0, F1, F2, F3, F4, F5] = C.RATED; // the owner rated them all; Robin the first 8
const P4 = C.PLAYING.find((f) => f.k === 4);
const LONG = `${'The lighthouse sequence is the best thing in it. '.repeat(10)}And then it ends.`;
const local = (s) => Date.parse(`${s}-04:00`);
const now = () => new Date(C.T0_MS).toISOString();

const w = S.world(await openWorld('notes-ui', {
  reqLog: true,
  prepare: (d) => {
    const note = d.prepare('INSERT INTO rating_notes(user_id, tmdb_id, note, full, source, updated_at) VALUES(?,?,?,?,?,?)');
    note.run(1, F3.id, `${LONG.slice(0, 200)}…`, `${LONG}\n\nSecond paragraph.`, 'letterboxd', now());
    note.run(1, F5.id, 'Keep an eye on the zebra crossing scene', null, 'app', now());
    note.run(2, F0.id, 'ROBINSECRET popcorn', null, 'app', now()); // Robin is user 2
    note.run(2, 90000000, 'The heron scene', null, 'app', now()); // one of Robin's 700, a Drama
    // More saved films than the filter's cutoff, one of them rated with a note.
    const wl = d.prepare('INSERT OR IGNORE INTO watchlist(user_id, tmdb_id, added_at) VALUES(1, ?, ?)');
    for (const f of [F5, ...C.PLAYING.slice(0, 9)]) wl.run(f.id, now());
    // "Did you see it?" for the owner.
    const ask = local('2026-09-23T10:00:00');
    d.prepare(`INSERT INTO plans(user_id, tmdb_id, showtime_id, theatre_id, theatre_name, date, start_local, start_epoch, title, created_at, remind_at, reminded_at, ask_at, asked_at, expires_at)
      VALUES(1, ?, 'past-1', '9101', 'AMC Maple Grove 12', '2026-09-22', '2026-09-22T20:10:00', ?, ?, '2026-09-22T12:00:00.000Z', ?, 'sent', ?, 'sent', ?)`)
      .run(P4.id, local('2026-09-22T20:10:00'), P4.title, local('2026-09-22T18:10:00'), ask, ask + 3 * 864e5);
  },
}));
const F = w.friends;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const rowOf = (uid, id) => w.q1('SELECT note, full, source FROM rating_notes WHERE user_id = ? AND tmdb_id = ?', uid, id);
const shot = async (p, name) => { if (SHOTS) await p.page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const browser = await launch();
// Taps a rater at `frac` of its width (0.9 is 4.5 stars), in view first.
async function tapStars(page, stars, frac) {
  await stars.scrollIntoViewIfNeeded();
  const b = await stars.boundingBox();
  await page.mouse.click(b.x + b.width * frac, b.y + b.height / 2);
}
const focusIs = (p, sel) => p.page.evaluate((s) => Boolean(document.activeElement?.matches?.(s)), sel);
const NOTE_PARTS = '.note-slot, .note-line';
const FONTS = ['IBM Plex Sans', 'Big Shoulders Display', 'IBM Plex Sans Fallback', 'Big Shoulders Display Fallback'];

S.check('setup: Robin is user 2', F.robin.id === 2);
// The brand-new friend has skipped the welcome setup and the tour.
await api(F.jordan, 'PUT', '/api/settings', { setupDone: true, tourDone: true, youNoteSeen: true });

// The layout rules, AA text, 44px taps and the two fonts inside the note
// parts, and no sideways scroll on the page.
async function findings(page, phone) {
  const palette = await textPalette(page);
  const out = await page.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES, scope: NOTE_PARTS });
  out.push(...(await page.evaluate(contrastProbe, { scope: NOTE_PARTS })).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  out.push(...await page.evaluate(({ scope, fonts }) => {
    const bad = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) bad.push({ kind: 'sideways', sel: 'html', detail: `${document.documentElement.scrollWidth} > ${vw}` });
    for (const el of document.querySelectorAll(scope)) {
      for (const e of [el, ...el.querySelectorAll('*')]) {
        const r = e.getBoundingClientRect();
        if (r.width && (r.right > vw + 1 || r.left < -1) && !e.closest('[hidden]')) bad.push({ kind: 'past-edge', sel: e.className?.toString?.() || e.tagName, detail: `${Math.round(r.left)}..${Math.round(r.right)} of ${vw}` });
        if (e.matches('button, a[href], input') && r.width && !e.closest('[hidden]') && (r.height < 44 || (r.width < 44 && !e.matches('input')))) bad.push({ kind: 'tap', sel: e.className?.toString?.(), detail: `${Math.round(r.width)}x${Math.round(r.height)}` });
        const ff = getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim();
        if (e.textContent.trim() && !fonts.includes(ff)) bad.push({ kind: 'font', sel: e.className?.toString?.() || e.tagName, detail: ff });
      }
    }
    return bad;
  }, { scope: NOTE_PARTS, fonts: FONTS }));
  return out;
}
const report = (tag, found, p) => S.check(`${tag}: no layout, contrast, tap, font, sideways or console findings`, !found.length && !p.errors.length, [...found.map((f) => `${f.kind} ${f.sel} ${f.detail}`), ...p.errors].slice(0, 4).join(' || '));

// ================================================================== movie page
await S.step('movie page: add, edit, delete, undo, keyboard, refusals', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light' });
  await go(p.page, w, `#/movie/${F1.id}`, 400);
  const add = p.page.locator('.rating-row + .note-slot .note-add');
  S.check('movie: a rated film shows "Add a note" under the stars', await add.count() === 1 && await p.page.locator('.note-input').count() === 0);
  S.check('movie: "Add a note" is named for the film', (await add.getAttribute('aria-label')) === `Add a note on ${F1.title}`);
  await add.click();
  S.check('movie: it opens a field in place (no dialog), focused', await p.page.locator('.modal-card').count() === 0 && await focusIs(p, '.note-input'));
  S.check('movie: the field says what it is for and how long it may be', (await p.page.locator('.note-input').getAttribute('aria-label')) === `Note on ${F1.title}` && await p.page.locator('.note-count').textContent() === '0/280' && (await p.page.locator('.note-input').getAttribute('maxlength')) === '280');
  await p.page.keyboard.type('<b>Loud</b> and proud');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(300);
  S.check('movie: HTML is refused in place, with a reason read out', /plain text/.test(await p.page.locator('.note-error').textContent()) && (await p.page.locator('.note-error').getAttribute('role')) === 'alert' && (await p.page.locator('.note-input').getAttribute('aria-invalid')) === 'true');
  S.check('movie: and nothing was saved', !rowOf(1, F1.id));
  await p.page.locator('.note-input').fill('The second act drags, the ending pays it off.');
  S.check('movie: the counter follows the text', await p.page.locator('.note-count').textContent() === '45/280');
  await p.page.keyboard.press('Enter');
  await p.page.waitForSelector('.note-text', { timeout: 5000 });
  S.check('movie: Enter saves; the note shows under the stars', await p.page.locator('.note-text').textContent() === 'The second act drags, the ending pays it off.' && rowOf(1, F1.id)?.note === 'The second act drags, the ending pays it off.');
  S.check('movie: with Edit and Delete, focus on Edit', await p.page.locator('.note-edit').count() === 1 && await p.page.locator('.note-delete').count() === 1 && await focusIs(p, '.note-edit'));
  await shot(p, 'note-movie-saved-owner-390-light');
  await p.page.locator('.note-edit').click();
  S.check('movie: Edit opens the field with the note in it', await p.page.locator('.note-input').inputValue() === 'The second act drags, the ending pays it off.');
  await p.page.keyboard.press('Escape');
  S.check('movie: Escape cancels, nothing changes, focus back on Edit', await p.page.locator('.note-input').count() === 0 && await focusIs(p, '.note-edit') && rowOf(1, F1.id).note === 'The second act drags, the ending pays it off.');
  await p.page.locator('.note-edit').click();
  await p.page.locator('.note-input').fill('Edited: worth it for the ending.');
  await p.page.locator('.note-save').click();
  await p.page.waitForTimeout(500);
  S.check('movie: Save keeps the edit', rowOf(1, F1.id)?.note === 'Edited: worth it for the ending.' && await p.page.locator('.note-text').textContent() === 'Edited: worth it for the ending.');
  await p.page.locator('.note-delete').click();
  await p.page.waitForTimeout(400);
  S.check('movie: Delete removes it and offers "Add a note", focused', !rowOf(1, F1.id)?.note && await focusIs(p, '.note-add'));
  S.check('movie: Delete says so with Undo', /Note deleted/.test(await toastText(p.page, /Note deleted/)));
  await p.page.locator('.toast-action', { hasText: 'Undo' }).click();
  await p.page.waitForTimeout(500);
  S.check('movie: Undo brings it back', rowOf(1, F1.id)?.note === 'Edited: worth it for the ending.' && await p.page.locator('.note-text').count() === 1);
  // Keyboard only, on another film.
  await go(p.page, w, `#/movie/${F2.id}`, 400);
  await p.page.locator('.note-add').focus();
  await p.page.keyboard.press('Enter');
  S.check('keys: Enter on "Add a note" opens the field, focused', await focusIs(p, '.note-input'));
  await p.page.keyboard.type('Typed with the keys');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(400);
  S.check('keys: Enter saves, focus lands on Edit', rowOf(1, F2.id)?.note === 'Typed with the keys' && await focusIs(p, '.note-edit'));
  // A Letterboxd review cut short.
  await go(p.page, w, `#/movie/${F3.id}`, 400);
  S.check('letterboxd: the note says where it came from', /from Letterboxd/.test(await p.page.locator('.note-label').textContent()) && (await p.page.locator('.note-text').textContent()).endsWith('…'));
  const more = p.page.locator('.note-more');
  await more.click();
  S.check('letterboxd: "Show the whole review" opens the whole of it', (await p.page.locator('.note-text').textContent()).includes('Second paragraph.') && (await more.getAttribute('aria-expanded')) === 'true');
  await shot(p, 'note-movie-letterboxd-owner-390-light');
  await more.click();
  S.check('letterboxd: and Show less folds it again', (await p.page.locator('.note-text').textContent()).endsWith('…'));
  S.check('movie: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('movie page: a quick star tap is never slowed by the note', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'dark' });
  const film = C.CLASSICS[3];
  await go(p.page, w, `#/movie/${film.id}`, 500);
  S.check('tap: an unrated film shows no note control', await p.page.locator('.rating-row + .note-slot').evaluate((e) => e.hidden));
  await tapStars(p.page, p.page.locator('.rating-row .stars[role="slider"]'), 0.75);
  await p.page.waitForTimeout(600);
  const r = w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', film.id);
  S.check('tap: one tap rates it', r?.rating === 4, JSON.stringify(r));
  S.check('tap: no field or dialog opens, "Add a note" waits after the stars', await p.page.locator('.note-input').count() === 0 && await p.page.locator('.modal-card').count() === 0 && await p.page.locator('.note-add').isVisible());
  await p.page.locator('.rating-row .rater-clear').click();
  await p.page.waitForTimeout(500);
  S.check('tap: clearing the rating takes "Add a note" away', await p.page.locator('.rating-row + .note-slot').evaluate((e) => e.hidden));
  S.check('tap: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

// ================================================================== other places
await S.step('Rate: a note after rating in search and in the list; the filter finds notes', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light' });
  await go(p.page, w, '#/rate', 500);
  await p.page.locator('.page > input.input.big').fill('Comet');
  const row = p.page.locator('.search-row').first();
  await row.waitFor({ timeout: 8000 });
  const title = (await row.locator('.search-title').textContent()).replace(/ \(\d{4}\)$/, '');
  const film = C.CLASSICS.find((c) => c.title === title);
  S.check('rate: no "Add a note" before rating', await row.locator('.note-add').count() === 0);
  await tapStars(p.page, row.locator('.stars[role="slider"]'), 0.9);
  await p.page.waitForTimeout(700);
  S.check('rate: after rating, "Add a note" comes up after the stars', await row.locator('.note-add').isVisible());
  await row.locator('.note-add').click();
  await p.page.keyboard.type('Rated from the Rate search');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(500);
  S.check('rate: the note saves from the search row', rowOf(1, film.id)?.note === 'Rated from the Rate search');
  await p.page.waitForSelector(`#rating-list [data-rating-id="${F5.id}"] .note-line`, { timeout: 8000 });
  S.check('rate: the list shows a note as a second line', (await p.page.locator(`#rating-list [data-rating-id="${F5.id}"] .note-line`).textContent()).includes('zebra crossing'));
  const filter = p.page.locator('.filter-input[aria-label="Filter your ratings"]');
  await filter.fill('zebra');
  await p.page.waitForTimeout(300);
  const shown = await p.page.locator('#rating-list .rating-item:not([hidden])').evaluateAll((els) => els.map((e) => Number(e.dataset.ratingId)));
  S.check('rate: the filter finds a film by a word in its note', JSON.stringify(shown) === JSON.stringify([F5.id]), JSON.stringify(shown));
  await shot(p, 'note-rate-filter-owner-390-light');
  await filter.fill('');
  // Rate a film again from the search results (the list only shows ratings):
  // "Add a note" on its row in the list too, and a tap there opens the field.
  await p.page.locator('.page > input.input.big').fill(F4.title);
  const again = p.page.locator('.search-row', { has: p.page.locator('.search-title', { hasText: F4.title }) }).first();
  await again.waitFor({ timeout: 8000 });
  await tapStars(p.page, again.locator('.stars[role="slider"]'), 0.5);
  await p.page.waitForSelector(`#rating-list [data-rating-id="${F4.id}"] .note-add`, { timeout: 8000 }).catch(() => {});
  const item = p.page.locator(`#rating-list [data-rating-id="${F4.id}"]`);
  S.check('rate: re-rating a film from the search offers "Add a note" on its row in the list', await item.locator('.note-add').count() === 1);
  await item.locator('.note-add').tap();
  await p.page.waitForTimeout(300);
  S.check('rate: a tap on that row\'s "Add a note" opens the field', await item.locator('.note-input').isVisible() && await p.page.evaluate(() => location.hash) === '#/rate');
  await p.page.keyboard.press('Escape');
  S.check('rate: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('Stats sheet: second lines, the filter, and a note after rating', async () => {
  await api(null, 'PUT', `/api/ratings/${F0.id}/note`, { note: 'Owner on the first one, walrus' });
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'dark' });
  await go(p.page, w, '#/stats', 500);
  await p.page.locator('.bar-row', { hasText: C.PEOPLE.ada.name }).first().click();
  await waitDialog(p.page);
  await p.page.waitForSelector('.sheet-rated .sheet-film', { timeout: 8000 });
  const line = p.page.locator('.sheet-rated .sheet-film', { hasText: F0.title }).locator('.note-line');
  S.check('stats: You rated shows the note as a second line', (await line.textContent()).includes('walrus'));
  S.check('stats: the line says it is your note to a screen reader', (await line.locator('.sr-only').textContent()) === 'Your note: ');
  await p.page.waitForSelector('.sheet-more .more-film', { timeout: 15000 });
  const more = p.page.locator('.sheet-more .more-film').first();
  const title = await more.locator('.sheet-title').evaluate((e) => e.firstChild.textContent);
  await tapStars(p.page, more.locator('.stars[role="slider"]'), 0.9);
  await p.page.waitForFunction((t) => [...document.querySelectorAll('.sheet-rated .sheet-film')].some((li) => li.textContent.includes(t) && li.querySelector('.note-add')), title, { timeout: 15000 }).catch(() => {});
  const moved = p.page.locator('.sheet-rated .sheet-film', { hasText: title });
  S.check('stats: a film rated in More from moves up with "Add a note"', await moved.locator('.note-add').count() === 1);
  await moved.locator('.note-add').click();
  await p.page.keyboard.type('From the Stats sheet');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(500);
  S.check('stats: the note saves from the sheet', w.q1("SELECT COUNT(*) n FROM rating_notes WHERE user_id = 1 AND note = 'From the Stats sheet'").n === 1);
  await moved.locator('.note-edit').click();
  await p.page.keyboard.press('Escape');
  await p.page.waitForTimeout(300);
  S.check('stats: Escape in the field closes only the field, the sheet stays', await p.page.locator('.modal-card').count() === 1 && await p.page.locator('.modal-card .note-input').count() === 0);
  await shot(p, 'note-stats-sheet-owner-390-dark');
  S.check('stats: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
  // Robin's Drama sheet has more films than the filter's cutoff.
  const q = await open(browser, w, { role: F.robin, width: 1280, theme: 'light' });
  await go(q.page, w, '#/stats', 500);
  await q.page.locator('.bar-row', { hasText: 'Drama' }).first().click();
  await waitDialog(q.page);
  await q.page.waitForSelector('.sheet-rated .sheet-film', { timeout: 8000 });
  const filter = q.page.locator('.modal-card .filter-input');
  await filter.waitFor({ state: 'visible', timeout: 15000 });
  await filter.fill('heron');
  await q.page.waitForTimeout(400);
  const vis = await q.page.locator('.sheet-rated .sheet-film:not([hidden])').allTextContents();
  S.check('stats: the sheet\'s filter finds a film by its note', vis.length === 1 && vis[0].includes('heron'), JSON.stringify(vis).slice(0, 200));
  await shot(q, 'note-stats-filter-robin-1280-light');
  S.check('stats: no console errors (Robin)', !q.errors.length, q.errors.join(' | '));
  await q.ctx.close();
});

await S.step('person page: You rated second lines and a note after rating', async () => {
  const p = await open(browser, w, { role: F.robin, width: 390, theme: 'light' });
  await go(p.page, w, `#/person/${C.PEOPLE.ada.id}`, 600);
  const rated = p.page.locator('.person-part[aria-labelledby="person-rated"] .note-line');
  S.check('person: Robin sees Robin\'s note in You rated', (await rated.allTextContents()).some((t) => t.includes('ROBINSECRET')));
  const text = await p.page.evaluate(() => document.body.innerText);
  S.check('person: and not the owner\'s', !/walrus|zebra/.test(text));
  const row = p.page.locator('.person-part[aria-labelledby="person-films"] .more-film').first();
  const title = await row.locator('.sheet-title').evaluate((e) => e.firstChild.textContent);
  await tapStars(p.page, row.locator('.stars[role="slider"]'), 0.7);
  await p.page.waitForFunction((t) => [...document.querySelectorAll('.person-part[aria-labelledby="person-rated"] .more-film')].some((li) => li.textContent.includes(t) && li.querySelector('.note-add')), title, { timeout: 15000 }).catch(() => {});
  const moved = p.page.locator('.person-part[aria-labelledby="person-rated"] .more-film', { hasText: title });
  S.check('person: the rated film moves to You rated with "Add a note"', await moved.locator('.note-add').count() === 1);
  await moved.locator('.note-add').click();
  await p.page.keyboard.type('Robin on the person page');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(500);
  S.check('person: the note saves', w.q1("SELECT COUNT(*) n FROM rating_notes WHERE user_id = ? AND note = 'Robin on the person page'", F.robin.id).n === 1);
  await shot(p, 'note-person-robin-390-light');
  S.check('person: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('"Did you see it?": the note after the stars in the rating sheet', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light', touch: false, mobile: false });
  await go(p.page, w, 'home', 500);
  await p.page.locator('.ask-yes').click();
  await waitDialog(p.page);
  S.check('ask: the sheet has the stars and "Add a note" after them', await p.page.locator('.rate-sheet .stars').count() === 1 && await p.page.locator('.rate-sheet .note-add').isVisible());
  await p.page.locator('.rate-sheet .note-add').click();
  await p.page.keyboard.type('Saw it with the family');
  await tapStars(p.page, p.page.locator('.rate-sheet .stars[role="slider"]'), 0.9);
  await p.page.waitForTimeout(1200);
  S.check('ask: with the note open, rating doesn\'t close the sheet', await p.page.locator('.rate-sheet').count() === 1 && w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', P4.id)?.rating === 4.5);
  await p.page.locator('.rate-sheet .note-save').click();
  await p.page.waitForTimeout(500);
  S.check('ask: the note saves', rowOf(1, P4.id)?.note === 'Saw it with the family');
  S.check('ask: "Not now" became Done', await p.page.locator('.rate-sheet .btn.soft', { hasText: 'Done' }).count() === 1);
  await shot(p, 'note-ask-owner-390-light');
  await p.page.locator('.rate-sheet .btn.soft', { hasText: 'Done' }).click();
  await p.page.waitForTimeout(400);
  S.check('ask: Done closes it', await p.page.locator('.modal-card').count() === 0);
  S.check('ask: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('Rate import: ratings.csv and reviews.csv picked together', async () => {
  const f = await makeFriend(w.base, 'Uploader');
  await api(f, 'PUT', '/api/settings', { setupDone: true, tourDone: true, youNoteSeen: true });
  const p = await open(browser, w, { role: f, width: 390, theme: 'light' });
  await go(p.page, w, '#/rate', 500);
  await p.page.locator('button', { hasText: 'Show me how' }).click();
  S.check('import: the steps mention reviews.csv', (await p.page.locator('.import-steps').textContent()).includes('reviews.csv'));
  const c = C.CLASSICS.slice(6, 9);
  const ratings = ['Date,Name,Year,Letterboxd URI,Rating', ...c.map((m, i) => `2024-01-0${i + 1},${m.title},${m.year},https://boxd.it/r${i},${[4, 3, 5][i]}`)].join('\n');
  const reviews = ['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date',
    `2024-01-05,${c[0].title},${c[0].year},https://boxd.it/v0,4,,"A <b>fine</b> film.",,2024-01-05`,
    `2024-01-06,${c[1].title},${c[1].year},https://boxd.it/v1,3,,"${'Long thoughts. '.repeat(30)}",,2024-01-06`].join('\n');
  // reviews.csv first in the picker: the page reads ratings.csv before it.
  // Its summary is on screen before reviews.csv is read, so wait for the one
  // that names the reviews (or an error, which ends the upload).
  const t = await importFiles(p.page, w, 'input[type=file][accept=".csv,text/csv"]', [
    { name: 'reviews.csv', mimeType: 'text/csv', buffer: Buffer.from(reviews) },
    { name: 'ratings.csv', mimeType: 'text/csv', buffer: Buffer.from(ratings) },
  ], () => { const r = document.querySelector('.import-result'); return r && !r.hidden && (/brought in/.test(r.textContent) || r.classList.contains('err')) && !/Matching titles/.test(r.textContent); }, { timeout: 40000 });
  S.check('import: both files import, the summary names ratings and notes', /3 ratings imported/.test(t) && /2 reviews brought in as notes/.test(t), t);
  S.check('import: the review became a plain-text note', rowOf(f.id, c[0].id)?.note === 'A fine film.' && rowOf(f.id, c[1].id)?.note.endsWith('…'));
  S.check('import: ratings.csv decided the ratings', w.q1('SELECT rating FROM ratings WHERE user_id = ? AND tmdb_id = ?', f.id, c[1].id)?.rating === 3);
  await shot(p, 'note-import-reviews-390-light');
  S.check('import: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('Watchlist: the filter finds a note', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light' });
  await go(p.page, w, '#/watchlist', 500);
  await p.page.locator('.filter-input').fill('zebra');
  await p.page.waitForTimeout(300);
  const vis = await p.page.locator('.tile-grid > :not([hidden])').allTextContents();
  S.check('watchlist: only the film with that word in its note is left', vis.length === 1 && vis[0].includes(F5.title), JSON.stringify(vis));
  await p.page.locator('.filter-input').fill('crossing zebra');
  await p.page.waitForTimeout(300);
  S.check('watchlist: two words from the note in any order', await p.page.locator('.tile-grid > :not([hidden])').count() === 1);
  S.check('watchlist: no console errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

// ================================================================== every role, width and theme
const ROLES = { owner: 'owner', robin: F.robin, jordan: F.jordan, casey: F.casey, guest: 'guest' };
for (const [role, as] of Object.entries(ROLES)) {
  await S.step(`looks and privacy as ${role}`, async () => {
    for (const width of [320, 390, 1280]) {
      for (const theme of ['light', 'dark']) {
        const tag = `${role} ${width} ${theme}`;
        const p = await open(browser, w, { role: as, width, theme });
        await go(p.page, w, `#/movie/${F0.id}`, 500);
        await p.page.locator('#rating-title').scrollIntoViewIfNeeded().catch(() => {});
        const text = await p.page.evaluate(() => document.body.innerText);
        const others = { owner: /ROBINSECRET/, robin: /walrus/, jordan: /walrus|ROBINSECRET/, casey: /walrus|ROBINSECRET/, guest: /walrus|ROBINSECRET/ }[role];
        S.check(`${tag}: the movie page shows no one else's note`, !others.test(text));
        if (role === 'guest') S.check(`${tag}: the guest has no rating and no note controls`, await p.page.locator('.note-slot, .note-add, .note-text').count() === 0);
        if (role === 'owner') S.check(`${tag}: the owner sees their note`, /walrus/.test(text));
        if (role === 'robin') S.check(`${tag}: Robin sees Robin's note`, /ROBINSECRET/.test(text));
        if (role === 'jordan' || role === 'casey') S.check(`${tag}: ${role} sees no note on a film they haven't rated`, await p.page.locator('.note-text').count() === 0);
        report(`${tag} movie`, await findings(p.page, width <= 1024), p);
        await shot(p, `note-movie-${role}-${width}-${theme}`);
        if (role === 'owner' || role === 'robin') {
          await go(p.page, w, '#/rate', 600);
          await p.page.waitForSelector('#rating-list', { timeout: 10000 }).catch(() => {});
          report(`${tag} rate`, await findings(p.page, width <= 1024), p);
          await shot(p, `note-rate-${role}-${width}-${theme}`);
          await go(p.page, w, `#/person/${C.PEOPLE.ada.id}`, 600);
          report(`${tag} person`, await findings(p.page, width <= 1024), p);
          await shot(p, `note-person-${role}-${width}-${theme}`);
        }
        await p.ctx.close();
      }
    }
  });
}

await browser.close();
await w.close();
S.finish();
