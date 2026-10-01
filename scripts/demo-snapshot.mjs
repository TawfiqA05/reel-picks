#!/usr/bin/env node
// Saves the demo's film snapshot (server/demo/snapshot.json), once, with real
// TMDB and OMDb keys:
//
//   node --disable-warning=ExperimentalWarning scripts/demo-snapshot.mjs
//
// It reads the two keys from .env (or the environment) and nothing else from
// it, picks real films (what's in US theaters now, this year's releases, the
// most-rated films of all time), then runs the demo's own build and the pages
// a visitor can open against the live services, saving every answer cut down
// to the fields the app reads (server/demo/snapshot.js trim). Keys never land
// in the file: they're added to each request here and left out of its saved
// name, and the file is checked for them before it's written.
//
// Runs in demo mode, so the database is a fresh one in a temp folder; the
// real one is never opened. AMC is the demo's made-up theaters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'demo', 'snapshot.json');

function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
  } catch { /* no .env */ }
  return '';
}
const KEYS = { tmdb: readKey('TMDB_API_KEY'), omdb: readKey('OMDB_API_KEY') };
if (!KEYS.tmdb || !KEYS.omdb) { console.error('Set TMDB_API_KEY and OMDB_API_KEY (in .env or the environment).'); process.exit(1); }

// Demo mode before any server module loads: temp database, no .env, no keys.
for (const k of ['DATA_DIR', 'TMDB_API_KEY', 'OMDB_API_KEY', 'AMC_API_KEY', 'OWNER_NAME', 'OWNER_TOKEN']) delete process.env[k];
process.env.DEMO_MODE = '1';

const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
let last = 0;
async function polite(gapMs) {
  const wait = last + gapMs - Date.now();
  last = Math.max(Date.now(), last + gapMs);
  if (wait > 0) await sleep(wait);
}
async function live(url, svc) {
  const u = new URL(url);
  u.searchParams.set(svc === 'tmdb' ? 'api_key' : 'apikey', KEYS[svc]);
  for (let attempt = 0; attempt < 4; attempt++) {
    await polite(svc === 'tmdb' ? 60 : 120);
    const res = await realFetch(u, { signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    return res;
  }
  throw new Error(`rate limited: ${svc}`);
}

// ---- 1. pick the films --------------------------------------------------------
const { requestKey, trim, serviceOf } = await import('../server/demo/snapshot.js');
const tmdbGet = async (p, q = {}) => {
  const u = new URL(`https://api.themoviedb.org/3${p}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const res = await live(u.toString(), 'tmdb');
  if (!res.ok) throw new Error(`TMDB ${res.status} ${p}`);
  return res.json();
};
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const daysAgo = (n) => ymd(new Date(Date.now() - n * 864e5));

const nowPlaying = [];
for (let page = 1; page <= 3; page++) nowPlaying.push(...(await tmdbGet('/movie/now_playing', { region: 'US', language: 'en-US', page })).results);
const playingPick = [...new Map(nowPlaying.map((r) => [r.id, r])).values()]
  .filter((r) => !r.adult && r.poster_path && r.backdrop_path && r.release_date && r.release_date >= daysAgo(75) && r.release_date <= ymd(today) && (r.vote_count || 0) >= 25)
  .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
  .slice(0, 15);
const playing = [];
for (const r of playingPick) {
  const d = await tmdbGet(`/movie/${r.id}`, { append_to_response: 'release_dates', language: 'en-US' });
  const us = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === 'US');
  const mpaa = (us?.release_dates || []).map((x) => x.certification).find((c) => c && c.trim()) || null;
  playing.push({ id: d.id, title: d.title, release_date: d.release_date, runtime: d.runtime || null, mpaa });
}
const year = today.getFullYear();
const recentRaw = [];
for (let page = 1; page <= 2; page++) {
  recentRaw.push(...(await tmdbGet('/discover/movie', {
    region: 'US', language: 'en-US', include_adult: 'false', sort_by: 'vote_count.desc', page,
    'primary_release_date.gte': `${year}-01-01`, 'primary_release_date.lte': daysAgo(35), with_release_type: '2|3',
  })).results);
}
const taken = new Set(playing.map((f) => f.id));
const recent = recentRaw.filter((r) => !taken.has(r.id) && r.poster_path).slice(0, 24).map((r) => r.id);
for (const id of recent) taken.add(id);
const classicsRaw = [];
for (let page = 1; page <= 8; page++) {
  classicsRaw.push(...(await tmdbGet('/discover/movie', {
    sort_by: 'vote_count.desc', include_adult: 'false', include_video: 'false', page, language: 'en-US',
  })).results);
}
const classics = classicsRaw.filter((r) => !taken.has(r.id) && r.poster_path).map((r) => r.id);
console.log(`films: ${playing.length} playing, ${recent.length} from ${year}, ${classics.length} classics`);

// The file the demo modules read while recording: films now, answers at the end.
const films = { playing, recent, classics };
fs.writeFileSync(OUT, JSON.stringify({ films, colors: {}, responses: {} }));

// ---- 2. record ------------------------------------------------------------------
const responses = {};
const { amcAnswer } = await import('../server/demo/net.js');
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  const u = new URL(url);
  if (u.hostname === 'api.amctheatres.com') return amcAnswer(url);
  if (u.hostname === 'image.tmdb.org') return realFetch(url, init); // poster colours
  const svc = serviceOf(u);
  if (!svc) throw Object.assign(new TypeError('fetch failed'), { cause: new Error(`not recorded: ${u.hostname}`) });
  const key = requestKey(url);
  const res = await live(url, svc);
  const text = await res.text();
  if (!res.ok) return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
  const body = trim(key, JSON.parse(text));
  responses[key] = body;
  // The app sees exactly what the demo will.
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { DatabaseSync } = await import('node:sqlite');
const { db, dataDir, all, get } = await import('../server/db.js');
const { withDb, closeBase } = await import('../server/demo/scope.js');
const { runAs } = await import('../server/lib/user.js');
const { buildSample } = await import('../server/demo/build.js');
const { backfillPosterColors } = await import('../server/lib/posterColor.js');
const { getPerson } = await import('../server/lib/personPage.js');
const { getStats } = await import('../server/lib/stats.js');
const { getStatsMore } = await import('../server/lib/statsMore.js');
const { suggest, MOODS } = await import('../server/lib/suggest.js');
const { search } = await import('../server/lib/search.js');
const tmdb = await import('../server/lib/tmdb.js');

const empty = path.join(dataDir, 'empty.db');
db.exec(`VACUUM INTO '${empty}'`);
closeBase();
const work = path.join(dataDir, 'record.db');
fs.copyFileSync(empty, work);
const h = new DatabaseSync(work);
h.exec('PRAGMA foreign_keys = ON;');

await withDb(h, 'record', async () => {
  await buildSample({ log: (m) => console.log(`  ${m}`) });
  await backfillPosterColors();
  const owner = (fn) => runAs(1, fn, { isOwner: true, guest: false });

  // People: who made and stars in what's playing, and Sam's most-rated names.
  const ids = new Set();
  for (const m of all('SELECT director_id, cast_ids FROM movies WHERE playing = 1 OR upcoming = 1')) {
    if (m.director_id) ids.add(m.director_id);
    try { for (const c of JSON.parse(m.cast_ids || '[]').slice(0, 3)) if (c) ids.add(c); } catch { /* none */ }
  }
  console.log(`people: ${ids.size}`);
  for (const id of ids) await owner(() => getPerson(id)).catch((e) => console.log(`  person ${id}: ${e.message}`));
  const stats = owner(() => getStats());
  const names = (list) => (Array.isArray(list) ? list : []).map((x) => x?.name).filter(Boolean).slice(0, 8);
  for (const [kind, key] of [['director', 'topDirectors'], ['actor', 'topActors']]) {
    const list = names(stats?.[key]);
    for (const name of list) await owner(() => getStatsMore(kind, name)).catch((e) => console.log(`  more ${name}: ${e.message}`));
  }
  for (const g of ['Science Fiction', 'Drama', 'Animation']) await owner(() => getStatsMore('genre', g)).catch(() => {});

  // Where every stored film streams (movie pages, search, What should I watch?).
  for (const { tmdb_id: id } of all('SELECT tmdb_id FROM movies')) await tmdb.watchProviders(id).catch(() => {});

  // What should I watch?, every question.
  for (const where of ['theater', 'home', 'either']) {
    for (const mood of ['surprise', ...Object.keys(MOODS)]) {
      for (const time of ['any', 'short']) await owner(() => suggest({ where, mood, time })).catch((e) => console.log(`  wsw ${where}/${mood}: ${e.message}`));
    }
  }
  // Search: a few names and titles a visitor is likely to try.
  for (const q of ['nolan', 'dune', 'pixar', 'spider', 'batman', 'star wars', 'tom hanks', 'zendaya']) await owner(() => search(q, { spend: () => true })).catch(() => {});
  // Quick rate and the welcome setup's film lists.
  for (const p of [1, 2]) { await tmdb.popular(p).catch(() => {}); await tmdb.wellKnown(p).catch(() => {}); }

  const colors = {};
  for (const m of all("SELECT tmdb_id, poster_color, poster_color_src FROM movies WHERE poster_color IS NOT NULL AND poster_color != '-'")) colors[m.tmdb_id] = [m.poster_color, m.poster_color_src];
  films.colorsCount = Object.keys(colors).length;
  const sorted = Object.fromEntries(Object.keys(responses).sort().map((k) => [k, responses[k]]));
  const out = JSON.stringify({
    about: 'Public film data from TMDB (themoviedb.org) and OMDb, saved by scripts/demo-snapshot.mjs for the Reel Picks demo. This product uses the TMDB API but is not endorsed or certified by TMDB.',
    savedOn: ymd(today),
    films: { playing, recent, classics },
    colors,
    responses: sorted,
  });
  for (const k of Object.values(KEYS)) if (out.includes(k)) throw new Error('a key ended up in the snapshot; not written');
  fs.writeFileSync(OUT, `${out}\n`);
  console.log(`saved ${Object.keys(sorted).length} answers, ${films.colorsCount} poster colours, ${(out.length / 1048576).toFixed(2)} MB → ${path.relative(ROOT, OUT)}`);
  console.log(`Sam: ${get('SELECT COUNT(*) AS n FROM ratings WHERE user_id = 1').n} ratings`);
});
h.close();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
