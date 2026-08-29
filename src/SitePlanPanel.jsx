import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import TileMap from "./TileMap";
import { boundsOf, fitZoom, MAX_Z } from "./tileMath";
import { fetchParcelsForBounds, parcelAtPoint, parcelPropsToInfo } from "./parcelOverlay";
import { buildCalloutMap } from "./treeMapExport";
import { buildPlanPayload, createPlanLink, copyPlanLink } from "./planShare";
import { getCurrentGeo, peekGeo } from "./geoCapture";
import { geocode } from "./RouteMap";
import { IconDownload, IconMapPin, IconX, IconPlus, IconTrash, IconImage,
         IconChevronUp, IconChevronDown, IconReorder } from "./icons";

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

export default function SitePlanPanel({ stop, pins = [], photos = [], token, onPinsChange, onAddToCard }) {
  const hostRef = useRef(null);
  const [live, setLive] = useState(false);      // mounted once scrolled into view
  const [view, setView] = useState(null);
  const [sel, setSel] = useState(null);
  const [parcelFeatures, setParcelFeatures] = useState([]);
  const [propInfo, setPropInfo] = useState(null);   // tapped parcel's details
  const [full, setFull] = useState(false);      // the Site Map, full screen
  const [showPhotos, setShowPhotos] = useState(true);
  const [listOpen, setListOpen] = useState(false);   // the pin list sheet
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

  // Boundary rings for drawing, derived from the same features the tap
  // hit-test uses — one fetch, one source of truth.
  const parcel = useMemo(() => {
    const rings = [];
    for (const f of parcelFeatures) {
      const g = f?.geometry;
      const polys = g?.type === "Polygon" ? [g.coordinates]
                  : g?.type === "MultiPolygon" ? g.coordinates : null;
      for (const coords of polys || []) {
        for (const ring of coords) rings.push(ring.map(([lng, lat]) => ({ lat, lng })));
      }
    }
    return rings;
  }, [parcelFeatures]);

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
  // Once the map has been moved by hand, it is the user's view and nothing
  // re-frames it. Now that the map is live inline, dropping a pin would
  // otherwise jump the ground out from under the drag that comes next.
  const movedRef = useRef(false);
  const onViewChange = useCallback((v) => { movedRef.current = true; setView(v); }, []);

  useEffect(() => {
    if (!located.length || movedRef.current) return;
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
    if (!live || !view || parcelFeatures.length) return;
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
        setParcelFeatures(res.features || []);
      } catch { /* boundary is a bonus */ }
    })();
    return () => { dead = true; };
  }, [live, view, located, parcelFeatures.length]);

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

  // Move a pin up or down the list. The numbers on the plan come from list
  // position, so this is how you control which tree is #1 — and on a job with
  // a dozen trees, ordering them the way you'll walk the property is what
  // makes the exported plan readable.
  //
  // The list shows `located`, but order lives on the full `pins` array, so the
  // swap is done by id against the real positions. Swapping the two entries
  // (rather than splicing) keeps any filtered-out pins exactly where they are.
  const reorderPin = useCallback((idx, dir) => {
    const a = viewPins[idx]?.id, b = viewPins[idx + dir]?.id;
    if (!a || !b) return;
    const ia = pins.findIndex(p => p.id === a), ib = pins.findIndex(p => p.id === b);
    if (ia < 0 || ib < 0) return;
    const next = pins.slice();
    next[ia] = pins[ib]; next[ib] = pins[ia];
    commit(next);
  }, [viewPins, pins, commit]);

  // Tap a row: put that pin in the middle of the screen at a working zoom.
  const flyTo = useCallback((idx) => {
    const p = viewPins[idx];
    if (!p) return;
    setView(v => ({ center: { lat: p.lat, lng: p.lng }, zoom: Math.max(v?.zoom || 19, 19.5) }));
    setSel(idx);
    setListOpen(false);
  }, [viewPins]);

  const deletePin = useCallback((idx) => {
    const id = viewPins[idx]?.id;
    if (!id) return;
    commit(pins.filter(p => p.id !== id));
    setSel(cur => (cur === idx ? null : cur));
  }, [viewPins, pins, commit]);

  // A clean tap on open imagery identifies the parcel under it — the whole
  // reason the separate parcel screen existed. Answered locally against the
  // boundaries already on screen, so it costs nothing and works offline once
  // the parcels are loaded.
  const identifyAt = useCallback((ll) => {
    if (!parcelFeatures.length) return;
    const f = parcelAtPoint(parcelFeatures, ll.lat, ll.lng);
    // Tapping off every parcel dismisses the sheet, so the same gesture that
    // opens it closes it.
    setSel(null);
    setPropInfo(f ? parcelPropsToInfo(f.properties) : null);
  }, [parcelFeatures]);

  const patchSel = useCallback((patch) => {
    const id = viewPins[sel]?.id;
    if (!id) return;
    commit(pins.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }, [viewPins, sel, pins, commit]);

  const deleteSel = useCallback(() => { if (sel != null) deletePin(sel); }, [sel, deletePin]);

  // ── The exported plan ─────────────────────────────────────────────────────
  // One builder, two destinations: the phone's files, or the card itself.
  const buildPlan = useCallback(() => buildCalloutMap({
    pins: located, photos: onPlanPhotos, parcelPaths: parcel,
    meta: {
      client: stop?.cn, address: stop?.addr,
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    },
  }), [located, onPlanPhotos, parcel, stop]);

  const planError = (e) => setErr(e?.message === "map-imagery-unavailable"
    ? "Couldn't load map imagery — check your signal."
    : "Couldn't build the site plan.");

  const makeJpeg = useCallback(async () => {
    if (busy) return;
    setBusy("jpeg"); setErr(null); setNote(null);
    try {
      const url = await buildPlan();
      if (!url) { setErr("Nothing to plot yet."); return; }
      const name = `${(stop?.cn || "site").replace(/[^\w]+/g, "_")}_site_plan.jpg`;
      const blob = await (await fetch(url)).blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(u), 20000);
      setNote("Site plan saved.");
    } catch (e) { planError(e); } finally { setBusy(null); }
  }, [busy, buildPlan, stop]);

  // File the plan on this card as a photo, so it travels with the proposal.
  const addPlanToCard = useCallback(async () => {
    if (busy || !onAddToCard) return;
    setBusy("card"); setErr(null); setNote(null);
    try {
      const url = await buildPlan();
      if (!url) { setErr("Nothing to plot yet."); return; }
      await onAddToCard(url);
      setNote("Site plan added to this card's photos.");
    } catch (e) { planError(e); } finally { setBusy(null); }
  }, [busy, buildPlan, onAddToCard]);

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

  // Compact square control used down the right of each pin-list row.
  const rowBtn = (off) => ({
    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
    background: "rgba(255,255,255,.05)", border: "1px solid #253049",
    display: "flex", alignItems: "center", justifyContent: "center",
    cursor: off ? "default" : "pointer", opacity: off ? 0.3 : 1, padding: 0,
  });

  // The action bar's buttons. Same set inline and full screen — only the
  // padding differs, because inline they sit in the card's flow rather than
  // floating over imagery.
  const barBtn = (active = false, accent = "#F6BF26", big = true) => ({
    flex: 1, minWidth: 0, padding: big ? "12px 4px" : "9px 3px", borderRadius: big ? 12 : 9,
    background: active ? accent : "rgba(28,28,30,.92)",
    border: `1px solid ${active ? accent : "rgba(255,255,255,.16)"}`,
    color: active ? "#1a1400" : accent,
    fontSize: big ? 10 : 9, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.3, textTransform: "uppercase", cursor: "pointer",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
  });

  // ── Shared pieces ─────────────────────────────────────────────────────────
  // The map and its controls are identical inline and full screen. Rendering
  // them from one place is the only way they stay that way: the old split had
  // an interactive map in one and a picture of a map in the other, which is
  // how the feature ended up with two personalities.

  const mapChrome = (inFull) => (
    <>
      {/* Centre crosshair — exactly where "+ Pin" will land. */}
      {!selPin && !propInfo && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          <circle cx="50%" cy="50%" r="13" fill="none" stroke="rgba(0,0,0,.45)" strokeWidth="4" />
          <circle cx="50%" cy="50%" r="13" fill="none" stroke="rgba(255,255,255,.7)" strokeWidth="1.4" strokeDasharray="4,4" />
        </svg>
      )}

      {/* Pin count doubles as the way into the list. */}
      <button
        onClick={(e) => { e.stopPropagation(); located.length && setListOpen(true); }}
        style={{
          position: "absolute", top: inFull ? "max(12px, env(safe-area-inset-top))" : 8,
          left: inFull ? "max(12px, env(safe-area-inset-left))" : 8,
          padding: inFull ? "9px 14px" : "6px 10px", borderRadius: 999,
          background: "rgba(0,0,0,.66)", border: "1px solid rgba(255,255,255,.16)",
          color: "#cfd8e6", fontSize: inFull ? 11.5 : 10, fontWeight: 700, fontFamily: F,
          letterSpacing: 0.4, textTransform: "uppercase",
          cursor: located.length ? "pointer" : "default",
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        {located.length ? <IconReorder size={inFull ? 14 : 12} color="#cfd8e6" /> : null}
        {located.length
          ? `${located.length} ${located.length === 1 ? "pin" : "pins"}`
          : "Tap + Pin to start"}
      </button>

      {/* Enlarge / close, top right. */}
      <button
        onClick={(e) => { e.stopPropagation(); setFull(!inFull); }}
        aria-label={inFull ? "Close full screen" : "Enlarge the map"}
        style={{
          position: "absolute", top: inFull ? "max(12px, env(safe-area-inset-top))" : 8,
          right: inFull ? "max(12px, env(safe-area-inset-right))" : 8,
          width: inFull ? 44 : 34, height: inFull ? 44 : 34, borderRadius: 22,
          background: "rgba(0,0,0,.7)", border: "1px solid rgba(255,255,255,.18)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", padding: 0,
        }}
      >
        {inFull
          ? <IconX size={18} color="#fff" />
          : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7.5 7.5M3 21l7.5-7.5" />
            </svg>
          )}
      </button>
    </>
  );

  const actionBar = (inFull) => (
    <div style={inFull ? {
      position: "absolute", left: "max(10px, env(safe-area-inset-left))",
      right: "max(10px, env(safe-area-inset-right))",
      bottom: "max(14px, env(safe-area-inset-bottom))",
      display: "flex", gap: 5,
    } : { display: "flex", gap: 5, marginTop: 8 }}>
      <button onClick={addPinHere} style={barBtn(false, "#F6BF26", inFull)}>
        <IconPlus size={inFull ? 17 : 15} color="#F6BF26" />+ Pin
      </button>
      <button onClick={dropPinAtMe} style={barBtn(false, "#7db4ff", inFull)}>
        <IconMapPin size={inFull ? 17 : 15} color="#7db4ff" />At Me
      </button>
      <button onClick={() => setShowPhotos(v => !v)} style={barBtn(showPhotos, "#F6BF26", inFull)}>
        <IconImage size={inFull ? 17 : 15} color={showPhotos ? "#1a1400" : "#F6BF26"} />Photos
      </button>
      <button onClick={makeJpeg} disabled={!!busy || !located.length}
              style={{ ...barBtn(false, "#F6BF26", inFull), opacity: located.length ? 1 : 0.4 }}>
        <IconDownload size={inFull ? 17 : 15} color="#F6BF26" />
        {busy === "jpeg" ? "…" : "JPEG"}
      </button>
      {onAddToCard && (
        <button onClick={addPlanToCard} disabled={!!busy || !located.length}
                style={{ ...barBtn(false, "#F6BF26", inFull), opacity: located.length ? 1 : 0.4 }}>
          <IconPlus size={inFull ? 17 : 15} color="#F6BF26" />
          {busy === "card" ? "…" : "Card"}
        </button>
      )}
      <button onClick={makeLink} disabled={!!busy || !located.length}
              style={{ ...barBtn(false, "#7db4ff", inFull), opacity: located.length ? 1 : 0.4 }}>
        <IconMapPin size={inFull ? 17 : 15} color="#7db4ff" />
        {busy === "link" ? "…" : "Link"}
      </button>
    </div>
  );

  const theMap = (inFull) => (
    <TileMap
      center={view.center}
      zoom={view.zoom}
      onViewChange={onViewChange}
      pins={viewPins}
      showPhotos={showPhotos}
      selectedIndex={sel}
      onPinTap={setSel}
      // Always draggable, inline as well as full screen. A pin you can't move
      // is the thing that made this feature useless.
      editable
      onPinMove={movePin}
      onMapTap={identifyAt}
      parcel={parcel}
      // Inline, one finger belongs to the page so the card still scrolls —
      // two fingers move the map. Pins stay one-finger draggable either way.
      gestures={inFull ? "full" : "cooperative"}
    />
  );

  return (
    <div
      ref={hostRef}
      // Keep touches here from reaching OnsiteWindow's swipe-to-Pipeline
      // handler — dragging a pin must not fling the card away.
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
          drag pins · two fingers to move the map
        </span>
      </div>

      {/* The live map, right here. Not a preview of one. */}
      <div style={{
        position: "relative", height: 360, borderRadius: 10, overflow: "hidden",
        border: "1px solid #1a2540", background: "#101722",
      }}>
        {live && view ? (
          <>
            {theMap(false)}
            {mapChrome(false)}
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#4a5a70", fontSize: 12, textAlign: "center", padding: 20 }}>
            {live ? "Finding this property…" : "Loading map…"}
          </div>
        )}
      </div>

      {live && view && actionBar(false)}

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

      {/* ══ FULL SCREEN ══════════════════════════════════════════════════════
          The same map with the whole screen to work in — past whatever the
          card's layout allows — for reading the property and placing pins
          precisely. One finger pans here, since there is no page to scroll. */}
      {full && view && (
        <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "#0a0b10" }}>
          {theMap(true)}
          {mapChrome(true)}
          {parcel.length > 0 && !selPin && !propInfo && !listOpen && (
            <div style={{
              position: "absolute", top: "calc(max(12px, env(safe-area-inset-top)) + 46px)",
              left: "max(12px, env(safe-area-inset-left))",
              fontSize: 10.5, color: "#9fb0c6", pointerEvents: "none",
              textShadow: "0 1px 4px rgba(0,0,0,.9)",
            }}>Tap the ground for property info</div>
          )}
          {!selPin && !propInfo && actionBar(true)}
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
        </div>
      )}

      {/* ══ SHEETS ═══════════════════════════════════════════════════════════
          Fixed to the viewport and rendered once, so they work over the inline
          map and the full-screen one without a second copy of each. */}

      {/* Property info for a tapped parcel. */}
      {propInfo && (
        <div style={{ ...sheetWrap, zIndex: 460 }}>
          <div onClick={() => setPropInfo(null)} style={scrim} />
          <div style={sheet}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {propInfo.owner}
                </div>
                {propInfo.parcelAddr && (
                  <div style={{ fontSize: 12.5, color: "#8aa0c0", marginTop: 2 }}>{propInfo.parcelAddr}</div>
                )}
              </div>
              <button onClick={() => setPropInfo(null)} aria-label="Close" style={closeBtn}>
                <IconX size={15} color="#8aa0c0" />
              </button>
            </div>
            {[
              ["Acres", propInfo.acres != null ? Number(propInfo.acres).toFixed(2) : null],
              ["Assessed", propInfo.assessedValue != null ? `$${Number(propInfo.assessedValue).toLocaleString()}` : null],
              ["SBL", propInfo.sbl],
              ["Class", propInfo.propClass],
              ["Municipality", [propInfo.muni, propInfo.county].filter(Boolean).join(", ") || null],
              ["Owner mailing", propInfo.mailAddr],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 10, padding: "6px 0", borderTop: "1px solid #161c2b" }}>
                <span style={{ width: 118, flexShrink: 0, fontSize: 10, fontWeight: 800, color: "#4a5a70", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", paddingTop: 2 }}>{k}</span>
                <span style={{ flex: 1, fontSize: 13, color: "#e6ecf5" }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pin list — plan order. Tap a row to fly to it; arrows set the order
          the pins are numbered in on the exported plan and the crew link. */}
      {listOpen && (
        <div style={{ ...sheetWrap, zIndex: 460 }}>
          <div onClick={() => setListOpen(false)} style={scrim} />
          <div style={{ ...sheet, padding: "14px 12px max(16px, env(safe-area-inset-bottom))" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "0 4px" }}>
              <div style={{ flex: 1, fontSize: 11, fontWeight: 800, color: "#4a5a70", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
                Pins · plan order
              </div>
              <button onClick={() => setListOpen(false)} aria-label="Close list" style={closeBtn}>
                <IconX size={15} color="#8aa0c0" />
              </button>
            </div>
            {viewPins.map((p, i) => (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 9,
                padding: "7px 4px", borderTop: i ? "1px solid #161c2b" : "none",
              }}>
                <button onClick={() => flyTo(i)} style={{
                  flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10,
                  background: "transparent", border: "none", padding: 0,
                  cursor: "pointer", textAlign: "left",
                }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: 12, background: "#F6BF26",
                    color: "#1a1400", fontFamily: F, fontWeight: 700, fontSize: 12,
                    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}>{p.n}</span>
                  <span style={{
                    width: 40, height: 40, borderRadius: 7, flexShrink: 0,
                    background: "#141a29", overflow: "hidden",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {(p.photo || p.photoLocal)
                      ? <img src={p.photo || p.photoLocal} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <IconMapPin size={16} color="#3a4a60" />}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, color: "#e6ecf5", fontWeight: 600,
                    overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                  }}>{p.label || `Location ${p.n}`}</span>
                </button>
                <button onClick={() => reorderPin(i, -1)} disabled={i === 0}
                        aria-label="Move up" style={rowBtn(i === 0)}>
                  <IconChevronUp size={15} color="#8aa0c0" />
                </button>
                <button onClick={() => reorderPin(i, 1)} disabled={i === viewPins.length - 1}
                        aria-label="Move down" style={rowBtn(i === viewPins.length - 1)}>
                  <IconChevronDown size={15} color="#8aa0c0" />
                </button>
                <button onClick={() => deletePin(i)} aria-label="Delete pin" style={rowBtn(false)}>
                  <IconTrash size={14} color="#ff8080" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* One tapped pin: label, photo, delete. */}
      {selPin && (
        <div style={{ ...sheetWrap, zIndex: 460 }}>
          <div onClick={() => setSel(null)} style={scrim} />
          <div style={sheet}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ flex: 1, fontSize: 12, color: "#5a6580" }}>
                Close this to drag the pin.
              </div>
              <button onClick={() => setSel(null)} aria-label="Close" style={closeBtn}>
                <IconX size={15} color="#8aa0c0" />
              </button>
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
        </div>
      )}
    </div>
  );
}

const sheetWrap = {
  position: "fixed", inset: 0,
  display: "flex", flexDirection: "column", justifyContent: "flex-end",
};
const scrim = { position: "absolute", inset: 0, background: "rgba(0,0,0,.55)" };
const sheet = {
  position: "relative",
  background: "#0e1120", borderTop: "1px solid #253049",
  borderTopLeftRadius: 16, borderTopRightRadius: 16,
  padding: "14px 16px max(16px, env(safe-area-inset-bottom))",
  boxShadow: "0 -12px 40px rgba(0,0,0,.65)",
  maxHeight: "76vh", overflowY: "auto",
};
const closeBtn = {
  width: 34, height: 34, borderRadius: 17, background: "transparent",
  border: "1px solid #253049", cursor: "pointer", flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
};
