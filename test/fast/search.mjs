// Header search (old G5 g-search, person search S1 and S2 g-people): the
// famous film stays in the first three rows for everyday and misspelled
// queries, the right person is the first row for people queries (typos
// included), and search recents are private to each person.
//
// TMDB's answers are real ones saved in test/fixtures/tmdb, so the ranking is
// tested against what TMDB really returns. "The famous film" and "the right
// person" are decided here from those saved answers, not hand-picked: the
// most-voted film whose title is the query's title, the most popular person
// with exactly that name. The rows are checked in the order the sheet shows
// them (people first, then films); the function suite checks the sheet in
// the browser shows exactly these rows.
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, until, GUEST } from '../lib/world.mjs';

const S = suite('search');
const SAVED = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'tmdb');
const saved = new Map(fs.readdirSync(SAVED).filter((f) => f.endsWith('.json')).map((f) => {
  const r = JSON.parse(fs.readFileSync(path.join(SAVED, f), 'utf8'));
  return [r.key, r.body];
}));
const tmdbSaved = (p, params) => saved.get(`/3${p}?${new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`);

export const FILMS = {
  brave: 'Brave', interstelar: 'Interstellar', spiderman: 'Spider-Man', amelie: 'Amélie', 'only the brav': 'Only the Brave',
  dune: 'Dune', batman: 'Batman', godfather: 'The Godfather', 'toy story': 'Toy Story', barbie: 'Barbie',
  oppenheimer: 'Oppenheimer', joker: 'Joker', frozen: 'Frozen', alien: 'Alien', inception: 'Inception',
};
export const PEOPLE = {
  'quentin tarantino': 'Quentin Tarantino', tarantino: 'Quentin Tarantino', tarentino: 'Quentin Tarantino',
  'greta gerwig': 'Greta Gerwig', 'denis villeneuve': 'Denis Villeneuve', zendaya: 'Zendaya',
  'pedro pascal': 'Pedro Pascal', 'florence pugh': 'Florence Pugh',
};
const ROLE = { Directing: 'Director', Acting: 'Actor' };
const normT = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/^the /, '').replace(/\s+/g, '');
const normName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function famous(title) {
  const r = tmdbSaved('/search/movie', { include_adult: 'false', language: 'en-US', query: title });
  const same = (r?.results || []).filter((x) => normT(x.title) === normT(title)).sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
  return same[0] ? { id: same[0].id, title: same[0].title, year: (same[0].release_date || '').slice(0, 4) } : null;
}
function rightPerson(name) {
  const r = tmdbSaved('/search/person', { include_adult: 'false', language: 'en-US', query: name.toLowerCase() })
    || tmdbSaved('/search/person', { include_adult: 'false', language: 'en-US', query: name });
  const same = (r?.results || []).filter((p) => normName(p.name) === normName(name)).sort((a, b) => b.popularity - a.popularity);
  return same[0] ? { id: same[0].id, name: same[0].name, dept: same[0].known_for_department } : null;
}

// The people warm-up (names a typo can be corrected to) runs from TMDB's
// most-voted films; this world starts it from the saved real answers.
const w = S.world(await openWorld('search', {
  env: { RP_TIMEOUT_SCALE: '0.02' },
  prepare: (d) => d.exec("DELETE FROM cache WHERE key LIKE 'tmdb:well_known:%' OR key LIKE 'tmdb:filmpeople:%'"),
}));
const fresh = w.friends.jordan;
const other = w.friends.casey;
await w.api('PUT', '/api/settings', { as: fresh, body: { setupDone: true, tourDone: true, youNoteSeen: true } });

await S.step('the typo list warms up from the saved answers', async () => {
  const ok = await until(async () => ((await w.api('GET', '/api/search?q=tarentino')).json?.people || []).length > 0, 120000, 1000);
  S.check('the people warm-up finished', Boolean(ok));
});

const rows = (r) => [...(r.people || []).map((p) => ({ kind: 'person', ...p })), ...(r.results || []).map((f) => ({ kind: 'film', id: f.tmdb_id, ...f }))];

for (const [who, as] of [['owner', null], ['brand-new friend', fresh]]) {
  await S.step(`famous films in the top 3 (${who})`, async () => {
    for (const [q, title] of Object.entries(FILMS)) {
      const f = famous(title);
      if (!S.check(`the saved answers name the famous film for "${q}"`, Boolean(f), title)) continue;
      const r = (await w.api('GET', `/api/search?q=${encodeURIComponent(q)}`, { as })).json;
      const top = rows(r).slice(0, 3);
      S.check(`${who}: "${q}" keeps ${f.title} (${f.year}) in the first 3 rows, people counted`, top.some((x) => x.kind === 'film' && x.id === f.id), top.map((x) => `${x.kind}:${x.title || x.name}`).join(' | '));
    }
  });
  await S.step(`people first (${who})`, async () => {
    for (const [q, name] of Object.entries(PEOPLE)) {
      const want = rightPerson(name);
      if (!S.check(`the saved answers name ${name}`, Boolean(want))) continue;
      const r = (await w.api('GET', `/api/search?q=${encodeURIComponent(q)}`, { as })).json;
      const people = r.people || [];
      const top = people[0];
      S.check(`${who}: "${q}" shows ${name} as the first row`, top?.id === want.id, people.map((p) => `${p.id}:${p.name}`).join(' | '));
      S.check(`${who}: "${q}" has at most 2 person rows`, people.length <= 2, `${people.length}`);
      if (top?.id === want.id) {
        S.check(`${who}: "${q}" row says ${ROLE[want.dept]} with 2 or 3 known-for titles`, top.role === ROLE[want.dept] && top.knownFor.length >= 2 && top.knownFor.length <= 3, `${top.role} / ${top.knownFor.join(', ')}`);
      }
    }
  });
}

await S.step('recents are private per person', async () => {
  for (const u of [null, fresh, other]) await w.api('POST', '/api/search/recents/clear', { as: u });
  await w.api('POST', '/api/search/recents', { as: fresh, body: { query: 'dune' } });
  await w.api('POST', '/api/search/recents', { as: fresh, body: { movie: { tmdb_id: 438631, title: 'Dune', year: 2021 } } });
  await w.api('POST', '/api/search/recents', { as: fresh, body: { person: { id: 138, name: 'Quentin Tarantino', role: 'Director' } } });
  const mine = (await w.api('GET', '/api/search/recents', { as: fresh })).json;
  S.check('the searcher\'s query, film and person are saved', mine.queries.some((x) => x.query === 'dune') && mine.movies.some((m) => m.tmdb_id === 438631) && mine.people.some((p) => p.id === 138));
  const own = (await w.api('GET', '/api/search/recents')).json;
  const oth = (await w.api('GET', '/api/search/recents', { as: other })).json;
  S.check('the owner sees none of them', !own.queries.length && !own.movies.length && !own.people.length, JSON.stringify(own).slice(0, 120));
  S.check('another friend sees none of them', !oth.queries.length && !oth.movies.length && !oth.people.length);
  S.check('the guest link can\'t read recents', (await w.api('GET', '/api/search/recents', { as: GUEST })).status === 403);
  S.check('the guest link can\'t search', (await w.api('GET', '/api/search?q=dune', { as: GUEST })).status === 403);
  await w.api('POST', '/api/search/recents', { body: { query: 'owner query' } });
  await w.api('POST', '/api/search/recents/clear', { as: fresh });
  S.check('one person clearing leaves the others\' alone', (await w.api('GET', '/api/search/recents')).json.queries.some((x) => x.query === 'owner query'));
  const cleared = (await w.api('GET', '/api/search/recents', { as: fresh })).json;
  S.check('clearing empties the searcher\'s own recents', !cleared.queries.length && !cleared.movies.length && !cleared.people.length);
});

await w.close();
S.finish();
