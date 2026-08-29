import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import {
  TILE, MAX_Z, MAX_TILE_Z, MIN_Z, TILE_URL, project, unproject, metersPerPixel, clampLat,
} from "./tileMath";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — TileMap
   ───────────────────────────────────────────────────────────────────────────
   A small, dependency-free satellite map with drag-pan, pinch-zoom, and
   draggable pins, drawn from free Esri World Imagery tiles.

   Why hand-rolled instead of Google Maps JS: the crew viewer is a public link
   that could be opened any number of times by any number of people, and the
   Maps JS API is metered per load. This costs nothing per view, forever.

   How it stays correct at any zoom: state is a float `zoom`, and BOTH the
   tiles and the markers are positioned from the same fractional-zoom world
   origin. Tiles only exist at integer zooms, so we draw the nearest integer
   level scaled by the fractional remainder — but their on-screen placement is
   still computed in fractional-zoom pixels, so a marker never drifts off its
   ground position the way it would with a CSS transform on a wrapper.

   Three things here exist specifically to make it dependable in the field:
     • every remote image retries on failure (§ RetryImg) — a truck's
       connection drops single requests constantly, and one dropped tile used
       to leave a permanent grey square;
     • leader lines are guaranteed not to cross (§ untangle) rather than
       merely usually not crossing;
     • pins have finger-sized hit targets and lift ABOVE the fingertip while
       dragging, so you can see what you are placing.
   ═══════════════════════════════════════════════════════════════════════════ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* Drive thumbnails are stored at sz=w1200. A 132px card needs nowhere near
   that, and a dozen full-size ones is real bandwidth on a truck's connection —
   ask Drive for a small rendition instead. */
const smallThumb = (url) =>
  typeof url === "string" ? url.replace(/([?&]sz=)w\d+/, "$1w400") : url;
const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid2 = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

// How far above the fingertip a pin floats while being dragged. A pin sitting
// under the finger is invisible at the exact moment you need to aim it.
const DRAG_LIFT = 52;
// How far the touch must travel before a grab counts as a drag at all, and
// over how much further travel the lift eases in. Below the slop a pin does
// not move a pixel, so tapping one to open its details never nudges it.
const DRAG_SLOP = 8;
const DRAG_RAMP = 46;

/* ── RetryImg ───────────────────────────────────────────────────────────────
   Remote images that retry instead of failing silently.

   Map tiles and Drive thumbnails both fail transiently in the field: a dropped
   request on a weak connection, or Drive briefly throttling a burst of
   thumbnail loads. A plain <img> renders that as blank grey forever. This
   retries a few times with backoff, then optionally falls back to another
   source (a local dataUrl for a photo that hasn't uploaded yet), and only then
   reports failure.

   The retry URL gets a cache-busting param because the browser will otherwise
   serve its own cached failure straight back. */
function RetryImg({ src, fallback, style, alt = "", onFail, tries = 3 }) {
  const [attempt, setAttempt] = useState(0);
  const [useFallback, setUseFallback] = useState(false);
  const [dead, setDead] = useState(false);
  const timer = useRef(null);

  // A new src is a fresh start.
  useEffect(() => {
    setAttempt(0); setUseFallback(false); setDead(false);
  }, [src, fallback]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const base = useFallback ? fallback : src;

  const fail = () => {
    if (attempt < tries) {
      // Back off a little — an instant retry usually hits the same condition.
      timer.current = setTimeout(() => setAttempt(a => a + 1), 400 * (attempt + 1));
    } else if (fallback && !useFallback) {
      setUseFallback(true); setAttempt(0);
    } else {
      setDead(true); onFail?.();
    }
  };

  if (!base || dead) return null;

  // Attempt 0 uses the plain URL so it can hit the browser cache normally;
  // later attempts must bypass it to actually re-request.
  const bust = attempt > 0 && /^https?:/.test(base)
    ? base + (base.includes("?") ? "&" : "?") + "_r=" + attempt
    : base;

  return <img key={bust} src={bust} alt={alt} draggable={false} style={style} onError={fail} />;
}

/* ── untangle ───────────────────────────────────────────────────────────────
   Guarantee that no two leader lines cross.

   Sorting cards by their pin's height makes crossings *rare*, which is why
   they kept turning up occasionally: rare is not never. Two lines drawn from
   the same edge lane cross whenever the vertical order of the cards disagrees
   with the angular order of the pins, and no single sort key fixes every case
   (a pin far out to the side and a pin close in can invert the ordering).

   So instead of sorting, this repairs. Any two segments that genuinely cross
   are swapped between their card slots. By the triangle inequality that swap
   ALWAYS makes the two lines shorter in total, so total length strictly
   decreases with every swap; there are finitely many arrangements, so the loop
   cannot cycle and must halt with zero crossings. It also considers swaps
   between the left and right lanes, so it converges on a globally untangled
   layout rather than a per-lane one.

   Mutates the slot assignment on `items` in place. */
function untangle(items) {
  const anchor = (it) => ({
    x: it.side === "left" ? it.rect.x + it.rect.w : it.rect.x,
    y: it.rect.y + it.rect.h / 2,
  });
  // Proper segment intersection (shared endpoints / collinear don't count —
  // those aren't visually a crossing worth fixing).
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const crosses = (p1, p2, p3, p4) => {
    const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  const n = items.length;
  // Generous cap: far past what any real layout needs, and it keeps a
  // pathological case from ever stalling a render.
  const LIMIT = Math.max(64, n * n * 2);
  for (let guard = 0; guard < LIMIT; guard++) {
    let swapped = false;
    for (let i = 0; i < n && !swapped; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!crosses(anchor(items[i]), items[i].at, anchor(items[j]), items[j].at)) continue;
        // Trade slots. Strictly shortens the two lines, so this terminates.
        const r = items[i].rect, s = items[i].side;
        items[i].rect = items[j].rect; items[i].side = items[j].side;
        items[j].rect = r; items[j].side = s;
        swapped = true;
        break;
      }
    }
    if (!swapped) break;
  }
  return items;
}

export default function TileMap({
  center,                 // { lat, lng }
  zoom,                   // float
  onViewChange,           // ({ center, zoom }) => void
  pins = [],              // [{ n, lat, lng, label, photo, photoLocal }]
  showPhotos = false,     // true => float a photo callout beside each pin
  interactive = true,     // false => static preview: no gestures, page scrolls freely
  // "full"        — one finger pans the map (a full-screen map)
  // "cooperative" — one finger scrolls the PAGE, two fingers move the map.
  //                 Pins are still one-finger draggable. This is what lets a
  //                 live map sit inside a scrolling card without becoming a
  //                 scroll trap.
  gestures = "full",
  selectedIndex = null,
  onPinTap,
  editable = false,       // true => pins can be dragged
  onPinMove,              // (index, { lat, lng }) => void
  onMapTap,               // ({ lat, lng }) => void — a clean tap on open map
  parcel = [],            // [[{lat,lng}, ...], ...]
  userPos = null,         // { lat, lng, acc }
  children,
}) {
  const boxRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tileFail, setTileFail] = useState(0);
  // Live drag, in container coordinates. Kept local so dragging stays smooth
  // without re-rendering the whole card on every touchmove; the new position
  // is committed to the parent once on release.
  const [drag, setDrag] = useState(null);   // { i, x, y }

  // Track container size so the projection knows the viewport.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Live view in a ref so gesture handlers (attached once) never read a stale
  // centre/zoom mid-drag.
  const view = useRef({ center, zoom });
  useEffect(() => { view.current = { center, zoom }; }, [center, zoom]);
  // Same for the interaction props, so the gesture effect doesn't need to be
  // torn down and rebuilt every time edit mode toggles.
  const cfg = useRef({});
  cfg.current = { editable, onPinMove, onPinTap, onMapTap, gestures };

  const emit = useCallback((next) => {
    view.current = next;
    onViewChange?.(next);
  }, [onViewChange]);

  // ── Gestures ──────────────────────────────────────────────────────────────
  // Registered natively with passive:false: a touch map has to be able to
  // preventDefault, otherwise the page scrolls/zooms underneath the drag.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !interactive) return;

    let mode = null;            // "pan" | "pinch" | "pin"
    let last = null;            // last single-touch point
    let pinchStart = null;      // { dist, zoom, mid }
    let lastTap = 0;
    let held = null;            // { i, moved, from } while dragging a pin
    let startPt = null;         // where a single touch began (tap detection)
    let lastMid = null;         // previous two-finger midpoint, for panning

    const rectOf = () => el.getBoundingClientRect();
    // Screen (client) coords -> lat/lng, via the same fractional-zoom origin
    // everything else on the map uses.
    const atClient = (cx, cy) => {
      const r = rectOf();
      const { center: c, zoom: z } = view.current;
      const p = project(c.lat, c.lng, z);
      return unproject(
        p.x + (cx - r.left) - r.width / 2,
        p.y + (cy - r.top) - r.height / 2,
        z
      );
    };

    const panBy = (dxPx, dyPx) => {
      const { center: c, zoom: z } = view.current;
      const p = project(c.lat, c.lng, z);
      const next = unproject(p.x - dxPx, p.y - dyPx, z);
      emit({ center: { lat: clampLat(next.lat), lng: next.lng }, zoom: z });
    };

    // Zoom while keeping the point under `anchor` (screen px) fixed.
    const zoomAround = (nextZoom, anchor) => {
      const { center: c, zoom: z } = view.current;
      const nz = clamp(nextZoom, MIN_Z, MAX_Z);
      if (nz === z) return;
      const rect = rectOf();
      const ax = anchor.x - rect.left - rect.width / 2;   // anchor offset from centre
      const ay = anchor.y - rect.top - rect.height / 2;
      const pOld = project(c.lat, c.lng, z);
      // World point currently under the anchor, re-expressed at the new zoom.
      const anchorWorld = unproject(pOld.x + ax, pOld.y + ay, z);
      const pAnchorNew = project(anchorWorld.lat, anchorWorld.lng, nz);
      const nextCentre = unproject(pAnchorNew.x - ax, pAnchorNew.y - ay, nz);
      emit({ center: { lat: clampLat(nextCentre.lat), lng: nextCentre.lng }, zoom: nz });
    };

    // Where a dragged pin's GROUND point goes.
    //
    // Two things matter here. The pin tracks the DELTA of your finger from
    // where the grab started, not your fingertip — so it never jumps to meet
    // your finger, it just moves as much as your finger moved, wherever on the
    // pin you happened to grab it. And the lift above the fingertip eases in
    // over the first stretch of movement rather than snapping on, so a pin you
    // touch and barely move stays exactly where it was.
    const groundAt = (cx, cy) => {
      const dx = cx - startPt.x, dy = cy - startPt.y;
      const travelled = Math.hypot(dx, dy);
      const lift = DRAG_LIFT * Math.min(1, Math.max(0, (travelled - DRAG_SLOP) / DRAG_RAMP));
      return { x: held.from.x + dx, y: held.from.y + dy - lift, lift };
    };

    const pinIndexAt = (target) => {
      const node = target?.closest?.("[data-pin-index]");
      return node ? Number(node.dataset.pinIndex) : null;
    };

    const onStart = (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        startPt = { x: t.clientX, y: t.clientY };
        const hit = pinIndexAt(e.target);
        if (hit != null && cfg.current.editable) {
          // Grabbing a pin: take over so the map can't pan under it. Nothing
          // moves yet — the pin only starts following once the touch has
          // travelled past the slop, which keeps a tap from nudging it.
          mode = "pin";
          const node = e.target.closest("[data-pin-index]");
          const r = rectOf(), b = node.getBoundingClientRect();
          held = {
            i: hit, moved: false,
            from: { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top },
          };
          e.preventDefault();
          return;
        }
        // Cooperative mode leaves one finger to the page: no preventDefault
        // anywhere below, so the card scrolls exactly as it would without a
        // map in it.
        if (cfg.current.gestures === "cooperative") { mode = "scroll"; return; }
        mode = "pan";
        last = { clientX: t.clientX, clientY: t.clientY };
        // Double-tap to zoom in — the expected gesture on a phone map.
        const now = Date.now();
        if (now - lastTap < 300) {
          zoomAround(view.current.zoom + 1, { x: last.clientX, y: last.clientY });
          lastTap = 0;
        } else lastTap = now;
      } else if (e.touches.length === 2) {
        mode = "pinch";
        held = null; setDrag(null);
        pinchStart = {
          dist: dist2(e.touches[0], e.touches[1]),
          zoom: view.current.zoom,
          mid: mid2(e.touches[0], e.touches[1]),
        };
        // Two fingers also PAN, tracked from their midpoint. In cooperative
        // mode that is the only way to move the map, so it can't be optional.
        lastMid = pinchStart.mid;
      }
    };

    const onMove = (e) => {
      if (mode === "pin" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        if (Math.hypot(t.clientX - startPt.x, t.clientY - startPt.y) <= DRAG_SLOP) return;
        held.moved = true;
        const g = groundAt(t.clientX, t.clientY);
        setDrag({ i: held.i, x: g.x, y: g.y, lift: g.lift });
      } else if (mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        panBy(t.clientX - last.clientX, t.clientY - last.clientY);
        last = { clientX: t.clientX, clientY: t.clientY };
      } else if (mode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const mid = mid2(e.touches[0], e.touches[1]);
        if (lastMid) panBy(mid.x - lastMid.x, mid.y - lastMid.y);
        lastMid = mid;
        const d = dist2(e.touches[0], e.touches[1]);
        if (pinchStart.dist > 0) {
          // Continuous fractional zoom — no stepping, no snap-back.
          zoomAround(pinchStart.zoom + Math.log2(d / pinchStart.dist), mid);
        }
      }
    };

    const onEnd = (e) => {
      if (mode === "pin" && e.touches.length === 0) {
        const t = e.changedTouches?.[0];
        if (held.moved && t) {
          // Commit exactly what was drawn — same delta maths, so the pin lands
          // where the crosshair said it would.
          const g = groundAt(t.clientX, t.clientY);
          const r = rectOf();
          cfg.current.onPinMove?.(held.i, atClient(g.x + r.left, g.y + r.top));
        } else {
          // A grab that never moved is a tap.
          cfg.current.onPinTap?.(held.i);
        }
        held = null; setDrag(null); mode = null; startPt = null;
        return;
      }
      if (e.touches.length === 0) {
        lastMid = null;
        // A clean tap on open imagery — no drag, no pin under it. The parent
        // decides what that means (drop a pin, identify the parcel, nothing).
        const t = e.changedTouches?.[0];
        if ((mode === "pan" || mode === "scroll") && t && startPt &&
            Math.hypot(t.clientX - startPt.x, t.clientY - startPt.y) < 8 &&
            pinIndexAt(e.target) == null) {
          cfg.current.onMapTap?.(atClient(t.clientX, t.clientY));
        }
        mode = null; last = null; pinchStart = null; startPt = null;
      } else if (e.touches.length === 1) {
        lastMid = null;
        mode = cfg.current.gestures === "cooperative" ? "scroll" : "pan";
        last = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      }
    };

    // Mouse + wheel so the link is usable on a laptop too.
    let down = null;
    const onMouseDown = (e) => {
      const hit = pinIndexAt(e.target);
      if (hit != null && cfg.current.editable) {
        down = { x: e.clientX, y: e.clientY, pin: hit, moved: false };
        setDrag({ i: hit, ...liftFrom(e.clientX, e.clientY) });
        e.preventDefault();
        return;
      }
      down = { x: e.clientX, y: e.clientY, start: { x: e.clientX, y: e.clientY } };
    };
    const onMouseMove = (e) => {
      if (!down) return;
      e.preventDefault();
      if (down.pin != null) {
        down.moved = true;
        setDrag({ i: down.pin, ...liftFrom(e.clientX, e.clientY) });
        return;
      }
      panBy(e.clientX - down.x, e.clientY - down.y);
      down = { ...down, x: e.clientX, y: e.clientY };
    };
    const onMouseUp = (e) => {
      if (down?.pin != null) {
        if (down.moved) cfg.current.onPinMove?.(down.pin, atClient(e.clientX, e.clientY - DRAG_LIFT));
        else cfg.current.onPinTap?.(down.pin);
        setDrag(null);
      } else if (down?.start &&
                 Math.hypot(e.clientX - down.start.x, e.clientY - down.start.y) < 6) {
        cfg.current.onMapTap?.(atClient(e.clientX, e.clientY));
      }
      down = null;
    };
    const onWheel = (e) => {
      // Cooperative: the wheel belongs to the page, same as one finger does.
      if (cfg.current.gestures === "cooperative") return;
      e.preventDefault();
      zoomAround(view.current.zoom - Math.sign(e.deltaY) * 0.5, { x: e.clientX, y: e.clientY });
    };

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [emit, interactive]);

  // ── Projection for this frame ─────────────────────────────────────────────
  const { w, h } = size;
  const ready = w > 0 && h > 0;
  const cpx = ready ? project(center.lat, center.lng, zoom) : { x: 0, y: 0 };
  const originX = cpx.x - w / 2, originY = cpx.y - h / 2;
  // Screen position of a lat/lng, in the SAME fractional-zoom space as the
  // tiles below — this is what keeps markers pinned to the ground.
  const toScreen = useCallback((lat, lng) => {
    const p = project(lat, lng, zoom);
    return { x: p.x - originX, y: p.y - originY };
  }, [zoom, originX, originY]);

  // A pin's position on screen, honouring an in-progress drag.
  const pinAt = (p, i) => (drag && drag.i === i ? { x: drag.x, y: drag.y } : toScreen(p.lat, p.lng));

  // Tiles exist only at integer zooms; draw the nearest level, scaled.
  // Cap the TILE level at what Esri has; zooming past it upscales those tiles
  // rather than requesting a grey placeholder.
  const tileZoom = clamp(Math.round(zoom), MIN_Z, MAX_TILE_Z);
  const scale = Math.pow(2, zoom - tileZoom);
  const tilePx = TILE * scale;
  const span = Math.pow(2, tileZoom);
  const tiles = [];
  if (ready) {
    const tx0 = Math.floor(originX / tilePx), tx1 = Math.floor((originX + w) / tilePx);
    const ty0 = Math.floor(originY / tilePx), ty1 = Math.floor((originY + h) / tilePx);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (ty < 0 || ty >= span) continue;           // no tiles past the poles
        const wrapX = ((tx % span) + span) % span;    // wrap around the globe
        tiles.push({
          // Keyed by the DRAWN position, not the wrapped tile id: at low zoom
          // the same tile can legitimately appear twice on screen, and a
          // duplicate React key made one of the two vanish.
          key: `${tileZoom}/${tx}/${ty}`,
          url: TILE_URL(tileZoom, wrapX, ty),
          left: tx * tilePx - originX,
          top: ty * tilePx - originY,
        });
      }
    }
  }

  // ── Photo callouts ────────────────────────────────────────────────────────
  // Cards sit in lanes down the LEFT and RIGHT edges with a leader line to a
  // small pin — the same read as the exported site plan. They used to float
  // next to their pins, which buried the property under photo blocks and made
  // the small inline map unusable. Keeping them off the imagery is the point.
  const layout = useMemo(() => {
    if (!ready || !showPhotos) return { callouts: [], CW: 0, PH: 0, CH: 0 };
    const CW = clamp(Math.round(w / 4.2), 64, 104);   // keep the map between the lanes usable
    const PH = Math.round(CW * 0.68);          // photo height
    const CH = PH + 20;                        // + label strip
    const GAP = 6, M = 6;
    const perSide = Math.max(1, Math.floor((h - 2 * M + GAP) / (CH + GAP)));

    const items = pins
      .map((p, i) => ({ pin: p, i, at: toScreen(p.lat, p.lng) }))
      .filter(x => x.pin.photo || x.pin.photoLocal);

    // Which edge each photo belongs to — the half its pin sits in, so lines
    // stay short and point outward.
    let L = [], R = [];
    items.forEach(it => (it.at.x < w / 2 ? L : R).push(it));
    // Spill the overflow to the other lane rather than dropping it.
    while (L.length > perSide && R.length < perSide) {
      L.sort((a, b) => a.at.x - b.at.x); R.push(L.pop());
    }
    while (R.length > perSide && L.length < perSide) {
      R.sort((a, b) => a.at.x - b.at.x); L.push(R.shift());
    }
    // Order down each lane by pin height — a good starting arrangement, which
    // untangle() below then repairs into a provably crossing-free one.
    L = L.sort((a, b) => a.at.y - b.at.y).slice(0, perSide);
    R = R.sort((a, b) => a.at.y - b.at.y).slice(0, perSide);

    const callouts = [];
    const lane = (arr, side) => {
      if (!arr.length) return;
      const total = arr.length * CH + (arr.length - 1) * GAP;
      const startY = Math.max(M, (h - total) / 2);
      arr.forEach((it, k) => callouts.push({
        ...it, side,
        rect: { x: side === "left" ? M : w - M - CW, y: startY + k * (CH + GAP), w: CW, h: CH },
      }));
    };
    lane(L, "left");
    lane(R, "right");
    untangle(callouts);
    return { callouts, CW, PH, CH };
  }, [ready, showPhotos, w, h, pins, toScreen]);
  const { callouts, CW, PH, CH } = layout;

  return (
    <div
      ref={boxRef}
      style={{
        position: "absolute", inset: 0, overflow: "hidden",
        background: "#1b2430",
        // Cooperative mode must leave vertical scrolling to the browser, or
        // the card can't be scrolled past the map.
        touchAction: !interactive ? "auto" : gestures === "cooperative" ? "pan-y" : "none",
        cursor: interactive ? "grab" : "default",
        userSelect: "none", WebkitUserSelect: "none",
      }}
    >
      {/* Satellite tiles. Plain <img> — we only display them, never read them
          back into a canvas, so no crossOrigin and no CORS failure mode.
          Wrapped in RetryImg because a single dropped request on a weak
          connection used to leave a permanent grey square. */}
      {tiles.map(t => (
        <div
          key={t.key}
          style={{
            position: "absolute", left: t.left, top: t.top,
            width: tilePx + 1, height: tilePx + 1,   // +1 hides hairline seams
            pointerEvents: "none",
          }}
        >
          <RetryImg
            src={t.url}
            onFail={() => setTileFail(n => n + 1)}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        </div>
      ))}

      {/* Property boundary */}
      {ready && parcel.length > 0 && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {parcel.map((ring, i) => (
            <polygon
              key={i}
              points={ring.map(pt => { const s = toScreen(pt.lat, pt.lng); return `${s.x},${s.y}`; }).join(" ")}
              fill="none" stroke="rgba(255,214,0,.85)" strokeWidth="2.5" strokeDasharray="9,6"
            />
          ))}
        </svg>
      )}

      {/* Leader lines, drawn beneath the pins and cards so they emerge from
          under the card edge rather than crossing over it. untangle() has
          already guaranteed that none of these cross each other. */}
      {callouts.length > 0 && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {callouts.map(c => {
            const ex = c.side === "left" ? c.rect.x + c.rect.w : c.rect.x;
            const ey = c.rect.y + c.rect.h / 2;
            const to = pinAt(c.pin, c.i);
            return (
              <g key={`l${c.i}`}>
                <line x1={ex} y1={ey} x2={to.x} y2={to.y} stroke="rgba(0,0,0,.55)" strokeWidth="3.5" />
                <line x1={ex} y1={ey} x2={to.x} y2={to.y}
                      stroke={selectedIndex === c.i ? "#F6BF26" : "rgba(255,255,255,.92)"} strokeWidth="1.75" />
              </g>
            );
          })}
        </svg>
      )}

      {/* Live position: accuracy circle sized in real metres, then the dot. */}
      {ready && userPos && (() => {
        const s = toScreen(userPos.lat, userPos.lng);
        const r = Math.max(6, (userPos.acc || 20) / metersPerPixel(userPos.lat, zoom));
        return (
          <>
            <div style={{
              position: "absolute", left: s.x - r, top: s.y - r,
              width: r * 2, height: r * 2, borderRadius: "50%",
              background: "rgba(26,115,232,.14)", border: "1px solid rgba(26,115,232,.35)",
              pointerEvents: "none",
            }} />
            <div style={{
              position: "absolute", left: s.x - 9, top: s.y - 9,
              width: 18, height: 18, borderRadius: "50%",
              background: "#1a73e8", border: "3px solid #fff",
              boxShadow: "0 2px 8px rgba(0,0,0,.5)", pointerEvents: "none",
            }} />
          </>
        );
      })()}

      {/* Pins. A small teardrop, the shape everyone already reads as "a pin",
          with its point ON the spot. No number: on a live map the leader line
          already says which photo belongs to which pin, and a digit forces the
          head wide enough to cover the tree it is marking. The hit box stays
          44px — Apple's minimum touch target — so a small pin is still an easy
          one to grab. */}
      {ready && pins.map((p, i) => {
        const s2 = pinAt(p, i);
        if (s2.x < -80 || s2.y < -80 || s2.x > w + 80 || s2.y > h + 80) return null;
        const on = selectedIndex === i;
        const isHeld = drag?.i === i;
        const PW = 15, PH2 = 21;                // pin: width, height (point at bottom)
        const HIT = 44;
        return (
          <div
            key={i}
            data-pin-index={i}
            onClick={(e) => { e.stopPropagation(); if (!editable) onPinTap?.(i); }}
            style={{
              position: "absolute",
              left: s2.x - HIT / 2,
              // The pin's POINT is the location, so the graphic hangs above it.
              top: s2.y - HIT / 2,
              width: HIT, height: HIT,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: editable ? "grab" : "pointer",
              pointerEvents: interactive ? "auto" : "none",
              zIndex: isHeld ? 30 : 10,
              transform: isHeld ? "scale(1.3)" : on ? "scale(1.15)" : "none",
              transformOrigin: "50% 50%",
              transition: isHeld ? "none" : "transform .12s",
            }}
          >
            <svg width={PW} height={PH2} viewBox="0 0 15 21"
                 style={{ display: "block", transform: `translateY(${-PH2 / 2}px)`,
                          filter: "drop-shadow(0 1px 2px rgba(0,0,0,.7))" }}>
              <path d="M7.5 20.4C7.5 20.4 14 11.6 14 7.1A6.5 6.5 0 1 0 1 7.1C1 11.6 7.5 20.4 7.5 20.4Z"
                    fill={on || isHeld ? "#fff" : "#F6BF26"}
                    stroke={on || isHeld ? "#F6BF26" : "#1a1400"} strokeWidth="1.4" />
              <circle cx="7.5" cy="7.1" r="2.3" fill={on || isHeld ? "#F6BF26" : "#1a1400"} />
            </svg>
          </div>
        );
      })}

      {/* While dragging: a crosshair marking the exact ground point, with a
          stem down to the fingertip so the link between hand and target is
          obvious. The pin itself floats above the finger, not under it. */}
      {drag && drag.lift > 1 && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 25 }}>
          <line x1={drag.x} y1={drag.y} x2={drag.x} y2={drag.y + drag.lift}
                stroke="rgba(0,0,0,.5)" strokeWidth="4" />
          <line x1={drag.x} y1={drag.y} x2={drag.x} y2={drag.y + drag.lift}
                stroke="#F6BF26" strokeWidth="1.5" strokeDasharray="4,3" />
          <circle cx={drag.x} cy={drag.y + drag.lift} r="11" fill="none" stroke="rgba(0,0,0,.5)" strokeWidth="4" />
          <circle cx={drag.x} cy={drag.y + drag.lift} r="11" fill="none" stroke="#F6BF26" strokeWidth="2" />
          <circle cx={drag.x} cy={drag.y + drag.lift} r="1.5" fill="#F6BF26" />
        </svg>
      )}

      {/* Photo callouts — tappable, opening the same detail sheet as the pin. */}
      {callouts.map(c => {
        const on = selectedIndex === c.i;
        return (
          <button
            key={`c${c.i}`}
            onClick={(e) => { e.stopPropagation(); onPinTap?.(c.i); }}
            style={{
              position: "absolute", left: c.rect.x, top: c.rect.y,
              width: CW, height: CH, padding: 3, textAlign: "left",
              borderRadius: 8, cursor: "pointer",
              background: on ? "#F6BF26" : "#f4f6fa",
              border: on ? "2px solid #fff" : "1px solid rgba(0,0,0,.3)",
              boxShadow: "0 3px 10px rgba(0,0,0,.55)",
              display: "flex", flexDirection: "column", gap: 2,
              pointerEvents: interactive ? "auto" : "none",
            }}
          >
            <div style={{ position: "relative", height: PH, borderRadius: 6, overflow: "hidden", background: "#c8cfda" }}>
              {/* Retries, then falls back to the local capture if the Drive
                  thumbnail won't load — Drive throttles bursts of thumbnail
                  requests, which is why photos came and went. */}
              <RetryImg
                src={smallThumb(c.pin.photo) || c.pin.photoLocal}
                fallback={c.pin.photo ? c.pin.photoLocal : null}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </div>
            {/* Only a real label earns the strip. An auto-generated
                "Location 3" is a number in disguise, and the leader line
                already answers which pin this is. */}
            {c.pin.label && (
              <div style={{
                fontSize: 9, fontWeight: 700, color: "#1a2030", lineHeight: 1.15,
                overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
              }}>{c.pin.label}</div>
            )}
          </button>
        );
      })}

      {/* Imagery is a free courtesy service with no SLA — say so plainly rather
          than leaving a blank blue rectangle. Only after retries have failed. */}
      {tileFail > 3 && tiles.length > 0 && (
        <div style={{
          position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
          padding: "7px 14px", borderRadius: 999, background: "rgba(0,0,0,.75)",
          color: "#ffb4b4", fontSize: 12, fontWeight: 600, pointerEvents: "none",
        }}>Map imagery unavailable — check your signal</div>
      )}

      {children}
    </div>
  );
}
