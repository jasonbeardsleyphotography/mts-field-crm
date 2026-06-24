/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Upload Queue (v4 — single streaming PUT)
   ───────────────────────────────────────────────────────────────────────────
   Uploads videos to Google Drive via the resumable upload API, stripped down
   to the simplest shape that survives life as an iOS PWA:

   1. One streaming PUT sends the whole remainder of the file (current offset
      → EOF). No chunking, no per-chunk round-trips, no adaptive sizing —
      the chunk machinery existed to bound a fixed timeout, and a progress-
      based stall watchdog (in driveUpload.js) does that job with zero
      protocol overhead. This is Drive's documented best practice.
   2. When anything interrupts the PUT (cellular drop, iOS suspending the
      app, stall), we query Drive for the bytes it actually received and
      resume from there. Drive keeps partial bytes from a dead request, so
      nothing already sent is ever re-sent.
   3. Retry/Force-Restart resumes from the server offset, never restarts at 0.
   4. Real byte-level progress via XHR upload.onprogress.
   5. Saves canonical /preview URL to the card; file is anyone-with-link so
      URLs work in client emails.

   PWA survival invariants:
   - Persistent IDB queue survives tab restarts (file blob included)
   - While backgrounded we wait instead of burning retries — iOS suspends
     network and JS, which is not a real failure
   - Wake lock keeps the screen on during active uploads
   - Watchdogs release stuck worker locks after iOS context switches
   - Pause/resume single global toggle; diagnostic log to videoLog.js
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, saveField, primeField, updateField, listFieldIds } from "./fieldStore";
import { incUpload, decUpload } from "./uploadStatus";
import { vlogInfo, vlogWarn, vlogError } from "./videoLog";
import {
  initDriveSession,
  uploadFromOffset,
  queryUploadOffset,
  makeDriveFilePublic,
  getVideosFolderId,
  buildShareUrl,
  getDriveFileMeta,
  renameDriveFile,
  sniffDriveFileFormat,
  fixDriveFileContentType,
} from "./driveUpload";
import { queueFieldDriveSync } from "./driveSync";

// ── Tunables ─────────────────────────────────────────────────────────────

const KB = 1024;
const RETRY_LIMIT = 6;                // consecutive failures with NO byte progress before giving up
const WORKER_LOCK_WATCHDOG_MS = 2 * 60 * 1000; // 2 min — iOS suspends JS mid-upload
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
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

// ── Wake Lock ─────────────────────────────────────────────────────────────
// Keeps the screen on while uploading so iOS doesn't suspend JS mid-chunk.
// Supported on iOS 16.4+ and modern Android Chrome. Silently no-ops on older
// browsers — the chunk-size reduction covers those cases instead.

let _wakeLock = null;
async function _acquireWakeLock() {
  if (!("wakeLock" in navigator) || _wakeLock) return;
  try {
    _wakeLock = await navigator.wakeLock.request("screen");
    _wakeLock.addEventListener("release", () => { _wakeLock = null; });
  } catch {}
}
function _releaseWakeLock() {
  try { _wakeLock?.release(); } catch {}
  _wakeLock = null;
}

// iOS suspends network requests when the app is backgrounded mid-chunk,
// which surfaces as a "Chunk timeout" — not a real network failure. Waiting
// here (instead of burning a retry) keeps large uploads from hitting the
// retry limit just because the screen locked or the user switched apps.
function _waitForVisible() {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onChange);
      clearInterval(poll);
      clearTimeout(giveUp);
      resolve();
    };
    const onChange = () => { if (document.visibilityState === "visible") finish(); };
    document.addEventListener("visibilitychange", onChange);
    // visibilitychange doesn't always fire reliably in iOS standalone PWAs —
    // poll as a backstop so we don't depend on it alone.
    const poll = setInterval(() => { if (document.visibilityState === "visible") finish(); }, 2000);
    // Safety valve — if visibilityState is ever stuck misreporting "hidden"
    // while the app is actually frontmost, don't let an upload hang forever.
    const giveUp = setTimeout(finish, 20_000);
  });
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

// Drive identifies a file's type largely by its name's extension. The title
// built in OnsiteWindow.jsx (e.g. "Mack #30428 06/23/2026 - 01") has none,
// so without this the file lands in Drive as generic "binary" — no preview,
// no recognizable extension on download either.
function extFromFile(file) {
  const m = (file.name || "").match(/\.([a-zA-Z0-9]+)$/);
  if (m) return m[1].toLowerCase();
  const t = file.type || "";
  if (t.includes("webm")) return "webm";
  if (t.includes("quicktime")) return "mov";
  return "mp4";
}

export async function enqueueVideo({ stopId, file, title }) {
  if (!file || !file.size) {
    vlogError("enqueue.bad_file", { hasFile: !!file, size: file?.size });
    throw new Error("No file or empty file");
  }
  const id = `vq_${stopId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const safeTitle = /\.[a-zA-Z0-9]+$/.test(title || "") ? title : `${title}.${extFromFile(file)}`;
  const item = {
    id,
    stopId,
    title: safeTitle,
    file,
    fileSize: file.size,
    fileName: file.name || "video.mov",
    fileType: (file.type || "video/mp4").split(";")[0],
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
  vlogInfo("enqueue.ok", { id, stopId, title: safeTitle, fileSize: file.size, fileType: item.fileType }, id);
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
  // Force-release a stuck lock before retrying — iOS can suspend JS mid-upload
  // leaving _processing true with no active worker.
  if (_processing && _processingStartMs && Date.now() - _processingStartMs > 30_000) {
    vlogWarn("worker.retry_unstick", { heldForMs: Date.now() - _processingStartMs });
    _processing = false;
  }
  const item = await idbGet(id);
  if (!item) return;
  // Preserve sessionUrl + bytesUploaded so we RESUME from where we stopped
  // instead of re-uploading the whole file (a near-complete 400MB upload
  // should never restart from 0). _processItem queries the true server offset
  // when a session exists; if the session is actually dead it transparently
  // starts a fresh one. Only the error/retry counters are reset.
  item.status = "queued";
  item.retries = 0;
  item.error = null;
  item.updatedAt = Date.now();
  await idbPut(item);
  vlogInfo("retry.requested", { resumeFrom: item.bytesUploaded || 0, hasSession: !!item.sessionUrl }, id);
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
  await _acquireWakeLock();
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
    _releaseWakeLock();
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
    await _setItem(id, { status: "uploading", statusSetAt: Date.now() });

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

    // Phase 2: stream the remainder of the file in one PUT. On any failure,
    // re-query the server offset and resume — bytes Drive already received
    // are never re-sent, so a retry only re-covers what was in flight.
    const refresh = await idbGet(id);
    if (!refresh) return false;
    let bytesUploaded = refresh.bytesUploaded || 0;
    let attempts = 0;   // consecutive tries with zero byte progress

    // Throttle progress writes to IDB so the onprogress stream doesn't hammer
    // IndexedDB. ~1.5s cadence is smooth enough for the bar. The persisted
    // value is display-only — resume always re-queries the true server offset.
    let lastProgressWrite = 0;
    const onUploadProgress = (absBytes) => {
      const now = Date.now();
      if (now - lastProgressWrite < 1500) return;
      lastProgressWrite = now;
      const pct = Math.min(99, Math.floor((absBytes / item.fileSize) * 100));
      _setItem(id, { progress: pct, bytesUploaded: absBytes }).catch(() => {});
    };

    while (bytesUploaded < item.fileSize) {
      if (_isPaused) {
        vlogInfo("upload.paused", null, id);
        return false;
      }
      const probe = await idbGet(id);
      if (!probe) { vlogInfo("upload.canceled_externally", null, id); return false; }

      // Don't start a request while backgrounded — iOS suspends it mid-flight
      // and it stalls out, burning a retry for no real reason.
      if (document.visibilityState === "hidden") {
        vlogInfo("upload.wait_visible", null, id);
        await _waitForVisible();
        continue;
      }

      const t0 = Date.now();
      vlogInfo("upload.start", { fromOffset: bytesUploaded, remainingKB: Math.round((item.fileSize - bytesUploaded) / KB), attempt: attempts + 1 }, id);

      const result = await uploadFromOffset(session, item.file.slice(bytesUploaded), bytesUploaded, item.fileSize, {
        onProgress: onUploadProgress,
      });
      const ms = Math.max(1, Date.now() - t0);

      if (result.kind === "ok-final") {
        vlogInfo("upload.final_ok", { ms, fileId: result.fileId }, id);
        await _finalize(id, result.fileId, token);
        return true;
      }
      if (result.kind === "ok-progress") {
        // 308 on a to-EOF PUT is unusual but valid — resume from where Drive says.
        if (result.nextOffset > bytesUploaded) attempts = 0;
        bytesUploaded = result.nextOffset;
        const pct = Math.min(99, Math.floor((bytesUploaded / item.fileSize) * 100));
        await _setItem(id, { progress: pct, bytesUploaded, retries: 0 });
        vlogInfo("upload.308_resume", { ms, nextOffset: bytesUploaded }, id);
        continue;
      }
      if (result.kind === "session-expired") {
        vlogWarn("upload.session_expired", { ms }, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }

      // Error path — if we went to background mid-request, the stall was
      // almost certainly iOS suspending the connection, not a real network
      // failure. Don't spend a retry on it; just wait it out.
      if (document.visibilityState === "hidden") {
        vlogInfo("upload.fail_while_hidden", { ms, error: result.error }, id);
        await _waitForVisible();
      }

      // Ask Drive how much it actually received — usually most of what was
      // in flight landed, so the "retry" just continues from further along.
      const offset = await queryUploadOffset(session, item.fileSize);
      if (offset === null) {
        vlogWarn("upload.session_dead_after_error", { error: result.error }, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0 });
        return await _processItem(id);
      }
      if (offset === "complete") {
        await _setItem(id, { status: "error", error: "Upload completed but file ID was lost. Check Drive videos folder." });
        return true;
      }
      if (offset > bytesUploaded) {
        // Bytes landed despite the error — that's progress, not a failure.
        bytesUploaded = offset;
        attempts = 0;
      } else {
        attempts++;
      }
      vlogWarn("upload.fail", { ms, attempt: attempts, error: result.error, resumeFrom: bytesUploaded }, id);
      if (attempts >= RETRY_LIMIT) {
        await _setItem(id, {
          status: "error",
          error: `Upload stalled after ${attempts} retries: ${result.error}`,
        });
        return true;
      }
      await _setItem(id, { bytesUploaded, retries: attempts });
      if (attempts > 0) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
        vlogInfo("upload.backoff", { ms: backoff }, id);
        await new Promise(r => setTimeout(r, backoff));
      }
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

  // Make the file readable by anyone with the link, so client emails work.
  // Re-fetch a fresh token each attempt — large uploads can outlast the
  // ~55min access-token lifetime, and a stale token here used to fail
  // silently, leaving the file uploaded but permanently private.
  let publicOk = false;
  for (let attempt = 0; attempt < 3 && !publicOk; attempt++) {
    const freshToken = _getToken?.() || token;
    publicOk = await makeDriveFilePublic(freshToken, fileId);
    if (!publicOk && attempt < 2) await new Promise(r => setTimeout(r, 1500));
  }
  if (!publicOk) {
    vlogWarn("finalize.permission_failed", { fileId }, id);
    // Continue anyway — the file uploaded; the Storage panel's "Fix video
    // playback links" repair can catch and fix this later.
  }

  const shareUrl = buildShareUrl(fileId);

  // Save the link to the card's field data via the shared write queue so
  // this doesn't race with concurrent photo operations on the same stop.
  try {
    await updateField(item.stopId, (existing) => {
      const urls = existing.videoUrls || (existing.videoUrl ? [existing.videoUrl] : []);
      if (urls.includes(shareUrl)) return {};
      return { videoUrls: [...urls, shareUrl] };
    });
    // Push the field JSON to Drive so the video link reaches the other device.
    // Previously this only reached Drive via App's blanket re-upload loop.
    queueFieldDriveSync(token, item.stopId);
    try { window.dispatchEvent(new CustomEvent("mts-video-uploaded", { detail: { stopId: item.stopId, shareUrl, fileId } })); } catch {}
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
    if (document.visibilityState === "visible") {
      // In-memory unstick: _processingStartMs freezes while iOS suspends JS,
      // so it can undercount elapsed time. Unstick if it looks long enough.
      if (_processing && _processingStartMs && Date.now() - _processingStartMs > 90_000) {
        vlogWarn("worker.foreground_unstick", { heldForMs: Date.now() - _processingStartMs });
        _processing = false;
      }
      vlogInfo("event.visible", null);
      if (_processing) _acquireWakeLock();
      _kick();

      // Wall-clock IDB unstick: _processingStartMs is an in-memory clock that
      // iOS freezes when the app is backgrounded (e.g. during a phone call).
      // Compare statusSetAt written to IDB (real wall time) to catch uploads
      // that have been stalled across a context switch. Resets them to "queued"
      // so _kick() restarts within seconds instead of waiting 2 minutes.
      idbAll().then(all => {
        const stale = all.filter(
          i => i.status === "uploading" && Date.now() - (i.statusSetAt || 0) > 90_000
        );
        if (!stale.length) return;
        vlogWarn("worker.idb_wall_unstick", { count: stale.length });
        Promise.all(stale.map(i => idbPut({ ...i, status: "queued", statusSetAt: Date.now() })))
          .then(() => { _processing = false; notify(); _kick(); })
          .catch(() => {});
      }).catch(() => {});
    } else {
      _releaseWakeLock();
    }
  });

  setInterval(() => { _kick(); }, 30 * 1000);
  _kick();
}

export async function pendingCount() {
  const all = await idbAll();
  return all.filter(i => i.status === "queued" || i.status === "uploading" || i.status === "error").length;
}

const EXT_TO_MIME = { webm: "video/webm", mp4: "video/mp4" };
const MIME_TO_EXT = { "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mp4" };

// ── Repair ───────────────────────────────────────────────────────────────
// Re-applies "anyone with the link" sharing to every already-uploaded video,
// for links that went private because the OAuth token expired mid-upload
// before finalize could set permissions (see _finalize above). Also fixes
// filenames AND Drive's stored mimeType missing/wrong — Drive's UI uses the
// mimeType field (not just the extension) to decide whether to render a
// video player, so a rename alone isn't enough. The correct format is
// sniffed from the file's actual bytes (see sniffDriveFileFormat) rather
// than trusted from Drive's stored mimeType field, since old uploads sent a
// malformed Content-Type that Drive sometimes mis-recorded (a WebM file
// stored with mimeType "video/mp4") — trusting that field renamed files to
// the WRONG extension. If the byte sniff itself fails (e.g. a transient
// network hiccup), fall back to a clean, recognized stored mimeType rather
// than silently skipping the file. After renaming, the meta is re-fetched
// so we can report whether the PATCH actually took effect — previous runs
// had no way to tell a no-op PATCH from a real one.
// All repairs are metadata-only (sharing permission / name / mimeType) —
// never touches videoUrls or any file's actual content, so existing videos
// and links are untouched either way.
export async function repairVideoSharing(token) {
  const ids = await listFieldIds();
  let checked = 0, shared = 0, failed = 0, renamed = 0, reuploaded = 0, verified = 0;
  const details = [];
  for (const stopId of ids) {
    let data;
    try { data = await loadField(stopId); } catch { continue; }
    const urls = data?.videoUrls || (data?.videoUrl ? [data.videoUrl] : []);
    for (const url of urls) {
      const m = url.match(/\/(?:file\/d|watch)\/([a-zA-Z0-9_-]+)/);
      if (!m) continue;
      const fileId = m[1];
      checked++;
      const detail = { fileId };

      const shareOk = await makeDriveFilePublic(token, fileId);
      detail.shared = shareOk;
      if (shareOk) shared++; else failed++;

      const meta = await getDriveFileMeta(token, fileId);
      detail.before = meta ? { name: meta.name, mimeType: meta.mimeType } : null;
      detail.hasThumbnail = meta?.hasThumbnail ?? null;
      detail.hasVideoMeta = !!meta?.videoMediaMetadata;

      const sniffed = await sniffDriveFileFormat(token, fileId);
      const realExt = sniffed || MIME_TO_EXT[meta?.mimeType] || null;
      detail.sniffed = sniffed;

      if (meta && realExt) {
        const correctMime = EXT_TO_MIME[realExt];
        const baseName = (meta.name || "").replace(/\.[a-zA-Z0-9]+$/, "");
        const correctName = `${baseName}.${realExt}`;
        const needsRename = meta.name !== correctName;
        // A plain metadata PATCH cannot change mimeType on a binary file —
        // Drive silently ignores it (confirmed: before/after both stayed
        // "application/octet-stream"). Fixing it for real requires
        // re-uploading the file's own bytes with the right Content-Type.
        const needsContentTypeFix = meta.mimeType !== correctMime;

        if (needsRename) {
          const renameOk = await renameDriveFile(token, fileId, correctName);
          if (renameOk) renamed++;
        }
        if (needsContentTypeFix) {
          const fixOk = await fixDriveFileContentType(token, fileId, correctMime);
          detail.contentTypeFixed = fixOk;
          if (fixOk) reuploaded++;
        }
        if (needsRename || needsContentTypeFix) {
          const after = await getDriveFileMeta(token, fileId);
          detail.after = after ? { name: after.name, mimeType: after.mimeType } : null;
          if (after?.name === correctName && after?.mimeType === correctMime) verified++;
        }
      }
      details.push(detail);
    }
  }
  return { checked, shared, fixed: shared, failed, renamed, reuploaded, verified, details };
}
