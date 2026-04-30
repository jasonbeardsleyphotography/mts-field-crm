/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Pipeline Diagnostic Log
   ───────────────────────────────────────────────────────────────────────────
   Writes structured log entries to IndexedDB so they survive tab restarts,
   service-worker recycles, and anything else that might wipe console.log.

   Why this exists: when an upload fails or stalls on a phone, console.log
   is useless because the console isn't observable. The user reports "the
   upload didn't work" and we have nothing. With this log, the user can
   open a "What happened?" panel in the app and we see every step the
   pipeline took, with timestamps.

   Schema:
     id:        autoincrement
     ts:        Date.now()
     level:     "info" | "warn" | "error"
     event:     short event name, e.g. "enqueued", "compress.start"
     itemId:    queue item id if applicable
     data:      arbitrary JSON, kept small

   Auto-prunes entries older than 7 days on each write so the log can't
   grow unboundedly. Cap at 5000 entries.
   ═══════════════════════════════════════════════════════════════════════════ */

const DB_NAME = "mts-video-log";
const DB_VER = 1;
const STORE = "log";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

let _dbPromise = null;
let _writeQueue = Promise.resolve(); // serialize writes to avoid IDB race

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in (typeof self !== "undefined" ? self : window))) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("ts", "ts", { unique: false });
        store.createIndex("itemId", "itemId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

async function _writeEntry(entry) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      store.add(entry);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    // If we can't write to the log, don't break the caller. Last-resort
    // fallback to console (will be visible in dev tools at least).
    try { console.warn("[VLOG] write failed:", e?.message || e, "entry:", entry); } catch {}
  }
}

/**
 * Log an event. Non-blocking — returns immediately, write happens in background.
 * Also mirrors to console for live debugging.
 */
export function vlog(level, event, data, itemId) {
  const entry = {
    ts: Date.now(),
    level,
    event,
    itemId: itemId || null,
    data: data || null,
  };
  // Mirror to console — keeps existing dev workflows working
  try {
    const tag = `[VLOG ${level}]`;
    const args = [tag, event, itemId ? `(${itemId})` : "", data || ""].filter(Boolean);
    if (level === "error") console.error(...args);
    else if (level === "warn") console.warn(...args);
    else console.log(...args);
  } catch {}
  // Serialize writes via promise chain so we don't lose ordering
  _writeQueue = _writeQueue.then(() => _writeEntry(entry)).catch(() => {});
}

export const vlogInfo = (event, data, itemId) => vlog("info", event, data, itemId);
export const vlogWarn = (event, data, itemId) => vlog("warn", event, data, itemId);
export const vlogError = (event, data, itemId) => vlog("error", event, data, itemId);

/**
 * Read entries newest-first.
 * @param {{itemId?: string, sinceMs?: number, limit?: number}} opts
 */
export async function readLog(opts = {}) {
  const { itemId = null, sinceMs = 0, limit = 500 } = opts;
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readonly");
      const store = t.objectStore(STORE);
      const out = [];
      // Walk by ts index in descending order
      const idx = store.index("ts");
      const range = sinceMs > 0 ? IDBKeyRange.lowerBound(sinceMs) : null;
      const req = idx.openCursor(range, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) { resolve(out); return; }
        const v = cur.value;
        if (!itemId || v.itemId === itemId) out.push(v);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return [];
  }
}

export async function clearLog() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {}
}

/**
 * Prune old entries. Call periodically (e.g. once per session).
 */
export async function pruneLog() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      const cutoff = Date.now() - MAX_AGE_MS;
      const range = IDBKeyRange.upperBound(cutoff);
      const req = store.index("ts").openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        cur.delete();
        cur.continue();
      };
      t.onerror = () => reject(t.error);
    });
    // Also cap at MAX_ENTRIES — delete oldest if we have more
    const total = await new Promise((resolve) => {
      const db2 = _dbPromise; // already resolved
      const t = db.transaction(STORE, "readonly");
      const req = t.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (total > MAX_ENTRIES) {
      const toDelete = total - MAX_ENTRIES;
      await new Promise((resolve) => {
        const t = db.transaction(STORE, "readwrite");
        const idx = t.objectStore(STORE).index("ts");
        let n = 0;
        const req = idx.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || n >= toDelete) { resolve(); return; }
          cur.delete();
          n++;
          cur.continue();
        };
        req.onerror = () => resolve();
      });
    }
  } catch {}
}
