const CACHE = "mts-field-v3";
const PRECACHE = ["/", "/index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

// App.jsx posts "SKIP_WAITING" when a new SW is installed and ready.
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

const BYPASS = ["googleapis.com", "generativelanguage", "accounts.google.com",
                "maps.googleapis.com", "fonts.googleapis.com", "fonts.gstatic.com",
                "router.project-osrm.org"];

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  if (BYPASS.some(h => url.includes(h))) return; // pass through external APIs

  // Stale-while-revalidate: return cached version immediately (fast startup),
  // fetch fresh copy in background so next load is up to date.
  // First-ever load falls through to network since cache is empty.
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const networkFetch = fetch(e.request).then(r => {
        if (r.ok || r.type === "opaque") cache.put(e.request, r.clone());
        return r;
      }).catch(() => null);
      return cached ?? networkFetch;
    })
  );
});
