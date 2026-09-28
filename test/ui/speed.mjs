// Speed budgets (final-polish G13, R13). The old gate compared timings with
// the commit before a change; a permanent test has no such commit, so it
// holds the app to budgets instead. Byte and request budgets were measured on
// main (eebcf84) in this sample world and set at about 1.3x, so ordinary
// changes pass and a big regression fails. A budget that a change means to
// break is raised here on purpose, with the new measurement. Timing budgets are generous (5x or
// more what a quiet machine takes) so a busy machine running suites side by
// side doesn't trip them; they catch something going badly wrong, not a
// few milliseconds.
//
//   RP_SPEED_MEASURE=1 node test/ui/speed.mjs   prints today's measurements
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, settle } from '../lib/browser.mjs';

// Measured on main (eebcf84) on 2026-09-28, compressed bytes over the wire,
// twice with the same result -> budget at about 1.3x.
const BUDGET = {
  jsBytes: 160000, // cold Picks, every JS module (all are preloaded): 122.2 KB
  cssBytes: 30000, // styles.css: 22.7 KB
  jsCssBytes: 190000, // together: 144.9 KB
  sameOriginRequests: 51, // cold Picks, app requests (page, modules, CSS, API, icons): 39
  fontFiles: 2, // the two families, latin subset (exactly)
  recommendationsBytes: 7700, // /api/recommendations for the owner: 5.9 KB
  posterRequestsCold: 6, // posters fetched on a cold Picks load before scrolling: 4
  // What the service worker fetches to install. Playwright turns the HTTP
  // cache off whenever requests are routed (and every test context routes
  // outside requests), so this counts the whole precache list, not the 304s a
  // real phone gets back: 149.5 KB.
  swInstallBytes: 195000,
  rateShowAllBytes: 280000, // 700-rating friend, cold Rate plus Show all, everything fetched: 215.6 KB
  // Timings (ms), generous on purpose (quiet machine in brackets).
  picksReadyMs: 8000, // cold Picks to hero on screen (~200 ms)
  rateShowAllMs: 8000, // 708 ratings listed after Show all (~60 ms)
  statsReadyMs: 8000, // Stats for the 700-rating friend (~100 ms)
  filterKeyMs: 1500, // slowest key typed into the Rate filter with 708 ratings (~60 ms)
  apiMs: 3000, // any read endpoint, locally (under 50 ms)
};

const S = suite('speed');
const w = S.world(await openWorld('speed'));
const robin = w.friends.robin;
const measure = process.env.RP_SPEED_MEASURE === '1';
const seen = {};
const within = (name, value, budget, unit = 'B') => {
  seen[name] = value;
  S.check(`${name} is within its budget (${budget}${unit === 'B' ? ' bytes' : unit === 'ms' ? ' ms' : ''})`, value != null && value <= budget, `measured ${value}`);
};

// Every response a page gets, with its compressed size over the wire.
function recorder(page, base) {
  const rows = [];
  page.on('requestfinished', async (req) => {
    const res = await req.response().catch(() => null);
    if (!res) return;
    const sizes = await req.sizes().catch(() => null);
    const url = req.url();
    rows.push({
      url, local: url.startsWith(base) ? url.slice(base.length) : url, type: req.resourceType(), status: res.status(),
      bytes: sizes ? sizes.responseBodySize : 0, enc: res.headers()['content-encoding'] || '', sw: res.fromServiceWorker(), bySw: Boolean(req.serviceWorker?.()),
    });
  });
  return rows;
}
const sum = (rows) => rows.reduce((n, r) => n + (r.bytes || 0), 0);

const chromium = await launch('chromium');

await S.step('cold Picks load as the owner at 390', async () => {
  const { ctx, page, errors } = await open(chromium, w, { width: 390, theme: 'light' });
  const rows = recorder(page, w.base);
  const t0 = Date.now();
  await page.goto(`${w.base}/#/home`);
  await page.waitForSelector('.hero-pick', { timeout: 30000 }).catch(() => {});
  const ready = Date.now() - t0;
  await settle(page, 800);
  const js = rows.filter((r) => r.local.startsWith('/') && /\.m?js(\?|$)/.test(r.local));
  const css = rows.filter((r) => r.local.startsWith('/') && /\.css(\?|$)/.test(r.local));
  within('cold Picks: JS', sum(js), BUDGET.jsBytes);
  within('cold Picks: CSS', sum(css), BUDGET.cssBytes);
  within('cold Picks: JS and CSS together', sum(js) + sum(css), BUDGET.jsCssBytes);
  within('cold Picks: requests to the app', rows.filter((r) => r.local.startsWith('/')).length, BUDGET.sameOriginRequests, 'n');
  const fonts = rows.filter((r) => /fonts\.gstatic\.com/.test(r.url));
  S.check(`cold Picks: exactly ${BUDGET.fontFiles} font files are downloaded`, fonts.length === BUDGET.fontFiles, fonts.map((f) => f.url.split('/').pop()).join(', '));
  seen['font files'] = fonts.length;
  const rec = rows.find((r) => r.local === '/api/recommendations');
  within('cold Picks: /api/recommendations', rec?.bytes, BUDGET.recommendationsBytes);
  S.check('cold Picks: /api/recommendations is sent compressed', Boolean(rec?.enc && rec.enc !== 'identity'), rec?.enc);
  const appjs = rows.find((r) => r.local.startsWith('/js/app.js'));
  const styles = rows.find((r) => r.local.startsWith('/styles.css'));
  S.check('cold Picks: JS and CSS are sent compressed', Boolean(appjs?.enc) && Boolean(styles?.enc), `app.js ${appjs?.enc}, styles.css ${styles?.enc}`);
  within('cold Picks: posters fetched before scrolling (lazy posters stay lazy)', rows.filter((r) => /image\.tmdb\.org/.test(r.url)).length, BUDGET.posterRequestsCold, 'n');
  within('cold Picks: hero on screen', ready, BUDGET.picksReadyMs, 'ms');
  // No poster file wider than 4x the width it's shown at (185 always allowed); the hero uses srcset.
  const big = await page.evaluate(() => [...document.images].filter((i) => i.currentSrc && /image\.tmdb\.org/.test(i.currentSrc)).map((i) => {
    const r = i.getBoundingClientRect(); const m = i.currentSrc.match(/\/t\/p\/w(\d+)\//);
    return { cls: i.className, file: m ? Number(m[1]) : null, css: Math.round(r.width) };
  }).filter((i) => i.file && i.css > 0 && !/hero/.test(i.cls) && i.file > Math.max(4 * i.css, 185)));
  S.check('cold Picks: no poster file is wider than 4x its shown width', !big.length, JSON.stringify(big.slice(0, 3)));
  S.check('cold Picks: no console error or failed request', !errors.length, errors.join(' | '));
  await ctx.close();
});

await S.step('the service worker installs lightly and handles the second load', async () => {
  const { ctx, page, errors } = await open(chromium, w, { width: 390, theme: 'dark', sw: true });
  const rows = recorder(page, w.base);
  const swRows = [];
  ctx.on('requestfinished', async (req) => {
    if (!req.serviceWorker?.()) return;
    const sizes = await req.sizes().catch(() => null);
    swRows.push({ url: req.url(), bytes: sizes ? sizes.responseBodySize : 0 });
  });
  await page.goto(`${w.base}/#/home`); await settle(page, 500);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  within('service worker install: bytes fetched', sum(swRows), BUDGET.swInstallBytes);
  rows.length = 0;
  await page.reload(); await settle(page, 500);
  const shell = rows.filter((r) => r.local.startsWith('/') && ['document', 'script', 'stylesheet'].includes(r.type));
  S.check('second load: the page, scripts and styles all go through the service worker', shell.length > 3 && shell.every((r) => r.sw), shell.filter((r) => !r.sw).map((r) => r.local).join(', ') || `${shell.length} files`);
  S.check('service worker: no console error or failed request', !errors.length, errors.join(' | '));
  await ctx.close();
});

await S.step('the 700-rating friend\'s big lists', async () => {
  const { ctx, page, errors } = await open(chromium, w, { role: robin, width: 390, theme: 'light' });
  const rows = recorder(page, w.base);
  await page.goto(`${w.base}/#/rate`); await settle(page, 500);
  const more = page.locator('#main .show-all').first();
  S.check('Rate: there is a Show all button for 700 ratings', await more.count() > 0);
  let t0 = Date.now();
  if (await more.count()) {
    await more.click();
    await page.waitForFunction(() => document.querySelectorAll('#rating-list > *').length >= 700, null, { timeout: 30000 }).catch(() => {});
  }
  const shown = await page.locator('#rating-list > *').count();
  within('Rate: Show all lists every rating', Date.now() - t0, BUDGET.rateShowAllMs, 'ms');
  S.check('Rate: Show all lists all 708 ratings', shown >= 700, `${shown}`);
  within('Rate: everything fetched for Rate and Show all', sum(rows), BUDGET.rateShowAllBytes);
  const filter = page.locator('#main input[type="search"], #main input.filter, #main input[placeholder*="ilter" i]').first();
  if (await filter.count()) {
    let worst = 0;
    for (const ch of 'harbor') {
      const t = Date.now();
      await filter.press(ch);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      worst = Math.max(worst, Date.now() - t);
    }
    within('Rate: slowest key typed into the filter with 700 ratings', worst, BUDGET.filterKeyMs, 'ms');
  } else S.check('Rate: the filter field is there', false, 'no filter input found');
  t0 = Date.now();
  await page.goto(`${w.base}/#/stats`);
  await page.waitForSelector('.big-stat', { timeout: 30000 }).catch(() => {});
  within('Stats: on screen for the 700-rating friend', Date.now() - t0, BUDGET.statsReadyMs, 'ms');
  S.check('big lists: no console error or failed request', !errors.length, errors.join(' | '));
  await ctx.close();
});

await S.step('read endpoints answer quickly', async () => {
  for (const [p, as] of [['/api/recommendations', null], ['/api/recommendations', robin], ['/api/coming-soon', null], ['/api/stats', robin], ['/api/ratings', robin], ['/api/movies/990001', null], ['/api/status', null]]) {
    const t = Date.now();
    const r = await w.api('GET', p, { as });
    within(`API ${p} as ${as ? 'the 700-rating friend' : 'the owner'}`, r.status === 200 ? Date.now() - t : null, BUDGET.apiMs, 'ms');
  }
});

await chromium.close();
if (measure) console.log(`measured: ${JSON.stringify(seen, null, 1)}`);
await w.close();
S.finish();
