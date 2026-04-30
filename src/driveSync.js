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
let authErrorCallback = null;

export function onSyncStatus(fn) { statusListeners.push(fn); return () => { statusListeners = statusListeners.filter(f => f !== fn); }; }
function setSyncStatus(s) { syncStatus = s; statusListeners.forEach(fn => fn(s)); }
export function getSyncStatus() { return syncStatus; }

/** Register a callback to be invoked when Drive returns 401/403.
 *  App.jsx wires this to silentReauth() so token is refreshed automatically. */
export function onAuthError(fn) { authErrorCallback = fn; }

async function driveReq(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
  if (!res.ok) {
    const err = new Error(`Drive ${res.status}`);
    err.status = res.status;
    if (res.status === 401 || res.status === 403) {
      err.isAuthError = true;
      if (authErrorCallback) authErrorCallback();
    }
    throw err;
  }
  return res;
}

export async function findOrCreateFolder(token, name, parentId = null) {
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

export async function saveAppState(token, pipeline, dismissed, lastContact) {
  setSyncStatus("syncing");
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    await saveJson(token, STATE_FILE, rootId, { pipeline, dismissed, lastContact: lastContact || {}, savedAt: Date.now() });
    setSyncStatus("success");
    setTimeout(() => setSyncStatus("idle"), 3000);
  } catch(e) {
    console.warn("Drive save failed:", e);
    // auth errors trigger re-auth via the registered callback; show distinct state
    setSyncStatus(e.isAuthError ? "auth-error" : "error");
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

// ── PHOTO FILE UPLOAD ────────────────────────────────────────────────────────

/**
 * Upload a single photo (base64 dataUrl) to Drive as a real file inside the
 * "field-data/photos" folder.  Returns the webContentLink (direct HTTPS URL)
 * on success, or null on failure.
 *
 * Uploading photos as Drive files rather than embedding them as base64 JSON
 * dramatically reduces app-state.json size, speeds up cross-device sync, and
 * lets the IMG tag load over CDN instead of parsing a huge data: string.
 */
export async function uploadPhotoToDrive(token, dataUrl, filename) {
  try {
    // Convert base64 dataUrl → binary Blob
    const [header, b64] = dataUrl.split(",");
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] || "image/jpeg";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });

    // Ensure folder structure exists
    const rootId  = await findOrCreateFolder(token, FOLDER_NAME);
    const fieldId = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    const photoId = await findOrCreateFolder(token, "photos", fieldId);

    // Multipart upload
    const metadata = { name: filename, parents: [photoId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);

    const res = await driveReq(
      token,
      `${UPLOAD_API}/files?uploadType=multipart&fields=id,webContentLink`,
      { method: "POST", body: form }
    );
    const data = await res.json();
    if (!data.id) return null;

    // Make publicly readable so IMG tags can load it without auth headers
    await driveReq(
      token,
      `${DRIVE_API}/files/${data.id}/permissions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      }
    );

    // webContentLink works for direct download; use thumbnail URL for display
    return `https://drive.google.com/thumbnail?id=${data.id}&sz=w1200`;
  } catch(e) {
    console.warn("Photo Drive upload failed:", e);
    return null;
  }
}

// ── FIELD DATA ───────────────────────────────────────────────────────────────

export async function saveFieldToDrive(token, eventId, fieldData) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    // Include full field data including photos as base64
    await saveJson(token, `${eventId}.json`, fid, fieldData);
  } catch(e) {
    console.warn("Drive field save failed:", e);
  }
}

export async function listFieldFiles(token) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    const q = `'${fid}' in parents and trashed=false`;
    const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive&pageSize=1000`);
    const d = await r.json();
    return d.files || [];
  } catch(e) { return []; }
}

export async function loadFieldFromDrive(token, eventId) {
  try {
    const rootId = await findOrCreateFolder(token, FOLDER_NAME);
    const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
    return await loadJson(token, `${eventId}.json`, fid);
  } catch(e) { return null; }
}
