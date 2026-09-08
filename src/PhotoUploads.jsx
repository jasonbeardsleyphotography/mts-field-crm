import { useState, useEffect, useCallback } from "react";
import {
  getPhotoQueueDetail, retryPhotoQueueNow, dropPhotoStop, processPhotoQueue,
  resetPhotoQueueLock,
} from "./photoSync";
import { getFieldSlim, loadField } from "./fieldStore";
import { getDriveStorage } from "./driveSync";
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

function fmtBytes(n) {
  if (n == null) return "—";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

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
  const [result, setResult] = useState(null);
  // The definitive answer to "is Drive actually full?". A full Drive and a
  // throttled Drive both arrive as a 403 and only one of them clears by
  // waiting, so it is worth one call to say which.
  const [storage, setStorage] = useState(null);

  const refresh = useCallback(async () => {
    const detail = getPhotoQueueDetail();
    // The slim mirror often has no entry for these stops, which is why every
    // row read as a raw calendar id. The full record does have the name, so
    // fall back to it — this screen is only ever showing a handful of rows.
    const named = await Promise.all(detail.map(async (q) => {
      let cn = getFieldSlim(q.stopId)?.cn || null;
      if (!cn) {
        try { cn = (await loadField(q.stopId))?.cn || null; } catch {}
      }
      return { ...q, cn };
    }));
    setRows(named);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let tok = token;
        try {
          const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
          if (saved?.token && saved.expiry > Date.now()) tok = saved.token;
        } catch {}
        if (!tok) return;
        const s = await getDriveStorage(tok);
        if (alive) setStorage(s);
      } catch { /* not worth surfacing on its own */ }
    })();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    refresh();
    // Poll while open so a retry visibly drains instead of looking frozen.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const retryAll = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    const before = getPhotoQueueDetail().length;
    try {
      retryPhotoQueueNow();          // clear every backoff
      // And clear a wedged pass lock, so a tap is guaranteed to actually run
      // something rather than returning at a guard.
      resetPhotoQueueLock();
      let tok = token;
      try {
        const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
        if (saved?.token && saved.expiry > Date.now()) tok = saved.token;
      } catch {}
      if (!tok) {
        setResult("Not signed in to Google right now, so nothing could be uploaded. Reconnect from the route screen and try again.");
        return;
      }
      await processPhotoQueue(tok);
      const after = getPhotoQueueDetail().length;
      setResult(before === after
        ? "Tried every stop. Nothing finished — the reason for each is below."
        : `${before - after} stop${before - after === 1 ? "" : "s"} finished uploading.`);
    } catch (e) {
      setResult(`The retry itself failed: ${e?.message || e}`);
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
        {storage && storage.limit != null && (
          <div style={{
            margin: "6px 0 10px", padding: "10px 12px", borderRadius: 9,
            background: storage.full ? "rgba(239,68,68,.12)" : "rgba(255,255,255,.04)",
            border: `1px solid ${storage.full ? "#ef4444" : "#1e2740"}`,
            color: storage.full ? "#ffc9c9" : "#8aa0c0", fontSize: 12, lineHeight: 1.45,
          }}>
            <b style={{ color: storage.full ? "#ff8080" : "#cfe0f5" }}>
              Google Drive: {fmtBytes(storage.used)} of {fmtBytes(storage.limit)} used
              {storage.usedPct != null ? ` (${storage.usedPct.toFixed(1)}%)` : ""}
            </b>
            {storage.full && (
              <div style={{ marginTop: 4 }}>
                Drive has no room left, so nothing can upload until you free space.
                Empty Drive's Trash first — deleted files still count against this.
              </div>
            )}
          </div>
        )}
        {result && (
          <div style={{
            margin: "6px 0 10px", padding: "10px 12px", borderRadius: 9,
            background: "rgba(26,115,232,.1)", border: "1px solid rgba(26,115,232,.3)",
            color: "#cfe0f5", fontSize: 12, lineHeight: 1.45,
          }}>{result}</div>
        )}
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
              {/* overflowWrap:anywhere — a calendar id is one unbroken 40-char
                  token, which pushed the Stop button off the row and under the
                  text when there was no client name to show. */}
              <div style={{
                fontSize: 14, fontWeight: 700, color: "#e6ecf5",
                overflowWrap: "anywhere",
                ...(r.cn ? {} : { fontSize: 11.5, color: "#8aa0c0", fontWeight: 600 }),
              }}>
                {r.cn || r.stopId}
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
