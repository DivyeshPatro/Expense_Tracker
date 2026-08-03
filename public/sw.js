// Ledgerly service worker — offline-sync-spec Phase 0.
// Scope: app-shell resilience only. Static assets are cached first-use
// (immutable, content-hashed); navigations stay network-first so online
// behavior is byte-identical to no-SW, with a branded offline fallback when
// the network is gone. No data caching, no background sync — later phases.
const STATIC_CACHE = "ledgerly-static-v2";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  // allSettled, not addAll: addAll is atomic, so a single missing asset would
  // reject the whole install and the SW would never activate — which is exactly
  // what a stale /icon.svg reference did before. Cache what's there; skip what
  // isn't, and still take over.
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // server actions / mutations: never touched

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // content-hashed build assets: cache-first, populate on first fetch
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // page navigations: network-first (online behavior unchanged), offline shell as fallback
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
  }
});
