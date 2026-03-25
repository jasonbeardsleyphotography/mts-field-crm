import { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS FIELD CRM v5 — Production Build
   Fixed reorder · DeskPipe kanban · iPhone Chrome optimized
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SCOPES = "https://www.googleapis.com/auth/calendar";

// ── PIPELINE CONFIG ──────────────────────────────────────────────────────────
const C = {
  basil:"#0B8043", grape:"#8E24AA", peacock:"#039BE5", lavender:"#7986CB",
  banana:"#F6BF26", flamingo:"#E67C73", sage:"#33B679", tomato:"#D50000",
  blueberry:"#3F51B5", graphite:"#616161"
};
const CID = {
  "10":"basil","3":"grape","7":"peacock","1":"lavender","5":"banana",
  "4":"flamingo","2":"sage","11":"tomato","9":"blueberry","8":"graphite"
};
const CID_REV = Object.fromEntries(Object.entries(CID).map(([k,v])=>[v,k]));
const PO = ["basil","grape","peacock","lavender","banana","flamingo","sage","tomato","blueberry"];
const PL = {
  basil:"New Lead", grape:"Needs Discussion", peacock:"Strong Lead",
  lavender:"Weak Lead", banana:"Follow Up 1", flamingo:"Follow Up 2",
  sage:"SOLD", tomato:"DECLINED", blueberry:"NO BID", graphite:"Admin"
};
const WS = {
  am:{ bg:"#0f2118", bd:"#1a4a2e", c:"#5cb878", lb:"AM" },
  pm:{ bg:"#0f1828", bd:"#1a3050", c:"#5a9ed6", lb:"PM" },
  driveby:{ bg:"#1a1a10", bd:"#3a3a20", c:"#c8c050", lb:"DB" },
  todo:{ bg:"#1a1018", bd:"#3a2040", c:"#c080b0", lb:"TODO" },
  admin:{ bg:"#141418", bd:"#28283a", c:"#8080a0", lb:"ADM" },
  restricted:{ bg:"#1a1410", bd:"#3a2810", c:"#c8a060", lb:"" },
  standard:{ bg:"#0d1018", bd:"#1a2030", c:"#6a8aaa", lb:"" }
};

const FU_RULES = [
  { stage:"grape", days:2, msg:"Needs contact before proposal", action:"Call to discuss" },
  { stage:"banana", days:3, msg:"3+ days in Follow Up 1", action:"Send 2nd follow-up" },
  { stage:"flamingo", days:5, msg:"5+ days in Follow Up 2", action:"Re-engage or decline" },
  { stage:"peacock", days:7, msg:"Proposal sent 7+ days ago", action:"Follow up on proposal" },
  { stage:"lavender", days:5, msg:"Weaker lead aging out", action:"Follow up or decline" },
];
const AUTO_DECLINE_DAYS = 14;
const AUTO_DECLINE_STAGES = ["banana", "flamingo"];

const TEXT_TEMPLATES = [
  { label:"Initial follow-up", msg:"Hi {name}, this is Jason from MTS Tree Service. Just following up on your tree care estimate. Let me know if you have any questions!" },
  { label:"2nd follow-up", msg:"Hi {name}, Jason from MTS again. Wanted to check in on the proposal I sent over. Happy to answer any questions or adjust the scope." },
  { label:"Final check-in", msg:"Hi {name}, Jason from MTS. Just a final check-in on your tree care estimate. No pressure at all — just want to make sure you're all set!" },
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
function daysAgo(d) {
  if (!d) return 0;
  const diff = Math.floor((new Date() - new Date(d)) / 86400000);
  return diff < 0 ? 0 : diff;
}
function daysLabel(n) {
  if (n === null || n === undefined) return "";
  return n === 0 ? "today" : n === 1 ? "1d ago" : `${n}d ago`;
}
function getBusinessDays(count) {
  const days = []; let d = new Date();
  d.setHours(0,0,0,0);
  while (days.length < count) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function parseEvent(ev) {
  const s = ev.summary || "", rd = ev.description || "";
  const desc = rd.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const colorKey = CID[ev.colorId] || "basil";

  const jobMatch = s.match(/Task \| #(\d+)/);
  const jobNum = jobMatch ? jobMatch[1] : null;
  const nameMatch = s.match(/Task \| #\d+\s+[^-]+\s*-\s*([^-]+?)(?:\s*-\s*(.*))?$/);
  const clientName = nameMatch ? nameMatch[1].trim() : s.replace(/^TODO:\s*/i, "").trim();
  const addrMatch = s.match(/Task \| #\d+\s+([^-]+?)\s*-/);
  const address = ev.location || (addrMatch ? addrMatch[1].trim() : "");

  const mobileMatch = desc.match(/Mobile:\s*([\d\-(). +]+?)(?:\s*$|\s*Email)/);
  const phoneMatch = desc.match(/Phone:\s*([\d\-(). +]+?)(?:\s*$|\s*Mobile)/);
  const phone = (mobileMatch && mobileMatch[1].trim().length > 5 ? mobileMatch[1].trim() : "")
    || (phoneMatch && phoneMatch[1].trim().length > 5 ? phoneMatch[1].trim() : "");
  const emailMatch = desc.match(/Email:\s*(\S+@\S+)/);
  const email = emailMatch ? emailMatch[1].trim() : "";
  const notesMatch = desc.match(/Notes:\s*([\s\S]*)/);
  const notes = notesMatch ? notesMatch[1].trim() : "";

  const isDriveBy = /drive[\s-]?by/i.test(s);
  const isTodo = /^TODO:/i.test(s) || (/\bNOTE[!]*\b/i.test(s) && !jobNum);
  const isAdmin = colorKey === "graphite" && !isTodo;

  const start = new Date(ev.start?.dateTime || ev.start?.date);
  const end = new Date(ev.end?.dateTime || ev.end?.date);
  const durH = (end - start) / 36e5, startH = start.getHours();

  let winType = "standard", winLabel = "", constraint = "";
  if (isTodo) { winType = "todo"; winLabel = "TODO"; }
  else if (isAdmin) { winType = "admin"; winLabel = "ADM"; }
  else if (isDriveBy) { winType = "driveby"; winLabel = "🚗 DB"; }
  else if (durH >= 3.5 && durH <= 4.5 && startH >= 7 && startH <= 9) { winType = "am"; winLabel = "AM"; }
  else if (durH >= 3.5 && durH <= 4.5 && startH >= 10 && startH <= 12) { winType = "pm"; winLabel = "PM"; }
  else if (!isAdmin) {
    winType = "restricted";
    const fmt = d => d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });
    winLabel = `${fmt(start)}–${fmt(end)}`;
  }

  if (/NOT BEFORE\s*([\d:]+)/i.test(s)) constraint = "Not before " + s.match(/NOT BEFORE\s*([\d:]+)/i)[1];
  else if (/([\d:]+)\s*OR LATER/i.test(s)) constraint = s.match(/([\d:]+)\s*OR LATER/i)[1] + " or later";
  if (/CAN'?T MEET BEFORE\s*([\d:]+)/i.test(s)) constraint = "Not before " + s.match(/CAN'?T MEET BEFORE\s*([\d:]+)/i)[1];
  if (/CANNOT MEET BEFORE\s*(\w+)/i.test(s)) constraint = "Not before " + s.match(/CANNOT MEET BEFORE\s*(\w+)/i)[1];
  if (/CALL (WHEN|FIRST|BEFORE)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "📞 Call first";
  if (/MEET (?:AT |.+?AT )(.+?)$/i.test(s)) {
    const m = s.match(/MEET (?:AT |.+?AT )(.+?)$/i);
    if (m) constraint = (constraint ? constraint + " · " : "") + "Meet at " + m[1];
  }
  if (/YARD STICK/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "📏 Bring yard stick";

  const ageDays = daysAgo(ev.created);
  return {
    id: ev.id, cn: clientName, addr: address, phone, email, notes, desc,
    ck: colorKey, jn: jobNum, wt: winType, wl: winLabel, con: constraint,
    db: isDriveBy, isTodo, isAdm: isAdmin, ageDays, age: daysLabel(ageDays),
    rawD: desc, soldDate: null, autoDeclined: false,
    start, end
  };
}

// ── GOOGLE CALENDAR API ──────────────────────────────────────────────────────
async function fetchEvents(token, dayStart, dayEnd) {
  const timeMin = dayStart.toISOString();
  const timeMax = dayEnd.toISOString();
  const url = `${CAL_BASE}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(ev => ({ ...ev }));
}

async function updateEventColor(token, eventId, colorId) {
  const url = `${CAL_BASE}/events/${eventId}?sendUpdates=none`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ colorId })
  });
  return res.ok;
}

async function createCalEvent(token, summary, start, end, colorId) {
  const url = `${CAL_BASE}/events`;
  const body = {
    summary,
    start: { dateTime: start, timeZone: "America/New_York" },
    end: { dateTime: end, timeZone: "America/New_York" },
    colorId
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.ok ? await res.json() : null;
}

// ── COMPONENTS ───────────────────────────────────────────────────────────────
function Dot({ color, sz = 8 }) {
  return <div style={{ width:sz, height:sz, borderRadius:sz, background:C[color]||color, flexShrink:0 }}/>;
}

function NotePopup({ stop, onClose, contactLog }) {
  if (!stop) return null;
  const log = contactLog || [];
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:"1px solid #1e2536", borderRadius:16, padding:20, width:"100%", maxWidth:380, maxHeight:"80vh", overflowY:"auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
          <Dot color={stop.ck} sz={12}/>
          <span style={{ fontSize:16, fontWeight:700, color:"#fff", flex:1 }}>{stop.cn}</span>
          {stop.jn && <a href={`https://app.singleops.com/jobs?search=${stop.jn}`} target="_blank" rel="noopener" style={{ fontSize:11, color:"#039BE5", textDecoration:"none" }}>#{stop.jn}</a>}
          <button onClick={onClose} style={{ width:30, height:30, borderRadius:8, background:"#161b25", border:"none", color:"#6a7590", fontSize:16, cursor:"pointer" }}>✕</button>
        </div>
        {stop.addr && <div style={{ fontSize:13, color:"#6a7590", marginBottom:6 }}>{stop.addr}</div>}
        {stop.phone && <div style={{ fontSize:13, color:"#8898a8", marginBottom:3 }}>📱 {stop.phone}</div>}
        {stop.email && <div style={{ fontSize:13, color:"#8898a8", marginBottom:8 }}>✉ {stop.email}</div>}
        {stop.con && <div style={{ fontSize:12, color:"#c85a9e", fontStyle:"italic", marginBottom:8 }}>{stop.con}</div>}
        <div style={{ background:"#0a0c10", borderRadius:10, padding:14, border:"1px solid #161b25" }}>
          <div style={{ fontSize:9, fontWeight:700, color:"#3a4560", letterSpacing:1, marginBottom:6 }}>NOTES</div>
          <div style={{ fontSize:13, color:"#c0c8d8", lineHeight:1.5, marginBottom:8 }}>{stop.notes || "No notes"}</div>
          {stop.rawD && <div style={{ paddingTop:8, borderTop:"1px solid #161b25", fontSize:13, color:"#6a7590", lineHeight:1.5, whiteSpace:"pre-wrap" }}>{stop.rawD}</div>}
        </div>
        {log.length > 0 && (
          <div style={{ marginTop:10, padding:"8px 10px", background:"#0a0c10", borderRadius:8, border:"1px solid #161b25" }}>
            <div style={{ fontSize:9, fontWeight:700, color:"#3a4560", letterSpacing:1, marginBottom:6 }}>CONTACT LOG</div>
            {log.slice().reverse().map((e, i) => (
              <div key={i} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:"#6a7590", padding:"2px 0" }}>
                <span>{e.type}</span><span style={{ color:"#3a4560" }}>·</span><span>{e.detail}</span>
              </div>
            ))}
          </div>
        )}
        {stop.age && <div style={{ marginTop:8, fontSize:10, color:"#3a4560" }}>Created: {stop.age}</div>}
        <div style={{ display:"flex", gap:8, marginTop:14 }}>
          {stop.phone && <a href={`tel:${stop.phone.replace(/\D/g,"")}`} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#0B8043", color:"#fff", textAlign:"center", textDecoration:"none", fontSize:13, fontWeight:600 }}>📞 Call</a>}
          {stop.phone && <a href={`sms:${stop.phone.replace(/\D/g,"")}`} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#039BE5", color:"#fff", textAlign:"center", textDecoration:"none", fontSize:13, fontWeight:600 }}>💬 Text</a>}
          {stop.addr && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.addr)}`} target="_blank" rel="noopener" style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#8E24AA", color:"#fff", textAlign:"center", textDecoration:"none", fontSize:13, fontWeight:600 }}>🗺 Map</a>}
        </div>
      </div>
    </div>
  );
}

function SoldPicker({ stop, onConfirm, onCancel }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  if (!stop) return null;
  return (
    <div onClick={onCancel} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:`1px solid ${C.sage}44`, borderRadius:16, padding:20, width:"100%", maxWidth:320 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
          <Dot color="sage" sz={12}/>
          <span style={{ fontSize:16, fontWeight:700, color:C.sage }}>Mark SOLD</span>
        </div>
        <div style={{ fontSize:14, color:"#a0a8b8", marginBottom:6 }}>{stop.cn}</div>
        <div style={{ marginBottom:6, fontSize:11, fontWeight:700, color:"#6a7590", letterSpacing:1 }}>SOLD DATE</div>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width:"100%", padding:10, borderRadius:8, background:"#0a0c10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:14 }}/>
        <div style={{ display:"flex", gap:10, marginTop:18 }}>
          <button onClick={onCancel} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#161b25", border:"none", color:"#6a7590", fontSize:13, fontWeight:600, cursor:"pointer" }}>Cancel</button>
          <button onClick={() => onConfirm(date)} style={{ flex:1, padding:"10px 0", borderRadius:8, background:C.sage, border:"none", color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer" }}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function TextSheet({ stop, onClose, onSend }) {
  const [custom, setCustom] = useState("");
  if (!stop) return null;
  const fn = (stop.cn || "").split(" ")[0];
  const ph = (stop.phone || "").replace(/\D/g, "");
  const send = (msg, label) => {
    window.open(`sms:+1${ph}&body=${encodeURIComponent(msg.replace("{name}", fn))}`, "_self");
    if (onSend) onSend(stop.id, label);
    onClose();
  };
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:"1px solid #1e2536", borderRadius:"16px 16px 0 0", padding:20, width:"100%", maxWidth:400, maxHeight:"70vh", overflowY:"auto" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
          <span style={{ fontSize:15, fontWeight:700, color:"#fff", flex:1 }}>Text {fn}</span>
          <span style={{ fontSize:12, color:"#6a7590" }}>{stop.phone}</span>
          <button onClick={onClose} style={{ width:28, height:28, borderRadius:6, background:"#161b25", border:"none", color:"#6a7590", fontSize:14, cursor:"pointer" }}>✕</button>
        </div>
        {TEXT_TEMPLATES.map((t, i) => (
          <button key={i} onClick={() => send(t.msg, t.label)} style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 12px", marginBottom:6, borderRadius:10, background:"#0a0c10", border:"1px solid #161b25", cursor:"pointer" }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#039BE5", marginBottom:3 }}>{t.label}</div>
            <div style={{ fontSize:12, color:"#8898a8", lineHeight:1.4 }}>{t.msg.replace("{name}", fn)}</div>
          </button>
        ))}
        <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Or type custom message…" style={{ width:"100%", padding:"10px 12px", borderRadius:8, background:"#0a0c10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:13, marginTop:4, boxSizing:"border-box" }}/>
        {custom.trim() && <button onClick={() => send(custom, "custom")} style={{ marginTop:6, width:"100%", padding:"10px 0", borderRadius:8, background:"#039BE5", border:"none", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer" }}>Send Custom</button>}
      </div>
    </div>
  );
}

// ── GOOGLE MAPS ──────────────────────────────────────────────────────────────
const ZC = {
  "14618":[43.12,-77.57],"14526":[43.155,-77.45],"14625":[43.14,-77.51],
  "14450":[43.10,-77.42],"14534":[43.09,-77.52],"14580":[43.22,-77.42],
  "14609":[43.17,-77.56],"14610":[43.14,-77.55],"14620":[43.13,-77.60],
  "14564":[42.98,-77.41],"14543":[42.97,-77.63],"14624":[43.13,-77.72],
  "14612":[43.23,-77.66],"14616":[43.24,-77.60],"14617":[43.23,-77.53],
  "14622":[43.21,-77.50],"14467":[43.05,-77.62],"14586":[43.05,-77.67],
  "14506":[43.01,-77.57],"14472":[42.95,-77.59],"14468":[43.28,-77.80],
  "14559":[43.19,-77.80],"14514":[43.10,-77.80],"14428":[43.10,-77.88],
  "14546":[43.02,-77.73],"14464":[43.32,-77.88],"14502":[43.07,-77.30],
  "14519":[43.22,-77.28],"14424":[42.89,-77.28],"14456":[42.87,-76.98],
};

function getFallbackCoords(addr) {
  const z = (addr||"").match(/\b(1\d{4})\b/);
  return z && ZC[z[1]] ? { lat:ZC[z[1]][0], lng:ZC[z[1]][1] } : { lat:43.12, lng:-77.50 };
}

let mapsLoaded = false;
let mapsPromise = null;
function loadMapsAPI() {
  if (mapsLoaded && window.google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { mapsLoaded = true; resolve(); return; }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=geocoding`;
    script.async = true;
    script.onload = () => { mapsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

const geocodeCache = {};
const ZIP_CITY = {
  "14445":"East Rochester","14450":"Fairport","14467":"Henrietta","14472":"Honeoye Falls",
  "14502":"Macedon","14506":"Mendon","14514":"North Chili","14526":"Penfield",
  "14534":"Pittsford","14543":"Rush","14580":"Webster","14586":"West Henrietta",
  "14607":"Rochester","14608":"Rochester","14609":"Rochester","14610":"Rochester",
  "14611":"Rochester","14612":"Rochester","14613":"Rochester","14614":"Rochester",
  "14615":"Rochester","14616":"Rochester","14617":"Rochester","14618":"Rochester",
  "14619":"Rochester","14620":"Rochester","14621":"Rochester","14622":"Rochester",
  "14623":"Rochester","14624":"Rochester","14625":"Penfield","14626":"Rochester",
  "14627":"Rochester","14642":"Rochester","14424":"Canandaigua","14432":"Clifton Springs",
  "14456":"Geneva","14464":"Hamlin","14468":"Hilton","14510":"Livonia",
  "14519":"Ontario","14544":"Phelps","14559":"Spencerport","14564":"Victor",
  "14585":"Bloomfield","14428":"Churchville","14546":"Scottsville",
};

function getFullAddress(addr) {
  if (!addr) return null;
  const zipMatch = addr.match(/\b(1\d{4})\b/);
  if (!zipMatch) return addr + ", Rochester, NY";
  const zip = zipMatch[1];
  const city = ZIP_CITY[zip] || "Rochester";
  if (new RegExp(city, "i").test(addr)) {
    if (!/\bNY\b/i.test(addr)) return addr + ", NY";
    return addr;
  }
  return addr.replace(/(\b1\d{4})\b/, `, ${city}, NY $1`);
}

async function geocodeAddress(addr) {
  if (!addr) return null;
  const fullAddr = getFullAddress(addr);
  if (!fullAddr) return null;
  if (geocodeCache[fullAddr]) return geocodeCache[fullAddr];
  try {
    const geocoder = new window.google.maps.Geocoder();
    const result = await geocoder.geocode({ address: fullAddr });
    if (result.results?.[0]?.geometry?.location) {
      const loc = result.results[0].geometry.location;
      const coords = { lat: loc.lat(), lng: loc.lng() };
      geocodeCache[fullAddr] = coords;
      return coords;
    }
  } catch (e) { /* fall through */ }
  return null;
}

const DARK_STYLE = [
  { elementType:"geometry", stylers:[{color:"#0d0f14"}] },
  { elementType:"labels.text.stroke", stylers:[{color:"#0d0f14"}] },
  { elementType:"labels.text.fill", stylers:[{color:"#3a4560"}] },
  { featureType:"road", elementType:"geometry", stylers:[{color:"#1e2536"}] },
  { featureType:"road", elementType:"geometry.stroke", stylers:[{color:"#161b25"}] },
  { featureType:"road.highway", elementType:"geometry", stylers:[{color:"#2a3548"}] },
  { featureType:"water", elementType:"geometry", stylers:[{color:"#080a10"}] },
  { featureType:"poi", stylers:[{visibility:"off"}] },
  { featureType:"transit", stylers:[{visibility:"off"}] },
  { featureType:"administrative", elementType:"geometry.stroke", stylers:[{color:"#161b25"}] },
];

function RouteMap({ stops, activeIdx, onSelect }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const directionsRenderer = useRef(null);
  const [ready, setReady] = useState(false);
  const [coords, setCoords] = useState({});

  useEffect(() => { loadMapsAPI().then(() => setReady(true)).catch(() => {}); }, []);

  // Geocode all stop addresses
  useEffect(() => {
    if (!ready || !stops.length) return;
    let cancelled = false;
    async function geo() {
      const newCoords = {};
      for (let i = 0; i < stops.length; i++) {
        if (cancelled) break;
        const s = stops[i];
        if (!s.addr || s.addr.trim().length < 5) continue;
        const result = await geocodeAddress(s.addr);
        if (result) newCoords[s.id] = result;
        if (i < stops.length - 1) await new Promise(r => setTimeout(r, 200));
      }
      if (!cancelled) setCoords(newCoords);
    }
    geo();
    return () => { cancelled = true; };
  }, [ready, stops.map(s => s.id + s.addr).join(",")]);

  useEffect(() => {
    if (!ready || !mapRef.current || !Object.keys(coords).length) return;
    if (!mapInstance.current) {
      mapInstance.current = new window.google.maps.Map(mapRef.current, {
        center: { lat: 43.12, lng: -77.50 }, zoom: 11,
        styles: DARK_STYLE, disableDefaultUI: true,
        zoomControl: false, mapTypeControl: false, scaleControl: false,
        streetViewControl: false, rotateControl: false, fullscreenControl: false,
        keyboardShortcuts: false, clickableIcons: false,
        gestureHandling: "greedy", backgroundColor: "#0d0f14",
      });
    }
    const map = mapInstance.current;

    // Clear old markers
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    if (directionsRenderer.current) {
      directionsRenderer.current.setMap(null);
      directionsRenderer.current = null;
    }

    const positions = [];
    const bounds = new window.google.maps.LatLngBounds();
    let sn = 0;

    stops.forEach((s, i) => {
      const pos = coords[s.id];
      if (!pos) return;
      sn++;
      const isActive = activeIdx === i;
      const marker = new window.google.maps.Marker({
        position: pos, map,
        label: { text: String(sn), color: "#fff", fontWeight: "700", fontSize: isActive ? "13px" : "11px" },
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: isActive ? 16 : 12,
          fillColor: C[s.ck] || "#039BE5", fillOpacity: s.db ? 0.6 : 1,
          strokeColor: isActive ? "#fff" : s.db ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.6)",
          strokeWeight: isActive ? 3 : 1,
        },
        zIndex: isActive ? 100 : 10,
      });
      marker.addListener("click", () => onSelect(i));
      markersRef.current.push(marker);
      positions.push(pos);
      bounds.extend(pos);
    });

    if (positions.length >= 2) {
      const directionsService = new window.google.maps.DirectionsService();
      const origin = positions[0];
      const destination = positions[positions.length - 1];
      const waypoints = positions.slice(1, -1).map(p => ({ location: p, stopover: true }));
      directionsService.route({
        origin, destination, waypoints: waypoints.slice(0, 23),
        travelMode: window.google.maps.TravelMode.DRIVING,
        optimizeWaypoints: false,
      }, (result, status) => {
        if (status === "OK") {
          const renderer = new window.google.maps.DirectionsRenderer({
            map, directions: result, suppressMarkers: true,
            polylineOptions: { strokeColor: "#039BE5", strokeOpacity: 0.7, strokeWeight: 4 },
          });
          directionsRenderer.current = renderer;
        } else if (positions.length > 1) {
          const polyline = new window.google.maps.Polyline({
            path: positions, geodesic: true, strokeColor: "#039BE5",
            strokeOpacity: 0.5, strokeWeight: 3, map,
          });
          directionsRenderer.current = { setMap: (m) => polyline.setMap(m) };
        }
      });
    }

    if (positions.length > 0) map.fitBounds(bounds, { top: 20, right: 20, bottom: 20, left: 20 });
  }, [ready, coords, stops, activeIdx, onSelect]);

  return (
    <div ref={mapRef} style={{ width:"100%", height:220, background:"#0d0f14" }}>
      {!ready && <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:"#3a4560", fontSize:12 }}>Loading map…</div>}
    </div>
  );
}

// ── SWIPE CARD ───────────────────────────────────────────────────────────────
function SwipeCard({ children, onSwipeRight, onSwipeLeft, enabled }) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const dirLocked = useRef(null);

  const handleStart = e => {
    if (!enabled) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    dirLocked.current = null;
    setSwiping(true);
  };
  const handleMove = e => {
    if (!swiping || !enabled) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;
    if (!dirLocked.current) {
      if (Math.abs(dy) > Math.abs(dx) + 5) { dirLocked.current = "v"; return; }
      if (Math.abs(dx) > 10) dirLocked.current = "h";
    }
    if (dirLocked.current === "h") {
      e.preventDefault();
      setOffset(dx * 0.6);
    }
  };
  const handleEnd = () => {
    if (offset > 100 && onSwipeRight) onSwipeRight();
    else if (offset < -100 && onSwipeLeft) onSwipeLeft();
    setOffset(0);
    setSwiping(false);
    dirLocked.current = null;
  };

  const absOff = Math.abs(offset);
  const revealOpacity = Math.min(absOff / 80, 1);
  const cardOpacity = 1 - Math.min(absOff / 300, 0.4);
  const isRight = offset > 0;

  return (
    <div style={{ position:"relative", overflow:"hidden" }}>
      {absOff > 20 && (
        <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background: isRight ? `${C.sage}22` : `${C.peacock}22`, opacity:revealOpacity }}>
          <div style={{ fontSize:18, fontWeight:800, color: isRight ? C.sage : C.peacock }}>{isRight ? "✓" : "▶"}</div>
          <div style={{ fontSize:11, fontWeight:700, color: isRight ? C.sage : C.peacock, marginTop:2 }}>{isRight ? "DONE" : "SKIP"}</div>
        </div>
      )}
      <div
        onTouchStart={handleStart}
        onTouchMove={handleMove}
        onTouchEnd={handleEnd}
        style={{
          transform: `translateX(${offset}px)`,
          opacity: cardOpacity,
          transition: swiping ? "none" : "transform .3s, opacity .3s",
          touchAction: "pan-y",
          WebkitUserSelect: "none",
          userSelect: "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── DESKPIPE KANBAN ──────────────────────────────────────────────────────────
function DeskPipeKanban({ stops, onStageChange, onCardClick, interLog, onTextSheet }) {
  const [dragId, setDragId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);
  const [touchDrag, setTouchDrag] = useState(null);
  const [touchPos, setTouchPos] = useState(null);
  const scrollRef = useRef(null);
  const cardRefs = useRef({});
  const columnRefs = useRef({});

  const activeStages = PO; // all pipeline stages
  const stageGroups = useMemo(() => {
    const g = {};
    activeStages.forEach(k => { g[k] = []; });
    stops.forEach(s => {
      if (g[s.ck]) g[s.ck].push(s);
    });
    return g;
  }, [stops]);

  // Touch-based drag for mobile
  const handleTouchStart = (e, stopId) => {
    const touch = e.touches[0];
    setTouchDrag(stopId);
    setTouchPos({ x: touch.clientX, y: touch.clientY });
  };

  const handleTouchMove = useCallback((e) => {
    if (!touchDrag) return;
    const touch = e.touches[0];
    setTouchPos({ x: touch.clientX, y: touch.clientY });

    // Detect which column we're over
    for (const [stage, ref] of Object.entries(columnRefs.current)) {
      if (!ref) continue;
      const rect = ref.getBoundingClientRect();
      if (touch.clientX >= rect.left && touch.clientX <= rect.right) {
        setDragOverStage(stage);
        break;
      }
    }
  }, [touchDrag]);

  const handleTouchEnd = useCallback(() => {
    if (touchDrag && dragOverStage) {
      const stop = stops.find(s => s.id === touchDrag);
      if (stop && stop.ck !== dragOverStage) {
        onStageChange(touchDrag, dragOverStage);
      }
    }
    setTouchDrag(null);
    setTouchPos(null);
    setDragOverStage(null);
  }, [touchDrag, dragOverStage, stops, onStageChange]);

  useEffect(() => {
    if (touchDrag) {
      document.addEventListener("touchmove", handleTouchMove, { passive: false });
      document.addEventListener("touchend", handleTouchEnd);
      return () => {
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
      };
    }
  }, [touchDrag, handleTouchMove, handleTouchEnd]);

  // Desktop drag handlers
  const handleDragStart = (e, stopId) => {
    setDragId(stopId);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (e, stage) => {
    e.preventDefault();
    setDragOverStage(stage);
  };
  const handleDrop = (e, stage) => {
    e.preventDefault();
    if (dragId) {
      const stop = stops.find(s => s.id === dragId);
      if (stop && stop.ck !== stage) {
        onStageChange(dragId, stage);
      }
    }
    setDragId(null);
    setDragOverStage(null);
  };

  const touchedCard = touchDrag ? stops.find(s => s.id === touchDrag) : null;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Ghost card follows touch */}
      {touchedCard && touchPos && (
        <div style={{
          position:"fixed", left: touchPos.x - 80, top: touchPos.y - 30,
          width:160, zIndex:300, pointerEvents:"none",
          background:"#161b25", border:`2px solid ${C[touchedCard.ck]}`,
          borderRadius:10, padding:"8px 10px", opacity:0.9,
          boxShadow:"0 8px 32px rgba(0,0,0,.6)"
        }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#e0e8f0", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{touchedCard.cn}</div>
          <div style={{ fontSize:10, color:"#6a7590" }}>{PL[touchedCard.ck]}</div>
        </div>
      )}

      <div ref={scrollRef} style={{
        flex:1, display:"flex", gap:8, overflowX:"auto",
        padding:"8px 8px max(8px, env(safe-area-inset-bottom))",
        WebkitOverflowScrolling:"touch",
      }}>
        {activeStages.map(stage => {
          const items = stageGroups[stage] || [];
          const isOver = dragOverStage === stage;
          return (
            <div
              key={stage}
              ref={el => { columnRefs.current[stage] = el; }}
              onDragOver={e => handleDragOver(e, stage)}
              onDrop={e => handleDrop(e, stage)}
              style={{
                minWidth:200, width:200, flexShrink:0,
                background: isOver ? `${C[stage]}15` : "#0a0c10",
                border: `1px solid ${isOver ? C[stage] + "60" : "#161b25"}`,
                borderRadius:12, display:"flex", flexDirection:"column",
                transition:"border-color .2s, background .2s",
              }}
            >
              {/* Column header */}
              <div style={{
                padding:"10px 12px 8px", borderBottom:"1px solid #161b25",
                display:"flex", alignItems:"center", gap:6, flexShrink:0,
              }}>
                <Dot color={stage} sz={10}/>
                <span style={{ fontSize:12, fontWeight:700, color:C[stage], flex:1 }}>{PL[stage]}</span>
                <span style={{ fontSize:11, fontWeight:600, color:"#3a4560", background:"#161b25", borderRadius:8, padding:"1px 6px" }}>{items.length}</span>
              </div>

              {/* Cards */}
              <div className="scr" style={{ flex:1, overflowY:"auto", padding:6, display:"flex", flexDirection:"column", gap:6 }}>
                {items.map(s => {
                  const isAging = FU_RULES.some(r => r.stage === s.ck && s.ageDays >= r.days);
                  const isDragging = dragId === s.id || touchDrag === s.id;
                  return (
                    <div
                      key={s.id}
                      ref={el => { cardRefs.current[s.id] = el; }}
                      draggable
                      onDragStart={e => handleDragStart(e, s.id)}
                      onDragEnd={() => { setDragId(null); setDragOverStage(null); }}
                      onTouchStart={e => handleTouchStart(e, s.id)}
                      onClick={() => onCardClick(s)}
                      style={{
                        background: isDragging ? "#1e2536" : "#0d0f14",
                        border:`1px solid ${isDragging ? C[s.ck] : "#1e2536"}`,
                        borderRadius:10, padding:"10px 12px",
                        cursor:"grab", opacity: isDragging ? 0.5 : 1,
                        transition:"opacity .15s",
                        WebkitTapHighlightColor:"transparent",
                        touchAction:"none",
                      }}
                    >
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                        <span style={{ fontSize:13, fontWeight:600, color:"#e0e8f0", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.cn}</span>
                        {s.jn && <span style={{ fontSize:10, color:"#039BE5" }}>#{s.jn}</span>}
                      </div>
                      {s.addr && <div style={{ fontSize:11, color:"#4a5a70", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:4 }}>{s.addr}</div>}
                      <div style={{ display:"flex", alignItems:"center", gap:4, flexWrap:"wrap" }}>
                        {s.db && <span style={{ fontSize:9, padding:"1px 5px", borderRadius:4, background:"#3a3a20", color:"#c8c050" }}>DB</span>}
                        {isAging && <span style={{ fontSize:9, padding:"1px 5px", borderRadius:4, background:"#3a2010", color:"#c8a050" }}>⚠ AGING</span>}
                        <span style={{ fontSize:10, color: s.ageDays > 5 ? "#c85a5a" : "#4a5a6a", fontWeight:600 }}>{s.age}</span>
                      </div>
                      {/* Quick actions */}
                      <div style={{ display:"flex", gap:4, marginTop:6 }}>
                        {s.phone && (
                          <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e => e.stopPropagation()} style={{ padding:"3px 8px", borderRadius:5, background:"#0B804322", color:"#5cb878", fontSize:10, fontWeight:600, textDecoration:"none", border:"1px solid #0B804344" }}>📞</a>
                        )}
                        {s.phone && (
                          <button onClick={e => { e.stopPropagation(); onTextSheet(s); }} style={{ padding:"3px 8px", borderRadius:5, background:"#039BE522", color:"#5a9ed6", fontSize:10, fontWeight:600, border:"1px solid #039BE544", cursor:"pointer" }}>💬</button>
                        )}
                        {s.addr && (
                          <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.addr)}`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} style={{ padding:"3px 8px", borderRadius:5, background:"#8E24AA22", color:"#b080d0", fontSize:10, fontWeight:600, textDecoration:"none", border:"1px solid #8E24AA44" }}>🗺</a>
                        )}
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <div style={{ padding:20, textAlign:"center", color:"#1e2536", fontSize:11 }}>Empty</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  // Auth state
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Data state
  const [rawEvents, setRawEvents] = useState({});
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(10));

  // UI state
  const [view, setView] = useState("route");
  const [selDay, setSelDay] = useState(0);
  const [actStop, setActStop] = useState(null);
  const [mapOpen, setMapOpen] = useState(true);
  const [todoOpen, setTodoOpen] = useState(false);
  const [showLeg, setShowLeg] = useState(false);
  const [todoInput, setTodoInput] = useState(false);
  const [todoText, setTodoText] = useState("");
  const [popup, setPopup] = useState(null);
  const [reorderMode, setReorderMode] = useState(false);
  const [moving, setMoving] = useState(null);
  const [pipeSearch, setPipeSearch] = useState("");
  const [pipeStage, setPipeStage] = useState("basil");
  const [soldPick, setSoldPick] = useState(null);
  const [soldDates, setSoldDates] = useState({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [undoStack, setUndoStack] = useState([]);
  const [expandedPipe, setExpandedPipe] = useState(null);
  const [textSheet, setTextSheet] = useState(null);
  const [syncQueue, setSyncQueue] = useState([]);
  const [interLog, setInterLog] = useState({});
  const [dismissed, setDismissed] = useState({});
  const [completedOpen, setCompletedOpen] = useState(false);

  const todoRef = useRef(null);
  const searchRef = useRef(null);
  const cRef = useRef(null);

  // ── GOOGLE AUTH ────────────────────────────────────────────────────────
  const initAuth = useCallback(() => {
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        if (response.access_token) { setToken(response.access_token); setError(null); }
        else setError("Sign-in failed");
      },
    });
    client.requestAccessToken();
  }, []);

  // ── FETCH EVENTS ──────────────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const days = getBusinessDays(10);
      setBusinessDays(days);
      const all = {};
      for (const day of days) {
        const start = new Date(day); start.setHours(0,0,0,0);
        const end = new Date(day); end.setHours(23,59,59,999);
        const evts = await fetchEvents(token, start, end);
        all[day.toDateString()] = evts;
      }
      setRawEvents(all);
      setSelDay(0);
      setDismissed({});
      setActStop(null);
    } catch (e) {
      setError(`Failed to load: ${e.message}`);
      if (e.message.includes("401")) setToken(null);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { if (token) loadEvents(); }, [token, loadEvents]);

  // ── PARSE EVENTS ──────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  const todayKey = businessDays[0]?.toDateString();

  const dayParsed = useMemo(() => {
    const raw = rawEvents[dayKey] || [];
    return raw.map(parseEvent).map(p => {
      if (soldDates[p.id]) p.soldDate = soldDates[p.id];
      if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) {
        p.ck = "tomato"; p.autoDeclined = true;
      }
      return p;
    });
  }, [rawEvents, dayKey, soldDates]);

  // All events across all loaded days (for DeskPipe)
  const allDaysParsed = useMemo(() => {
    const all = [];
    const seen = new Set();
    Object.values(rawEvents).forEach(evts => {
      evts.forEach(ev => {
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        const p = parseEvent(ev);
        if (soldDates[p.id]) p.soldDate = soldDates[p.id];
        if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) {
          p.ck = "tomato"; p.autoDeclined = true;
        }
        all.push(p);
      });
    });
    return all;
  }, [rawEvents, soldDates]);

  const todayParsed = useMemo(() => {
    const raw = rawEvents[todayKey] || [];
    return raw.map(parseEvent).map(p => {
      if (soldDates[p.id]) p.soldDate = soldDates[p.id];
      if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) {
        p.ck = "tomato"; p.autoDeclined = true;
      }
      return p;
    });
  }, [rawEvents, todayKey, soldDates]);

  const [ordIds, setOrdIds] = useState({});
  useEffect(() => {
    const key = dayKey;
    if (!key || ordIds[key]) return;
    setOrdIds(prev => ({ ...prev, [key]: dayParsed.map(e => e.id) }));
  }, [dayKey, dayParsed]);

  const currentOrd = ordIds[dayKey] || dayParsed.map(e => e.id);
  const pmMap = useMemo(() => { const m = {}; dayParsed.forEach(p => { m[p.id] = p; }); return m; }, [dayParsed]);
  const allStops = currentOrd.map(id => pmMap[id]).filter(Boolean);
  const allClientStops = allStops.filter(s => !s.isAdm && !s.isTodo);
  const cs = allClientStops.filter(s => !dismissed[s.id]);
  const completedStops = allClientStops.filter(s => dismissed[s.id]);
  const todos = allStops.filter(s => s.isTodo);
  const admins = allStops.filter(s => s.isAdm && !s.isTodo);

  const todayP = todayParsed.filter(s => !s.isAdm && !s.isTodo);
  const deskPipeStops = allDaysParsed.filter(s => !s.isAdm && !s.isTodo);

  const needsAttention = useMemo(() =>
    FU_RULES.flatMap(rule =>
      todayP.filter(s => s.ck === rule.stage && s.ageDays >= rule.days).map(s => ({ ...s, rule }))
    ), [todayP]);

  // ── ACTIONS ────────────────────────────────────────────────────────────
  const addTodo = async () => {
    if (!todoText.trim() || !token) return;
    const now = new Date();
    const start = new Date(now); start.setHours(7,0,0,0);
    const end = new Date(now); end.setHours(8,0,0,0);
    const ev = await createCalEvent(token, `TODO: ${todoText.trim()}`, start.toISOString(), end.toISOString(), "8");
    if (ev) loadEvents();
    setTodoText(""); setTodoInput(false);
  };

  // ── FIXED REORDER ──────────────────────────────────────────────────────
  const handleTap = idx => {
    if (!reorderMode) return;
    if (moving === null) { setMoving(idx); setActStop(null); }
    else if (moving === idx) { setMoving(null); }
    else {
      const key = dayKey;
      const prevIds = [...(ordIds[key] || currentOrd)];

      // FIX: Work directly with cs (visible client stops) indices
      // cs[moving] and cs[idx] give us the actual stop IDs to swap
      const fromId = cs[moving]?.id;
      const toId = cs[idx]?.id;
      if (!fromId || !toId) { setMoving(null); return; }

      // Work on the full ordered ID list
      const ids = [...prevIds];
      const fi = ids.indexOf(fromId);
      const ti = ids.indexOf(toId);
      if (fi === -1 || ti === -1) { setMoving(null); return; }

      // Remove from old position, insert at new
      ids.splice(fi, 1);
      const newTi = ids.indexOf(toId);
      ids.splice(moving < idx ? newTi + 1 : newTi, 0, fromId);

      setUndoStack(u => [...u, { type:"reorder", key, prevIds }]);
      setOrdIds(prev => ({ ...prev, [key]: ids }));
      setMoving(null);
    }
  };

  const addToSync = (stopId, toStage) => {
    const s = pmMap[stopId] || allDaysParsed.find(x => x.id === stopId);
    if (!s || !s.jn) return;
    const actionMap = { sage:"Mark SOLD", tomato:"Mark DECLINED", blueberry:"Mark NO BID", grape:"Move to Discuss" };
    const action = actionMap[toStage] || `Move → ${PL[toStage] || toStage}`;
    setSyncQueue(q => [...q.filter(x => x.id !== stopId), { id:stopId, cn:s.cn, jn:s.jn, action, stage:toStage }]);
  };

  const moveStage = async (stopId, toStage) => {
    if (toStage === "sage") {
      const stop = pmMap[stopId] || allDaysParsed.find(x => x.id === stopId);
      setSoldPick({ id:stopId, ...stop, prevStage: stop?.ck });
      return;
    }
    const prevCk = (pmMap[stopId] || allDaysParsed.find(x => x.id === stopId))?.ck;
    setUndoStack(u => [...u, { type:"stage", id:stopId, prev:prevCk }]);
    addToSync(stopId, toStage);
    const colorId = CID_REV[toStage];
    if (token && colorId) {
      await updateEventColor(token, stopId, colorId);
      loadEvents();
    }
  };

  const confirmSold = async (date) => {
    if (!soldPick) return;
    setUndoStack(u => [...u, { type:"stage", id:soldPick.id, prev:soldPick.prevStage }]);
    setSoldDates(p => ({ ...p, [soldPick.id]: date }));
    addToSync(soldPick.id, "sage");
    if (token) { await updateEventColor(token, soldPick.id, "2"); loadEvents(); }
    setSoldPick(null);
  };

  const dismissStop = id => { setUndoStack(u => [...u, { type:"dismiss", id }]); setDismissed(p => ({ ...p, [id]: true })); };
  const undismissStop = id => { setDismissed(p => { const n={...p}; delete n[id]; return n; }); };

  const undo = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack(u => u.slice(0, -1));
    if (last.type === "stage") {
      const colorId = CID_REV[last.prev];
      if (token && colorId) { updateEventColor(token, last.id, colorId); loadEvents(); }
      setSoldDates(p => { const n={...p}; delete n[last.id]; return n; });
    } else if (last.type === "reorder") {
      setOrdIds(prev => ({ ...prev, [last.key]: last.prevIds }));
    } else if (last.type === "dismiss") {
      undismissStop(last.id);
    }
  };

  const logInteraction = (stopId, type, detail) => {
    setInterLog(prev => ({
      ...prev,
      [stopId]: [...(prev[stopId] || []), { type, detail, ts: new Date().toISOString() }]
    }));
  };

  const navUrl = useMemo(() => {
    const a = cs.filter(s => s.addr).map(s => s.addr);
    if (a.length < 2) return null;
    const base = "https://www.google.com/maps/dir/";
    return base + a.map(encodeURIComponent).join("/");
  }, [cs]);

  // ── SUB-COMPONENTS ─────────────────────────────────────────────────────
  const Badge = ({s}) => {
    const w = WS[s.wt] || WS.standard;
    return <span style={{ padding:"2px 8px", borderRadius:6, background:w.bg, border:`1px solid ${w.bd}`, color:w.c, fontSize:10, fontWeight:700, flexShrink:0 }}>{s.wl || w.lb}</span>;
  };

  const StageButtons = ({stop, compact}) => {
    const stages = [...PO, "graphite"];
    return (
      <div style={{ display:"flex", gap:compact?3:4, flexWrap:"wrap", marginTop:compact?6:8 }}>
        {stages.filter(k => k !== stop.ck).map(k => (
          <button key={k} onClick={e => { e.stopPropagation(); moveStage(stop.id, k); }}
            style={{ padding:compact?"2px 6px":"3px 8px", borderRadius:5, background:`${C[k]}22`, border:`1px solid ${C[k]}44`, color:C[k], fontSize:compact?9:10, fontWeight:600, cursor:"pointer" }}>
            {PL[k]}
          </button>
        ))}
      </div>
    );
  };

  const ContactBtns = ({s, compact}) => (
    <div style={{ display:"flex", gap:compact?4:8, marginTop:compact?4:8 }}>
      {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{ padding:compact?"4px 8px":"6px 12px", borderRadius:6, background:"#0B804322", color:"#5cb878", fontSize:compact?11:12, fontWeight:600, textDecoration:"none", border:"1px solid #0B804344" }}>📞 Call</a>}
      {s.phone && <button onClick={e => { e.stopPropagation(); setTextSheet(s); }} style={{ padding:compact?"4px 8px":"6px 12px", borderRadius:6, background:"#039BE522", color:"#5a9ed6", fontSize:compact?11:12, fontWeight:600, border:"1px solid #039BE544", cursor:"pointer" }}>💬 Text</button>}
      {s.addr && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.addr)}`} target="_blank" rel="noopener" style={{ padding:compact?"4px 8px":"6px 12px", borderRadius:6, background:"#8E24AA22", color:"#b080d0", fontSize:compact?11:12, fontWeight:600, textDecoration:"none", border:"1px solid #8E24AA44" }}>🗺</a>}
      <button onClick={e => { e.stopPropagation(); setPopup(s); }} style={{ padding:compact?"4px 8px":"6px 12px", borderRadius:6, background:"#1e253622", color:"#6a7590", fontSize:compact?11:12, fontWeight:600, border:"1px solid #1e2536", cursor:"pointer" }}>📋</button>
    </div>
  );

  const InteractionHistory = ({stopId}) => {
    const log = interLog[stopId];
    if (!log?.length) return null;
    return (
      <div style={{ marginTop:6, fontSize:10, color:"#4a5a6a" }}>
        {log.slice(-3).reverse().map((e, i) => (
          <div key={i} style={{ display:"flex", gap:4 }}>
            <span>{e.type}</span><span style={{ color:"#2a3540" }}>·</span><span>{e.detail}</span>
          </div>
        ))}
      </div>
    );
  };

  // ═══ SIGN IN SCREEN ═══════════════════════════════════════════════════
  if (!token) {
    return (
      <div style={{ height:"100dvh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#090b10", fontFamily:"'Inter',system-ui,sans-serif", WebkitTapHighlightColor:"transparent" }}>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
        <div style={{ fontSize:28, fontWeight:800, color:"#e0e8f0", marginBottom:4 }}>MTS Field CRM</div>
        <div style={{ fontSize:13, color:"#4a5a6a", marginBottom:32 }}>Sales & Route Planning</div>
        <button onClick={initAuth} style={{ padding:"14px 32px", borderRadius:10, background:"#039BE5", border:"none", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>Sign in with Google</button>
        {error && <div style={{ marginTop:16, color:"#D50000", fontSize:12 }}>{error}</div>}
      </div>
    );
  }

  // ═══ LOADING ═══════════════════════════════════════════════════════════
  if (loading && !Object.keys(rawEvents).length) {
    return (
      <div style={{ height:"100dvh", display:"flex", alignItems:"center", justifyContent:"center", background:"#090b10", fontFamily:"'Inter',system-ui,sans-serif" }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:16, fontWeight:600, marginBottom:8, color:"#e0e8f0" }}>Loading calendar…</div>
          <div style={{ fontSize:12, color:"#4a5a6a" }}>Fetching 10 business days</div>
        </div>
      </div>
    );
  }

  // ═══ MAIN APP ═════════════════════════════════════════════════════════
  const dayLabels = businessDays.map((d, i) => {
    const opts = { weekday:"short", month:"numeric", day:"numeric" };
    const label = d.toLocaleDateString("en-US", opts);
    const isToday = d.toDateString() === new Date().toDateString();
    return { label: label + (isToday ? " (Today)" : ""), d };
  });

  return (
    <div ref={cRef} style={{
      height:"100dvh", width:"100%", background:"#090b10",
      display:"flex", flexDirection:"column",
      fontFamily:"'Inter',system-ui,sans-serif",
      WebkitTapHighlightColor:"transparent",
      overscrollBehavior:"none",
      WebkitOverscrollBehavior:"none",
      touchAction:"manipulation",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <style>{`
        .scr::-webkit-scrollbar{width:3px}
        .scr::-webkit-scrollbar-track{background:transparent}
        .scr::-webkit-scrollbar-thumb{background:#1e2536;border-radius:3px}
        *{box-sizing:border-box}
        html,body{overscroll-behavior:none;-webkit-overflow-scrolling:touch}
        input,select,button{font-family:inherit;-webkit-appearance:none}
        select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236a7590' d='M3 5l3 3 3-3'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:24px}
      `}</style>

      {/* NAV */}
      <div style={{ display:"flex", alignItems:"center", gap:4, padding:"6px 8px", background:"#0d0f14", borderBottom:"1px solid #161b25", flexShrink:0, paddingTop:"max(6px, env(safe-area-inset-top))" }}>
        {view !== "deskpipe" && (
          <select value={selDay} onChange={e => { setSelDay(Number(e.target.value)); setActStop(null); setMoving(null); setReorderMode(false); }}
            style={{ padding:"5px 8px", borderRadius:6, background:"#0a0c10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:12, fontWeight:600 }}>
            {dayLabels.map((d,i) => <option key={i} value={i}>{d.label}</option>)}
          </select>
        )}
        {view === "deskpipe" && <span style={{ fontSize:13, fontWeight:700, color:"#e0e8f0", padding:"0 4px" }}>DeskPipe</span>}

        {!searchOpen ? (
          <>
            <button onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
              style={{ width:28, height:28, borderRadius:6, background:"#0a0c10", border:"1px solid #1e2536", color:"#6a7590", fontSize:14, cursor:"pointer" }}>🔍</button>
            <button onClick={undo}
              style={{ width:28, height:28, borderRadius:6, background: undoStack.length ? "#1a1428" : "#0a0c10", border:`1px solid ${undoStack.length ? "#3a2850" : "#1e2536"}`, color: undoStack.length ? "#9a80c8" : "#3a4560", fontSize:14, cursor:"pointer" }}>↩</button>
            <button onClick={loadEvents}
              style={{ width:28, height:28, borderRadius:6, background: loading ? "#0a1420" : "#0a0c10", border:`1px solid ${loading ? "#1a3050" : "#1e2536"}`, color: loading ? "#5a9ed6" : "#6a7590", fontSize:14, cursor:"pointer" }}>⟳</button>
          </>
        ) : (
          <div style={{ display:"flex", alignItems:"center", gap:3, flex:1, minWidth:0 }}>
            <input ref={searchRef} value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key === "Escape" && setSearchOpen(false)}
              placeholder="Search…" style={{ flex:1, padding:"5px 8px", borderRadius:6, background:"#0a0c10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:12, minWidth:0, outline:"none" }}/>
            <button onClick={() => { setSearchOpen(false); setSearchQ(""); }} style={{ padding:"4px 6px", background:"none", border:"none", color:"#6a7590", fontSize:12, cursor:"pointer" }}>✕</button>
          </div>
        )}

        {!searchOpen && <div style={{ flex:1 }}/>}

        {!searchOpen && (
          <div style={{ display:"flex", gap:2, background:"#0a0c12", borderRadius:7, padding:2, border:"1px solid #161b25" }}>
            {[{k:"route",l:"Route"},{k:"pipeline",l:"Pipe"},{k:"deskpipe",l:"Desk"}].map(v => (
              <button key={v.k} onClick={() => setView(v.k)}
                style={{ padding:"4px 10px", borderRadius:5, background: view===v.k ? "#1e2536" : "transparent", border:"none", color: view===v.k ? "#e0e8f0" : "#4a5a6a", fontSize:11, fontWeight:600, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>
                {v.l}
              </button>
            ))}
          </div>
        )}

        <button onClick={() => setShowLeg(!showLeg)} style={{ width:28, height:28, borderRadius:6, background:"#0a0c10", border:"1px solid #1e2536", color:"#6a7590", fontSize:14, cursor:"pointer" }}>◐</button>

        {showLeg && (
          <div onClick={() => setShowLeg(false)} style={{ position:"fixed", inset:0, zIndex:100 }}>
            <div onClick={e => e.stopPropagation()} style={{ position:"absolute", top:44, right:8, background:"#0d0f14", border:"1px solid #1e2536", borderRadius:10, padding:12, zIndex:101, minWidth:160 }}>
              {PO.map(k => (
                <div key={k} style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 0" }}>
                  <Dot color={k} sz={10}/><span style={{ fontSize:12, color:C[k] }}>{PL[k]}</span>
                </div>
              ))}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 0" }}>
                <Dot color="graphite" sz={10}/><span style={{ fontSize:12, color:C.graphite }}>Admin</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* TODO — only on route/pipeline */}
      {view !== "deskpipe" && (
        <div style={{ background:"#0b0d12", borderBottom:"1px solid #161b25", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", padding:"4px 10px", gap:5 }}>
            <button onClick={() => setTodoOpen(!todoOpen)} style={{ background:"none", border:"none", color:"#6a7590", fontSize:13, fontWeight:600, display:"flex", alignItems:"center", gap:5, cursor:"pointer", padding:0, WebkitTapHighlightColor:"transparent" }}>
              <span style={{ transform: todoOpen ? "rotate(90deg)" : "", transition:"transform .15s", display:"inline-block" }}>▸</span>
              TODOs
              {todos.length > 0 && <span style={{ background:"#1e2536", borderRadius:10, padding:"0 6px", fontSize:10, color:"#6a7590" }}>{todos.length}</span>}
            </button>
            <div style={{ flex:1 }}/>
            {!todoInput ? (
              <button onClick={() => { setTodoInput(true); setTodoOpen(true); setTimeout(() => todoRef.current?.focus(), 50); }}
                style={{ padding:"3px 8px", borderRadius:5, background:"#0a0c10", border:"1px solid #1e2536", color:"#6a7590", fontSize:11, cursor:"pointer" }}>+ TODO</button>
            ) : (
              <div style={{ display:"flex", gap:4 }}>
                <input ref={todoRef} value={todoText} onChange={e => setTodoText(e.target.value)} onKeyDown={e => e.key === "Enter" && addTodo()}
                  placeholder="New todo…" style={{ padding:"3px 8px", borderRadius:5, background:"#0a0c10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:12, width:140, outline:"none" }}/>
                <button onClick={addTodo} style={{ padding:"3px 8px", borderRadius:5, border:"none", background:"#039BE5", color:"#fff", fontSize:11, fontWeight:600, cursor:"pointer" }}>Add</button>
              </div>
            )}
          </div>
          {todoOpen && todos.length > 0 && (
            <div style={{ padding:"0 10px 8px" }}>
              {todos.map(t => (
                <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 0" }}>
                  <div style={{ width:16, height:16, borderRadius:4, border:"2px solid #333", flexShrink:0 }}/>
                  <span style={{ fontSize:13, fontWeight:500, color:"#a0a8b8", flex:1 }}>{(t.cn||"").replace(/^TODO:\s*/i,"")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ ROUTE ═══ */}
      {view === "route" ? (
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          <div style={{ flexShrink:0 }}>
            {reorderMode && (
              <div style={{ padding:"6px 12px", background:"#1a0f28", borderBottom:"1px solid #2a1840", display:"flex", alignItems:"center", gap:8 }}>
                {moving !== null ? (
                  <><Dot color={cs[moving]?.ck || "basil"} sz={10}/><span style={{ fontSize:12, fontWeight:500, color:"#c8b0e8" }}>Tap destination for {cs[moving]?.cn}</span></>
                ) : (
                  <span style={{ fontSize:12, fontWeight:500, color:"#9a80c8" }}>↕ Tap a stop to pick it up</span>
                )}
                <button onClick={() => { setReorderMode(false); setMoving(null); }} style={{ marginLeft:"auto", padding:"3px 8px", borderRadius:5, background:"#2a1840", border:"none", color:"#9a80c8", fontSize:11, cursor:"pointer" }}>Done</button>
              </div>
            )}

            <div style={{ borderBottom:"1px solid #161b25" }}>
              <div style={{ display:"flex", alignItems:"center" }}>
                <button onClick={() => setMapOpen(!mapOpen)} style={{ flex:1, padding:"8px 12px", background:"none", border:"none", color:"#6a7590", fontSize:12, fontWeight:600, textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:5, WebkitTapHighlightColor:"transparent" }}>
                  <span style={{ transform: mapOpen ? "rotate(90deg)" : "", transition:"transform .15s", display:"inline-block" }}>▸</span>
                  🗺 {cs.length} stops{completedStops.length > 0 ? ` · ${completedStops.length} done` : ""}
                </button>
                <button onClick={() => { if(reorderMode) { setReorderMode(false); setMoving(null); } else { setReorderMode(true); setActStop(null); } }}
                  style={{ padding:"6px 10px", background:"none", border:"none", color: reorderMode ? "#9a80c8" : "#4a5a6a", fontSize:12, cursor:"pointer" }}>↕</button>
                {navUrl && <a href={navUrl} target="_blank" rel="noopener noreferrer" style={{ padding:"6px 10px", color:"#039BE5", fontSize:12, textDecoration:"none", fontWeight:600 }}>▶ Nav</a>}
              </div>
              {mapOpen && cs.length > 0 && <RouteMap stops={cs} activeIdx={moving !== null ? moving : actStop} onSelect={i => { if(reorderMode) handleTap(i); else setActStop(actStop === i ? null : i); }}/>}
            </div>

            {admins.length > 0 && (
              <div style={{ padding:"5px 10px", display:"flex", gap:4, flexWrap:"wrap", borderBottom:"1px solid #161b25" }}>
                {admins.map(a => (
                  <button key={a.id} onClick={() => setPopup(a)} style={{ padding:"3px 8px", borderRadius:5, background:"#14141866", border:"1px solid #28283a", color:"#8080a0", fontSize:11, cursor:"pointer" }}>
                    {a.cn}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Scrollable card list */}
          <div className="scr" style={{ flex:1, overflowY:"auto", paddingBottom:"max(12px, env(safe-area-inset-bottom))", WebkitOverflowScrolling:"touch" }}>
            {(() => {
              const q = searchQ.toLowerCase();
              const list = q ? cs.filter(s => (s.cn||"").toLowerCase().includes(q) || (s.addr||"").toLowerCase().includes(q)) : cs;
              if (q && list.length === 0) return <div style={{ padding:30, textAlign:"center", color:"#3a4560", fontSize:13 }}>No matches</div>;

              let sn = 0;
              return list.map((s, idx) => {
                sn++;
                const isA = actStop === idx;
                const isMov = moving === idx;
                const isNext = idx === 0 && !reorderMode;
                return (
                  <SwipeCard key={s.id} enabled={!reorderMode} onSwipeRight={() => dismissStop(s.id)} onSwipeLeft={() => moveStage(s.id, "peacock")}>
                    <div onClick={() => { if(reorderMode) handleTap(idx); else setActStop(isA ? null : idx); }}
                      style={{
                        padding: isNext ? "12px 14px" : "10px 14px",
                        background: isMov ? "#1a0f28" : isA ? "#0d1018" : "#090b10",
                        borderBottom:"1px solid #0e1118",
                        borderLeft: isMov ? "3px solid #8E24AA" : isNext ? "3px solid #039BE5" : "3px solid transparent",
                        WebkitTapHighlightColor:"transparent",
                        cursor: reorderMode ? "pointer" : "default",
                      }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{
                          width: isNext ? 34 : 30, height: isNext ? 34 : 30, borderRadius:"50%",
                          background: `${C[s.ck]}30`, border: `2px solid ${C[s.ck]}`,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize: isNext ? 14 : 12, fontWeight:700, color:C[s.ck], flexShrink:0,
                        }}>{sn}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize: isNext ? 16 : 15, fontWeight: isNext ? 700 : 600, color:"#e0e8f0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.cn}</div>
                          <div style={{ fontSize:12, color:"#4a5a70", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.addr}</div>
                        </div>
                        <Badge s={s}/>
                      </div>

                      {s.con && <div style={{ marginTop:4, marginLeft: isNext ? 44 : 40, fontSize:12, color:"#c85a9e", fontStyle:"italic" }}>{s.con}</div>}

                      {isA && !reorderMode && (
                        <div style={{ marginTop:10, marginLeft:40, paddingTop:10, borderTop:"1px solid #161b25" }}>
                          {s.notes && <div style={{ fontSize:13, color:"#7a8898", lineHeight:1.5, marginBottom:8 }}>{s.notes}</div>}
                          <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:8, flexWrap:"wrap" }}>
                            <span style={{ display:"inline-flex", alignItems:"center", gap:3, padding:"2px 8px", borderRadius:5, background:`${C[s.ck]}22`, border:`1px solid ${C[s.ck]}44` }}>
                              <Dot color={s.ck} sz={8}/><span style={{ fontSize:11, color:C[s.ck], fontWeight:600 }}>{PL[s.ck]}</span>
                            </span>
                            {s.jn && <a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener" style={{ fontSize:11, color:"#039BE5", textDecoration:"none" }}>SO #{s.jn}</a>}
                            {s.age && <span style={{ fontSize:10, color:"#3a4560" }}>{s.age}</span>}
                          </div>
                          <ContactBtns s={s}/>
                          <InteractionHistory stopId={s.id}/>
                          <StageButtons stop={s}/>
                        </div>
                      )}
                    </div>
                  </SwipeCard>
                );
              });
            })()}

            {completedStops.length > 0 && (
              <div style={{ borderTop:"1px solid #161b25" }}>
                <button onClick={() => setCompletedOpen(!completedOpen)} style={{ width:"100%", padding:"8px 14px", background:"none", border:"none", color:"#3a4560", fontSize:12, fontWeight:600, textAlign:"left", cursor:"pointer", display:"flex", alignItems:"center", gap:5, WebkitTapHighlightColor:"transparent" }}>
                  <span style={{ transform: completedOpen ? "rotate(90deg)" : "", transition:"transform .15s", display:"inline-block" }}>▸</span>
                  {completedStops.length} completed
                </button>
                {completedOpen && completedStops.map(s => (
                  <div key={s.id} style={{ padding:"8px 14px", display:"flex", alignItems:"center", gap:10, borderBottom:"1px solid #0e1118" }}>
                    <div style={{ width:24, height:24, borderRadius:"50%", background:C[s.ck]+"44", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:C[s.ck], fontWeight:700 }}>✓</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, color:"#6a7590", textDecoration:"line-through" }}>{s.cn}</div>
                    </div>
                    <button onClick={() => undismissStop(s.id)} style={{ padding:"3px 8px", borderRadius:5, background:"#1e2536", border:"none", color:"#6a7590", fontSize:10, cursor:"pointer" }}>Undo</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      ) : view === "pipeline" ? (
        /* ═══ PIPELINE ═══ */
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          {syncQueue.length > 0 && (
            <div style={{ padding:"8px 10px", background:"#1a0a0a", borderBottom:"1px solid #3a1a1a", flexShrink:0 }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#F4511E", letterSpacing:1, marginBottom:4 }}>SYNC QUEUE</div>
              {syncQueue.map((q, qi) => (
                <div key={q.id+qi} style={{ display:"flex", alignItems:"center", gap:6, padding:"2px 0" }}>
                  <Dot color={q.stage} sz={8}/>
                  <div style={{ flex:1, minWidth:0 }}>
                    <span style={{ fontSize:12, color:"#c08080", fontWeight:600 }}>{q.cn}</span>
                    <span style={{ fontSize:10, color:"#804040", marginLeft:6 }}>{q.action}</span>
                  </div>
                  {q.jn && <a href={`https://app.singleops.com/jobs?search=${q.jn}`} target="_blank" rel="noopener" style={{ fontSize:10, color:"#039BE5", textDecoration:"none" }}>#{q.jn}</a>}
                  <button onClick={() => setSyncQueue(p => p.filter((_, i) => i !== qi))} style={{ padding:"2px 6px", borderRadius:4, background:"#3a1a1a", border:"none", color:"#804040", fontSize:10, cursor:"pointer" }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {needsAttention.length > 0 && (
            <div style={{ padding:"8px 10px", background:"#1a1410", borderBottom:"1px solid #3a2810", flexShrink:0 }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#F6BF26", letterSpacing:1, marginBottom:4 }}>⚠ NEEDS ATTENTION</div>
              <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:4, WebkitOverflowScrolling:"touch" }}>
                {needsAttention.slice(0, 5).map(s => (
                  <div key={s.id} onClick={() => { setPipeStage(s.ck); setExpandedPipe(s.id); }} style={{ minWidth:140, padding:"6px 10px", borderRadius:8, background:"#1a1810", border:"1px solid #3a3010", cursor:"pointer", flexShrink:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
                      <Dot color={s.ck} sz={6}/><span style={{ fontSize:11, fontWeight:600, color:"#c8a050" }}>{s.cn}</span>
                    </div>
                    <div style={{ fontSize:9, color:"#8a7050" }}>{s.rule.msg}</div>
                    {s.phone && <button onClick={e => { e.stopPropagation(); setTextSheet(s); }} style={{ marginTop:4, padding:"2px 6px", borderRadius:4, background:"#039BE522", border:"none", color:"#5a9ed6", fontSize:9, cursor:"pointer" }}>💬 Text</button>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:"flex", padding:"6px 8px", gap:3, overflowX:"auto", flexShrink:0, borderBottom:"1px solid #161b25", WebkitOverflowScrolling:"touch" }}>
            {PO.map(k => {
              const cnt = todayP.filter(s => s.ck === k).length;
              return (
                <button key={k} onClick={() => setPipeStage(k)}
                  style={{ padding:"4px 10px", borderRadius:6, background: pipeStage === k ? `${C[k]}22` : "#0a0c10", border:`1px solid ${pipeStage === k ? C[k] + "60" : "#1e2536"}`, color: pipeStage === k ? C[k] : "#4a5a6a", fontSize:11, fontWeight:600, cursor:"pointer", flexShrink:0, whiteSpace:"nowrap" }}>
                  {PL[k]} {cnt > 0 && <span style={{ fontSize:9, opacity:0.7 }}>({cnt})</span>}
                </button>
              );
            })}
          </div>

          <div style={{ padding:"6px 8px", background:"#0a0c10", borderBottom:"1px solid #161b25", flexShrink:0 }}>
            <input value={pipeSearch} onChange={e => setPipeSearch(e.target.value)} placeholder="Search pipeline…"
              style={{ width:"100%", padding:"6px 10px", borderRadius:6, background:"#090b10", border:"1px solid #1e2536", color:"#e0e8f0", fontSize:12, outline:"none", boxSizing:"border-box" }}/>
          </div>

          <div className="scr" style={{ flex:1, overflowY:"auto", padding:"10px 10px max(10px, env(safe-area-inset-bottom))", WebkitOverflowScrolling:"touch" }}>
            {(() => {
              let items = todayP.filter(s => s.ck === pipeStage);
              if (pipeSearch) { const q = pipeSearch.toLowerCase(); items = items.filter(s => (s.cn||"").toLowerCase().includes(q) || (s.addr||"").toLowerCase().includes(q)); }
              if (items.length === 0) return <div style={{ textAlign:"center", padding:40, color:"#1e2536", fontSize:13 }}>No leads in {PL[pipeStage]}</div>;

              return items.map(s => {
                const isExp = expandedPipe === s.id;
                const isAging = FU_RULES.some(r => r.stage === s.ck && s.ageDays >= r.days);
                return (
                  <div key={s.id} onClick={() => setExpandedPipe(isExp ? null : s.id)}
                    style={{ background:"#0d0f14", border:`1px solid ${isAging ? "#3a2810" : "#161b25"}`, borderRadius:10, padding:"10px 12px", marginBottom:8, cursor:"pointer", WebkitTapHighlightColor:"transparent" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:600, color:"#e0e8f0" }}>{s.cn}</div>
                        {s.db && <span style={{ fontSize:11, color:WS.driveby.c }}>🚗</span>}
                      </div>
                      <span style={{ fontSize:10, color: s.ageDays > 5 ? "#c85a5a" : "#4a5a6a", fontWeight:600 }}>{s.age}</span>
                    </div>
                    {isAging && <div style={{ marginTop:4, fontSize:10, color:"#c8a050", fontStyle:"italic" }}>⚠ {FU_RULES.find(r => r.stage === s.ck)?.msg}</div>}
                    {s.autoDeclined && <div style={{ marginTop:4, fontSize:10, color:"#D50000", fontStyle:"italic" }}>Auto-declined ({AUTO_DECLINE_DAYS}d)</div>}
                    {s.jn && <a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} style={{ fontSize:10, color:"#039BE5", textDecoration:"none" }}>SO #{s.jn}</a>}
                    {isExp && (
                      <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #161b25" }}>
                        {s.phone && <div style={{ fontSize:12, color:"#8898a8", marginBottom:3 }}>📱 {s.phone}</div>}
                        {s.email && <div style={{ fontSize:12, color:"#8898a8", marginBottom:6 }}>✉ {s.email}</div>}
                        {s.notes && <div style={{ fontSize:12, color:"#6a7a8a", lineHeight:1.5, padding:"6px 0 8px", borderTop:"1px solid #0e1118" }}>{s.notes}</div>}
                        {s.con && <div style={{ fontSize:11, color:"#c85a9e", fontStyle:"italic", marginBottom:6 }}>{s.con}</div>}
                        <ContactBtns s={s} compact/>
                        <InteractionHistory stopId={s.id}/>
                        <StageButtons stop={s} compact/>
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>

      ) : (
        /* ═══ DESKPIPE KANBAN ═══ */
        <DeskPipeKanban
          stops={deskPipeStops}
          onStageChange={(id, stage) => moveStage(id, stage)}
          onCardClick={s => setPopup(s)}
          interLog={interLog}
          onTextSheet={s => setTextSheet(s)}
        />
      )}

      <NotePopup stop={popup} onClose={() => setPopup(null)} contactLog={popup ? interLog[popup.id] : []}/>
      <SoldPicker stop={soldPick} onConfirm={confirmSold} onCancel={() => setSoldPick(null)}/>
      <TextSheet stop={textSheet} onClose={() => setTextSheet(null)} onSend={(id, label) => logInteraction(id, "text", label)}/>
    </div>
  );
}
