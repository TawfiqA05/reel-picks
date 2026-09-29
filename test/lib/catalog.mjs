// The made-up world every test runs in: theaters, films, people, schedules and
// public scores. Nothing here is real: every title, name, theater and number
// was invented for the tests. The stand-ins for AMC, TMDB and OMDb (mocks.mjs,
// preload.mjs) answer from this file, so a run needs no key and no network.

// The tests' clock. Every server and browser in a run believes it is this
// Wednesday morning, so schedules, the weekly four and every score come out
// the same on every run.
export const TZ = 'America/New_York';
export const T0 = '2026-09-23T10:00:00-04:00';
export const T0_MS = Date.parse(T0);
// The world is built a little earlier than the suites run, so nothing it
// stored is dated after a suite's own start.
export const BUILD_AT = '2026-09-23T09:30:00-04:00';

export const OWNER_NAME = 'Sam';

export const THEATRES = [
  { id: '9101', name: 'AMC Maple Grove 12', slug: 'amc-maple-grove-12', city: 'Maple Grove', state: 'OH', lat: 41.2, lng: -81.5 },
  { id: '9102', name: 'AMC Riverside 8', slug: 'amc-riverside-8', city: 'Riverside', state: 'OH', lat: 41.3, lng: -81.4 },
  { id: '9103', name: 'AMC Lakeview 16', slug: 'amc-lakeview-16', city: 'Lakeview', state: 'OH', lat: 41.1, lng: -81.7 },
];
export const HOME = { label: 'Testville, OH', lat: 41.25, lng: -81.45 };

// People: directors 5000x, actors 6000x.
export const PEOPLE = {
  ada: { id: 50001, name: 'Ada Lindqvist', dept: 'Directing' },
  marcus: { id: 50002, name: 'Marcus Oyelaran', dept: 'Directing' },
  priya: { id: 50003, name: 'Priya Venkat', dept: 'Directing' },
  tomas: { id: 50004, name: 'Tomas Beaulieu', dept: 'Directing' },
  hana: { id: 50005, name: 'Hana Kobori', dept: 'Directing' },
  eli: { id: 50006, name: 'Eli Marchetti', dept: 'Directing' },
  june: { id: 60001, name: 'June Calloway', dept: 'Acting' },
  rafael: { id: 60002, name: 'Rafael Ostrow', dept: 'Acting' },
  mina: { id: 60003, name: 'Mina Sorensen', dept: 'Acting' },
  theo: { id: 60004, name: 'Theo Achterberg', dept: 'Acting' },
  lena: { id: 60005, name: 'Lena Fairweather', dept: 'Acting' },
  omar: { id: 60006, name: 'Omar Castellan', dept: 'Acting' },
  iris: { id: 60007, name: 'Iris Pemberton', dept: 'Acting' },
  felix: { id: 60008, name: 'Felix Nakamura', dept: 'Acting' },
};
const P = PEOPLE;

export const GENRE_IDS = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99, Drama: 18, Family: 10751,
  Fantasy: 14, History: 36, Horror: 27, Music: 10402, Mystery: 9648, Romance: 10749, 'Science Fiction': 878,
  Thriller: 53, War: 10752, Western: 37,
};
export const GENRE_NAMES = Object.fromEntries(Object.entries(GENRE_IDS).map(([n, id]) => [id, n]));

// Schedules. days: offsets from T0's date; times: local HH:MM; attrs: AMC
// attribute names on those showings.
const ALL = [...Array(14).keys()];
const range = (a, b) => ALL.filter((d) => d >= a && d <= b);

// Films playing at the made-up theaters (AMC movie ids 700k, TMDB 99000k).
export const PLAYING = [
  {
    k: 1, title: 'The Paper Lantern', year: 2026, release: '2026-09-11', genres: ['Drama', 'Thriller'], runtime: 128, mpaa: 'PG-13',
    dir: P.ada, cast: [P.june, P.rafael, P.mina], va: 7.9, vc: 1840, omdb: { imdb: 8.1, rt: 94, meta: 86 }, trailer: 'rpTrailer001',
    at: { 9101: [{ days: ALL, times: ['13:00', '19:30'], attrs: ['IMAX'] }, { days: ALL, times: ['21:15'], attrs: [] }], 9102: [{ days: ALL, times: ['18:45'], attrs: [] }] },
    overview: 'A lighthouse keeper finds letters that were never sent.',
  },
  {
    k: 2, title: 'Northern Signal', year: 2026, release: '2026-09-04', genres: ['Science Fiction', 'Drama'], runtime: 141, mpaa: 'PG-13',
    dir: P.marcus, cast: [P.theo, P.lena, P.june], va: 7.6, vc: 2210, omdb: { imdb: 7.8, rt: 88, meta: 79 }, trailer: 'rpTrailer002',
    at: { 9101: [{ days: ALL, times: ['12:30', '19:00'], attrs: ['Dolby Cinema at AMC'] }], 9102: [{ days: ALL, times: ['20:00'], attrs: [] }] },
    overview: 'A radio operator at the edge of the map hears a voice from next week.',
  },
  {
    k: 3, title: 'Velvet Harbor', year: 2026, release: '2026-08-28', genres: ['Adventure', 'Family'], runtime: 104, mpaa: 'PG',
    dir: P.hana, cast: [P.omar, P.iris], va: 7.1, vc: 980, omdb: { imdb: 7.0, rt: 81, meta: 70 }, trailer: null,
    at: { 9101: [{ days: ALL, times: ['11:00', '16:20'], attrs: ['RealD 3D'] }, { days: ALL, times: ['18:40'], attrs: [] }] },
    overview: 'Two cousins sail a borrowed boat home before the storm.',
  },
  {
    k: 4, title: 'Glass Orchard', year: 2026, release: '2026-09-18', genres: ['Drama', 'Romance'], runtime: 117, mpaa: 'R',
    dir: P.ada, cast: [P.mina, P.felix], va: 7.4, vc: 640, omdb: { imdb: 7.5, rt: 90, meta: 82 }, trailer: 'rpTrailer004',
    at: { 9101: [{ days: ALL, times: ['14:10', '20:10'], attrs: ['70MM'] }] },
    overview: 'An orchard grows back after the fire, and so does a family.',
  },
  {
    k: 5, title: 'Iron Chorus', year: 2026, release: '2026-09-11', genres: ['Music', 'Drama'], runtime: 112, mpaa: 'PG-13',
    dir: P.priya, cast: [P.lena, P.rafael], va: 7.3, vc: 720, omdb: { imdb: 7.4, rt: 86, meta: 74 }, trailer: null,
    at: { 9102: [{ days: ALL, times: ['17:30', '20:30'], attrs: [] }] },
    overview: 'A steelworks choir enters one last competition.',
  },
  {
    k: 6, title: 'Crimson Station', year: 2026, release: '2026-09-18', genres: ['Mystery', 'Thriller'], runtime: 99, mpaa: 'R',
    dir: P.tomas, cast: [P.theo, P.omar], va: 9.4, vc: 12, omdb: null, trailer: null,
    at: { 9101: [{ days: ALL, times: ['19:45'], attrs: [] }] },
    overview: 'A night train, a missing ticket inspector, and a map with one extra stop.',
  },
  {
    k: 7, title: 'Hollow Summer', year: 2026, release: '2026-08-14', genres: ['Drama', 'Comedy'], runtime: 108, mpaa: 'PG-13',
    dir: P.eli, cast: [P.iris, P.june], va: 7.7, vc: 1500, omdb: { imdb: 7.7, rt: 91, meta: 80 }, trailer: null,
    at: { 9101: [{ days: range(0, 2), times: ['15:00', '19:15'], attrs: [] }] },
    overview: 'The last week of a lakeside summer camp, told by the cook.',
  },
  {
    k: 8, title: 'Quiet Frontier', year: 2026, release: '2026-09-18', genres: ['Horror'], runtime: 95, mpaa: 'R',
    dir: P.marcus, cast: [P.felix], va: 6.1, vc: 430, omdb: { imdb: 5.9, rt: 48, meta: 44 }, trailer: null,
    at: { 9101: [{ days: ALL, times: ['21:45'], attrs: [] }], 9102: [{ days: ALL, times: ['22:00'], attrs: [] }] },
    overview: 'Settlers find the new town already has residents.',
  },
  {
    k: 9, title: 'Midnight Parade', year: 2026, release: '2026-09-25', genres: ['Comedy'], runtime: 101, mpaa: 'PG-13',
    dir: P.priya, cast: [P.rafael, P.lena], va: 7.0, vc: 210, omdb: { imdb: 7.1, rt: 79, meta: 68 }, trailer: 'rpTrailer009',
    at: { 9101: [{ days: range(2, 13), times: ['18:30', '21:00'], attrs: [] }] },
    overview: 'A marching band gets lost on the way to the big game.',
  },
  {
    k: 10, title: 'Distant Tide', year: 1999, release: '1999-10-15', genres: ['Drama', 'Romance'], runtime: 132, mpaa: 'PG-13',
    dir: P.hana, cast: [P.mina, P.theo], va: 7.8, vc: 3100, omdb: { imdb: 7.9, rt: 89, meta: 77 }, trailer: null, amcYear: 1999,
    at: { 9101: [{ days: [0, 3, 5], times: ['19:00'], attrs: [] }] },
    overview: 'A ferry captain and a lighthouse painter, one winter.',
  },
  {
    k: 11, title: 'Wild Letter', year: 2026, release: '2026-10-02', genres: ['Crime', 'Thriller'], runtime: 119, mpaa: 'R',
    dir: P.tomas, cast: [P.june, P.omar], va: 0, vc: 0, omdb: null, trailer: 'rpTrailer011',
    at: { 9101: [{ days: [6], times: ['19:00'], attrs: ['Fan First Premiere'] }] },
    overview: 'A postal inspector follows one envelope across three states.',
  },
  {
    k: 12, title: 'Scarlet Engine', year: 2026, release: '2026-09-04', genres: ['Animation', 'Family'], runtime: 92, mpaa: 'G',
    dir: P.eli, cast: [P.iris, P.felix], va: 7.2, vc: 860, omdb: { imdb: 7.0, rt: 84, meta: 71 }, trailer: null,
    at: { 9101: [{ days: ALL, times: ['10:30', '13:30'], attrs: [] }], 9102: [{ days: ALL, times: ['11:00'], attrs: [] }] },
    overview: 'A little red locomotive wants to see the sea.',
  },
];
// An AMC title TMDB has no film for (matched by hand, or ignored, in Settings).
export const UNMATCHED = { amcId: 7099, title: 'Mystery Screening Night', at: { 9101: [{ days: [4], times: ['20:00'], attrs: [] }] } };

for (const f of PLAYING) { f.id = 990000 + f.k; f.amcId = 7000 + f.k; }

// Coming soon (TMDB /movie/upcoming), not yet at the theaters.
export const UPCOMING = [
  { id: 970001, title: 'Summer of Lanterns', release: '2026-10-16', genres: ['Drama'], dir: P.ada, cast: [P.mina], va: 0, vc: 0 },
  { id: 970002, title: 'The Iron Kite', release: '2026-11-06', genres: ['Adventure', 'Family'], dir: P.hana, cast: [P.omar], va: 0, vc: 0 },
  { id: 970003, title: 'Night Ferry', release: '2026-10-30', genres: ['Thriller'], dir: P.tomas, cast: [P.theo], va: 0, vc: 0 },
];

// Older films the owner rated (and friends may rate). Taste: Ada Lindqvist
// and dramas high, horror low, comedy middling.
const W1 = ['Silent', 'Golden', 'Northern', 'Paper', 'Glass', 'Velvet', 'Hollow', 'Distant', 'Quiet', 'Electric'];
const W2 = ['River', 'Harbor', 'Garden', 'Letter', 'Station', 'Mirror', 'Island', 'Orchard'];
export const RATED = [];
{
  const plan = [
    [P.ada, ['Drama', 'Thriller'], 5], [P.ada, ['Drama'], 4.5], [P.ada, ['Drama', 'Romance'], 5], [P.ada, ['Thriller'], 4.5],
    [P.marcus, ['Science Fiction'], 4], [P.marcus, ['Horror'], 1.5], [P.marcus, ['Science Fiction', 'Drama'], 4.5],
    [P.priya, ['Comedy'], 3], [P.priya, ['Music', 'Drama'], 4], [P.priya, ['Comedy'], 2.5],
    [P.tomas, ['Crime', 'Thriller'], 4], [P.tomas, ['Mystery'], 3.5], [P.tomas, ['Crime'], 4],
    [P.hana, ['Adventure', 'Family'], 3.5], [P.hana, ['Drama', 'Romance'], 4.5], [P.hana, ['Family'], 3],
    [P.eli, ['Animation', 'Family'], 3.5], [P.eli, ['Comedy', 'Drama'], 4], [P.eli, ['Comedy'], 3],
    [P.marcus, ['Horror'], 1], [P.tomas, ['Horror', 'Thriller'], 2], [P.eli, ['Horror'], 1.5],
    [P.ada, ['Drama'], 4], [P.priya, ['Drama'], 3.5], [P.hana, ['History', 'Drama'], 4],
    [P.marcus, ['Action', 'Science Fiction'], 3.5], [P.tomas, ['Action', 'Crime'], 3], [P.eli, ['Family', 'Comedy'], 3.5],
    [P.ada, ['Mystery', 'Drama'], 4.5], [P.priya, ['Romance', 'Comedy'], 3],
  ];
  const actors = [P.june, P.rafael, P.mina, P.theo, P.lena, P.omar, P.iris, P.felix];
  plan.forEach(([dir, genres, stars], i) => {
    RATED.push({
      id: 980001 + i, title: `${W1[i % W1.length]} ${W2[Math.floor(i / W1.length) % W2.length]}`, year: 2000 + (i % 25),
      genres, dir, cast: [actors[i % 8], actors[(i + 3) % 8]], va: 6.2 + (i % 18) / 10, vc: 300 + i * 37, stars,
      ratedAt: new Date(Date.parse('2026-09-01T12:00:00Z') - i * 9 * 864e5).toISOString(),
    });
  });
}

// Well-known films (TMDB discover by vote count, and popular): the welcome
// setup's "rate ten films" grid.
const C1 = ['Ember', 'Harbor', 'Lantern', 'Meadow', 'Signal', 'Canyon', 'Comet', 'Parade', 'Tundra', 'Bridge', 'Circus', 'Fable'];
export const CLASSICS = Array.from({ length: 30 }, (_, i) => ({
  id: 950001 + i, title: `The ${C1[i % 12]}${i >= 12 ? ` ${['Returns', 'Rising'][Math.floor(i / 12) - 1]}` : ''}`, year: 1980 + i,
  genres: [['Drama', 'Adventure', 'Comedy', 'Science Fiction', 'Crime', 'Family'][i % 6]],
  dir: [P.ada, P.marcus, P.priya, P.tomas, P.hana, P.eli][i % 6], cast: [[P.june, P.rafael, P.mina, P.theo, P.lena, P.omar][i % 6]],
  va: 7 + (i % 15) / 10, vc: 20000 - i * 400,
}));

// On streaming services (TMDB discover with watch providers): the At home picks.
export const STREAMING = Array.from({ length: 10 }, (_, i) => ({
  id: 960001 + i, title: `${['Blue', 'Late', 'Bright', 'Small', 'Long'][i % 5]} ${['Hours', 'Roads', 'Rooms', 'Waves'][i % 4]}`, year: 2015 + i,
  genres: [['Drama', 'Comedy', 'Thriller', 'Romance', 'Documentary'][i % 5]], dir: [P.priya, P.eli, P.tomas, P.hana, P.ada][i % 5],
  cast: [[P.lena, P.iris, P.felix, P.mina, P.june][i % 5]], va: 7.2 + (i % 7) / 10, vc: 900 + i * 50,
  providers: i % 2 ? [8] : [1899],
}));

export const PROVIDERS = {
  8: { provider_id: 8, provider_name: 'Netflix', logo_path: '/rp-logo-8.jpg', display_priority: 1 },
  1899: { provider_id: 1899, provider_name: 'Max', logo_path: '/rp-logo-1899.jpg', display_priority: 2 },
  2: { provider_id: 2, provider_name: 'Apple TV', logo_path: '/rp-logo-2.jpg', display_priority: 3 },
  10: { provider_id: 10, provider_name: 'Amazon Video', logo_path: '/rp-logo-10.jpg', display_priority: 4 },
};

// ---------------------------------------------------------------- lookups
export const ALL_FILMS = [...PLAYING, ...UPCOMING, ...RATED, ...CLASSICS, ...STREAMING];
const byId = new Map(ALL_FILMS.map((f) => [f.id, f]));
export const film = (id) => byId.get(Number(id)) || null;
export const person = (id) => Object.values(PEOPLE).find((p) => p.id === Number(id)) || null;

const releaseOf = (f) => f.release || `${f.year}-06-01`;
const posterOf = (f) => `/rp-${f.id}.jpg`;
const genreIds = (f) => f.genres.map((g) => GENRE_IDS[g]).filter(Boolean);
const votes = (f) => f.vc ?? 500;
const popularity = (f) => Math.round((10 + (votes(f) % 97) + (f.id % 13)) * 10) / 10;

export function light(f) {
  return {
    id: f.id, title: f.title, original_title: f.title, release_date: releaseOf(f), genre_ids: genreIds(f),
    poster_path: posterOf(f), backdrop_path: `/rp-bd-${f.id}.jpg`, popularity: popularity(f), vote_count: votes(f),
    vote_average: f.va ?? 7, overview: f.overview || 'A made-up film for the Reel Picks tests.', adult: false, original_language: 'en', video: false,
  };
}

export function details(f) {
  const people = [f.dir, ...(f.cast || [])];
  return {
    ...light(f), imdb_id: `tt${f.id}`, runtime: f.runtime || 110, genres: f.genres.map((g) => ({ id: GENRE_IDS[g], name: g })),
    status: 'Released', tagline: '', belongs_to_collection: null,
    credits: {
      crew: f.dir ? [{ id: f.dir.id, name: f.dir.name, job: 'Director', department: 'Directing', known_for_department: 'Directing' }] : [],
      cast: (f.cast || []).map((c, i) => ({ id: c.id, name: c.name, character: `Role ${i + 1}`, order: i, known_for_department: 'Acting' })),
    },
    videos: { results: f.trailer ? [{ site: 'YouTube', type: 'Trailer', key: f.trailer, official: true, iso_639_1: 'en', published_at: '2026-06-01T00:00:00Z', name: 'Trailer' }] : [] },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: `${releaseOf(f)}T00:00:00.000Z`, certification: f.mpaa || 'PG-13' }] }] },
    _people: people.filter(Boolean).length,
  };
}

// A person's film credits: every catalog film they directed or acted in.
export function credits(p) {
  const crew = []; const cast = [];
  for (const f of ALL_FILMS) {
    if (f.dir?.id === p.id) crew.push({ ...light(f), job: 'Director', department: 'Directing', credit_id: `c${f.id}d` });
    const i = (f.cast || []).findIndex((c) => c.id === p.id);
    if (i >= 0) cast.push({ ...light(f), character: `Role ${i + 1}`, order: i, credit_id: `c${f.id}a` });
  }
  return { id: p.id, crew, cast };
}

export function providersFor(f) {
  const us = f.providers
    ? { link: `https://www.example.test/watch/${f.id}`, flatrate: f.providers.map((id) => PROVIDERS[id]) }
    : f.id % 3 === 0
      ? { link: `https://www.example.test/watch/${f.id}`, rent: [PROVIDERS[2], PROVIDERS[10]], buy: [PROVIDERS[2], PROVIDERS[10]] }
      : f.id % 3 === 1 ? { link: `https://www.example.test/watch/${f.id}`, flatrate: [PROVIDERS[8]], rent: [PROVIDERS[2]], buy: [PROVIDERS[10]] } : null;
  return { id: f.id, results: us ? { US: us } : {} };
}

export function omdbFor(f) {
  if (!f?.omdb) return null;
  return {
    Response: 'True', Title: f.title, Year: String(f.year), imdbID: `tt${f.id}`, imdbRating: f.omdb.imdb.toFixed(1), Metascore: String(f.omdb.meta),
    Rated: f.mpaa || 'PG-13', Ratings: [{ Source: 'Internet Movie Database', Value: `${f.omdb.imdb.toFixed(1)}/10` }, { Source: 'Rotten Tomatoes', Value: `${f.omdb.rt}%` }, { Source: 'Metacritic', Value: `${f.omdb.meta}/100` }],
  };
}

// ---------------------------------------------------------------- AMC schedule
const pad = (n) => String(n).padStart(2, '0');
export const ymdLocal = (d) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts;
};
export const dayOffset = (ymd) => Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${ymdLocal(new Date(T0_MS))}T12:00:00Z`)) / 864e5);

// A showtime id that stays inside Number.MAX_SAFE_INTEGER (AMC's ids are
// numbers): theater, year digit, day of the year, film, block and time.
export function showtimeId(theatreId, ymd, amcId, block, slot) {
  const day = Math.round((Date.parse(`${ymd}T12:00:00Z`) - Date.parse(`${ymd.slice(0, 4)}-01-01T12:00:00Z`)) / 864e5);
  return Number(`${theatreId}${ymd.slice(3, 4)}${String(day).padStart(3, '0')}${pad(amcId % 100)}${block}${slot}`);
}

// AMC showtimes for one theater on one local date (YYYY-MM-DD). shift: serve
// the schedule of that many days earlier, so a suite that jumps weeks ahead
// still has a lineup.
export function amcShowtimes(theatreId, ymd, { shift = 0 } = {}) {
  const off = dayOffset(ymd) - shift;
  const out = [];
  for (const f of [...PLAYING, UNMATCHED]) {
    const blocks = f.at?.[theatreId] || [];
    blocks.forEach((b, bi) => {
      if (!b.days.includes(off)) return;
      b.times.forEach((t, ti) => {
        out.push({
          id: showtimeId(theatreId, ymd, f.amcId, bi, ti), movieId: f.amcId, movieName: f.title,
          theatreId: Number(theatreId), showDateTimeLocal: `${ymd}T${t}:00`, runTime: f.runtime || 100,
          attributes: b.attrs.map((name) => ({ code: name.toUpperCase().replace(/\W+/g, ''), name })),
          purchaseUrl: `https://www.example.test/buy/${theatreId}/${f.amcId}/${ymd}/${t.replace(':', '')}`,
        });
      });
    });
  }
  return out;
}
export const amcMovie = (amcId) => {
  const f = [...PLAYING, UNMATCHED].find((x) => x.amcId === Number(amcId));
  if (!f) return null;
  const year = f.amcYear || f.year || 2026;
  return { id: f.amcId, name: f.title, releaseDateUtc: `${f.release || `${year}-09-01`}T00:00:00Z`, runTime: f.runtime || 100, mpaaRating: f.mpaa || 'NR' };
};
