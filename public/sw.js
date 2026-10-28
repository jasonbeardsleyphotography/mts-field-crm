// v79: Drive pull no longer re-downloads every visit (its bookkeeping key was
//      being overwritten as a "visit"); one pull at a time, paced, paused
//      while the camera is open; old visits fetched on open; sweep paced.
// v78: no iOS text auto-zoom (text-size-adjust always 100%); pull no longer
//      loads every visit record; Pipeline summary hydrates once per session.
// v77: camera debug — one encode per shot at final size (async), shots stored
//      one at a time, uploads/Drive pushes held until the camera closes, small
//      thumbnails for photo tiles.
// v76: camera responsiveness — viewfinder sizing event-driven only (no timer,
//      no container units/transform); removed the full re-upload reconcile and
//      the re-upload-everything on the cloud button.
// v75: iPhone Shortcut settings (RealWork, Send to RealWork, iPhone Video)
//      backed up to Drive and restored after a reinstall.
// v74: in-app recordings saved as MP4 again (iOS now accepts WebM, which iPhones
//      often can't play back); video players fall back to Drive's own player.
// v73: read visit records and app state from EVERY "MTS Field" folder (newest
//      wins); one-time full re-pull; Settings → Recover photos & videos.
// v72: solid ("black") status bar so iOS has nothing under it to blur; main
//      screens are position:fixed (fill whatever iOS gives them); dark html.
//      Existing installs: remove + re-add the Home Screen icon once.
// v71: status bar back to black-translucent (matches installed apps — v70's
//      change left a white strip); solid fixed strip behind the status bar
//      only, no layout change.
// v70: 40pt top padding removed; opaque ("black") status bar instead, so the
//      header sits right under it with no iOS blur and no lost space.
// v69: debug pass — account gate before any Drive/Contacts write, safe account
//      switching, notes no longer overwritten by just opening a card, all fields
//      sync across devices, manual contact saves de-duplicated, photo-save
//      failures surfaced, Maps fallback, per-user name in customer messages.
// v68: Home Screen app keeps headers below iOS 26.1+'s top-edge blur (40pt band
//      of plain background); Settings sheet shorter and scrollable.
// v67: viewfinder sizing in pure CSS (no shrink/snap on rotation); iOS edge
//      blur re-sampled when the camera or video recorder closes.
// v66: camera + video viewfinders sized to fill the screen explicitly (no longer
//      trusting object-fit on iOS); camera Permissions-Policy header removed.
// v65: status bar back to black-translucent — "black" shrank the full-screen
//      camera and video viewfinders.
// v64: special callout on in-app visits; status bar no longer overlaps (blur);
//      brighter muted text app-wide; phone kept when an email is also given.
// v63: iPhone Video button (opens Camera in Video, copies address, logs it);
//      contacts de-duplicated across devices; approved-accounts check; real
//      sign-out; AI key moved server-side; Account & connection check; brighter
//      onsite buttons.
// v62: settings no longer freeze; site-map Link copies reliably; JPEG and
// line items hidden; video above the map; Library/YouTube/Camera/Video grid;
// optional auto-send of the first photo to RealWork on Done.
// v61: RealWork button removed from the on-site card header.
// v60: clearer RealWork Shortcut setup steps; the Shortcut name is editable.
// v59: blue share buttons gone; on a phone, Download opens "Save Image" so the
// photo lands in Photos.
// v58: optional iPhone-Shortcut route so RealWork opens the app, not Safari.
// v57: after Done — pick a photo for RealWork (or skip), RealWork opens, and the
// unchanged next-stop countdown starts when you come back.
// v56: RealWork shortcut on the on-site card.
// v55: share-a-photo button, no more "save video to phone?" prompt, and the
// route list no longer fights scrolling while a card is open.
// v54: stop creating a new Google contact for the same client on every
// calendar reload, and add a tool to remove the duplicates already made.
// v53: stepping between photos in markup actually changes the photo — the
// source is now tied to the photo it belongs to, so a stale one cannot show.
// v52: a Drive cleanup tool that removes the duplicate photo files the
// re-upload bug created, so the quota it filled can be reclaimed.
// v51: distinguish a FULL Drive from a throttled one — my own classifier was
// calling storageQuotaExceeded "rate limiting", which never clears by waiting.
// v50: the upload error is no longer swallowed — the Photo uploads screen now
// says WHY each stop failed, and permanently damaged photo data stops looping.
// v49: the photo queue can no longer freeze silently — one hung await used to
// leave the pass lock stuck true, so every later run (Retry included) no-opped.
// v48: photos upload one at a time (a parallel burst was inviting the very
// rate limits that jammed the queue), are named "Lastname MM-DD-YYYY NN.jpg",
// and a storage failure while capturing now says so instead of going quiet.
// v47: Photo uploads is a real screen in Settings now, with a count badge on
// the settings button, instead of a line in a debug panel nobody can find.
// v46: photo uploads can finish. A successful upload is no longer discarded
// when the sharing call fails, and the queue has a terminal state.
// v45: stop the Google sign-in popup storm — Drive rate-limit 403s are no
// longer treated as auth failures, and the popup path is rationed.
// v44: the markup editor resolves its photo once per open, so a background
// sync can no longer drop it to the loading screen mid-edit.
// v43: site-plan photos no longer come out grey — the export retries, then
// falls back to an authenticated Drive download that cannot fail on CORS.
// v42: restore DRAG_LIFT (its removal broke pin dragging outright) and damp
// the pinch/wheel zoom, which was 1:1 with fingers and far too hot.
// v41: expand now really fills the screen (the overlay was trapped inside a
// transformed ancestor), and pin dragging is back to the version that worked.
// v40: the Site Map is live on the on-site screen (two-finger pan, pins
// one-finger draggable), smaller unnumbered pins, drag no longer jumps on
// touch, and the markup screen gains a jump-to strip + down-arrow download.
// v39: one map. The parcel screen is retired — its owner/tax lookup is now
// a local hit-test on the Site Map. Plus a reorderable pin list and Add to Card.
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
const CACHE = "mts-field-v79";
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
