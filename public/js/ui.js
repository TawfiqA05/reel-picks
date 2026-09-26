// DOM helpers + reusable UI components (no framework, no build step).
import { icon } from './icons.js';

export { icon };

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  append(e, kids);
  return e;
}

function append(parent, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    parent.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function frag(...kids) {
  const f = document.createDocumentFragment();
  append(f, kids);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---- formatting --------------------------------------------------------

export const money = (n) => (n == null ? '–' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
export const pct = (n) => (n == null ? '–' : `${Math.round(n * 100)}%`);
export const scoreColor = (v) => (v == null ? 'na' : v >= 75 ? 'good' : v >= 55 ? 'ok' : 'low');

// ---- components --------------------------------------------------------

// The title set on a gradient, standing in for missing or broken artwork.
function posterFallback(movie) {
  return h('div', { class: 'poster-fallback', role: 'img', 'aria-label': movie.title || 'No poster' },
    h('span', { class: 'poster-fallback-title' }, movie.title || 'No poster'),
    movie.year ? h('span', { class: 'poster-fallback-year' }, String(movie.year)) : null);
}

export function poster(movie, { size = 'md', link = true } = {}) {
  let inner;
  if (movie.poster) {
    inner = h('img', { class: 'poster-img', src: movie.poster, alt: movie.title || '', loading: 'lazy', decoding: 'async' });
    inner.addEventListener('error', () => inner.replaceWith(posterFallback(movie)), { once: true });
  } else inner = posterFallback(movie);
  const box = h('div', { class: `poster poster-${size}` }, inner);
  if (link && movie.tmdb_id) {
    return h('a', { class: 'poster-link', href: `#/movie/${movie.tmdb_id}` }, box);
  }
  return box;
}

// unscored: the number rests on a default public score (no reviews yet), so
// the pill is drawn dashed and says so on hover.
export function scorePill(value, { label, big = false, unscored = false } = {}) {
  return h('div', {
    class: `score-pill ${scoreColor(value)}${big ? ' big' : ''}${unscored ? ' unscored' : ''}`,
    title: unscored ? 'No public scores yet. This number uses a neutral 50 for reviews.' : (label || 'Score'),
  },
    h('span', { class: 'score-num' }, value == null ? '–' : value),
    label ? h('span', { class: 'score-label' }, label) : null,
  );
}

export function badge(text, variant = '') {
  return h('span', { class: `badge ${variant}` }, text);
}

export function chip(text, { active = false, onClick, removable = false } = {}) {
  return h('button', {
    class: `chip${active ? ' active' : ''}`,
    type: 'button',
    onClick,
  }, text, removable ? h('span', { class: 'chip-x' }, ' ✕') : null);
}

// Half-star capable rating control.
// allowClear: clicking the rating you're already on removes it, reporting 0 to
// onChange. The returned node carries setValue() so callers can push the display
// back in sync (e.g. after a failed save).
export function makeStars({ value = 0, interactive = false, onChange, size = 22, allowClear = false } = {}) {
  const wrap = h('div', { class: `stars${interactive ? ' interactive' : ''}`, style: { fontSize: `${size}px` } });
  const base = h('div', { class: 'stars-base' }, '★★★★★');
  const fill = h('div', { class: 'stars-fill' }, '★★★★★');
  let current = value;
  const set = (v) => { current = v; fill.style.width = `${(v / 5) * 100}%`; };
  set(value);
  wrap.append(base, fill);
  if (interactive) {
    const fromX = (clientX) => {
      const r = base.getBoundingClientRect();
      let ratio = (clientX - r.left) / r.width;
      ratio = Math.max(0, Math.min(1, ratio));
      return Math.max(0.5, Math.ceil(ratio * 10) / 2);
    };
    wrap.addEventListener('click', (e) => {
      let v = fromX(e.clientX);
      if (allowClear && v === current) v = 0;
      set(v);
      onChange && onChange(v);
    });
  }
  wrap.setValue = set;
  return wrap;
}

// Always carries words: with reduced motion the ring is hidden and the text
// is the whole indicator, so it can't be left empty.
export function spinner(text = 'Loading…') {
  return h('div', { class: 'spinner', role: 'status' }, h('div', { class: 'spinner-ring', 'aria-hidden': 'true' }), h('div', { class: 'spinner-text' }, text || 'Loading…'));
}

export function emptyState(icon, title, msg, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, typeof icon === 'string' ? iconFor(icon) : icon),
    h('div', { class: 'empty-title' }, title),
    msg ? h('div', { class: 'empty-msg' }, msg) : null,
    action || null,
  );
}

// Empty / error states name their icon from the shared set.
function iconFor(name) {
  return icon(name, { size: 32 });
}

// level: 1 for the page's own title (one per page), 2 for its sections. Both
// look the same; only the document outline differs.
export function sectionTitle(text, sub, { level = 2 } = {}) {
  return h('div', { class: 'section-title' },
    h(level === 1 ? 'h1' : 'h2', {}, text),
    sub ? h('span', { class: 'section-sub' }, sub) : null,
  );
}

let toastHost;
// action: { label, onClick } adds a button (Undo) and keeps the toast up for
// six seconds instead of the usual two and a half.
// duration 0 keeps the toast up until its action is tapped.
export function toast(message, type = '', { action = null, duration = action ? 6000 : 2600 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  };
  const t = h('div', { class: `toast ${type}${action ? ' has-action' : ''}` },
    h('span', {}, message),
    action ? h('button', {
      class: 'toast-action', type: 'button',
      onClick: () => { dismiss(); action.onClick(); },
    }, action.label) : null,
  );
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss };
}

// Modal is portaled to <body> so page transforms never trap the fixed overlay.
// It is a real dialog: labelled by its title, focus moves in on open, Tab
// stays inside it, and focus goes back to whatever opened it on close.
let modalSeq = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
// `onClose` runs once, after the dialog starts closing.
export function openModal(contentNode, { title, onClose } = {}) {
  const opener = document.activeElement;
  const titleId = `modal-title-${++modalSeq}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
    if (opener && document.contains(opener)) opener.focus?.();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...card.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); card.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'modal-head' },
      h('h3', { id: titleId }, title || ''),
      h('button', { class: 'modal-x', type: 'button', 'aria-label': 'Close', onClick: close }, icon('x', { size: 20 })),
    ),
    h('div', { class: 'modal-body' }, contentNode),
  );
  const overlay = h('div', { class: 'modal-overlay', onClick: (e) => { if (e.target === overlay) close(); } }, card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  // Focus the first field if there is one, else the dialog itself; a caller
  // that focuses something specific right after opening still wins.
  const firstField = card.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
  (firstField || card).focus();
  return { close, card };
}

export function labeled(label, node) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), node);
}
