import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import TileMap from "./TileMap";
import { boundsOf, fitZoom, MAX_Z } from "./tileMath";
import { fetchParcelsForBounds } from "./parcelOverlay";
import { buildCalloutMap } from "./treeMapExport";
import { buildPlanPayload, createPlanLink, copyPlanLink } from "./planShare";
import { getCurrentGeo, peekGeo } from "./geoCapture";
import { geocode } from "./RouteMap";
import { IconDownload, IconMapPin, IconX, IconPlus, IconTrash, IconImage } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Site Map
   ───────────────────────────────────────────────────────────────────────────
   ONE place for everything about tree locations. It used to be spread across
   two screens with two different map engines and two different sets of powers
   — the parcel map could edit pins but not export, this panel could export but
   not edit, and the two disagreed about what a pin even looked like. All of it
   lives here now.

   Two rules make it usable in the field:

   1. THERE IS NO EDIT MODE. Pins are always draggable. A drag that starts on a
      pin moves that pin; a drag that starts on open imagery pans the map. The
      gesture itself says which you meant, so there is no mode to enter, and
      none to forget to leave.

   2. ADDING A PIN IS ONE TAP. "+ Pin" drops one at the centre of the view
      immediately — then you drag it onto the tree. Arming a tap-to-place mode
      failed too often, because on a phone the tap that places a pin and the
      drag that pans the map are the same gesture until it's over.

   The panel also renders with ZERO pins, showing the map centred on where you
   are standing. The previous version returned null when there were no pins,
   which meant a card with no pins had no map, and no map meant no way to
   create the first pin.

   Performance: the map isn't mounted until the panel scrolls into view, so
   opening a card costs nothing.
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
  const [full, setFull] = useState(false);      // the Site Map, full screen
  const [showPhotos, setShowPhotos] = useState(true);
  const [busy, setBusy] = useState(null);       // "jpeg" | "link" | null
  const [link, setLink] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  // ── What is actually on the plan ──────────────────────────────────────────
  // A photo switched off on the card is off everywhere: this map, the full
  // screen map, the JPEG and the crew link.
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
      // card. A local dataUrl is the full-size capture, and decoding several of
      // those for 132px thumbnails is real memory on a phone — so it is the
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

  // ── Framing ───────────────────────────────────────────────────────────────
  // Pins first. With none, fall back to where the phone is — you're standing on
  // the property, so that is the right answer and it costs nothing. Only if
  // there's no fix do we spend a geocode on the address.
  const frameKey = located.map(p => p.id).join(",");
  const fullRef = useRef(false);
  useEffect(() => { fullRef.current = full; }, [full]);

  useEffect(() => {
    if (!located.length) return;
    // Never re-frame under the user's hands: adding a pin while the map is open
    // must not yank the view out from under the next drag.
    if (fullRef.current) return;
    const b = boundsOf(located);
    setView({
      center: { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 },
      zoom: Math.min(MAX_Z, Math.max(16, fitZoom(b, 300) - 0.5)),
    });
    // Deliberately keyed on the pin id list, not the pin objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  useEffect(() => {
    if (!live || located.length || view) return;
    let dead = false;
    (async () => {
      const g = peekGeo(120_000) || await getCurrentGeo({ maxAgeMs: 120_000, timeout: 6000 });
      if (dead) return;
      if (g) { setView({ center: { lat: g.lat, lng: g.lng }, zoom: 19 }); return; }
      if (!stop?.addr) return;
      try {
        const ll = await geocode(stop.addr);
        if (!dead && ll) setView({ center: { lat: ll.lat, lng: ll.lng }, zoom: 19 });
      } catch { /* no fix, no geocode — the prompt below explains */ }
    })();
    return () => { dead = true; };
  }, [live, located.length, view, stop?.addr]);

  // Property lines, fetched once. Best-effort: the plan is useful without them.
  useEffect(() => {
    if (!live || !view || parcel.length) return;
    let dead = false;
    (async () => {
      try {
        const b = located.length ? boundsOf(located) : {
          north: view.center.lat, south: view.center.lat,
          east: view.center.lng, west: view.center.lng,
        };
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
  }, [live, view, located, parcel.length]);

  // ── Pin edits ─────────────────────────────────────────────────────────────
  // Edits are expressed against the full pin list, but the map only shows
  // `located` — so map indices are translated back through pin ids.
  const commit = useCallback((next) => { onPinsChange?.(next); }, [onPinsChange]);

  const movePin = useCallback((idx, ll) => {
    const id = viewPins[idx]?.id;
    if (!id) return;
    commit(pins.map(p => p.id === id
      // `adjusted` records that a human placed this point, so a GPS-derived
      // position is never silently trusted over a corrected one.
      ? { ...p, lat: ll.lat, lng: ll.lng, adjusted: true, acc: null }
      : p));
  }, [viewPins, pins, commit]);

  // One tap: a pin appears at the centre of what you're looking at, already
  // selected so the label field is right there. Then drag it onto the tree.
  const addPinHere = useCallback(() => {
    if (!view) return;
    const pin = {
      id: newPinId(), lat: view.center.lat, lng: view.center.lng,
      source: "map", ts: Date.now(), adjusted: true,
    };
    commit([...pins, pin]);
    setNote(null);
  }, [view, pins, commit]);

  const dropPinAtMe = useCallback(async () => {
    setNote("Getting your location…");
    const g = await getCurrentGeo({ maxAgeMs: 15000, timeout: 8000 });
    if (!g) { setNote("Couldn't get a location fix — use + Pin and drag it instead."); return; }
    commit([...pins, {
      id: newPinId(), lat: g.lat, lng: g.lng, acc: g.acc, source: "gps", ts: Date.now(),
    }]);
    setView(v => ({ center: { lat: g.lat, lng: g.lng }, zoom: Math.max(v?.zoom || 19, 19) }));
    setNote(null);
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

  const selPin = sel != null ? viewPins[sel] : null;
  const selRaw = selPin ? pins.find(p => p.id === selPin.id) : null;

  const cardBtn = (tone, on = true) => ({
    flex: 1, padding: "11px 0", borderRadius: 8,
    background: tone === "gold" ? "rgba(246,191,38,.12)" : "rgba(26,115,232,.15)",
    border: `1px solid ${tone === "gold" ? "rgba(246,191,38,.35)" : "rgba(26,115,232,.4)"}`,
    color: tone === "gold" ? "#F6BF26" : "#7db4ff",
    fontSize: 11, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.5, textTransform: "uppercase",
    cursor: busy ? "default" : "pointer", opacity: on ? 1 : 0.45,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  });

  // Bottom-bar button on the full-screen map.
  const barBtn = (active = false, accent = "#F6BF26") => ({
    flex: 1, minWidth: 0, padding: "12px 4px", borderRadius: 12,
    background: active ? accent : "rgba(28,28,30,.92)",
    border: `1px solid ${active ? accent : "rgba(255,255,255,.16)"}`,
    color: active ? "#1a1400" : accent,
    fontSize: 10.5, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.4, textTransform: "uppercase", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
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
          Site Map
        </span>
        <span style={{ fontSize: 10, color: "#3a4a60" }}>
          {located.length
            ? `${located.length} ${located.length === 1 ? "pin" : "pins"} · open to move or add`
            : "no pins yet"}
        </span>
      </div>

      {/* Preview. Static on purpose: a gesture-capturing map inside a scrolling
          card is a scroll trap on a phone. Everything interactive happens in
          the full-screen map below. */}
      <div
        onClick={() => live && view && setFull(true)}
        style={{ position: "relative", height: 330, borderRadius: 10, overflow: "hidden", border: "1px solid #1a2540", background: "#101722", cursor: "pointer" }}
      >
        {live && view ? (
          <TileMap
            center={view.center}
            zoom={view.zoom}
            pins={viewPins}
            showPhotos={showPhotos}
            parcel={parcel}
            interactive={false}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#4a5a70", fontSize: 12, textAlign: "center", padding: 20 }}>
            {live ? "Finding this property…" : "Loading map…"}
          </div>
        )}
      </div>

      {/* One primary action on the card. Everything else is inside. */}
      <button
        onClick={() => live && view && setFull(true)}
        disabled={!live || !view}
        style={{
          width: "100%", marginTop: 8, padding: "13px 0", borderRadius: 10,
          background: "rgba(246,191,38,.95)", border: "none", color: "#1a1400",
          fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
          textTransform: "uppercase", cursor: view ? "pointer" : "default",
          opacity: view ? 1 : 0.45,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
        }}
      >
        <IconMapPin size={15} color="#1a1400" />
        {located.length ? "Open Site Map" : "Open Site Map — add pins"}
      </button>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={makeJpeg} disabled={!!busy || !located.length}
                style={cardBtn("gold", !!located.length)}>
          <IconDownload size={14} color="#F6BF26" />
          {busy === "jpeg" ? "Saving…" : "Save JPEG"}
        </button>
        <button onClick={makeLink} disabled={!!busy || !located.length}
                style={cardBtn("blue", !!located.length)}>
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

      {/* ══ THE SITE MAP ═════════════════════════════════════════════════════
          Pan, zoom, drag pins, add pins, tap a pin to edit it, export, share.
          No modes: what your finger lands on decides what the gesture does. */}
      {full && view && (
        <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "#0a0b10" }}>
          <TileMap
            center={view.center}
            zoom={view.zoom}
            onViewChange={setView}
            pins={viewPins}
            showPhotos={showPhotos}
            selectedIndex={sel}
            onPinTap={setSel}
            // Always on. A pin you can't move is the thing that made this
            // feature useless; there is no state in which that is the right
            // behaviour on this screen.
            editable
            onPinMove={movePin}
            parcel={parcel}
          />

          <button
            onClick={() => { setSel(null); setFull(false); }}
            aria-label="Close site map"
            style={{
              position: "absolute", top: "max(12px, env(safe-area-inset-top))",
              right: "max(12px, env(safe-area-inset-right))",
              width: 44, height: 44, borderRadius: 22,
              background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.18)",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            }}
          ><IconX size={18} color="#fff" /></button>

          <div style={{
            position: "absolute", top: "max(12px, env(safe-area-inset-top))",
            left: "max(12px, env(safe-area-inset-left))",
            padding: "9px 14px", borderRadius: 999,
            background: "rgba(0,0,0,.66)", color: "#cfd8e6",
            fontSize: 11.5, fontWeight: 700, fontFamily: F, letterSpacing: 0.4,
            textTransform: "uppercase", pointerEvents: "none",
          }}>
            {located.length
              ? `${located.length} ${located.length === 1 ? "pin" : "pins"} · drag to move`
              : "Tap + Pin to start"}
          </div>

          {/* Centre crosshair — where "+ Pin" will land. Shown only with the
              sheet closed, so it never argues with what you're reading. */}
          {!selPin && (
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
              <circle cx="50%" cy="50%" r="15" fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="4" />
              <circle cx="50%" cy="50%" r="15" fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.5" strokeDasharray="4,4" />
            </svg>
          )}

          {/* ── One bar, every action ─────────────────────────────────────── */}
          {!selPin && (
            <div style={{
              position: "absolute", left: "max(10px, env(safe-area-inset-left))",
              right: "max(10px, env(safe-area-inset-right))",
              bottom: "max(14px, env(safe-area-inset-bottom))",
              display: "flex", gap: 7,
            }}>
              <button onClick={addPinHere} style={barBtn()}>
                <IconPlus size={17} color="#F6BF26" />+ Pin
              </button>
              <button onClick={dropPinAtMe} style={barBtn(false, "#7db4ff")}>
                <IconMapPin size={17} color="#7db4ff" />At Me
              </button>
              <button onClick={() => setShowPhotos(v => !v)} style={barBtn(showPhotos)}>
                <IconImage size={17} color={showPhotos ? "#1a1400" : "#F6BF26"} />Photos
              </button>
              <button onClick={makeJpeg} disabled={!!busy || !located.length}
                      style={{ ...barBtn(), opacity: located.length ? 1 : 0.4 }}>
                <IconDownload size={17} color="#F6BF26" />
                {busy === "jpeg" ? "…" : "JPEG"}
              </button>
              <button onClick={makeLink} disabled={!!busy || !located.length}
                      style={{ ...barBtn(false, "#7db4ff"), opacity: located.length ? 1 : 0.4 }}>
                <IconMapPin size={17} color="#7db4ff" />
                {busy === "link" ? "…" : "Link"}
              </button>
            </div>
          )}

          {(err || note) && (
            <div style={{
              position: "absolute", left: 0, right: 0,
              bottom: "calc(max(14px, env(safe-area-inset-bottom)) + 74px)",
              display: "flex", justifyContent: "center", pointerEvents: "none",
            }}>
              <div style={{
                padding: "8px 14px", borderRadius: 999, maxWidth: "88%",
                background: "rgba(0,0,0,.8)", color: err ? "#ff9a9a" : "#a8dca0",
                fontSize: 11.5, fontWeight: 600, textAlign: "center",
              }}>{err || note}</div>
            </div>
          )}

          {/* ── Pin sheet: label, photo, delete ───────────────────────────── */}
          {selPin && (
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: "#0e1120", borderTop: "1px solid #253049",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              padding: "14px 16px max(16px, env(safe-area-inset-bottom))",
              boxShadow: "0 -12px 40px rgba(0,0,0,.65)", maxHeight: "72vh", overflowY: "auto",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 15, background: "#F6BF26",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: F, fontWeight: 700, color: "#1a1400", fontSize: 15, flexShrink: 0,
                }}>{selPin.n}</div>
                <div style={{ flex: 1, fontSize: 12, color: "#5a6580" }}>
                  Close this to drag the pin.
                </div>
                <button onClick={() => setSel(null)} aria-label="Close" style={{
                  width: 34, height: 34, borderRadius: 17, background: "transparent",
                  border: "1px solid #253049", cursor: "pointer", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}><IconX size={15} color="#8aa0c0" /></button>
              </div>

              {(selPin.photo || selPin.photoLocal) && (
                <img src={selPin.photo || selPin.photoLocal} alt="" style={{
                  width: "100%", maxHeight: "30vh", objectFit: "contain",
                  borderRadius: 10, background: "#0a0c14", display: "block", marginBottom: 10,
                }} />
              )}

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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
