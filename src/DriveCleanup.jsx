import { useState, useCallback } from "react";
import {
  listAppPhotoFiles, findDuplicatePhotos, deleteDriveFiles, getDriveStorage,
} from "./driveSync";
import { listFieldIds, loadField } from "./fieldStore";
import { IconX, IconTrash, IconRefresh } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Free up Drive space
   ───────────────────────────────────────────────────────────────────────────
   Finds duplicate photo files this app put in Drive and offers to remove them.

   They are here because of a bug in this app: a photo whose upload succeeded
   but whose "make it public" step failed was treated as a failed upload and
   sent again, once a minute, for as long as the app stayed open. Every attempt
   left a file behind. The bug is fixed; the files are not, and they are
   occupying the quota that is now blocking every new upload.

   Two rules, because this deletes things that cannot be undone:
     • A file any card still points at is never touched. The referenced set is
       read from the app's own records before anything is listed.
     • Every duplicate name keeps one file. Only the extra copies go.
   Nothing is deleted until you say so, and you see the count and the size
   first.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

function fmtBytes(n) {
  if (n == null) return "—";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = n / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

// Every Drive id the app's own records still point at.
async function collectReferencedIds() {
  const ids = new Set();
  const idOf = (url) => {
    const m = String(url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
              String(url || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    return m?.[1] || null;
  };
  let stopIds = [];
  try { stopIds = await listFieldIds(); } catch { return ids; }
  for (const sid of stopIds) {
    let rec = null;
    try { rec = await loadField(sid); } catch { continue; }
    if (!rec) continue;
    for (const key of ["scopePhotos", "addonPhotos", "photos"]) {
      const arr = rec[key];
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        const id = idOf(p?.url);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

export default function DriveCleanup({ onClose, token }) {
  const [phase, setPhase] = useState("idle");  // idle | scanning | ready | deleting | done
  const [scan, setScan] = useState(null);
  const [storage, setStorage] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const freshToken = useCallback(() => {
    let tok = token;
    try {
      const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
      if (saved?.token && saved.expiry > Date.now()) tok = saved.token;
    } catch {}
    return tok;
  }, [token]);

  const runScan = useCallback(async () => {
    const tok = freshToken();
    if (!tok) { setError("Not signed in to Google right now."); return; }
    setPhase("scanning"); setError(null); setScan(null);
    try {
      const [files, referenced, store] = await Promise.all([
        listAppPhotoFiles(tok),
        collectReferencedIds(),
        getDriveStorage(tok).catch(() => null),
      ]);
      setStorage(store);
      const result = findDuplicatePhotos(files, referenced);
      setScan({ ...result, total: files.length, referenced: referenced.size });
      setPhase("ready");
    } catch (e) {
      setError(e?.message || String(e));
      setPhase("idle");
    }
  }, [freshToken]);

  const runDelete = useCallback(async () => {
    if (!scan?.deletable?.length) return;
    if (!window.confirm(
      `Permanently delete ${scan.deletable.length} duplicate photo file` +
      `${scan.deletable.length === 1 ? "" : "s"} from Google Drive?\n\n` +
      `This frees about ${fmtBytes(scan.bytes)}. One copy of every photo is kept, ` +
      `and no file any card points at is touched. This cannot be undone.`
    )) return;
    const tok = freshToken();
    if (!tok) { setError("Not signed in to Google right now."); return; }
    setPhase("deleting"); setProgress({ done: 0, failed: 0, total: scan.deletable.length });
    try {
      const res = await deleteDriveFiles(tok, scan.deletable.map(f => f.id), setProgress);
      setProgress(res);
      setPhase("done");
      // Re-read the quota so the number on screen reflects the deletion.
      try { setStorage(await getDriveStorage(tok)); } catch {}
    } catch (e) {
      setError(e?.message || String(e));
      setPhase("ready");
    }
  }, [scan, freshToken]);

  const btn = (accent) => ({
    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
    width: "100%", padding: "13px 0", borderRadius: 10,
    background: `${accent}22`, border: `1px solid ${accent}88`, color: accent,
    fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
    textTransform: "uppercase", cursor: "pointer",
  });

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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
            Free Up Drive Space
          </div>
          <div style={{ fontSize: 11.5, color: "#5a6580", marginTop: 2 }}>
            Duplicate photos this app left behind
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0,
          background: "transparent", border: "1px solid #253049", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconX size={16} color="#8aa0c0" /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px max(20px, env(safe-area-inset-bottom))" }}>
        {storage?.limit != null && (
          <div style={{
            padding: "10px 12px", borderRadius: 9, marginBottom: 12,
            background: storage.full ? "rgba(239,68,68,.12)" : "rgba(255,255,255,.04)",
            border: `1px solid ${storage.full ? "#ef4444" : "#1e2740"}`,
            color: storage.full ? "#ff8080" : "#cfe0f5", fontSize: 12.5, fontWeight: 700,
          }}>
            Google Drive: {fmtBytes(storage.used)} of {fmtBytes(storage.limit)} used
            {storage.usedPct != null ? ` (${storage.usedPct.toFixed(1)}%)` : ""}
          </div>
        )}

        {error && (
          <div style={{
            padding: "10px 12px", borderRadius: 9, marginBottom: 12,
            background: "rgba(239,68,68,.12)", border: "1px solid #ef4444",
            color: "#ffc9c9", fontSize: 12, lineHeight: 1.45,
          }}>{error}</div>
        )}

        {phase === "idle" && (
          <>
            <p style={{ fontSize: 13, color: "#8aa0c0", lineHeight: 1.55 }}>
              A bug in this app re-uploaded photos it thought had failed — once a
              minute, for as long as the app was open — leaving a copy in Drive
              every time. The bug is fixed, but those files are still taking up
              the space that is now blocking new uploads.
            </p>
            <p style={{ fontSize: 12.5, color: "#5a6580", lineHeight: 1.55, marginTop: 10 }}>
              Scanning only reads. Nothing is deleted until you confirm, and you
              will see how many files and how much space first. One copy of every
              photo is always kept, and any file a card still points at is left
              alone.
            </p>
            <div style={{ marginTop: 16 }}>
              <button onClick={runScan} style={btn("#7db4ff")}>
                <IconRefresh size={15} color="#7db4ff" /> Scan Drive
              </button>
            </div>
          </>
        )}

        {phase === "scanning" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "#8aa0c0", fontSize: 13 }}>
            Scanning your Drive… this can take a minute on a large account.
          </div>
        )}

        {(phase === "ready" || phase === "deleting" || phase === "done") && scan && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {[
                ["Photo files in Drive", String(scan.total)],
                ["Still used by a card", String(scan.referenced)],
                ["Duplicate copies", String(scan.deletable.length)],
                ["Space they take", fmtBytes(scan.bytes)],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid #141a28" }}>
                  <span style={{ flex: 1, fontSize: 12, color: "#5a6580" }}>{k}</span>
                  <span style={{ fontSize: 13, color: "#e6ecf5", fontWeight: 700 }}>{v}</span>
                </div>
              ))}
            </div>

            {phase === "done" && (
              <div style={{
                padding: "10px 12px", borderRadius: 9, marginBottom: 12,
                background: "rgba(16,185,129,.12)", border: "1px solid rgba(16,185,129,.4)",
                color: "#a8dca0", fontSize: 12.5, lineHeight: 1.45,
              }}>
                Deleted {progress?.done ?? 0} file{(progress?.done ?? 0) === 1 ? "" : "s"}
                {progress?.failed ? `, ${progress.failed} could not be deleted` : ""}.
                Drive counts deleted files against your quota until its Trash is
                emptied — open Drive and empty Trash to actually reclaim the space,
                then come back and tap Retry all on Photo uploads.
              </div>
            )}

            {phase === "deleting" && (
              <div style={{ fontSize: 12.5, color: "#8aa0c0", marginBottom: 12 }}>
                Deleting {progress?.done ?? 0} of {progress?.total ?? 0}…
              </div>
            )}

            {phase === "ready" && scan.deletable.length > 0 && (
              <button onClick={runDelete} style={btn("#ff8080")}>
                <IconTrash size={15} color="#ff8080" />
                Delete {scan.deletable.length} duplicates · {fmtBytes(scan.bytes)}
              </button>
            )}

            {phase === "ready" && scan.deletable.length === 0 && (
              <div style={{ fontSize: 13, color: "#8aa0c0", lineHeight: 1.55 }}>
                No duplicates found. The space is being used by something else —
                check Google Photos, Gmail attachments, and Drive's Trash, which
                still counts against the quota.
              </div>
            )}

            {phase !== "deleting" && (
              <button onClick={runScan} style={{ ...btn("#5a6580"), marginTop: 10 }}>
                <IconRefresh size={15} color="#8aa0c0" /> Scan again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
