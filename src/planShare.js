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
export async function createPlanLink(token, payload, id) {
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
    body: JSON.stringify(id ? { ...payload, id } : payload),
  });
  if (res.status === 401) throw new Error("Sign in to Google again, then try sharing.");
  if (res.status === 409) throw new Error("That link id was already taken — tap Link again.");
  if (!res.ok) throw new Error("Couldn't create the share link — try again.");
  const { id: savedId } = await res.json();
  if (!savedId) throw new Error("Couldn't create the share link — try again.");
  return `${SHARE_ORIGIN}/plan/${savedId}`;
}

/* ── One-tap copy ───────────────────────────────────────────────────────────
   Copy the crew link so that pasting it reads "Live Map Site Plan" with the
   link right under it.

   This used to put TWO versions on the clipboard — an HTML one with the
   address hidden behind the words "Live Map Site Plan", plus plain text — and
   to wait for the server to create the link before copying. Both went wrong:
     • Apps that took the HTML version pasted just the words. A text message
       can't carry a hidden link, so the crew got a label with no link.
     • iOS only allows a copy during the tap itself. Waiting for the server
       (a few seconds when it's cold) often outlived the tap, and the copy was
       quietly refused.
   So now the link's id is made on the phone, the full address is known the
   moment the button is tapped, and it is copied right then as plain text. The
   server then stores the plan under that id. */
export const PLAN_LINK_LABEL = "Live Map Site Plan";

/** A random id for a new plan: 20 URL-safe characters (120 bits). */
export function newPlanId() {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const planUrlFor = (id) => `${SHARE_ORIGIN}/plan/${id}`;

/** The text that lands on the clipboard. Plain text, so every app — Messages,
 *  SMS to an Android phone, email — turns the address into a tappable link. */
export const planLinkText = (url) => `${PLAN_LINK_LABEL}\n${url}`;

/** Copy, synchronously inside the tap. Returns a promise for whether it worked. */
export function copyPlanText(url) {
  try {
    const p = navigator.clipboard?.writeText(planLinkText(url));
    return p ? p.then(() => true, () => false) : Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}
