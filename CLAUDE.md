# MTS Field CRM — notes for Claude sessions

Field-sales app for Monster Tree Service of Rochester. React 18 + Vite PWA, hosted on Netlify
(Functions in `netlify/functions`, an Edge Function for video streaming, helpers in `netlify/lib`).
The owner (Jason) is not a developer: explain plainly, say what you could not test, and never
tell him something is "safe" unless you checked.

## How changes go live
1. Work on the branch the session names (currently `claude/update-icons-fix-route-QdApK`), commit, push it.
2. Merge that branch into `main` and push `main` — Netlify deploys from `main`; that is what makes a change live.
3. Bump the cache name in `public/sw.js` (`mts-field-vNN`) and add a one-line comment at the top, every release.
4. Do not open a pull request unless asked. Do not put model names in commits or code comments.
5. Before shipping: `npm run build` (it runs `scripts/check-undef.mjs`, which fails on a SCREAMING_CASE name that is used but never declared).

## Who uses it
- Phone: iPhone, installed to the Home Screen (iOS 26+). Also a Chromebook/laptop.
- Accounts: sign-in is Google. Server-side approved list is `netlify/lib/accounts.mjs` (SHA-256 of lowercase
  emails + optional `ALLOWED_GOOGLE_EMAILS` env var). The Google Cloud OAuth consent screen is in
  **Testing** mode: every new user must also be added under Test users, and refresh tokens expire after 7 days.
- The route comes from the signed-in user's own primary Google Calendar. Photos/notes live in that user's Drive
  (`drive.file` scope, folder "MTS Field"). Contacts go to that user's Google Contacts.

## Hard-won rules (each one came from a real bug)
- **iOS web limits:** clipboard writes, share sheets and `shortcuts://` navigation need a live tap. A camera
  app cannot lock rotation. `apple-mobile-web-app-status-bar-style` is read only when the app is added to
  the Home Screen. Since iOS 26.1 a `black-translucent` status bar gets a system blur over the top ~40pt that
  no CSS removes; the owner rejected padding the whole app down to dodge it (screen space matters).
- **Rotating back to portrait leaves the whole page scrolled up 59pt (the status bar height)** on the owner's
  iPhone (confirmed in freeze reports: `scroll 0,59`). Drawn UI and tap targets then disagree and every tap
  misses — it looks like a freeze. `src/pinViewport.js` resets any page scroll app-wide (skipping while a text
  field is focused); the camera also rebuilds its controls after rotation. The app must never page-scroll.
- **NEVER tell the user to remove/re-add the Home Screen app** without first confirming nothing is waiting to
  upload (Settings → Photo uploads / Video uploads). It wipes the phone's local storage; unsent photos, videos and
  per-phone settings are lost. Per-phone Shortcut settings are now backed up to Drive (`src/devicePrefs.js`).
- **localStorage keys under `mts-field-` are treated as visit records by `fieldStore.listFieldIds`.** Never store
  other data under that prefix. (A download-tracking key stored there was overwritten as a "visit" and made the
  Drive pull re-download all ~1,400 visits repeatedly, freezing the app and camera. It is now `mts-remote-seen`.)
- **No Drive/Contacts write before the account is confirmed** (`src/accountGate.js`). Switching accounts on a phone
  with unsent work must not wipe or leak it (the app stops and asks).
- **Contacts:** match against the full contact list (`loadContactIndex` / `saveClientContact` in `googleContacts.js`),
  never Google's lagging `searchContacts`, or duplicates are created.
- **Camera:** keep per-shot work minimal (one async encode at final size, photos stored one at a time, uploads and
  Drive pulls paused while `window.__mtsCameraOpen`). Anything that runs repeatedly while the camera is open
  or walks every visit record will freeze an iPhone — there are ~1,400 visit records.
- **The App component re-renders often** (syncs, contact pushes, timers) and the camera sits inside it. Never do
  heavy work during App render (e.g. parsing the 1,400-card pipeline from localStorage), and never setState once
  per item in a background loop — batch it. Background jobs should wait while `window.__mtsCameraOpen`.
- Test the camera path end to end before shipping (open camera, take photos, close): `check-undef.mjs` only
  catches missing SCREAMING_CASE names, so a deleted camelCase helper crashes at runtime unnoticed by the build.
  The "morning" Playwright simulation (4x CPU throttle, 1,400 visits, 3,000 contacts) is the realistic load test.
- React: never define components inside render, keep hooks above early returns, guard async results with a
  generation counter, and don't run inline callback refs that re-fire every render.
- Service worker: network-first navigation; opaque responses are never cached; `/api/` bypasses the cache.
- The sandbox cannot reach `projectvideoreview.app` or the owner's phone. Measure with Playwright
  (a 1,400-visit simulation of the camera/idle load was the way the freeze was finally found) and say clearly
  what only the owner's phone can confirm.

## Freeze report
`src/freezeLog.js` records camera steps, background jobs, stalls (heartbeat gaps) and errors to localStorage
(`mts-freeze-log`, last 4 sessions) as they happen. The owner sends it via Settings → Copy freeze report.
Read the last lines of the session that froze: the step with no matching "done"/"finished" is the one that hung.
Keep logging out of tight loops; log slow/failed cases, not every success.

## Known open items
- No saved copy of the route: opening the app offline with an expired sign-in shows only the sign-in screen.
- Deleted photos can come back after a cross-device union merge (no deletion markers).
- Remaining security items: the video-stream edge function is an open proxy for public Drive files; shared
  plan links never expire; uploaded photos are "anyone with the link". The old Gemini API key was exposed in
  early builds — rotate it and set `GEMINI_API_KEY` in Netlify (AI calls go through `/api/ai`).
- In-app recordings from newer iOS may be WebM, which iPhones often cannot play; the recorder now asks for MP4
  first and the players fall back to Drive's own player.
