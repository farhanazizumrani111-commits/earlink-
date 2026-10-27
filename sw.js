// Caches the app's own files so it opens instantly and can be installed.
// Translation itself always needs internet.
const CACHE = 'earlink-v13';
const FILES = ['./', 'index.html', 'app.js', 'capture-worklet.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'fonts/chakra-500.woff2', 'fonts/chakra-600.woff2', 'fonts/chakra-700.woff2', 'fonts/sharetech.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Network first (so updates show up), cache as fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
