/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Drive Sync
   Unified app state: pipeline + dismissed in one file for cross-device sync.
   ═══════════════════════════════════════════════════════════════════════════ */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "MTS Field";
const STATE_FILE = "app-state.json";
const FIELD_FOLDER = "field-data";

let folderCache = {};
let syncStatus = "idle";
let statusListeners = [];

export function onSyncStatus(fn) { statusListeners.push(fn); return () => { statusListeners = statusListeners.filter(f => f !== fn); }; }
function setSyncStatus(s) { syncStatus = s; statusListeners.forEach(fn => fn(s)); }
export function getSyncStatus() { return syncStatus; }

async function driveReq(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (!res.ok) { const err = new Error(`Drive ${res.status}`); err.status = res.status; throw err; }
  return res;
}

async function findOrCreateFolder(token, name, parentId = null) {
  const ck = parentId ? `${parentId}/${name}` : name;
  if (folderCache[ck]) return folderCache[ck];
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const d = await r.json();
  if (d.files?.length > 0) { folderCache[ck] = d.files[0].id; return d.files[0].id; }
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const c = await driveReq(token, `${DRIVE_API}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
  const cr = await c.json();
  folderCache[ck] = cr.id;
  return cr.id;
}

async function findFile(token, name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

async function saveJson(token, fileName, folderId, data) {
  const body = JSON.stringify(data);
  const existingId = await findFile(token, fileName, folderId);
  if (existingId) {
    await driveReq(token, `${UPLOAD_API}/files/${existingId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  } else {
    const metadata = { name: fileName, parents: [folderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await driveReq(token, `${UPLOAD_API}/files?uploadType=multipart`, { method: "POST", body: form });
  }
}

async function loadJson(token, fileName, folderId) {
  const fileId = await findFile(token, fileName, folderId);
  if (!fileId) return null;
  const r = await driveReq(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  return await r.json();
}

// ── APP STATE: pipeline + dismissed ──────────────────────────────────────────

export async function saveAppState(token, pipeline, dismissed) {
  setSyncStatus("syncing");
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    await saveJson(token, STATE_FILE, rootId, { pipeline, dismissed, savedAt: Date.now() });
    setSyncStatus("success");
    setTimeout(() => setSyncStatus("idle"), 3000);
  } catch(e) {
    console.warn("Drive save failed:", e);
    setSyncStatus("error");
  }
}

export async function loadAppState(token) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    return await loadJson(token, STATE_FILE, rootId);
  } catch(e) {
    console.warn("Drive load failed:", e);
    return null;
  }
}

// ── FIELD DATA ───────────────────────────────────────────────────────────────

export async function saveFieldToDrive(token, eventId, fieldData) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    // Strip photo dataUrls (too large for JSON); photos synced separately if needed
    const clean = { ...fieldData };
    delete clean.scopePhotos;
    delete clean.addonPhotos;
    delete clean.photos;
    await saveJson(token, `${eventId}.json`, fid, clean);
  } catch(e) {
    console.warn("Drive field save failed:", e);
  }
}

export async function loadFieldFromDrive(token, eventId) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    return await loadJson(token, `${eventId}.json`, fid);
  } catch(e) { return null; }
}
