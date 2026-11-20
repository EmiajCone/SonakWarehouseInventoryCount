/* sw.js — caches the app shell so the whole app opens with zero signal.
   Catalog/rack data is NOT cached here — that's handled by db.js/app.js via
   IndexedDB, since it needs its own refresh logic, not a blanket cache. */
const CACHE_NAME = "warehouse-count-v52";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db.js",
  "./barcode.js",
  "./config.js",
  "./manifest.json",
  "./logo.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // skipWaiting so a fixed service worker takes over immediately instead of
  // waiting for every open tab to close (which on a always-open dashboard
  // laptop is never).
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // NEVER touch cross-origin requests. That's Apps Script (live counts),
  // Google Sheets CSVs, and Firebase. The old handler cached these
  // cache-first, so the Dashboard kept re-reading its very first response
  // forever — refreshing (button or browser) just returned the same saved
  // copy until site data was cleared.
  if (url.origin !== self.location.origin) return;

  // The Dashboard is online-only and must always be current — never cache it.
  if (url.pathname.endsWith("/dashboard.html")) return;

  // Same-origin app shell: network-first (so code/config edits show up right
  // away), falling back to the cache when offline or the network is slow, so
  // the counting app still opens with zero signal.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(req, { cache: "no-cache", signal: ctrl.signal });
        clearTimeout(timer);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = (await cache.match(req, { ignoreSearch: true })) || (await caches.match(req));
        if (cached) return cached;
        throw e;
      }
    })()
  );
});
