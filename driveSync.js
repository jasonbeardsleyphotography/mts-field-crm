/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Drive Sync
   Saves pipeline data and field photos to Google Drive.
   Uses the same OAuth token as Google Calendar (just needs drive.file scope).
   
   Drive structure:
     MTS Field/
       pipeline.json        — full pipeline state
       field-data/
         {eventId}.json     — per-stop field notes, video links, audio clips
       photos/
         {eventId}_1.jpg    — field photos (full resolution)
   ═══════════════════════════════════════════════════════════════════════════ */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "MTS Field";
const PIPELINE_FILE = "pipeline.json";
const FIELD_FOLDER = "field-data";
const PHOTO_FOLDER = "photos";

let folderCache = {}; // { "MTS Field": id, "photos": id, "field-data": id }

// ── HELPERS ──────────────────────────────────────────────────────────────────

async function driveReq(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!res.ok) {
    const err = new Error(`Drive ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Find or create a folder by name (optionally inside a parent folder)
async function findOrCreateFolder(token, name, parentId = null) {
  const cacheKey = parentId ? `${parentId}/${name}` : name;
  if (folderCache[cacheKey]) return folderCache[cacheKey];

  // Search for existing folder
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const searchRes = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  const searchData = await searchRes.json();
  if (searchData.files?.length > 0) {
    folderCache[cacheKey] = searchData.files[0].id;
    return searchData.files[0].id;
  }

  // Create folder
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) meta.parents = [parentId];
  const createRes = await driveReq(token, `${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  const created = await createRes.json();
  folderCache[cacheKey] = created.id;
  return created.id;
}

// Find a file by name in a folder
async function findFile(token, name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

// ── PIPELINE JSON ────────────────────────────────────────────────────────────

export async function savePipelineToDrive(token, pipelineData) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const existingId = await findFile(token, PIPELINE_FILE, rootId);
  const body = JSON.stringify(pipelineData, null, 2);

  if (existingId) {
    // Update existing file
    await driveReq(token, `${UPLOAD_API}/files/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } else {
    // Create new file
    const metadata = { name: PIPELINE_FILE, parents: [rootId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await driveReq(token, `${UPLOAD_API}/files?uploadType=multipart`, {
      method: "POST",
      body: form,
    });
  }
}

export async function loadPipelineFromDrive(token) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const fileId = await findFile(token, PIPELINE_FILE, rootId);
  if (!fileId) return null;

  const res = await driveReq(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  return await res.json();
}

// ── FIELD DATA (per-stop notes, video links, audio) ──────────────────────────

export async function saveFieldDataToDrive(token, eventId, fieldData) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const fieldFolderId = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
  const fileName = `${eventId}.json`;

  // Strip photos from field data (photos saved separately as actual image files)
  const dataToSave = { ...fieldData };
  delete dataToSave.photos;

  const existingId = await findFile(token, fileName, fieldFolderId);
  const body = JSON.stringify(dataToSave, null, 2);

  if (existingId) {
    await driveReq(token, `${UPLOAD_API}/files/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } else {
    const metadata = { name: fileName, parents: [fieldFolderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([body], { type: "application/json" }));
    await driveReq(token, `${UPLOAD_API}/files?uploadType=multipart`, { method: "POST", body: form });
  }
}

export async function loadFieldDataFromDrive(token, eventId) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const fieldFolderId = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
  const fileId = await findFile(token, `${eventId}.json`, fieldFolderId);
  if (!fileId) return null;

  const res = await driveReq(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  return await res.json();
}

// ── PHOTOS ───────────────────────────────────────────────────────────────────

export async function savePhotoToDrive(token, eventId, photoIndex, dataUrl) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const photoFolderId = await findOrCreateFolder(token, PHOTO_FOLDER, rootId);
  const fileName = `${eventId}_${photoIndex}.jpg`;

  // Convert data URL to blob
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();

  const existingId = await findFile(token, fileName, photoFolderId);

  if (existingId) {
    await driveReq(token, `${UPLOAD_API}/files/${existingId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
  } else {
    const metadata = { name: fileName, parents: [photoFolderId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);
    await driveReq(token, `${UPLOAD_API}/files?uploadType=multipart`, { method: "POST", body: form });
  }
}

export async function listPhotosFromDrive(token, eventId) {
  const rootId = await findOrCreateFolder(token, FOLDER_NAME);
  const photoFolderId = await findOrCreateFolder(token, PHOTO_FOLDER, rootId);
  const q = `name contains '${eventId}_' and '${photoFolderId}' in parents and trashed=false`;
  const res = await driveReq(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&orderBy=name`);
  const data = await res.json();
  return data.files || [];
}

export async function getPhotoUrl(token, fileId) {
  // Returns a temporary download URL
  const res = await driveReq(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ── FULL SYNC ────────────────────────────────────────────────────────────────

export async function syncToCloud(token, pipelineData, fieldDataMap) {
  // Save pipeline
  await savePipelineToDrive(token, pipelineData);

  // Save field data + photos for each stop
  for (const [eventId, fieldData] of Object.entries(fieldDataMap)) {
    await saveFieldDataToDrive(token, eventId, fieldData);

    // Save photos
    if (fieldData.photos?.length > 0) {
      for (let i = 0; i < fieldData.photos.length; i++) {
        await savePhotoToDrive(token, eventId, i, fieldData.photos[i].dataUrl);
      }
    }
  }
}

export async function syncFromCloud(token) {
  const pipeline = await loadPipelineFromDrive(token);
  return pipeline;
}
