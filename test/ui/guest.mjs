// The guest link's pages at phone and laptop width: every page a guest can
// open loads with no error, the banner and the heading over the four say
// whose they aren't, every score reads as a public score, and there is no
// taste match, no Coming Soon match and no line about anyone's taste. The
// owner and a friend still see their own words.
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, VISIBLE } from '../lib/browser.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('guest');
const w = S.world(await openWorld('guestui'));
const browser = await launch();
const BANNER = 'You\'re viewing what\'s playing this week, ranked by public reviews. Ask whoever shared this link for an invite to get picks of your own.';
const PAGES = ['home', 'schedule/leaving', 'schedule/coming', `movie/${C.PLAYING[0].id}`, `movie/${C.UPCOMING[0].id}`, `person/${C.PEOPLE.ada.id}`];

const read = (page) => page.evaluate((vis) => {
  const v = eval(vis);
  const text = (sel) => [...document.querySelectorAll(sel)].filter(v).map((e) => e.textContent.trim());
  return {
    banner: document.querySelector('#guest-banner')?.textContent.trim() || '',
    bannerShown: Boolean([...document.querySelectorAll('#guest-banner')].find(v)),
    headings: text('.section-title h1, .section-title h2'),
    subs: [...document.querySelectorAll('.section-title')].filter(v).map((t) => [t.querySelector('h1, h2')?.textContent.trim(), t.querySelector('.section-sub')?.textContent.trim() || null]),
    badges: text('.match'),
    taste: Boolean([...document.querySelectorAll('#taste-title')].find(v)),
    reasons: text('.reason-line'),
    body: document.querySelector('#main')?.innerText || '',
  };
}, VISIBLE);

await S.step('guest pages at phone and laptop width', async () => {
  for (const width of [390, 1280]) {
    const p = await open(browser, w, { role: 'guest', width, theme: width === 390 ? 'light' : 'dark' });
    for (const hash of PAGES) {
      await go(p.page, w, hash, 500);
      const r = await read(p.page);
      const at = `guest ${width} #/${hash}`;
      S.check(`${at}: the banner reads the approved words`, r.banner === BANNER && r.bannerShown, r.banner);
      S.check(`${at}: no match and no taste match, only public scores`, !r.badges.some((b) => /match/i.test(b)) && !r.taste && !/% match|Taste match/.test(r.body), JSON.stringify(r.badges.slice(0, 4)));
      S.check(`${at}: no line about anyone's taste, watchlist or name`, !new RegExp(`taste|watchlist|\\b${C.OWNER_NAME}\\b|You (love|like|rate)`, 'i').test(r.reasons.join(' | ')), r.reasons.slice(0, 3).join(' | '));
      if (hash === 'home') {
        S.check(`${at}: the heading over the four is "The rest of the top four by reviews"`, r.headings.includes('The rest of the top four by reviews'), r.headings.join(' / '));
        S.check(`${at}: the picks show public scores`, r.badges.length >= 4 && r.badges.every((b) => /^(Reviews \d+|No reviews yet)$/.test(b)), r.badges.slice(0, 6).join(', '));
      }
      if (hash === 'schedule/coming') {
        const sub = r.subs.find(([t]) => t === 'Coming soon');
        S.check(`${at}: no match badge and no subtitle`, !r.badges.length && sub && sub[1] == null, JSON.stringify([r.badges, sub]));
      }
    }
    S.check(`guest ${width}: no console error, page error or failed request on any page`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    S.check(`guest ${width}: nothing asked of the outside`, !p.outside.length, p.outside.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await S.step('the owner and a friend keep their own words', async () => {
  for (const [name, role] of [['owner', 'owner'], ['friend', w.friends.robin]]) {
    for (const width of [390, 1280]) {
      const p = await open(browser, w, { role, width });
      await go(p.page, w, 'home', 500);
      let r = await read(p.page);
      S.check(`${name} ${width}: no guest banner`, !r.bannerShown && !r.banner, r.banner);
      S.check(`${name} ${width}: the heading over the four is "The rest of your four"`, r.headings.includes('The rest of your four'), r.headings.join(' / '));
      S.check(`${name} ${width}: the picks show the match`, r.badges.some((b) => /^\d+% match/.test(b)), r.badges.slice(0, 4).join(', '));
      await go(p.page, w, `movie/${C.PLAYING[0].id}`, 500);
      r = await read(p.page);
      S.check(`${name} ${width}: the movie page has the Taste match`, r.taste);
      await go(p.page, w, 'schedule/coming', 500);
      r = await read(p.page);
      const sub = r.subs.find(([t]) => t === 'Coming soon');
      S.check(`${name} ${width}: Coming Soon has its match badges and subtitle`, r.badges.some((b) => /% match/.test(b)) && Boolean(sub?.[1]), JSON.stringify([r.badges.slice(0, 2), sub]));
      S.check(`${name} ${width}: no console error, page error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
      await p.ctx.close();
    }
  }
});

await browser.close();
await w.close();
S.finish();
