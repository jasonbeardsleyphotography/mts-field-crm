/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Drive Sync
   ─────────────────────────
   - App state (pipeline + dismissed) syncs in one `app-state.json` file
   - Each calendar event's field data syncs as `{eventId}.json` in field-data folder
   - All records carry `savedAt` timestamp for conflict resolution (newest wins)
   - Status listeners provide sync UI feedback
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
  const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime)&spaces=drive`);
  const d = await r.json();
  return d.files?.[0] || null;
}

async function saveJson(token, fileName, folderId, data) {
  const body = JSON.stringify(data);
  const existing = await findFile(token, fileName, folderId);
  if (existing) {
    await driveReq(token, `${UPLOAD_API}/files/${existing.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  } else {
    const metadata = { name: fileName, parents: [folderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await driveReq(token, `${UPLOAD_API}/files?uploadType=multipart`, { method: "POST", body: form });
  }
}

async function loadJson(token, fileName, folderId) {
  const existing = await findFile(token, fileName, folderId);
  if (!existing) return null;
  const r = await driveReq(token, `${DRIVE_API}/files/${existing.id}?alt=media`);
  return await r.json();
}

// ── APP STATE: pipeline + dismissed ──────────────────────────────────────────

export async function saveAppState(token, pipeline, dismissed) {
  setSyncStatus("syncing");
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    await saveJson(token, STATE_FILE, rootId, { pipeline, dismissed, savedAt: Date.now() });
    setSyncStatus("success");
    setTimeout(() => { if (syncStatus === "success") setSyncStatus("idle"); }, 2000);
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
    // Always attach a timestamp so we can resolve conflicts (newest wins)
    const payload = { ...fieldData, savedAt: Date.now() };
    await saveJson(token, `${eventId}.json`, fid, payload);
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

// List all field data files with modifiedTime (for efficient polling)
export async function listFieldFiles(token) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    const q = `'${fid}' in parents and trashed=false and mimeType='application/json'`;
    const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive&pageSize=1000`);
    const d = await r.json();
    return d.files || [];
  } catch(e) { console.warn("List field files failed:", e); return []; }
}

// Fetch a single file by its direct ID
export async function loadFileById(token, fileId) {
  try {
    const r = await driveReq(token, `${DRIVE_API}/files/${fileId}?alt=media`);
    return await r.json();
  } catch(e) { return null; }
}

// ── FULL SYNC (called on app open, visibility change, interval) ──────────────
// Returns { pipeline, dismissed, fieldData: {[id]: data} } merged from Drive
export async function fullSyncFromDrive(token) {
  setSyncStatus("syncing");
  const result = { pipeline: null, dismissed: null, fieldData: {}, stateSavedAt: 0 };
  try {
    const state = await loadAppState(token);
    if (state) {
      result.pipeline = state.pipeline || null;
      result.dismissed = state.dismissed || null;
      result.stateSavedAt = state.savedAt || 0;
    }
    const files = await listFieldFiles(token);
    for (const f of files) {
      const id = f.name.replace(/\.json$/, "");
      const data = await loadFileById(token, f.id);
      if (data) result.fieldData[id] = { ...data, _modifiedTime: f.modifiedTime };
    }
    setSyncStatus("success");
    setTimeout(() => { if (syncStatus === "success") setSyncStatus("idle"); }, 2000);
  } catch(e) {
    console.warn("Full sync failed:", e);
    setSyncStatus("error");
  }
  return result;
}
