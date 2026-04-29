/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Global Upload Tracker
   ───────────────────────────────────────────────────────────────────────────
   A fixed-position bar that lives at the bottom of every screen (route,
   pipeline, onsite). Shows aggregate upload progress and expands to a list
   of every video currently in the queue across all jobs.

   Why this exists: the per-card queue panel inside OnsiteWindow only shows
   videos for the currently-open stop. When the user moves a card to the
   pipeline (or just navigates away from the onsite screen), they lose
   visibility into uploads that are still running. This component restores
   that visibility everywhere.

   Subscribes to the videoQueue's onQueueChange — re-renders whenever any
   item changes status, progress, or error.
   ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";
import {
  listAll as listAllQueue,
  onQueueChange,
  forceUploadNow,
  cancelQueueItem,
  retryQueueItem,
  getUploadMode,
  setUploadMode,
} from "./videoQueue";
import { IconX, IconYoutube } from "./icons";

const F = "'Oswald',sans-serif";

// Status → display label + color. Kept here so the per-card panel and
// global tracker present the same vocabulary to the user.
function describeStatus(item) {
  switch (item.status) {
    case "queued":      return { label: "Waiting…",            color: "#7a7050" };
    case "compressing": return { label: `Compressing ${item.progress||0}%`, color: "#5a90b0" };
    case "ready":       return { label: "Ready to upload",     color: "#7a7050" };
    case "uploading":   return { label: `Uploading ${item.progress||0}%`,   color: "#10B981" };
    case "paused":      return { label: "Paused",              color: "#7a7050" };
    case "error":       return { label: "Failed",              color: "#FF5555" };
    default:            return { label: item.status,           color: "#7a7050" };
  }
}

export default function UploadTracker({ stopMap = {}, bottomOffset = 0 }) {
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState(getUploadMode());

  // Load + subscribe
  useEffect(() => {
    let alive = true;
    listAllQueue().then(all => { if (alive) setItems(all); });
    const off = onQueueChange((all) => { if (alive) setItems(all); });
    return () => { alive = false; off(); };
  }, []);

  if (items.length === 0) return null;

  // Aggregate progress = mean of all items' progress (compression and upload
  // both weight the same; close enough for a glanceable indicator).
  const avgProgress = Math.round(items.reduce((sum, i) => sum + (i.progress || 0), 0) / items.length);
  const errorCount = items.filter(i => i.status === "error").length;
  const activeCount = items.filter(i => i.status === "uploading" || i.status === "compressing").length;
  const waitingCount = items.filter(i => i.status === "queued" || i.status === "ready" || i.status === "paused").length;

  // Resolve customer name from stopMap if available — falls back to the
  // title we stored at enqueue time. The title is always set, so we'll
  // never show nothing.
  const nameFor = (item) => {
    const stop = stopMap[item.stopId];
    if (stop?.cn) return stop.cn;
    // Title format: "LastName #JobNum 04/29/2026 - 01" — first word is last name
    const firstSpace = item.title.indexOf(" ");
    return firstSpace > 0 ? item.title.slice(0, firstSpace) : item.title;
  };

  const summary = errorCount > 0
    ? `${errorCount} failed${activeCount > 0 ? `, ${activeCount} active` : ""}${waitingCount > 0 ? `, ${waitingCount} waiting` : ""}`
    : activeCount > 0
      ? `${activeCount} uploading${waitingCount > 0 ? `, ${waitingCount} waiting` : ""}`
      : `${items.length} pending`;

  const accent = errorCount > 0 ? "#FF5555" : "#10B981";
  const accentBg = errorCount > 0 ? "rgba(255,85,85,.08)" : "rgba(16,185,129,.06)";
  const accentBorder = errorCount > 0 ? "rgba(255,85,85,.3)" : "rgba(16,185,129,.25)";

  return (
    <div style={{
      position: "fixed",
      bottom: bottomOffset,
      left: 0,
      right: 0,
      zIndex: 145, // below modals (200+) and toasts (150-151), above everything else
      background: "#0a0d15",
      borderTop: `1px solid ${accentBorder}`,
      paddingBottom: "max(0px, env(safe-area-inset-bottom))",
      maxHeight: "60vh",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Collapsed bar — always visible */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: "100%",
          background: accentBg,
          border: "none",
          padding: "9px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          color: "#e0e8f0",
          textAlign: "left",
        }}
      >
        <IconYoutube size={14} color={accent} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: accent, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase" }}>
            {summary}
            {!errorCount && activeCount > 0 && <span style={{marginLeft:8,color:"#7a8090",fontWeight:600}}>{avgProgress}%</span>}
          </div>
          {/* Aggregate progress bar */}
          {!errorCount && (
            <div style={{ height: 2, background: "rgba(255,255,255,.05)", borderRadius: 1, marginTop: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${avgProgress}%`, background: accent, transition: "width .3s" }} />
            </div>
          )}
        </div>
        <span style={{ fontSize: 14, color: "#5a6580", marginLeft: 4 }}>{expanded ? "▾" : "▴"}</span>
      </button>

      {/* Expanded list */}
      {expanded && (
        <div style={{ flex: 1, overflowY: "auto", borderTop: "1px solid #1a2030" }}>
          {/* Mode toggle row */}
          <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6, background: "#0e1120", borderBottom: "1px solid #1a2030" }}>
            <span style={{ fontSize: 9, color: "#5a6580", fontWeight: 700, fontFamily: F, letterSpacing: 0.4, textTransform: "uppercase" }}>Mode:</span>
            {[["always","Always"],["wifi","WiFi"],["hybrid","Hybrid"]].map(([m, lbl]) => (
              <button
                key={m}
                onClick={() => { setUploadMode(m); setMode(m); }}
                style={{
                  padding: "3px 9px",
                  borderRadius: 5,
                  background: mode === m ? "rgba(16,185,129,.15)" : "transparent",
                  border: `1px solid ${mode === m ? "rgba(16,185,129,.4)" : "#252d47"}`,
                  color: mode === m ? "#10B981" : "#5a6580",
                  fontSize: 9,
                  fontWeight: 800,
                  cursor: "pointer",
                  fontFamily: F,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >{lbl}</button>
            ))}
          </div>

          {/* Item rows */}
          {items.map(item => {
            const sd = describeStatus(item);
            const sizeMB = ((item.compressedSize || item.originalSize) / (1024 * 1024)).toFixed(1);
            const origMB = (item.originalSize / (1024 * 1024)).toFixed(0);
            const showOrig = item.compressedSize && item.compressedSize !== item.originalSize;
            return (
              <div key={item.id} style={{ padding: "9px 12px", borderBottom: "1px solid #0e1220" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#e0e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: F, letterSpacing: 0.3 }}>
                      {nameFor(item)}
                    </div>
                    <div style={{ fontSize: 9, color: "#5a6580", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                      {item.title}
                    </div>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 800, color: sd.color, fontFamily: F, letterSpacing: 0.4, textTransform: "uppercase", flexShrink: 0 }}>{sd.label}</span>
                </div>
                {/* Per-item progress bar */}
                <div style={{ height: 3, background: "rgba(255,255,255,.05)", borderRadius: 2, overflow: "hidden", marginBottom: 5 }}>
                  <div style={{ height: "100%", width: `${item.progress || 0}%`, background: sd.color, transition: "width .3s" }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, fontSize: 9, color: "#5a6580", fontFamily: F, letterSpacing: 0.3 }}>
                    {showOrig ? `${origMB}MB → ${sizeMB}MB` : `${sizeMB}MB`}
                    {item.compressionSkipped && <span style={{ marginLeft: 6, color: "#a07050" }}>(uncompressed)</span>}
                  </div>
                  {(item.status === "queued" || item.status === "ready" || item.status === "paused") && (
                    <button onClick={() => forceUploadNow(item.id)} style={btnStyle("rgba(16,185,129,.1)", "rgba(16,185,129,.3)", "#10B981")}>UPLOAD NOW</button>
                  )}
                  {item.status === "error" && (
                    <button onClick={() => retryQueueItem(item.id)} style={btnStyle("rgba(246,191,38,.1)", "rgba(246,191,38,.3)", "#F6BF26")}>RETRY</button>
                  )}
                  <button onClick={() => { if (window.confirm("Cancel this upload? The video stays in your camera roll.")) cancelQueueItem(item.id); }} style={btnStyle("transparent", "#252d47", "#a06060", true)}>
                    <IconX size={11} color="#a06060" />
                  </button>
                </div>
                {item.error && (
                  <div style={{ fontSize: 9, color: "#FF8888", marginTop: 4, fontFamily: F, lineHeight: 1.4 }}>{item.error}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function btnStyle(bg, border, color, icon) {
  return {
    padding: icon ? "3px 6px" : "3px 8px",
    borderRadius: 5,
    background: bg,
    border: `1px solid ${border}`,
    color,
    fontSize: 9,
    fontWeight: 800,
    cursor: "pointer",
    fontFamily: F,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    display: "flex",
    alignItems: "center",
  };
}
