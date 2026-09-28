// Loaded into every test server with --import. Two jobs:
//
// 1. The clock. The server believes it is RP_FAKE_NOW (catalog.mjs T0) and
//    time runs on from there. A suite can jump it through the control file
//    (RP_CTRL_FILE, {"seq":n,"now":"<iso>"}); RP_TIMER_SCALE shortens the long
//    scheduler intervals so a mocked week of background jobs runs in seconds.
//
// 2. The network. No request leaves the machine. TMDB is answered from saved
//    sample responses (test/fixtures/tmdb) or else from the made-up catalog,
//    OMDb from the catalog, place lookups and drive times with canned answers,
//    poster images with a tiny generated JPEG. localhost passes through (the
//    AMC, Letterboxd and push stand-ins). Anything else is refused. Every
//    outside request is logged to RP_NET_LOG so a suite can prove none went
//    unanswered.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jpeg from 'jpeg-js';
import * as C from './catalog.mjs';

// ---------------------------------------------------------------- clock
const RealDate = globalThis.Date;
const realSetInterval = globalThis.setInterval;
let base = process.env.RP_FAKE_NOW ? new RealDate(process.env.RP_FAKE_NOW).getTime() : RealDate.now();
let realAt = RealDate.now();
const nowMs = () => base + (RealDate.now() - realAt);
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(nowMs()); else super(...a); }
  static now() { return nowMs(); }
}
if (process.env.RP_FAKE_NOW) globalThis.Date = FakeDate;
let ctrl = {};
let seq = null;
const ctrlFile = process.env.RP_CTRL_FILE;
function readCtrl(initial) {
  try {
    const c = JSON.parse(fs.readFileSync(ctrlFile, 'utf8'));
    if (c.seq === seq) return;
    seq = c.seq; ctrl = c;
    if (c.now && !initial) { base = new RealDate(c.now).getTime(); realAt = RealDate.now(); }
  } catch { /* no control file yet */ }
}
if (ctrlFile) { readCtrl(true); realSetInterval(() => readCtrl(false), 20).unref(); }
const scale = Number(process.env.RP_TIMER_SCALE || 0);
if (scale > 0) {
  globalThis.setInterval = (fn, ms, ...a) => realSetInterval(fn, ms >= 60000 ? Math.max(50, Math.round(ms * scale)) : ms, ...a);
}
// Only while the sample database is built: the polite pauses between TMDB
// calls (throttle gaps, the people warm-up) are shortened, since every answer
// is local. The data that comes out is the same.
const tScale = Number(process.env.RP_TIMEOUT_SCALE || 0);
if (tScale > 0) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 200 ? Math.max(1, Math.round(ms * tScale)) : ms, ...a);
}

// ---------------------------------------------------------------- network log
const LOG = process.env.RP_NET_LOG;
const note = (entry) => { if (LOG) try { fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`); } catch { /* best effort */ } };

// ---------------------------------------------------------------- saved TMDB answers
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SAVED_DIR = path.join(HERE, '..', 'fixtures', 'tmdb');
export const savedKey = (u) => {
  const p = [...u.searchParams.entries()].filter(([k]) => k !== 'api_key').sort(([a], [b]) => a.localeCompare(b));
  return `${u.pathname}?${new URLSearchParams(p)}`;
};
const saved = new Map();
try {
  for (const f of fs.readdirSync(SAVED_DIR)) {
    if (!f.endsWith('.json')) continue;
    const r = JSON.parse(fs.readFileSync(path.join(SAVED_DIR, f), 'utf8'));
    saved.set(r.key, r);
  }
} catch { /* no saved answers */ }

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = () => json({ success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }, 404);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const page = (list, n, size = 20) => ({ page: n, total_pages: Math.max(1, Math.ceil(list.length / size)), total_results: list.length, results: list.slice((n - 1) * size, n * size) });

function searchFilms(q, year) {
  const nq = norm(q);
  if (!nq) return [];
  const words = nq.split(' ');
  const hits = C.ALL_FILMS.filter((f) => {
    const t = norm(f.title);
    return t === nq || t.startsWith(nq) || words.every((w) => t.split(' ').some((tw) => tw.startsWith(w)));
  }).filter((f) => !year || String(f.year) === String(year) || (f.release || '').startsWith(String(year)));
  return hits.sort((a, b) => (b.vc ?? 0) - (a.vc ?? 0)).map(C.light);
}

function personLight(p) {
  const cr = C.credits(p);
  const known = (p.dept === 'Directing' ? cr.crew : cr.cast).slice().sort((a, b) => b.vote_count - a.vote_count).slice(0, 3);
  return {
    id: p.id, name: p.name, known_for_department: p.dept, popularity: 20 + (p.id % 17), profile_path: `/rp-p-${p.id}.jpg`, adult: false, gender: 0,
    known_for: known.map((k) => ({ ...k, media_type: 'movie' })),
  };
}

function tmdbSynth(u) {
  const p = u.pathname.replace(/^\/3/, '');
  const q = u.searchParams;
  const n = Number(q.get('page') || 1);
  let m;
  if (p === '/search/movie') return json(page(searchFilms(q.get('query'), q.get('year')), n));
  if (p === '/search/person') {
    const nq = norm(q.get('query'));
    const hits = Object.values(C.PEOPLE).filter((x) => nq && norm(x.name).split(' ').some((w) => w.startsWith(nq) || nq.split(' ').every((qw) => norm(x.name).includes(qw))));
    return json(page(hits.map(personLight), n));
  }
  if ((m = p.match(/^\/movie\/(\d+)$/))) { const f = C.film(m[1]); return f ? json(C.details(f)) : notFound(); }
  if ((m = p.match(/^\/movie\/(\d+)\/videos$/))) { const f = C.film(m[1]); return f ? json({ id: f.id, results: C.details(f).videos.results }) : notFound(); }
  if ((m = p.match(/^\/movie\/(\d+)\/credits$/))) { const f = C.film(m[1]); return f ? json({ id: f.id, ...C.details(f).credits }) : notFound(); }
  if ((m = p.match(/^\/movie\/(\d+)\/watch\/providers$/))) { const f = C.film(m[1]); return f ? json(C.providersFor(f)) : notFound(); }
  if (p === '/movie/now_playing') return json(page(C.PLAYING.filter((f) => f.year === 2026).map(C.light), n));
  if (p === '/movie/upcoming') return json(page(C.UPCOMING.map(C.light), n));
  if (p === '/movie/popular') return json(page(C.CLASSICS.map(C.light), n));
  if (p === '/discover/movie') {
    const prov = q.get('with_watch_providers');
    if (prov) {
      const want = new Set(prov.split('|').map(Number));
      return json(page(C.STREAMING.filter((f) => f.providers.some((x) => want.has(x))).map(C.light), n));
    }
    return json(page(C.CLASSICS.map(C.light), n));
  }
  if ((m = p.match(/^\/person\/(\d+)$/))) {
    const x = C.person(m[1]);
    return x ? json({ id: x.id, name: x.name, known_for_department: x.dept, profile_path: `/rp-p-${x.id}.jpg`, biography: 'A made-up person for the tests.', popularity: 20 + (x.id % 17), adult: false }) : notFound();
  }
  if ((m = p.match(/^\/person\/(\d+)\/movie_credits$/))) { const x = C.person(m[1]); return x ? json(C.credits(x)) : notFound(); }
  return null;
}

function tmdb(u) {
  if (ctrl.tmdb === 'down') { note({ host: u.hostname, path: u.pathname, how: 'down' }); return json({ status_message: 'down' }, 503); }
  const key = savedKey(u);
  const s = saved.get(key);
  if (s) { note({ host: u.hostname, path: u.pathname, how: 'saved', key }); return json(s.body, s.status); }
  const r = tmdbSynth(u);
  if (r) { note({ host: u.hostname, path: u.pathname, how: 'synth', key }); return r; }
  note({ host: u.hostname, path: u.pathname, how: 'miss', key });
  return json({ page: 1, total_pages: 0, total_results: 0, results: [] });
}

function omdb(u) {
  if (ctrl.omdbMode === 'quota') { note({ host: u.hostname, path: '/', how: 'quota' }); return json({ Response: 'False', Error: 'Request limit reached!' }); }
  const i = u.searchParams.get('i');
  const t = u.searchParams.get('t');
  let f = null;
  if (i) f = C.film(String(i).replace(/^tt/, ''));
  else if (t) f = C.ALL_FILMS.find((x) => norm(x.title) === norm(t)) || null;
  const override = f && ctrl.omdb?.[f.id];
  note({ host: u.hostname, path: '/', how: 'synth', key: i ? `i=${i}` : `t=${t}` });
  if (override) return json({ Response: 'True', imdbRating: String(override.imdb), Metascore: String(override.meta), Rated: f.mpaa || 'PG-13', Ratings: [{ Source: 'Rotten Tomatoes', Value: `${override.rt}%` }] });
  const body = C.omdbFor(f);
  return json(body || { Response: 'False', Error: i ? 'Incorrect IMDb ID.' : 'Movie not found!' });
}

// A 4x6 JPEG in a colour picked from the image path, so each poster has its
// own glow colour and the result never changes between runs.
const jpegCache = new Map();
function poster(u) {
  const h = crypto.createHash('sha1').update(u.pathname).digest();
  const k = h.subarray(0, 3).toString('hex');
  if (!jpegCache.has(k)) {
    const w = 4; const hgt = 6; const data = Buffer.alloc(w * hgt * 4);
    for (let i = 0; i < w * hgt; i++) { data[i * 4] = h[0]; data[i * 4 + 1] = h[1]; data[i * 4 + 2] = h[2]; data[i * 4 + 3] = 255; }
    jpegCache.set(k, jpeg.encode({ data, width: w, height: hgt }, 90).data);
  }
  note({ host: u.hostname, path: u.pathname, how: 'synth' });
  return new Response(jpegCache.get(k), { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

function answer(u) {
  const h = u.hostname;
  if (h === 'api.themoviedb.org') return tmdb(u);
  if (h === 'www.omdbapi.com' || h === 'omdbapi.com') return omdb(u);
  if (h === 'image.tmdb.org') return poster(u);
  if (h === 'router.project-osrm.org') { note({ host: h, path: '/route', how: 'synth' }); return json({ code: 'Ok', routes: [{ duration: 1260, distance: 17000 }] }); }
  if (h === 'nominatim.openstreetmap.org') {
    note({ host: h, path: u.pathname, how: 'synth' });
    const q = (u.searchParams.get('q') || '').toLowerCase();
    if (u.pathname.startsWith('/reverse')) return json({ display_name: 'Testville, Test County, Ohio, United States', lat: String(C.HOME.lat), lon: String(C.HOME.lng), address: { city: 'Testville', state: 'Ohio', 'ISO3166-2-lvl4': 'US-OH', country_code: 'us' } });
    if (q.includes('nowhere')) return json([]);
    return json([
      { lat: String(C.HOME.lat), lon: String(C.HOME.lng), display_name: 'Testville, Test County, Ohio, United States', addresstype: 'city', address: { city: 'Testville', state: 'Ohio', 'ISO3166-2-lvl4': 'US-OH', country_code: 'us' } },
      { lat: '40.5', lon: '-82.5', display_name: 'Testville, Other County, Ohio, United States', addresstype: 'city', address: { city: 'Testville', state: 'Ohio', 'ISO3166-2-lvl4': 'US-OH', country_code: 'us' } },
    ].slice(0, q.includes('two') ? 2 : 1));
  }
  return null;
}

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let u;
  try { u = new URL(typeof input === 'string' ? input : (input?.url ?? String(input))); } catch { return realFetch(input, init); }
  if (LOCAL.has(u.hostname)) return realFetch(input, init);
  const r = answer(u);
  if (r) return r;
  note({ host: u.hostname, path: u.pathname, how: 'refused' });
  throw new TypeError(`fetch failed (the test preload allows no request to ${u.hostname})`);
};
