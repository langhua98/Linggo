const CACHE = 'linggo-v108';
const SHELL = [
  '/Linggo/',
  '/Linggo/index.html',
  '/Linggo/style.css',
  '/Linggo/sb.js',
  '/Linggo/script.js',
  '/Linggo/srs.js',
  '/Linggo/cet4.js',
  '/Linggo/cet6.js',
  '/Linggo/ogden850.js',
  '/Linggo/ecdict.js',
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

// Core code files: always fetch fresh so deploys take effect immediately,
// fall back to cache only when offline
const CODE = /\/(index\.html|script\.js|style\.css|sb\.js|srs\.js|cet4\.js|cet6\.js|ogden850\.js|ecdict\.js|align-worker\.js)$|\/Linggo\/$/;

// Fetch: network-first for code, cache-first for static assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Let external requests (APIs, CDN, fonts) go straight to network
  if (url.origin !== location.origin) return;

  // Kokoro model assets (~115 MB): handled by transformers.js's own
  // persistent Cache API bucket — keep them out of the versioned app cache
  // so SW version bumps never force a re-download
  if (url.pathname.startsWith('/Linggo/kokoro/')) return;

  // Network-first for HTML/JS/CSS — users always get the latest code online
  if (CODE.test(url.pathname) || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('/Linggo/index.html')))
    );
    return;
  }

  // Cache-first + background update for static assets (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fromNetwork = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fromNetwork;
    })
  );
});
