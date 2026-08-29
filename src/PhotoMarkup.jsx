import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { IconArrowUpRight, IconArrowLeft, IconArrowRight, IconEraser, IconUndo, IconX, IconDownload, IconRotateCcw, IconMapPin } from "./icons";

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
const ARROWHEAD_SCALES = [1.8, 3, 4.5];  // small / large / XL
const X_SCALES = [0.35, 0.55, 0.85, 1.70, 2.55]; // XS / S / M / L / XL — 2 new smaller sizes + all prior sizes reduced ~15%
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;
const INIT_SCALE = 1;               // fit-to-screen on open
const MAX_BACKING = 4096;           // cap canvas backing dimension (memory)
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_RADIUS = 30;

function buildArrowStroke(info, color, size, headScale = 1) {
  const { start, end, angle } = info;
  const headLen = Math.max(16, size * 4) * headScale;
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

function buildXStroke(center, color, size, cssToImg, xHeadScale = 1) {
  const armLen = Math.max(24, size * 8) * xHeadScale * cssToImg;
  return { type: "x", cx: center.x, cy: center.y, armLen, color, size };
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

function drawX(ctx, s, lineWidth) {
  const { cx, cy, armLen } = s;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - armLen, cy - armLen);
  ctx.lineTo(cx + armLen, cy + armLen);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + armLen, cy - armLen);
  ctx.lineTo(cx - armLen, cy + armLen);
  ctx.stroke();
}

function drawLine(ctx, s, lineWidth) {
  ctx.strokeStyle = s.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s.start.x, s.start.y);
  ctx.lineTo(s.end.x, s.end.y);
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

export default function PhotoMarkup({
  photoDataUrl, originalDataUrl = null, onSave, onCancel,
  hasPrev = false, hasNext = false, onPrev, onNext,
  // Whether this photo is on the site plan, and how to flip it. Null hides the
  // control entirely (for callers with no plan concept).
  onPlan = null, onTogglePlan,
  // Every photo on the card, for the jump-to strip: [{ key, src }]. `index` is
  // which one is open; onJump(dataUrl, hasEdits, i) switches to another.
  strip = [], index = 0, onJump,
}) {
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
  // Active tool. Defaults to "x" so the editor opens ready to stamp X marks —
  // the most common annotation. Persisted across sessions.
  // Values: "x" | "freehand" | "line" | "eraser"
  // The "line" tool draws a straight line with an optional arrowhead at the end
  // (controlled by `arrowEnd`, default on) — line and arrow are one tool now.
  const [tool, setTool] = useState(() => {
    try {
      let t = localStorage.getItem("pm.tool");
      if (t === "arrow") t = "line";  // old arrow tool folded into the line tool
      return ["x", "freehand", "line", "eraser"].includes(t) ? t : "x";
    } catch { return "x"; }
  });
  useEffect(() => { try { localStorage.setItem("pm.tool", tool); } catch {} }, [tool]);
  // Derived booleans keep the rest of the component unchanged.
  const eraserMode   = tool === "eraser";
  const xMode        = tool === "x";
  const lineMode     = tool === "line";
  const freehandMode = tool === "freehand";
  // Whether the line tool caps its end with an arrowhead. Defaults on.
  const [arrowEnd, setArrowEnd] = useState(() => {
    try { const v = localStorage.getItem("pm.arrowEnd"); return v === null ? true : v === "1"; }
    catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem("pm.arrowEnd", arrowEnd ? "1" : "0"); } catch {} }, [arrowEnd]);
  const [arrowHeadScale, setArrowHeadScale] = useState(() => {
    try {
      const s = Number(localStorage.getItem("pm.arrowHeadScale")) || 3;
      // Validate against the current option set; unknown values fall back to large
      return ARROWHEAD_SCALES.includes(s) ? s : 3;
    } catch { return 3; }
  });
  const [xHeadScale, setXHeadScale] = useState(() => {
    try {
      const s = Number(localStorage.getItem("pm.xHeadScale"));
      // Validate against current scale set; old saved values (1/2/3) fall back to medium
      return X_SCALES.includes(s) ? s : X_SCALES[2];
    } catch { return X_SCALES[2]; }
  });

  // Persist tool preferences
  useEffect(() => { try { localStorage.setItem("pm.color", color); } catch {} }, [color]);
  useEffect(() => { try { localStorage.setItem("pm.brushSize", String(brushSize)); } catch {} }, [brushSize]);
  useEffect(() => { try { localStorage.setItem("pm.arrowHeadScale", String(arrowHeadScale)); } catch {} }, [arrowHeadScale]);
  useEffect(() => { try { localStorage.setItem("pm.xHeadScale", String(xHeadScale)); } catch {} }, [xHeadScale]);

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
  const [loadError, setLoadError] = useState(false);
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

  // Current image source. Starts as the incoming photo, but the Rotate button
  // replaces it with a freshly-rotated (annotations baked in) data URL.
  const [srcUrl, setSrcUrl] = useState(photoDataUrl);
  // If the parent swaps the photo (prev/next navigation), follow it.
  useEffect(() => { setSrcUrl(photoDataUrl); }, [photoDataUrl]);

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
    // Without an error handler a corrupt/truncated dataUrl (e.g. a partially
    // synced field record) left the editor stuck on "Loading…" forever with no
    // way out but the corner ✕. Surface a clear error instead.
    img.onerror = () => { if (!dead) setLoadError(true); };
    setLoadError(false);
    img.src = srcUrl;
    return () => { dead = true; };
  }, [srcUrl]);

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
      if (s.type === "arrow")     drawArrow(ctx, s, lw);
      else if (s.type === "x")    drawX(ctx, s, lw);
      else if (s.type === "line") drawLine(ctx, s, lw);
      else                        drawFreehand(ctx, s, lw);
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

    if (cs) {
      if (cs.type === "x-preview") {
        const xStroke = buildXStroke(cs.center, cs.color, cs.size, cssToImg, cs.xHeadScale || 1);
        drawX(ctx, xStroke, cs.size * cssToImg);
      } else if (cs.type === "line" && cs.points.length >= 2) {
        // Straight-line preview: first point → current point. Caps with an
        // arrowhead when arrowEnd is on, matching what will be committed.
        const a = cs.points[0], b = cs.points[cs.points.length - 1];
        if (cs.arrowEnd) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const arrow = buildArrowStroke({ start: a, end: b, angle }, cs.color, cs.size, cs.arrowHeadScale || 1);
          drawArrow(ctx, arrow, cs.size * cssToImg);
        } else {
          drawLine(ctx, { start: a, end: b, color: cs.color }, cs.size * cssToImg);
        }
      } else if (cs.points.length >= 2) {
        drawFreehand(ctx, cs, cs.size * cssToImg);
      }
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
        if (s.type === "arrow" || s.type === "line") {
          if (distToSegment(pImg.x, pImg.y, s.start.x, s.start.y, s.end.x, s.end.y) < HIT) {
            return prev.filter((_, j) => j !== i);
          }
        } else if (s.type === "x") {
          const { cx, cy, armLen: arm } = s;
          if (distToSegment(pImg.x, pImg.y, cx - arm, cy - arm, cx + arm, cy + arm) < HIT ||
              distToSegment(pImg.x, pImg.y, cx + arm, cy - arm, cx - arm, cy + arm) < HIT) {
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
        // In X mode, the first tap of this double-tap already stamped an X on
        // its pointer-up (a double-tap is only recognizable here, on the second
        // tap's down). Roll that stray X back so the documented "double-tap to
        // reset the view" gesture doesn't leave an unwanted mark. The double-tap
        // time/radius window above guarantees it's this gesture's X.
        if (xMode) setStrokes(prev => (prev.length && prev[prev.length - 1]?.type === "x") ? prev.slice(0, -1) : prev);
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
      if (xMode) {
        drawingRef.current = true;
        currentStrokeRef.current = { type: "x-preview", center: pImg, color, size: brushSize, xHeadScale };
        forceUpdate(n => n + 1);
        scheduleOverlay();
        return;
      }
      drawingRef.current = true;
      arrowPreviewRef.current = null;
      currentStrokeRef.current = {
        type: lineMode ? "line" : "freehand",
        points: [pImg],
        color,
        size: brushSize,
        arrowEnd,
        arrowHeadScale,
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

      // X-stamp: commit on pointer up at the stored center position
      if (cs.type === "x-preview") {
        currentStrokeRef.current = null;
        const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
        const xStroke = buildXStroke(cs.center, cs.color, cs.size, cssToImg, cs.xHeadScale || 1);
        scheduleOverlay();
        setStrokes(prev => [...prev, xStroke]);
        return;
      }

      if (!cs.points || cs.points.length < 2) {
        currentStrokeRef.current = null;
        scheduleOverlay();
        forceUpdate(n => n + 1);
        return;
      }

      // Line tool: commit a clean straight segment from first → last point,
      // discarding the intermediate freehand jitter. Caps with an arrowhead
      // when arrowEnd is on (line + arrow are one tool).
      if (cs.type === "line") {
        const a = cs.points[0], b = cs.points[cs.points.length - 1];
        currentStrokeRef.current = null;
        scheduleOverlay();
        if (cs.arrowEnd) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const arrow = buildArrowStroke({ start: a, end: b, angle }, cs.color, cs.size, cs.arrowHeadScale || 1);
          setStrokes(prev => [...prev, arrow]);
        } else {
          setStrokes(prev => [...prev, { type: "line", start: a, end: b, color: cs.color, size: cs.size }]);
        }
        return;
      }

      // Commit freehand stroke to base layer. Clear overlay first so the
      // stroke doesn't briefly double-render (base + overlay) on flush.
      currentStrokeRef.current = null;
      scheduleOverlay();
      setStrokes(prev => [...prev, cs]);
    }
  };

  // ── MOUSE WHEEL ZOOM ───────────────────────────────────────────────────────
  // Must be a non-passive listener so e.preventDefault() can block page scroll.
  // Uses a ref for the handler so the effect deps stay stable.
  const onWheelRef = useRef(null);
  onWheelRef.current = (e) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !fit.w) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // ctrlKey=true on macOS trackpad pinch — finer delta; mouse wheel is coarser.
    const factor = Math.exp(e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.002);
    setView(prev => {
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      const midCanvas = {
        x: (cx - prev.tx) / prev.scale,
        y: (cy - prev.ty) / prev.scale,
      };
      const nextTx = cx - nextScale * midCanvas.x;
      const nextTy = cy - nextScale * midCanvas.y;
      return clampView({ scale: nextScale, tx: nextTx, ty: nextTy });
    });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => onWheelRef.current?.(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []); // stable — onWheelRef.current always points to the latest closure

  // ── ACTIONS ────────────────────────────────────────────────────────────────
  const undo     = () => setStrokes(p => p.slice(0, -1));

  // Rotate the photo 90° clockwise. Bakes current annotations into the image
  // first (so they rotate with it), then loads the rotated result as the new
  // source with a cleared stroke list. View re-fits automatically.
  const handleRotate = () => {
    const img = imgRef.current;
    if (!img) return;
    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;

    // Composite image + strokes at native resolution.
    const flat = document.createElement("canvas");
    flat.width = imgDims.w; flat.height = imgDims.h;
    const fctx = flat.getContext("2d");
    fctx.drawImage(img, 0, 0, imgDims.w, imgDims.h);
    strokes.forEach(s => {
      const lw = s.size * cssToImg;
      if (s.type === "arrow")     drawArrow(fctx, s, lw);
      else if (s.type === "x")    drawX(fctx, s, lw);
      else if (s.type === "line") drawLine(fctx, s, lw);
      else                        drawFreehand(fctx, s, lw);
    });

    // Rotate 90° clockwise into a dimension-swapped canvas.
    const rc = document.createElement("canvas");
    rc.width = imgDims.h; rc.height = imgDims.w;
    const rctx = rc.getContext("2d");
    rctx.translate(rc.width, 0);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(flat, 0, 0);

    setStrokes([]);
    setSrcUrl(rc.toDataURL("image/jpeg", 0.92));
  };

  // Clear all markup. Two kinds can exist: baked-in edits from a previous save
  // (removable only by reverting to the stashed clean original) and live strokes
  // from the current session (removable directly). The button shows whenever
  // EITHER exists, so there's always a one-tap "erase all my markup" — not just
  // one-at-a-time Undo. Confirms first so an accidental tap can't wipe real work.
  const hasBaked = !!originalDataUrl && srcUrl !== originalDataUrl;
  const canRevert = hasBaked || strokes.length > 0;
  const handleRevert = () => {
    if (!canRevert) return;
    const msg = hasBaked
      ? "Revert to the original photo? This erases ALL markup on this photo."
      : "Clear all markup on this photo?";
    if (!window.confirm(msg)) return;
    setStrokes([]);
    if (hasBaked) setSrcUrl(originalDataUrl);
  };

  // Render image + all strokes to a new canvas and return a dataUrl.
  const getAnnotatedDataUrl = () => {
    const img = imgRef.current;
    if (!img) return null;
    const fc = document.createElement("canvas");
    fc.width = imgDims.w;
    fc.height = imgDims.h;
    const ctx = fc.getContext("2d");
    ctx.drawImage(img, 0, 0, imgDims.w, imgDims.h);
    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
    strokes.forEach(s => {
      const lw = s.size * cssToImg;
      if (s.type === "arrow")     drawArrow(ctx, s, lw);
      else if (s.type === "x")    drawX(ctx, s, lw);
      else if (s.type === "line") drawLine(ctx, s, lw);
      else                        drawFreehand(ctx, s, lw);
    });
    return fc.toDataURL("image/jpeg", 0.9);
  };

  // Save at full image resolution.
  const handleSave = () => {
    const dataUrl = getAnnotatedDataUrl();
    if (dataUrl) onSave(dataUrl);
  };

  // Navigate to adjacent photo — passes current dataUrl to parent so it can
  // save edits before changing the index (without closing the editor).
  const handleNav = (direction) => {
    const dataUrl = getAnnotatedDataUrl();
    const hasEdits = strokes.length > 0;
    if (direction === "prev" && onPrev) onPrev(dataUrl, hasEdits);
    if (direction === "next" && onNext) onNext(dataUrl, hasEdits);
  };

  // Keyboard: arrow keys step through the photos, Escape backs out. On a
  // laptop, reaching for the on-screen chevrons for every photo is the slow
  // way to review a card's worth of pictures.
  useEffect(() => {
    const onKey = (e) => {
      // Never steal a keystroke from a text field.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft" && hasPrev) { e.preventDefault(); handleNav("prev"); }
      else if (e.key === "ArrowRight" && hasNext) { e.preventDefault(); handleNav("next"); }
      // Down = save a copy. Left/right walk the photos, down takes the one
      // you're looking at — the whole keyboard shape of reviewing a card.
      else if (e.key === "ArrowDown") { e.preventDefault(); handleDownload(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleNav and handleDownload close over the current strokes, so this is
    // re-bound as they change or a keypress would act on a stale set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPrev, hasNext, onPrev, onNext, onCancel, strokes, imgDims, fit]);

  // Download the current canvas (image + all annotations) without saving back.
  const handleDownload = () => {
    const img = imgRef.current;
    if (!img) return;
    const fc = document.createElement("canvas");
    fc.width = imgDims.w; fc.height = imgDims.h;
    const ctx = fc.getContext("2d");
    ctx.drawImage(img, 0, 0, imgDims.w, imgDims.h);
    const cssToImg = fit.w > 0 ? imgDims.w / fit.w : 1;
    strokes.forEach(s => {
      const lw = s.size * cssToImg;
      if (s.type === "arrow")     drawArrow(ctx, s, lw);
      else if (s.type === "x")    drawX(ctx, s, lw);
      else if (s.type === "line") drawLine(ctx, s, lw);
      else                        drawFreehand(ctx, s, lw);
    });
    fc.toBlob(blob => {
      if (!blob) return;
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl; a.download = `photo_markup_${Date.now()}.jpg`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    }, "image/jpeg", 0.9);
  };

  // ── RENDER ─────────────────────────────────────────────────────────────────

  // On a laptop the rail can be one compact row instead of a stack: there is
  // width to spare, and three stacked pills climbed a third of the way up the
  // picture. Narrow screens keep the stack, which is the only thing that fits.
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 820);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 820);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Dimmed until pointed at, so the controls stop competing with the photo.
  const [railHot, setRailHot] = useState(false);
  // The jump-to strip is closed by default and overlays nothing when it is —
  // this screen is for looking at a photo, so a permanent filmstrip would be
  // in the way every second you are not using it.
  const [stripOpen, setStripOpen] = useState(false);

  const jumpTo = (i) => {
    if (i === index) { setStripOpen(false); return; }
    onJump?.(getAnnotatedDataUrl(), strokes.length > 0, i);
    setStripOpen(false);
  };

  const railChrome = {
    background: "rgba(28,28,30,.72)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    backdropFilter: "blur(20px) saturate(180%)",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 2px 10px rgba(0,0,0,.35)",
  };

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
          position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 12,
          alignItems: "center", justifyContent: "center",
          color: loadError ? "#e08080" : "#5a5a5a", fontSize: 14, textAlign: "center", padding: 24,
        }}>
          {loadError ? (
            <>
              <div>This photo couldn't be loaded — it may not have finished syncing.</div>
              <button onClick={onCancel} style={{ padding: "8px 18px", borderRadius: 8, background: "rgba(255,255,255,.1)", border: "1px solid #333", color: "#ccc", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Close</button>
            </>
          ) : "Loading…"}
        </div>
      )}

      {/* ── TOP BAR ────────────────────────────────────────────────────
          One row, pinned to both edges: leave/undo on the left, commit on the
          right. Everything else moved to the bottom tool rail.

          It used to be two clusters — and the right-hand one held EIGHT
          44px buttons in a non-wrapping flex row. That is 440px of controls
          before the "Done" pill, on a 390px phone: they overlapped the
          left-hand cluster and ran off the edge of the screen, which is what
          made this screen unusable on mobile. Nothing here can overflow now,
          because nothing here grows with the tool count. */}
      <div data-pm-ctl style={{
        position: "absolute",
        top: "max(12px, env(safe-area-inset-top))",
        left: "max(12px, env(safe-area-inset-left))",
        right: "max(12px, env(safe-area-inset-right))",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8, pointerEvents: "none",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", pointerEvents: "auto" }}>
          <button onClick={onCancel} style={fab()} title="Cancel">
            <IconX size={22} color="#fff" />
          </button>
          {canRevert && (
            <button
              onClick={handleRevert}
              onPointerDown={e => e.stopPropagation()}
              style={{ ...fab(), width: "auto", padding: "0 14px", gap: 6, fontSize: 13, fontWeight: 600 }}
              title={hasBaked ? "Revert to the original, un-edited photo" : "Erase all markup on this photo"}
            >
              <IconRotateCcw size={16} color="#fff" />
              {hasBaked ? "Original" : "Clear"}
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", pointerEvents: "auto" }}>
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
      </div>

      {/* ── PREV / NEXT photo navigation ───────────────────────────────── */}
      {hasPrev && (
        <div data-pm-ctl style={{
          position: "absolute",
          left: "max(12px, env(safe-area-inset-left))",
          top: "50%",
          transform: "translateY(-50%)",
        }}>
          <button
            onClick={() => handleNav("prev")}
            onPointerDown={e => e.stopPropagation()}
            style={fab()}
            title="Previous photo"
          >
            <IconArrowLeft size={20} color="#fff" />
          </button>
        </div>
      )}
      {hasNext && (
        <div data-pm-ctl style={{
          position: "absolute",
          right: "max(12px, env(safe-area-inset-right))",
          top: "50%",
          transform: "translateY(-50%)",
        }}>
          <button
            onClick={() => handleNav("next")}
            onPointerDown={e => e.stopPropagation()}
            style={fab()}
            title="Next photo"
          >
            <IconArrowRight size={20} color="#fff" />
          </button>
        </div>
      )}

      {/* ── BOTTOM RAIL: line options + colors + brushes + tools ─────────
          On a laptop this collapses to a single row so it occupies one strip
          at the bottom edge instead of a stack climbing up the photo, and it
          sits at reduced opacity until the pointer comes near. Touch screens
          keep the stack — it's the only arrangement that fits — and stay at
          full opacity, since there is no pointer to detect. */}
      <div
        data-pm-ctl
        onMouseEnter={() => setRailHot(true)}
        onMouseLeave={() => setRailHot(false)}
        style={{
          position: "absolute",
          left: 0, right: 0,
          bottom: "max(16px, env(safe-area-inset-bottom))",
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: wide ? 8 : 10,
          opacity: wide && !railHot ? 0.45 : 1,
          transition: "opacity .18s",
          pointerEvents: "none", // outer wrapper lets touches pass through; pills opt in
        }}
      >
        {/* Jump-to strip. Closed by default and gone from the screen entirely
            when closed, so marking up a photo is never done around a filmstrip.
            Open it from the grid button in the tool rail. */}
        {stripOpen && strip.length > 1 && (
          <div style={{
            display: "flex", gap: 6, padding: "6px 8px", alignItems: "center",
            maxWidth: "calc(100vw - 20px)", overflowX: "auto",
            background: "rgba(28,28,30,.82)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            backdropFilter: "blur(20px) saturate(180%)",
            borderRadius: 14,
            border: "1px solid rgba(255,255,255,.12)",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)",
            pointerEvents: "auto",
            WebkitOverflowScrolling: "touch", scrollbarWidth: "none",
          }}>
            {strip.map((ph, i) => (
              <button
                key={ph.key ?? i}
                onClick={() => jumpTo(i)}
                onPointerDown={e => e.stopPropagation()}
                title={`Photo ${i + 1} of ${strip.length}`}
                style={{
                  flexShrink: 0, width: 52, height: 52, padding: 0, borderRadius: 8,
                  overflow: "hidden", cursor: "pointer", background: "#1a1f2b",
                  border: i === index ? "2.5px solid #0a84ff" : "1px solid rgba(255,255,255,.18)",
                  opacity: i === index ? 1 : 0.72,
                }}
              >
                {ph.src && <img src={ph.src} alt="" draggable={false}
                                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
              </button>
            ))}
          </div>
        )}

        {/* Line tool: arrow-end toggle + (when on) arrowhead size (3 sizes) */}
        {lineMode && (
          <div style={{
            display: "flex", gap: 4, padding: "6px 10px",
            background: "rgba(28,28,30,.72)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            backdropFilter: "blur(20px) saturate(180%)",
            borderRadius: 999,
            border: "1px solid rgba(0,122,255,.45)",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)",
            pointerEvents: "auto",
            alignItems: "center",
          }}>
            <button
              onClick={() => setArrowEnd(v => !v)}
              title={arrowEnd ? "Arrow end on — tap for plain line" : "Plain line — tap to add arrow end"}
              style={{
                width: 56, height: 34, borderRadius: 8,
                background: arrowEnd ? "rgba(0,122,255,.35)" : "transparent",
                border: arrowEnd ? "1px solid rgba(0,122,255,.7)" : "1px solid rgba(255,255,255,.2)",
                cursor: "pointer", padding: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="42" height="18" viewBox="0 0 42 18" fill="none">
                <line x1="3" y1="9" x2={arrowEnd ? 32 : 39} y2="9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
                {arrowEnd && (
                  <polyline points="30,3 39,9 30,15" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                )}
              </svg>
            </button>
            {arrowEnd && (
              <div style={{ width: 1, height: 22, background: "rgba(255,255,255,.18)", margin: "0 2px" }} />
            )}
            {arrowEnd && ARROWHEAD_SCALES.map((scale, i) => {
              const active = arrowHeadScale === scale;
              const headSize = [7, 11, 15][i]; // small / large / XL preview sizes
              return (
                <button
                  key={scale}
                  onClick={() => setArrowHeadScale(scale)}
                  title={["Small", "Large", "XL"][i] + " arrowhead"}
                  style={{
                    width: 42, height: 34, borderRadius: 8,
                    background: active ? "rgba(0,122,255,.35)" : "transparent",
                    border: active ? "1px solid rgba(0,122,255,.7)" : "1px solid transparent",
                    cursor: "pointer", padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <svg width="36" height="18" viewBox="0 0 36 18" fill="none">
                    <line x1="2" y1="9" x2={34 - headSize} y2="9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
                    <polyline
                      points={`${34 - headSize},${9 - headSize} 34,9 ${34 - headSize},${9 + headSize}`}
                      fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                    />
                  </svg>
                </button>
              );
            })}
          </div>
        )}

        {/* X stamp size — only shown when X mode is active */}
        {xMode && (
          <div style={{
            display: "flex", gap: 4, padding: "6px 10px",
            background: "rgba(28,28,30,.72)",
            WebkitBackdropFilter: "blur(20px) saturate(180%)",
            backdropFilter: "blur(20px) saturate(180%)",
            borderRadius: 999,
            border: "1px solid rgba(0,122,255,.45)",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)",
            pointerEvents: "auto",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,.5)", fontWeight: 600, marginRight: 4, letterSpacing: 0.5 }}>SIZE</span>
            {X_SCALES.map((scale, i) => {
              const active = xHeadScale === scale;
              const arm = [2, 4, 7, 11, 15][i]; // XS→XL arm half-lengths in SVG preview
              return (
                <button
                  key={scale}
                  onClick={() => setXHeadScale(scale)}
                  title={["XS", "Small", "Medium", "Large", "XL"][i] + " X"}
                  style={{
                    width: 36, height: 34, borderRadius: 8,
                    background: active ? "rgba(0,122,255,.35)" : "transparent",
                    border: active ? "1px solid rgba(0,122,255,.7)" : "1px solid transparent",
                    cursor: "pointer", padding: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                    <line x1={16 - arm} y1={16 - arm} x2={16 + arm} y2={16 + arm} stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
                    <line x1={16 + arm} y1={16 - arm} x2={16 - arm} y2={16 + arm} stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                </button>
              );
            })}
          </div>
        )}

        {/* Colours, brushes and tools. One pill on a wide screen, three
            stacked pills on a narrow one — same markup either way, so there
            is no second layout to keep in sync. */}
        <div style={{
          display: "flex", alignItems: "center",
          flexDirection: wide ? "row" : "column",
          gap: wide ? 0 : 10,
          maxWidth: "calc(100vw - 20px)",
          pointerEvents: wide ? "auto" : "none",
          ...(wide ? { ...railChrome, padding: "4px 6px" } : {}),
        }}>

        {/* Colors */}
        <div style={{
          display: "flex", gap: 10, alignItems: "center",
          padding: wide ? "0 12px" : "8px 14px",
          ...(wide ? {} : railChrome),
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

        {/* Brush sizes */}
        <div style={{
          display: "flex", gap: 6, alignItems: "center",
          padding: wide ? "0 8px" : "6px 8px",
          ...(wide
            ? { borderLeft: "1px solid rgba(255,255,255,.14)" }
            : railChrome),
          pointerEvents: "auto",
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
        </div>

        {/* Tools. Down here rather than in the top bar: this is the row you
            reach for constantly, and the bottom of the screen is where a thumb
            already is. Scrolls horizontally so adding a tool can never push
            another one off the screen again. */}
        <div style={{
          display: "flex", gap: 6, alignItems: "center",
          padding: wide ? "0 4px 0 8px" : "6px 8px",
          // minWidth:0 lets this shrink inside the merged row so the scroll
          // actually engages instead of pushing the pill past the window.
          minWidth: 0, maxWidth: "calc(100vw - 20px)", overflowX: "auto",
          ...(wide
            ? { borderLeft: "1px solid rgba(255,255,255,.14)" }
            : railChrome),
          pointerEvents: "auto",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}>
          <button onClick={() => setTool("x")} style={{ ...fab(xMode), flexShrink: 0 }} title="Stamp an X mark">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <line x1="3" y1="3" x2="17" y2="17" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="17" y1="3" x2="3" y2="17" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </button>
          <button onClick={() => setTool("freehand")} style={{ ...fab(freehandMode), flexShrink: 0 }} title="Freehand draw">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M3 16c2-1 3-4 5-4s2 3 4 2 2-7 5-9" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button onClick={() => setTool("line")} style={{ ...fab(lineMode), flexShrink: 0 }} title="Line / arrow">
            {arrowEnd
              ? <IconArrowUpRight size={20} color="#fff" />
              : (
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <line x1="3" y1="17" x2="17" y2="3" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
                </svg>
              )}
          </button>
          <button onClick={() => setTool("eraser")} style={{ ...fab(eraserMode, true), flexShrink: 0 }} title="Eraser">
            <IconEraser size={20} color="#fff" />
          </button>
          <button onClick={handleRotate} style={{ ...fab(), flexShrink: 0 }} title="Rotate 90°">
            <IconRotateCcw size={20} color="#fff" />
          </button>
          <button onClick={handleDownload} style={{ ...fab(), flexShrink: 0 }} title="Download photo with annotations">
            <IconDownload size={20} color="#fff" />
          </button>

          {/* Jump to any photo on the card. */}
          {strip.length > 1 && (
            <button
              onClick={() => setStripOpen(v => !v)}
              onPointerDown={e => e.stopPropagation()}
              style={{ ...fab(stripOpen), flexShrink: 0 }}
              title="Jump to another photo"
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
                   stroke={stripOpen ? "#fff" : "#fff"} strokeWidth="1.9" strokeLinejoin="round">
                <rect x="3" y="4" width="7" height="7" rx="1.5" />
                <rect x="14" y="4" width="7" height="7" rx="1.5" />
                <rect x="3" y="15" width="7" height="5" rx="1.5" />
                <rect x="14" y="15" width="7" height="5" rx="1.5" />
              </svg>
            </button>
          )}

          {/* Site-plan toggle. The moment you're looking at a photo full size
              is the moment you know whether it belongs on the plan, so the
              switch belongs here and not only back on the card. */}
          {onPlan !== null && (
            <button
              onClick={onTogglePlan}
              onPointerDown={e => e.stopPropagation()}
              style={{
                ...fab(),
                width: "auto", padding: "0 14px", gap: 6, flexShrink: 0,
                fontSize: 13, fontWeight: 700, whiteSpace: "nowrap",
                background: onPlan ? "rgba(246,191,38,.92)" : "rgba(28,28,30,.72)",
                color: onPlan ? "#1a1400" : "#8b93a4",
              }}
              title={onPlan
                ? "On the site plan — tap to leave it off"
                : "Not on the site plan — tap to include it"}
            >
              <IconMapPin size={16} color={onPlan ? "#1a1400" : "#8b93a4"} />
              {onPlan ? "On Plan" : "Off Plan"}
            </button>
          )}
        </div>

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
