// v38: pins consolidated onto one Site Map screen with no edit mode — pins
// are always draggable, "+ Pin" drops one at the crosshair, and the panel now
// renders with zero pins so the first one can actually be created.
// v37: markup rail collapses to one row on desktop and dims until pointed
// at; arrow keys step through photos.
// v36: markup screen rebuilt for phone width — the top-right cluster held
// eight 44px buttons in a non-wrapping row (440px before the Done pill) on a
// 390px screen. Tools moved to a scrolling bottom rail, plus a site-plan
// toggle on the open photo.
// v35: CRITICAL image fix. A cross-origin <img> produces a no-cors request, so
// fetch() in the SW resolves to an OPAQUE response whose status is always 0 —
// indistinguishable from success. The old rule `if (r.ok || r.type === "opaque")`
// therefore CACHED FAILURES: one throttled Drive thumbnail (403) or one Esri tile
// error got stored and replayed forever, which is exactly the "photos and maps
// don't consistently show up / blank grey space" report. Map tiles and Drive
// thumbnails now bypass the SW entirely, and opaque responses are never cached.
//
// v8: cache-name bump to force every client onto the empty-route recovery fix
// (auth-aware reload, fresh-token load, Reconnect escalation, stable stops
// memoization to stop the map "shaking" during sync). Old-version assets are
// never evicted by stale-while-revalidate alone, so a version bump is the only
// reliable purge.
const CACHE = "mts-field-v38";
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
                "router.project-osrm.org",
                // Remote imagery: satellite tiles and Drive photo thumbnails.
                // These MUST go straight to the network. They are fetched
                // no-cors by <img>, so a failure is opaque and looks identical
                // to a success — caching one poisons that exact tile/photo for
                // good and it renders as permanent grey. The browser's own HTTP
                // cache already handles them properly, headers and all.
                "arcgisonline.com", "drive.google.com", "googleusercontent.com",
                "drive.usercontent.google.com",
                // Same-origin backend endpoints (token refresh, OAuth) must NEVER
                // be cached: the stale-while-revalidate path below would otherwise
                // serve a previous /api/token response — an already-expired access
                // token stamped with a fresh-looking expiry — making silent reauth
                // hand back a dead token and every Calendar fetch 401 until a hard
                // relaunch. Always go straight to the network for these.
                "/api/"];

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
        // Only cache responses we can actually verify. An opaque response
        // (any no-cors cross-origin fetch) reports status 0 whether it was a
        // 200 or a 403, so storing one risks caching an error permanently.
        if (r.ok && r.type !== "opaque") cache.put(e.request, r.clone());
        return r;
      }).catch(() => null);
      return cached ?? networkFetch;
    })
  );
});
