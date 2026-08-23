// Reusable movie cards shared across Home / Coming Soon / Watchlist.
import { api } from '../api.js';
import { h, clear, poster, scorePill, badge, makeStars, toast } from '../ui.js';

export function fmtRuntime(min) {
  if (!min) return null;
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return hh ? `${hh}h ${mm}m` : `${mm}m`;
}

export function dayLabel(date) {
  if (!date) return '';
  const t = new Date(`${date}T00:00:00`);
  const now = new Date();
  const days = Math.round((t - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return t.toLocaleDateString(undefined, { weekday: 'short' });
}

export function metaLine(m) {
  return [m.year, fmtRuntime(m.runtime), m.mpaa].filter(Boolean).join(' · ');
}

// Premium formats worth flagging; "Standard" is the default and stays silent.
export function formatBadge(st) {
  if (!st) return null;
  if (st.is_imax) return badge('IMAX', 'imax');
  if (st.format && !/^standard$/i.test(st.format)) return badge(st.format, 'fmt');
  return null;
}

// A bookable showtime. `showDay` is off inside a day-grouped list, where the day
// is already the heading. Showtimes that have already started render inert
// rather than linking to a booking page that can't be used.
export function showtimeChip(st, { showDay = true } = {}) {
  if (!st) return null;
  const label = showDay ? `${dayLabel(st.date)} ${st.time}` : st.time;
  const kids = [
    formatBadge(st),
    h('span', { class: 'st-time' }, label),
    st.end ? h('span', { class: 'st-end' }, `→ ${st.end}`) : null,
    st.fits_window ? h('span', { class: 'st-fit' }, '✓ fits') : null,
  ];
  if (st.past) {
    return h('div', { class: 'showtime-chip past' }, ...kids, h('span', { class: 'st-past' }, 'started'));
  }
  return h('a', { class: 'showtime-chip', href: st.purchase_url || '#', target: '_blank', rel: 'noopener' },
    ...kids, h('span', { class: 'st-book' }, 'Book ↗'));
}

// Runway: how much longer a movie is on at one theatre. Loud only when the run
// is genuinely ending within a few days; otherwise a quiet "through at least"
// that never claims more than the published schedule supports. `theatre`
// names the theatre when the badge isn't about the primary (nearby rows).
export function runwayBadge(runway, { theatre = null } = {}) {
  if (!runway) return null;
  const text = runway.formats?.text
    || (runway.urgent && runway.detail ? `${runway.label} · ${runway.detail}` : runway.label);
  return h('span', {
    class: `runway ${runway.kind}${runway.urgent ? ' urgent' : ''}`,
    title: runway.detail || runway.label,
  }, theatre ? h('span', { class: 'runway-where' }, `${theatre.short}: `) : null, text);
}

// Calendar glyph for the runway line — inline SVG so it takes the tier colour.
// Outline when the end date is still open ("through at least"); the body fills
// when the end is committed, with the header bar and date mark cut out.
function calendarIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'runway-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect class="cal-body" x="2" y="3" width="12" height="11" rx="2"/>'
    + '<path class="cal-rings" d="M5.5 1.5v3M10.5 1.5v3"/>'
    + '<path class="cal-bar" d="M2 7h12"/>'
    + '<circle class="cal-dot" cx="8" cy="10.5" r="1.1" stroke="none"/>';
  return svg;
}

// Prominent runway line for cards and rows — the second thing to land on after
// title and score. Three tiers: quiet (room to spare, still fully readable),
// urgent (ending within ~4 days), lastday (today / tomorrow); a committed end
// date (kind 'ending') fills the glyph at any tier. The text is the server's
// label verbatim, hedging included. `theatre` prefixes the theatre on nearby
// rows, where the runway isn't about the primary.
export function runwayLine(runway, { theatre = null, compact = false } = {}) {
  if (!runway) return null;
  const committed = runway.kind === 'ending';
  const lastDay = committed && runway.daysLeft <= 1;
  const text = runway.formats?.text
    || (runway.urgent && runway.detail ? `${runway.label} · ${runway.detail}` : runway.label);
  return h('div', {
    class: `runway-line ${runway.kind}${committed ? ' committed' : ''}${runway.urgent ? ' urgent' : ''}${lastDay ? ' lastday' : ''}${compact ? ' compact' : ''}`,
    title: runway.detail || (committed ? `${runway.label} — the schedule is posted well past this, so the run ends here` : runway.label),
  },
    calendarIcon(),
    h('span', { class: 'runway-text' },
      theatre ? h('span', { class: 'runway-where' }, `${theatre.short}: `) : null,
      text,
    ),
  );
}

// Which followed theatres a movie plays at this week. Only rendered when more
// than one theatre is followed, so the single-theatre layout is untouched.
export function theatreChips(entry, { multi = false } = {}) {
  if (!multi || !entry.theatres?.length) return null;
  return h('div', { class: 'theatre-chips' }, ...entry.theatres.map((t) => h('span', {
    class: `t-chip${t.isPrimary ? ' primary' : ''}`,
    title: `${t.name}${t.runway?.label ? ` — ${t.runway.label.toLowerCase()}` : ''}`,
  }, t.short, t.distance ? h('span', { class: 't-dist' }, ` · ${t.distance.minutes} min`) : null)));
}

// "Last week at Castleton — still at Indianapolis through Sep 4."
export function handoffLine(entry) {
  return entry.handoff ? h('div', { class: 'handoff' }, '↪ ', entry.handoff.text) : null;
}

export function flagBadges(entry) {
  const f = entry.flags || {};
  const out = [];
  if (f.noScores) out.push(badge('No scores yet', 'noscore'));
  if (f.imax) out.push(badge('IMAX', 'imax'));
  if (entry.watchlisted || f.watchlisted) out.push(badge('★ Watchlist', 'watch'));
  if (f.settling) out.push(badge('Scores settling', 'settling'));
  if (f.seen) out.push(badge('Seen', 'seen'));
  const div = entry.public?.divergence;
  if (div) out.push(badge(div.direction === 'critics-higher' ? 'Critics ▲' : 'Audience ▲', 'diverge'));
  return out.length ? h('div', { class: 'badge-row' }, ...out) : null;
}

export function watchlistButton(entry, ctx, { compact = false, onToggle } = {}) {
  let on = Boolean(entry.watchlisted || entry.flags?.watchlisted);
  const btn = h('button', { class: `chip-btn${on ? ' active' : ''}`, type: 'button' }, on ? '★' : '☆', compact ? null : ' Watchlist');
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = await api.toggleWatchlist(entry.tmdb_id);
      on = r.watchlisted;
      btn.classList.toggle('active', on);
      btn.firstChild.nodeValue = on ? '★' : '☆';
      toast(on ? 'Added to watchlist' : 'Removed from watchlist');
      ctx?.refreshStatus?.();
      onToggle?.(on);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  return btn;
}

// Inline half-star rater that can also clear. Tapping the rating you're already
// on removes it, and the Clear button next to the stars makes that discoverable
// instead of a hidden gesture. Clearing deletes the row outright (not a 0-star
// rating), so the movie stops feeding the taste profile.
export function starRater(entry, ctx, { value = 0, onRated, size = 20 } = {}) {
  let current = value;
  const clearBtn = h('button', { class: 'link-btn rater-clear', type: 'button', title: 'Remove your rating' }, 'Clear');

  const showClear = (v) => { clearBtn.style.display = v ? '' : 'none'; };

  const persist = async (v) => {
    if (v === current) return;
    try {
      if (v) {
        await api.rate({ tmdb_id: entry.tmdb_id, rating: v, title: entry.title, year: entry.year, poster: entry.poster, genres: entry.genres });
        toast(`Rated ${v}★`, 'success');
      } else {
        await api.unrate(entry.tmdb_id);
        toast('Rating cleared');
      }
      current = v;
      showClear(v);
      ctx?.refreshStatus?.();
      onRated?.(v);
    } catch (err) {
      stars.setValue(current); // nothing was saved — put the stars back
      showClear(current);
      toast(err.message, 'error');
    }
  };

  const stars = makeStars({ value, interactive: true, size, allowClear: true, onChange: persist });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stars.setValue(0);
    persist(0);
  });

  showClear(value);
  return h('div', { class: 'rater' }, stars, clearBtn);
}

// Rating control for a pick card. Deliberately does NOT re-render the page on
// change: rating a movie marks it seen, which would drop the card out of the
// weekly 4 instantly and take the Clear button with it before you could undo a
// misclick. The list picks up the change on the next load or refresh.
function rateInline(entry, ctx) {
  const label = h('span', { class: 'muted small' }, entry.myRating ? 'Your rating' : 'Rate');
  return h('div', { class: 'rate-inline' },
    label,
    starRater(entry, ctx, {
      value: entry.myRating || 0,
      onRated: (v) => { label.textContent = v ? 'Your rating' : 'Rate'; },
    }),
  );
}

// Big "Your 4 this week" pick card.
export function weeklyCard(entry, ctx, rank, { day = null, multi = false } = {}) {
  const dayBest = pickBest(daySlots(entry, day));
  return h('div', { class: 'pick-card' },
    h('div', { class: 'pick-poster' },
      rank ? h('div', { class: 'pick-rank' }, rank) : null,
      poster(entry, { size: 'lg' }),
    ),
    h('div', { class: 'pick-body' },
      h('div', { class: 'pick-head' },
        scorePill(entry.final, { label: 'match', big: true, unscored: Boolean(entry.flags?.noScores) }),
        h('div', { class: 'pick-titles' },
          h('a', { class: 'pick-title', href: `#/movie/${entry.tmdb_id}` }, entry.title),
          h('div', { class: 'pick-meta' }, metaLine(entry) || (entry.genres || []).slice(0, 3).join(' · ')),
        ),
      ),
      runwayLine(entry.runway),
      h('p', { class: 'pick-reason' }, entry.reason),
      flagBadges(entry),
      h('div', { class: 'row-sub' }, theatreChips(entry, { multi })),
      handoffLine(entry),
      dayBest ? showtimeChip(dayBest, { showDay: false }) : noTimesLine(day),
      h('div', { class: 'pick-actions' },
        ctx.isGuest?.() ? null : rateInline(entry, ctx),
        ctx.isGuest?.() ? null : watchlistButton(entry, ctx, { compact: true }),
        h('a', { class: 'chip-btn', href: `#/movie/${entry.tmdb_id}` }, 'Details'),
      ),
    ),
  );
}

// Premium formats first, plain screenings last.
const FORMAT_ORDER = ['IMAX', 'Dolby Cinema', 'RealD 3D'];

export function groupByFormat(showtimes) {
  const groups = new Map();
  for (const st of showtimes) {
    const key = st.is_imax ? 'IMAX'
      : (st.format && !/^standard$/i.test(st.format) ? st.format : 'Regular');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(st);
  }
  const rank = (k) => {
    const i = FORMAT_ORDER.indexOf(k);
    return i !== -1 ? i : (k === 'Regular' ? 99 : 50);
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([format, list]) => ({ format, showtimes: list }));
}

export function daySlots(entry, day) {
  const days = entry.showtimesByDay || [];
  return (day ? days.find((d) => d.date === day)?.showtimes : null) || [];
}

// "No showtimes today" / "No showtimes on Fri" for the selected day.
export function noTimesLine(day) {
  const when = dayLabel(day);
  return h('div', { class: 'muted small row-none' },
    `No showtimes ${/^(Today|Tomorrow)$/.test(when) ? when.toLowerCase() : `on ${when}`}`);
}

// Best showtime still to come on a given day: prefer one inside a preferred
// window, then IMAX, then whichever starts soonest.
export function pickBest(list) {
  const live = list.filter((s) => !s.past);
  if (!live.length) return null;
  return [...live].sort((a, b) =>
    Number(b.fits_window) - Number(a.fits_window)
    || Number(b.is_imax) - Number(a.is_imax)
    || (a.start_epoch ?? 0) - (b.start_epoch ?? 0))[0];
}

// Day selector for the whole page. Counts show how many movies play that day.
export function dayPicker(days, selected, onSelect) {
  const bar = h('div', { class: 'day-picker' });
  for (const d of days) {
    const btn = h('button', { class: `day-btn${d.date === selected ? ' active' : ''}`, type: 'button', dataset: { date: d.date } },
      h('span', { class: 'day-name' }, dayLabel(d.date)),
      h('span', { class: 'day-n' }, String(d.movies)),
    );
    btn.addEventListener('click', () => {
      [...bar.children].forEach((b) => b.classList.toggle('active', b.dataset.date === d.date));
      onSelect(d.date);
    });
    bar.appendChild(btn);
  }
  return bar;
}

// Ranked row with real showtimes for the selected day. A plain <div>, not a
// link — it contains a Book link and buttons, which can't legally nest inside an
// anchor, so the poster and title carry the navigation instead.
// compact: drops the reason line and flag badges (used by "Everything playing").
// multi: more than one theatre is followed — the expandable panel then groups
// showtimes by theatre. nearby: the row is in "Also nearby", so its runway and
// showtimes are about a theatre other than the primary and say which.
export function movieRow(entry, ctx, { day = null, compact = false, multi = false, nearby = false } = {}) {
  const slots = daySlots(entry, day);
  const next = pickBest(slots);

  // The entry's own day list is for the theatre it was evaluated at; the other
  // followed theatres carry theirs on entry.theatres.
  const groups = multi
    ? (entry.theatres || [])
      .map((t) => ({ theatre: t, slots: t.showtimesByDay ? daySlots(t, day) : slots }))
      .filter((g) => g.slots.length)
    : (slots.length ? [{ theatre: null, slots }] : []);
  const total = groups.reduce((n, g) => n + g.slots.length, 0);

  const panel = h('div', { class: 'row-expand', hidden: true });
  let built = false;

  const label = (n) => `All times (${n})`;
  const toggle = h('button', { class: 'chip-btn row-more', type: 'button' }, label(total));
  toggle.addEventListener('click', () => {
    if (!built) {
      built = true;
      for (const g of groups) {
        if (g.theatre) {
          panel.appendChild(h('div', { class: 'fmt-theatre' },
            g.theatre.short,
            g.theatre.distance ? h('span', { class: 'muted small' }, g.theatre.distance.label) : null,
            runwayBadge(g.theatre.runway),
          ));
        }
        for (const f of groupByFormat(g.slots)) {
          panel.appendChild(h('div', { class: 'fmt-group' },
            h('div', { class: 'fmt-label' }, f.format),
            h('div', { class: 'fmt-slots' }, ...f.showtimes.map((st) => showtimeChip(st, { showDay: false }))),
          ));
        }
      }
    }
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.classList.toggle('active', opening);
    toggle.firstChild.nodeValue = opening ? 'Hide times' : label(total);
  });

  return h('div', { class: `list-row${entry.flags?.excluded ? ' excluded' : ''}${entry.flags?.seen ? ' seen' : ''}` },
    h('a', { class: 'row-poster', href: `#/movie/${entry.tmdb_id}` }, poster(entry, { size: 'sm', link: false })),
    h('div', { class: 'row-body' },
      h('div', { class: 'row-head' },
        h('a', { class: 'row-title', href: `#/movie/${entry.tmdb_id}` },
          entry.title, h('span', { class: 'row-year' }, entry.year ? ` ${entry.year}` : '')),
        scorePill(entry.final, { unscored: Boolean(entry.flags?.noScores) }),
      ),
      runwayLine(entry.runway, { theatre: nearby ? entry.theatre : null, compact: true }),
      // Single-line with ellipsis; the full reason (urgency clause included) is
      // on the tooltip and always in full on the card / detail page.
      compact ? null : h('div', { class: 'row-reason', title: entry.reason }, entry.reason),
      // The no-scores flag shows even on compact rows: a dashed pill alone is
      // too easy to miss for a number that is partly made up.
      compact && entry.flags?.noScores ? h('div', { class: 'row-tags' }, badge('No scores yet', 'noscore')) : null,
      compact ? null : h('div', { class: 'row-tags' },
        entry.flags?.noScores ? badge('No scores yet', 'noscore') : null,
        entry.flags?.imax ? badge('IMAX', 'imax') : null,
        entry.flags?.excluded ? badge('Filtered', 'muted') : null,
        entry.flags?.settling ? badge('Settling', 'settling') : null,
        entry.flags?.seen ? badge('Seen', 'seen') : null,
      ),
      h('div', { class: 'row-sub' }, theatreChips(entry, { multi })),
      handoffLine(entry),
      next ? showtimeChip(next, { showDay: false }) : noTimesLine(day),
      total ? toggle : null,
      panel,
    ),
  );
}

// "Last chance" card: scores well and is actually about to leave the theatre.
export function lastChanceCard(entry, ctx) {
  return h('a', { class: `lc-card${entry.watchlisted ? ' starred' : ''}`, href: `#/movie/${entry.tmdb_id}` },
    h('div', { class: 'lc-poster' },
      poster(entry, { size: 'grid', link: false }),
      entry.watchlisted ? h('span', { class: 'lc-star', title: ctx?.isGuest?.() ? 'On the watchlist' : 'On your watchlist' }, '\u2605') : null,
      h('span', { class: 'lc-score' }, scorePill(entry.final)),
    ),
    h('div', { class: 'lc-body' },
      h('div', { class: 'lc-title' }, entry.title),
      h('div', { class: `lc-when ${entry.urgency}` }, entry.lastLabel),
      h('div', { class: 'lc-left' },
        entry.leftLabel,
        entry.signal === 'shrinking' ? h('span', { class: 'lc-sig' }, ' \u00b7 schedule shrinking') : null,
      ),
      entry.handoff ? h('div', { class: 'lc-handoff' }, '\u21aa ', entry.handoff.text) : null,
    ),
  );
}

// Generic poster tile with a caption (Coming Soon / Watchlist grids).
export function posterTile(movie, { corner, caption, sub } = {}) {
  return h('a', { class: 'tile', href: `#/movie/${movie.tmdb_id}` },
    h('div', { class: 'tile-poster' },
      corner || null,
      poster(movie, { size: 'grid', link: false }),
    ),
    h('div', { class: 'tile-cap' }, caption || movie.title),
    sub ? h('div', { class: 'tile-sub' }, sub) : null,
  );
}
