const CACHE = 'imb-web-v0.19.0';
const CORE = ['./', './index.html', './styles.css', './app.js', './web-api.js', './board-data.js', './template-data.js', './media-loader.js', './fflate.js', './imb-icon.png', './icon-192.png', './icon-512.png', './MiSans-Demibold.ttf'];

self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
