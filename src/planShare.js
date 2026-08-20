/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Share a site plan with the crew
   ───────────────────────────────────────────────────────────────────────────
   Turns a card's pins + photos into the small public payload behind a
   /plan/:id link, and creates that link.
   ═══════════════════════════════════════════════════════════════════════════ */

import { SHARE_ORIGIN } from "./driveUpload";

/**
 * Build the public payload.
 *
 * Only a photo with a PUBLIC Drive `url` can be included — a local `dataUrl`
 * exists solely on Jason's phone, so a crew member's browser could never load
 * it. Photos get that url when photoSync uploads them (driveSync's
 * uploadPhotoToDrive already grants "anyone with the link" read access).
 *
 * Returns { payload, pendingPhotos } where pendingPhotos counts pins whose
 * photo hasn't finished uploading yet, so the UI can warn before sharing.
 */
export function buildPlanPayload({ pins = [], photos = [], parcelPaths = [], stop = {} }) {
  const located = pins.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const photoFor = (p) => (p.photoId ? photos.find(ph => (ph.id || ph.ts) === p.photoId) : null);

  let pendingPhotos = 0;
  const outPins = located.map((p, i) => {
    const ph = photoFor(p);
    // A Drive-hosted url is the only thing an outsider can load.
    const publicUrl = ph && typeof ph.url === "string" && /^https?:\/\//.test(ph.url) ? ph.url : null;
    if (ph && !publicUrl) pendingPhotos++;
    return {
      n: i + 1,
      lat: +p.lat.toFixed(7),
      lng: +p.lng.toFixed(7),
      ...(p.label ? { label: p.label } : {}),
      ...(publicUrl ? { photo: publicUrl } : {}),
    };
  });

  return {
    payload: {
      v: 1,
      client: stop.cn || "",
      address: stop.addr || "",
      pins: outPins,
      // Trim the boundary: full parcel rings can be hundreds of points and the
      // crew only needs the shape.
      parcel: (parcelPaths || [])
        .filter(r => r?.length)
        .map(ring => ring.map(pt => ({ lat: +pt.lat.toFixed(6), lng: +pt.lng.toFixed(6) }))),
    },
    pendingPhotos,
  };
}

/** POST the payload and return the public link. Throws with a friendly message. */
export async function createPlanLink(token, payload) {
  // Prefer the token currently in storage over whatever was captured in props:
  // a background silent-reauth may have replaced it, and sending the stale one
  // is what produced spurious "sign in again" failures.
  let best = token;
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) best = saved.token;
  } catch {}
  const res = await fetch("/api/plan", {
    method: "POST",
    // Send the first-party session cookie too, so the server can fall back to
    // it when the access token is expired or unverifiable.
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(best ? { Authorization: `Bearer ${best}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new Error("Sign in to Google again, then try sharing.");
  if (!res.ok) throw new Error("Couldn't create the share link — try again.");
  const { id } = await res.json();
  if (!id) throw new Error("Couldn't create the share link — try again.");
  return `${SHARE_ORIGIN}/plan/${id}`;
}
