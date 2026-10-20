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
