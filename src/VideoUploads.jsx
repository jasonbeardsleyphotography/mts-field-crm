/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Upload Manager
   Full-screen overlay showing all queued/active/failed video uploads with
   per-file progress, Force Restart, and Cancel controls.
   ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "react";
import {
  listAll as listAllQueue,
  onQueueChange,
  cancelItem,
  deleteItem,
  retryItem,
  isPaused,
  setPaused,
  forceUnstick,
} from "./videoQueue";
import { saveVideoToDevice } from "./videoSave";
import { readLog } from "./videoLog";
import { IconArrowLeft, IconX } from "./icons";

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

function fmtMB(bytes) {
  if (!bytes) return "0 MB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusPill({ item }) {
  const isStuck = item.status === "uploading" && Date.now() - (item.updatedAt || 0) > 60_000;
  if (item.status === "uploading") {
    return (
      <span style={{
        fontSize: 10, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
        color: isStuck ? "#F6BF26" : "#10B981",
        padding: "2px 8px", borderRadius: 10,
        background: isStuck ? "rgba(246,191,38,.12)" : "rgba(16,185,129,.12)",
        border: `1px solid ${isStuck ? "rgba(246,191,38,.3)" : "rgba(16,185,129,.3)"}`,
      }}>
        {isStuck ? "⚠ STALLED" : `⬆ ${item.progress || 0}%`}
      </span>
    );
  }
  if (item.status === "queued") return (
    <span style={{ fontSize: 10, fontWeight: 700, color: "#6a7a90", fontFamily: F, letterSpacing: 0.5 }}>WAITING</span>
  );
  if (item.status === "local") return (
    <span style={{ fontSize: 10, fontWeight: 700, color: "#8898a8", fontFamily: F, letterSpacing: 0.5 }}>ON PHONE</span>
  );
  if (item.status === "error") return (
    <span style={{
      fontSize: 10, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
      color: "#FF5555", padding: "2px 8px", borderRadius: 10,
      background: "rgba(255,85,85,.12)", border: "1px solid rgba(255,85,85,.3)",
    }}>FAILED</span>
  );
  return null;
}

export default function VideoUploads({ open, onClose, stopMap = {} }) {
  const [items, setItems] = useState([]);
  const [paused, setPausedState] = useState(isPaused());
  const [, tick] = useState(0);
  const [restarting, setRestarting] = useState({});
  const [saving, setSaving] = useState({});
  const [showDiag, setShowDiag] = useState(false);
  const [logEntries, setLogEntries] = useState([]);

  // Diagnostics live right here on the uploads screen — previously they
  // were buried in the mini tracker's expanded panel, which the user could
  // not find (and which disappears entirely when the queue looks empty).
  useEffect(() => {
    if (!showDiag || !open) return;
    let alive = true;
    const refresh = () => { readLog({ limit: 100 }).then(e => { if (alive) setLogEntries(e); }).catch(() => {}); };
    refresh();
    const t = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [showDiag, open]);

  useEffect(() => {
    let alive = true;
    listAllQueue().then(all => { if (alive) setItems(all); });
    // Re-read pause state on every queue change — Retry/Force Restart clear
    // a stuck pause inside videoQueue.js, and this button must not keep
    // showing "Resume" (i.e. claiming paused) after that happens.
    const off = onQueueChange(all => { if (alive) { setItems(all); setPausedState(isPaused()); } });
    return () => { alive = false; off(); };
  }, []);

  // Refresh every 5 seconds so "stalled" status and timestamps stay current
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;

  // "local" items are no longer part of the upload queue — they live on the
  // client's card (with preview/Save/Upload). X-ing an upload should visibly
  // remove it from this screen, so don't list them here.
  const visibleItems = items.filter(i => i.status !== "local");
  const activeCount  = items.filter(i => i.status === "uploading").length;
  const errorCount   = items.filter(i => i.status === "error").length;
  const waitingCount = items.filter(i => i.status === "queued").length;
  const localCount   = items.filter(i => i.status === "local").length;

  const nameFor = (item) => {
    const stop = stopMap[item.stopId];
    if (stop?.cn) return stop.cn;
    const sp = item.title.indexOf(" ");
    return sp > 0 ? item.title.slice(0, sp) : item.title;
  };

  const handlePauseToggle = () => {
    const next = !paused;
    setPaused(next);
    setPausedState(next);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 250,
      background: "#080a10", display: "flex", flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        paddingTop: "max(12px, env(safe-area-inset-top))",
        background: "#0a0c14",
        borderBottom: "1px solid #1a2030",
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
      }}>
        <button onClick={onClose} style={{
          width: 34, height: 34, borderRadius: 8, border: "none",
          background: "transparent", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
        }}>
          <IconArrowLeft size={20} color="#5a6580" />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: "#e0e8f0", fontFamily: F, letterSpacing: 1.5, textTransform: "uppercase" }}>
            Video Uploads
          </div>
          {visibleItems.length > 0 && (
            <div style={{ fontSize: 11, color: "#5a6580", fontFamily: F, letterSpacing: 0.5, marginTop: 1 }}>
              {[
                activeCount > 0 && `${activeCount} uploading`,
                waitingCount > 0 && `${waitingCount} waiting`,
                errorCount > 0 && `${errorCount} failed`,
                localCount > 0 && `${localCount} kept on client cards`,
              ].filter(Boolean).join(" · ") || "All done"}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowDiag(v => !v)}
          title="Show what the uploader has been doing"
          style={{
            padding: "7px 10px", borderRadius: 8, cursor: "pointer",
            fontFamily: F, fontWeight: 800, fontSize: 11, letterSpacing: 0.5,
            background: showDiag ? "rgba(100,180,246,.15)" : "transparent",
            border: `1px solid ${showDiag ? "rgba(100,180,246,.4)" : "#252d47"}`,
            color: showDiag ? "#64B5F6" : "#5a6580",
          }}
        >🔍 Log</button>
        {visibleItems.length > 0 && (
          <button
            onClick={handlePauseToggle}
            style={{
              padding: "7px 14px", borderRadius: 8, cursor: "pointer",
              fontFamily: F, fontWeight: 800, fontSize: 11, letterSpacing: 0.5,
              background: paused ? "rgba(16,185,129,.12)" : "rgba(246,191,38,.12)",
              border: paused ? "1px solid rgba(16,185,129,.35)" : "1px solid rgba(246,191,38,.35)",
              color: paused ? "#10B981" : "#F6BF26",
            }}
          >{paused ? "▶ Resume" : "⏸ Pause All"}</button>
        )}
      </div>

      {/* Paused banner — pause persists across app restarts (localStorage),
          so a forgotten pause silently stops ALL uploads. Make it loud. */}
      {paused && visibleItems.length > 0 && (
        <div style={{
          padding: "10px 16px", flexShrink: 0,
          background: "rgba(255,85,85,.08)",
          borderBottom: "1px solid rgba(255,85,85,.25)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⏸</span>
          <div style={{ fontSize: 12, color: "#FF8888", lineHeight: 1.5, fontFamily: B }}>
            <strong style={{ fontFamily: F, letterSpacing: 0.5 }}>Uploads are paused.</strong>{" "}
            Nothing will upload until you tap Resume above.
          </div>
        </div>
      )}

      {/* Storage-stuck banner: repeated blob-read failures mean iOS wedged
          this page's storage access — only a full app reload clears it.
          Give the user that button right here instead of a dead end. */}
      {items.some(i => (i.probeFails || 0) >= 2) && (
        <div style={{
          padding: "10px 16px", flexShrink: 0,
          background: "rgba(255,140,0,.08)",
          borderBottom: "1px solid rgba(255,140,0,.25)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12, color: "#FFB366", lineHeight: 1.5, fontFamily: B }}>
            <strong style={{ fontFamily: F, letterSpacing: 0.5 }}>Phone storage got stuck.</strong>{" "}
            Reloading the app fixes this — your videos and upload progress are safe.
          </div>
          <button
            onClick={() => { try { window.location.reload(); } catch {} }}
            style={{
              padding: "8px 14px", borderRadius: 8, flexShrink: 0,
              background: "rgba(255,140,0,.15)", border: "1px solid rgba(255,140,0,.4)",
              color: "#FF8C00", fontSize: 11, fontWeight: 800,
              cursor: "pointer", fontFamily: F, letterSpacing: 0.5,
            }}
          >⟳ Reload App</button>
        </div>
      )}

      {/* Diagnostic log — visible, timestamped record of every step the
          uploader took. First stop when something looks stuck. */}
      {showDiag && (
        <div style={{ flexShrink: 0, maxHeight: "40vh", overflowY: "auto", padding: "8px 16px", background: "#060810", borderBottom: "1px solid #1a2030" }}>
          {logEntries.length === 0 && <div style={{ fontSize: 11, color: "#4a5a70", fontStyle: "italic" }}>No log entries yet.</div>}
          {logEntries.map(e => (
            <div key={e.id} style={{ fontSize: 10, color: e.level === "error" ? "#FF8888" : e.level === "warn" ? "#F6BF26" : "#8898a8", fontFamily: "ui-monospace,Menlo,monospace", lineHeight: 1.45, marginBottom: 2, wordBreak: "break-word" }}>
              <span style={{ color: "#4a5a70" }}>{new Date(e.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
              {" "}<span style={{ fontWeight: 700 }}>{e.event}</span>
              {e.itemId && <span style={{ color: "#4a5a70" }}> [{String(e.itemId).slice(-8)}]</span>}
              {e.data && <span style={{ color: "#5a6580" }}> {JSON.stringify(e.data)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Warning banner — only while actively uploading */}
      {activeCount > 0 && (
        <div style={{
          padding: "10px 16px", flexShrink: 0,
          background: "rgba(246,191,38,.07)",
          borderBottom: "1px solid rgba(246,191,38,.2)",
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div style={{ fontSize: 12, color: "#d4aa60", lineHeight: 1.5, fontFamily: B }}>
            <strong style={{ fontFamily: F, letterSpacing: 0.5 }}>Keep this app open</strong> while uploading.
            Switching to another app (like Phone) pauses uploads. They will resume when you return.
          </div>
        </div>
      )}

      {/* Item list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {visibleItems.length === 0 && (
          <div style={{
            padding: 40, textAlign: "center",
            color: "#4a5a70", fontSize: 13, fontFamily: F,
            letterSpacing: 0.5, textTransform: "uppercase",
          }}>
            No uploads in queue
          </div>
        )}

        {visibleItems.map(item => {
          const isStuck = item.status === "uploading" && Date.now() - (item.updatedAt || 0) > 60_000;
          const pct = item.progress || 0;
          const barColor = item.status === "error" ? "#FF5555" : isStuck ? "#F6BF26" : "#10B981";

          return (
            <div key={item.id} style={{
              padding: "14px 16px",
              borderBottom: "1px solid #0e1220",
            }}>
              {/* Name + status */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 700, color: "#e0e8f0",
                    fontFamily: F, letterSpacing: 0.5,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{nameFor(item)}</div>
                  <div style={{
                    fontSize: 10, color: "#4a5a70", marginTop: 2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{item.title}</div>
                </div>
                <StatusPill item={item} />
              </div>

              {/* Progress bar */}
              <div style={{
                height: 6, borderRadius: 3,
                background: "rgba(255,255,255,.06)",
                overflow: "hidden", marginBottom: 6,
              }}>
                <div style={{
                  height: "100%",
                  width: item.status === "error" ? "100%" : `${pct}%`,
                  background: barColor,
                  opacity: item.status === "error" ? 0.5 : 1,
                  transition: "width .4s",
                }} />
              </div>

              {/* Size + bytes sent */}
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                marginBottom: 8, fontSize: 11, color: "#5a6580", fontFamily: F, letterSpacing: 0.3,
              }}>
                <span>{fmtMB(item.fileSize)}</span>
                {item.bytesUploaded > 0 && item.status !== "error" && (
                  <span style={{ color: "#7a8090" }}>{fmtMB(item.bytesUploaded)} sent</span>
                )}
                {item.status === "uploading" && item.fileSize > 0 && (
                  <span style={{ color: "#4a5a70", marginLeft: "auto" }}>{pct}%</span>
                )}
              </div>

              {/* Error message */}
              {item.error && (
                <div style={{
                  fontSize: 11, color: "#FF8888", marginBottom: 8,
                  fontFamily: B, lineHeight: 1.4,
                  padding: "6px 10px", borderRadius: 6,
                  background: "rgba(255,85,85,.07)",
                  border: "1px solid rgba(255,85,85,.2)",
                }}>{item.error}</div>
              )}

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={async () => {
                    // Immediate visible feedback the instant this is tapped —
                    // without it, a slow/wedged IDB read (e.g. right after the
                    // app went blank under memory pressure) leaves the button
                    // looking dead for several seconds, which reads as "not
                    // responding" even though it's still working.
                    if (saving[item.id]) return;
                    setSaving(s => ({ ...s, [item.id]: true }));
                    try { await saveVideoToDevice(item); }
                    finally { setSaving(s => { const n = { ...s }; delete n[item.id]; return n; }); }
                  }}
                  disabled={!!saving[item.id]}
                  title="Save this video to your phone"
                  style={{
                    padding: "8px 12px", borderRadius: 8, flexShrink: 0,
                    background: "rgba(16,185,129,.1)", border: "1px solid rgba(16,185,129,.3)",
                    color: "#10B981", fontSize: 11, fontWeight: 800,
                    cursor: saving[item.id] ? "default" : "pointer",
                    opacity: saving[item.id] ? 0.6 : 1,
                    fontFamily: F, letterSpacing: 0.5,
                  }}
                >{saving[item.id] ? "Saving…" : "Save"}</button>
                {/* ALWAYS present — a queued item showing a red note with no
                    button, or an uploading item with nothing to tap, read as
                    dead ends in the field. Any state can be force-restarted. */}
                {(
                  <button
                    onClick={() => {
                      // Immediate feedback so the tap reads as registered —
                      // the queue reset can take a beat to reach the worker,
                      // and on a flaky connection the retry may fail again
                      // looking identical, which reads as "did nothing".
                      setRestarting(r => ({ ...r, [item.id]: true }));
                      setTimeout(() => setRestarting(r => {
                        const next = { ...r };
                        delete next[item.id];
                        return next;
                      }), 4000);
                      retryItem(item.id);
                    }}
                    disabled={!!restarting[item.id]}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 8,
                      background: "rgba(59,130,246,.1)", border: "1px solid rgba(59,130,246,.3)",
                      color: "#3B82F6", fontSize: 11, fontWeight: 800,
                      cursor: restarting[item.id] ? "default" : "pointer",
                      opacity: restarting[item.id] ? 0.6 : 1,
                      fontFamily: F, letterSpacing: 0.5,
                    }}
                  >{restarting[item.id] ? "Restarting…" : item.status === "local" ? "Upload" : "Force Restart"}</button>
                )}
                <button
                  onClick={() => {
                    if (item.status === "local") {
                      if (window.confirm("Permanently delete this video from the phone? Save it first if you still need it.")) {
                        deleteItem(item.id);
                      }
                    } else if (window.confirm("Stop uploading this video? It stays on the client's card so you can save or upload it later.")) {
                      cancelItem(item.id);
                    }
                  }}
                  style={{
                    width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                    background: "transparent", border: "1px solid #1a2030",
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <IconX size={13} color="#6a3a3a" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer — unstick when anything is stuck */}
      {items.some(i => i.status === "uploading" && Date.now() - (i.updatedAt || 0) > 60_000) && (
        <div style={{
          padding: "10px 16px",
          paddingBottom: "max(10px, env(safe-area-inset-bottom))",
          borderTop: "1px solid #1a2030",
          background: "#0a0c14", flexShrink: 0,
        }}>
          <button
            onClick={() => forceUnstick()}
            style={{
              width: "100%", padding: "10px 0", borderRadius: 10,
              background: "rgba(255,140,0,.1)", border: "1px solid rgba(255,140,0,.3)",
              color: "#FF8C00", fontSize: 12, fontWeight: 800,
              cursor: "pointer", fontFamily: F, letterSpacing: 0.5,
            }}
          >⚡ Force Unstick All</button>
        </div>
      )}
    </div>
  );
}
