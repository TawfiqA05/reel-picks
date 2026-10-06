// The security headers in real browsers (server/lib/headers.js, and the two
// write checks in server/index.js).
//
//   join      Safari before 16.4 sends no Sec-Fetch-Site; stood in for by a
//             proxy that takes those headers off. Pressing Join on the Join
//             page still signs the friend in, because the page's
//             Referrer-Policy (same-origin) lets its form carry the site's own
//             Origin. Chromium and WebKit.
import http from 'node:http';
import { suite } from '../lib/check.mjs';
import { openWorld } from '../lib/world.mjs';
import { launch, open } from '../lib/browser.mjs';

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

await chromium.close();
await webkit.close();
await w.close();
S.finish();
