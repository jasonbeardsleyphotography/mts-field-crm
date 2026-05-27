/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Image Utilities
   ───────────────────────────────────────────────────────────────────────────
   Photos captured by the in-app camera arrive at full sensor resolution (up to
   4K). Stored raw as base64 they (a) decode to ~33 MB bitmaps and quickly OOM
   the renderer when several are shown at once, and (b) bloat the field JSON so
   Drive sync fails. `downscaleDataUrl` caps the longest edge and re-encodes,
   matching the file-picker path's 2400px / q0.82 budget (~700 KB base64).
   ═══════════════════════════════════════════════════════════════════════════ */

export const PHOTO_MAX_DIM = 2400;
export const PHOTO_QUALITY = 0.82;
// base64 length above which a photo is considered oversized and worth a
// downscale pass. A 2400px q0.82 JPEG is typically < 900 KB; 4K q0.9 is 2–4 MB.
export const OVERSIZE_DATAURL_LEN = 1_200_000;

// Downscale a base64 image dataUrl so its longest edge is <= max. Returns the
// original string unchanged if it's already within bounds or can't be decoded.
// Memory-safe: decodes one image, draws to a small canvas, releases.
export function downscaleDataUrl(dataUrl, max = PHOTO_MAX_DIM, quality = PHOTO_QUALITY) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image")) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w <= max && h <= max) { resolve(dataUrl); return; } // already small enough
      if (w > max) { h = h * max / w; w = max; }
      if (h > max) { w = w * max / h; h = max; }
      try {
        const c = document.createElement("canvas");
        c.width = Math.round(w); c.height = Math.round(h);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Strip the heavy base64 `dataUrl` from a field's photo arrays, preserving
// every other field and the array lengths (so photo counts stay correct).
// Used to keep the in-memory peek mirror light — it only needs metadata.
export function stripPhotoDataUrls(field) {
  if (!field || typeof field !== "object") return field;
  const strip = (arr) => Array.isArray(arr)
    ? arr.map(p => { if (p && p.dataUrl) { const { dataUrl, ...rest } = p; return rest; } return p; })
    : arr;
  const out = { ...field };
  if (out.scopePhotos) out.scopePhotos = strip(out.scopePhotos);
  if (out.addonPhotos) out.addonPhotos = strip(out.addonPhotos);
  if (out.photos)      out.photos      = strip(out.photos);
  return out;
}
