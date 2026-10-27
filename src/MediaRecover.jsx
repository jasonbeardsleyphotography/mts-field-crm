import { useState, useMemo, useCallback } from "react";
import { loadPipeline } from "./Pipeline";
import { loadField, updateField } from "./fieldStore";
import { queueFieldDriveSync } from "./driveSync";
import { lastNameOf } from "./photoSync";
import { buildShareUrl } from "./driveUpload";
import { IconX, IconSearch } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Recover photos & videos onto a card
   ───────────────────────────────────────────────────────────────────────────
   Every photo and video this app uploads is a real file in the user's Google
   Drive, named after the client ("Linda Long #32501 10-26-2026 01.jpg",
   "Wood #32449 10/26/2026 - 01.webm") or, for older photos, after the visit's
   id. If a card loses its links to those files — a reinstall that wiped the
   phone's copy before the card's record reached Drive, a sync conflict — the
   files are still there. This finds them by name and re-attaches the ones the
   user ticks. It only ADDS links; it never deletes or changes a file.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

function freshToken(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
  } catch {}
  return fallback;
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const fileIdIn = (u) => (String(u || "").match(/[?&]id=([\w-]+)/) || String(u || "").match(/\/(?:watch|d|file\/d)\/([\w-]+)/) || [])[1] || null;

async function searchDrive(token, terms) {
  const nameQ = terms.map(t => `name contains '${q(t)}'`).join(" or ");
  const query = `(${nameQ}) and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')`;
  const out = [];
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,mimeType,createdTime,thumbnailLink,size)&orderBy=createdTime desc&spaces=drive&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Drive ${r.status}`);
    const d = await r.json();
    out.push(...(d.files || []));
    pageToken = d.nextPageToken || "";
  } while (pageToken && out.length < 600);
  return out;
}

export default function MediaRecover({ token, onClose }) {
  const cards = useMemo(() => {
    const pl = loadPipeline();
    return Object.values(pl).filter(c => c && c.id && c.cn)
      .sort((a, b) => (b.stageChangedAt || b.addedAt || 0) - (a.stageChangedAt || a.addedAt || 0));
  }, []);
  const [filter, setFilter] = useState("");
  const [card, setCard] = useState(null);
  const [files, setFiles] = useState(null);
  const [onCard, setOnCard] = useState(new Set());
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const shown = cards.filter(c => !filter || `${c.cn} ${c.jn || ""} ${c.addr || ""}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);

  const openCard = useCallback(async (c) => {
    setCard(c); setFiles(null); setMsg(null); setPicked(new Set()); setBusy(true);
    try {
      const terms = [lastNameOf(c.cn), c.id].filter(t => t && t.length >= 2);
      if (c.jn) terms.push(`#${c.jn}`);
      const found = await searchDrive(freshToken(token), terms);
      const rec = await loadField(c.id).catch(() => ({})) || {};
      const have = new Set();
      for (const p of [...(rec.scopePhotos || rec.photos || []), ...(rec.addonPhotos || [])]) { const id = fileIdIn(p?.url); if (id) have.add(id); }
      for (const v of (rec.videoUrls || (rec.videoUrl ? [rec.videoUrl] : []))) { const id = fileIdIn(v); if (id) have.add(id); }
      setOnCard(have);
      setFiles(found);
      // Pre-tick what's missing from the card and clearly belongs to it (job # or visit id in the name).
      setPicked(new Set(found.filter(f => !have.has(f.id) && ((c.jn && f.name.includes(`#${c.jn}`)) || f.name.includes(c.id))).map(f => f.id)));
    } catch (e) {
      setMsg(`Couldn't search Drive (${e.message}). Check your signal and try again.`);
    } finally { setBusy(false); }
  }, [token]);

  const attach = useCallback(async () => {
    if (!card || !picked.size) return;
    setBusy(true);
    try {
      const chosen = files.filter(f => picked.has(f.id));
      const photos = chosen.filter(f => f.mimeType.startsWith("image/")).map(f => ({
        id: `rec_${f.id}`, ts: new Date(f.createdTime).getTime() || Date.now(),
        url: `https://drive.google.com/thumbnail?id=${f.id}&sz=w1200`, syncedAt: Date.now(),
      }));
      const vids = chosen.filter(f => f.mimeType.startsWith("video/")).map(f => buildShareUrl(f.id));
      await updateField(card.id, (ex) => {
        const cur = ex.scopePhotos || ex.photos || [];
        const curIds = new Set(cur.map(p => fileIdIn(p?.url)).filter(Boolean));
        const urls = ex.videoUrls || (ex.videoUrl ? [ex.videoUrl] : []);
        return {
          scopePhotos: [...cur, ...photos.filter(p => !curIds.has(fileIdIn(p.url)))].sort((a, b) => (a.ts || 0) - (b.ts || 0)),
          videoUrls: [...urls, ...vids.filter(v => !urls.includes(v))],
        };
      }, { throwOnFail: true });
      const t = freshToken(token);
      if (t) queueFieldDriveSync(t, card.id);
      try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
      setOnCard(prev => new Set([...prev, ...picked]));
      setMsg(`Added ${photos.length} photo${photos.length === 1 ? "" : "s"} and ${vids.length} video${vids.length === 1 ? "" : "s"} to ${card.cn}.`);
      setPicked(new Set());
    } catch (e) {
      setMsg(`Couldn't add them (${e.message}).`);
    } finally { setBusy(false); }
  }, [card, picked, files, token]);

  const btn = (accent) => ({
    padding: "11px 14px", borderRadius: 10, background: `${accent}22`, border: `1px solid ${accent}88`,
    color: accent, fontSize: 12.5, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
    textTransform: "uppercase", cursor: "pointer",
  });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 360, background: "#0a0b10", display: "flex", flexDirection: "column", fontFamily: B, color: "#e6ecf5" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "max(14px, var(--safe-top)) 16px 12px", borderBottom: "1px solid #1a2030", flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
            {card ? card.cn : "Recover photos & videos"}
          </div>
          <div style={{ fontSize: 11.5, color: "#8a9ab0", marginTop: 2 }}>
            {card ? "Files in your Drive matching this client — tick the ones to put back" : "Pick the card that lost its photos or videos"}
          </div>
        </div>
        {card && <button onClick={() => { setCard(null); setFiles(null); setMsg(null); }} style={{ ...btn("#8aa0c0"), padding: "8px 12px" }}>Back</button>}
        <button onClick={onClose} aria-label="Close" style={{ width: 38, height: 38, borderRadius: 19, background: "transparent", border: "1px solid #253049", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><IconX size={16} color="#9aadc8" /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "10px 16px" }}>
        {!card && (<>
          <div style={{ position: "relative", marginBottom: 10 }}>
            <span style={{ position: "absolute", left: 11, top: 11 }}><IconSearch size={15} color="#8aa0c0" /></span>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Client name or job #"
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px 10px 34px", borderRadius: 9, background: "#0e1120", border: "1px solid #1a2540", color: "#e0e8f0", fontSize: 14, outline: "none" }} />
          </div>
          {shown.map(c => (
            <button key={c.id} onClick={() => openCard(c)} style={{ width: "100%", textAlign: "left", padding: "11px 4px", background: "transparent", border: "none", borderBottom: "1px solid #141a28", color: "#e6ecf5", cursor: "pointer" }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{c.cn}{c.jn ? <span style={{ color: "#8a9ab0", fontWeight: 500 }}>  #{c.jn}</span> : null}</div>
              <div style={{ fontSize: 11.5, color: "#8a9ab0", marginTop: 2 }}>{c.addr || ""}</div>
            </button>
          ))}
          {!shown.length && <div style={{ color: "#8a9ab0", fontSize: 13, padding: 20, textAlign: "center" }}>No matching cards.</div>}
        </>)}

        {card && busy && !files && <div style={{ color: "#8a9ab0", fontSize: 13, padding: 24, textAlign: "center" }}>Searching your Drive…</div>}
        {msg && <div style={{ margin: "6px 0 12px", padding: "10px 12px", borderRadius: 9, background: "rgba(16,185,129,.1)", border: "1px solid rgba(16,185,129,.35)", color: "#7ee2b8", fontSize: 13 }}>{msg}</div>}
        {card && files && !files.length && <div style={{ color: "#8a9ab0", fontSize: 13, padding: 20, textAlign: "center", lineHeight: 1.5 }}>No photos or videos for this client were found in your Drive. Anything that never finished uploading before the app was removed isn't there to recover.</div>}
        {card && files && files.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {files.map(f => {
              const already = onCard.has(f.id), on = picked.has(f.id);
              const isVid = f.mimeType.startsWith("video/");
              return (
                <button key={f.id} disabled={already} onClick={() => setPicked(prev => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; })}
                  style={{ padding: 0, borderRadius: 9, overflow: "hidden", border: `2px solid ${on ? "#10B981" : "#1a2540"}`, background: "#0e1120", cursor: already ? "default" : "pointer", opacity: already ? 0.45 : 1, textAlign: "left" }}>
                  <div style={{ aspectRatio: "1", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", color: "#FF8A80", fontSize: 11, fontWeight: 800, fontFamily: F }}>
                    {f.thumbnailLink ? <img src={f.thumbnailLink} alt="" referrerPolicy="no-referrer" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (isVid ? "VIDEO" : "PHOTO")}
                  </div>
                  <div style={{ padding: "4px 5px", fontSize: 9.5, color: already ? "#8a9ab0" : on ? "#7ee2b8" : "#aab9cd", lineHeight: 1.25, wordBreak: "break-word" }}>
                    {already ? "✓ on card · " : on ? "✓ " : ""}{isVid ? "🎥 " : ""}{f.name}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {card && files && files.length > 0 && (
        <div style={{ padding: "10px 16px max(14px, env(safe-area-inset-bottom))", borderTop: "1px solid #1a2030", flexShrink: 0 }}>
          <button disabled={busy || !picked.size} onClick={attach} style={{ ...btn("#10B981"), width: "100%", padding: "14px 0", opacity: busy || !picked.size ? 0.5 : 1 }}>
            {busy ? "Adding…" : `Add ${picked.size} to ${card.cn}`}
          </button>
        </div>
      )}
    </div>
  );
}
