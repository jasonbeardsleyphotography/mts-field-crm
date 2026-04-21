import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { IconArrowUpRight, IconEraser, IconUndo, IconX, IconTrash } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Photo Markup (Rebuild)
   Production-quality mobile photo annotator.

   Architecture
   ────────────
   • Strokes are stored in IMAGE-NATURAL coordinates (e.g. 3840×2160). This
     means drawing geometry is totally independent of zoom level — a stroke
     drawn at 5x zoom is stored at the same image coords as one drawn at 0.5x.
   • Canvas backing is sized to the image's natural dimensions (capped at
     4096 on the long side to stay memory-friendly on older iPhones).
   • Canvas DOM element is CSS-sized to "fit-to-container" (scale=1 baseline).
   • Zoom & pan are applied as a CSS transform: translate(tx,ty) scale(s).
   • Pointer input is converted to image coords via getBoundingClientRect,
     which always reflects the current CSS transform — so drawing stays
     pixel-accurate no matter how the user has zoomed or panned.
   • Uses Pointer Events API + touch-action:none for reliable multi-touch.
     One pointer = draw. Two pointers = pinch (scale + pan around pivot).

   Gestures
   ────────
   • Single finger: freehand draw (or erase when eraser tool active)
   • Two fingers:   pinch to zoom 0.5x–5x, pan simultaneously
   • Double-tap:    reset view to default (0.5x, centered)

   Default view: scale=0.5 (zoomed out — shows full photo with breathing room
   so you can pick the spot you want to zoom into).
   ═══════════════════════════════════════════════════════════════════════════ */

const COLORS = [
  { name: "Red",    hex: "#FF3B30" },
  { name: "Yellow", hex: "#FFCC00" },
  { name: "White",  hex: "#FFFFFF" },
  { name: "Blue",   hex: "#007AFF" },
  { name: "Green",  hex: "#34C759" },
];

const SIZES = [3, 6, 10];           // brush sizes in CSS pixels at scale=1
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
const INIT_SCALE = 1;               // fit-to-screen on open
const MAX_BACKING = 4096;           // cap canvas backing dimension (memory)
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_RADIUS = 30;

// ── ARROW DETECTION ──────────────────────────────────────────────────────────
// Straight-ish stroke with sufficient length snaps to a clean arrow (Apple-style).

function analyzeStroke(points) {
  if (points.length < 4) return null;
  const a = points[0], b = points[points.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const straight = Math.hypot(dx, dy);
  if (straight < 40) return null;

  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const ratio = pathLen > 0 ? straight / pathLen : 0;

  const angle = Math.atan2(dy, dx);
  let maxDev = 0;
  for (const p of points) {
    const rx = p.x - a.x, ry = p.y - a.y;
    const dev = Math.abs(rx * Math.sin(angle) - ry * Math.cos(angle));
    if (dev > maxDev) maxDev = dev;
  }

  if (ratio > 0.72 && maxDev < straight * 0.1) {
    return { start: a, end: b, angle };
  }
  return null;
}

function buildArrowStroke(info, color, size) {
  const { start, end, angle } = info;
  const headLen = Math.max(16, size * 4);
  const headAngle = 0.45; // ~25deg
  const tip = end;
  const left = {
    x: tip.x - headLen * Math.cos(angle - headAngle),
    y: tip.y - headLen * Math.sin(angle - headAngle),
  };
  const right = {
    x: tip.x - headLen * Math.cos(angle + headAngle),
    y: tip.y - headLen * Math.sin(angle + headAngle),
  };
  return { type: "arrow", start, end, left, right, color, size };
}

// ── DRAWING ──────────────────────────────────────────────────────────────────
// All draw functions operate in whatever coord space ctx is currently in.
// Caller is responsible for ctx.scale() before invoking these.

function drawFreehand(ctx, stroke, lineWidth) {
  const pts = stroke.points;
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    // Quadratic-midpoint smoothing: each interior point becomes a control
    // point, and the curve passes through the midpoint to the next control.
    // Produces a soft, natural freehand feel (vs. jagged lineTo segments).
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

function drawArrow(ctx, a, lineWidth) {
  ctx.strokeStyle = a.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(a.start.x, a.start.y);
  ctx.lineTo(a.end.x, a.end.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.left.x, a.left.y);
  ctx.lineTo(a.end.x, a.end.y);
  ctx.lineTo(a.right.x, a.right.y);
  ctx.stroke();
}

// Distance from point to segment — for eraser hit-testing.
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ═════════════════════════════════════════════════════════════════════════════

export default function PhotoMarkup({ photoDataUrl, onSave, onCancel }) {
  const baseCanvasRef    = useRef(null);  // image + committed strokes (static)
  const overlayCanvasRef = useRef(null);  // current stroke / arrow preview (dynamic)
  const imgRef           = useRef(null);
  const containerRef     = useRef(null);

  // Tool state (persisted across sessions)
  const [color, setColor]           = useState(() => {
    try { return localStorage.getItem("pm.color") || COLORS[0].hex; } catch { return COLORS[0].hex; }
  });
  const [brushSize, setBrushSize]   = useState(() => {
    try { return Number(localStorage.getItem("pm.brushSize")) || SIZES[1]; } catch { return SIZES[1]; }
  });
  const [arrowMode, setArrowMode]   = useState(false);
  const [eraserMode, setEraserMode] = useState(false);

  // Persist tool preferences
  useEffect(() => { try { localStorage.setItem("pm.color", color); } catch {} }, [color]);
  useEffect(() => { try { localStorage.setItem("pm.brushSize", String(brushSize)); } catch {} }, [brushSize]);

  // Committed strokes in image-natural coords (drives base canvas)
  const [strokes, setStrokes]   = useState([]);

  // Force-refresh hook for the stroke counter badge, without pulling
  // currentStroke into React state (which would re-render on every move).
  const [, forceUpdate] = useState(0);

  // Active stroke + arrow preview live in refs — mutated in pointer handlers,
  // flushed to the overlay canvas via rAF. No React renders per frame.
  const currentStrokeRef = useRef(null);
  const arrowPreviewRef  = useRef(null);
  const overlayDirty     = useRef(false);
  const rafId            = useRef(0);

  // Image / viewport
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgDims, setImgDims]     = useState({ w: 0, h: 0 });   // natural image size
  const [fit, setFit]             = useState({ w: 0, h: 0 });   // fit-to-container CSS size
  const [backing, setBacking]     = useState({ w: 0, h: 0 });   // canvas backing resolution

  // View transform (applied as CSS transform on canvas)
  const [view, setView] = useState({ scale: INIT_SCALE, tx: 0, ty: 0 });

  // Pointer / gesture tracking (mutable refs so we don't re-render during gestures)
  const pointersRef = useRef(new Map());     // pointerId -> {x,y}
  const gestureRef  = useRef(null);          // { startDist, startScale, midCanvas, containerRect }
  const drawingRef  = useRef(false);         // true while a stroke is being drawn
  const lastTapRef  = useRef({ t: 0, x: 0, y: 0 });

  // ── IMAGE LOAD ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      imgRef.current = img;
      setImgDims({ w: img.naturalWidth, h: img.naturalHeight });

      // Canvas backing: image-native resolution, capped at MAX_BACKING.
      const longSide = Math.max(img.naturalWidth, img.naturalHeight);
      const backingScale = longSide > MAX_BACKING ? MAX_BACKING / longSide : 1;
      setBacking({
        w: Math.floor(img.naturalWidth * backingScale),
        h: Math.floor(img.naturalHeight * backingScale),
      });
      setImgLoaded(true);
    };
    img.src = photoDataUrl;
    return () => { dead = true; };
  }, [photoDataUrl]);

  // ── FIT-TO-CONTAINER (recomputed on resize / rotation) ─────────────────────
  useLayoutEffect(() => {
    if (!imgLoaded) return;
    const el = containerRef.current;
    if (!el) return;

    const recompute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const s = Math.min(cw / imgDims.w, ch / imgDims.h);
      const fw = Math.floor(imgDims.w * s);
      const fh = Math.floor(imgDims.h * s);
      setFit({ w: fw, h: fh });
      // Re-center at current zoom level. Works for both first-load (scale=INIT_SCALE)
      // and rotation (preserves user's current zoom).
      setView(v => centerView(v.scale, cw, ch, fw, fh));
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    window.addEventListener("orientationchange", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", recompute);
    };
  }, [imgLoaded, imgDims.w, imgDims.h]);

  // ── COORDINATE CONVERSION ──────────────────────────────────────────────────
  // client (viewport) coords → image-natural coords.
  // getBoundingClientRect reflects CSS transforms, so this stays correct at
  // any zoom/pan level.
  const clientToImage = useCallback((clientX, clientY) => {
    const c = baseCanvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top)  / r.height;
    return { x: nx * imgDims.w, y: ny * imgDims.h };
  }, [imgDims.w, imgDims.h]);

  // ── BASE REDRAW (image + committed strokes) ────────────────────────────────
  // Runs only when strokes, image, or canvas dimensions change — NOT during
  // active drawing. This is the "expensive" render (drawImage on a 4k canvas
  // plus all strokes) and it needs to happen rarely.
  useEffect(() => {
    const c = baseCanvasRef.current, img = imgRef.current;
    if (!c || !img || !backing.w || !backing.h) return;
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const bs = backing.w / imgDims.w;
    ctx.scale(bs, bs);
    ctx.drawImage(img, 0, 0, imgDims.w, imgDims.h);

    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
    strokes.forEach(s => {
      const lw = s.size * cssToImg;
      if (s.type === "arrow") drawArrow(ctx, s, lw);
      else                    drawFreehand(ctx, s, lw);
    });
  }, [strokes, backing.w, backing.h, imgDims.w, imgDims.h, fit.w]);

  // ── OVERLAY REDRAW (active stroke + arrow preview) ────────────────────────
  // Runs every animation frame while a stroke is in progress. Only touches
  // the thin overlay canvas, so cost is proportional to stroke length, not
  // image size.
  const renderOverlay = useCallback(() => {
    rafId.current = 0;
    overlayDirty.current = false;
    const c = overlayCanvasRef.current;
    if (!c || !backing.w || !backing.h) return;
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);

    const cs = currentStrokeRef.current;
    const ap = arrowPreviewRef.current;
    if (!cs && !ap) return;

    const bs = backing.w / imgDims.w;
    ctx.scale(bs, bs);
    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;

    if (cs && cs.points.length >= 2) {
      drawFreehand(ctx, cs, cs.size * cssToImg);
    }
    if (ap) {
      drawArrow(ctx, ap, ap.size * cssToImg);
    }
  }, [backing.w, backing.h, imgDims.w, imgDims.h, fit.w]);

  const scheduleOverlay = useCallback(() => {
    if (overlayDirty.current) return;
    overlayDirty.current = true;
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(renderOverlay);
  }, [renderOverlay]);

  // Clear overlay when dependencies that affect rendering change
  useEffect(() => { scheduleOverlay(); }, [backing.w, backing.h, fit.w, scheduleOverlay]);

  // Cancel any pending frame on unmount
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  // ── VIEW HELPERS ───────────────────────────────────────────────────────────

  // Center the canvas within the container at a given scale.
  function centerView(scale, containerW, containerH, fitW, fitH) {
    const displayedW = fitW * scale;
    const displayedH = fitH * scale;
    return {
      scale,
      tx: (containerW - displayedW) / 2,
      ty: (containerH - displayedH) / 2,
    };
  }

  // Clamp pan so the image can't run entirely off-screen.
  // When displayed ≤ container: center. When displayed > container: keep edges past container edges.
  const clampView = useCallback(({ scale, tx, ty }) => {
    const el = containerRef.current;
    if (!el || !fit.w) return { scale, tx, ty };
    const cw = el.clientWidth, ch = el.clientHeight;
    const dw = fit.w * scale, dh = fit.h * scale;

    let clampedTx, clampedTy;
    if (dw <= cw) {
      clampedTx = (cw - dw) / 2;
    } else {
      clampedTx = Math.min(0, Math.max(cw - dw, tx));
    }
    if (dh <= ch) {
      clampedTy = (ch - dh) / 2;
    } else {
      clampedTy = Math.min(0, Math.max(ch - dh, ty));
    }
    return { scale, tx: clampedTx, ty: clampedTy };
  }, [fit.w, fit.h]);

  // Re-center / re-clamp whenever fit changes.
  useEffect(() => {
    if (!fit.w || !containerRef.current) return;
    setView(v => clampView(v));
  }, [fit.w, fit.h, clampView]);

  const resetView = useCallback(() => {
    const el = containerRef.current;
    if (!el || !fit.w) return;
    setView(centerView(INIT_SCALE, el.clientWidth, el.clientHeight, fit.w, fit.h));
  }, [fit.w, fit.h]);

  // ── ERASER ─────────────────────────────────────────────────────────────────
  const eraseAt = (pImg) => {
    // Hit tolerance in IMAGE coords: scale a CSS-px tolerance by image:fit ratio.
    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
    const HIT = 16 * cssToImg;
    setStrokes(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const s = prev[i];
        if (s.type === "arrow") {
          if (distToSegment(pImg.x, pImg.y, s.start.x, s.start.y, s.end.x, s.end.y) < HIT) {
            return prev.filter((_, j) => j !== i);
          }
        } else if (s.points) {
          for (let k = 0; k < s.points.length - 1; k++) {
            if (distToSegment(pImg.x, pImg.y,
                              s.points[k].x,   s.points[k].y,
                              s.points[k+1].x, s.points[k+1].y) < HIT) {
              return prev.filter((_, j) => j !== i);
            }
          }
        }
      }
      return prev;
    });
  };

  // ── POINTER HANDLERS ───────────────────────────────────────────────────────

  const onPointerDown = (e) => {
    // Ignore pointers that start on UI controls — they get their own events.
    if (e.target.closest && e.target.closest("[data-pm-ctl]")) return;

    // Only track touch/pen/mouse primary buttons — ignore right-click etc.
    if (e.pointerType === "mouse" && e.button !== 0) return;

    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const count = pointersRef.current.size;

    // Double-tap to reset view.
    if (count === 1 && e.isPrimary) {
      const now = Date.now();
      const last = lastTapRef.current;
      if (now - last.t < DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_RADIUS) {
        resetView();
        lastTapRef.current = { t: 0, x: 0, y: 0 };
        pointersRef.current.delete(e.pointerId);
        return;
      }
      lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
    }

    if (count === 1) {
      const pImg = clientToImage(e.clientX, e.clientY);
      if (eraserMode) {
        eraseAt(pImg);
        return;
      }
      drawingRef.current = true;
      arrowPreviewRef.current = null;
      currentStrokeRef.current = {
        type: "freehand",
        points: [pImg],
        color, size: brushSize,
      };
      forceUpdate(n => n + 1); // flip strokes-count badge
      scheduleOverlay();
    } else if (count === 2) {
      // Second finger down → abandon any current stroke, enter pinch gesture.
      if (drawingRef.current) {
        drawingRef.current = false;
        currentStrokeRef.current = null;
        scheduleOverlay();
      }
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midClient = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const rect = containerRef.current.getBoundingClientRect();
      // Point on the *unscaled* canvas under the pinch midpoint (canvas-local coords).
      const midCanvas = {
        x: (midClient.x - rect.left - view.tx) / view.scale,
        y: (midClient.y - rect.top  - view.ty) / view.scale,
      };
      gestureRef.current = {
        startDist: dist,
        startScale: view.scale,
        midCanvas,
        containerRect: rect,
      };
    }
  };

  const onPointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const count = pointersRef.current.size;

    if (count === 1 && drawingRef.current && currentStrokeRef.current) {
      const pImg = clientToImage(e.clientX, e.clientY);
      currentStrokeRef.current.points.push(pImg);
      scheduleOverlay();
    } else if (count === 2 && gestureRef.current) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midClient = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const g = gestureRef.current;

      let nextScale = g.startScale * (dist / g.startDist);
      nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));

      // Keep g.midCanvas anchored under the current midpoint → pinch-around-pivot + pan.
      const nextTx = midClient.x - g.containerRect.left - nextScale * g.midCanvas.x;
      const nextTy = midClient.y - g.containerRect.top  - nextScale * g.midCanvas.y;

      setView(clampView({ scale: nextScale, tx: nextTx, ty: nextTy }));
    }
  };

  const endPointer = (e) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.delete(e.pointerId);
    }
    const remaining = pointersRef.current.size;

    if (remaining < 2 && gestureRef.current) {
      gestureRef.current = null;
      setView(v => clampView(v));
    }

    if (remaining === 0 && drawingRef.current) {
      drawingRef.current = false;
      const cs = currentStrokeRef.current;
      if (!cs) return;

      if (cs.points.length < 2) {
        currentStrokeRef.current = null;
        scheduleOverlay();
        forceUpdate(n => n + 1);
        return;
      }

      const arrowInfo = arrowMode ? analyzeStroke(cs.points) : null;
      if (arrowInfo) {
        const arrow = buildArrowStroke(arrowInfo, cs.color, cs.size);
        arrowPreviewRef.current = arrow;
        currentStrokeRef.current = null;
        scheduleOverlay();
        forceUpdate(n => n + 1);
        // Brief preview flash, then commit to base layer
        setTimeout(() => {
          arrowPreviewRef.current = null;
          scheduleOverlay();
          setStrokes(prev => [...prev, arrow]);
        }, 120);
      } else {
        // Commit freehand stroke to base layer. Clear overlay first so the
        // stroke doesn't briefly double-render (base + overlay) on flush.
        currentStrokeRef.current = null;
        scheduleOverlay();
        setStrokes(prev => [...prev, cs]);
      }
    }
  };

  // ── ACTIONS ────────────────────────────────────────────────────────────────
  const undo     = () => setStrokes(p => p.slice(0, -1));
  const clearAll = () => setStrokes([]);

  // Save at full image resolution.
  const handleSave = () => {
    const img = imgRef.current;
    if (!img) return;
    const fc = document.createElement("canvas");
    fc.width = imgDims.w;
    fc.height = imgDims.h;
    const ctx = fc.getContext("2d");
    ctx.drawImage(img, 0, 0, imgDims.w, imgDims.h);

    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
    strokes.forEach(s => {
      const lw = s.size * cssToImg;
      if (s.type === "arrow") drawArrow(ctx, s, lw);
      else                    drawFreehand(ctx, s, lw);
    });

    onSave(fc.toDataURL("image/jpeg", 0.9));
  };

  // ── RENDER ─────────────────────────────────────────────────────────────────

  // iOS-style floating "FAB" button base.
  const fab = (active = false, danger = false) => ({
    width: 44, height: 44, borderRadius: 22,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: active
      ? (danger ? "rgba(255,59,48,.92)" : "rgba(0,122,255,.92)")
      : "rgba(28,28,30,.72)",
    border: "1px solid rgba(255,255,255,.12)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    backdropFilter: "blur(20px) saturate(180%)",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,.35)",
    padding: 0,
    transition: "background .15s, transform .1s",
  });

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed", inset: 0, zIndex: 300, background: "#000",
        overflow: "hidden",
        touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
        WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >

      {/* ── CANVAS (base = image + committed strokes) ─────────────────── */}
      {fit.w > 0 && backing.w > 0 && (
        <canvas
          ref={baseCanvasRef}
          width={backing.w}
          height={backing.h}
          style={{
            position: "absolute",
            left: 0, top: 0,
            width: fit.w, height: fit.h,
            transform: `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.scale})`,
            transformOrigin: "0 0",
            willChange: "transform",
            imageRendering: "auto",
            touchAction: "none",
          }}
        />
      )}

      {/* ── CANVAS (overlay = active stroke only) ────────────────────── */}
      {fit.w > 0 && backing.w > 0 && (
        <canvas
          ref={overlayCanvasRef}
          width={backing.w}
          height={backing.h}
          style={{
            position: "absolute",
            left: 0, top: 0,
            width: fit.w, height: fit.h,
            transform: `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.scale})`,
            transformOrigin: "0 0",
            willChange: "transform",
            imageRendering: "auto",
            pointerEvents: "none",   // base canvas receives pointer events
            touchAction: "none",
          }}
        />
      )}

      {!imgLoaded && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          color: "#5a5a5a", fontSize: 14,
        }}>Loading…</div>
      )}

      {/* ── TOP-LEFT: Cancel ───────────────────────────────────────────── */}
      <div data-pm-ctl style={{
        position: "absolute",
        top: "max(12px, env(safe-area-inset-top))",
        left: "max(12px, env(safe-area-inset-left))",
      }}>
        <button onClick={onCancel} style={fab()} title="Cancel">
          <IconX size={22} color="#fff" />
        </button>
      </div>

      {/* ── TOP-RIGHT: Tools + Done ────────────────────────────────────── */}
      <div data-pm-ctl style={{
        position: "absolute",
        top: "max(12px, env(safe-area-inset-top))",
        right: "max(12px, env(safe-area-inset-right))",
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <button
          onClick={() => { setArrowMode(m => !m); setEraserMode(false); }}
          style={fab(arrowMode)}
          title="Arrow (straight strokes snap to arrows)"
        >
          <IconArrowUpRight size={20} color="#fff" />
        </button>
        <button
          onClick={() => { setEraserMode(m => !m); setArrowMode(false); }}
          style={fab(eraserMode, true)}
          title="Eraser"
        >
          <IconEraser size={20} color="#fff" />
        </button>
        <button
          onClick={undo}
          disabled={!strokes.length}
          style={{ ...fab(), opacity: strokes.length ? 1 : 0.4 }}
          title="Undo"
        >
          <IconUndo size={20} color="#fff" />
        </button>
        <button
          onClick={handleSave}
          style={{
            ...fab(), width: "auto", padding: "0 16px",
            background: "rgba(0,122,255,.95)",
            fontWeight: 700, fontSize: 15,
          }}
          title="Save markup"
        >Done</button>
      </div>

      {/* ── BOTTOM: Color + Brush sizes ────────────────────────────────── */}
      <div data-pm-ctl style={{
        position: "absolute",
        left: 0, right: 0,
        bottom: "max(16px, env(safe-area-inset-bottom))",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
        pointerEvents: "none", // outer wrapper lets touches pass through; pills opt in
      }}>
        {/* Colors */}
        <div style={{
          display: "flex", gap: 10, padding: "8px 14px",
          background: "rgba(28,28,30,.72)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          backdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.12)",
          boxShadow: "0 2px 10px rgba(0,0,0,.35)",
          pointerEvents: "auto",
        }}>
          {COLORS.map(c => {
            const active = color === c.hex;
            return (
              <button
                key={c.hex}
                onClick={() => setColor(c.hex)}
                aria-label={c.name}
                style={{
                  width: active ? 32 : 26,
                  height: active ? 32 : 26,
                  borderRadius: "50%",
                  background: c.hex,
                  border: active
                    ? "2px solid #fff"
                    : (c.hex === "#FFFFFF" ? "1px solid rgba(255,255,255,.4)" : "1px solid rgba(0,0,0,.2)"),
                  cursor: "pointer",
                  padding: 0,
                  boxShadow: active ? `0 0 10px ${c.hex}80` : "none",
                  transition: "all .15s",
                }}
              />
            );
          })}
        </div>

        {/* Brush sizes + clear */}
        <div style={{
          display: "flex", gap: 6, padding: "6px 8px",
          background: "rgba(28,28,30,.72)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          backdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,.12)",
          boxShadow: "0 2px 10px rgba(0,0,0,.35)",
          pointerEvents: "auto",
          alignItems: "center",
        }}>
          {SIZES.map(s => {
            const active = brushSize === s;
            return (
              <button
                key={s}
                onClick={() => setBrushSize(s)}
                style={{
                  width: 38, height: 38, borderRadius: 19,
                  background: active ? "rgba(255,255,255,.16)" : "transparent",
                  border: "none", cursor: "pointer", padding: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <div style={{
                  width: s * 2 + 4, height: s * 2 + 4,
                  borderRadius: "50%",
                  background: color,
                  opacity: active ? 1 : 0.55,
                  border: color === "#FFFFFF" ? "1px solid rgba(0,0,0,.3)" : "none",
                }}/>
              </button>
            );
          })}
          <div style={{ width: 1, height: 22, background: "rgba(255,255,255,.12)", margin: "0 4px" }} />
          <button
            onClick={clearAll}
            disabled={!strokes.length}
            style={{
              width: 38, height: 38, borderRadius: 19,
              background: "transparent", border: "none",
              cursor: strokes.length ? "pointer" : "default",
              opacity: strokes.length ? 1 : 0.35,
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0,
            }}
            title="Clear all"
          >
            <IconTrash size={18} color="#fff" />
          </button>
        </div>
      </div>

      {/* ── ZOOM INDICATOR (only when away from default) ───────────────── */}
      {Math.abs(view.scale - INIT_SCALE) > 0.02 && (
        <div data-pm-ctl
          onClick={resetView}
          style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: "max(72px, calc(env(safe-area-inset-top) + 60px))",
            padding: "4px 12px", borderRadius: 999,
            background: "rgba(28,28,30,.72)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            backdropFilter: "blur(20px) saturate(180%)",
            border: "1px solid rgba(255,255,255,.12)",
            color: "#fff", fontSize: 12, fontWeight: 600,
            cursor: "pointer",
            pointerEvents: "auto",
          }}
        >{view.scale.toFixed(1)}× · tap to reset</div>
      )}
    </div>
  );
}
