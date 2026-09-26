// Reel Picks service worker: offline app shell, and updates that reach open
// pages without anyone closing the app.
//
// App code (the page, JS, CSS) is network-first: online, every file comes
// from the server, so a page always runs one consistent version. The cache is
// only the offline fallback, and it holds exactly one version: CORE is fetched
// fresh (past the HTTP cache) at install, never written to afterwards, and the
// previous version's cache is deleted when this worker activates. So offline
// can't mix files from two versions either.
//
// A new worker takes over as soon as it installs (skipWaiting + claim). The
// page hears "controllerchange" and reloads once when that's safe
// (js/update.js).
const CACHE = 'reelpicks-v46';
const CORE = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/icons.js', '/js/update.js',
  '/js/fuzzy.js', '/js/filter.js', '/js/search.js', '/js/settingsRules.js', '/js/stream.js', '/js/tour.js',
  '/js/plans.js', '/js/services.js', '/js/wsw.js', '/js/views/athome.js',
  '/js/views/components.js', '/js/views/home.js', '/js/views/detail.js', '/js/views/schedule.js',
  '/js/views/coming.js', '/js/views/leaving.js', '/js/views/rate.js', '/js/views/onboarding.js', '/js/views/welcome.js',
  '/js/views/watchlist.js', '/js/views/stats.js', '/js/views/settings.js', '/js/views/together.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// Workers up to v32 served JS cache-first and their pages have no update
// handling, so a page they loaded would keep running old code after this
// worker takes over. Taking over from one of them reloads its windows once.
// That happens right after such a page loaded (a load is what installs this
// worker), so nothing is mid-action yet. Pages from v33 on reload themselves
// when it's safe (js/update.js).
const UNAWARE = /^reelpicks-v([0-9]|[12][0-9]|3[0-2])$/;

self.addEventListener('activate', (e) => {
  const done = (async () => {
    const keys = await caches.keys();
    const fromUnaware = keys.some((k) => UNAWARE.test(k));
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    return fromUnaware;
  })();
  e.waitUntil(done);
  // After activation, not inside it: the reload's own fetch waits for this
  // worker to finish activating, so awaiting it here would deadlock.
  done.then(async (fromUnaware) => {
    if (!fromUnaware) return;
    const wins = await self.clients.matchAll({ type: 'window' });
    await Promise.all(wins.map((c) => c.navigate(c.url).catch(() => {})));
  }).catch(() => {});
});

// "Your 4 for this week are ready" (server/lib/push.js). The payload is just
// the title, the #1 film and where to go.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Reel Picks', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    tag: d.tag || 'weekly-picks',
    data: { url: d.url || '/#/home' },
  }));
});

// Tapping it opens Picks: in an open Reel Picks window if there is one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url = new URL(e.notification.data?.url || '/#/home', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/#/home', self.location.origin);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (!win) return self.clients.openWindow(url.href);
    await win.focus();
    return win.navigate(url.href).catch(() => self.clients.openWindow(url.href));
  })());
});

// The page asks which version took control (its reload-once guard).
self.addEventListener('message', (e) => {
  if (e.data?.type === 'version') e.ports[0]?.postMessage({ version: CACHE });
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // fonts etc.: the browser's own caching

  // API: network-first, JSON error when offline (never serve stale API here —
  // the app's own SQLite cache handles freshness server-side).
  if (url.pathname.startsWith('/api')) {
    e.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'You appear to be offline.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        })),
    );
    return;
  }

  // Navigations: the app shell, from the network; the cached shell offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() => caches.match('/index.html', { cacheName: CACHE })
        .then((r) => r || caches.match('/', { cacheName: CACHE }))),
    );
    return;
  }

  // Everything else of ours (JS, CSS, icons, manifest): network first, this
  // version's precache when offline.
  e.respondWith(
    fetch(request).catch(() => caches.match(request, { cacheName: CACHE, ignoreSearch: true })
      .then((r) => r || Response.error())),
  );
});
