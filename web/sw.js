const CACHE_NAME = 'datapurge-v6';
const ASSETS = [
    '/',
    '/index.html',
    '/app.html',
    '/embed.html',
    '/css/style.css',
    '/js/app.js',
    '/js/store.js',
    '/js/templates.js',
    '/js/queue.js',
    '/js/brokers.js',
    '/js/scan.js',
    '/js/progress.js',
    '/js/share.js',
    '/js/stats.js',
    '/data/registry.json',
    '/data/templates.json',
    '/icon.svg',
    '/manifest.json',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // Network-first for data files (may update), cache-first for assets
    if (e.request.url.includes('/data/')) {
        e.respondWith(
            fetch(e.request)
                .then(resp => {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                    return resp;
                })
                .catch(() => caches.match(e.request))
        );
    } else {
        e.respondWith(
            caches.match(e.request).then(cached => cached || fetch(e.request))
        );
    }
});
