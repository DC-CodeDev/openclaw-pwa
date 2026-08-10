const CACHE = 'openclaw-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (e) => {
  // No offline caching — app is always local. Pass everything through.
  e.respondWith(fetch(e.request));
});
