/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Global Upload Tracker
   ───────────────────────────────────────────────────────────────────────────
   Fixed-position bar at the bottom of every screen. Shows aggregate upload
   progress. Tap to expand and see every video in the queue.

   This version (v2) drops the WiFi/Hybrid/Always mode toggle in favor of a
   single Pause/Resume button. The mode toggle was the source of a critical
   bug: existing users had "wifi" stored in localStorage from earlier
   versions, iOS can't detect WiFi, so uploads silently never ran.

   Adds a "Diagnostics" expander that surfaces the videoLog so the user can
   see what's actually happening when something fails.
   ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";
import {
  listAll as listAllQueue,
  onQueueChange,
  cancelItem,
  retryItem,
  isPaused,
  setPaused,
  forceUnstick,
} from "./videoQueue";
import { readLog, clearLog } from "./videoLog";
import { IconX, IconYoutube } from "./icons";

const F = "'Oswald',sans-serif";

function describeStatus(item) {
  switch (item.status) {
    case "queued":    return { label: "Waiting…", color: "#7a7050" };
    case "uploading": return { label: `Uploading ${item.progress||0}%`, color: "#10B981" };
    case "error":     return { label: "Failed", color: "#FF5555" };
    default:          return { label: item.status, color: "#7a7050" };
  }
}

export default function UploadTracker({ stopMap = {}, bottomOffset = 0, inline = false }) {
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [paused, setPausedState] = useState(isPaused());
  const [showDiag, setShowDiag] = useState(false);
  const [logEntries, setLogEntries] = useState([]);

  useEffect(() => {
    let alive = true;
    listAllQueue().then(all => { if (alive) setItems(all); });
    const off = onQueueChange((all) => { if (alive) setItems(all); });
    return () => { alive = false; off(); };
  }, []);

  // Refresh diagnostic log every 2 seconds while the diag panel is open
  useEffect(() => {
    if (!showDiag) return;
    let alive = true;
    const refresh = () => {
      readLog({ limit: 80 }).then(entries => { if (alive) setLogEntries(entries); });
    };
    refresh();
    const t = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [showDiag]);

  if (items.length === 0 && !showDiag) return null;

  const avgProgress = items.length > 0
    ? Math.round(items.reduce((sum, i) => sum + (i.progress || 0), 0) / items.length)
    : 0;
  const errorCount = items.filter(i => i.status === "error").length;
  const activeCount = items.filter(i => i.status === "uploading").length;
  const waitingCount = items.filter(i => i.status === "queued").length;

  const nameFor = (item) => {
    const stop = stopMap[item.stopId];
    if (stop?.cn) return stop.cn;
    const firstSpace = item.title.indexOf(" ");
    return firstSpace > 0 ? item.title.slice(0, firstSpace) : item.title;
  };

  const summary = errorCount > 0
    ? `${errorCount} failed${activeCount > 0 ? `, ${activeCount} active` : ""}${waitingCount > 0 ? `, ${waitingCount} waiting` : ""}`
    : paused
      ? `${items.length} paused`
      : activeCount > 0
        ? `${activeCount} uploading${waitingCount > 0 ? `, ${waitingCount} waiting` : ""}`
        : items.length > 0 ? `${items.length} pending` : "";

  const accent = errorCount > 0 ? "#FF5555" : paused ? "#F6BF26" : "#10B981";
  const accentBg = errorCount > 0 ? "rgba(255,85,85,.08)" : paused ? "rgba(246,191,38,.08)" : "rgba(16,185,129,.06)";
  const accentBorder = errorCount > 0 ? "rgba(255,85,85,.3)" : paused ? "rgba(246,191,38,.3)" : "rgba(16,185,129,.25)";

  return (
    <div style={inline ? {
      // Inline mode — sits in the document flow above the bottom bar
      width: "100%",
      background: "#0a0d15",
      borderTop: `1px solid ${accentBorder}`,
      maxHeight: "70vh",
      display: "flex",
      flexDirection: "column",
      flexShrink: 0,
    } : {
      // Fixed mode — overlays at the bottom of the viewport
      position: "fixed",
      bottom: bottomOffset,
      left: 0, right: 0,
      zIndex: 145,
      background: "#0a0d15",
      borderTop: `1px solid ${accentBorder}`,
      paddingBottom: "max(0px, env(safe-area-inset-bottom))",
      maxHeight: "70vh",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Collapsed bar — TRUE thin strip (6px tall). No text, no icon —
          just a progress indicator the user can tap to expand. The expanded
          view has all the details. This preserves bottom UI real estate
          (especially the Reorder button). */}
      {items.length > 0 && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", background: "#0a0d15", border: "none",
            padding: 0, cursor: "pointer", textAlign: "left",
            position: "relative", overflow: "hidden",
            height: 6,
            display: "block",
          }}
          aria-label={`Uploads: ${summary}`}
          title={summary}
        >
          {/* Progress fill */}
          {!errorCount && !paused && activeCount > 0 && (
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${avgProgress}%`,
              background: accent,
              transition: "width .3s",
            }} />
          )}
          {/* Idle/paused/error: full-width tinted strip */}
          {(errorCount > 0 || paused || activeCount === 0) && (
            <div style={{
              position: "absolute", left: 0, top: 0, bottom: 0, right: 0,
              background: accent, opacity: 0.4,
            }} />
          )}
        </button>
      )}

      {/* Expanded list */}
      {expanded && (
        <div style={{ flex: 1, overflowY: "auto", borderTop: "1px solid #1a2030" }}>
          {/* Title / summary row with collapse button */}
          <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, background: "#0e1120", borderBottom: "1px solid #1a2030" }}>
            <IconYoutube size={12} color={accent} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 10, fontWeight: 800, color: accent, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase" }}>
              {summary}
              {!errorCount && !paused && activeCount > 0 && <span style={{marginLeft:6,color:"#7a8090",fontWeight:600}}>{avgProgress}%</span>}
            </div>
            <button onClick={() => setExpanded(false)} style={{ padding:"3px 8px", borderRadius:4, background:"transparent", border:"1px solid #252d47", color:"#5a6580", fontSize:9, fontWeight:700, cursor:"pointer", fontFamily:F, letterSpacing:0.5 }}>HIDE</button>
          </div>
          {/* Action row */}
          <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6, background: "#0e1120", borderBottom: "1px solid #1a2030", flexWrap: "wrap" }}>
            <button
              onClick={() => { setPaused(!paused); setPausedState(!paused); }}
              style={{
                padding: "5px 10px", borderRadius: 5,
                background: paused ? "rgba(16,185,129,.12)" : "rgba(246,191,38,.12)",
                border: paused ? "1px solid rgba(16,185,129,.3)" : "1px solid rgba(246,191,38,.3)",
                color: paused ? "#10B981" : "#F6BF26",
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
              }}
            >{paused ? "▶ Resume" : "⏸ Pause"}</button>
            {/* Diagnostic toggle */}
            <button
              onClick={() => setShowDiag(v => !v)}
              style={{
                padding: "5px 10px", borderRadius: 5,
                background: showDiag ? "rgba(100,180,246,.15)" : "transparent",
                border: "1px solid #252d47",
                color: showDiag ? "#64B5F6" : "#5a6580",
                fontSize: 10, fontWeight: 700, cursor: "pointer",
                fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
              }}
            >🔍 Diagnostics</button>
            {/* Force-unstick — only show if there's anything that's been
                "uploading" for more than a minute without progress */}
            {items.some(i => i.status === "uploading" && Date.now() - (i.updatedAt || 0) > 60000) && (
              <button
                onClick={() => { forceUnstick(); }}
                title="If an upload is stuck, this resets the worker"
                style={{
                  padding: "5px 10px", borderRadius: 5,
                  background: "rgba(255,140,0,.12)", border: "1px solid rgba(255,140,0,.3)",
                  color: "#FF8C00", fontSize: 10, fontWeight: 800, cursor: "pointer",
                  fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
                }}
              >⚡ Unstick</button>
            )}
          </div>

          {/* Diagnostic panel */}
          {showDiag && (
            <div style={{ padding: "6px 12px 10px", background: "#080a14", borderBottom: "1px solid #1a2030", maxHeight: 240, overflowY: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 9, color: "#5a6580", fontWeight: 700, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", flex: 1 }}>Recent log entries (newest first)</span>
                <button onClick={() => { clearLog(); setLogEntries([]); }} style={{ padding: "2px 8px", borderRadius: 4, background: "transparent", border: "1px solid #252d47", color: "#5a6580", fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: F, letterSpacing: 0.5 }}>CLEAR</button>
              </div>
              {logEntries.length === 0 && <div style={{ fontSize: 10, color: "#4a5a70", fontStyle: "italic" }}>No log entries yet. Upload a video to see what happens.</div>}
              {logEntries.map(e => (
                <div key={e.id} style={{ fontSize: 10, color: e.level === "error" ? "#FF8888" : e.level === "warn" ? "#F6BF26" : "#8898a8", fontFamily: "ui-monospace,Menlo,monospace", lineHeight: 1.4, marginBottom: 2, wordBreak: "break-word" }}>
                  <span style={{ color: "#4a5a70" }}>{new Date(e.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
                  {" "}<span style={{ fontWeight: 700 }}>{e.event}</span>
                  {e.itemId && <span style={{ color: "#4a5a70" }}> [{e.itemId.slice(-8)}]</span>}
                  {e.data && <span style={{ color: "#5a6580" }}> {JSON.stringify(e.data)}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Item rows */}
          {items.map(item => {
            const sd = describeStatus(item);
            const sizeMB = (item.fileSize / (1024 * 1024)).toFixed(1);
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
                <div style={{ height: 3, background: "rgba(255,255,255,.05)", borderRadius: 2, overflow: "hidden", marginBottom: 5 }}>
                  <div style={{ height: "100%", width: `${item.progress || 0}%`, background: sd.color, transition: "width .3s" }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, fontSize: 9, color: "#5a6580", fontFamily: F, letterSpacing: 0.3 }}>
                    {sizeMB}MB
                    {item.bytesUploaded > 0 && item.status !== "error" && (
                      <span style={{ marginLeft: 6, color: "#7a8090" }}>
                        {(item.bytesUploaded / (1024*1024)).toFixed(1)}MB sent
                      </span>
                    )}
                  </div>
                  {item.status === "error" && (
                    <button onClick={() => retryItem(item.id)} style={btnStyle("rgba(246,191,38,.1)", "rgba(246,191,38,.3)", "#F6BF26")}>RETRY</button>
                  )}
                  <button onClick={() => { if (window.confirm("Cancel this upload? The video stays in your camera roll.")) cancelItem(item.id); }} style={btnStyle("transparent", "#252d47", "#a06060", true)}>
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
    borderRadius: 5, background: bg, border: `1px solid ${border}`, color,
    fontSize: 9, fontWeight: 800, cursor: "pointer",
    fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
    display: "flex", alignItems: "center",
  };
}
