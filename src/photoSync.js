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

import { loadField, updateField } from "./fieldStore";
import { uploadPhotoToDrive, queueFieldDriveSync } from "./driveSync";
import { downscaleDataUrl, OVERSIZE_DATAURL_LEN } from "./imageUtils";

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

// ── Upload one stop's pending photos ────────────────────────────────────

async function syncStop(stopId, token) {
  let data;
  try { data = await loadField(stopId); }
  catch { return; }
  if (!data) return;

  // Recovery: shrink any legacy 4K photos before upload. Keeps the Drive
  // payload small (so sync actually succeeds) and shrinks IDB. One photo at a
  // time to bound peak memory. Re-load after so the upload sees small versions.
  try {
    if (await _shrinkOversized(stopId, data)) data = await loadField(stopId);
  } catch {}

  const sections = ["scopePhotos", "addonPhotos"];
  // Track uploads per-section, indexed by stable key (ts || filename), so
  // we can write back through updateField without losing concurrent
  // photo adds/removes/edits.
  const uploadsBySection = {};
  let anyNewlySynced = false;

  for (const key of sections) {
    const photos = data[key];
    if (!Array.isArray(photos)) continue;
    uploadsBySection[key] = new Map();

    await Promise.all(photos.map(async (p) => {
      if (p.url) return;           // Already uploaded
      if (!p.dataUrl) return;      // Nothing to upload
      try {
        const ext = p.dataUrl.startsWith("data:image/png") ? "png" : "jpg";
        const filename = `${stopId}_${key}_${p.ts || Date.now()}.${ext}`;
        const url = await uploadPhotoToDrive(token, p.dataUrl, filename);
        if (url) {
          anyNewlySynced = true;
          uploadsBySection[key].set(p.ts || p.dataUrl, { url, syncedAt: Date.now() });
        }
      } catch(e) {
        console.warn("Photo upload failed for", stopId, e);
      }
    }));
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
          const id = p.ts || p.dataUrl;
          const result = uploads.get(id);
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
    const allUploaded = sections.every(key =>
      !Array.isArray(fresh[key]) || fresh[key].every(p => p.url || !p.dataUrl)
    );
    if (allUploaded) unmarkStop(stopId);
  } catch {}
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

async function promoteStop(stopId) {
  let data;
  try { data = await loadField(stopId); }
  catch { return; }
  if (!data) return;

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
        toEvict.add(p.ts || p.url);
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
          if (toEvict.has(p.ts || p.url)) {
            const { dataUrl, ...rest } = p;
            return rest;
          }
          return p;
        });
      }
      return updates;
    }).catch(() => {});
  }
  if (!stillHasFresh) unmarkStopForPromotion(stopId);
}

// ── Process the entire queue ─────────────────────────────────────────────

let _processing = false;

export async function processPhotoQueue(token) {
  if (!token || _processing) return;
  if (!navigator.onLine) return;

  // First: upload pending photos
  const queue = getQueue();
  if (queue.size > 0) {
    _processing = true;
    try {
      for (const stopId of queue) {
        await syncStop(stopId, token);
      }
    } finally {
      _processing = false;
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
}
