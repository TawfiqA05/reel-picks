// Space inside cards on the You pages (Stats, Together, Settings, Help), for
// the owner, the 700-rating friend, the 3-rating friend (one film hidden, so
// Hidden films has its button row) and the brand-new friend past the welcome
// setup, at 320, 390 and 1280, light and dark (test/lib/card-probe.mjs):
//
//   top      each card's first row starts as far below its top edge as its
//            content sits from its left edge (16px), and nothing (text,
//            control or filled box) comes closer to the top than that
//   bottom   its last row ends the same distance above the bottom edge
//   note     a card that opens with a note has 16px from the note to the
//            divider under it
//   clean    no console error, failed request or sideways scroll
//
// RP_SHOTS_DIR saves a screenshot of each page.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';
import { cardProbe } from '../lib/card-probe.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('spacing');
const SHOTS = process.env.RP_SHOTS_DIR || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
// One owner alert, so the Alerts card has its list under the notes.
const w = S.world(await openWorld('spacing', {
  prepare: (d) => d.prepare('INSERT INTO owner_alerts(problem, kind, message, at, pushed) VALUES(?,?,?,?,0)').run('backup', 'problem', 'The nightly backup failed: database or disk is full', C.T0),
}));
const F = w.friends;
for (const f of C.RATED.slice(10, 13)) await w.api('POST', '/api/ratings', { as: F.casey, body: { tmdb_id: f.id, rating: f.stars, title: f.title, year: f.year } });
await w.api('POST', '/api/hidden', { as: F.casey, body: { tmdb_id: C.PLAYING[1].id, title: C.PLAYING[1].title } });
await w.api('PUT', '/api/settings', { as: F.jordan, body: { setupDone: true, tourDone: true, youNoteSeen: true, onboardingDone: true } });
const ROLES = { owner: 'owner', robin: F.robin, casey: F.casey, jordan: F.jordan };
const PAGES = ['stats', 'together', 'settings', 'help'];
const browser = await launch();
const near = (a, b) => Math.abs(a - b) <= 1;
let cards = 0;
const seen = new Set();

for (const [role, as] of Object.entries(ROLES)) {
  for (const width of [320, 390, 1280]) {
    for (const theme of ['light', 'dark']) {
      const p = await open(browser, w, { role: as, width, theme });
      const bad = { top: [], bottom: [], note: [], wide: [] };
      for (const pg of PAGES) {
        await p.page.goto('about:blank');
        await p.page.goto(`${w.base}/#/${pg}`);
        await settle(p.page, 900);
        // The Hidden films count and the Alerts list fill in after the page.
        await p.page.waitForFunction(() => ![...document.querySelectorAll('#main p')].some((e) => e.textContent === 'Checking…'), null, { timeout: 5000 }).catch(() => {});
        await p.page.waitForTimeout(200);
        if (SHOTS && width === 390) await p.page.screenshot({ path: path.join(SHOTS, `${pg}-${role}-${width}-${theme}.png`), fullPage: true });
        for (const c of await p.page.evaluate(cardProbe)) {
          cards++;
          seen.add(`${pg}:${c.name}${c.note != null ? ':note' : ''}`);
          const at = `${pg} "${c.name}"`;
          if (!near(c.row, c.side) || c.top < c.side - 4) bad.top.push({ gap: Math.min(c.row, c.top), text: `${at} row ${c.row} top ${c.top} side ${c.side}` });
          if (!near(c.bottom, c.side)) bad.bottom.push(`${at} bottom ${c.bottom} side ${c.side}`);
          if (c.note != null && !near(c.note, 16)) bad.note.push(`${at} note to divider ${c.note}`);
        }
        if (await p.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) bad.wide.push(pg);
      }
      const tag = `${role} ${width} ${theme}`;
      // Tightest first, so the cards with text against the edge lead the detail.
      S.check(`top: every card's first row starts as far down as its side inset (${tag})`, !bad.top.length, bad.top.sort((a, b) => a.gap - b.gap).slice(0, 6).map((b) => b.text).join(' | '));
      S.check(`bottom: every card's last row ends as far up as its side inset (${tag})`, !bad.bottom.length, bad.bottom.slice(0, 5).join(' | '));
      S.check(`note: an opening note has 16px to the divider under it (${tag})`, !bad.note.length, bad.note.slice(0, 5).join(' | '));
      S.check(`clean: no sideways scroll, console error or failed request (${tag})`, !bad.wide.length && !p.errors.length && !p.outside.length, [...bad.wide, ...p.errors, ...p.outside].slice(0, 4).join(' | '));
      await p.ctx.close();
    }
  }
}
// The cards the report was about are among those measured, with their notes.
S.check('the Hidden films and Alerts cards were measured, Hidden films with its opening note over a divider', seen.has('settings:Hidden films:note') && seen.has('settings:Alerts'), [...seen].filter((s) => /Hidden|Alerts/.test(s)).join(', '));
S.check('Stats, Settings and Help cards were all measured (at least 400 in all)', cards >= 400 && [...seen].some((s) => s.startsWith('stats:')) && [...seen].some((s) => s.startsWith('help:')), `${cards} cards`);

await browser.close();
await w.close();
S.finish();
