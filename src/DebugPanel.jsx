import { useState, useEffect, useCallback } from "react";
import { getLog, clearLog, downloadLog, onLogChange } from "./debugLog";
import { listAll as listVideoQueue } from "./videoQueue";
import { listFieldIds } from "./fieldStore";
import { getDirtyFieldIds, getFieldSlim } from "./fieldStore";
import { getSyncStatus } from "./driveSync";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS Debug Panel
   ───────────────────────────────────────────────────────────────────────────
   Accessed by tapping the "MTS" text in the header 5 times rapidly.
   Shows sync health, IDB stats, queue depths, and the error log.
   Production-safe: no sensitive data exposed beyond what's already in the app.
   ═══════════════════════════════════════════════════════════════════════════ */

const ROW  = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #1a2035" };
const LABEL = { fontSize: 12, color: "#7a8aaa", fontWeight: 500 };
const VALUE = { fontSize: 12, color: "#e0e8ff", fontWeight: 700, fontFamily: "'DM Mono',monospace", textAlign: "right", maxWidth: "60%" };
const SECTION_HEAD = { fontSize: 10, letterSpacing: 1.5, color: "#4a5a70", fontWeight: 700, textTransform: "uppercase", paddingTop: 16, paddingBottom: 4 };

const LEVEL_COLOR = { error: "#FF5555", warn: "#F6BF26", info: "#5a9fdf" };

function fmt(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ago(ts) {
  if (!ts) return "never";
  const ms = Date.now() - ts;
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600000)}h ago`;
}

export default function DebugPanel({ onClose, token, lastSyncTime }) {
  const [log, setLog]           = useState(() => getLog());
  const [videoItems, setVideoItems] = useState([]);
  const [idbCount, setIdbCount] = useState(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [tab, setTab]           = useState("overview");
  const [loading, setLoading]   = useState(true);
  const [lsSize, setLsSize]     = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [vids, ids] = await Promise.all([
        listVideoQueue().catch(() => []),
        listFieldIds().catch(() => []),
      ]);
      setVideoItems(vids);
      setIdbCount(ids.length);
      setDirtyCount(getDirtyFieldIds().size);
      // Estimate localStorage usage
      try {
        let bytes = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          bytes += (k?.length || 0) + (localStorage.getItem(k)?.length || 0);
        }
        setLsSize(bytes);
      } catch {}
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsub = onLogChange(setLog);
    return unsub;
  }, [refresh]);

  const syncStatus = getSyncStatus();

  const statusColor = {
    idle: "#10B981", success: "#10B981", syncing: "#F6BF26",
    error: "#FF5555", "auth-error": "#FF5555",
  }[syncStatus] || "#7a8aaa";

  const pendingVideos = videoItems.filter(v => v.status === "queued" || v.status === "uploading");
  const errorVideos   = videoItems.filter(v => v.status === "error" || v.status === "failed");
  const errorLogEntries = log.filter(e => e.level === "error");

  const photoQueueRaw = (() => {
    try { return JSON.parse(localStorage.getItem("mts-photo-queue") || "[]"); } catch { return []; }
  })();

  const health = [];
  if (dirtyCount > 0) health.push({ label: `${dirtyCount} field(s) pending Drive push`, color: "#F6BF26" });
  if (photoQueueRaw.length > 0) health.push({ label: `${photoQueueRaw.length} stop(s) with pending photo uploads`, color: "#F6BF26" });
  if (pendingVideos.length > 0) health.push({ label: `${pendingVideos.length} video(s) uploading/queued`, color: "#5a9fdf" });
  if (errorVideos.length > 0) health.push({ label: `${errorVideos.length} video upload(s) in error state`, color: "#FF5555" });
  if (errorLogEntries.length > 0) health.push({ label: `${errorLogEntries.length} error(s) in log`, color: "#FF5555" });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "#070910", display: "flex", flexDirection: "column", fontFamily: "'DM Sans',system-ui,sans-serif", color: "#e0e8ff", paddingTop: "env(safe-area-inset-top)" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid #1a2035", flexShrink: 0 }}>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#7a8aaa", cursor: "pointer", padding: 4, display: "flex" }}>
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", fontFamily: "'Oswald',sans-serif", flex: 1 }}>Debug Panel</span>
        <button onClick={refresh} style={{ background: "none", border: "1px solid #2a3560", borderRadius: 6, color: "#7a8aaa", cursor: "pointer", padding: "3px 8px", fontSize: 11, fontWeight: 600 }}>Refresh</button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, padding: "6px 14px", borderBottom: "1px solid #1a2035", flexShrink: 0 }}>
        {["overview", "queues", "log"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "4px 12px", borderRadius: 6, background: tab === t ? "#1a2035" : "transparent", border: "none", color: tab === t ? "#f0f4fa" : "#4a5a70", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1, fontFamily: "'Oswald',sans-serif" }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 14px 24px" }}>

        {tab === "overview" && <>
          {/* Health summary */}
          <div style={SECTION_HEAD}>Health</div>
          {health.length === 0
            ? <div style={{ fontSize: 12, color: "#10B981", padding: "8px 0", fontWeight: 600 }}>All clear — no issues detected</div>
            : health.map((h, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                  <div style={{ width: 7, height: 7, borderRadius: 99, background: h.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: h.color, fontWeight: 600 }}>{h.label}</span>
                </div>
              ))
          }

          {/* Sync */}
          <div style={SECTION_HEAD}>Sync</div>
          <div style={ROW}><span style={LABEL}>Drive status</span><span style={{ ...VALUE, color: statusColor }}>{syncStatus}</span></div>
          <div style={ROW}><span style={LABEL}>Last successful pull</span><span style={VALUE}>{ago(lastSyncTime)}</span></div>
          <div style={ROW}><span style={LABEL}>Fields pending push</span><span style={{ ...VALUE, color: dirtyCount > 0 ? "#F6BF26" : "#10B981" }}>{dirtyCount}</span></div>

          {/* IDB */}
          <div style={SECTION_HEAD}>Local Storage</div>
          <div style={ROW}><span style={LABEL}>Field records in IDB</span><span style={VALUE}>{loading ? "…" : (idbCount ?? "—")}</span></div>
          <div style={ROW}><span style={LABEL}>localStorage size</span><span style={VALUE}>{lsSize != null ? `~${(lsSize / 1024).toFixed(0)} KB` : "—"}</span></div>
          <div style={ROW}>
            <span style={LABEL}>Photo upload queue</span>
            <span style={{ ...VALUE, color: photoQueueRaw.length > 0 ? "#F6BF26" : "#10B981" }}>{photoQueueRaw.length} stop(s)</span>
          </div>

          {/* Error log summary */}
          <div style={SECTION_HEAD}>Error Log Summary</div>
          <div style={ROW}><span style={LABEL}>Total entries</span><span style={VALUE}>{log.length} / 100</span></div>
          <div style={ROW}><span style={LABEL}>Errors</span><span style={{ ...VALUE, color: errorLogEntries.length > 0 ? "#FF5555" : "#10B981" }}>{errorLogEntries.length}</span></div>
          <div style={ROW}><span style={LABEL}>Last error</span><span style={VALUE}>{errorLogEntries.length > 0 ? ago(errorLogEntries[errorLogEntries.length - 1].ts) : "none"}</span></div>
          {log.length > 0 && <div style={ROW}><span style={LABEL}>Oldest entry</span><span style={VALUE}>{fmt(log[0].ts)}</span></div>}

          {/* Actions */}
          <div style={SECTION_HEAD}>Actions</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}>
            <button onClick={downloadLog} style={{ padding: "9px 14px", borderRadius: 8, background: "#1a2035", border: "1px solid #2a3560", color: "#b0c0e0", fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "left" }}>
              Download error log (JSON)
            </button>
            <button onClick={() => { clearLog(); setLog([]); }} style={{ padding: "9px 14px", borderRadius: 8, background: "#1a0b0b", border: "1px solid #5a1a1a", color: "#FF8888", fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "left" }}>
              Clear error log
            </button>
          </div>

          {/* App version */}
          <div style={SECTION_HEAD}>Environment</div>
          <div style={ROW}><span style={LABEL}>User agent</span><span style={{ ...VALUE, fontSize: 10, wordBreak: "break-all" }}>{navigator.userAgent.slice(0, 80)}</span></div>
          <div style={ROW}><span style={LABEL}>Online</span><span style={{ ...VALUE, color: navigator.onLine ? "#10B981" : "#FF5555" }}>{navigator.onLine ? "yes" : "no"}</span></div>
          <div style={ROW}><span style={LABEL}>Timestamp</span><span style={VALUE}>{fmt(Date.now())}</span></div>
        </>}

        {tab === "queues" && <>
          <div style={SECTION_HEAD}>Video Upload Queue ({videoItems.length})</div>
          {videoItems.length === 0 && <div style={{ fontSize: 12, color: "#4a5a70", padding: "8px 0" }}>No video items</div>}
          {videoItems.map(item => {
            const pct = item.fileSize > 0 ? Math.round((item.bytesUploaded || 0) / item.fileSize * 100) : 0;
            const statusCol = { queued: "#5a9fdf", uploading: "#F6BF26", done: "#10B981", error: "#FF5555", failed: "#FF5555", cancelled: "#7a8aaa" }[item.status] || "#7a8aaa";
            return (
              <div key={item.id} style={{ background: "#0d1020", borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#e0e8ff", marginBottom: 4 }}>{item.title || item.id}</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 11, color: statusCol, fontWeight: 700 }}>{item.status}</span>
                  {item.fileSize > 0 && <span style={{ fontSize: 11, color: "#7a8aaa" }}>{(item.bytesUploaded / 1e6).toFixed(1)} / {(item.fileSize / 1e6).toFixed(1)} MB</span>}
                </div>
                {item.fileSize > 0 && (
                  <div style={{ height: 4, background: "#1a2035", borderRadius: 99 }}>
                    <div style={{ height: 4, width: `${pct}%`, background: statusCol, borderRadius: 99, transition: "width .3s" }} />
                  </div>
                )}
                <div style={{ fontSize: 10, color: "#4a5a70", marginTop: 4 }}>
                  {item.retryCount > 0 && `Retries: ${item.retryCount}  `}
                  {item.updatedAt ? `Updated: ${ago(item.updatedAt)}` : ""}
                </div>
              </div>
            );
          })}

          <div style={SECTION_HEAD}>Photo Upload Queue</div>
          {photoQueueRaw.length === 0
            ? <div style={{ fontSize: 12, color: "#4a5a70", padding: "8px 0" }}>No pending photo uploads</div>
            : photoQueueRaw.map(id => (
                <div key={id} style={{ fontSize: 12, color: "#b0c0e0", padding: "5px 0", borderBottom: "1px solid #1a2035" }}>{id}</div>
              ))
          }
        </>}

        {tab === "log" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
            <span style={SECTION_HEAD}>Error Log ({log.length} entries)</span>
            <button onClick={downloadLog} style={{ background: "none", border: "1px solid #2a3560", borderRadius: 6, color: "#7a8aaa", cursor: "pointer", padding: "3px 8px", fontSize: 10, fontWeight: 700 }}>Download</button>
          </div>
          {log.length === 0 && <div style={{ fontSize: 12, color: "#4a5a70", padding: "8px 0" }}>No log entries</div>}
          {[...log].reverse().map((entry, i) => (
            <div key={i} style={{ borderBottom: "1px solid #111520", padding: "7px 0" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: LEVEL_COLOR[entry.level] || "#7a8aaa", textTransform: "uppercase", minWidth: 36 }}>{entry.level}</span>
                <span style={{ fontSize: 10, color: "#5a6a8a", fontFamily: "'DM Mono',monospace" }}>{fmt(entry.ts)}</span>
                <span style={{ fontSize: 10, color: "#4a5a70" }}>{entry.context}</span>
              </div>
              <div style={{ fontSize: 12, color: "#c0d0e8", paddingLeft: 44 }}>{entry.message}</div>
              {entry.data && <div style={{ fontSize: 10, color: "#4a6070", paddingLeft: 44, fontFamily: "'DM Mono',monospace", wordBreak: "break-all", marginTop: 2 }}>{entry.data}</div>}
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}
