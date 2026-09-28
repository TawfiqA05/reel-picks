// Local stand-ins the test servers talk to over HTTP on 127.0.0.1: AMC's API
// (answered from catalog.mjs), a web-push service that decrypts what it gets,
// and Letterboxd's RSS feeds.
import http from 'node:http';
import crypto from 'node:crypto';
import * as C from './catalog.mjs';

const pad = (n) => String(n).padStart(2, '0');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serve(handler) {
  const sockets = new Set();
  const srv = http.createServer(handler);
  srv.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    srv.port = srv.address().port;
    srv.origin = `http://127.0.0.1:${srv.port}`;
    srv.shut = () => new Promise((r) => { for (const c of sockets) c.destroy(); srv.close(() => r()); });
    resolve(srv);
  }));
}

const readBody = (req) => new Promise((r) => { const b = []; req.on('data', (d) => b.push(d)); req.on('end', () => r(Buffer.concat(b))); });

// AMC. mode: ok | 500 | hold (answers wait for release()). gone: AMC movie
// ids no longer listed. hits: every request, for suites that count calls.
export async function amcMock() {
  const amc = { mode: 'ok', delay: 2, hits: [], inflight: 0, maxInflight: 0, held: [], gone: new Set() };
  const srv = await serve(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const hit = { kind: 'other', path: u.pathname, at: Date.now() };
    let m;
    amc.inflight++; amc.maxInflight = Math.max(amc.maxInflight, amc.inflight);
    try {
      if ((m = u.pathname.match(/^\/v2\/theatres\/(\d+)\/showtimes\/(.+)$/))) {
        hit.kind = 'showtimes'; hit.theatre = m[1];
        const mm = m[2].match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
        hit.date = mm ? `${mm[3]}-${pad(mm[1])}-${pad(mm[2])}` : m[2];
      } else if (/^\/v2\/theatres\/?$/.test(u.pathname)) hit.kind = 'theatres';
      else if ((m = u.pathname.match(/^\/v2\/theatres\/(\d+)$/))) { hit.kind = 'theatre'; hit.theatre = m[1]; }
      else if ((m = u.pathname.match(/^\/v2\/movies\/(\d+)$/))) { hit.kind = 'movie'; hit.movie = m[1]; }
      hit.mode = amc.mode;
      amc.hits.push(hit);
      if (amc.mode === 'hold') await new Promise((r) => amc.held.push(r));
      await sleep(amc.delay);
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (amc.mode === '500') return send(500, { errors: [{ message: 'Internal Server Error' }] });
      if (!req.headers['x-amc-vendor-key']) return send(401, { errors: [{ message: 'Unauthorized' }] });
      const rec = (t) => ({ id: Number(t.id), name: t.name, longName: t.name, slug: t.slug, location: { cityName: t.city, stateName: t.state, latitude: t.lat, longitude: t.lng } });
      if (hit.kind === 'theatres') return send(200, { _embedded: { theatres: C.THEATRES.map(rec) } });
      if (hit.kind === 'theatre') {
        const t = C.THEATRES.find((x) => x.id === hit.theatre);
        return t ? send(200, rec(t)) : send(404, { errors: [{ message: 'not found' }] });
      }
      if (hit.kind === 'movie') { const mv = C.amcMovie(hit.movie); return mv ? send(200, mv) : send(404, { errors: [] }); }
      if (hit.kind === 'showtimes') {
        if (!/^\d{4}-\d\d-\d\d$/.test(hit.date)) return send(404, { errors: [{ message: 'bad date' }] });
        const list = C.amcShowtimes(hit.theatre, hit.date).filter((s) => !amc.gone.has(s.movieId));
        return send(200, { _embedded: { showtimes: list } });
      }
      return send(404, { errors: [] });
    } finally { amc.inflight--; }
  });
  amc.srv = srv;
  amc.origin = srv.origin;
  amc.release = () => { const h = amc.held.splice(0); for (const r of h) r(); };
  return amc;
}

// Push service: keeps every message, decrypted with the subscription's keys.
export async function pushMock() {
  const push = { hits: [], subs: new Map() };
  const srv = await serve(async (req, res) => {
    const body = await readBody(req);
    const name = req.url.replace(/^\/push\//, '');
    const s = push.subs.get(name);
    let msg = null;
    if (s) { try { msg = JSON.parse(decrypt(body, s)); } catch (e) { msg = { error: e.message }; } }
    push.hits.push({ name, topic: req.headers.topic || '', msg, at: Date.now() });
    res.writeHead(201); res.end();
  });
  push.srv = srv;
  push.origin = srv.origin;
  push.newSub = (name) => {
    const e = crypto.createECDH('prime256v1'); e.generateKeys();
    const auth = crypto.randomBytes(16);
    push.subs.set(name, { ecdh: e, pub: e.getPublicKey(), auth });
    return { endpoint: `${srv.origin}/push/${name}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  };
  return push;
}

// RFC 8291 (aes128gcm, one record) decryption with the subscription's keys.
export function decrypt(body, sub) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = sub.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), sub.pub, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, sub.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

// Letterboxd: /<user>/rss/. feeds maps a lowercase username to entries;
// "broken" answers 500 and anyone unknown 404.
export async function letterboxdMock(feeds = {}) {
  const srv = await serve((req, res) => {
    const m = req.url.match(/^\/([^/]+)\/rss\/?$/);
    const user = m ? decodeURIComponent(m[1]).toLowerCase() : '';
    if (user === 'broken') { res.statusCode = 500; return res.end('oops'); }
    if (!feeds[user]) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', 'application/rss+xml');
    res.end(rssFeed(feeds[user]));
  });
  srv.feeds = feeds;
  return srv;
}

export function rssFeed(entries) {
  const items = entries.map((e, i) => `<item><title>${e.title}, ${e.year}${e.rating ? ` - ${'★'.repeat(Math.floor(e.rating))}` : ''}</title>
<guid isPermaLink="false">letterboxd-review-${e.guid || i}</guid><pubDate>${new Date(C.T0_MS - (entries.length - i) * 3600e3).toUTCString()}</pubDate>
<letterboxd:watchedDate>${e.watched || '2026-09-20'}</letterboxd:watchedDate><letterboxd:filmTitle>${e.title}</letterboxd:filmTitle>
<letterboxd:filmYear>${e.year}</letterboxd:filmYear>${e.rating ? `<letterboxd:memberRating>${e.rating}</letterboxd:memberRating>` : ''}<tmdb:movieId>${e.id}</tmdb:movieId></item>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel><title>Letterboxd</title>${items}</channel></rss>`;
}
