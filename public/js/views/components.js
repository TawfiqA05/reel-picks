// Reusable film pieces shared across Picks, the movie page, Schedule and the
// lists: the match badge, the short reason line, tags, showtime rows, the
// hero, the pick cards and the list rows.
import { api } from '../api.js';
import { h, clear, poster, matchBadge, badge, makeStars, toast, icon, spinner, openModal, withStars } from '../ui.js';
import { paintRow, heroPlan, goingLine } from '../social.js';

function fmtRuntime(min) {
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
// than a year old counts, so last winter's awards run doesn't get the tag.
export function isOldRelease(m) {
  return Boolean(m?.year) && m.year < new Date().getFullYear() - 1;
}

function backBadge(m) {
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

// ---- formats ------------------------------------------------------------
// Premium formats get a tinted chip that says which: IMAX blue, Dolby purple,
// RealD 3D teal, anything else amber. A standard showing has none.
export function formatName(st) {
  if (!st) return null;
  if (st.is_imax) return 'IMAX';
  if (st.format && !/^standard$/i.test(st.format)) return st.format;
  return null;
}
function formatKind(name) {
  if (!name) return null;
  if (/imax/i.test(name)) return 'imax';
  if (/dolby/i.test(name)) return 'dolby';
  if (/3d|reald/i.test(name)) return 'reald';
  return 'fmt';
}
// Short enough for the showtime row's one fixed column.
const SHORT = { imax: 'IMAX', dolby: 'Dolby', reald: '3D' };
function formatShort(name) {
  const k = formatKind(name);
  if (SHORT[k]) return SHORT[k];
  if (/laser/i.test(name)) return 'Laser';
  if (/70\s*mm/i.test(name)) return '70mm';
  return name.split(/\s+/)[0].slice(0, 6);
}
export function formatBadge(st, { short = false } = {}) {
  const name = formatName(st);
  if (!name) return null;
  const tag = badge(short ? formatShort(name) : name, formatKind(name));
  if (short) tag.title = name;
  return tag;
}

// ---- tags ---------------------------------------------------------------
// One line, in this order: the format (IMAX), then what's going on with the
// run (Back in theaters, Last chance, New this week, Opens…), then plain
// facts. The hero keeps three at most so they fit one line at 320.
export function filmTags(entry, { movedUp = false, max = 5, noScores = true } = {}) {
  const f = entry.flags || {};
  const tags = [
    f.imax ? badge('IMAX', 'imax') : null,
    backBadge(entry),
    entry.runway?.urgent ? badge('Last chance', 'last') : null,
    entry.pick?.newThisWeek ? badge('New this week', 'new') : null,
    opensBadge(entry),
    movedUp ? badge('Moved up', 'moved') : null,
    noScores && f.noScores ? badge('No scores yet') : null,
    f.settling ? badge('Scores settling') : null,
  ].filter(Boolean).slice(0, max);
  return tags.length ? h('div', { class: 'tag-row' }, ...tags) : null;
}

// ---- the reason line ----------------------------------------------------
// At most the two strongest reasons, in plain words: "RT 94% · You love
// action". The public score is green when it's high, red when it's low.
// Built from the facts the server keeps with each pick (entry.why); a reason
// that only comes as a sentence (At home, What should I watch?) is tidied the
// same way. The watchlist, IMAX and "no scores yet" are left out: the gold
// bookmark, the IMAX tag and the early match already say them.
function scoreTone(source, value) {
  const percent = source === 'RT' || source === 'Metacritic';
  const v = percent ? value : value * 10;
  if (v >= (percent ? 75 : 70)) return 'good';
  if (v < 60) return 'bad';
  return '';
}
function scoreSpan(text, source, value) {
  const tone = scoreTone(source, Number(value));
  return h('span', { class: `rs-score${tone ? ` ${tone}` : ''}` }, text);
}
function tasteWords(t, who) {
  const name = t.kind === 'genre' ? t.label.toLowerCase() : t.label;
  const verb = t.avg >= 4 ? 'love' : t.avg >= 3.5 ? 'like' : 'rate';
  const lead = who ? `${who} ${verb}s` : `You ${verb}`;
  return verb === 'rate' ? `${lead} ${name} ${t.avg}/5` : `${lead} ${name}`;
}
const DIVERGE = { 'critics-higher': 'Critics like it more than audiences', 'audience-higher': 'Audiences like it more than critics' };

function factsParts(why, { who, lastChance }) {
  const parts = [];
  if (why.review && !why.noScores) parts.push(scoreSpan(why.review.text, why.review.source, why.review.value));
  if (why.taste) parts.push(tasteWords(why.taste, who));
  if (why.goneAfter && !lastChance) parts.push(why.goneAfter.charAt(0).toUpperCase() + why.goneAfter.slice(1));
  if (why.leaning) parts.push(who ? `${who}'s taste is still filling in` : 'Your taste is still filling in');
  if (why.divergence && DIVERGE[why.divergence]) parts.push(DIVERGE[why.divergence]);
  return parts;
}

const SCORE_RE = /\b(RT \d+%|Metacritic \d+|IMDb \d(?:\.\d)?|TMDB \d(?:\.\d)?)/;
function textParts(text) {
  const bits = String(text || '')
    .split(/\s+\+\s+|\s+·\s+|, and /)
    .map((b) => b.trim())
    .filter((b) => b && !/watchlist|IMAX available|^no public scores yet$/i.test(b));
  return bits.map((b) => {
    const s = b.charAt(0).toUpperCase() + b.slice(1);
    const m = s.match(SCORE_RE);
    if (!m) return s;
    const [src, val] = m[1].split(' ');
    const at = s.indexOf(m[1]);
    return [s.slice(0, at), scoreSpan(m[1], src, parseFloat(val)), s.slice(at + m[1].length)].filter((x) => x !== '');
  });
}

export function reasonLine(entry, ctx, { cls = 'reason-line', lastChance = false } = {}) {
  const guest = ctx?.isGuest?.();
  const who = guest ? (ctx.getStatus?.()?.ownerName || 'The owner') : null;
  const parts = (entry.why ? factsParts(entry.why, { who, lastChance }) : textParts(entry.reason)).slice(0, 2);
  if (!parts.length) return null;
  const kids = [];
  parts.forEach((p, i) => { if (i) kids.push(' · '); kids.push(...(Array.isArray(p) ? p : [p])); });
  return h('p', { class: cls }, ...kids.flatMap((k) => (typeof k === 'string' ? withStars(k) : [k])));
}

// ---- showtimes ----------------------------------------------------------
// One showtime as a row on a fixed grid, so every row in a list lines up:
// time, format chip, "ends …", fits, Book, and a small calendar button at the
// right edge. The whole row books (its Book link covers it); the calendar
// button sits above that. A time that has started is shown, quietly, with
// nothing to book.
export function showtimeRow(st) {
  if (!st) return null;
  const fmt = formatName(st);
  const cells = [
    h('span', { class: 'st-time' }, st.time),
    h('span', { class: 'st-fmt' }, formatBadge(st, { short: true })),
    h('span', { class: 'st-end' }, st.end ? `ends ${st.end}` : ''),
    h('span', { class: 'st-fit' }, st.fits_window && !st.past ? [icon('check', { size: 14 }), 'Fits'] : null),
  ];
  if (st.past) {
    return h('div', { class: 'st-row past', title: 'This showing has started' }, ...cells, h('span', { class: 'st-book' }, 'Started'), h('span', { class: 'st-cal' }));
  }
  const when = dayLabel(st.date);
  const label = [`Book ${when === 'Today' ? '' : `${when} `}${st.time}`, fmt, st.end ? `ends ${st.end}` : null, st.fits_window ? 'fits your times' : null].filter(Boolean).join(', ');
  const row = h('div', { class: 'st-row', title: showtimeTitle(st), dataset: st.id ? { st: String(st.id) } : null },
    ...cells,
    h('a', { class: 'st-book', href: st.purchase_url || '#', target: '_blank', rel: 'noopener', 'aria-label': label }, 'Book', icon('arrowRight', { size: 14 })),
    st.id ? calendarButton(st, { cls: 'st-cal' }) : h('span', { class: 'st-cal' }),
  );
  // Your "I'm going" showing: the soft accent and the plan's line (js/social.js).
  if (st.id) paintRow(row);
  return row;
}

// "Add to calendar": the showtime as an .ics file (server/lib/calendar.js). A
// plain link, so iPhone Safari hands it to Calendar and a desktop browser
// downloads it. A small icon button; its tap area is 44px all the same.
export function calendarButton(st, { cls = '' } = {}) {
  const when = `${dayLabel(st.date)} ${st.time}`;
  return h('a', {
    class: `cal-btn${cls ? ` ${cls}` : ''}`, href: `/api/showtimes/${encodeURIComponent(st.id)}/calendar.ics`,
    'aria-label': `Add to calendar: ${when}`, title: `Add ${when} to your calendar`,
    onClick: (e) => { if (!navigator.onLine) { e.preventDefault(); toast('You\'re offline. Try again once you\'re back online.', 'error'); } },
  }, icon('calendarPlus', { size: 16 }));
}

// The three times, spelled out on hover.
function showtimeTitle(st) {
  const parts = [`AMC lists ${st.time}. Previews start then.`];
  if (st.be_there_by) {
    const mins = Number(st.previews_min) > 0 ? ` (${st.previews_min} min of previews, set in Settings)` : '';
    parts.push(`The film itself starts around ${st.be_there_by}${mins}.`);
  }
  if (st.end) parts.push(`Out around ${st.end}.`);
  return parts.join(' ');
}

// ---- runway -------------------------------------------------------------
// How much longer a film is on at a theater. The words are the server's.
function runwayBadge(runway, { theatre = null } = {}) {
  if (!runway) return null;
  const text = runway.formats?.text || runway.label;
  return h('span', { class: `runway ${runway.kind}${runway.urgent ? ' urgent' : ''}`, title: runway.detail || runway.label },
    theatre ? h('span', { class: 'runway-where' }, `${theatre.short}: `) : null, text);
}

// The runway as its own line on the hero, cards and rows: a calendar glyph,
// filled when the end is confirmed, then the label. Red in the last days.
export function runwayLine(runway, { theatre = null, compact = false } = {}) {
  if (!runway) return null;
  const committed = runway.kind === 'ending';
  const text = runway.formats?.text || runway.label;
  return h('div', {
    class: `runway-line ${runway.kind}${committed ? ' committed' : ''}${runway.urgent ? ' urgent' : ''}${compact ? ' compact' : ''}`,
    title: runway.detail || runway.label,
  },
    icon('calendar', { size: compact ? 14 : 16, cls: 'runway-icon' }),
    h('span', { class: 'runway-text' }, theatre ? h('span', { class: 'runway-where' }, `${theatre.short}: `) : null, text),
  );
}

// Where a film plays, only when that's news: a film at every followed theater
// says nothing; one that isn't names where it is ("Only at Castleton · 24 min").
export function theatreChips(entry, { multi = 0 } = {}) {
  const at = entry.theatres || [];
  if (!multi || !at.length || at.length >= multi) return null;
  return h('div', { class: 'theatre-chips' },
    h('span', { class: 't-only' }, 'Only at'),
    ...at.map((t) => h('span', {
      class: `tag${t.isPrimary ? ' accent' : ''}`,
      title: `${t.name}${t.runway?.label ? `: ${t.runway.label.toLowerCase()}` : ''}`,
    }, t.short, t.distance ? ` · ${t.distance.minutes} min` : null)));
}

// "Last week at Castleton. Still at Indianapolis through Sep 4."
export function handoffLine(entry) {
  return entry.handoff ? h('div', { class: 'handoff' }, icon('handoff', { size: 14 }), ' ', entry.handoff.text) : null;
}

// ---- controls -------------------------------------------------------------
// Save (the watchlist). `words` gives it its word ("Save" / "Saved"); without,
// it's a 44px icon button. Gold once saved; aria-pressed says the same.
export function watchlistButton(entry, ctx, { words = false, onToggle } = {}) {
  let on = Boolean(entry.watchlisted || entry.flags?.watchlisted);
  const label = h('span', {});
  const btn = h('button', { class: `${words ? 'btn soft' : 'icon-btn soft'} wl-btn`, type: 'button' },
    icon('bookmark', { size: words ? 18 : 20 }), words ? label : null);
  const paint = () => {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', `Save to your watchlist: ${entry.title || 'this movie'}`);
    btn.title = on ? 'On your watchlist. Tap to take it off' : 'Save to your watchlist';
    label.textContent = on ? 'Saved' : 'Save';
  };
  paint();
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const r = await api.toggleWatchlist(entry.tmdb_id);
      on = r.watchlisted;
      paint();
      toast(on ? 'Saved to your watchlist' : 'Taken off your watchlist');
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
// `awaitDetails` asks the server to finish fetching the film's credits
// before answering (Stats sheets, which re-list the film by director/cast).
export function starRater(entry, ctx, { value = 0, onRated, size = 20, awaitDetails = false } = {}) {
  let current = value;
  const clearBtn = h('button', { class: 'link-btn rater-clear', type: 'button', title: 'Remove your rating' }, 'Clear');

  const showClear = (v) => { clearBtn.style.display = v ? '' : 'none'; };

  const persist = async (v) => {
    if (v === current) return;
    try {
      if (v) {
        await api.rate({ tmdb_id: entry.tmdb_id, rating: v, title: entry.title, year: entry.year, poster: entry.poster, genres: entry.genres, awaitDetails: awaitDetails || undefined });
        toast(withStars(`Rated ${v}★`), 'success');
      } else {
        await api.unrate(entry.tmdb_id);
        toast('Rating cleared');
      }
      current = v;
      showClear(v);
      ctx?.refreshStatus?.();
      onRated?.(v);
    } catch (err) {
      stars.setValue(current); // nothing was saved: put the stars back
      showClear(current);
      toast(err.message, 'error');
    }
  };

  const stars = makeStars({ value, interactive: true, size, allowClear: true, onChange: persist, label: entry.title ? `Your rating of ${entry.title}` : 'Your rating' });

  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    stars.setValue(0);
    persist(0);
  });

  showClear(value);
  return h('div', { class: 'rater' }, stars, clearBtn);
}

// Rating control for a card or row. Deliberately does NOT re-render the page
// on change: rating a movie marks it seen, which would drop the card out of
// the weekly 4 instantly and take the Clear button with it before you could
// undo a misclick. The list picks up the change on the next load.
function rateInline(entry, ctx) {
  return h('div', { class: 'rate-inline' },
    starRater(entry, ctx, { value: entry.myRating || 0 }));
}

// Owner and friend controls under a card or row: the stars on the left, Save
// and Not for me on the right.
export function ownerTools(entry, ctx, { onHide = null } = {}) {
  if (ctx.isGuest?.()) return null;
  return h('div', { class: 'owner-tools' },
    rateInline(entry, ctx),
    h('div', { class: 'owner-buttons' },
      watchlistButton(entry, ctx),
      onHide ? notForMeButton(entry, onHide) : null,
    ),
  );
}

// "Not for me": hides the film from every recommendation (never from the full
// list, never from the scores). `onHide(entry, card)` does the work; the card
// is the element to fade out. `words` gives it its word (the hero).
function notForMeButton(entry, onHide, { words = false } = {}) {
  const btn = h('button', {
    class: words ? 'btn danger not-for-me' : 'icon-btn danger not-for-me', type: 'button',
    'aria-label': `Not for me, hide ${entry.title}`, title: 'Not for me. Hide it from your picks',
  }, icon('eyeOff', { size: words ? 18 : 20 }), words ? h('span', {}, 'Not for me') : null);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    onHide(entry, btn.closest('.hero-pick, .pick-card, .list-row'));
  });
  return btn;
}

// ---- which showtime -------------------------------------------------------
function daySlots(entry, day) {
  const days = entry.showtimesByDay || [];
  return (day ? days.find((d) => d.date === day)?.showtimes : null) || [];
}

// Best showtime still to come on a given day: prefer one inside a preferred
// window, then IMAX, then whichever starts soonest.
function pickBest(list) {
  const live = list.filter((s) => !s.past);
  if (!live.length) return null;
  return [...live].sort((a, b) =>
    Number(b.fits_window) - Number(a.fits_window)
    || Number(b.is_imax) - Number(a.is_imax)
    || (a.start_epoch ?? 0) - (b.start_epoch ?? 0))[0];
}

// With nothing left on the chosen day: the best showing on the next day that
// has one.
function nextShowing(entry, day) {
  for (const d of entry.showtimesByDay || []) {
    if (day && d.date <= day) continue;
    const best = pickBest(d.showtimes || []);
    if (best) return best;
  }
  return null;
}

// "tonight" / "today" / "tomorrow" / "Fri", for the Book button. Evening
// listings read as tonight; a matinee today is just today.
function whenWord(st) {
  const when = dayLabel(st?.date);
  if (when === 'Today') return Number(String(st?.start_local || '').slice(11, 13)) >= 17 ? 'tonight' : 'today';
  if (when === 'Tomorrow') return 'tomorrow';
  return when;
}

// The page's one main action: "Book 11:45 AM today · IMAX". Full width, no
// chip inside. With nothing left that day, the next showing instead.
function bookButton(st) {
  if (!st) return h('span', { class: 'btn wide book', 'aria-disabled': 'true' }, 'No showtimes listed');
  const fmt = formatName(st);
  return h('a', {
    class: 'btn wide book', href: st.purchase_url || '#', target: '_blank', rel: 'noopener', title: showtimeTitle(st),
  }, `Book ${st.time} ${whenWord(st)}${fmt ? ` · ${fmt}` : ''}`);
}

// "Seat by 12:05 PM · out around 3:06 PM", and the calendar button at its end.
export function seatLine(st) {
  if (!st) return null;
  const bits = [st.be_there_by ? `Seat by ${st.be_there_by}` : null, st.end ? `out around ${st.end}` : null].filter(Boolean);
  if (!bits.length && !st.id) return null;
  const words = bits.join(' · ');
  return h('div', { class: 'seat-line' },
    h('span', {}, words.charAt(0).toUpperCase() + words.slice(1)),
    st.id && !st.past ? calendarButton(st) : null);
}

// "Next: Fri 7:00 PM" and its Book link, for a card or row with nothing on
// the chosen day. With nothing later either, says so.
function nextLine(entry, day) {
  const st = nextShowing(entry, day);
  if (!st) {
    const when = dayLabel(day);
    return h('p', { class: 'next-line muted' }, !when ? 'No showtimes listed' : `No showtimes ${/^(Today|Tomorrow)$/.test(when) ? when.toLowerCase() : `on ${when}`}`);
  }
  const fmt = formatName(st);
  return h('p', { class: 'next-line' },
    h('span', {}, `Next: ${dayLabel(st.date)} ${st.time}${fmt ? ` · ${fmt}` : ''}`),
    h('a', { class: 'st-book', href: st.purchase_url || '#', target: '_blank', rel: 'noopener', 'aria-label': `Book ${dayLabel(st.date)} ${st.time}` }, 'Book', icon('arrowRight', { size: 14 })));
}

// ---- art --------------------------------------------------------------------
// Backdrop art with a graceful fall-through: the backdrop, then the poster
// itself, then nothing (the glow and the page carry it).
export function heroMedia(m, { cls = 'hero-media' } = {}) {
  const wrap = h('div', { class: cls });
  const usePoster = () => {
    if (!m.poster) { wrap.classList.add('plain'); return; }
    wrap.classList.add('from-poster');
    const img = h('img', { class: 'hero-poster', src: m.poster, alt: '', 'aria-hidden': 'true' });
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

// ---- the #1 pick ------------------------------------------------------------
export function heroPick(entry, ctx, { day = null, multi = 0, onHide = null, movedUp = false, rank = 1 } = {}) {
  const st = pickBest(daySlots(entry, day)) || nextShowing(entry, day);
  const guest = ctx.isGuest?.();
  const tags = filmTags(entry, { movedUp, max: 3, noScores: false });
  tags?.classList.add('one-line');
  return h('section', { class: 'hero-pick', 'aria-labelledby': `hero-${entry.tmdb_id}` },
    heroMedia(entry),
    h('div', { class: 'hero-content' },
      h('div', { class: 'hero-line' }, h('span', {}, `#${rank} this week`), matchBadge(entry.final, { early: entry.flags?.noScores })),
      h('h1', { class: 'hero-title', id: `hero-${entry.tmdb_id}` },
        h('a', { href: `#/movie/${entry.tmdb_id}` }, entry.title)),
      metaLine(entry) ? h('p', { class: 'hero-meta' }, metaLine(entry)) : null,
      tags,
      reasonLine(entry, ctx, { cls: 'reason-line hero-reason', lastChance: entry.runway?.urgent }),
      runwayLine(entry.runway),
      theatreChips(entry, { multi }),
      handoffLine(entry),
      h('div', { class: 'hero-actions' },
        bookButton(st),
        h('div', { class: `hero-buttons${guest ? ' one' : ''}` },
          h('a', { class: 'btn soft', href: `#/movie/${entry.tmdb_id}` }, 'Details'),
          guest ? null : watchlistButton(entry, ctx, { words: true }),
          onHide && !guest ? notForMeButton(entry, onHide, { words: true }) : null,
        ),
      ),
      seatLine(st),
      // I'm going (this showing) and Send, or the plan (js/social.js).
      guest ? null : heroPlan(entry, st, ctx),
    ),
  );
}

// ---- picks 2 to 4 -------------------------------------------------------------
// Poster on the left with the title, match, facts and reason beside it; the
// day's showtime and the controls below, across the whole card.
export function weeklyCard(entry, ctx, rank, { day = null, multi = 0, onHide = null, movedUp = false } = {}) {
  const best = pickBest(daySlots(entry, day));
  const meta = metaLine(entry) || (entry.genres || []).slice(0, 3).join(' · ');
  return h('article', { class: 'pick-card', 'data-id': entry.tmdb_id },
    h('div', { class: 'pc-top' },
      h('a', { class: 'pick-poster', href: `#/movie/${entry.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' },
        poster(entry, { size: 'card', link: false })),
      h('div', { class: 'pick-body' },
        h('h3', { class: 'pick-head' },
          rank ? h('span', { class: 'pick-rank' }, h('span', { class: 'sr-only' }, 'Number '), String(rank), h('span', { class: 'sr-only' }, ': ')) : null,
          h('a', { class: 'pick-title', href: `#/movie/${entry.tmdb_id}` }, entry.title)),
        matchBadge(entry.final, { early: entry.flags?.noScores }),
        meta ? h('p', { class: 'pick-meta' }, meta) : null,
        filmTags(entry, { movedUp, noScores: false }),
        reasonLine(entry, ctx, { lastChance: entry.runway?.urgent }),
        runwayLine(entry.runway, { compact: true }),
        theatreChips(entry, { multi }),
        handoffLine(entry),
        ctx.isGuest?.() ? null : goingLine(entry.tmdb_id),
      ),
    ),
    h('div', { class: 'pc-times' }, best ? showtimeRow(best) : nextLine(entry, day)),
    ownerTools(entry, ctx, { onHide }),
  );
}

// ---- the full lists -------------------------------------------------------------
// Day selector for the whole page: weekday over the date number, like a
// calendar strip. The chosen day fills with the accent; the strip fades at
// its right edge while more days are off screen.
export function dayPicker(days, selected, onSelect) {
  const bar = h('div', { class: 'day-picker', role: 'group', 'aria-label': 'Choose a day' });
  const wrap = h('div', { class: 'day-strip' }, bar);
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
  const fade = () => wrap.classList.toggle('more', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2);
  bar.addEventListener('scroll', fade, { passive: true });
  new ResizeObserver(fade).observe(bar);
  return wrap;
}

// A ranked row with the chosen day's best showtime. Not a link itself (it
// holds a Book link and buttons); the poster and title carry the navigation.
// compact: no reason line (Everything playing). multi: how many theaters are
// followed (0 for one); the times panel then groups by theater. nearby: the
// row is in "Also nearby", about a theater other than the primary. onHide adds
// Not for me; onUnhide, on a hidden film, the Unhide link. tools adds the
// stars and Save (Also worth seeing).
export function movieRow(entry, ctx, { day = null, compact = false, multi = 0, nearby = false, onHide = null, onUnhide = null, tools = false } = {}) {
  const hidden = Boolean(entry.flags?.hidden);
  const owner = !ctx.isGuest?.();
  const slots = daySlots(entry, day);
  const next = pickBest(slots);

  const groups = multi
    ? (entry.theatres || [])
      .map((t) => ({ theatre: t, slots: t.showtimesByDay ? daySlots(t, day) : slots }))
      .filter((g) => g.slots.length)
    : (slots.length ? [{ theatre: null, slots }] : []);
  const total = groups.reduce((n, g) => n + g.slots.length, 0);

  const panel = h('div', { class: 'row-expand row-wide', hidden: true });
  let built = false;
  const label = (n) => `All times (${n})`;
  const toggle = h('button', { class: 'btn soft small row-more row-wide', type: 'button', 'aria-expanded': 'false' }, label(total));
  toggle.addEventListener('click', () => {
    if (!built) {
      built = true;
      for (const g of groups) {
        if (g.theatre) {
          panel.appendChild(h('div', { class: 'fmt-theatre' },
            g.theatre.short,
            g.theatre.distance ? h('span', { class: 'muted' }, g.theatre.distance.label) : null,
            runwayBadge(g.theatre.runway),
          ));
        }
        panel.appendChild(h('div', { class: 'st-list' }, ...[...g.slots].sort((a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0)).map((st) => showtimeRow(st))));
      }
    }
    const opening = panel.hidden;
    panel.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    toggle.textContent = opening ? 'Hide times' : label(total);
  });

  const tags = compact
    ? [backBadge(entry), opensBadge(entry), entry.flags?.noScores ? badge('No scores yet') : null]
    : [entry.flags?.imax ? badge('IMAX', 'imax') : null, backBadge(entry), entry.runway?.urgent ? badge('Last chance', 'last') : null, opensBadge(entry),
      entry.flags?.excluded ? badge('Filtered') : null, entry.flags?.settling ? badge('Scores settling') : null, entry.flags?.seen ? badge('Seen') : null];

  return h('div', { class: `list-row${entry.flags?.excluded ? ' excluded' : ''}${entry.flags?.seen ? ' seen' : ''}${hidden ? ' is-hidden' : ''}` },
    h('a', { class: 'row-poster', href: `#/movie/${entry.tmdb_id}`, tabindex: '-1', 'aria-hidden': 'true' }, poster(entry, { size: 'sm', link: false })),
    h('div', { class: 'row-body' },
      h('div', { class: 'row-head' },
        h('a', { class: 'row-title', href: `#/movie/${entry.tmdb_id}` },
          entry.title, h('span', { class: 'row-year' }, entry.year ? ` ${entry.year}` : '')),
        owner && onHide && !hidden ? notForMeButton(entry, onHide) : null,
      ),
      h('div', { class: 'row-match' }, matchBadge(entry.final, { early: entry.flags?.noScores }),
        hidden ? badge('Hidden', 'hidden') : null,
        hidden && owner && onUnhide ? h('button', {
          class: 'link-btn', type: 'button', 'aria-label': `Unhide ${entry.title}`,
          onClick: (e) => { e.currentTarget.disabled = true; onUnhide(entry); },
        }, 'Unhide') : null),
      compact ? null : reasonLine(entry, ctx, { cls: 'reason-line row-reason' }),
      tags.some(Boolean) ? h('div', { class: 'tag-row' }, ...tags) : null,
      runwayLine(entry.runway, { theatre: nearby ? entry.theatre : null, compact: true }),
      theatreChips(entry, { multi }),
      handoffLine(entry),
      owner && !compact ? goingLine(entry.tmdb_id) : null,
    ),
    h('div', { class: 'row-wide' }, next ? showtimeRow(next) : nextLine(entry, day)),
    total > 1 ? toggle : null,
    panel,
    tools ? h('div', { class: 'row-wide' }, ownerTools(entry, ctx)) : null,
  );
}

// "Last chance" tile: scores well and is actually about to leave. Only a
// confirmed end date gets the red "Leaving Fri"; anything hedged keeps its
// runway words, quiet.
export function lastChanceCard(entry, ctx) {
  const committed = !entry.runway || entry.runway.kind === 'ending';
  const days = entry.daysLeft ?? entry.runway?.daysLeft ?? null;
  const when = days != null && days <= 0 ? 'Last day today'
    : days === 1 ? 'Leaving tomorrow'
    : `Leaving ${new Date(`${entry.lastDate || entry.runway?.lastDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}`;
  const onList = entry.watchlisted;
  return h('a', { class: `lc-card${committed ? ' committed' : ' hedged'}`, href: `#/movie/${entry.tmdb_id}` },
    h('div', { class: 'lc-poster' }, poster(entry, { size: 'grid', link: false }),
      onList ? h('span', { class: 'lc-saved', title: ctx?.isGuest?.() ? 'On the watchlist' : 'On your watchlist' }, icon('bookmark', { size: 14, label: 'Saved' })) : null),
    committed
      ? h('span', { class: 'tag last lc-when', title: entry.lastLabel || '' }, when)
      : h('span', { class: 'lc-hedge', title: entry.runway?.detail || entry.runway?.label || '' }, entry.runway?.label || entry.lastLabel),
    h('div', { class: 'lc-title' }, entry.title),
    h('div', { class: 'lc-meta' }, matchBadge(entry.final),
      committed && entry.leftLabel ? h('span', { class: 'lc-left' }, entry.leftLabel, entry.signal === 'shrinking' ? ' · schedule shrinking' : null) : null),
    entry.handoff ? h('div', { class: 'lc-handoff' }, icon('handoff', { size: 13 }), ' ', entry.handoff.text) : null,
  );
}

// Poster tile with a caption (Coming soon, Watchlist). The art stays clean:
// the match and tags sit under it, and only a control (`corner`, the Save
// button) sits on the poster.
export function posterTile(movie, { corner, caption, sub, tags } = {}) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-poster' },
      h('a', { class: 'tile-link', href: `#/movie/${movie.tmdb_id}`, 'aria-label': movie.title }, poster(movie, { size: 'grid', link: false })),
      corner || null),
    h('a', { class: 'tile-cap', href: `#/movie/${movie.tmdb_id}`, tabindex: '-1' }, caption || movie.title),
    tags ? h('div', { class: 'tile-tags' }, tags) : null,
    sub ? h('div', { class: 'tile-sub' }, sub) : null,
  );
}

// Every hidden ("Not for me") film, each with its way back: from the Picks
// page and from Settings. `unhide(film)` does the work (and says so).
export async function openHiddenList(unhide) {
  const body = h('div', { class: 'hidden-list' }, spinner());
  const modal = openModal(body, { title: 'Hidden films' });
  try {
    const { movies } = await api.hidden();
    clear(body);
    if (!movies.length) { body.appendChild(h('p', { class: 'muted' }, 'Nothing is hidden.')); return; }
    body.appendChild(h('p', { class: 'muted small' }, 'These stay out of your picks until you unhide them. Their scores are unchanged.'));
    for (const m of movies) {
      const row = h('div', { class: 'hidden-row' },
        h('span', { class: 'hidden-name' }, icon('eyeOff', { size: 16, cls: 'hidden-icon' }),
          h('a', { class: 'hidden-title', href: `#/movie/${m.tmdb_id}`, onClick: () => modal.close() }, m.title || `Movie ${m.tmdb_id}`)),
        h('button', {
          class: 'btn soft small', type: 'button', 'aria-label': `Unhide ${m.title}`,
          onClick: async (e) => {
            e.currentTarget.disabled = true;
            await unhide({ tmdb_id: m.tmdb_id, title: m.title });
            row.remove();
            if (!body.querySelector('.hidden-row')) modal.close();
          },
        }, 'Unhide'),
      );
      body.appendChild(row);
    }
  } catch (e) {
    clear(body);
    body.appendChild(h('p', { class: 'muted' }, e.message));
  }
}
