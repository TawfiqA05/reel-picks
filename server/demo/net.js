// Demo mode's network: none. installDemoNet() replaces fetch for the whole
// process before anything runs. TMDB and OMDb are answered from the film
// snapshot, AMC from the made-up theaters (world.js); anything else (drive
// times, place lookups, posters, push, Letterboxd) fails as if offline, which
// every caller already handles. No request leaves the process.
import { answer, serviceOf, snapshot } from './snapshot.js';
import * as W from './world.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// What the made-up AMC says, by path (lib/amc.js asks for these four).
export function amcAnswer(url, today = W.ymd(new Date())) {
  const u = new URL(url);
  const films = snapshot().films.playing;
  let m;
  if (/^\/v2\/theatres\/?$/.test(u.pathname)) return json(200, { _embedded: { theatres: W.THEATRES.map(W.amcTheatre) } });
  if ((m = u.pathname.match(/^\/v2\/theatres\/(\d+)$/))) {
    const t = W.THEATRES.find((x) => x.id === m[1]);
    return t ? json(200, W.amcTheatre(t)) : json(404, { errors: [{ message: 'Not found' }] });
  }
  if ((m = u.pathname.match(/^\/v2\/movies\/(\d+)$/))) {
    const f = W.amcMovie(films, m[1]);
    return f ? json(200, f) : json(404, { errors: [{ message: 'Not found' }] });
  }
  if ((m = u.pathname.match(/^\/v2\/theatres\/(\d+)\/showtimes\/(.+)$/))) {
    // AMC's two date spellings: M-d-yyyy, then yyyy-MM-dd.
    const d = m[2].match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    const date = d ? `${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}` : m[2];
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) return json(404, { errors: [{ message: 'Bad date' }] });
    return json(200, { _embedded: { showtimes: W.amcShowtimes(films, m[1], date, today) } });
  }
  return json(404, { errors: [{ message: 'Not found' }] });
}

const offline = (url) => Object.assign(new TypeError('fetch failed'), {
  cause: new Error(`Demo mode makes no network requests (${new URL(url).hostname})`),
});

export async function demoFetch(input) {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  let u;
  try { u = new URL(url); } catch { throw offline('http://invalid'); }
  if (u.hostname === 'api.amctheatres.com') return amcAnswer(url);
  if (serviceOf(u)) {
    const a = answer(url);
    return json(a.status, a.body);
  }
  throw offline(url);
}

export function installDemoNet() {
  globalThis.fetch = demoFetch;
}
