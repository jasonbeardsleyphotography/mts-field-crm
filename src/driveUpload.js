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
   - This file does large streaming uploads with stall detection and
     offset-based resume to handle cellular flake correctly
   ═══════════════════════════════════════════════════════════════════════════ */

import { findOrCreateFolder } from "./driveSync";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

// Folder structure: MTS Field / field-data / videos / [files...]
const ROOT_FOLDER = "MTS Field";
const FIELD_FOLDER = "field-data";
const VIDEOS_FOLDER = "videos";

// Timeout for the small control requests (session init, offset query). The
// big data transfer uses a progress-based stall watchdog instead — see
// uploadFromOffset below.
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
  // Strip any MediaRecorder codecs parameter (e.g. "video/webm;codecs=vp9,opus")
  // — Drive's content-type handling only wants the bare type.
  const cleanMime = (mime || "video/mp4").split(";")[0];
  const metadata = {
    name: title,
    parents: [parentId],
    mimeType: cleanMime,
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
          "X-Upload-Content-Type": cleanMime,
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

// If no bytes move for this long, the request is dead — abort and let the
// queue re-query the server offset and resume. This replaces a fixed total
// timeout: a 500MB upload legitimately takes many minutes, but a healthy
// transfer fires progress events constantly, so 45s of silence means stalled.
const STALL_TIMEOUT_MS = 45_000;

/**
 * Upload everything from `startByte` to end-of-file in ONE streaming PUT.
 *
 * This is Google's documented best practice: use a single request when you
 * can, and lean on the resumable protocol only for *recovery*. Chunking every
 * upload (what we did before) pays a network round-trip per chunk for no
 * benefit — Drive persists whatever bytes it received even when a request
 * dies mid-flight, and queryUploadOffset() tells us exactly where to resume.
 * So the fast path is one request with zero protocol overhead, and the
 * failure path costs only one offset query before resuming.
 *
 * XHR instead of fetch for two reasons: `upload.onprogress` gives real
 * byte-level progress for the bar, and progress events double as the
 * liveness signal for the stall watchdog (fetch exposes neither).
 *
 * The session URL is pre-authenticated (it embeds an upload_id), so no
 * Authorization header is needed — uploads keep working even if the OAuth
 * token expires mid-transfer.
 *
 * @param {string}   sessionUrl  resumable session URL
 * @param {Blob}     blob        file.slice(startByte) — the remainder to send
 * @param {number}   startByte   absolute offset this PUT starts at
 * @param {number}   totalSize   full file size
 * @param {object}   [opts]
 * @param {number}   [opts.stallMs]     abort after this long with no progress
 * @param {function} [opts.onProgress]  (absoluteBytesUploaded) => void
 *
 * Return shape:
 *   { kind: "ok-final", fileId, webViewLink }
 *   { kind: "ok-progress", nextOffset }   (server replied 308 — resume from offset)
 *   { kind: "session-expired" }
 *   { kind: "error", error, timedOut? }
 */
export function uploadFromOffset(sessionUrl, blob, startByte, totalSize, opts = {}) {
  const { stallMs = STALL_TIMEOUT_MS, onProgress, onAbortHandle } = opts;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stallTimer = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      resolve(v);
    };
    const armStallWatchdog = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try { xhr.abort(); } catch {}
        done({ kind: "error", error: `No upload progress for ${Math.round(stallMs / 1000)}s`, timedOut: true });
      }, stallMs);
    };

    try {
      xhr.open("PUT", sessionUrl, true);
    } catch (e) {
      return done({ kind: "error", error: `Open failed: ${e?.message || e}` });
    }
    xhr.setRequestHeader("Content-Range", `bytes ${startByte}-${totalSize - 1}/${totalSize}`);

    // Hand the caller a way to kill this request from the outside. Without
    // this, "Force Restart" could only start a NEW upload alongside the stuck
    // one — the zombie XHR kept streaming to the same Drive session, and two
    // concurrent PUTs to one resumable session wedge it server-side.
    if (onAbortHandle) onAbortHandle(() => { try { xhr.abort(); } catch {} });

    xhr.upload.onprogress = (e) => {
      armStallWatchdog();
      if (onProgress && e.lengthComputable) onProgress(startByte + e.loaded);
    };

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
        return done({ kind: "ok-progress", nextOffset: m ? parseInt(m[1], 10) + 1 : startByte });
      }
      if (status === 404 || status === 410) return done({ kind: "session-expired" });
      done({ kind: "error", error: `HTTP ${status}: ${(xhr.responseText || "").slice(0, 200)}` });
    };
    xhr.onerror = () => done({ kind: "error", error: "Network error during upload" });
    xhr.onabort = () => done({ kind: "error", error: "Upload aborted" });

    armStallWatchdog();
    try { xhr.send(blob); }
    catch (e) { done({ kind: "error", error: `Send failed: ${e?.message || e}` }); }
  });
}

/**
 * Query a resumable session for current byte offset.
 * Returns: number (next byte to upload) | "complete" | "dead" | "network"
 *
 * "dead" vs "network" matters enormously and used to be conflated (both
 * returned null): a fetch that failed because the phone briefly had no
 * connectivity (call came in, iOS suspended the app, cell handoff) was
 * reported identically to Drive explicitly saying 404/410 session-gone.
 * The queue treated both as "session dead" — threw away every byte already
 * uploaded, reset to 0, and started a brand-new session. On a field phone
 * where interruptions are constant, that meant uploads endlessly restarting
 * from scratch and never finishing. Only an explicit 404/410 means dead;
 * every failure to get an answer is "network" (unknown — retry later,
 * KEEPING the session and its bytes).
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
    return "network";
  }
  clearTimeout(timeoutId);

  if (res.status === 200 || res.status === 201) return "complete";
  if (res.status === 308) {
    const range = res.headers.get("Range");
    if (!range) return 0;
    const m = range.match(/bytes=0-(\d+)/);
    return m ? parseInt(m[1], 10) + 1 : 0;
  }
  if (res.status === 404 || res.status === 410) return "dead";
  // Unexpected status (5xx etc.) — treat as transient, not as session loss.
  return "network";
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
 * Look up a file's current name/mimeType and Drive's own processing
 * signals — used by the repair sweep to detect files that uploaded without
 * a recognizable extension/mimeType, and to tell whether Drive has actually
 * transcoded the file as a video at all.
 */
export async function getDriveFileMeta(token, fileId) {
  try {
    const res = await fetch(
      `${DRIVE_API}/files/${fileId}?fields=name,mimeType,size,hasThumbnail,videoMediaMetadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Sniff a file's real container format from its first bytes, rather than
 * trusting Drive's stored mimeType — old uploads sent a malformed
 * codecs-qualified Content-Type that Drive sometimes mis-recorded (e.g. a
 * WebM file stored with mimeType "video/mp4"), so the metadata field isn't
 * reliable for already-uploaded files. WebM/Matroska starts with the EBML
 * magic bytes 1A 45 DF A3; ISO base media (mp4/mov) has "ftyp" at offset 4.
 * Returns "webm" | "mp4" | null (unrecognized).
 *
 * Reads via the response body stream (no Range header) — Range isn't
 * CORS-safelisted, so adding it forces a preflight the Drive media endpoint
 * doesn't satisfy, which silently fails the fetch from a browser. Reading
 * one chunk off the stream and cancelling it avoids that without pulling
 * the whole file.
 */
export async function sniffDriveFileFormat(token, fileId) {
  try {
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    const buf = value || new Uint8Array();
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "mp4";
    return null;
  } catch {
    return null;
  }
}

/**
 * Rename a Drive file. Metadata-only — never touches file content.
 *
 * Note: `mimeType` is intentionally NOT settable here. Drive's API ignores
 * a mimeType change sent via a plain metadata PATCH for non-Google-Apps
 * files — confirmed empirically (before/after both stayed
 * "application/octet-stream" despite the PATCH succeeding). The only way
 * to actually change a binary file's mimeType is to re-upload its content
 * with the correct Content-Type — see fixDriveFileContentType below.
 */
export async function renameDriveFile(token, fileId, newName) {
  try {
    const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Initialize a resumable session to replace an EXISTING file's content,
 * mirroring initDriveSession but PATCHing the existing fileId instead of
 * creating a new one. This is the only way to correct a stale mimeType on
 * a binary file already in Drive (see renameDriveFile's note above).
 */
async function initDriveUpdateSession(token, fileId, size, mime) {
  const cleanMime = (mime || "video/mp4").split(";")[0];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=resumable`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Upload-Content-Type": cleanMime,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ mimeType: cleanMime }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") return { ok: false, error: "Session init timeout" };
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
 * Re-upload a Drive file's existing bytes back to the SAME file ID with
 * the correct Content-Type, so Drive actually corrects its stored
 * mimeType (a plain metadata PATCH can't do this — see renameDriveFile).
 * Downloads the current content, then sends it right back via the
 * resumable update session above. Same fileId, same shareable link, same
 * bytes — only the declared content type changes, which is what lets
 * Drive's preview/thumbnail pipeline recognize the file as video.
 */
export async function fixDriveFileContentType(token, fileId, mime, onProgress) {
  let blob;
  try {
    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    blob = await res.blob();
  } catch {
    return false;
  }
  const init = await initDriveUpdateSession(token, fileId, blob.size, mime);
  if (!init.ok) return false;
  const result = await uploadFromOffset(init.sessionUrl, blob, 0, blob.size, { onProgress });
  return result.kind === "ok-final";
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

// Dedicated domain for client-facing share links. Generic shared hosting
// domains like *.netlify.app get false-positive "malicious" flags from
// email security scanners (e.g. Microsoft Defender Safe Links) because
// they're used by countless unrelated sites. A domain we own has its own
// clean reputation. Same Netlify site serves both — this only changes
// what hostname goes into the link clients receive.
const SHARE_ORIGIN = "https://projectvideoreview.app";

/**
 * Build the canonical shareable URL we save to cards: our own /watch page,
 * not a Drive link. Drive's /preview iframe frequently shows "No preview
 * available" for webm/mp4 uploads, so clients need a page we control that
 * streams the file through the video-stream edge function instead.
 */
export function buildShareUrl(fileId) {
  return `${SHARE_ORIGIN}/watch/${fileId}`;
}

/**
 * Build the direct stream URL for in-app <video src=...> elements (the
 * card detail preview). Same edge function the /watch page uses.
 */
export function buildStreamUrl(fileId) {
  return `/api/video-stream?id=${fileId}`;
}
