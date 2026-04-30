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

import { loadField, saveField, primeField } from "./fieldStore";
import { uploadPhotoToDrive } from "./driveSync";

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

  const sections = ["scopePhotos", "addonPhotos"];
  let changed = false;
  let anyNewlySynced = false;

  for (const key of sections) {
    const photos = data[key];
    if (!Array.isArray(photos)) continue;

    const updated = await Promise.all(photos.map(async (p) => {
      // Already uploaded — has a Drive URL
      if (p.url) return p;
      // No base64 to upload
      if (!p.dataUrl) return p;

      try {
        const ext = p.dataUrl.startsWith("data:image/png") ? "png" : "jpg";
        const filename = `${stopId}_${key}_${p.ts || Date.now()}.${ext}`;
        const url = await uploadPhotoToDrive(token, p.dataUrl, filename);
        if (url) {
          changed = true;
          anyNewlySynced = true;
          // Mark with syncedAt so we can later evict the dataUrl after grace period
          return { ...p, url, syncedAt: Date.now() };
        }
      } catch(e) {
        console.warn("Photo upload failed for", stopId, e);
      }
      return p;
    }));

    data = { ...data, [key]: updated };
  }

  if (changed) {
    primeField(stopId, data);
    await saveField(stopId, data).catch(() => {});
    try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
  }

  // If anything was just synced, queue this stop for promotion-eviction later
  if (anyNewlySynced) markStopForPromotion(stopId);

  // If no more pending photos remain, remove from upload queue
  const allUploaded = sections.every(key =>
    !Array.isArray(data[key]) || data[key].every(p => p.url || !p.dataUrl)
  );
  if (allUploaded) unmarkStop(stopId);
}

// ── Promote (evict dataUrl after grace period) ──────────────────────────

async function promoteStop(stopId) {
  let data;
  try { data = await loadField(stopId); }
  catch { return; }
  if (!data) return;

  const sections = ["scopePhotos", "addonPhotos"];
  let changed = false;
  let stillHasFresh = false;

  const now = Date.now();
  for (const key of sections) {
    const photos = data[key];
    if (!Array.isArray(photos)) continue;
    const updated = photos.map(p => {
      if (!p.url || !p.dataUrl) return p; // already promoted or never synced
      const age = now - (p.syncedAt || 0);
      if (age >= PROMOTION_GRACE_MS) {
        // Evict the dataUrl, keep everything else
        const { dataUrl, ...rest } = p;
        changed = true;
        return rest;
      }
      stillHasFresh = true;
      return p;
    });
    data = { ...data, [key]: updated };
  }

  if (changed) {
    primeField(stopId, data);
    await saveField(stopId, data).catch(() => {});
  }
  // If nothing left in grace window, remove from promotion queue
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
  }

  const tok = getToken();
  if (tok && navigator.onLine) processPhotoQueue(tok);
  // Also run promotion sweep periodically (independent of token)
  processPromotionQueue();
}
