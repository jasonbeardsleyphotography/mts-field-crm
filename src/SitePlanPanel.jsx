import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import TileMap from "./TileMap";
import { boundsOf, fitZoom, MAX_Z } from "./tileMath";
import { fetchParcelsForBounds } from "./parcelOverlay";
import { buildCalloutMap } from "./treeMapExport";
import { buildPlanPayload, createPlanLink, copyPlanLink } from "./planShare";
import { getCurrentGeo } from "./geoCapture";
import { IconDownload, IconMapPin, IconX, IconPlus, IconTrash, IconImage } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Site Plan panel (inline, on the on-site screen)
   ───────────────────────────────────────────────────────────────────────────
   The site plan lives HERE, on the main on-site screen, not buried behind the
   parcel map. Everything the plan needs is on this one panel:

     • see it            — live map under the photos, tap for full screen
     • fix it            — Edit Pins: drag a pin, tap the map to add one,
                           tap a pin to label / attach a photo / delete
     • send it           — one tap saves the JPEG, one tap copies the crew link
                           (which pastes as the words "Live Map Site Plan")

   What shows on the map is exactly what ships: a photo switched off on the
   card disappears from this map, the full-screen map, the JPEG and the crew
   link together. There is no longer a version of the plan that only the
   export knows about.

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

const photoKey = (ph) => ph.id || ph.ts;
const newPinId = () => `pin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export default function SitePlanPanel({ stop, pins = [], photos = [], token, onPinsChange }) {
  const hostRef = useRef(null);
  const [live, setLive] = useState(false);      // mounted once scrolled into view
  const [view, setView] = useState(null);
  const [sel, setSel] = useState(null);
  const [parcel, setParcel] = useState([]);
  const [full, setFull] = useState(false);      // fullscreen, interactive
  const [edit, setEdit] = useState(false);      // pin editing armed
  const [addMode, setAddMode] = useState(false);
  const [busy, setBusy] = useState(null);       // "jpeg" | "link" | null
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  // ── What is actually on the plan ──────────────────────────────────────────
  // A photo switched off on the card is off everywhere: this map, the full
  // screen map, the JPEG and the crew link. Previously the toggle only reached
  // the export, so the map on screen disagreed with the file it produced.
  const onPlanPhotos = useMemo(() => photos.filter(ph => !ph.planOff), [photos]);
  const onPlanKeys = useMemo(() => new Set(onPlanPhotos.map(photoKey)), [onPlanPhotos]);

  // Pins that can be drawn AND haven't been switched off with their photo.
  const located = useMemo(
    () => pins.filter(p =>
      Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
      (!p.photoId || onPlanKeys.has(p.photoId))
    ),
    [pins, onPlanKeys]
  );

  // Pins in the shape TileMap/exports expect, with each pin's photo resolved.
  const viewPins = useMemo(() => located.map((p, i) => {
    const ph = p.photoId ? photos.find(x => photoKey(x) === p.photoId) : null;
    return {
      n: i + 1, lat: p.lat, lng: p.lng, label: p.label, id: p.id,
      // Prefer the Drive URL: TileMap shrinks it to a w400 rendition for the
      // card. A local dataUrl is the full 3200px capture, and decoding several
      // of those for 132px thumbnails is real memory on a phone — so it is the
      // fallback TileMap uses only if the Drive thumbnail won't load.
      photo: ph?.url || null,
      photoLocal: ph?.dataUrl || null,
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

  // Frame the whole job. This re-frames whenever the SET of pins changes (not
  // on every drag — that would fight the user), so a pin added after the map
  // first drew can't end up outside the view showing empty imagery.
  const frameKey = located.map(p => p.id).join(",");
  const fullRef = useRef(false);
  useEffect(() => { fullRef.current = full; }, [full]);
  useEffect(() => {
    if (!located.length) { setView(null); return; }
    // Never re-frame under the user's hands: adding a pin while the map is
    // open full screen must not yank the view out from under the next drag.
    if (fullRef.current) return;
    const b = boundsOf(located);
    setView({
      center: { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 },
      zoom: Math.min(MAX_Z, Math.max(16, fitZoom(b, 300) - 0.5)),
    });
    // Deliberately keyed on the pin id list, not the pin objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

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

  // ── Editing ───────────────────────────────────────────────────────────────
  // Edits are expressed against the full pin list, but the map only shows
  // `located` — so map indices are translated back through pin ids.
  const commit = useCallback((next) => { onPinsChange?.(next); }, [onPinsChange]);

  const movePin = useCallback((idx, ll) => {
    const id = viewPins[idx]?.id;
    if (!id) return;
    commit(pins.map(p => p.id === id
      ? { ...p, lat: ll.lat, lng: ll.lng, adjusted: true, acc: null }
      : p));
  }, [viewPins, pins, commit]);

  const addPinAt = useCallback((ll) => {
    commit([...pins, {
      id: newPinId(), lat: ll.lat, lng: ll.lng, source: "map", ts: Date.now(), adjusted: true,
    }]);
    setAddMode(false);
    setNote("Pin added — drag it to fine-tune, or tap it to add a photo.");
  }, [pins, commit]);

  const dropPinAtMe = useCallback(async () => {
    setNote("Getting your location…");
    const g = await getCurrentGeo({ maxAgeMs: 15000, timeout: 8000 });
    if (!g) { setNote("Couldn't get a location fix — tap the map instead."); return; }
    commit([...pins, {
      id: newPinId(), lat: g.lat, lng: g.lng, acc: g.acc, source: "gps", ts: Date.now(),
    }]);
    setNote("Pin dropped where you're standing.");
  }, [pins, commit]);

  const patchSel = useCallback((patch) => {
    const id = viewPins[sel]?.id;
    if (!id) return;
    commit(pins.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }, [viewPins, sel, pins, commit]);

  const deleteSel = useCallback(() => {
    const id = viewPins[sel]?.id;
    if (!id) return;
    commit(pins.filter(p => p.id !== id));
    setSel(null);
  }, [viewPins, sel, pins, commit]);

  // ── Save the JPEG (one tap) ───────────────────────────────────────────────
  // Straight to the file, exactly like the per-photo download buttons — no
  // preview to tap through, no second confirmation.
  const makeJpeg = useCallback(async () => {
    if (busy) return;
    setBusy("jpeg"); setErr(null); setNote(null);
    try {
      const url = await buildCalloutMap({
        pins: located, photos: onPlanPhotos, parcelPaths: parcel,
        meta: {
          client: stop?.cn, address: stop?.addr,
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        },
      });
      if (!url) { setErr("Nothing to plot yet."); return; }
      const name = `${(stop?.cn || "site").replace(/[^\w]+/g, "_")}_site_plan.jpg`;
      const blob = await (await fetch(url)).blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(u), 20000);
      setNote("Site plan saved.");
    } catch (e) {
      setErr(e?.message === "map-imagery-unavailable"
        ? "Couldn't load map imagery — check your signal."
        : "Couldn't build the site plan.");
    } finally { setBusy(null); }
  }, [busy, located, onPlanPhotos, parcel, stop]);

  // ── Crew link (one tap) ───────────────────────────────────────────────────
  // Not async: the clipboard write has to be registered inside the tap itself
  // or iOS refuses it, so copyPlanLink takes the still-pending link promise.
  // Anything that could block — a confirm() about unsynced photos — is shown
  // afterwards as a note instead of standing between Jason and the link.
  const makeLink = useCallback(() => {
    if (busy) return;
    const { payload, pendingPhotos } = buildPlanPayload({
      pins: located, photos: onPlanPhotos, parcelPaths: parcel, stop,
    });
    if (!payload.pins.length) { setErr("Add a pin first."); return; }
    setBusy("link"); setErr(null); setNote(null);
    copyPlanLink(createPlanLink(token, payload))
      .then(({ url, copied }) => {
        setLink(url);
        setNote(
          (copied ? "Link copied — paste it to the crew." : "Link ready — copy it below.") +
          (pendingPhotos > 0
            ? ` ${pendingPhotos} photo${pendingPhotos === 1 ? "" : "s"} still uploading, so ${pendingPhotos === 1 ? "it won't" : "they won't"} show yet.`
            : "")
        );
      })
      .catch(e => setErr(e?.message || "Couldn't create the link."))
      .finally(() => setBusy(null));
  }, [busy, located, onPlanPhotos, parcel, stop, token]);

  if (!located.length) return null;

  const selPin = sel != null ? viewPins[sel] : null;
  const selRaw = selPin ? pins.find(p => p.id === selPin.id) : null;

  const actionBtn = (tone) => ({
    flex: 1, padding: "11px 0", borderRadius: 8,
    background: tone === "gold" ? "rgba(246,191,38,.12)" : "rgba(26,115,232,.15)",
    border: `1px solid ${tone === "gold" ? "rgba(246,191,38,.35)" : "rgba(26,115,232,.4)"}`,
    color: tone === "gold" ? "#F6BF26" : "#7db4ff",
    fontSize: 11, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.5, textTransform: "uppercase",
    cursor: busy ? "default" : "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  });

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
          {located.length} {located.length === 1 ? "pin" : "pins"} · tap the map to open and edit
        </span>
      </div>

      {/* Live plan. Static inline on purpose: a gesture-capturing map sitting in
          a scrolling card is a scroll trap on a phone. Tap to open it full
          screen, where panning, pin taps and editing are enabled. */}
      <div
        onClick={() => live && view && setFull(true)}
        style={{ position: "relative", height: 330, borderRadius: 10, overflow: "hidden", border: "1px solid #1a2540", background: "#101722", cursor: "pointer" }}
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

      {/* Actions — one tap each. */}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={makeJpeg} disabled={!!busy}
                style={{ ...actionBtn("gold"), opacity: busy === "jpeg" ? 0.6 : 1 }}>
          <IconDownload size={14} color="#F6BF26" />
          {busy === "jpeg" ? "Saving…" : "Save JPEG"}
        </button>
        <button onClick={makeLink} disabled={!!busy}
                style={{ ...actionBtn("blue"), opacity: busy === "link" ? 0.6 : 1 }}>
          <IconMapPin size={14} color="#7db4ff" />
          {busy === "link" ? "Copying…" : "Copy Crew Link"}
        </button>
      </div>

      {err && <div style={{ marginTop: 6, fontSize: 11, color: "#ff8080" }}>{err}</div>}
      {note && !err && <div style={{ marginTop: 6, fontSize: 11, color: "#8fbf80" }}>{note}</div>}

      {link && (
        <div style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 8,
          background: "rgba(26,115,232,.1)", border: "1px solid rgba(26,115,232,.3)",
        }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: "#7db4ff", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 3 }}>
            Pastes as “Live Map Site Plan”
          </div>
          <div style={{ fontSize: 11, color: "#cfe0f5", wordBreak: "break-all" }}>{link}</div>
        </div>
      )}

      {/* ── Fullscreen: pan, zoom, tap pins, and edit them ─────────────────── */}
      {full && view && (
        <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "#0a0b10" }}>
          <TileMap
            center={view.center}
            zoom={view.zoom}
            onViewChange={setView}
            pins={viewPins}
            // In edit mode the photo cards come off: they're what you're trying
            // to see past while placing a pin.
            showPhotos={!edit}
            selectedIndex={sel}
            onPinTap={setSel}
            editable={edit}
            onPinMove={movePin}
            addMode={edit && addMode}
            onMapTap={addPinAt}
            parcel={parcel}
          />

          <button
            onClick={() => { setSel(null); setEdit(false); setAddMode(false); setFull(false); }}
            aria-label="Close site plan"
            style={{
              position: "absolute", top: "max(12px, env(safe-area-inset-top))",
              right: "max(12px, env(safe-area-inset-right))",
              width: 44, height: 44, borderRadius: 22,
              background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.18)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          ><IconX size={18} color="#fff" /></button>

          {/* Edit toggle */}
          <button
            onClick={() => { setEdit(v => !v); setAddMode(false); setSel(null); }}
            style={{
              position: "absolute", top: "max(12px, env(safe-area-inset-top))",
              left: "max(12px, env(safe-area-inset-left))",
              padding: "11px 16px", borderRadius: 999,
              background: edit ? "rgba(246,191,38,.95)" : "rgba(28,28,30,.85)",
              border: `1px solid ${edit ? "#F6BF26" : "rgba(255,255,255,.18)"}`,
              color: edit ? "#1a1400" : "#fff",
              fontSize: 12, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
              textTransform: "uppercase", cursor: "pointer",
            }}
          >{edit ? "Done" : "Edit Pins"}</button>

          {edit && (
            <>
              <div style={{
                position: "absolute", top: "calc(max(12px, env(safe-area-inset-top)) + 54px)",
                left: "max(12px, env(safe-area-inset-left))", right: "max(12px, env(safe-area-inset-right))",
                padding: "8px 12px", borderRadius: 10, background: "rgba(0,0,0,.72)",
                color: "#cfd8e6", fontSize: 11.5, lineHeight: 1.4, pointerEvents: "none",
              }}>
                {addMode
                  ? "Tap the tree on the map to drop a pin there."
                  : "Drag any pin to move it — it lifts above your finger so you can see it. Tap a pin to label it, add a photo, or delete it."}
              </div>

              <div style={{
                position: "absolute", left: "max(14px, env(safe-area-inset-left))",
                right: "max(14px, env(safe-area-inset-right))",
                bottom: "max(20px, env(safe-area-inset-bottom))",
                display: "flex", gap: 10,
              }}>
                <button onClick={() => setAddMode(v => !v)} style={{
                  flex: 1, padding: "13px 0", borderRadius: 999,
                  background: addMode ? "rgba(246,191,38,.95)" : "rgba(28,28,30,.9)",
                  border: `1px solid ${addMode ? "#F6BF26" : "rgba(255,255,255,.18)"}`,
                  color: addMode ? "#1a1400" : "#F6BF26",
                  fontSize: 12, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
                  textTransform: "uppercase", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                  <IconPlus size={15} color={addMode ? "#1a1400" : "#F6BF26"} />
                  {addMode ? "Tap a tree" : "Add pin"}
                </button>
                <button onClick={dropPinAtMe} style={{
                  flex: 1, padding: "13px 0", borderRadius: 999,
                  background: "rgba(28,28,30,.9)", border: "1px solid rgba(255,255,255,.18)",
                  color: "#7db4ff", fontSize: 12, fontWeight: 800, fontFamily: F,
                  letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}>
                  <IconMapPin size={15} color="#7db4ff" />
                  Pin at me
                </button>
              </div>
            </>
          )}

          {/* Pin sheet — read-only detail, or the editor when Edit Pins is on. */}
          {selPin && (
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: "#0e1120", borderTop: "1px solid #253049",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              padding: "14px 16px max(16px, env(safe-area-inset-bottom))",
              boxShadow: "0 -12px 40px rgba(0,0,0,.65)", maxHeight: "70vh", overflowY: "auto",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 15, background: "#F6BF26",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: F, fontWeight: 700, color: "#1a1400", fontSize: 15, flexShrink: 0,
                }}>{selPin.n}</div>
                <div style={{ flex: 1, fontSize: 14.5, fontWeight: 700, color: "#e6ecf5" }}>
                  {selPin.label || `Location ${selPin.n}`}
                </div>
                <button onClick={() => setSel(null)} aria-label="Close" style={{
                  width: 34, height: 34, borderRadius: 17, background: "transparent",
                  border: "1px solid #253049", color: "#8aa0c0", cursor: "pointer", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}><IconX size={15} color="#8aa0c0" /></button>
              </div>

              {(selPin.photo || selPin.photoLocal) && (
                <img src={selPin.photo || selPin.photoLocal} alt="" style={{
                  width: "100%", maxHeight: "34vh", objectFit: "contain",
                  borderRadius: 10, background: "#0a0c14", display: "block", marginBottom: 10,
                }} />
              )}

              {edit ? (
                <>
                  <input
                    value={selRaw?.label || ""}
                    onChange={e => patchSel({ label: e.target.value })}
                    placeholder="Label (e.g. Big maple, back left)"
                    style={{
                      width: "100%", boxSizing: "border-box", padding: "10px 12px",
                      borderRadius: 8, background: "#141a29", border: "1px solid #253049",
                      color: "#e6ecf5", fontSize: 13.5, marginBottom: 10,
                    }}
                  />
                  {photos.length > 0 && (
                    <>
                      <div style={{ fontSize: 9.5, fontWeight: 800, color: "#4a5a70", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 5, display: "flex", alignItems: "center", gap: 5 }}>
                        <IconImage size={11} color="#4a5a70" /> Photo on this pin
                      </div>
                      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 6, marginBottom: 10 }}>
                        {photos.map((ph) => {
                          const k = photoKey(ph);
                          const on = selRaw?.photoId === k;
                          return (
                            <button key={k} onClick={() => patchSel({ photoId: on ? null : k })} style={{
                              flexShrink: 0, width: 58, height: 58, padding: 0, borderRadius: 8,
                              overflow: "hidden", cursor: "pointer", background: "#141a29",
                              border: on ? "2.5px solid #F6BF26" : "1px solid #253049",
                              opacity: ph.planOff ? 0.35 : 1,
                            }}>
                              <img src={ph.url || ph.dataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  <button onClick={deleteSel} style={{
                    width: "100%", padding: "11px 0", borderRadius: 8,
                    background: "rgba(255,90,90,.12)", border: "1px solid rgba(255,90,90,.35)",
                    color: "#ff8080", fontSize: 12, fontWeight: 800, fontFamily: F,
                    letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}>
                    <IconTrash size={14} color="#ff8080" /> Delete this pin
                  </button>
                </>
              ) : (
                !selPin.photo && !selPin.photoLocal && (
                  <div style={{ fontSize: 12.5, color: "#5a6580", padding: "8px 0" }}>
                    No photo on this pin. Tap Edit Pins to attach one.
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
