import { useState, useRef, useEffect, useCallback } from "react";
import { loadMaps, geocode } from "./RouteMap";
import { attachParcelOverlay, detachParcelOverlay, parcelFeatureToInfo } from "./parcelOverlay";
import { IconX, IconCamera, IconMapPin, IconTrash, IconPlus } from "./icons";
import { getCurrentGeo } from "./geoCapture";
import { buildCalloutMap } from "./treeMapExport";

/* Build a small rounded "photo window" marker icon from a full-size photo.
   Photos are 3200px — using one directly as a marker icon would pin a huge
   bitmap in memory per pin, so each is drawn down to a ~56px framed tile. */
function makePhotoIcon(dataUrl, size = 56) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const pad = 3, r = 9, w = size + pad * 2, h = size + pad * 2 + 6;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const x = c.getContext("2d");
        // Pointer stem below the tile
        x.beginPath();
        x.moveTo(w / 2 - 5, h - 7); x.lineTo(w / 2, h); x.lineTo(w / 2 + 5, h - 7);
        x.closePath();
        x.fillStyle = "#fff"; x.fill();
        // Rounded white frame
        x.beginPath();
        x.moveTo(pad + r, pad);
        x.arcTo(w - pad, pad, w - pad, h - pad - 6, r);
        x.arcTo(w - pad, h - pad - 6, pad, h - pad - 6, r);
        x.arcTo(pad, h - pad - 6, pad, pad, r);
        x.arcTo(pad, pad, w - pad, pad, r);
        x.closePath();
        x.fillStyle = "#fff"; x.fill();
        x.save(); x.clip();
        // Cover-fit the photo into the tile
        const s = Math.max(size / img.width, size / img.height);
        const dw = img.width * s, dh = img.height * s;
        x.drawImage(img, pad + (size - dw) / 2, pad + (size - dh) / 2, dw, dh);
        x.restore();
        resolve({ url: c.toDataURL("image/jpeg", 0.8), w, h });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* Plain numbered pin for points with no photo attached. Drawn as SVG so it
   stays crisp and costs nothing to generate. */
function makeDotIcon(n, color = "#F6BF26") {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">` +
    `<path d="M17 43C17 43 32 26.5 32 16A15 15 0 1 0 2 16C2 26.5 17 43 17 43Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>` +
    `<text x="17" y="21" font-family="Oswald,sans-serif" font-size="15" font-weight="700" fill="#1a1400" text-anchor="middle">${n}</text>` +
    `</svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Parcel Map View
   Full-screen satellite map + tax-parcel boundary overlay for a single stop,
   reached from OnsiteWindow. Tap a parcel to see read-only owner/tax info in
   a bottom sheet. "Snapshot" captures the current view (including whatever
   parcel lines are drawn) and hands the image back to the caller, which
   stores it the same way a camera photo is stored.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function ParcelMapView({
  stop, onClose, onSnapshot,
  pins = [],            // [{ id, lat, lng, source, photoId, label, acc, ts, adjusted }]
  photos = [],          // all photos on this card, for thumbnails + previews
  onPinsChange,         // (nextPins) => void
}) {
  const ref = useRef(null);
  const map = useRef(null);
  const parcelHandle = useRef(null);
  const pinMarkers = useRef([]);        // live google.maps.Marker instances
  const thumbCache = useRef(new Map()); // photoId -> {url,w,h}, so re-renders are cheap
  const pinsRef = useRef(pins);         // current pins for use inside map listeners
  const [addMode, setAddMode] = useState(false); // tap-map-to-drop armed
  const [openPin, setOpenPin] = useState(null);  // pin shown in the detail sheet
  const addModeRef = useRef(false);              // read inside map listeners
  useEffect(() => { pinsRef.current = pins; }, [pins]);
  useEffect(() => { addModeRef.current = addMode; }, [addMode]);
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState(null); // parcel info shown in bottom sheet
  const [snapping, setSnapping] = useState(false);
  const [snapError, setSnapError] = useState(null);
  const [parcelStatus, setParcelStatus] = useState(null); // overlay fetch state
  const [imagery, setImagery] = useState("google"); // "google" (hybrid) | "esri" (aerial)

  // Live "blue dot" current-location marker + accuracy circle + geolocation watch.
  const locMarker = useRef(null);
  const locCircle = useRef(null);
  const watchId   = useRef(null);
  const [hasFix, setHasFix] = useState(false);
  const [mapReady, setMapReady] = useState(false); // true once map.current exists
  const [exporting, setExporting] = useState(false);
  const [planUrl, setPlanUrl] = useState(null);     // built site plan, shown for review

  useEffect(() => { loadMaps().then(() => setReady(true)).catch(() => {}); }, []);

  // Draw / move the blue dot for a geolocation fix.
  const updateLocation = useCallback((pos) => {
    const g = window.google?.maps;
    if (!g || !map.current) return;
    const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const accuracy = pos.coords.accuracy || 30;
    if (!locMarker.current) {
      locMarker.current = new g.Marker({
        map: map.current, position: ll, zIndex: 9999, clickable: false,
        icon: { path: g.SymbolPath.CIRCLE, scale: 7, fillColor: "#1a73e8",
          fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3 },
      });
      locCircle.current = new g.Circle({
        map: map.current, center: ll, radius: accuracy, clickable: false,
        fillColor: "#1a73e8", fillOpacity: 0.12,
        strokeColor: "#1a73e8", strokeOpacity: 0.25, strokeWeight: 1,
      });
    } else {
      locMarker.current.setPosition(ll);
      locCircle.current.setCenter(ll);
      locCircle.current.setRadius(accuracy);
    }
    setHasFix(true);
  }, []);

  // Recenter the map on the user's current location (one-shot if no fix yet).
  const goToMyLocation = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    const recenter = (ll) => {
      if (!map.current) return;
      map.current.panTo(ll);
      if (map.current.getZoom() < 17) map.current.setZoom(18);
    };
    if (locMarker.current) {
      recenter(locMarker.current.getPosition());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => { updateLocation(pos); recenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      (err) => console.warn("[ParcelMapView] location error:", err?.message || err),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, [updateLocation]);

  // ── PIN MUTATIONS ────────────────────────────────────────────────────────
  const commitPins = useCallback((next) => { onPinsChange?.(next); }, [onPinsChange]);

  const addPin = useCallback((p) => {
    const pin = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(), ...p,
    };
    commitPins([...(pinsRef.current || []), pin]);
    return pin;
  }, [commitPins]);

  const addPinRef = useRef(addPin);
  useEffect(() => { addPinRef.current = addPin; }, [addPin]);

  const movePin = useCallback((id, lat, lng) => {
    // `adjusted` records that a human placed this point, so a GPS-derived
    // position is never silently trusted over a corrected one.
    commitPins((pinsRef.current || []).map(p =>
      p.id === id ? { ...p, lat, lng, adjusted: true } : p));
  }, [commitPins]);

  const deletePin = useCallback((id) => {
    commitPins((pinsRef.current || []).filter(p => p.id !== id));
    setOpenPin(null);
  }, [commitPins]);

  const labelPin = useCallback((id, label) => {
    commitPins((pinsRef.current || []).map(p => p.id === id ? { ...p, label } : p));
    setOpenPin(prev => prev && prev.id === id ? { ...prev, label } : prev);
  }, [commitPins]);

  // Drop a pin at the phone's current position. Uses the warm fix when we have
  // one so this is instant; falls back to a one-shot lock otherwise.
  const [dropping, setDropping] = useState(false);
  const dropPinAtMe = useCallback(async () => {
    setDropping(true);
    try {
      const g = await getCurrentGeo();
      if (!g) { setSnapError("Couldn't get your location — try again in a moment."); return; }
      addPin({ lat: g.lat, lng: g.lng, acc: g.acc, source: "gps" });
      if (map.current) { map.current.panTo({ lat: g.lat, lng: g.lng }); if (map.current.getZoom() < 19) map.current.setZoom(19); }
    } finally { setDropping(false); }
  }, [addPin]);

  // ── RENDER PINS AS MARKERS ───────────────────────────────────────────────
  // Rebuilt whenever the pin list changes. Thumbnails are cached by photo id so
  // a drag or a label edit doesn't re-decode any images.
  useEffect(() => {
    const g = window.google?.maps;
    if (!g || !map.current) return;
    let dead = false;
    (async () => {
      // Pre-build any thumbnails we don't have yet, one at a time (never all
      // full-size photos in memory at once).
      for (const p of pins) {
        if (!p.photoId || thumbCache.current.has(p.photoId)) continue;
        const photo = photos.find(ph => (ph.id || ph.ts) === p.photoId);
        const src = photo?.dataUrl || photo?.url;
        if (!src) continue;
        const icon = await makePhotoIcon(src);
        if (dead) return;
        if (icon) thumbCache.current.set(p.photoId, icon);
      }
      if (dead) return;
      pinMarkers.current.forEach(m => m.setMap(null));
      pinMarkers.current = pins.map((p, i) => {
        const thumb = p.photoId ? thumbCache.current.get(p.photoId) : null;
        const icon = thumb
          ? { url: thumb.url, scaledSize: new g.Size(thumb.w, thumb.h), anchor: new g.Point(thumb.w / 2, thumb.h) }
          : { url: makeDotIcon(i + 1, p.source === "gps" ? "#4c9aff" : "#F6BF26"),
              scaledSize: new g.Size(34, 44), anchor: new g.Point(17, 44) };
        const marker = new g.Marker({
          map: map.current, position: { lat: p.lat, lng: p.lng },
          draggable: true, icon, zIndex: 500 + i,
          title: p.label || (p.photoId ? "Photo location" : `Pin ${i + 1}`),
        });
        marker.addListener("dragend", (e) => movePin(p.id, e.latLng.lat(), e.latLng.lng()));
        marker.addListener("click", () => setOpenPin(p));
        return marker;
      });
    })();
    return () => { dead = true; };
  }, [pins, photos, movePin, mapReady]);

  // Clear markers on unmount so nothing is left attached to a dead map.
  useEffect(() => () => { pinMarkers.current.forEach(m => m.setMap(null)); pinMarkers.current = []; }, []);

  // Pull the drawn parcel boundary out of the map's data layer so the exported
  // plan carries the property lines, not just the pins.
  const getParcelPaths = useCallback(() => {
    const out = [];
    try {
      map.current?.data?.forEach((feature) => {
        const geo = feature.getGeometry?.();
        if (!geo) return;
        const pushPoly = (poly) => poly.getArray().forEach(ring =>
          out.push(ring.getArray().map(ll => ({ lat: ll.lat(), lng: ll.lng() }))));
        const t = geo.getType?.();
        if (t === "Polygon") pushPoly(geo);
        else if (t === "MultiPolygon") geo.getArray().forEach(pushPoly);
      });
    } catch { /* boundary is a bonus — never block the export on it */ }
    return out;
  }, []);

  // Build the callout site plan. Shown for review first rather than saved
  // straight away: the build takes a few seconds, and iOS only allows sharing
  // from a fresh tap — so the Save button in the preview is the gesture.
  const exportPlan = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setSnapError(null);
    try {
      const url = await buildCalloutMap({
        pins, photos, parcelPaths: getParcelPaths(),
        meta: {
          client: stop?.cn, address: stop?.addr,
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        },
      });
      if (!url) { setSnapError("Add at least one pin first."); return; }
      setPlanUrl(url);
    } catch (e) {
      console.warn("Site plan export failed:", e);
      setSnapError(e?.message === "map-imagery-unavailable"
        ? "Couldn't load map imagery - check your signal and try again."
        : "Couldn't build the site plan - try again.");
    } finally { setExporting(false); }
  }, [exporting, pins, photos, getParcelPaths, stop?.cn, stop?.addr]);

  const savePlan = useCallback(async () => {
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
    } catch { setSnapError("Couldn't save the plan."); }
  }, [planUrl, stop?.cn]);

  // Flip the base imagery between Google (hybrid, with labels) and Esri aerial.
  const toggleImagery = useCallback(() => {
    if (!map.current) return;
    setImagery(prev => {
      const next = prev === "google" ? "esri" : "google";
      map.current.setMapTypeId(next === "esri" ? "esri" : "hybrid");
      return next;
    });
  }, []);

  // Create map, centered on the stop's geocoded address, with overlay attached.
  useEffect(() => {
    if (!ready || !ref.current || map.current) return;
    let dead = false;
    (async () => {
      const center = await geocode(stop?.addr) || { lat: 43.12, lng: -77.50 };
      if (dead || !ref.current) return;
      map.current = new window.google.maps.Map(ref.current, {
        center, zoom: 18,
        mapTypeId: "hybrid",
        disableDefaultUI: true, gestureHandling: "greedy", backgroundColor: "#10131a",
        zoomControl: false, mapTypeControl: false, streetViewControl: false,
        fullscreenControl: false, keyboardShortcuts: false, clickableIcons: false,
      });
      // Register Esri World Imagery as an alternate base (free, no key, often a
      // different/newer capture than Google's). Toggled via the imagery button.
      const esri = new window.google.maps.ImageMapType({
        name: "Aerial",
        maxZoom: 21,
        tileSize: new window.google.maps.Size(256, 256),
        getTileUrl: (c, z) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${c.y}/${c.x}`,
      });
      map.current.mapTypes.set("esri", esri);
      setMapReady(true);
      // Wait for the map's first idle event before attaching — right after
      // construction, map.getBounds() can still return null, which would
      // make the overlay's first refresh() silently no-op.
      const onceIdle = map.current.addListener("idle", () => {
        onceIdle.remove();
        if (dead) return;
        parcelHandle.current = attachParcelOverlay(map.current, {
          // While arming a pin, a tap means "put it here" — don't also pop the
          // parcel info sheet over the spot the user just aimed at.
          onParcelClick: (feature) => { if (!addModeRef.current) setInfo(parcelFeatureToInfo(feature)); },
          onStatus: (s) => setParcelStatus(s),
        });
        // Tap-to-place. One-shot: arming, tapping, then disarming prevents a
        // stray tap while panning from scattering pins across the property.
        map.current.addListener("click", (e) => {
          if (!addModeRef.current || !e?.latLng) return;
          addPinRef.current({ lat: e.latLng.lat(), lng: e.latLng.lng(), source: "map" });
          setAddMode(false);
        });
      });
      // Start tracking the user's location (blue dot). watchPosition keeps it
      // live as they move; the button below recenters on it.
      if ("geolocation" in navigator) {
        watchId.current = navigator.geolocation.watchPosition(
          updateLocation,
          (err) => console.warn("[ParcelMapView] location error:", err?.message || err),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
      }
    })();
    return () => {
      dead = true;
      if (parcelHandle.current) { detachParcelOverlay(parcelHandle.current); parcelHandle.current = null; }
      if (watchId.current != null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
      locMarker.current?.setMap(null); locMarker.current = null;
      locCircle.current?.setMap(null); locCircle.current = null;
    };
  }, [ready, stop?.addr, updateLocation]);

  const dismissInfo = () => setInfo(null);

  const takeSnapshot = async () => {
    if (!ref.current || snapping) return;
    setSnapping(true);
    setSnapError(null);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(ref.current, { useCORS: true, logging: false });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      await onSnapshot(dataUrl);
    } catch (e) {
      console.warn("Parcel map snapshot failed:", e);
      setSnapError("Snapshot failed — try again.");
    } finally {
      // Always re-enable the button — previously the success path never reset
      // `snapping`, so if onSnapshot kept this view mounted the button stayed
      // stuck on "Saving…" forever.
      setSnapping(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 300, overflow: "hidden" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }}>
        {!ready && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#5a6580", fontSize: 13, fontFamily: F }}>
            Loading map...
          </div>
        )}
      </div>

      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        padding: "max(12px, env(safe-area-inset-top)) 14px 12px",
        background: "linear-gradient(to bottom, rgba(0,0,0,.7) 0%, transparent 100%)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: F, textTransform: "uppercase", letterSpacing: 1, textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
          {stop?.addr || "Parcel Map"}
        </div>
        <button onClick={onClose} aria-label="Close parcel map" style={{
          width: 36, height: 36, borderRadius: 18,
          background: "rgba(28,28,30,.72)", border: "1px solid rgba(255,255,255,.14)",
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
        }}>
          <IconX size={18} color="#fff" />
        </button>
      </div>

      {/* ── PARCEL STATUS PILL ──────────────────────────────────────────── */}
      {/* Only shown when there's something the user should know — zoom in,
          no data here, or a load failure. Stays out of the way on success. */}
      {ready && parcelStatus && (parcelStatus.state === "zoom" || parcelStatus.state === "empty" || parcelStatus.state === "error") && (
        <div style={{
          position: "absolute",
          top: "max(56px, calc(env(safe-area-inset-top) + 44px))",
          left: "50%", transform: "translateX(-50%)",
          padding: "7px 14px", borderRadius: 14, maxWidth: "90%",
          background: parcelStatus.state === "error" ? "rgba(239,68,68,.92)" : "rgba(28,28,30,.86)",
          border: "1px solid rgba(255,255,255,.14)",
          color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: F,
          textAlign: "center", whiteSpace: "nowrap",
          boxShadow: "0 2px 10px rgba(0,0,0,.4)",
        }}>
          {parcelStatus.state === "zoom"  && "Zoom in to see parcels"}
          {parcelStatus.state === "empty" && "No parcel data for this area"}
          {parcelStatus.state === "error" && "Couldn't load parcels"}
        </div>
      )}

      {/* ── IMAGERY TOGGLE ──────────────────────────────────────────────── */}
      <button
        onClick={toggleImagery}
        aria-label="Switch satellite imagery source"
        style={{
          position: "absolute",
          right: "max(14px, env(safe-area-inset-right))",
          bottom: "max(148px, calc(env(safe-area-inset-bottom) + 132px))",
          display: "flex", alignItems: "center", gap: 5,
          padding: "8px 11px", borderRadius: 999,
          background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.16)",
          color: "#fff", fontSize: 11, fontWeight: 700, fontFamily: F, letterSpacing: 0.5,
          cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8.5 12 15 2 8.5 12 2" />
          <polyline points="2 15.5 12 22 22 15.5" />
        </svg>
        {imagery === "google" ? "Google" : "Aerial"}
      </button>

      {/* ── MY LOCATION BUTTON ──────────────────────────────────────────── */}
      <button
        onClick={goToMyLocation}
        aria-label="Center on my location"
        style={{
          position: "absolute",
          right: "max(14px, env(safe-area-inset-right))",
          bottom: "max(92px, calc(env(safe-area-inset-bottom) + 76px))",
          width: 46, height: 46, borderRadius: 23,
          background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.16)",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.4)", padding: 0,
        }}
      >
        {/* crosshair / locate icon, blue once we have a fix */}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
             stroke={hasFix ? "#4c9aff" : "#fff"} strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" fill={hasFix ? "#4c9aff" : "none"} stroke="none" />
          <circle cx="12" cy="12" r="7" />
          <line x1="12" y1="1.5" x2="12" y2="4.5" />
          <line x1="12" y1="19.5" x2="12" y2="22.5" />
          <line x1="1.5" y1="12" x2="4.5" y2="12" />
          <line x1="19.5" y1="12" x2="22.5" y2="12" />
        </svg>
      </button>

      {/* ── PIN CONTROLS (left side: capture) ───────────────────────────── */}
      {/* Tap-to-place. Arming first means a stray tap while panning can't
          scatter pins across the property. */}
      <button
        onClick={() => { setAddMode(v => !v); setInfo(null); }}
        aria-label="Add a pin by tapping the map"
        style={{
          position: "absolute",
          left: "max(14px, env(safe-area-inset-left))",
          bottom: "max(148px, calc(env(safe-area-inset-bottom) + 132px))",
          display: "flex", alignItems: "center", gap: 6,
          padding: "9px 13px", borderRadius: 999,
          background: addMode ? "rgba(246,191,38,.95)" : "rgba(28,28,30,.85)",
          border: `1px solid ${addMode ? "#F6BF26" : "rgba(255,255,255,.16)"}`,
          color: addMode ? "#1a1400" : "#fff",
          fontSize: 12, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
          cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        }}
      >
        <IconPlus size={15} color={addMode ? "#1a1400" : "#F6BF26"} />
        {addMode ? "TAP A TREE" : "ADD PIN"}
      </button>

      {/* Drop at the phone's current position — for when you're standing at
          the trunk and the canopy isn't identifiable from above. */}
      <button
        onClick={dropPinAtMe}
        disabled={dropping}
        aria-label="Drop a pin at my current location"
        style={{
          position: "absolute",
          left: "max(14px, env(safe-area-inset-left))",
          bottom: "max(92px, calc(env(safe-area-inset-bottom) + 76px))",
          display: "flex", alignItems: "center", gap: 6,
          padding: "9px 13px", borderRadius: 999,
          background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.16)",
          color: "#fff", fontSize: 12, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
          cursor: dropping ? "default" : "pointer", opacity: dropping ? 0.6 : 1,
          boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        }}
      >
        <IconMapPin size={15} color="#4c9aff" />
        {dropping ? "LOCATING…" : "PIN AT ME"}
      </button>

      {/* Arming hint + accuracy honesty. Under canopy a GPS fix is often 10m+,
          which matters when the points represent individual trees. */}
      {(addMode || pins.length > 0) && (
        <div style={{
          position: "absolute",
          top: "max(56px, calc(env(safe-area-inset-top) + 44px))",
          left: "50%", transform: "translateX(-50%)",
          padding: "7px 14px", borderRadius: 999, whiteSpace: "nowrap",
          background: addMode ? "rgba(246,191,38,.95)" : "rgba(28,28,30,.82)",
          border: `1px solid ${addMode ? "#F6BF26" : "rgba(255,255,255,.14)"}`,
          color: addMode ? "#1a1400" : "#cfd8e6",
          fontSize: 11.5, fontWeight: 700, fontFamily: F, letterSpacing: 0.4,
          boxShadow: "0 4px 16px rgba(0,0,0,.4)", pointerEvents: "none",
        }}>
          {addMode
            ? "TAP THE TREE ON THE MAP"
            : `${pins.length} PIN${pins.length === 1 ? "" : "S"} · DRAG TO CORRECT`}
        </div>
      )}

      {/* ── PIN DETAIL SHEET ────────────────────────────────────────────── */}
      {openPin && (() => {
        const live = pins.find(p => p.id === openPin.id) || openPin;
        const photo = live.photoId ? photos.find(ph => (ph.id || ph.ts) === live.photoId) : null;
        const src = photo?.dataUrl || photo?.url || null;
        const idx = pins.findIndex(p => p.id === live.id);
        return (
          <div onClick={() => setOpenPin(null)} style={{
            position: "absolute", inset: 0, zIndex: 20,
            background: "rgba(0,0,0,.45)", display: "flex", alignItems: "flex-end",
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              width: "100%", background: "#0e1120", borderTop: "1px solid #253049",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              padding: "14px 16px max(18px, env(safe-area-inset-bottom))",
              boxShadow: "0 -12px 40px rgba(0,0,0,.6)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 1, fontSize: 12, fontWeight: 800, color: "#F6BF26", fontFamily: F, letterSpacing: 0.8, textTransform: "uppercase" }}>
                  Pin {idx >= 0 ? idx + 1 : ""}
                  <span style={{ color: "#5a6580", fontWeight: 600, marginLeft: 8, letterSpacing: 0.3 }}>
                    {live.source === "photo" ? "from photo" : live.source === "gps" ? "from GPS" : "placed on map"}
                    {live.adjusted ? " · adjusted" : live.acc ? ` · ±${live.acc}m` : ""}
                  </span>
                </div>
                <button onClick={() => setOpenPin(null)} style={{
                  width: 30, height: 30, borderRadius: 15, background: "transparent",
                  border: "1px solid #253049", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}><IconX size={14} color="#8aa0c0" /></button>
              </div>
              {src && (
                <img src={src} alt="" style={{
                  width: "100%", maxHeight: 190, objectFit: "cover",
                  borderRadius: 10, marginBottom: 12, border: "1px solid #1a2540",
                }} />
              )}
              <input
                value={live.label || ""}
                onChange={e => labelPin(live.id, e.target.value)}
                placeholder="Label (e.g. Sugar maple — remove)"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "10px 12px",
                  borderRadius: 8, background: "#0a0c14", border: "1px solid #253049",
                  color: "#e0e8f0", fontSize: 14, outline: "none", marginBottom: 12,
                  fontFamily: "'DM Sans',system-ui,sans-serif",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, fontSize: 11, color: "#5a6580", lineHeight: 1.4, alignSelf: "center" }}>
                  Drag the pin on the map to correct its position.
                </div>
                <button onClick={() => deletePin(live.id)} style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "9px 14px", borderRadius: 8,
                  background: "rgba(200,60,60,.12)", border: "1px solid rgba(200,60,60,.3)",
                  color: "#e06060", fontSize: 11.5, fontWeight: 800,
                  cursor: "pointer", fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase",
                }}><IconTrash size={14} color="#e06060" /> Remove</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── SNAPSHOT BUTTON ─────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", bottom: "max(24px, env(safe-area-inset-bottom))", left: 0, right: 0,
        display: "flex", justifyContent: "center", pointerEvents: "none",
      }}>
        <button
          onClick={takeSnapshot}
          disabled={!ready || snapping}
          style={{
            pointerEvents: "auto",
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 22px", borderRadius: 999,
            background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.16)",
            color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: F, letterSpacing: 0.5,
            cursor: ready && !snapping ? "pointer" : "default",
            opacity: ready && !snapping ? 1 : 0.55,
            boxShadow: "0 4px 16px rgba(0,0,0,.4)",
          }}
        >
          <IconCamera size={17} color="#fff" />
          {snapping ? "Saving..." : "Snapshot"}
        </button>

        {/* Callout site plan — photos arranged AROUND the map with leader lines
            to their pin, so the map itself stays readable. */}
        <button
          onClick={exportPlan}
          disabled={!ready || exporting || pins.length === 0}
          style={{
            pointerEvents: "auto", marginLeft: 10,
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 22px", borderRadius: 999,
            background: pins.length ? "rgba(246,191,38,.92)" : "rgba(28,28,30,.85)",
            border: `1px solid ${pins.length ? "#F6BF26" : "rgba(255,255,255,.16)"}`,
            color: pins.length ? "#1a1400" : "#8b93a4",
            fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
            cursor: ready && !exporting && pins.length ? "pointer" : "default",
            opacity: exporting ? 0.7 : 1,
            boxShadow: "0 4px 16px rgba(0,0,0,.4)",
          }}
        >
          <IconMapPin size={16} color={pins.length ? "#1a1400" : "#8b93a4"} />
          {exporting ? "Building..." : "Site Plan"}
        </button>
      </div>

      {/* ── SITE PLAN PREVIEW ───────────────────────────────────────────── */}
      {planUrl && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 40, background: "rgba(0,0,0,.88)",
          display: "flex", flexDirection: "column",
          padding: "max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom))",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 800, color: "#F6BF26", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
              Site Plan
            </div>
            <button onClick={() => setPlanUrl(null)} aria-label="Close preview" style={{
              width: 34, height: 34, borderRadius: 17, background: "rgba(28,28,30,.8)",
              border: "1px solid rgba(255,255,255,.16)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}><IconX size={16} color="#fff" /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderRadius: 10, background: "#0d1017" }}>
            <img src={planUrl} alt="Site plan" style={{ width: "100%", display: "block" }} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={savePlan} style={{
              flex: 1, padding: "13px 0", borderRadius: 10,
              background: "#F6BF26", border: "none", color: "#1a1400",
              fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
              textTransform: "uppercase", cursor: "pointer",
            }}>Save / Share</button>
            <button
              onClick={async () => { const u = planUrl; setPlanUrl(null); await onSnapshot?.(u); }}
              style={{
                flex: 1, padding: "13px 0", borderRadius: 10,
                background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.2)",
                color: "#e6ecf5", fontSize: 13, fontWeight: 800, fontFamily: F,
                letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
              }}>Add to Card</button>
          </div>
        </div>
      )}

      {snapError && (
        <div style={{
          position: "absolute", bottom: "max(84px, calc(env(safe-area-inset-bottom) + 60px))", left: "50%",
          transform: "translateX(-50%)", padding: "8px 14px", borderRadius: 8,
          background: "rgba(239,68,68,.9)", color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
        }}>
          {snapError}
        </div>
      )}

      {/* ── BOTTOM SHEET — parcel info ──────────────────────────────────── */}
      {info && (
        <div onClick={dismissInfo} style={{ position: "fixed", inset: 0, zIndex: 1 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: "#13161f", borderTop: "1px solid #252d47",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              padding: "16px 18px max(20px, env(safe-area-inset-bottom))",
              boxShadow: "0 -8px 30px rgba(0,0,0,.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {info.owner}
              </div>
              <button onClick={dismissInfo} aria-label="Close" style={{
                width: 28, height: 28, borderRadius: 14, background: "transparent",
                border: "1px solid #252d47", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0, marginLeft: 10,
              }}>
                <IconX size={14} color="#5a6580" />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#c8d0e8" }}>
              {info.parcelAddr && <Row label="Property" value={info.parcelAddr} />}
              {info.mailAddr && <Row label="Mailing address" value={info.mailAddr} />}
              {info.sbl && <Row label="SBL / tax ID" value={info.sbl} />}
              {info.acres != null && <Row label="Acreage" value={`${info.acres} ac`} />}
              {info.assessedValue != null && <Row label="Assessed value" value={`$${Number(info.assessedValue).toLocaleString()}`} />}
              {info.propClass && <Row label="Property class" value={info.propClass} />}
              {(info.muni || info.county) && <Row label="Municipality" value={[info.muni, info.county].filter(Boolean).join(", ")} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#5a6580", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontFamily: F, flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
}
