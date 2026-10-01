// The demo's made-up world: who uses it, where they see films, and a week of
// showtimes that always starts today. The films are real (server/demo/
// snapshot.json); everything about the people, the theaters and the
// schedule is invented here, and nothing comes from a real account.
//
// Everything is worked out from a fixed seed, so every start builds the same
// sample apart from the dates.

// ---- people ------------------------------------------------------------------

// User 1, the owner of the copy each visitor gets. Friends pair only with
// them, as on the real app.
export const SAM = { id: 1, name: 'Sam' };
export const FRIENDS = [
  { id: 2, name: 'Maya', together: true, services: ['netflix', 'hulu'], likes: { Romance: 0.7, Comedy: 0.5, Drama: 0.3, Animation: 0.3, Horror: -0.6, War: -0.4 }, count: 90 },
  { id: 3, name: 'Theo', together: true, services: ['max'], likes: { Action: 0.6, Thriller: 0.5, 'Science Fiction': 0.4, Crime: 0.3, Romance: -0.5, Animation: -0.3 }, count: 45 },
  { id: 4, name: 'Priya', together: false, services: [], likes: { Documentary: 0.6, Drama: 0.4, Mystery: 0.3, Action: -0.3 }, count: 22 },
];
export const SAM_LIKES = {
  'Science Fiction': 0.7, Animation: 0.5, Thriller: 0.35, Mystery: 0.3, Drama: 0.15, Adventure: 0.15,
  Horror: -0.9, Romance: -0.35, Family: -0.2, Music: -0.2,
};
export const SAM_SERVICES = ['netflix', 'max'];

// A made-up town; the coordinates are only used for the drive-time estimate.
export const HOME = { label: 'Maple Hollow', lat: 41.586, lng: -93.625 };

export const THEATRES = [
  { id: '9301', name: 'Riverside 12', slug: 'riverside-12', city: 'Maple Hollow', state: 'IA', address: '1200 River Road', lat: 41.623, lng: -93.676 },
  { id: '9302', name: 'Northgate 8', slug: 'northgate-8', city: 'Maple Hollow', state: 'IA', address: '45 Northgate Plaza', lat: 41.684, lng: -93.571 },
];
export const [RIVERSIDE, NORTHGATE] = THEATRES;

// What Sam wrote on a few films (a rating's note). Matched by genre so each
// reads like it belongs to the film it lands on.
export const NOTES = {
  'Science Fiction': 'Still thinking about the last twenty minutes.',
  Animation: 'Gorgeous. Watched it twice in a week.',
  Thriller: 'Tense the whole way through, and the ending earns it.',
  Drama: 'Slow first act, then it really lands.',
  Comedy: 'Funnier than I remembered.',
};

// The picks friends send, and the one Sam sent.
export const SEND_TO_SAM = 'The score alone is worth the ticket.';
export const SEND_FROM_SAM = 'Saw this last week, you would like it.';

// ---- numbers -----------------------------------------------------------------

// A small seeded generator (mulberry32), so the sample is the same every start.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, seed) {
  const r = rng(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Stars for a film from its public rating, a person's genre leanings and a
// little noise, in half stars.
export function starsFor(film, likes, r) {
  const va = Number(film.vote_average) || 7;
  const lean = (film.genres || []).reduce((s, g) => s + (likes[g] || 0), 0);
  const raw = 3.1 + (va - 7.4) * 1.15 + lean + (r() - 0.5) * 1.3;
  return Math.min(5, Math.max(0.5, Math.round(raw * 2) / 2));
}

// ---- dates -------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00`) - Date.parse(`${b}T12:00:00`)) / 864e5);

// ---- the made-up AMC ---------------------------------------------------------

// The lineup: each film playing, with a made-up AMC id. `films` is the
// snapshot's playing list in order (most popular first), each with its
// title, runtime and release date.
export function lineup(films) {
  return films.map((f, i) => ({
    ...f,
    amcId: 81001 + i,
    // Riverside shows all but the last; Northgate a handful, and the last
    // film only (it lands in "Also nearby").
    at: i === films.length - 1 ? [NORTHGATE.id] : i % 2 === 0 && i < 10 ? [RIVERSIDE.id, NORTHGATE.id] : [RIVERSIDE.id],
    // Two films leave Riverside early, inside the published week, so Last
    // chance has something real to say.
    lastDay: i === 5 ? 2 : i === 8 ? 4 : null,
    format: i === 0 ? 'IMAX' : i === 1 ? 'Dolby Cinema' : null,
  }));
}

// AMC posts about a week: every film for the next seven days, then a thin
// tail of advance showings for the two biggest.
const PUBLISHED_DAYS = 7;
const TAIL_DAYS = 3;
const SLOTS = ['11:20', '13:50', '16:30', '19:10', '21:45'];

// Weekends run all five slots; weekdays the afternoon and evening plus one of
// the early two, varying by film and day.
function timesFor(i, off, weekend) {
  const shift = (i * 7) % 25; // minutes, so the films don't all start together
  const keep = weekend ? SLOTS : SLOTS.filter((_, s) => s >= 2 || s === (i + off) % 2);
  return keep.map((t) => {
    const [h, m] = t.split(':').map(Number);
    const total = h * 60 + m + shift;
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  });
}

export function amcShowtimes(films, theatreId, date, today) {
  const off = dayDiff(date, today);
  if (off < 0 || off >= PUBLISHED_DAYS + TAIL_DAYS) return [];
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const weekend = weekday === 0 || weekday === 5 || weekday === 6;
  const out = [];
  lineup(films).forEach((f, i) => {
    if (!f.at.includes(theatreId)) return;
    if (off >= PUBLISHED_DAYS && i > 1) return;
    if (f.lastDay != null && theatreId === RIVERSIDE.id && off > f.lastDay) return;
    timesFor(i, off, weekend).forEach((t, ti) => {
      const premium = f.format && ti === 1 ? [{ code: f.format.toUpperCase().replace(/\W+/g, ''), name: f.format }] : [];
      out.push({
        id: Number(`${theatreId.slice(-2)}${String(f.amcId).slice(-3)}${date.replace(/-/g, '').slice(2)}${ti}`),
        movieId: f.amcId,
        movieName: f.title,
        theatreId: Number(theatreId),
        showDateTimeLocal: `${date}T${t}:00`,
        runTime: f.runtime || 110,
        attributes: [...premium, { code: 'RESERVEDSEATING', name: 'Reserved Seating' }],
        purchaseUrl: `https://www.amctheatres.com/movies/${f.amcId}`,
      });
    });
  });
  return out;
}

export function amcMovie(films, amcId) {
  const f = lineup(films).find((x) => x.amcId === Number(amcId));
  if (!f) return null;
  return {
    id: f.amcId, name: f.title, releaseDateUtc: f.release_date ? `${f.release_date}T00:00:00Z` : null,
    runTime: f.runtime || 110, mpaaRating: f.mpaa || 'NR',
  };
}

export const amcTheatre = (t) => ({
  id: Number(t.id), name: t.name, longName: t.name, slug: t.slug,
  location: { addressLine1: t.address, cityName: t.city, stateName: t.state, latitude: t.lat, longitude: t.lng },
});
