// Offline resilience for the projector / control room. Venue Wi-Fi drops and
// Render cold-starts must not turn into a blank screen: the app shell, styles,
// scripts, brand art and uploaded images are cached, and the last network
// copy is served whenever the network (or a sleeping server) is slow.
const VERSION = 'wp-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['/display', '/stage', '/css/presenter.css', '/js/display.js', '/js/stage.js', '/images/brand/rccg-logo.png', '/images/brand/yp9-logo.png']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req, cacheName, timeoutMs) {
  return caches.open(cacheName).then((cache) =>
    new Promise((resolve) => {
      let settled = false;
      const fallback = () => cache.match(req).then((hit) => { if (!settled) { settled = true; resolve(hit || Response.error()); } });
      const timer = setTimeout(fallback, timeoutMs); // slow/asleep server -> serve the cached copy
      fetch(req).then((res) => {
        clearTimeout(timer);
        if (res && res.ok) cache.put(req, res.clone());
        if (!settled) { settled = true; resolve(res); }
      }).catch(() => { clearTimeout(timer); fallback(); });
    })
  );
}

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((hit) => hit || fetch(req).then((res) => {
      const type = res.headers.get('content-type') || '';
      if (res.ok && res.status === 200 && /^image\//.test(type)) cache.put(req, res.clone());
      return res;
    }))
  );
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/socket.io/') || p === '/healthz' || p === '/login' || p === '/control' || p === '/remote') return;
  if (p.startsWith('/api/')) {
    if (/^\/api\/(media\/file|theme-image)\//.test(p)) e.respondWith(cacheFirst(req, ASSETS));
    return;
  }
  if (p === '/display' || p === '/stage' || /\.(js|css|html)$/.test(p)) {
    e.respondWith(networkFirst(req, SHELL, 4000));
  } else if (/\.(png|jpe?g|webp|gif|svg|ico)$/.test(p)) {
    e.respondWith(cacheFirst(req, ASSETS));
  }
});
