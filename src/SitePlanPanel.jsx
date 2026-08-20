import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import TileMap from "./TileMap";
import { boundsOf, fitZoom, MAX_Z } from "./tileMath";
import { fetchParcelsForBounds } from "./parcelOverlay";
import { buildCalloutMap } from "./treeMapExport";
import { buildPlanPayload, createPlanLink } from "./planShare";
import { IconDownload, IconMapPin, IconX } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Site Plan panel (inline, on the on-site screen)
   ───────────────────────────────────────────────────────────────────────────
   The live site plan sits right under the photos on the card, so it takes no
   navigation to see: pins with their photos floating beside them, exactly the
   read of the exported plan but pannable. Two actions live here — save the
   JPEG, and get the crew link — rather than being buried behind the parcel map.

   Performance: the map is not mounted until the panel scrolls into view, so
   simply opening a card costs nothing. (Capture is already free: the camera is
   a full-screen early return in OnsiteWindow, so this whole subtree unmounts
   while a photo is being taken.)
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

// Duck-type a Google LatLngBounds so the existing parcel fetcher can be reused
// without a Google map on screen.
const boundsShim = (b) => ({
  getNorthEast: () => ({ lat: () => b.north, lng: () => b.east }),
  getSouthWest: () => ({ lat: () => b.south, lng: () => b.west }),
});

export default function SitePlanPanel({ stop, pins = [], photos = [], token }) {
  const hostRef = useRef(null);
  const [live, setLive] = useState(false);      // mounted once scrolled into view
  const [view, setView] = useState(null);
  const [sel, setSel] = useState(null);
  const [parcel, setParcel] = useState([]);
  const [full, setFull] = useState(false);      // fullscreen, interactive
  const [busy, setBusy] = useState(null);       // "jpeg" | "link" | null
  const [planUrl, setPlanUrl] = useState(null); // JPEG preview
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);

  // Only pins that can actually be drawn.
  const located = useMemo(
    () => pins.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [pins]
  );

  // Pins in the shape TileMap/exports expect, with each pin's photo resolved.
  const viewPins = useMemo(() => located.map((p, i) => {
    const ph = p.photoId ? photos.find(x => (x.id || x.ts) === p.photoId) : null;
    return {
      n: i + 1, lat: p.lat, lng: p.lng, label: p.label,
      photo: ph ? (ph.dataUrl || ph.url) : null,
    };
  }), [located, photos]);

  // Lazy-mount: don't fetch a single map tile until the panel is on screen.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || live) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setLive(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [live]);

  // Frame the whole job once we know the pins.
  useEffect(() => {
    if (!located.length) { setView(null); return; }
    const b = boundsOf(located);
    setView(v => v || {
      center: { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 },
      zoom: Math.min(MAX_Z, Math.max(16, fitZoom(b, 300) - 0.5)),
    });
  }, [located]);

  // Property lines, fetched once. Best-effort: the plan is still useful without.
  useEffect(() => {
    if (!live || !located.length || parcel.length) return;
    let dead = false;
    (async () => {
      try {
        const b = boundsOf(located);
        const pad = 0.0012;
        const res = await fetchParcelsForBounds(boundsShim({
          north: b.north + pad, south: b.south - pad,
          east: b.east + pad, west: b.west - pad,
        }));
        if (dead) return;
        const rings = [];
        for (const f of res.features || []) {
          const g = f.geometry;
          if (g?.type === "Polygon") {
            for (const ring of g.coordinates) rings.push(ring.map(([lng, lat]) => ({ lat, lng })));
          }
        }
        setParcel(rings);
      } catch { /* boundary is a bonus */ }
    })();
    return () => { dead = true; };
  }, [live, located, parcel.length]);

  const parcelForExport = useMemo(() => parcel, [parcel]);

  // ── Save the JPEG ─────────────────────────────────────────────────────────
  const makeJpeg = useCallback(async () => {
    if (busy) return;
    setBusy("jpeg"); setErr(null);
    try {
      const url = await buildCalloutMap({
        pins: located, photos, parcelPaths: parcelForExport,
        meta: {
          client: stop?.cn, address: stop?.addr,
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        },
      });
      if (!url) { setErr("Nothing to plot yet."); return; }
      setPlanUrl(url);
    } catch (e) {
      setErr(e?.message === "map-imagery-unavailable"
        ? "Couldn't load map imagery — check your signal."
        : "Couldn't build the site plan.");
    } finally { setBusy(null); }
  }, [busy, located, photos, parcelForExport, stop]);

  const savePlanImage = useCallback(async () => {
    if (!planUrl) return;
    const name = `${(stop?.cn || "site").replace(/[^\w]+/g, "_")}_site_plan.jpg`;
    try {
      const blob = await (await fetch(planUrl)).blob();
      const file = new File([blob], name, { type: "image/jpeg" });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; } catch { /* dismissed */ }
      }
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(u), 20000);
    } catch { setErr("Couldn't save the image."); }
  }, [planUrl, stop]);

  // ── Crew link ─────────────────────────────────────────────────────────────
  const makeLink = useCallback(async () => {
    if (busy) return;
    const { payload, pendingPhotos } = buildPlanPayload({
      pins: located, photos, parcelPaths: parcelForExport, stop,
    });
    if (!payload.pins.length) { setErr("Add a pin first."); return; }
    if (pendingPhotos > 0 && !window.confirm(
      `${pendingPhotos} photo${pendingPhotos === 1 ? " hasn't" : "s haven't"} finished uploading, so ` +
      `${pendingPhotos === 1 ? "it won't" : "they won't"} show for your crew. Share anyway?`
    )) return;
    setBusy("link"); setErr(null);
    try {
      const url = await createPlanLink(token, payload);
      setLink(url);
      try { await navigator.clipboard?.writeText(url); } catch {}
      if (navigator.share) {
        try {
          await navigator.share({
            title: `Site plan — ${stop?.cn || "job"}`,
            text: `Tree locations for ${stop?.addr || "this job"}. Open on your phone and allow location to see where you are.`,
            url,
          });
        } catch { /* dismissed — link is copied and shown below */ }
      }
    } catch (e) {
      setErr(e?.message || "Couldn't create the link.");
    } finally { setBusy(null); }
  }, [busy, located, photos, parcelForExport, stop, token]);

  if (!located.length) return null;

  const selPin = sel != null ? viewPins[sel] : null;

  return (
    <div
      ref={hostRef}
      // Keep touches here from reaching OnsiteWindow's swipe-to-Pipeline
      // handler — panning the map must not fling the card away.
      onTouchStart={e => e.stopPropagation()}
      onTouchMove={e => e.stopPropagation()}
      onTouchEnd={e => e.stopPropagation()}
      style={{ padding: "12px 16px", borderBottom: "1px solid #1a1f2e" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#4a5a70", letterSpacing: 1, textTransform: "uppercase", fontFamily: F }}>
          Site Plan
        </span>
        <span style={{ fontSize: 10, color: "#3a4a60" }}>
          {located.length} {located.length === 1 ? "pin" : "pins"} · drag pins on the Parcel Map to correct
        </span>
      </div>

      {/* Live plan. Static inline on purpose: a gesture-capturing map sitting in
          a scrolling card is a scroll trap on a phone. Tap to open it full
          screen, where panning and pin taps are enabled. */}
      <div
        onClick={() => live && view && setFull(true)}
        style={{ position: "relative", height: 300, borderRadius: 10, overflow: "hidden", border: "1px solid #1a2540", background: "#101722", cursor: "pointer" }}
      >
        {live && view ? (
          <TileMap
            center={view.center}
            zoom={view.zoom}
            pins={viewPins}
            showPhotos
            parcel={parcel}
            interactive={false}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#4a5a70", fontSize: 12 }}>
            Loading plan…
          </div>
        )}
        {live && view && (
          <div style={{
            position: "absolute", right: 8, bottom: 8, padding: "5px 10px",
            borderRadius: 999, background: "rgba(0,0,0,.7)", color: "#cfe0f5",
            fontSize: 10, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
            textTransform: "uppercase", pointerEvents: "none",
          }}>Tap to open</div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={makeJpeg} disabled={!!busy} style={{
          flex: 1, padding: "10px 0", borderRadius: 8,
          background: "rgba(246,191,38,.12)", border: "1px solid rgba(246,191,38,.35)",
          color: "#F6BF26", fontSize: 11, fontWeight: 800, fontFamily: F,
          letterSpacing: 0.5, textTransform: "uppercase",
          cursor: busy ? "default" : "pointer", opacity: busy === "jpeg" ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <IconDownload size={14} color="#F6BF26" />
          {busy === "jpeg" ? "Building…" : "Save JPEG"}
        </button>
        <button onClick={makeLink} disabled={!!busy} style={{
          flex: 1, padding: "10px 0", borderRadius: 8,
          background: "rgba(26,115,232,.15)", border: "1px solid rgba(26,115,232,.4)",
          color: "#7db4ff", fontSize: 11, fontWeight: 800, fontFamily: F,
          letterSpacing: 0.5, textTransform: "uppercase",
          cursor: busy ? "default" : "pointer", opacity: busy === "link" ? 0.6 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <IconMapPin size={14} color="#7db4ff" />
          {busy === "link" ? "Creating…" : "Crew Link"}
        </button>
      </div>

      {err && <div style={{ marginTop: 6, fontSize: 11, color: "#ff8080" }}>{err}</div>}

      {link && (
        <div style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 8,
          background: "rgba(26,115,232,.1)", border: "1px solid rgba(26,115,232,.3)",
        }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#7db4ff", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 3 }}>
            Link copied — crew can open this on any phone
          </div>
          <div style={{ fontSize: 11, color: "#cfe0f5", wordBreak: "break-all" }}>{link}</div>
        </div>
      )}

      {/* Fullscreen, interactive — pan, zoom and tap pins here. */}
      {full && view && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 400, background: "#0a0b10",
        }}>
          <TileMap
            center={view.center}
            zoom={view.zoom}
            onViewChange={setView}
            pins={viewPins}
            showPhotos
            selectedIndex={sel}
            onPinTap={setSel}
            parcel={parcel}
          />
          <button
            onClick={() => { setSel(null); setFull(false); }}
            aria-label="Close site plan"
            style={{
              position: "absolute", top: "max(12px, env(safe-area-inset-top))",
              right: "max(12px, env(safe-area-inset-right))",
              width: 40, height: 40, borderRadius: 20,
              background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.18)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          ><IconX size={18} color="#fff" /></button>

          {selPin && (
            <div onClick={() => setSel(null)} style={{
              position: "absolute", inset: 0, background: "rgba(0,0,0,.8)",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
            }}>
              <div onClick={e => e.stopPropagation()} style={{ maxWidth: "100%", textAlign: "center" }}>
                {selPin.photo
                  ? <img src={selPin.photo} alt="" style={{ maxWidth: "100%", maxHeight: "62vh", borderRadius: 10, display: "block" }} />
                  : <div style={{ color: "#8aa0c0", fontSize: 13 }}>No photo on this pin.</div>}
                <div style={{ marginTop: 8, fontSize: 13.5, color: "#e6ecf5", fontWeight: 700 }}>
                  {selPin.label || `Location ${selPin.n}`}
                </div>
                <button onClick={() => setSel(null)} style={{
                  marginTop: 10, padding: "8px 18px", borderRadius: 8,
                  background: "rgba(255,255,255,.1)", border: "1px solid #253049",
                  color: "#c8d4e4", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F,
                }}>Close</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* JPEG preview — also keeps Save inside a fresh tap, which iOS requires
          to open the share sheet. */}
      {planUrl && (
        <div onClick={() => setPlanUrl(null)} style={{
          position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,.9)",
          display: "flex", flexDirection: "column",
          padding: "max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom))",
        }}>
          <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 800, color: "#F6BF26", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>Site Plan</div>
              <button onClick={() => setPlanUrl(null)} style={{
                width: 34, height: 34, borderRadius: 17, background: "rgba(28,28,30,.8)",
                border: "1px solid rgba(255,255,255,.16)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}><IconX size={16} color="#fff" /></button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 10, background: "#0d1017" }}>
              <img src={planUrl} alt="Site plan" style={{ width: "100%", display: "block" }} />
            </div>
            <button onClick={savePlanImage} style={{
              marginTop: 12, padding: "13px 0", borderRadius: 10,
              background: "#F6BF26", border: "none", color: "#1a1400",
              fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
              textTransform: "uppercase", cursor: "pointer",
            }}>Save / Share JPEG</button>
          </div>
        </div>
      )}
    </div>
  );
}
