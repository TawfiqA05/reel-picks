// Watch together: films two people could see together, the owner and one
// friend who has switched it on in Settings.
//
// Privacy comes before everything else here. A pair is always the owner and
// one friend, never two friends. A friend's only possible partner is the
// owner. Nothing a friend can request here names, counts or hints at any other
// friend, and every id that isn't a valid partner for the caller (another
// friend, a friend who has it switched off, a revoked one, a made-up number,
// yourself) gets the same 404 with the same body.
//
// Neither person's ratings, scores or watchlist leave the server. Each film
// carries one label that says why it's there, and nothing more. The ranking
// adds the two match scores, but the scores themselves are never sent.
//
// A film qualifies when it has a showtime in the next 14 days at a theatre
// both people follow, neither of them has rated it, logged it as seen, or
// hidden it with "Not for me", and it is
//   on both watchlists, or
//   on one watchlist with a match of 70+ for the other person, or
//   a match of 75+ for both.
// The match score is each person's own, exactly as their Picks page shows it
// (lib/recommend.js matchScores). Read only: nothing is written.
import { all, get, getSetting, getSettings } from '../db.js';
import { matchScores } from './recommend.js';
import { followedTheatres } from './theatres.js';
import { OWNER_ID, runAs } from './user.js';
import { ownerName } from './guest.js';
import { localYMD, addDays, timeLabel } from './util.js';

export const WINDOW_DAYS = 14;
export const WATCHLIST_MATCH = 70;
export const BOTH_MATCH = 75;
const SHOWTIMES_SHOWN = 3;
const EVENING_HOUR = 17;

export const NOT_FOUND = { status: 404, body: { error: 'Not found.' } };

export const LABELS = {
  both: 'On both watchlists',
  mine: 'On your watchlist · great match for them',
  theirs: 'On their watchlist · great match for you',
  strong: 'Strong match for both',
};

export const isOptedIn = (userId) => getSetting('watchTogether', { userId }) === true;

// Friends the owner can pair with right now: signed up, not revoked, and
// switched on. Switching off takes a friend out of this list on the next
// request.
function optedInFriends() {
  return all('SELECT id, name FROM users WHERE id != ? AND revoked_at IS NULL ORDER BY name COLLATE NOCASE, id', OWNER_ID)
    .filter((u) => isOptedIn(u.id));
}

// The caller's valid partner for `id`, or null. The owner may pair with an
// opted-in friend; a friend who opted in may pair with the owner, and nobody
// else. Every other case is the same null (and so the same 404).
export function partnerFor(me, id) {
  const pid = Number(id);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === me.userId) return null;
  if (me.isOwner) {
    if (pid === OWNER_ID) return null;
    const u = get('SELECT id, name FROM users WHERE id = ? AND id != ? AND revoked_at IS NULL', pid, OWNER_ID);
    return u && isOptedIn(u.id) ? { id: u.id, name: u.name } : null;
  }
  if (pid !== OWNER_ID || !isOptedIn(me.userId)) return null;
  return { id: OWNER_ID, name: ownerName() };
}

// What the Together page opens with. The owner gets the opted-in friends to
// choose from; a friend gets only whether they've switched it on and the
// owner's name. A friend's payload has no list, count or id of anyone else.
export function overview(me) {
  if (me.isOwner) {
    return { role: 'owner', partners: optedInFriends().map((u) => ({ id: u.id, name: u.name })) };
  }
  const optedIn = isOptedIn(me.userId);
  return { role: 'friend', optedIn, partner: optedIn ? { id: OWNER_ID, name: ownerName() } : null, ownerName: ownerName() };
}

const sharedTheatres = (a, b) => {
  const theirs = new Set(followedTheatres(getSettings({ userId: b })).map((t) => t.id));
  return followedTheatres(getSettings({ userId: a })).filter((t) => theirs.has(t.id));
};

function labelFor(me, them) {
  if (me.watchlisted && them.watchlisted) return 'both';
  if (me.watchlisted && them.final >= WATCHLIST_MATCH) return 'mine';
  if (them.watchlisted && me.final >= WATCHLIST_MATCH) return 'theirs';
  if (me.final >= BOTH_MATCH && them.final >= BOTH_MATCH) return 'strong';
  return null;
}

// Friday to Sunday at 5pm or later, the shows two people can usually make.
function isWeekendEvening(s) {
  const day = new Date(`${s.date}T00:00:00`).getDay();
  const hour = Number(String(s.start_local).match(/T(\d\d)/)?.[1] ?? 0);
  return (day === 5 || day === 6 || day === 0) && hour >= EVENING_HOUR;
}

// The next three showtimes at the shared theatres, weekend evenings first,
// each group in time order.
function pickShowtimes(rows, short) {
  const byTime = (a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0);
  const ordered = [...rows.filter(isWeekendEvening).sort(byTime), ...rows.filter((s) => !isWeekendEvening(s)).sort(byTime)];
  return ordered.slice(0, SHOWTIMES_SHOWN).map((s) => ({
    id: s.id,
    date: s.date,
    time: timeLabel(s.start_local),
    theatre: short.get(s.theatre_id) || '',
    format: s.format || null,
    is_imax: Boolean(s.is_imax),
    weekendEvening: isWeekendEvening(s),
    purchase_url: s.purchase_url || null,
  }));
}

// The pair's list, from `me`'s side (labels say "your" and "their").
export function filmsFor(me, partner) {
  const shared = sharedTheatres(me.userId, partner.id);
  const base = {
    partner: { id: partner.id, name: partner.name },
    sharedTheatres: shared.map((t) => ({ name: t.name, short: t.short })),
    films: [],
  };
  if (!shared.length) return { ...base, state: 'no-shared-theatre' };

  const now = Date.now();
  const last = localYMD(addDays(new Date(), WINDOW_DAYS - 1));
  const ids = shared.map((t) => t.id);
  const rows = all(
    `SELECT * FROM showtimes WHERE tmdb_id IS NOT NULL AND date <= ? AND start_epoch >= ?
       AND theatre_id IN (${ids.map(() => '?').join(',')}) ORDER BY start_epoch`,
    last, now, ...ids,
  );
  const byFilm = new Map();
  for (const s of rows) {
    if (!byFilm.has(s.tmdb_id)) byFilm.set(s.tmdb_id, []);
    byFilm.get(s.tmdb_id).push(s);
  }
  const filmIds = [...byFilm.keys()];
  const mine = runAs(me.userId, () => matchScores(filmIds));
  const theirs = runAs(partner.id, () => matchScores(filmIds));
  const short = new Map(shared.map((t) => [t.id, t.short]));

  const films = [];
  for (const id of filmIds) {
    const a = mine.get(id);
    const b = theirs.get(id);
    if (!a || !b || a.done || b.done) continue;
    const label = labelFor(a, b);
    if (!label) continue;
    const m = get('SELECT tmdb_id, title, year, poster FROM movies WHERE tmdb_id = ?', id);
    films.push({
      tmdb_id: id,
      title: m.title || `Movie ${id}`,
      year: m.year ?? null,
      poster: m.poster || null,
      label: LABELS[label],
      labelKind: label,
      showtimes: pickShowtimes(byFilm.get(id), short),
      _rank: a.final + b.final,
    });
  }
  films.sort((x, y) => y._rank - x._rank || x.title.localeCompare(y.title));
  for (const f of films) delete f._rank;
  return { ...base, films, state: films.length ? 'ok' : 'nothing' };
}
