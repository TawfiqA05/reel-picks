// Security (old G6 g-security, R6, person search S14 with GET /version and
// GET /person/:id added, and the decisions run's D9 host check).
//
// Every route in server/routes.js and every app-level route in server/index.js
// is in the route table below (checked by parsing both files, so a new route
// can't dodge it), and each is tried as the guest, a friend and the owner:
// the guest may only GET the allowlisted reads, friends are refused the
// owner's routes, nothing is a 5xx. Also: the owner unlock link leaves no
// token in a URL, cookies are HttpOnly/Secure/SameSite, path tricks and
// cross-site posts are refused, static files serve no source or secret, bad
// inputs are refused and store nothing, a manual Letterboxd sync can't be
// pressed into a flood, no key, token, cookie secret or invite link shows up
// in any response or the server log, no tracked repo file holds a key, and
// off Railway only a localhost Host is answered.
//
// The coverage check is exported so it can be run against an edited copy of
// routes.js: missingRoutes(routesSrc, indexSrc) returns the declared routes
// the table lacks (empty when every route is covered).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROUTE_FILES, readAll } from '../lib/sources.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------- the route table
// [method, path, kind, body, options]. kind: guest = anyone may GET it;
// user = the owner and friends; owner = the owner only; app = an app-level
// route in index.js (checked separately). {film}, {person}, {showtime} are
// filled in from the world. skipOwner / skipFriend: that role isn't sent
// (the call would change what later checks read); every route is still sent
// by at least the guest.
export const ROUTES = [
  ['GET', '/api/version', 'guest'],
  ['GET', '/api/status', 'guest'],
  ['POST', '/api/refresh', 'owner', {}],
  ['GET', '/api/recommendations', 'guest'],
  ['GET', '/api/coming-soon', 'guest'],
  ['GET', '/api/movies/{film}', 'guest'],
  ['GET', '/api/settings', 'user'],
  ['PUT', '/api/settings', 'user', {}],
  ['GET', '/api/geocode', 'user'],
  ['GET', '/api/geocode/reverse?lat=x&lng=y', 'user'],
  ['DELETE', '/api/home', 'user', undefined, { skipOwner: true }],
  ['GET', '/api/theatres?query=maple', 'user'],
  ['POST', '/api/theatre', 'user', {}],
  ['POST', '/api/theatres/follow', 'user', {}],
  ['DELETE', '/api/theatres/follow/nonexistent-theatre', 'user'],
  ['POST', '/api/theatres/primary', 'user', {}],
  ['GET', '/api/state', 'user'],
  ['GET', '/api/backup/latest', 'owner'],
  ['POST', '/api/state', 'owner', {}],
  ['GET', '/api/ratings', 'user'],
  ['POST', '/api/ratings', 'user', {}],
  ['DELETE', '/api/ratings/0', 'user'],
  ['PUT', '/api/ratings/0/note', 'user', { note: 'x' }],
  ['DELETE', '/api/ratings/0/note', 'user'],
  ['POST', '/api/ratings/import', 'user', {}],
  ['GET', '/api/letterboxd', 'user'],
  ['PUT', '/api/letterboxd', 'user', { username: '' }],
  ['POST', '/api/letterboxd/sync', 'user', {}],
  ['GET', '/api/ratings/search?q=', 'user'],
  ['GET', '/api/search?q=paper', 'user'],
  ['GET', '/api/search/recents', 'user'],
  ['POST', '/api/search/recents', 'user', {}],
  ['DELETE', '/api/search/recents?kind=query&key=nothing', 'user'],
  ['POST', '/api/search/recents/clear', 'user', {}],
  ['POST', '/api/search/recents/restore', 'user', {}],
  ['GET', '/api/showtimes/{showtime}/calendar.ics', 'guest'],
  ['GET', '/api/providers', 'user'],
  ['GET', '/api/onboarding/movies', 'user'],
  ['POST', '/api/onboarding/rate', 'user', { ratings: [] }],
  ['POST', '/api/onboarding/done', 'user', {}],
  ['GET', '/api/watchlist', 'user'],
  ['POST', '/api/watchlist/toggle', 'user', {}],
  ['GET', '/api/hidden', 'user'],
  ['POST', '/api/hidden', 'user', {}],
  ['DELETE', '/api/hidden/0', 'user'],
  ['GET', '/api/alist', 'user'],
  ['POST', '/api/watched', 'user', {}],
  ['DELETE', '/api/watched/0', 'user'],
  ['GET', '/api/together', 'user'],
  ['GET', '/api/together/999999', 'user'],
  ['GET', '/api/social', 'guest'],
  ['PUT', '/api/plans', 'user', {}],
  ['DELETE', '/api/plans/0', 'user'],
  ['POST', '/api/plans/0/answer', 'user', {}],
  ['POST', '/api/sends', 'user', {}],
  ['DELETE', '/api/sends/0', 'user'],
  ['GET', '/api/stats', 'user'],
  ['GET', '/api/person/{person}', 'guest'],
  ['GET', '/api/stats/group?kind=genre&name=Drama', 'user'],
  ['GET', '/api/stats/more?kind=genre&name=Drama', 'user'],
  ['GET', '/api/year', 'user'],
  ['GET', '/api/year/poster/0', 'user'],
  ['GET', '/api/export', 'user'],
  ['GET', '/api/matches/unmatched', 'owner'],
  ['POST', '/api/match/keep', 'owner', {}],
  ['POST', '/api/match/ignore', 'owner', {}],
  ['DELETE', '/api/match/ignore/nothing-here', 'owner'],
  ['POST', '/api/match/set', 'owner', {}],
  ['GET', '/api/friends', 'owner'],
  ['POST', '/api/friends', 'owner', {}],
  ['POST', '/api/friends/999999/revoke', 'owner', {}],
  ['POST', '/api/friends/999999/reissue', 'owner', {}],
  ['GET', '/api/home-picks', 'user'],
  ['POST', '/api/suggest', 'user', {}],
  ['POST', '/api/suggest/state', 'user', { ids: [] }],
  ['GET', '/api/offsite', 'owner'],
  ['POST', '/api/offsite/upload', 'owner', {}, { skipOwner: true }],
  ['GET', '/api/alerts', 'owner'],
  ['GET', '/api/push/config', 'user'],
  ['POST', '/api/push/check', 'user', {}],
  ['POST', '/api/push/subscribe', 'user', {}],
  ['POST', '/api/push/unsubscribe', 'user', {}],
  ['POST', '/api/push/weekly/send', 'owner', {}],
];
// App-level routes in server/index.js, each checked by its own section below.
const APP_ROUTES = [
  ['GET', '/?owner=<token>', 'owner unlock'],
  ['GET', '/?invite=<token>', 'invite page'],
  ['POST', '/invite/join', 'invite join'],
  ['GET', '/', 'the page'],
  ['GET', '/index.html', 'the page'],
  ['GET', '/styles.css', 'the stylesheet, its parts joined (server/lib/styles.js); checked with the static files'],
  ['GET', 'static files', 'static'],
  ['GET', '*', 'SPA fallback'],
];

// The routes declared in the source, as "METHOD /path" (router paths without
// /api; app-level ones by their own names).
function declaredRoutes(routesSrc, indexSrc) {
  const out = [...routesSrc.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  for (const m of indexSrc.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/g)) {
    const paths = [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    for (const p of paths) out.push(`${m[1].toUpperCase()} ${p}`);
  }
  if (/express\.static\(/.test(indexSrc)) out.push('GET static files');
  for (const q of indexSrc.matchAll(/['"](\w+)['"]\s+in\s+req\.query/g)) out.push(`GET /?${q[1]}=<token>`);
  return [...new Set(out)];
}

// Declared routes the table doesn't cover.
export function missingRoutes(routesSrc, indexSrc) {
  const norm = (p) => p.replace(/\?.*$/, '').replace(/^\/api/, '');
  return declaredRoutes(routesSrc, indexSrc).filter((d) => {
    const [m, ...rest] = d.split(' ');
    const p = rest.join(' ');
    if (APP_ROUTES.some(([am, ap]) => am === m && ap === p)) return false;
    const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+')}$`);
    return !ROUTES.some(([rm, rp]) => rm === m && re.test(norm(rp).replace(/\{[a-z]+\}/g, 'x')));
  });
}

export const fill = (p, vals) => p.replace(/\{([a-z]+)\}/g, (_, k) => encodeURIComponent(vals[k]));

// ---------------------------------------------------------------- the suite

async function main() {
  const { suite } = await import('../lib/check.mjs');
  const { openWorld, makeFriend, call, GUEST, sleep } = await import('../lib/world.mjs');
  const C = await import('../lib/catalog.mjs');
  const { serve } = await import('../lib/mocks.mjs');
  const S = suite('security');

  // ---- coverage: every route is in the table
  await S.step('the route table covers every route', async () => {
    const routesSrc = readAll(ROUTE_FILES);
    const indexSrc = fs.readFileSync(path.join(REPO_ROOT, 'server/index.js'), 'utf8');
    const declared = declaredRoutes(routesSrc, indexSrc);
    S.check('the source declares routes (the parser finds them)', declared.length > 70 && declared.includes('GET /version') && declared.includes('GET /person/:id'), `${declared.length}`);
    const missing = missingRoutes(routesSrc, indexSrc);
    S.check('every route in routes.js and index.js is in the route table', !missing.length, missing.join(', '));
    const probe = missingRoutes(`${routesSrc}\nrouter.get('/made-up-route', h);`, indexSrc);
    S.check('the coverage check notices a route missing from the table', probe.length === 1 && probe[0] === 'GET /made-up-route', probe.join(', '));
  });

  // ---- mocks that count and echo: Letterboxd, S3
  const hits = { lbx: 0, s3: 0, amc: 0 };
  const lbx = await serve((req, res) => { hits.lbx++; res.writeHead(404); res.end('nope'); });
  const s3 = await serve((req, res) => { hits.s3++; req.resume(); res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<ListBucketResult></ListBucketResult>'); });
  // An AMC stand-in that errors and echoes the vendor key back, to prove the key never reaches a client.
  const amcEcho = await serve((req, res) => { hits.amc++; res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `bad key ${req.headers['x-amc-vendor-key']}` })); });

  const rnd = (n = 24) => crypto.randomBytes(n).toString('base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const SECRETS = {
    OWNER_TOKEN: `ownertok${rnd()}`,
    TMDB_API_KEY: `tmdbkey${rnd()}`,
    OMDB_API_KEY: `omdbkey${rnd(12)}`,
    AMC_API_KEY: `amckey${rnd()}`,
    VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'),
    BACKUP_S3_SECRET: `s3secret${rnd()}`,
    BACKUP_S3_KEY_ID: `s3keyid${rnd(12)}`,
  };
  const ENV = {
    OWNER_TOKEN: SECRETS.OWNER_TOKEN, TMDB_API_KEY: SECRETS.TMDB_API_KEY, OMDB_API_KEY: SECRETS.OMDB_API_KEY, AMC_API_KEY: SECRETS.AMC_API_KEY,
    VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: SECRETS.VAPID_PRIVATE_KEY,
    BACKUP_S3_ENDPOINT: s3.origin, BACKUP_S3_BUCKET: 'b', BACKUP_S3_KEY_ID: SECRETS.BACKUP_S3_KEY_ID, BACKUP_S3_SECRET: SECRETS.BACKUP_S3_SECRET,
    RP_LETTERBOXD_ORIGIN: lbx.origin, GUEST_MODE: '',
  };
  const w = S.world(await openWorld('security', { push: true, env: ENV }));
  const base = () => w.base;
  const port = () => w.srv.port;
  const seen = [];
  const logs = [];
  const req = async (role, method, p, opts = {}) => {
    const r = await call(base(), method, p, { ...opts, headers: { ...(role.headers || {}), ...(opts.headers || {}) } });
    seen.push({ role: role.name, method, p, status: r.status, text: r.text, hdr: JSON.stringify([...r.headers]) });
    return r;
  };
  const raw = (method, p, headers = {}, body = null, at = '127.0.0.1') => new Promise((resolve) => {
    const rq = http.request({ host: at, port: port(), method, path: p, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => {
        seen.push({ role: 'raw', method, p, status: res.statusCode, text: t, hdr: JSON.stringify(res.headers) });
        let json = null; try { json = JSON.parse(t); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: t, json });
      });
    });
    rq.on('error', (e) => resolve({ status: 0, headers: {}, text: e.code || e.message, json: null }));
    rq.setTimeout(10000, () => rq.destroy(new Error('no answer in 10 s')));
    if (body) rq.write(body); rq.end();
  });
  const OWNER = { name: 'owner', headers: {} };
  const GUESTR = { name: 'guest', headers: GUEST };
  const vals = {
    film: 990001, person: C.PEOPLE.ada.id,
    showtime: w.q1("SELECT id FROM showtimes WHERE theatre_id = '9101' AND tmdb_id IS NOT NULL ORDER BY date DESC, id LIMIT 1")?.id || 'x',
  };

  // ---- owner unlock (?owner=)
  await S.step('the owner unlock link', async () => {
    const r = await raw('GET', `/settings?owner=${SECRETS.OWNER_TOKEN}&x=1`, { host: `localhost:${port()}`, 'cf-ray': 'test' });
    const sc = String(r.headers['set-cookie'] || '');
    S.check('?owner= redirects to the same URL without the token', r.status === 302 && r.headers.location === '/settings?x=1', `${r.status} ${r.headers.location}`);
    S.check('the owner cookie is HttpOnly, Secure and SameSite=Lax', /rp_owner=/.test(sc) && /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Lax/i.test(sc), sc.replace(/=[^;]+/, '=…'));
    S.check('the owner cookie and Location never carry the token', !sc.includes(SECRETS.OWNER_TOKEN) && !String(r.headers.location).includes(SECRETS.OWNER_TOKEN));
    const bad = await raw('GET', '/?owner=wrong', { host: `localhost:${port()}`, 'cf-ray': 'test' });
    S.check('a wrong owner token sets no cookie', bad.status === 302 && !bad.headers['set-cookie'], `${bad.status}`);
    OWNER.remote = { name: 'owner-remote', headers: { 'cf-ray': 'test', cookie: sc.split(';')[0] } };
    const st = await req(OWNER.remote, 'GET', '/api/status');
    S.check('the owner cookie makes a remote visitor the owner', st.json?.user?.isOwner === true && st.json?.guest === false);
    for (const p of ['/.//evil.example/?owner=x', '/%2e//evil.example/?owner=x', '//evil.example/?owner=x', '/\\evil.example/?owner=x']) {
      const o = await raw('GET', p, { host: `localhost:${port()}`, 'cf-ray': 'test' });
      const loc = String(o.headers.location || '');
      S.check(`the ?owner= redirect is not an open redirect: ${p}`, !/^(\/\/|\/\\|[a-z]+:)/i.test(loc), loc);
    }
  });

  // ---- a friend for the route table, and the friend cookie's attributes
  const B = { name: 'friend', ...(await makeFriend(base(), 'Bravo')) };
  await S.step('the friend cookie', async () => {
    const r = await call(base(), 'POST', '/api/friends', { body: { name: 'Cookie Check' } });
    const tok = new URL(r.json.invite, 'http://x').searchParams.get('invite');
    const j = await fetch(`${base()}/invite/join`, { method: 'POST', redirect: 'manual', headers: { origin: base(), 'cf-ray': 'test', 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${tok}` });
    const sc = j.headers.get('set-cookie') || '';
    S.check('the friend cookie is HttpOnly, Secure and SameSite=Lax', /HttpOnly/i.test(sc) && /Secure/i.test(sc) && /SameSite=Lax/i.test(sc));
    SECRETS.INVITE_COOKIECHECK = tok;
    SECRETS.FRIEND_COOKIE_CC = sc.split(';')[0].split('=').slice(1).join('=');
    await call(base(), 'POST', `/api/friends/${r.json.friend.id}/revoke`);
  });
  SECRETS.FRIEND_COOKIE_B = decodeURIComponent(B.headers.cookie.split('=').slice(1).join('='));

  // ---- every route as every role
  await S.step('every route answers each role as it should', async () => {
    for (const [method, tp, kind, body, opt = {}] of ROUTES) {
      const p = fill(tp, vals);
      const o = body !== undefined ? { body } : {};
      const g = await req(GUESTR, method, p, o);
      if (kind === 'guest') S.check(`guest may ${method} ${tp}`, g.status !== 403 && g.status < 500, `${g.status} ${g.text.slice(0, 80)}`);
      else S.check(`guest is refused ${method} ${tp}`, g.status === 403, `${g.status}`);
      if (!opt.skipFriend) {
        const f = await req(B, method, p, o);
        if (kind === 'owner') S.check(`friend is refused owner-only ${method} ${tp}`, f.status === 403 || f.status === 404, `${f.status}`);
        else S.check(`friend may ${method} ${tp}`, f.status !== 403 && f.status < 500, `${f.status} ${f.text.slice(0, 80)}`);
      }
      if (!opt.skipOwner) {
        const r = await req(OWNER, method, p, o);
        S.check(`owner may ${method} ${tp}`, r.status !== 403 && r.status < 500, `${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const r = await req(GUESTR, m, '/api/status', m === 'HEAD' ? {} : { body: {} });
      S.check(`guest ${m} /api/status is refused`, r.status === 403, `${r.status}`);
    }
    for (const p of ['/api/STATS', '/api/stats/', '/api//stats', '/api/movies/1/../../stats', '/api/movies/1%2F..%2F..%2Fstats', '/api/status/../stats', '/API/stats']) {
      const r = await raw('GET', p, { host: `localhost:${port()}`, 'cf-ray': 'test' });
      S.check(`guest path trick ${p} doesn't reach an owner route`, r.status === 403 || r.status === 404 || (r.status === 200 && /<!doctype html>/i.test(r.text)), `${r.status}`);
    }
    const unknown = await req(GUESTR, 'GET', '/api/movies/1');
    S.check('guest /api/movies/<unknown> is a 404 without a TMDB call', unknown.status === 404, `${unknown.status}`);
    for (const p of ['/api/ratings/search?q=a&q=b', '/api/ratings/search?q[x]=1']) {
      const r = await req(B, 'GET', p);
      S.check(`friend GET ${p} is not a 5xx`, r.status < 500, `${r.status}`);
    }
  });

  // ---- a friend's calendar file for a theater they don't follow
  await S.step('calendar files only for followed theaters', async () => {
    await req(B, 'POST', '/api/theatre', { body: { id: '9103', name: 'AMC Lakeview 16', slug: 'amc-lakeview-16' } });
    await req(B, 'DELETE', '/api/theatres/follow/9101');
    const st = (await req(B, 'GET', '/api/settings')).json;
    const follows = [st.theatreId, ...(st.extraTheatres || []).map((t) => t.id)].map(String);
    S.check('setup: the friend follows only a theater with no showtimes', !follows.includes('9101'), follows.join(','));
    const r = await req(B, 'GET', `/api/showtimes/${encodeURIComponent(vals.showtime)}/calendar.ics`);
    S.check('a friend can\'t fetch a calendar file for a theater they don\'t follow', r.status === 404, `${r.status}`);
    const o = await req(OWNER, 'GET', `/api/showtimes/${encodeURIComponent(vals.showtime)}/calendar.ics`);
    S.check('the owner can (control)', o.status === 200 && /BEGIN:VCALENDAR/.test(o.text), `${o.status}`);
  });

  // ---- rate limits on Letterboxd
  await S.step('a manual Letterboxd sync can\'t be pressed into a flood', async () => {
    // Linked first (a new name syncs at once), then saved again five times.
    await req(B, 'PUT', '/api/letterboxd', { body: { username: 'madeupuser' } });
    const before = hits.lbx;
    for (let i = 0; i < 5; i++) await req(B, 'PUT', '/api/letterboxd', { body: { username: 'madeupuser' } });
    const put = hits.lbx - before;
    const b2 = hits.lbx;
    for (let i = 0; i < 5; i++) await req(B, 'POST', '/api/letterboxd/sync', { body: {} });
    const sync = hits.lbx - b2;
    S.check('five Sync presses fetch at most once', sync <= 1, `${sync} fetches`);
    S.check('re-saving the same username isn\'t a way around it', put <= 1, `${put} fetches`);
  });

  // ---- headers, cross-site posts, static files
  await S.step('HTTP headers', async () => {
    const r = await fetch(`${base()}/`, { headers: { 'cf-ray': 'test' } });
    await r.text();
    S.check('no X-Powered-By header', !r.headers.get('x-powered-by'));
    S.check('X-Content-Type-Options: nosniff on pages', r.headers.get('x-content-type-options') === 'nosniff');
    S.check('pages refuse framing', /frame-ancestors|DENY|SAMEORIGIN/i.test(`${r.headers.get('content-security-policy')} ${r.headers.get('x-frame-options')}`));
  });
  await S.step('a change from another site is refused', async () => {
    const s = await raw('POST', '/api/friends/999999/revoke', { host: `localhost:${port()}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, 'x');
    S.check('a cross-site POST to the owner API is refused (Origin)', s.status === 403, `${s.status}`);
    const s2 = await raw('PUT', '/api/settings', { host: `localhost:${port()}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{"previewsMinutes":5}');
    S.check('a cross-site PUT is refused (Sec-Fetch-Site)', s2.status === 403, `${s2.status}`);
  });
  await S.step('static files serve no source or secret', async () => {
    for (const p of ['/../server/index.js', '/%2e%2e/server/index.js', '/js/..%2f..%2fserver%2findex.js', '/..%5c..%5cserver%5cindex.js', '/.env', '/%2e%2e/.env', '/../.env', '/data/reelpicks.db', '/../data/reelpicks.db', '/.git/config', '/..%2f.git%2fconfig', '/package.json', '/../package.json']) {
      const r = await raw('GET', p, { host: `localhost:${port()}`, 'cf-ray': 'test' });
      S.check(`static path ${p} serves no source or secret`, !/import express|TMDB_API_KEY=|SQLite format|\[core\]|"dependencies"/.test(r.text), `${r.status}`);
    }
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = ['/', '/index.html', '/styles.css', '/sw.js', '/manifest.webmanifest', ...walk(path.join(REPO_ROOT, 'public/js')).map((f) => `/js/${path.relative(path.join(REPO_ROOT, 'public/js'), f)}`)];
    for (const f of files) {
      for (const who of [GUESTR, OWNER]) {
        const r = await req(who, 'GET', f);
        S.check(`${who.name}: static ${f} serves`, r.status === 200, `${r.status}`);
      }
    }
    const spa = await req(GUESTR, 'GET', '/some/deep/link');
    S.check('the SPA fallback serves the page', spa.status === 200 && /<!doctype html>/i.test(spa.text), `${spa.status}`);
  });

  // ---- input validation, as a friend who owns nothing else
  await S.step('bad inputs are refused and store nothing', async () => {
    const F = { name: 'junk', ...(await makeFriend(base(), 'Junk')) };
    const r2 = (method, p, body, headers = F.headers) => req({ name: 'junk', headers }, method, p, body === undefined ? {} : { body });
    const views = ['/api/status', '/api/settings', '/api/recommendations', '/api/coming-soon', '/api/alist', '/api/stats', '/api/ratings', '/api/watchlist', '/api/hidden', '/api/together', '/api/export', '/api/state', '/api/search/recents', '/api/home-picks'];
    const userSetting = (k) => w.q1('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', F.id, k)?.value;
    const badSettings = [
      ['weightPublic', 'abc'], ['weightPublic', 5], ['previewsMinutes', 2.5], ['home', 'x'], ['home', { lat: 999, lng: 0 }],
      ['moviePlan', 'nope'], ['streamingServices', 'netflix'], ['streamingServices', ['nope']],
      ['extraTheatres', { a: 1 }], ['extraTheatres', 'x'], ['extraTheatres', Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }))],
      ['showtimeWindows', 'junk'], ['showtimeWindows', { weekday: 5 }], ['excludedGenres', 'Drama'], ['excludedMpaa', { x: 1 }],
      ['theatreId', { x: 1 }], ['theatreName', 'x'.repeat(5000)], ['home', { label: 'x'.repeat(100000) }],
      ['watchTogether', 'yes'], ['onboardingDone', { x: 1 }], ['preferImax', 'maybe'],
    ];
    for (const [k, v] of badSettings) {
      const label = `${k}=${JSON.stringify(v).slice(0, 40)}`;
      const before = userSetting(k);
      const r = await r2('PUT', '/api/settings', { [k]: v });
      S.check(`PUT /settings ${label} is refused`, r.status === 400, `${r.status}`);
      S.check(`PUT /settings ${label} stores nothing`, before === userSetting(k));
    }
    for (const body of [[1, 2], null]) {
      const r = await r2('PUT', '/api/settings', body);
      S.check(`PUT /settings with body ${JSON.stringify(body)} is not a 5xx`, r.status < 500, `${r.status}`);
    }
    const malformed = await fetch(`${base()}/api/settings`, { method: 'PUT', headers: { ...F.headers, 'content-type': 'application/json' }, body: '{bad json' });
    S.check('malformed JSON is a 400', malformed.status === 400, `${malformed.status}`);
    const ratingCount = () => w.q1('SELECT COUNT(*) n FROM ratings WHERE user_id = ?', F.id).n;
    const badRatings = [
      { tmdb_id: 700001, rating: 6 }, { tmdb_id: 700002, rating: 0 }, { tmdb_id: 700003, rating: -1 }, { tmdb_id: 700004, rating: 'abc' },
      { tmdb_id: 700006, rating: 2.7 }, { tmdb_id: 'abc', rating: 3 }, { tmdb_id: -5, rating: 3 },
      { tmdb_id: 1.5, rating: 3 }, { tmdb_id: { x: 1 }, rating: 3 }, { tmdb_id: [700007], rating: 3 }, { tmdb_id: 700008, rating: 3, title: { x: 1 } },
      { tmdb_id: 700010, rating: 3, source: { x: 1 } }, { tmdb_id: 700011, rating: 3, source: 'x'.repeat(50000) },
    ];
    for (const b of badRatings) {
      const label = JSON.stringify(b).slice(0, 70);
      const n0 = ratingCount();
      const r = await r2('POST', '/api/ratings', b);
      S.check(`POST /ratings ${label} is refused`, r.status === 400, `${r.status} ${r.text.slice(0, 60)}`);
      S.check(`POST /ratings ${label} stores nothing`, ratingCount() === n0);
    }
    const junkRatings = w.q1("SELECT COUNT(*) n FROM ratings WHERE user_id = ? AND (typeof(tmdb_id) != 'integer' OR tmdb_id <= 0 OR typeof(rating) NOT IN ('real','integer') OR rating < 0.5 OR rating > 5 OR (rating * 2) != CAST(rating * 2 AS INTEGER))", F.id).n;
    S.check('no junk rating rows stored', junkRatings === 0, `${junkRatings}`);
    // A friend-supplied title/poster never lands in the shared movies table.
    const fakeId = 950030;
    await r2('POST', '/api/ratings', { tmdb_id: fakeId, rating: 3, title: 'Friend Supplied Title', poster: 'https://evil.example/p.jpg' });
    await sleep(300);
    const other = await call(base(), 'GET', `/api/movies/${fakeId}`);
    S.check('a friend\'s made-up title and poster don\'t reach the owner\'s movie page', !other.text.includes('evil.example') && !other.text.includes('Friend Supplied Title'), `${other.status}`);
    await r2('POST', '/api/onboarding/rate', { ratings: [{ tmdb_id: fakeId - 1, rating: 3, title: 'Onboard Fake', poster: 'https://evil.example/q.jpg' }] });
    await sleep(300);
    const other2 = await call(base(), 'GET', `/api/movies/${fakeId - 1}`);
    S.check('onboarding can\'t plant a poster address for everyone', !other2.text.includes('evil.example') && !other2.text.includes('Onboard Fake'), `${other2.status}`);
    for (const b of [{ ratings: 'x' }, { ratings: 5 }, { ratings: { a: 1 } }, { ratings: [null] }, { ratings: [{ tmdb_id: 700020, rating: 99 }] }, { ratings: [{ tmdb_id: 'abc', rating: 3 }] }]) {
      const n0 = ratingCount();
      const r = await r2('POST', '/api/onboarding/rate', b);
      S.check(`POST /onboarding/rate ${JSON.stringify(b)} is not a 5xx`, r.status < 500, `${r.status}`);
      S.check(`POST /onboarding/rate ${JSON.stringify(b)} stores no junk rating`, ratingCount() === n0);
    }
    for (const id of ['abc', '-1', '1.5', '99999999999999999999']) {
      for (const p of [`/api/ratings/${id}`, `/api/hidden/${id}`, `/api/watched/${id}`]) {
        const r = await r2('DELETE', p);
        S.check(`DELETE ${p} is not a 5xx`, r.status < 500, `${r.status}`);
      }
    }
    for (const id of ['abc', -5, 1.5, { x: 1 }, [1], true]) {
      const r = await r2('POST', '/api/watchlist/toggle', { tmdb_id: id });
      S.check(`POST /watchlist/toggle tmdb_id=${JSON.stringify(id)} is refused`, r.status === 400, `${r.status}`);
    }
    S.check('no junk watchlist rows', w.q1("SELECT COUNT(*) n FROM watchlist WHERE user_id = ? AND (typeof(tmdb_id) != 'integer' OR tmdb_id <= 0)", F.id).n === 0);
    for (const id of ['abc', -5, 1.5, { x: 1 }]) {
      const r = await r2('POST', '/api/hidden', { tmdb_id: id });
      S.check(`POST /hidden tmdb_id=${JSON.stringify(id)} is refused`, r.status === 400, `${r.status}`);
    }
    for (const b of [{ tmdb_id: 990003, title: { x: 1 } }, { tmdb_id: 990003, in_weekly4: { x: 1 } }, { tmdb_id: 990004, in_weekly4: 'yes' }, { tmdb_id: 990005, title: 'x'.repeat(100000) }]) {
      const r = await r2('POST', '/api/watched', b);
      S.check(`POST /watched ${JSON.stringify(b).slice(0, 60)} is not a 5xx`, r.status === 400 || r.status === 200, `${r.status}`);
    }
    const junkWatched = w.q1("SELECT COUNT(*) n FROM watched WHERE user_id = ? AND (in_weekly4 NOT IN (0,1) OR length(title) > 500 OR typeof(title) NOT IN ('text','null'))", F.id).n;
    S.check('no junk watched rows', junkWatched === 0, `${junkWatched}`);
    for (const b of [{ movie: { tmdb_id: 'x' } }, { movie: { tmdb_id: 5, title: 'T', poster: 'javascript:alert(1)' } }, { query: { x: 1 } }, { query: 'x'.repeat(10000) }]) {
      const r = await r2('POST', '/api/search/recents', b);
      S.check(`POST /search/recents ${JSON.stringify(b).slice(0, 50)} is not a 5xx`, r.status < 500, `${r.status}`);
      S.check(`POST /search/recents ${JSON.stringify(b).slice(0, 50)} stores no non-TMDB poster`, !r.text.includes('javascript:'));
    }
    for (const b of [{ queries: 'x', movies: 5 }, { queries: [null, 5], movies: [null, { tmdb_id: 1 }] }]) {
      const r = await r2('POST', '/api/search/recents/restore', b);
      S.check(`POST /search/recents/restore ${JSON.stringify(b)} is not a 5xx`, r.status < 500, `${r.status}`);
    }
    for (const q of ['kind=bad', 'kind=query', 'kind[]=query&key=x']) {
      const r = await r2('DELETE', `/api/search/recents?${q}`);
      S.check(`DELETE /search/recents?${q} is not a 5xx`, r.status < 500, `${r.status}`);
    }
    for (const p of ['/api/search?q[]=a&q[]=b', `/api/search?q=${'x'.repeat(4000)}`, '/api/ratings/search?q=a&q=b', '/api/ratings/search?q[x]=1',
      '/api/stats/group?kind=genre&name[]=x', '/api/stats/more?kind[]=genre&name=x', '/api/geocode?q[]=', '/api/geocode/reverse?lat[]=1&lng=2',
      '/api/providers?ids[]=1', '/api/theatres?query[]=x', `/api/stats/group?kind=genre&name=${'x'.repeat(301)}`, '/api/person/abc', '/api/person/-1', '/api/person/1e3', '/api/person/99999999999']) {
      const r = await r2('GET', p);
      S.check(`GET ${p.slice(0, 60)} is not a 5xx`, r.status < 500, `${r.status} ${r.text.slice(0, 60)}`);
    }
    const lb0 = hits.lbx;
    for (const u of ['../../etc/passwd', 'a/b', 'x'.repeat(1000), { x: 1 }, 'name with space', '%2e%2e']) {
      const r = await r2('PUT', '/api/letterboxd', { username: u });
      S.check(`PUT /letterboxd ${JSON.stringify(u).slice(0, 40)} is refused`, r.status === 400 || (r.status === 200 && r.json?.username == null), `${r.status}`);
    }
    S.check('bad Letterboxd usernames never fetch', hits.lbx === lb0, `${hits.lbx - lb0} fetches`);
    for (const b of [{ id: { x: 1 } }, { id: 'x'.repeat(5000), name: 'x' }, { id: ['a'] }]) {
      const r = await r2('POST', '/api/theatres/follow', b);
      S.check(`POST /theatres/follow ${JSON.stringify(b).slice(0, 40)} is refused`, r.status === 400, `${r.status}`);
    }
    const csvJunk = () => ({
      r: w.q1("SELECT COUNT(*) n FROM ratings WHERE user_id = ? AND (typeof(tmdb_id) != 'integer' OR tmdb_id <= 0 OR rating > 5 OR rating < 0.5)", F.id).n,
      u: w.q1('SELECT COUNT(*) n FROM unmatched_ratings WHERE user_id = ? AND (rating > 5 OR rating < 0.5 OR rating IS NULL)', F.id).n,
      w: w.q1("SELECT COUNT(*) n FROM watched WHERE user_id = ? AND (watched_date IS NULL OR watched_date NOT GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')", F.id).n,
    });
    const junk0 = csvJunk();
    for (const [csv, why] of [['"unterminated,quote\n1,2', 'unterminated quote'], ['\u0000\u0001\u0002', 'binary'], [',,,\n,,,', 'empty cells'], ['Date,Name,Year,Letterboxd URI,Rating\n2020-01-01,"x",abc,u,99', 'bad rating'],
      ['Type,tmdb_id,Title,Year,Rating,Source,RatedAt,WatchedAt,InWeekly4,Price\nrating,-5,x,,9,manual,,,,\nrating,abc,y,,3,manual,,,,\nwatched,7,z,,,,,notadate,1,abc', 'reelpicks junk']]) {
      const n0 = ratingCount();
      const r = await r2('POST', '/api/ratings/import', { csv });
      S.check(`CSV import (${why}) is not a 5xx`, r.status < 500, `${r.status} ${r.text.slice(0, 60)}`);
      if (why !== 'reelpicks junk') S.check(`CSV import (${why}) stores no ratings`, ratingCount() === n0);
    }
    const j = csvJunk();
    S.check('CSV import stores no out-of-range rows', j.r === junk0.r && j.u === junk0.u && j.w === junk0.w, JSON.stringify({ j, junk0 }));
    const rows = Array.from({ length: 60000 }, (_, i) => `2020-01-01,Title ${i},2000,https://boxd.it/${i},3`).join('\n');
    const big = await r2('POST', '/api/ratings/import', { csv: `Date,Name,Year,Letterboxd URI,Rating\n${rows}` });
    S.check('a 60,000-row CSV is refused or capped, never a 5xx', big.status < 500 && (big.status === 400 || big.status === 413 || (big.json?.received ?? 0) <= 20000), `${big.status} ${big.json?.received}`);
    await w.q('DELETE FROM unmatched_ratings WHERE user_id = ?', F.id);
    const huge = await fetch(`${base()}/api/ratings/import`, { method: 'POST', headers: { ...F.headers, 'content-type': 'application/json' }, body: JSON.stringify({ csv: 'x'.repeat(21 * 1024 * 1024) }) });
    S.check('a 21 MB body is a 413', huge.status === 413, `${huge.status}`);
    const r3 = await fetch(`${base()}/api/settings`, { method: 'PUT', headers: { ...F.headers, 'content-type': 'application/json' }, body: JSON.stringify({ home: { label: 'y'.repeat(2 * 1024 * 1024) } }) });
    S.check('a 2 MB settings body is refused', r3.status === 413 || r3.status === 400, `${r3.status}`);
    const g = await fetch(`${base()}/api/settings`, { method: 'PUT', headers: { ...GUEST, 'content-type': 'application/json' }, body: JSON.stringify({ csv: 'z'.repeat(5 * 1024 * 1024) }) });
    S.check('a guest\'s big body is refused before it is read', g.status === 403, `${g.status}`);
    const jb = await fetch(`${base()}/invite/join`, { method: 'POST', headers: { 'cf-ray': 'test', origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${'a'.repeat(10000)}` });
    S.check('an oversized invite join body is refused', jb.status === 413 || jb.status === 410, `${jb.status}`);
    for (const v of views) {
      const r = await r2('GET', v);
      S.check(`after the bad inputs, GET ${v} still works`, r.status < 500, `${r.status}`);
    }
  });

  // ---- the owner's diagnostics hold no key
  await S.step('secrets never leave the server', async () => {
    for (const p of ['/api/friends', '/api/status', '/api/state', '/api/settings', '/api/alerts', '/api/offsite', '/api/push/config', '/api/backup/latest', '/api/recommendations', '/api/movies/990001']) {
      await req(OWNER, 'GET', p); await req(OWNER.remote, 'GET', p); await req(B, 'GET', p); await req(GUESTR, 'GET', p);
    }
    const st = (await req(OWNER, 'GET', '/api/status')).json;
    S.check('the owner\'s status shows key fingerprints, not keys', st?.keyMeta?.tmdb?.len === SECRETS.TMDB_API_KEY.length && /^[0-9a-f]{8}$/.test(st?.keyMeta?.tmdb?.sha8 || ''));
    // AMC answering with an error that echoes the key back.
    logs.push(w.srv.log());
    w.q("DELETE FROM cache WHERE key LIKE 'amc:theatre%'");
    await w.restart({ env: { ...ENV, RP_AMC_BASE: amcEcho.origin } });
    const t = await req(OWNER, 'GET', '/api/theatres?query=maple');
    S.check('AMC echoing its key in an error: the owner\'s theater search reaches it', hits.amc >= 1 && t.status >= 400, `${hits.amc} calls, ${t.status}`);
    await req(OWNER, 'POST', '/api/theatres/follow', { body: { id: '9103', name: 'AMC Lakeview 16', slug: 'x' } });
    await req(OWNER, 'GET', '/api/status');
    await sleep(300);
    logs.push(w.srv.log());
    const cs = w.q1("SELECT value FROM settings WHERE key = 'friendCookieSecret'");
    if (cs) SECRETS.FRIEND_COOKIE_SECRET = JSON.parse(cs.value);
    const inviteKeys = Object.keys(SECRETS).filter((k) => k.startsWith('INVITE_'));
    const cookieKeys = Object.keys(SECRETS).filter((k) => k.startsWith('FRIEND_COOKIE_') && k !== 'FRIEND_COOKIE_SECRET');
    for (const [k, v] of Object.entries(SECRETS)) {
      if (!v || v.length < 8) continue;
      const where = [];
      for (const s of seen) {
        // Invite tokens: only the owner's own create / reissue answers carry them.
        if (inviteKeys.includes(k) && /^owner/.test(s.role) && /\/api\/friends(\/\d+\/reissue)?$/.test(s.p) && s.method === 'POST') continue;
        // The newest backup is the whole database by design (owner only).
        if (k === 'FRIEND_COOKIE_SECRET' && s.p === '/api/backup/latest' && /^owner/.test(s.role)) continue;
        const hay = s.text + (cookieKeys.includes(k) ? '' : s.hdr);
        if (hay.includes(v)) where.push(`${s.role} ${s.method} ${s.p}`);
      }
      S.check(`${k} appears in no response`, !where.length, where.slice(0, 4).join(', '));
      S.check(`${k} appears in no server log`, !logs.some((l) => l.includes(v)));
    }
  });

  // ---- tracked repo files hold no key
  await S.step('no tracked file holds a key', async () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT }).toString().split('\0').filter(Boolean);
    const envValues = [];
    try {
      for (const line of fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?([^'"\n]*)['"]?\s*$/);
        if (m && /KEY|TOKEN|SECRET/.test(m[1]) && m[2].trim().length >= 8) envValues.push(m[2].trim());
      }
    } catch { /* a clean clone has no .env */ }
    const shaped = [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
      /(api_key|apikey|OWNER_TOKEN|VAPID_PRIVATE_KEY|_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9_\-]{20,}/];
    const hitsEnv = []; const hitsShape = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'); } catch { continue; }
      if (text.includes('\0')) continue;
      if (envValues.some((v) => text.includes(v))) hitsEnv.push(f);
      if (Object.values(SECRETS).some((v) => v && text.includes(v))) hitsEnv.push(f);
      if (f !== 'package-lock.json' && shaped.some((re) => re.test(text))) hitsShape.push(f);
    }
    S.check('the tracked files were listed', files.length > 20, `${files.length}`);
    S.check('no tracked file holds a value from .env or a test key', !hitsEnv.length, hitsEnv.join(', '));
    S.check('no tracked file holds a key-shaped string', !hitsShape.length, hitsShape.join(', '));
  });

  // ---- D9: the host check
  const rawHost = (host, p = '/api/status', { method = 'GET', headers = {} } = {}) => raw(method, p, { host, ...headers, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, method === 'GET' ? null : '{}');
  await S.step('off Railway only a localhost Host is answered', async () => {
    await w.restart({ env: { GUEST_MODE: '', RP_ALLOW_LAN: '' } });
    for (const h of ['localhost', '127.0.0.1', '[::1]']) {
      const r = await rawHost(`${h}:${port()}`);
      S.check(`local: Host ${h} is answered as the owner`, r.status === 200 && r.json?.user?.isOwner === true, `${r.status}`);
    }
    const page = await rawHost(`localhost:${port()}`, '/');
    S.check('local: the app page is served on localhost', page.status === 200 && /<html/i.test(page.text));
    for (const [h, p] of [['evil.example', '/api/status'], ['evil.example', '/api/friends'], ['evil.example', '/'], ['192.168.1.20:5170', '/api/status'], ['reelpicks.local', '/api/status']]) {
      const r = await rawHost(h, p);
      S.check(`local: Host ${h} ${p} is refused`, r.status === 403 && !/"isOwner":true/.test(r.text) && !/"friends"/.test(r.text), `${r.status} ${r.text.slice(0, 60)}`);
    }
    const post = await rawHost('evil.example', '/api/refresh', { method: 'POST' });
    S.check('local: a write with a foreign Host is refused', post.status === 403, `${post.status}`);
    const tunnel = await rawHost('quiet-lake-1234.trycloudflare.com', '/api/status', { headers: { 'cf-ray': 'abc123', 'cf-connecting-ip': '203.0.113.9' } });
    S.check('local: the share tunnel still gets the read-only guest view', tunnel.status === 200 && tunnel.json?.guest === true, `${tunnel.status}`);
  });
  await S.step('RP_ALLOW_LAN=1 opens it to the network', async () => {
    await w.restart({ env: { RP_ALLOW_LAN: '1' } });
    const lan = await rawHost(`192.168.1.20:${port()}`);
    S.check('RP_ALLOW_LAN=1: a LAN address is answered', lan.status === 200, `${lan.status}`);
    S.check('RP_ALLOW_LAN=1: localhost is still answered', (await rawHost(`localhost:${port()}`)).status === 200);
    S.check('RP_ALLOW_LAN=1, GUEST_MODE off: a Host that isn\'t localhost is the guest, not the owner', lan.json?.guest === true && lan.json?.user?.isOwner !== true, JSON.stringify({ guest: lan.json?.guest, owner: lan.json?.user?.isOwner }));
    S.check('RP_ALLOW_LAN=1: localhost from this machine is still the owner', (await rawHost(`localhost:${port()}`)).json?.user?.isOwner === true);
  });

  // The owner at their own machine means a localhost Host AND a connection
  // from this machine. These calls go to this Mac's own network address, so
  // the server sees a non-loopback address, as it would from a phone.
  const os = await import('node:os');
  const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4')?.address;
  const atLan = (p, { method = 'GET', headers = {}, host = `localhost:${port()}` } = {}) => raw(method, p, { host, ...headers, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, method === 'GET' ? null : '{}', lanIp);
  await S.step('a device on the network is never the owner', async () => {
    if (!lanIp) { console.log('  - skipped: this machine has no network address, so the calls from the network were not made'); return; }
    await w.restart({ env: { GUEST_MODE: '', RP_ALLOW_LAN: '' } });
    const off = await atLan('/api/status');
    S.check('off Railway without RP_ALLOW_LAN: the network address doesn\'t answer at all (it listens on 127.0.0.1)', off.status === 0 && /ECONNREFUSED/.test(off.text), `${off.status} ${off.text.slice(0, 80)}`);
    S.check('off Railway without RP_ALLOW_LAN: localhost still answers as the owner', (await rawHost(`localhost:${port()}`)).json?.user?.isOwner === true);
    for (const guestMode of ['', '1']) {
      const tag = `RP_ALLOW_LAN=1, GUEST_MODE ${guestMode ? 'on' : 'off'}`;
      await w.restart({ env: { GUEST_MODE: guestMode, RP_ALLOW_LAN: '1' } });
      for (const h of ['localhost', '127.0.0.1', '[::1]']) {
        const st = await atLan('/api/status', { host: `${h}:${port()}` });
        S.check(`${tag}: from the network with Host ${h}, the read-only guest`, st.status === 200 && st.json?.guest === true && st.json?.user?.isOwner !== true, `${st.status} ${JSON.stringify({ guest: st.json?.guest, owner: st.json?.user?.isOwner })}`);
      }
      const fr = await atLan('/api/friends');
      S.check(`${tag}: from the network, the friends list is refused`, fr.status === 403 && !/"friends"/.test(fr.text), `${fr.status}`);
      const bk = await atLan('/api/backup/latest');
      S.check(`${tag}: from the network, the backup download is refused`, bk.status === 403, `${bk.status}`);
      const inv = await atLan('/?invite=not-a-real-token');
      S.check(`${tag}: from the network, an invite link isn't sent on to Settings as the owner`, inv.status !== 302 && inv.headers?.location !== '/#/settings', `${inv.status} ${inv.headers?.location || ''}`);
      const post = await atLan('/api/refresh', { method: 'POST', headers: { origin: `http://localhost:${port()}` } });
      S.check(`${tag}: from the network, a write is refused`, post.status === 403, `${post.status}`);
      S.check(`${tag}: from this machine, localhost is still the owner`, (await rawHost(`localhost:${port()}`)).json?.user?.isOwner === true);
      const tunnel = await rawHost('quiet-lake-1234.trycloudflare.com', '/api/status', { headers: { 'cf-ray': 'abc123', 'cf-connecting-ip': '203.0.113.9' } });
      S.check(`${tag}: the share tunnel is still the read-only guest`, tunnel.status === 200 && tunnel.json?.guest === true, `${tunnel.status}`);
    }
  });

  await S.step('on Railway any Host is answered', async () => {
    await w.restart({ env: { RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_PROJECT_ID: 'test-project-id', GUEST_MODE: '1' } });
    const rw = await rawHost('reel-picks-production.up.railway.app');
    S.check('Railway: its own domain is answered without RP_ALLOW_LAN', rw.status === 200 && rw.json?.guest === true, `${rw.status}`);
    const rw2 = await rawHost('some-custom-domain.example');
    S.check('Railway: any Host is answered', rw2.status === 200, `${rw2.status}`);
    // Railway's proxy reaches the app over the network, never loopback: a
    // server listening on 127.0.0.1 there would take the site down.
    if (!lanIp) { console.log('  - skipped: this machine has no network address, so the Railway call on it was not made'); return; }
    const net = await atLan('/api/status', { host: 'reel-picks-production.up.railway.app' });
    S.check('Railway: the server answers on the network address, without RP_ALLOW_LAN', net.status === 200 && net.json?.guest === true, `${net.status} ${net.text.slice(0, 80)}`);
  });

  await w.close();
  await lbx.shut(); await s3.shut(); await amcEcho.shut();
  S.finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
