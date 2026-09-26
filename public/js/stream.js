// Where to stream: US streaming, rent and buy options from TMDB's watch
// providers (data from JustWatch, which TMDB asks every app to credit). The
// movie page gets a section with logos; search results and "More from" rows
// get one small line for films that aren't in theaters. Rows ask only once
// they scroll into view, in small batches, and each film is asked about once
// per page load.
import { api } from './api.js';
import { h } from './ui.js';

export const CREDIT = 'Streaming data from JustWatch';

const known = new Map(); // `${id}:${skipPlaying}` -> Promise<providers | { playing } | null>
const waiting = new Map(); // same key -> { id, skipPlaying, resolve }
let timer = null;
const BATCH = 4;

function flush() {
  timer = null;
  const all = [...waiting.values()];
  waiting.clear();
  for (const skip of [true, false]) {
    const group = all.filter((w) => w.skipPlaying === skip);
    for (let i = 0; i < group.length; i += BATCH) {
      const chunk = group.slice(i, i + BATCH);
      api.providers(chunk.map((w) => w.id), { skipPlaying: skip })
        .then((r) => chunk.forEach((w) => w.resolve(r.providers?.[w.id] ?? null)))
        .catch(() => chunk.forEach((w) => w.resolve(null)));
    }
  }
}

export function providersFor(id, { skipPlaying = false } = {}) {
  const key = `${id}:${skipPlaying}`;
  if (!known.has(key)) {
    known.set(key, new Promise((resolve) => { waiting.set(key, { id, skipPlaying, resolve }); }));
    clearTimeout(timer);
    timer = setTimeout(flush, 60);
  }
  return known.get(key);
}

// "Amazon Prime Video with Ads" says nothing "Amazon Prime Video" didn't.
const distinct = (list) => list.filter((p, i) => !list.slice(0, i).some((q) => p.name.toLowerCase().startsWith(q.name.toLowerCase())));
const names = (all, n = 3) => {
  const list = distinct(all);
  const shown = list.slice(0, n).map((p) => p.name);
  return list.length > n ? `${shown.join(', ')} +${list.length - n}` : shown.join(', ');
};

// "Stream on Netflix, Max" or, with nothing to stream, "Rent or buy on …".
export function summary(p) {
  if (!p || p.playing) return null;
  if (p.stream?.length) return `Stream on ${names(p.stream)}`;
  const paid = [...(p.rent || []), ...(p.buy || [])].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
  if (!paid.length) return null;
  const how = p.rent?.length && p.buy?.length ? 'Rent or buy' : p.rent?.length ? 'Rent' : 'Buy';
  return `${how} on ${names(paid)}`;
}

// A small line under a result, filled in once its row is on screen and
// removed when there's nothing to say. `onShown` runs when it gets text (the
// list then adds the JustWatch credit once).
let observer = null;
const pending = new WeakMap();
function whenVisible(el, fn) {
  observer ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      pending.get(e.target)?.();
      pending.delete(e.target);
    }
  }, { rootMargin: '120px 0px' });
  pending.set(el, fn);
  observer.observe(el);
}

// `row` is the visible element the line sits in; call after it's built.
export function streamLine(id, row, { cls = 'stream-line', onShown = null } = {}) {
  const line = h('span', { class: cls, hidden: true });
  whenVisible(row, () => {
    providersFor(id, { skipPlaying: true }).then((p) => {
      const text = summary(p);
      if (!text || !line.isConnected) { line.remove(); return; }
      line.textContent = text;
      line.hidden = false;
      onShown?.();
    });
  });
  return line;
}

// The movie page's "Where to watch": Stream, Rent and Buy rows of provider
// logos, the JustWatch credit, and a link to TMDB's page for the film. Starts
// hidden and stays out of the page when the film has nothing in the US.
export function streamSection(id) {
  const section = h('section', { class: 'stream-card', 'aria-labelledby': 'stream-title', hidden: true });
  providersFor(id).then((p) => {
    if (!p || p.playing || !(p.stream?.length || p.rent?.length || p.buy?.length)) { section.remove(); return; }
    const row = (label, list) => (list?.length
      ? h('div', { class: 'stream-row' },
        h('span', { class: 'stream-kind' }, label),
        h('ul', { class: 'stream-logos', 'aria-label': `${label}: ${list.map((x) => x.name).join(', ')}` },
          ...list.map((x) => h('li', { title: x.name },
            x.logo ? h('img', { class: 'stream-logo', src: x.logo, alt: x.name, width: '40', height: '40', decoding: 'async' })
              : h('span', { class: 'stream-logo stream-noname' }, x.name.slice(0, 1))))))
      : null);
    section.append(
      h('h3', { id: 'stream-title' }, 'Where to watch'),
      row('Stream', p.stream), row('Rent', p.rent), row('Buy', p.buy),
      h('p', { class: 'stream-credit' },
        CREDIT,
        p.link ? h('a', { class: 'stream-more', href: p.link, target: '_blank', rel: 'noopener' }, 'All options on TMDB ↗') : null),
    );
    section.hidden = false;
  });
  return section;
}
