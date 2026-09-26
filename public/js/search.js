// The header search sheet (owner and friends): search as you type over TMDB
// and the films already around, with this person's recents while the box is
// empty. Recents live on the server, per person, so they follow them across
// devices; the guest link never gets the button (and the API refuses it).
import { api } from './api.js';
import { h, clear, toast, icon, openModal } from './ui.js';
import { query as prepQuery } from './fuzzy.js';
import { streamLine, CREDIT } from './stream.js';
import { openWhatToWatch } from './wsw.js';

const DEBOUNCE_MS = 300;
const DWELL_MS = 2000; // results looked at this long count as a search, even if typed over later
const MIN_CHARS = 2;
const thumb = (url) => (url ? url.replace(/\/w\d+\//, '/w92/') : null);
const yearOf = (y) => (y ? ` ${y}` : '');

let open = null; // one sheet at a time

export function openSearch(ctx = null) {
  if (open) { open.input.focus(); return; }

  const listId = 'search-list';
  const input = h('input', {
    class: 'input big search-input', type: 'search', placeholder: 'Search movies', 'aria-label': 'Search movies',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
  });
  const clearBtn = h('button', { class: 'filter-clear search-clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('x', { size: 18 }));
  const statusLine = h('p', { class: 'search-status', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'search-body', id: listId, role: 'listbox', 'aria-label': 'Search results' });
  const credit = h('p', { class: 'stream-credit sr-credit', hidden: true }, CREDIT);
  // Not sure what to look for? "What should I watch?" (js/wsw.js) instead.
  const wswBtn = ctx ? h('button', { class: 'link-btn search-wsw', type: 'button', 'aria-haspopup': 'dialog' }, icon('sparkle', { size: 16 }), 'Not sure? What should I watch?') : null;
  const content = h('div', { class: 'search-sheet' },
    h('div', { class: 'filter-field search-field' }, icon('search', { size: 18, cls: 'filter-icon' }), input, clearBtn),
    wswBtn, statusLine, body, credit);

  let recents = { queries: [], movies: [] };
  let results = null; // { q, list } of the last finished search
  let timer = null;
  let dwell = null;
  let ticket = 0;
  let controller = null;
  let active = -1;
  let savedQuery = '';

  const modal = openModal(content, {
    title: 'Search', cls: 'search-overlay',
    onClose: () => {
      open = null;
      clearTimeout(timer);
      clearTimeout(dwell);
      controller?.abort();
      stopViewport();
      // A search that found something counts as a recent even if nothing was opened.
      if (results?.list.length) remember(results.q);
    },
  });
  open = { input };
  modal.card.classList.add('search-card');
  wswBtn?.addEventListener('click', () => { modal.close(); openWhatToWatch(ctx); });
  input.focus();

  // ---- keep the sheet inside what's visible above an on-screen keyboard
  const vv = window.visualViewport;
  const fit = () => {
    if (!vv) return;
    modal.overlay.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    modal.overlay.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
  };
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  const stopViewport = () => { vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit); };
  fit();

  // ---- options and keyboard
  const options = () => [...body.querySelectorAll('[role="option"]')];
  const setActive = (i) => {
    const opts = options();
    opts.forEach((o) => o.classList.remove('active'));
    active = opts.length ? Math.max(-1, Math.min(i, opts.length - 1)) : -1;
    if (active >= 0) {
      opts[active].classList.add('active');
      opts[active].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', opts[active].id);
    } else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); } else if (e.key === 'Enter') {
      e.preventDefault();
      const opts = options();
      if (active >= 0 && opts[active]) { opts[active].click(); return; }
      // Enter before the pause is over: search now, then open the top result.
      const q = input.value;
      if (prepQuery(q).c.length < MIN_CHARS) return;
      if (!results || results.q !== q) await run(q);
      options()[0]?.click();
    }
  });

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(timer);
    clearTimeout(dwell);
    const q = input.value;
    if (!prepQuery(q).n) { cancel(); showRecents(); return; }
    if (prepQuery(q).c.length < MIN_CHARS) { cancel(); clear(body); credit.hidden = true; statusLine.textContent = 'Keep typing…'; setExpanded(false); return; }
    statusLine.textContent = 'Searching…';
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; cancel(); showRecents(); input.focus(); });

  const cancel = () => { ticket++; controller?.abort(); controller = null; results = null; };
  const setExpanded = (on) => input.setAttribute('aria-expanded', String(on));

  async function run(q) {
    clearTimeout(timer);
    const mine = ++ticket;
    controller?.abort();
    controller = new AbortController();
    statusLine.textContent = 'Searching…';
    try {
      const r = await api.search(q, { signal: controller.signal });
      if (mine !== ticket) return;
      results = { q, list: r.results };
      paintResults(q, r.results);
    } catch (err) {
      if (err.name === 'AbortError' || mine !== ticket) return;
      statusLine.textContent = err.message;
    }
  }

  // ---- results
  function badges(m) {
    const out = [];
    if (m.playing) out.push(h('span', { class: 'badge sr-badge playing' }, 'Playing now'));
    if (m.rating != null) out.push(h('span', { class: 'badge sr-badge rated', 'aria-label': `You rated it ${m.rating} stars` }, `★ ${m.rating}`));
    if (m.watchlisted) out.push(h('span', { class: 'badge sr-badge' }, 'Watchlist'));
    if (m.hidden) out.push(h('span', { class: 'badge sr-badge muted' }, 'Hidden'));
    return out;
  }

  const poster = (m) => (m.poster
    ? h('img', { class: 'sr-thumb', src: thumb(m.poster), alt: '', loading: 'lazy', decoding: 'async', width: '40', height: '60' })
    : h('span', { class: 'sr-thumb sr-noposter', 'aria-hidden': 'true' }, icon('film', { size: 18 })));

  function openMovie(m, q) {
    if (q) remember(q);
    api.addRecentMovie({ tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster }).catch(() => {});
    results = null; // already remembered
    modal.close();
    location.hash = `#/movie/${m.tmdb_id}`;
  }

  function paintResults(q, list) {
    clear(body);
    credit.hidden = true;
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!list.length) {
      statusLine.textContent = `No matches for "${q.trim()}"`;
      setExpanded(false);
      return;
    }
    statusLine.textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;
    setExpanded(true);
    clearTimeout(dwell);
    dwell = setTimeout(() => remember(q), DWELL_MS);
    // Films not in theaters get a small "Stream on …" line, and the JustWatch
    // credit shows under the list once one does.
    list.forEach((m, i) => {
      const text = h('span', { class: 'sr-text' },
        h('span', { class: 'sr-title' }, m.title, m.year ? h('span', { class: 'sr-year' }, yearOf(m.year)) : null),
        h('span', { class: 'sr-badges' }, ...badges(m)));
      const row = h('a', {
        class: 'sr-row', id: `sr-${i}`, role: 'option', href: `#/movie/${m.tmdb_id}`, tabindex: '-1',
        onClick: (e) => { e.preventDefault(); openMovie(m, q); },
      }, poster(m), text);
      body.appendChild(row);
      if (!m.playing) text.appendChild(streamLine(m.tmdb_id, row, { cls: 'stream-line sr-stream', onShown: () => { credit.hidden = false; } }));
    });
  }

  // ---- recents
  function remember(q) {
    const text = String(q || '').trim();
    if (!text || text === savedQuery || prepQuery(text).c.length < MIN_CHARS) return;
    savedQuery = text;
    api.addRecentQuery(text).then((r) => { recents = r; }).catch(() => {});
  }

  function showRecents() {
    results = null;
    credit.hidden = true;
    setExpanded(false);
    clear(body);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    statusLine.textContent = '';
    const { queries, movies } = recents;
    if (!queries.length && !movies.length) {
      body.appendChild(h('p', { class: 'search-empty' }, 'Your recent searches and the films you open from here show up here.'));
      return;
    }
    let n = 0;
    body.appendChild(h('div', { class: 'recents-head' },
      h('span', {}, 'Recent'),
      h('button', { class: 'link-btn recents-clear', type: 'button', onClick: clearAll }, 'Clear all')));
    if (queries.length) {
      body.appendChild(h('h4', { class: 'recents-label' }, 'Recent searches'));
      for (const r of queries) {
        body.appendChild(h('div', { class: 'recent-row' },
          h('button', {
            class: 'recent-main', type: 'button', role: 'option', id: `rc-${n++}`, tabindex: '-1',
            onClick: () => { input.value = r.query; clearBtn.hidden = false; remember(r.query); run(r.query); input.focus(); },
          }, icon('search', { size: 16 }), h('span', { class: 'recent-text' }, r.query)),
          h('button', { class: 'recent-x', type: 'button', 'aria-label': `Remove "${r.query}" from recent searches`, onClick: () => removeOne('query', r.key) }, icon('x', { size: 16 }))));
      }
    }
    if (movies.length) {
      body.appendChild(h('h4', { class: 'recents-label' }, 'Recently viewed'));
      for (const m of movies) {
        body.appendChild(h('div', { class: 'recent-row' },
          h('a', {
            class: 'recent-main', href: `#/movie/${m.tmdb_id}`, role: 'option', id: `rc-${n++}`, tabindex: '-1',
            onClick: (e) => { e.preventDefault(); openMovie(m, null); },
          }, poster(m), h('span', { class: 'recent-text' }, m.title, m.year ? h('span', { class: 'sr-year' }, yearOf(m.year)) : null)),
          h('button', { class: 'recent-x', type: 'button', 'aria-label': `Remove ${m.title} from recently viewed`, onClick: () => removeOne('movie', String(m.tmdb_id)) }, icon('x', { size: 16 }))));
      }
    }
  }

  async function removeOne(kind, key) {
    const before = recents;
    recents = kind === 'query'
      ? { ...recents, queries: recents.queries.filter((r) => r.key !== key) }
      : { ...recents, movies: recents.movies.filter((m) => String(m.tmdb_id) !== key) };
    showRecents();
    input.focus();
    try { recents = await api.removeRecent(kind, key); } catch (e) { recents = before; toast(e.message, 'error'); }
    if (!input.value) showRecents();
  }

  // No confirm popup: it clears at once, and the toast offers Undo.
  async function clearAll() {
    const before = recents;
    recents = { queries: [], movies: [] };
    showRecents();
    input.focus();
    try {
      const r = await api.clearRecents();
      toast('Cleared your recent searches', '', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const back = await api.restoreRecents(r.cleared);
              recents = back;
              if (open && !input.value) showRecents();
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      });
    } catch (e) {
      recents = before;
      showRecents();
      toast(e.message, 'error');
    }
  }

  showRecents();
  api.searchRecents().then((r) => { recents = r; if (!input.value) showRecents(); }).catch(() => {});
}
