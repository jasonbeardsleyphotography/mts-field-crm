/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Storage Panel
   Full-screen overlay showing on-device storage usage: a total estimate
   from the browser, a breakdown of what's using it (queued/failed video
   blobs vs. local photo copies), the list of failed video uploads (with
   Retry/Discard — same actions as VideoUploads.jsx), and a "Free up space
   now" button that runs the global photo-eviction sweep.
   ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from "react";
import { listAll as listAllQueue, retryItem, cancelItem, repairVideoSharing } from "./videoQueue";
import { listFieldIds, loadField } from "./fieldStore";
import { sweepAllPhotos } from "./photoSync";
import { IconArrowLeft, IconX } from "./icons";

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtAge(ms) {
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  return "just now";
}

// Sum the length of every retained photo dataUrl across all stops.
// base64 length ≈ bytes (close enough for an estimate).
async function localPhotoBytes() {
  const ids = await listFieldIds();
  let total = 0;
  for (const id of ids) {
    let data;
    try { data = await loadField(id); } catch { continue; }
    if (!data) continue;
    for (const key of ["scopePhotos", "addonPhotos"]) {
      const photos = data[key];
      if (!Array.isArray(photos)) continue;
      for (const p of photos) {
        if (p?.dataUrl) total += p.dataUrl.length;
      }
    }
  }
  return total;
}

export default function StoragePanel({ open, onClose, token }) {
  const [estimate, setEstimate] = useState(null); // { usage, quota }
  const [videoItems, setVideoItems] = useState([]);
  const [photoBytes, setPhotoBytes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [freedMsg, setFreedMsg] = useState(null);
  const [restarting, setRestarting] = useState({});
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (navigator.storage?.estimate) {
        setEstimate(await navigator.storage.estimate());
      }
      setVideoItems(await listAllQueue());
      setPhotoBytes(await localPhotoBytes());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;

  const videoBytes = videoItems.reduce((sum, i) => sum + (i.fileSize || 0), 0);
  const errorItems = videoItems.filter(i => i.status === "error");
  const errorBytes = errorItems.reduce((sum, i) => sum + (i.fileSize || 0), 0);
  const usagePct = estimate?.quota ? Math.min(100, (estimate.usage / estimate.quota) * 100) : null;

  const handleFreeUpSpace = async () => {
    setSweeping(true);
    setFreedMsg(null);
    try {
      const before = estimate?.usage ?? 0;
      const { stopsScanned, photosEvicted } = await sweepAllPhotos();
      await refresh();
      const after = navigator.storage?.estimate ? (await navigator.storage.estimate()).usage : null;
      const freed = after != null ? Math.max(0, before - after) : null;
      setFreedMsg(
        photosEvicted === 0
          ? `Checked ${stopsScanned} jobs — nothing old enough to clear yet.`
          : `Cleared local copies of ${photosEvicted} photo${photosEvicted === 1 ? "" : "s"} across ${stopsScanned} jobs` +
            (freed ? ` (freed ~${fmtBytes(freed)}).` : ".")
      );
    } finally {
      setSweeping(false);
    }
  };

  const handleFixVideoLinks = async () => {
    if (!token) return;
    setRepairing(true);
    setRepairMsg(null);
    try {
      const { checked, fixed, failed } = await repairVideoSharing(token);
      setRepairMsg(
        checked === 0
          ? "No video links found to check."
          : `Checked ${checked} video link${checked === 1 ? "" : "s"} — fixed ${fixed}, already OK ${checked - fixed - failed}` +
            (failed ? `, ${failed} still failed (try again).` : ".")
      );
    } catch {
      setRepairMsg("Couldn't check video links — try again.");
    } finally {
      setRepairing(false);
    }
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
            Storage
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {/* Total usage */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, color: "#5a6580", fontFamily: F, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
            Total on this device
          </div>
          {estimate ? (
            <>
              <div style={{ fontSize: 24, fontWeight: 900, color: "#e0e8f0", fontFamily: F }}>
                {fmtBytes(estimate.usage)}
                {estimate.quota ? <span style={{ fontSize: 13, color: "#5a6580", fontWeight: 600 }}> / {fmtBytes(estimate.quota)}</span> : null}
              </div>
              {usagePct != null && (
                <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,.06)", overflow: "hidden", marginTop: 8 }}>
                  <div style={{ height: "100%", width: `${usagePct}%`, background: usagePct > 80 ? "#FF5555" : "#3B82F6", transition: "width .4s" }} />
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#4a5a70", fontFamily: B }}>{loading ? "Calculating…" : "Not available on this browser."}</div>
          )}
        </div>

        {/* Breakdown */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, color: "#5a6580", fontFamily: F, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
            Breakdown
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,.03)", border: "1px solid #1a2030" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e0e8f0", fontFamily: F }}>Videos in upload queue</div>
                <div style={{ fontSize: 10, color: "#4a5a70", fontFamily: B, marginTop: 2 }}>
                  {videoItems.length} file{videoItems.length === 1 ? "" : "s"}
                  {errorItems.length > 0 && <span style={{ color: "#FF8888" }}> · {errorItems.length} failed ({fmtBytes(errorBytes)})</span>}
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#e0e8f0", fontFamily: F }}>{fmtBytes(videoBytes)}</div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,.03)", border: "1px solid #1a2030" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e0e8f0", fontFamily: F }}>Local photo copies</div>
                <div style={{ fontSize: 10, color: "#4a5a70", fontFamily: B, marginTop: 2 }}>
                  Cloud-backed copies are kept on-device for 7 days, then cleared automatically.
                </div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#e0e8f0", fontFamily: F }}>{photoBytes != null ? fmtBytes(photoBytes) : "…"}</div>
            </div>
          </div>
        </div>

        {/* Failed video uploads */}
        {errorItems.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: "#5a6580", fontFamily: F, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
              Failed video uploads
            </div>
            <div style={{ fontSize: 11, color: "#d4aa60", fontFamily: B, lineHeight: 1.5, marginBottom: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(246,191,38,.07)", border: "1px solid rgba(246,191,38,.2)" }}>
              These videos never finished uploading — the only copy is on this device. Retry to resume the upload, or discard if you no longer need it.
            </div>
            {errorItems.map(item => (
              <div key={item.id} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,.03)", border: "1px solid #1a2030", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#e0e8f0", fontFamily: F, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
                    <div style={{ fontSize: 10, color: "#4a5a70", marginTop: 2 }}>{fmtBytes(item.fileSize)} · {fmtAge(Date.now() - (item.updatedAt || item.createdAt || Date.now()))}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => {
                      setRestarting(r => ({ ...r, [item.id]: true }));
                      setTimeout(() => setRestarting(r => { const next = { ...r }; delete next[item.id]; return next; }), 4000);
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
                  >{restarting[item.id] ? "Retrying…" : "Retry"}</button>
                  <button
                    onClick={() => {
                      if (window.confirm("Discard this video? It will be permanently deleted from this device — it never reached Drive.")) {
                        cancelItem(item.id).then(refresh);
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
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: "10px 16px",
        paddingBottom: "max(10px, env(safe-area-inset-bottom))",
        borderTop: "1px solid #1a2030",
        background: "#0a0c14", flexShrink: 0,
      }}>
        {repairMsg && (
          <div style={{ fontSize: 11, color: "#3B82F6", fontFamily: B, marginBottom: 8, textAlign: "center" }}>{repairMsg}</div>
        )}
        <button
          onClick={handleFixVideoLinks}
          disabled={repairing || !token}
          style={{
            width: "100%", padding: "10px 0", borderRadius: 10, marginBottom: 8,
            background: "rgba(59,130,246,.1)", border: "1px solid rgba(59,130,246,.3)",
            color: "#3B82F6", fontSize: 12, fontWeight: 800,
            cursor: repairing ? "default" : "pointer", opacity: repairing ? 0.6 : 1,
            fontFamily: F, letterSpacing: 0.5,
          }}
        >{repairing ? "Checking video links…" : "Fix video playback links"}</button>
        {freedMsg && (
          <div style={{ fontSize: 11, color: "#10B981", fontFamily: B, marginBottom: 8, textAlign: "center" }}>{freedMsg}</div>
        )}
        <button
          onClick={handleFreeUpSpace}
          disabled={sweeping}
          style={{
            width: "100%", padding: "10px 0", borderRadius: 10,
            background: "rgba(16,185,129,.1)", border: "1px solid rgba(16,185,129,.3)",
            color: "#10B981", fontSize: 12, fontWeight: 800,
            cursor: sweeping ? "default" : "pointer", opacity: sweeping ? 0.6 : 1,
            fontFamily: F, letterSpacing: 0.5,
          }}
        >{sweeping ? "Checking…" : "Free up space now"}</button>
      </div>
    </div>
  );
}
