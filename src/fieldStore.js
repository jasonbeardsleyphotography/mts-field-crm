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
