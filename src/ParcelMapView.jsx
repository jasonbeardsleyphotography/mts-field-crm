import { useState, useRef, useEffect, useCallback } from "react";
import { loadMaps, geocode } from "./RouteMap";
import { attachParcelOverlay, detachParcelOverlay, parcelFeatureToInfo } from "./parcelOverlay";
import { IconX, IconCamera } from "./icons";

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

   Tree pins are READ-ONLY here — plain numbered dots for reference. Placing,
   dragging, labelling and sharing them all live on the on-site screen's Site
   Plan panel, which is where the photos they belong to already are.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function ParcelMapView({
  stop, onClose, onSnapshot, token,
  pins = [],            // [{ id, lat, lng, source, photoId, label, acc, ts, adjusted }]
}) {
  const ref = useRef(null);
  const map = useRef(null);
  const parcelHandle = useRef(null);
  const pinMarkers = useRef([]);        // live google.maps.Marker instances
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

  // ── RENDER PINS (READ-ONLY) ──────────────────────────────────────────────
  // Pin editing lives on the on-site screen's Site Plan panel now, not buried
  // in here. What's left is a reference layer: numbered dots showing where the
  // trees are while you read the property lines.
  //
  // Deliberately NOT photo thumbnails. A photo marker covers the exact ground
  // it is marking, and on a phone your fingertip covers whatever is left — the
  // marker hid the very thing it was pointing at.
  useEffect(() => {
    const g = window.google?.maps;
    if (!g || !map.current) return;
    pinMarkers.current.forEach(m => m.setMap(null));
    pinMarkers.current = pins
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p, i) => new g.Marker({
        map: map.current,
        position: { lat: p.lat, lng: p.lng },
        clickable: false,
        icon: {
          url: makeDotIcon(i + 1, p.source === "gps" ? "#4c9aff" : "#F6BF26"),
          scaledSize: new g.Size(34, 44), anchor: new g.Point(17, 44),
        },
        zIndex: 500 + i,
        title: p.label || `Pin ${i + 1}`,
      }));
  }, [pins, mapReady]);

  // Clear markers on unmount so nothing is left attached to a dead map.
  useEffect(() => () => { pinMarkers.current.forEach(m => m.setMap(null)); pinMarkers.current = []; }, []);

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
          onParcelClick: (feature) => setInfo(parcelFeatureToInfo(feature)),
          onStatus: (s) => setParcelStatus(s),
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

      {/* Read-only reminder of where the pins are edited. */}
      {pins.length > 0 && (
        <div style={{
          position: "absolute",
          top: "max(56px, calc(env(safe-area-inset-top) + 44px))",
          left: "50%", transform: "translateX(-50%)",
          padding: "7px 14px", borderRadius: 999, whiteSpace: "nowrap",
          background: "rgba(28,28,30,.82)", border: "1px solid rgba(255,255,255,.14)",
          color: "#cfd8e6", fontSize: 11.5, fontWeight: 700, fontFamily: F,
          letterSpacing: 0.4, boxShadow: "0 4px 16px rgba(0,0,0,.4)", pointerEvents: "none",
        }}>
          {`${pins.length} PIN${pins.length === 1 ? "" : "S"} · EDIT ON THE SITE PLAN`}
        </div>
      )}

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

      </div>

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
