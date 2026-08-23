// DOM helpers + reusable UI components (no framework, no build step).

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

export const money = (n) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
export const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
export const scoreColor = (v) => (v == null ? 'na' : v >= 75 ? 'good' : v >= 55 ? 'ok' : 'low');

// ---- components --------------------------------------------------------

export function poster(movie, { size = 'md', link = true } = {}) {
  const inner = movie.poster
    ? h('img', { class: 'poster-img', src: movie.poster, alt: movie.title || '', loading: 'lazy' })
    : h('div', { class: 'poster-fallback' }, h('span', {}, movie.title || 'No poster'));
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
    title: unscored ? 'No public scores yet — this number uses a neutral 50 for reviews' : (label || 'Score'),
  },
    h('span', { class: 'score-num' }, value == null ? '—' : value),
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

export function spinner(text) {
  return h('div', { class: 'spinner' }, h('div', { class: 'spinner-ring' }), text ? h('div', { class: 'spinner-text' }, text) : null);
}

export function emptyState(icon, title, msg, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon),
    h('div', { class: 'empty-title' }, title),
    msg ? h('div', { class: 'empty-msg' }, msg) : null,
    action || null,
  );
}

export function sectionTitle(text, sub) {
  return h('div', { class: 'section-title' },
    h('h2', {}, text),
    sub ? h('span', { class: 'section-sub' }, sub) : null,
  );
}

let toastHost;
export function toast(message, type = '') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast ${type}` }, message);
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

// Modal is portaled to <body> so page transforms never trap the fixed overlay.
export function openModal(contentNode, { title } = {}) {
  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const card = h('div', { class: 'modal-card' },
    h('div', { class: 'modal-head' },
      h('h3', {}, title || ''),
      h('button', { class: 'modal-x', onClick: close }, '✕'),
    ),
    h('div', { class: 'modal-body' }, contentNode),
  );
  const overlay = h('div', { class: 'modal-overlay', onClick: (e) => { if (e.target === overlay) close(); } }, card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return { close, card };
}

export function labeled(label, node) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), node);
}
