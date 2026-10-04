// What the read-only guest link (lib/guest.js) gets of a scored film: the
// film, its public scores, its showtimes and how long it has left, and
// nothing of the owner's. lib/recommend.js scores the guest's films on public
// scores alone; these shapes then keep only the fields named here, so a field
// added to the owner's answer stays out of the guest's until it is added
// here on purpose. Theaters keep their names but not their AMC ids, as in the
// guest /api/status answer.
const FILM = [
  'tmdb_id', 'title', 'year', 'poster', 'backdrop', 'genres', 'director', 'runtime', 'mpaa', 'tmdb_rating',
  'release_date', 'us_release_date', 'glow', 'reason', 'public', 'showtimeCount', 'prerelease', 'runway',
];
// What Last chance and the leaving-soon list add (lib/leaving.js). `urgency`
// is the card's colour tier, worked out from the last date.
const LEAVING = ['lastDate', 'showtimesLeft', 'signal', 'daysLeft', 'lastLabel', 'leftLabel', 'urgency'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

export function guestTheatre(t) {
  return t ? { ...t, id: '' } : t;
}

// A showtime without the "fits your times" mark, which comes from the
// owner's preferred hours.
export function guestShowtime(s) {
  if (!s) return s;
  const { fits_window: _fits, ...rest } = s;
  return rest;
}

export function guestDays(days) {
  return (days || []).map((d) => ({ date: d.date, showtimes: d.showtimes.map(guestShowtime) }));
}

// One film from evaluate() (lib/recommend.js), scored with the public context:
// its match is the public score, and none without one.
export function guestEntry(e) {
  return {
    ...pick(e, [...FILM, ...LEAVING]),
    final: e.flags?.noScores ? null : e.final,
    why: e.why ? pick(e.why, ['review', 'noScores', 'divergence', 'goneAfter']) : null,
    flags: pick(e.flags || {}, ['imax', 'settling', 'noScores']),
    bestShowtime: guestShowtime(e.bestShowtime),
    nextShowtime: guestShowtime(e.nextShowtime),
    showtimesByDay: guestDays(e.showtimesByDay),
    theatre: guestTheatre(e.theatre),
    theatres: (e.theatres || []).map((t) => ({ ...guestTheatre(t), showtimesByDay: t.showtimesByDay && guestDays(t.showtimesByDay) })),
    handoff: e.handoff ? { ...e.handoff, theatre: guestTheatre(e.handoff.theatre) } : null,
  };
}
