// DOM helpers + reusable UI components (no framework, no build step).
import { icon } from './icons.js';

export { icon };

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') e.className = v;
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

// ---- components --------------------------------------------------------

// The title set on a gradient, standing in for missing or broken artwork.
function posterFallback(movie) {
  return h('div', { class: 'poster-fallback', role: 'img', 'aria-label': movie.title || 'No poster' },
    h('span', { class: 'poster-fallback-title' }, movie.title || 'No poster'),
    movie.year ? h('span', { class: 'poster-fallback-year' }, String(movie.year)) : null);
}

// TMDB serves posters at fixed widths; ask for about what the box needs at a
// phone's 3x (a 54px row poster was loading the 500px file).
const TMDB_WIDTH = { sm: 'w185', card: 'w342', grid: 'w342', xl: 'w500' };
export const tmdbSized = (url, w) => (typeof url === 'string' && url.startsWith('https://image.tmdb.org/') ? url.replace(/\/w\d+\//, `/${w}/`) : url);

// `file` picks the TMDB width outright where the box is smaller than its size class.
export function poster(movie, { size = 'md', link = true, file = null } = {}) {
  let inner;
  if (movie.poster) {
    // loading before src: set after it, the browser has already started the download.
    inner = h('img', { class: 'poster-img', loading: 'lazy', decoding: 'async', src: tmdbSized(movie.poster, file || TMDB_WIDTH[size] || 'w342'), alt: movie.title || '' });
    inner.addEventListener('error', () => inner.replaceWith(posterFallback(movie)), { once: true });
  } else inner = posterFallback(movie);
  const box = h('div', { class: `poster poster-${size}` }, inner);
  if (link && movie.tmdb_id) {
    return h('a', { class: 'poster-link', href: `#/movie/${movie.tmdb_id}` }, box);
  }
  return box;
}

// The match, one style everywhere: a soft accent pill, "97% match". `early`
// (no public scores yet, so the number leans on taste and a neutral 50 for
// reviews) adds a small "early".
// The guest link ranks by public score alone, so its films' score is the
// public score, not a match (server/lib/recommend.js). Set from the status
// (js/app.js).
let publicScores = false;
export function showPublicScores(on) { publicScores = Boolean(on); }

export function matchBadge(value, { early = false } = {}) {
  if (publicScores) {
    return h('span', { class: 'match', title: 'Rotten Tomatoes, Metacritic, IMDb and TMDB, averaged' }, value == null ? 'No reviews yet' : `Reviews ${value}`);
  }
  return h('span', {
    class: 'match',
    title: early ? 'No public scores yet. This number uses a neutral 50 for reviews.' : 'How likely you are to enjoy it',
  }, value == null ? 'No match yet' : `${value}% match`, early ? h('span', { class: 'match-early' }, 'early') : null);
}

// A part of the match on its own (public score, taste match), as a number.
export function scoreNum(value) {
  return h('span', { class: 'score-num' }, value == null ? 'n/a' : String(value));
}

// A tag: a small soft-filled label. `variant` picks its tint (styles.css, tags).
export function badge(text, variant = '') {
  return h('span', { class: `tag${variant ? ` ${variant}` : ''}` }, text);
}

export function chip(text, { active = false, onClick } = {}) {
  return h('button', {
    class: `chip${active ? ' active' : ''}`,
    type: 'button',
    onClick,
  }, text);
}

// Half-star capable rating control.
// allowClear: clicking the rating you're already on removes it, reporting 0 to
// onChange. The returned node carries setValue() so callers can push the display
// back in sync (e.g. after a failed save).
// A star rating, 0.5-5 in half stars. `interactive` makes it a control that
// works by pointer and by keyboard: a slider (named by `label`) whose
// aria-valuetext always says the value. Arrow keys move it half a star at a
// time (Home/End jump to the ends) without saving; Enter or Space saves, and
// Delete or Backspace clears when `allowClear`. Escape or leaving the control
// puts an unsaved value back. A click saves at once, as always, and clicking
// the saved value clears it.
// One SVG holds all five stars (a list of hundreds of ratings draws two rows
// each), built once and cloned.
let starTemplate = null;
const STAR = 'M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.1 6.6 20l1-6.1-4.4-4.3 6.1-.9z';
const starRow = () => {
  if (!starTemplate) {
    const ns = 'http://www.w3.org/2000/svg';
    starTemplate = document.createElementNS(ns, 'svg');
    starTemplate.setAttribute('viewBox', '0 0 120 24');
    starTemplate.setAttribute('class', 'star-row');
    starTemplate.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 5; i++) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', STAR);
      path.setAttribute('transform', `translate(${i * 24} 0)`);
      starTemplate.appendChild(path);
    }
  }
  return starTemplate.cloneNode(true);
};

// A small drawn star for running text ("4.5★", "★ Watchlist"). Text that
// arrives with ★ in it (a pick's reason from the server) goes through
// withStars, which swaps each one for the drawn star.
let inlineStar = null;
export const star = () => (inlineStar ||= icon('star', { size: '0.9em', cls: 'star-glyph inline-star' })).cloneNode(true);
export function withStars(text) {
  const parts = String(text ?? '').split('★');
  return parts.flatMap((p, i) => (i ? [star(), p] : [p])).filter((x) => x !== '');
}

export function makeStars({ value = 0, interactive = false, onChange, size = 22, allowClear = false, label = 'Your rating' } = {}) {
  const wrap = h('div', { class: `stars${interactive ? ' interactive' : ''}`, style: { fontSize: `${size}px` } });
  // Drawn, not typed: none of the app's fonts has a star, so a ★ character
  // came from whatever system font had one. A read-only row is one image
  // named by its value; the control names itself through aria-valuetext.
  const base = h('div', { class: 'stars-base', 'aria-hidden': 'true' }, starRow());
  const fill = h('div', { class: 'stars-fill', 'aria-hidden': 'true' }, starRow());
  let current = value; // saved
  let shown = value; // on screen: the saved value, or one picked with the keys and not saved yet
  const words = (v) => (v ? `${v} star${v === 1 ? '' : 's'}` : 'Not rated');
  const paint = (v) => {
    shown = v;
    fill.style.width = `${(v / 5) * 100}%`;
    if (!interactive) return;
    wrap.setAttribute('aria-valuenow', String(v));
    wrap.setAttribute('aria-valuetext', v === current ? words(v) : `${words(v)}, press Enter to save`);
  };
  const set = (v) => {
    current = v; paint(v);
    if (!interactive) { wrap.setAttribute('role', 'img'); wrap.setAttribute('aria-label', words(v)); }
  };
  wrap.append(base, fill);
  if (interactive) {
    Object.entries({
      role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '5',
    }).forEach(([k, v]) => wrap.setAttribute(k, v));
  }
  set(value);
  if (interactive) {
    // Saves run one after another: a quick "rate, then clear" (keys or taps)
    // reaches the server in that order, and each onChange sees the last
    // one finished.
    let saving = Promise.resolve();
    const save = (v) => {
      set(v);
      if (onChange) saving = saving.then(() => onChange(v)).catch(() => {});
    };
    const fromX = (clientX) => {
      const r = base.getBoundingClientRect();
      let ratio = (clientX - r.left) / r.width;
      ratio = Math.max(0, Math.min(1, ratio));
      return Math.max(0.5, Math.ceil(ratio * 10) / 2);
    };
    wrap.addEventListener('click', (e) => {
      let v = fromX(e.clientX);
      if (allowClear && v === current) v = 0;
      save(v);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let next = null;
      switch (e.key) {
        case 'ArrowRight': case 'ArrowUp': next = Math.min(5, (shown || 0) + 0.5); break;
        case 'ArrowLeft': case 'ArrowDown': next = shown ? Math.max(0.5, shown - 0.5) : 0; break;
        case 'Home': next = 0.5; break;
        case 'End': next = 5; break;
        case 'Enter': case ' ':
          if (shown !== current) save(shown);
          break;
        case 'Delete': case 'Backspace':
          if (!allowClear) return;
          if (current || shown) save(0);
          break;
        case 'Escape':
          if (shown === current) return; // nothing to undo: let a sheet close
          paint(current);
          break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (next !== null && next !== shown) paint(next);
    });
    wrap.addEventListener('blur', () => { if (shown !== current) paint(current); });
  }
  wrap.setValue = set;
  return wrap;
}

// A status line: a dot in the state's colour, then the words that say it.
// state: 'ok' | 'bad' | 'warn' | '' (no dot).
export function setStatus(el, state, text) {
  el.classList.add('status-line');
  el.classList.toggle('bad', state === 'bad');
  el.replaceChildren(...(state ? [h('span', { class: `status-dot ${state}`, 'aria-hidden': 'true' })] : []), h('span', {}, text));
  return el;
}

// Always carries words: with reduced motion the ring is hidden and the text
// is the whole indicator, so it can't be left empty.
export function spinner(text = 'Loading…') {
  return h('div', { class: 'spinner', role: 'status' }, h('div', { class: 'spinner-ring', 'aria-hidden': 'true' }), h('div', { class: 'spinner-text' }, text || 'Loading…'));
}

// `level` makes the title a heading, for a state that is the whole page
// (not found, offline, an error).
export function emptyState(icon, title, msg, action, { level = 0 } = {}) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, typeof icon === 'string' ? iconFor(icon) : icon),
    h(level ? `h${level}` : 'div', { class: 'empty-title' }, title),
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
// The live region is on the page before anything is said in it: screen
// readers announce changes to a region that already exists, not a new one.
// app.js calls this at start-up.
export function ensureToastHost() {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(message, type = '', { action = null, duration = action ? 6000 : 2600 } = {}) {
  ensureToastHost();
  let timer;
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  };
  const button = action ? h('button', {
    class: 'toast-action', type: 'button',
    onClick: () => { dismiss(); action.onClick(); },
  }, action.label) : null;
  const mark = type === 'success' ? icon('check', { size: 16, cls: 'toast-icon ok' })
    : type === 'error' ? icon('alert', { size: 16, cls: 'toast-icon bad', label: 'Problem' }) : null;
  const t = h('div', { class: `toast ${type}${action ? ' has-action' : ''}` },
    h('span', {}, mark, message),
    button,
  );
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  // The clock stops while the toast is pointed at or focused, so its action
  // can still be reached (by keyboard, the action button is focused for it).
  const start = () => { if (duration > 0 && !done) timer = setTimeout(dismiss, duration); };
  const stop = () => clearTimeout(timer);
  t.addEventListener('mouseenter', stop); t.addEventListener('mouseleave', start);
  t.addEventListener('focusin', stop); t.addEventListener('focusout', start);
  start();
  return { dismiss, button };
}

// Modal is portaled to <body> so page transforms never trap the fixed overlay.
// It is a real dialog: labelled by its title, focus moves in on open, Tab
// stays inside it, and focus goes back to whatever opened it on close.
let modalSeq = 0;
// Open dialogs, newest last: only the top one answers Escape and Tab, so
// Escape in a sheet opened from a sheet closes just that one.
const openStack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
// `onClose` runs once, after the dialog starts closing. `cls` adds a class to
// the overlay (the search sheet uses it to sit at the top on phones).
export function openModal(contentNode, { title, onClose, cls = '' } = {}) {
  const opener = document.activeElement;
  const titleId = `modal-title-${++modalSeq}`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
    openStack.splice(openStack.indexOf(overlay), 1);
    if (!openStack.length) document.querySelector('.shell')?.removeAttribute('inert');
    if (opener && document.contains(opener)) opener.focus?.();
    onClose?.();
  };
  const onKey = (e) => {
    if (openStack[openStack.length - 1] !== overlay) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...card.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null && !el.classList.contains('focus-wrap'));
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
    // Tab out of an embedded frame (the trailer) arrives here and goes round
    // to the first control, instead of leaving the dialog.
    h('span', { class: 'focus-wrap', tabindex: '0', onFocus: () => {
      const items = [...card.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null && !el.classList.contains('focus-wrap'));
      (items[0] || card).focus();
    } }),
  );
  const overlay = h('div', { class: `modal-overlay${cls ? ` ${cls}` : ''}`, onClick: (e) => { if (e.target === overlay) close(); } }, card);
  document.body.appendChild(overlay);
  openStack.push(overlay);
  // The page behind can't be reached by keyboard or screen reader meanwhile.
  document.querySelector('.shell')?.setAttribute('inert', '');
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  // Focus the first field if there is one, else the dialog itself; a caller
  // that focuses something specific right after opening still wins.
  const firstField = [...card.querySelectorAll('.modal-body input, .modal-body select, .modal-body textarea')].find((el) => el.offsetParent !== null);
  (firstField || card).focus();
  return { close, card, overlay };
}

// Small helpers several pages share.
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const thumb = (url) => (url ? url.replace(/\/w\d+\//, '/w92/') : null);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function labeled(label, node) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), node);
}
