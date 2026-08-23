// App shell, hash router, chrome (header + bottom nav), and refresh polling.
import { api } from './api.js';
import { h, clear, toast, spinner, emptyState } from './ui.js';
import * as home from './views/home.js';
import * as detail from './views/detail.js';
import * as coming from './views/coming.js';
import * as rate from './views/rate.js';
import * as watchlist from './views/watchlist.js';
import * as stats from './views/stats.js';
import * as settings from './views/settings.js';
import * as onboarding from './views/onboarding.js';

const routes = {
  home: home.render,
  movie: detail.render,
  coming: coming.render,
  rate: rate.render,
  watchlist: watchlist.render,
  stats: stats.render,
  settings: settings.render,
  onboarding: onboarding.render,
};

const NAV = [
  { name: 'home', label: 'Picks', icon: '🎬' },
  { name: 'coming', label: 'Coming', icon: '🗓️' },
  { name: 'rate', label: 'Rate', icon: '⭐' },
  { name: 'watchlist', label: 'Watchlist', icon: '🔖' },
  { name: 'stats', label: 'Stats', icon: '📊' },
];

let status = null;
let refreshing = false;

const ctx = {
  getStatus: () => status,
  isGuest: () => Boolean(status?.guest),
  refreshStatus,
  navigate: (hash) => { location.hash = hash; },
  rerender: () => route(),
  triggerRefresh: doRefresh,
};

const GUEST_ROUTES = new Set(['home', 'coming', 'movie']);

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
    keys: document.querySelector('#key-warn'),
    refreshBtn: document.querySelector('#refresh-btn'),
    nav: document.querySelector('#bottom-nav'),
  };
}

function renderChrome() {
  const els = chromeEls();
  if (!els.theatre) return;
  const guest = Boolean(status?.guest);
  document.querySelector('.shell')?.classList.toggle('guest', guest);

  const banner = document.querySelector('#guest-banner');
  if (banner) banner.textContent = guest ? `${status?.ownerName || 'Owner'}'s picks — read only` : '';

  const extra = Math.max(0, (status?.theatres?.length || 1) - 1);
  els.theatre.textContent = (status?.theatre?.name || (guest ? '' : 'Set your theatre')) + (extra ? ` +${extra}` : '');
  // Guests can't open Settings, so the label just goes back to Picks.
  els.theatre.setAttribute('href', guest ? '#/home' : '#/settings');
  els.theatre.title = extra
    ? `Also following: ${status.theatres.filter((t) => !t.isPrimary).map((t) => t.name).join(', ')}`
    : '';

  const missing = (!guest && status?.keys)
    ? Object.entries(status.keys).filter(([, v]) => !v).map(([k]) => k.toUpperCase())
    : [];
  clear(els.keys);
  if (missing.length) {
    els.keys.appendChild(h('a', { class: 'key-warn', href: '#/settings' },
      `⚠︎ Add ${missing.join(', ')} key${missing.length > 1 ? 's' : ''}`));
  }
  // AMC titles that couldn't be matched to TMDB are invisible to the ranking;
  // keep that visible until they're matched or ignored (owner only).
  const unmatched = guest ? 0 : (status?.counts?.unmatchedAmc || 0);
  const review = guest ? 0 : (status?.counts?.reviewAmc || 0);
  if (unmatched || review) {
    const bits = [];
    if (unmatched) bits.push(`${unmatched} unmatched AMC title${unmatched > 1 ? 's' : ''}`);
    if (review) bits.push(`${review} match${review > 1 ? 'es' : ''} to review`);
    els.keys.appendChild(h('a', { class: 'key-warn', href: '#/settings', title: 'Settings → AMC title matching' },
      `⚠︎ ${bits.join(' · ')}`));
  }

  els.refreshBtn.classList.toggle('spinning', refreshing || Boolean(status?.refreshing));
  els.refreshBtn.title = status?.lastRefresh
    ? `Last updated ${new Date(status.lastRefresh).toLocaleString()}`
    : 'Refresh';
}

function updateNavActive(name) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.name === name);
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
      toast(`Still refreshing… (${min} min — first runs with several theatres take a while)`);
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
    else toast('Refresh is still running after 20 minutes — check Settings → Data for warnings', 'error');
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
  const view = routes[name] || routes.home;
  const main = document.querySelector('#main');
  clear(main);
  main.appendChild(spinner('Loading…'));
  updateNavActive(name);
  try {
    await view(main, params, ctx);
  } catch (e) {
    clear(main);
    main.appendChild(emptyState('😕', 'Something went wrong', e.message,
      h('button', { class: 'btn', onClick: () => route() }, 'Retry')));
  }
  window.scrollTo(0, 0);
}

function buildShell() {
  const app = document.querySelector('#app');
  clear(app);
  app.appendChild(
    h('div', { class: 'shell' },
      h('header', { class: 'app-header' },
        h('a', { class: 'brand', href: '#/home' },
          h('span', { class: 'brand-mark' }, '🎞️'),
          h('span', { class: 'brand-name' }, 'Reel Picks'),
        ),
        h('div', { class: 'header-mid' },
          h('a', { id: 'theatre-name', class: 'theatre-name', href: '#/settings' }, '…'),
          h('span', { id: 'key-warn' }),
        ),
        h('div', { class: 'header-actions' },
          h('button', { id: 'refresh-btn', class: 'icon-btn', title: 'Refresh', onClick: doRefresh }, '↻'),
          h('a', { class: 'icon-btn', href: '#/settings', title: 'Settings' }, '⚙️'),
        ),
      ),
      h('div', { id: 'guest-banner', class: 'guest-banner' }),
      h('main', { id: 'main' }),
      h('nav', { id: 'bottom-nav', class: 'bottom-nav' },
        ...NAV.map((n) => h('a', { class: 'nav-item', 'data-name': n.name, href: `#/${n.name}` },
          h('span', { class: 'nav-icon' }, n.icon),
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
  route();

  // Register the service worker (PWA install/offline). Non-fatal if it fails.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
