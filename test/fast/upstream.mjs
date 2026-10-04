// What the app does when TMDB, AMC or OMDb answer with an error code. These
// pin behaviour that reads the upstream code: they pass the same before and
// after it moved off err.status (where the error handler would show its text).
//
//   TMDB 404    the credits backfill marks the film missing and never asks
//               again; a person page is a 404 "Person not found"; a movie
//               page is a 404 "Movie not found"; a film with no providers
//               page is null without a log line; "More from" a director TMDB
//               has no credits for (or none of whose films it has) answers,
//               with nothing in it; At home leaves the missing films out.
//   TMDB 429    the backfill waits retry_after and tries again, three times.
//   AMC 404     on one day: both date forms are tried, that day has no
//               showtimes, the other days keep theirs.
//   AMC 500     the first date form's error ends that day at once (one call
//               per day), and the showtimes already there stay.
//   AMC 403     the refresh log says the key was rejected.
//   OMDb 401    OMDb is paused after the first answer: no second call.
import { suite } from '../lib/check.mjs';
import { openWorld, sleep, until } from '../lib/world.mjs';
import * as C from '../lib/catalog.mjs';

const S = suite('upstream');
const { check, step } = S;

// Film and person ids TMDB has never heard of.
const GONE = 88800001;
const SLOW = 88800002;
const NOBODY = 88800021;
const NOFILM = 88800031;
const NOPROV = 88800041;
const ADA = 50001; // a director the owner rated

const w = S.world(await openWorld('upstream', {
  refresh: true,
  prepare: (d) => d.exec(`DELETE FROM cache WHERE key = 'tmdb:person:${ADA}:movie_credits' OR key LIKE 'stats:unknown-person:%'`),
}));
const status = async () => (await w.api('GET', '/api/status')).json;
const lastLog = () => JSON.parse(w.q1("SELECT value FROM settings WHERE key = 'lastRefreshLog'")?.value || '{}');
const calls = (re) => w.net().filter((e) => e.host === 'api.themoviedb.org' && re.test(e.path));
async function refresh() {
  const before = (await status())?.lastRefresh;
  const r = await w.api('POST', '/api/refresh');
  const done = await until(async () => { const s = await status(); return s && !s.refreshing && s.lastRefresh !== before && s; }, 60000, 150);
  return r.status === 200 && Boolean(done);
}

try {
  await step('TMDB 404 and 429: the credits backfill', async () => {
    // Two films the owner rated that have no details yet: the backfill's
    // work. It runs at start, so the server starts again to find them.
    for (const [id, title] of [[GONE, 'Gone Film'], [SLOW, 'Slow Film']]) {
      w.q('INSERT INTO ratings(user_id, tmdb_id, title, year, rating, source, rated_at, created_at) VALUES(1, ?, ?, 2020, 4, \'manual\', ?, ?)', id, title, C.T0, C.T0);
    }
    w.writeCtrl({ tmdbFail: { [`/3/movie/${GONE}`]: 404, [`/3/movie/${SLOW}`]: { status: 429, body: { status_code: 25, status_message: 'Too many requests.', retry_after: 1 } } } });
    await w.restart();
    const done = await until(async () => { const s = await status(); return s?.creditsBackfill && !s.creditsBackfill.running && s.creditsBackfill.finishedAt && s; }, 30000, 150);
    check('the backfill finished', Boolean(done), JSON.stringify((await status())?.creditsBackfill));
    const gone = w.q1('SELECT details_missing FROM movies WHERE tmdb_id = ?', GONE);
    check('a TMDB 404: the film is marked missing', gone?.details_missing === 'not_found', JSON.stringify(gone));
    check('a TMDB 404: asked once', calls(new RegExp(`^/3/movie/${GONE}$`)).length === 1, String(calls(new RegExp(`^/3/movie/${GONE}$`)).length));
    const slow = calls(new RegExp(`^/3/movie/${SLOW}$`));
    check('a TMDB 429: asked three times, a retry_after apart', slow.length === 3 && slow[1].at - slow[0].at >= 900 && slow[2].at - slow[1].at >= 900, JSON.stringify(slow.map((e) => e.at)));
    check('a TMDB 429: the backfill says it is still rate-limited', done?.creditsBackfill?.lastError === `${SLOW}: still rate-limited after retries`, done?.creditsBackfill?.lastError);
    check('a TMDB 429: the film is not marked missing', !w.q1('SELECT details_missing FROM movies WHERE tmdb_id = ?', SLOW)?.details_missing);
    w.writeCtrl({});
  });

  await step('TMDB 404: person, movie, providers and More from', async () => {
    const p = await w.api('GET', `/api/person/${NOBODY}`);
    check('a person TMDB doesn\'t know: 404 "Person not found"', p.status === 404 && p.json?.error === 'Person not found', `${p.status} ${p.text.slice(0, 160)}`);
    const m = await w.api('GET', `/api/movies/${NOFILM}`);
    check('a film TMDB doesn\'t know: 404 "Movie not found"', m.status === 404 && m.json?.error === 'Movie not found', `${m.status} ${m.text.slice(0, 160)}`);
    const pr = await w.api('GET', `/api/providers?ids=${NOPROV}`);
    check('providers for a film TMDB doesn\'t know: null', pr.status === 200 && pr.json?.providers?.[NOPROV] === null, `${pr.status} ${pr.text.slice(0, 160)}`);
    check('and no providers line in the log', !w.srv.log().includes(`[providers] ${NOPROV}`));
    w.writeCtrl({ tmdbFail: { [`/3/person/${ADA}/movie_credits`]: 404 } });
    await sleep(120);
    const name = encodeURIComponent(C.PEOPLE.ada.name);
    const more = await w.api('GET', `/api/stats/more?kind=director&name=${name}`);
    w.writeCtrl({});
    check('More from a director with no credits on TMDB: answers, with nothing in it', more.status === 200 && more.json?.unknownPerson === true && more.json.films.length === 0, `${more.status} ${more.text.slice(0, 200)}`);
    check('and TMDB was asked for those credits', calls(new RegExp(`^/3/person/${ADA}/movie_credits$`)).length >= 1);

    // A director whose films carry no person id: "More from" looks the
    // films up to find one, and TMDB has none of them.
    const marcus = C.PEOPLE.marcus.name;
    const films = w.q('SELECT m.tmdb_id FROM movies m JOIN ratings r ON r.tmdb_id = m.tmdb_id AND r.user_id = 1 WHERE m.director = ?', marcus).map((r) => r.tmdb_id);
    check('the owner rated films by a second director', films.length >= 1, String(films.length));
    w.q(`UPDATE movies SET director_id = NULL WHERE tmdb_id IN (${films.join(',')})`);
    w.q(`DELETE FROM cache WHERE key IN (${films.map((id) => `'tmdb:movie:${id}'`).join(',')})`);
    w.writeCtrl({ tmdbFail: Object.fromEntries(films.map((id) => [`/3/movie/${id}`, 404])) });
    await sleep(120);
    const lookup = await w.api('GET', `/api/stats/more?kind=director&name=${encodeURIComponent(marcus)}`);
    w.writeCtrl({});
    check('More from, when TMDB has none of the films: answers, with nothing in it', lookup.status === 200 && lookup.json?.unknownPerson === true, `${lookup.status} ${lookup.text.slice(0, 200)}`);
    const marked = w.q(`SELECT COUNT(*) n FROM movies WHERE details_missing = 'not_found' AND tmdb_id IN (${films.join(',')})`)[0].n;
    check('and the films it looked up are marked missing', marked >= 1 && marked === Math.min(3, films.length), `${marked} of ${films.length}`);
  });

  await step('TMDB 404: At home picks', async () => {
    // Every film on the owner's service is one TMDB no longer has.
    const mine = C.STREAMING.filter((f) => f.providers.includes(8)).map((f) => f.id);
    w.q('DELETE FROM home_picks');
    w.q(`DELETE FROM movies WHERE tmdb_id IN (${mine.join(',')})`);
    w.q(`DELETE FROM cache WHERE key IN (${mine.map((id) => `'tmdb:movie:${id}'`).join(',')})`);
    w.writeCtrl({ tmdbFail: Object.fromEntries(mine.map((id) => [`/3/movie/${id}`, 404])) });
    await sleep(120);
    const res = await until(async () => { const r = (await w.api('GET', '/api/home-picks')).json; return r && r.status !== 'computing' && r; }, 30000, 200);
    w.writeCtrl({});
    check('At home still answers "ready", not an error', res?.status === 'ready', JSON.stringify(res).slice(0, 200));
    check('with none of the missing films in it', Array.isArray(res?.picks) && !res.picks.some((p) => mine.includes(p.tmdb_id)), JSON.stringify(res?.picks?.map((p) => p.tmdb_id)));
    check('and TMDB was asked for them', mine.some((id) => calls(new RegExp(`^/3/movie/${id}$`)).length > 0));
  });

  // The showtimes the refresh asks for are forced fresh for the first days,
  // so every refresh below asks AMC again.
  const dayHits = (from) => {
    const by = new Map();
    for (const h of w.amc.hits.slice(from)) if (h.kind === 'showtimes') { const k = `${h.theatre} ${h.date}`; by.set(k, (by.get(k) || 0) + 1); }
    return by;
  };
  const rows = (date) => w.q1('SELECT COUNT(*) n FROM showtimes WHERE date = ?', date).n;

  await step('AMC 404 on one day', async () => {
    const day = '2026-09-25';
    check('there are showtimes that day to start with', rows(day) > 0, String(rows(day)));
    w.q("DELETE FROM cache WHERE key LIKE 'amc:showtimes%'");
    w.amc.missing.add(day);
    const from = w.amc.hits.length;
    check('the refresh ran', await refresh());
    w.amc.missing.clear();
    const hits = dayHits(from);
    const thatDay = [...hits].filter(([k]) => k.endsWith(day));
    check('both date forms were tried for that day', thatDay.length > 0 && thatDay.every(([, n]) => n === 2), JSON.stringify(thatDay));
    check('that day has no showtimes', rows(day) === 0, String(rows(day)));
    check('the next day keeps its showtimes', rows('2026-09-26') > 0, String(rows('2026-09-26')));
    check('the refresh log names the day', (lastLog().errors || []).some((e) => e.startsWith('AMC showtimes') && e.includes(day)), JSON.stringify(lastLog().errors).slice(0, 300));
  });

  await step('AMC 500', async () => {
    const before = w.q1('SELECT COUNT(*) n FROM showtimes').n;
    w.amc.mode = '500';
    const from = w.amc.hits.length;
    check('the refresh ran', await refresh());
    w.amc.mode = 'ok';
    const hits = [...dayHits(from)];
    check('one call per day: the first error ends that day', hits.length > 0 && hits.every(([, n]) => n === 1), JSON.stringify(hits.slice(0, 6)));
    check('the showtimes already there stay', w.q1('SELECT COUNT(*) n FROM showtimes').n === before, `${before} -> ${w.q1('SELECT COUNT(*) n FROM showtimes').n}`);
  });

  await step('AMC 403', async () => {
    w.q("DELETE FROM cache WHERE key = 'amc:theatres:all'");
    w.amc.mode = '403';
    check('the refresh ran', await refresh());
    w.amc.mode = 'ok';
    const errs = lastLog().errors || [];
    check('the refresh log says the AMC key was rejected', errs.some((e) => e.startsWith('AMC key rejected')), JSON.stringify(errs).slice(0, 300));
    check('and not the raw theater lookup error', !errs.some((e) => e.startsWith('AMC theater lookup')), JSON.stringify(errs).slice(0, 300));
  });

  await step('OMDb 401', async () => {
    // Films the sample has never stored, so nothing about them is cached.
    const fresh = C.ALL_FILMS.filter((f) => !w.q1('SELECT 1 x FROM movies WHERE tmdb_id = ?', f.id)).slice(0, 3);
    check('three films with nothing cached', fresh.length === 3, String(fresh.length));
    w.writeCtrl({ omdbMode: 'unauthorized' });
    await sleep(120);
    const omdb = () => w.net().filter((e) => e.host === 'www.omdbapi.com' || e.host === 'omdbapi.com');
    const from = omdb().length;
    for (const f of fresh) await w.api('POST', '/api/ratings', { body: { tmdb_id: f.id, rating: 3, title: f.title, year: f.year, awaitDetails: true } });
    await until(() => fresh.every((f) => w.q1('SELECT details_at FROM movies WHERE tmdb_id = ?', f.id)?.details_at), 15000, 150);
    await sleep(1500);
    w.writeCtrl({});
    const asked = omdb().slice(from);
    check('OMDb answered 401 once and was not asked again', asked.length === 1 && asked[0].how === 'unauthorized', JSON.stringify(asked.map((e) => e.how)));
  });
} finally {
  await w.close();
}

S.finish();
