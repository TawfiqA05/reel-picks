// The guided tour: a spotlight on the real element and a short card beside
// it, step by step across the tabs. It opens on its own once, on Picks, for
// anyone who hasn't finished or skipped it (tourDone, stored per user), right
// after the welcome setup for someone new; Replay tour in Settings and the ?
// in the header open it again. The guest link never gets it.
//
// The spotlight only ever lands on an element that is on screen and showing:
// page elements are scrolled into view first, and a step whose element isn't
// there shows its card in the middle with no spotlight. Tapping outside the
// card does nothing; Escape skips, arrow keys and Enter move.
import { api } from './api.js';
import { h } from './ui.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A tab, wherever it is showing: the bottom bar on phones, the header on wide screens.
const tab = (name) => [`#bottom-nav .nav-item[data-name="${name}"]`, `.seg .seg-item[data-name="${name}"]`];

function steps(status) {
  const owner = status?.ownerName || 'the owner';
  const isOwner = status?.user?.isOwner !== false;
  return [
    { route: 'home', targets: [['.hero-pick .eyebrow', '.hero-pick .hero-title']], title: 'Your picks',
      text: 'Your 4 for this week, the movies at your theaters you\'ll most likely love. The match score shows how sure we are.' },
    { route: 'home', targets: [['.pick-card .rate-inline'], ['.worth-list .rate-inline']], title: 'Ratings',
      text: 'Rate what you\'ve seen. Every rating makes next week\'s picks better.' },
    { route: 'home', targets: [['.pick-card .owner-buttons .icon-btn:not(.not-for-me)'], ['.hero-pick .hero-actions .icon-btn[aria-pressed]']], title: 'Watchlist',
      text: 'Save movies you want to see. They get a boost and you\'ll get a heads-up before they leave.' },
    { route: 'home', targets: [['.pick-card .not-for-me'], ['.hero-pick .not-for-me']], title: 'Not for me',
      text: 'Not interested? Hide it and it won\'t come back. You can undo in Settings.' },
    { route: 'schedule', targets: tab('schedule').map((s) => [s]), title: 'Schedule',
      text: 'What\'s leaving soon (last chance) and what\'s opening soon.' },
    { route: null, targets: [['#search-btn']], title: 'Search',
      text: 'Find any movie, even old ones, to rate or save.' },
    isOwner ? null : { route: 'together', targets: tab('together').map((s) => [s]), title: 'Together',
      text: `Plan a movie with ${owner}. Turn it on in Settings and you'll both see what you'd both enjoy.` },
    { route: 'stats', targets: tab('stats').map((s) => [s]), title: 'Stats',
      text: 'Your taste in numbers. Tap any genre, director or actor to see those movies.' },
    { route: 'settings', targets: [['#settings-btn']], title: 'Settings',
      text: 'Theaters, notifications and more live here. You can replay this tour anytime.' },
  ].filter(Boolean);
}

let active = null;
let endedHere = false; // finished or skipped on this page load: never again on its own
export const tourActive = () => Boolean(active);

export function shouldAutoTour(status) {
  return Boolean(status && !status.guest && status.user && !status.tourDone && !endedHere);
}

const shown = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
};
const firstShown = (sel) => [...document.querySelectorAll(sel)].find(shown) || null;

// The step's elements: the first target group whose every element is showing.
// Several selectors in one group are lit together (one spotlight around all).
function resolve(step) {
  for (const group of step.targets) {
    const els = group.map(firstShown);
    if (els.every(Boolean)) {
      // Group members belong together: the later ones from the same card as the first.
      if (els.length > 1) {
        const card = els[0].closest('.hero-pick, .pick-card, .list-row');
        if (card) for (let i = 1; i < els.length; i++) els[i] = card.querySelector(group[i]) || els[i];
      }
      return els;
    }
  }
  return null;
}

const inFixedBar = (el) => Boolean(el.closest('.app-header, .bottom-nav'));
const union = (els) => els.map((e) => e.getBoundingClientRect()).reduce((a, r) => ({
  top: Math.min(a.top, r.top), left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom),
}), { top: Infinity, left: Infinity, right: -Infinity, bottom: -Infinity });

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
async function scrollSettled() {
  let last = -1;
  for (let i = 0, still = 0; i < 90 && still < 3; i++) {
    await frame();
    still = window.scrollY === last ? still + 1 : 0;
    last = window.scrollY;
  }
}

// Waits for the page to finish drawing and the step's elements to show up.
async function waitForTargets(step, token) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (token !== active?.token) return null;
    const main = document.querySelector('#main');
    const busy = !main || main.querySelector('.spinner, .skeleton');
    if (!busy) {
      const els = resolve(step);
      if (els) return els;
      if (Date.now() - t0 > 2500) return null; // drawn, and it isn't there
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

export function startTour(ctx) {
  if (active) return;
  const status = ctx.getStatus();
  if (!status || status.guest) return;
  const list = steps(status);
  const opener = document.activeElement;
  const count = h('p', { class: 'tour-count' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text', id: 'tour-text' });
  const back = h('button', { class: 'btn ghost tour-back', type: 'button' }, 'Back');
  const next = h('button', { class: 'btn tour-next', type: 'button' }, 'Next');
  const skip = h('button', { class: 'link-btn tour-skip', type: 'button' }, 'Skip tour');
  const card = h('section', {
    class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text', tabindex: '-1',
  }, count, title, text, h('div', { class: 'tour-actions' }, skip, h('div', { class: 'tour-moves' }, back, next)));
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  // The layer takes every tap outside the card, and does nothing with it.
  const layer = h('div', { class: 'tour-layer' }, spot, card);
  layer.addEventListener('click', (e) => { if (!card.contains(e.target)) { e.preventDefault(); e.stopPropagation(); } });
  document.body.appendChild(layer);
  document.documentElement.classList.add('touring');

  let at = 0;
  let els = null;
  let ourNav = null; // resolves when the tour's own hash change arrives
  active = { token: 0 };

  const place = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(360, vw - 32);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight;
    if (!els) {
      spot.hidden = true;
      card.style.left = `${Math.round((vw - cw) / 2)}px`;
      card.style.top = `${Math.round(Math.max(16, (vh - ch) / 2))}px`;
      return;
    }
    const u = union(els);
    const pad = 6;
    const r = { top: u.top - pad, left: u.left - pad, width: u.right - u.left + pad * 2, height: u.bottom - u.top + pad * 2 };
    spot.hidden = false;
    Object.assign(spot.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    const gap = 12;
    const below = vh - (r.top + r.height) - gap - 16;
    const above = r.top - gap - 16;
    let top;
    if (below >= ch) top = r.top + r.height + gap;
    else if (above >= ch) top = r.top - gap - ch;
    else top = below >= above ? vh - ch - 16 : 16;
    const left = Math.min(Math.max(16, r.left + r.width / 2 - cw / 2), vw - 16 - cw);
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
  };
  const onMove = () => { if (active) place(); };
  // Late layout (a web font arriving, a poster loading above) moves things
  // without a scroll or resize, so the spotlight follows size changes too.
  let moveQueued = false;
  const resized = new ResizeObserver(() => {
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => { moveQueued = false; onMove(); });
  });

  const show = async (i) => {
    at = i;
    const token = ++active.token;
    const step = list[i];
    count.textContent = `${i + 1} of ${list.length}`;
    title.textContent = step.title;
    text.textContent = step.text;
    back.hidden = i === 0;
    next.textContent = i === list.length - 1 ? 'Done' : 'Next';
    layer.classList.add('moving');
    if (step.route && !location.hash.startsWith(`#/${step.route}`)) {
      // The app's router runs on the same hash change, first; the page is
      // drawn once #main loses its spinner (waitForTargets).
      const arrived = new Promise((resolve) => { ourNav = resolve; });
      ctx.navigate(`#/${step.route}`);
      await Promise.race([arrived, new Promise((r) => setTimeout(r, 3000))]);
      ourNav = null;
      if (token !== active?.token) return;
    }
    const found = await waitForTargets(step, token);
    await document.fonts?.ready;
    if (token !== active?.token) return;
    els = found;
    resized.disconnect();
    for (const el of [document.querySelector('#main'), ...(els || [])]) if (el) resized.observe(el);
    if (els && !els.every(inFixedBar)) {
      els[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      await scrollSettled();
      if (token !== active?.token) return;
    }
    place();
    layer.classList.remove('moving');
    next.focus({ preventScroll: true });
  };

  const end = async ({ done }) => {
    if (!active) return;
    active = null;
    resized.disconnect();
    window.removeEventListener('scroll', onMove, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    document.documentElement.classList.remove('touring');
    endedHere = true;
    if (done) ctx.navigate('#/home');
    else if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true });
    try { await api.saveSettings({ tourDone: true }); } catch { /* shows again next time; nothing lost */ }
    ctx.refreshStatus();
  };

  // Leaving the tour's page some other way (the browser's back button) ends it.
  const onHash = () => {
    if (ourNav) { ourNav(); ourNav = null; return; }
    end({ done: false });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end({ done: false }); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); return; }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && card.contains(e.target))) { e.preventDefault(); e.stopPropagation(); go(1); return; }
    if (e.key === 'Tab') {
      const items = [skip, back, next].filter((b) => !b.hidden);
      const idx = items.indexOf(document.activeElement);
      e.preventDefault();
      e.stopPropagation();
      items[(idx + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      return;
    }
    // Nothing else reaches the page underneath ("/" would open search).
    if (!card.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
  };
  const go = (d) => {
    const n = at + d;
    if (n < 0) return;
    if (n >= list.length) { end({ done: true }); return; }
    show(n);
  };
  next.addEventListener('click', () => go(1));
  back.addEventListener('click', () => go(-1));
  skip.addEventListener('click', () => end({ done: false }));
  window.addEventListener('scroll', onMove, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('hashchange', onHash);
  document.addEventListener('keydown', onKey, true);
  show(0);
}
