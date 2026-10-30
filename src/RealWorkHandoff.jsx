import { useState, useEffect, useRef, useCallback } from "react";
import { loadField } from "./fieldStore";
import { lastNameOf } from "./photoSync";
import { photoToFile, sharePhotoFile } from "./sharePhoto";
import { IconX, IconLinkExternal } from "./icons";
import RealWorkSetup from "./RealWorkSetup";
import { openRealWork, realworkHref, isShortcutReady, runSendShortcut, sendShortcutHref } from "./realwork";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Hand-off to RealWork, shown right after Done
   ───────────────────────────────────────────────────────────────────────────
   The visit is already saved and filed by the time this appears (Done does that
   first), so leaving the app from here cannot interrupt a save.

     • Card has photos   → pick ONE. It goes to the phone's share sheet; tap
                            "Save Image" to put it in Photos. RealWork then
                            opens.
     • Card has no photos → straight to RealWork.
     • Skip              → straight on to the next-stop screen, no RealWork.

   When you come back to the app, onRelease() hands over to the existing
   next-stop screen, whose countdown is unchanged and starts fresh on return.

   Two things iOS decides, not this app, and the screen is built to survive both:
     1. Opening RealWork automatically after the share sheet closes may be
        refused (it was not a direct response to a tap). So there is always a
        real "Open RealWork" link on screen — one tap if the automatic attempt
        didn't take.
     2. Whether the link opens the RealWork app, Safari, or an in-app sheet is
        up to iOS and RealWork. If it is a sheet over this app, the app is never
        "hidden", so there is also an "I'm back" button.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

// A card thumbnail doesn't need the 1200px rendition Drive photos are stored at.
const smallThumb = (url) =>
  typeof url === "string" ? url.replace(/([?&]sz=)w\d+/, "$1w400") : url;

export default function RealWorkHandoff({ stopId, cn, token, onRelease, sendClip = null }) {
  // sendClip: when "Send to RealWork" is on, Done has already started copying
  // the visit's first photo to the clipboard, and this is the promise for it.
  // Then there is no picker: wait for the copy, run the Shortcut, done. If the
  // copy fails, fall back to the picker below so nothing is lost.
  const [phase, setPhase] = useState(sendClip ? "sending" : "loading");   // sending | loading | pick | opening
  const [mode, setMode] = useState("plain");      // plain: open RealWork | send: run Send to RealWork
  const [photos, setPhotos] = useState([]);
  const [busyKey, setBusyKey] = useState(null);
  const [note, setNote] = useState(null);
  const [, refresh] = useState(0);          // re-read the saved RealWork choice after setup
  const [showSetup, setShowSetup] = useState(false);
  const fileCache = useRef(new Map());              // photo key -> File, for a second tap
  const openedRef = useRef(false);
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (phase !== "loading") return;
    const t = setTimeout(() => setSlowLoad(true), 4000);
    return () => clearTimeout(t);
  }, [phase]);

  // Send mode: wait for the photo copy that Done started.
  useEffect(() => {
    if (!sendClip) return;
    let dead = false;
    sendClip.then((ok) => {
      if (dead) return;
      if (ok) { setMode("send"); setPhase("opening"); }
      else {
        setNote("Couldn't copy the photo automatically — pick one below instead.");
        setPhase("loading");
      }
    });
    return () => { dead = true; };
  }, [sendClip]);

  // Which photos does the visit that just finished have?
  useEffect(() => {
    if (phase !== "loading") return;
    let dead = false;
    (async () => {
      let list = [];
      try {
        const rec = await loadField(stopId);
        list = [
          ...(Array.isArray(rec?.scopePhotos) ? rec.scopePhotos : Array.isArray(rec?.photos) ? rec.photos : []),
          ...(Array.isArray(rec?.addonPhotos) ? rec.addonPhotos : []),
        ].filter(p => p && (p.dataUrl || p.url));
      } catch { /* can't read them — fall through to "no photos" */ }
      if (dead) return;
      setPhotos(list);
      // No photos: nothing to choose, go straight to RealWork.
      setPhase(list.length ? "pick" : "opening");
    })();
    return () => { dead = true; };
  }, [stopId, phase]);

  // Entering "opening": try to launch RealWork once.
  useEffect(() => {
    if (phase !== "opening" || openedRef.current) return;
    openedRef.current = true;
    if (mode === "send") runSendShortcut(); else openRealWork();
  }, [phase, mode]);

  // Coming back to the app after RealWork → continue to the next stop.
  useEffect(() => {
    if (phase !== "opening") return;
    let wasHidden = document.visibilityState === "hidden";
    const onVis = () => {
      if (document.visibilityState === "hidden") wasHidden = true;
      else if (wasHidden) onRelease();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase, onRelease]);

  const nameFor = (n) => {
    const last = lastNameOf(cn) || "Photo";
    const d = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }).replace(/\//g, "-");
    return `${last} ${d} ${String(n).padStart(2, "0")}.jpg`;
  };

  const pick = useCallback(async (p, n) => {
    if (busyKey) return;
    // The client's name goes on the clipboard with this tap (iOS only allows a
    // copy during one), ready to paste once RealWork opens. Saving the photo
    // goes to Photos, not the clipboard, so the name survives.
    try { if (cn) navigator.clipboard?.writeText(String(cn).trim()).catch(() => {}); } catch {}
    const key = p.id || p.ts || n;
    setBusyKey(key); setNote(null);
    try {
      let file = fileCache.current.get(key);
      if (!file) {
        // An on-device photo becomes a file instantly, which keeps this tap
        // valid for the share sheet. A Drive-only one has to download first,
        // which can outlast it — the file is kept, so a second tap is instant.
        file = await photoToFile(p, token, nameFor(n));
        fileCache.current.set(key, file);
      }
      const r = await sharePhotoFile(file, cn || "Photo");
      if (r === "needs-tap") setNote("Photo ready — tap it again.");
      else if (r === "cancelled") setNote("Not saved. Tap a photo to try again, or choose another option below.");
      else setPhase("opening");     // saved (or downloaded where there's no share sheet)
    } catch {
      setNote("Couldn't load that photo. Try another, or open RealWork without one.");
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, token, cn]);   // eslint-disable-line react-hooks/exhaustive-deps

  const shell = {
    position: "fixed", inset: 0, zIndex: 490, background: "#0a0b10",
    display: "flex", flexDirection: "column", fontFamily: B, color: "#e6ecf5",
  };
  const bigBtn = (accent) => ({
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", padding: "16px 0", borderRadius: 12, textDecoration: "none",
    background: `${accent}22`, border: `1px solid ${accent}99`, color: accent,
    fontSize: 14, fontWeight: 800, fontFamily: F, letterSpacing: 0.6,
    textTransform: "uppercase", cursor: "pointer", boxSizing: "border-box",
  });
  const quietBtn = {
    width: "100%", padding: "12px 0", borderRadius: 10, background: "transparent",
    border: "1px solid #253049", color: "#aab9cb", fontSize: 12.5, fontWeight: 700,
    fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
  };

  if (phase === "loading") {
    // A way out if loading the card's photos ever hangs (slow storage after
    // the app was backgrounded) — appears after a few seconds.
    return (
      <div style={{ ...shell, alignItems: "center", justifyContent: "center", color: "#707c9a", fontSize: 12, gap: 18, padding: 24 }}>
        One moment…
        {slowLoad && <button onClick={() => onRelease?.()} style={{ ...quietBtn, width: 200 }}>Skip</button>}
      </div>
    );
  }

  // Send mode, while the photo is being copied (usually under a second).
  if (phase === "sending") {
    return (
      <div style={{ ...shell, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 }}>
        <div style={{ fontSize: 13, color: "#9aadc8" }}>Getting the photo ready for RealWork…</div>
        <button onClick={onRelease} style={{ ...quietBtn, maxWidth: 380, border: "none", color: "#818c9d" }}>Skip RealWork</button>
      </div>
    );
  }

  // ── Open RealWork ───────────────────────────────────────────────────────────
  if (phase === "opening") {
    return (
      <div style={{ ...shell, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ textAlign: "center", marginBottom: 6 }}>
            <div style={{ fontSize: 18, fontWeight: 800, fontFamily: F, letterSpacing: 0.8, textTransform: "uppercase" }}>RealWork</div>
            <div style={{ fontSize: 12.5, color: "#8e9bb7", marginTop: 6, lineHeight: 1.5 }}>
              {mode === "send"
                ? "Saving the first photo to your Photos and opening RealWork. If nothing happened, tap below."
                : "Opening it now. If nothing opened, tap below."}
            </div>
          </div>
          {/* A real link, on purpose: a tap on a link is the one thing iOS will
              always honour, and it is what lets the RealWork app claim the
              address if it has registered for it. */}
          <a href={mode === "send" ? sendShortcutHref() : realworkHref()}
             onClick={() => { if (mode !== "send" && cn) { try { navigator.clipboard?.writeText(String(cn).trim()).catch(() => {}); } catch {} } }}
             {...(mode === "send" || isShortcutReady() ? {} : { target: "_blank", rel: "noopener noreferrer" })}
             style={bigBtn("#7db4ff")}>
            <IconLinkExternal size={16} color="#7db4ff" /> Open RealWork
          </a>
          <button onClick={onRelease} style={quietBtn}>I'm back — continue</button>
          <button onClick={() => setShowSetup(v => !v)} style={{ ...quietBtn, border: "none", color: "#818c9d", textTransform: "none", letterSpacing: 0.2, fontSize: 12 }}>
            {isShortcutReady() ? "RealWork app settings" : "Open the RealWork app instead of the browser…"}
          </button>
          {showSetup && (
            <div style={{ padding: 12, borderRadius: 10, background: "#0e1220", border: "1px solid #1a2540" }}>
              <RealWorkSetup onChange={() => refresh(n => n + 1)} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Choose a photo ──────────────────────────────────────────────────────────
  return (
    <div style={shell}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        padding: "max(14px, var(--safe-top)) 16px 12px", borderBottom: "1px solid #1a2030",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
            Photo for RealWork
          </div>
          <div style={{ fontSize: 11.5, color: "#707c9a", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cn || "This visit"} · tap one, then “Save Image”
          </div>
        </div>
        <button onClick={onRelease} aria-label="Skip RealWork" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, background: "transparent",
          border: "1px solid #253049", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconX size={16} color="#9aadc8" /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px 8px" }}>
        {note && (
          <div style={{
            marginBottom: 12, padding: "10px 12px", borderRadius: 9,
            background: "rgba(26,115,232,.1)", border: "1px solid rgba(26,115,232,.3)",
            color: "#cfe0f5", fontSize: 12.5, lineHeight: 1.45,
          }}>{note}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {photos.map((p, i) => {
            const key = p.id || p.ts || i + 1;
            const busy = busyKey === key;
            return (
              <button key={key} onClick={() => pick(p, i + 1)} disabled={!!busyKey} style={{
                position: "relative", aspectRatio: "1 / 1", padding: 0, borderRadius: 10, overflow: "hidden",
                background: "#141a29", border: "1px solid #253049", cursor: busyKey ? "default" : "pointer",
                opacity: busyKey && !busy ? 0.4 : 1,
              }}>
                <img src={p.thumb && p.thumbMarked ? p.thumb : p.url ? smallThumb(p.url) : (p.originalDataUrl ? p.dataUrl : (p.thumb || p.dataUrl))} alt="" draggable={false}
                     style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                {busy && (
                  <div style={{
                    position: "absolute", inset: 0, background: "rgba(0,0,0,.55)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 11, fontWeight: 800, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
                  }}>Loading…</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{
        flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
        padding: "10px 16px max(16px, env(safe-area-inset-bottom))", borderTop: "1px solid #1a2030",
      }}>
        <button onClick={() => setPhase("opening")} disabled={!!busyKey} style={quietBtn}>
          No photo — just open RealWork
        </button>
        <button onClick={onRelease} disabled={!!busyKey} style={{ ...quietBtn, border: "none", color: "#818c9d" }}>
          Skip RealWork
        </button>
      </div>
    </div>
  );
}
