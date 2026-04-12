import { useState, useRef, useEffect } from "react";

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

// ═════════════════════════════════════════════════════════════════════════════
export default function RouteMap({ stops, selectedId }) {
  const ref = useRef(null);
  const map = useRef(null);
  const markers = useRef([]); // [{marker, stopId}]
  const route = useRef(null);
  const nextRoute = useRef(null); // directions to next stop
  const prevSet = useRef("");
  const locMarker = useRef(null);
  const watchId = useRef(null);
  const userLoc = useRef(null); // latest GPS coords
  const [ready, setReady] = useState(false);
  const [coords, setCoords] = useState({});

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
    if (route.current) { route.current.setMap(null); route.current = null; }
    if (!Object.keys(coords).length) return;

    const positions = [];
    const bounds = new window.google.maps.LatLngBounds();
    let n = 0;
    stops.forEach(s => {
      const pos = coords[s.id]; if (!pos) return; n++;
      const isAM = (s.window||"").startsWith("AM");
      const pinColor = isAM ? AM_COLOR : PM_COLOR;
      const hasConstraint = !!s.constraint;
      const isSel = s.id === selectedId;
      const m = new window.google.maps.Marker({
        position:pos, map:map.current,
        label:{text:String(n),color:"#fff",fontWeight:"800",fontSize: isSel ? "11px" : "10px"},
        icon:{path:window.google.maps.SymbolPath.CIRCLE,
          scale: isSel ? 12 : 10,
          fillColor:pinColor, fillOpacity: s.db ? .7 : 1,
          strokeColor: isSel ? "#FFD600" : hasConstraint ? "#FF4081" : "#fff",
          strokeWeight: isSel ? 3 : hasConstraint ? 2 : 1.5},
        zIndex: isSel ? 20 : 10,
      });
      markers.current.push({ marker: m, stopId: s.id });
      positions.push(pos); bounds.extend(pos);
    });

    // Full route polyline
    if (positions.length >= 2) {
      try {
        new window.google.maps.DirectionsService().route({
          origin:positions[0], destination:positions[positions.length-1],
          waypoints:positions.slice(1,-1).map(p=>({location:p,stopover:true})).slice(0,23),
          travelMode:window.google.maps.TravelMode.DRIVING, optimizeWaypoints:false,
        }, (result, status) => {
          if (status === "OK") {
            route.current = new window.google.maps.DirectionsRenderer({
              map:map.current, directions:result, suppressMarkers:true, preserveViewport:true,
              polylineOptions:{strokeColor:"#039BE5",strokeOpacity:.6,strokeWeight:3},
            });
          } else {
            route.current = new window.google.maps.Polyline({
              path:positions, strokeColor:"#039BE5", strokeOpacity:.4, strokeWeight:2, map:map.current,
            });
          }
        });
      } catch(e) {
        route.current = new window.google.maps.Polyline({
          path:positions, strokeColor:"#039BE5", strokeOpacity:.4, strokeWeight:2, map:map.current,
        });
      }
    }

    // Fit bounds only when stop SET changes
    const set = [...stops.map(s=>s.id)].sort().join(",");
    if (positions.length > 0 && set !== prevSet.current) {
      map.current.fitBounds(bounds, {top:20,right:20,bottom:20,left:20});
      prevSet.current = set;
    }
  }, [coords, stops, selectedId]);

  // ── DIRECTIONS FROM CURRENT LOCATION TO NEXT STOP ─────────────────────
  useEffect(() => {
    if (!map.current) return;
    if (nextRoute.current) { nextRoute.current.setMap(null); nextRoute.current = null; }
    // Next stop = first stop in list
    const firstStop = stops[0];
    if (!firstStop || !coords[firstStop.id] || !userLoc.current) return;

    try {
      new window.google.maps.DirectionsService().route({
        origin: userLoc.current,
        destination: coords[firstStop.id],
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (result, status) => {
        if (status === "OK") {
          nextRoute.current = new window.google.maps.DirectionsRenderer({
            map: map.current, directions: result, suppressMarkers: true, preserveViewport: true,
            polylineOptions: { strokeColor: "#FFD600", strokeOpacity: .8, strokeWeight: 5 },
          });
        }
      });
    } catch(e) {}
  }, [coords, stops, ready]);

  // ── HIGHLIGHT SELECTED MARKER ──────────────────────────────────────────
  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach(({ marker, stopId }) => {
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
      marker.setZIndex(isSel ? 20 : 10);
      marker.setLabel({ text: marker.getLabel().text, color: "#fff", fontWeight: "800", fontSize: isSel ? "11px" : "10px" });
    });
  }, [selectedId]);

  return <div ref={ref} style={{width:"100%",height:200,background:"#10131a"}}>{!ready && <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#5a6580",fontSize:12}}>Loading map...</div>}</div>;
}
