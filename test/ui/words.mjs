// No "null", "undefined" or "NaN" on screen. Every screen each role can reach
// (the owner, the 700-rating friend, the 3-rating friend, the brand-new friend
// on the welcome setup, and the guest), plus the search sheet, What should I
// watch? and, in December, the year recap's cards, with the clock outside the
// recap dates (Sept 23) and inside them (Dec 10):
//
//   words    no visible text reads null, undefined or NaN
//   you      outside Dec 1 to Jan 15 the You page has nothing between its
//            heading and the segments (no stray text), and inside it shows
//            the "Your 2026 in movies" row
//   clean    no console error, failed request or sideways scroll
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';
import { waitDialog } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('words');
const w = S.world(await openWorld('words'));
const F = w.friends;
for (const f of C.RATED.slice(10, 13)) await w.api('POST', '/api/ratings', { as: F.casey, body: { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year } });
const MOVIE = C.PLAYING[0].id;
const PERSON = C.PEOPLE.ada.id;
const ALL = ['home', `movie/${MOVIE}`, `person/${PERSON}`, 'schedule', 'schedule/coming', 'schedule/leaving', 'rate', 'watchlist', 'you', 'stats', 'together', 'settings', 'help', 'onboarding'];
const ROLES = {
  owner: { as: 'owner', screens: ALL, sheets: true },
  robin: { as: F.robin, screens: ALL, sheets: true },
  casey: { as: F.casey, screens: ALL, sheets: false },
  jordan: { as: F.jordan, screens: ['welcome', 'home', 'settings', 'help'], sheets: false },
  guest: { as: 'guest', screens: ['home', `movie/${MOVIE}`, 'schedule', 'schedule/leaving'], sheets: false },
};
const CLOCKS = { outside: C.T0, inside: '2026-12-10T12:00:00-05:00' };
const BAD = /\b(null|undefined|NaN)\b/;
const browser = await launch();
let visits = 0;

// Visible text, with each hit shown in its line.
const scan = (page) => page.evaluate((src) => {
  const re = new RegExp(src);
  return document.body.innerText.split('\n').filter((l) => re.test(l)).map((l) => l.trim().slice(0, 120));
}, BAD.source);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

for (const [when, iso] of Object.entries(CLOCKS)) {
  await w.restart({ fakeNow: iso });
  for (const [role, R] of Object.entries(ROLES)) {
    const p = await open(browser, w, { role: R.as, width: 390, allow403: role === 'guest' });
    const hits = [];
    const wide = [];
    for (const s of R.screens) {
      await p.page.goto('about:blank');
      await p.page.goto(`${w.base}/#/${s}`);
      await settle(p.page, 400);
      visits++;
      for (const l of await scan(p.page)) hits.push(`#/${s}: ${l}`);
      if (await sideways(p.page)) wide.push(s);
      if (s === 'you' && role !== 'guest') {
        const you = await p.page.evaluate(() => {
          const main = document.querySelector('#main');
          const head = main?.querySelector('.page-head');
          const seg = main?.querySelector('.you-seg');
          const between = [];
          for (let n = head?.nextSibling; n && n !== seg; n = n.nextSibling) between.push(n.nodeType === 3 ? `text:${n.textContent}` : n.className);
          const stray = [...(main?.querySelectorAll('*') || []), main].flatMap((el) => [...(el?.childNodes || [])]).filter((n) => n.nodeType === 3 && /^(null|undefined|NaN)$/.test(n.textContent.trim())).length;
          return { between, stray, row: main?.querySelector('.year-entry')?.innerText || null };
        });
        if (role !== 'jordan') {
          if (when === 'outside') S.check(`you: outside the recap dates nothing sits between the heading and the segments (${role})`, you.between.length === 0 && you.stray === 0, JSON.stringify(you));
          else S.check(`you: inside the recap dates the year row shows (${role})`, you.between.length === 1 && /Your 2026 in movies/.test(you.row || '') && you.stray === 0, JSON.stringify(you));
        }
      }
    }
    if (R.sheets) {
      await p.page.goto(`${w.base}/#/home`);
      await settle(p.page, 400);
      await p.page.click('#search-btn');
      await p.page.waitForSelector('.search-input');
      await p.page.fill('.search-input', 'a');
      await p.page.waitForTimeout(900);
      visits++;
      for (const l of await scan(p.page)) hits.push(`search: ${l}`);
      await p.page.keyboard.press('Escape');
      await p.page.waitForTimeout(300);
      if (await p.page.locator('#wsw-btn').count()) {
        await p.page.click('#wsw-btn');
        await waitDialog(p.page);
        await p.page.waitForTimeout(800);
        visits++;
        for (const l of await scan(p.page)) hits.push(`what should I watch: ${l}`);
        await p.page.keyboard.press('Escape');
        await p.page.waitForTimeout(300);
      }
      if (when === 'inside') {
        await p.page.goto(`${w.base}/#/you`);
        await settle(p.page, 400);
        await p.page.locator('#main .year-entry .btn').first().click();
        await waitDialog(p.page);
        await p.page.waitForSelector('.yr-card');
        // Every card of the recap, one after another.
        for (let i = 0; i < 12; i++) {
          await p.page.waitForTimeout(350);
          visits++;
          for (const l of await scan(p.page)) hits.push(`year card ${i + 1}: ${l}`);
          const before = await p.page.locator('.yr-count').textContent().catch(() => null);
          await p.page.keyboard.press('ArrowRight');
          await p.page.waitForTimeout(250);
          if ((await p.page.locator('.yr-count').textContent().catch(() => null)) === before) break;
        }
        await p.page.keyboard.press('Escape');
      }
    }
    S.check(`words: no null, undefined or NaN on any screen (${role}, ${when})`, hits.length === 0, hits.slice(0, 6).join(' | '));
    S.check(`clean: no sideways scroll (${role}, ${when})`, wide.length === 0, wide.join(', '));
    S.check(`clean: no console error or failed request (${role}, ${when})`, p.errors.length === 0 && p.outside.length === 0, [...p.errors, ...p.outside].slice(0, 4).join(' | '));
    await p.ctx.close();
  }
}
S.check('words: at least 90 screens and sheets looked at', visits >= 90, `${visits}`);

await browser.close();
await w.close();
S.finish();
