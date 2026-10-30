/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Image Utilities
   ───────────────────────────────────────────────────────────────────────────
   Photos captured by the in-app camera arrive at full sensor resolution (up to
   4K). Stored raw as base64 they (a) decode to ~33 MB bitmaps and quickly OOM
   the renderer when several are shown at once, and (b) bloat the field JSON so
   Drive sync fails. `downscaleDataUrl` caps the longest edge and re-encodes,
   matching the file-picker path's 2400px / q0.82 budget (~700 KB base64).
   ═══════════════════════════════════════════════════════════════════════════ */

// Bumped from 2400px/q0.82 to 3200px/q0.88 so field photos carry more detail
// and print sharper when dropped into a SingleOps proposal page. A 3200px q0.88
// JPEG is typically ~1.5–2.5 MB base64 (vs ~700–900 KB before). Photos are
// uploaded to Drive individually and their in-JSON dataUrl is evicted after
// upload, so the larger size doesn't permanently bloat the field record.
export const PHOTO_MAX_DIM = 3200;
export const PHOTO_QUALITY = 0.88;
// base64 length above which a photo is considered oversized and worth a
// downscale pass. Raised in step with the bigger capture budget so a normal
// new 3200px/q0.88 photo isn't needlessly re-decoded every sync; genuinely
// huge legacy 4K originals (> ~3 MB base64) still get shrunk to the cap.
export const OVERSIZE_DATAURL_LEN = 3_200_000;

/** The picture a photo TILE should show.
 *  - A thumbnail rebuilt after markup (thumbMarked) is always current.
 *  - Once uploaded, the Drive copy is the latest version (marks included);
 *    an older thumbnail may predate marks made before thumbnails were
 *    refreshed on save, so the Drive copy wins.
 *  - Not uploaded yet (e.g. just taken): the small thumbnail — drawing several
 *    full-size local photos as tiles is what used to freeze the phone — unless
 *    the photo was marked up with no fresh thumbnail, then the photo itself. */
export function tileSrc(p) {
  if (!p) return "";
  if (p.thumb && p.thumbMarked) return p.thumb;
  if (p.url) return p.url;
  if (p.originalDataUrl) return p.dataUrl || p.thumb || "";
  return p.thumb || p.dataUrl || "";
}

/** makeThumb for a stored photo (data: URL) — decodes it first. Resolves null on failure. */
export function thumbFromDataUrl(dataUrl, max = 360) {
  return new Promise((resolve) => {
    if (!dataUrl || !String(dataUrl).startsWith("data:image")) { resolve(null); return; }
    const img = new Image();
    const t = setTimeout(() => resolve(null), 15000);
    img.onload = () => { clearTimeout(t); resolve(makeThumb(img, max)); try { img.src = ""; } catch {} };
    img.onerror = () => { clearTimeout(t); resolve(null); };
    img.src = dataUrl;
  });
}

// A small JPEG for photo tiles. Tiles used to draw the full 3200px photo, so
// opening a card after a burst of shots made the phone decode every one of
// them at full size at once (~20 MB each) — enough to freeze it. ~15 KB each.
export function makeThumb(source, max = 360) {
  try {
    const w = source.width || source.naturalWidth, h = source.height || source.naturalHeight;
    if (!w || !h) return null;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    const out = c.toDataURL("image/jpeg", 0.72);
    c.width = 0; c.height = 0;
    return out;
  } catch { return null; }
}

// ── PHOTO IDENTITY ───────────────────────────────────────────────────────────
// Every photo gets a globally-unique `id` at creation. This is the PRIMARY
// merge/dedup key everywhere photos are unioned (hydration, cross-device pull,
// upload writeback). Before this, photos were keyed only by `ts` (Date.now()),
// so two photos created in the same millisecond — easy to hit when importing
// several library images at once, or bursting the camera — collided and one was
// silently dropped on the next merge. `id` is stored in the photo object and
// travels with it through IDB and Drive JSON, so it's stable across devices.
export function newPhotoId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Stable key for a photo. Prefers the unique id; falls back to ts/url/dataUrl
// for legacy photos created before ids existed. The same expression must be
// used on both sides of any merge so keys line up.
export function photoKey(p) {
  return (p && (p.id || p.ts || p.url || p.dataUrl)) || null;
}

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
    // A decode that never fires either handler would hang whatever is awaiting
    // this — and this runs inside the photo upload pass, where one hung await
    // used to freeze the whole queue. Give up and hand back the original.
    const timer = setTimeout(() => { try { img.src = ""; } catch {} resolve(dataUrl); }, 15000);
    img.onload = () => {
      clearTimeout(timer);
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
    img.onerror = () => { clearTimeout(timer); resolve(dataUrl); };
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
