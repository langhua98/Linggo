const CACHE = 'linggo-v202';
const SHELL = [
  '/Linggo/',
  '/Linggo/index.html',
  '/Linggo/style.css',
  '/Linggo/sb.js',
  '/Linggo/script.js',
  '/Linggo/srs.js',
  '/Linggo/userdeck.js',
  '/Linggo/cet4.js',
  '/Linggo/cet6.js',
  '/Linggo/ogden850.js',
  '/Linggo/ecdict.js',
  '/Linggo/licon.js',
  '/Linggo/vendor/lottie.min.js',
  '/Linggo/vendor/hyphenation.en-us.js',
  '/Linggo/vendor/hypher.js',
  '/Linggo/vendor/ts-fsrs.umd.js',
  '/Linggo/vendor/emoji/deck-cet4.svg',
  '/Linggo/vendor/emoji/deck-cet6.svg',
  '/Linggo/vendor/emoji/deck-ogden.svg',
  '/Linggo/vendor/emoji/deck-mine.svg',
  '/Linggo/lottie/playPause.json',
  '/Linggo/lottie/skipBack.json',
  '/Linggo/lottie/skipForward.json',
  '/Linggo/lottie/heart.json',
  '/Linggo/lottie/bookmark.json',
  '/Linggo/lottie/searchToX.json',
  '/Linggo/lottie/settings2.json',
  '/Linggo/lottie/menu.json',
  '/Linggo/lottie/loading.json',
  '/Linggo/icon.png',
  '/Linggo/icon-192.png',
  '/Linggo/icon-512.png',
  '/Linggo/apple-touch-icon.png',
  '/Linggo/manifest.json',
];

// Install: cache app shell
// cache:'reload' 是必须的 —— SW 里的 fetch/addAll 默认仍然经过浏览器自身的 HTTP 缓存，
// 而 Pages 给静态文件发 max-age=600。不加这个，install 会把 HTTP 缓存里的旧文件
// 原样烤进新版本缓存，然后一直留到下次版本号变更为止（线上真出过：新 sw + 旧 srs.js）。
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
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
// 代码文件一律网络优先，部署即生效。这里**不要**再退回手工白名单 ——
// 漏掉一个文件就会出现「这个文件是新的、那个是旧缓存」的版本错配，
// 曾经因为漏了 userdeck.js 导致老用户词书永远载不出来。
// 注意 vendor/ 下的第三方库带版本、极少变动，仍走缓存优先，不必每次回源。
const CODE = /\/Linggo\/(?!vendor\/)[^/]*\.(js|css|html)$|\/Linggo\/$/;

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
  // 同样要 cache:'reload'：不加的话这个 fetch 会被浏览器 HTTP 缓存直接应答，
  // 压根到不了网络，「网络优先」名存实亡，部署后最长 10 分钟都还是旧代码。
  if (CODE.test(url.pathname) || e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, { cache: 'reload' }).then(res => {
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
