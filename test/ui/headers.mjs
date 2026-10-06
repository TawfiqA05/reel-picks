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
import http from 'node:http';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open, go } from '../lib/browser.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('headers');
const w = S.world(await openWorld('headers'));
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

const invite = async (name) => {
  const r = await w.api('POST', '/api/friends', { body: { name } });
  return { id: r.json.friend.id, token: new URL(r.json.invite, 'http://x').searchParams.get('invite') };
};
const pending = async (id) => (await w.api('GET', '/api/friends')).json.friends.find((f) => f.id === id)?.invite_pending;

// ------------------------------------------------------------------ join
await S.step('join: Join works in a browser that sends no Sec-Fetch-Site', async () => {
  const px = await proxy({ strip: true, guest: true });
  for (const [engine, browser] of ENGINES) {
    const D = await invite(`Old ${engine}`);
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

await chromium.close();
await webkit.close();
await w.close();
S.finish();
