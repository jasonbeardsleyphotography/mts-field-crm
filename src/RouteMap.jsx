import { useState, useRef, useEffect } from "react";
import { attachParcelOverlay, detachParcelOverlay, PARCEL_MIN_ZOOM } from "./parcelOverlay";
import { IconMapPin } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Route Map
   Satellite hybrid map. Live blue dot. Selected stop highlight.
   Directions line from current location to next (first) stop.
   ═══════════════════════════════════════════════════════════════════════════ */

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
export const AM_COLOR = "#2E7D32";
export const PM_COLOR = "#1E88E5";

// Minimal label styling for hybrid satellite
const SAT_STYLE = [
  {featureType:"poi",stylers:[{visibility:"off"}]},
  {featureType:"transit",stylers:[{visibility:"off"}]},
];

// ── GEOCODING ────────────────────────────────────────────────────────────────
const ZIP_CITY = {"14445":"East Rochester","14450":"Fairport","14472":"Honeoye Falls","14502":"Macedon","14526":"Penfield","14534":"Pittsford","14543":"Rush","14564":"Victor","14580":"Webster","14607":"Rochester","14608":"Rochester","14609":"Rochester","14610":"Rochester","14611":"Rochester","14612":"Rochester","14614":"Rochester","14615":"Rochester","14616":"Rochester","14617":"Rochester","14618":"Rochester","14619":"Rochester","14620":"Rochester","14621":"Rochester","14622":"Rochester","14623":"Rochester","14624":"Rochester","14625":"Penfield","14626":"Rochester","14424":"Canandaigua"};
const geoCache = {};

function fullAddress(addr) {
  if (!addr) return null;
  const z = addr.match(/\b(1\d{4})\b/);
  if (!z) return addr + ", Rochester, NY";
  const city = ZIP_CITY[z[1]] || "Rochester";
  if (new RegExp(city,"i").test(addr)) return /\bNY\b/i.test(addr) ? addr : addr + ", NY";
  return addr.replace(/(\b1\d{4})\b/, `, ${city}, NY $1`);
}

export async function geocode(addr) {
  if (!addr || addr.length < 5) return null;
  const full = fullAddress(addr);
  if (geoCache[full]) return geoCache[full];
  try {
    const r = await new window.google.maps.Geocoder().geocode({ address: full });
    if (r.results?.[0]?.geometry?.location) {
      const loc = r.results[0].geometry.location;
      const c = { lat: loc.lat(), lng: loc.lng() };
      geoCache[full] = c;
      return c;
    }
  } catch(e) {}
  return null;
}

// ── OSRM FALLBACK ROUTING ─────────────────────────────────────────────────────
async function fetchOSRMPath(positions) {
  const coords = positions.map(p => `${p.lng},${p.lat}`).join(";");
  try {
    const resp = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coords}?geometries=geojson&overview=full`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await resp.json();
    const line = data?.routes?.[0]?.geometry?.coordinates;
    if (line?.length) return line.map(([lng, lat]) => ({ lat, lng }));
  } catch(e) {}
  return null;
}

// ── MAPS LOADER ──────────────────────────────────────────────────────────────
let mapsPromise = null;
export function loadMaps() {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((ok, fail) => {
    if (window.google?.maps?.Map) { ok(); return; }
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    s.async = true;
    s.onload = () => window.google?.maps?.Map ? ok() : fail("Maps failed");
    s.onerror = () => { mapsPromise = null; fail("Script failed"); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}

// ── PIXEL-CONSTANT MARKER OFFSET ─────────────────────────────────────────────
// Two stops geocoded to nearly the same point need to stay visually distinct
// at ANY zoom level. A fixed lat/lng offset shrinks to a few pixels when
// zoomed out and the markers merge back into one blob. Instead we compute the
// offset in real-world meters that corresponds to a constant on-screen pixel
// distance at the map's current zoom (Web Mercator projection), so clustered
// markers always sit ~CLUSTER_PX apart on screen no matter how far zoomed out.
const CLUSTER_PX = 15;
function metersPerPixel(lat, zoom) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}
function offsetLatLng(base, angle, meters) {
  return {
    lat: base.lat + (meters * Math.cos(angle)) / 111320,
    lng: base.lng + (meters * Math.sin(angle)) / (111320 * Math.cos(base.lat * Math.PI / 180)),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function RouteMap({ stops, selectedId }) {
  const ref = useRef(null);
  const map = useRef(null);
  const markers = useRef([]); // [{marker, stopId}]
  const clusterInfo = useRef({}); // stopId -> { base:{lat,lng}, angle } for clustered stops only
  const route = useRef(null);
  const nextRoute = useRef(null); // directions to next stop
  const prevSet = useRef("");
  const locMarker = useRef(null);
  const watchId = useRef(null);
  const userLoc = useRef(null); // latest GPS coords
  const [ready, setReady] = useState(false);
  const [coords, setCoords] = useState({});
  const [parcelsOn, setParcelsOn] = useState(false);
  const [mapZoom, setMapZoom] = useState(11);
  const parcelHandle = useRef(null);

  useEffect(() => { loadMaps().then(() => setReady(true)).catch(() => {}); }, []);

  // Create map — satellite hybrid
  useEffect(() => {
    if (!ready || !ref.current || map.current) return;
    map.current = new window.google.maps.Map(ref.current, {
      center:{lat:43.12,lng:-77.50}, zoom:11,
      mapTypeId: "hybrid", styles: SAT_STYLE,
      disableDefaultUI:true, gestureHandling:"greedy", backgroundColor:"#10131a",
      zoomControl:false, mapTypeControl:false, streetViewControl:false,
      fullscreenControl:false, keyboardShortcuts:false, clickableIcons:false,
    });
  }, [ready]);

  // ── PARCEL BOUNDARY OVERLAY ─────────────────────────────────────────────
  // No info panel here by design — this toggle is just "am I on the right
  // property" while driving, not a lookup tool (that's ParcelMapView).
  useEffect(() => {
    if (!map.current) return;
    if (parcelsOn) {
      parcelHandle.current = attachParcelOverlay(map.current);
    } else if (parcelHandle.current) {
      detachParcelOverlay(parcelHandle.current);
      parcelHandle.current = null;
    }
    return () => {
      if (parcelHandle.current) {
        detachParcelOverlay(parcelHandle.current);
        parcelHandle.current = null;
      }
    };
  }, [parcelsOn, ready]);

  // ── LIVE LOCATION DOT ───────────────────────────────────────────────────
  useEffect(() => {
    if (!map.current || !navigator.geolocation) return;
    watchId.current = navigator.geolocation.watchPosition(
      pos => {
        const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        userLoc.current = latlng;
        if (!locMarker.current) {
          locMarker.current = new window.google.maps.Marker({
            position: latlng, map: map.current, zIndex: 999,
            icon: {
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 7, fillColor: "#4285F4", fillOpacity: 1,
              strokeColor: "#fff", strokeWeight: 2.5,
            },
          });
          locMarker.current._ring = new window.google.maps.Circle({
            map: map.current, center: latlng,
            radius: pos.coords.accuracy,
            fillColor: "#4285F4", fillOpacity: 0.08,
            strokeColor: "#4285F4", strokeOpacity: 0.25, strokeWeight: 1,
            clickable: false, zIndex: 998,
          });
        } else {
          locMarker.current.setPosition(latlng);
          if (locMarker.current._ring) {
            locMarker.current._ring.setCenter(latlng);
            locMarker.current._ring.setRadius(pos.coords.accuracy);
          }
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      if (locMarker.current) { locMarker.current.setMap(null); if (locMarker.current._ring) locMarker.current._ring.setMap(null); locMarker.current = null; }
    };
  }, [ready]);

  // Geocode — parallel batches of 4
  useEffect(() => {
    if (!ready || !stops.length) return;
    let dead = false;
    (async () => {
      const c = {};
      const BATCH = 4;
      for (let i = 0; i < stops.length; i += BATCH) {
        if (dead) break;
        const batch = stops.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(s => geocode(s.addr)));
        batch.forEach((s, j) => { if (results[j]) c[s.id] = results[j]; });
        if (i + BATCH < stops.length) await new Promise(r => setTimeout(r, 100));
      }
      if (!dead) setCoords(c);
    })();
    return () => { dead = true; };
  }, [ready, stops.map(s => s.id + s.addr).join(",")]);

  // ── MARKERS + ROUTE LINE ──────────────────────────────────────────────
  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach(m => m.marker.setMap(null)); markers.current = [];
    if (route._cancelOSRM) { route._cancelOSRM(); delete route._cancelOSRM; }
    if (route.current) { route.current.setMap(null); route.current = null; }
    if (!Object.keys(coords).length) return;

    // Detect stops that geocoded to nearly the same point — they need a
    // visual offset to stay distinguishable. The angle assignment is
    // zoom-independent; the actual offset DISTANCE is computed per-render
    // (and live on zoom change, see the zoom_changed listener below) so the
    // on-screen pixel separation stays constant at any zoom level.
    clusterInfo.current = {};
    const NEAR = 0.0004;
    const stopsWithPos = stops.filter(s => coords[s.id]);
    const clusterVisited = new Set();
    for (let i = 0; i < stopsWithPos.length; i++) {
      if (clusterVisited.has(stopsWithPos[i].id)) continue;
      const base = coords[stopsWithPos[i].id];
      const group = [stopsWithPos[i].id];
      for (let j = i + 1; j < stopsWithPos.length; j++) {
        if (clusterVisited.has(stopsWithPos[j].id)) continue;
        const p = coords[stopsWithPos[j].id];
        if (Math.abs(base.lat - p.lat) < NEAR && Math.abs(base.lng - p.lng) < NEAR) {
          group.push(stopsWithPos[j].id);
        }
      }
      if (group.length > 1) {
        group.forEach((id, ci) => {
          clusterVisited.add(id);
          clusterInfo.current[id] = { base, angle: (ci / group.length) * 2 * Math.PI };
        });
      }
    }
    const zoom = map.current.getZoom() ?? 11;
    const markerPos = (id) => {
      const info = clusterInfo.current[id];
      if (!info) return coords[id];
      return offsetLatLng(info.base, info.angle, CLUSTER_PX * metersPerPixel(info.base.lat, zoom));
    };

    const positions = [];
    const bounds = new window.google.maps.LatLngBounds();
    let n = 0;
    stops.forEach(s => {
      if (!coords[s.id]) return;
      const pos = markerPos(s.id); if (!pos) return; n++;
      const isAM = (s.window||"").startsWith("AM");
      const pinColor = isAM ? AM_COLOR : PM_COLOR;
      const hasConstraint = !!s.constraint;
      const isSel = s.id === selectedId;
      const m = new window.google.maps.Marker({
        position:pos, map:map.current,
        optimized: false,
        label:{text:String(n),color:"#fff",fontWeight:"800",fontSize: isSel ? "11px" : "10px"},
        icon:{path:window.google.maps.SymbolPath.CIRCLE,
          scale: isSel ? 12 : 10,
          fillColor:pinColor, fillOpacity: s.db ? .7 : 1,
          strokeColor: isSel ? "#FFD600" : hasConstraint ? "#FF4081" : "#fff",
          strokeWeight: isSel ? 3 : hasConstraint ? 2 : 1.5},
        zIndex: isSel ? 9999 : (stops.length - n + 11),
      });
      markers.current.push({ marker: m, stopId: s.id, order: n });
      // Route line + bounds use the TRUE geocoded position (not the visual
      // cluster offset) so the route geometry stays stable across zoom
      // changes and doesn't trigger redundant Directions lookups.
      positions.push(coords[s.id]); bounds.extend(coords[s.id]);
    });

    // Full route polyline — Google Directions → OSRM fallback → straight-line fallback
    if (positions.length >= 2) {
      let staleRoute = false;
      const drawOSRM = async () => {
        const path = await fetchOSRMPath(positions);
        if (staleRoute || route.current) return;
        route.current = new window.google.maps.Polyline({
          path: path || positions,
          strokeColor:"#039BE5", strokeOpacity: path ? .6 : .4,
          strokeWeight: path ? 3 : 2, map:map.current,
        });
      };
      try {
        new window.google.maps.DirectionsService().route({
          origin:positions[0], destination:positions[positions.length-1],
          waypoints:positions.slice(1,-1).map(p=>({location:p,stopover:true})).slice(0,23),
          travelMode:window.google.maps.TravelMode.DRIVING, optimizeWaypoints:false,
        }, (result, status) => {
          if (staleRoute) return;
          if (status === "OK") {
            route.current = new window.google.maps.DirectionsRenderer({
              map:map.current, directions:result, suppressMarkers:true, preserveViewport:true,
              polylineOptions:{strokeColor:"#039BE5",strokeOpacity:.6,strokeWeight:3},
            });
          } else {
            drawOSRM();
          }
        });
      } catch(e) {
        drawOSRM();
      }
      // Expose cleanup so the effect can cancel inflight OSRM fetch
      route._cancelOSRM = () => { staleRoute = true; };
    }

    // Fit bounds only when stop SET changes
    const set = [...stops.map(s=>s.id)].sort().join(",");
    if (positions.length > 0 && set !== prevSet.current) {
      map.current.fitBounds(bounds, {top:20,right:20,bottom:20,left:20});
      prevSet.current = set;
    }
  }, [coords, stops, selectedId]);

  // ── LIVE-REPOSITION CLUSTERED MARKERS ON ZOOM ──────────────────────────
  // Keeps clustered markers ~CLUSTER_PX pixels apart on screen at any zoom
  // level, instead of the fixed real-world offset shrinking to nothing when
  // zoomed out. Only touches markers that are actually clustered — cheap.
  useEffect(() => {
    if (!map.current) return;
    const listener = map.current.addListener("zoom_changed", () => {
      const zoom = map.current.getZoom();
      if (zoom == null) return;
      setMapZoom(zoom);
      markers.current.forEach(({ marker, stopId }) => {
        const info = clusterInfo.current[stopId];
        if (!info) return;
        marker.setPosition(offsetLatLng(info.base, info.angle, CLUSTER_PX * metersPerPixel(info.base.lat, zoom)));
      });
    });
    return () => listener.remove();
  }, [ready]);

  // ── DIRECTIONS FROM CURRENT LOCATION TO NEXT STOP ─────────────────────
  useEffect(() => {
    if (!map.current) return;
    if (nextRoute.current) { nextRoute.current.setMap(null); nextRoute.current = null; }
    let stale = false;
    const firstStop = stops[0];
    if (!firstStop || !coords[firstStop.id] || !userLoc.current) return;

    try {
      new window.google.maps.DirectionsService().route({
        origin: userLoc.current,
        destination: coords[firstStop.id],
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (result, status) => {
        if (stale) return;
        if (status === "OK") {
          nextRoute.current = new window.google.maps.DirectionsRenderer({
            map: map.current, directions: result, suppressMarkers: true, preserveViewport: true,
            polylineOptions: { strokeColor: "#FFD600", strokeOpacity: .8, strokeWeight: 5 },
          });
        }
      });
    } catch(e) {}
    return () => {
      stale = true;
      if (nextRoute.current) { nextRoute.current.setMap(null); nextRoute.current = null; }
    };
  }, [coords, stops, ready]);

  // ── HIGHLIGHT SELECTED MARKER ──────────────────────────────────────────
  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach(({ marker, stopId, order }) => {
      const isSel = stopId === selectedId;
      const s = stops.find(x => x.id === stopId);
      if (!s) return;
      const isAM = (s.window||"").startsWith("AM");
      const pinColor = isAM ? AM_COLOR : PM_COLOR;
      const hasConstraint = !!s.constraint;
      marker.setIcon({
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: isSel ? 12 : 10,
        fillColor: pinColor, fillOpacity: s.db ? .7 : 1,
        strokeColor: isSel ? "#FFD600" : hasConstraint ? "#FF4081" : "#fff",
        strokeWeight: isSel ? 3 : hasConstraint ? 2 : 1.5,
      });
      marker.setZIndex(isSel ? 9999 : (stops.length - order + 11));
      marker.setLabel({ text: marker.getLabel().text, color: "#fff", fontWeight: "800", fontSize: isSel ? "11px" : "10px" });
    });
  }, [selectedId]);

  return (
    <div style={{position:"relative",width:"100%",height:260,background:"#10131a"}}>
      <div ref={ref} style={{width:"100%",height:"100%"}}>{!ready && <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#5a6580",fontSize:12}}>Loading map...</div>}</div>
      {ready && (
        <button
          onClick={() => setParcelsOn(v => !v)}
          style={{
            position:"absolute", top:8, right:8, zIndex:10,
            display:"flex", alignItems:"center", gap:5,
            padding:"6px 10px", borderRadius:8,
            background: parcelsOn ? "rgba(255,214,0,.92)" : "rgba(16,19,26,.78)",
            border:"1px solid rgba(255,255,255,.14)",
            color: parcelsOn ? "#1a1a1a" : "#e0e8f0",
            fontSize:11, fontWeight:700, letterSpacing:0.5,
            cursor:"pointer",
          }}
        >
          <IconMapPin size={13} color={parcelsOn ? "#1a1a1a" : "#e0e8f0"}/>Parcels
        </button>
      )}
      {ready && parcelsOn && mapZoom < PARCEL_MIN_ZOOM && (
        <div style={{
          position:"absolute", top:42, right:8, zIndex:10,
          padding:"5px 9px", borderRadius:7,
          background:"rgba(16,19,26,.85)", border:"1px solid rgba(255,255,255,.14)",
          color:"#ffd600", fontSize:10.5, fontWeight:600,
        }}>
          Zoom in to see parcels
        </div>
      )}
    </div>
  );
}
