const CACHE = 'linggo-v10';
const SHELL = [
  '/Linggo/',
  '/Linggo/index.html',
  '/Linggo/style.css',
  '/Linggo/script.js',
  '/Linggo/cet4.js',
  '/Linggo/cet6.js',
  '/Linggo/ogden850.js',
  '/Linggo/icon.png',
  '/Linggo/icon-192.png',
  '/Linggo/icon-512.png',
  '/Linggo/apple-touch-icon.png',
  '/Linggo/manifest.json',
];

// Install: cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-only for external APIs
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Let external requests (APIs, CDN, fonts) go straight to network
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fromNetwork = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      // Return cache immediately if available, update in background
      return cached || fromNetwork;
    })
  );
});
