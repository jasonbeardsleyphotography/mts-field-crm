/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Photo Upload & Promotion Queue
   ───────────────────────────────────────────────────────────────────────────
   Photos are captured to IndexedDB locally, then uploaded to Drive in the
   background. After a successful upload, the local base64 (`dataUrl`) is
   retained for a grace period and then evicted once the photo has been
   confirmed-uploaded for long enough to be safe to drop.

   Three lifecycle states for a photo:

     1. local-only  — { dataUrl: <base64> }  (just captured, not uploaded yet)
     2. synced      — { dataUrl: <base64>, url: <drive-url>, syncedAt: <ts> }
     3. promoted    — { url: <drive-url>, syncedAt: <ts> }  (dataUrl evicted)

   Why a grace period instead of immediate eviction:
   - Markup mode needs pixel-level access to draw on the image. If the user
     re-marks-up a photo, the dataUrl makes that instant; otherwise we'd
     need to re-download from Drive over potentially-bad cellular.
   - If the user is in a low-signal area (basement of a job site) and wants
     to view their photo notes, having local copies is huge.
   - 7 days covers ~99% of "want to look at this again soon" cases.

   Why eviction at all:
   - IndexedDB has a per-origin quota that varies by device. iOS Safari
     can clear it after 7 days of inactivity to "protect privacy". Smaller
     IDB = less risk of partial wipe.
   - A typical job has 8-15 photos × 2-4MB each = 30MB. Across 100 jobs
     that's 3GB locally. Evicting after sync brings it back to bounds.

   Markup re-edit flow (handled in OnsiteWindow):
   - If user enters markup on a promoted (no-dataUrl) photo, OnsiteWindow
     fetches from `url` into a blob, passes that blob URL to PhotoMarkup,
     and revokes the URL when markup closes. Saved markup creates a NEW
     photo entry (the original stays uploaded; the new one starts fresh).
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, updateField, listFieldIds } from "./fieldStore";
import { uploadPhotoToDrive, queueFieldDriveSync } from "./driveSync";
import { downscaleDataUrl, OVERSIZE_DATAURL_LEN, photoKey } from "./imageUtils";
import { logError, logWarn, logInfo } from "./debugLog";
import { createWakeLockHandle } from "./wakeLock";

// Keeps the screen on during an active photo upload, same as video uploads —
// otherwise a glance-length upload can lose to the screen auto-locking and
// iOS suspending the tab before it finishes.
const _wakeLockHandle = createWakeLockHandle();

const QUEUE_KEY = "mts-photo-queue";
const PROMOTED_QUEUE_KEY = "mts-photo-promote-queue"; // stops that may have evictable photos

// How long after upload to keep the local base64 before evicting.
// 7 days matches iOS Safari's IDB privacy clear interval.
const PROMOTION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Queue management (upload pending) ────────────────────────────────────

function getQueue(key = QUEUE_KEY) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch { return new Set(); }
}

function saveQueue(set, key = QUEUE_KEY) {
  try { localStorage.setItem(key, JSON.stringify([...set])); }
  catch {}
}

export function markStopForPhotoSync(stopId) {
  const q = getQueue();
  q.add(stopId);
  saveQueue(q);
}

function unmarkStop(stopId) {
  const q = getQueue();
  q.delete(stopId);
  saveQueue(q);
}

// ── Promote queue (eviction candidates) ─────────────────────────────────

function markStopForPromotion(stopId) {
  const q = getQueue(PROMOTED_QUEUE_KEY);
  q.add(stopId);
  saveQueue(q, PROMOTED_QUEUE_KEY);
}

function unmarkStopForPromotion(stopId) {
  const q = getQueue(PROMOTED_QUEUE_KEY);
  q.delete(stopId);
  saveQueue(q, PROMOTED_QUEUE_KEY);
}

// ── Photo filename ──────────────────────────────────────────────────────
// Name uploaded photos after the client (mirrors the video naming) so files in
// Drive read like "Deborah Wood #30432 06-30-2026 01.jpg" instead of an
// opaque stop id. Returns null when the field record has no client name yet so
// the caller can fall back to the legacy id-based name.
function sanitizePhotoName(s) {
  return (s || "").replace(/[\/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
}

/* The client's LAST name, which is what a tree crew and an office actually
   sort by. Handles the shapes a calendar title really produces:
     "Deborah Wood"        -> Wood
     "Wood, Deborah"       -> Wood        (comma means last name first)
     "Bob & Sue Wood"      -> Wood
     "Robert Wood Jr."     -> Wood        (suffixes are not surnames)
     "Mainstreet Dental"   -> Dental      (a business has no surname; the last
                                           word is still a stable, useful key)
   Falls back to the whole name if there is nothing better. */
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v", "md", "dds", "esq"]);
function lastNameOf(full) {
  const clean = sanitizePhotoName(full).replace(/[.,]+$/, "");
  if (!clean) return "";
  if (clean.includes(",")) {
    const head = clean.split(",")[0].trim();
    if (head) return head;
  }
  const parts = clean.split(" ").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!NAME_SUFFIXES.has(parts[i].toLowerCase())) return parts[i];
  }
  return clean;
}
function buildPhotoFilename(data, p, seq, ext) {
  // Last name + the date the photo was taken, e.g. "Wood 06-30-2026 01.jpg".
  // Naming happens at UPLOAD time, and an already-uploaded photo is skipped
  // because it has a url — so this only ever names photos that haven't gone
  // to Drive yet. Nothing already in Drive is renamed.
  const name = lastNameOf(data?.cn);
  if (!name) return null;
  let datePart = "";
  try {
    datePart = " " + new Date(p?.ts || Date.now())
      .toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
      .replace(/\//g, "-");
  } catch {}
  const seqPart = " " + String((seq ?? 0) + 1).padStart(2, "0");
  return `${name}${datePart}${seqPart}.${ext}`;
}

/* ── Queue health ───────────────────────────────────────────────────────────
   The upload queue had no terminal state. A stop that could not finish was
   retried every 60s for as long as the app was open, forever, and the only
   evidence was a count in the debug panel. This records what happened on each
   pass so a wedged stop can be seen, backed off, and reported.

   Backing off matters for more than tidiness: a stop failing on Drive
   throttling that is retried every minute keeps the throttle alive. */
const STATE_KEY = "mts-photo-queue-state";
const MAX_BACKOFF_MS = 30 * 60 * 1000;

function getState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); } catch { return {}; }
}
function setState(next) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch {}
}
function noteAttempt(stopId, patch) {
  const st = getState();
  st[stopId] = { ...(st[stopId] || {}), ...patch, lastTry: Date.now() };
  setState(st);
}
function clearState(stopId) {
  const st = getState();
  if (st[stopId]) { delete st[stopId]; setState(st); }
}
function backoffFor(tries) {
  return Math.min(MAX_BACKOFF_MS, 60_000 * Math.pow(2, Math.max(0, tries - 1)));
}

/** Everything the UI needs to explain a stuck upload. */
export function getPhotoQueueDetail() {
  const st = getState();
  return [...getQueue()].map(stopId => ({
    stopId,
    tries: st[stopId]?.tries || 0,
    pending: st[stopId]?.pending ?? null,
    lastError: st[stopId]?.lastError || null,
    lastTry: st[stopId]?.lastTry || 0,
  }));
}

/** Clear the backoff on every queued stop so the next pass runs immediately. */
export function retryPhotoQueueNow() {
  const st = getState();
  for (const id of Object.keys(st)) st[id] = { ...st[id], tries: 0, lastTry: 0 };
  setState(st);
}

/** Stop retrying one stop. The photos stay on the device untouched — this
 *  only takes it out of the upload queue. */
export function dropPhotoStop(stopId) {
  unmarkStop(stopId);
  clearState(stopId);
}

// ── Upload one stop's pending photos ────────────────────────────────────

async function syncStop(stopId, token) {
  const state = getState()[stopId] || {};
  // Respect the backoff. Without this a permanently-failing stop is retried
  // every 60 seconds for days.
  if (state.tries > 0 && Date.now() - (state.lastTry || 0) < backoffFor(state.tries)) return;

  let data;
  try { data = await loadField(stopId); }
  catch (e) {
    noteAttempt(stopId, { tries: (state.tries || 0) + 1, lastError: `Couldn't read the saved record: ${e.message}` });
    return;
  }
  // No record at all: the card was deleted, or its storage was cleared. There
  // is nothing here to upload and never will be, so the queue entry is dead
  // weight — it used to sit there forever, counted as a pending upload.
  if (!data) { dropPhotoStop(stopId); return; }

  // Recovery: shrink any legacy 4K photos before upload. Keeps the Drive
  // payload small (so sync actually succeeds) and shrinks IDB. One photo at a
  // time to bound peak memory. Re-load after so the upload sees small versions.
  try {
    if (await _shrinkOversized(stopId, data)) data = await loadField(stopId);
  } catch {}

  const sections = ["scopePhotos", "addonPhotos"];
  // Global sequence across BOTH sections (scope then addon), keyed by each
  // photo's stable key, so "Name #Job Date 01/02/03…" numbers a stop's photos
  // in one continuous run instead of colliding (scope #1 and addon #1).
  const seqByKey = new Map();
  [...(Array.isArray(data.scopePhotos) ? data.scopePhotos : []),
   ...(Array.isArray(data.addonPhotos) ? data.addonPhotos : [])]
    .forEach((p, i) => seqByKey.set(photoKey(p), i));

  // Track uploads per-section, indexed by stable key (ts || filename), so
  // we can write back through updateField without losing concurrent
  // photo adds/removes/edits.
  const uploadsBySection = {};
  let anyNewlySynced = false;
  let lastError = null;
  let rateLimited = false;

  for (const key of sections) {
    const photos = data[key];
    if (!Array.isArray(photos)) continue;
    uploadsBySection[key] = new Map();

    // ONE AT A TIME. This used to be Promise.all, which fired every photo on
    // a stop at Drive simultaneously — ten photos meant thirty-odd concurrent
    // requests once folder lookups and permission calls are counted. That is
    // exactly the burst Drive answers with 403 rate limits, and a rate-limited
    // upload used to be indistinguishable from a broken one. Sequential is
    // barely slower in practice and it stops the app throttling itself.
    for (const [i, p] of photos.entries()) {
      if (p.url) continue;           // Already uploaded
      if (!p.dataUrl) continue;      // Nothing to upload
      if (rateLimited) break;        // Drive said slow down — believe it
      try {
        const ext = p.dataUrl.startsWith("data:image/png") ? "png" : "jpg";
        const seq = seqByKey.get(photoKey(p)) ?? i;
        const filename = buildPhotoFilename(data, p, seq, ext) || `${stopId}_${key}_${p.ts || Date.now()}.${ext}`;
        const url = await uploadPhotoToDrive(token, p.dataUrl, filename);
        if (url) {
          anyNewlySynced = true;
          uploadsBySection[key].set(photoKey(p), { url, syncedAt: Date.now() });
        }
      } catch(e) {
        lastError = e?.isRateLimited
          ? "Google Drive is rate-limiting uploads — this will retry on its own."
          : (e?.message || String(e));
        if (e?.isRateLimited) rateLimited = true;
        console.warn("Photo upload failed for", stopId, e);
        logError("photoSync", `Photo upload failed for stop ${stopId}: ${e.message}`, { key, status: e.status });
      }
    }
  }

  // Write all upload results through updateField — queued, atomic, and
  // composes safely with concurrent text saves / photo adds / removes.
  if (anyNewlySynced) {
    await updateField(stopId, (existing) => {
      const updates = {};
      for (const key of sections) {
        const uploads = uploadsBySection[key];
        if (!uploads || uploads.size === 0) continue;
        const current = existing[key] || (key === "scopePhotos" ? existing.photos : null) || [];
        updates[key] = current.map(p => {
          const result = uploads.get(photoKey(p));
          return result ? { ...p, ...result } : p;
        });
      }
      return updates;
    }).catch(() => {});
    try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
    markStopForPromotion(stopId);
    // Push the updated field JSON to Drive so the compact url-bearing record
    // (not just the individual photo files) reaches the other device. Without
    // this the other device only sees photo URLs after some later text edit
    // happens to push the field JSON — which may be never.
    queueFieldDriveSync(token, stopId);
  }

  // If no more pending photos remain, remove from upload queue. Re-read
  // since updateField may have changed the photo records.
  try {
    const fresh = await loadField(stopId);
    // A record that vanished mid-pass is the same dead entry as above.
    if (!fresh) { dropPhotoStop(stopId); return; }
    let pending = 0;
    for (const key of sections) {
      const arr = fresh[key];
      if (Array.isArray(arr)) pending += arr.filter(p => !p.url && p.dataUrl).length;
    }
    if (pending === 0) {
      unmarkStop(stopId);
      clearState(stopId);
      return;
    }
    // Still pending. If this pass uploaded something we are making progress,
    // so reset the backoff; otherwise escalate it.
    noteAttempt(stopId, {
      pending,
      lastError,
      tries: anyNewlySynced ? 0 : (state.tries || 0) + 1,
    });
  } catch (e) {
    noteAttempt(stopId, { tries: (state.tries || 0) + 1, lastError: e?.message || String(e) });
  }
}

// ── Downscale oversized (legacy 4K) photos in place ──────────────────────

async function _shrinkOversized(stopId, data) {
  const sections = ["scopePhotos", "addonPhotos", "photos"];
  let changed = false;
  const next = {};
  for (const key of sections) {
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const out = [];
    for (const p of arr) {
      if (p && p.dataUrl && typeof p.dataUrl === "string" && p.dataUrl.length > OVERSIZE_DATAURL_LEN) {
        const small = await downscaleDataUrl(p.dataUrl);
        if (small !== p.dataUrl) { out.push({ ...p, dataUrl: small }); changed = true; }
        else out.push(p);
      } else {
        out.push(p);
      }
    }
    next[key] = out;
  }
  if (!changed) return false;
  await updateField(stopId, () => next).catch(() => {});
  return true;
}

// ── Promote (evict dataUrl after grace period) ──────────────────────────

export async function promoteStop(stopId) {
  let data;
  try { data = await loadField(stopId); }
  catch { return 0; }
  if (!data) return 0;

  const sections = ["scopePhotos", "addonPhotos"];
  // Track which ts/url keys should have their dataUrl evicted.
  const toEvict = new Set();
  let stillHasFresh = false;

  const now = Date.now();
  for (const key of sections) {
    const photos = data[key];
    if (!Array.isArray(photos)) continue;
    photos.forEach(p => {
      if (!p.url || !p.dataUrl) return; // already promoted or never synced
      const age = now - (p.syncedAt || 0);
      if (age >= PROMOTION_GRACE_MS) {
        toEvict.add(photoKey(p));
      } else {
        stillHasFresh = true;
      }
    });
  }

  if (toEvict.size > 0) {
    await updateField(stopId, (existing) => {
      const updates = {};
      for (const key of sections) {
        const photos = existing[key];
        if (!Array.isArray(photos)) continue;
        updates[key] = photos.map(p => {
          if (toEvict.has(photoKey(p))) {
            // Drop the working copy AND the stashed pre-edit original together
            // — both are local-only space savers and share the same lifecycle.
            const { dataUrl, originalDataUrl, ...rest } = p;
            return rest;
          }
          return p;
        });
      }
      return updates;
    }).catch(() => {});
  }
  if (!stillHasFresh) unmarkStopForPromotion(stopId);
  return toEvict.size;
}

// ── Process the entire queue ─────────────────────────────────────────────

let _processing = false;
let _processingStartMs = 0;

// A single pass, and a single stop within it, are both bounded.
//
// This is the fix for a queue that stopped moving entirely — no uploads, no
// errors, not even a rising attempt count. `_processing` is a plain module
// flag cleared in a `finally`, so it is only ever cleared if the await inside
// actually SETTLES. An IndexedDB read or a queued write that never resolves
// (a blocked upgrade, a transaction lost when the tab was suspended) leaves
// the flag true for the life of the page, and from then on every call —
// including the Retry button — returns at the guard on the first line and does
// nothing at all. Silently.
//
// So: a stop that takes too long is abandoned and recorded, and a pass that
// somehow still overruns has its lock treated as stale by the next caller.
const STOP_TIMEOUT_MS = 180_000;
const PASS_LOCK_STALE_MS = 5 * 60_000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

/** Clear a wedged pass lock. Exposed so the Retry button can guarantee that a
 *  tap actually runs something. */
export function resetPhotoQueueLock() {
  _processing = false;
  _processingStartMs = 0;
}

export async function processPhotoQueue(token) {
  if (!token) return;
  if (_processing) {
    // Take the lock back if the holder has plainly stopped making progress.
    if (!_processingStartMs || Date.now() - _processingStartMs < PASS_LOCK_STALE_MS) return;
    logWarn("photoSync", "Photo queue lock was stale — taking it over");
    _processing = false;
  }
  if (!navigator.onLine) return;

  // First: upload pending photos
  const queue = getQueue();
  if (queue.size > 0) {
    _processing = true;
    _processingStartMs = Date.now();
    await _wakeLockHandle.acquire();
    try {
      for (const stopId of queue) {
        try {
          await withTimeout(syncStop(stopId, token), STOP_TIMEOUT_MS, "timed-out");
        } catch (e) {
          // One wedged stop must not stop the others, and it must leave a
          // trace — this used to be the thing nobody could see.
          const msg = e?.message === "timed-out"
            ? "Timed out — this stop's photos couldn't be read or uploaded in three minutes."
            : (e?.message || String(e));
          const st = getState()[stopId] || {};
          noteAttempt(stopId, { tries: (st.tries || 0) + 1, lastError: msg });
          logError("photoSync", `Photo pass failed for ${stopId}: ${msg}`);
        }
      }
    } finally {
      _processing = false;
      _processingStartMs = 0;
      _wakeLockHandle.release();
    }
  }

  // Second: process promotion queue (evict aged-out dataUrls)
  // No token needed for this — pure local IDB work.
  await processPromotionQueue();
}

export async function processPromotionQueue() {
  const promoteQ = getQueue(PROMOTED_QUEUE_KEY);
  for (const stopId of promoteQ) {
    await promoteStop(stopId);
  }
}

// ── Global eviction backstop ─────────────────────────────────────────────
// processPromotionQueue() above only revisits stops that were marked during
// THIS session's upload. Photos synced on another device, or stops that fell
// out of the queue early, never get re-checked — so their dataUrls can sit
// around forever even though they're long since safe to drop. This sweeps
// every stop in the store and applies the same age check, as a backstop.
const SWEEP_LAST_KEY = "mts-photo-sweep-last";
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

export async function sweepAllPhotos() {
  const ids = await listFieldIds();
  let stopsScanned = 0, photosEvicted = 0;
  for (const id of ids) {
    stopsScanned++;
    photosEvicted += (await promoteStop(id)) || 0;
  }
  try { localStorage.setItem(SWEEP_LAST_KEY, String(Date.now())); } catch {}
  return { stopsScanned, photosEvicted };
}

function maybeSweepAllPhotos() {
  let last = 0;
  try { last = parseInt(localStorage.getItem(SWEEP_LAST_KEY) || "0", 10) || 0; } catch {}
  if (Date.now() - last >= SWEEP_INTERVAL_MS) sweepAllPhotos();
}

// ── Watcher ──────────────────────────────────────────────────────────────

let _getToken = null;
let _watcherInstalled = false;

export function startPhotoSyncWatcher(getToken) {
  _getToken = getToken;

  if (!_watcherInstalled) {
    _watcherInstalled = true;

    window.addEventListener("online", () => {
      const tok = _getToken?.();
      if (tok) processPhotoQueue(tok);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        const tok = _getToken?.();
        if (tok) processPhotoQueue(tok);
      }
    });

    // Retry failed photo uploads every 60s while the tab is visible.
    // Without this, a single network blip leaves photos stuck in the queue
    // until the user switches tabs or loses/regains connectivity.
    setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const tok = _getToken?.();
      if (tok && navigator.onLine) processPhotoQueue(tok);
    }, 60 * 1000);
  }

  const tok = getToken();
  if (tok && navigator.onLine) processPhotoQueue(tok);
  // Also run promotion sweep periodically (independent of token)
  processPromotionQueue();
  // And the global backstop sweep, at most once a day
  maybeSweepAllPhotos();
}
