/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Drive Sync
   Unified app state: pipeline + dismissed in one file for cross-device sync.
   ═══════════════════════════════════════════════════════════════════════════ */

import { loadField, markFieldDirty, clearFieldDirty } from "./fieldStore";

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
  // orderBy modifiedTime desc → if past races created duplicate files with the
  // same name, both reads and writes consistently target the NEWEST copy. Without
  // this, Drive's default ordering is non-deterministic and reads/writes could
  // land on different copies, permanently splitting a stop's data.
  const r = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=modifiedTime desc&spaces=drive`);
  const d = await r.json();
  return d.files?.[0]?.id || null;
}

// Drive's simple media/multipart upload caps at 5 MB. Field JSON with several
// base64 photos can exceed that easily. Use resumable upload for anything over
// 4 MB so large payloads always land regardless of size.
const RESUMABLE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

async function saveJson(token, fileName, folderId, data) {
  const body = JSON.stringify(data);
  const existingId = await findFile(token, fileName, folderId);
  if (body.length > RESUMABLE_THRESHOLD) {
    await _saveJsonResumable(token, body, fileName, folderId, existingId);
    return;
  }
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

// Initiate a Drive resumable upload session, then PUT the full body.
// Handles both create (new file) and update (patch existing file).
async function _saveJsonResumable(token, body, fileName, folderId, existingId) {
  const initUrl = existingId
    ? `${UPLOAD_API}/files/${existingId}?uploadType=resumable`
    : `${UPLOAD_API}/files?uploadType=resumable`;
  const initMethod = existingId ? "PATCH" : "POST";
  const initBody = existingId ? undefined : JSON.stringify({ name: fileName, parents: [folderId] });

  const sessionRes = await fetch(initUrl, {
    method: initMethod,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "application/json",
      "X-Upload-Content-Length": String(body.length),
    },
    ...(initBody ? { body: initBody } : {}),
  });
  if (!sessionRes.ok) {
    const err = new Error(`Drive resumable init ${sessionRes.status}`);
    err.status = sessionRes.status;
    if (sessionRes.status === 401 || sessionRes.status === 403) {
      err.isAuthError = true;
      if (authErrorCallback) authErrorCallback();
    }
    throw err;
  }
  const sessionUrl = sessionRes.headers.get("Location");
  if (!sessionUrl) throw new Error("Drive resumable: missing Location header");

  const uploadRes = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
    body,
  });
  if (!uploadRes.ok) {
    const err = new Error(`Drive resumable upload ${uploadRes.status}`);
    err.status = uploadRes.status;
    if (uploadRes.status === 401 || uploadRes.status === 403) {
      err.isAuthError = true;
      if (authErrorCallback) authErrorCallback();
    }
    throw err;
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

// Strip `dataUrl` from photos that already have a Drive `url` before pushing
// the field JSON. Photos without `url` (not yet uploaded as separate Drive
// files) keep their dataUrl so the other device can see them. This keeps the
// JSON under 1 MB for stops with uploaded photos, avoiding Drive's 5 MB
// multipart limit and making every push fast regardless of photo count.
// Photos with only a local `dataUrl` are small enough (one at a time, freshly
// captured) that the resumable-upload fallback in saveJson covers any edge case.
function _slimForDrive(data) {
  if (!data) return data;
  const stripUploaded = (arr) => (arr || []).map(p => {
    if (p && p.url && p.dataUrl) { const { dataUrl, ...rest } = p; return rest; }
    return p;
  });
  return {
    ...data,
    scopePhotos: stripUploaded(data.scopePhotos || data.photos),
    addonPhotos: stripUploaded(data.addonPhotos),
    photos: undefined, // drop legacy field alias — scopePhotos is canonical on Drive
  };
}

export async function saveFieldToDrive(token, eventId, fieldData) {
  // NOTE: this intentionally lets errors propagate. queueFieldDriveSync relies
  // on a thrown error to know the push failed (so it keeps the id dirty for
  // retry and surfaces an error in the sync indicator). Callers that don't
  // care about the result wrap this in `.catch(() => {})`.
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const fid = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
  await saveJson(token, `${eventId}.json`, fid, _slimForDrive(fieldData));
}

// ── SERIALIZED + COALESCED FIELD SYNC ────────────────────────────────────────
// All field-JSON pushes for a stop MUST go through here. Previously every photo
// capture, the auto-save timer, and the pagehide/unmount flushes each fired
// their own saveFieldToDrive independently. On slow networks these overlap and
// a push started earlier (fewer photos, no text yet) can LAND AFTER a later push
// that had everything — so the stale snapshot wins and the other device sees
// partial data. This queue guarantees: (1) at most one push per stop in flight,
// (2) it reads the FRESHEST data from IDB at execution time, and (3) bursts of
// requests collapse into a single trailing run that captures all changes.
const _fieldChain    = new Map();   // id -> tail promise
const _fieldTrailing = new Set();   // ids with a not-yet-started run already queued

export function queueFieldDriveSync(token, id) {
  if (!token || !id) return Promise.resolve();
  // Record that this stop has an unconfirmed Drive push. Cleared on success;
  // left set on failure so App.jsx's periodic dirty-flush retries it.
  markFieldDirty(id);
  // A queued run hasn't started yet — it will read fresh IDB when it does, so
  // collapse this request into it rather than stacking another.
  if (_fieldTrailing.has(id)) return _fieldChain.get(id) || Promise.resolve();
  _fieldTrailing.add(id);
  const run = async () => {
    _fieldTrailing.delete(id); // starting now; further calls queue a fresh trailing run
    setSyncStatus("syncing");
    try {
      const fresh = await loadField(id);
      if (fresh && Object.keys(fresh).length) {
        await saveFieldToDrive(token, id, fresh);
      }
      // Only clear dirty if no newer edit got queued while this push was in
      // flight. If a trailing run exists, it pushes the newer data and clears
      // dirty when it succeeds — clearing here would drop the retry guarantee.
      if (!_fieldTrailing.has(id)) clearFieldDirty(id);
      setSyncStatus("success");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch (e) {
      // Leave the id dirty so the periodic flush retries it.
      setSyncStatus(e?.isAuthError ? "auth-error" : "error");
    }
  };
  const prev = _fieldChain.get(id) || Promise.resolve();
  const next = prev.then(run, run); // run even if the prior link rejected
  _fieldChain.set(id, next);
  next.finally(() => { if (_fieldChain.get(id) === next) _fieldChain.delete(id); });
  return next;
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
