import { useRef, useEffect, useState, useCallback } from "react";
import {
  TILE, MAX_Z, MAX_TILE_Z, MIN_Z, TILE_URL, project, unproject, metersPerPixel, clampLat,
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

/* Drive thumbnails are stored at sz=w1200. A 132px card needs nowhere near
   that, and a dozen full-size ones is real bandwidth on a truck's connection —
   ask Drive for a small rendition instead. */
const smallThumb = (url) =>
  typeof url === "string" ? url.replace(/([?&]sz=)w\d+/, "$1w400") : url;
const dist2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
const mid2 = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

export default function TileMap({
  center,                 // { lat, lng }
  zoom,                   // float
  onViewChange,           // ({ center, zoom }) => void
  pins = [],              // [{ n, lat, lng, label, photo }]
  showPhotos = false,     // true => float a photo callout beside each pin
  interactive = true,     // false =>static preview: no gestures, page scrolls freely
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
    if (!el || !interactive) return;

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
  }, [emit, interactive]);

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
          key: `${tileZoom}/${wrapX}/${ty}`,
          url: TILE_URL(tileZoom, wrapX, ty),
          left: tx * tilePx - originX,
          top: ty * tilePx - originY,
        });
      }
    }
  }

  // ── Photo callouts ────────────────────────────────────────────────────────
  // With photos on, each pin gets a floating preview card joined to it by a
  // leader line — the same read as the exported site plan, but live. Cards are
  // decluttered greedily: try a ring of candidate offsets around the pin and
  // take the first that collides with nothing already placed (including OTHER
  // pins, so a card never buries a marker). Placement is recomputed each frame,
  // which is cheap at these counts and keeps cards sensible while panning.
  const CW = 132, CH = 118;
  const TOP_RESERVE = 78;   // leave the title overlay legible
  const callouts = [];
  if (ready && showPhotos) {
    const pad = 6;
    const hit = (a, b) =>
      !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
        a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
    // Reserve every pin's marker so callouts don't sit on top of one.
    const taken = pins.map(p => {
      const s2 = toScreen(p.lat, p.lng);
      return { x: s2.x - 16, y: s2.y - 40, w: 32, h: 42 };
    });
    // Card-centre offsets from the pin's ground point: straight above first,
    // then fanning out to the sides and further afield.
    const CAND = [
      [0, -103], [-96, -94], [96, -94], [-120, -34], [120, -34],
      [-112, 54], [112, 54], [0, 80], [0, -196], [-176, -152], [176, -152],
      [-196, 24], [196, 24], [-176, 140], [176, 140],
    ];
    pins
      .map((p, i) => ({ p, i, s: toScreen(p.lat, p.lng) }))
      .filter(({ p, s: s2 }) => p.photo && s2.x > -240 && s2.y > -240 && s2.x < w + 240 && s2.y < h + 240)
      .sort((a, b) => (a.s.y - b.s.y) || (a.s.x - b.s.x))   // stable, top-down
      .forEach(({ p, i, s: s2 }) => {
        let rect = null;
        for (const [dx, dy] of CAND) {
          const r = { x: s2.x + dx - CW / 2, y: s2.y + dy - CH / 2, w: CW, h: CH };
          if (r.x < 4 || r.y < TOP_RESERVE || r.x + CW > w - 4 || r.y + CH > h - 4) continue;
          if (!taken.some(q => hit(q, r))) { rect = r; break; }
        }
        if (!rect) {
          // Everything collided (very tight cluster) — park it above the pin,
          // clamped on-screen, and accept the overlap rather than hiding data.
          rect = {
            x: clamp(s2.x - CW / 2, 4, Math.max(4, w - CW - 4)),
            y: clamp(s2.y - 103 - CH / 2, TOP_RESERVE, Math.max(TOP_RESERVE, h - CH - 4)),
            w: CW, h: CH,
          };
        }
        taken.push(rect);
        callouts.push({ pin: p, i, at: s2, rect });
      });
  }

  return (
    <div
      ref={boxRef}
      style={{
        position: "absolute", inset: 0, overflow: "hidden",
        background: "#1b2430",
        touchAction: interactive ? "none" : "auto",
        cursor: interactive ? "grab" : "default",
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

      {/* Leader lines, drawn beneath the pins and cards so they emerge from
          under the card edge rather than crossing over it. */}
      {callouts.length > 0 && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          {callouts.map(c => (
            <g key={`l${c.i}`}>
              <line x1={c.rect.x + c.rect.w / 2} y1={c.rect.y + c.rect.h / 2}
                    x2={c.at.x} y2={c.at.y}
                    stroke="rgba(0,0,0,.5)" strokeWidth="4" />
              <line x1={c.rect.x + c.rect.w / 2} y1={c.rect.y + c.rect.h / 2}
                    x2={c.at.x} y2={c.at.y}
                    stroke={selectedIndex === c.i ? "#F6BF26" : "rgba(255,255,255,.9)"} strokeWidth="2" />
            </g>
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
              pointerEvents: interactive ? "auto" : "none",
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

      {/* Photo callouts — tappable, opening the same detail sheet as the pin. */}
      {callouts.map(c => {
        const on = selectedIndex === c.i;
        return (
          <button
            key={`c${c.i}`}
            onClick={(e) => { e.stopPropagation(); onPinTap?.(c.i); }}
            style={{
              position: "absolute", left: c.rect.x, top: c.rect.y,
              width: CW, height: CH, padding: 4, textAlign: "left",
              borderRadius: 10, cursor: "pointer",
              background: on ? "#F6BF26" : "#f4f6fa",
              border: on ? "2px solid #fff" : "1px solid rgba(0,0,0,.25)",
              boxShadow: "0 4px 14px rgba(0,0,0,.5)",
              display: "flex", flexDirection: "column", gap: 3,
              pointerEvents: interactive ? "auto" : "none",
            }}
          >
            <div style={{ position: "relative", flex: 1, minHeight: 0, borderRadius: 7, overflow: "hidden", background: "#c8cfda" }}>
              {/* Ask Drive for a small rendition — the stored URL is w1200,
                  which is far more than a 132px card needs on a phone. */}
              <img
                src={smallThumb(c.pin.photo)}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
              <span style={{
                position: "absolute", top: 3, left: 3,
                minWidth: 19, height: 19, padding: "0 4px", borderRadius: 10,
                background: "#F6BF26", color: "#1a1400",
                fontFamily: "Oswald, sans-serif", fontWeight: 700, fontSize: 12,
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 1px 4px rgba(0,0,0,.4)",
              }}>{c.pin.n ?? c.i + 1}</span>
            </div>
            <div style={{
              fontSize: 10.5, fontWeight: 700, color: "#1a2030", lineHeight: 1.25,
              maxHeight: 26, overflow: "hidden",
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
            }}>{c.pin.label || `Location ${c.pin.n ?? c.i + 1}`}</div>
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
