import { useState, useRef, useEffect, useCallback } from "react";
import { IconX } from "./icons";
import { useCoverVideo } from "./coverVideo";
import { scoreSharpness } from "./sharpness";
import { PHOTO_MAX_DIM, PHOTO_QUALITY, makeThumb } from "./imageUtils";
import { setPhotoSyncPaused } from "./photoSync";
import { flog } from "./freezeLog";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Camera View
   Production-quality mobile camera matching the native iOS Camera feel.

   Features
   ────────
   • Full-screen viewfinder — video is position:absolute inset:0 so rotating
     the device never collapses the preview. Controls float over the video.
   • Close (✕) and lens-preset pills live in the bottom strip beside the
     shutter, so the important controls never move on rotate.
   • Volume-Up key fires the shutter (Android Chrome; iOS doesn't expose
     volume keys to web pages, but the listener is harmless).
   • Defaults to 0.5× ultrawide on supported iPhones (zoom.min ≤ 0.5).
   • Pinch-to-zoom on the viewfinder.
   • Lens preset pills (0.5× / 1× / 2×) above the shutter.
   • Tap-to-focus with animated yellow square.
   • Torch toggle (when device exposes it).
   • Rule-of-thirds grid overlay.
   • Shutter flash + haptic.

   Gesture model (Pointer Events API, touch-action:none)
   ─────────────────────────────────────────────────────
   • 1 pointer down → tap-vs-drag. If no pinch and didn't move far → tap-focus.
   • 2 pointers → pinch zoom.
   ═══════════════════════════════════════════════════════════════════════════ */

const PRESET_LENSES       = [0.5, 1, 2];
const PRESET_TOLERANCE    = 0.05;
const TAP_MOVE_THRESHOLD  = 12;   // px — above this, treat as drag not tap
const ZOOM_PILL_HIDE_MS   = 1500;
const FOCUS_INDICATOR_MS  = 800;
const BURST_FRAME_COUNT   = 2;    // frames grabbed per shutter press; sharpest wins (2: each frame is real work on a phone)

// Free a canvas's backing store immediately (0×0 releases the pixel buffer)
// rather than waiting for GC — important at full sensor resolution.
function releaseCanvas(c) { try { c.width = 0; c.height = 0; } catch {} }

// Grabs `count` frames from `video` a rAF tick apart, scoring each for
// sharpness, and returns the canvas holding the sharpest one.
//
// Frames are drawn straight at the FINAL photo size into two canvases that
// live for as long as the camera is open (`pair`), swapping which one holds
// the best frame. The old version allocated a fresh full-sensor (4K, ~33 MB)
// canvas for every frame — three per tap — and repeated big allocations like
// that are what run Safari out of canvas memory and stall it.
async function grabBurst(video, pair, count, mountedRef) {
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (!mountedRef.current) break;
    const target = pair[0] === best ? pair[1] : pair[0];
    try {
      flog(`cam: grab frame ${i + 1}`, `${target.width}x${target.height}`);
      const t0 = performance.now();
      target.getContext("2d").drawImage(video, 0, 0, target.width, target.height);
      const t1 = performance.now();
      let score = -Infinity;
      try { score = scoreSharpness(target); } catch {}
      flog(`cam: frame ${i + 1} done`, `draw ${Math.round(t1 - t0)}ms, score ${Math.round(performance.now() - t1)}ms`);
      if (!best || score > bestScore) { best = target; bestScore = score; }
    } catch (e) { flog(`cam: frame ${i + 1} failed`, e?.message || String(e)); }
  }
  return best;
}

const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch {} };

// The chosen frame -> the stored JPEG, in one step: it is already at the
// final size, and toBlob encodes off the main thread.
async function encodeFrame(c) {
  flog("cam: encode (toBlob) …");
  const blob = await new Promise((res) => {
    // A toBlob that never calls back would leave the shutter locked for good.
    const t = setTimeout(() => { flog("cam: toBlob TIMED OUT (8s)"); res(null); }, 8000);
    try { c.toBlob((bl) => { clearTimeout(t); res(bl); }, "image/jpeg", PHOTO_QUALITY); }
    catch (e) { clearTimeout(t); flog("cam: toBlob threw", e?.message); res(null); }
  });
  flog("cam: encode done", blob ? `${Math.round(blob.size / 1024)}KB` : "no blob");
  if (blob) {
    return await new Promise((res) => {
      const r = new FileReader();
      const t = setTimeout(() => { flog("cam: FileReader TIMED OUT (8s)"); res(null); }, 8000);
      r.onload = () => { clearTimeout(t); res(r.result); };
      r.onerror = () => { clearTimeout(t); res(null); };
      r.readAsDataURL(blob);
    });
  }
  try { return c.toDataURL("image/jpeg", PHOTO_QUALITY); } catch { return null; }
}

// Which physical edge of the device the portrait-bottom edge currently sits
// on. Rotating the phone counterclockwise (angle 90) puts that edge on the
// right; clockwise (angle 270 / -90) puts it on the left. The shutter strip
// follows it so the button stays under the same thumb in any orientation —
// like the native Camera app, which rotates icons but never moves controls.
function portraitBottomEdge() {
  let a = 0;
  try { a = screen.orientation?.angle ?? window.orientation ?? 0; } catch {}
  if (a === 90) return "right";
  if (a === -90 || a === 270) return "left";
  return "bottom";
}

export default function CameraView({ onPhoto, onClose }) {
  const videoRef           = useRef(null);
  useCoverVideo(videoRef);   // fill the screen even when iOS ignores object-fit
  const streamRef          = useRef(null);
  const trackRef           = useRef(null);
  const containerRef       = useRef(null);
  const mountedRef         = useRef(true);
  const captureInFlightRef = useRef(false);
  const pendingShotRef     = useRef(false);   // one press remembered while a shot is in progress
  const captureRef         = useRef(null);
  const framePairRef       = useRef(null);
  const shotStartRef       = useRef(0);   // the two reusable frame buffers (see grabBurst)
  useEffect(() => () => { framePairRef.current?.forEach(releaseCanvas); framePairRef.current = null; }, []);
  // Hold background photo uploads while the camera is open (see photoSync).
  // __mtsCameraOpen also holds the Drive pull's downloads (App.jsx).
  useEffect(() => {
    setPhotoSyncPaused(true); window.__mtsCameraOpen = true;
    flog("cam: OPEN");
    return () => { setPhotoSyncPaused(false); window.__mtsCameraOpen = false; flog("cam: closed"); };
  }, []);

  // Stream readiness
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // Shutter UX
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);

  // Zoom
  const [zoom, setZoom]             = useState(1);
  const [zoomCaps, setZoomCaps]     = useState({ min: 1, max: 1, step: 0.1, supported: false });
  const [zoomPillOn, setZoomPillOn] = useState(false);
  const zoomPillHideRef             = useRef(null);

  // Torch
  const [torchOn, setTorchOn]               = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  // Grid
  const [gridOn, setGridOn] = useState(false);

  // Tap-to-focus indicator
  const [focusPoint, setFocusPoint] = useState(null); // {x,y,t}

  // Gesture tracking
  const pointersRef = useRef(new Map());
  const pinchRef    = useRef(null);
  const gestureRef  = useRef({ pinched: false, movedFar: false });

  // Orientation — drives where the shutter strip is anchored
  const [ctrlEdge, setCtrlEdge] = useState(portraitBottomEdge);
  useEffect(() => {
    const update = () => setCtrlEdge(portraitBottomEdge());
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    try { screen.orientation?.addEventListener?.("change", update); } catch {}
    return () => {
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
      try { screen.orientation?.removeEventListener?.("change", update); } catch {}
    };
  }, []);

  // ── CAMERA STREAM SETUP ────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;

    (async () => {
      const CONSTRAINTS = [
        { facingMode: "environment", width: { ideal: 3840 }, height: { ideal: 2160 } },
        { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        { facingMode: "environment" },
      ];

      let stream = null;
      let lastErr = null;
      for (const video of CONSTRAINTS) {
        if (dead) return;
        try {
          stream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video, audio: false }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
          ]);
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`Camera constraint failed (${JSON.stringify(video)}):`, e?.message);
        }
      }

      if (!stream) {
        if (!dead) {
          flog("cam: could not start", lastErr?.name || String(lastErr));
          setError(lastErr?.name === "NotAllowedError"
            ? "Camera permission denied. Enable it in Settings → Safari → Camera."
            : "Camera unavailable.");
          setTimeout(() => onClose?.(), 1800);
        }
        return;
      }

      if (dead) { stream.getTracks().forEach(t => t.stop()); return; }

      streamRef.current = stream;
      try { const st = stream.getVideoTracks()[0]?.getSettings?.() || {}; flog("cam: stream on", `${st.width}x${st.height} @${Math.round(st.frameRate || 0)}fps`); } catch {}
      const track = stream.getVideoTracks()[0];
      trackRef.current = track;

      const caps = track.getCapabilities?.() || {};

      if (caps.zoom) {
        const min  = caps.zoom.min  ?? 1;
        const max  = caps.zoom.max  ?? 1;
        const step = caps.zoom.step ?? 0.1;
        setZoomCaps({ min, max, step, supported: max > min });

        const target = min <= 0.5 ? 0.5 : Math.max(1, min);
        setZoom(target);
        try { await track.applyConstraints({ advanced: [{ zoom: target }] }); } catch {}
      }

      if (caps.torch) setTorchSupported(true);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch {}
        setReady(true);
        flog("cam: ready");
      }
    })();

    return () => {
      dead = true;
      mountedRef.current = false;
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (zoomPillHideRef.current) clearTimeout(zoomPillHideRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ZOOM ───────────────────────────────────────────────────────────────────
  const applyZoom = useCallback(async (val) => {
    if (!zoomCaps.supported) return;
    const clamped = Math.max(zoomCaps.min, Math.min(zoomCaps.max, val));
    setZoom(clamped);
    if (trackRef.current) {
      const tz = performance.now();
      try { await trackRef.current.applyConstraints({ advanced: [{ zoom: clamped }] }); } catch (e) { flog("cam: zoom failed", e?.message); }
      if (performance.now() - tz > 300) flog("cam: zoom slow", `${clamped.toFixed(1)}x took ${Math.round(performance.now() - tz)}ms`);
    }
    setZoomPillOn(true);
    if (zoomPillHideRef.current) clearTimeout(zoomPillHideRef.current);
    zoomPillHideRef.current = setTimeout(() => setZoomPillOn(false), ZOOM_PILL_HIDE_MS);
  }, [zoomCaps]);

  // ── TAP TO FOCUS ───────────────────────────────────────────────────────────
  const tapFocus = async (clientX, clientY) => {
    const v = videoRef.current;
    if (!v) return;
    const r = v.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top)  / r.height;

    // The ring lives in the full-screen container; the video can be larger
    // than the screen (it's sized to cover it), so measure from the container.
    const c = containerRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    setFocusPoint({ x: clientX - c.left, y: clientY - c.top, t: Date.now() });
    setTimeout(() => {
      if (!mountedRef.current) return; // don't setState after the camera closed
      setFocusPoint(p => (p && Date.now() - p.t >= FOCUS_INDICATOR_MS ? null : p));
    }, FOCUS_INDICATOR_MS + 50);

    const track = trackRef.current;
    if (!track) return;
    const caps = track.getCapabilities?.() || {};
    const advanced = [];
    if (caps.pointsOfInterest) advanced.push({ pointsOfInterest: [{ x: nx, y: ny }] });
    if (caps.focusMode?.includes?.("single-shot"))    advanced.push({ focusMode: "single-shot" });
    if (caps.exposureMode?.includes?.("single-shot")) advanced.push({ exposureMode: "single-shot" });
    if (advanced.length) {
      const tf = performance.now();
      try { await track.applyConstraints({ advanced }); } catch {}
      if (performance.now() - tf > 300) flog("cam: focus slow", `${Math.round(performance.now() - tf)}ms`);
    }
    haptic(6);
  };

  // ── TORCH ──────────────────────────────────────────────────────────────────
  const toggleTorch = async () => {
    if (!trackRef.current || !torchSupported) return;
    const next = !torchOn;
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
      haptic(8);
    } catch (e) {
      console.warn("Torch toggle failed:", e);
    }
  };

  // ── CAPTURE ────────────────────────────────────────────────────────────────
  // No real focus-lock/focus-detection API exists on iOS Safari's web
  // platform, so instead of gating capture on "in focus", grab a quick burst
  // of frames and keep whichever scores sharpest.
  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !ready) { flog("cam: shutter tap ignored", ready ? "no video" : "camera not ready"); return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { flog("cam: shutter tap ignored", "video has no size"); return; }

    // One shot at a time. A press during a shot is remembered (once) and taken
    // right after, so a quick second tap isn't lost — but presses can't stack
    // up work faster than the phone can finish it.
    if (captureInFlightRef.current) {
      pendingShotRef.current = true;
      flog("cam: shutter tap while busy", `previous shot running ${Date.now() - shotStartRef.current}ms`);
      return;
    }
    captureInFlightRef.current = true;
    shotStartRef.current = Date.now();
    flog("cam: SHUTTER", `video ${vw}x${vh}, paused=${video.paused}, readyState=${video.readyState}`);

    // Immediate felt-response — fires on tap regardless of how long scoring takes.
    setCount(c => c + 1);
    setFlash(true);
    haptic(14);
    setTimeout(() => setFlash(false), 90);

    try {
      // Two frame buffers at the final photo size, made once and reused.
      const k = Math.min(1, PHOTO_MAX_DIM / Math.max(vw, vh));
      const fw = Math.round(vw * k), fh = Math.round(vh * k);
      let pair = framePairRef.current;
      if (!pair || pair[0].width !== fw || pair[0].height !== fh) {
        if (pair) pair.forEach(releaseCanvas);
        pair = [0, 1].map(() => { const c = document.createElement("canvas"); c.width = fw; c.height = fh; return c; });
        framePairRef.current = pair;
      }
      const best = await grabBurst(video, pair, BURST_FRAME_COUNT, mountedRef);
      if (best && mountedRef.current) {
        const thumb = makeThumb(best);
        const dataUrl = await encodeFrame(best);
        flog("cam: photo ready", dataUrl ? `${Math.round(dataUrl.length / 1024)}KB` : "EMPTY");
        if (mountedRef.current && dataUrl && dataUrl.length > 100) onPhoto(dataUrl, { sized: true, thumb });
      }
    } catch (e) {
      console.warn("Burst capture failed:", e);
      flog("cam: shot failed", e?.message || String(e));
    } finally {
      captureInFlightRef.current = false;
      flog("cam: shot finished", `${Date.now() - shotStartRef.current}ms`);
      if (pendingShotRef.current && mountedRef.current) {
        pendingShotRef.current = false;
        setTimeout(() => captureRef.current?.(), 0);
      }
    }
  }, [ready, onPhoto]);
  captureRef.current = capture;

  // ── VOLUME-UP → SHUTTER ────────────────────────────────────────────────────
  // Works on Android Chrome. iOS doesn't expose volume keys to web pages
  // (the system intercepts them), so this is a no-op there but harmless.
  useEffect(() => {
    const handleKey = (e) => {
      // AudioVolumeUp = Chrome standard; VolumeUp = older Blink; 447/175 = keyCode fallbacks
      if (
        e.key === "AudioVolumeUp" || e.key === "VolumeUp" ||
        e.keyCode === 447 || e.keyCode === 175
      ) {
        e.preventDefault();
        e.stopPropagation();
        capture();
      }
    };
    window.addEventListener("keydown", handleKey, { capture: true });
    return () => window.removeEventListener("keydown", handleKey, { capture: true });
  }, [capture]);

  // ── CLOSE ──────────────────────────────────────────────────────────────────
  const close = () => {
    flog("cam: X (close) tapped");
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onClose();
  };

  // ── POINTER HANDLERS ───────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    if (e.target.closest?.("[data-cam-ctl]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    pointersRef.current.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      startX: e.clientX, startY: e.clientY,
    });
    const cnt = pointersRef.current.size;
    if (cnt === 1) {
      gestureRef.current = { pinched: false, movedFar: false };
    } else if (cnt === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      pinchRef.current = { startDist: dist, startZoom: zoom };
      gestureRef.current.pinched = true;
    }
  };

  const onPointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    const p = pointersRef.current.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY;
    const size = pointersRef.current.size;
    if (size === 1) {
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_MOVE_THRESHOLD)
        gestureRef.current.movedFar = true;
    } else if (size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      applyZoom(pinchRef.current.startZoom * (dist / pinchRef.current.startDist));
    }
  };

  const onPointerEnd = (e) => {
    const last = pointersRef.current.get(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      if (!gestureRef.current.pinched && !gestureRef.current.movedFar && last)
        tapFocus(last.x, last.y);
      gestureRef.current = { pinched: false, movedFar: false };
    }
  };

  // ── LENS PRESETS ───────────────────────────────────────────────────────────
  const presets = zoomCaps.supported
    ? PRESET_LENSES.filter(p => p >= zoomCaps.min - PRESET_TOLERANCE && p <= zoomCaps.max + PRESET_TOLERANCE)
    : [1];

  // ── STYLE HELPERS ──────────────────────────────────────────────────────────
  const fab = (active = false, accent = "blue") => ({
    width: 44, height: 44, borderRadius: 22,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: active
      ? (accent === "yellow" ? "rgba(255,204,0,.95)" : "rgba(0,122,255,.92)")
      : "rgba(28,28,30,.72)",
    border: "1px solid rgba(255,255,255,.12)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    backdropFilter:       "blur(20px) saturate(180%)",
    color: active && accent === "yellow" ? "#000" : "#fff",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,.35)",
    padding: 0, flexShrink: 0,
    transition: "background .15s",
  });

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed", inset: 0, background: "#000", zIndex: 300,
        overflow: "hidden",
        touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
        WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >

      {/* ── VIEWFINDER — always fills the full fixed viewport ──────────────── */}
      {/* With inset:0 + object-fit:cover, rotating the device never collapses  */}
      {/* the preview or causes a layout shift.                                  */}
      <video
        ref={videoRef}
        playsInline muted autoPlay
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />

      {/* Rule-of-thirds grid */}
      {gridOn && (
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
          preserveAspectRatio="none" viewBox="0 0 3 3"
        >
          <line x1="1" y1="0" x2="1" y2="3" stroke="rgba(255,255,255,.35)" strokeWidth="0.012" />
          <line x1="2" y1="0" x2="2" y2="3" stroke="rgba(255,255,255,.35)" strokeWidth="0.012" />
          <line x1="0" y1="1" x2="3" y2="1" stroke="rgba(255,255,255,.35)" strokeWidth="0.012" />
          <line x1="0" y1="2" x2="3" y2="2" stroke="rgba(255,255,255,.35)" strokeWidth="0.012" />
        </svg>
      )}

      {/* Shutter flash */}
      {flash && (
        <div style={{
          position: "absolute", inset: 0,
          background: "#fff", opacity: 0.4,
          pointerEvents: "none",
        }}/>
      )}

      {/* Tap-to-focus indicator */}
      {focusPoint && (
        <div style={{
          position: "absolute",
          left: focusPoint.x - 32, top: focusPoint.y - 32,
          width: 64, height: 64,
          border: "1.5px solid #FFCC00", borderRadius: 6,
          pointerEvents: "none",
          boxShadow: "0 0 8px rgba(255,204,0,.35)",
          animation: "cv-focus 0.8s ease-out forwards",
        }}/>
      )}

      {/* ── TOP-CENTER: Photo count badge ────────────────────────────────── */}
      {count > 0 && (
        <div data-cam-ctl style={{
          position: "absolute",
          top: "max(14px, var(--safe-top))",
          left: "50%", transform: "translateX(-50%)",
          padding: "6px 13px", borderRadius: 999,
          background: "rgba(52,199,89,.92)",
          color: "#fff", fontSize: 13, fontWeight: 700,
          display: "flex", gap: 6, alignItems: "center",
          boxShadow: "0 2px 10px rgba(0,0,0,.35)",
          whiteSpace: "nowrap",
        }}>
          <span>📷</span><span>{count}</span>
        </div>
      )}

      {/* ── TOP-RIGHT: Torch + Grid ───────────────────────────────────────── */}
      <div data-cam-ctl style={{
        position: "absolute",
        top:   "max(12px, var(--safe-top))",
        right: "max(12px, env(safe-area-inset-right))",
        display: "flex", gap: 8,
      }}>
        {torchSupported && (
          <button onClick={toggleTorch} style={fab(torchOn, "yellow")} aria-label="Torch">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>
        )}
        <button onClick={() => { setGridOn(g => !g); haptic(6); }}
                style={fab(gridOn)} aria-label="Grid">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <line x1="9"  y1="3"  x2="9"  y2="21" />
            <line x1="15" y1="3"  x2="15" y2="21" />
            <line x1="3"  y1="9"  x2="21" y2="9" />
            <line x1="3"  y1="15" x2="21" y2="15" />
          </svg>
        </button>
      </div>

      {/* ── ZOOM PILL (center, auto-fades) ───────────────────────────────── */}
      {zoomCaps.supported && (
        <div data-cam-ctl style={{
          position: "absolute",
          top: "max(72px, calc(var(--safe-top) + 60px))",
          left: "50%", transform: "translateX(-50%)",
          padding: "4px 12px", borderRadius: 999,
          background: "rgba(28,28,30,.72)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          backdropFilter:       "blur(20px) saturate(180%)",
          border: "1px solid rgba(255,255,255,.12)",
          color: "#FFCC00", fontSize: 13, fontWeight: 700,
          opacity: zoomPillOn ? 1 : 0,
          transition: "opacity .3s",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        }}>
          {zoom.toFixed(1)}×
        </div>
      )}

      {/* ── ERROR BANNER ─────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          position: "absolute",
          top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          padding: "14px 18px", borderRadius: 12,
          background: "rgba(28,28,30,.92)",
          color: "#fff", fontSize: 14, maxWidth: 280, textAlign: "center",
          boxShadow: "0 8px 30px rgba(0,0,0,.5)",
        }}>
          {error}
        </div>
      )}

      {/* ── CONTROL STRIP — anchored to the device's portrait-bottom edge ── */}
      {/* In portrait that's the bottom of the screen; in landscape it's the   */}
      {/* left or right edge (wherever the bottom of the phone physically is), */}
      {/* so the shutter never slides away from your thumb when you rotate.    */}
      {(() => {
        const sideways = ctrlEdge !== "bottom";
        const stripStyle = sideways
          ? {
              position: "absolute",
              top: 0, bottom: 0, [ctrlEdge]: 0,
              background: `linear-gradient(to ${ctrlEdge}, transparent 0%, rgba(0,0,0,.5) 40%, rgba(0,0,0,.88) 100%)`,
              display: "flex",
              flexDirection: ctrlEdge === "right" ? "row" : "row-reverse",
              alignItems: "center",
              [ctrlEdge === "right" ? "paddingLeft" : "paddingRight"]: 44,
              [ctrlEdge === "right" ? "paddingRight" : "paddingLeft"]:
                `max(24px, env(safe-area-inset-${ctrlEdge}))`,
              paddingTop:    "max(16px, var(--safe-top))",
              paddingBottom: "max(16px, env(safe-area-inset-bottom))",
            }
          : {
              position: "absolute",
              bottom: 0, left: 0, right: 0,
              background: "linear-gradient(to top, rgba(0,0,0,.88) 0%, rgba(0,0,0,.5) 60%, transparent 100%)",
              paddingTop: 44,
              paddingBottom: "max(24px, env(safe-area-inset-bottom))",
              paddingLeft:  "max(16px, env(safe-area-inset-left))",
              paddingRight: "max(16px, env(safe-area-inset-right))",
            };
        return (
          <div data-cam-ctl style={stripStyle}>
            {/* Lens preset pills */}
            {presets.length > 1 && (
              <div style={sideways
                ? { display: "flex", flexDirection: "column", justifyContent: "center", gap: 8, marginRight: ctrlEdge === "right" ? 20 : 0, marginLeft: ctrlEdge === "left" ? 20 : 0 }
                : { display: "flex", justifyContent: "center", gap: 8, marginBottom: 20 }
              }>
                {presets.map(p => {
                  const active = Math.abs(zoom - p) < PRESET_TOLERANCE + 0.02;
                  return (
                    <button
                      key={p}
                      onClick={() => { applyZoom(p); haptic(6); }}
                      style={{
                        minWidth: active ? 52 : 40, height: active ? 40 : 32,
                        borderRadius: 999, padding: "0 12px",
                        background: "rgba(28,28,30,.72)",
                        WebkitBackdropFilter: "blur(20px) saturate(180%)",
                        backdropFilter:       "blur(20px) saturate(180%)",
                        border: "1px solid rgba(255,255,255,.14)",
                        color: active ? "#FFCC00" : "#fff",
                        fontSize: active ? 14 : 12, fontWeight: 700,
                        cursor: "pointer",
                        transition: "all .18s",
                        boxShadow: "0 2px 10px rgba(0,0,0,.35)",
                      }}
                    >
                      {p < 1 ? p.toFixed(1) : p}×
                    </button>
                  );
                })}
              </div>
            )}

            {/* Shutter group — [ Close ✕ ]  [ ◎ Shutter ]  [ spacer ]; a column when sideways */}
            <div style={{
              display: "flex",
              flexDirection: sideways ? "column" : "row",
              alignItems: "center", justifyContent: "center",
              gap: 50,
              ...(sideways ? { height: "100%" } : {}),
            }}>

              {/* Close — stays beside the shutter on every rotation */}
              <button onClick={close} style={fab()} aria-label="Close camera">
                <IconX size={22} color="#fff" />
              </button>

              {/* Shutter */}
              <button
                onClick={capture}
                disabled={!ready}
                aria-label="Capture photo"
                style={{
                  width: 74, height: 74, borderRadius: 37,
                  background: "#fff",
                  border: "4px solid rgba(255,255,255,.45)",
                  cursor: ready ? "pointer" : "default",
                  opacity: ready ? 1 : 0.45,
                  boxShadow: "0 0 18px rgba(255,255,255,.18)",
                  padding: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "transform .08s",
                  flexShrink: 0,
                }}
                onPointerDown={(e) => { e.currentTarget.style.transform = "scale(.93)"; }}
                onPointerUp={(e)   => { e.currentTarget.style.transform = "scale(1)"; }}
                onPointerLeave={(e)=> { e.currentTarget.style.transform = "scale(1)"; }}
              >
                <div style={{
                  width: 62, height: 62, borderRadius: 31,
                  border: "2.5px solid #000",
                }}/>
              </button>

              {/* Spacer — keeps shutter centered */}
              <div style={{ width: 44, height: 44, flexShrink: 0 }} />
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes cv-focus {
          0%   { transform: scale(1.5); opacity: 0; }
          30%  { transform: scale(1);   opacity: 1; }
          70%  { transform: scale(1);   opacity: 1; }
          100% { transform: scale(1);   opacity: 0.55; }
        }
      `}</style>
    </div>
  );
}
