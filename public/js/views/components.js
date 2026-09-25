// Reusable movie cards shared across Home / Coming Soon / Watchlist.
import { api } from '../api.js';
import { h, clear, poster, scorePill, badge, makeStars, toast, icon, scoreColor } from '../ui.js';

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

// An older film on the current lineup is a revival, not a new release. More
// than a year old counts, so last winter's awards run doesn't get the badge.
export function isOldRelease(m) {
  return Boolean(m?.year) && m.year < new Date().getFullYear() - 1;
}

export function backBadge(m) {
  return isOldRelease(m) ? badge('Back in theaters', 'back') : null;
}

// Not out yet: this week's showtimes are all early screenings (server sets
// entry.prerelease). "Opens Oct 2".
export function opensBadge(entry) {
  const d = entry?.prerelease?.opens;
  if (!d) return null;
  const when = new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return badge(`Opens ${when}`, 'opens');
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
  // Three different times can appear here, so each is named rather than left to
  // be inferred from position: the listed time is when previews roll, "be there
  // by" is when the feature itself starts, "→" is when it lets out.
  const kids = [
    formatBadge(st),
    h('span', { class: 'st-time' }, label),
    st.be_there_by ? h('span', { class: 'st-seat' }, `be there by ${st.be_there_by}`) : null,
    st.end ? h('span', { class: 'st-end' }, `→ ends ${st.end}`) : null,
    st.fits_window ? h('span', { class: 'st-fit' }, '✓ fits') : null,
  ];
  const attrs = { class: 'showtime-chip', title: showtimeTitle(st) };
  if (st.past) {
    return h('div', { ...attrs, class: 'showtime-chip past' }, ...kids, h('span', { class: 'st-past' }, 'started'));
  }
  return h('a', { ...attrs, href: st.purchase_url || '#', target: '_blank', rel: 'noopener' },
    ...kids, h('span', { class: 'st-book' }, 'Book ↗'));
}

// Spells the three times out in full on hover, so the compact chip never has to
// carry the whole explanation.
function showtimeTitle(st) {
  const parts = [`AMC lists ${st.time}. Previews start then.`];
  if (st.be_there_by) {
    const mins = Number(st.previews_min) > 0 ? ` (${st.previews_min} min of previews, set in Settings)` : '';
    parts.push(`The film itself starts around ${st.be_there_by}, so that is the latest you want to be in your seat${mins}.`);
  }
  if (st.end) parts.push(`Ends around ${st.end}.`);
  return parts.join(' ');
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
    title: runway.detail || (committed ? `${runway.label}. The schedule runs well past this, so the run ends here.` : runway.label),
  },
    calendarIcon(),
    h('span', { class: 'runway-text' },
      theatre ? h('span', { class: 'runway-where' }, `${theatre.short}: `) : null,
      text,
    ),
  );
}

// Where a movie plays, but only when that's news: a film at every followed
// theatre says nothing ("it's everywhere" is the default), while one that isn't
// names where it is ("Only at Castleton · 24 min"). `multi` is the number of
// followed theatres when there's more than one, else 0, so a single-theatre
// setup renders nothing here, as before.
export function theatreChips(entry, { multi = 0 } = {}) {
  const at = entry.theatres || [];
  if (!multi || !at.length || at.length >= multi) return null;
  return h('div', { class: 'theatre-chips' },
    h('span', { class: 't-only' }, 'Only at'),
    ...at.map((t) => h('span', {
      class: `t-chip${t.isPrimary ? ' primary' : ''}`,
      title: `${t.name}${t.runway?.label ? `: ${t.runway.label.toLowerCase()}` : ''}`,
    }, t.short, t.distance ? h('span', { class: 't-dist' }, ` · ${t.distance.minutes} min`) : null)));
}

// "Last week at Castleton — still at Indianapolis through Sep 4."
export function handoffLine(entry) {
  return entry.handoff ? h('div', { class: 'handoff' }, icon('handoff', { size: 14 }), ' ', entry.handoff.text) : null;
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
  // Compact: a round icon button. The filled bookmark is the "on" state, and
  // aria-pressed says the same thing to a screen reader.
  const btn = h('button', { class: compact ? 'icon-btn round' : 'chip-btn', type: 'button' },
    icon('bookmark', { size: compact ? 20 : 16 }), compact ? null : h('span', {}, 'Watchlist'));
  const paint = () => {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', `${on ? 'Remove from' : 'Add to'} watchlist: ${entry.title || 'this movie'}`);
    btn.title = on ? 'On your watchlist' : 'Add to watchlist';
  };
  paint();
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = await api.toggleWatchlist(entry.tmdb_id);
      on = r.watchlisted;
      paint();
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

// Rating control for a pick card or row. Deliberately does NOT re-render the
// page on change: rating a movie marks it seen, which would drop the card out
// of the weekly 4 instantly and take the Clear button with it before you could
// undo a misclick. The list picks up the change on the next load or refresh.
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

// Owner controls under a card or row: the rater on the left, the watchlist
// toggle and "Not for me" on the right. The row wraps, so on a narrow card the
// stars take their own line and the buttons stay together.
function ownerTools(entry, ctx, { onHide = null } = {}) {
  if (ctx.isGuest?.()) return null;
  return h('div', { class: 'owner-tools' },
    rateInline(entry, ctx),
    h('div', { class: 'owner-buttons' },
      watchlistButton(entry, ctx, { compact: true }),
      onHide ? notForMeButton(entry, onHide) : null,
    ),
  );
}

// Picks 2-4: poster left, the facts in reading order on the right, the day's
// showtime with its Book link, then the owner's controls at the bottom.
export function weeklyCard(entry, ctx, rank, { day = null, multi = 0, onHide = null, movedUp = false } = {}) {
  const dayBest = pickBest(daySlots(entry, day));
  const meta = metaLine(entry) || (entry.genres || []).slice(0, 3).join(' · ');
  return h('article', { class: 'pick-card', 'data-id': entry.tmdb_id },
    h('a', { class: 'pick-poster', href: `#/movie/${entry.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' },
      poster(entry, { size: 'card', link: false }),
      rank ? h('span', { class: 'pick-rank' }, rank) : null,
    ),
    h('div', { class: 'pick-body' },
      h('div', { class: 'pick-head' },
        h('a', { class: 'pick-title', href: `#/movie/${entry.tmdb_id}` }, entry.title),
        scorePill(entry.final, { unscored: Boolean(entry.flags?.noScores) }),
      ),
      h('div', { class: 'pick-meta' },
        meta ? h('span', {}, meta) : null,
        opensBadge(entry),
        entry.flags?.imax ? badge('IMAX', 'imax') : null,
        backBadge(entry),
        entry.flags?.noScores ? badge('No scores yet', 'noscore') : null,
        movedUp ? movedTag() : null,
      ),
      entry.reason ? h('p', { class: 'pick-reason' }, entry.reason) : null,
      runwayLine(entry.runway, { compact: true }),
      h('div', { class: 'row-sub' }, theatreChips(entry, { multi })),
      handoffLine(entry),
      h('div', { class: 'pick-foot' },
        dayBest ? showtimeChip(dayBest, { showDay: false }) : noTimesLine(day),
      ),
      ownerTools(entry, ctx, { onHide }),
    ),
  );
}

// "tonight" / "today" / "tomorrow" / "Fri", for the Book button. Evening
// listings read as tonight; a matinee today is just today.
function whenWord(st, day) {
  const when = dayLabel(day || st?.date);
  if (when === 'Today') return Number(String(st?.start_local || '').slice(11, 13)) >= 17 ? 'tonight' : 'today';
  if (when === 'Tomorrow') return 'tomorrow';
  return when;
}

// The day's best showtime as the page's one primary action. With nothing left
// that day, the same slot says so instead of disappearing.
export function bookButton(st, day, { wide = false } = {}) {
  if (!st) {
    const when = dayLabel(day);
    const text = !when ? 'No showtimes available' : `No showtimes ${/^(Today|Tomorrow)$/.test(when) ? when.toLowerCase() : when}`;
    return h('span', { class: `btn book none${wide ? ' wide' : ''}`, 'aria-disabled': 'true' }, text);
  }
  return h('a', {
    class: `btn book${wide ? ' wide' : ''}`, href: st.purchase_url || '#', target: '_blank', rel: 'noopener',
    title: showtimeTitle(st),
  }, formatBadge(st), `Book ${st.time} ${whenWord(st, day)}`);
}

// "Be in your seat by 7:50 PM. Ends around 10:51 PM." Same two times the
// showtime chip names (be there by / ends), spelled out as a sentence.
export function seatLine(st) {
  if (!st) return null;
  const bits = [];
  if (st.be_there_by) bits.push(`Be in your seat by ${st.be_there_by}.`);
  if (st.end) bits.push(`Ends around ${st.end}.`);
  if (st.fits_window) bits.push('Fits your window.');
  return bits.length ? h('p', { class: 'seat-line' }, bits.join(' ')) : null;
}

// Backdrop art with a graceful fall-through: the backdrop, then the poster
// blurred up to fill the frame, then a plain surface.
export function heroMedia(m, { cls = 'hero-media' } = {}) {
  const wrap = h('div', { class: cls });
  const usePoster = () => {
    if (!m.poster) { wrap.classList.add('plain'); return; }
    wrap.classList.add('from-poster');
    const img = h('img', { class: 'hero-img', src: m.poster, alt: '', 'aria-hidden': 'true' });
    img.addEventListener('error', () => { img.remove(); wrap.classList.remove('from-poster'); wrap.classList.add('plain'); });
    wrap.appendChild(img);
  };
  if (m.backdrop) {
    const big = m.backdrop.replace('/w780/', '/w1280/');
    const img = h('img', {
      class: 'hero-img', src: m.backdrop, alt: '', 'aria-hidden': 'true', fetchpriority: 'high',
      srcset: big !== m.backdrop ? `${m.backdrop} 780w, ${big} 1280w` : null, sizes: '(min-width: 900px) 1200px, 100vw',
    });
    img.addEventListener('error', () => { img.remove(); usePoster(); }, { once: true });
    wrap.appendChild(img);
  } else usePoster();
  wrap.appendChild(h('div', { class: 'hero-scrim' }));
  return wrap;
}

// "Not for me": hides the film from every recommendation (never from the full
// list, never from the scores). `onHide(entry, card)` does the work; the card
// is the element to fade out. `label` gives the hero its worded version.
export function notForMeButton(entry, onHide, { label = false } = {}) {
  const btn = h('button', {
    class: label ? 'btn ghost not-for-me' : 'icon-btn round not-for-me', type: 'button',
    'aria-label': `Not for me, hide ${entry.title}`, title: 'Not for me. Hide it from your picks',
  }, icon('eyeOff', { size: label ? 18 : 20 }), label ? h('span', {}, 'Not for me') : null);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    onHide(entry, btn.closest('.hero-pick, .pick-card, .list-row'));
  });
  return btn;
}

// Tag for a film that just moved into the four after a hide.
const movedTag = () => badge('Moved up', 'moved');

// The #1 pick of the week, full width over its own backdrop.
export function heroPick(entry, ctx, { day = null, multi = 0, onHide = null, movedUp = false, rank = 1 } = {}) {
  const best = pickBest(daySlots(entry, day));
  const guest = ctx.isGuest?.();
  const meta = [entry.year, fmtRuntime(entry.runtime), entry.mpaa].filter(Boolean);
  return h('section', { class: 'hero-pick', 'aria-labelledby': `hero-${entry.tmdb_id}` },
    heroMedia(entry),
    h('div', { class: 'hero-content' },
      h('div', { class: 'eyebrow' },
        `No. ${rank} this week`,
        h('span', { class: 'eyebrow-dot', 'aria-hidden': 'true' }, ' · '),
        h('span', { class: `eyebrow-score ${scoreColor(entry.final)}`, title: entry.flags?.noScores ? 'No public scores yet. This number uses a neutral 50 for reviews.' : 'Match score' },
          `${entry.final ?? '-'} match`),
        movedUp ? movedTag() : null,
      ),
      h('h2', { class: 'hero-title', id: `hero-${entry.tmdb_id}` },
        h('a', { href: `#/movie/${entry.tmdb_id}` }, entry.title)),
      h('div', { class: 'hero-facts' },
        meta.length ? h('span', {}, meta.join(' · ')) : null,
        opensBadge(entry),
        entry.flags?.imax ? badge('IMAX', 'imax') : null,
        backBadge(entry),
        ...heroFlags(entry),
      ),
      entry.reason ? h('p', { class: 'hero-reason' }, entry.reason) : null,
      runwayLine(entry.runway),
      h('div', { class: 'row-sub' }, theatreChips(entry, { multi })),
      handoffLine(entry),
      h('div', { class: 'hero-actions' },
        bookButton(best, day),
        h('a', { class: 'btn ghost', href: `#/movie/${entry.tmdb_id}` }, 'Details'),
        guest ? null : watchlistButton(entry, ctx, { compact: true }),
        onHide && !guest ? notForMeButton(entry, onHide, { label: true }) : null,
      ),
      seatLine(best),
    ),
  );
}

// The flags worth a word on the hero (IMAX has its own badge beside the meta).
function heroFlags(entry) {
  const f = entry.flags || {};
  return [
    f.noScores ? badge('No scores yet', 'noscore') : null,
    entry.watchlisted || f.watchlisted ? badge('On watchlist', 'watch') : null,
    f.settling ? badge('Scores settling', 'settling') : null,
  ];
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

// "No showtimes today" / "No showtimes on Fri" for the selected day — or,
// with no day selected at all (TMDB fallback: no published schedule), a
// complete sentence instead of a truncated "No showtimes on ".
export function noTimesLine(day) {
  const when = dayLabel(day);
  if (!when) return h('div', { class: 'muted small row-none' }, 'No showtimes available');
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

// Day selector for the whole page: weekday over the date number, like a
// calendar strip. How many films play that day is on the tooltip.
export function dayPicker(days, selected, onSelect) {
  const bar = h('div', { class: 'day-picker', role: 'group', 'aria-label': 'Choose a day' });
  const paint = (date) => [...bar.children].forEach((b) => {
    const on = b.dataset.date === date;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  for (const d of days) {
    const t = new Date(`${d.date}T00:00:00`);
    const name = dayLabel(d.date) === 'Today' ? 'Today' : t.toLocaleDateString(undefined, { weekday: 'short' });
    const full = t.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const btn = h('button', {
      class: 'day-btn', type: 'button', dataset: { date: d.date },
      title: `${d.movies} film${d.movies === 1 ? '' : 's'} playing`,
      'aria-label': `${full}, ${d.movies} film${d.movies === 1 ? '' : 's'}`,
    },
      h('span', { class: 'day-name' }, name),
      h('span', { class: 'day-num' }, String(t.getDate())),
    );
    btn.addEventListener('click', () => { paint(d.date); onSelect(d.date); });
    bar.appendChild(btn);
  }
  paint(selected);
  return bar;
}

// Ranked row with real showtimes for the selected day. A plain <div>, not a
// link — it contains a Book link and buttons, which can't legally nest inside an
// anchor, so the poster and title carry the navigation instead.
// compact: drops the reason line and flag badges (used by "Everything playing").
// multi: how many theatres are followed (0 for one) — the expandable panel then groups
// showtimes by theatre. nearby: the row is in "Also nearby", so its runway and
// showtimes are about a theatre other than the primary and say which.
// onHide adds the "Not for me" button; onUnhide, on a hidden film, the Unhide
// link that stands in for it (Everything playing). tools adds the rater and the
// watchlist toggle (Also worth seeing). All owner only.
export function movieRow(entry, ctx, { day = null, compact = false, multi = 0, nearby = false, onHide = null, onUnhide = null, tools = false } = {}) {
  const hidden = Boolean(entry.flags?.hidden);
  const owner = !ctx.isGuest?.();
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

  return h('div', { class: `list-row${entry.flags?.excluded ? ' excluded' : ''}${entry.flags?.seen ? ' seen' : ''}${hidden ? ' is-hidden' : ''}` },
    h('a', { class: 'row-poster', href: `#/movie/${entry.tmdb_id}` }, poster(entry, { size: 'sm', link: false })),
    h('div', { class: 'row-body' },
      h('div', { class: 'row-head' },
        h('a', { class: 'row-title', href: `#/movie/${entry.tmdb_id}` },
          entry.title, h('span', { class: 'row-year' }, entry.year ? ` ${entry.year}` : '')),
        scorePill(entry.final, { unscored: Boolean(entry.flags?.noScores) }),
        owner && onHide && !hidden ? notForMeButton(entry, onHide) : null,
      ),
      hidden ? h('div', { class: 'row-tags' },
        badge('Hidden', 'hidden'),
        owner && onUnhide ? h('button', {
          class: 'link-btn', type: 'button', 'aria-label': `Unhide ${entry.title}`,
          onClick: (e) => { e.currentTarget.disabled = true; onUnhide(entry); },
        }, 'Unhide') : null,
      ) : null,
      runwayLine(entry.runway, { theatre: nearby ? entry.theatre : null, compact: true }),
      // Single-line with ellipsis; the full reason (urgency clause included) is
      // on the tooltip and always in full on the card / detail page.
      compact ? null : h('div', { class: 'row-reason', title: entry.reason }, entry.reason),
      // The no-scores flag shows even on compact rows: a dashed pill alone is
      // too easy to miss for a number that is partly made up.
      compact && (entry.flags?.noScores || isOldRelease(entry) || entry.prerelease) ? h('div', { class: 'row-tags' },
        opensBadge(entry), entry.flags?.noScores ? badge('No scores yet', 'noscore') : null, backBadge(entry)) : null,
      compact ? null : h('div', { class: 'row-tags' },
        opensBadge(entry),
        backBadge(entry),
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
      tools ? ownerTools(entry, ctx) : null,
    ),
  );
}

// "Last chance" tile: scores well and is actually about to leave the theatre.
// Only a committed end date (runway kind 'ending') gets the loud treatment: an
// urgent border and a solid "Last day today" / "Leaving Fri" pill. Anything
// hedged keeps its runway label verbatim, quiet and uncoloured, so a hedge
// never reads like a deadline.
export function lastChanceCard(entry, ctx) {
  const committed = !entry.runway || entry.runway.kind === 'ending';
  const days = entry.daysLeft ?? entry.runway?.daysLeft ?? null;
  const when = days != null && days <= 0 ? 'Last day today'
    : days === 1 ? 'Leaving tomorrow'
    : `Leaving ${new Date(`${entry.lastDate || entry.runway?.lastDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}`;
  const onList = entry.watchlisted;
  return h('a', { class: `lc-card${committed ? ' committed' : ' hedged'}`, href: `#/movie/${entry.tmdb_id}` },
    h('div', { class: 'lc-poster' }, poster(entry, { size: 'grid', link: false })),
    committed
      ? h('span', { class: 'lc-pill', title: entry.lastLabel || '' }, when)
      : h('span', { class: 'lc-hedge', title: entry.runway?.detail || entry.runway?.label || '' }, entry.runway?.label || entry.lastLabel),
    h('div', { class: 'lc-body' },
      h('div', { class: 'lc-title' }, entry.title),
      h('div', { class: 'lc-meta' },
        scorePill(entry.final),
        onList ? h('span', { class: 'lc-star', title: ctx?.isGuest?.() ? 'On the watchlist' : 'On your watchlist' }, icon('bookmark', { size: 14 })) : null,
        committed ? h('span', { class: 'lc-left' }, entry.leftLabel,
          entry.signal === 'shrinking' ? ' · schedule shrinking' : null) : null,
      ),
      entry.handoff ? h('div', { class: 'lc-handoff' }, icon('handoff', { size: 13 }), ' ', entry.handoff.text) : null,
    ),
  );
}

// Generic poster tile with a caption (Coming Soon / Watchlist grids). The art
// stays clean: score pills and badges sit in the caption row under it, and
// only a control (`corner`, e.g. the watchlist button) overlays the poster.
export function posterTile(movie, { corner, caption, sub, tags } = {}) {
  return h('a', { class: 'tile', href: `#/movie/${movie.tmdb_id}` },
    h('div', { class: 'tile-poster' },
      corner || null,
      poster(movie, { size: 'grid', link: false }),
    ),
    tags ? h('div', { class: 'tile-tags' }, tags) : null,
    h('div', { class: 'tile-cap' }, caption || movie.title),
    sub ? h('div', { class: 'tile-sub' }, sub) : null,
  );
}
