/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Field Data Store (IndexedDB)

   Stores per-stop field data: scopeNotes, addonNotes, scopePhotos (base64
   dataURL), addonPhotos, audioClips, videoUrls, AI results. Photo data
   URLs and audio dataURLs quickly exceed localStorage's 5–10 MB cap, so
   this moves them to IndexedDB (hundreds of MB available).

   Migration: first read for any ID, if IndexedDB has no entry but
   localStorage has mts-field-${id}, we copy the localStorage value into
   IndexedDB and return it. The localStorage copy stays put for now —
   that means a rollback to the previous version is still safe. A future
   pass can drop the localStorage fallback once we're confident.

   API is *async* — this is the one place the app has to deal with that.
   OnsiteWindow and Pipeline need to await loads on mount and only update
   state when data arrives.
   ═══════════════════════════════════════════════════════════════════════════ */

const DB_NAME  = "mts-field";
const DB_VER   = 1;
const STORE    = "fields";
const LS_PREFIX = "mts-field-";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  return dbPromise;
}

async function tx(mode) {
  const db = await openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

// Delete the entire field database + its localStorage slim mirrors. Used when a
// DIFFERENT Google account signs in on this device, so one account's field data
// (photos, notes, videos) can't bleed into another's. Resolves even if the DB
// was already gone or the delete is blocked.
export async function deleteFieldDB() {
  try { (await dbPromise)?.close?.(); } catch {}
  dbPromise = null;
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    keys.forEach(k => { try { localStorage.removeItem(k); } catch {} });
  } catch {}
}

// ── LOAD: IDB first, fall back to localStorage (with migration) ─────────────
export async function loadField(id) {
  if (!id) return {};
  try {
    const store = await tx("readonly");
    const data = await new Promise((ok, err) => {
      const r = store.get(id);
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => err(r.error);
    });
    if (data) return data;

    // No IDB entry — migrate from localStorage if present.
    const lsRaw = localStorage.getItem(LS_PREFIX + id);
    if (!lsRaw) return {};
    const lsData = JSON.parse(lsRaw);
    // Write through so next read hits IDB.
    saveField(id, lsData).catch(() => {});
    return lsData || {};
  } catch (e) {
    console.warn("fieldStore load failed, falling back to localStorage:", e);
    try {
      const raw = localStorage.getItem(LS_PREFIX + id);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch { return {}; }
  }
}

// ── SAVE: writes to IDB + mirror to localStorage for legacy readers ─────────
// The localStorage mirror keeps backwards compatibility with Drive sync
// (which iterates localStorage keys) and the Pipeline cardsByStage memo
// (which still has some sync paths during transition). Once all callers
// are async-safe, the mirror can be dropped.
export async function saveField(id, data) {
  if (!id) return;
  const enriched = { ...data, savedAt: Date.now() };
  try {
    const store = await tx("readwrite");
    await new Promise((ok, err) => {
      const r = store.put(enriched, id);
      r.onsuccess = () => ok();
      r.onerror   = () => err(r.error);
    });
  } catch (e) {
    console.warn("fieldStore save failed:", e);
  }
  // Mirror a *lightweight slice* to localStorage so legacy code (Drive sync
  // key-iteration, App.jsx pullFromDrive) still sees entries exist. Strips
  // base64 photo/audio dataURLs to stay under the 5 MB cap. Full data is
  // always available via IDB / Drive.
  try {
    const slim = {
      scopeNotes: enriched.scopeNotes,
      addonNotes: enriched.addonNotes,
      videoUrls:  enriched.videoUrls,
      aiScopeSummary: enriched.aiScopeSummary,
      aiAddonEmail:   enriched.aiAddonEmail,
      savedAt: enriched.savedAt,
      // Counts only — legacy readers that just check "has anything?" are happy.
      _scopePhotoCount: (enriched.scopePhotos || enriched.photos || []).length,
      _addonPhotoCount: (enriched.addonPhotos || []).length,
      _audioCount:      (enriched.audioClips  || []).length,
    };
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(slim));
  } catch {
    // Even the slim payload was too big or storage is full — drop the mirror.
    try { localStorage.removeItem(LS_PREFIX + id); } catch {}
  }
}

// ── SYNC MIRROR: caches latest loaded values so sync code can peek ──────────
// A lightweight in-memory Map of id → data. Filled as loadField resolves;
// consulted by sync-only code paths (e.g. Pipeline's cardsByStage field
// summary). Not a cache in the TTL sense — it's just a view of what async
// loads have already pulled this session.
const mirror = new Map();
export function peekField(id) {
  if (!id) return {};
  if (mirror.has(id)) return mirror.get(id);
  // Last-ditch: try localStorage synchronously. This is the "before the
  // async load completes" case. Safe because IDB is eventually authoritative.
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (raw) {
      const parsed = JSON.parse(raw) || {};
      mirror.set(id, parsed);
      return parsed;
    }
  } catch {}
  return {};
}
export function primeField(id, data) {
  if (!id) return;
  mirror.set(id, data || {});
}

// ── SHARED WRITE QUEUE ──────────────────────────────────────────────────────
// Per-stop serialization for read-modify-write operations. Both the auto-
// save (text/AI changes) and photo modifications (add/remove/edit/upload)
// must go through this queue. Without it, two concurrent writes to the
// same stop would read the same "before" state and clobber each other's
// changes — exactly the bug that wiped photos when auto-save raced with
// _processPhoto.
const writeQueues = new Map();
function _enqueueWrite(id, fn) {
  const prev = writeQueues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn); // chain even if prev rejected
  writeQueues.set(id, next);
  // Drop the entry when the chain settles so the map doesn't leak.
  next.finally(() => {
    if (writeQueues.get(id) === next) writeQueues.delete(id);
  });
  return next;
}

// ── MERGE / UPDATE: surgical writes that don't clobber other fields ────────
// mergeField(id, partial)         — shallow merge of `partial` into existing
// updateField(id, fn)             — fn(existing) returns the partial to merge
// Both are queued per-id so concurrent calls don't race. Both update the
// in-memory mirror so peekField sees the latest. Use these for any write
// that touches a SUBSET of the field record (text without photos, photos
// without text, etc.). Use saveField only when you have the entire record.
export function mergeField(id, partial) {
  if (!id) return Promise.resolve();
  return _enqueueWrite(id, async () => {
    const existing = await loadField(id).catch(() => ({}));
    const merged = { ...existing, ...partial, savedAt: Date.now() };
    mirror.set(id, merged);
    await saveField(id, merged).catch((e) => console.warn("mergeField save failed:", e));
  });
}
export function updateField(id, transformer) {
  if (!id || typeof transformer !== "function") return Promise.resolve();
  return _enqueueWrite(id, async () => {
    const existing = await loadField(id).catch(() => ({}));
    const updates = transformer(existing) || {};
    const merged = { ...existing, ...updates, savedAt: Date.now() };
    mirror.set(id, merged);
    await saveField(id, merged).catch((e) => console.warn("updateField save failed:", e));
  });
}

// ── SYNCHRONOUS SLIM FLUSH ──────────────────────────────────────────────────
// For pagehide/visibilitychange handlers where async writes can be cut off
// before they commit. localStorage writes are synchronous, so the slim
// mirror always lands before iOS suspends the page. On next open, peekField
// reads this slim mirror and state initializes from the latest text — even
// if the matching IDB write was interrupted mid-flight.
export function saveFieldSync(id, data) {
  if (!id || !data) return;
  try {
    const slim = {
      scopeNotes: data.scopeNotes,
      addonNotes: data.addonNotes,
      videoUrls:  data.videoUrls,
      aiScopeSummary: data.aiScopeSummary,
      aiAddonEmail:   data.aiAddonEmail,
      savedAt: Date.now(),
      _scopePhotoCount: (data.scopePhotos || data.photos || []).length,
      _addonPhotoCount: (data.addonPhotos || []).length,
      _audioCount:      (data.audioClips  || []).length,
    };
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(slim));
  } catch {
    try { localStorage.removeItem(LS_PREFIX + id); } catch {}
  }
}

// ── SLIM MIRROR DIRECT READ ─────────────────────────────────────────────────
// Reads localStorage directly, bypassing the in-memory mirror. Needed for
// the recovery check on hydration: we compare the slim mirror's photo count
// (what we last claimed to have) against IDB's actual photo count (what we
// actually have). A mismatch signals possible data loss and we can pull
// from Drive to recover.
export function getFieldSlim(id) {
  if (!id) return null;
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    return raw ? (JSON.parse(raw) || null) : null;
  } catch { return null; }
}

// ── DIRTY-FIELD TRACKING ─────────────────────────────────────────────────────
// A persisted set of stop IDs whose local field data has a Drive push that
// hasn't been confirmed yet. queueFieldDriveSync (driveSync.js) marks an id
// dirty when a push is requested and clears it only after the push succeeds.
// App.jsx periodically re-pushes whatever is still dirty, so an edit made
// offline (or a push that 401'd) is retried automatically instead of being
// lost. This replaces the old "re-upload every field record on every action"
// brute-force sync, which saturated the connection and slowed real syncs.
const DIRTY_KEY = "mts-field-dirty";
function _readDirty() {
  try { return new Set(JSON.parse(localStorage.getItem(DIRTY_KEY) || "[]")); }
  catch { return new Set(); }
}
function _writeDirty(set) {
  try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...set])); } catch {}
}
export function markFieldDirty(id) {
  if (!id) return;
  const s = _readDirty();
  if (!s.has(id)) { s.add(id); _writeDirty(s); }
}
export function clearFieldDirty(id) {
  if (!id) return;
  const s = _readDirty();
  if (s.delete(id)) _writeDirty(s);
}
export function getDirtyFieldIds() {
  return [..._readDirty()];
}

// ── LIST IDS ────────────────────────────────────────────────────────────────
export async function listFieldIds() {
  try {
    const store = await tx("readonly");
    const keys = await new Promise((ok, err) => {
      const r = store.getAllKeys();
      r.onsuccess = () => ok(r.result || []);
      r.onerror   = () => err(r.error);
    });
    // Also include localStorage-only entries that haven't been migrated yet.
    const lsKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) lsKeys.push(k.slice(LS_PREFIX.length));
    }
    return [...new Set([...keys, ...lsKeys])];
  } catch {
    return [];
  }
}

// ── DELETE ──────────────────────────────────────────────────────────────────
export async function deleteField(id) {
  if (!id) return;
  try {
    const store = await tx("readwrite");
    await new Promise((ok) => {
      const r = store.delete(id);
      r.onsuccess = () => ok();
      r.onerror   = () => ok();
    });
  } catch {}
  try { localStorage.removeItem(LS_PREFIX + id); } catch {}
  mirror.delete(id);
}
