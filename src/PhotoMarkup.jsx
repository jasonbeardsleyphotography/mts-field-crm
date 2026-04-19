import { useState, useRef, useEffect, useCallback } from "react";
import { IconArrowUpRight, IconEraser, IconUndo, IconX } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Photo Markup
   Full-screen canvas annotation. Freehand drawing + auto-arrow detection.
   When you draw a roughly straight line and lift, it snaps to a clean arrow
   with a proper arrowhead (like Apple Markup).
   ═══════════════════════════════════════════════════════════════════════════ */

const COLORS = [
  { name: "Red",    hex: "#FF3B30" },
  { name: "Yellow", hex: "#FFCC00" },
  { name: "White",  hex: "#FFFFFF" },
  { name: "Blue",   hex: "#007AFF" },
  { name: "Green",  hex: "#34C759" },
];

const SIZES = [3, 6, 10];

// ── ARROW DETECTION ──────────────────────────────────────────────────────────
// If a stroke is mostly straight (>75% efficiency) and long enough, convert it
// to a clean arrow. Short pause after lifting = snap.

function analyzeStroke(points) {
  if (points.length < 4) return null;

  const start = points[0];
  const end = points[points.length - 1];

  // Straight-line distance
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const straightDist = Math.sqrt(dx * dx + dy * dy);

  // Minimum length to qualify as arrow (not a tap or small mark)
  if (straightDist < 40) return null;

  // Total path length
  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    const px = points[i].x - points[i-1].x;
    const py = points[i].y - points[i-1].y;
    pathLen += Math.sqrt(px * px + py * py);
  }

  // Straightness ratio: 1.0 = perfectly straight
  const ratio = pathLen > 0 ? straightDist / pathLen : 0;

  // Also check max deviation from the line
  const angle = Math.atan2(dy, dx);
  let maxDev = 0;
  for (const p of points) {
    const rx = p.x - start.x;
    const ry = p.y - start.y;
    // Perpendicular distance to line
    const dev = Math.abs(rx * Math.sin(angle) - ry * Math.cos(angle));
    if (dev > maxDev) maxDev = dev;
  }

  // Arrow if: ratio > 0.75 AND max deviation < 25px
  if (ratio > 0.72 && maxDev < 30) {
    return { start, end, angle: Math.atan2(dy, dx) };
  }

  return null;
}

function buildArrowStroke(arrowInfo, color, size) {
  const { start, end, angle } = arrowInfo;

  // Arrowhead: two lines from the tip, angled back
  const headLen = Math.max(16, size * 4);
  const headAngle = 0.45; // ~25 degrees

  const tip = end;
  const left = {
    x: tip.x - headLen * Math.cos(angle - headAngle),
    y: tip.y - headLen * Math.sin(angle - headAngle),
  };
  const right = {
    x: tip.x - headLen * Math.cos(angle + headAngle),
    y: tip.y - headLen * Math.sin(angle + headAngle),
  };

  return {
    type: "arrow",
    start, end, left, right,
    color, size,
  };
}

// ── DRAWING HELPERS ──────────────────────────────────────────────────────────

function drawFreehand(ctx, stroke) {
  if (stroke.points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  ctx.stroke();
}

function drawArrow(ctx, arrow) {
  // Shaft
  ctx.beginPath();
  ctx.strokeStyle = arrow.color;
  ctx.lineWidth = arrow.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.moveTo(arrow.start.x, arrow.start.y);
  ctx.lineTo(arrow.end.x, arrow.end.y);
  ctx.stroke();

  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(arrow.left.x, arrow.left.y);
  ctx.lineTo(arrow.end.x, arrow.end.y);
  ctx.lineTo(arrow.right.x, arrow.right.y);
  ctx.strokeStyle = arrow.color;
  ctx.lineWidth = arrow.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

// ═════════════════════════════════════════════════════════════════════════════

export default function PhotoMarkup({ photoDataUrl, onSave, onCancel }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const [color, setColor] = useState(COLORS[0].hex);
  const [brushSize, setBrushSize] = useState(SIZES[1]);
  const [drawing, setDrawing] = useState(false);
  const [strokes, setStrokes] = useState([]); // mixed: {type:"freehand", points, color, size} or {type:"arrow", ...}
  const [currentStroke, setCurrentStroke] = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0, scale: 1 });
  const [arrowPreview, setArrowPreview] = useState(null);
  const [arrowMode, setArrowMode] = useState(false);
  const [eraserMode, setEraserMode] = useState(false);
  const [canvasPinchScale, setCanvasPinchScale] = useState(1);

  // Load image
  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.src = photoDataUrl;
  }, [photoDataUrl]);

  // Size canvas
  useEffect(() => {
    if (!imgLoaded || !imgRef.current || !containerRef.current) return;
    const container = containerRef.current;
    const maxW = container.clientWidth;
    const maxH = container.clientHeight;
    const img = imgRef.current;
    const scale = Math.min(maxW / img.width, maxH / img.height);
    setCanvasSize({ w: Math.floor(img.width * scale), h: Math.floor(img.height * scale), scale });
  }, [imgLoaded]);

  // Redraw
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !canvasSize.w) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // All committed strokes
    strokes.forEach(s => {
      if (s.type === "arrow") drawArrow(ctx, s);
      else drawFreehand(ctx, s);
    });

    // Arrow preview (flashes green ring briefly)
    if (arrowPreview) {
      drawArrow(ctx, arrowPreview);
    }

    // Current live stroke
    if (currentStroke && currentStroke.points.length >= 2) {
      drawFreehand(ctx, currentStroke);
    }
  }, [strokes, currentStroke, arrowPreview, canvasSize]);

  useEffect(() => { redraw(); }, [redraw]);

  // Canvas coords from event
  const getPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };

  // Distance from point to line segment
  const distToSegment = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };

  const eraseAtPoint = (pos) => {
    const HIT = 15; // pixel tolerance
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (s.type === "arrow") {
        if (distToSegment(pos.x, pos.y, s.start.x, s.start.y, s.end.x, s.end.y) < HIT) {
          setStrokes(prev => prev.filter((_, j) => j !== i));
          return;
        }
      } else if (s.points) {
        for (let k = 0; k < s.points.length - 1; k++) {
          if (distToSegment(pos.x, pos.y, s.points[k].x, s.points[k].y, s.points[k+1].x, s.points[k+1].y) < HIT) {
            setStrokes(prev => prev.filter((_, j) => j !== i));
            return;
          }
        }
      }
    }
  };

  const startDraw = (e) => {
    e.preventDefault();
    if (eraserMode) { eraseAtPoint(getPos(e)); return; }
    setDrawing(true);
    setArrowPreview(null);
    setCurrentStroke({ type: "freehand", points: [getPos(e)], color, size: brushSize });
  };

  const moveDraw = (e) => {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    setCurrentStroke(prev => ({ ...prev, points: [...prev.points, getPos(e)] }));
  };

  const endDraw = (e) => {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    setDrawing(false);

    if (currentStroke.points.length < 2) {
      setCurrentStroke(null);
      return;
    }

    // Check for arrow shape only if arrow mode is enabled
    const arrowInfo = arrowMode ? analyzeStroke(currentStroke.points) : null;
    if (arrowInfo) {
      const arrow = buildArrowStroke(arrowInfo, currentStroke.color, currentStroke.size);
      setArrowPreview(arrow);
      setCurrentStroke(null);
      // Brief flash then commit
      setTimeout(() => {
        setStrokes(prev => [...prev, arrow]);
        setArrowPreview(null);
      }, 150);
    } else {
      // Regular freehand stroke
      setStrokes(prev => [...prev, currentStroke]);
      setCurrentStroke(null);
    }
  };

  const undo = () => { setStrokes(prev => prev.slice(0, -1)); };
  const clearAll = () => { setStrokes([]); };

  // Save at full resolution
  const handleSave = () => {
    const img = imgRef.current;
    if (!img) return;
    const fc = document.createElement("canvas");
    fc.width = img.width; fc.height = img.height;
    const ctx = fc.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const sx = img.width / canvasSize.w;
    const sy = img.height / canvasSize.h;

    // Scale and draw each stroke at full res
    strokes.forEach(s => {
      if (s.type === "arrow") {
        const scaled = {
          ...s,
          start: { x: s.start.x * sx, y: s.start.y * sy },
          end: { x: s.end.x * sx, y: s.end.y * sy },
          left: { x: s.left.x * sx, y: s.left.y * sy },
          right: { x: s.right.x * sx, y: s.right.y * sy },
          size: s.size * sx,
        };
        drawArrow(ctx, scaled);
      } else {
        const scaled = {
          ...s,
          points: s.points.map(p => ({ x: p.x * sx, y: p.y * sy })),
          size: s.size * sx,
        };
        drawFreehand(ctx, scaled);
      }
    });

    onSave(fc.toDataURL("image/jpeg", 0.8));
  };

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:300, background:"#000",
      display:"flex", flexDirection:"column",
      touchAction:"none", userSelect:"none", WebkitUserSelect:"none",
    }}>

      {/* ── TOP BAR ──────────────────────────────────────────────────── */}
      <div style={{
        display:"flex", alignItems:"center", gap:6, padding:"8px 10px",
        background:"#111", borderBottom:"1px solid #2a2a2a", flexShrink:0,
        paddingTop:"max(8px, env(safe-area-inset-top))",
      }}>
        <button onClick={onCancel} style={{padding:"7px 11px",borderRadius:8,background:"transparent",border:"1px solid #3a3a3a",color:"#aaa",fontSize:11,cursor:"pointer"}}>Cancel</button>
        <div style={{flex:1}}/>
        <button onClick={()=>{setArrowMode(!arrowMode);if(!arrowMode)setEraserMode(false);}} title="Arrow" style={{padding:"8px",borderRadius:8,background:arrowMode?"rgba(0,122,255,.2)":"transparent",border:`1px solid ${arrowMode?"#007AFF":"#3a3a3a"}`,cursor:"pointer",display:"flex",alignItems:"center"}}>
          <IconArrowUpRight size={16} color={arrowMode?"#007AFF":"#aaa"} />
        </button>
        <button onClick={()=>{setEraserMode(!eraserMode);if(!eraserMode)setArrowMode(false);}} title="Erase" style={{padding:"8px",borderRadius:8,background:eraserMode?"rgba(255,100,100,.2)":"transparent",border:`1px solid ${eraserMode?"#ff6b6b":"#3a3a3a"}`,cursor:"pointer",display:"flex",alignItems:"center"}}>
          <IconEraser size={16} color={eraserMode?"#ff6b6b":"#aaa"} />
        </button>
        <button onClick={undo} disabled={!strokes.length} title="Undo" style={{padding:"8px",borderRadius:8,background:"transparent",border:"1px solid #3a3a3a",cursor:strokes.length?"pointer":"default",display:"flex",alignItems:"center",opacity:strokes.length?1:.3}}>
          <IconUndo size={16} color="#fff" />
        </button>
        <button onClick={handleSave} style={{padding:"7px 14px",borderRadius:8,background:"#007AFF",border:"none",color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer"}}>Done</button>
      </div>

      {/* ── CANVAS ───────────────────────────────────────────────────── */}
      <div ref={containerRef} style={{flex:1, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden", padding:8, touchAction:"none"}}
        onTouchStart={e => {
          if (e.touches.length === 2) {
            // Pinch start — store initial distance
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            containerRef.current._pinchDist = Math.sqrt(dx*dx + dy*dy);
            containerRef.current._pinchScale = canvasPinchScale;
          }
        }}
        onTouchMove={e => {
          if (e.touches.length === 2) {
            e.preventDefault();
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            const initDist = containerRef.current._pinchDist || dist;
            const initScale = containerRef.current._pinchScale || 1;
            const next = Math.max(1, Math.min(5, initScale * (dist / initDist)));
            setCanvasPinchScale(next);
          }
        }}
      >
        {canvasSize.w > 0 && (
          <canvas
            ref={canvasRef}
            width={canvasSize.w}
            height={canvasSize.h}
            onTouchStart={startDraw}
            onTouchMove={moveDraw}
            onTouchEnd={endDraw}
            onMouseDown={startDraw}
            onMouseMove={moveDraw}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            style={{ width: canvasSize.w * canvasPinchScale, height: canvasSize.h * canvasPinchScale, borderRadius:4, touchAction:"none", transformOrigin:"center center" }}
          />
        )}
        {!imgLoaded && <div style={{color:"#5a5a5a",fontSize:14}}>Loading...</div>}
      </div>

      {/* ── BOTTOM TOOLBAR ───────────────────────────────────────────── */}
      <div style={{
        padding:"10px 16px", background:"#111", borderTop:"1px solid #2a2a2a",
        paddingBottom:"max(10px, env(safe-area-inset-bottom))", flexShrink:0,
      }}>
        {/* Hint */}

        {/* Colors */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:10}}>
          {COLORS.map(c => (
            <button key={c.hex} onClick={() => setColor(c.hex)} style={{
              width: color === c.hex ? 36 : 28,
              height: color === c.hex ? 36 : 28,
              borderRadius: "50%", background: c.hex,
              border: color === c.hex ? "3px solid #fff" : c.hex === "#FFFFFF" ? "2px solid #555" : "2px solid transparent",
              cursor: "pointer", transition: "all .15s",
              boxShadow: color === c.hex ? `0 0 12px ${c.hex}60` : "none",
            }}/>
          ))}
        </div>

        {/* Brush sizes */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:16}}>
          {SIZES.map(s => (
            <button key={s} onClick={() => setBrushSize(s)} style={{
              width:44, height:44, borderRadius:22,
              background: brushSize === s ? "#2a2a2a" : "transparent",
              border: brushSize === s ? "1px solid #4a4a4a" : "1px solid transparent",
              display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer",
            }}>
              <div style={{
                width: s * 2 + 4, height: s * 2 + 4,
                borderRadius: "50%", background: color,
                opacity: brushSize === s ? 1 : 0.5,
              }}/>
            </button>
          ))}
          <div style={{color:"#5a5a5a",fontSize:11,fontWeight:600,marginLeft:4}}>
            {brushSize === 3 ? "Fine" : brushSize === 6 ? "Medium" : "Thick"}
          </div>
        </div>
      </div>
    </div>
  );
}
