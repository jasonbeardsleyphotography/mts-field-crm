import { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { METRICS, renderGradient, projector, inRings, fmtVal } from "./soilData";

/* ═══════════════════════════════════════════════════════════════════════════
   The property map: Esri satellite + road/place labels, the interpolated soil
   layer, sample pins, boundary/cut-outs, and "you are here".
   Location stays on this device — it is never sent anywhere — and watching
   stops while the page is hidden, to save battery.
   ═══════════════════════════════════════════════════════════════════════════ */

const E = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const PARCEL_URL = "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query?";

const LOC_MSG = {
  denied: "Location is blocked. On iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using, then tap the location button again.",
  unavailable: "Your phone can't get a location fix right now. Step into the open, away from buildings, and try again.",
  timeout: "Still looking for your location… this can take a moment outdoors.",
  insecure: "Location needs the secure (https) version of this page.",
  unsupported: "This browser can't share location.",
};

export default function SoilMap({
  samples, metric, fade, opacity, shapes, draft, drawMode, onMapClick, selected, onSelect,
  onParcelStatus, useParcel = true, height = "100%", center,
}) {
  const el = useRef(null);
  const map = useRef(null);
  const layers = useRef({});
  const markers = useRef(new Map());
  const [parcel, setParcel] = useState([]);        // polygons: arrays of rings of [lat, lon]
  const [ready, setReady] = useState(false);
  const clickRef = useRef(onMapClick); clickRef.current = onMapClick;
  const selRef = useRef(onSelect); selRef.current = onSelect;
  const modeRef = useRef(drawMode); modeRef.current = drawMode;

  const placed = useMemo(() => samples.filter((s) => s.lat != null && s.lng != null), [samples]);
  const allPoints = useMemo(() => {
    const pts = placed.map((s) => [s.lat, s.lng]);
    (shapes || []).forEach((sh) => sh.coords.forEach((c) => pts.push(c)));
    return pts.length ? pts : [center ? [center.lat, center.lng] : [43.12, -77.55]];
  }, [placed, shapes, center]);
  const proj = useMemo(() => projector(placed.length ? placed.map((s) => [s.lat, s.lng]) : allPoints), [placed, allPoints]);

  // ── create the map once ───────────────────────────────────────────────────
  useEffect(() => {
    const m = L.map(el.current, { maxZoom: 20, zoomControl: true, attributionControl: true, tap: true });
    m.createPane("grad").style.zIndex = 350;
    m.createPane("labels").style.zIndex = 450;
    m.getPane("labels").style.pointerEvents = "none";
    L.tileLayer(E + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics &middot; Parcels: NYS ITS Geospatial Services",
    }).addTo(m);
    L.tileLayer(E + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, maxNativeZoom: 19, pane: "labels" }).addTo(m);
    L.tileLayer(E + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, maxNativeZoom: 19, pane: "labels" }).addTo(m);
    layers.current = {
      overlay: L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAAAAACw=", [[0, 0], [0, 0]], { pane: "grad", opacity: 0.6 }).addTo(m),
      parcel: L.layerGroup().addTo(m),
      shapes: L.layerGroup().addTo(m),
      temp: L.layerGroup().addTo(m),
      me: L.layerGroup().addTo(m),
    };
    m.on("click", (e) => { if (modeRef.current) clickRef.current?.([e.latlng.lat, e.latlng.lng]); });
    map.current = m;
    setReady(true);
    return () => { m.remove(); map.current = null; markers.current.clear(); };
  }, []);

  // fit to the property once
  const fitted = useRef(false);
  useEffect(() => {
    if (!ready || fitted.current) return;
    if (allPoints.length > 1) { map.current.fitBounds(allPoints, { padding: [40, 40], maxZoom: 19 }); fitted.current = true; }
    else map.current.setView(allPoints[0], center ? 18 : 10);
  }, [ready, allPoints]);

  // ── NYS tax parcel (may be empty: Monroe County doesn't share parcels) ───
  const hasBoundary = (shapes || []).some((s) => s.type === "boundary");
  useEffect(() => {
    if (!ready || hasBoundary || !useParcel || !placed.length) { setParcel([]); return; }
    let dead = false;
    onParcelStatus?.("Looking up the tax parcel…");
    const geom = JSON.stringify({ points: placed.map((d) => [d.lng, d.lat]), spatialReference: { wkid: 4326 } });
    const url = PARCEL_URL + new URLSearchParams({ geometry: geom, geometryType: "esriGeometryMultipoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "*", returnGeometry: "true", outSR: "4326", f: "geojson" });
    fetch(url).then((r) => r.json()).then((j) => {
      if (dead) return;
      const fs = (j.features || []).filter((f) => f.geometry);
      if (!fs.length) { onParcelStatus?.("No public tax parcel here (this county may not share parcels with the state)."); setParcel([]); return; }
      const polys = [];
      fs.forEach((f) => {
        const g = f.geometry, ps = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        ps.forEach((p) => polys.push(p.map((r) => r.map((q) => [q[1], q[0]]))));
      });
      setParcel(polys);
      onParcelStatus?.(`Clipped to the NYS tax parcel (${fs.length}).`);
    }).catch(() => { if (!dead) { onParcelStatus?.("Couldn't reach the NYS parcel service."); setParcel([]); } });
    return () => { dead = true; };
  }, [ready, hasBoundary, useParcel, placed.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    const g = layers.current.parcel; g.clearLayers();
    parcel.forEach((p) => L.polygon(p, { color: "#ffeb3b", weight: 3, fill: false, dashArray: "6 4", interactive: false }).addTo(g));
  }, [ready, parcel]);

  // ── gradient ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      const out = metric && renderGradient({
        metric, fade, proj, allPoints, shapes: shapes || [], regions: parcel,
        samples: placed.filter((s) => s.included).map((s) => ({ lat: s.lat, lng: s.lng, value: s.values?.[metric] })),
      });
      const ov = layers.current.overlay;
      if (out) { ov.setUrl(out.url); ov.setBounds(out.bounds); } else ov.setUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
    }, 30);
    return () => clearTimeout(t);
  }, [ready, metric, fade, placed, shapes, parcel, proj, allPoints]);
  useEffect(() => { if (ready) layers.current.overlay.setOpacity(opacity); }, [ready, opacity]);

  // ── stored boundary / cut-outs ────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const g = layers.current.shapes; g.clearLayers();
    (shapes || []).forEach((s) => {
      const sty = { boundary: { color: "#ffeb3b", weight: 3, fill: false }, area: { color: "#fff", weight: 2, dashArray: "4 3", fillOpacity: 0 }, line: { color: "#fff", weight: 2, dashArray: "4 3" } }[s.type];
      (s.type === "line" ? L.polyline(s.coords, { ...sty, interactive: false }) : L.polygon(s.coords, { ...sty, interactive: false })).addTo(g);
    });
  }, [ready, shapes]);

  // ── drawing in progress ───────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const g = layers.current.temp; g.clearLayers();
    map.current.getContainer().style.cursor = drawMode ? "crosshair" : "";
    if (drawMode) map.current.doubleClickZoom.disable(); else map.current.doubleClickZoom.enable();
    if (!draft?.length) return;
    if (drawMode === "line") L.polyline(draft, { color: "#ff5252", weight: 4 }).addTo(g);
    else L.polygon(draft, { color: "#ff5252", weight: 2, fillOpacity: 0.15 }).addTo(g);
    draft.forEach((p) => L.circleMarker(p, { radius: 5, color: "#fff", fillColor: "#ff5252", fillOpacity: 1, weight: 1 }).addTo(g));
  }, [ready, draft, drawMode]);

  // ── sample pins ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const want = new Set();
    placed.forEach((s) => {
      const key = s.key; want.add(key);
      const v = s.values?.[metric];
      const html = `<div class="sp-pin${s.included ? "" : " off"}${selected === key ? " sel" : ""}"><b>${s.id}</b><span>${v == null ? "–" : fmtVal(v)}</span></div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [44, 30], iconAnchor: [22, 15] });
      let mk = markers.current.get(key);
      if (!mk) {
        mk = L.marker([s.lat, s.lng], { icon, riseOnHover: true, keyboard: true, title: `Sample ${s.id}` }).addTo(map.current);
        mk.on("click", () => selRef.current?.(key));
        markers.current.set(key, mk);
      } else { mk.setIcon(icon); mk.setLatLng([s.lat, s.lng]); }
      mk.setZIndexOffset(selected === key ? 1000 : 0);
    });
    for (const [k, mk] of markers.current) if (!want.has(k)) { mk.remove(); markers.current.delete(k); }
  }, [ready, placed, metric, selected]);

  useEffect(() => {
    const s = placed.find((x) => x.key === selected);
    if (s && map.current) map.current.panTo([s.lat, s.lng]);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── you are here ──────────────────────────────────────────────────────────
  const [loc, setLoc] = useState({ on: false, status: "", fix: null });
  const [follow, setFollow] = useState(true);
  const watchId = useRef(null);
  const followRef = useRef(follow); followRef.current = follow;
  const firstFix = useRef(true);

  const boundaryRings = useMemo(() => {
    const b = (shapes || []).filter((s) => s.type === "boundary").map((s) => [s.coords]);
    return b.length ? b : parcel;
  }, [shapes, parcel]);
  const outside = useMemo(() => {
    if (!loc.fix) return false;
    const [x, y] = proj.XY(loc.fix.lat, loc.fix.lng);
    if (boundaryRings.length) return !boundaryRings.some((p) => inRings(x, y, p.map((r) => r.map((q) => proj.XY(q[0], q[1])))));
    const dmin = Math.min(...placed.map((s) => { const [a, b] = proj.XY(s.lat, s.lng); return Math.hypot(a - x, b - y); }));
    return dmin > 160;
  }, [loc.fix, boundaryRings, placed, proj]);

  const startWatch = () => {
    if (!("geolocation" in navigator)) { setLoc((l) => ({ ...l, on: true, status: "unsupported" })); return; }
    if (!window.isSecureContext) { setLoc((l) => ({ ...l, on: true, status: "insecure" })); return; }
    if (watchId.current != null) return;
    setLoc((l) => ({ ...l, on: true, status: l.fix ? "" : "asking" }));
    watchId.current = navigator.geolocation.watchPosition(
      (p) => setLoc({ on: true, status: "", fix: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, at: p.timestamp } }),
      (err) => setLoc((l) => ({ ...l, on: true, status: err.code === 1 ? "denied" : err.code === 3 ? "timeout" : "unavailable" })),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  };
  const stopWatch = () => { if (watchId.current != null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; } };

  useEffect(() => {
    const vis = () => { if (document.hidden) stopWatch(); else if (loc.on && loc.status !== "denied") startWatch(); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [loc.on, loc.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopWatch(), []);

  useEffect(() => {
    if (!ready) return;
    const g = layers.current.me; g.clearLayers();
    const f = loc.fix; if (!loc.on || !f) return;
    L.circle([f.lat, f.lng], { radius: Math.max(3, f.acc || 0), color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false }).addTo(g);
    if (f.heading != null && isFinite(f.heading)) {
      L.marker([f.lat, f.lng], { interactive: false, icon: L.divIcon({ className: "", iconSize: [44, 44], iconAnchor: [22, 22],
        html: `<div class="sp-head" style="transform:rotate(${f.heading}deg)"></div>` }) }).addTo(g);
    }
    L.circleMarker([f.lat, f.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(g);
    if (followRef.current && !outside) {
      if (firstFix.current) { map.current.setView([f.lat, f.lng], Math.max(map.current.getZoom(), 18)); firstFix.current = false; }
      else map.current.panTo([f.lat, f.lng], { animate: true });
    }
  }, [ready, loc, outside]);

  const recenter = () => {
    if (loc.fix) map.current.setView([loc.fix.lat, loc.fix.lng], Math.max(map.current.getZoom(), 18));
    else startWatch();
  };
  const showProperty = () => { if (allPoints.length > 1) map.current.fitBounds(allPoints, { padding: [40, 40], maxZoom: 19 }); };

  const msg = loc.on && (loc.status === "asking" ? "Finding your location… if your phone asks, tap Allow."
    : LOC_MSG[loc.status] || (outside ? "You're outside this property, so the map isn't following you. Tap ⌖ to jump to where you are." : ""));

  return (
    <div style={{ position: "relative", height, minHeight: 280 }}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {msg && <div className="sp-banner" role="status">{msg}</div>}
      <div className="sp-ctl">
        {!loc.on ? (
          <button className="sp-fab sp-fab-wide" onClick={startWatch} aria-label="Show my location">◉ Show me</button>
        ) : (
          <>
            <button className={`sp-fab${follow ? " on" : ""}`} onClick={() => setFollow((f) => !f)} aria-pressed={follow} aria-label="Follow me" title="Follow me">
              {follow ? "Following" : "Follow"}
            </button>
            <button className="sp-fab" onClick={recenter} aria-label="Recenter on me" title="Recenter on me">⌖</button>
            <button className="sp-fab" onClick={() => { stopWatch(); setLoc({ on: false, status: "", fix: null }); firstFix.current = true; }} aria-label="Stop showing my location" title="Stop">✕</button>
          </>
        )}
        <button className="sp-fab" onClick={showProperty} aria-label="Show the whole property" title="Whole property">⤢</button>
      </div>
    </div>
  );
}
