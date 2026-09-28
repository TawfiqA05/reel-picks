// Scores identical (old G7, D11, S10, real-app G20, R7): every film's score,
// the weekly four, Worth seeing, Last chance, Also nearby, movie-page scores
// and Coming Soon predictions, for the owner, the 700-rating friend, the empty
// friend, the brand-new friend and the guest, equal the saved expected values
// in test/fixtures/expected-scores.json. They are measured twice: once as the
// world starts and again after every role has searched for people and opened
// person pages, which must change nothing.
//
// A change that is meant to move scores updates the file on purpose:
//   RP_UPDATE_EXPECTED=1 node test/run.mjs fast --only=scores
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../lib/check.mjs';
import { openWorld, GUEST } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('scores');
const EXPECTED = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'expected-scores.json');
const w = S.world(await openWorld('scores'));
const ROLES = { owner: null, heavy: w.friends.robin, empty: w.friends.casey, fresh: w.friends.jordan, guest: GUEST };

const num = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);
const ids = (list) => (list || []).map((e) => e.tmdb_id);

async function measure() {
  const out = {};
  for (const [role, as] of Object.entries(ROLES)) {
    const recs = (await w.api('GET', '/api/recommendations', { as })).json;
    const cs = (await w.api('GET', '/api/coming-soon', { as })).json;
    const films = {};
    for (const e of [...(recs.list || []), ...(recs.alsoNearby || [])]) {
      films[e.tmdb_id] = {
        final: num(e.final), beforeUrgency: num(e.finalBeforeUrgency), public: num(e.public?.combined),
        critic: num(e.public?.critic), audience: num(e.public?.audience), taste: num(e.taste?.score),
      };
    }
    const movies = {};
    for (const f of C.PLAYING) {
      const m = (await w.api('GET', `/api/movies/${f.id}`, { as })).json;
      movies[f.id] = m ? { final: num(m.final), public: num(m.public?.combined), taste: num(m.taste?.score) } : null;
    }
    out[role] = {
      weekly4: ids(recs.weekly4), lockWeek: recs.lock?.week ?? null, worthSeeing: ids(recs.worthSeeing),
      lastChance: ids(recs.lastChance), alsoNearby: ids(recs.alsoNearby), films, movies,
      comingSoon: Object.fromEntries((cs.list || []).map((e) => [e.tmdb_id, num(e.predicted)])),
    };
  }
  return out;
}

function diff(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], `${at}.${k}`));
  }
  return [`${at}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`];
}

let first;
await S.step('measure every role as the world starts', async () => {
  first = await measure();
  S.check('the owner has a weekly four', first.owner.weekly4.length === 4, JSON.stringify(first.owner.weekly4));
  S.check('the 700-rating friend has a weekly four', first.heavy.weekly4.length === 4);
  S.check('the guest sees the owner\'s four', JSON.stringify(first.guest.weekly4) === JSON.stringify(first.owner.weekly4));
});

if (process.env.RP_UPDATE_EXPECTED === '1') {
  fs.writeFileSync(EXPECTED, `${JSON.stringify(first, null, 1)}\n`);
  console.log(`wrote ${EXPECTED}`);
}
const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));

await S.step('every score and pick equals the saved expected values', async () => {
  for (const role of Object.keys(ROLES)) {
    const d = diff(first[role], expected[role]);
    S.check(`${role}: scores, the four and every list equal the expected values`, !d.length, d.slice(0, 6).join(' | '));
  }
});

await S.step('people searches and person pages change nothing', async () => {
  for (const as of Object.values(ROLES)) {
    if (as !== GUEST) {
      for (const q of ['ada lindqvist', 'lindqvst', 'june calloway']) await w.api('GET', `/api/search?q=${encodeURIComponent(q)}`, { as });
    }
    for (const p of [C.PEOPLE.ada, C.PEOPLE.june, C.PEOPLE.tomas]) await w.api('GET', `/api/person/${p.id}`, { as });
  }
  const again = await measure();
  for (const role of Object.keys(ROLES)) {
    const d = diff(again[role], expected[role]);
    S.check(`${role}: still equal after people searches and person pages`, !d.length, d.slice(0, 6).join(' | '));
  }
});

await w.close();
S.finish();
