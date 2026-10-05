// What the server answers outside the app's own screens, in my own app and
// in demo mode.
//
//   search engines   my own app says "noindex, nofollow" (X-Robots-Tag) on
//                    every answer: the page, the guest view, the API for
//                    every role, refusals, static files and robots.txt.
//                    robots.txt allows crawling there, so a crawler can read
//                    the header. The demo is meant to be found: no header, and
//                    its robots.txt keeps crawlers off /api only.
//   not found        an address that isn't part of the app (a mistyped image,
//                    /js/typo.js, a deep link) gets a plain 404 page built like
//                    the Join page, in both modes; one under /api gets a JSON
//                    404 for the owner and friends, while a guest is still
//                    refused there first. Every link the app makes opens a
//                    page: the app moves between screens after the # only,
//                    and the owner unlock lands on the front page.
//   errors           an error on a page request (outside /api) gets a plain
//                    error page with its status kept: a 5xx says the server
//                    hit a problem, a 4xx that the request couldn't be read.
//                    Under /api the answer is the same JSON as before.
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, startServer, tempDir, until, sleep, GUEST, REPO } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('pages');
const OWNER_TOKEN = crypto.randomBytes(24).toString('base64url');
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

// The not-found page: its heading and line, a way to the front page, the
// app's stylesheet, and none of the app itself or anyone's name.
const isNotFound = (r) => r.status === 404 && /^text\/html/.test(hdr(r, 'content-type'))
  && /<title>Page not found<\/title>/.test(r.text) && /There’s no page here/.test(r.text)
  && /Check the address for a typo, or go to the front page\./.test(r.text)
  && /<a class="btn" href="\/">Go to Reel Picks<\/a>/.test(r.text) && /href="\/styles\.css"/.test(r.text)
  && !/js\/app\.js/.test(r.text) && !new RegExp(`\\b${C.OWNER_NAME}\\b`).test(r.text);
const hdr = (r, k) => (typeof r.headers.get === 'function' ? r.headers.get(k) : r.headers[k]) || '';
const UNKNOWN = ['/no-such-page', '/js/typo.js', '/icons/typo.png', '/some/deep/link', '/settings', '/index', '/favicon.png'];

await S.step('my own app: unknown paths get the not-found page', async () => {
  for (const [who, h] of [['the owner', {}], ['a guest', GUEST], ['a friend', friend.headers]]) {
    for (const p of UNKNOWN) {
      const r = await raw('GET', p, h);
      S.check(`${who}: GET ${p} is the not-found page`, isNotFound(r), `${r.status} ${hdr(r, 'content-type')} ${r.text.slice(0, 80)}`);
    }
  }
  const r = await raw('GET', '/no-such-page', GUEST);
  S.check('the not-found page is never cached', hdr(r, 'cache-control') === 'no-store', hdr(r, 'cache-control'));
  const head = await raw('HEAD', '/no-such-page', GUEST);
  S.check('HEAD of an unknown path is a 404', head.status === 404 && !head.text, `${head.status}`);
  const post = await raw('POST', '/no-such-page', { 'content-type': 'application/json' }, '{}');
  S.check('POST to an unknown path is the not-found page', isNotFound(post), `${post.status} ${post.text.slice(0, 80)}`);
  // Control: the pages that are there still answer.
  for (const p of ['/', '/index.html']) {
    const ok = await raw('GET', p, GUEST);
    S.check(`control: ${p} is still the app page`, ok.status === 200 && /js\/app\.js/.test(ok.text), `${ok.status}`);
  }
});

await S.step('my own app: unknown /api paths get a JSON 404', async () => {
  for (const [who, h] of [['the owner', {}], ['a friend', friend.headers]]) {
    for (const [m, p] of [['GET', '/api/no-such-route'], ['GET', '/api'], ['GET', '/api/movies/1/extra'], ['POST', '/api/no-such-route'], ['DELETE', '/api/no-such-route']]) {
      const body = m === 'POST' ? '{}' : null;
      const r = await raw(m, p, { ...h, ...(body ? { 'content-type': 'application/json' } : {}) }, body);
      S.check(`${who}: ${m} ${p} is a JSON 404`, r.status === 404 && /^application\/json/.test(hdr(r, 'content-type')) && r.json?.error === 'Not found', `${r.status} ${hdr(r, 'content-type')} ${r.text.slice(0, 80)}`);
    }
  }
  // A guest is refused there first, as before.
  for (const [m, p] of [['GET', '/api/no-such-route'], ['GET', '/api'], ['POST', '/api/no-such-route']]) {
    const r = await raw(m, p, { ...GUEST, ...(m === 'GET' ? {} : { 'content-type': 'application/json' }) }, m === 'GET' ? null : '{}');
    S.check(`a guest: ${m} ${p} is still the read-only 403`, r.status === 403 && r.json?.error === 'This shared link is read only.', `${r.status} ${r.text.slice(0, 80)}`);
  }
});

await S.step('demo: unknown paths get the not-found page', async () => {
  for (const p of ['/no-such-page', '/js/typo.js']) {
    const r = await D.get(p);
    S.check(`demo GET ${p} is the not-found page`, isNotFound(r), `${r.status} ${r.text.slice(0, 80)}`);
  }
  const api = await D.get('/api/no-such-route');
  let json = null; try { json = JSON.parse(api.text); } catch { /* not JSON */ }
  S.check('demo GET /api/no-such-route is a JSON 404', api.status === 404 && json?.error === 'Not found', `${api.status} ${api.text.slice(0, 80)}`);
  const page = await D.get('/');
  S.check('control: the demo page is still served', page.status === 200 && /js\/app\.js/.test(page.text), `${page.status}`);
});

// Every link the app makes, read from the source: notification and
// redirect targets on the server, and navigations in the page. Each opens
// the front page (its screen is after the #), or is an API or a static file.
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const LINK_CONTEXT = /\burl:|\b[A-Z_]*URL\s*=|\bredirect\(|\bnavigate\(|\bopenWindow\(|\blocation\.(?:replace|assign)\(|\blocation\.href\s*=|\bhref:|\breplaceState\(|\binvite:/;
function appLinks(files) {
  const out = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line) || !LINK_CONTEXT.test(line)) return;
      for (const m of line.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)) out.push({ at: `${path.relative(REPO, f)}:${i + 1}`, link: m[2] });
    });
  }
  return out;
}
const opensAPage = (link) => {
  const p = link.split(/[?#$]/)[0];
  return p === '/' || p.startsWith('/api/') || (p.length > 1 && fs.existsSync(path.join(REPO, 'public', p)));
};

await S.step('every link the app makes opens a page', async () => {
  const files = [...walk(path.join(REPO, 'server')), ...walk(path.join(REPO, 'public/js')), path.join(REPO, 'public/sw.js')].filter((f) => /\.m?js$/.test(f));
  const links = appLinks(files);
  S.check('the source scan finds the app\'s links (push, alerts, invites, redirects)', links.some((l) => l.link === '/#/home') && links.some((l) => l.link.startsWith('/?invite=')) && links.some((l) => l.link === '/#/settings') && links.length >= 10, `${links.length}`);
  const bad = links.filter((l) => !opensAPage(l.link));
  S.check('every link in the source opens the front page, an API or a file', !bad.length, bad.map((l) => `${l.at} ${l.link}`).join(', '));
  // Positive control: a link with a path of its own is noticed.
  const planted = path.join(w.dir, 'planted.js');
  fs.writeFileSync(planted, "send({ url: '/settings' });\n");
  S.check('control: a planted link with a path is caught', appLinks([planted]).filter((l) => !opensAPage(l.link)).length === 1);
  const man = JSON.parse(fs.readFileSync(path.join(REPO, 'public/manifest.webmanifest'), 'utf8'));
  for (const k of ['start_url', 'scope']) {
    const r = await raw('GET', man[k], GUEST);
    S.check(`the manifest's ${k} (${man[k]}) opens the app`, r.status === 200 && /js\/app\.js/.test(r.text), `${r.status}`);
  }
  // An invite link, made the way the owner makes one, opens the Join page.
  const inv = await w.api('POST', '/api/friends', { body: { name: 'Link Check' } });
  const join = await raw('GET', inv.json.invite, GUEST);
  S.check('an invite link opens the Join page', inv.json.invite.startsWith('/?invite=') && join.status === 200 && /You’re invited by/.test(join.text), `${join.status}`);
  await w.api('POST', `/api/friends/${inv.json.friend.id}/revoke`);
});

await S.step('the owner unlock lands on a page that is there', async () => {
  for (const [from, to] of [[`/?owner=${OWNER_TOKEN}`, '/'], [`/settings?owner=${OWNER_TOKEN}&x=1`, '/?x=1'], [`/no-such-page?owner=${OWNER_TOKEN}`, '/'], ['/index.html?owner=wrong', '/']]) {
    const r = await raw('GET', from, GUEST);
    const shown = from.replace(OWNER_TOKEN, '<token>');
    S.check(`${shown} redirects to ${to}`, r.status === 302 && hdr(r, 'location') === to, `${r.status} ${hdr(r, 'location').replace(OWNER_TOKEN, '<token>')}`);
    const next = await raw('GET', hdr(r, 'location') || '/x', GUEST);
    S.check(`${shown}: where it lands is the app page`, next.status === 200 && /js\/app\.js/.test(next.text), `${next.status}`);
  }
});

const SERVER_LINE = 'Something went wrong on the server. Try again.';
const UNREADABLE = 'Reel Picks couldn\'t read that request. Reload the page and try again.';
const TOO_BIG = 'That file is too big. Reel Picks takes files up to 20 MB.';
const isErrorPage = (r, status, line) => r.status === status && /^text\/html/.test(hdr(r, 'content-type'))
  && /<title>Something went wrong<\/title>/.test(r.text) && /<h1 class="empty-title">Something went wrong<\/h1>/.test(r.text)
  && r.text.includes(line) && /<a class="btn" href="\/">Go to Reel Picks<\/a>/.test(r.text)
  && !/js\/app\.js/.test(r.text) && !new RegExp(`\\b${C.OWNER_NAME}\\b`).test(r.text) && hdr(r, 'cache-control') === 'no-store';
const LINE_5XX = 'Reel Picks hit a problem on its end. Try again in a moment.';
const LINE_4XX = 'Reel Picks couldn’t read that request. Check the address, or go to the front page.';

await S.step('errors: a page request gets a page, an API request JSON', async () => {
  // A database failure behind the Join page (the invite lookup), and the
  // same kind behind an API read.
  w.writeCtrl({ dbFail: [{ sql: 'invite_token_hash' }, { sql: 'FROM ratings r LEFT JOIN movies m' }] });
  await sleep(120);
  const page = await raw('GET', `/?invite=${'a'.repeat(30)}`, GUEST);
  S.check('a 500 on a page is the error page', isErrorPage(page, 500, LINE_5XX), `${page.status} ${hdr(page, 'content-type')} ${page.text.slice(0, 120)}`);
  S.check('the error page shows nothing of the failure', !/database|disk is full|sqlite/i.test(page.text));
  S.check('the error page says noindex too', hdr(page, 'x-robots-tag') === NOINDEX, hdr(page, 'x-robots-tag'));
  const api = await raw('GET', '/api/ratings');
  S.check('control: a 500 under /api is still the JSON server line', api.status === 500 && api.json?.error === SERVER_LINE, `${api.status} ${api.text.slice(0, 120)}`);
  w.writeCtrl();
  await sleep(120);
  // A body that can't be read, sent to a page address.
  const unreadable = await raw('POST', '/no-such-page', { ...GUEST, 'content-type': 'application/json' }, '{not json');
  S.check('an unreadable body to a page address is the error page with its 400', isErrorPage(unreadable, 400, LINE_4XX), `${unreadable.status} ${unreadable.text.slice(0, 120)}`);
  // A page address with broken %-escapes names no file: not found.
  for (const p of ['/%zz', '/js/%E0%A4%A.js']) {
    const r = await raw('GET', p, GUEST);
    S.check(`a broken address ${p} is the not-found page`, isNotFound(r), `${r.status} ${r.text.slice(0, 120)}`);
  }
  const bad = await raw('GET', '/api/movies/%zz');
  S.check('control: a broken address under /api is still the JSON 400', bad.status === 400 && bad.json?.error === UNREADABLE, `${bad.status} ${bad.text.slice(0, 120)}`);
  // A Join form far bigger than any token.
  const big = await raw('POST', '/invite/join', { ...GUEST, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, `token=${'a'.repeat(5000)}`);
  S.check('a too-big Join form is the error page with its 413', isErrorPage(big, 413, LINE_4XX), `${big.status} ${big.text.slice(0, 120)}`);
  const bigApi = await raw('POST', '/api/ratings', { 'content-type': 'application/json' }, JSON.stringify({ x: 'a'.repeat(300 * 1024) }));
  S.check('control: a too-big body under /api is still the JSON 413', bigApi.status === 413 && bigApi.json?.error === TOO_BIG, `${bigApi.status} ${bigApi.text.slice(0, 120)}`);
  const after = await raw('GET', '/', GUEST);
  S.check('the server still answers after them', after.status === 200, `${after.status}`);
});

await demo.stop();
fs.rmSync(demoDir, { recursive: true, force: true });
await w.close();
S.finish();
