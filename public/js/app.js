// App shell, hash router, chrome (header + bottom nav), and refresh polling.
import { api } from './api.js';
import { h, clear, toast, spinner, emptyState, icon, ensureToastHost } from './ui.js';
import { watchForUpdates } from './update.js';
import { openSearch } from './search.js';
import { startTour, shouldAutoTour, tourActive } from './tour.js';
import * as home from './views/home.js';
import * as detail from './views/detail.js';
import * as schedule from './views/schedule.js';
import * as rate from './views/rate.js';
import * as watchlist from './views/watchlist.js';
import * as you from './views/you.js';
import * as onboarding from './views/onboarding.js';
import * as welcome from './views/welcome.js';

const routes = {
  home: home.render,
  movie: detail.render,
  schedule: schedule.render,
  rate: rate.render,
  watchlist: watchlist.render,
  // You holds Stats, Together, Settings and Help; each keeps its own address.
  you: you.render,
  stats: (root, params, c) => you.render(root, ['stats', ...params], c),
  together: (root, params, c) => you.render(root, ['together', ...params], c),
  settings: (root, params, c) => you.render(root, ['settings', ...params], c),
  help: (root, params, c) => you.render(root, ['help', ...params], c),
  onboarding: onboarding.render,
  welcome: welcome.render,
};

const NAV = [
  { name: 'home', label: 'Picks', icon: 'film' },
  { name: 'schedule', label: 'Schedule', icon: 'calendar' },
  { name: 'rate', label: 'Rate', icon: 'star' },
  { name: 'watchlist', label: 'Watchlist', icon: 'bookmark' },
  { name: 'you', label: 'You', icon: 'user' },
];
// Pages that live under a tab without being its first page.
const TAB_OF = { stats: 'you', together: 'you', settings: 'you', help: 'you' };

let status = null;
let refreshing = false;

const ctx = {
  getStatus: () => status,
  isGuest: () => Boolean(status?.guest),
  // The owner's own controls (refresh, AMC matching, friends). A signed-in
  // friend and the guest link both get false.
  isOwner: () => Boolean(status && !status.guest && status.user?.isOwner !== false),
  refreshStatus,
  navigate: (hash) => { location.hash = hash; },
  rerender: () => route(),
  triggerRefresh: doRefresh,
  startTour: () => startTour(ctx),
  setGlow,
};

// The dark theme's glow behind the top of the page (Picks and the movie
// page): the film's poster colour, or `null` for the faint amber one.
// Anything else (undefined) takes it away; every route change does.
function setGlow(color) {
  const shell = document.querySelector('.shell');
  if (!shell) return;
  shell.classList.toggle('has-glow', color !== undefined);
  shell.classList.toggle('glow-faint', color === null);
  if (color) shell.style.setProperty('--glow-color', color);
  else shell.style.removeProperty('--glow-color');
}

// Schedule's Leaving segment reads only /api/recommendations, which is already
// on the guest allowlist and already strips drive times and home coordinates
// for guests.
const GUEST_ROUTES = new Set(['home', 'schedule', 'movie']);
// Coming and Leaving were tabs of their own; their old addresses open the
// matching Schedule segment.
const MOVED = { coming: '#/schedule/coming', leaving: '#/schedule/leaving' };

async function refreshStatus() {
  try {
    status = await api.status();
  } catch (e) {
    status = null;
  }
  renderChrome();
  return status;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'home', params: rest };
}

function chromeEls() {
  return {
    searchBtn: document.querySelector('#search-btn'),
    youTabs: document.querySelectorAll('.nav-item[data-name="you"], .seg-item[data-name="you"]'),
  };
}

function renderChrome() {
  const els = chromeEls();
  if (!els.searchBtn) return;
  const guest = Boolean(status?.guest);
  document.querySelector('.shell')?.classList.toggle('guest', guest);
  // A friend can't force a refresh (pull-to-refresh just re-fetches for them).
  document.querySelector('.shell')?.classList.toggle('friend', !guest && status?.user?.isOwner === false);
  // Search is the owner's and friends'; the guest link has none (and the
  // server refuses it). Hidden until status says who this is.
  els.searchBtn.hidden = !status || guest;

  // The guest link's one piece of guidance, in place of the setup and tour.
  const banner = document.querySelector('#guest-banner');
  if (banner) banner.textContent = guest ? `You're viewing ${status?.ownerName || 'the owner'}'s picks. Ask him for an invite to get your own.` : '';

  // Anything in Settings that needs the owner (a missing key, AMC titles that
  // couldn't be matched, matches to review) is a dot on the You tab, and the
  // tab says so in words. The full text lives in Settings.
  const missing = (!guest && status?.keys) ? Object.values(status.keys).filter((v) => !v).length : 0;
  const unmatched = guest ? 0 : (status?.counts?.unmatchedAmc || 0);
  const review = guest ? 0 : (status?.counts?.reviewAmc || 0);
  const attention = missing + unmatched + review;
  const words = attention
    ? [missing && `${missing} missing key${missing > 1 ? 's' : ''}`, unmatched && `${unmatched} unmatched AMC title${unmatched > 1 ? 's' : ''}`, review && `${review} match${review > 1 ? 'es' : ''} to review`].filter(Boolean).join(', ')
    : '';
  for (const tab of els.youTabs) {
    tab.classList.toggle('has-dot', attention > 0);
    tab.setAttribute('aria-label', attention ? `You. Settings: ${words}` : 'You');
    tab.title = attention ? `Settings: ${words}` : '';
  }
}

function updateNavActive(name) {
  // A movie page belongs to no tab; everything else lights its own.
  const tab = TAB_OF[name] || name;
  document.querySelectorAll('.nav-item, .seg-item').forEach((el) => {
    const on = el.dataset.name === tab;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    // A tab left for another page (the back button, a link in the page) lets
    // go of focus, so its focus ring can't linger there like a highlight.
    if (!on && el === document.activeElement) el.blur();
  });
}

// Poll until the server says it's idle. Resolves true when done, false only
// after the hard cap — a first run with several theatres can take minutes, and
// the old 2-minute cutoff reported "Up to date" while the server was still busy.
async function pollUntilDone(maxMs = 20 * 60000) {
  const start = Date.now();
  let nudgedMin = 0;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await api.status().catch(() => null);
    if (s) status = s;
    renderChrome();
    if (s && !s.refreshing && !s.matching) return true;
    const min = Math.floor((Date.now() - start) / 60000);
    if (min >= 1 && min > nudgedMin) {
      nudgedMin = min;
      toast(`Still refreshing (${min} min). First runs with several theaters take a while.`);
    }
  }
  return false;
}

async function doRefresh() {
  if (refreshing || status?.refreshing) return;
  refreshing = true;
  renderChrome();
  try {
    const r = await api.refresh();
    toast(r?.queued ? 'Refresh queued behind the one in progress…' : 'Refreshing showtimes & scores…');
    const done = await pollUntilDone();
    if (done) toast('Up to date', 'success');
    else toast('Refresh is still running after 20 minutes. Check Settings, then Data, for warnings.', 'error');
    await refreshStatus();
    route();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    refreshing = false;
    renderChrome();
  }
}

let routeSeq = 0;

async function route() {
  const { name, params } = parseHash();
  if (MOVED[name]) { location.replace(MOVED[name]); return; }
  // Guests are confined to picks / schedule / movie detail.
  if (Boolean(status?.guest) && !GUEST_ROUTES.has(name)) {
    if (location.hash !== '#/home') { location.hash = '#/home'; return; }
  }
  const view = routes[name] || notFound;
  const seq = ++routeSeq;
  // Each visit draws into a box of its own: a page still loading when the
  // reader moves on finishes into a box that's gone, never under the new page.
  const root = h('div', { class: 'view' });
  document.querySelector('#main').replaceChildren(root);
  // A page's Save bar (Settings) leaves with the page, and so does its room.
  document.body.classList.remove('has-save');
  // Picks draws its own skeleton; everything else gets the spinner.
  if (view !== routes.home) root.appendChild(spinner('Loading…'));
  setGlow(undefined);
  updateNavActive(name);
  try {
    await view(root, params, ctx);
  } catch (e) {
    if (seq !== routeSeq) return;
    clear(root);
    root.appendChild(errorState(e));
  }
  if (seq !== routeSeq) return;
  window.scrollTo(0, 0);
  // Anyone who hasn't seen the tour gets it once, on Picks (right after the
  // welcome setup for someone new).
  if (name === 'home' && location.hash.startsWith('#/home') && shouldAutoTour(status) && !welcome.needsSetup(status) && !tourActive()) startTour(ctx);
  else youNote();
}

// Once, for everyone who knew the old six tabs: where three of them went.
// Someone new learns it from the tour instead (which marks it seen too).
let youNoted = false;
function youNote() {
  if (youNoted || !status || status.guest || !status.user || status.youNoteSeen || !status.tourDone || tourActive()) return;
  youNoted = true;
  status.youNoteSeen = true;
  toast('Stats, Together and Settings are now under You.', '', {
    duration: 9000,
    action: { label: 'Open You', onClick: () => { location.hash = '#/you'; } },
  });
  api.saveSettings({ youNoteSeen: true }).catch(() => {});
}

// The service worker answers API calls with a 503 "You appear to be offline."
// when there's no network; without a worker, fetch itself throws a TypeError.
const isOffline = (e) => !navigator.onLine || e instanceof TypeError || (e.status === 503 && /offline/i.test(e.message));

function errorState(e) {
  const retry = h('button', { class: 'btn', type: 'button', onClick: async () => { await refreshStatus(); route(); } }, 'Retry');
  if (isOffline(e)) {
    return emptyState('alert', 'You\'re offline', 'Reel Picks needs a connection to load this page. Retry once you\'re back online.', retry, { level: 1 });
  }
  if (e.status === 404) {
    return emptyState('search', 'Not found', e.message === 'Movie not found' ? 'There\'s no movie at this address.' : e.message,
      h('a', { class: 'btn', href: '#/home' }, 'Go to Picks'), { level: 1 });
  }
  return emptyState('alert', 'Something went wrong', e.message, retry, { level: 1 });
}

function notFound(root) {
  clear(root);
  root.appendChild(emptyState('search', 'Page not found', 'There is nothing at this address.',
    h('a', { class: 'btn', href: '#/home' }, 'Go to Picks'), { level: 1 }));
}

function buildShell() {
  const app = document.querySelector('#app');
  clear(app);
  app.appendChild(
    h('div', { class: 'shell' },
      h('div', { class: 'page-glow', 'aria-hidden': 'true' }),
      h('header', { class: 'app-header' },
        h('a', { class: 'brand', href: '#/home', 'aria-label': 'Reel Picks, home' },
          icon('reel', { size: 22, cls: 'brand-mark' }),
          h('span', { class: 'brand-name' }, 'Reel Picks'),
        ),
        // Wide screens: the tabs move up here and the bottom bar goes away.
        h('nav', { class: 'seg', 'aria-label': 'Sections' },
          ...NAV.map((n) => h('a', { class: 'seg-item', 'data-name': n.name, href: `#/${n.name}` }, n.label,
            h('span', { class: 'attn-dot', 'aria-hidden': 'true' }))),
        ),
        h('button', { id: 'search-btn', class: 'icon-btn header-search', type: 'button', hidden: true, 'aria-label': 'Search movies', title: 'Search (/)', 'aria-haspopup': 'dialog', onClick: () => openSearch(ctx) }, icon('search', { size: 20 })),
      ),
      h('div', { id: 'guest-banner', class: 'guest-banner' }),
      h('main', { id: 'main' }),
      h('nav', { id: 'bottom-nav', class: 'bottom-nav', 'aria-label': 'Sections' },
        ...NAV.map((n) => h('a', { class: 'nav-item', 'data-name': n.name, href: `#/${n.name}` },
          h('span', { class: 'nav-icon' }, icon(n.icon, { size: 22 }), h('span', { class: 'attn-dot', 'aria-hidden': 'true' })),
          h('span', { class: 'nav-label' }, n.label),
        )),
      ),
    ),
  );
}

async function boot() {
  buildShell();
  ensureToastHost();
  await refreshStatus();
  // A new friend (or anyone with under 5 ratings) who hasn't finished or
  // skipped the welcome setup starts there, whatever the link said.
  if (welcome.needsSetup(status)) history.replaceState(null, '', '#/welcome');
  if (!location.hash) location.hash = '#/home';
  window.addEventListener('hashchange', route);
  // "/" opens search from anywhere that isn't a text field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .modal-overlay')) return;
    if (!status || status.guest) return;
    e.preventDefault();
    openSearch(ctx);
  });
  route();

  // Service worker (PWA install/offline) and getting new deploys onto this
  // page. Non-fatal if it fails.
  watchForUpdates();
}

boot();
