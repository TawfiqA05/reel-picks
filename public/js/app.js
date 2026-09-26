// App shell, hash router, chrome (header + bottom nav), and refresh polling.
import { api } from './api.js';
import { h, clear, toast, spinner, emptyState, icon } from './ui.js';
import { watchForUpdates } from './update.js';
import { openSearch } from './search.js';
import * as home from './views/home.js';
import * as detail from './views/detail.js';
import * as coming from './views/coming.js';
import * as leaving from './views/leaving.js';
import * as rate from './views/rate.js';
import * as watchlist from './views/watchlist.js';
import * as stats from './views/stats.js';
import * as together from './views/together.js';
import * as settings from './views/settings.js';
import * as onboarding from './views/onboarding.js';

const routes = {
  home: home.render,
  movie: detail.render,
  coming: coming.render,
  leaving: leaving.render,
  rate: rate.render,
  watchlist: watchlist.render,
  stats: stats.render,
  together: together.render,
  settings: settings.render,
  onboarding: onboarding.render,
};

const NAV = [
  { name: 'home', label: 'Picks', icon: 'film' },
  { name: 'coming', label: 'Coming', icon: 'calendar' },
  { name: 'leaving', label: 'Leaving', icon: 'hourglass' },
  { name: 'rate', label: 'Rate', icon: 'star' },
  { name: 'watchlist', label: 'Watchlist', icon: 'bookmark' },
  { name: 'together', label: 'Together', icon: 'users' },
  { name: 'stats', label: 'Stats', icon: 'chart' },
];

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
};

// Leaving reads only /api/recommendations, which is already on the guest
// allowlist and already strips drive times and home coordinates for guests.
const GUEST_ROUTES = new Set(['home', 'coming', 'leaving', 'movie']);

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
    theatre: document.querySelector('#theatre-name'),
    userChip: document.querySelector('#user-chip'),
    settingsBtn: document.querySelector('#settings-btn'),
    refreshBtn: document.querySelector('#refresh-btn'),
    searchBtn: document.querySelector('#search-btn'),
    nav: document.querySelector('#bottom-nav'),
  };
}

function renderChrome() {
  const els = chromeEls();
  if (!els.theatre) return;
  const guest = Boolean(status?.guest);
  document.querySelector('.shell')?.classList.toggle('guest', guest);
  // Who's signed in, beside Settings. The guest link has its own banner.
  if (els.userChip) {
    const name = !guest && status?.user?.name ? status.user.name : '';
    els.userChip.textContent = name;
    els.userChip.hidden = !name;
    els.userChip.title = name ? `Signed in as ${name}` : '';
  }
  // Search is the owner's and friends'; the guest link has none (and the
  // server refuses it). Hidden until status says who this is.
  if (els.searchBtn) els.searchBtn.hidden = !status || guest;
  // A friend can't force a refresh; the server would refuse it anyway.
  document.querySelector('.shell')?.classList.toggle('friend', !guest && status?.user?.isOwner === false);

  const banner = document.querySelector('#guest-banner');
  if (banner) banner.textContent = guest ? `${status?.ownerName || 'Owner'}'s picks, read only` : '';

  const extra = Math.max(0, (status?.theatres?.length || 1) - 1);
  const primary = status?.theatre;
  els.theatre.textContent = (primary?.short || primary?.name || (guest ? '' : 'Set your theatre')) + (extra ? ` +${extra}` : '');
  // Guests can't open Settings, so the label just goes back to Picks.
  els.theatre.setAttribute('href', guest ? '#/home' : '#/settings');
  els.theatre.title = extra
    ? `${primary?.name || ''}. Also following ${status.theatres.filter((t) => !t.isPrimary).map((t) => t.name).join(', ')}`
    : (primary?.name || '');

  // Anything that needs the owner's attention (a missing key, AMC titles that
  // couldn't be matched and so are invisible to the ranking, matches to review)
  // is a dot on the Settings button. The full text lives in Settings and in the
  // note above Everything playing, not in the header.
  const missing = (!guest && status?.keys) ? Object.values(status.keys).filter((v) => !v).length : 0;
  const unmatched = guest ? 0 : (status?.counts?.unmatchedAmc || 0);
  const review = guest ? 0 : (status?.counts?.reviewAmc || 0);
  const attention = missing + unmatched + review;
  els.settingsBtn.classList.toggle('has-dot', attention > 0);
  els.settingsBtn.setAttribute('aria-label', attention
    ? `Settings, ${attention} item${attention > 1 ? 's' : ''} need${attention > 1 ? '' : 's'} attention`
    : 'Settings');
  els.settingsBtn.title = attention
    ? [missing && `${missing} missing key${missing > 1 ? 's' : ''}`, unmatched && `${unmatched} unmatched AMC title${unmatched > 1 ? 's' : ''}`, review && `${review} match${review > 1 ? 'es' : ''} to review`].filter(Boolean).join(', ')
    : 'Settings';

  els.refreshBtn.classList.toggle('spinning', refreshing || Boolean(status?.refreshing));
  els.refreshBtn.title = status?.lastRefresh
    ? `Refresh. Last updated ${new Date(status.lastRefresh).toLocaleString()}`
    : 'Refresh';
  els.refreshBtn.setAttribute('aria-busy', String(refreshing || Boolean(status?.refreshing)));
}

function updateNavActive(name) {
  // A movie page belongs to no tab; everything else lights its own.
  document.querySelectorAll('.nav-item, .seg-item').forEach((el) => {
    const on = el.dataset.name === name;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
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
      toast(`Still refreshing (${min} min). First runs with several theatres take a while.`);
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

async function route() {
  const { name, params } = parseHash();
  // Guests are confined to picks / coming soon / movie detail.
  if (Boolean(status?.guest) && !GUEST_ROUTES.has(name)) {
    if (location.hash !== '#/home') { location.hash = '#/home'; return; }
  }
  const view = routes[name] || notFound;
  const main = document.querySelector('#main');
  clear(main);
  // Picks draws its own skeleton; everything else gets the spinner.
  if (view !== routes.home) main.appendChild(spinner('Loading…'));
  updateNavActive(name);
  try {
    await view(main, params, ctx);
  } catch (e) {
    clear(main);
    main.appendChild(emptyState('alert', 'Something went wrong', e.message,
      h('button', { class: 'btn', onClick: () => route() }, 'Retry')));
  }
  window.scrollTo(0, 0);
}

function notFound(root) {
  clear(root);
  root.appendChild(emptyState('search', 'Page not found', 'There is nothing at this address.',
    h('a', { class: 'btn', href: '#/home' }, 'Go to Picks')));
}

function buildShell() {
  const app = document.querySelector('#app');
  clear(app);
  app.appendChild(
    h('div', { class: 'shell' },
      h('header', { class: 'app-header' },
        h('a', { class: 'brand', href: '#/home', 'aria-label': 'Reel Picks, home' },
          icon('reel', { size: 22, cls: 'brand-mark' }),
          h('span', { class: 'brand-name' }, 'Reel Picks'),
        ),
        // Wide screens: the tabs move up here as a segmented control and the
        // bottom bar goes away.
        h('nav', { class: 'seg', 'aria-label': 'Sections' },
          ...NAV.map((n) => h('a', { class: 'seg-item', 'data-name': n.name, href: `#/${n.name}` }, n.label)),
        ),
        h('div', { class: 'header-actions' },
          h('a', { id: 'theatre-name', class: 'theatre-name', href: '#/settings' }, ''),
          h('button', { id: 'search-btn', class: 'icon-btn round', type: 'button', hidden: true, 'aria-label': 'Search movies', title: 'Search (/)', 'aria-haspopup': 'dialog', onClick: () => openSearch() }, icon('search', { size: 20 })),
          h('button', { id: 'refresh-btn', class: 'icon-btn round', type: 'button', 'aria-label': 'Refresh showtimes and scores', title: 'Refresh', onClick: doRefresh }, icon('refresh', { size: 20 })),
          h('span', { id: 'user-chip', class: 't-chip user-chip', hidden: true }),
          h('a', { id: 'settings-btn', class: 'icon-btn round', href: '#/settings', 'aria-label': 'Settings', title: 'Settings' },
            icon('settings', { size: 20 }), h('span', { class: 'attn-dot', 'aria-hidden': 'true' })),
        ),
      ),
      h('div', { id: 'guest-banner', class: 'guest-banner' }),
      h('main', { id: 'main' }),
      h('nav', { id: 'bottom-nav', class: 'bottom-nav', 'aria-label': 'Sections' },
        ...NAV.map((n) => h('a', { class: 'nav-item', 'data-name': n.name, href: `#/${n.name}` },
          h('span', { class: 'nav-icon' }, icon(n.icon, { size: 22 })),
          h('span', { class: 'nav-label' }, n.label),
        )),
      ),
    ),
  );
}

async function boot() {
  buildShell();
  await refreshStatus();
  if (!location.hash) location.hash = '#/home';
  window.addEventListener('hashchange', route);
  // "/" opens search from anywhere that isn't a text field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .modal-overlay')) return;
    if (!status || status.guest) return;
    e.preventDefault();
    openSearch();
  });
  route();

  // Service worker (PWA install/offline) and getting new deploys onto this
  // page. Non-fatal if it fails.
  watchForUpdates();
}

boot();
