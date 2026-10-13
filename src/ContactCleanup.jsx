import { useState, useCallback } from "react";
import {
  listAllContacts, findDuplicateContacts, deleteContacts,
} from "./googleContacts";
import { IconX, IconTrash, IconRefresh } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Clean up duplicate contacts
   ───────────────────────────────────────────────────────────────────────────
   Shows the duplicate client contacts this app created, and removes the extras
   on confirmation. Only contacts carrying this app's own "CLIENT " name prefix
   or its signature note are ever considered, a contact with no duplicate is
   never a candidate, and every duplicate set keeps one record — the most
   complete one, tie-broken to the oldest, since that is the copy the phone has
   most likely already synced.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function ContactCleanup({ onClose, token }) {
  const [phase, setPhase] = useState("idle");  // idle | scanning | ready | deleting | done
  const [scan, setScan] = useState(null);
  const [count, setCount] = useState(0);
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
    setPhase("scanning"); setError(null); setScan(null); setCount(0);
    try {
      const people = await listAllContacts(tok, setCount);
      setScan(findDuplicateContacts(people));
      setPhase("ready");
    } catch (e) {
      setError(e?.detail || e?.message || String(e));
      setPhase("idle");
    }
  }, [freshToken]);

  const runDelete = useCallback(async () => {
    if (!scan?.deletable?.length) return;
    if (!window.confirm(
      `Permanently delete ${scan.deletable.length} duplicate contact` +
      `${scan.deletable.length === 1 ? "" : "s"} from Google Contacts?\n\n` +
      `One contact is kept for every client, and no contact this app didn't ` +
      `create is touched. This cannot be undone.`
    )) return;
    const tok = freshToken();
    if (!tok) { setError("Not signed in to Google right now."); return; }
    setPhase("deleting"); setProgress({ done: 0, failed: 0, total: scan.deletable.length });
    try {
      const res = await deleteContacts(tok, scan.deletable.map(p => p.resourceName), setProgress);
      setProgress(res);
      setPhase("done");
    } catch (e) {
      setError(e?.detail || e?.message || String(e));
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
            Duplicate Contacts
          </div>
          <div style={{ fontSize: 11.5, color: "#5a6580", marginTop: 2 }}>
            Extra client contacts this app created
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0,
          background: "transparent", border: "1px solid #253049", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconX size={16} color="#8aa0c0" /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px max(20px, env(safe-area-inset-bottom))" }}>
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
              The app adds a “CLIENT …” contact for each new client so their
              calls show a name. A bug let it add the same person more than
              once — that's fixed, but the extra entries are still in your
              phone.
            </p>
            <p style={{ fontSize: 12.5, color: "#5a6580", lineHeight: 1.55, marginTop: 10 }}>
              Scanning only reads. Nothing is deleted until you confirm, and you
              will see the count first. Only contacts this app created are
              considered, and every client keeps one.
            </p>
            <div style={{ marginTop: 16 }}>
              <button onClick={runScan} style={btn("#7db4ff")}>
                <IconRefresh size={15} color="#7db4ff" /> Scan contacts
              </button>
            </div>
          </>
        )}

        {phase === "scanning" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "#8aa0c0", fontSize: 13 }}>
            Reading your contacts… {count > 0 ? `${count} so far` : ""}
          </div>
        )}

        {(phase === "ready" || phase === "deleting" || phase === "done") && scan && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {[
                ["Contacts scanned", String(scan.scanned)],
                ["Added by this app", String(scan.appContacts)],
                ["Clients with duplicates", String(scan.groups.length)],
                ["Extra copies to remove", String(scan.deletable.length)],
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
                Deleted {progress?.done ?? 0} contact{(progress?.done ?? 0) === 1 ? "" : "s"}
                {progress?.failed ? `, ${progress.failed} could not be deleted` : ""}.
                Your phone may take a few minutes to catch up with Google.
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
                Delete {scan.deletable.length} duplicates
              </button>
            )}

            {phase === "ready" && scan.deletable.length === 0 && (
              <div style={{ fontSize: 13, color: "#8aa0c0", lineHeight: 1.55 }}>
                No duplicates found among the contacts this app created.
              </div>
            )}

            {/* What would go, so this isn't a blind delete. */}
            {scan.groups.length > 0 && phase !== "deleting" && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: "#4a5a70", fontFamily: F, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
                  {phase === "done" ? "Cleaned up" : "Will keep one of each"}
                </div>
                {scan.groups.slice(0, 60).map(g => (
                  <div key={g.id} style={{
                    display: "flex", gap: 10, padding: "7px 0",
                    borderBottom: "1px solid #141a28", alignItems: "center",
                  }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#cfe0f5", overflowWrap: "anywhere" }}>
                      {g.name}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 11.5, color: "#ff9a9a", fontWeight: 700 }}>
                      −{g.drop.length}
                    </span>
                  </div>
                ))}
                {scan.groups.length > 60 && (
                  <div style={{ fontSize: 11.5, color: "#5a6580", paddingTop: 8 }}>
                    …and {scan.groups.length - 60} more.
                  </div>
                )}
              </div>
            )}

            {phase !== "deleting" && (
              <button onClick={runScan} style={{ ...btn("#5a6580"), marginTop: 14 }}>
                <IconRefresh size={15} color="#8aa0c0" /> Scan again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
