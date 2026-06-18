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
  const recorderRef = useRef(null);
  const chunksRef   = useRef([]);
  const timerRef    = useRef(null);
  const mimeRef     = useRef("");

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // "idle" | "recording" | "paused" | "finishing"
  const [state, setState] = useState("idle");
  const [duration, setDuration] = useState(0);

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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: true,
        });
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
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
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 300, overflow: "hidden",
      touchAction: "none", userSelect: "none", WebkitUserSelect: "none",
      WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
    }}>
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
      <div style={stripStyle}>
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
