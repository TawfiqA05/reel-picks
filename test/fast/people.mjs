// Person pages at the API (person search S3, API parts, and S4 g-cache).
//
// S3: /api/person/<id> lists Playing now (the person's films showing at the
// viewer's own theaters from today on, read here from the showtimes table),
// then You rated (the viewer's own ratings), then every other feature film,
// most popular first, split into Directed and Acted; the Directed / Acted
// switch in the app shows exactly when both lists have films. Rating or
// saving a film from there writes that user's row only, and a film just rated
// moves into You rated. The expected lists are worked out here from the
// made-up catalog, not taken from the app.
//
// S4: a person's credits come only through the shared 7-day cache key
// tmdb:person:<id>:movie_credits (tmdb.personCredits, behind the shared
// throttle): a second user opening the same person makes no TMDB call, a
// header search reads the same row, and no other cache key holds credits.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, REPO } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('people');

// One made-up person who has both directed and acted, planted as a cached
// TMDB answer (the catalog's own people each do one or the other).
const BOTH = { id: 59001, name: 'Noa Ferrante', dept: 'Directing' };
const light = (f) => C.light(f);
const BOTH_CREDITS = {
  id: BOTH.id,
  crew: [C.film(990012), C.film(950003), C.film(950010)].map((f) => ({ ...light(f), job: 'Director', department: 'Directing', credit_id: `n${f.id}d` })),
  cast: [C.film(950004), C.film(950011), C.film(960002)].map((f, i) => ({ ...light(f), character: `Role ${i + 1}`, order: i, credit_id: `n${f.id}a` })),
};
const plant = (d) => {
  const at = new Date(C.T0_MS - 3600e3).toISOString();
  const put = d.prepare('INSERT OR REPLACE INTO cache(key, value, fetched_at, ttl) VALUES(?, ?, ?, ?)');
  put.run(`tmdb:person:${BOTH.id}`, JSON.stringify({ id: BOTH.id, name: BOTH.name, known_for_department: 'Directing', profile_path: null, popularity: 12, adult: false }), at, 7 * 86400);
  put.run(`tmdb:person:${BOTH.id}:movie_credits`, JSON.stringify(BOTH_CREDITS), at, 7 * 86400);
};

const w = S.world(await openWorld('people', { prepare: plant }));
const owner = null;
const robin = w.friends.robin;
const casey = w.friends.casey;

const ids = (list) => list.map((f) => f.tmdb_id);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const nonIncreasing = (list) => list.every((f, i) => i === 0 || (list[i - 1].popularity ?? 0) >= (f.popularity ?? 0));
const today = C.ymdLocal(new Date(C.T0_MS));

// The person's feature films straight from the catalog (their TMDB credits).
function expectedFor(p) {
  const cr = p.id === BOTH.id ? BOTH_CREDITS : C.credits(p);
  const feature = (c) => !c.adult && !c.video && Boolean(c.release_date) && !(c.genre_ids || []).includes(10770);
  const directed = cr.crew.filter((c) => c.job === 'Director' && feature(c)).map((c) => c.id);
  const acted = cr.cast.filter(feature).map((c) => c.id);
  return { directed, acted, all: [...new Set([...directed, ...acted])] };
}
async function viewer(as, uid) {
  const st = (await w.api('GET', '/api/settings', { as })).json;
  const theatres = [st.theatreId, ...(st.extraTheatres || []).map((t) => t.id)].filter(Boolean).map(String);
  const showing = new Set(theatres.length ? w.q(`SELECT DISTINCT tmdb_id FROM showtimes WHERE tmdb_id IS NOT NULL AND date >= ? AND theatre_id IN (${theatres.map(() => '?').join(',')})`, today, ...theatres).map((r) => r.tmdb_id) : []);
  const mine = new Map(w.q('SELECT tmdb_id, rating FROM ratings WHERE user_id = ?', uid).map((r) => [r.tmdb_id, r.rating]));
  const hidden = new Set(w.q('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?', uid).map((r) => r.tmdb_id));
  return { showing, mine, hidden };
}

const VIEWERS = [['owner', owner, 1], ['heavy friend', robin, robin.id], ['empty friend', casey, casey.id]];
for (const p of [C.PEOPLE.ada, C.PEOPLE.june, BOTH]) {
  await S.step(`${p.name}: sections, lists and order`, async () => {
    const exp = expectedFor(p);
    for (const [who, as, uid] of VIEWERS) {
      const r = await w.api('GET', `/api/person/${p.id}`, { as });
      if (!S.check(`${who}: ${p.name}'s page answers`, r.status === 200 && r.json?.person?.id === p.id, `${r.status}`)) continue;
      const d = r.json;
      const v = await viewer(as, uid);
      const wantPlaying = exp.all.filter((id) => v.showing.has(id) && !v.hidden.has(id));
      S.check(`${who}: ${p.name} Playing now is exactly their films at the viewer's theaters`, sameSet(ids(d.playing), wantPlaying), `${ids(d.playing)} vs ${wantPlaying}`);
      d.playing.forEach((f) => S.check(`${who}: ${p.name} Playing now film ${f.tmdb_id} is marked playing`, f.playing === true));
      const wantRated = exp.all.filter((id) => v.mine.has(id) && !v.showing.has(id));
      S.check(`${who}: ${p.name} You rated is exactly the viewer's own rated films of theirs`, sameSet(ids(d.rated), wantRated) && d.rated.every((f) => f.myRating === v.mine.get(f.tmdb_id)), `${ids(d.rated)} vs ${wantRated}`);
      const rest = [...d.directed, ...d.acted, ...d.actedSmaller];
      const restD = exp.directed.filter((id) => !v.showing.has(id) && !v.mine.has(id) && !v.hidden.has(id));
      const restA = exp.acted.filter((id) => !v.showing.has(id) && !v.mine.has(id) && !v.hidden.has(id));
      S.check(`${who}: ${p.name} Directed and Acted hold exactly the rest`, sameSet(ids(d.directed), restD) && sameSet(ids([...d.acted, ...d.actedSmaller]), restA), `${ids(d.directed)} / ${ids([...d.acted, ...d.actedSmaller])}`);
      const all = [...d.playing, ...d.rated, ...rest];
      S.check(`${who}: ${p.name} lists nothing outside their feature films`, ids(all).every((id) => exp.all.includes(id)));
      const apart = (a, b) => !ids(a).some((id) => ids(b).includes(id));
      S.check(`${who}: ${p.name} each film sits in one section`, apart(d.playing, d.rated) && apart(d.playing, rest) && apart(d.rated, rest));
      S.check(`${who}: ${p.name} most popular first`, [d.playing, d.directed, d.acted, d.actedSmaller].every(nonIncreasing));
      const both = restD.length > 0 && restA.length > 0;
      S.check(`${who}: ${p.name} the Directed / Acted switch would show exactly when both have films`, (d.directed.length > 0 && (d.acted.length + d.actedSmaller.length) > 0) === both);
    }
  });
}

await S.step('the switch shows for someone who both directed and acted', async () => {
  const d = (await w.api('GET', `/api/person/${BOTH.id}`)).json;
  S.check('a directing and acting person has films in both lists', d.directed.length > 0 && (d.acted.length + d.actedSmaller.length) > 0, JSON.stringify({ d: ids(d.directed), a: ids(d.acted) }));
  const ada = (await w.api('GET', `/api/person/${C.PEOPLE.ada.id}`)).json;
  S.check('a director who never acted has no Acted list (no switch)', ada.acted.length === 0 && ada.actedSmaller.length === 0 && ada.directed.length > 0);
});

await S.step('rating and saving from a person page writes only that user\'s row', async () => {
  const film = 950007; // one of Ada Lindqvist's films nobody has rated
  const save = 950013;
  const before = w.q('SELECT user_id FROM ratings WHERE tmdb_id = ?', film).map((r) => r.user_id);
  S.check('nobody has rated the film yet', before.length === 0, before.join(','));
  const r = await w.api('POST', '/api/ratings', { as: casey, body: { tmdb_id: film, rating: 4, title: C.film(film).title } });
  S.check('the empty friend rates it', r.status === 200, `${r.status}`);
  const rows = w.q('SELECT user_id, rating FROM ratings WHERE tmdb_id = ?', film);
  S.check('exactly one rating row, the friend\'s', rows.length === 1 && rows[0].user_id === casey.id && rows[0].rating === 4, JSON.stringify(rows));
  const t = await w.api('POST', '/api/watchlist/toggle', { as: casey, body: { tmdb_id: save } });
  S.check('the empty friend saves another', t.status === 200 && t.json.watchlisted === true);
  const wl = w.q('SELECT user_id FROM watchlist WHERE tmdb_id = ?', save).map((x) => x.user_id);
  S.check('exactly one watchlist row, the friend\'s', wl.length === 1 && wl[0] === casey.id, wl.join(','));
  const mine = (await w.api('GET', `/api/person/${C.PEOPLE.ada.id}`, { as: casey })).json;
  S.check('the rated film moved into You rated with its stars', mine.rated.some((f) => f.tmdb_id === film && f.myRating === 4) && ![...mine.directed, ...mine.acted].some((f) => f.tmdb_id === film));
  S.check('the saved film shows as saved for the friend', [...mine.directed, ...mine.acted, ...mine.rated].some((f) => f.tmdb_id === save && f.watchlisted === true));
  for (const [who, as] of [['owner', owner], ['heavy friend', robin]]) {
    const o = (await w.api('GET', `/api/person/${C.PEOPLE.ada.id}`, { as })).json;
    const every = [...o.playing, ...o.rated, ...o.directed, ...o.acted, ...o.actedSmaller];
    S.check(`${who} sees neither the friend's rating nor save`, !o.rated.some((f) => f.tmdb_id === film) && every.every((f) => f.tmdb_id !== film || f.myRating == null) && every.every((f) => f.tmdb_id !== save || f.watchlisted === false));
  }
});

// ---------------------------------------------------------------- S4: the shared cache
await S.step('code: one place asks TMDB for movie credits, always behind the throttle', async () => {
  const lib = path.join(REPO, 'server/lib');
  const files = fs.readdirSync(lib).map((f) => path.join(lib, f)).concat([path.join(REPO, 'server/routes.js'), path.join(REPO, 'server/index.js')]);
  const hits = []; const calls = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => { if (/movie_credits/.test(line) && !/^\s*\/\//.test(line)) hits.push(`${path.basename(f)}:${i + 1}`); });
    for (const m of src.matchAll(/tmdb\.(personCredits|person|searchPeople)\(([^)]*)\)/g)) calls.push({ file: path.basename(f), fn: m[1], args: m[2] });
  }
  const tm = fs.readFileSync(path.join(lib, 'tmdb.js'), 'utf8');
  const def = tm.match(/const creditsKey[\s\S]*?export async function personCredits[\s\S]*?\n}\n/)?.[0] || '';
  S.check('movie_credits appears only in tmdb.js, in personCredits and its key', hits.length === 2 && hits.every((h) => h.startsWith('tmdb.js')) && /person:\$\{personId\}:movie_credits/.test(def) && /req\(creditsKey\(personId\), 7 \* DAY/.test(def), hits.join(', '));
  S.check('every personCredits / person / searchPeople call passes tmdbThrottle', calls.length >= 5 && calls.every((c) => /gate: tmdbThrottle/.test(c.args)), calls.map((c) => `${c.file}:${c.fn}(${c.args})`).join(' | '));
});

await S.step('run time: a second user costs no TMDB call', async () => {
  const P = C.PEOPLE.lena;
  const key = `tmdb:person:${P.id}:movie_credits`;
  S.check('the person is not cached at the start', !w.q("SELECT key FROM cache WHERE key LIKE ?", `tmdb:person:${P.id}%`).length);
  const a = await w.api('GET', `/api/person/${P.id}`);
  S.check('the owner opens the person page', a.status === 200 && a.json.person.id === P.id, `${a.status}`);
  const mine = w.q('SELECT fetched_at, ttl FROM cache WHERE key = ?', key);
  S.check('their credits sit in tmdb:person:<id>:movie_credits for 7 days', mine.length === 1 && mine[0].ttl === 7 * 86400, JSON.stringify(mine));
  const calls = () => w.net().filter((e) => e.host === 'api.themoviedb.org' && e.path.startsWith(`/3/person/${P.id}`)).length;
  const before = calls();
  S.check('the owner\'s page asked TMDB for the person', before >= 1, `${before}`);
  const b = await w.api('GET', `/api/person/${P.id}`, { as: robin });
  S.check('a friend opens the same person and gets the same films', b.status === 200 && JSON.stringify(ids([...b.json.acted, ...b.json.actedSmaller, ...b.json.playing, ...b.json.rated]).sort()) === JSON.stringify(ids([...a.json.acted, ...a.json.actedSmaller, ...a.json.playing, ...a.json.rated]).sort()));
  S.check('the friend\'s page made no TMDB call', calls() === before, `${before} -> ${calls()}`);
  const s = await w.api('GET', `/api/search?q=${encodeURIComponent(P.name.toLowerCase())}`, { as: robin });
  S.check('the header search finds them', s.json?.people?.[0]?.id === P.id, JSON.stringify(s.json?.people || []).slice(0, 120));
  S.check('the search read the same cached credits (no credits call)', w.net().filter((e) => e.path === `/3/person/${P.id}/movie_credits`).length === 1);
  S.check('the cached credits were not fetched again', w.q('SELECT fetched_at FROM cache WHERE key = ?', key)[0]?.fetched_at === mine[0]?.fetched_at);
  const others = w.q("SELECT key FROM cache WHERE key LIKE '%credits%'").map((r) => r.key)
    .filter((k) => !/^tmdb:person:\d+:movie_credits$/.test(k) && !/^tmdb:filmpeople:\d+$/.test(k));
  S.check('no other cache key holds movie credits', !others.length, others.slice(0, 5).join(', '));
  const fp = w.q("SELECT value FROM cache WHERE key LIKE 'tmdb:filmpeople:%' LIMIT 20").map((r) => JSON.parse(r.value));
  S.check('the typo list keeps only names and ids per film, not credits', fp.length > 0 && fp.every((v) => Object.keys(v).sort().join() === 'cast,directors' && [...v.cast, ...v.directors].every((p) => Object.keys(p).sort().join() === 'id,name')), JSON.stringify(fp[0]).slice(0, 120));
  const st = (await w.api('GET', '/api/status')).json;
  S.check('the shared throttle never let more than four calls through in a second', st.creditsBackfill.maxPerSecond <= 4 && st.creditsBackfill.calls >= 1, JSON.stringify(st.creditsBackfill));
});

await w.close();
S.finish();
