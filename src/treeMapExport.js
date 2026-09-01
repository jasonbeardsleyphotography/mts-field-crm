/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Tree Map Export (callout site plan)
   ───────────────────────────────────────────────────────────────────────────
   Renders a shareable site plan: a square satellite map in the middle, the
   job's photos arranged around the outside, and a leader line from each photo
   to the exact spot on the map where it was taken. Keeping the photos OUTSIDE
   the map is the whole point — thumbnails sitting on top of the map bury the
   property you're trying to show.

   Everything is drawn into a canvas we control rather than screen-captured.
   html2canvas cannot rasterize Google's WebGL tile surface (it comes out
   blank), so this fetches map tiles directly and composites them. Tiles come
   from Esri World Imagery — the same free, key-less source the map view
   already offers, so this export costs nothing per use.
   ═══════════════════════════════════════════════════════════════════════════ */

import { TILE, TILE_URL, project, boundsOf, fitZoom } from "./tileMath";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadImg(src, cors = false, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const img = new Image();
    // A request that never settles would hang the whole export, since photos
    // and tiles are loaded sequentially. Give up and let the retry decide.
    const timer = setTimeout(() => { img.src = ""; resolve(null); }, timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = src;
  });
}

/* ── loadPhoto ──────────────────────────────────────────────────────────────
   Get a photo onto the canvas, or admit it couldn't.

   Grey boxes on roughly half of exports came from this being a single
   attempt at one URL. Two things go wrong with a Drive thumbnail:

     • Drive throttles a burst of thumbnail requests and answers 403. One
       `onerror` and the photo was grey forever, with no retry.
     • The canvas needs crossOrigin="anonymous", so the export depends on
       Drive returning CORS headers on that redirect chain — which it does
       not do reliably. (It has to be anonymous: drawing a non-CORS image
       taints the canvas and makes toDataURL throw, which would lose the
       ENTIRE plan rather than one photo.)

   So: the local copy if there is one, then the thumbnail with retries and a
   cache-buster, and finally an authenticated Drive download turned into a
   blob URL — which is same-origin as far as the canvas is concerned and so
   cannot fail on CORS at all. Cheapest path first; the guaranteed one last. */
async function loadPhoto(photo, token) {
  // 1. The local capture. No network, so nothing to fail.
  if (photo.dataUrl) {
    const img = await loadImg(photo.dataUrl);
    if (img) return img;
  }
  const url = photo.url;
  if (!url) return null;

  // 2. The public thumbnail, retried. The cache-buster matters: without it the
  //    browser re-serves its own cached failure instead of re-requesting.
  for (let attempt = 0; attempt < 3; attempt++) {
    const src = attempt === 0
      ? url
      : url + (url.includes("?") ? "&" : "?") + "_r=" + attempt;
    const img = await loadImg(src, true);
    if (img) return img;
    await sleep(400 * (attempt + 1));
  }

  // 3. Authenticated download. Slower and heavier — it fetches the original,
  //    not a rendition — but it is the path that cannot be refused for CORS,
  //    so it is what turns "sometimes grey" into "always there".
  const fileId = (url.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
                  url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/))?.[1];
  if (!fileId || !token) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let blobUrl = null;
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        blobUrl = URL.createObjectURL(await res.blob());
        const img = await loadImg(blobUrl);
        // Held until well after the draw; revoking immediately can race the
        // decode on Safari.
        setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 60000);
        if (img) return img;
      } else if (res.status === 401 || res.status === 404) {
        return null;   // a dead token or a deleted file won't get better
      }
      // A 403 here is usually Drive rate-limiting, not a permission problem —
      // that is precisely the case worth retrying.
    } catch { /* network — worth one more go */ }
    await sleep(600 * (attempt + 1));
  }
  return null;
}

/** The freshest access token available: a silent reauth may have replaced the
 *  one captured in props while the card sat open. Same rule planShare uses. */
function freshToken(token) {
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
  } catch {}
  return token;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Build the callout site plan.
 *
 * @param {Array}  pins        [{ id, lat, lng, photoId, label, source }]
 * @param {Array}  photos      [{ id, ts, dataUrl, url }]
 * @param {Array}  parcelPaths [[{lat,lng}, ...], ...] property boundary rings
 * @param {Object} meta        { client, address, date }
 * @param {string} token       Google access token, for the authenticated photo
 *                             fallback. Optional, but without it a photo whose
 *                             thumbnail is being throttled has no way through.
 * @returns {Promise<{dataUrl: string, missing: number}|null>} the JPEG and how
 *          many photos could not be loaded, or null if there's nothing to draw
 */
export async function buildCalloutMap({ pins = [], photos = [], parcelPaths = [], meta = {}, token = null }) {
  const auth = freshToken(token);
  let missing = 0;
  const real = pins.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  // A photo that carries its own position but has no pin of its own still
  // belongs on the plan — e.g. it was captured before pins existed, or its pin
  // was removed. Synthesise a point for it so no located photo is left out.
  const pinnedPhotoIds = new Set(real.filter(p => p.photoId).map(p => p.photoId));
  const orphans = (photos || [])
    .filter(ph => ph?.geo && Number.isFinite(ph.geo.lat) && Number.isFinite(ph.geo.lng)
                  && !pinnedPhotoIds.has(ph.id || ph.ts))
    .map(ph => ({
      id: `photo_${ph.id || ph.ts}`, lat: ph.geo.lat, lng: ph.geo.lng,
      acc: ph.geo.acc, photoId: ph.id || ph.ts, source: "photo", ts: ph.ts || 0,
    }));
  const located = [...real, ...orphans];
  if (!located.length) return null;

  // ── Layout ────────────────────────────────────────────────────────────────
  // Work out up front how many points actually have a photo, because the map
  // only needs to leave room around itself for callouts that exist. A plan of
  // bare pins gets a big map instead of a small one floating in dead space.
  const photoFor = (p) => (p.photoId ? (photos || []).find(ph => (ph.id || ph.ts) === p.photoId) : null);
  const calloutCount = located.filter(p => { const ph = photoFor(p); return !!(ph && (ph.dataUrl || ph.url)); }).length;

  const W = 2200, H = 2200;
  const MAP = calloutCount ? 1120 : 1960;            // map square edge
  const MX = (W - MAP) / 2, MY = (H - MAP) / 2 + 40; // map origin (nudged for the title)
  const CW = 380, CH = 300;                          // callout card size

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d1017"; ctx.fillRect(0, 0, W, H);

  // ── Map projection for this view ──────────────────────────────────────────
  const b = boundsOf(located);
  // Pad so no pin sits on the very edge; also guarantees a sane span when every
  // pin is nearly on top of the next (a single tree, or a tight cluster).
  const padLat = Math.max((b.north - b.south) * 0.35, 0.00035);
  const padLng = Math.max((b.east - b.west) * 0.35, 0.00045);
  const padded = {
    north: b.north + padLat, south: b.south - padLat,
    east: b.east + padLng, west: b.west - padLng,
  };
  const z = fitZoom(padded, MAP);
  const centre = { lat: (padded.north + padded.south) / 2, lng: (padded.east + padded.west) / 2 };
  const cPx = project(centre.lat, centre.lng, z);
  const originX = cPx.x - MAP / 2, originY = cPx.y - MAP / 2;
  const toCanvas = (lat, lng) => {
    const p = project(lat, lng, z);
    return { x: MX + (p.x - originX), y: MY + (p.y - originY) };
  };

  // ── Satellite tiles ───────────────────────────────────────────────────────
  ctx.save();
  roundRect(ctx, MX, MY, MAP, MAP, 10);
  ctx.clip();
  ctx.fillStyle = "#1b2430"; ctx.fillRect(MX, MY, MAP, MAP);
  let tilesDrawn = 0, tilesTried = 0;
  const x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + MAP) / TILE);
  const y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + MAP) / TILE);
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      // Sequential on purpose: a burst of parallel tile decodes is a memory
      // spike on a phone that's already holding full-size photos.
      tilesTried++;
      const img = await loadImg(TILE_URL(z, tx, ty), true);
      if (!img) continue;
      tilesDrawn++;
      ctx.drawImage(img, MX + (tx * TILE - originX), MY + (ty * TILE - originY), TILE, TILE);
    }
  }

  // Every tile failing means imagery was unreachable (offline, or the tile host
  // refused the cross-origin read). Fail loudly rather than handing back a plan
  // with an empty square where the property should be.
  if (tilesTried > 0 && tilesDrawn === 0) {
    ctx.restore();
    throw new Error("map-imagery-unavailable");
  }

  // ── Parcel boundary ───────────────────────────────────────────────────────
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,214,0,.85)";
  ctx.setLineDash([10, 7]);
  for (const ring of parcelPaths) {
    if (!ring?.length) continue;
    ctx.beginPath();
    ring.forEach((pt, i) => {
      const c = toCanvas(pt.lat, pt.lng);
      i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Map frame
  ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 2;
  roundRect(ctx, MX, MY, MAP, MAP, 10); ctx.stroke();

  // ── Assign each pin to a side ─────────────────────────────────────────────
  // Photos go on the side of the map their pin is nearest, so leader lines stay
  // short and mostly avoid crossing each other.
  const cx = MX + MAP / 2, cy = MY + MAP / 2;
  const withPhoto = [], noPhoto = [];
  // Number by POSITION IN THE PIN LIST, not by the order cards happen to be
  // drawn around the ring. The app and the crew viewer both number pins by
  // list position, and a tree labelled "3" on screen must be "3" on the plan
  // you hand the crew.
  located.forEach((p, idx) => {
    const photo = photoFor(p);
    const at = toCanvas(p.lat, p.lng);
    (photo && (photo.dataUrl || photo.url) ? withPhoto : noPhoto).push({ pin: p, photo, at, num: idx + 1 });
  });

  // Order callouts around the map as a RING. Sorting by angle and then spilling
  // to the NEXT SIDE CLOCKWISE keeps the callouts in the same rotational order
  // as their pins, which is what stops leader lines from crossing. (The old
  // code sent overflow to whichever side had room — usually the left — so a pin
  // on the right could end up with a card on the left, dragging its line across
  // everything else.)
  const SIDES = ["top", "right", "bottom", "left"];
  const CAP = { top: 4, right: 5, bottom: 4, left: 5 };
  const sides = { top: [], right: [], bottom: [], left: [] };
  // Angle measured clockwise from straight up, so it matches the ring order.
  const angleOf = (at) => (Math.atan2(at.x - cx, -(at.y - cy)) * 180 / Math.PI + 360) % 360;
  const sideOfAngle = (t) => (t < 45 || t >= 315) ? "top" : t < 135 ? "right" : t < 225 ? "bottom" : "left";

  withPhoto
    .map(it => ({ ...it, angle: angleOf(it.at) }))
    .sort((a, b2) => a.angle - b2.angle)
    .forEach((item) => {
      let side = sideOfAngle(item.angle);
      for (let g = 0; sides[side].length >= CAP[side] && g < 4; g++) {
        side = SIDES[(SIDES.indexOf(side) + 1) % 4]; // next side clockwise
      }
      sides[side].push(item);
    });

  // Slots follow the same clockwise ring: top runs left->right, right top->
  // bottom, bottom right->left, left bottom->top. Because the lists above are
  // already in angular order, index 0 is simply the first slot along that path.
  const slotFor = (side, i, n) => {
    const M = 40;
    if (side === "top" || side === "bottom") {
      const y = side === "top" ? 128 : H - M - CH;
      const step = Math.min(CW + 20, (W - 2 * M) / Math.max(n, 1));
      const startX = (W - (step * (n - 1) + CW)) / 2;
      const idx = side === "top" ? i : (n - 1 - i);   // bottom runs right->left
      return { x: startX + idx * step, y };
    }
    const x = side === "left" ? M : W - M - CW;
    const step = Math.min(CH + 20, (H - 240) / Math.max(n, 1));
    const startY = (H - (step * (n - 1) + CH)) / 2 + 30;
    const idx = side === "right" ? i : (n - 1 - i);   // left runs bottom->top
    return { x, y: startY + idx * step };
  };

  // ── Draw callouts (photo card + leader line + matching number) ────────────
  const drawn = [];
  for (const side of SIDES) {
    const list = sides[side];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const num = item.num;
      const { x, y } = slotFor(side, i, list.length);
      const imgH = CH - 46;

      // Leader line: from the card edge facing the map, to the pin.
      const anchor = {
        x: side === "left" ? x + CW : side === "right" ? x : x + CW / 2,
        y: side === "top" ? y + CH : side === "bottom" ? y : y + CH / 2,
      };
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(item.at.x, item.at.y);
      ctx.stroke();
      // Halo so the line stays readable over bright imagery
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.lineWidth = 5;
      ctx.globalCompositeOperation = "destination-over";
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(item.at.x, item.at.y);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";

      drawn.push(item);

      // Card
      ctx.fillStyle = "#f4f6fa";
      roundRect(ctx, x, y, CW, CH, 12); ctx.fill();

      // Photo (loaded one at a time — never all full-size photos at once)
      const img = await loadPhoto(item.photo, auth);
      if (!img) missing++;
      ctx.save();
      roundRect(ctx, x + 10, y + 10, CW - 20, imgH, 8); ctx.clip();
      if (img) {
        const s = Math.max((CW - 20) / img.width, imgH / img.height);
        const dw = img.width * s, dh = img.height * s;
        ctx.drawImage(img, x + 10 + (CW - 20 - dw) / 2, y + 10 + (imgH - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = "#c8cfda"; ctx.fillRect(x + 10, y + 10, CW - 20, imgH);
      }
      ctx.restore();

      // Number badge on the card
      ctx.fillStyle = "#F6BF26";
      ctx.beginPath(); ctx.arc(x + 34, y + 34, 21, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1a1400";
      ctx.font = "700 24px Oswald, Arial, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(num), x + 34, y + 35);

      // Label
      ctx.fillStyle = "#1a2030";
      ctx.font = "600 21px 'DM Sans', Arial, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      const label = item.pin.label || `Photo ${num}`;
      const maxW = CW - 24;
      let text = label;
      while (ctx.measureText(text).width > maxW && text.length > 4) text = text.slice(0, -2);
      if (text !== label) text = text.slice(0, -1) + "…";
      ctx.fillText(text, x + 12, y + CH - 14);
    }
  }

  // ── Pins on the map (drawn last so they sit above the leader lines) ───────
  // Deliberately tiny: the point is to mark the spot precisely, not to cover
  // it. The number lives on the callout card and the leader line does the
  // matching, so repeating it here just obscured the tree underneath.
  const pinDot = (at, color) => {
    ctx.beginPath(); ctx.arc(at.x, at.y, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
  };
  drawn.forEach(d => pinDot(d.at, "#F6BF26"));
  // Points with no photo still belong on the plan — they're trees you pinned.
  noPhoto.forEach(d => pinDot(d.at, "#4c9aff"));

  // ── Title block ───────────────────────────────────────────────────────────
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 46px Oswald, Arial, sans-serif";
  ctx.fillText((meta.client || "Site Plan").toUpperCase(), 40, 72);
  ctx.fillStyle = "#93a2b8";
  ctx.font = "500 26px 'DM Sans', Arial, sans-serif";
  ctx.fillText([meta.address, meta.date].filter(Boolean).join("   ·   "), 40, 108);
  ctx.textAlign = "right";
  ctx.fillStyle = "#6b7a90";
  ctx.font = "500 20px 'DM Sans', Arial, sans-serif";
  ctx.fillText("Monster Tree Service of Rochester", W - 40, 72);
  ctx.fillText("Imagery © Esri", W - 40, 104);

  return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), missing };
}
