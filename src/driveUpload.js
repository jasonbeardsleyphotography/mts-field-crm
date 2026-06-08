/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Drive Resumable Upload
   ───────────────────────────────────────────────────────────────────────────
   Pure protocol-level helpers for uploading large files to Google Drive
   using the resumable upload API. videoQueue.js calls these. Photos use
   the simpler multipart helper in driveSync.js.

   Why Drive instead of YouTube:
   - No 6-videos-per-day quota cap (YouTube costs 1600 units/upload, default
     daily quota is 10000, so ~6 uploads/day ceiling)
   - Drive uploads are much more reliable than YouTube uploads — Drive is
     a more mature API surface
   - Don't need video transcoding for the use case (sending links to
     clients in proposals/emails)
   - Drive `/preview` URL works in every browser without plugins, on every
     device — universal compatibility for our needs

   Why this file is separate from driveSync.js:
   - driveSync.js does small JSON state and small multipart photo uploads
   - This file does large chunked uploads with resume, retry, timeout, and
     a per-chunk timeout enforcement to handle cellular flake correctly
   ═══════════════════════════════════════════════════════════════════════════ */

import { findOrCreateFolder } from "./driveSync";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// Folder structure: MTS Field / field-data / videos / [files...]
const ROOT_FOLDER = "MTS Field";
const FIELD_FOLDER = "field-data";
const VIDEOS_FOLDER = "videos";

// Per-chunk timeout. The whole reason we're rewriting: previously a hung
// fetch() would wait forever. With a 60s timeout we treat any chunk that
// takes longer than 60s as a network failure that triggers retry/backoff.
// 60s is generous — even on slow LTE, a 5MB chunk transfers in under 30s.
const CHUNK_TIMEOUT_MS = 60_000;

/**
 * Initialize a resumable upload session.
 * Returns the session URL on success, or null on failure.
 *
 * @param {string} token   - OAuth bearer token
 * @param {string} title   - File name on Drive
 * @param {number} size    - Total file size in bytes
 * @param {string} mime    - MIME type
 * @param {string} parentId - Drive folder ID
 */
export async function initDriveSession(token, title, size, mime, parentId) {
  const metadata = {
    name: title,
    parents: [parentId],
    // Description with a tag so we can find these programmatically later
    description: "Uploaded via MTS Field CRM",
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(
      `${UPLOAD_API}/files?uploadType=resumable&fields=id,webViewLink`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          "X-Upload-Content-Type": mime,
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify(metadata),
        signal: controller.signal,
      }
    );
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") {
      return { ok: false, error: `Session init timeout (${CHUNK_TIMEOUT_MS / 1000}s)` };
    }
    return { ok: false, error: `Network: ${e?.message || String(e)}` };
  }
  clearTimeout(timeoutId);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: txt.slice(0, 300) };
  }
  const loc = res.headers.get("Location");
  if (!loc) return { ok: false, error: "No Location header in init response" };
  return { ok: true, sessionUrl: loc };
}

/**
 * Upload one chunk via XMLHttpRequest.
 *
 * Why XHR instead of fetch: XHR exposes `upload.onprogress`, giving real
 * byte-level progress *within* a chunk. With the adaptive chunk sizing in
 * videoQueue.js (chunks can be many MB), fetch would only update the progress
 * bar once per chunk — XHR keeps it moving smoothly. XHR also has a native
 * `timeout` and `abort()`, so we keep the per-chunk timeout that prevents a
 * stalled request from hanging forever on cellular flake.
 *
 * The resumable session URL is pre-authenticated (it embeds an upload_id), so
 * no Authorization header is needed here — which conveniently means chunk PUTs
 * keep working even if the OAuth token expires mid-upload on a long transfer.
 *
 * @param {string}   sessionUrl  resumable session URL
 * @param {Blob}     chunkBlob   the slice to send
 * @param {number}   startByte   absolute start offset of this chunk
 * @param {number}   endByte     absolute end offset (inclusive)
 * @param {number}   totalSize   full file size
 * @param {object}   [opts]
 * @param {number}   [opts.timeoutMs]   per-chunk timeout
 * @param {function} [opts.onProgress]  (absoluteBytesUploaded) => void
 *
 * Return shape:
 *   { kind: "ok-final", fileId, webViewLink }
 *   { kind: "ok-progress", nextOffset }
 *   { kind: "session-expired" }
 *   { kind: "error", error, timedOut? }
 */
export function uploadChunk(sessionUrl, chunkBlob, startByte, endByte, totalSize, opts = {}) {
  const { timeoutMs = CHUNK_TIMEOUT_MS, onProgress } = opts;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      xhr.open("PUT", sessionUrl, true);
    } catch (e) {
      return done({ kind: "error", error: `Open failed: ${e?.message || e}` });
    }
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Content-Range", `bytes ${startByte}-${endByte}/${totalSize}`);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(startByte + e.loaded);
      };
    }

    xhr.onload = () => {
      const status = xhr.status;
      if (status === 200 || status === 201) {
        let body;
        try { body = JSON.parse(xhr.responseText); }
        catch { return done({ kind: "error", error: "Final response not JSON" }); }
        if (body?.id) return done({ kind: "ok-final", fileId: body.id, webViewLink: body.webViewLink });
        return done({ kind: "error", error: "Final response missing file id" });
      }
      if (status === 308) {
        const range = xhr.getResponseHeader("Range");
        if (!range) return done({ kind: "ok-progress", nextOffset: 0 });
        const m = range.match(/bytes=0-(\d+)/);
        return done({ kind: "ok-progress", nextOffset: m ? parseInt(m[1], 10) + 1 : endByte + 1 });
      }
      if (status === 404 || status === 410) return done({ kind: "session-expired" });
      done({ kind: "error", error: `HTTP ${status}: ${(xhr.responseText || "").slice(0, 200)}` });
    };
    xhr.ontimeout = () => done({ kind: "error", error: `Chunk timeout (${Math.round(timeoutMs / 1000)}s)`, timedOut: true });
    xhr.onerror   = () => done({ kind: "error", error: "Network error during chunk upload" });
    xhr.onabort   = () => done({ kind: "error", error: "Chunk aborted" });

    try { xhr.send(chunkBlob); }
    catch (e) { done({ kind: "error", error: `Send failed: ${e?.message || e}` }); }
  });
}

/**
 * Query a resumable session for current byte offset.
 * Returns: number (next byte to upload) | "complete" | null (session dead)
 */
export async function queryUploadOffset(sessionUrl, totalSize) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${totalSize}` },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
  clearTimeout(timeoutId);

  if (res.status === 200 || res.status === 201) return "complete";
  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (!range) return 0;
    const m = range.match(/bytes=0-(\d+)/);
    return m ? parseInt(m[1], 10) + 1 : 0;
  }
  if (res.status === 404 || res.status === 410) return null;
  return null;
}

/**
 * Make a Drive file readable by anyone with the link. After this, the file's
 * `/preview` URL works in any browser without authentication. This is what
 * lets you paste the link into a client email and have it just work.
 */
export async function makeDriveFilePublic(token, fileId) {
  try {
    const res = await fetch(`${DRIVE_API}/files/${fileId}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the videos folder ID, creating the folder hierarchy if missing.
 * Cached internally by findOrCreateFolder().
 */
export async function getVideosFolderId(token) {
  const rootId = await findOrCreateFolder(token, ROOT_FOLDER);
  const fieldId = await findOrCreateFolder(token, FIELD_FOLDER, rootId);
  const videosId = await findOrCreateFolder(token, VIDEOS_FOLDER, fieldId);
  return videosId;
}

/**
 * Build the canonical shareable URL we save to cards. The /preview URL
 * uses Drive's embed player — works in any browser, on any device, for
 * both videos and images. Universal compatibility.
 */
export function buildShareUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

/**
 * Build a direct-stream URL useful for HTML5 <video src=...> elements.
 * Some clients prefer this over the embed player.
 */
export function buildDirectUrl(fileId) {
  return `https://drive.google.com/uc?id=${fileId}&export=view`;
}
