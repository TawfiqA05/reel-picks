// Reel Picks service worker: offline app shell + stale-while-revalidate statics.
const CACHE = 'reelpicks-v14';
const CORE = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/js/app.js', '/js/api.js', '/js/ui.js',
  '/js/views/components.js', '/js/views/home.js', '/js/views/detail.js',
  '/js/views/coming.js', '/js/views/rate.js', '/js/views/onboarding.js',
  '/js/views/watchlist.js', '/js/views/stats.js', '/js/views/settings.js',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

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

  // Navigations: fall back to the cached app shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets: cache-first with a background refresh.
  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
