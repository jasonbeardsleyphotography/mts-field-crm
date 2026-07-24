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
// Geocoding is a PAID Google API. The cache was in-memory only, so every cold
// launch of the PWA re-geocoded all of the day's stop addresses (~20 billable
// requests each open). Persist it to localStorage keyed by normalized address
// so a given address is geocoded once, ever, across launches and devices-days.
const GEOCACHE_KEY = "mts-geocache";
let geoCache = {};
try { geoCache = JSON.parse(localStorage.getItem(GEOCACHE_KEY) || "{}") || {}; } catch { geoCache = {}; }
function _persistGeoCache() {
  try {
    const keys = Object.keys(geoCache);
    if (keys.length > 800) { // bound growth across years of addresses
      const trimmed = {};
      for (const k of keys.slice(-600)) trimmed[k] = geoCache[k];
      geoCache = trimmed;
    }
    localStorage.setItem(GEOCACHE_KEY, JSON.stringify(geoCache));
  } catch {}
}

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
      _persistGeoCache();
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

// ── PIXEL-CONSTANT MARKER DECLUTTER ──────────────────────────────────────────
// Overlap is a SCREEN-PIXEL phenomenon, not a real-world-distance one: two
// stops a mile apart still sit on top of each other when zoomed out to the
// whole route. So we cluster by pixel distance at the current zoom (recomputed
// live on zoom) and fan each cluster into a ring whose radius grows with the
// member count, guaranteeing the pins never touch.
const MARKER_PX        = 22;  // approx pin diameter
const CLUSTER_THRESH_PX = 26; // pins whose centers are within this get grouped
const SEP_PX           = 20;  // center-to-center spacing of fanned pins — tightened
                               // from 30px, which fanned stops out far enough to
                               // read as separate addresses rather than one cluster
const MIN_RING_PX      = 12;  // smallest fan radius (for pairs) — tightened from 17

function metersPerPixel(lat, zoom) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}
function offsetLatLng(base, angle, meters) {
  return {
    lat: base.lat + (meters * Math.cos(angle)) / 111320,
    lng: base.lng + (meters * Math.sin(angle)) / (111320 * Math.cos(base.lat * Math.PI / 180)),
  };
}
function metersBetween(a, b) {
  const latM = (a.lat - b.lat) * 111320;
  const lngM = (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(latM, lngM);
}

// Group stops whose pins would overlap on screen at `zoom`, then spread each
// group around its centroid in a ring sized to keep ~SEP_PX between pins.
// Returns { posById, clusteredIds, clusters }. Singletons keep their true
// position and aren't included in `clusters` (only actual fanned groups are —
// used to draw a faint grouping halo so a fan doesn't read as separate
// addresses). Radius is in SCREEN PIXELS; the caller converts to meters.
function computeClusterLayout(ids, coords, zoom) {
  const posById = {};
  const clusteredIds = new Set();
  const clusters = [];
  const withPos = ids.filter(id => coords[id]);

  // Build overlap adjacency (centers within CLUSTER_THRESH_PX screen pixels).
  const adj = {};
  withPos.forEach(id => { adj[id] = []; });
  for (let i = 0; i < withPos.length; i++) {
    for (let j = i + 1; j < withPos.length; j++) {
      const a = coords[withPos[i]], b = coords[withPos[j]];
      const mpp = metersPerPixel((a.lat + b.lat) / 2, zoom);
      if (metersBetween(a, b) / mpp < CLUSTER_THRESH_PX) {
        adj[withPos[i]].push(withPos[j]);
        adj[withPos[j]].push(withPos[i]);
      }
    }
  }

  // Connected components = clusters.
  const seen = new Set();
  for (const start of withPos) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of adj[id]) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    if (comp.length === 1) {
      posById[comp[0]] = coords[comp[0]];
      continue;
    }
    const centroid = {
      lat: comp.reduce((s, id) => s + coords[id].lat, 0) / comp.length,
      lng: comp.reduce((s, id) => s + coords[id].lng, 0) / comp.length,
    };
    const count = comp.length;
    const radiusPx = Math.max(MIN_RING_PX, (SEP_PX * count) / (2 * Math.PI));
    const mpp = metersPerPixel(centroid.lat, zoom);
    // Stable angle order (sort by id) so pins don't jump around between renders.
    [...comp].sort().forEach((id, k) => {
      const angle = (k / count) * 2 * Math.PI - Math.PI / 2; // first pin at top
      posById[id] = offsetLatLng(centroid, angle, radiusPx * mpp);
      clusteredIds.add(id);
    });
    clusters.push({ centroid, radiusPx, count });
  }
  return { posById, clusteredIds, clusters };
}

// ═════════════════════════════════════════════════════════════════════════════
export default function RouteMap({ stops, selectedId }) {
  const ref = useRef(null);
  const map = useRef(null);
  const markers = useRef([]); // [{marker, stopId}]
  const haloCircles = useRef([]); // faint backing circles behind fanned clusters
  const layoutInputs = useRef({ ids: [], coords: {} }); // for re-layout on zoom
  const route = useRef(null);
  const nextRoute = useRef(null); // directions to next stop
  const prevSet = useRef("");
  const locMarker = useRef(null);
  const watchId = useRef(null);
  const userLoc = useRef(null); // latest GPS coords
  const [ready, setReady] = useState(false);
  const [userLocState, setUserLocState] = useState(null); // mirror of userLoc.current, to re-run the directions effect
  const [coords, setCoords] = useState({});
  const [parcelsOn, setParcelsOn] = useState(false);
  const [mapZoom, setMapZoom] = useState(11);
  const parcelHandle = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadMaps().then(() => { if (!cancelled) setReady(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Unmount teardown: the marker/route effect only clears its previous output at
  // the START of its next run, so on unmount the markers, halo circles, and
  // route/next-route polylines stayed attached to the map and any in-flight OSRM
  // draw could resolve onto a dead map. Repeatedly toggling Route↔Pipeline over a
  // long shift accreted detached Google Maps overlays. Clean them all up here.
  useEffect(() => {
    return () => {
      try { if (route._cancelOSRM) route._cancelOSRM(); } catch {}
      try { markers.current.forEach(m => m.marker.setMap(null)); } catch {}
      try { haloCircles.current.forEach(c => c.setMap(null)); } catch {}
      try { route.current?.setMap(null); } catch {}
      try { nextRoute.current?.setMap(null); } catch {}
      markers.current = []; haloCircles.current = [];
      route.current = null; nextRoute.current = null;
    };
  }, []);

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
        // Mirror the fix into state so the "directions to next stop" effect
        // actually re-runs when the FIRST GPS lock lands (it arrives seconds
        // after geocoding, so a ref-only value left the guide line undrawn) and
        // as the truck moves. Throttled to ~75m so we don't re-fetch the route
        // on every high-accuracy tick.
        setUserLocState(prev => (!prev || metersBetween(prev, latlng) > 75) ? latlng : prev);
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
    haloCircles.current.forEach(c => c.setMap(null)); haloCircles.current = [];
    if (route._cancelOSRM) { route._cancelOSRM(); delete route._cancelOSRM; }
    if (route.current) { route.current.setMap(null); route.current = null; }
    if (!Object.keys(coords).length) return;

    // Spread stops whose pins overlap on screen at the current zoom. Clustering
    // is by pixel distance (recomputed live on zoom — see the zoom_changed
    // listener below) so pins separate as you zoom in and re-merge sensibly out.
    const zoom = map.current.getZoom() ?? 11;
    const idsWithPos = stops.filter(s => coords[s.id]).map(s => s.id);
    const { posById, clusters } = computeClusterLayout(idsWithPos, coords, zoom);

    // Faint backing circle behind each fanned cluster — a visual cue that
    // these pins are one grouped location fanned out for legibility, not
    // several genuinely separate addresses.
    haloCircles.current = clusters.map(({ centroid, radiusPx, count }) => {
      const mpp = metersPerPixel(centroid.lat, zoom);
      return new window.google.maps.Circle({
        map: map.current, center: centroid,
        radius: (radiusPx + MARKER_PX / 2 + 4) * mpp,
        fillColor: "#ffffff", fillOpacity: 0.07,
        strokeColor: "#ffffff", strokeOpacity: 0.18, strokeWeight: 1,
        clickable: false, zIndex: 1,
      });
    });
    layoutInputs.current = { ids: idsWithPos, coords };

    const positions = [];
    const bounds = new window.google.maps.LatLngBounds();
    let n = 0;
    stops.forEach(s => {
      if (!coords[s.id]) return;
      const pos = posById[s.id]; if (!pos) return; n++;
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

    // Full route polyline — FREE OSRM routing, straight-line fallback.
    // This used to call Google's paid Directions API and re-fire on every
    // redraw (including every stop tap), running up a large monthly bill for
    // what is only a cosmetic overview line. Turn-by-turn navigation happens
    // via the native Google Maps hand-off (free), so this line never needed a
    // paid API. A signature guard also skips redraws when the route is
    // unchanged, so we don't hammer the free OSRM endpoint either.
    if (positions.length >= 2) {
      let staleRoute = false;
      const drawRoute = async () => {
        const path = await fetchOSRMPath(positions);
        if (staleRoute || route.current) return;
        route.current = new window.google.maps.Polyline({
          path: path || positions,
          strokeColor:"#039BE5", strokeOpacity: path ? .6 : .4,
          strokeWeight: path ? 3 : 2, map:map.current,
        });
      };
      drawRoute();
      route._cancelOSRM = () => { staleRoute = true; };
    }

    // Fit bounds only when stop SET changes
    const set = [...stops.map(s=>s.id)].sort().join(",");
    if (positions.length > 0 && set !== prevSet.current) {
      map.current.fitBounds(bounds, {top:20,right:20,bottom:20,left:20});
      prevSet.current = set;
    }
    // NOTE: selectedId is deliberately NOT a dependency. Selection visuals are
    // handled entirely by the separate HIGHLIGHT effect (marker.setIcon/etc.),
    // so re-running this heavy marker+route rebuild on every stop tap was pure
    // waste — and back when the route line used the paid Directions API, each
    // tap fired a billable request. Keep it keyed only to real data changes.
  }, [coords, stops]);

  // ── RE-CLUSTER MARKERS ON ZOOM ─────────────────────────────────────────
  // Which pins overlap depends on zoom, so we recompute the whole layout each
  // time it changes: pins that were fanned out merge/separate naturally, and
  // separation stays constant on screen at any zoom level.
  useEffect(() => {
    if (!map.current) return;
    const listener = map.current.addListener("zoom_changed", () => {
      const zoom = map.current.getZoom();
      if (zoom == null) return;
      setMapZoom(zoom);
      const { ids, coords: c } = layoutInputs.current;
      if (!ids.length) return;
      const { posById, clusters } = computeClusterLayout(ids, c, zoom);
      markers.current.forEach(({ marker, stopId }) => {
        const p = posById[stopId];
        if (p) marker.setPosition(p);
      });
      haloCircles.current.forEach(circle => circle.setMap(null));
      haloCircles.current = clusters.map(({ centroid, radiusPx }) => {
        const mpp = metersPerPixel(centroid.lat, zoom);
        return new window.google.maps.Circle({
          map: map.current, center: centroid,
          radius: (radiusPx + MARKER_PX / 2 + 4) * mpp,
          fillColor: "#ffffff", fillOpacity: 0.07,
          strokeColor: "#ffffff", strokeOpacity: 0.18, strokeWeight: 1,
          clickable: false, zIndex: 1,
        });
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
    const from = userLocState || userLoc.current;
    if (!firstStop || !coords[firstStop.id] || !from) return;

    // Free OSRM (with straight-line fallback) for the current-location→next-stop
    // guide line — same reasoning as the full route: it's a cosmetic overlay,
    // and turn-by-turn nav is the native Google Maps hand-off, so it doesn't
    // need the paid Directions API.
    (async () => {
      const to = coords[firstStop.id];
      const path = await fetchOSRMPath([from, to]);
      if (stale) return;
      nextRoute.current = new window.google.maps.Polyline({
        path: path || [from, to],
        strokeColor: "#FFD600", strokeOpacity: path ? .8 : .5,
        strokeWeight: path ? 5 : 3, map: map.current,
      });
    })();
    return () => {
      stale = true;
      if (nextRoute.current) { nextRoute.current.setMap(null); nextRoute.current = null; }
    };
  }, [coords, stops, ready, userLocState]);

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
