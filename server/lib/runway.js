// Runway: how much longer a movie is on at ONE theatre, stated only as
// confidently as that theatre's published schedule allows.
//
// The trap is the publishing horizon. AMC posts roughly a week ahead, so on
// most days most of the lineup has no showtimes past next Thursday — not
// because those movies end Thursday, but because Friday isn't posted yet.
// leaving.js computes where each theatre's schedule genuinely stops (the
// density horizon); this module turns "last showtime" + "horizon" into a label
// that commits ("Through Thu · 3 days left") only when the movie's last date
// falls clearly short of the horizon, and otherwise says "through at least".
import { daysApart } from './leaving.js';

const asDate = (ymd) => new Date(`${ymd}T00:00:00`);

// "today" / "tomorrow" / "Thu" (inside the coming week) / "Sep 4" (beyond).
export function dateWord(ymd, today) {
  const d = daysApart(today, ymd);
  if (d == null) return '';
  if (d <= 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d <= 6) return asDate(ymd).toLocaleDateString('en-US', { weekday: 'short' });
  // Non-breaking space so "Sep 2" never splits across a wrapped line on a phone.
  return asDate(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', ' ');
}

// "through Thu" — with "at least" when the date is only a publishing edge.
function throughPhrase(ymd, today, committed) {
  return `${committed ? 'through' : 'through at least'} ${dateWord(ymd, today)}`;
}

// Prose for the reason line when urgency lifted a score: "it's gone after
// Thursday", "tomorrow's its last day". Only ever about a committed end.
export function goneAfterPhrase(runway, today) {
  if (!runway || runway.kind !== 'ending') return null;
  const d = runway.daysLeft;
  if (d <= 0) return 'today\'s its last day';
  if (d === 1) return 'tomorrow\'s its last day';
  // Urgency only fires inside ranking.js URGENCY_WINDOW_DAYS (7), so the call
  // site always lands in the weekday branch; the date form is a fallback.
  const when = d <= 6
    ? asDate(runway.lastDate).toLocaleDateString('en-US', { weekday: 'long' })
    : dateWord(runway.lastDate, today);
  return `it's gone after ${when}`;
}

// lastDate / imaxLastDate / regularLastDate: YYYY-MM-DD (or null) of the final
// showtime at this theatre overall / in IMAX / not in IMAX.
// firstDate: the earliest upcoming showtime, to spot advance-only bookings.
// horizon: this theatre's density horizon. minGap: days short of the horizon a
// last date must be before we'll say the run is ending (Settings: last chance).
// hedgeAll: the theatre's schedule looks mid-update (most of its lineup "ends"
// on the same day — see leaving.js MASS_EXODUS), so nothing may commit.
export function computeRunway({
  lastDate, firstDate = null, imaxLastDate = null, regularLastDate = null,
  horizon, today, minGap = 3, urgentWithin = 4, hedgeAll = false,
}) {
  if (!lastDate || !horizon) return null;
  const daysLeft = daysApart(today, lastDate) ?? 0;
  const gapDays = daysApart(lastDate, horizon) ?? 0;
  const startsIn = firstDate ? (daysApart(today, firstDate) ?? 0) : 0;

  // Only an advance booking (nothing this week) — it isn't "running" yet.
  if (startsIn > 6) {
    return {
      kind: 'upcoming', lastDate, firstDate, daysLeft, gapDays, urgent: false,
      label: `Starts ${dateWord(firstDate, today)}`, detail: null, formats: null,
    };
  }

  let kind;
  if (gapDays >= minGap && !hedgeAll) kind = 'ending'; // clearly stops before the schedule does
  else if (gapDays <= 0) kind = 'open';                // runs to (or past) the published edge
  else kind = 'thin';                                  // stops short, but not confidently: hedge

  const committed = kind === 'ending';
  let label;
  let detail = null;
  if (hedgeAll && gapDays >= minGap) {
    label = `Through at least ${dateWord(lastDate, today)}`;
    detail = 'Most of this theatre\'s lineup ends the same day — reading that as a schedule mid-update, not departures';
  } else if (committed) {
    if (daysLeft <= 0) label = 'Last day today';
    else if (daysLeft === 1) label = 'Last day tomorrow';
    else label = `Through ${dateWord(lastDate, today)}`;
    if (daysLeft >= 2 && daysLeft <= urgentWithin) detail = `${daysLeft} days left`;
  } else if (daysLeft <= 0) {
    label = 'On today';
    detail = 'No later dates posted yet';
  } else {
    label = `Through at least ${dateWord(lastDate, today)}`;
    detail = kind === 'open'
      ? `No end date yet — schedule posted through ${dateWord(horizon, today)}`
      : `Schedule posted through ${dateWord(horizon, today)}; nothing listed after ${dateWord(lastDate, today)} yet`;
  }

  // Format split: only when the IMAX run ends clearly before the published
  // schedule does (same minGap test as the overall run) while regular showings
  // continue. An IMAX date sitting at the horizon edge is just next week's IMAX
  // allocation not being posted yet — saying "IMAX through Wed" there would be
  // the exact lie the horizon exists to prevent.
  let formats = null;
  if (imaxLastDate && regularLastDate && imaxLastDate < regularLastDate && !hedgeAll) {
    const imaxGap = daysApart(imaxLastDate, horizon) ?? 0;
    if (imaxGap >= minGap) {
      const regularGap = daysApart(regularLastDate, horizon) ?? 0;
      formats = {
        imax: { lastDate: imaxLastDate, phrase: throughPhrase(imaxLastDate, today, true) },
        regular: { lastDate: regularLastDate, phrase: throughPhrase(regularLastDate, today, regularGap >= minGap) },
      };
      formats.text = `IMAX ${formats.imax.phrase} · regular ${formats.regular.phrase}`;
    }
  }

  return {
    kind, lastDate, firstDate, daysLeft, gapDays,
    urgent: committed && daysLeft <= urgentWithin,
    label, detail, formats,
  };
}

// Last / first dates split by format from a theatre's showtime rows.
export function runwayDates(rows) {
  let lastDate = null;
  let firstDate = null;
  let imaxLastDate = null;
  let regularLastDate = null;
  for (const s of rows) {
    if (!s.date) continue;
    if (!lastDate || s.date > lastDate) lastDate = s.date;
    if (!firstDate || s.date < firstDate) firstDate = s.date;
    if (s.is_imax) { if (!imaxLastDate || s.date > imaxLastDate) imaxLastDate = s.date; }
    else if (!regularLastDate || s.date > regularLastDate) regularLastDate = s.date;
  }
  return { lastDate, firstDate, imaxLastDate, regularLastDate };
}

// "Last week at Castleton — still at Indianapolis through Sep 4."
// Only when the primary run is genuinely ending and another followed theatre
// has it strictly later. `others` are { short, runway } for non-primary theatres.
export function handoffLine({ primaryShort, primaryRunway, others, today }) {
  if (!primaryRunway || primaryRunway.kind !== 'ending') return null;
  const later = others
    .filter((o) => o.runway && o.runway.kind !== 'upcoming' && o.runway.lastDate > primaryRunway.lastDate)
    .sort((a, b) => b.runway.lastDate.localeCompare(a.runway.lastDate)
      || (a.distance?.minutes ?? 1e9) - (b.distance?.minutes ?? 1e9));
  if (!later.length) return null;
  const o = later[0];
  const d = primaryRunway.daysLeft;
  const head = d <= 0 ? `Last day at ${primaryShort}`
    : d === 1 ? `Last day tomorrow at ${primaryShort}`
    : d <= 7 ? `Last week at ${primaryShort}`
    : `Through ${dateWord(primaryRunway.lastDate, today)} at ${primaryShort}`;
  const tail = `still at ${o.short} ${throughPhrase(o.runway.lastDate, today, o.runway.kind === 'ending')}`;
  return {
    text: `${head} — ${tail}.`,
    theatre: { id: o.id, short: o.short, name: o.name },
    lastDate: o.runway.lastDate,
    committed: o.runway.kind === 'ending',
  };
}
