import { useState, useEffect, useCallback } from "react";
import {
  getPhotoQueueDetail, retryPhotoQueueNow, dropPhotoStop, processPhotoQueue,
} from "./photoSync";
import { getFieldSlim } from "./fieldStore";
import { IconX, IconRefresh, IconImage } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Photo Uploads
   ───────────────────────────────────────────────────────────────────────────
   Which stops still have photos waiting to reach Drive, and why.

   This existed only as a line in the debug panel, behind a five-tap gesture on
   an unmarked part of the header. So a stop could sit wedged for days with the
   only evidence somewhere nobody would ever look. It sits in Settings next to
   Video uploads now, where the same question about videos is already answered.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function PhotoUploads({ onClose, token }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setRows(getPhotoQueueDetail().map(q => ({ ...q, slim: getFieldSlim(q.stopId) })));
  }, []);

  useEffect(() => {
    refresh();
    // Poll while open so a retry visibly drains instead of looking frozen.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const retryAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      retryPhotoQueueNow();          // clear every backoff
      let tok = token;
      try {
        const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
        if (saved?.token && saved.expiry > Date.now()) tok = saved.token;
      } catch {}
      if (tok) await processPhotoQueue(tok);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 360, background: "#0a0b10",
      display: "flex", flexDirection: "column", fontFamily: "'DM Sans',system-ui,sans-serif",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        padding: "max(14px, env(safe-area-inset-top)) 16px 12px",
        borderBottom: "1px solid #1a2030",
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
            Photo Uploads
          </div>
          <div style={{ fontSize: 11.5, color: "#5a6580", marginTop: 2 }}>
            {rows.length === 0
              ? "Everything is uploaded"
              : `${rows.length} stop${rows.length === 1 ? "" : "s"} with photos still to upload`}
          </div>
        </div>
        {rows.length > 0 && (
          <button onClick={retryAll} disabled={busy} style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "9px 14px", borderRadius: 9,
            background: "rgba(26,115,232,.15)", border: "1px solid rgba(26,115,232,.4)",
            color: "#7db4ff", fontSize: 11.5, fontWeight: 800, fontFamily: F,
            letterSpacing: 0.5, textTransform: "uppercase",
            cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
          }}>
            <IconRefresh size={14} color="#7db4ff" />
            {busy ? "Trying…" : "Retry all"}
          </button>
        )}
        <button onClick={onClose} aria-label="Close" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0,
          background: "transparent", border: "1px solid #253049", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconX size={16} color="#8aa0c0" /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px max(20px, env(safe-area-inset-bottom))" }}>
        {rows.length === 0 && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            gap: 10, padding: "60px 20px", textAlign: "center",
          }}>
            <IconImage size={30} color="#253049" />
            <div style={{ fontSize: 13.5, color: "#5a6580" }}>
              No photos are waiting. Everything on this device has reached Drive.
            </div>
          </div>
        )}

        {rows.map(r => (
          <div key={r.stopId} style={{
            padding: "12px 0", borderBottom: "1px solid #141a28",
            display: "flex", alignItems: "flex-start", gap: 10,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e6ecf5" }}>
                {r.slim?.cn || r.stopId}
              </div>
              <div style={{ fontSize: 11.5, color: "#7a8aaa", marginTop: 3, lineHeight: 1.45 }}>
                {r.pending == null
                  ? "Queued — not tried yet"
                  : `${r.pending} photo${r.pending === 1 ? "" : "s"} left to upload`}
                {r.tries > 0 && ` · ${r.tries} failed ${r.tries === 1 ? "attempt" : "attempts"}`}
                {r.lastTry > 0 && ` · last tried ${ago(r.lastTry)}`}
              </div>
              {r.lastError && (
                <div style={{
                  fontSize: 11.5, color: "#ff9a9a", marginTop: 5, lineHeight: 1.4,
                  wordBreak: "break-word",
                }}>{r.lastError}</div>
              )}
            </div>
            <button
              onClick={() => {
                if (!window.confirm(
                  "Stop trying to upload this stop's photos?\n\n" +
                  "The photos stay on this device exactly as they are — this only " +
                  "stops the retries."
                )) return;
                dropPhotoStop(r.stopId);
                refresh();
              }}
              style={{
                flexShrink: 0, padding: "7px 11px", borderRadius: 8,
                background: "transparent", border: "1px solid #3a2540",
                color: "#c08090", fontSize: 10.5, fontWeight: 800, fontFamily: F,
                letterSpacing: 0.4, textTransform: "uppercase", cursor: "pointer",
              }}
            >Stop</button>
          </div>
        ))}

        {rows.length > 0 && (
          <div style={{ fontSize: 11.5, color: "#4a5a70", lineHeight: 1.5, padding: "14px 0" }}>
            Photos live on this device until Drive accepts them, so nothing here is
            lost while it waits. Uploads retry on their own, backing off as they
            fail — “Retry all” skips the wait and tries again right now.
          </div>
        )}
      </div>
    </div>
  );
}
