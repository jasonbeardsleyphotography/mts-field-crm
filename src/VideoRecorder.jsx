import { useState, useRef, useEffect, useCallback } from "react";
import { IconX } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Recorder
   In-app video capture, capped to ~720p / ~1.5Mbps so field videos upload in
   a reasonable time over cellular. Same native-camera viewfinder feel as
   CameraView.jsx, with a native-iOS-style pause/resume during recording —
   MediaRecorder.pause()/.resume() encode into one continuous output blob.
   ═══════════════════════════════════════════════════════════════════════════ */

const MIME_CANDIDATES = [
  "video/mp4;codecs=h264,aac",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const VIDEO_BITRATE = 1_500_000; // ~1.5Mbps — ~11MB/min at 720p, "good enough to watch"
const AUDIO_BITRATE  = 64_000;
const MAX_DURATION_S = 15 * 60;  // safety net — auto-finalize so a forgotten recorder can't run forever

const PRESET_LENSES     = [0.5, 1, 2];
const PRESET_TOLERANCE  = 0.05;
const ZOOM_PILL_HIDE_MS = 1500;

const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch {} };

function pickMimeType() {
  for (const m of MIME_CANDIDATES) {
    try { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; } catch {}
  }
  return "";
}

function portraitBottomEdge() {
  let a = 0;
  try { a = screen.orientation?.angle ?? window.orientation ?? 0; } catch {}
  if (a === 90) return "right";
  if (a === -90 || a === 270) return "left";
  return "bottom";
}

const fmtDur = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

export default function VideoRecorder({ onRecorded, onClose }) {
  const videoRef    = useRef(null);
  const streamRef   = useRef(null);
  const trackRef    = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef   = useRef([]);
  const timerRef    = useRef(null);
  const mimeRef     = useRef("");

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // "idle" | "recording" | "paused" | "finishing"
  const [state, setState] = useState("idle");
  const [duration, setDuration] = useState(0);

  // Zoom — same hardware-constraint approach as CameraView.jsx; the track
  // recorded by MediaRecorder is the same track this zoom is applied to, so
  // it's baked into the saved video automatically.
  const [zoom, setZoom]             = useState(1);
  const [zoomCaps, setZoomCaps]     = useState({ min: 1, max: 1, step: 0.1, supported: false });
  const [zoomPillOn, setZoomPillOn] = useState(false);
  const zoomPillHideRef             = useRef(null);

  const pointersRef = useRef(new Map());
  const pinchRef    = useRef(null);

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

  // ── STREAM SETUP ─────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        // Hard-cap at 720p/30fps: `ideal` is only a hint some phones ignore
        // (handing back 1080p, which balloons the file and the upload time).
        // `max` makes 720p a ceiling the camera cannot exceed, so field videos
        // stay small enough to upload quickly and reliably.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width:  { ideal: 1280, max: 1280 },
            height: { ideal: 720,  max: 720  },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: true,
        });
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        const caps = track?.getCapabilities?.() || {};
        if (caps.zoom) {
          const min  = caps.zoom.min  ?? 1;
          const max  = caps.zoom.max  ?? 1;
          const step = caps.zoom.step ?? 0.1;
          setZoomCaps({ min, max, step, supported: max > min });
          const target = min <= 0.5 ? 0.5 : Math.max(1, min);
          setZoom(target);
          try { await track.applyConstraints({ advanced: [{ zoom: target }] }); } catch {}
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try { await videoRef.current.play(); } catch {}
          setReady(true);
        }
      } catch (e) {
        if (!dead) {
          setError(e?.name === "NotAllowedError"
            ? "Camera/mic permission denied. Enable it in Settings → Safari → Camera & Microphone."
            : "Camera unavailable.");
          setTimeout(() => onClose?.(), 1800);
        }
      }
    })();
    return () => {
      dead = true;
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── TIMER ────────────────────────────────────────────────────────────────
  const startTimer = () => {
    timerRef.current = setInterval(() => {
      setDuration(d => {
        const next = d + 1;
        if (next >= MAX_DURATION_S) finalize();
        return next;
      });
    }, 1000);
  };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // ── ZOOM ───────────────────────────────────────────────────────────────────
  const applyZoom = useCallback(async (val) => {
    if (!zoomCaps.supported) return;
    const clamped = Math.max(zoomCaps.min, Math.min(zoomCaps.max, val));
    setZoom(clamped);
    if (trackRef.current) {
      try { await trackRef.current.applyConstraints({ advanced: [{ zoom: clamped }] }); } catch {}
    }
    setZoomPillOn(true);
    if (zoomPillHideRef.current) clearTimeout(zoomPillHideRef.current);
    zoomPillHideRef.current = setTimeout(() => setZoomPillOn(false), ZOOM_PILL_HIDE_MS);
  }, [zoomCaps]);

  // ── PINCH-TO-ZOOM POINTER HANDLERS ──────────────────────────────────────────
  const onPointerDown = (e) => {
    if (e.target.closest?.("[data-vr-ctl]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      pinchRef.current = { startDist: dist, startZoom: zoom };
    }
  };
  const onPointerMove = (e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    const p = pointersRef.current.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY;
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      applyZoom(pinchRef.current.startZoom * (dist / pinchRef.current.startDist));
    }
  };
  const onPointerEnd = (e) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  // ── FINALIZE — assemble chunks, hand the file back to the caller ─────────
  const finalize = useCallback(() => {
    setState("finishing");
    stopTimer();
    try { recorderRef.current?.stop(); } catch {}
  }, []);

  // ── RECORD / PAUSE / RESUME / STOP ────────────────────────────────────────
  const startRecording = () => {
    if (!streamRef.current || !ready) return;
    const mimeType = pickMimeType();
    mimeRef.current = mimeType;
    chunksRef.current = [];
    const opts = mimeType ? { mimeType, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE }
                           : { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
    let mr;
    try {
      mr = new MediaRecorder(streamRef.current, opts);
    } catch {
      try { mr = new MediaRecorder(streamRef.current); } catch (e) {
        setError("Recording isn't supported on this device/browser.");
        return;
      }
    }
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      const type = mimeRef.current || mr.mimeType || "video/mp4";
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes("webm") ? "webm" : "mp4";
      const file = new File([blob], `video.${ext}`, { type });
      onRecorded(file);
    };
    recorderRef.current = mr;
    mr.start();
    setState("recording");
    setDuration(0);
    startTimer();
    haptic(14);
  };

  const togglePause = () => {
    const mr = recorderRef.current;
    if (!mr) return;
    if (state === "recording") {
      mr.pause();
      stopTimer();
      setState("paused");
      haptic(8);
    } else if (state === "paused") {
      mr.resume();
      startTimer();
      setState("recording");
      haptic(8);
    }
  };

  // ── CLOSE ──────────────────────────────────────────────────────────────────
  const close = () => {
    if (state === "recording" || state === "paused") {
      if (!window.confirm("Discard this recording in progress?")) return;
    }
    stopTimer();
    try { recorderRef.current?.stop(); } catch {}
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    recorderRef.current = null;
    onClose();
  };

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

  const recording = state === "recording";
  const paused = state === "paused";
  const sideways = ctrlEdge !== "bottom";

  const presets = zoomCaps.supported
    ? PRESET_LENSES.filter(p => p >= zoomCaps.min - PRESET_TOLERANCE && p <= zoomCaps.max + PRESET_TOLERANCE)
    : [1];

  const stripStyle = sideways
    ? {
        position: "absolute", top: 0, bottom: 0, [ctrlEdge]: 0,
        background: `linear-gradient(to ${ctrlEdge}, transparent 0%, rgba(0,0,0,.5) 40%, rgba(0,0,0,.88) 100%)`,
        display: "flex",
        flexDirection: ctrlEdge === "right" ? "row" : "row-reverse",
        alignItems: "center",
        [ctrlEdge === "right" ? "paddingLeft" : "paddingRight"]: 44,
        [ctrlEdge === "right" ? "paddingRight" : "paddingLeft"]: `max(24px, env(safe-area-inset-${ctrlEdge}))`,
        paddingTop:    "max(16px, env(safe-area-inset-top))",
        paddingBottom: "max(16px, env(safe-area-inset-bottom))",
      }
    : {
        position: "absolute", bottom: 0, left: 0, right: 0,
        background: "linear-gradient(to top, rgba(0,0,0,.88) 0%, rgba(0,0,0,.5) 60%, transparent 100%)",
        paddingTop: 44,
        paddingBottom: "max(24px, env(safe-area-inset-bottom))",
        paddingLeft:  "max(16px, env(safe-area-inset-left))",
        paddingRight: "max(16px, env(safe-area-inset-right))",
      };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "#000", zIndex: 300, overflow: "hidden",
        touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
        WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <video ref={videoRef} playsInline muted autoPlay
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }} />

      {/* Recording pulse border */}
      {recording && (
        <div style={{ position: "absolute", inset: 0, border: "3px solid rgba(255,59,48,.85)", pointerEvents: "none", animation: "vr-pulse 1.4s ease-in-out infinite" }} />
      )}

      {/* ── TOP-CENTER: timer / status badge ──────────────────────────────── */}
      {state !== "idle" && (
        <div style={{
          position: "absolute", top: "max(14px, env(safe-area-inset-top))",
          left: "50%", transform: "translateX(-50%)",
          padding: "6px 13px", borderRadius: 999,
          background: paused ? "rgba(246,191,38,.92)" : "rgba(255,59,48,.92)",
          color: paused ? "#000" : "#fff", fontSize: 13, fontWeight: 700,
          display: "flex", gap: 6, alignItems: "center",
          boxShadow: "0 2px 10px rgba(0,0,0,.35)", whiteSpace: "nowrap",
        }}>
          {!paused && <span style={{ width: 8, height: 8, borderRadius: 4, background: "#fff", animation: "vr-dot 1s infinite" }} />}
          <span>{paused ? "PAUSED" : "REC"} {fmtDur(duration)}</span>
        </div>
      )}

      {/* ── ZOOM PILL (center, auto-fades) ───────────────────────────────── */}
      {zoomCaps.supported && (
        <div data-vr-ctl style={{
          position: "absolute",
          top: "max(72px, calc(env(safe-area-inset-top) + 60px))",
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

      {/* ── ERROR ──────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          padding: "14px 18px", borderRadius: 12, background: "rgba(28,28,30,.92)",
          color: "#fff", fontSize: 14, maxWidth: 280, textAlign: "center", boxShadow: "0 8px 30px rgba(0,0,0,.5)",
        }}>
          {error}
        </div>
      )}

      {/* ── CONTROL STRIP ──────────────────────────────────────────────────── */}
      <div data-vr-ctl style={stripStyle}>
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
        <div style={{
          display: "flex", flexDirection: sideways ? "column" : "row",
          alignItems: "center", justifyContent: "center", gap: 50,
          ...(sideways ? { height: "100%" } : {}),
        }}>
          {/* Close — hidden mid-recording on the strip to avoid accidental taps; still reachable via confirm-gated close() if needed elsewhere */}
          <button onClick={close} style={fab()} aria-label="Close">
            <IconX size={22} color="#fff" />
          </button>

          {state === "idle" && (
            <button onClick={startRecording} disabled={!ready} aria-label="Start recording"
              style={{
                width: 74, height: 74, borderRadius: 37, background: "#FF3B30",
                border: "4px solid rgba(255,255,255,.45)", cursor: ready ? "pointer" : "default",
                opacity: ready ? 1 : 0.45, boxShadow: "0 0 18px rgba(255,59,48,.35)",
                padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
              <div style={{ width: 30, height: 30, borderRadius: 15, background: "#fff" }} />
            </button>
          )}

          {(recording || paused) && (
            <>
              <button onClick={togglePause} aria-label={paused ? "Resume" : "Pause"} style={fab(paused, "yellow")}>
                {paused ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                )}
              </button>

              <button onClick={finalize} aria-label="Stop and use video"
                style={{
                  width: 74, height: 74, borderRadius: 37, background: "#fff",
                  border: "4px solid rgba(255,255,255,.45)", cursor: "pointer",
                  boxShadow: "0 0 18px rgba(255,255,255,.18)", padding: 0,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                <div style={{ width: 26, height: 26, borderRadius: 5, background: "#FF3B30" }} />
              </button>
            </>
          )}

          {/* Spacer keeps the controls centered regardless of which buttons are shown */}
          <div style={{ width: 44, height: 44, flexShrink: 0 }} />
        </div>
      </div>

      <style>{`
        @keyframes vr-pulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
        @keyframes vr-dot   { 0%,100% { opacity: 1; } 50% { opacity: .2; } }
      `}</style>
    </div>
  );
}
