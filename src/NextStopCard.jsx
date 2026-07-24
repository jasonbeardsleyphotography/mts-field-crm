import { useState, useEffect, useRef } from "react";

const COUNTDOWN_SECONDS = 8;
const RING_SIZE = 60;
const STROKE = 5;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function NextStopCard({ stop, stopNumber, totalStops, onDismiss, onNavigate }) {
  const [timeLeft, setTimeLeft] = useState(COUNTDOWN_SECONDS);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef(null);

  // Trigger slide-up animation after mount
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => setVisible(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Countdown tick — the updater ONLY computes the next value. Calling
  // onDismiss() from inside a setState updater was a render-phase side effect
  // ("Cannot update a component while rendering a different component", and a
  // possible double-fire under StrictMode). Deps are [] so a re-rendering
  // parent passing a fresh onDismiss can't keep resetting the tick cadence.
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft(t => (t <= 1 ? 0 : t - 1));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // Fire dismissal once, outside the render phase, when the count hits 0.
  useEffect(() => {
    if (timeLeft === 0) { clearInterval(timerRef.current); onDismiss(); }
  }, [timeLeft, onDismiss]);

  const handleNavigate = () => {
    clearInterval(timerRef.current);
    const encoded = encodeURIComponent(stop.addr || "");
    window.location.href = `comgooglemaps://?daddr=${encoded}&directionsmode=driving`;
    if (onNavigate) onNavigate(stop);
  };

  const handleDismiss = () => {
    clearInterval(timerRef.current);
    onDismiss();
  };

  // SVG ring: progress from full → empty as time runs out
  const progress = timeLeft / COUNTDOWN_SECONDS; // 1 → 0
  const dashOffset = CIRCUMFERENCE * (1 - progress);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 500,
        background: "#0a0b10",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left))",
        transform: visible ? "translateY(0)" : "translateY(100%)",
        transition: "transform 200ms ease-out",
        willChange: "transform",
      }}
    >
      {/* Stop badge — top right */}
      <div
        style={{
          position: "absolute",
          top: "max(16px, env(safe-area-inset-top, 16px))",
          right: "max(16px, env(safe-area-inset-right, 16px))",
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 20,
          padding: "4px 12px",
          fontSize: 12,
          fontWeight: 700,
          color: "#8899aa",
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        Stop {stopNumber} of {totalStops}
      </div>

      {/* Header */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "#10B981",
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: 2,
          textTransform: "uppercase",
          marginBottom: 24,
          opacity: 0.9,
        }}
      >
        Next Stop
      </div>

      {/* Client name */}
      <div
        style={{
          fontSize: 32,
          fontWeight: 800,
          color: "#ffffff",
          fontFamily: "'Oswald', sans-serif",
          textAlign: "center",
          lineHeight: 1.15,
          marginBottom: 10,
          letterSpacing: 0.3,
        }}
      >
        {stop.cn || "Client"}
      </div>

      {/* Address */}
      <div
        style={{
          fontSize: 15,
          color: "#7a8fa8",
          textAlign: "center",
          lineHeight: 1.4,
          marginBottom: 44,
          maxWidth: 280,
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}
      >
        {stop.addr || ""}
      </div>

      {/* Navigate button */}
      <button
        onClick={handleNavigate}
        style={{
          width: "100%",
          maxWidth: 320,
          padding: "16px 20px",
          borderRadius: 14,
          background: "linear-gradient(135deg, #10B981 0%, #059669 100%)",
          border: "none",
          color: "#ffffff",
          fontSize: 17,
          fontWeight: 800,
          fontFamily: "'Oswald', sans-serif",
          letterSpacing: 1,
          textTransform: "uppercase",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: "0 4px 24px rgba(16,185,129,0.35)",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="3 11 22 2 13 21 11 13 3 11" />
        </svg>
        Navigate
      </button>

      {/* Countdown ring + dismiss area */}
      <div
        style={{
          marginTop: 36,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        {/* SVG countdown ring */}
        <div style={{ position: "relative", width: RING_SIZE, height: RING_SIZE }}>
          <svg
            width={RING_SIZE}
            height={RING_SIZE}
            style={{ transform: "rotate(-90deg)" }}
          >
            {/* Track */}
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={STROKE}
            />
            {/* Progress arc */}
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="#10B981"
              strokeWidth={STROKE}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 0.9s linear" }}
            />
          </svg>
          {/* Countdown number centered */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 800,
              color: "#ffffff",
              fontFamily: "'Oswald', sans-serif",
            }}
          >
            {timeLeft}
          </div>
        </div>

        {/* Dismiss link */}
        <button
          onClick={handleDismiss}
          style={{
            background: "none",
            border: "none",
            color: "#4a5a70",
            fontSize: 14,
            fontFamily: "'DM Sans', system-ui, sans-serif",
            cursor: "pointer",
            padding: "4px 12px",
            WebkitTapHighlightColor: "transparent",
            textDecoration: "underline",
            textDecorationColor: "rgba(74,90,112,0.4)",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
