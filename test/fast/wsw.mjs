// "What should I watch?" (server/lib/suggest.js) through the API, on a fixed
// seed (RP_WSW_SEED) so every run draws the same films:
//
//   bar       every film clears the match floor and a solid public score
//             (TMDB 7.0+ from 200+ votes, RT 75%+ or IMDb 7.0+), measured here
//             from the stored numbers; a film with no scores only as a theater
//             film showing in the next 48 hours; the ranking blend by ratings
//   relax     too few pass: 70/6.5, then 65/6.0, said in plain words; none at
//             all: "Nothing fits right now." with what to try instead
//   variety   the same seed repeats exactly; 20 opens never repeat a film
//             within 7 days while three others pass; without a seed, better
//             films come up more often but not always the same three; no two
//             films in a set share a director, no three "Surprise me" films a
//             main genre; "Show me 3 more" never repeats; the memory is per
//             person, in the database, and forgets after 7 days
//   privacy   the guest gets 403; one person's memory never touches another's
//   same      suggesting changes no pick and no score anywhere else
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { suite } from '../lib/check.mjs';
import { openWorld, tempDir, until, GUEST, PRELOAD } from '../lib/world.mjs';

const S = suite('wsw');
const SEED = { RP_WSW_SEED: 'wsw-test' };
const w = S.world(await openWorld('wsw', { env: SEED }));
const { robin: R, casey: K, jordan: J } = w.friends;
const OWNER = null;
const api = (as, m, p, body) => w.api(m, p, { as, body });
const ask = async (world, as, body) => {
  const r = await world.api('POST', '/api/suggest', { as, body });
  if (r.status !== 200) throw new Error(`suggest ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};
const ids = (r) => r.films.map((f) => f.tmdb_id);
const SHOW_RE = /^(RT \d+%|IMDb \d+\.\d|TMDB \d+\.\d|No scores yet)$/;

// The films a person could be offered for Either / Any length / Surprise me,
// and which clear the bar, worked out here from /api/recommendations, the
// stored At home list and the movies table (not from suggest.js).
const TIER0 = { match: 65, tmdb: 7.0, rt: 75, imdb: 7.0 };
function publicOk(display, votes, t = TIER0) {
  const d = display || {};
  return (d.rt != null && d.rt >= t.rt) || (d.imdb != null && d.imdb >= t.imdb) || (d.tmdb != null && d.tmdb >= t.tmdb && (votes ?? 0) >= 200);
}
function displayOf(m) {
  const sc = m.scores ? JSON.parse(m.scores) : {};
  const tmdb = m.tmdb_rating > 0 && (m.tmdb_votes == null || m.tmdb_votes >= 50) ? m.tmdb_rating : null;
  return { rt: sc.rt ?? null, imdb: sc.imdb ?? null, tmdb };
}
async function passingPool(world, as, uid) {
  const r = (await world.api('GET', '/api/recommendations', { as })).json;
  const seen = new Set(world.q('SELECT DISTINCT tmdb_id FROM watched WHERE user_id = ?', uid).map((x) => x.tmdb_id));
  const movie = (id) => world.q1('SELECT * FROM movies WHERE tmdb_id = ?', id);
  const pool = new Map();
  for (const e of [...r.list, ...(r.alsoNearby || [])]) {
    if (pool.has(e.tmdb_id) || e.flags.seen || e.flags.hidden || e.flags.excluded || seen.has(e.tmdb_id)) continue;
    const m = movie(e.tmdb_id);
    // No scores at all: only as a theater film with a showing in the next 48 hours.
    const now = world.srv.fakeNowMs + (Date.now() - world.srv.startedAt);
    const soon = (e.showtimesByDay || []).some((d) => d.showtimes.some((x) => x.start_epoch >= now && x.start_epoch - now <= 48 * 3600e3));
    const ok = e.final >= TIER0.match && (e.flags.noScores ? soon : publicOk(e.public.display, m.tmdb_votes));
    pool.set(e.tmdb_id, { final: e.final, ok, director: m.director, genre: JSON.parse(m.genres || '[]')[0] || null, where: 'theater' });
  }
  const hp = world.q1('SELECT ranked FROM home_picks WHERE user_id = ?', uid);
  const rated = new Set(world.q('SELECT tmdb_id FROM ratings WHERE user_id = ?', uid).map((x) => x.tmdb_id));
  const hidden = new Set(world.q('SELECT tmdb_id FROM hidden_movies WHERE user_id = ?', uid).map((x) => x.tmdb_id));
  for (const e of hp ? JSON.parse(hp.ranked) : []) {
    if (pool.has(e.tmdb_id) || rated.has(e.tmdb_id) || hidden.has(e.tmdb_id) || seen.has(e.tmdb_id)) continue;
    const m = movie(e.tmdb_id);
    pool.set(e.tmdb_id, { final: e.final, ok: e.final >= TIER0.match && publicOk(displayOf(m), m.tmdb_votes), director: m.director, genre: JSON.parse(m.genres || '[]')[0] || null, where: 'home' });
  }
  return pool;
}
const homeReady = (world, as) => until(async () => (await world.api('GET', '/api/home-picks', { as })).json?.status === 'ready', 60000, 250);

// One set breaks no variety rule. Returns what's wrong, or ''.
function setProblems(set, pool, surprise) {
  const bad = [];
  const dirs = set.map((id) => pool.get(id)?.director).filter(Boolean);
  if (new Set(dirs).size !== dirs.length) bad.push(`two films by one director (${dirs.join(', ')})`);
  if (surprise) {
    const g = new Map();
    for (const id of set) { const x = pool.get(id)?.genre; if (x) g.set(x, (g.get(x) || 0) + 1); }
    if ([...g.values()].some((n) => n > 2)) bad.push(`three share a main genre (${[...g.entries()].map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
  return bad.join('; ');
}
// Would film `id` have fit beside the rest of `set`?
function conflicts(id, set, pool, surprise) {
  const f = pool.get(id);
  if (!f) return true;
  const others = set.filter((x) => x !== id);
  if (f.director && others.some((x) => pool.get(x)?.director === f.director)) return true;
  return surprise && f.genre && others.filter((x) => pool.get(x)?.genre === f.genre).length >= 2;
}

let before;
const recsOf = async (as) => {
  const r = (await api(as, 'GET', '/api/recommendations')).json;
  const hp = (await api(as, 'GET', '/api/home-picks')).json;
  return JSON.stringify({
    four: r.weekly4.map((e) => [e.tmdb_id, e.final]), list: r.list.map((e) => [e.tmdb_id, e.final, e.public?.combined, e.taste?.score]),
    worth: r.worthSeeing.map((e) => e.tmdb_id), near: r.alsoNearby.map((e) => [e.tmdb_id, e.final]), home: (hp.picks || []).map((p) => [p.tmdb_id, p.final]),
  });
};
const ROLES = { owner: OWNER, heavy: R, empty: K, fresh: J, guest: GUEST };
const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(ROLES).map(async ([k, as]) => [k, await recsOf(as)])));

await S.step('setup: the home lists are worked out, and the picks recorded before anything is suggested', async () => {
  S.check('setup: the owner\'s At home list is ready', await homeReady(w, OWNER));
  S.check('setup: the heavy friend\'s At home list is ready', await homeReady(w, R));
  before = await snapshot();
});

// ============================================================ the bar
await S.step('bar: every film clears the match floor and a solid public score', async () => {
  for (const [who, as, uid] of [['owner', OWNER, 1], ['heavy friend', R, R.id]]) {
    const pool = await passingPool(w, as, uid);
    const r = await ask(w, as, { where: 'either', time: 'any', mood: 'surprise' });
    S.check(`bar: ${who} gets three films`, r.films.length === 3, JSON.stringify(r).slice(0, 300));
    S.check(`bar: ${who}'s answer is not relaxed`, r.relaxed === false && r.note == null, JSON.stringify({ relaxed: r.relaxed, note: r.note }));
    for (const f of r.films) {
      const p = pool.get(f.tmdb_id);
      S.check(`bar: ${who}'s films clear the bar (measured from the stored scores)`, p && p.ok, `${f.title}: ${JSON.stringify(p)}`);
      S.check(`bar: ${who}'s card match is that film's score everywhere else`, p && f.final === p.final, `${f.title}: card ${f.final}, elsewhere ${p?.final}`);
      S.check(`bar: ${who}'s card names the public score that cleared it`, SHOW_RE.test(f.publicLine || ''), f.publicLine);
    }
  }
});

await S.step('bar: a film with no scores only counts as a theater film showing in the next 48 hours', async () => {
  const now = Date.parse('2026-09-23T10:00:00-04:00');
  const x = S.world(await openWorld('wsw-thin', {
    env: SEED,
    prepare: (d) => {
      // No public score for anything playing, and half of them with nothing
      // in the next 48 hours.
      d.exec("UPDATE movies SET scores = NULL, tmdb_rating = NULL WHERE playing = 1");
      const films = d.prepare('SELECT tmdb_id FROM movies WHERE playing = 1 ORDER BY tmdb_id').all().map((r) => r.tmdb_id);
      const later = films.filter((_, i) => i % 2 === 1);
      for (const id of later) d.prepare('DELETE FROM showtimes WHERE tmdb_id = ? AND start_epoch < ?').run(id, now + 50 * 3600e3);
      d.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('wswThinLater', ?)").run(JSON.stringify(later));
      // A strong taste weight, so some unscored films reach the floor on match alone.
      d.prepare("INSERT OR REPLACE INTO user_settings(user_id, key, value) VALUES(1, 'weightPublic', '0.1')").run();
      d.prepare("INSERT OR REPLACE INTO user_settings(user_id, key, value) VALUES(1, 'weightTaste', '0.9')").run();
    },
  }));
  try {
    const later = new Set(JSON.parse(x.q1("SELECT value FROM settings WHERE key = 'wswThinLater'").value));
    const got = [];
    const shown = [];
    for (let i = 0; i < 6; i++) {
      const r = await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'surprise', exclude: shown });
      if (!r.films.length) break;
      for (const f of r.films) { got.push(f); shown.push(f.tmdb_id); }
    }
    S.check('bar: unscored theater films showing within 48 hours are offered (control)', got.length >= 1, `${got.length} offered`);
    S.check('bar: no unscored film without a showing in the next 48 hours is offered', got.every((f) => !later.has(f.tmdb_id)), got.filter((f) => later.has(f.tmdb_id)).map((f) => f.title).join(', '));
    S.check('bar: an unscored film is shown as "No scores yet"', got.every((f) => f.publicLine === 'No scores yet'), got.map((f) => f.publicLine).join(', '));
    S.check('bar: an unscored film still needs the match floor', got.every((f) => f.final >= 65), got.map((f) => f.final).join(', '));
    const home = await ask(x, OWNER, { where: 'home', time: 'any', mood: 'surprise' });
    S.check('bar: At home films all have public scores', home.films.every((f) => f.publicLine !== 'No scores yet'), home.films.map((f) => f.publicLine).join(', '));
  } finally { await x.close(); }
});

await S.step('bar: the ranking blend follows how many films the person rated', async () => {
  // In a child process on an empty scratch database, never the suite's.
  const dir = tempDir('wsw-unit');
  try {
    const code = `const m = await import('./server/lib/suggest.js');
      console.log(JSON.stringify({ w: [0, 4, 5, 19, 20, 700].map((n) => m.blendWeights(n)), r: [m.rankScore(80, 90, m.blendWeights(25)), m.rankScore(80, 90, m.blendWeights(10)), m.rankScore(80, 90, m.blendWeights(3)), m.rankScore(80, null, m.blendWeights(25))],
        floor: m.MATCH_FLOOR, tiers: m.TIERS, p: [m.publicPasses({ display: { tmdb: 7.0 } }, 200).length, m.publicPasses({ display: { tmdb: 7.0 } }, 199).length, m.publicPasses({ display: { rt: 75 } }, 0).length, m.publicPasses({ display: { rt: 74 } }, 0).length, m.publicPasses({ display: { imdb: 7.0 } }, 0).length, m.publicPasses({ display: { imdb: 6.9 } }, 0).length] }));
      process.exit(0);`;
    const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `--import=${PRELOAD}`, '--input-type=module', '-e', code], {
      cwd: w.app, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dir, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 30000,
    });
    const j = JSON.parse(out.stdout.trim().split('\n').pop());
    const wts = j.w.map((x) => `${x.match}/${x.public}`).join(' ');
    S.check('bar: public score alone under 5 ratings, 50/50 from 5 to 19, 60/40 from 20', wts === '0/1 0/1 0.5/0.5 0.5/0.5 0.6/0.4 0.6/0.4', wts);
    S.check('bar: the blend computes as 0.6 x match + 0.4 x public (and 50 for no public score)', Math.abs(j.r[0] - 84) < 1e-9 && Math.abs(j.r[1] - 85) < 1e-9 && j.r[2] === 90 && Math.abs(j.r[3] - 68) < 1e-9, j.r.join(', '));
    S.check('bar: the public bar is TMDB 7.0 from 200 votes, RT 75%, IMDb 7.0', j.p.join('') === '101010', j.p.join(''));
    S.check('bar: the relaxed steps are 70/6.5 and 65/6.0 (never under the floor)', j.tiers.length === 3 && j.tiers[1].tmdb === 6.5 && j.tiers[2].tmdb === 6.0 && j.tiers[1].match === Math.min(j.floor, 70) && j.tiers[2].match === 65 && j.tiers[1].rt === 70 && j.tiers[2].rt === 65, JSON.stringify(j.tiers));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================ relaxing
await S.step('relax: too few pass, the bar comes down and says so; none, and it says what to try', async () => {
  const x = S.world(await openWorld('wsw-relax', {
    env: SEED,
    prepare: (d) => {
      // Every film playing just under the bar: RT 72%, TMDB 6.6 from 300 votes.
      d.exec(`UPDATE movies SET scores = '{"rt":72}', tmdb_rating = 6.6, tmdb_votes = 300 WHERE playing = 1`);
    },
  }));
  try {
    const r = await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'surprise' });
    S.check('relax: three films after coming down a step', r.films.length === 3, `${r.films.length}`);
    S.check('relax: the answer says so in plain words', r.relaxed === true && r.note === 'Not much great in theaters. These are the closest.', r.note);
    S.check('relax: the relaxed films clear 70/6.5 (RT 70%+)', r.films.every((f) => f.final >= 65 && /^RT 72%$/.test(f.publicLine)), r.films.map((f) => `${f.final} ${f.publicLine}`).join(', '));
    const m = await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'funny' });
    S.check('relax: with a mood it says "for this mood"', m.films.length === 0 || m.note === 'Not much great for this mood in theaters. These are the closest.', m.note);
    const d = x.db();
    try { d.exec(`UPDATE movies SET scores = '{"rt":67}', tmdb_rating = 6.1, tmdb_votes = 300 WHERE playing = 1`); } finally { d.close(); }
    const r2 = await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'surprise', exclude: [] });
    S.check('relax: a second step (65/6.0) when the first isn\'t enough', r2.films.length > 0 && r2.relaxed && r2.films.every((f) => f.publicLine === 'RT 67%'), `${r2.films.length} ${r2.films.map((f) => f.publicLine).join(', ')}`);
    const d2 = x.db();
    try { d2.exec(`UPDATE movies SET scores = '{"rt":50}', tmdb_rating = 5.0, tmdb_votes = 300 WHERE playing = 1`); } finally { d2.close(); }
    const none = await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'funny' });
    S.check('relax: nothing at all says "Nothing fits right now. Try another mood or At home."', none.films.length === 0 && none.note === 'Nothing fits right now. Try another mood or At home.', none.note);
    const noneEither = await ask(x, OWNER, { where: 'theater', time: 'short', mood: 'scary' });
    S.check('relax: the tips follow the answers', noneEither.films.length === 0 && noneEither.note === 'Nothing fits right now. Try another mood, At home or Any length.', noneEither.note);
  } finally { await x.close(); }
});

// ============================================================ variety
const OPEN = { where: 'either', time: 'any', mood: 'surprise' };
async function opens(world, as, n, { clear = null } = {}) {
  const sets = [];
  for (let i = 0; i < n; i++) {
    if (clear != null) { const d = world.db(); try { d.prepare('DELETE FROM wsw_shown WHERE user_id = ?').run(clear); } finally { d.close(); } }
    sets.push(ids(await ask(world, as, OPEN)));
  }
  return sets;
}

let ownerSets;
await S.step('variety: 20 opens never repeat a film within 7 days while three others pass', async () => {
  const pool = await passingPool(w, OWNER, 1);
  const passing = [...pool.entries()].filter(([, p]) => p.ok).map(([id]) => id);
  // Start the memory empty (the bar checks above showed some films).
  { const d = w.db(); try { d.prepare('DELETE FROM wsw_shown').run(); } finally { d.close(); } }
  ownerSets = await opens(w, OWNER, 20);
  const before2 = new Set();
  let wrong = '';
  let rulesBroken = '';
  ownerSets.forEach((set, k) => {
    for (const id of set) {
      if (!pool.get(id)?.ok) wrong ||= `open ${k + 1}: ${id} doesn't clear the bar`;
      if (before2.has(id)) {
        const fresh = passing.filter((x) => !before2.has(x));
        const couldHave = fresh.filter((x) => !set.includes(x) && !conflicts(x, [...set.filter((y) => y !== id), x], pool, true));
        if (couldHave.length) wrong ||= `open ${k + 1}: repeated ${id} while ${couldHave.length} unshown films fit`;
      }
    }
    rulesBroken ||= setProblems(set, pool, true);
    for (const id of set) before2.add(id);
  });
  const distinct = new Set(ownerSets.flat()).size;
  console.log(`  variety: owner, 20 opens: ${distinct} distinct films of ${passing.length} that pass`);
  S.check('variety: every film in 20 opens clears the bar, and none repeats while unshown ones fit', !wrong, wrong);
  S.check('variety: every film that passes is shown before any repeats', distinct === passing.length || distinct >= Math.min(passing.length, 20 * 3), `${distinct} of ${passing.length}`);
  S.check('variety: each set has three films', ownerSets.every((s) => s.length === 3), ownerSets.map((s) => s.length).join(''));
  S.check('variety: no set has two films by one director or three sharing a main genre', !rulesBroken, rulesBroken);
  const rows = w.q('SELECT user_id, COUNT(*) n FROM wsw_shown GROUP BY user_id');
  S.check('variety: the memory is kept per person in the database', rows.length === 1 && rows[0].user_id === 1 && rows[0].n === distinct, JSON.stringify(rows));
});

await S.step('variety: the same seed repeats exactly', async () => {
  const x = S.world(await openWorld('wsw-seed', { env: SEED }));
  try {
    await homeReady(x, OWNER);
    const again = await opens(x, OWNER, 20);
    S.check('variety: two fresh copies with one seed give the same 20 sets', JSON.stringify(again) === JSON.stringify(ownerSets), `${JSON.stringify(again.slice(0, 3))} vs ${JSON.stringify(ownerSets.slice(0, 3))}`);
  } finally { await x.close(); }
});

await S.step('variety: better films come up more often, but not always the same three', async () => {
  const x = S.world(await openWorld('wsw-random')); // no seed: real random draws
  try {
    await homeReady(x, OWNER);
    const pool = await passingPool(x, OWNER, 1);
    const sets = await opens(x, OWNER, 40, { clear: 1 });
    const count = new Map();
    for (const id of sets.flat()) count.set(id, (count.get(id) || 0) + 1);
    // Rank as suggest.js does: 60% match, 40% public score (the owner has 20+ ratings).
    const r = (await x.api('GET', '/api/recommendations')).json;
    const pubOf = new Map([...r.list, ...(r.alsoNearby || [])].map((e) => [e.tmdb_id, e.public.combined]));
    const passing = [...pool.entries()].filter(([, p]) => p.ok && p.where === 'theater').map(([id, p]) => ({ id, rank: 0.6 * p.final + 0.4 * (pubOf.get(id) ?? 50) }))
      .sort((a, b) => b.rank - a.rank);
    const top = passing[0];
    const bottom = passing[passing.length - 1];
    const distinct = new Set(sets.flat()).size;
    const topThree = new Set(passing.slice(0, 3).map((p) => p.id));
    console.log(`  variety: memory cleared, 40 opens: ${distinct} distinct films; best-ranked theater film ${count.get(top.id) || 0} times, lowest ${count.get(bottom.id) || 0}`);
    S.check('variety: more than three distinct films across 40 opens', distinct > 3, String(distinct));
    S.check('variety: the best-ranked film comes up more often than the lowest-ranked one that passes', (count.get(top.id) || 0) > (count.get(bottom.id) || 0), `${count.get(top.id) || 0} vs ${count.get(bottom.id) || 0}`);
    S.check('variety: not every set is the top three', sets.some((s) => s.some((id) => !topThree.has(id))));
  } finally { await x.close(); }
});

await S.step('variety: no two films by one director, even when the best ones share one', async () => {
  const x = S.world(await openWorld('wsw-director', {
    env: SEED,
    prepare: (d) => { d.exec("UPDATE movies SET director = 'One Director' WHERE playing = 1 AND tmdb_id IN (SELECT tmdb_id FROM movies WHERE playing = 1 ORDER BY tmdb_rating DESC LIMIT 6)"); },
  }));
  try {
    const shared = new Set(x.q("SELECT tmdb_id FROM movies WHERE director = 'One Director'").map((r) => r.tmdb_id));
    let worst = 0;
    let seenShared = 0;
    for (let i = 0; i < 10; i++) {
      const set = ids(await ask(x, OWNER, { where: 'theater', time: 'any', mood: 'surprise' }));
      const n = set.filter((id) => shared.has(id)).length;
      worst = Math.max(worst, n);
      seenShared += n;
    }
    S.check('variety: films by the shared director are offered (control)', seenShared > 0, String(seenShared));
    S.check('variety: never two of them in one set', worst <= 1, `${worst} in one set`);
  } finally { await x.close(); }
});

await S.step('variety: "Show me 3 more" never repeats a film from the session', async () => {
  const shown = [];
  let last;
  let rounds = 0;
  let repeat = '';
  for (; rounds < 30; rounds++) {
    last = await ask(w, R, { ...OPEN, exclude: shown });
    for (const id of ids(last)) { if (shown.includes(id)) repeat ||= String(id); shown.push(id); }
    if (!last.films.length) break;
  }
  S.check('variety: no film repeats within a session', !repeat && new Set(shown).size === shown.length, repeat);
  S.check('variety: at the end it says that\'s everything', last.films.length === 0 && last.more === false && /^That's everything that fits these answers\./.test(last.note || ''), JSON.stringify(last));
  S.check('variety: a session covers more than one set', rounds >= 2, String(rounds));
});

await S.step('variety: the memory forgets after 7 days', async () => {
  const x = S.world(await openWorld('wsw-week', { env: SEED }));
  const K = x.friends.casey;
  try {
    const first = ids(await ask(x, K, { where: 'theater', time: 'any', mood: 'surprise' }));
    await x.jump('2026-09-29T10:00:00-04:00'); // 6 days on
    const pool = await passingPool(x, K, K.id);
    const passing = [...pool.entries()].filter(([, p]) => p.ok).map(([id]) => id);
    const second = ids(await ask(x, K, { where: 'theater', time: 'any', mood: 'surprise' }));
    const fresh = passing.filter((id) => !first.includes(id));
    S.check('variety: 6 days later the first films are still held back', fresh.length < 3 || second.every((id) => !first.includes(id)), `${first} then ${second}`);
    await x.jump('2026-09-30T10:01:00-04:00'); // 7 days and a minute after the first
    await ask(x, K, { where: 'theater', time: 'any', mood: 'surprise' });
    const old = x.q('SELECT tmdb_id FROM wsw_shown WHERE user_id = ? AND shown_at <= ?', K.id, Date.parse('2026-09-23T10:01:00-04:00')).map((r) => r.tmdb_id);
    S.check('variety: after 7 days the first showing is gone from the memory', old.length === 0 && first.length === 3, JSON.stringify(old));
  } finally { await x.close(); }
});

// ============================================================ privacy
await S.step('privacy: the guest is refused; one person\'s memory never touches another\'s', async () => {
  const g1 = await w.api('POST', '/api/suggest', { as: GUEST, body: OPEN });
  const g2 = await w.api('POST', '/api/suggest/state', { as: GUEST, body: { ids: [990001] } });
  S.check('privacy: the guest gets 403 from /api/suggest', g1.status === 403, String(g1.status));
  S.check('privacy: the guest gets 403 from /api/suggest/state', g2.status === 403, String(g2.status));
  const a = S.world(await openWorld('wsw-priv-a', { env: SEED }));
  const b = S.world(await openWorld('wsw-priv-b', { env: SEED }));
  try {
    const JA = a.friends.jordan; const JB = b.friends.jordan; const KB = b.friends.casey;
    const alone = [];
    for (let i = 0; i < 3; i++) alone.push(ids(await ask(a, JA, OPEN)));
    for (let i = 0; i < 5; i++) await ask(b, KB, OPEN);
    const after = [];
    for (let i = 0; i < 3; i++) after.push(ids(await ask(b, JB, OPEN)));
    S.check('privacy: another friend\'s suggestions leave this friend\'s sets exactly as they were', JSON.stringify(alone) === JSON.stringify(after), `${JSON.stringify(alone)} vs ${JSON.stringify(after)}`);
    const rows = b.q('SELECT user_id, COUNT(*) n FROM wsw_shown GROUP BY user_id ORDER BY user_id');
    S.check('privacy: each person\'s memory holds only their own films', rows.length === 2 && rows.every((r) => [JB.id, KB.id].includes(r.user_id)), JSON.stringify(rows));
    // The owner saved 990002; a friend asking about it sees only their own state.
    const st = (await b.api('POST', '/api/suggest/state', { as: JB, body: { ids: [990002] } })).json;
    S.check('privacy: /api/suggest/state answers with the caller\'s own watchlist only', st.films[0].watchlisted === false && st.films[0].rating == null, JSON.stringify(st));
    const own = (await b.api('POST', '/api/suggest/state', { body: { ids: [990002] } })).json;
    S.check('privacy: and the owner\'s with the owner\'s (control)', own.films[0].watchlisted === true, JSON.stringify(own));
    const bad = await b.api('POST', '/api/suggest/state', { body: { ids: ['x'] } });
    S.check('privacy: /api/suggest/state refuses anything but film ids', bad.status === 400, String(bad.status));
  } finally { await a.close(); await b.close(); }
});

await S.step('a 3-rating friend gets films ranked on public score', async () => {
  const x = S.world(await openWorld('wsw-three', { env: SEED }));
  const K = x.friends.casey;
  try {
    for (const [id, stars] of [[980001, 4], [980002, 3.5], [980003, 4.5]]) {
      const f = x.q1('SELECT title, year FROM movies WHERE tmdb_id = ?', id);
      if (f) await x.api('POST', '/api/ratings', { as: K, body: { tmdb_id: id, rating: stars, title: f.title, year: f.year } });
    }
    const n = x.q1('SELECT COUNT(*) n FROM ratings WHERE user_id = ?', K.id).n;
    const r = await ask(x, K, OPEN);
    S.check('three: the friend has 3 ratings', n === 3, String(n));
    S.check('three: and gets three films that clear the bar', r.films.length === 3 && r.films.every((f) => f.final >= 65 && SHOW_RE.test(f.publicLine)), JSON.stringify(r.films.map((f) => [f.final, f.publicLine])));
  } finally { await x.close(); }
});

// ============================================================ nothing else moved
await S.step('same: suggesting changed no pick and no score anywhere', async () => {
  const after = await snapshot();
  for (const k of Object.keys(ROLES)) S.check(`same: ${k}'s picks, scores and At home are unchanged`, after[k] === before[k], k);
});

S.finish();
