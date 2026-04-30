/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Upload Queue (v3 — Drive)
   ───────────────────────────────────────────────────────────────────────────
   This version uploads videos to Google Drive instead of YouTube. Drive is:
   - More reliable (more mature API surface)
   - No daily quota cap (YouTube was 6 videos/day default)
   - Already authenticated (we use Drive for app state and photos)
   - Universal client playback via /preview URL

   Key changes from v2:
   1. Target is Drive, not YouTube
   2. Per-chunk timeout (60s) prevents indefinite hangs on cellular flake
   3. Saves canonical /preview URL to card on completion
   4. Uses anyone-with-link permission so URLs work in client emails

   Key invariants kept from v2:
   - Persistent IDB queue survives tab restarts
   - Pause/resume single global toggle
   - Aggressive retry (5 attempts, exponential backoff)
   - Watchdog releases stuck worker locks
   - Diagnostic log to videoLog.js
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, saveField, primeField } from "./fieldStore";
import { incUpload, decUpload } from "./uploadStatus";
import { vlogInfo, vlogWarn, vlogError } from "./videoLog";
import {
  initDriveSession,
  uploadChunk,
  queryUploadOffset,
  makeDriveFilePublic,
  getVideosFolderId,
  buildShareUrl,
} from "./driveUpload";

// ── Tunables ─────────────────────────────────────────────────────────────

const CHUNK_SIZE = 5 * 1024 * 1024;       // 5MB chunks
const CHUNK_RETRY_LIMIT = 5;              // 5 attempts per chunk
const WORKER_LOCK_WATCHDOG_MS = 10 * 60 * 1000;
const RETRY_BACKOFF_MS = [1500, 3000, 6000, 12000, 30000];
const PAUSE_KEY = "mts-video-uploads-paused";

// ── IndexedDB ────────────────────────────────────────────────────────────

const DB_NAME = "mts-video-queue";
// DB_VER bumped to 3 because schema fields changed (was uploadUrl→sessionUrl,
// videoId→fileId, etc.). Old items get migrated by reading and re-saving with
// the new shape, keeping their file blob.
const DB_VER = 3;
const STORE = "queue";

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

async function _idbOp(mode, op) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    op(store, (r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const idbPut    = (item) => _idbOp("readwrite", (s) => s.put(item));
const idbGet    = (id)   => _idbOp("readonly",  (s, ret) => { s.get(id).onsuccess = (e) => ret(e.target.result); });
const idbDelete = (id)   => _idbOp("readwrite", (s) => s.delete(id));
const idbAll    = ()     => _idbOp("readonly",  (s, ret) => { s.getAll().onsuccess = (e) => ret(e.target.result || []); });

// ── Pause state ──────────────────────────────────────────────────────────

let _isPaused = false;
try { _isPaused = localStorage.getItem(PAUSE_KEY) === "1"; } catch {}

export function isPaused() { return _isPaused; }
export function setPaused(p) {
  _isPaused = !!p;
  try { localStorage.setItem(PAUSE_KEY, _isPaused ? "1" : "0"); } catch {}
  vlogInfo("queue.paused", { paused: _isPaused });
  notify();
  if (!_isPaused) _kick();
}

// ── Subscribers ──────────────────────────────────────────────────────────

const _listeners = new Set();
export function onQueueChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

let _notifyTimer = null;
function notify() {
  if (_notifyTimer) return;
  _notifyTimer = setTimeout(async () => {
    _notifyTimer = null;
    try {
      const all = await idbAll();
      _listeners.forEach(fn => { try { fn(all); } catch {} });
    } catch {}
  }, 50);
}

// ── Public API ───────────────────────────────────────────────────────────

export async function listAll() { return await idbAll(); }
export async function listForStop(stopId) {
  const all = await idbAll();
  return all.filter(i => i.stopId === stopId);
}

export async function enqueueVideo({ stopId, file, title }) {
  if (!file || !file.size) {
    vlogError("enqueue.bad_file", { hasFile: !!file, size: file?.size });
    throw new Error("No file or empty file");
  }
  const id = `vq_${stopId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const item = {
    id,
    stopId,
    title,
    file,
    fileSize: file.size,
    fileName: file.name || "video.mov",
    fileType: file.type || "video/mp4",
    status: "queued",                  // queued | uploading | done | error
    progress: 0,
    bytesUploaded: 0,
    sessionUrl: null,                  // Drive resumable session URL
    folderId: null,                    // Drive folder where file will live
    retries: 0,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await idbPut(item);
  vlogInfo("enqueue.ok", { id, stopId, title, fileSize: file.size, fileType: item.fileType }, id);
  notify();
  _kick();
  return id;
}

export async function cancelItem(id) {
  vlogInfo("cancel", null, id);
  await idbDelete(id);
  notify();
}

export async function retryItem(id) {
  const item = await idbGet(id);
  if (!item) return;
  item.status = "queued";
  item.retries = 0;
  item.error = null;
  item.updatedAt = Date.now();
  await idbPut(item);
  vlogInfo("retry.requested", null, id);
  notify();
  _kick();
}

// ── Worker ───────────────────────────────────────────────────────────────

let _processing = false;
let _processingStartMs = 0;
let _getToken = null;
let _watcherInstalled = false;

export function forceUnstick() {
  vlogWarn("worker.force_unstick", { wasProcessing: _processing });
  _processing = false;
  _kick();
}

export function _kick() {
  if (_processing && _processingStartMs && Date.now() - _processingStartMs > WORKER_LOCK_WATCHDOG_MS) {
    vlogWarn("worker.watchdog_release", { heldForMs: Date.now() - _processingStartMs });
    _processing = false;
  }
  if (_processing) return;
  if (_isPaused) return;
  if (!_getToken) return;
  _processNext().catch((e) => {
    vlogError("worker.uncaught", { msg: e?.message || String(e) });
    _processing = false;
  });
}

async function _processNext() {
  if (_processing || _isPaused) return;
  _processing = true;
  _processingStartMs = Date.now();
  try {
    while (true) {
      if (_isPaused) break;
      const all = await idbAll();
      const next = all.find(i => i.status === "queued" || i.status === "uploading");
      if (!next) break;
      const ok = await _processItem(next.id);
      if (!ok) break;
    }
  } finally {
    _processing = false;
    _processingStartMs = 0;
  }
}

async function _setItem(id, patch) {
  const cur = await idbGet(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await idbPut(next);
  notify();
  return next;
}

async function _processItem(id) {
  const item = await idbGet(id);
  if (!item) return false;
  const token = _getToken?.();
  if (!token) {
    vlogWarn("process.no_token", null, id);
    return false;
  }

  if (!item.file || !item.file.size) {
    vlogError("process.missing_file", { hasFile: !!item.file }, id);
    await _setItem(id, { status: "error", error: "Video file lost (try re-uploading)" });
    return true;
  }

  vlogInfo("process.start", { fileSize: item.fileSize, status: item.status, bytesUploaded: item.bytesUploaded }, id);
  incUpload(item.stopId);
  try {
    await _setItem(id, { status: "uploading" });

    // Resolve target folder (cached)
    let folderId = item.folderId;
    if (!folderId) {
      try {
        folderId = await getVideosFolderId(token);
        await _setItem(id, { folderId });
      } catch (e) {
        vlogError("drive.folder_failed", { msg: e?.message }, id);
        await _setItem(id, { status: "error", error: "Could not access Drive videos folder" });
        return true;
      }
    }

    // Phase 1: ensure session
    let session = item.sessionUrl;
    if (!session) {
      vlogInfo("drive.init.start", { fileSize: item.fileSize }, id);
      const init = await initDriveSession(token, item.title, item.fileSize, item.fileType, folderId);
      if (!init.ok) {
        vlogError("drive.init.fail", { error: init.error, status: init.status }, id);
        await _setItem(id, { status: "error", error: `Could not start Drive upload: ${init.error}` });
        return true;
      }
      session = init.sessionUrl;
      vlogInfo("drive.init.ok", { sessionPrefix: session.slice(0, 80) }, id);
      await _setItem(id, { sessionUrl: session, bytesUploaded: 0 });
    } else {
      vlogInfo("drive.resume.query", { lastKnown: item.bytesUploaded }, id);
      const offset = await queryUploadOffset(session, item.fileSize);
      if (offset === null) {
        vlogWarn("drive.resume.session_expired", null, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }
      if (offset === "complete") {
        // Server has the bytes but we lost the file ID. Mark error so the
        // user knows; they can manually find it in Drive.
        vlogWarn("drive.resume.already_complete", null, id);
        await _setItem(id, {
          status: "error",
          error: "Upload completed on Drive but the file ID was lost. Check Drive's MTS Field/field-data/videos folder.",
        });
        return true;
      }
      vlogInfo("drive.resume.offset", { offset }, id);
      await _setItem(id, { bytesUploaded: offset });
    }

    // Phase 2: chunked upload loop
    const refresh = await idbGet(id);
    if (!refresh) return false;
    let bytesUploaded = refresh.bytesUploaded || 0;
    let chunkRetries = 0;

    while (bytesUploaded < item.fileSize) {
      if (_isPaused) {
        vlogInfo("chunk.paused", null, id);
        return false;
      }
      const probe = await idbGet(id);
      if (!probe) { vlogInfo("chunk.canceled_externally", null, id); return false; }

      const end = Math.min(bytesUploaded + CHUNK_SIZE, item.fileSize);
      const chunk = item.file.slice(bytesUploaded, end);
      const t0 = Date.now();
      vlogInfo("chunk.start", { rangeStart: bytesUploaded, rangeEnd: end - 1, total: item.fileSize, attempt: chunkRetries + 1 }, id);

      const result = await uploadChunk(session, chunk, bytesUploaded, end - 1, item.fileSize);
      const ms = Date.now() - t0;

      if (result.kind === "ok-final") {
        vlogInfo("chunk.final_ok", { ms, fileId: result.fileId }, id);
        await _finalize(id, result.fileId, token);
        return true;
      }
      if (result.kind === "ok-progress") {
        vlogInfo("chunk.ok", { ms, nextOffset: result.nextOffset }, id);
        bytesUploaded = result.nextOffset;
        const pct = Math.floor((bytesUploaded / item.fileSize) * 100);
        await _setItem(id, { progress: pct, bytesUploaded, retries: 0 });
        chunkRetries = 0;
        continue;
      }
      if (result.kind === "session-expired") {
        vlogWarn("chunk.session_expired", { ms }, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }

      // Error path
      chunkRetries++;
      vlogWarn("chunk.fail", { ms, attempt: chunkRetries, error: result.error }, id);
      if (chunkRetries >= CHUNK_RETRY_LIMIT) {
        await _setItem(id, {
          status: "error",
          error: `Upload chunk failed after ${chunkRetries} retries: ${result.error}`,
        });
        return true;
      }
      const backoff = RETRY_BACKOFF_MS[Math.min(chunkRetries - 1, RETRY_BACKOFF_MS.length - 1)];
      await _setItem(id, { retries: chunkRetries });
      vlogInfo("chunk.backoff", { ms: backoff }, id);
      await new Promise(r => setTimeout(r, backoff));

      // After backoff, query current server offset in case our local view
      // is stale (e.g. timeout fired but the chunk had actually transferred)
      const offset = await queryUploadOffset(session, item.fileSize);
      if (offset === null) {
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }
      if (offset === "complete") {
        await _setItem(id, { status: "error", error: "Upload completed but file ID was lost. Check Drive videos folder." });
        return true;
      }
      bytesUploaded = offset;
      await _setItem(id, { bytesUploaded });
    }
    vlogError("loop.exhausted_without_final", { bytesUploaded, fileSize: item.fileSize }, id);
    await _setItem(id, { status: "error", error: "Upload completed bytes but never received final acknowledgment" });
    return true;
  } catch (e) {
    vlogError("process.exception", { msg: e?.message || String(e), stack: (e?.stack || "").slice(0, 500) }, id);
    await _setItem(id, { status: "error", error: e.message || String(e) }).catch(() => {});
    return true;
  } finally {
    decUpload(item.stopId);
  }
}

async function _finalize(id, fileId, token) {
  const item = await idbGet(id);
  if (!item) return;
  vlogInfo("finalize.start", { fileId }, id);

  // Make the file readable by anyone with the link, so client emails work
  const publicOk = await makeDriveFilePublic(token, fileId);
  if (!publicOk) {
    vlogWarn("finalize.permission_failed", { fileId }, id);
    // Continue anyway — the file uploaded; user can manually share it
  }

  const shareUrl = buildShareUrl(fileId);

  // Save the link to the card's field data
  try {
    const saved = await loadField(item.stopId).catch(() => ({}));
    const existing = saved?.videoUrls || (saved?.videoUrl ? [saved.videoUrl] : []);
    if (!existing.includes(shareUrl)) {
      const next = { ...(saved || {}), videoUrls: [...existing, shareUrl], savedAt: Date.now() };
      primeField(item.stopId, next);
      await saveField(item.stopId, next).catch(() => {});
      try { window.dispatchEvent(new CustomEvent("mts-video-uploaded", { detail: { stopId: item.stopId, shareUrl, fileId } })); } catch {}
    }
  } catch (e) {
    vlogWarn("finalize.field_write_failed", { msg: e?.message }, id);
  }
  await idbDelete(id);
  vlogInfo("finalize.ok", { fileId, shareUrl }, id);
  notify();
}

// ── Watcher ──────────────────────────────────────────────────────────────

export function startVideoQueueWatcher(getToken) {
  _getToken = getToken;
  if (_watcherInstalled) {
    _kick();
    return;
  }
  _watcherInstalled = true;
  vlogInfo("watcher.install", null);

  window.addEventListener("online", () => { vlogInfo("event.online", null); _kick(); });
  window.addEventListener("focus",  () => { vlogInfo("event.focus", null);  _kick(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { vlogInfo("event.visible", null); _kick(); }
  });

  setInterval(() => { _kick(); }, 30 * 1000);
  _kick();
}

export async function pendingCount() {
  const all = await idbAll();
  return all.filter(i => i.status === "queued" || i.status === "uploading" || i.status === "error").length;
}
