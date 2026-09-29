// Your year in movies in the browser (public/js/year.js):
//
//   window   on Nov 30 and Jan 16 no card on Picks and no row in You; on
//            Dec 1 and Jan 15 both, and each opens the recap; "Preview year
//            in movies" in Settings for the owner only, opening it any day;
//            the guest sees none of it
//   viewer   every card of the owner, the 700-rating friend, the 3-rating
//            friend and the brand-new friend at 320, 390 and 1280, light and
//            dark, and in the installed app at 390: a heading and readable
//            text on each, no sideways scroll, clipped text, covered
//            controls, taps under 44px, AA contrast failures, console errors
//            or failed requests; tap, swipe, arrow keys, Back, Next, Done,
//            the close button and Escape; focus kept inside and handed back;
//            reduced motion moves nothing
//   share    Save image gives a 1080 x 1920 PNG from a canvas that stays
//            readable: the person's name and numbers, their posters drawn
//            from this server, nobody else's data, no invite link
//
// RP_SHOTS_DIR saves a screenshot of every card, the entry points and the
// saved images.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, settle, VISIBLE } from '../lib/browser.mjs';
import { measure, contrastProbe, extras, waitDialog, textPalette, realSizePosters, ROUTES, PNG } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';
import { seedYear, DEC1, NOV30, JAN15, JAN16, NOTE } from '../lib/year-seed.mjs';
import { buttonsProbe, outlined, wordScan, wordProblems, paintedColours, paletteNow, inPalette } from '../lib/design-probes.mjs';

const S = suite('year');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

const w = S.world(await openWorld('year-ui', { prepare: (d) => { seedYear(d); } }));
const F = w.friends;
// The 3-rating friend, and the brand-new friend past the welcome setup.
for (const f of C.RATED.slice(10, 13)) await w.api('POST', '/api/ratings', { as: F.casey, body: { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year } });
await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true } });
const ROLES = { owner: 'owner', robin: F.robin, casey: F.casey, jordan: F.jordan };
const NAMES = { owner: C.OWNER_NAME, robin: 'Robin', casey: 'Casey', jordan: 'Jordan' };
const browser = await launch();

const at = async (iso) => { await w.restart({ fakeNow: iso }); };
const load = async (page, hash, ms = 300) => { await page.goto('about:blank'); await page.goto(`${w.base}/#/${hash}`); await settle(page, ms); };
const openRecap = async (page, from = '#main .year-entry .btn') => { await page.locator(from).first().click(); await waitDialog(page); await page.waitForSelector('.yr-card'); await page.waitForTimeout(350); };
const countText = (page) => page.locator('.yr-count').textContent();
async function measureAll(page, phone) {
  const palette = await textPalette(page);
  const findings = await page.evaluate(measure, { phone, atBottom: false, palette, routes: ROUTES });
  findings.push(...(await page.evaluate(extras)).out);
  findings.push(...(await page.evaluate(contrastProbe)).out.map((c) => ({ ...c, kind: `contrast:${c.kind}` })));
  return findings;
}
// The design suite's rules (test/ui/design.mjs) on whatever is on screen:
// sizes and line heights from the type scale, only the two fonts, palette
// colours only, one button system, no outlined boxes, plain wording.
const SIZES = new Set([12, 13, 15, 17, 22, 30, 40, 46, 64, 72]);
const RATIOS = [1, 0.98, 1.05, 1.2, 1.25, 1.35, 1.5];
const PX = new Set([18, 20, 22, 24, 40]);
const FONTS = ['Big Shoulders Display', 'IBM Plex Sans'];
// Only the recap and its entry card are held to them here: everything else
// is hidden while the probes run (on a mocked December the Picks page behind
// shows its own no-showtimes state, which design.mjs covers on its own day).
async function designFindings(page) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => {
    const st = document.createElement('style'); st.id = 'probe-scope';
    st.textContent = 'body * { visibility: hidden !important; transition: none !important; } .year-sheet, .year-sheet *, .year-entry, .year-entry * { visibility: visible !important; }';
    document.head.appendChild(st);
  });
  try { return await probe(page); } finally { await page.evaluate(() => document.getElementById('probe-scope')?.remove()); }
}
async function probe(page) {
  const bad = [];
  const { inv } = await page.evaluate(extras);
  for (const [k, cls] of Object.entries(inv)) {
    if (cls.every((c) => c === '.poster-fallback-title')) continue;
    const [fsz, , lh] = k.split('|'); const size = parseFloat(fsz);
    if (!SIZES.has(size)) bad.push(`type: size ${size}px ${cls.join(' ')}`);
    const l = parseFloat(lh);
    if (lh === 'normal' || (!PX.has(Math.round(l)) && !RATIOS.some((r) => Math.abs(l - r * size) < 0.6))) bad.push(`type: line-height ${lh} at ${size}px ${cls.join(' ')}`);
  }
  const pal = await page.evaluate(paletteNow);
  for (const g of await page.evaluate(paintedColours)) if (!inPalette(g.c, pal, pal.slice(0, 5))) bad.push(`colour ${g.c} ${g.what} ${g.el}`);
  const fams = await page.evaluate(() => [...new Set([...document.querySelectorAll('.year-sheet *, .year-entry *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/"/g, '').trim()))]);
  for (const f of fams) if (!FONTS.includes(f)) bad.push(`font ${f}`);
  bad.push(...(await page.evaluate(buttonsProbe, VISIBLE)).bad.map((b) => `buttons: ${b}`));
  bad.push(...(await page.evaluate(outlined, VISIBLE)).map((b) => `outlined: ${b}`));
  bad.push(...wordProblems(await page.evaluate(wordScan, VISIBLE)).map((b) => `words: ${b}`));
  return bad;
}

// The card on screen: its kind, heading and readable text.
const cardNow = (page) => page.evaluate(() => {
  const c = document.querySelector('.yr-card');
  const hd = c?.querySelector('h3');
  return { kind: c?.dataset.kind, heading: hd?.textContent.trim() || '', text: (c?.innerText || '').replace(/\s+/g, ' ').trim(), label: c?.getAttribute('aria-label') || '', live: c?.parentElement?.getAttribute('aria-live') };
});

// ------------------------------------------------------------------ window
await S.step('window: the card, the row and the preview by date', async () => {
  for (const [label, iso, open_] of [['Nov 30', NOV30, false], ['Dec 1', DEC1, true], ['Jan 15', JAN15, true], ['Jan 16', JAN16, false]]) {
    await at(iso);
    for (const role of ['owner', 'robin']) {
      const p = await open(browser, w, { role: ROLES[role], width: 390, theme: 'light' });
      await realSizePosters(p.ctx);
      await load(p.page, 'home');
      const card = await p.page.locator('#main .year-entry').count();
      S.check(`window: ${label} ${role}: ${open_ ? 'a' : 'no'} Your year card at the top of Picks`, open_ ? card === 1 && (await p.page.locator('#main .page > *').first().getAttribute('class')).includes('year-entry') : card === 0, `${card}`);
      if (open_) {
        const t = await p.page.locator('#main .year-entry .banner-title').textContent();
        S.check(`window: ${label} ${role}: it names the year that's ending`, t === 'Your 2026 in movies', t);
        if (role === 'owner' && label === 'Dec 1') { await shot(p.page, 'year-picks-card-owner-390-light'); }
        await openRecap(p.page);
        const title = await p.page.locator('.year-sheet .modal-head h3').textContent();
        S.check(`window: ${label} ${role}: the card opens the recap`, /Your 2026 in movies/.test(title) && (await cardNow(p.page)).kind === 'intro', title);
        await p.page.keyboard.press('Escape');
        await p.page.waitForTimeout(300);
      }
      await load(p.page, 'you');
      const row = await p.page.locator('#main .year-entry').count();
      S.check(`window: ${label} ${role}: ${open_ ? 'a' : 'no'} row in You`, open_ ? row === 1 : row === 0, `${row}`);
      if (open_) {
        if (role === 'robin' && label === 'Jan 15') await shot(p.page, 'year-you-row-robin-390-light');
        await openRecap(p.page);
        S.check(`window: ${label} ${role}: the row opens the recap`, (await cardNow(p.page)).kind === 'intro');
        await p.page.keyboard.press('Escape');
      }
      await load(p.page, 'settings');
      const pv = p.page.locator('button', { hasText: 'Preview year in movies' });
      S.check(`window: ${label} ${role}: Preview year in movies is in Settings ${role === 'owner' ? 'for the owner' : 'not for a friend'}`, (await pv.count()) === (role === 'owner' ? 1 : 0), String(await pv.count()));
      if (role === 'owner' && (label === 'Nov 30' || label === 'Jan 16')) {
        await pv.scrollIntoViewIfNeeded();
        if (label === 'Nov 30') await shot(p.page, 'year-settings-preview-owner-390-light');
        await pv.click();
        await waitDialog(p.page);
        const title = await p.page.locator('.year-sheet .modal-head h3').textContent();
        S.check(`window: ${label} owner: the preview opens outside the dates`, /^Preview: Your 20(26|27) in movies$/.test(title) && (await cardNow(p.page)).kind === 'intro', title);
        await p.page.keyboard.press('Escape');
      }
      S.check(`window: ${label} ${role}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
      await p.ctx.close();
    }
  }
  await at(DEC1);
  const g = await open(browser, w, { role: 'guest', width: 390, theme: 'dark' });
  const asked = [];
  g.page.on('request', (r) => { if (/\/api\/year/.test(r.url())) asked.push(r.url()); });
  await load(g.page, 'home');
  S.check('window: Dec 1 guest: no card on Picks and no call for a recap', (await g.page.locator('.year-entry').count()) === 0 && !asked.length, asked.join(' '));
  S.check('window: Dec 1 guest: no console error or failed request', !g.errors.length, g.errors.slice(0, 3).join(' | '));
  await g.ctx.close();
});

// ------------------------------------------------------------------ viewer: every card
const KINDS = {
  owner: 'intro,numbers,tops,theater,months,plan,picks,best,summary',
  robin: 'intro,numbers,tops,months,plan,picks,best,summary',
  casey: 'intro,numbers,best,summary',
  jordan: 'intro,start',
};
async function walk(role, width, theme, { standalone = false } = {}) {
  const p = await open(browser, w, { role: ROLES[role], width, theme, touch: width <= 1024 });
  await realSizePosters(p.ctx);
  if (standalone) {
    await p.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : mm(q));
    });
    const cdp = await p.ctx.newCDPSession(p.page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
  }
  const tag = standalone ? `standalone 390 ${theme} ${role}` : `${role} ${width} ${theme}`;
  await load(p.page, 'home');
  if (width !== 320 && !standalone) {
    await load(p.page, 'you');
    const youBad = [...(await measureAll(p.page, width <= 1024)).map((f) => `${f.kind} ${f.sel} ${f.detail}`), ...(await designFindings(p.page))];
    S.check(`viewer: ${tag}: the row in You passes the layout and design checks`, (await p.page.locator('#main .year-entry').count()) === 1 && !youBad.length, youBad.slice(0, 4).join(' || '));
    await load(p.page, 'home');
    const picksBad = (await measureAll(p.page, width <= 1024)).map((f) => `${f.kind} ${f.sel} ${f.detail}`);
    S.check(`viewer: ${tag}: the card on Picks passes the layout checks`, !picksBad.length, picksBad.slice(0, 4).join(' || '));
  }
  await openRecap(p.page);
  const seen = [];
  const bad = [];
  const designBad = [];
  if (width !== 320 && !standalone) designBad.push(...(await designFindings(p.page)).map((b) => `Picks card: ${b}`));
  for (let i = 0; i < 12; i++) {
    const c = await cardNow(p.page);
    seen.push(c.kind);
    if (!c.heading || c.text.length < c.heading.length + 8) bad.push(`${c.kind}: heading "${c.heading}" text "${c.text.slice(0, 60)}"`);
    const findings = await measureAll(p.page, width <= 1024);
    if (findings.length) bad.push(...findings.slice(0, 3).map((f) => `${c.kind}: ${f.kind} ${f.sel} ${f.detail}`));
    if (width !== 320 && !standalone) designBad.push(...(await designFindings(p.page)).map((b) => `${c.kind}: ${b}`));
    if (standalone) {
      const edge = await p.page.evaluate(() => ({ x: document.querySelector('.year-sheet .modal-x').getBoundingClientRect().top, nav: document.querySelector('.yr-nav').getBoundingClientRect().bottom, h: innerHeight }));
      if (edge.x < 47 || edge.nav > edge.h - 34) bad.push(`${c.kind}: under the notch or home bar (close top ${edge.x}, nav bottom ${edge.nav} of ${edge.h})`);
    }
    await shot(p.page, standalone ? `year-standalone-390-${theme}-${role}-${String(i + 1).padStart(2, '0')}-${c.kind}` : `year-${role}-${width}-${theme}-${String(i + 1).padStart(2, '0')}-${c.kind}`);
    const next = p.page.locator('.yr-next');
    if (!(await next.count())) { bad.push(`after ${c.kind}: the recap closed (${await p.page.evaluate(() => location.hash)})`); break; }
    if ((await next.textContent()).trim() === 'Done') break;
    await next.click();
    await p.page.waitForTimeout(420);
  }
  S.check(`viewer: ${tag}: the cards are ${KINDS[role]}`, seen.join(',') === KINDS[role], seen.join(','));
  S.check(`viewer: ${tag}: every card has a heading and readable text, and no layout, contrast or tap finding`, !bad.length, bad.slice(0, 4).join(' || '));
  if (width !== 320 && !standalone) S.check(`viewer: ${tag}: the Picks card and every card keep the design rules (type scale, two fonts, palette, buttons, no outlined boxes, wording)`, !designBad.length, [...new Set(designBad)].slice(0, 5).join(' || '));
  await p.page.locator('.yr-next').click();
  await p.page.waitForTimeout(300);
  S.check(`viewer: ${tag}: Done closes it`, (await p.page.locator('.year-sheet').count()) === 0);
  S.check(`viewer: ${tag}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
  await p.ctx.close();
}
await S.step('viewer: every card, every person, width and theme', async () => {
  const tasks = [];
  const safe = (tag, fn) => async () => { try { await fn(); } catch (e) { S.check(`viewer: ${tag}: the walk ran to the end`, false, e.message.split('\n').slice(0, 3).join(' | ')); } };
  for (const role of Object.keys(ROLES)) for (const width of [320, 390, 1280]) for (const theme of ['light', 'dark']) tasks.push(safe(`${role} ${width} ${theme}`, () => walk(role, width, theme)));
  for (const theme of ['light', 'dark']) tasks.push(safe(`standalone 390 ${theme}`, () => walk('owner', 390, theme, { standalone: true })));
  await Promise.all(Array.from({ length: 3 }, async () => { while (tasks.length) await tasks.shift()(); }));
});

// ------------------------------------------------------------------ viewer: moving around
await S.step('viewer: tap, swipe, keys, close and focus', async () => {
  const p = await open(browser, w, { role: 'owner', width: 390, theme: 'light', touch: true });
  await realSizePosters(p.ctx);
  await load(p.page, 'home');
  const opener = p.page.locator('#main .year-entry .btn');
  await openRecap(p.page);
  const n = KINDS.owner.split(',').length;
  S.check('viewer: it opens on card 1 with Next focused', (await countText(p.page)) === `1 of ${n}` && await p.page.evaluate(() => document.activeElement?.classList.contains('yr-next')));
  S.check('viewer: the dialog is labelled and each card is a live, labelled region', await p.page.evaluate(() => { const d = document.querySelector('.year-sheet [role="dialog"]'); return d?.getAttribute('aria-modal') === 'true' && Boolean(document.getElementById(d.getAttribute('aria-labelledby'))?.textContent); }) && (await cardNow(p.page)).live === 'polite' && /^1 of \d+: Your 2026 in movies$/.test((await cardNow(p.page)).label));
  const box = await p.page.locator('.yr-stage').boundingBox();
  const y = box.y + box.height / 2;
  await p.page.mouse.click(box.x + box.width * 0.8, y); await p.page.waitForTimeout(400);
  S.check('viewer: a tap on the right goes on', (await countText(p.page)) === `2 of ${n}`, await countText(p.page));
  await p.page.mouse.click(box.x + box.width * 0.1, y); await p.page.waitForTimeout(400);
  S.check('viewer: a tap on the left goes back', (await countText(p.page)) === `1 of ${n}`, await countText(p.page));
  const swipe = async (from, to) => { await p.page.mouse.move(box.x + box.width * from, y); await p.page.mouse.down(); for (let k = 1; k <= 6; k++) await p.page.mouse.move(box.x + box.width * (from + ((to - from) * k) / 6), y + k); await p.page.mouse.up(); await p.page.waitForTimeout(400); };
  await swipe(0.85, 0.15);
  S.check('viewer: a swipe left goes on', (await countText(p.page)) === `2 of ${n}`, await countText(p.page));
  await swipe(0.15, 0.85);
  S.check('viewer: a swipe right goes back', (await countText(p.page)) === `1 of ${n}`, await countText(p.page));
  await p.page.keyboard.press('ArrowRight'); await p.page.keyboard.press('ArrowRight'); await p.page.waitForTimeout(400);
  S.check('viewer: the right arrow key goes on', (await countText(p.page)) === `3 of ${n}`, await countText(p.page));
  await p.page.keyboard.press('ArrowLeft'); await p.page.waitForTimeout(400);
  S.check('viewer: the left arrow key goes back', (await countText(p.page)) === `2 of ${n}`, await countText(p.page));
  await p.page.locator('.yr-back').click(); await p.page.waitForTimeout(400);
  S.check('viewer: Back goes back, and is off on the first card', (await countText(p.page)) === `1 of ${n}` && await p.page.locator('.yr-back').isDisabled());
  await p.page.keyboard.press('ArrowLeft'); await p.page.waitForTimeout(200);
  S.check('viewer: nothing before the first card', (await countText(p.page)) === `1 of ${n}`);
  const inside = [];
  for (let k = 0; k < 14; k++) { await p.page.keyboard.press('Tab'); inside.push(await p.page.evaluate(() => Boolean(document.activeElement?.closest('.year-sheet .modal-card')))); }
  S.check('viewer: Tab stays inside the recap', inside.every(Boolean), inside.join(','));
  for (let k = 0; k < n + 2; k++) await p.page.keyboard.press('ArrowRight');
  await p.page.waitForTimeout(400);
  S.check('viewer: nothing after the last card, which is the summary', (await countText(p.page)) === `${n} of ${n}` && (await cardNow(p.page)).kind === 'summary');
  await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(350);
  S.check('viewer: Escape closes it and focus goes back to Open', (await p.page.locator('.year-sheet').count()) === 0 && await opener.evaluate((el) => el === document.activeElement));
  await openRecap(p.page);
  await p.page.locator('.year-sheet .modal-x').click(); await p.page.waitForTimeout(350);
  S.check('viewer: the close button closes it', (await p.page.locator('.year-sheet').count()) === 0);
  const sizes = await (async () => { await openRecap(p.page); return p.page.evaluate(() => [...document.querySelectorAll('.year-sheet button, .year-sheet a[href]')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [b.className, Math.round(r.width), Math.round(r.height)]; })); })();
  S.check('viewer: every control is at least 44 by 44', sizes.length >= 3 && sizes.every(([, wd, ht]) => wd >= 44 && ht >= 44), JSON.stringify(sizes));
  // The note under the highest-rated film.
  for (let k = 0; k < 7; k++) await p.page.keyboard.press('ArrowRight');
  await p.page.waitForTimeout(400);
  const best = await cardNow(p.page);
  S.check('viewer: the highest-rated card shows their note', best.kind === 'best' && best.text.includes(NOTE), best.text.slice(0, 120));
  // The control for the design checks: a card broken on purpose is caught.
  await p.page.addStyleTag({ content: '.yr-title { font-size: 16px !important; text-transform: uppercase !important; border: 1px solid var(--text) !important; } .yr-kicker { color: rgb(255, 0, 170) !important; }' });
  const caught = (await designFindings(p.page)).join(' || ');
  S.check('viewer: the design checks catch a card broken on purpose (the control)', /type: size 16px/.test(caught) && /words: capitals/.test(caught) && /outlined: h3\.yr-title/.test(caught) && /colour rgb\(255, 0, 170\)/.test(caught), caught.slice(0, 500));
  S.check('viewer: no console error or failed request', !p.errors.length, p.errors.slice(0, 3).join(' | '));
  await p.ctx.close();
});

await S.step('viewer: reduced motion only fades', async () => {
  const sample = async (reducedMotion) => {
    const p = await open(browser, w, { role: 'owner', width: 390, theme: 'dark', reducedMotion, clock: false });
    await load(p.page, 'home');
    await openRecap(p.page);
    const transforms = await p.page.evaluate(() => new Promise((resolve) => {
      const out = [];
      document.querySelector('.yr-next').click();
      const t0 = performance.now();
      const tick = () => {
        const c = document.querySelector('.yr-card');
        out.push(getComputedStyle(c).transform);
        if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve(out);
      };
      tick();
    }));
    await p.ctx.close();
    return transforms;
  };
  const moving = await sample('no-preference');
  S.check('viewer: without reduced motion the next card slides in (the control)', moving.some((t) => t !== 'none' && !/^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t)), moving.slice(0, 4).join(' '));
  const still = await sample('reduce');
  S.check('viewer: with reduced motion nothing moves', still.length > 5 && still.every((t) => t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t)), still.filter((t) => t !== 'none').slice(0, 4).join(' '));
});

// ------------------------------------------------------------------ share
await S.step('share: Save image makes a 1080 x 1920 PNG of their own year', async () => {
  const recaps = {};
  // On a phone the image goes to the share sheet (stood in for here: headless
  // Chromium never answers it); on a computer it downloads.
  for (const [role, theme, min, width] of [['owner', 'dark', 4, 390], ['robin', 'light', 4, 1280], ['casey', 'light', 3, 390]]) {
    recaps[role] = (await w.api('GET', '/api/year', { as: ROLES[role] === 'owner' ? null : ROLES[role] })).json;
    const phone = width <= 430;
    const p = await open(browser, w, { role: ROLES[role], width, theme, touch: phone });
    await realSizePosters(p.ctx);
    await p.ctx.addInitScript((phoneShare) => {
      window.__texts = []; window.__images = [];
      if (phoneShare) {
        navigator.canShare = (d) => Boolean(d?.files?.length);
        navigator.share = async (d) => { const f = d.files[0]; const b = new Uint8Array(await f.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); window.__shared = { name: f.name, type: f.type, title: d.title, b64: btoa(s) }; };
      }
      const ft = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t, ...a) { window.__texts.push(String(t)); return ft.call(this, t, ...a); };
      const di = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (img, ...a) { window.__images.push(img.currentSrc || img.src || ''); return di.call(this, img, ...a); };
    }, phone);
    const posterAsks = [];
    p.page.on('request', (r) => { if (/\/api\/year\/poster\//.test(r.url())) posterAsks.push(r.url()); });
    await load(p.page, 'home');
    await openRecap(p.page);
    for (let k = 0; k < 12 && (await cardNow(p.page)).kind !== 'summary'; k++) { await p.page.locator('.yr-next').click(); await p.page.waitForTimeout(300); }
    let buf; let name;
    if (phone) {
      await p.page.locator('.yr-save').click();
      await p.page.waitForFunction(() => window.__shared, null, { timeout: 20000 });
      const sh = await p.page.evaluate(() => window.__shared);
      buf = Buffer.from(sh.b64, 'base64'); name = sh.name;
      S.check(`share: ${role} (phone): the share sheet gets the PNG with a title`, sh.type === 'image/png' && sh.title === 'My 2026 in movies', `${sh.type} ${sh.title}`);
    } else {
      const [dl] = await Promise.all([p.page.waitForEvent('download', { timeout: 20000 }), p.page.locator('.yr-save').click()]);
      buf = fs.readFileSync(await dl.path()); name = dl.suggestedFilename();
    }
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `year-share-${role}-${theme}.png`), buf);
    const png = PNG.read(buf);
    S.check(`share: ${role}: a PNG named for the year, 1080 x 1920`, buf.subarray(1, 4).toString() === 'PNG' && name === 'reel-picks-2026.png' && png.width === 1080 && png.height === 1920, `${name} ${png.width}x${png.height}`);
    const said = phone ? /Shared/ : /Image saved/;
    await p.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.yr-save-status')?.textContent || ''), said.source, { timeout: 5000 }).catch(() => {});
    S.check(`share: ${role}: it says the image is ${phone ? 'shared' : 'saved'} (the canvas wasn't tainted)`, said.test(await p.page.locator('.yr-save-status').textContent()));
    const texts = await p.page.evaluate(() => window.__texts);
    const images = await p.page.evaluate(() => window.__images);
    const sum = recaps[role].cards.find((c) => c.kind === 'summary');
    const joined = texts.join(' | ');
    S.check(`share: ${role}: it carries their name, the year and their numbers`, texts.includes(`${NAMES[role]}'s`) && texts.includes('2026') && [sum.seen, sum.rated].every((n) => (n ? texts.includes(String(n)) : !texts.includes('seen in theaters') || n !== 0)), joined);
    if (!sum.seen) S.check(`share: ${role}: no zero on the image (nothing seen in theaters, so only films rated)`, !texts.includes('seen in theaters') && texts.includes('films rated'), joined);
    const others = Object.entries(NAMES).filter(([k]) => k !== role).map(([, v]) => v).filter((v) => joined.includes(v));
    S.check(`share: ${role}: no one else's name, no invite link, no web address, no place but none at all`, !others.length && !/invite|http|www\.|\.com|Maple Grove|Riverside|Testville/i.test(joined), `${others.join(',')} ${joined}`);
    S.check(`share: ${role}: ${sum.posters.length} of their posters (at least ${min}), each drawn from this server`, sum.posters.length >= min && images.length === sum.posters.length && images.every((u) => u.startsWith(`${w.base}/api/year/poster/`)) && posterAsks.length >= sum.posters.length
      && sum.posters.every((f) => images.some((u) => u.includes(`/poster/${f.tmdb_id}`))), images.join(' '));
    // The posters painted: each slot's middle differs from the page colour beside the row.
    const px = (x, y) => { const o = (y * png.width + x) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
    const pw = (1080 - 192 - 72) / 4; const ph = pw * 1.5;
    const factsEnd = 1160 + 76 * [sum.genre, sum.director].filter(Boolean).length;
    const top = Math.min(factsEnd + 40, 1920 - 112 - ph);
    const bg = px(40, Math.round(top + ph / 2));
    const painted = sum.posters.map((_, i) => px(Math.round(96 + i * (pw + 24) + pw / 2), Math.round(top + ph / 2))).filter((c) => c.some((v, k) => Math.abs(v - bg[k]) > 12)).length;
    S.check(`share: ${role}: every poster is painted on the image`, painted === sum.posters.length, `${painted} of ${sum.posters.length}`);
    S.check(`share: ${role}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await browser.close();
await w.close();
S.finish();
