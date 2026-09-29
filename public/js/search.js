// The header search sheet (owner and friends): search as you type over TMDB
// and the films already around, with up to two people (directors and actors)
// above the films, and this person's recents while the box is empty. Recents live on the server, per person, so they follow them across
// devices; the guest link never gets the button (and the API refuses it).
//
// Keeping the place (js/keep.js, the way "What should I watch?" does it):
// opening a film, a person or a recent from here and coming back (Back, the
// back gesture, the Back button) opens the sheet again with the same text,
// the same results and the same scroll, per person on this device, for 30
// minutes. Clearing the box, the close button, Escape or a tap outside end it.
import { api } from './api.js';
import { h, clear, toast, icon, openModal, star } from './ui.js';
import { query as prepQuery } from './fuzzy.js';
import { streamLine, CREDIT } from './stream.js';
import { openWhatToWatch } from './wsw.js';
import { keeper, resumable, uidOf, here } from './keep.js';

const DEBOUNCE_MS = 300;
const DWELL_MS = 2000; // results looked at this long count as a search, even if typed over later
const MIN_CHARS = 2;
const thumb = (url) => (url ? url.replace(/\/w\d+\//, '/w92/') : null);
// A face for a 44px circle: TMDB's 45px-wide size on a 1x screen, the 185 one on anything sharper.
const faceUrl = (url) => (url && window.devicePixelRatio > 1 ? url : url?.replace(/\/w\d+\//, '/w45/') || null);
const yearOf = (y) => (y ? ` ${y}` : '');

let open = null; // one sheet at a time
const store = keeper('rp-search:');
resumable(store, { open: (ctx) => openSearch(ctx, { resume: true }), isOpen: () => Boolean(open) });

// `resume`: coming back from a trip (js/keep.js), the kept place is shown.
// Opened any other way, the search starts fresh and anything kept goes.
export function openSearch(ctx = null, { resume = false } = {}) {
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
  const wswBtn = ctx ? h('button', { class: 'link-btn search-wsw', type: 'button', 'aria-haspopup': 'dialog' }, icon('ticket', { size: 16 }), 'Not sure? What should I watch?') : null;
  const content = h('div', { class: 'search-sheet' },
    h('div', { class: 'filter-field search-field' }, icon('search', { size: 18, cls: 'filter-icon' }), input, clearBtn),
    wswBtn, statusLine, body, credit);

  let recents = { queries: [], movies: [], people: [] };
  let results = null; // { q, list } of the last finished search
  let timer = null;
  let dwell = null;
  let ticket = 0;
  let controller = null;
  let active = -1;
  let savedQuery = '';
  const uid = uidOf(ctx);
  const kept = ctx && resume ? store.load(uid) : null;
  if (!resume) store.forget(uid);
  const origin = here();
  let leaving = null; // what to keep when the sheet closes to open something

  const modal = openModal(content, {
    title: 'Search', cls: 'search-overlay',
    onClose: () => {
      open = null;
      clearTimeout(timer);
      clearTimeout(dwell);
      controller?.abort();
      stopViewport();
      // A search that found something counts as a recent even if nothing was opened.
      if (results?.list.length || results?.people?.length) remember(results.q);
      if (leaving) store.save(uid, { ...leaving, returnTo: origin });
      else store.forget(uid);
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
    if (!prepQuery(q).n) { cancel(); showRecents(); store.forget(uid); return; }
    if (prepQuery(q).c.length < MIN_CHARS) { cancel(); clear(body); credit.hidden = true; statusLine.textContent = 'Keep typing…'; setExpanded(false); return; }
    statusLine.textContent = 'Searching…';
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; cancel(); showRecents(); store.forget(uid); input.focus(); });

  // Leaving for a film or a person: what's on screen now is what comes back.
  const keepPlace = () => {
    leaving = { q: input.value, results: results && results.q === input.value ? results : null, scroll: Math.round(body.scrollTop) };
  };

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
      results = { q, list: r.results, people: r.people || [] };
      paintResults(q, r.results, results.people);
    } catch (err) {
      if (err.name === 'AbortError' || mine !== ticket) return;
      statusLine.textContent = err.message;
    }
  }

  // ---- results
  function badges(m) {
    const out = [];
    if (m.playing) out.push(h('span', { class: 'tag sr-badge playing' }, 'Playing now'));
    if (m.rating != null) out.push(h('span', { class: 'tag sr-badge rated', 'aria-label': `You rated it ${m.rating} stars` }, star(), ` ${m.rating}`));
    if (m.watchlisted) out.push(h('span', { class: 'tag sr-badge' }, 'Watchlist'));
    if (m.hidden) out.push(h('span', { class: 'tag sr-badge muted' }, 'Hidden'));
    return out;
  }

  const poster = (m) => (m.poster
    ? h('img', { class: 'sr-thumb', loading: 'lazy', decoding: 'async', src: thumb(m.poster), alt: '', width: '40', height: '60' })
    : h('span', { class: 'sr-thumb sr-noposter', 'aria-hidden': 'true' }, icon('film', { size: 18 })));

  function openMovie(m, q) {
    keepPlace();
    if (q) remember(q);
    api.addRecentMovie({ tmdb_id: m.tmdb_id, title: m.title, year: m.year, poster: m.poster }).catch(() => {});
    results = null; // already remembered
    modal.close();
    location.hash = `#/movie/${m.tmdb_id}`;
  }

  // A person goes into Recently viewed the way a film does.
  function openPerson(p, q) {
    keepPlace();
    if (q) remember(q);
    api.addRecentPerson({ id: p.id, name: p.name, role: p.role, photo: p.photo }).catch(() => {});
    results = null;
    modal.close();
    location.hash = `#/person/${p.id}`;
  }

  // A round photo, so a person never reads as a poster.
  const face = (p) => (p.photo
    ? h('img', { class: 'sr-face', loading: 'lazy', decoding: 'async', src: faceUrl(p.photo), alt: '', width: '44', height: '44' })
    : h('span', { class: 'sr-face sr-noface', 'aria-hidden': 'true' }, icon('user', { size: 20 })));

  // One person: photo, name, Director or Actor, and what they're known for.
  // The option's name says all of it in one line.
  function personRow(p, i, q) {
    const known = (p.knownFor || []).join(', ');
    return h('a', {
      class: 'sr-person', id: `sr-p${i}`, role: 'option', href: `#/person/${p.id}`, tabindex: '-1',
      'aria-label': `${p.name}, ${p.role}${known ? `. Known for ${known}` : ''}`,
      onClick: (e) => { e.preventDefault(); openPerson(p, q); },
    }, face(p),
    h('span', { class: 'sr-text' },
      h('span', { class: 'sr-title' }, p.name, h('span', { class: 'tag sr-badge sr-role' }, p.role)),
      known ? h('span', { class: 'sr-known' }, known) : null));
  }

  function paintResults(q, list, people = []) {
    clear(body);
    credit.hidden = true;
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!list.length && !people.length) {
      statusLine.textContent = `No matches for "${q.trim()}"`;
      setExpanded(false);
      return;
    }
    const films = `${list.length} result${list.length === 1 ? '' : 's'}`;
    const who = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    statusLine.textContent = !people.length ? films : list.length ? `${who} · ${films}` : who;
    setExpanded(true);
    clearTimeout(dwell);
    dwell = setTimeout(() => remember(q), DWELL_MS);
    people.forEach((p, i) => body.appendChild(personRow(p, i, q)));
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
    const { queries } = recents;
    // Films and people opened from here, newest first.
    const viewed = [
      ...recents.movies.map((m, i) => ({ m, at: m.at ?? -i })),
      ...(recents.people || []).map((p, i) => ({ p, at: p.at ?? -100 - i })),
    ].sort((a, b) => b.at - a.at);
    if (!queries.length && !viewed.length) {
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
    if (viewed.length) {
      body.appendChild(h('h4', { class: 'recents-label' }, 'Recently viewed'));
      for (const { m, p } of viewed) {
        if (p) {
          body.appendChild(h('div', { class: 'recent-row' },
            h('a', {
              class: 'recent-main recent-person', href: `#/person/${p.id}`, role: 'option', id: `rc-${n++}`, tabindex: '-1',
              'aria-label': p.role ? `${p.name}, ${p.role}` : p.name,
              onClick: (e) => { e.preventDefault(); openPerson(p, null); },
            }, face(p), h('span', { class: 'recent-text' }, p.name, p.role ? h('span', { class: 'sr-year' }, ` · ${p.role}`) : null)),
            h('button', { class: 'recent-x', type: 'button', 'aria-label': `Remove ${p.name} from recently viewed`, onClick: () => removeOne('person', String(p.id)) }, icon('x', { size: 16 }))));
          continue;
        }
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
    recents = kind === 'query' ? { ...recents, queries: recents.queries.filter((r) => r.key !== key) }
      : kind === 'person' ? { ...recents, people: (recents.people || []).filter((p) => String(p.id) !== key) }
        : { ...recents, movies: recents.movies.filter((m) => String(m.tmdb_id) !== key) };
    showRecents();
    input.focus();
    try { recents = await api.removeRecent(kind, key); } catch (e) { recents = before; toast(e.message, 'error'); }
    if (!input.value) showRecents();
  }

  // No confirm popup: it clears at once, and the toast offers Undo.
  async function clearAll() {
    const before = recents;
    recents = { queries: [], movies: [], people: [] };
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

  // Back from a trip: the same text, results and scroll. With no results
  // kept (the recents were showing), the recents come back once loaded.
  const restoreScroll = (y) => { if (y) requestAnimationFrame(() => { body.scrollTop = y; }); };
  if (kept && (kept.q || kept.results)) {
    input.value = kept.q || '';
    clearBtn.hidden = !input.value;
    if (kept.results) {
      results = kept.results;
      savedQuery = kept.results.q.trim();
      paintResults(kept.results.q, kept.results.list || [], kept.results.people || []);
      restoreScroll(kept.scroll);
    } else if (prepQuery(input.value).c.length >= MIN_CHARS) run(input.value).then(() => restoreScroll(kept.scroll));
  } else showRecents();
  api.searchRecents().then((r) => {
    recents = r;
    if (!input.value) { showRecents(); if (kept && !kept.q) restoreScroll(kept.scroll); }
  }).catch(() => {});
}
