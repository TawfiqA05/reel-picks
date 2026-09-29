// A person's page (#/person/<id>): their films playing at your theaters this
// week, the ones you rated, then the rest of their career, most popular first,
// with a Directed / Acted switch for someone who has done both. Every film can
// be rated and saved right there, with the same controls as a Stats sheet. The
// guest link only reads: no stars, no Save, and no one's ratings.
import { api } from '../api.js';
import { h, clear, spinner, icon, emptyState } from '../ui.js';
import { starRater, watchlistButton, opensBadge } from './components.js';
import { streamLine, CREDIT } from '../stream.js';
import { noteSlot, noteLine } from '../notes.js';

const thumb = (url) => (url ? url.replace(/\/w\d+\//, '/w92/') : null);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function render(root, params, ctx) {
  clear(root);
  root.appendChild(spinner('Loading…'));
  const guest = ctx.isGuest?.();
  const d = await api.person(params[0]);
  clear(root);
  const p = d.person;

  const page = h('div', { class: 'page person' });
  const directedAll = d.directed.length;
  const actedAll = d.acted.length + d.actedSmaller.length;
  page.appendChild(h('header', { class: 'person-head' },
    p.photo
      ? h('img', { class: 'person-photo', src: p.photo, alt: '', width: '88', height: '88', decoding: 'async' })
      : h('span', { class: 'person-photo person-nophoto', 'aria-hidden': 'true' }, icon('user', { size: 36 })),
    h('div', { class: 'person-who' },
      h('h1', { class: 'person-name' }, p.name),
      p.role ? h('p', { class: 'person-role' }, p.role) : null)));

  // Films playing get no "Stream on" line; everything else can, once the
  // row is on screen (not on the guest link, which can't ask for it).
  const credit = h('p', { class: 'stream-credit group-foot', hidden: true }, CREDIT);
  const lists = {}; // section key -> its <ul>, for moving a rated film up

  // One film: poster, title and year, TMDB's rating, and the controls. A film
  // rated here gets "Add a note" after its stars; in You rated, your note is a
  // short second line under the title.
  const row = (f, where, { fresh = false } = {}) => {
    const li = h('li', { class: 'sheet-film more-film' });
    const tmdbLine = f.tmdb_rating > 0
      ? h('span', { class: 'more-tmdb', 'aria-label': `TMDB ${f.tmdb_rating.toFixed(1)} out of 10` }, `TMDB ${f.tmdb_rating.toFixed(1)}`)
      : h('span', { class: 'more-tmdb' }, 'No TMDB rating yet');
    const stream = guest || f.playing ? null
      : streamLine(f.tmdb_id, li, { cls: 'stream-line more-stream', onShown: () => { credit.hidden = false; } });
    const inner = [
      f.poster
        ? h('img', { class: 'sheet-thumb', loading: 'lazy', decoding: 'async', src: thumb(f.poster), alt: '', width: '40', height: '60' })
        : h('span', { class: 'sheet-thumb sheet-noposter', 'aria-hidden': 'true' }, icon('film', { size: 18 })),
      h('span', { class: 'more-text' },
        h('span', { class: 'sheet-title' }, f.title, f.year ? h('span', { class: 'sheet-year' }, ` ${f.year}`) : null),
        h('span', { class: 'more-meta' }, tmdbLine, opensBadge(f)),
        where === 'rated' ? noteLine(f.myNote) : null,
        stream),
    ];
    // The guest link opens only films the app already has; any other would
    // be a dead end for it.
    li.append(!guest || f.stored ? h('a', { class: 'more-link', href: `#/movie/${f.tmdb_id}` }, ...inner) : h('div', { class: 'more-link' }, ...inner));
    if (!guest) {
      const note = noteSlot(f, { rated: Boolean(f.myRating) });
      if (fresh && !f.myNote) note.rated(f.myRating);
      // A rating changed where the film stays: Add a note, unless it has one.
      // Cleared: the note went with the rating.
      const rerated = (v) => {
        if (!v) { f.myNote = null; li.querySelector('.note-line')?.remove(); note.rated(0); } else if ((where === 'playing' || where === 'rated') && !f.myNote) note.rated(v);
        onRated(f, li, where, v);
      };
      li.append(h('div', { class: 'more-tools' },
        starRater(f, ctx, { value: f.myRating || 0, size: 18, awaitDetails: true, onRated: (v) => rerated(v) }),
        watchlistButton(f, ctx)), note.el);
      li.addEventListener('note-change', (e) => { f.myNote = e.detail?.note || null; });
    }
    return li;
  };
  const filmList = (films, where, label) => {
    const ul = h('ul', { class: 'sheet-films person-films', 'aria-label': label });
    ul.append(...films.map((f) => row(f, where)));
    return ul;
  };
  const part = (id, title, sub, ...body) => h('section', { class: 'group person-part', 'aria-labelledby': id },
    h('div', { class: 'group-head' }, h('h2', { class: 'group-title', id }, title), sub != null ? h('span', { class: 'section-sub' }, sub) : null),
    ...body);

  // Playing now: at the viewer's own theaters this week.
  if (d.playing.length) {
    lists.playing = filmList(d.playing, 'playing', `${p.name}: playing now`);
    page.appendChild(part('person-playing', 'Playing now', guest ? 'In theaters this week' : 'At your theaters this week',
      h('div', { class: 'group-body' }, lists.playing)));
  }

  // You rated: made on first use when there's none yet, so a film rated
  // further down has somewhere to go.
  let ratedPart = null;
  const ratedSub = () => count(lists.rated.children.length, 'film');
  const ensureRated = () => {
    if (ratedPart) return;
    lists.rated = filmList([], 'rated', `${p.name}: films you rated`);
    ratedPart = part('person-rated', 'You rated', '', h('div', { class: 'group-body' }, lists.rated));
    page.insertBefore(ratedPart, filmsPart);
  };
  const paintRatedSub = () => { ratedPart.querySelector('.section-sub').textContent = ratedSub(); };

  // Their other films, one list per kind of work, with a switch when both.
  const kinds = [
    { key: 'directed', label: 'Directed', films: d.directed, smaller: [] },
    { key: 'acted', label: 'Acted', films: d.acted, smaller: d.actedSmaller },
  ].filter((k) => k.films.length || k.smaller.length);
  let shown = kinds.find((k) => k.key === (p.department === 'Directing' ? 'directed' : 'acted')) || kinds[0];
  const filmsBody = h('div', { class: 'group-body' });
  const toggle = kinds.length > 1 ? h('div', { class: 'segmented person-toggle', role: 'group', 'aria-label': `${p.name}'s films` }) : null;
  const filmsPart = part('person-films', 'Films', 'Most popular first',
    toggle, filmsBody, credit);
  page.appendChild(filmsPart);

  for (const k of kinds) {
    k.list = filmList(k.films, k.key, `${p.name}: films ${k.label.toLowerCase()}`);
    if (k.smaller.length) {
      k.smallerList = filmList(k.smaller, k.key, `${p.name}: smaller films ${k.label.toLowerCase()}`);
      k.smallerList.hidden = true;
      k.smallerList.id = `person-smaller-${k.key}`;
      k.moreBtn = h('button', { class: 'btn soft small show-all', type: 'button', 'aria-controls': k.smallerList.id });
      k.moreBtn.addEventListener('click', () => { k.smallerList.hidden = !k.smallerList.hidden; paintMore(k); });
      k.more = h('div', { class: 'person-more' }, k.moreBtn);
      paintMore(k);
    }
    if (toggle) {
      k.button = h('button', { class: 'segment', type: 'button' }, `${k.label} · ${k.films.length + k.smaller.length}`);
      k.button.addEventListener('click', () => { shown = k; paintFilms(); });
      toggle.appendChild(k.button);
    }
  }
  function paintMore(k) {
    const n = k.smallerList.children.length;
    if (!n) { k.more.remove(); k.smallerList.remove(); k.more = null; return; }
    const open = !k.smallerList.hidden;
    k.moreBtn.textContent = open ? 'Hide smaller films' : `Show smaller films (${n})`;
    k.moreBtn.setAttribute('aria-expanded', String(open));
  }
  const emptyLine = () => h('p', { class: 'muted' }, guest ? 'No other films to show.' : 'No other films to show. You\'ve rated them all.');
  function paintFilms() {
    clear(filmsBody);
    if (!shown) { filmsBody.appendChild(h('p', { class: 'muted' }, 'No films to show.')); return; }
    for (const k of kinds) {
      k.button?.classList.toggle('active', k === shown);
      k.button?.setAttribute('aria-pressed', String(k === shown));
    }
    const any = shown.list.children.length || shown.smallerList?.children.length;
    filmsBody.append(...(any ? [shown.list, shown.more, shown.smallerList].filter(Boolean) : [emptyLine()]));
  }
  paintFilms();

  if (!guest && d.rated.length) {
    ensureRated();
    lists.rated.append(...d.rated.map((f) => row(f, 'rated')));
    paintRatedSub();
  }

  // Rated from the lists below: the film moves up into You rated, and focus
  // goes to the stars of the next film (or the one before), so a keyboard
  // user stays in the list. A rating changed in Playing now or You rated
  // stays where it is.
  function onRated(f, li, where, v) {
    f.myRating = v || null;
    if (!v || where === 'playing' || where === 'rated') return;
    const hadFocus = li.contains(document.activeElement);
    const next = (li.nextElementSibling || li.previousElementSibling)?.querySelector('.stars.interactive');
    const from = li.parentElement;
    li.remove();
    ensureRated();
    lists.rated.prepend(row(f, 'rated', { fresh: true }));
    paintRatedSub();
    const k = kinds.find((x) => x.smallerList === from);
    if (k?.more) paintMore(k);
    if (from === shown?.list && !from.children.length && !shown.smallerList?.children.length) paintFilms();
    if (hadFocus) (next || lists.rated.querySelector('.stars.interactive'))?.focus();
  }

  if (!d.playing.length && !d.rated.length && !kinds.length) {
    filmsPart.replaceWith(emptyState('film', 'No films to show', `TMDB doesn't list any films for ${p.name}.`));
  }
  root.appendChild(page);
}
