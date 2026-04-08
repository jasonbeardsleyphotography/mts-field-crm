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
  const clientName = nameMatch ? nameMatch[1].trim() : s.replace(/^TODO:\s*/i,"").trim();
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
  const isTodo = /^TODO:/i.test(s);
  const isAdmin = (ev.colorId === "8" || ev.colorId === "11") && !jobNum && !isTodo;

  // Window detection: AM (8-12), PM (11-3/4), DB
  const start = new Date(ev.start?.dateTime || ev.start?.date);
  const end = new Date(ev.end?.dateTime || ev.end?.date);
  const startH = start.getHours();
  const durH = (end - start) / 36e5;
  let window = "";
  if (isDriveBy) window = "DB";
  else if (durH >= 3 && durH <= 5 && startH >= 7 && startH <= 9) window = "AM";
  else if (durH >= 3 && durH <= 5 && startH >= 10 && startH <= 12) window = "PM";
  else if (startH < 10) window = "AM";
  else if (startH >= 10) window = "PM";

  // Constraints — extracted from title
  let constraint = "";
  if (/CALL (WHEN|FIRST|BEFORE|OTW)/i.test(s)) constraint = "📞 CALL FIRST";
  if (/NOT BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/NOT BEFORE\s*([\d:]+)/i)[1];
  if (/([\d:]+)\s*OR LATER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + s.match(/([\d:]+)\s*OR LATER/i)[1] + " or later";
  if (/CAN'?T MEET BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CAN'?T MEET BEFORE\s*([\d:]+)/i)[1];
  if (/CANNOT MEET BEFORE\s*(\w+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CANNOT MEET BEFORE\s*(\w+)/i)[1];
  if (/EARLIER IS BETTER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "⏰ EARLIER IS BETTER";
  if (/MEET (?:AT |.+?AT )(.+?)$/i.test(s)) { const m = s.match(/MEET (?:AT |.+?AT )(.+?)$/i); if (m) constraint = (constraint ? constraint + " · " : "") + "📍 " + m[1].slice(0,40); }
  if (/YARD STICK/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "🪧 Yard stick";
  if (/WE CAN MOVE/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "↔ Flexible";

  const color = stageColor(ev.colorId);

  return {
    id: ev.id, cn: clientName, addr: address, phone, email, notes, desc,
    jn: jobNum, db: isDriveBy, isTodo, isAdmin, constraint, color,
    colorId: ev.colorId, raw: s, rawD: rd, window,
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
      const m = new window.google.maps.Marker({
        position:pos, map:map.current,
        label:{text:String(n),color:"#fff",fontWeight:"800",fontSize:"12px"},
        icon:{path:window.google.maps.SymbolPath.CIRCLE, scale:14,
          fillColor:s.color, fillOpacity:s.db?.7:1,
          strokeColor:"#fff", strokeWeight:2},
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
              map:map.current, directions:result, suppressMarkers:true,
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
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rawEvents, setRawEvents] = useState({});
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(10));
  const [selDay, setSelDay] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [dismissed, setDismissed] = useState({});
  const [completedOpen, setCompletedOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(true);
  const [undoStack, setUndoStack] = useState([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [moving, setMoving] = useState(null); // index of card being moved
  const [ordIds, setOrdIds] = useState({}); // {dayKey: [id, id, ...]}

  // ── AUTH ─────────────────────────────────────────────────────────────────
  const initAuth = useCallback(() => {
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: r => { if (r.access_token) { setToken(r.access_token); setError(null); } else setError("Sign-in failed"); },
    }).requestAccessToken({ prompt: "consent" });
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
      setRawEvents(all); setSelDay(0); setDismissed({}); setExpanded(null); setOrdIds({}); setReorderMode(false); setMoving(null);
    } catch (e) {
      setError(e.message);
      if (e.message.includes("401")) setToken(null);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // ── PARSE ────────────────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  const parsed = useMemo(() => {
    const raw = rawEvents[dayKey] || [];
    return raw.map(parseEvent).filter(Boolean).filter(s => !s.isAdmin && !s.isTodo);
  }, [rawEvents, dayKey]);

  // Initialize order for this day if not set
  useEffect(() => {
    if (!dayKey || !parsed.length) return;
    if (ordIds[dayKey]?.length > 0) return;
    setOrdIds(prev => ({...prev, [dayKey]: parsed.map(s => s.id)}));
  }, [dayKey, parsed]);

  // Build ordered stops from ordIds
  const stopMap = useMemo(() => { const m = {}; parsed.forEach(s => m[s.id] = s); return m; }, [parsed]);
  const currentOrder = (ordIds[dayKey]?.length > 0) ? ordIds[dayKey] : parsed.map(s => s.id);
  const stops = currentOrder.map(id => stopMap[id]).filter(Boolean);

  const active = stops.filter(s => !dismissed[s.id]);
  const completed = stops.filter(s => dismissed[s.id]);

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  const dismiss = id => { setUndoStack(u => [...u, {type:"dismiss",id}]); setDismissed(p => ({...p,[id]:true})); setExpanded(null); };
  const undo = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length-1];
    setUndoStack(u => u.slice(0,-1));
    if (last.type === "dismiss") setDismissed(p => { const n={...p}; delete n[last.id]; return n; });
    if (last.type === "reorder") setOrdIds(prev => ({...prev, [dayKey]: last.prevOrder}));
  };
  const navigate = addr => { if (addr) window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`, "_blank"); };

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

  const navAllUrl = useMemo(() => {
    const a = active.filter(s=>s.addr).map(s=>s.addr);
    if (a.length < 2) return a.length===1 ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a[0])}` : null;
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(a[0])}&destination=${encodeURIComponent(a[a.length-1])}${a.length>2?`&waypoints=${a.slice(1,-1).map(encodeURIComponent).join("|")}`:""}`;
  }, [active]);

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
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0}}>
        <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setDismissed({});setReorderMode(false);setMoving(null);}} style={{padding:"6px 10px",borderRadius:8,border:"1px solid #1a2030",background:"#0a0c12",color:"#f0f4fa",fontSize:14,fontWeight:700,cursor:"pointer",outline:"none",appearance:"auto"}}>
          {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
        </select>
        <div style={{flex:1}}/>
        <button onClick={undo} disabled={!undoStack.length} style={{width:36,height:36,borderRadius:8,background:undoStack.length?"#1a2240":"transparent",border:"1px solid #1a2030",color:undoStack.length?"#f0f4fa":"#2a3050",fontSize:14,cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center"}}>↩</button>
        <button onClick={load} style={{width:36,height:36,borderRadius:8,background:loading?"#1a2240":"transparent",border:"1px solid #1a2030",color:loading?"#039BE5":"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>⟳</button>
      </div>

      {/* ── MAP ────────────────────────────────────────────────────────── */}
      <div style={{flexShrink:0,borderBottom:"1px solid #1a2030"}}>
        <div style={{display:"flex",alignItems:"center",padding:"0 12px",gap:6}}>
          <button onClick={()=>setMapOpen(!mapOpen)} style={{flex:1,padding:"6px 0",background:"none",border:"none",color:"#5a6580",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
            <span style={{transform:mapOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>
            {active.length} stops{completed.length>0?` · ${completed.length} done`:""}
          </button>
          <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}} style={{padding:"5px 12px",borderRadius:8,background:reorderMode?"rgba(142,36,170,.15)":"#1a2240",border:`1px solid ${reorderMode?"rgba(142,36,170,.4)":"#2a3560"}`,color:reorderMode?"#c8a0e8":"#5a6580",fontSize:12,fontWeight:700,cursor:"pointer"}}>{reorderMode?"✕ Done":"↕ Reorder"}</button>
          {navAllUrl && !reorderMode && <a href={navAllUrl} target="_blank" rel="noopener noreferrer" style={{padding:"5px 12px",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:12,fontWeight:700,textDecoration:"none"}}>🧭 All</a>}
        </div>
        {/* Reorder mode banner */}
        {reorderMode && <div style={{padding:"6px 14px",background:"rgba(142,36,170,.08)",borderTop:"1px solid rgba(142,36,170,.15)",display:"flex",alignItems:"center",gap:8}}>
          {moving !== null ? <>
            <div style={{width:10,height:10,borderRadius:10,background:active[moving]?.color||"#8E24AA"}}/>
            <span style={{fontSize:12,fontWeight:600,color:"#c8a0e8"}}>Moving: {active[moving]?.cn} — tap where to place</span>
            <button onClick={()=>setMoving(null)} style={{marginLeft:"auto",padding:"3px 10px",borderRadius:6,background:"#1a2240",border:"none",color:"#90a8c0",fontSize:10,fontWeight:700,cursor:"pointer"}}>Cancel</button>
          </> : <span style={{fontSize:12,fontWeight:500,color:"#9a80c8"}}>↕ Tap a stop to pick it up</span>}
        </div>}
        {mapOpen && active.length>0 && !reorderMode && <RouteMap stops={active}/>}
      </div>

      {/* ── STOP LIST ──────────────────────────────────────────────────── */}
      <div className="scr" style={{flex:1,overflowY:"auto",paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
        {active.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No stops</div>}

        {active.map((s, idx) => {
          const isNext = idx === 0 && !reorderMode;
          const isExp = expanded === s.id && !reorderMode;
          const isMov = moving === idx;
          const winColor = s.window === "AM" ? "#5cb878" : s.window === "PM" ? "#5a9ec8" : s.window === "DB" ? "#c8b050" : "#5a6580";
          const winBg = s.window === "AM" ? "rgba(92,184,120,.1)" : s.window === "PM" ? "rgba(90,158,200,.1)" : s.window === "DB" ? "rgba(200,176,80,.1)" : "transparent";

          return <SwipeCard key={s.id} enabled={!reorderMode} onSwipeRight={() => dismiss(s.id)} onSwipeLeft={() => navigate(s.addr)}>
            <div onClick={() => { if (reorderMode) handleReorderTap(idx); else setExpanded(isExp ? null : s.id); }} style={{
              padding:"14px 16px", borderBottom:"1px solid #0e1220",
              cursor: reorderMode ? "grab" : "pointer",
              background: isMov ? "rgba(142,36,170,.08)" : isNext ? "#0e1525" : reorderMode ? "#0a0c12" : "transparent",
              borderLeft: `4px solid ${isMov ? "#8E24AA" : isNext ? s.color : "transparent"}`,
              opacity: reorderMode && !isMov && moving !== null ? .5 : 1,
              transition: "opacity .15s",
            }}>
              {/* Main row: number + name + window badge + phone */}
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:isNext?38:32,height:isNext?38:32,borderRadius:"50%",background:s.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:isNext?16:14,fontWeight:800,color:"#fff",flexShrink:0,border:s.db?"2px dashed rgba(255,255,255,.4)":isMov?"2px solid #8E24AA":"none"}}>{idx+1}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:isNext?18:16,fontWeight:isNext?800:700,color:"#f0f4fa",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{isNext?"▸ ":""}{s.cn}</div>
                  {s.addr && <div style={{fontSize:11,color:"#5a6a80",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.addr}</div>}
                </div>
                {/* Window badge: AM / PM / DB */}
                {s.window && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:800,color:winColor,background:winBg,border:`1px solid ${winColor}30`,flexShrink:0,letterSpacing:.5}}>{s.window}</span>}
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>e.stopPropagation()} style={{padding:"8px 14px",borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:14,textDecoration:"none",fontWeight:700,flexShrink:0}}>📞</a>}
              </div>

              {/* Constraint — bright and prominent */}
              {s.constraint && !reorderMode && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(200,90,158,.1)",border:"1px solid rgba(200,90,158,.2)",color:"#e880b0",fontSize:12,fontWeight:700,display:"inline-block"}}>{s.constraint}</div>}

              {/* Expanded */}
              {isExp && <div style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {s.notes && <div style={{fontSize:13,color:"#8898a8",lineHeight:1.6,marginBottom:10,display:"-webkit-box",WebkitLineClamp:4,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{s.notes}</div>}
                {s.phone && <div style={{fontSize:13,color:"#90a8c0",marginBottom:3}}>📞 {s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#90a8c0",marginBottom:8}}>✉️ {s.email}</div>}
                {s.jn && <a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{display:"inline-block",padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0d1018",border:"1px solid #1a2030",color:"#5a6580",textDecoration:"none",marginBottom:8}}>SO #{s.jn} ↗</a>}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  {s.phone && <a href={`sms:${s.phone.replace(/\D/g,"")}`} onClick={e=>e.stopPropagation()} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:13,fontWeight:700,textDecoration:"none",textAlign:"center"}}>💬 Text</a>}
                  {s.addr && <button onClick={e=>{e.stopPropagation();navigate(s.addr);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:700,cursor:"pointer"}}>🧭 Navigate</button>}
                  <button onClick={e=>{e.stopPropagation();dismiss(s.id);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(51,182,121,.1)",border:"1px solid rgba(51,182,121,.2)",color:"#33B679",fontSize:13,fontWeight:700,cursor:"pointer"}}>✓ Done</button>
                </div>
              </div>}
            </div>
          </SwipeCard>;
        })}

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
    </div>
  );
}
