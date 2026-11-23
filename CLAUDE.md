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
- The route comes from the calendar(s) chosen in Settings → Route calendar (`src/calendarSource.js`, per device,
  localStorage `mts-route-calendars`; default = the account's primary calendar). Writes to an event (colour, move)
  go to the calendar it was loaded from (`fetchCalendarEvent`); new stops go on the first chosen calendar.
  Account identity still uses `calendars/primary` (its id is the email). Photos/notes live in that user's Drive
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

## Field app ☰ menu
The Settings sheet (and the app switcher in it) renders for both the Route and Pipeline views; Pipeline has its own
slim bottom bar with the ☰ button. (The old "pipeline bottom bar" inside the route-view fragment is dead code.)

## Phone vs computer
`src/device.js` `isPhoneLike()` = primary pointer is coarse. Phone-only steps (RealWork hand-off after Done, its
clipboard copies and iPhone Shortcuts) are skipped on a laptop/Chromebook, even one with a touchscreen.

## Onsite card data for proposals
- `jobTags` (SingleOps' 71 tags, colours in `singleOpsCatalog.js`) and `templates` ({ GTC, PHC, LC } → arrays of
  template names; older records may contain "" entries, which are ignored) are saved on each visit record and sync like notes. Template lists live
  in `SINGLEOPS_TEMPLATES`; the two TICK + MOSQUITO templates were filed under PHC (owner may move them to LC).

## Sync notes
- Visit order per day: `mts-route-order` (ids) + `mts-route-order-at` (when set BY HAND). Only hand-set orders
  sync, inside app-state.json as `routeOrder`, newest per day wins; saveAppState merges with Drive's copy first.
- AI video summary: edge function `netlify/edge-functions/video-summary.js` (Drive → Gemini file upload → streamed
  NDJSON progress + result). An edge function, not a background function: the Netlify plan may not include
  background functions, and an unsupported one could break deploys. Results are saved on the card as
  `videoSummaries[driveFileId]`.

## Known open items
- **TO DO (owner): rotate the Gemini API key.** The old key shipped in early public builds. Make a new key in
  Google AI Studio, delete the old one, set `GEMINI_API_KEY` in Netlify, redeploy. Until then, watch its usage.
- No saved copy of the route: opening the app offline with an expired sign-in shows only the sign-in screen.
- Deleted photos can come back after a cross-device union merge (no deletion markers).
- Uploaded photos/videos are "anyone with the link" (needed for crew/client links and in-app Drive thumbnails).
  Making them private means routing every view through our server with stored Google credentials — a big change
  the owner hasn't asked for. Done instead: plan links expire after 2 years (plan.mjs, 410 → "expired" page);
  video-stream only serves video files owned by an approved account (else 404; allows on a Drive outage).
- In-app recordings from newer iOS may be WebM, which iPhones often cannot play; the recorder now asks for MP4
  first and the players fall back to Drive's own player.

## Dispatch (/dispatch) — a separate tool on the same site (owner asked for it, Nov 2026)
- Must never change the field app. Built SEPARATELY: `vite.dispatch.config.js` (second `vite build` in `npm run build`)
  writes `dist/dispatch.html` + `dist/dispatch-assets/`, sharing no code files with the field app. Code lives in
  `src/dispatch/`; do not import field-app modules from there (copy what's needed) or the field bundle changes.
- Server: `netlify/functions/dispatch.mjs` (`/api/dispatch/*`), Blobs stores `mts-dispatch` (sessions `sess/…`,
  sign-in links `link/…`, `backlog/current`, geocode cache `geo`) and `mts-admin` (`users`).
- Sign-in: one-time sign-in links the owner makes on Admin (any email, Google or not; 14-day expiry; session cookie
  `mts_dsess`, 400 days), or the field app's Google session cookie `mts_sess` on the same browser. The owner refused to
  ask corporate for Microsoft-account permission, so no Microsoft sign-in.
- Permissions (`appPermissions` in `netlify/lib/accounts.mjs`): field / dispatch / shop / admin per email, set on the
  Admin tab. The owner's two accounts (personal + main business account, `OWNER_HASHES`) always have everything. An email in the list is decided by the list (a
  "removed" entry blocks even a built-in account); otherwise the field app falls back to the built-in list + env var.
  Node functions pass `getStore`. Edge functions can't read Blobs: video-summary falls back to `GET /api/dispatch/allowed-field`
  (Bearer token → field permission); video-stream still uses the built-in list only.
- Backlog: the GTC Backlog .xlsm is parsed in the browser (`parseWorkbook.js`, SheetJS `xlsx`, columns found by header
  text; forecast/priority tabs are a rolling 12 months — months before the sheet date mean next year). Stored on the
  server; nothing is written back to Excel. Later the same parser can take the live SharePoint file.
- Map pins: US Census batch geocoder (server, free), then Google's browser geocoder for misses; cached by address.
- Shop Board (Dispatch tab, `src/dispatch/shop/ShopBoard.jsx` = the owner's ShopBoard.jsx, ported): storage is
  `/api/dispatch/shop/*` (Blobs store `mts-shop`: core, day.<iso>, week.<sunday iso>, presence). Clients send PATCHES
  (only what changed); the server merges per item (`at` stamps from the server clock via `shopApi.stampNow`), and
  because Blobs has no conditional write it re-checks a moment later and re-applies a patch a simultaneous save wiped
  (`landed()`, per-key times in day.keyAt — never over a newer edit). The board polls core, week AND the current day.
  Kept rule: a unit's spec comes from SEED_ASSETS in code and is re-applied on every read (reSpec). Fixes vs original:
  bins pull people/units off crews directly (`pullOut`; the proximity `materialize` emptied crews), Undo reverts only
  the items its own action touched (`undoRef.own`), copy-to-week asks before replacing planned days, Reset is admin
  only, identity = sign-in. Its CSS is scoped under `.mb` by `scopeCss`. check-undef can't see `const A = 1, B = 2`:
  declare SCREAMING_CASE constants one per line.
  Drag & drop (rebuilt Nov 2026 after "jumpy" reports): drags start only after real movement (clicks stay clicks; the
  click after a drag is swallowed), the ghost moves via its own element (no re-render per mouse move), items carry
  `from` and dropping back there is a no-op, Escape cancels, the canvas auto-scrolls. Open asphalt accepts only crew
  re-ordering; new crews come from the "＋ New crew" tile. Absolutely-positioned drop targets (crew boxes, new-crew tile)
  must BE the Zone element (className/style on the Zone) — a wrapper div has zero size and never receives drops (that
  bug made drops on crews create new crews in the original). Crew boxes pack to the visible width (ResizeObserver).
  Polls don't merge day changes while dragging or for 2 s after. In-crew load cards have no caption (they overlapped).
  Bins: Crew room / Off Duty (left), At the yard (big) / In for repair (status shop) / Broken (status tagged) (right).
  Room and yard are decided by crew MEMBERSHIP (`crewHas`), not screen positions (that left dropped people/trucks in
  both places). ✎ Edit on each crew opens CrewSheet: rename, operation, add/remove people and equipment via pickers
  (reuses yardMove). People tab (`PeopleView`): month calendar; pick a person + reason (vac/sick/train/light/on), tap or
  drag across days → writes the same week.<sunday> cells the yard reads. Off-duty people are hidden from crew boxes
  (data kept, they return when back on duty), sit locked in Off Duty (not draggable; their sheet has "Back on duty
  today"). Person `ops` (GTC/PHC/LC/SHOP/SALES; none = anywhere) → amber plate + "to check" line when on another op's crew.
  Bins are built by `yardGroups(day, assets)` = units on NO crew right now, grouped by day.stacks only when the whole
  stored group is free (the crews' own hitching comes from iron order — deriveHitch — and day.stacks used to drift
  from it, so loads dragged to the yard vanished). Every stack drag carries `members` (exactly what was grabbed) and
  yardMove uses them; loads sent to a bin are re-recorded as one group (`regroup`). Equipment tab = the owner's parked
  FleetView (condition columns) + "+ Add equipment" (AddAssetSheet copies drawing/towing keys from a SEED unit of the
  same kind) + name / drawing label / plate edits stored as `asset.custom` (LABEL_KEYS win in reSpec; drawing/towing
  keys never do).
- Equipment tab (owner, Nov 23): columns are KINDS of machine (`EQUIP_GROUPS`: Aerial lifts (incl. the bucket truck),
  Trucks, Trailers, Material handlers, Chippers, Stump grinders, Sprayers & UTVs, Sales cars, Other), not conditions.
  Condition = the compact card's outline + a short badge; repair (status `shop`, blue, "In for repair") and broken
  (status `tagged`, red, "Broken") sink to the bottom of each column. The Type filter and column switcher are gone;
  conditions are a filter row. Status keys are unchanged (only labels), so stored data is untouched.
- Tab order (owner, Nov 23): Shop Board · Schedule · Backlog · Quick pick; Shop Board is the default tab.
- Hours (`src/dispatch/hours.js`): the workbook's hours are ON-SITE HOURS (OSH). Sales hours: 1 SH = 0.78 OSH. The OSH | SH
  switch in the Dispatch header is per device (localStorage `mts-dispatch-hours-unit`); always format with `fmtH()` so the
  unit is printed. A normal day = 6.24 OSH (8 SH) per person working (`dayOsh`); Schedule warns when a crew is light/heavy.
  Stump grinding / cleanup / soil & seed never count toward the day (a later stage; a stump screen is planned).
- Jobs ON PAUSE ("purgatory", owner's idea): `mts-dispatch` key `backlog/paused` = { ref: { reason, until, by, at } }
  (`/api/dispatch/paused`, GET / POST {ref, reason, until} | {ref, remove}); kept apart from the workbook so uploads keep
  them. Status `paused` beats everything, never late, own colour; card reads "Name: reason". Pause from a Backlog card,
  the Schedule map card or Quick pick. Shared loader `useBacklog.js` (backlog + paused, enriched).
- Seasons (`seasonStatus` in backlogModel): 08 WINTER Jan–Mar, SPRING Apr–Jun, SUMMER Jul–Sep, FALL Oct–Dec, OAK Nov–Mar
  (assumed), "OAK 2027" = not before 2027 (assumed). In season → due by its end; out of season → status `season`
  ("Waiting for season", not late); late only if a whole window ended ≥ the promised lead (4 wk if 99) after the sale.
- Age colours are by RANK (`ageT`, 9-stop gradient) among jobs that aren't paused / waiting for season.
- Tag filters (`TagFilter.jsx`: tap = must have, again = must not, again = clear; all/any). Schedule: each crew's
  "Find work" lists only jobs it can do (`checkJob` with crew machines + people; stump tags are `later` and ignored),
  optional "fits the hours left". "Tag → equipment" button shows the rules (TAG_RULES / UNMAPPED_TAGS in crewCheck).
- Quick pick (`QuickPick.jsx`, phone-first): full-screen map; pick crew (today's Shop Board), hour range in the viewer's
  unit, fits crew, tags; nearest first from the crew's last stop today (else its yard) or "near me" (one-shot GPS, never
  sent); "+ Add to <crew> today" writes sched.<today> like the Schedule.
- Backlog tab = a job manager, not a dashboard: one totals line, Group by Priority (status categories) / Equipment
  (`equipmentNeeds` from crewCheck, "No special equipment") / Zone, OLDEST FIRST inside each group; map coloured by age
  by default (`ageColor`, green → dark red over a year). Hours split (`enrich` → treeHrs / grindHrs / cleanupHrs / seedHrs,
  shown by `JobHours.jsx`): tree work is the big number. Splits come from the workbook's line-item sheet (`lineItems` in
  parseWorkbook: any sheet with Item Name + Quantity + job number; labor items = hours, others = quantities), else the
  sheet's Stump Hrs. The current export has only Stump Grind Labor / Stump Grinding / Stump Debris Removal (a quantity);
  soil & seed and cleanup labor appear automatically once SingleOps' export includes them.
- Schedule (Dispatch tab, `src/dispatch/Schedule.jsx`): crews for a day come from the Shop Board (that day's record,
  else the latest earlier saved day, else the standing setup). Jobs are assigned per day in `mts-shop` key
  `sched.<iso>` = { assign: { jobRef: { crew|null, order, label, town, hrs, at, by } } }, merged per job like the board
  (crew null = taken off). Dispatch users may read the board and edit only sched.*; board edits need Shop Board.
  Drag (desktop HTML5 DnD) or tap a job then "Add here" (phones); tapping a map dot opens a job card ON the map
  (with "+ <crew>" buttons); route lines and yard markers are not clickable and the map's job list is memoised (a new array
  each render rebuilt every marker and could swallow taps); ↑↓ reorder; map shows numbered stops + route line per
  crew; "Nearest to <crew>" sorts the backlog by distance to that crew's stops; jobs planned on other days of the week
  are marked/hidden. The Shop Board Day sheet appends each crew's scheduled jobs ("Jobs from the Schedule" toggle).
  Nothing is written to SingleOps or the workbook.
  Job tags vs crew (`src/dispatch/crewCheck.js`, used by Schedule AND Shop Board): equipment tags (02 BUCKET, 02 LIFT,
  02 LIFT TALL!, 03 AVANT, 03 BIG CHIP, 03 WOOD TRUCK, 03 CRANE, 07 STUMPS…) must match a unit on the crew that isn't in
  the shop/tagged out; #N PERSON vs people working that day (week cells); scheduling tags (09 MUST BE HOME, NEIGHBOR
  PERMISSION, OBSTACLE, 07 SCHEDULE…, 05 …, 04 lines) → the Schedule's "Office call list"; 06 gear → "load:" reminders.
  sched entries store the job's `tags` (backfilled once by the Schedule) so the Shop Board can check without the backlog.
  "Best order" per crew: shortest straight-line loop yard → stops → yard (every order tried up to 8 stops; nearest-next
  + 2-opt above). Yard addresses live in `mts-shop` key `settings` ({ yards: { Brighton|Rush Scottsville: {addr,lat,lng} } },
  "Yards" button; Census lookup on the server, Google's geocoder in the browser as fallback). Default yard by crew op
  (PHC/LC → Rush Scottsville, else Brighton); a per-day override is stored in sched.<iso> as assign["_yard:<crewId>"]
  (keys starting "_" are not jobs).

## Soil (/soil) — property soil maps (owner asked for it, Nov 2026)
- Same separate build as Dispatch (`vite.dispatch.config.js` has inputs dispatch.html + soil.html; output
  `dist/dispatch-assets/`). Code in `src/soil/`. Server `netlify/functions/soil.mjs` (`/api/soil/*`), Blobs store
  `mts-soil`: `index`, `site/<id>`, `pdf/<site>/<file>.pdf`, `link/<token>`. Shared sign-in check: `netlify/lib/session.mjs`.
- Access: staff need the **Soil** permission (Admin tab); editing (import, cut-outs, client links) is admin-only. Clients
  get a private read-only link `/soil/c/<token>` made with "Make a client link" (revocable). `clientView()` strips every
  `internal` field and the link list ON THE SERVER — never rely on hiding them in the page. `/soil/*` is noindex.
- Map spec = the owner's prototype `BH-soil-gradient-map.html`: Esri imagery + reference labels, IDW power 2 in local
  metres, fade 45→130 m, colour stops in `src/soil/soilData.js`, NYS tax parcel clip (empty for Monroe County), stored
  shapes `{type: boundary|area|line, name, coords:[[lat,lon]], width}` (BH-cutouts.json format).
- "You are here": watchPosition on the device only — position is never sent or stored; stopped when the page is hidden.
- Client data (addresses, lab PDFs, $ history) is imported through the page (site package .zip), never committed to git.
- Each lab is judged by its own reference ranges (labs use different methods); never mix labs on one colour scale.
- Trees (later): separate layer; inspections stored as separate dated records, not on the tree.
- OneDrive archive (12 properties, 27 reports) imports from `MTS-soil-archive.zip` (soil-archive.json + pdf/<site>/…),
  built outside the repo; 18 UMass reports parsed by script, 9 others typed in by hand (`transcribed: true`, owner to
  check). Tests may carry their own `fields`, per-sample lab `ratings` words, `recs`/`recText`/`comment`; leaf tests are
  `type: "F"` (no map colours). Non-Morgan methods only colour pH and organic matter. Staff-only notes live under
  `site.internal` (stripped for clients). Admins place sample pins by tapping the map ("Place samples").
- Adding tests: property Admin tab → "Add a soil test" (`src/soil/AddTest.jsx`): PDFs → edge function
  `netlify/edge-functions/soil-extract.js` (`/api/soil-extract`, Gemini reads the PDF, streamed NDJSON; admin checked by
  calling `/api/soil/me` with the caller's cookies) → editable review table → PDFs + test saved (`transcribed: "ai"`).
  UMass Modified Morgan → standard keys (full map colours); other labs → `fields`. "+ New property" on the Soil home.
- Most new reports arrive as single PDFs named "Client, street zip, date, S|F, area.pdf" (only Boughton Hill had a full
  package). Soil home → "Add soil reports (PDFs)" (`src/soil/BulkAdd.jsx`): `parseReportName` reads the name, files are
  grouped by street number + street + zip and matched to existing properties (or new ones), then each group runs the
  embedded AddTest (AI read → review → save). The file name's area labels one-sample reports; its date is a fallback.
- App switcher (Field · Dispatch · Soil) sits at the top of every app's ☰ menu. Field app: `src/AppSwitcher.jsx`
  (asks `/api/dispatch/me`; shows nothing if that fails, so the field app is never affected; warns before leaving
  with photos uploading). Dispatch/Soil: `src/dispatch/AppMenu.jsx` (fixed bottom-left ☰; on a Soil property page it
  sits in the map's bottom-left corner; never on client links). Admin is a menu item (opens `/dispatch/#admin`), not a
  tab. Shop Board and Schedule live inside Dispatch.

## Future expansion — ON HOLD (owner's decision; don't start without being asked)
- **Client history:** one large CSV of every line item for every job the company has ever completed. Must show
  per client: jobs with their line items, targets and prices, plus soil samples. Stored separately from visit
  records, but tied to the client: tapping a name (e.g. "Ed Short") shows his history AND his app visits/pipeline
  status together. Both salespeople must see exactly the same history (so it needs a shared home, not one Drive).
- (Soil reports moved out of ON HOLD — built as /soil, see above.) Soil development PAUSED by the owner (Nov 23) to focus on Dispatch.
- Video snapshot button (photo from the live video view, with GPS + site-map pin) — explored, not built.
