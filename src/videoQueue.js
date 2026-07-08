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
import { queueFieldDriveSync, triggerAuthError } from "./driveSync";
import { createWakeLockHandle } from "./wakeLock";

// ── Tunables ─────────────────────────────────────────────────────────────

const KB = 1024;
const RETRY_LIMIT = 6;                // consecutive failures with NO byte progress before giving up
const WORKER_LOCK_WATCHDOG_MS = 2 * 60 * 1000; // 2 min — iOS suspends JS mid-upload
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const PAUSE_KEY = "mts-video-uploads-paused";
// Below this size we read the upload body fully into RAM before handing it to
// XHR (the iOS blob-stall fix — see _readSliceToBuffer). Above it we stream the
// blob directly to avoid holding a huge buffer in memory. Field videos are far
// under this; the cap only guards a hypothetical very large file.
const MATERIALIZE_CAP_BYTES = 200 * 1024 * 1024;
const SLICE_READ_TIMEOUT_MS = 25_000; // reading 200MB from IDB should take << this; longer means wedged

// ── IndexedDB ────────────────────────────────────────────────────────────

const DB_NAME = "mts-video-queue";
// DB_VER bumped to 3 because schema fields changed (was uploadUrl→sessionUrl,
// videoId→fileId, etc.). Old items get migrated by reading and re-saving with
// the new shape, keeping their file blob.
const DB_VER = 3;
const STORE = "queue";

// THE iOS PWA KILLER, and the root cause of "uploads never restart after I
// switch apps": iOS closes a page's IndexedDB connections when the app is
// backgrounded — most reliably right after a large write (like a freshly
// recorded video blob) creates memory pressure. A cached connection then
// makes db.transaction() throw InvalidStateError on EVERY call, forever.
// The worker dies, the 30s recovery tick dies the same way each time, and
// Retry/Force Restart die on their first read — all silently. Nothing can
// recover until a full app relaunch. So: listen for the connection's close
// event to drop the cache eagerly, and wrap every operation with one
// reopen-and-retry so even a close we never got an event for self-heals on
// the next call.
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
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { _dbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch {} _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function _idbOpOnce(mode, op) {
  return openDB().then(db => new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (e) {
      reject(e); // closed connection throws synchronously
      return;
    }
    const store = t.objectStore(STORE);
    let result;
    op(store, (r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

async function _idbOp(mode, op) {
  try {
    return await _idbOpOnce(mode, op);
  } catch (e) {
    // Any failure gets exactly one retry on a FRESH connection. This turns
    // "iOS closed the DB while we were backgrounded" from a permanent,
    // silent, app-wide death into a one-call hiccup.
    vlogWarn?.("idb.reopen_retry", { msg: e?.message || String(e) });
    _dbPromise = null;
    return await _idbOpOnce(mode, op);
  }
}

// Delete the entire video-queue database (including any stored file blobs).
// Used when a DIFFERENT Google account signs in on this device so pending
// videos can't carry over between accounts. Resolves even if already gone.
export async function deleteVideoQueueDB() {
  try { (await _dbPromise)?.close?.(); } catch {}
  _dbPromise = null;
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
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

const _wakeLockHandle = createWakeLockHandle();
const _acquireWakeLock = () => _wakeLockHandle.acquire();
const _releaseWakeLock = () => _wakeLockHandle.release();

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

// "Cancel" = stop trying to upload, but KEEP the video. The blob stays in
// IDB with status "local" so the client card can always play it, save it to
// the phone, or upload it later. Previously this deleted the item outright —
// X-ing a stuck upload silently destroyed the only copy of the video.
export async function cancelItem(id) {
  vlogInfo("cancel_keep_local", null, id);
  // Unconditionally invalidate — the _currentItemId match had timing gaps
  // (cleared between loop iterations) that let a live worker keep going and
  // overwrite the "local" status we're about to write.
  _invalidateWorker("cancel_item");
  const item = await idbGet(id);
  if (!item) return;
  await idbPut({
    ...item,
    status: "local",
    error: null,
    sessionUrl: null,
    bytesUploaded: 0,
    progress: 0,
    retries: 0,
    updatedAt: Date.now(),
  });
  notify();
  _kick(); // free the worker for the next queued item right away
}

// Permanently delete a video from this device. The only truly destructive
// path — every UI entry point confirms first.
export async function deleteItem(id) {
  vlogInfo("delete_permanent", null, id);
  _invalidateWorker("delete_item");
  await idbDelete(id);
  notify();
  _kick();
}

// Retrieve a queued video's raw file so the UI can let the user save it to
// their device — even if it never uploads. The blob lives in IDB from the
// moment of recording, so this works regardless of upload status. Returns a
// File (named for a clean Save) or null if the blob is missing.
export async function getVideoFile(id) {
  const item = await idbGet(id);
  if (!item || !item.file) return null;
  return fileFromQueueItem(item);
}

// Build a nicely-named File from a queue item's stored blob. Sanitizes the
// title (it contains "/" from dates, illegal in filenames) and ensures a
// video extension so iOS/Drive recognize it.
export function fileFromQueueItem(item) {
  if (!item || !item.file) return null;
  const type = item.fileType || item.file.type || "video/mp4";
  let name = (item.title || item.fileName || "video").replace(/[\/\\:*?"<>|]+/g, "-");
  if (!/\.[a-z0-9]+$/i.test(name)) {
    name += type.includes("webm") ? ".webm" : type.includes("quicktime") ? ".mov" : ".mp4";
  }
  try {
    if (item.file instanceof File && item.file.name === name) return item.file;
    return new File([item.file], name, { type });
  } catch {
    return item.file; // Blob fallback (still saveable)
  }
}

export async function retryItem(id) {
  const item = await idbGet(id);
  if (!item) return;
  // GUARD: if the worker is actively on this item RIGHT NOW (progress and
  // status writes refresh updatedAt every ~1.5s while healthy), a re-tap of
  // Upload/Retry must NOT invalidate the worker — that aborted the very
  // upload the previous tap had just started. Rapid taps then perpetually
  // killed their own work: the item bounced between "Waiting" and 0% and
  // never got anywhere ("I tap the upload button and it does not work").
  // A genuinely stuck item has a stale updatedAt and takes the full path.
  const freshMs = Date.now() - (item.updatedAt || 0);
  if ((item.status === "uploading" || item.status === "queued") && freshMs < 10_000) {
    vlogInfo("retry.noop_already_active", { status: item.status, freshMs }, id);
    if (_isPaused) setPaused(false);
    _kick(); // make sure a worker is running; nothing else to change
    return;
  }
  // A manual retry means "the current state is wrong — start over cleanly".
  // Unconditionally invalidate any worker (live or zombie) and abort its
  // in-flight request. The old 30-second-held-lock heuristic left a stuck
  // XHR streaming while a second worker started on the same item — two
  // writers, two PUTs to one Drive session, wedged forever. If a HEALTHY
  // upload of another item gets aborted by this, nothing is lost: Drive
  // keeps received bytes and the new worker resumes it from the server
  // offset ("uploading" items are picked first).
  _invalidateWorker("retry_item");
  // Retry is explicit intent to upload — a forgotten persisted "Pause All"
  // must not silently swallow it (paused _kick() is a no-op).
  if (_isPaused) setPaused(false);
  // Preserve sessionUrl + bytesUploaded so we RESUME from where we stopped
  // instead of re-uploading the whole file (a near-complete 400MB upload
  // should never restart from 0). _processItem queries the true server offset
  // when a session exists; if the session is actually dead it transparently
  // starts a fresh one. Only the error/retry counters are reset.
  item.status = "queued";
  item.retries = 0;
  item.error = null;
  item.probeFails = 0; // a manual retry gets a clean slate on storage-read strikes
  item.updatedAt = Date.now();
  await idbPut(item);
  vlogInfo("retry.requested", { resumeFrom: item.bytesUploaded || 0, hasSession: !!item.sessionUrl, fromStatus: item.status }, id);
  notify();
  _kick();
  // Backstop: if a dying worker happened to hold the lock at the moment we
  // kicked, the 30s tick would eventually cover it — but the user is
  // watching the screen right now. One delayed kick closes that gap.
  setTimeout(() => { try { _kick(); } catch {} }, 2500);
}

// ── Worker ───────────────────────────────────────────────────────────────

let _processing = false;   // false | run-sequence number of the worker holding the lock
let _processingStartMs = 0;
let _getToken = null;
let _watcherInstalled = false;

// Epoch/abort machinery. The old design's fatal flaw: every "unstick" path
// (Force Restart, watchdogs, foreground unstick) just flipped _processing to
// false and kicked a NEW worker — but the OLD worker was still alive, its XHR
// still streaming. Result: two workers writing the same IDB item and two
// concurrent PUTs to the same Drive resumable session, which wedges the
// session server-side. That's why Force Restart often made things worse
// instead of better. Now:
//   - _epoch invalidates zombie workers: they check it after every await and
//     exit without touching state if a newer epoch exists.
//   - _abortInFlight() actually kills the in-flight XHR so the zombie exits
//     within milliseconds instead of streaming until its stall timeout.
//   - _processing holds the owning worker's run number, so a zombie's
//     `finally` can't clobber the lock a newer worker holds.
let _epoch = 0;
let _runSeq = 0;
let _abortCurrentUpload = null; // set while an XHR is in flight
let _currentItemId = null;      // item the live worker is processing right now

function _abortInFlight() {
  const abort = _abortCurrentUpload;
  _abortCurrentUpload = null;
  if (abort) { try { abort(); } catch {} }
}

// Invalidate any live/zombie worker and kill its network request. Every
// unstick path funnels through here so recovery is deterministic: exactly
// one worker survives.
function _invalidateWorker(why) {
  vlogWarn("worker.invalidate", { why, wasProcessing: !!_processing });
  _epoch++;
  _abortInFlight();
  _processing = false;
  _processingStartMs = 0;
}

export function forceUnstick() {
  _invalidateWorker("force_unstick");
  // An explicit unstick is an explicit "make uploads run". If the global
  // pause toggle was left on (persisted in localStorage across sessions!),
  // _kick() was a permanent no-op and NOTHING — Retry, Force Restart, the
  // 30s interval — could ever start an upload. Clear it.
  if (_isPaused) setPaused(false);
  _kick();
}

export function _kick() {
  if (_processing && _processingStartMs && Date.now() - _processingStartMs > WORKER_LOCK_WATCHDOG_MS) {
    _invalidateWorker("watchdog_release");
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
  const myRun = ++_runSeq;
  const myEpoch = _epoch;
  _processing = myRun;
  _processingStartMs = Date.now();
  await _acquireWakeLock();
  try {
    while (true) {
      if (_isPaused || myEpoch !== _epoch) break;
      const all = await idbAll();
      // An item already mid-upload always wins — abandoning it would waste
      // bytes Drive has already received. Otherwise prefer the smallest
      // queued item, so a short visible window is more likely to see at
      // least one item finish instead of the largest file monopolizing it.
      const next =
        all.find(i => i.status === "uploading") ||
        all.filter(i => i.status === "queued").sort((a, b) => a.fileSize - b.fileSize)[0];
      if (!next) break;
      const ok = await _processItem(next.id, myEpoch);
      if (!ok) break;
    }
  } finally {
    // Only release the lock if we still own it — a zombie worker finishing
    // late must not clear the lock (or drop the wake lock) out from under
    // the worker that replaced it.
    if (_processing === myRun) {
      _processing = false;
      _processingStartMs = 0;
      _releaseWakeLock();
    }
  }
}

// Read a blob slice fully into memory, but never hang forever. THE iOS UPLOAD
// STALL: WebKit can hang indefinitely materializing an IndexedDB-backed Blob
// when it's handed straight to xhr.send() — the PUT then transmits ZERO bytes
// until the 45s stall watchdog aborts it, on an endless loop. (The diagnostic
// log showed exactly this: every attempt failed at ~45000ms with bytesUploaded
// stuck at 0 and the byte counter never moving.) Reading the bytes ourselves,
// with a timeout, both sidesteps that stall — XHR then sends from a plain RAM
// buffer, which never hangs — and turns a genuinely unreadable blob into a
// fast, catchable failure instead of a 45-second dead wait.
function _readSliceToBuffer(file, startByte, timeoutMs) {
  const slice = file.slice(startByte);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error(`slice read timeout (${Math.round(timeoutMs/1000)}s)`)), timeoutMs);
    slice.arrayBuffer()
      .then(buf => (buf && buf.byteLength > 0) ? finish(resolve, buf) : finish(reject, new Error("empty slice read")))
      .catch(e => finish(reject, e));
  });
}

async function _setItem(id, patch) {
  const cur = await idbGet(id);
  if (!cur) return null;
  // Never resurrect a video the user stopped (status "local"). Worker writes
  // race with cancelItem: a read-modify-write that started BEFORE the cancel
  // landed would put stale status "uploading" back, making the item
  // impossible to remove from the queue — every X-tap appeared to do nothing
  // because the worker immediately overwrote it. Only retryItem (which
  // writes via idbPut directly, an explicit user action) can take an item
  // out of "local".
  if (cur.status === "local") {
    vlogInfo("setitem.blocked_local", { attempted: patch.status || "(no status)" }, id);
    return null;
  }
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await idbPut(next);
  notify();
  return next;
}

// restarts counts fresh-session restarts within ONE processing pass. Before
// this cap existed, "session dead" (which a transient network failure could
// masquerade as) recursed with a reset retry counter — an infinite loop that
// kept the item at "uploading 0%" forever, never erroring, never finishing,
// and immune to Retry because the worker never actually stopped.
const SESSION_RESTART_LIMIT = 3;

async function _processItem(id, myEpoch = _epoch, restarts = 0) {
  // A zombie worker (superseded by Force Restart / a watchdog) must never
  // touch item state — the replacement worker owns it now.
  const stale = () => myEpoch !== _epoch;
  const item = await idbGet(id);
  if (!item || stale()) return false;
  _currentItemId = id;

  if (restarts >= SESSION_RESTART_LIMIT) {
    vlogError("process.restart_limit", { restarts }, id);
    await _setItem(id, {
      status: "error",
      error: "Drive kept dropping the upload session — tap Retry to start fresh",
      sessionUrl: null,
      bytesUploaded: 0,
      progress: 0,
    });
    return true;
  }
  let token = _getToken?.();
  if (!token) {
    // The stored token is missing or past expiry. Previously this silently
    // returned false — the item sat at "WAITING" forever with no error and
    // no reauth attempt, and Retry/Force Restart died the same silent death.
    // Now: ask the app for a silent reauth, give it a moment, and re-check.
    // If still no token, leave the item QUEUED (so the 30s tick keeps
    // retrying automatically once sign-in recovers) but write a visible
    // message so the user can see WHY nothing is moving.
    vlogWarn("process.no_token", null, id);
    try { triggerAuthError(); } catch {}
    await new Promise(r => setTimeout(r, 3000));
    token = _getToken?.();
    if (stale()) return false;
    if (!token) {
      await _setItem(id, { error: "Waiting for Google sign-in to refresh — uploads will resume automatically" });
      return false;
    }
  }

  if (!item.file || !item.file.size) {
    vlogError("process.missing_file", { hasFile: !!item.file }, id);
    await _setItem(id, { status: "error", error: "Video file lost (try re-uploading)" });
    return true;
  }

  // Actually READ a slice of the blob before starting. On iOS, a blob stored
  // in IndexedDB can have its backing data evicted while its metadata (size,
  // type) survives — item.file.size looks fine, but every read returns
  // nothing, so the XHR "uploads" 0 bytes and errors in an endless cycle
  // that never moves past 0%.
  //
  // CRITICAL: a single failed read is NOT proof of data loss. iOS also
  // invalidates blob handles TRANSIENTLY around backgrounding — a video
  // recorded minutes ago (and already partially uploaded!) can fail this
  // read for a few seconds right after returning from another app, then
  // read fine again. Declaring it "purged" on the first failure destroyed a
  // perfectly good upload in the field. So: retry within this pass, park as
  // queued on transient failure (auto-retried by the 30s tick), and only
  // call it permanently lost after many consecutive failed passes.
  let headOk = false;
  for (let i = 0; i < 3 && !headOk; i++) {
    try {
      const head = await item.file.slice(0, 64 * KB).arrayBuffer();
      headOk = !!head && head.byteLength > 0;
    } catch {}
    if (!headOk) await new Promise(r => setTimeout(r, 1500));
    if (stale()) return false;
  }
  if (!headOk) {
    const fails = (item.probeFails || 0) + 1;
    vlogWarn("process.file_read_failed", { consecutivePasses: fails }, id);
    if (fails >= 5) {
      // Never once readable across many passes. In practice this is a wedged
      // WebKit storage session, which a full reload clears — say that, don't
      // tell the user to re-record a video that's probably fine.
      vlogError("process.file_unreadable", null, id);
      await _setItem(id, {
        status: "error",
        error: "Phone storage is stuck — close this app completely and reopen it, then tap Force Restart. The video is still saved.",
      });
      return true;
    }
    await _setItem(id, {
      probeFails: fails,
      status: "queued",
      error: fails >= 2
        ? "Phone storage got stuck — reload the app (button above) to fix it. The video is safe."
        : "Phone storage is briefly unavailable — will retry automatically",
    });
    return false;
  }
  if (item.probeFails) await _setItem(id, { probeFails: 0, error: null });

  vlogInfo("process.start", { fileSize: item.fileSize, status: item.status, bytesUploaded: item.bytesUploaded }, id);
  incUpload(item.stopId);
  try {
    await _setItem(id, { status: "uploading", statusSetAt: Date.now(), error: null });

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
      let init = await initDriveSession(token, item.title, item.fileSize, item.fileType, folderId);
      if (!init.ok && (init.status === 401 || init.status === 403)) {
        // The access token expired while this item sat in the queue. Without
        // this, that produced a permanent "Could not start Drive upload"
        // error that Retry/Force Restart could never fix on their own — the
        // real problem (a stale token) was one silent reauth away, but
        // nothing ever asked for one. Trigger the app's existing silent-reauth
        // hook (same one Calendar/Drive 401s already use) and retry ONCE with
        // whatever token comes back before giving up.
        vlogWarn("drive.init.auth_retry", { status: init.status }, id);
        try { triggerAuthError(); } catch {}
        await new Promise(r => setTimeout(r, 2000));
        const freshToken = _getToken?.();
        if (freshToken) {
          init = await initDriveSession(freshToken, item.title, item.fileSize, item.fileType, folderId);
        }
      }
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
      if (stale()) return false;
      if (offset === "network") {
        // Couldn't reach Drive to ask — that says NOTHING about the session.
        // Keep the session and its uploaded bytes; leave the item queued and
        // let the 30s tick retry when connectivity returns. Previously this
        // was treated as session-death: bytes thrown away, restart from 0,
        // in a loop that never converged on a phone with constant
        // call/text/map interruptions.
        vlogWarn("drive.resume.network_fail", { lastKnown: item.bytesUploaded }, id);
        await _setItem(id, { status: "queued", error: "Connection dropped — will resume automatically" });
        return false;
      }
      if (offset === "dead") {
        vlogWarn("drive.resume.session_expired", null, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0, progress: 0 });
        return await _processItem(id, myEpoch, restarts + 1);
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
      // Keep the display bar honest — it previously kept showing the old
      // percentage after a reset (e.g. "WAITING" with an 85% bar).
      await _setItem(id, { bytesUploaded: offset, progress: Math.min(99, Math.floor((offset / item.fileSize) * 100)) });
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
      if (stale()) return; // zombie worker — the replacement owns progress now
      const now = Date.now();
      if (now - lastProgressWrite < 1500) return;
      lastProgressWrite = now;
      const pct = Math.min(99, Math.floor((absBytes / item.fileSize) * 100));
      _setItem(id, { progress: pct, bytesUploaded: absBytes }).catch(() => {});
    };

    while (bytesUploaded < item.fileSize) {
      if (stale()) { vlogInfo("upload.superseded", null, id); return false; }
      if (_isPaused) {
        vlogInfo("upload.paused", null, id);
        return false;
      }
      const probe = await idbGet(id);
      if (!probe) { vlogInfo("upload.canceled_externally", null, id); return false; }
      if (probe.status === "local") { vlogInfo("upload.stopped_kept_local", null, id); return false; }

      // Don't start a request while backgrounded — iOS suspends it mid-flight
      // and it stalls out, burning a retry for no real reason.
      if (document.visibilityState === "hidden") {
        vlogInfo("upload.wait_visible", null, id);
        await _waitForVisible();
        continue;
      }

      // Materialize the exact bytes we're about to PUT into a RAM buffer FIRST,
      // then send THAT — never the IDB-backed blob directly. This is the fix
      // for the zero-progress / 45s-abort loop the diagnostic log revealed:
      // iOS stalls streaming an IDB blob through XHR, but a RAM buffer sends
      // fine. Huge files (unrealistic for field video) stream the blob to avoid
      // holding a giant buffer.
      const remainingBytes = item.fileSize - bytesUploaded;
      let sendBody;
      if (remainingBytes <= MATERIALIZE_CAP_BYTES) {
        try {
          sendBody = await _readSliceToBuffer(item.file, bytesUploaded, SLICE_READ_TIMEOUT_MS);
        } catch (e) {
          if (stale()) return false;
          const fails = (item.sliceFails || 0) + 1;
          vlogWarn("upload.slice_read_failed", { msg: e?.message || String(e), remainingKB: Math.round(remainingBytes / KB), consecutive: fails }, id);
          if (fails >= 5) {
            await _setItem(id, {
              status: "error",
              error: "Phone storage is stuck — close this app completely and reopen it, then tap Force Restart. The video is still saved.",
              sliceFails: fails,
            });
            return true;
          }
          await _setItem(id, {
            status: "queued",
            sliceFails: fails,
            error: fails >= 2
              ? "Phone storage got stuck — reload the app (button above) to fix it. The video is safe."
              : "Reading the video from storage — will retry automatically",
          });
          // brief backoff so we don't spin on a momentarily-busy store
          await new Promise(r => setTimeout(r, 1500));
          return false;
        }
        if (stale()) return false;
        if (item.sliceFails) { await _setItem(id, { sliceFails: 0 }); item.sliceFails = 0; }
      } else {
        sendBody = item.file.slice(bytesUploaded);
      }

      const t0 = Date.now();
      vlogInfo("upload.start", { fromOffset: bytesUploaded, remainingKB: Math.round(remainingBytes / KB), attempt: attempts + 1, buffered: sendBody instanceof ArrayBuffer }, id);

      // Register the in-flight request so Force Restart / watchdogs can
      // actually terminate it instead of leaving it streaming as a zombie.
      let myAbort = null;
      const result = await uploadFromOffset(session, sendBody, bytesUploaded, item.fileSize, {
        onProgress: onUploadProgress,
        onAbortHandle: (fn) => { myAbort = fn; _abortCurrentUpload = fn; },
      });
      if (_abortCurrentUpload === myAbort) _abortCurrentUpload = null;
      const ms = Math.max(1, Date.now() - t0);
      // If we were superseded while the request was in flight (it was likely
      // aborted out from under us), exit WITHOUT touching state — the new
      // worker re-queries the server offset and continues cleanly.
      if (stale()) { vlogInfo("upload.superseded_midflight", { ms }, id); return false; }

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
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0, progress: 0 });
        return await _processItem(id, myEpoch, restarts + 1);
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
      if (stale()) return false;
      if (offset === "dead") {
        vlogWarn("upload.session_dead_after_error", { error: result.error }, id);
        await _setItem(id, { sessionUrl: null, bytesUploaded: 0, progress: 0 });
        return await _processItem(id, myEpoch, restarts + 1);
      }
      if (offset === "complete") {
        await _setItem(id, { status: "error", error: "Upload completed but file ID was lost. Check Drive videos folder." });
        return true;
      }
      if (offset === "network") {
        // Can't even reach Drive — the upload error was a connectivity blip,
        // not a session problem. The session and its bytes stay intact.
        if (navigator.onLine === false) {
          // Genuinely offline: don't burn retries toward a FAILED state the
          // user has to notice and tap. Park as queued; the "online" event
          // and the 30s tick resume it automatically.
          vlogInfo("upload.offline_park", null, id);
          await _setItem(id, { status: "queued", error: "Offline — will resume automatically" });
          return false;
        }
        attempts++;
      } else if (offset > bytesUploaded) {
        // Bytes landed despite the error — that's progress, not a failure.
        bytesUploaded = offset;
        attempts = 0;
      } else {
        attempts++;
      }
      vlogWarn("upload.fail", { ms, attempt: attempts, error: result.error, resumeFrom: bytesUploaded }, id);
      if (attempts >= RETRY_LIMIT) {
        // The session is still technically alive (Drive never returned a clean
        // 404/410 to trigger the fresh-session paths above) but isn't making
        // progress after repeated retries — e.g. wedged into a bad state after
        // an earlier aborted request. Clear it so the NEXT retry (manual or
        // automatic) starts a genuinely new Drive session instead of hammering
        // the same broken one forever, which previously made Retry/Force
        // Restart permanently ineffective on this class of failure.
        await _setItem(id, {
          status: "error",
          error: `Upload stalled after ${attempts} retries: ${result.error}`,
          sessionUrl: null,
          bytesUploaded: 0,
          progress: 0,
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
    // Only clear if we still own the slot — a zombie must not blank the id
    // the replacement worker is actively processing.
    if (!stale() && _currentItemId === id) _currentItemId = null;
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

// Wall-clock IDB unstick: an item can be left at status:"uploading" with a
// dead worker (crashed mid-request, iOS froze the tab mid-flight, etc.) and
// nothing else ever resets it. Previously this scan only ran inside the
// visibilitychange handler, so an app that stayed foregrounded the whole time
// (never backgrounded+refocused) had no automatic recovery path — the item
// just sat there until the user happened to background/foreground the tab.
// Runs here AND on the periodic tick below so it self-heals either way.
function _wallClockUnstick() {
  idbAll().then(all => {
    // Staleness must key off updatedAt, NOT statusSetAt: statusSetAt is
    // written once when the upload starts and never again, so a healthy
    // multi-minute upload looked "stale" 45s in and got requeued — which
    // aborted nothing, spawned a duplicate worker, and double-PUT the same
    // Drive session into a wedged state. updatedAt is refreshed every ~1.5s
    // by progress writes while bytes are actually moving, so 45s of silence
    // genuinely means dead.
    const stale = all.filter(
      i => i.status === "uploading" && Date.now() - (i.updatedAt || 0) > 45_000
    );
    if (!stale.length) return;
    Promise.all(stale.map(i => idbPut({ ...i, status: "queued", statusSetAt: Date.now() })))
      .then(() => { _invalidateWorker("idb_wall_unstick"); notify(); _kick(); })
      .catch(() => {});
  }).catch(() => {});
}

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
      if (_processing && _processingStartMs && Date.now() - _processingStartMs > 45_000) {
        _invalidateWorker("foreground_unstick");
      }
      vlogInfo("event.visible", null);
      if (_processing) _acquireWakeLock();
      _kick();
      _wallClockUnstick();
      // iOS can report "visible" while storage/network are still thawing —
      // the immediate kick may fire into a half-frozen environment and die.
      // Follow up shortly after so recovery never rides on that first shot.
      setTimeout(() => { _kick(); _wallClockUnstick(); }, 4000);
    } else {
      _releaseWakeLock();
    }
  });

  // Also run the wall-clock unstick scan on the periodic tick, not just on
  // visibilitychange, so an item stuck at "uploading" recovers even if the
  // app is never backgrounded/foregrounded again.
  setInterval(() => { _kick(); _wallClockUnstick(); }, 30 * 1000);
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
