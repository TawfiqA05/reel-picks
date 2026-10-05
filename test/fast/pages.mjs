// What the server answers outside the app's own screens, in my own app and
// in demo mode.
//
//   search engines   my own app says "noindex, nofollow" (X-Robots-Tag) on
//                    every answer: the page, the guest view, the API for
//                    every role, refusals, static files and robots.txt.
//                    robots.txt allows crawling there, so a crawler can read
//                    the header. The demo is meant to be found: no header, and
//                    its robots.txt keeps crawlers off /api only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, startServer, tempDir, until, GUEST } from '../lib/world.mjs';

const S = suite('pages');
const OWNER_TOKEN = 'pages-owner-token-0123456789abcdef';
const w = S.world(await openWorld('pages', { env: { OWNER_TOKEN } }));
const friend = Object.values(w.friends)[0];

// A request exactly as given (no fetch normalising the path), from this
// machine; `host` picks the Host header.
const raw = (method, p, headers = {}, body = null) => new Promise((resolve) => {
  const rq = http.request({ host: '127.0.0.1', port: w.srv.port, method, path: p, headers: { host: `localhost:${w.srv.port}`, ...headers } }, (res) => {
    const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => {
      const buf = Buffer.concat(parts); const text = buf.toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
      resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
    });
  });
  rq.on('error', (e) => resolve({ status: 0, headers: {}, text: e.code || e.message, json: null, buf: Buffer.alloc(0) }));
  rq.setTimeout(15000, () => rq.destroy(new Error('no answer in 15 s')));
  if (body) rq.write(body); rq.end();
});
const at = (srv) => ({ get: (p, headers = {}) => fetch(`${srv.base}${p}`, { redirect: 'manual', headers }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() })) });

// The demo: the same app copy, started in demo mode on a folder of its own
// (its sample is built by its own refresh, so that stays on).
const demoDir = tempDir('pages-demo');
const demo = await startServer({ app: w.app, dataDir: path.join(demoDir, 'data'), env: { DEMO_MODE: '1', RP_DISABLE_REFRESH: '0' }, label: 'pages-demo' });
const demoReady = await until(() => demo.log().includes('Demo sample ready') || demo.child.exitCode != null, 60000);
S.check('setup: the demo server builds its sample', demoReady && demo.child.exitCode == null, demo.log().slice(-400));
const D = at(demo);
const NOINDEX = 'noindex, nofollow';

await S.step('my own app: noindex on every answer', async () => {
  const tries = [
    ['the page', 'GET', '/', {}],
    ['the page as a guest', 'GET', '/', GUEST],
    ['/index.html', 'GET', '/index.html', {}],
    ['the stylesheet', 'GET', '/styles.css', GUEST],
    ['a static script', 'GET', '/js/app.js', GUEST],
    ['the service worker', 'GET', '/sw.js', GUEST],
    ['the manifest', 'GET', '/manifest.webmanifest', GUEST],
    ['an icon', 'GET', '/icons/icon.svg', GUEST],
    ['robots.txt', 'GET', '/robots.txt', GUEST],
    ['the owner\'s API', 'GET', '/api/status', {}],
    ['a friend\'s API', 'GET', '/api/settings', friend.headers],
    ['the guest\'s API', 'GET', '/api/recommendations', GUEST],
    ['a guest refused an owner route', 'GET', '/api/stats', GUEST],
    ['a guest refused a change', 'POST', '/api/ratings', { ...GUEST, 'content-type': 'application/json' }],
    ['a cross-site change refused', 'PUT', '/api/settings', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }],
    ['an expired invite', 'GET', '/?invite=not-a-real-invite-token-at-all', GUEST],
    ['a Join from another site', 'POST', '/invite/join', { ...GUEST, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }],
    ['the owner unlock', 'GET', '/?owner=wrong', GUEST],
    ['a HEAD of the page', 'HEAD', '/', GUEST],
  ];
  for (const [label, method, p, headers] of tries) {
    const r = await raw(method, p, headers, method === 'GET' || method === 'HEAD' ? null : (/json/.test(headers['content-type']) ? '{}' : 'token=x'));
    S.check(`noindex: ${label} (${method} ${p})`, r.status > 0 && r.headers['x-robots-tag'] === NOINDEX, `${r.status} ${r.headers['x-robots-tag']}`);
  }
  // Off Railway a Host other than localhost is refused before anything else.
  const refused = await raw('GET', '/', { host: 'example.com' });
  S.check('noindex: the off-Railway Host refusal', refused.status === 403 && refused.headers['x-robots-tag'] === NOINDEX, `${refused.status} ${refused.headers['x-robots-tag']}`);
});

await S.step('my own app: robots.txt allows crawling', async () => {
  for (const [who, h] of [['the owner', {}], ['a guest', GUEST]]) {
    const r = await raw('GET', '/robots.txt', h);
    S.check(`robots.txt as ${who} is a plain-text file`, r.status === 200 && /^text\/plain/.test(r.headers['content-type'] || ''), `${r.status} ${r.headers['content-type']}`);
    S.check(`robots.txt as ${who} allows every crawler everywhere`, r.text === 'User-agent: *\nAllow: /\n', JSON.stringify(r.text.slice(0, 120)));
  }
});

await S.step('demo: findable, crawlers kept off /api', async () => {
  const r = await D.get('/robots.txt');
  S.check('demo robots.txt is a plain-text file', r.status === 200 && /^text\/plain/.test(r.headers.get('content-type') || ''), `${r.status} ${r.headers.get('content-type')}`);
  S.check('demo robots.txt keeps crawlers off /api only', r.text === 'User-agent: *\nDisallow: /api/\n', JSON.stringify(r.text.slice(0, 120)));
  for (const p of ['/', '/robots.txt', '/styles.css', '/js/app.js']) {
    const x = await D.get(p);
    S.check(`demo ${p}: no X-Robots-Tag`, x.status === 200 && !x.headers.get('x-robots-tag'), `${x.status} ${x.headers.get('x-robots-tag')}`);
  }
  const page = await D.get('/');
  S.check('demo page: no robots meta either', page.status === 200 && !/name="robots"/.test(page.text), `${page.status}`);
});

await demo.stop();
fs.rmSync(demoDir, { recursive: true, force: true });
await w.close();
S.finish();
