import { useRef, useEffect, useState, useCallback } from "react";
import {
  TILE, MAX_Z, MIN_Z, TILE_URL, project, unproject, metersPerPixel, clampLat,
} from "./tileMath";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — TileMap
   ───────────────────────────────────────────────────────────────────────────
   A small, dependency-free satellite map with drag-pan and pinch-zoom, drawn
   from free Esri World Imagery tiles.

   Why hand-rolled instead of Google Maps JS: the crew viewer is a public link
   that could be opened any number of times by any number of people, and the
   Maps JS API is metered per load. This costs nothing per view, forever.

   How it stays correct at any zoom: state is a float `zoom`, and BOTH the
   tiles and the markers are positioned from the same fractional-zoom world
   origin. Tiles only exist at integer zooms, so we draw the nearest integer
   level scaled by the fractional remainder — but their on-screen placement is
   still computed in fractional-zoom pixels, so a marker never drifts off its
   ground position the way it would with a CSS transform on a wrapper.
   ═══════════════════════════════════════════════════════════════════════════ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid2 = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

export default function TileMap({
  center,                 // { lat, lng }
  zoom,                   // float
  onViewChange,           // ({ center, zoom }) => void
  pins = [],              // [{ n, lat, lng, label, photo }]
  selectedIndex = null,
  onPinTap,
  parcel = [],            // [[{lat,lng}, ...], ...]
  userPos = null,         // { lat, lng, acc }
  children,
}) {
  const boxRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tileFail, setTileFail] = useState(0);

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

  const emit = useCallback((next) => {
    view.current = next;
    onViewChange?.(next);
  }, [onViewChange]);

  // ── Gestures ──────────────────────────────────────────────────────────────
  // Registered natively with passive:false: a touch map has to be able to
  // preventDefault, otherwise the page scrolls/zooms underneath the drag.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    let mode = null;            // "pan" | "pinch"
    let last = null;            // last single-touch point
    let pinchStart = null;      // { dist, zoom, mid }
    let lastTap = 0;

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
      const rect = el.getBoundingClientRect();
      const ax = anchor.x - rect.left - rect.width / 2;   // anchor offset from centre
      const ay = anchor.y - rect.top - rect.height / 2;
      const pOld = project(c.lat, c.lng, z);
      // World point currently under the anchor, re-expressed at the new zoom.
      const anchorWorld = unproject(pOld.x + ax, pOld.y + ay, z);
      const pAnchorNew = project(anchorWorld.lat, anchorWorld.lng, nz);
      const nextCentre = unproject(pAnchorNew.x - ax, pAnchorNew.y - ay, nz);
      emit({ center: { lat: clampLat(nextCentre.lat), lng: nextCentre.lng }, zoom: nz });
    };

    const onStart = (e) => {
      if (e.touches.length === 1) {
        mode = "pan";
        last = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
        // Double-tap to zoom in — the expected gesture on a phone map.
        const now = Date.now();
        if (now - lastTap < 300) {
          zoomAround(view.current.zoom + 1, { x: last.clientX, y: last.clientY });
          lastTap = 0;
        } else lastTap = now;
      } else if (e.touches.length === 2) {
        mode = "pinch";
        pinchStart = {
          dist: dist2(e.touches[0], e.touches[1]),
          zoom: view.current.zoom,
          mid: mid2(e.touches[0], e.touches[1]),
        };
      }
    };

    const onMove = (e) => {
      if (mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        panBy(t.clientX - last.clientX, t.clientY - last.clientY);
        last = { clientX: t.clientX, clientY: t.clientY };
      } else if (mode === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const d = dist2(e.touches[0], e.touches[1]);
        if (pinchStart.dist > 0) {
          // Continuous fractional zoom — no stepping, no snap-back.
          zoomAround(pinchStart.zoom + Math.log2(d / pinchStart.dist), pinchStart.mid);
        }
      }
    };

    const onEnd = (e) => {
      if (e.touches.length === 0) { mode = null; last = null; pinchStart = null; }
      else if (e.touches.length === 1) {
        mode = "pan";
        last = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      }
    };

    // Mouse + wheel so the link is usable on a laptop too.
    let down = null;
    const onMouseDown = (e) => { down = { x: e.clientX, y: e.clientY }; };
    const onMouseMove = (e) => {
      if (!down) return;
      e.preventDefault();
      panBy(e.clientX - down.x, e.clientY - down.y);
      down = { x: e.clientX, y: e.clientY };
    };
    const onMouseUp = () => { down = null; };
    const onWheel = (e) => {
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
  }, [emit]);

  // ── Projection for this frame ─────────────────────────────────────────────
  const { w, h } = size;
  const ready = w > 0 && h > 0;
  const cpx = ready ? project(center.lat, center.lng, zoom) : { x: 0, y: 0 };
  const originX = cpx.x - w / 2, originY = cpx.y - h / 2;
  // Screen position of a lat/lng, in the SAME fractional-zoom space as the
  // tiles below — this is what keeps markers pinned to the ground.
  const toScreen = (lat, lng) => {
    const p = project(lat, lng, zoom);
    return { x: p.x - originX, y: p.y - originY };
  };

  // Tiles exist only at integer zooms; draw the nearest level, scaled.
  const tileZoom = clamp(Math.round(zoom), MIN_Z, MAX_Z);
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
          key: `${tileZoom}/${wrapX}/${ty}`,
          url: TILE_URL(tileZoom, wrapX, ty),
          left: tx * tilePx - originX,
          top: ty * tilePx - originY,
        });
      }
    }
  }

  return (
    <div
      ref={boxRef}
      style={{
        position: "absolute", inset: 0, overflow: "hidden",
        background: "#1b2430", touchAction: "none", cursor: "grab",
        userSelect: "none", WebkitUserSelect: "none",
      }}
    >
      {/* Satellite tiles. Plain <img> — we only display them, never read them
          back into a canvas, so no crossOrigin and no CORS failure mode. */}
      {tiles.map(t => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          draggable={false}
          onError={() => setTileFail(n => n + 1)}
          style={{
            position: "absolute", left: t.left, top: t.top,
            width: tilePx + 1, height: tilePx + 1,   // +1 hides hairline seams
            pointerEvents: "none",
          }}
        />
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

      {/* Pins — real DOM nodes, so tapping is an ordinary click handler. */}
      {ready && pins.map((p, i) => {
        const s = toScreen(p.lat, p.lng);
        if (s.x < -60 || s.y < -60 || s.x > w + 60 || s.y > h + 60) return null;
        const on = selectedIndex === i;
        return (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); onPinTap?.(i); }}
            style={{
              position: "absolute", left: s.x - 16, top: s.y - 38,
              width: 32, height: 40, padding: 0, border: "none",
              background: "transparent", cursor: "pointer",
              transform: on ? "scale(1.18)" : "none", transformOrigin: "50% 100%",
              transition: "transform .12s",
            }}
          >
            <svg width="32" height="40" viewBox="0 0 34 44">
              <path
                d="M17 43C17 43 32 26.5 32 16A15 15 0 1 0 2 16C2 26.5 17 43 17 43Z"
                fill={on ? "#fff" : "#F6BF26"} stroke={on ? "#F6BF26" : "#fff"} strokeWidth="2.5"
              />
              <text x="17" y="22" fontFamily="Oswald, sans-serif" fontSize="15"
                    fontWeight="700" fill="#1a1400" textAnchor="middle">{p.n ?? i + 1}</text>
            </svg>
          </button>
        );
      })}

      {/* Imagery is a free courtesy service with no SLA — say so plainly rather
          than leaving a blank blue rectangle. */}
      {tileFail > 6 && tiles.length > 0 && (
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
