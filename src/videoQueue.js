/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Upload Queue (v2 rewrite)
   ───────────────────────────────────────────────────────────────────────────
   Hard-won lessons informing this rewrite:

   1. The previous version had a localStorage trap: existing users had
      `mts-video-upload-mode` set to "wifi" from when that was the default.
      iOS Safari can't detect WiFi, so shouldUpload() returned false for
      every item forever. Uploads sat at "queued" indefinitely even with
      the screen on. → Fix: there is NO MODE. We always try to upload as
      soon as we can. If the user is truly worried about cell data, they
      can pause uploads with a single global toggle.

   2. The previous version used ffmpeg.wasm for compression. Loading 30MB
      of WASM from a CDN was unreliable on cellular and added a phase that
      could silently fail and stall everything. → Fix: no compression.
      Upload original file directly. Modern phones already produce reasonable
      sizes through iOS's built-in HEVC and the file picker recompresses
      4K to a friendlier format.

   3. The previous version's worker loop used `_processing` as a singleton
      lock. If _processOne threw an exception unexpectedly without going
      through the try/finally cleanup, the lock could stay set forever.
      → Fix: every code path that sets _processing=true also unsets it
      with a finally; additionally, a watchdog timer resets the lock if
      it's been stuck for >10 minutes.

   4. The previous version dispatched "mts-field-synced" on completion,
      which created a feedback loop with OnsiteWindow's auto-save effect.
      → Fix: completion event uses a more specific name and OnsiteWindow's
      handler does proper equality checks before setState.

   5. Diagnostic logging now persists to IDB via videoLog.js so we can
      tell after the fact what went wrong.
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, saveField, primeField } from "./fieldStore";
import { saveFieldToDrive } from "./driveSync";
import { incUpload, decUpload } from "./uploadStatus";
import { vlogInfo, vlogWarn, vlogError } from "./videoLog";

// ── Tunables ─────────────────────────────────────────────────────────────

// 5 MB is the smallest chunk YouTube accepts beyond the minimum (256KB
// alignment is required for non-final chunks). Using 5MB gives reasonable
// resume granularity without too much per-chunk overhead.
const CHUNK_SIZE = 5 * 1024 * 1024;

// Per-chunk retry budget. After N failures on the same chunk, mark item
// as error and stop trying (until user explicitly retries).
const CHUNK_RETRY_LIMIT = 5;

// If the worker lock has been held for longer than this, assume we're
// wedged and forcibly release it. This is a safety net, not a feature.
const WORKER_LOCK_WATCHDOG_MS = 10 * 60 * 1000;

// Backoff schedule for chunk retries. Indices correspond to attempt count.
// First retry: 1.5s. Last retry: 30s. Total budget if all retries used: ~70s.
const RETRY_BACKOFF_MS = [1500, 3000, 6000, 12000, 30000];

// Pause flag — separate from per-item state. When true, no new chunks fire.
const PAUSE_KEY = "mts-video-uploads-paused";

// ── IndexedDB ────────────────────────────────────────────────────────────

const DB_NAME = "mts-video-queue";
// DB_VER bumped because we changed the schema (compressedFile etc removed)
const DB_VER = 2;
const STORE = "queue";

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // For v1→v2: just keep the same store. The shape change is additive
      // (we ignore old fields like compressedFile). Don't delete existing
      // queue items — the user has data in there.
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

// ── Public API: queue inspection ─────────────────────────────────────────

export async function listAll() { return await idbAll(); }
export async function listForStop(stopId) {
  const all = await idbAll();
  return all.filter(i => i.stopId === stopId);
}

// ── Public API: enqueue and lifecycle ────────────────────────────────────

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
    status: "queued",
    progress: 0,
    bytesUploaded: 0,
    uploadUrl: null,
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

    let session = item.uploadUrl;
    if (!session) {
      vlogInfo("yt.init.start", { fileSize: item.fileSize }, id);
      session = await _initYouTubeSession(token, item.title, item.fileSize, item.fileType);
      if (!session) {
        await _setItem(id, { status: "error", error: "Could not start YouTube upload session. Check Google sign-in and YouTube API quota." });
        return true;
      }
      vlogInfo("yt.init.ok", { sessionPrefix: session.slice(0, 80) }, id);
      await _setItem(id, { uploadUrl: session, bytesUploaded: 0 });
    } else {
      vlogInfo("yt.resume.query", { lastKnown: item.bytesUploaded }, id);
      const offset = await _queryUploadOffset(session, item.fileSize);
      if (offset === null) {
        vlogWarn("yt.resume.session_expired", null, id);
        await _setItem(id, { uploadUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }
      if (offset === "complete") {
        vlogWarn("yt.resume.already_complete", null, id);
        await _setItem(id, {
          status: "error",
          error: "Upload was already complete on YouTube but we lost the video ID. Check YouTube; the video is there.",
        });
        return true;
      }
      vlogInfo("yt.resume.offset", { offset }, id);
      await _setItem(id, { bytesUploaded: offset });
    }

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

      const result = await _uploadChunk(session, chunk, bytesUploaded, end - 1, item.fileSize);
      const ms = Date.now() - t0;

      if (result.kind === "ok-final") {
        vlogInfo("chunk.final_ok", { ms, videoId: result.videoId }, id);
        await _finalize(id, result.videoId, token);
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
        await _setItem(id, { uploadUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }

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

      const offset = await _queryUploadOffset(session, item.fileSize);
      if (offset === null) {
        await _setItem(id, { uploadUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }
      if (offset === "complete") {
        await _setItem(id, { status: "error", error: "Server has the full upload but the video ID was lost. Check YouTube." });
        return true;
      }
      bytesUploaded = offset;
      await _setItem(id, { bytesUploaded });
    }
    vlogError("loop.exhausted_without_final", { bytesUploaded, fileSize: item.fileSize }, id);
    await _setItem(id, { status: "error", error: "Upload completed bytes but never received final acknowledgment from YouTube" });
    return true;
  } catch (e) {
    vlogError("process.exception", { msg: e?.message || String(e), stack: (e?.stack || "").slice(0, 500) }, id);
    await _setItem(id, { status: "error", error: e.message || String(e) }).catch(() => {});
    return true;
  } finally {
    decUpload(item.stopId);
  }
}

async function _finalize(id, videoId, token) {
  const item = await idbGet(id);
  if (!item) return;
  const ytUrl = `https://youtu.be/${videoId}`;
  vlogInfo("finalize.start", { videoId, ytUrl }, id);
  try {
    const saved = await loadField(item.stopId).catch(() => ({}));
    const existing = saved?.videoUrls || (saved?.videoUrl ? [saved.videoUrl] : []);
    if (!existing.includes(ytUrl)) {
      const next = { ...(saved || {}), videoUrls: [...existing, ytUrl], savedAt: Date.now() };
      primeField(item.stopId, next);
      await saveField(item.stopId, next).catch(() => {});
      saveFieldToDrive(token, item.stopId, next).catch(() => {});
      try { window.dispatchEvent(new CustomEvent("mts-video-uploaded", { detail: { stopId: item.stopId, ytUrl } })); } catch {}
    }
  } catch (e) {
    vlogWarn("finalize.field_write_failed", { msg: e?.message }, id);
  }
  await idbDelete(id);
  vlogInfo("finalize.ok", { videoId }, id);
  notify();
}

// ── YouTube resumable upload protocol ───────────────────────────────────

async function _initYouTubeSession(token, title, size, mimeType) {
  const metadata = {
    snippet: { title, description: "Uploaded via MTS Field CRM" },
    status: { privacyStatus: "unlisted" },
  };
  let res;
  try {
    res = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          "X-Upload-Content-Type": mimeType || "video/mp4",
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify(metadata),
      }
    );
  } catch (e) {
    vlogError("yt.init.network_error", { msg: e?.message || String(e) });
    return null;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    vlogError("yt.init.http_error", {
      status: res.status,
      reason: parsed?.error?.errors?.[0]?.reason,
      message: parsed?.error?.message,
      raw: txt.slice(0, 300),
    });
    return null;
  }
  const loc = res.headers.get("Location");
  if (!loc) {
    vlogError("yt.init.no_location_header", null);
    return null;
  }
  return loc;
}

async function _uploadChunk(uploadUrl, chunkBlob, startByte, endByte, totalSize) {
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${startByte}-${endByte}/${totalSize}`,
      },
      body: chunkBlob,
    });
  } catch (e) {
    return { kind: "error", error: `Network: ${e?.message || String(e)}` };
  }
  if (res.status === 200 || res.status === 201) {
    let body;
    try { body = await res.json(); } catch (e) {
      return { kind: "error", error: "Final response not JSON" };
    }
    if (body?.id) return { kind: "ok-final", videoId: body.id };
    return { kind: "error", error: "Final response missing video id" };
  }
  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (!range) {
      return { kind: "ok-progress", nextOffset: 0 };
    }
    const m = range.match(/bytes=0-(\d+)/);
    return { kind: "ok-progress", nextOffset: m ? parseInt(m[1], 10) + 1 : endByte + 1 };
  }
  if (res.status === 404 || res.status === 410) {
    return { kind: "session-expired" };
  }
  const txt = await res.text().catch(() => "");
  return { kind: "error", error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
}

async function _queryUploadOffset(uploadUrl, totalSize) {
  let res;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  } catch (e) {
    vlogWarn("yt.query.network_error", { msg: e?.message });
    return null;
  }
  if (res.status === 200 || res.status === 201) return "complete";
  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (!range) return 0;
    const m = range.match(/bytes=0-(\d+)/);
    return m ? parseInt(m[1], 10) + 1 : 0;
  }
  if (res.status === 404 || res.status === 410) return null;
  vlogWarn("yt.query.unexpected_status", { status: res.status });
  return null;
}

// ── Watcher: install once, keep the queue ticking ───────────────────────

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

  // Periodic safety net every 30s
  setInterval(() => { _kick(); }, 30 * 1000);

  _kick();
}

export async function pendingCount() {
  const all = await idbAll();
  return all.filter(i => i.status === "queued" || i.status === "uploading" || i.status === "error").length;
}
