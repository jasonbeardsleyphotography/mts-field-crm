/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Upload Queue
   ───────────────────────────────────────────────────────────────────────────
   Solves the "phone in pocket, app backgrounded, 6-hour upload" problem by:

   1.  Persisting the actual video Blob to IndexedDB the moment the user
       picks it. After that point, the app being closed/backgrounded/
       reloaded does NOT lose the video — it just delays the upload.

   2.  Compressing to 720p H.264 ~2 Mbps before upload (videoCompress.js).
       A 500 MB original becomes ~30 MB. 15-20x faster network transfer.

   3.  Uploading in 5 MB CHUNKED resumable PUTs to YouTube. When the app
       is backgrounded mid-upload the current chunk fails, we persist the
       byte offset, and on the next resume we ask YouTube where it left
       off (a status query) and continue from there. No restarts.

   4.  WiFi-only mode by default. Videos sit queued until the device
       reports a WiFi/ethernet connection. Each item has an "Upload now"
       override that ignores the gate.

   ──────────────────────────────────────────────────────────────────────────
   Switching modes:
     UPLOAD_MODE = "wifi"    — only upload on WiFi/ethernet (default)
     UPLOAD_MODE = "hybrid"  — upload on WiFi automatically, allow per-item
                               cellular override (basically "wifi" but
                               surfaces the override more aggressively)
     UPLOAD_MODE = "always"  — upload immediately on any connection

   Change the constant below or call setUploadMode() at runtime — the
   queue picks up the new mode on its next tick.
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, saveField, primeField } from "./fieldStore";
import { saveFieldToDrive } from "./driveSync";
import { compressVideo } from "./videoCompress";
import { incUpload, decUpload } from "./uploadStatus";

// ── Configuration ──────────────────────────────────────────────────────

const DEFAULT_MODE = "always"; // "wifi" | "hybrid" | "always"
const MODE_KEY = "mts-video-upload-mode";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — YouTube requires multiples of 256 KB; 5 MB is well-tested
const CHUNK_RETRY_LIMIT = 3;        // per-chunk retry count before pausing the queue item

// Structured logging — every line prefixed [VQ] so you can filter the
// browser console by "VQ" to see only video-queue activity. Helpful
// when an upload appears stuck and we need to know which phase it's in.
const vqLog = (...args) => { try { console.log("[VQ]", ...args); } catch {} };
const vqWarn = (...args) => { try { console.warn("[VQ]", ...args); } catch {} };

// ── IndexedDB ──────────────────────────────────────────────────────────

const DB_NAME = "mts-video-queue";
const DB_VER = 1;
const STORE = "queue";

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(mode) {
  return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

// ── Mode management ────────────────────────────────────────────────────

let _mode = (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY)) || DEFAULT_MODE;
let _modeListeners = new Set();

export function getUploadMode() { return _mode; }
export function setUploadMode(mode) {
  if (!["wifi", "hybrid", "always"].includes(mode)) return;
  _mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  _modeListeners.forEach(fn => { try { fn(mode); } catch {} });
  // Kick the watcher in case we just unlocked uploads
  _maybeProcessQueue();
}
export function onModeChange(fn) { _modeListeners.add(fn); return () => _modeListeners.delete(fn); }

// ── Connection detection ───────────────────────────────────────────────
// navigator.connection is supported on Chrome/Edge/Android. Safari iOS does
// NOT expose it. On iOS we conservatively assume "unknown" connection and
// fall back to: assume cellular UNLESS the user toggled to "always" or
// flipped on a per-item override. Practically this means iOS users will
// queue everything until they manually trigger uploads — which matches our
// "WiFi default" intent (we just can't auto-detect WiFi on iOS, so the user
// has to either flip the global toggle or hit "Upload now" per item).

function isOnWifi() {
  if (!navigator.onLine) return false;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return null; // unknown — caller decides
  // type is the modern field; effectiveType is fallback
  if (c.type === "wifi" || c.type === "ethernet") return true;
  if (c.type === "cellular") return false;
  return null;
}

function shouldUpload(item) {
  if (item.forceNow) return true;     // per-item override
  if (_mode === "always") return true;
  if (!navigator.onLine) return false;
  const wifi = isOnWifi();
  if (wifi === true) return true;
  if (wifi === false) return false;
  // Unknown (iOS) — only auto-process if mode is "always"; otherwise wait
  // for explicit user action. This is the conservative path.
  return false;
}

// ── Queue CRUD ─────────────────────────────────────────────────────────

const _listeners = new Set();
function notify() {
  listAll().then(items => {
    _listeners.forEach(fn => { try { fn(items); } catch {} });
  });
}
export function onQueueChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

export async function listAll() {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function listForStop(stopId) {
  const all = await listAll();
  return all.filter(i => i.stopId === stopId);
}

async function getItem(id) {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putItem(item) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteItem(id) {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Add a video to the queue. Returns the queue item id.
 * status flow:
 *   "queued" → "compressing" → "ready" → "uploading" → "done" (then removed)
 *   any state → "error" (with retry count); "paused" if user-paused
 */
export async function enqueueVideo({ stopId, file, title }) {
  const id = `vq_${stopId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const item = {
    id,
    stopId,
    title,
    originalFile: file,        // Blob — IDB stores Blobs natively, no base64 needed
    originalSize: file.size,
    originalName: file.name || "video.mov",
    status: "queued",
    progress: 0,
    bytesUploaded: 0,
    totalBytes: file.size,     // updated post-compression
    uploadUrl: null,           // YouTube resumable session URL
    retries: 0,
    forceNow: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  };
  await putItem(item);
  vqLog("enqueued", { id, stopId, title, originalSize: file.size });
  notify();
  _maybeProcessQueue();
  return id;
}

export async function forceUploadNow(id) {
  const item = await getItem(id);
  if (!item) return;
  item.forceNow = true;
  item.status = item.status === "error" || item.status === "paused" ? "queued" : item.status;
  item.retries = 0;
  item.error = null;
  item.updatedAt = Date.now();
  await putItem(item);
  notify();
  _maybeProcessQueue();
}

export async function cancelQueueItem(id) {
  await deleteItem(id);
  notify();
}

export async function retryQueueItem(id) {
  const item = await getItem(id);
  if (!item) return;
  item.status = "queued";
  item.retries = 0;
  item.error = null;
  item.updatedAt = Date.now();
  await putItem(item);
  notify();
  _maybeProcessQueue();
}

// ── Worker loop ────────────────────────────────────────────────────────

let _processing = false;
let _getToken = null;

async function _maybeProcessQueue() {
  if (_processing) return;
  if (!_getToken) return;
  const items = await listAll();
  const next = items.find(i =>
    (i.status === "queued" || i.status === "ready") && shouldUpload(i)
  );
  if (!next) return;
  _processing = true;
  try {
    await _processOne(next.id);
  } finally {
    _processing = false;
    // Tail recurse — picks up the next queued item if any are still actionable
    setTimeout(() => _maybeProcessQueue(), 100);
  }
}

async function _processOne(id) {
  const item = await getItem(id);
  if (!item) return;
  const token = _getToken?.();
  if (!token) { vqWarn("processOne: no token, skipping", id); return; }

  vqLog("processOne start", { id, stopId: item.stopId, title: item.title, status: item.status, originalSize: item.originalSize, compressedSize: item.compressedSize, bytesUploaded: item.bytesUploaded });
  incUpload(item.stopId);
  try {
    // ── Phase 1: Compress (skipped if already done) ─────────────────────
    let blob = item.compressedFile || item.originalFile;
    if (!item.compressedFile && item.status !== "ready") {
      vqLog("compress phase begin", { id, originalSize: item.originalSize });
      await _setStatus(id, "compressing", { progress: 0 });
      const result = await compressVideo(item.originalFile, async (pct) => {
        // Throttle progress writes — once every ~5% to avoid IDB thrash
        if (pct % 5 === 0) await _setProgress(id, pct);
      });
      blob = result.blob;
      vqLog("compress phase done", { id, skipped: result.skipped, reason: result.reason, originalSize: result.originalSize, compressedSize: result.compressedSize });
      const itm = await getItem(id);
      if (!itm) return; // canceled mid-compress
      itm.compressedFile = blob;
      itm.compressedSize = blob.size;
      itm.totalBytes = blob.size;
      itm.status = "ready";
      itm.progress = 0;
      itm.bytesUploaded = 0;
      itm.compressionSkipped = !!result.skipped;
      itm.compressionReason = result.reason || null;
      itm.updatedAt = Date.now();
      await putItem(itm);
      notify();
    }

    // ── Phase 2: Init or resume YouTube session ─────────────────────────
    const cur = await getItem(id);
    if (!cur) return;
    let uploadUrl = cur.uploadUrl;
    let bytesUploaded = cur.bytesUploaded || 0;

    if (!uploadUrl) {
      vqLog("init YT session", { id, size: blob.size, mime: blob.type });
      uploadUrl = await _initYouTubeSession(token, cur.title, blob.size, blob.type || "video/mp4");
      if (!uploadUrl) throw new Error("Failed to init YouTube upload session (check token + YouTube API enabled)");
      vqLog("YT session ready", { id, sessionUrl: uploadUrl.slice(0,80) + "..." });
      cur.uploadUrl = uploadUrl;
      cur.updatedAt = Date.now();
      await putItem(cur);
    } else {
      // Resuming — ask YouTube where we left off
      vqLog("resuming session", { id, lastByte: bytesUploaded });
      const resumed = await _queryUploadOffset(uploadUrl, blob.size);
      vqLog("resume query result", { id, resumed });
      if (resumed === "complete") {
        await _setStatus(id, "error", { error: "Upload appears complete but result was lost. Check YouTube." });
        return;
      }
      if (typeof resumed === "number") bytesUploaded = resumed;
      if (resumed === null) {
        vqLog("session expired, re-initing", { id });
        cur.uploadUrl = null;
        cur.bytesUploaded = 0;
        await putItem(cur);
        return _processOne(id);
      }
    }

    // ── Phase 3: Chunked upload loop ────────────────────────────────────
    await _setStatus(id, "uploading");
    while (bytesUploaded < blob.size) {
      const itm = await getItem(id);
      if (!itm) return; // canceled
      if (itm.status === "paused") return;

      const end = Math.min(bytesUploaded + CHUNK_SIZE, blob.size);
      const chunk = blob.slice(bytesUploaded, end);
      const isLast = end === blob.size;

      const t0 = Date.now();
      const result = await _uploadChunk(uploadUrl, chunk, bytesUploaded, end, blob.size);
      const ms = Date.now() - t0;
      vqLog("chunk done", { id, range: `${bytesUploaded}-${end-1}/${blob.size}`, isLast, kind: result.kind, ms });

      if (result.kind === "ok-final") {
        vqLog("upload complete", { id, videoId: result.videoId });
        await _finalize(id, result.videoId, token);
        return;
      }
      if (result.kind === "ok-progress") {
        bytesUploaded = result.nextOffset;
        const pct = Math.floor((bytesUploaded / blob.size) * 100);
        await _setProgress(id, pct, bytesUploaded);
        continue;
      }
      if (result.kind === "session-expired") {
        vqLog("session expired mid-upload, re-initing", { id });
        const itm2 = await getItem(id);
        if (itm2) {
          itm2.uploadUrl = null;
          itm2.bytesUploaded = 0;
          await putItem(itm2);
        }
        return _processOne(id);
      }
      // Network error or 5xx — bump retries, throw if too many
      const itm2 = await getItem(id);
      if (!itm2) return;
      itm2.retries = (itm2.retries || 0) + 1;
      vqWarn("chunk failed", { id, attempt: itm2.retries, error: result.error });
      if (itm2.retries >= CHUNK_RETRY_LIMIT) {
        itm2.status = "error";
        itm2.error = result.error || "Chunk upload failed after retries";
        itm2.updatedAt = Date.now();
        await putItem(itm2);
        notify();
        return;
      }
      await putItem(itm2);
      notify();
      // Brief backoff then retry
      await new Promise(r => setTimeout(r, 1500 * itm2.retries));
    }
  } catch (e) {
    vqWarn("processOne exception", id, e?.message || e);
    await _setStatus(id, "error", { error: e.message || String(e) });
  } finally {
    decUpload(item.stopId);
  }
}

async function _setStatus(id, status, extra = {}) {
  const item = await getItem(id);
  if (!item) return;
  Object.assign(item, { status, updatedAt: Date.now() }, extra);
  await putItem(item);
  notify();
}

async function _setProgress(id, progress, bytesUploaded) {
  const item = await getItem(id);
  if (!item) return;
  item.progress = progress;
  if (typeof bytesUploaded === "number") item.bytesUploaded = bytesUploaded;
  item.updatedAt = Date.now();
  await putItem(item);
  notify();
}

async function _finalize(id, videoId, token) {
  const item = await getItem(id);
  if (!item) return;
  const ytUrl = `https://youtu.be/${videoId}`;
  // Persist to fieldStore — the same shape OnsiteWindow already reads
  try {
    const saved = await loadField(item.stopId).catch(() => ({}));
    const existing = saved?.videoUrls || (saved?.videoUrl ? [saved.videoUrl] : []);
    if (!existing.includes(ytUrl)) {
      const next = { ...(saved || {}), videoUrls: [...existing, ytUrl], savedAt: Date.now() };
      primeField(item.stopId, next);
      await saveField(item.stopId, next).catch(() => {});
      saveFieldToDrive(token, item.stopId, next).catch(() => {});
      // Notify listening components (OnsiteWindow / Pipeline) to refresh
      try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
    }
  } catch (e) {
    console.warn("Finalize fieldStore write failed:", e);
  }
  // Done — remove from queue
  await deleteItem(id);
  notify();
}

// ── YouTube resumable upload primitives ────────────────────────────────

async function _initYouTubeSession(token, title, size, mimeType) {
  const metadata = { snippet: { title }, status: { privacyStatus: "unlisted" } };
  let res;
  try {
    res = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify(metadata),
      }
    );
  } catch (e) {
    vqWarn("YT init network error:", e?.message || e);
    return null;
  }
  if (!res.ok) {
    const txt = await res.text().catch(()=>"");
    vqWarn("YT init failed:", res.status, txt.slice(0, 200));
    return null;
  }
  return res.headers.get("Location");
}

/**
 * Query a resumable session for its current byte offset.
 * Returns: number (next offset to upload), "complete", or null (session dead).
 */
async function _queryUploadOffset(uploadUrl, totalSize) {
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": "0", "Content-Range": `bytes */${totalSize}` },
    });
    if (res.status === 200 || res.status === 201) return "complete";
    if (res.status === 308) {
      const range = res.headers.get("Range"); // e.g. "bytes=0-524287"
      if (!range) return 0;
      const m = range.match(/bytes=0-(\d+)/);
      return m ? parseInt(m[1], 10) + 1 : 0;
    }
    if (res.status === 404 || res.status === 410) return null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Upload one chunk to a resumable session.
 * Returns one of:
 *   { kind: "ok-final", videoId }     — last chunk, video accepted
 *   { kind: "ok-progress", nextOffset } — interim chunk, server confirmed range
 *   { kind: "session-expired" }       — 404/410 from server
 *   { kind: "error", error }          — network or 5xx
 */
async function _uploadChunk(uploadUrl, chunk, start, end, total) {
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.size),
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
      },
      body: chunk,
    });
    if (res.status === 200 || res.status === 201) {
      const body = await res.json().catch(() => null);
      if (body?.id) return { kind: "ok-final", videoId: body.id };
      return { kind: "error", error: "Final response missing video id" };
    }
    if (res.status === 308) {
      // Resume Incomplete — server confirms how much it has
      const range = res.headers.get("Range");
      const m = range?.match(/bytes=0-(\d+)/);
      const nextOffset = m ? parseInt(m[1], 10) + 1 : end;
      return { kind: "ok-progress", nextOffset };
    }
    if (res.status === 404 || res.status === 410) return { kind: "session-expired" };
    return { kind: "error", error: `HTTP ${res.status}` };
  } catch (e) {
    return { kind: "error", error: e.message || String(e) };
  }
}

// ── Watcher: kick the queue on connection / visibility / online events ──

let _watcherInstalled = false;

export function startVideoQueueWatcher(getToken) {
  _getToken = getToken;
  if (_watcherInstalled) {
    _maybeProcessQueue();
    return;
  }
  _watcherInstalled = true;

  window.addEventListener("online", () => _maybeProcessQueue());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") _maybeProcessQueue();
  });
  // Connection type change (Chrome/Android only)
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c && typeof c.addEventListener === "function") {
    c.addEventListener("change", () => _maybeProcessQueue());
  }

  _maybeProcessQueue();
}

// Force-tick the queue (called from UI after toggling mode)
export function pokeQueue() { _maybeProcessQueue(); }

// Status helpers for UI
export function describeMode(mode) {
  switch (mode) {
    case "always": return "Always upload";
    case "hybrid": return "WiFi auto, cell on demand";
    case "wifi":
    default: return "WiFi only";
  }
}

export function isWifi() { return isOnWifi(); }
