// "I'm going" and Send a pick in the browser (js/social.js): as the owner, the
// 700-rating friend, a brand-new friend, a second friend and the guest, at
// 320, 390 and 1280 in light and dark, plus the installed app at 390.
//
// Every page with the new parts (Picks with its "Did you see it?" and "Sent
// to you" cards and the hero's I'm going and Send, the movie page with Sent
// by, Send, the plan and who else is going, Schedule's Leaving list, and the
// three sheets) is measured inside those parts with the layout rules
// (ui-helpers.mjs, scoped): nothing past the screen edge or clipped, 44px
// taps, WCAG AA text; plus no console error or failed request, no sideways
// scroll on Picks and the movie page, and only the app's two fonts. Then by
// keyboard: the showing sheet and the Send sheet trap focus, return it and
// close on Escape; I'm going, Cancel and Undo; Yes (then the star rating) and
// No; dismiss and Save on a sent pick; the 140 character note; names and
// states a screen reader reads. A friend never sees another friend's name,
// and the guest sees none of it and never asks for it. The tour and Help
// cover both features. RP_SHOTS_DIR saves a screenshot of every scene.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, settle, toastText } from '../lib/browser.mjs';
import { measure, contrastProbe, textPalette, waitDialog, ROUTES } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('social');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const P = Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [k, C.PLAYING.find((f) => f.k === k)]));
const WED = '2026-09-23';
const local = (s) => Date.parse(`${s}-04:00`);

// Yesterday's showing of Glass Orchard, planned by the owner and the heavy
// friend: the morning question is up as the world starts.
const w = S.world(await openWorld('social', {
  prepare: (d) => {
    const ins = d.prepare(`INSERT INTO plans(user_id, tmdb_id, showtime_id, theatre_id, theatre_name, date, start_local, start_epoch, title, created_at, remind_at, reminded_at, ask_at, asked_at, expires_at)
      VALUES(?, ?, ?, '9101', 'AMC Maple Grove 12', '2026-09-22', '2026-09-22T20:10:00', ?, ?, '2026-09-22T12:00:00.000Z', ?, 'sent', ?, 'sent', ?)`);
    const ask = local('2026-09-23T10:00:00');
    for (const uid of [1, 2]) ins.run(uid, P[4].id, `past-${uid}`, local('2026-09-22T20:10:00'), P[4].title, local('2026-09-22T18:10:00'), ask, ask + 3 * 864e5);
  },
}));
const F = w.friends;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const show = (k, t, hhmm, date = WED) => w.q1('SELECT * FROM showtimes WHERE tmdb_id = ? AND theatre_id = ? AND date = ? AND start_local LIKE ?', P[k].id, t, date, `%T${hhmm}%`);
const must = async (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text}`); return r; };

await S.step('the world: plans, Together and sent picks', async () => {
  await must(await api(F.robin, 'PUT', '/api/settings', { watchTogether: true }), 'robin together');
  // The brand-new friend has skipped the welcome setup and the tour.
  await must(await api(F.jordan, 'PUT', '/api/settings', { setupDone: true, tourDone: true, youNoteSeen: true }), 'jordan setup');
  await must(await api(null, 'PUT', '/api/plans', { showtime_id: show(1, '9101', '21:15').id }), 'owner plan');
  await must(await api(F.robin, 'PUT', '/api/plans', { showtime_id: show(2, '9101', '19:00').id }), 'robin plan');
  await must(await api(F.casey, 'PUT', '/api/plans', { showtime_id: show(1, '9102', '18:45').id }), 'casey plan');
  await must(await api(F.robin, 'POST', '/api/sends', { to: 1, tmdb_id: P[3].id, note: 'Two cousins, one boat. Trust me on this one.' }), 'robin sends');
  await must(await api(F.casey, 'POST', '/api/sends', { to: 1, tmdb_id: P[5].id }), 'casey sends');
  await must(await api(null, 'POST', '/api/sends', { to: F.robin.id, tmdb_id: P[6].id, note: 'Saw this and thought of you' }), 'owner sends robin');
  await must(await api(null, 'POST', '/api/sends', { to: F.jordan.id, tmdb_id: P[2].id, note: '<i>x</i> & "welcome"' }), 'owner sends jordan');
  S.check('world: set up', true);
});

const ROLES = { owner: 'owner', heavy: F.robin, newbie: F.jordan, casey: F.casey, guest: 'guest' };
const NAMES = { heavy: 'Robin', newbie: 'Jordan', casey: 'Casey' };
const NEW = '.inbox, .hero-plan, .detail-plan, .lv-plan, .sent-by-list, .going-lines, .st-row.planned, .detail-actions, .plan-picker, .send-form, .rate-sheet';
// The two faces and their size-matched local fallbacks (styles.css @font-face).
const FONTS = ['IBM Plex Sans', 'Big Shoulders Display', 'IBM Plex Sans Fallback', 'Big Shoulders Display Fallback'];
const shot = async (p, name) => { if (SHOTS) await p.page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

// Inside the new parts: the layout rules and AA text; page-wide: no sideways
// scroll (Leaving already scrolls at 390 on main, test/known-bugs.json) and
// only the two fonts.
async function findings(page, phone, { sideways = true } = {}) {
  const palette = await textPalette(page);
  const out = await page.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES, scope: NEW });
  out.push(...(await page.evaluate(contrastProbe, { scope: NEW })).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  const extra = await page.evaluate(({ scope, fonts }) => {
    const bad = [];
    const vw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll(scope)) {
      for (const e of [el, ...el.querySelectorAll('*')]) {
        const r = e.getBoundingClientRect();
        if (r.width && (r.right > vw + 1 || r.left < -1) && !e.closest('[hidden]')) bad.push({ kind: 'past-edge', sel: e.className?.toString?.() || e.tagName, detail: `${Math.round(r.left)}..${Math.round(r.right)} of ${vw}` });
        const ff = getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim();
        if (e.textContent.trim() && !fonts.includes(ff)) bad.push({ kind: 'font', sel: e.className?.toString?.() || e.tagName, detail: ff });
      }
    }
    for (const f of document.fonts) if (f.status === 'loaded' && !fonts.includes(f.family.replace(/["']/g, ''))) bad.push({ kind: 'font', sel: 'document.fonts', detail: f.family });
    return bad;
  }, { scope: NEW, fonts: FONTS });
  out.push(...extra);
  // Leaving at 390 is wider than the screen on main already (a showtime row
  // with Fits and Book, test/known-bugs.json), which also pushes the tab bar.
  return out.filter((f) => sideways || !((f.kind === 'sideways' && /^html/.test(f.sel)) || f.kind === 'tabbar'));
}

const browser = await launch();
const report = (tag, found, p) => S.check(`${tag}: no layout, contrast, tap, font or error findings`, !found.length && !p.errors.length, [...found.map((f) => `${f.kind} ${f.sel} ${f.detail}`), ...p.errors].slice(0, 4).join(' || '));
const pageText = (p) => p.page.evaluate(() => document.body.innerText);
const count = (p, sel) => p.page.locator(sel).count();

// ---------------------------------------------------------------- every role, width and theme
for (const [role, as] of Object.entries(ROLES)) {
  await S.step(`pages as ${role}`, async () => {
    for (const width of [320, 390, 1280]) {
      for (const theme of ['light', 'dark']) {
        const tag = `${role} ${width} ${theme}`;
        const p = await open(browser, w, { role: as, width, theme });
        const socialCalls = [];
        p.page.on('request', (r) => { if (r.url().includes('/api/social')) socialCalls.push(r.url()); });
        const phone = width <= 1024;
        const other = Object.entries(NAMES).filter(([k]) => k !== role).map(([, n]) => n);
        const privacy = async (where) => {
          if (role === 'owner' || role === 'guest') return;
          const t = await pageText(p);
          const leak = other.filter((n) => t.includes(n));
          S.check(`${tag} ${where}: names no other friend`, !leak.length, leak.join());
        };

        await go(p.page, w, 'home', 400);
        await shot(p, `${role}-${width}-${theme}-home`);
        report(`${tag} picks`, await findings(p.page, phone), p);
        await privacy('picks');
        if (role === 'guest') {
          const any = await p.page.evaluate((sel) => [...document.querySelectorAll(`${sel}, .send-btn, .go-btn, .ask-card, .sent-card, .going-line`)].filter((e) => !e.closest('[hidden]') && !e.matches('.detail-actions')).length, NEW);
          S.check(`${tag}: the guest sees no plan, send or going line on Picks`, any === 0, `${any}`);
        } else {
          S.check(`${tag}: the hero has I'm going or the plan, and Send`, await count(p, '.hero-pick .hero-plan .send-btn') === 1 && (await count(p, '.hero-pick .go-btn') + await count(p, '.hero-pick .plan-pill')) === 1);
          const cards = await p.page.evaluate(() => ({ ask: [...document.querySelectorAll('.ask-card .inbox-q')].map((e) => e.textContent), sent: [...document.querySelectorAll('.sent-card .inbox-from')].map((e) => e.textContent) }));
          const want = { owner: { ask: 1, sent: 2 }, heavy: { ask: 1, sent: 1 }, newbie: { ask: 0, sent: 1 }, casey: { ask: 0, sent: 0 } }[role];
          S.check(`${tag}: the top of Picks has its questions and sent picks`, cards.ask.length === want.ask && cards.sent.length === want.sent && cards.ask.every((q) => q === `Did you see ${P[4].title}?`), JSON.stringify(cards));
          if (role === 'owner') {
            const going = await p.page.evaluate(() => [...document.querySelectorAll('.going-line')].filter((e) => e.offsetParent).map((e) => e.textContent));
            S.check(`${tag}: the owner sees the opted-in friend going, and nobody else`, going.some((t) => /^Robin is going Tonight 7:00 PM · Maple Grove$/.test(t)) && !going.some((t) => /Casey|Jordan/.test(t)), JSON.stringify(going));
            S.check(`${tag}: the planned showing reads You're going on the hero`, /^You're going · Tonight 9:15 PM · Maple Grove$/.test((await p.page.locator('.hero-pick .plan-text').textContent().catch(() => '')) || ''));
          }
          if (role === 'heavy') {
            const going = await p.page.evaluate(() => [...document.querySelectorAll('.going-line')].filter((e) => e.offsetParent).map((e) => e.textContent));
            S.check(`${tag}: the opted-in friend sees the owner going, only`, going.length >= 1 && going.every((t) => t.startsWith(`${C.OWNER_NAME} is going`)), JSON.stringify(going));
          }
          if (role === 'casey' || role === 'newbie') S.check(`${tag}: a friend without Together sees nobody going`, await p.page.locator('.going-line').count() === 0);
          const hp = p.page.locator('.hero-pick .hero-plan');
          await hp.scrollIntoViewIfNeeded(); await p.page.waitForTimeout(150);
          await shot(p, `${role}-${width}-${theme}-hero-plan`);
        }

        await go(p.page, w, `movie/${P[1].id}`, 400);
        await shot(p, `${role}-${width}-${theme}-movie`);
        report(`${tag} movie`, await findings(p.page, phone), p);
        await privacy('movie');
        await p.page.evaluate(() => { const el = document.querySelector('#showtimes'); if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 80); });
        await p.page.waitForTimeout(200);
        await shot(p, `${role}-${width}-${theme}-showtimes`);
        report(`${tag} movie showtimes`, await findings(p.page, phone), p);
        if (role === 'owner') {
          const row = await p.page.evaluate(() => [...document.querySelectorAll('.st-row.planned')].map((r) => r.querySelector('.st-plan')?.textContent));
          const pill = await p.page.locator('.detail-plan .plan-text').textContent().catch(() => '');
          S.check(`${tag}: the movie page and that showing both read You're going`, row.length === 1 && row[0] === 'You\'re going · Tonight 9:15 PM · Maple Grove' && pill === row[0], `${JSON.stringify(row)} / ${pill}`);
        }
        if (role === 'casey') S.check(`${tag}: their own plan on the movie page, at their theater`, /^You're going · Tonight 6:45 PM · Riverside$/.test(await p.page.locator('.detail-plan .plan-text').textContent().catch(() => '')));
        else if (role !== 'guest' && role !== 'owner') S.check(`${tag}: I'm going on the movie page`, await count(p, '.detail-plan .go-btn') === 1);
        if (role === 'guest') S.check(`${tag}: the guest's movie page has no Send, plan or sent line`, await count(p, '.send-btn, .detail-plan:not([hidden]), .sent-by, .st-row.planned, .going-line') === 0);

        await go(p.page, w, 'schedule/leaving', 400);
        await shot(p, `${role}-${width}-${theme}-leaving`);
        report(`${tag} leaving`, await findings(p.page, phone, { sideways: false }), p);
        if (role === 'guest') S.check(`${tag}: the guest's Leaving has no I'm going`, await count(p, '.lv-plan, .go-btn') === 0);
        else {
          const films = await count(p, '.lv-film:has(.st-row:not(.past))');
          S.check(`${tag}: Leaving offers I'm going on every film with showings left that day`, await count(p, '.lv-plan .go-btn, .lv-plan .plan-pill') === films, `${films} films`);
        }

        // The sheets, where they are.
        if (role !== 'guest') {
          await go(p.page, w, `movie/${P[3].id}`, 300);
          await p.page.locator('.detail-plan .go-btn').click(); await waitDialog(p.page);
          await shot(p, `${role}-${width}-${theme}-picker`);
          report(`${tag} showing sheet`, await findings(p.page, phone), p);
          await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(250);
          await p.page.locator('.detail-actions .send-btn').click(); await waitDialog(p.page);
          await shot(p, `${role}-${width}-${theme}-send`);
          report(`${tag} send sheet`, await findings(p.page, phone), p);
          const sheet = await p.page.locator('.modal-card').innerText();
          if (role !== 'owner') S.check(`${tag}: a friend's Send sheet is to the owner alone`, new RegExp(`To ${C.OWNER_NAME}`).test(sheet) && !Object.values(NAMES).some((n) => sheet.includes(n)) && await count(p, '.modal-card input[type="radio"]') === 0, sheet.slice(0, 200));
          else S.check(`${tag}: the owner's Send sheet lists every friend`, ['Casey', 'Jordan', 'Robin'].every((n) => sheet.includes(n)) && await count(p, '.modal-card input[type="radio"]') === 3);
          await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(250);
        }
        S.check(`${tag}: ${role === 'guest' ? 'the guest never asks for plans or sends' : 'plans and sends were fetched'}`, role === 'guest' ? socialCalls.length === 0 : socialCalls.length > 0, `${socialCalls.length}`);
        await p.ctx.close();
      }
    }
  });
}

// ---------------------------------------------------------------- the installed app
await S.step('the installed app at 390', async () => {
  for (const theme of ['light', 'dark']) {
    for (const [role, as] of [['owner', 'owner'], ['heavy', F.robin]]) {
      const p = await open(browser, w, { role: as, width: 390, theme, touch: true });
      await p.ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { get: () => true });
        const mm = window.matchMedia.bind(window);
        window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
      });
      const cdp = await p.ctx.newCDPSession(p.page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } }).catch(() => {});
      for (const hash of ['home', `movie/${P[1].id}`]) {
        await go(p.page, w, hash, 400);
        const standalone = await p.page.evaluate(() => matchMedia('(display-mode: standalone)').matches);
        await shot(p, `standalone-390-${theme}-${role}-${hash.split('/')[0]}`);
        report(`standalone ${role} 390 ${theme} ${hash.split('/')[0]}${standalone ? '' : ' (not standalone)'}`, await findings(p.page, true), p);
      }
      await p.ctx.close();
    }
  }
});

// ---------------------------------------------------------------- by keyboard
const focusIs = (p, sel) => p.page.evaluate((s) => Boolean(document.activeElement?.closest(s)), sel);
const inDialog = (p) => p.page.evaluate(() => Boolean(document.activeElement?.closest('.modal-card')));
const nameOf = (p, sel) => p.page.evaluate((s) => { const e = document.querySelector(s); return e ? (e.getAttribute('aria-label') || e.textContent).trim() : null; }, sel);

await S.step('the showing sheet by keyboard: I\'m going, Cancel, Undo', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light', touch: false, mobile: false });
  await go(p.page, w, `movie/${P[3].id}`, 400);
  const btn = p.page.locator('.detail-plan .go-btn');
  S.check('keys: I\'m going is a button named for what it does', (await nameOf(p, '.detail-plan .go-btn'))?.startsWith('I\'m going') && await btn.getAttribute('aria-haspopup') === 'dialog');
  await btn.focus(); await p.page.keyboard.press('Enter'); await waitDialog(p.page);
  S.check('keys: the sheet is a labelled dialog and focus lands on a showing', await p.page.evaluate(() => { const c = document.querySelector('.modal-card[role="dialog"]'); return Boolean(c && document.getElementById(c.getAttribute('aria-labelledby'))?.textContent.includes('When are you going')); }) && await focusIs(p, '.pp-time'));
  const pressed = await p.page.locator('.pp-time[aria-pressed]').count();
  S.check('keys: every showing is a toggle with its state', pressed > 3 && pressed === await p.page.locator('.pp-time').count());
  let trapped = true;
  for (let i = 0; i < 40; i++) { await p.page.keyboard.press('Tab'); if (!(await inDialog(p))) trapped = false; }
  S.check('keys: Tab stays in the sheet', trapped);
  await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(300);
  S.check('keys: Escape closes it and focus goes back to I\'m going', await p.page.locator('.modal-card').count() === 0 && await focusIs(p, '.detail-plan .go-btn'));
  await p.page.keyboard.press('Enter'); await waitDialog(p.page);
  const label = await p.page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await p.page.keyboard.press('Enter');
  const t = await toastText(p.page, /You're going/);
  const plan = w.q1('SELECT * FROM plans WHERE user_id = 1 AND tmdb_id = ?', P[3].id);
  S.check('keys: Enter on a showing makes the plan and says so', Boolean(plan) && /^You're going to .+ (tonight|today|tomorrow|on \w+) at \d+:\d\d [AP]M \(Maple Grove\)\.\s*Undo$/.test(t), `${t} / ${label}`);
  await p.page.waitForTimeout(300);
  const pill = await p.page.locator('.detail-plan .plan-text').textContent().catch(() => '');
  const rows = await p.page.locator('.st-row.planned').count();
  S.check('keys: the plan shows on the movie page and on that one showing', /^You're going · \w+ \d+:\d\d [AP]M · Maple Grove$/.test(pill) && rows === 1, `${pill} rows ${rows}`);
  S.check('keys: focus moves to the plan\'s own buttons', await focusIs(p, '.detail-plan .plan-acts'));
  await p.page.locator('.detail-plan .plan-cancel').focus(); await p.page.keyboard.press('Enter');
  const t2 = await toastText(p.page, /cancelled/);
  S.check('keys: Cancel takes the plan away', !w.q1('SELECT 1 x FROM plans WHERE user_id = 1 AND tmdb_id = ?', P[3].id) && /cancelled/.test(t2) && await p.page.locator('.st-row.planned').count() === 0);
  S.check('keys: after Cancel focus is on I\'m going again', await focusIs(p, '.detail-plan .go-btn'));
  await p.page.locator('.toast-action').last().click();
  await p.page.waitForTimeout(500);
  S.check('keys: Undo puts the plan back', Boolean(w.q1('SELECT 1 x FROM plans WHERE user_id = 1 AND tmdb_id = ?', P[3].id)) && await p.page.locator('.st-row.planned').count() === 1);
  S.check('keys: no errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('the hero\'s I\'m going plans the showing Book points at', async () => {
  const p = await open(browser, w, { role: F.jordan, width: 390, theme: 'dark' });
  await go(p.page, w, 'home', 400);
  const book = (await p.page.locator('.hero-pick .btn.book').textContent()).match(/\d+:\d\d [AP]M/)?.[0];
  const id = Number((await p.page.locator('.hero-pick .hero-title a').getAttribute('href')).split('/').pop());
  await p.page.locator('.hero-pick .go-btn').click();
  await p.page.waitForSelector('.hero-pick .plan-pill');
  const plan = w.q1('SELECT * FROM plans WHERE user_id = ? AND tmdb_id = ?', F.jordan.id, id);
  const pill = await p.page.locator('.hero-pick .plan-text').textContent();
  S.check('hero: the plan is the hero\'s own showing', plan && pill.includes(book) && new RegExp(`${book}`).test(pill), `${book} vs ${pill}`);
  S.check('hero: no errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('the Send sheet by keyboard: who, the note, sending', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'dark', touch: false, mobile: false });
  await go(p.page, w, `movie/${P[4].id}`, 400);
  const b = p.page.locator('.detail-actions .send-btn');
  S.check('send: Send is named for its film and opens a dialog', (await nameOf(p, '.detail-actions .send-btn'))?.startsWith('Send') && await b.getAttribute('aria-haspopup') === 'dialog');
  await b.focus(); await p.page.keyboard.press('Enter'); await waitDialog(p.page);
  S.check('send: focus lands on the first friend', await focusIs(p, 'input[type="radio"]'));
  S.check('send: Send waits until someone is chosen', await p.page.locator('.send-go').isDisabled());
  await p.page.keyboard.press('Space');
  await p.page.keyboard.press('ArrowDown');
  const chosen = await p.page.evaluate(() => document.querySelector('.send-to input:checked')?.parentElement.textContent);
  S.check('send: arrow keys choose a friend', chosen === 'Jordan' && !(await p.page.locator('.send-go').isDisabled()), chosen);
  const noteLabel = await p.page.evaluate(() => { const t = document.querySelector('.note-input'); return document.querySelector(`label[for="${t.id}"]`)?.textContent; });
  S.check('send: the note has a label and says its limit', noteLabel === 'Note (optional)' && await p.page.locator('.note-input').getAttribute('maxlength') === '140');
  await p.page.locator('.note-input').focus();
  await p.page.keyboard.type('a'.repeat(150));
  const v = await p.page.locator('.note-input').inputValue();
  S.check('send: the note stops at 140 characters', v.length === 140 && (await p.page.locator('.note-count').textContent()) === '140 of 140', `${v.length}`);
  let trapped = true;
  for (let i = 0; i < 12; i++) { await p.page.keyboard.press('Tab'); if (!(await inDialog(p))) trapped = false; }
  S.check('send: Tab stays in the sheet', trapped);
  await p.page.locator('.send-go').focus(); await p.page.keyboard.press('Enter');
  const t = await toastText(p.page, /Sent/);
  await p.page.waitForTimeout(400);
  const row = w.q1('SELECT * FROM sends WHERE from_user = 1 AND to_user = ? AND tmdb_id = ? AND cleared_at IS NULL', F.jordan.id, P[4].id);
  S.check('send: sending closes the sheet, says so and stores it', /^Sent .+ to Jordan\.$/.test(t) && row?.note?.length === 140 && await p.page.locator('.modal-card').count() === 0, `${t}`);
  S.check('send: focus is back on Send', await focusIs(p, '.detail-actions .send-btn'));
  S.check('send: no errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();
});

await S.step('the top of Picks: Yes then the stars, No, dismiss, Save', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light', touch: false, mobile: false });
  await go(p.page, w, 'home', 400);
  S.check('inbox: cards are named for what they are', (await p.page.locator('.ask-card').getAttribute('aria-label')) === `Did you see ${P[4].title}?` && await p.page.locator('.sent-card[aria-label^="Sent to you by Robin"]').count() === 1);
  const sub = await p.page.locator('.ask-card .inbox-sub').textContent();
  S.check('inbox: the question says which showing', sub === 'You planned the 8:10 PM showing last night at Maple Grove.', sub);
  await p.page.locator('.ask-yes').focus(); await p.page.keyboard.press('Enter');
  await waitDialog(p.page);
  S.check('yes: the star rating opens with focus on the stars', await focusIs(p, '.stars[role="slider"]') && /Rate /.test(await p.page.locator('.modal-card h3').textContent()));
  const wr = w.q1('SELECT * FROM watched WHERE user_id = 1 AND tmdb_id = ?', P[4].id);
  S.check('yes: logged seen on the showing\'s day', wr?.watched_date === '2026-09-22', JSON.stringify(wr));
  for (let i = 0; i < 8; i++) await p.page.keyboard.press('ArrowRight');
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(1200);
  S.check('yes: the rating is saved and the sheet closes', w.q1('SELECT rating FROM ratings WHERE user_id = 1 AND tmdb_id = ?', P[4].id)?.rating === 4 && await p.page.locator('.modal-card').count() === 0);
  await settle(p.page, 300);
  S.check('yes: the card is gone', await p.page.locator('.ask-card').count() === 0);
  const sentBefore = await p.page.locator('.sent-card').count();
  const d = p.page.locator('.sent-card .sent-dismiss').first();
  S.check('dismiss: the button says what and from whom', /^Dismiss .+ from (Robin|Casey)$/.test(await d.getAttribute('aria-label')));
  await d.focus(); await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(500);
  S.check('dismiss: the row goes and focus stays on the page', await p.page.locator('.sent-card').count() === sentBefore - 1 && await p.page.evaluate(() => document.activeElement && document.activeElement !== document.body));
  S.check('inbox: no errors', !p.errors.length, p.errors.join(' | '));
  await p.ctx.close();

  const h = await open(browser, w, { role: F.robin, width: 390, theme: 'dark' });
  await go(h.page, w, 'home', 400);
  await h.page.locator('.ask-no').click();
  await h.page.waitForTimeout(500);
  S.check('no: the card and the plan go, nothing is logged', await h.page.locator('.ask-card').count() === 0 && !w.q1('SELECT 1 x FROM plans WHERE user_id = ? AND tmdb_id = ?', F.robin.id, P[4].id) && !w.q1('SELECT 1 x FROM watched WHERE user_id = ? AND tmdb_id = ?', F.robin.id, P[4].id));
  await h.page.locator('.sent-card .wl-btn').click();
  await h.page.waitForTimeout(600);
  S.check('save: saving a sent pick puts it on the watchlist and clears the row', await h.page.locator('.sent-card').count() === 0 && Boolean(w.q1('SELECT 1 x FROM watchlist WHERE user_id = ? AND tmdb_id = ?', F.robin.id, P[6].id)));
  S.check('save: no errors', !h.errors.length, h.errors.join(' | '));
  await h.ctx.close();

  const n = await open(browser, w, { role: F.jordan, width: 390, theme: 'light' });
  await go(n.page, w, 'home', 400);
  const note = await n.page.evaluate(() => { const e = [...document.querySelectorAll('.sent-card .sent-note')].find((x) => x.textContent.includes('welcome')); return e ? { text: e.textContent, markup: e.querySelectorAll('*').length } : null; });
  S.check('note: shown as plain text, never as markup', note?.text === '"<i>x</i> & "welcome""' && note.markup === 0, JSON.stringify(note));
  await go(n.page, w, `movie/${P[2].id}`, 400);
  const by = await n.page.locator('.sent-by').innerText().catch(() => '');
  S.check('movie: Sent by the owner, with the note', by.includes(`Sent by ${C.OWNER_NAME}`) && by.includes('<i>x</i>'), by);
  await n.ctx.close();
});

// ---------------------------------------------------------------- tour and Help
await S.step('the tour and Help, for the owner and a friend', async () => {
  for (const [role, as] of [['owner', 'owner'], ['friend', F.casey]]) {
    const p = await open(browser, w, { role: as, width: 390, theme: 'light' });
    await go(p.page, w, 'help', 300);
    const guide = await p.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.guide dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent || ''])));
    S.check(`help ${role}: a line for I'm going and for Send a pick`, /reminder two hours before/.test(guide['I\'m going'] || '') && /ten a day/.test(guide['Send a pick'] || ''), JSON.stringify(Object.keys(guide)));
    S.check(`help ${role}: says who sees your plans`, role === 'owner' ? /Friends who turned on Together/.test(guide['I\'m going']) : new RegExp(`you and ${C.OWNER_NAME} see each other's plans`).test(guide['I\'m going']));
    await p.page.locator('.tour-replay').click();
    await p.page.waitForSelector('.tour-card');
    const steps = [];
    for (let i = 0; i < 20; i++) {
      await p.page.waitForFunction(() => !document.querySelector('.tour-layer.moving'), null, { timeout: 15000 }).catch(() => {});
      await p.page.waitForTimeout(150);
      steps.push(await p.page.evaluate(() => { const s = document.querySelector('.tour-spot'); const r = s.getBoundingClientRect(); return { title: document.querySelector('.tour-title').textContent, text: document.querySelector('.tour-text').textContent, lit: !s.hidden && r.width > 0 && r.bottom > 0 && r.top < innerHeight }; }));
      const next = p.page.locator('.tour-next');
      if ((await next.textContent()).trim() === 'Done') { await next.click(); break; }
      await next.click();
    }
    const go1 = steps.find((s) => s.title === 'I\'m going');
    const send = steps.find((s) => s.title === 'Send a pick');
    S.check(`tour ${role}: an I'm going step lighting a real element`, go1?.lit && /reminder two hours before/.test(go1.text), JSON.stringify(go1));
    S.check(`tour ${role}: a Send step lighting a real element, worded for them`, send?.lit && (role === 'owner' ? /a friend/.test(send.text) : new RegExp(C.OWNER_NAME).test(send.text)), JSON.stringify(send));
    S.check(`tour ${role}: no errors`, !p.errors.length, p.errors.join(' | '));
    await p.ctx.close();
  }
});

await browser.close();
await w.close();
S.finish();
