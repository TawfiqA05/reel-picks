// The security headers in real browsers (server/lib/headers.js, and the two
// write checks in server/index.js).
//
//   join      Safari before 16.4 sends no Sec-Fetch-Site; stood in for by a
//             proxy that takes those headers off. Pressing Join on the Join
//             page still signs the friend in, because the page's
//             Referrer-Policy (same-origin) lets its form carry the site's own
//             Origin. Chromium and WebKit.
//   saves     The app's own saves go through with and without Sec-Fetch-Site
//             (the write check refuses Origin "null" now, so they must carry
//             the site's own Origin).
//   features  With the Permissions-Policy on: Use my location fills the home
//             fields, the year recap's share call takes its image, Copy puts
//             the invite link on the clipboard, and the trailer frame gets
//             what it asks for. What the policy switches off is off.
//   policy    With the Content-Security-Policy on: every view, in light and
//             dark, for the owner, a friend and the guest, and the Join,
//             error, expired and not-found pages, logs no violation; the
//             inline scripts run, the fonts and the posters load. Then the
//             year recap and its saved image.
import http from 'node:http';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go, settle, toastText } from '../lib/browser.mjs';
import { waitDialog } from '../lib/ui-helpers.mjs';
import * as C from '../lib/catalog.mjs';
import { seedYear, DEC1 } from '../lib/year-seed.mjs';

const S = suite('headers');
const w = S.world(await openWorld('headers', { prepare: (d) => { seedYear(d); } }));
const chromium = await launch();
const webkit = await launch('webkit');
const ENGINES = [['Chromium', chromium], ['WebKit', webkit]];

// A proxy in front of the server. strip: takes every Sec-Fetch-* header off
// (a browser that sends none); guest: adds the share tunnel's header, so the
// server sees a visitor rather than this machine's owner. Every write is
// recorded with what the browser sent and the server's answer.
async function proxy({ strip = false, guest = false } = {}) {
  const writes = [];
  const srv = http.createServer((req, res) => {
    const headers = { ...req.headers };
    if (strip) for (const k of Object.keys(headers)) if (k.startsWith('sec-fetch-')) delete headers[k];
    if (guest) headers['cf-ray'] = 'test';
    const rec = ['GET', 'HEAD'].includes(req.method) ? null : {
      method: req.method, path: req.url, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null,
      sent: req.headers['sec-fetch-site'] ?? null, passed: headers['sec-fetch-site'] ?? null, status: null,
    };
    if (rec) writes.push(rec);
    const up = http.request({ host: '127.0.0.1', port: w.srv.port, path: req.url, method: req.method, headers }, (r) => {
      if (rec) rec.status = r.statusCode;
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${srv.address().port}`;
  return { base, writes, world: { get srv() { return w.srv; }, base }, close: () => new Promise((r) => srv.close(r)) };
}

// A fresh invite link each time, for one made-up friend (re-issued: the app
// holds nine people, and the made-up world has most of them already).
let tester = null;
const invite = async () => {
  const r = tester ? await w.api('POST', `/api/friends/${tester}/reissue`) : await w.api('POST', '/api/friends', { body: { name: 'Header Test' } });
  tester = r.json.friend.id;
  return { id: tester, token: new URL(r.json.invite, 'http://x').searchParams.get('invite') };
};
const pending = async (id) => (await w.api('GET', '/api/friends')).json.friends.find((f) => f.id === id)?.invite_pending;

// ------------------------------------------------------------------ join
await S.step('join: Join works in a browser that sends no Sec-Fetch-Site', async () => {
  const px = await proxy({ strip: true, guest: true });
  for (const [engine, browser] of ENGINES) {
    const D = await invite();
    const p = await open(browser, px.world, { width: 390, allow403: true });
    const res = await p.page.goto(`${px.base}/?invite=${D.token}`);
    S.check(`join: ${engine}: the Join page sends Referrer-Policy: same-origin`, res.headers()['referrer-policy'] === 'same-origin', res.headers()['referrer-policy']);
    await p.page.locator('form[action="/invite/join"] button').click();
    await p.page.waitForLoadState('load');
    const post = px.writes.filter((x) => x.path === '/invite/join').at(-1);
    S.check(`join: ${engine}: the stand-in took Sec-Fetch-Site off the Join form`, post && post.passed === null, JSON.stringify(post));
    S.check(`join: ${engine}: the Join form carried the site's own Origin`, post?.origin === px.base, JSON.stringify(post));
    S.check(`join: ${engine}: the Join form's Referer, if any, stayed on the site`, post && (post.referer === null || post.referer.startsWith(`${px.base}/`)), post?.referer);
    S.check(`join: ${engine}: with no Sec-Fetch-Site, Join signs the friend in`, post?.status === 303 && await pending(D.id) === false, `${post?.status}`);
    await p.ctx.close();
  }
  await px.close();
});

// ------------------------------------------------------------------ saves
await S.step('saves: the app\'s own saves work with and without Sec-Fetch-Site', async () => {
  const film = C.PLAYING[0];
  const listed = () => w.q('SELECT 1 FROM watchlist WHERE user_id = 1 AND tmdb_id = ?', film.id).length > 0;
  const pressed = (page, v) => page.waitForFunction((x) => document.querySelector('.detail-actions .wl-btn')?.getAttribute('aria-pressed') === String(x), v, { timeout: 8000 }).catch(() => {});
  for (const strip of [false, true]) {
    const px = await proxy({ strip });
    const how = strip ? 'without Sec-Fetch-Site' : 'with Sec-Fetch-Site';
    for (const [engine, browser] of ENGINES) {
      const p = await open(browser, px.world, { width: 1280 });
      await go(p.page, px.world, `movie/${film.id}`, 500);
      const was = listed();
      const n0 = px.writes.length;
      await p.page.locator('.detail-actions .wl-btn').click();
      await pressed(p.page, !was);
      const mid = listed();
      await p.page.locator('.detail-actions .wl-btn').click();
      await pressed(p.page, was);
      // A PUT and a DELETE through the app's own request code (js/api.js).
      const more = await p.page.evaluate(async (id) => {
        const { api } = await import('/js/api.js');
        const out = [];
        try { const s = await api.settings(); await api.saveSettings({ previewsMinutes: s.previewsMinutes }); out.push('put ok'); } catch (e) { out.push(`put ${e.message}`); }
        try { await api.hide(id, 'x'); await api.unhide(id); out.push('hide ok'); } catch (e) { out.push(`hide ${e.message}`); }
        return out;
      }, film.id);
      const mine = px.writes.slice(n0);
      S.check(`saves: ${engine} ${how}: the watchlist button saved both ways`, mid === !was && listed() === was && mine.filter((x) => x.path === '/api/watchlist/toggle' && x.status === 200).length === 2, JSON.stringify(mine.slice(0, 2)));
      S.check(`saves: ${engine} ${how}: a settings save and a hide and unhide went through`, more.join() === 'put ok,hide ok', more.join());
      S.check(`saves: ${engine} ${how}: every write answered 200`, mine.length >= 5 && mine.every((x) => x.status === 200), JSON.stringify(mine.map((x) => `${x.method} ${x.path} ${x.status}`)));
      S.check(`saves: ${engine} ${how}: every write carried the site's own Origin`, mine.every((x) => x.origin === px.base), JSON.stringify(mine.map((x) => x.origin)));
      S.check(`saves: ${engine} ${how}: the server saw ${strip ? 'no' : 'the browser\'s'} Sec-Fetch-Site`, mine.length > 0 && mine.every((x) => x.sent === 'same-origin' && x.passed === (strip ? null : 'same-origin')), JSON.stringify(mine.map((x) => [x.sent, x.passed])));
      S.check(`saves: ${engine} ${how}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
      await p.ctx.close();
    }
    await px.close();
  }
});

// ------------------------------------------------------------------ features
const TRAILER_FILM = C.PLAYING.find((f) => f.trailer);
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
await S.step('features: what the Permissions-Policy leaves on works', async () => {
  const p = await open(chromium, w, { width: 390 });
  const policyLines = [];
  p.page.on('console', (m) => { if (/permissions.policy|feature.policy|unrecognized feature/i.test(m.text())) policyLines.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
  await p.ctx.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write'], { origin: w.base });
  await p.ctx.setGeolocation({ latitude: C.HOME.lat, longitude: C.HOME.lng });
  const res = await p.page.goto(`${w.base}/#/settings`);
  await settle(p.page, 700);
  S.check('features: the page carries the Permissions-Policy', /^geolocation=\(self\), web-share=\(self\), /.test(res.headers()['permissions-policy'] || ''), res.headers()['permissions-policy']);

  // The home lookup asks for the location (views/settings.js).
  await p.page.locator('button', { hasText: 'Use my location' }).click();
  await p.page.waitForFunction(() => /^(Found|Coordinates set)/.test(document.querySelector('.geo-status')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const geo = await p.page.evaluate(() => ({ status: document.querySelector('.geo-status')?.textContent, lat: document.querySelector('input[placeholder="lat"]')?.value }));
  S.check('features: Use my location gets the position and fills the home fields', /^Found /.test(geo.status || '') && Number(geo.lat) === Math.round(C.HOME.lat * 100) / 100, JSON.stringify(geo));

  // The invite link is copied (views/settings/owner.js).
  const fc = p.page.locator('.settings-group', { has: p.page.locator('.group-title', { hasText: /^Friends$/ }) });
  await fc.locator('input[aria-label="Friend\'s name"]').fill('Copy Test');
  await fc.locator('button', { hasText: 'Create invite link' }).click();
  await p.page.waitForSelector('input[aria-label="Invite link for Copy Test"]', { timeout: 8000 });
  await p.page.locator('.import-box button', { hasText: 'Copy' }).click();
  const copied = await toastText(p.page, /copied|copy it/i);
  S.check('features: Copy puts the invite link on the clipboard', copied === 'Link copied', copied);

  // The year recap's share call (year.js): canShare with its image file.
  const share = await p.page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'reel-picks-2026.png', { type: 'image/png' });
    return { has: typeof navigator.share === 'function', can: Boolean(navigator.canShare?.({ files: [file] })) };
  }, PNG_BYTES);
  S.check('features: the share sheet takes the year recap\'s image', share.has && share.can, JSON.stringify(share));

  // What the policy switches off is off here (each one this browser knows).
  const off = await p.page.evaluate(() => {
    const fp = document.featurePolicy;
    const known = new Set(fp.features());
    const list = ['camera', 'microphone', 'payment', 'usb', 'serial', 'hid', 'bluetooth', 'midi', 'display-capture', 'magnetometer',
      'xr-spatial-tracking', 'screen-wake-lock', 'idle-detection', 'browsing-topics', 'clipboard-read', 'local-fonts', 'window-management', 'autoplay'];
    return { unknown: list.filter((f) => !known.has(f)), on: list.filter((f) => known.has(f) && fp.allowsFeature(f)) };
  });
  console.log(`  (switched-off features this Chromium doesn't know: ${off.unknown.join(', ') || 'none'})`);
  S.check('features: every switched-off feature this browser knows is off', !off.on.length, off.on.join(', '));

  // The trailer frame (views/detail.js), for the player's own origin.
  await go(p.page, w, `movie/${TRAILER_FILM.id}`, 500);
  await p.page.locator('.detail-actions button', { hasText: 'Trailer' }).click();
  await waitDialog(p.page);
  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) { frame = p.page.frames().find((f) => /youtube-nocookie\.com\/embed\//.test(f.url())); if (!frame) await p.page.waitForTimeout(100); }
  const allowed = frame ? await frame.evaluate(() => document.featurePolicy.allowedFeatures()) : [];
  const want = ['fullscreen', 'accelerometer', 'clipboard-write', 'compute-pressure', 'encrypted-media', 'gyroscope', 'picture-in-picture'];
  S.check('features: the trailer frame loads', Boolean(frame), p.page.frames().map((f) => f.url()).join(' '));
  S.check('features: the trailer frame may use fullscreen, accelerometer, clipboard-write, compute-pressure, encrypted-media, gyroscope and picture-in-picture', frame && want.every((f) => allowed.includes(f)), want.filter((f) => !allowed.includes(f)).join(', '));
  S.check('features: the trailer frame gets no camera, microphone, location or autoplay', frame && !['camera', 'microphone', 'geolocation', 'autoplay'].some((f) => allowed.includes(f)), allowed.join(' '));
  await p.page.keyboard.press('Escape');

  console.log(`  (policy lines in the console: ${policyLines.join(' | ') || 'none'})`);
  S.check('features: no Permissions-Policy error in the console', !policyLines.some((l) => l.startsWith('error')), policyLines.join(' | '));
  S.check('features: no console error or failed request', !p.errors.length, p.errors.slice(0, 3).join(' | '));
  await p.ctx.close();
});

// Every policy violation in the page, from the start of each document.
async function watchPolicy(ctx) {
  await ctx.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__violations.push(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI || ''} ${(e.sourceFile || '').replace(location.origin, '')}:${e.lineNumber || ''}`);
    });
  });
}
const violations = (page) => page.evaluate(() => { const v = window.__violations || []; window.__violations = []; return v; }).catch(() => ['(page gone)']);

// ------------------------------------------------------------------ policy
const MOVIE = C.PLAYING[0].id;
const PERSON = C.PEOPLE.ada.id;
const ALL = ['home', 'schedule', 'schedule/leaving', 'schedule/coming', `movie/${MOVIE}`, `person/${PERSON}`, 'rate', 'watchlist', 'you', 'stats', 'together', 'settings', 'help', 'welcome', 'onboarding'];
const GUEST_VIEWS = ['home', 'schedule', 'schedule/leaving', 'schedule/coming', `movie/${MOVIE}`, `person/${PERSON}`];
const ROLES = [['owner', 'owner', ALL], ['friend', w.friends.robin, ALL], ['guest', 'guest', GUEST_VIEWS]];

// The theme the page is drawn in (the Theme switch's inline script sets
// data-theme from a saved choice), the fonts, and the posters on screen.
const pageState = (page) => page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  rpTheme: typeof window.rpTheme?.get === 'function',
  fonts: document.fonts.check('700 30px "Big Shoulders Display"') && document.fonts.check('400 15px "IBM Plex Sans"'),
  // Posters without a srcset: a 1 x 1 stand-in under a width descriptor
  // reports no width even when it loaded.
  posters: [...document.querySelectorAll('img')].filter((i) => !i.srcset && /image\.tmdb\.org/.test(i.currentSrc || i.src) && i.complete).map((i) => i.naturalWidth > 0),
}));

await S.step('policy: every view, light and dark, logs no violation', async () => {
  for (const [engine, browser] of ENGINES) {
    for (const [name, role, views] of ROLES) {
      if (engine === 'WebKit' && name === 'friend') continue;
      for (const theme of ['light', 'dark']) {
        // A saved choice that differs from the device's: only the inline
        // Theme script can make the page follow it.
        const chosen = theme === 'light' ? 'dark' : 'light';
        const p = await open(browser, w, { role, width: engine === 'WebKit' ? 390 : 1280, theme, extraCtx: { storageState: { cookies: [], origins: [{ origin: w.base, localStorage: [{ name: 'rp.theme', value: chosen }] }] } } });
        await watchPolicy(p.ctx);
        const tag = `policy: ${engine} ${name} ${theme}`;
        const seen = [];
        let first = null;
        for (const v of views) {
          await go(p.page, w, v, 400);
          if (!first) first = await pageState(p.page);
          if (v === `movie/${MOVIE}` && name !== 'guest') {
            const t = p.page.locator('.detail-actions button', { hasText: 'Trailer' });
            if (await t.count()) { await t.click(); await waitDialog(p.page); await p.page.waitForTimeout(400); await p.page.keyboard.press('Escape'); await p.page.waitForTimeout(400); }
          }
          seen.push(...(await violations(p.page)).map((x) => `#/${v}: ${x}`));
        }
        const home = await (async () => { await go(p.page, w, 'home', 500); return pageState(p.page); })();
        seen.push(...(await violations(p.page)).map((x) => `#/home: ${x}`));
        S.check(`${tag}: no policy violation on ${views.length} views`, !seen.length, seen.slice(0, 4).join(' | '));
        S.check(`${tag}: the Theme script ran (the saved ${chosen} choice is drawn)`, first.rpTheme && first.theme === chosen, JSON.stringify(first));
        S.check(`${tag}: both web fonts loaded`, home.fonts, JSON.stringify(home));
        S.check(`${tag}: the posters on Picks loaded from TMDB`, home.posters.length >= 1 && home.posters.every(Boolean), JSON.stringify(home.posters));
        S.check(`${tag}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
        S.check(`${tag}: nothing asked of the outside`, !p.outside.length, p.outside.slice(0, 3).join(' | '));
        await p.ctx.close();
      }
    }
  }
});

await S.step('policy: the Join, expired, not-found and error pages log no violation', async () => {
  const px = await proxy({ guest: true });
  for (const [engine, browser] of ENGINES) {
    for (const theme of ['light', 'dark']) {
      const tag = `policy: ${engine} ${theme}`;
      const D = await invite();
      const p = await open(browser, px.world, { width: 390, theme, allow403: true });
      await watchPolicy(p.ctx);
      const pages = [];
      const visit = async (label, fn) => {
        await fn();
        await p.page.waitForLoadState('load'); await p.page.waitForTimeout(300);
        pages.push({ label, title: await p.page.title(), status: await p.page.evaluate(() => document.querySelector('h1')?.textContent || ''), v: await violations(p.page), theme: await p.page.evaluate(() => typeof window.rpTheme?.get === 'function') });
      };
      await visit('Join', () => p.page.goto(`${px.base}/?invite=${D.token}`));
      // A Join form far over its size: the error page (413).
      await visit('error', async () => { await p.page.locator('input[name="token"]').evaluate((i) => { i.value = 'a'.repeat(5000); }); await p.page.locator('form[action="/invite/join"] button').click(); });
      await visit('Join again', () => p.page.goto(`${px.base}/?invite=${D.token}`));
      await visit('Join pressed', () => p.page.locator('form[action="/invite/join"] button').click());
      await visit('expired', () => p.page.goto(`${px.base}/?invite=${D.token}`));
      await visit('not found', () => p.page.goto(`${px.base}/no-such-page`));
      const titles = pages.map((x) => `${x.label}: ${x.title}`).join(' / ');
      S.check(`${tag}: the Join, error, expired and not-found pages all showed`, /Join Reel Picks/.test(pages[0].title) && /Something went wrong/.test(pages[1].title) && /Invite expired/.test(pages[4].title) && /Page not found/.test(pages[5].title), titles);
      S.check(`${tag}: pressing Join on its page went through (form-action 'self')`, await pending(D.id) === false && px.writes.some((x) => x.path === '/invite/join' && x.status === 303));
      S.check(`${tag}: the Theme script ran on each server page`, pages.filter((x) => x.label !== 'Join pressed').every((x) => x.theme), titles);
      const v = pages.flatMap((x) => x.v.map((y) => `${x.label}: ${y}`));
      S.check(`${tag}: no policy violation on the server pages`, !v.length, v.slice(0, 4).join(' | '));
      await p.ctx.close();
    }
  }
  await px.close();
});

await S.step('policy: the year recap and its saved image log no violation', async () => {
  await w.restart({ fakeNow: DEC1 });
  for (const theme of ['light', 'dark']) {
    const p = await open(chromium, w, { width: 1280, theme });
    await watchPolicy(p.ctx);
    await go(p.page, w, 'home', 500);
    await p.page.locator('#main .year-entry .btn').first().click();
    await waitDialog(p.page);
    await p.page.waitForSelector('.yr-card');
    for (let k = 0; k < 12 && !(await p.page.locator('.yr-save').count()); k++) { await p.page.locator('.yr-next').click(); await p.page.waitForTimeout(300); }
    const [dl] = await Promise.all([p.page.waitForEvent('download', { timeout: 20000 }).catch(() => null), p.page.locator('.yr-save').click()]);
    await p.page.waitForTimeout(300);
    const v = await violations(p.page);
    S.check(`policy: year recap ${theme}: Save image downloads the PNG`, dl?.suggestedFilename() === 'reel-picks-2026.png', dl?.suggestedFilename());
    S.check(`policy: year recap ${theme}: no policy violation`, !v.length, v.slice(0, 4).join(' | '));
    S.check(`policy: year recap ${theme}: no console error or failed request`, !p.errors.length, p.errors.slice(0, 3).join(' | '));
    await p.ctx.close();
  }
});

await chromium.close();
await webkit.close();
await w.close();
S.finish();
