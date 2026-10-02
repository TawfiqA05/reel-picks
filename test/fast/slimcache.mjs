// Slim film details in the cache (lib/tmdb.js slimDetails, lib/housekeeping.js):
// a TMDB film detail answer is saved with only the parts the app reads, and
// the nightly cleanup slims a row saved in full before, right after a good
// backup and only then, changing that row's value and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { suite } from '../lib/check.mjs';
import { openWorld, until, sleep } from '../lib/world.mjs';

const S = suite('slimcache');
const at = (local) => `${local}-04:00`;
const w = S.world(await openWorld('slimcache', { env: { RP_FAKE_NOW: at('2026-10-02T01:00:00') } }));
const BK = path.join(w.dataDir, 'backups');
const log = () => w.srv.log();

const TOP = ['id', 'imdb_id', 'title', 'release_date', 'poster_path', 'backdrop_path', 'runtime', 'overview', 'vote_average', 'vote_count',
  'genres', 'belongs_to_collection', 'videos', 'credits', 'release_dates'];
const slimShape = (d) => {
  const bad = [];
  for (const k of Object.keys(d || {})) if (!TOP.includes(k)) bad.push(k);
  if ((d?.credits?.crew || []).some((c) => c.job !== 'Director' || Object.keys(c).some((k) => !['id', 'name', 'job'].includes(k)))) bad.push('crew');
  if ((d?.credits?.cast || []).length > 6 || (d?.credits?.cast || []).some((c) => Object.keys(c).some((k) => !['id', 'name', 'order'].includes(k)))) bad.push('cast');
  if ((d?.release_dates?.results || []).some((r) => r.iso_3166_1 !== 'US')) bad.push('release_dates');
  if ((d?.videos?.results || []).some((v) => v.site !== 'YouTube')) bad.push('videos');
  return bad;
};

// A detail answer as TMDB sends it: long crew and cast lists, many countries,
// videos from more than one site, fields the app never reads.
const ID = 4242001;
const full = {
  adult: false, backdrop_path: '/bd.jpg', belongs_to_collection: { id: 77, name: 'A Series', poster_path: '/c.jpg', backdrop_path: '/cb.jpg' },
  budget: 1000000, genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }], homepage: 'https://example.com', id: ID, imdb_id: 'tt4242001',
  origin_country: ['US'], original_language: 'en', original_title: 'A Planted Film', overview: 'Someone plants a film in the cache.', popularity: 12.5,
  poster_path: '/p.jpg', production_companies: [{ id: 1, name: 'Studio' }], release_date: '2026-05-01', revenue: 5, runtime: 101, status: 'Released',
  tagline: 'Planted.', title: 'A Planted Film', video: false, vote_average: 7.1, vote_count: 812,
  videos: { results: [
    { iso_639_1: 'en', iso_3166_1: 'US', name: 'Clip', key: 'vimeo1', site: 'Vimeo', size: 1080, type: 'Clip', official: true, published_at: '2026-04-01T00:00:00Z', id: 'v1' },
    { iso_639_1: 'en', iso_3166_1: 'US', name: 'Teaser', key: 'yt-teaser', site: 'YouTube', size: 1080, type: 'Teaser', official: true, published_at: '2026-03-01T00:00:00Z', id: 'v2' },
    { iso_639_1: 'en', iso_3166_1: 'US', name: 'Trailer', key: 'yt-trailer', site: 'YouTube', size: 1080, type: 'Trailer', official: false, published_at: '2026-04-02T00:00:00Z', id: 'v3' },
  ] },
  credits: {
    cast: Array.from({ length: 12 }, (_, i) => ({ adult: false, gender: 2, id: 7000 + i, known_for_department: 'Acting', name: `Actor ${i}`, original_name: `Actor ${i}`, popularity: 3, profile_path: `/a${i}.jpg`, cast_id: i, character: `Role ${i}`, credit_id: `c${i}`, order: 11 - i })),
    crew: [
      { id: 8001, name: 'Writer One', job: 'Screenplay', department: 'Writing', profile_path: null, credit_id: 'w1' },
      { id: 8002, name: 'Director One', job: 'Director', department: 'Directing', profile_path: '/d.jpg', credit_id: 'd1' },
      { id: 8003, name: 'Composer One', job: 'Original Music Composer', department: 'Sound', profile_path: null, credit_id: 'm1' },
    ],
  },
  release_dates: { results: [
    { iso_3166_1: 'FR', release_dates: [{ certification: '', descriptor: [], iso_639_1: '', note: '', release_date: '2026-04-20T00:00:00.000Z', type: 3 }] },
    { iso_3166_1: 'US', release_dates: [{ certification: '', descriptor: [], iso_639_1: '', note: 'Festival', release_date: '2026-03-10T00:00:00.000Z', type: 1 }, { certification: 'R', descriptor: [], iso_639_1: '', note: '', release_date: '2026-05-01T00:00:00.000Z', type: 3 }] },
  ] },
};
// What the app keeps of it.
const slim = {
  id: ID, imdb_id: 'tt4242001', title: 'A Planted Film', release_date: '2026-05-01', poster_path: '/p.jpg', backdrop_path: '/bd.jpg', runtime: 101,
  overview: 'Someone plants a film in the cache.', vote_average: 7.1, vote_count: 812,
  genres: [{ id: 18, name: 'Drama' }, { id: 53, name: 'Thriller' }], belongs_to_collection: { id: 77 },
  videos: { results: [
    { site: 'YouTube', key: 'yt-teaser', type: 'Teaser', iso_639_1: 'en', official: true, published_at: '2026-03-01T00:00:00Z' },
    { site: 'YouTube', key: 'yt-trailer', type: 'Trailer', iso_639_1: 'en', official: false, published_at: '2026-04-02T00:00:00Z' },
  ] },
  credits: {
    cast: Array.from({ length: 6 }, (_, i) => ({ id: 7011 - i, name: `Actor ${11 - i}`, order: i })),
    crew: [{ id: 8002, name: 'Director One', job: 'Director' }],
  },
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: '', type: 1, release_date: '2026-03-10T00:00:00.000Z' }, { certification: 'R', type: 3, release_date: '2026-05-01T00:00:00.000Z' }] }] },
};

const OTHER = ['ratings', 'watchlist', 'watched', 'hidden_movies', 'users', 'user_settings', 'weekly4_log', 'movies', 'showtimes', 'matches', 'settings'];
function tables() {
  const d = new DatabaseSync(w.dbFile, { readOnly: true });
  try {
    const out = {};
    for (const t of OTHER) out[t] = crypto.createHash('sha256').update(JSON.stringify(d.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2`).all())).digest('hex');
    out.cache = new Map(d.prepare('SELECT key, value, fetched_at, ttl FROM cache').all().map((r) => [r.key, r]));
    return out;
  } finally { d.close(); }
}
function plant(key, value, fetched) {
  const d = w.db();
  d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?,?,?,?)').run(key, JSON.stringify(value), new Date(at(fetched)).toISOString(), 604800);
  d.close();
}

await S.step('new answers are saved slim', async () => {
  const rows = w.q("SELECT key, value FROM cache WHERE key GLOB 'tmdb:movie:[0-9]*'");
  const bad = rows.map((r) => [r.key, slimShape(JSON.parse(r.value))]).filter(([, b]) => b.length);
  S.check('every film detail row the sample world saved holds only the parts the app reads', rows.length >= 20 && !bad.length, `${rows.length} rows; ${bad.slice(0, 3).map(([k, b]) => `${k}: ${b.join(',')}`).join('; ')}`);
  await w.srv.stop();
});

await S.step('night 1: after the backup, a row saved in full is slimmed and nothing else changes', async () => {
  plant(`tmdb:movie:${ID}`, full, '2026-10-01T12:00:00');
  plant('tmdb:movie:4242002', { ...slim, id: 4242002 }, '2026-10-01T12:00:00');
  const before = tables();
  await w.restart({ fakeNow: at('2026-10-02T03:01:00') });
  await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-10-02.db')) && /\[housekeeping\] cache/.test(log()), 30000);
  await sleep(1500);
  const after = tables();
  const row = after.cache.get(`tmdb:movie:${ID}`);
  S.check('night 1: the full row now holds exactly the slim answer', row && row.value === JSON.stringify(slim), row?.value?.slice(0, 200));
  S.check('night 1: its fetched time and lifetime are as they were', row && row.fetched_at === before.cache.get(`tmdb:movie:${ID}`).fetched_at && row.ttl === 604800);
  S.check('night 1: a row already slim is left byte for byte', after.cache.get('tmdb:movie:4242002')?.value === before.cache.get('tmdb:movie:4242002').value);
  S.check('night 1: the log says one row was slimmed', /\[housekeeping\] cache: slimmed 1 TMDB film detail row/.test(log()), log().split('\n').filter((l) => /housekeeping/.test(l)).join(' | '));
  const others = [...after.cache].filter(([k, r]) => k !== `tmdb:movie:${ID}` && before.cache.has(k) && before.cache.get(k).value !== r.value && Date.parse(r.fetched_at) < Date.parse(at('2026-10-02T02:00:00'))).map(([k]) => k);
  S.check('night 1: no other cache row was rewritten', !others.length, others.slice(0, 5).join(', '));
  const changed = OTHER.filter((t) => t !== 'settings' && before[t] !== after[t]);
  S.check('night 1: no other table changed', !changed.length, changed.join(', '));
  const bk = new DatabaseSync(path.join(BK, 'reelpicks-2026-10-02.db'), { readOnly: true });
  const inBackup = bk.prepare('SELECT value FROM cache WHERE key = ?').get(`tmdb:movie:${ID}`)?.value;
  bk.close();
  S.check('night 1: the backup was taken first (it holds the full row)', inBackup === JSON.stringify(full));
  await w.srv.stop();
});

await S.step('night 2: a failed backup slims nothing; a slim cache needs no more work', async () => {
  plant('tmdb:movie:4242003', { ...full, id: 4242003 }, '2026-10-02T12:00:00');
  fs.chmodSync(BK, 0o555);
  try {
    await w.restart({ fakeNow: at('2026-10-03T03:01:00') });
    await until(() => /\[backup\] ✗/.test(log()), 20000);
    await sleep(1500);
    S.check('night 2: the backup failed', /\[backup\] ✗ reelpicks-2026-10-03\.db/.test(log()));
    S.check('night 2: so the full row is still full', w.q1("SELECT value FROM cache WHERE key = 'tmdb:movie:4242003'")?.value === JSON.stringify({ ...full, id: 4242003 }));
    await w.srv.stop();
  } finally { fs.chmodSync(BK, 0o755); }
  w.q("DELETE FROM cache WHERE key = 'tmdb:movie:4242003'");
  await w.restart({ fakeNow: at('2026-10-04T03:01:00') });
  await until(() => fs.existsSync(path.join(BK, 'reelpicks-2026-10-04.db')) && /\[housekeeping\] cache/.test(log()), 30000);
  await sleep(1500);
  S.check('night 3: with every row slim, nothing is slimmed', !/slimmed/.test(log()));
});

await w.close();
S.finish();
