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

const TILE = 256;
const MAX_Z = 20;              // Esri imagery is reliable through ~20
const TILE_URL = (z, x, y) =>
  `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// ── Web Mercator ────────────────────────────────────────────────────────────
function project(lat, lng, z) {
  const world = TILE * Math.pow(2, z);
  const x = ((lng + 180) / 360) * world;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  return { x, y };
}

function boundsOf(points) {
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  return {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lngs), west: Math.min(...lngs),
  };
}

// Largest zoom at which the padded bounds still fit inside the map square.
function fitZoom(b, mapPx) {
  for (let z = MAX_Z; z >= 1; z--) {
    const a = project(b.north, b.west, z);
    const c = project(b.south, b.east, z);
    if (Math.abs(c.x - a.x) <= mapPx && Math.abs(c.y - a.y) <= mapPx) return z;
  }
  return 1;
}

function loadImg(src, cors = false) {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
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
 * @returns {Promise<string|null>} JPEG dataUrl, or null if there's nothing to draw
 */
export async function buildCalloutMap({ pins = [], photos = [], parcelPaths = [], meta = {} }) {
  const located = pins.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!located.length) return null;

  // ── Layout ────────────────────────────────────────────────────────────────
  const W = 2200, H = 2200;
  const MAP = 1120;                                  // map square edge
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
  located.forEach((p) => {
    const photo = p.photoId ? photos.find(ph => (ph.id || ph.ts) === p.photoId) : null;
    const at = toCanvas(p.lat, p.lng);
    (photo && (photo.dataUrl || photo.url) ? withPhoto : noPhoto).push({ pin: p, photo, at });
  });

  const CAP = { top: 3, bottom: 3, left: 4, right: 4 };
  const sides = { top: [], bottom: [], left: [], right: [] };
  const preferred = (at) => {
    const dx = at.x - cx, dy = at.y - cy;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
  };
  const order = ["left", "right", "top", "bottom"];
  withPhoto
    .sort((a, b2) => a.at.y - b2.at.y)
    .forEach((item) => {
      let side = preferred(item.at);
      if (sides[side].length >= CAP[side]) {
        side = order.find(s => sides[s].length < CAP[s]) || side; // spill to any free side
      }
      sides[side].push(item);
    });

  // Sort along each side so lines run roughly parallel instead of tangling.
  sides.left.sort((a, b2) => a.at.y - b2.at.y);
  sides.right.sort((a, b2) => a.at.y - b2.at.y);
  sides.top.sort((a, b2) => a.at.x - b2.at.x);
  sides.bottom.sort((a, b2) => a.at.x - b2.at.x);

  // Slot geometry for each side
  const slotFor = (side, i, n) => {
    if (side === "left" || side === "right") {
      const x = side === "left" ? 40 : W - 40 - CW;
      const span = H - 260, step = Math.min(CH + 26, span / Math.max(n, 1));
      const startY = (H - (step * n - (step - CH))) / 2 + 20;
      return { x, y: startY + i * step };
    }
    const y = side === "top" ? 132 : H - 40 - CH;
    const span = MAP + 120, step = Math.min(CW + 24, span / Math.max(n, 1));
    const startX = cx - (step * n - (step - CW)) / 2;
    return { x: startX + i * step, y };
  };

  // ── Draw callouts (photo card + leader line + matching number) ────────────
  let num = 0;
  const drawn = [];
  for (const side of order) {
    const list = sides[side];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      num++;
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

      drawn.push({ ...item, num });

      // Card
      ctx.fillStyle = "#f4f6fa";
      roundRect(ctx, x, y, CW, CH, 12); ctx.fill();

      // Photo (loaded one at a time — never all full-size photos at once)
      const src = item.photo.dataUrl || item.photo.url;
      const img = await loadImg(src, !item.photo.dataUrl);
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
  const pinDot = (at, n, color) => {
    ctx.beginPath(); ctx.arc(at.x, at.y, 20, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#1a1400";
    ctx.font = "700 22px Oswald, Arial, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), at.x, at.y + 1);
  };
  drawn.forEach(d => pinDot(d.at, d.num, "#F6BF26"));
  // Points with no photo still belong on the plan — they're trees you pinned.
  noPhoto.forEach(d => pinDot(d.at, "\u2022", "#4c9aff"));

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

  return canvas.toDataURL("image/jpeg", 0.92);
}
