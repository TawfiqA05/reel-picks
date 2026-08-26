// Leaving: a week of departure deadlines at the primary theatre.
//
// Read-only, and built entirely from data /api/recommendations already returns
// (each entry's `runway` and `handoff`) — no new endpoint, no new state.
//
// The one rule that governs this whole view: a COMMITTED end date and the
// PUBLISHING HORIZON are different things. runway.kind === 'ending' means the
// run genuinely stops before the schedule does — a real deadline, and only
// those get a day on the calendar. Everything else ('open' / 'thin') is just
// where AMC has stopped posting; it is listed separately, below, and never
// occupies a day. Labels are rendered verbatim from runway.label so the
// "through at least" hedging is never re-worded or shortened here.
import { api } from '../api.js';
import { h, clear, spinner, emptyState, sectionTitle, poster, scorePill } from '../ui.js';

const DAYS_AHEAD = 7;

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Working out what\'s leaving…'));
  const data = await api.recommendations();
  clear(root);

  const page = h('div', { class: 'page' });
  const theatre = data.theatre || {};
  const horizon = theatre.horizon?.publishedThrough || null;

  if (!data.list.length) {
    page.appendChild(emptyState('🗓️', 'Nothing playing yet', 'Departure deadlines appear once showtimes load.'));
    root.appendChild(page);
    return;
  }

  const withRunway = data.list.filter((e) => e.runway);
  const committed = withRunway.filter((e) => e.runway.kind === 'ending');
  const hedged = withRunway.filter((e) => e.runway.kind === 'open' || e.runway.kind === 'thin');

  page.appendChild(sectionTitle('Leaving', theatre.name || ''));
  page.appendChild(h('p', { class: 'muted small lv-intro' },
    'Films whose run at your primary theatre is confirmed to end. Only a run that stops before the published schedule does counts as a deadline — everything still running at the edge of what AMC has posted is listed underneath, not on a day.'));

  // ---- the week ---------------------------------------------------------
  // Falls back to the local clock: with no schedule at all there are no
  // published days to read "today" from, and without it every heading would
  // print its own date twice instead of "Today" / "Tomorrow".
  const today = data.days?.[0]?.date || ymd(new Date());
  const week = weekDates(today, DAYS_AHEAD);
  const byDay = new Map(week.map((d) => [d, []]));
  const later = [];
  for (const e of committed) {
    const d = e.runway.lastDate;
    if (byDay.has(d)) byDay.get(d).push(e);
    else later.push(e);
  }
  for (const list of byDay.values()) list.sort((a, b) => b.final - a.final);

  const total = committed.length;
  page.appendChild(h('div', { class: 'lv-week' },
    ...week.map((d) => dayColumn(d, byDay.get(d), today, ctx)),
  ));

  if (!total) {
    // Two different nothings: a theatre schedule that shows no confirmed
    // endings, versus no schedule at all (no AMC showtimes, so no runway on
    // anything). Claiming films "run to the edge of the published schedule"
    // when nothing is published would be its own small lie.
    const noSchedule = !withRunway.length || !horizon;
    page.appendChild(h('div', { class: 'alert tip lv-none' },
      h('span', { class: 'alert-icon' }, noSchedule ? '🗓️' : '🎬'),
      h('span', {}, noSchedule
        ? 'No showtimes are loaded for this theatre, so there are no departure dates to work from yet.'
        : 'Nothing has a confirmed last day this week. Every film is still running to the edge of the published schedule.'),
    ));
  }

  // Committed departures beyond the seven days shown.
  if (later.length) {
    page.appendChild(sectionTitle('Later', `${later.length} more with a confirmed end date`));
    const grid = h('div', { class: 'lv-later' });
    later.sort((a, b) => a.runway.lastDate.localeCompare(b.runway.lastDate))
      .forEach((e) => grid.appendChild(filmRow(e, ctx, { showDate: true })));
    page.appendChild(grid);
  }

  // ---- the horizon ------------------------------------------------------
  // Deliberately not a day on the calendar: these are not departures.
  if (hedged.length) {
    page.appendChild(sectionTitle('Not a deadline — schedule just stops here',
      horizon ? `${hedged.length} still running at the published edge` : `${hedged.length} with no end date yet`));
    page.appendChild(h('p', { class: 'muted small lv-intro' },
      horizon
        ? `AMC has published through ${friendly(horizon, today)} at ${theatre.short || 'this theatre'}. These films have no showtimes past that point, which means the schedule stops — not that they leave. They may well still be playing after.`
        : 'These films have no confirmed end date.'));
    const grid = h('div', { class: 'lv-hedged' });
    hedged.sort((a, b) => a.runway.lastDate.localeCompare(b.runway.lastDate) || b.final - a.final)
      .forEach((e) => grid.appendChild(hedgedRow(e, ctx)));
    page.appendChild(grid);
  }

  root.appendChild(page);
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Seven dates starting today, as YYYY-MM-DD.
function weekDates(today, n) {
  const start = new Date(`${today}T00:00:00`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push(ymd(d));
  }
  return out;
}

function daysApart(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

// "Today" / "Tomorrow" / "Sat" / "Sep 4" — headings only. Never used to
// describe a run; runway.label owns that wording.
function friendly(ymd, today) {
  const d = daysApart(today, ymd);
  const date = new Date(`${ymd}T00:00:00`);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d != null && d > 1 && d <= 6) return date.toLocaleDateString('en-US', { weekday: 'short' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Soonest = loudest. Reuses the urgency tiers the Last chance cards already use.
function tierFor(daysOut) {
  if (daysOut <= 0) return 'urgent';
  if (daysOut <= 1) return 'soon';
  if (daysOut <= 3) return 'near';
  return '';
}

function dayColumn(date, films, today, ctx) {
  const d = daysApart(today, date) ?? 0;
  const tier = films.length ? tierFor(d) : '';
  const dateObj = new Date(`${date}T00:00:00`);
  return h('div', { class: `lv-day ${tier}${films.length ? '' : ' empty'}` },
    h('div', { class: 'lv-day-head' },
      h('span', { class: 'lv-day-name' }, friendly(date, today)),
      h('span', { class: 'lv-day-num' }, dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
      films.length
        ? h('span', { class: 'lv-day-count' }, `${films.length} leaving`)
        : h('span', { class: 'lv-day-count muted' }, '—'),
    ),
    h('div', { class: 'lv-day-body' }, ...films.map((e) => filmRow(e, ctx, { date }))),
  );
}

// One departing film. `date` renders that day's remaining showtimes, which is
// the actionable part of a deadline.
function filmRow(e, ctx, { date = null, showDate = false } = {}) {
  const tier = tierFor(e.runway.daysLeft ?? 0);
  const slots = date ? (e.showtimesByDay || []).find((x) => x.date === date)?.showtimes || [] : [];
  const live = slots.filter((s) => !s.past).slice(0, 4);
  const hiddenCount = slots.filter((s) => !s.past).length - live.length;

  return h('a', { class: 'lv-film', href: `#/movie/${e.tmdb_id}` },
    h('div', { class: 'lv-poster' },
      poster(e, { size: 'grid', link: false }),
      h('span', { class: 'lv-score' }, scorePill(e.final)),
      e.flags?.watchlisted ? h('span', { class: 'lv-star', title: ctx?.isGuest?.() ? 'On the watchlist' : 'On your watchlist' }, '★') : null,
    ),
    h('div', { class: 'lv-film-body' },
      h('div', { class: 'lv-film-title' }, e.title),
      // runway.label verbatim — the committed / hedged wording is decided
      // server-side and must not be re-phrased here.
      h('div', { class: `lv-when ${tier}` }, e.runway.label),
      showDate && e.runway.lastDate
        ? h('div', { class: 'lv-sub' }, e.runway.lastDate)
        : null,
      e.runway.detail ? h('div', { class: 'lv-sub' }, e.runway.detail) : null,
      // "still at Indianapolis through Sep 4" — a film leaving here but not gone.
      e.handoff ? h('div', { class: 'lv-handoff' }, '↪ ', e.handoff.text) : null,
      live.length
        ? h('div', { class: 'lv-slots' },
          ...live.map((s) => h('span', { class: 'lv-slot' }, s.time)),
          hiddenCount > 0 ? h('span', { class: 'lv-slot more' }, `+${hiddenCount}`) : null,
        )
        : null,
    ),
  );
}

// Horizon-edge film: same shape, deliberately quieter, and the label is the
// untouched "Through at least …".
function hedgedRow(e, ctx) {
  return h('a', { class: 'lv-film hedged', href: `#/movie/${e.tmdb_id}` },
    h('div', { class: 'lv-poster' },
      poster(e, { size: 'grid', link: false }),
      h('span', { class: 'lv-score' }, scorePill(e.final)),
      e.flags?.watchlisted ? h('span', { class: 'lv-star', title: ctx?.isGuest?.() ? 'On the watchlist' : 'On your watchlist' }, '★') : null,
    ),
    h('div', { class: 'lv-film-body' },
      h('div', { class: 'lv-film-title' }, e.title),
      h('div', { class: 'lv-when hedge' }, e.runway.label),
      e.runway.detail ? h('div', { class: 'lv-sub' }, e.runway.detail) : null,
    ),
  );
}
