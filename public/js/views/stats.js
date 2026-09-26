// Stats: A-List usage, savings, ratings, recommendation hit-rate + tuning tip.
import { api } from '../api.js';
import { h, clear, spinner, money, pct, makeStars, toast, sectionTitle, openModal, icon } from '../ui.js';
import { starRater, watchlistButton, opensBadge } from './components.js';
import { filterBox } from '../filter.js';
import { streamLine, CREDIT } from '../stream.js';

// Re-draws the page in place after a sheet changed a rating: no spinner, same
// scroll position, same "Show all" lists open, focus back on the row.
let repaint = null;

export async function render(root, params, ctx, { quiet = false } = {}) {
  repaint = async (kind, name) => {
    const y = window.scrollY;
    await render(root, params, ctx, { quiet: true });
    window.scrollTo(0, y);
    [...root.querySelectorAll(`#top-${kind} .bar-row`)]
      .find((b) => b.querySelector('.bar-name')?.textContent === name)?.focus({ preventScroll: true });
  };
  if (!quiet) {
    expanded.clear();
    clear(root);
    root.appendChild(spinner('Crunching numbers…'));
  }
  const [s, week] = await Promise.all([api.stats(), api.alist()]);
  clear(root);

  const page = h('div', { class: 'page' });

  page.appendChild(sectionTitle('This A-List week', `Resets Friday · week of ${week.weekStart}`, { level: 1 }));
  page.appendChild(h('div', { class: 'stat-grid' },
    bigStat(`${week.used}/${week.limit}`, 'reservations used', `${week.remaining} left`),
    bigStat(money(week.savings.saved), 'saved this month', `${week.savings.monthTickets} tickets vs ${money(week.savings.alistFee)} fee`),
    bigStat(money(week.savings.ticketValue), 'ticket value seen', 'this month'),
  ));
  if (week.movies.length) page.appendChild(watchLog(week.movies, ctx));

  page.appendChild(sectionTitle('Your year', String(s.year)));
  page.appendChild(h('div', { class: 'stat-grid' },
    // Only films logged as seen (Mark seen / A-List), not imported ratings.
    bigStat(s.seenThisYear, 'seen in theaters', 'logged this year'),
    bigStat(s.totalRatings, 'ratings', 'in your profile'),
    bigStat(s.avgRating != null ? `${s.avgRating}★` : '–', 'average rating', ''),
    bigStat(s.hitRate != null ? pct(s.hitRate) : '–', 'pick hit-rate', s.ratedPicks ? `of ${s.ratedPicks} picks watched` : 'rate your picks'),
  ));

  if (s.suggestion) {
    const tip = h('div', { class: 'alert tip' },
      h('span', { class: 'alert-icon' }, icon('target', { size: 18 })),
      h('span', {}, s.suggestion.text),
    );
    if (s.suggestion.weightTaste != null) {
      tip.appendChild(h('button', { class: 'btn small', onClick: async () => {
        await api.saveSettings({ weightPublic: s.suggestion.weightPublic, weightTaste: s.suggestion.weightTaste });
        toast('Weights updated', 'success');
      } }, 'Apply'));
    }
    page.appendChild(tip);
  }

  const ranked = "ranked by films you've rated";
  if (s.topGenres.length) page.appendChild(topList('Top genres', ranked, s.topGenres, 'genre', ctx));
  if (s.topDirectors.length) page.appendChild(topList('Top directors', ranked, s.topDirectors, 'director', ctx));
  if (s.topActors.length) page.appendChild(topList('Top actors', ranked, s.topActors, 'actor', ctx));
  // Imported films arrive with genres only; director and cast follow in the
  // background. Say so while it's happening, so a short list isn't a mystery.
  if (s.backfilling && s.detailsPending > 0) {
    page.appendChild(h('div', { class: 'muted small pad' },
      `Still loading details for ${s.detailsPending} of your film${s.detailsPending === 1 ? '' : 's'}`));
  }
  if (!s.totalRatings) {
    page.appendChild(h('div', { class: 'muted pad' }, 'Rate some movies to unlock genre/director insights and personalized picks.'));
  }

  root.appendChild(page);
}

// This week's logged entries, each removable. The server has always had the
// delete; nothing reached it, so an accidental "Mark seen" could only be undone
// in SQLite. Removal only — dates and rewatches are not editable here.
function watchLog(movies, ctx) {
  const list = h('div', { class: 'theatre-list' });
  for (const m of movies) {
    list.appendChild(h('div', { class: 'theatre-item' },
      h('div', { class: 'ti-main' },
        h('div', { class: 'ti-name' }, m.title || `Movie ${m.tmdb_id}`),
        h('div', { class: 'muted small' }, watchedLabel(m.watched_at)),
      ),
      h('div', { class: 'ti-actions' },
        h('button', {
          class: 'btn ghost small', type: 'button', title: 'Remove from your watch log',
          'aria-label': `Remove ${m.title || 'this movie'} from your watch log`,
          onClick: () => confirmRemove(m, ctx),
        }, icon('x', { size: 16 })),
      ),
    ));
  }
  return list;
}

function confirmRemove(m, ctx) {
  const modal = openModal(h('div', { class: 'confirm' },
    h('p', {}, `Remove ${m.title || 'this movie'} from your watch log?`),
    h('p', { class: 'muted small' }, 'It stops counting toward this week\'s three reservations, this month\'s savings, and the pick hit-rate. Your rating, if you left one, is not touched.'),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onClick: async () => {
        modal.close();
        try {
          await api.undoWatched(m.id);
          toast('Removed from your watch log', 'success');
          ctx?.refreshStatus?.();
          ctx?.rerender?.();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Remove'),
      h('button', { class: 'btn ghost', onClick: () => modal.close() }, 'Cancel'),
    ),
  ), { title: 'Remove watch entry' });
}

function watchedLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Logged';
  return `Logged ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

function bigStat(value, label, sub) {
  return h('div', { class: 'big-stat' },
    h('div', { class: 'bs-value' }, value),
    h('div', { class: 'bs-label' }, label),
    sub ? h('div', { class: 'bs-sub' }, sub) : null,
  );
}

const filmsLabel = (n, avg) => `${n} film${n === 1 ? '' : 's'} · ${avg.toFixed(1)}★`;

// One numbered row per entry: "2 films · 4.5★" (the user's own average).
// Each row is a button that opens the films behind it.
function barList(items, id, kind, ctx) {
  return h('ol', { class: 'bar-list', id }, ...items.map((it, i) => {
    const btn = h('button', {
      class: 'bar-row', type: 'button', 'aria-haspopup': 'dialog',
      'aria-label': `${i + 1}. ${it.name}: ${it.n} film${it.n === 1 ? '' : 's'}, average ${it.avg.toFixed(1)} stars. Show the films`,
    },
      h('span', { class: 'bar-rank', 'aria-hidden': 'true' }, String(i + 1)),
      h('span', { class: 'bar-name' }, it.name),
      makeStars({ value: it.avg, size: 14 }),
      h('span', { class: 'bar-meta' }, filmsLabel(it.n, it.avg)),
      icon('chevronRight', { size: 16, cls: 'row-chevron' }),
    );
    btn.addEventListener('click', () => openGroup(kind, it, ctx));
    return h('li', { class: 'bar-item' }, btn);
  }));
}

// A small TMDB thumbnail: the list only ever shows 40px posters.
const thumb = (url) => (url ? url.replace(/\/w\d+\//, '/w92/') : null);

const thumbOf = (f) => (f.poster
  ? h('img', { class: 'sheet-thumb', src: thumb(f.poster), alt: '', loading: 'lazy', decoding: 'async', width: '40', height: '60' })
  : h('span', { class: 'sheet-thumb sheet-noposter', 'aria-hidden': 'true' }, icon('film', { size: 18 })));

// The sheet for one row, in two parts. "You rated": every film the user rated
// in that genre / by that person, best-rated first; the count comes from the
// same server-side counting as the row. Below it, loading on its own so the
// sheet opens at once: "More from <person>" (their filmography) or "<Genre>
// playing now", each film rateable in place. A film rated there moves up into
// "You rated", and the Stats page behind is redrawn when the sheet closes.
function openGroup(kind, it, ctx) {
  const sub = h('p', { class: 'sheet-sub' }, filmsLabel(it.n, it.avg));
  const rated = h('div', { class: 'sheet-part sheet-rated' }, spinner('Loading films…'));
  const more = h('section', { class: 'sheet-part sheet-more', 'aria-labelledby': `sheet-more-${kind}` });
  let changed = false;
  // More than FILTER_AT films in the sheet and a filter box goes on top. It
  // matches titles, and directors and actors where the film has them.
  const filter = filterBox({ label: `Filter films: ${it.name}`, placeholder: 'Filter by title, director or actor', onChange: (r) => onFilter(r) });
  filter.el.hidden = true;
  const modal = openModal(h('div', { class: 'sheet' }, sub, filter.el, rated, more), {
    title: it.name,
    onClose: () => { if (changed) repaint?.(kind, it.name).catch(() => ctx?.rerender?.()); },
  });
  const close = () => modal.close();

  let ratedIds = new Set();
  let ratedRows = [];
  const refreshFilter = () => {
    const moreRows = [...more.querySelectorAll('.more-film')].map((el) => ({ el, fields: el._fields }));
    const all = [...ratedRows, ...moreRows];
    if (all.length > FILTER_AT) filter.el.hidden = false;
    filter.set(all);
  };
  const onFilter = ({ query }) => {
    // A section with nothing left says nothing; the filter's own line covers "none at all".
    const anyIn = (el) => [...el.querySelectorAll('.sheet-film')].some((r) => !r.hidden);
    rated.hidden = Boolean(query) && !anyIn(rated);
    more.hidden = Boolean(query) && !anyIn(more);
    // A match in the folded "smaller films" opens it.
    if (query && smallerList?.hidden && [...smallerList.children].some((r) => !r.hidden)) { smallerList.hidden = false; paintSmaller(); }
  };
  const paintRated = (g) => {
    ratedIds = new Set(g.films.map((f) => f.tmdb_id));
    sub.textContent = filmsLabel(g.n, g.avg);
    clear(rated);
    rated.appendChild(h('h4', { class: 'sheet-head' }, 'You rated'));
    if (!g.films.length) { rated.appendChild(h('p', { class: 'muted' }, 'No films here any more.')); return; }
    const list = h('ul', { class: 'sheet-films', 'aria-label': `Films you rated: ${it.name}` });
    const frag = document.createDocumentFragment();
    ratedRows = [];
    for (const f of g.films) {
      const li = frag.appendChild(h('li', { class: 'sheet-film' },
        h('a', { href: `#/movie/${f.tmdb_id}`, onClick: close },
          thumbOf(f),
          h('span', { class: 'sheet-title' }, f.title, f.year ? h('span', { class: 'sheet-year' }, ` ${f.year}`) : null),
          h('span', { class: 'sheet-rating', 'aria-label': `your rating ${f.rating} stars` },
            makeStars({ value: f.rating, size: 13 }), h('span', { 'aria-hidden': 'true' }, `${f.rating}★`)),
        )));
      ratedRows.push({ el: li, fields: [f.title, f.director, ...(f.cast || [])] });
    }
    list.appendChild(frag);
    rated.appendChild(list);
    refreshFilter();
  };
  const loadRated = () => api.statsGroup(kind, it.name).then(paintRated, (e) => {
    clear(rated);
    rated.appendChild(h('p', { class: 'muted' }, e.message));
  });
  const ratedReady = loadRated();

  // Second section.
  const heading = kind === 'genre' ? `${it.name} playing now` : `More from ${it.name}`;
  more.appendChild(h('h4', { class: 'sheet-head', id: `sheet-more-${kind}` }, heading));
  const status = h('p', { class: 'muted small sheet-status', role: 'status' },
    kind === 'genre' ? 'Checking your theaters…' : 'Loading films from TMDB…');
  more.appendChild(status);

  const onRated = async (f, row, v) => {
    changed = true;
    if (!v) return;
    await loadRated();
    if (!ratedIds.has(f.tmdb_id)) return; // rated, but not counted under this row (e.g. a small role)
    const list = row.parentElement;
    // Rated from the keyboard: the stars of the next film (or the one before)
    // take focus, instead of it falling out of the sheet with the row.
    const hadFocus = row.contains(document.activeElement);
    const nextStars = (row.nextElementSibling || row.previousElementSibling)?.querySelector('.stars.interactive');
    row.remove();
    if (list && !list.children.length) list.remove();
    if (hadFocus) (nextStars || more.closest('.modal-card'))?.focus();
    paintSmaller();
    if (!more.querySelector('.more-film')) { status.textContent = emptyLine; status.hidden = false; }
  };

  // Films from a person's career that aren't in theaters get a small "Stream
  // on …" line; the section then ends with the JustWatch credit. A genre's
  // list is what's playing now, so it has none.
  const credit = h('p', { class: 'stream-credit more-credit', hidden: true }, CREDIT);
  const moreRow = (f) => {
    const row = h('li', { class: 'sheet-film more-film' });
    const stream = kind === 'genre' ? null
      : streamLine(f.tmdb_id, row, { cls: 'stream-line more-stream', onShown: () => { credit.hidden = false; } });
    row._fields = [f.title, f.director, ...(f.cast || [])];
    // The server leaves tmdb_rating null when it rests on too few votes or the film isn't out in the US yet.
    const tmdbLine = f.tmdb_rating > 0
      ? h('span', { class: 'more-tmdb', 'aria-label': `TMDB ${f.tmdb_rating.toFixed(1)} out of 10` }, `TMDB ${f.tmdb_rating.toFixed(1)}`)
      : h('span', { class: 'more-tmdb' }, 'No TMDB rating yet');
    row.append(
      h('a', { class: 'more-link', href: `#/movie/${f.tmdb_id}`, onClick: close },
        thumbOf(f),
        h('span', { class: 'more-text' },
          h('span', { class: 'sheet-title' }, f.title, f.year ? h('span', { class: 'sheet-year' }, ` ${f.year}`) : null),
          h('span', { class: 'more-meta' }, tmdbLine, opensBadge(f)),
          stream,
        ),
      ),
      h('div', { class: 'more-tools' },
        starRater(f, ctx, { value: f.myRating || 0, size: 18, awaitDetails: true, onRated: (v) => onRated(f, row, v) }),
        watchlistButton(f, ctx, { compact: true }),
      ),
    );
    return row;
  };
  const moreList = (films, label) => {
    const list = h('ul', { class: 'sheet-films more-films', 'aria-label': label });
    list.append(...films.map(moreRow));
    return list;
  };

  let smallerBtn = null;
  let smallerList = null;
  const paintSmaller = () => {
    if (!smallerBtn) return;
    const n = smallerList.children.length;
    if (!n) { smallerBtn.remove(); smallerList.remove(); smallerBtn = null; return; }
    const open = !smallerList.hidden;
    smallerBtn.textContent = open ? 'Hide smaller films' : `Show smaller films (${n})`;
    smallerBtn.setAttribute('aria-expanded', String(open));
  };
  const emptyLine = kind === 'genre'
    ? `No other ${it.name.toLowerCase()} films at your theaters right now.`
    : 'No other films to show.';

  api.statsMore(kind, it.name).then(async (m) => {
    await ratedReady; // keep "You rated" first on screen
    status.textContent = '';
    if (m.films.length) more.appendChild(moreList(m.films, heading));
    if (m.smaller.length) {
      smallerList = moreList(m.smaller, `${heading}: smaller films`);
      smallerList.id = `sheet-smaller-${kind}`;
      smallerList.hidden = true;
      smallerBtn = h('button', { class: 'btn ghost small show-all', type: 'button', 'aria-controls': smallerList.id });
      smallerBtn.addEventListener('click', () => { smallerList.hidden = !smallerList.hidden; paintSmaller(); });
      more.append(smallerBtn, smallerList);
      paintSmaller();
    }
    more.appendChild(credit);
    if (!m.films.length && !m.smaller.length) status.textContent = m.unknownPerson ? "Couldn't find this person on TMDB." : emptyLine;
    else status.hidden = true;
    refreshFilter();
  }, (e) => {
    status.textContent = e.message;
    status.classList.add('sheet-error');
  });
}

// A ranked list showing its first TOP rows, with "Show all (N)" underneath
// to expand to the rest when the server sent more (for people, that's only
// those with 2+ films).
const TOP = 10;
const FILTER_AT = 12; // a drill-down sheet with more films than this gets a filter box
const expanded = new Set(); // lists opened with "Show all", kept across repaints
function topList(title, sub, items, key, ctx) {
  const id = `top-${key}`;
  const list = barList(items, id, key, ctx);
  const extra = [...list.children].slice(TOP);
  const wrap = h('section', { class: 'stat-list' }, sectionTitle(title, sub), list);
  if (!extra.length) return wrap;
  let open = expanded.has(key);
  const btn = h('button', { class: 'btn ghost small show-all', type: 'button', 'aria-controls': id });
  // With every row showing, a filter box sits between the heading and the list.
  const filter = filterBox({ label: `Filter ${title.toLowerCase()}`, placeholder: `Filter ${items.length} ${title.replace(/^Top /, '')}` });
  const rows = [...list.children].map((li, i) => ({ el: li, fields: [items[i].name] }));
  wrap.insertBefore(filter.el, list);
  const paint = () => {
    filter.reset();
    filter.el.hidden = !open;
    for (const row of extra) row.hidden = !open;
    if (open) filter.set(rows);
    btn.textContent = open ? 'Show fewer' : `Show all (${items.length})`;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => {
    open = !open;
    if (open) expanded.add(key); else expanded.delete(key);
    paint();
  });
  paint();
  wrap.appendChild(btn);
  return wrap;
}
