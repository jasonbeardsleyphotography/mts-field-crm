import { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS MINIMAL — Pure Route. Nothing else.
   Built for bright sun, one thumb, between-stops glances.
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SCOPES = "https://www.googleapis.com/auth/calendar";

// ── COLORS ───────────────────────────────────────────────────────────────────
const STAGE_COLORS = { "10":"#0B8043","3":"#8E24AA","7":"#039BE5","1":"#7986CB","5":"#F6BF26","4":"#E67C73","2":"#33B679","11":"#D50000","9":"#3F51B5","8":"#616161" };
function stageColor(colorId) { return STAGE_COLORS[colorId] || "#039BE5"; }
const AM_COLOR = "#2E7D32"; // green for AM stops
const PM_COLOR = "#1E88E5"; // blue for PM stops

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getBusinessDays(n) {
  const days = []; let d = new Date(); d.setHours(0,0,0,0);
  while (days.length < n) { if (d.getDay()!==0 && d.getDay()!==6) days.push(new Date(d)); d.setDate(d.getDate()+1); }
  return days;
}

// ── EVENT PARSER ─────────────────────────────────────────────────────────────
function parseEvent(ev) {
  const s = ev.summary || "", rd = ev.description || "";
  const desc = rd.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();

  // Filter: skip MTS NOTE and ***NOTE!*** events
  if (/MTS NOTE/i.test(s) || /\*{2,}NOTE[!]*\*{2,}/i.test(s)) return null;

  // Parse fields
  const jobMatch = s.match(/Task \| #(\d+)/);
  const jobNum = jobMatch ? jobMatch[1] : null;
  const nameMatch = s.match(/Task \| #\d+\s+[^-]+\s*-\s*([^-]+?)(?:\s*-\s*(.*))?$/);
  const clientName = nameMatch ? nameMatch[1].trim() : s.replace(/^TODO:\s*/i,"").replace(/^TASK\s+/i,"").trim();
  const addrMatch = s.match(/Task \| #\d+\s+([^-]+?)\s*-/);
  const address = ev.location || (addrMatch ? addrMatch[1].trim() : "");

  const mobileMatch = desc.match(/Mobile:\s*([\d\-(). +]+?)(?:\s*$|\s*Email)/);
  const phoneMatch = desc.match(/Phone:\s*([\d\-(). +]+?)(?:\s*$|\s*Mobile)/);
  const phone = (mobileMatch && mobileMatch[1].trim().length > 5 ? mobileMatch[1].trim() : "") || (phoneMatch && phoneMatch[1].trim().length > 5 ? phoneMatch[1].trim() : "");
  const emailMatch = desc.match(/Email:\s*(\S+@\S+)/);
  const email = emailMatch ? emailMatch[1].trim() : "";
  const notesMatch = desc.match(/Notes:\s*([\s\S]*)/);
  const notes = notesMatch ? notesMatch[1].replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim() : "";

  const isDriveBy = /drive[\s-]?by/i.test(s);
  const isTask = /^Task\b/i.test(s); // real appointment from SingleOps
  const isTodo = /^TODO:/i.test(s);
  const isAdmin = (ev.colorId === "8" || ev.colorId === "11") && !isTask && !isTodo;

  // Window detection: AM or PM based on start hour, DB is separate flag
  const start = new Date(ev.start?.dateTime || ev.start?.date);
  const end = new Date(ev.end?.dateTime || ev.end?.date);
  const startH = start.getHours() + start.getMinutes()/60;
  const durH = (end - start) / 36e5;
  let window = startH < 10.5 ? "AM" : "PM";
  const fmt = d => d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(":00","");
  const timeLabel = fmt(start) + "–" + fmt(end);

  // Constraints — extracted from title + time analysis
  let constraint = "";
  if (/CALL (WHEN|FIRST|BEFORE|OTW)/i.test(s)) constraint = "📞 CALL FIRST";
  if (/NOT BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/NOT BEFORE\s*([\d:]+)/i)[1];
  if (/([\d:]+)\s*OR LATER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + s.match(/([\d:]+)\s*OR LATER/i)[1] + " or later";
  if (/CAN'?T MEET BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CAN'?T MEET BEFORE\s*([\d:]+)/i)[1];
  if (/CANNOT MEET BEFORE\s*(\w+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CANNOT MEET BEFORE\s*(\w+)/i)[1];
  if (/CAN'?T MEET (PAST|AFTER)\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Before " + s.match(/CAN'?T MEET (?:PAST|AFTER)\s*([\d:]+)/i)[1];
  if (/CAN'?T MEET OUTSIDE/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "⏰ " + fmt(start) + "–" + fmt(end) + " ONLY";
  if (/EARLIER IS BETTER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "⏰ EARLIER IS BETTER";
  if (/MEET (?:AT |.+?AT )(.+?)$/i.test(s)) { const m = s.match(/MEET (?:AT |.+?AT )(.+?)$/i); if (m) constraint = (constraint ? constraint + " · " : "") + "📍 " + m[1].slice(0,40); }
  if (/YARD STICK/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "🪧 Yard stick";
  if (/WE CAN MOVE/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "↔ Flexible";
  // Detect tight/unusual windows (not standard 4hr AM or PM) — if no constraint set yet
  if (!constraint && !isDriveBy && durH < 3) constraint = "⏰ " + fmt(start) + "–" + fmt(end);

  // Extract title context: everything after "On Site Estimate" or "DRIVE BY" in title
  let titleContext = "";
  if (nameMatch && nameMatch[2]) {
    // nameMatch[2] = everything after client name, e.g. "On Site Estimate - COMING FROM BUFFALO; CAN'T MEET BEFORE 9:00 - CELL..."
    let suffix = nameMatch[2].trim();
    // Strip known visit types
    suffix = suffix.replace(/^On Site (?:Estimate|Site)\s*[-–]?\s*/i, "");
    suffix = suffix.replace(/^DRIVE[\s-]?BY\s*[-–]?\s*/i, "");
    // What's left is the extra context
    if (suffix.length > 2) titleContext = suffix;
  }

  const color = stageColor(ev.colorId);

  return {
    id: ev.id, cn: clientName, addr: address, phone, email, notes, desc,
    jn: jobNum, db: isDriveBy, isTask, isTodo, isAdmin, constraint, color,
    colorId: ev.colorId, raw: s, rawD: rd, window, timeLabel, titleContext,
  };
}

// ── GOOGLE CALENDAR API ──────────────────────────────────────────────────────
async function fetchEvents(token, dayStart, dayEnd) {
  const url = `${CAL_BASE}/events?timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250&timeZone=America/New_York`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return ((await res.json()).items || []);
}

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
async function geocode(addr) {
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

// ── GOOGLE MAPS ──────────────────────────────────────────────────────────────
const DARK_STYLE = [
  {elementType:"geometry",stylers:[{color:"#10131a"}]},
  {elementType:"labels.text.stroke",stylers:[{color:"#10131a"}]},
  {elementType:"labels.text.fill",stylers:[{color:"#5a6580"}]},
  {featureType:"road",elementType:"geometry",stylers:[{color:"#1e2940"}]},
  {featureType:"road.highway",elementType:"geometry",stylers:[{color:"#2a3a55"}]},
  {featureType:"water",elementType:"geometry",stylers:[{color:"#080a10"}]},
  {featureType:"poi",stylers:[{visibility:"off"}]},
  {featureType:"transit",stylers:[{visibility:"off"}]},
];

let mapsPromise = null;
function loadMaps() {
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

function RouteMap({ stops }) {
  const ref = useRef(null);
  const map = useRef(null);
  const markers = useRef([]);
  const route = useRef(null);
  const prevSet = useRef("");
  const [ready, setReady] = useState(false);
  const [coords, setCoords] = useState({});

  useEffect(() => { loadMaps().then(() => setReady(true)).catch(() => {}); }, []);

  // Create map once
  useEffect(() => {
    if (!ready || !ref.current || map.current) return;
    map.current = new window.google.maps.Map(ref.current, {
      center:{lat:43.12,lng:-77.50}, zoom:11, styles:DARK_STYLE,
      disableDefaultUI:true, gestureHandling:"greedy", backgroundColor:"#10131a",
      zoomControl:false, mapTypeControl:false, streetViewControl:false,
      fullscreenControl:false, keyboardShortcuts:false, clickableIcons:false,
    });
  }, [ready]);

  // Geocode
  useEffect(() => {
    if (!ready || !stops.length) return;
    let dead = false;
    (async () => {
      const c = {};
      for (let i = 0; i < stops.length; i++) {
        if (dead) break;
        const r = await geocode(stops[i].addr);
        if (r) c[stops[i].id] = r;
        if (i < stops.length - 1) await new Promise(r => setTimeout(r, 200));
      }
      if (!dead) setCoords(c);
    })();
    return () => { dead = true; };
  }, [ready, stops.map(s => s.id + s.addr).join(",")]);

  // Markers + route
  useEffect(() => {
    if (!map.current) return;
    markers.current.forEach(m => m.setMap(null)); markers.current = [];
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
      const m = new window.google.maps.Marker({
        position:pos, map:map.current,
        label:{text:String(n),color:"#fff",fontWeight:"800",fontSize:"10px"},
        icon:{path:window.google.maps.SymbolPath.CIRCLE,
          scale:10,
          fillColor:pinColor, fillOpacity:s.db?.7:1,
          strokeColor:hasConstraint?"#FF4081":"#fff",
          strokeWeight:hasConstraint?2:1.5},
        zIndex:10,
      });
      markers.current.push(m);
      positions.push(pos); bounds.extend(pos);
    });

    // Route line
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
              polylineOptions:{strokeColor:"#039BE5",strokeOpacity:.7,strokeWeight:4},
            });
          } else {
            route.current = new window.google.maps.Polyline({
              path:positions, strokeColor:"#039BE5", strokeOpacity:.5, strokeWeight:3, map:map.current,
            });
          }
        });
      } catch(e) {
        route.current = new window.google.maps.Polyline({
          path:positions, strokeColor:"#039BE5", strokeOpacity:.5, strokeWeight:3, map:map.current,
        });
      }
    }

    // Only refit when stop SET changes
    const set = [...stops.map(s=>s.id)].sort().join(",");
    if (positions.length > 0 && set !== prevSet.current) {
      map.current.fitBounds(bounds, {top:20,right:20,bottom:20,left:20});
      prevSet.current = set;
    }
  }, [coords, stops]);

  return <div ref={ref} style={{width:"100%",height:200,background:"#10131a"}}>{!ready && <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"#5a6580",fontSize:12}}>Loading map...</div>}</div>;
}

// ── SWIPE CARD ───────────────────────────────────────────────────────────────
function SwipeCard({ children, onSwipeRight, onSwipeLeft, enabled }) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const sx = useRef(0), sy = useRef(0), dir = useRef(null);

  const ts = e => { if(!enabled)return; sx.current=e.touches[0].clientX; sy.current=e.touches[0].clientY; dir.current=null; setSwiping(true); };
  const tm = e => { if(!swiping||!enabled)return; const dx=e.touches[0].clientX-sx.current, dy=e.touches[0].clientY-sy.current;
    if(dir.current===null&&(Math.abs(dx)>8||Math.abs(dy)>8)) dir.current=Math.abs(dx)>Math.abs(dy)?"h":"v";
    if(dir.current==="h"){e.preventDefault();e.stopPropagation();setOffset(dx);}
  };
  const te = () => { if(offset>100&&onSwipeRight)onSwipeRight(); else if(offset<-100&&onSwipeLeft)onSwipeLeft(); setOffset(0);setSwiping(false);dir.current=null; };

  const abs = Math.abs(offset), reveal = Math.min(abs/80,1), opacity = 1-Math.min(abs/250,.5), right = offset>0;

  return <div style={{position:"relative",overflow:"hidden"}}>
    {abs>20 && <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:right?"flex-start":"flex-end",justifyContent:"center",padding:"0 20px",opacity:reveal,background:right?"rgba(51,182,121,.1)":"rgba(3,155,229,.1)"}}>
      <div style={{fontSize:20,fontWeight:800,color:right?"#33B679":"#039BE5"}}>{right?"✓":"🧭"}</div>
      <div style={{fontSize:12,fontWeight:700,color:right?"#33B679":"#039BE5",marginTop:2}}>{right?"Done":"Navigate"}</div>
    </div>}
    <div onTouchStart={ts} onTouchMove={tm} onTouchEnd={te}
      style={{transform:`translateX(${offset}px)`,opacity,transition:swiping?"none":"transform .25s,opacity .25s",position:"relative",zIndex:1,touchAction:"pan-y"}}>
      {children}
    </div>
  </div>;
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  // Restore cached token if still valid (tokens last ~1 hour)
  const [token, setToken] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
      if (saved && saved.expiry > Date.now()) return saved.token;
    } catch(e) {}
    return null;
  });
  const saveToken = (t) => {
    setToken(t);
    if (t) {
      // Cache token with 55-min expiry (tokens last 60 min, leave 5 min buffer)
      localStorage.setItem("mts-token", JSON.stringify({ token: t, expiry: Date.now() + 55 * 60 * 1000 }));
    } else {
      localStorage.removeItem("mts-token");
    }
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rawEvents, setRawEvents] = useState({});
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(10));
  const [selDay, setSelDay] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [dismissed, setDismissed] = useState({});
  const [completedOpen, setCompletedOpen] = useState(false);
  const [textSheet, setTextSheet] = useState(null); // stop object when text sheet is open
  const [otwMinutes, setOtwMinutes] = useState(null); // null = choosing, number = selected
  const [mapOpen, setMapOpen] = useState(true);
  const [undoStack, setUndoStack] = useState([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [moving, setMoving] = useState(null);
  // Load saved order from localStorage, fall back to empty
  const [ordIds, setOrdIds] = useState(() => {
    try { const saved = localStorage.getItem("mts-route-order"); return saved ? JSON.parse(saved) : {}; }
    catch(e) { return {}; }
  });

  // Persist ordIds to localStorage whenever they change
  useEffect(() => {
    try { localStorage.setItem("mts-route-order", JSON.stringify(ordIds)); } catch(e) {}
  }, [ordIds]);

  // ── AUTH ─────────────────────────────────────────────────────────────────
  const initAuth = useCallback(() => {
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: r => { if (r.access_token) { saveToken(r.access_token); setError(null); } else setError("Sign-in failed"); },
    }).requestAccessToken();
  }, []);

  // ── LOAD ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const days = getBusinessDays(10);
      setBusinessDays(days);
      const all = {};
      for (const day of days) {
        const s = new Date(day); s.setHours(0,0,0,0);
        const e = new Date(day); e.setHours(23,59,59,999);
        all[day.toDateString()] = await fetchEvents(token, s, e);
      }
      setRawEvents(all); setSelDay(0); setDismissed({}); setExpanded(null); setReorderMode(false); setMoving(null);
      // Don't reset ordIds — preserve saved reorder from localStorage
    } catch (e) {
      setError(e.message);
      if (e.message.includes("401")) saveToken(null);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // ── PARSE ────────────────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  const allParsed = useMemo(() => {
    const raw = rawEvents[dayKey] || [];
    return raw.map(parseEvent).filter(Boolean).filter(s => !s.isAdmin && !s.isTodo);
  }, [rawEvents, dayKey]);

  // Initialize order: tasks first, then TD items — all reorderable together
  useEffect(() => {
    if (!dayKey || !allParsed.length) return;
    const saved = ordIds[dayKey] || [];
    const parsedIds = allParsed.map(s => s.id);
    if (!saved.length) {
      // Default order: tasks first, TDs at bottom
      const tasks = allParsed.filter(s => s.isTask).map(s => s.id);
      const tds = allParsed.filter(s => !s.isTask).map(s => s.id);
      setOrdIds(prev => ({...prev, [dayKey]: [...tasks, ...tds]}));
      return;
    }
    const newIds = parsedIds.filter(id => !saved.includes(id));
    const validSaved = saved.filter(id => parsedIds.includes(id));
    if (newIds.length > 0 || validSaved.length !== saved.length) {
      setOrdIds(prev => ({...prev, [dayKey]: [...validSaved, ...newIds]}));
    }
  }, [dayKey, allParsed]);

  const stopMap = useMemo(() => { const m = {}; allParsed.forEach(s => m[s.id] = s); return m; }, [allParsed]);
  const currentOrder = (ordIds[dayKey]?.length > 0) ? ordIds[dayKey] : allParsed.map(s => s.id);
  const stops = currentOrder.map(id => stopMap[id]).filter(Boolean);

  const active = useMemo(() => stops.filter(s => !dismissed[s.id]), [stops, dismissed]);
  const completed = useMemo(() => stops.filter(s => dismissed[s.id]), [stops, dismissed]);
  // Only task items go on the map
  const mapStops = useMemo(() => active.filter(s => s.isTask), [active]);

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  const dismiss = id => { setUndoStack(u => [...u, {type:"dismiss",id}]); setDismissed(p => ({...p,[id]:true})); setExpanded(null); };
  const undo = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length-1];
    setUndoStack(u => u.slice(0,-1));
    if (last.type === "dismiss") setDismissed(p => { const n={...p}; delete n[last.id]; return n; });
    if (last.type === "reorder") setOrdIds(prev => ({...prev, [dayKey]: last.prevOrder}));
  };
  const navigate = addr => {
    if (!addr) return;
    const q = encodeURIComponent(addr);
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isIOS) {
      // Apple Maps opens natively on iPhone — no prompt, no page replacement
      window.open(`https://maps.apple.com/?daddr=${q}`, "_blank");
    } else {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${q}`, "_blank");
    }
  };

  // Reorder: tap to pick up, tap destination to place
  const handleReorderTap = (idx) => {
    if (!reorderMode) return;
    if (moving === null) {
      // Pick up this card
      setMoving(idx);
      setExpanded(null);
    } else if (moving === idx) {
      // Tapped same card — deselect
      setMoving(null);
    } else {
      // Drop: move the picked card to this position
      const activeIds = active.map(s => s.id);
      const prevOrder = [...(ordIds[dayKey] || currentOrder)];
      const fromId = activeIds[moving];
      const toId = activeIds[idx];

      // Work on full order (including dismissed)
      const fullOrder = [...prevOrder];
      const fromIdx = fullOrder.indexOf(fromId);
      fullOrder.splice(fromIdx, 1);
      const toIdx = fullOrder.indexOf(toId);
      fullOrder.splice(moving < idx ? toIdx + 1 : toIdx, 0, fromId);

      setUndoStack(u => [...u, {type:"reorder", prevOrder}]);
      setOrdIds(prev => ({...prev, [dayKey]: fullOrder}));
      setMoving(null);
    }
  };

  const navAll = useCallback(() => {
    const a = mapStops.filter(s=>s.addr).map(s=>s.addr);
    if (!a.length) return;
    if (a.length === 1) { navigate(a[0]); return; }
    // Multi-stop: use Google Maps URL (opens in new tab, iOS may offer to open in app)
    const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(a[0])}&destination=${encodeURIComponent(a[a.length-1])}${a.length>2?`&waypoints=${a.slice(1,-1).map(encodeURIComponent).join("|")}`:""}`;
    window.open(url, "_blank");
  }, [mapStops]);
  const hasStopsWithAddr = mapStops.some(s => s.addr);

  // Day labels
  const dayLabels = businessDays.map(d => {
    const isToday = d.toDateString() === new Date().toDateString();
    return d.toLocaleDateString("en-US",{weekday:"short",month:"numeric",day:"numeric"}) + (isToday ? " ★" : "");
  });

  // ── SIGN IN ──────────────────────────────────────────────────────────────
  if (!token) return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0a0c12",fontFamily:"'DM Sans',system-ui,sans-serif",color:"#f0f4fa",padding:20}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700;800&display=swap" rel="stylesheet"/>
      <div style={{fontSize:32,fontWeight:800,letterSpacing:-1}}>MTS</div>
      <div style={{fontSize:13,color:"#5a6580",marginBottom:32,fontWeight:500}}>Field Route</div>
      <button onClick={initAuth} style={{padding:"16px 40px",borderRadius:12,background:"#1a2240",border:"1px solid #2a3560",color:"#f0f4fa",fontSize:16,fontWeight:700,cursor:"pointer",letterSpacing:.5}}>Sign in with Google</button>
      {error && <div style={{marginTop:16,color:"#ff5555",fontSize:12}}>{error}</div>}
    </div>
  );

  if (loading && !Object.keys(rawEvents).length) return (
    <div style={{height:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0c12",color:"#5a6580",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:700}}>Loading...</div></div>
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div style={{height:"100dvh",width:"100%",background:"#0a0c12",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',system-ui,sans-serif",color:"#f0f4fa",overflow:"hidden"}}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <style>{`.scr::-webkit-scrollbar{width:0}.gmnoprint,.gm-bundled-control,.gm-style-cc,.gm-control-active,.gm-fullscreen-control,.gm-style .adp,.gm-style button[title]{display:none!important}`}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:5,padding:"8px 10px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0}}>
        <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setDismissed({});setReorderMode(false);setMoving(null);}} style={{padding:"6px 8px",borderRadius:8,border:"1px solid #1a2030",background:"#0a0c12",color:"#f0f4fa",fontSize:13,fontWeight:700,cursor:"pointer",outline:"none",appearance:"auto"}}>
          {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
        </select>
        <div style={{flex:1}}/>
        <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}} style={{padding:"5px 10px",borderRadius:8,background:reorderMode?"rgba(142,36,170,.15)":"#1a2240",border:`1px solid ${reorderMode?"rgba(142,36,170,.4)":"#2a3560"}`,color:reorderMode?"#c8a0e8":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}>{reorderMode?"✕ Done":"↕ Reorder"}</button>
        {hasStopsWithAddr && !reorderMode && <button onClick={navAll} style={{padding:"5px 10px",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:11,fontWeight:700,cursor:"pointer"}}>🧭 All</button>}
        <button onClick={undo} disabled={!undoStack.length} style={{width:34,height:34,borderRadius:8,background:undoStack.length?"#1a2240":"transparent",border:"1px solid #1a2030",color:undoStack.length?"#f0f4fa":"#2a3050",fontSize:13,cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center"}}>↩</button>
      </div>

      {/* ── MAP ────────────────────────────────────────────────────────── */}
      <div style={{flexShrink:0,borderBottom:"1px solid #1a2030"}}>
        <button onClick={()=>setMapOpen(!mapOpen)} style={{width:"100%",padding:"4px 12px",background:"none",border:"none",color:"#3a4560",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
          <span style={{transform:mapOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7}}>▶</span>
          {mapOpen?"hide map":"show map"}
        </button>
        {/* Reorder mode banner */}
        {reorderMode && <div style={{padding:"5px 12px",background:"rgba(142,36,170,.08)",borderTop:"1px solid rgba(142,36,170,.15)",display:"flex",alignItems:"center",gap:8}}>
          {moving !== null ? <>
            <div style={{width:10,height:10,borderRadius:10,background:active[moving]?.color||"#8E24AA"}}/>
            <span style={{fontSize:12,fontWeight:600,color:"#c8a0e8"}}>Moving: {active[moving]?.cn} — tap where to place</span>
            <button onClick={()=>setMoving(null)} style={{marginLeft:"auto",padding:"3px 10px",borderRadius:6,background:"#1a2240",border:"none",color:"#90a8c0",fontSize:10,fontWeight:700,cursor:"pointer"}}>Cancel</button>
          </> : <span style={{fontSize:12,fontWeight:500,color:"#9a80c8"}}>↕ Tap a stop to pick it up</span>}
        </div>}
        {mapOpen && mapStops.length>0 && <RouteMap stops={mapStops}/>}
      </div>

      {/* ── STOP LIST ──────────────────────────────────────────────────── */}
      <div className="scr" style={{flex:1,overflowY:"auto",paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
        {active.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No stops</div>}

        {(()=>{ let taskNum = 0; return active.map((s, idx) => {
          if (s.isTask) taskNum++;
          const isNext = idx === 0 && !reorderMode && s.isTask;
          const isExp = expanded === s.id && !reorderMode;
          const isMov = moving === idx;
          const isAM = (s.window||"").startsWith("AM");
          const circleColor = s.isTask ? (isAM ? AM_COLOR : PM_COLOR) : "#2a2040";
          const winColor = isAM ? "#4CAF50" : "#5a9ec8";
          const winBg = isAM ? "rgba(46,125,50,.12)" : "rgba(30,136,229,.12)";

          return <SwipeCard key={s.id} enabled={!reorderMode} onSwipeRight={() => dismiss(s.id)} onSwipeLeft={() => navigate(s.addr)}>
            <div onClick={() => { if (reorderMode) handleReorderTap(idx); else setExpanded(isExp ? null : s.id); }} style={{
              padding:"14px 16px", borderBottom:"1px solid #0e1220",
              cursor: reorderMode ? "grab" : "pointer",
              background: isMov ? "rgba(142,36,170,.08)" : isNext ? "#0e1525" : reorderMode ? "#0a0c12" : "transparent",
              borderLeft: `4px solid ${isMov ? "#8E24AA" : isNext ? circleColor : "transparent"}`,
              opacity: reorderMode && !isMov && moving !== null ? .5 : 1,
              transition: "opacity .15s",
            }}>
              {/* Main row: number + name + window badge + phone */}
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:isNext?38:32,height:isNext?38:32,borderRadius:"50%",background:circleColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:s.isTask?(isNext?16:14):9,fontWeight:800,color:s.isTask?"#fff":"#9a80c8",flexShrink:0,border:s.db?"2px dashed rgba(255,255,255,.4)":isMov?"2px solid #8E24AA":!s.isTask?"1px solid #3a3060":"none",letterSpacing:s.isTask?0:-.5}}>{s.isTask?taskNum:"TD"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:isNext?18:16,fontWeight:isNext?800:s.isTask?700:600,color:s.isTask?"#f0f4fa":"#c0b8d8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{isNext?"▸ ":""}{s.cn}</div>
                  {s.addr && <div style={{fontSize:11,color:"#5a6a80",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.addr}</div>}
                </div>
                {/* Window badge: AM/PM for tasks, time range for TDs */}
                {s.isTask && s.window && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:800,color:winColor,background:winBg,border:`1px solid ${winColor}30`,flexShrink:0,letterSpacing:.5}}>{s.window}</span>}
                {s.isTask && s.db && <span style={{padding:"3px 6px",borderRadius:6,fontSize:9,fontWeight:800,color:"#c8a820",background:"rgba(200,168,32,.12)",border:"1px solid rgba(200,168,32,.3)",flexShrink:0,letterSpacing:.5}}>DB</span>}
                {!s.isTask && s.timeLabel && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:700,color:"#6a6090",background:"rgba(100,80,160,.1)",border:"1px solid rgba(100,80,160,.2)",flexShrink:0}}>{s.timeLabel}</span>}
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>e.stopPropagation()} style={{padding:"5px 10px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:12,textDecoration:"none",fontWeight:700,flexShrink:0}}>📞</a>}
              </div>

              {/* Constraint — bright and prominent */}
              {s.constraint && !reorderMode && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(200,90,158,.1)",border:"1px solid rgba(200,90,158,.2)",color:"#e880b0",fontSize:12,fontWeight:700,display:"inline-block"}}>{s.constraint}</div>}

              {/* Title context — extra info from the event title */}
              {s.titleContext && !reorderMode && <div style={{marginTop:4,marginLeft:isNext?50:44,fontSize:12,color:"#a0a8b8",lineHeight:1.5,fontStyle:"italic"}}>{s.titleContext}</div>}

              {/* Expanded */}
              {isExp && <div style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {s.notes && <div style={{fontSize:13,color:"#8898a8",lineHeight:1.6,marginBottom:10}}>{s.notes}</div>}
                {s.phone && <div style={{fontSize:13,color:"#90a8c0",marginBottom:3}}>📞 {s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#90a8c0",marginBottom:8}}>✉️ {s.email}</div>}
                {s.jn && <button onClick={e=>{e.stopPropagation();window.open(`https://app.singleops.com/jobs?search=${s.jn}`,"_blank");}} style={{display:"inline-block",padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0d1018",border:"1px solid #1a2030",color:"#5a6580",cursor:"pointer",marginBottom:8}}>SO #{s.jn} ↗</button>}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  {s.phone && <button onClick={e=>{e.stopPropagation();setTextSheet(s);setOtwMinutes(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:13,fontWeight:700,cursor:"pointer"}}>💬 Text</button>}
                  {s.addr && <button onClick={e=>{e.stopPropagation();navigate(s.addr);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:700,cursor:"pointer"}}>🧭 Navigate</button>}
                  <button onClick={e=>{e.stopPropagation();dismiss(s.id);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(51,182,121,.1)",border:"1px solid rgba(51,182,121,.2)",color:"#33B679",fontSize:13,fontWeight:700,cursor:"pointer"}}>✓ Done</button>
                </div>
              </div>}
            </div>
          </SwipeCard>;
        }); })()}

        {/* Completed */}
        {completed.length>0 && <div style={{borderTop:"1px solid #1a2030"}}>
          <button onClick={()=>setCompletedOpen(!completedOpen)} style={{width:"100%",padding:"10px 16px",background:"#0a0c10",border:"none",color:"#33B679",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            <span style={{transform:completedOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>
            ✓ {completed.length} completed
          </button>
          {completedOpen && completed.map(s => (
            <div key={s.id} style={{padding:"8px 16px",borderBottom:"1px solid #0a0e16",opacity:.4,display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:24,height:24,borderRadius:"50%",background:s.color+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#fff"}}>✓</div>
              <div style={{flex:1,fontSize:13,color:"#5a6580",textDecoration:"line-through"}}>{s.cn}</div>
              <button onClick={()=>{setDismissed(p=>{const n={...p};delete n[s.id];return n;});}} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"1px solid #1a2030",color:"#5a6580",fontSize:10,fontWeight:600,cursor:"pointer"}}>Restore</button>
            </div>
          ))}
        </div>}
      </div>

      {/* ── TEXT SHEET ─────────────────────────────────────────────────── */}
      {textSheet && <div onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d1018",border:"1px solid #1a2030",borderRadius:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:"max(18px,env(safe-area-inset-bottom))"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1}}>Text {(textSheet.cn||"").split(" ")[0]}</span>
            <span style={{fontSize:12,color:"#5a6580"}}>{textSheet.phone}</span>
            <button onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{width:28,height:28,borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
          </div>

          {/* Custom text */}
          <button onClick={()=>{window.open(`sms:${textSheet.phone.replace(/\D/g,"")}`,"_self");setTextSheet(null);}} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",cursor:"pointer",textAlign:"left"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#90a8c0"}}>Custom</div>
            <div style={{fontSize:11,color:"#5a6580",marginTop:2}}>Open blank message</div>
          </button>

          {/* OTW */}
          {otwMinutes === null ? (
            <div>
              <div style={{fontSize:11,fontWeight:700,color:"#5a6580",marginBottom:6,letterSpacing:.5}}>OTW — how far out are you?</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {[["4–6","4 to 6 minutes"],["5–7","5 to 7 minutes"],["6–8","6 to 8 minutes"],["8–10","8 to 10 minutes"],["10–12","10 to 12 minutes"],["12–15","12 to 15 minutes"],["15–20","15 to 20 minutes"],["20–25","20 to 25 minutes"],["30–40","30 to 40 minutes"],["40–50","40 to 50 minutes"],["45–1 hr","45 minutes to an hour"]].map(([label,txt]) => (
                  <button key={label} onClick={()=>{
                    const fn = (textSheet.cn||"").split(" ")[0];
                    const msg = `Hi there ${fn}, this is Jason with Monster Tree Service, and I'm just reaching out to let you know that I'm headed toward your property and I'm about ${txt} away.`;
                    window.open(`sms:${textSheet.phone.replace(/\D/g,"")}&body=${encodeURIComponent(msg)}`,"_self");
                    setTextSheet(null); setOtwMinutes(null);
                  }} style={{flex:"1 0 30%",padding:"10px 0",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:800,cursor:"pointer",textAlign:"center"}}>{label}</button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>}
    </div>
  );
}
