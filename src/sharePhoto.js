/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Share a photo to another app
   ───────────────────────────────────────────────────────────────────────────
   Hands a photo to the phone's own share sheet, from which it can go straight
   into RealWork (or Messages, Mail, AirDrop — any app that accepts images).

   What this can and cannot do, so nobody expects more of it than it is:
     • A web app cannot open a SPECIFIC native app and push a file into it.
       There is no URL scheme that carries a photo. The share sheet is the only
       door iOS gives a web page, and RealWork has to be offering itself there
       (i.e. it has a share extension) for it to appear in the list.
     • The sheet is shown by the phone, not by us. The first time, scroll the
       app row and choose RealWork; iOS then tends to keep it near the front.

   The timing rule that shapes this file: iOS only lets a page open the share
   sheet in direct response to a tap. A photo already on the device can be
   turned into a file instantly, which keeps that tap valid. A photo that lives
   only in Drive has to be downloaded first, which can outlast the tap — so the
   caller keeps the downloaded file and the SECOND tap shares it instantly.
   ═══════════════════════════════════════════════════════════════════════════ */

/** data: URL -> File, synchronously. Deliberately not fetch(dataUrl): that is
 *  async, and every await between the tap and navigator.share() is time the
 *  tap's permission can run out in. */
export function dataUrlToFile(dataUrl, filename) {
  const [header, b64] = String(dataUrl || "").split(",");
  if (!header || !b64) throw new Error("not-a-data-url");
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

/** Save a file the ordinary way, for browsers with no share sheet. */
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Open the share sheet for one photo.
 * Resolves to one of:
 *   "shared"     — the user picked a destination
 *   "cancelled"  — the user closed the sheet
 *   "needs-tap"  — the tap's permission expired (slow download); tap again
 *   "downloaded" — this browser has no share sheet, so it was saved instead
 */
export async function sharePhotoFile(file, title = "Photo") {
  const canShare = typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    (typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] }));
  if (!canShare) { downloadFile(file); return "downloaded"; }
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (e) {
    if (e?.name === "AbortError") return "cancelled";
    if (e?.name === "NotAllowedError") return "needs-tap";
    // Anything else (a target that rejected the file, say): don't strand the
    // photo — fall back to saving it.
    downloadFile(file);
    return "downloaded";
  }
}

/** Get a card photo as a File, wherever it lives: the on-device copy if there
 *  is one (instant), otherwise Drive. A Drive-only photo uses the signed-in
 *  token when it has an id to ask for, falling back to its public URL. */
export async function photoToFile(photo, token, filename) {
  if (photo?.dataUrl) return dataUrlToFile(photo.dataUrl, filename);
  const url = photo?.url;
  if (!url) throw new Error("photo-has-no-source");
  const fileId = (url.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
                  url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/))?.[1];
  const res = fileId && token
    ? await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } })
    : await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

/** True on a touch phone or tablet that has a share sheet.
 *
 *  On iOS an ordinary download lands in the Files app, not in Photos — which is
 *  rarely where a photo is wanted. The share sheet's "Save Image" puts it in
 *  Photos. On a laptop or Chromebook a normal download is right, so this looks
 *  at the PRIMARY pointer: a phone's is touch ("coarse"), a laptop's — even one
 *  with a touchscreen — is the trackpad or mouse. */
export function prefersShareSheet() {
  try {
    return typeof navigator.share === "function" &&
      !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  } catch { return false; }
}

/** A card photo as a PNG blob, for the clipboard. Browsers only accept images
 *  on the clipboard as PNG, so the JPEG is redrawn. Capped at 2000px on the
 *  long side: plenty for a site-visit photo, and it keeps the copy quick. */
export async function photoToPngBlob(photo, token, maxDim = 2000) {
  const file = await photoToFile(photo, token, "photo.jpg");
  let src, w, h, release = () => {};
  if (typeof createImageBitmap === "function") {
    src = await createImageBitmap(file);
    w = src.width; h = src.height;
    release = () => { try { src.close?.(); } catch {} };
  } else {
    const url = URL.createObjectURL(file);
    src = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode-failed"));
      im.src = url;
    });
    w = src.naturalWidth; h = src.naturalHeight;
    release = () => URL.revokeObjectURL(url);
  }
  try {
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return await new Promise((res, rej) =>
      c.toBlob(b => (b ? res(b) : rej(new Error("png-failed"))), "image/png"));
  } finally {
    release();
  }
}

/** Put a photo on the clipboard, starting synchronously inside a tap.
 *  The PNG is still being made when this returns — the clipboard is handed a
 *  PROMISE for it, which is what lets the copy be claimed during the tap and
 *  filled in a moment later. Resolves true once the photo is on the clipboard. */
export function copyPhotoToClipboard(photo, token) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return Promise.resolve(false);
    const png = photoToPngBlob(photo, token);
    return navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      .then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}
