/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Offline Photo Upload Queue
   ───────────────────────────────────────────────────────────────────────────
   When the device is offline (or Drive upload fails), photos are stored as
   base64 in IndexedDB via fieldStore — same as before. This module:

   1.  Tracks which stops have pending-upload photos via localStorage
       ("mts-photo-queue": Set of stopIds).

   2.  When the browser comes online (or the app regains focus with a token),
       processPhotoQueue() iterates each queued stopId, uploads every photo
       that still has a dataUrl (but no url yet), and replaces the dataUrl
       with the Drive-served URL in IndexedDB.

   3.  The component renders src={p.url || p.dataUrl} everywhere — once a
       photo is uploaded, the Drive URL takes over for fast CDN loading; the
       base64 is intentionally retained in IDB as the offline fallback and
       so PhotoMarkup can always draw on a local copy. If the user marks up
       a photo, url is cleared and the stop is re-queued so the edited
       version gets re-uploaded.

   This approach means photos are NEVER lost even if the upload fails; they
   just stay as base64 until the next successful sync.
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, saveField, primeField } from "./fieldStore";
import { uploadPhotoToDrive } from "./driveSync";

const QUEUE_KEY = "mts-photo-queue"; // localStorage key → JSON array of stopIds

// ── Queue management ─────────────────────────────────────────────────────

function getQueue() {
  try { return new Set(JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]")); }
  catch { return new Set(); }
}

function saveQueue(set) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify([...set])); }
  catch {}
}

/**
 * Mark a stop as having photos that need Drive upload.
 * Called by OnsiteWindow after a photo is saved to IDB.
 */
export function markStopForPhotoSync(stopId) {
  const q = getQueue();
  q.add(stopId);
  saveQueue(q);
}

/**
 * Remove a stop from the queue once all its photos are uploaded.
 * Called internally after a successful full-upload pass.
 */
function unmarkStop(stopId) {
  const q = getQueue();
  q.delete(stopId);
  saveQueue(q);
}

// ── Upload one stop's pending photos ────────────────────────────────────

async function syncStop(stopId, token) {
  let data;
  try { data = await loadField(stopId); }
  catch { return; }
  if (!data) return;

  const sections = ["scopePhotos", "addonPhotos"];
  let changed = false;

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
          // dataUrl is intentionally retained alongside url.
          // It serves as the offline fallback (src={p.url || p.dataUrl})
          // and is required by PhotoMarkup for drawing. Clearing it would
          // break markup on uploaded photos. IDB space is acceptable;
          // the key win is that app-state.json stays small (no photos embedded).
          return { ...p, url };
        }
      } catch(e) {
        console.warn("Photo upload failed for", stopId, e);
      }
      return p; // leave base64 intact on error
    }));

    data = { ...data, [key]: updated };
  }

  if (changed) {
    primeField(stopId, data);
    await saveField(stopId, data).catch(() => {});
    try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
  }

  // If no more pending photos remain, remove from queue
  const allUploaded = sections.every(key =>
    !Array.isArray(data[key]) || data[key].every(p => p.url || !p.dataUrl)
  );
  if (allUploaded) unmarkStop(stopId);
}

// ── Process the entire queue ─────────────────────────────────────────────

let _processing = false;

export async function processPhotoQueue(token) {
  if (!token || _processing) return;
  if (!navigator.onLine) return;

  const queue = getQueue();
  if (queue.size === 0) return;

  _processing = true;
  try {
    for (const stopId of queue) {
      await syncStop(stopId, token);
    }
  } finally {
    _processing = false;
  }
}

// ── Watcher: auto-process when online event fires ───────────────────────

let _getToken = null;
let _watcherInstalled = false;

/**
 * Call once from App.jsx (after token is available).
 * getToken() is a function that returns the current token.
 */
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

  // Run immediately in case there's a queue from a prior session
  const tok = getToken();
  if (tok && navigator.onLine) processPhotoQueue(tok);
}
