// The guided tour: a spotlight on the real element and a short card beside
// it, step by step across the tabs. It opens on its own once, on Picks, for
// anyone who hasn't finished or skipped it (tourDone, stored per user), right
// after the welcome setup for someone new; Replay tour under You, Help, opens
// it again. The guest link never gets it.
//
// The spotlight only ever lands on an element that is on screen and showing:
// page elements are scrolled into view first, and a step whose element isn't
// there shows its card in the middle with no spotlight. Tapping outside the
// card does nothing; Escape skips, arrow keys and Enter move.
import { api } from './api.js';
import { h, reduced } from './ui.js';


// A tab, wherever it is showing: the bottom bar on phones, the header on wide screens.
const tab = (name) => [`#bottom-nav .nav-item[data-name="${name}"]`, `.seg .seg-item[data-name="${name}"]`];

function steps(status) {
  const owner = status?.ownerName || 'the owner';
  const isOwner = status?.user?.isOwner !== false;
  return [
    { route: 'home', targets: [['.hero-pick .hero-line', '.hero-pick .hero-title']], title: 'Your four',
      text: 'The four films at your theaters you\'re most likely to love this week, best first. The match says how likely.' },
    { route: 'home', targets: [['.hero-pick .btn.book']], title: 'Book',
      text: 'Book opens the best showtime on AMC. Seat by, under it, is when the film itself starts after the previews.' },
    { route: 'home', targets: [['.hero-pick .hero-buttons']], title: 'Save or skip',
      text: 'Save keeps a film on your watchlist and gives it a boost. Not for me hides it; you can bring it back from Settings.' },
    { route: 'home', targets: [['.hero-pick .go-btn'], ['.hero-pick .plan-pill']], title: 'I\'m going',
      text: 'Going to a showing? Tap I\'m going. You get a reminder two hours before, and the next morning a quick question: did you see it?' },
    { route: 'home', targets: [['.hero-pick .send-btn']], title: 'Send a pick',
      text: isOwner ? 'Think a friend would love it? Send it with a short note. It waits for them at the top of their Picks.'
        : `Think ${owner} would love it? Send it with a short note. It waits for them at the top of their Picks.` },
    { route: 'home', targets: [['.day-strip']], title: 'Pick a day',
      text: 'Every showtime on Picks follows the day you choose here.' },
    { route: 'home', targets: [['.pick-card .rate-inline'], ['.worth-list .rate-inline']], title: 'Rate as you go',
      text: 'Seen one already? Rate it right on the card. Every rating sharpens next week\'s four.' },
    { route: 'home', targets: [['#wsw-btn']], title: 'What should I watch?',
      text: 'Can\'t decide? Answer three quick questions and get three films that fit, at the theater or at home.' },
    { route: 'home', targets: [['#at-home .section-head', '#at-home .home-card'], ['#at-home .section-head', '#at-home .home-setup'], ['#at-home .section-head']], title: 'At home',
      text: 'Staying in? Your best matches this week on the streaming services you have, scored the same way.' },
    { route: 'schedule', targets: tab('schedule').map((s) => [s]), title: 'Schedule',
      text: 'What\'s leaving soon, day by day, and what\'s opening soon.' },
    { route: 'rate', targets: tab('rate').map((s) => [s]), title: 'Rate',
      text: 'Find any film to rate, or bring in your ratings from Letterboxd or IMDb.' },
    { route: 'watchlist', targets: tab('watchlist').map((s) => [s]), title: 'Watchlist',
      text: 'Everything you\'ve saved, with a heads-up before it leaves your theater.' },
    { route: null, targets: [['#search-btn']], title: 'Search',
      text: 'Find any film, even old ones, to rate or save. Press / on a keyboard.' },
    { route: 'help', targets: tab('you').map((s) => [s]), title: 'You',
      text: isOwner ? 'Your stats, Together, Settings and this tour live under You.'
        : `Your stats, Together (plan a film with ${owner}), Settings and this tour live under You.` },
  ];
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
  const startHash = location.hash;
  const count = h('p', { class: 'tour-count' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text', id: 'tour-text' });
  const back = h('button', { class: 'btn soft tour-back', type: 'button' }, 'Back');
  const next = h('button', { class: 'btn tour-next', type: 'button' }, 'Next');
  const skip = h('button', { class: 'link-btn tour-skip', type: 'button' }, 'Skip tour');
  // Focus stays on Next from step to step, which says nothing new, so the
  // step's words are a live region: each new step is read out.
  const card = h('section', {
    class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text', tabindex: '-1',
  }, h('div', { class: 'tour-words', 'aria-live': 'polite', 'aria-atomic': 'true' }, count, title, text), h('div', { class: 'tour-actions' }, skip, h('div', { class: 'tour-moves' }, back, next)));
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

  // Skipped from a page the tour moved to (it began on Help, say): go back
  // there and put focus on Replay tour again, where it was.
  const returnToStart = async () => {
    ctx.navigate(startHash);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const again = document.querySelector('.tour-replay');
      if (again) { again.focus({ preventScroll: true }); return; }
    }
  };

  const end = async ({ done, away = false }) => {
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
    else if (!away && location.hash !== startHash) returnToStart();
    // The tour shows where Stats, Together and Settings are, so the one-time
    // note about them moving (js/app.js) isn't needed after it.
    try { await api.saveSettings({ tourDone: true, youNoteSeen: true }); } catch { /* shows again next time; nothing lost */ }
    ctx.refreshStatus();
  };

  // Leaving the tour's page some other way (the browser's back button) ends it.
  const onHash = () => {
    if (ourNav) { ourNav(); ourNav = null; return; }
    end({ done: false, away: true });
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
