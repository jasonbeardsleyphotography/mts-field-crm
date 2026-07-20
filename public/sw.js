// v7: cache-name bump forces the activate handler to delete the ENTIRE v6
// cache. A build with a since-fixed React error #300 crash (bad hook order
// in OnsiteWindow) was still being served from it on some launches — old
// shell -> old hashed assets, all cache hits — so the fix never actually
// reached the phone. Old-version assets are never evicted by
// stale-while-revalidate alone, so a version bump is the only reliable purge.
const CACHE = "mts-field-v7";
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

  // The HTML shell references hashed JS/CSS bundle filenames, so it must
  // always come from the network when possible — a stale cached copy would
  // point at a bundle that no longer exists after a new deploy, which is
  // exactly what was causing users to get stuck on old code even after the
  // auto-update reload below. Fall back to cache only when offline.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(async () => (await caches.match(e.request)) || (await caches.match("/index.html")))
    );
    return;
  }

  // Stale-while-revalidate for everything else (hashed assets, images, etc.):
  // return cached version immediately (fast startup), fetch fresh copy in
  // background so next load is up to date. First-ever load falls through to
  // network since cache is empty.
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
