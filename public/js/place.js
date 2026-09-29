// Keeping my place on a page (per device, per tab). Every visit to a page is
// one entry in the browser's history; this gives each entry an id (kept in
// history.state, next to how deep into the app it is) and remembers, in
// sessionStorage, where the page was when it was left: how far down, and the
// bits a page registers (a filter's text, the day picked, a section opened).
//
// Coming back to an entry (the browser's back or forward, the back gesture in
// the installed app, the Back button on a film or person page) draws the page
// with those bits and scrolls to the same spot once the page is tall enough.
// Opening a page any other way (a tab, a link) is a new entry and starts at
// the top. js/app.js calls leave() before each page is drawn and arrive()
// when it starts, then finish() once it's drawn.
const KEY = 'rp-place';
const MAX = 60; // entries remembered
const WAIT_MS = 4000; // how long to wait for a page to grow tall enough

let current = null; // { id, depth, parts: Map(key -> getter), ready }
let replacing = false;
let seq = 0;

try { history.scrollRestoration = 'manual'; } catch { /* old browser */ }

function readAll() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function writeAll(all) {
  const ids = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete all[id];
  try { sessionStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage off or full */ }
}

// How deep into the app this entry is: 0 is the first page opened here (from
// a link, the home screen or a fresh start), so there's nothing to go back to.
export const depth = () => current?.depth ?? 0;

// The next hash change replaces this entry rather than adding one.
export function willReplace() { replacing = true; }

// Before a page is drawn: remember where the one on screen was. A page still
// loading keeps what was remembered before.
export function leave() {
  if (!current?.ready) return;
  const parts = {};
  for (const [k, get] of current.parts) {
    try { const v = get(); if (v !== undefined) parts[k] = v; } catch { /* that part is gone */ }
  }
  const all = readAll();
  all[current.id] = { y: Math.round(window.scrollY), parts, at: Date.now() };
  writeAll(all);
}

// A page starts: which entry this is, and whether it's one being returned to.
// Returns { back, parts, y }.
export function arrive() {
  const st = history.state;
  if (st && typeof st.rpPlace === 'string') {
    current = { id: st.rpPlace, depth: st.rpDepth || 0, parts: new Map(), ready: false };
    replacing = false;
    const saved = readAll()[current.id];
    return { back: Boolean(saved), parts: saved?.parts || {}, y: saved?.y ?? 0 };
  }
  const d = current ? current.depth + (replacing ? 0 : 1) : 0;
  replacing = false;
  current = { id: `${Date.now().toString(36)}-${++seq}`, depth: d, parts: new Map(), ready: false };
  try { history.replaceState({ ...(st && typeof st === 'object' ? st : {}), rpPlace: current.id, rpDepth: d }, ''); } catch { /* ignore */ }
  return { back: false, parts: {}, y: 0 };
}

// A page's own bit of state, read when it's left.
export function keep(key, get) {
  current?.parts.set(key, get);
}

// The page is drawn: back to where it was, or the top. On a return the page
// may still be filling in (a list or a section that loads after it), and a
// part arriving above the spot would push it down, so the spot is set again
// each frame until the page has been the same height for STEADY_MS (or
// WAIT_MS pass). It stops as soon as the reader scrolls or touches the page.
const STEADY_MS = 400;
export function finish(visit) {
  const me = current;
  if (me) me.ready = true;
  if (!visit?.back || !visit.y) { window.scrollTo(0, 0); return; }
  const target = visit.y;
  const t0 = Date.now();
  let stop = false;
  let lastH = -1;
  let steadySince = Date.now();
  const quit = () => { stop = true; };
  const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
  events.forEach((e) => window.addEventListener(e, quit, { once: true, passive: true }));
  const done = () => events.forEach((e) => window.removeEventListener(e, quit));
  const step = () => {
    if (stop || current !== me) return done();
    const h = document.documentElement.scrollHeight;
    if (h !== lastH) { lastH = h; steadySince = Date.now(); }
    const max = h - window.innerHeight;
    const want = Math.min(target, Math.max(0, max));
    if (Math.abs(window.scrollY - want) > 1) window.scrollTo(0, want);
    if ((max >= target && Date.now() - steadySince >= STEADY_MS) || Date.now() - t0 > WAIT_MS) return done();
    requestAnimationFrame(step);
  };
  step();
}

// A state that doesn't need an id yet (the welcome redirect) keeps whatever
// the entry already had.
export const stateWith = (extra = {}) => ({ ...(history.state && typeof history.state === 'object' ? history.state : {}), ...extra });
