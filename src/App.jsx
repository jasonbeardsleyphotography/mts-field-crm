import { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS FIELD CRM — Production Build
   Google Calendar OAuth · Live Read/Write · Swipe · Pipeline · Sync Queue
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const SHEET_ID = import.meta.env.VITE_GOOGLE_SHEET_ID;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets";

// ── PIPELINE ─────────────────────────────────────────────────────────────────
const C = { basil:"#0B8043", grape:"#8E24AA", peacock:"#039BE5", lavender:"#7986CB", banana:"#F6BF26", flamingo:"#E67C73", sage:"#33B679", tomato:"#D50000", blueberry:"#3F51B5", graphite:"#616161" };
const CID = { "10":"basil","3":"grape","7":"peacock","1":"lavender","5":"banana","4":"flamingo","2":"sage","11":"tomato","9":"blueberry","8":"graphite" };
const CID_REV = Object.fromEntries(Object.entries(CID).map(([k,v])=>[v,k]));
const PO = ["basil","grape","peacock","lavender","banana","flamingo","sage","tomato","blueberry"];
const PL = { basil:"New Lead", grape:"Needs Discussion", peacock:"Strong Lead", lavender:"Weaker Lead", banana:"Follow Up 1", flamingo:"Follow Up 2", sage:"Sold", tomato:"Declined", blueberry:"No Bid", graphite:"Admin" };
const WS = { am:{bg:"#0f2118",bd:"#1a4a2e",c:"#5cb878",lb:"AM"}, pm:{bg:"#0f1828",bd:"#1a3050",c:"#5a9ec8",lb:"PM"}, driveby:{bg:"#1e1a0f",bd:"#4a3f1a",c:"#c8b050",lb:"🚗 DB"}, restricted:{bg:"#280f1e",bd:"#501a3a",c:"#c85a9e"}, admin:{bg:"#141414",bd:"#2a2a2a",c:"#777",lb:"ADM"}, todo:{bg:"#141414",bd:"#2a2a2a",c:"#777",lb:"TODO"} };

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
  { label:"Initial follow-up", msg:"Hi {name}, this is Jason from MTS Tree Service. Just following up on the estimate I put together for you. Let me know if you have any questions!" },
  { label:"2nd follow-up", msg:"Hi {name}, Jason from MTS again. Wanted to check in on the proposal I sent over. Happy to walk through anything or adjust the scope. Let me know!" },
  { label:"Final check-in", msg:"Hi {name}, Jason from MTS. Just a final check-in on your tree work estimate. If you'd like to move forward or have questions, I'm here. No pressure either way!" },
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
function daysAgo(d) { if (!d) return 0; const diff = Math.floor((new Date() - new Date(d)) / 864e5); return diff <= 0 ? 0 : diff; }
function daysLabel(n) { if (n === null || n === undefined) return ""; return n === 0 ? "today" : n === 1 ? "1d" : `${n}d`; }

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

// Get business days from Monday of this week through today (for pipeline)
function getWeekDaysToToday() {
  const today = new Date(); today.setHours(0,0,0,0);
  const dow = today.getDay(); // 0=Sun, 1=Mon...
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1)); // go back to Monday
  const days = [];
  let d = new Date(monday);
  while (d <= today) {
    const dw = d.getDay();
    if (dw !== 0 && dw !== 6) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function parseEvent(ev) {
  const s = ev.summary || "", rd = ev.description || "";
  const desc = rd.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const colorKey = CID[ev.colorId] || "basil";
  const jobMatch = s.match(/Task \| #(\d+)/); const jobNum = jobMatch ? jobMatch[1] : null;
  const nameMatch = s.match(/Task \| #\d+\s+[^-]+\s*-\s*([^-]+?)(?:\s*-\s*(.*))?$/);
  const clientName = nameMatch ? nameMatch[1].trim() : s.replace(/^TODO:\s*/i, "").trim();
  const addrMatch = s.match(/Task \| #\d+\s+([^-]+?)\s*-/);
  const address = ev.location || (addrMatch ? addrMatch[1].trim() : "");
  const mobileMatch = desc.match(/Mobile:\s*([\d\-(). +]+?)(?:\s*$|\s*Email)/);
  const phoneMatch = desc.match(/Phone:\s*([\d\-(). +]+?)(?:\s*$|\s*Mobile)/);
  const phone = (mobileMatch && mobileMatch[1].trim().length > 5 ? mobileMatch[1].trim() : "") || (phoneMatch && phoneMatch[1].trim().length > 5 ? phoneMatch[1].trim() : "");
  const emailMatch = desc.match(/Email:\s*(\S+@\S+)/); const email = emailMatch ? emailMatch[1].trim() : "";
  const notesMatch = desc.match(/Notes:\s*([\s\S]*)/); const notes = notesMatch ? notesMatch[1].trim() : "";
  const isDriveBy = /drive[\s-]?by/i.test(s);
  const isMtsNote = /MTS NOTE/i.test(s) || /\*{2,}NOTE[!]*\*{2,}/i.test(s);
  const isTodo = !isMtsNote && (/^TODO:/i.test(s) || (/\bNOTE[!]*\b/i.test(s) && !jobNum));
  const isAdmin = colorKey === "graphite" && !isTodo && !isMtsNote;
  const start = new Date(ev.start?.dateTime || ev.start?.date);
  const end = new Date(ev.end?.dateTime || ev.end?.date);
  const durH = (end - start) / 36e5, startH = start.getHours();
  let winType = "standard", winLabel = "", constraint = "";
  if (isTodo) { winType = "todo"; winLabel = "TODO"; }
  else if (isAdmin) { winType = "admin"; winLabel = "ADM"; }
  else if (isDriveBy) { winType = "driveby"; winLabel = "🚗 DB"; }
  else if (durH >= 3.5 && durH <= 4.5 && startH >= 7 && startH <= 9) { winType = "am"; winLabel = "AM"; }
  else if (durH >= 3.5 && durH <= 4.5 && startH >= 10 && startH <= 12) { winType = "pm"; winLabel = "PM"; }
  else if (!isAdmin) { winType = "restricted"; const fmt = d => d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" }); winLabel = fmt(start) + "–" + fmt(end); }
  if (/NOT BEFORE\s*([\d:]+)/i.test(s)) constraint = "Not before " + s.match(/NOT BEFORE\s*([\d:]+)/i)[1];
  else if (/([\d:]+)\s*OR LATER/i.test(s)) constraint = s.match(/([\d:]+)\s*OR LATER/i)[1] + " or later";
  if (/CAN'?T MEET BEFORE\s*([\d:]+)/i.test(s)) constraint = "Not before " + s.match(/CAN'?T MEET BEFORE\s*([\d:]+)/i)[1];
  if (/CANNOT MEET BEFORE\s*(\w+)/i.test(s)) constraint = "Not before " + s.match(/CANNOT MEET BEFORE\s*(\w+)/i)[1];
  if (/CALL (WHEN|FIRST|BEFORE)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "📞 Call first";
  if (/MEET (?:AT |.+?AT )(.+?)$/i.test(s)) { const m = s.match(/MEET (?:AT |.+?AT )(.+?)$/i); if (m) constraint = (constraint ? constraint + " · " : "") + "📍 " + m[1].slice(0, 40); }
  if (/YARD STICK/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "🪧 Bring yard stick";
  const ageDays = daysAgo(ev.created);
  return { id:ev.id, cn:clientName, addr:address, phone, email, notes, desc, ck:colorKey, jn:jobNum, db:isDriveBy, isTodo, isAdm:isAdmin, isMtsNote, wt:winType, wl:winLabel, con:constraint, raw:s, rawD:rd, st:start, en:end, ageDays, age:daysLabel(ageDays) };
}

// ── GOOGLE CALENDAR API ──────────────────────────────────────────────────────
async function fetchEvents(token, dayStart, dayEnd) {
  const timeMin = dayStart.toISOString();
  const timeMax = dayEnd.toISOString();
  const url = `${CAL_BASE}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=250&timeZone=America/New_York`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(ev => ({ ...ev }));
}

async function updateEventColor(token, eventId, colorId) {
  const url = `${CAL_BASE}/events/${eventId}?sendUpdates=none`;
  const res = await fetch(url, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ colorId }) });
  return res.ok;
}

async function createCalEvent(token, summary, start, end, colorId) {
  const url = `${CAL_BASE}/events`;
  const body = { summary, start: { dateTime: start, timeZone: "America/New_York" }, end: { dateTime: end, timeZone: "America/New_York" }, colorId };
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.ok ? await res.json() : null;
}

// ── GOOGLE SHEETS API ────────────────────────────────────────────────────────
async function readSheetLog(token) {
  if (!SHEET_ID) return [];
  try {
    const url = `${SHEETS_BASE}/${SHEET_ID}/values/Sheet1!A2:G1000`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.values || []).map(row => ({
      ts: row[0] || "", eventId: row[1] || "", jn: row[2] || "",
      cn: row[3] || "", addr: row[4] || "", from: row[5] || "", to: row[6] || "",
    }));
  } catch (e) { return []; }
}

async function appendSheetLog(token, eventId, jobNum, clientName, address, fromStage, toStage) {
  if (!SHEET_ID) return;
  try {
    const ts = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month:"numeric", day:"numeric", year:"2-digit", hour:"numeric", minute:"2-digit" });
    const url = `${SHEETS_BASE}/${SHEET_ID}/values/Sheet1!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[ts, eventId, jobNum || "", clientName || "", address || "", PL[fromStage] || fromStage || "", PL[toStage] || toStage || ""]] }),
    });
  } catch (e) { /* silent fail — sheet logging is non-critical */ }
}

// Compute days since last stage change for each event from sheet log
function computeStageAge(logRows) {
  const latest = {}; // eventId -> { ts, to }
  logRows.forEach(row => {
    const prev = latest[row.eventId];
    if (!prev || new Date(row.ts) > new Date(prev.ts)) {
      latest[row.eventId] = { ts: row.ts, to: row.to };
    }
  });
  const ages = {};
  const now = new Date();
  Object.entries(latest).forEach(([id, { ts }]) => {
    const d = new Date(ts);
    if (!isNaN(d)) ages[id] = Math.floor((now - d) / 864e5);
  });
  return ages; // eventId -> days since last stage change
}

// ── COMPONENTS ───────────────────────────────────────────────────────────────
function Dot({ color, sz = 8 }) { return <div style={{ width:sz, height:sz, borderRadius:sz, background:C[color]||"#555", flexShrink:0 }}/>; }

function NotePopup({ stop, onClose, contactLog }) {
  if (!stop) return null;
  const log = contactLog || [];
  return <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
    <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:"1px solid #1e2536", borderRadius:14, padding:18, maxWidth:480, width:"100%", maxHeight:"80vh", overflowY:"auto" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
        <Dot color={stop.ck} sz={12}/><span style={{ fontSize:16, fontWeight:700, color:"#fff", flex:1 }}>{stop.cn}</span>
        {stop.jn && <a href={`https://app.singleops.com/jobs?search=${stop.jn}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:700, background:"#1a1e28", border:"1px solid #2a3040", color:"#8a95a8", textDecoration:"none" }}>SO #{stop.jn} ↗</a>}
        <button onClick={onClose} style={{ width:30, height:30, borderRadius:8, background:"#111420", border:"1px solid #1e2536", color:"#8a95a8", fontSize:16, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
      </div>
      {stop.addr && <div style={{ fontSize:13, color:"#8a95a8", marginBottom:6 }}>{stop.addr}</div>}
      {stop.phone && <div style={{ fontSize:13, color:"#8898a8", marginBottom:3 }}>📞 {stop.phone}</div>}
      {stop.email && <div style={{ fontSize:13, color:"#8898a8", marginBottom:8 }}>✉️ {stop.email}</div>}
      {stop.con && <div style={{ fontSize:12, color:"#c85a9e", fontStyle:"italic", marginBottom:10, padding:"6px 10px", background:"#1a0f18", borderRadius:6, border:"1px solid #301a28" }}>⚠ {stop.con}</div>}
      <div style={{ background:"#0a0c10", borderRadius:10, padding:14, border:"1px solid #161b25" }}>
        <div style={{ fontSize:9, fontWeight:700, color:"#5a6580", letterSpacing:1, marginBottom:6 }}>EVENT DETAILS</div>
        <div style={{ fontSize:13, color:"#e8ecf4", lineHeight:1.5, marginBottom:8 }}>{stop.raw}</div>
        {stop.rawD && <div style={{ paddingTop:8, borderTop:"1px solid #161b25", fontSize:13, color:"#a0a8b8", lineHeight:1.7 }} dangerouslySetInnerHTML={{ __html:stop.rawD }}/>}
      </div>
      {log.length > 0 && <div style={{ marginTop:10, padding:"8px 10px", background:"#0a0c10", borderRadius:8, border:"1px solid #161b25" }}>
        <div style={{ fontSize:9, fontWeight:700, color:"#5a6580", letterSpacing:1, marginBottom:6 }}>CONTACT LOG</div>
        {log.slice().reverse().map((e, i) => <div key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"3px 0", fontSize:11, color:"#8a95a8" }}><span>{e.type==="call"?"📞":"💬"}</span><span style={{color:"#8a9ab0"}}>{e.type==="call"?"Called":"Texted"}</span><span style={{marginLeft:"auto",color:"#5a6580",fontSize:10}}>{e.ts}</span></div>)}
      </div>}
      {stop.age && <div style={{ marginTop:8, fontSize:10, color:"#5a6580" }}>Created: {stop.age}</div>}
      <div style={{ display:"flex", gap:8, marginTop:14 }}>
        {stop.phone && <a href={`tel:${stop.phone.replace(/\D/g,"")}`} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#111420", border:"1px solid #1e2536", color:"#a0a8b8", fontSize:13, fontWeight:600, textDecoration:"none", textAlign:"center" }}>📞 Call</a>}
        {stop.phone && <a href={`sms:${stop.phone.replace(/\D/g,"")}`} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#111420", border:"1px solid #1e2536", color:"#a0a8b8", fontSize:13, fontWeight:600, textDecoration:"none", textAlign:"center" }}>💬 Text</a>}
        {stop.addr && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.addr)}`} target="_blank" style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#111420", border:"1px solid #1e2536", color:"#a0a8b8", fontSize:13, fontWeight:600, textDecoration:"none", textAlign:"center" }}>🧭 Nav</a>}
      </div>
    </div>
  </div>;
}

function SoldPicker({ stop, onConfirm, onCancel }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  if (!stop) return null;
  return <div onClick={onCancel} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", zIndex:210, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
    <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:`1px solid ${C.sage}44`, borderRadius:14, padding:22, maxWidth:360, width:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}><Dot color="sage" sz={14}/><span style={{ fontSize:17, fontWeight:700, color:"#fff" }}>Mark as Sold</span></div>
      <div style={{ fontSize:14, color:"#a0a8b8", marginBottom:6 }}>{stop.cn}</div>
      <div style={{ marginBottom:6, fontSize:11, fontWeight:700, color:"#8a95a8", letterSpacing:1 }}>SOLD DATE</div>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width:"100%", padding:"10px 14px", borderRadius:8, border:`1px solid ${C.sage}33`, background:"#0a0c10", color:"#f0f4fa", fontSize:15, fontWeight:600, outline:"none", boxSizing:"border-box", colorScheme:"dark" }}/>
      <div style={{ display:"flex", gap:10, marginTop:18 }}>
        <button onClick={onCancel} style={{ flex:1, padding:"10px 0", borderRadius:8, background:"#111420", border:"1px solid #1e2536", color:"#8a95a8", fontSize:13, fontWeight:600, cursor:"pointer" }}>Cancel</button>
        <button onClick={() => onConfirm(date)} style={{ flex:1, padding:"10px 0", borderRadius:8, background:C.sage+"22", border:`1px solid ${C.sage}55`, color:C.sage, fontSize:13, fontWeight:700, cursor:"pointer" }}>Confirm Sold</button>
      </div>
    </div>
  </div>;
}

function TextSheet({ stop, onClose, onSend }) {
  const [custom, setCustom] = useState("");
  if (!stop) return null;
  const fn = (stop.cn || "").split(" ")[0], ph = (stop.phone || "").replace(/\D/g, "");
  const send = (msg, label) => { window.open(`sms:+1${ph}&body=${encodeURIComponent(msg.replace("{name}", fn))}`, "_self"); if (onSend) onSend(stop.id, label); onClose(); };
  return <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", backdropFilter:"blur(4px)", zIndex:205, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
    <div onClick={e => e.stopPropagation()} style={{ background:"#0d0f14", border:"1px solid #1e2536", borderRadius:"14px 14px 0 0", padding:18, maxWidth:480, width:"100%", maxHeight:"70vh", overflowY:"auto" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
        <span style={{ fontSize:15, fontWeight:700, color:"#fff", flex:1 }}>Text {fn}</span>
        <span style={{ fontSize:12, color:"#8a95a8" }}>{stop.phone}</span>
        <button onClick={onClose} style={{ width:28, height:28, borderRadius:6, background:"#111420", border:"1px solid #1e2536", color:"#8a95a8", fontSize:14, cursor:"pointer" }}>✕</button>
      </div>
      {TEXT_TEMPLATES.map((t, i) => <button key={i} onClick={() => send(t.msg, t.label)} style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 12px", marginBottom:6, borderRadius:8, background:"#111420", border:"1px solid #1e2536", cursor:"pointer" }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#039BE5", marginBottom:3 }}>{t.label}</div>
        <div style={{ fontSize:12, color:"#8898a8", lineHeight:1.4 }}>{t.msg.replace("{name}", fn)}</div>
      </button>)}
      <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Or type custom..." style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1px solid #1e2536", background:"#0a0c10", color:"#f0f4fa", fontSize:13, outline:"none", boxSizing:"border-box", marginTop:4 }}/>
      {custom.trim() && <button onClick={() => send(custom, "custom")} style={{ marginTop:6, width:"100%", padding:"10px 0", borderRadius:8, background:"#039BE522", border:"1px solid #039BE544", color:"#039BE5", fontSize:13, fontWeight:700, cursor:"pointer" }}>Send Custom</button>}
    </div>
  </div>;
}

// ── GOOGLE MAPS ──────────────────────────────────────────────────────────────
const ZC = { "14618":[43.12,-77.57],"14526":[43.155,-77.45],"14625":[43.14,-77.51],"14450":[43.10,-77.44],"14502":[43.07,-77.30],"14424":[42.87,-77.28],"14543":[42.99,-77.64],"14534":[43.09,-77.52],"14580":[43.21,-77.43],"14472":[42.95,-77.59],"14445":[43.11,-77.49],"14607":[43.15,-77.59],"14610":[43.14,-77.57] };
function getFallbackCoords(addr) {
  const z = (addr||"").match(/\b(1\d{4})\b/);
  return z && ZC[z[1]] ? { lat:ZC[z[1]][0], lng:ZC[z[1]][1] } : { lat:43.12, lng:-77.50 };
}

// Load Google Maps script once
let mapsPromise = null;
function loadMapsAPI() {
  if (window.google?.maps?.Map) return Promise.resolve(); // already loaded
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.Map) { resolve(); return; }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    script.async = true;
    script.onload = () => {
      if (window.google?.maps?.Map) resolve();
      else reject(new Error("Maps loaded but Map class not found"));
    };
    script.onerror = () => { mapsPromise = null; reject(new Error("Failed to load Google Maps")); };
    document.head.appendChild(script);
  });
  return mapsPromise;
}

// Geocode cache to avoid re-geocoding same addresses
const geocodeCache = {};
// Rochester area zip-to-city lookup for accurate geocoding
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
  // Check if city name is already in the address
  if (new RegExp(city, "i").test(addr)) {
    if (!/\bNY\b/i.test(addr)) return addr + ", NY";
    return addr;
  }
  // Insert city and state before zip
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

// Dark map style
const DARK_STYLE = [
  { elementType:"geometry", stylers:[{color:"#0d0f14"}] },
  { elementType:"labels.text.stroke", stylers:[{color:"#0d0f14"}] },
  { elementType:"labels.text.fill", stylers:[{color:"#5a6580"}] },
  { featureType:"road", elementType:"geometry", stylers:[{color:"#2a3550"}] },
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
  const [status, setStatus] = useState("init");
  const [coords, setCoords] = useState({});

  // Load Google Maps API
  useEffect(() => {
    if (!MAPS_KEY) { setStatus("err:No Maps API key found"); return; }
    setStatus("loading...");
    loadMapsAPI()
      .then(() => setStatus("ready"))
      .catch(e => setStatus("err:" + e.message));
  }, []);

  // Create map when ready
  useEffect(() => {
    if (status !== "ready" || !mapRef.current || mapInstance.current) return;
    try {
      mapInstance.current = new window.google.maps.Map(mapRef.current, {
        center: { lat: 43.12, lng: -77.50 }, zoom: 11,
        styles: DARK_STYLE, disableDefaultUI: true,
        zoomControl: false, mapTypeControl: false, scaleControl: false,
        streetViewControl: false, rotateControl: false, fullscreenControl: false,
        keyboardShortcuts: false, clickableIcons: false,
        gestureHandling: "greedy", backgroundColor: "#0d0f14",
      });
      setStatus("map-created");
    } catch (e) { setStatus("err:Map create failed - " + e.message); }
  }, [status]);

  // Geocode addresses
  useEffect(() => {
    if (status !== "map-created" && status !== "ready") return;
    if (!stops.length) return;
    let cancelled = false;
    async function geo() {
      const newCoords = {};
      for (let i = 0; i < stops.length; i++) {
        if (cancelled) break;
        const s = stops[i];
        if (!s.addr || s.addr.trim().length < 5) continue;
        try {
          const result = await geocodeAddress(s.addr);
          if (result) newCoords[s.id] = result;
        } catch (e) { /* skip */ }
        if (i < stops.length - 1) await new Promise(r => setTimeout(r, 200));
      }
      if (!cancelled) setCoords(newCoords);
    }
    geo();
    return () => { cancelled = true; };
  }, [status, stops.map(s => s.id + s.addr).join(",")]);

  const prevStopSetRef = useRef("");

  // Place markers and route
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];
    if (directionsRenderer.current) { directionsRenderer.current.setMap(null); directionsRenderer.current = null; }
    if (!Object.keys(coords).length) return;

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
          strokeColor: isActive ? "#fff" : s.db ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.2)",
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
      try {
        const ds = new window.google.maps.DirectionsService();
        ds.route({
          origin: positions[0], destination: positions[positions.length - 1],
          waypoints: positions.slice(1, -1).map(p => ({ location: p, stopover: true })).slice(0, 23),
          travelMode: window.google.maps.TravelMode.DRIVING, optimizeWaypoints: false,
        }, (result, s) => {
          if (s === "OK") {
            directionsRenderer.current = new window.google.maps.DirectionsRenderer({
              map, directions: result, suppressMarkers: true,
              polylineOptions: { strokeColor: "#039BE5", strokeOpacity: 0.7, strokeWeight: 4 },
            });
          } else {
            const pl = new window.google.maps.Polyline({ path: positions, strokeColor: "#039BE5", strokeOpacity: 0.5, strokeWeight: 3, map });
            directionsRenderer.current = { setMap: m => pl.setMap(m) };
          }
        });
      } catch (e) {
        const pl = new window.google.maps.Polyline({ path: positions, strokeColor: "#039BE5", strokeOpacity: 0.5, strokeWeight: 3, map });
        directionsRenderer.current = { setMap: m => pl.setMap(m) };
      }
    }

    // Only fitBounds when the SET of stops changes (new day, add/remove) — NOT on reorder
    const stopSet = [...stops.map(s => s.id)].sort().join(",");
    if (positions.length > 0 && stopSet !== prevStopSetRef.current) {
      map.fitBounds(bounds, { top: 20, right: 20, bottom: 20, left: 20 });
      prevStopSetRef.current = stopSet;
    }
  }, [coords, stops, activeIdx, onSelect]);

  const showStatus = status.startsWith("err:") || status === "init" || status === "loading...";
  return <div ref={mapRef} style={{ width:"100%", height:220, background:"#0d0f14" }}>
    {showStatus && <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100%", color:status.startsWith("err:")?"#c85a5a":"#5a6580", fontSize:11, padding:10, textAlign:"center" }}>
      {status.startsWith("err:") ? status.slice(4) : status}
    </div>}
  </div>;
}

// ── SWIPE CARD ───────────────────────────────────────────────────────────────
function SwipeCard({ children, onSwipeRight, onSwipeLeft, enabled }) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startX = useRef(0); const startY = useRef(0); const dirLocked = useRef(null);
  const handleStart = e => { if(!enabled)return; startX.current=e.touches[0].clientX; startY.current=e.touches[0].clientY; dirLocked.current=null; setSwiping(true); };
  const handleMove = e => { if(!swiping||!enabled)return; const dx=e.touches[0].clientX-startX.current,dy=e.touches[0].clientY-startY.current; if(dirLocked.current===null&&(Math.abs(dx)>8||Math.abs(dy)>8)){dirLocked.current=Math.abs(dx)>Math.abs(dy)?"h":"v";} if(dirLocked.current==="v")return; if(dirLocked.current==="h"){e.preventDefault();e.stopPropagation();setOffset(dx);} };
  const handleEnd = () => { if(offset>100&&onSwipeRight)onSwipeRight(); else if(offset<-100&&onSwipeLeft)onSwipeLeft(); setOffset(0);setSwiping(false);dirLocked.current=null; };
  const absOff=Math.abs(offset),revealOpacity=Math.min(absOff/80,1),cardOpacity=1-Math.min(absOff/250,.5),isRight=offset>0;
  return <div style={{position:"relative",overflow:"hidden"}}>
    {absOff>20&&<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:isRight?"flex-start":"flex-end",justifyContent:"center",padding:"0 16px",opacity:revealOpacity,background:isRight?`${C.sage}18`:`${C.peacock}18`}}>
      <div style={{fontSize:18,fontWeight:800,color:isRight?C.sage:C.peacock}}>{isRight?"✓":"🧭"}</div>
      <div style={{fontSize:11,fontWeight:700,color:isRight?C.sage:C.peacock,marginTop:2}}>{isRight?"Done":"Navigate"}</div>
    </div>}
    <div onTouchStart={handleStart} onTouchMove={handleMove} onTouchEnd={handleEnd} style={{transform:`translateX(${offset}px)`,opacity:cardOpacity,transition:swiping?"none":"transform .25s ease, opacity .25s ease",position:"relative",zIndex:1,touchAction:"pan-y"}}>{children}</div>
  </div>;
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
  const [rawEvents, setRawEvents] = useState({}); // { "2026-03-24": [...events] }
  const [sheetLog, setSheetLog] = useState([]); // rows from sheet
  const [stageAges, setStageAges] = useState({}); // eventId -> days since last stage change
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
      const forwardDays = getBusinessDays(10);
      const weekDays = getWeekDaysToToday();
      // Merge and dedupe: past week days + forward days
      const seen = new Set();
      const allDays = [];
      [...weekDays, ...forwardDays].forEach(d => {
        const k = d.toDateString();
        if (!seen.has(k)) { seen.add(k); allDays.push(d); }
      });
      setBusinessDays(forwardDays); // dropdown still shows forward days
      const all = {};
      for (const day of allDays) {
        const start = new Date(day); start.setHours(0,0,0,0);
        const end = new Date(day); end.setHours(23,59,59,999);
        const evts = await fetchEvents(token, start, end);
        all[day.toDateString()] = evts;
      }
      setRawEvents(all);
      setOrdIds({}); // reset so stops re-initialize from fresh data
      setSelDay(0);
      setDismissed({});
      setActStop(null);
      // Read sheet log for stage change history
      const log = await readSheetLog(token);
      setSheetLog(log);
      setStageAges(computeStageAge(log));
    } catch (e) {
      setError(`Failed to load: ${e.message}`);
      if (e.message.includes("401")) setToken(null); // token expired
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
      if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) { p.ck = "tomato"; p.autoDeclined = true; }
      return p;
    });
  }, [rawEvents, dayKey, soldDates]);

  const todayParsed = useMemo(() => {
    const raw = rawEvents[todayKey] || [];
    return raw.map(parseEvent).map(p => {
      if (soldDates[p.id]) p.soldDate = soldDates[p.id];
      if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) { p.ck = "tomato"; p.autoDeclined = true; }
      return p;
    });
  }, [rawEvents, todayKey, soldDates]);

  const [ordIds, setOrdIds] = useState({});
  useEffect(() => {
    const key = dayKey;
    if (!key || !dayParsed.length) return; // no key or no events yet — wait
    if (ordIds[key]?.length > 0) return; // already initialized with real data
    setOrdIds(prev => ({ ...prev, [key]: dayParsed.map(e => e.id) }));
  }, [dayKey, dayParsed]);

  const currentOrd = (ordIds[dayKey]?.length > 0) ? ordIds[dayKey] : dayParsed.map(e => e.id);
  const pmMap = useMemo(() => { const m = {}; dayParsed.forEach(p => { m[p.id] = p; }); return m; }, [dayParsed]);

  const allStops = currentOrd.map(id => pmMap[id]).filter(Boolean).filter(s => !s.isMtsNote);
  const allClientStops = allStops.filter(s => !s.isAdm && !s.isTodo);
  const cs = allClientStops.filter(s => !dismissed[s.id]);
  const completedStops = allClientStops.filter(s => dismissed[s.id]);
  const todos = allStops.filter(s => s.isTodo);
  const admins = allStops.filter(s => s.isAdm && !s.isTodo);
  const todayP = todayParsed.filter(s => !s.isAdm && !s.isTodo && !s.isMtsNote);

  // Pipeline events: this week (Mon–today), deduped — used by Pipeline tab and DeskPipe
  const pipelineEvents = useMemo(() => {
    const today = new Date(); today.setHours(23,59,59,999);
    const weekDays = getWeekDaysToToday();
    const weekKeys = new Set(weekDays.map(d => d.toDateString()));
    const seen = new Set();
    const all = [];
    Object.entries(rawEvents).forEach(([dayStr, dayEvts]) => {
      if (!weekKeys.has(dayStr)) return; // skip future days and old weeks
      dayEvts.forEach(ev => {
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
        const p = parseEvent(ev);
        if (soldDates[p.id]) p.soldDate = soldDates[p.id];
        if (AUTO_DECLINE_STAGES.includes(p.ck) && p.ageDays >= AUTO_DECLINE_DAYS) { p.ck = "tomato"; p.autoDeclined = true; }
        if (!p.isAdm && !p.isTodo && !p.isMtsNote) all.push(p);
      });
    });
    return all;
  }, [rawEvents, soldDates]);

  // Use sheet-based stage age if available, fall back to event creation date
  const getStageAge = (s) => stageAges[s.id] !== undefined ? stageAges[s.id] : s.ageDays;
  const needsAttention = useMemo(() => FU_RULES.flatMap(rule => pipelineEvents.filter(s => s.ck === rule.stage && getStageAge(s) >= rule.days).map(s => ({...s, stageAge: getStageAge(s), rule}))), [pipelineEvents, stageAges]);

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

  const handleTap = idx => {
    if (!reorderMode) return;
    if (moving === null) { setMoving(idx); setActStop(null); }
    else if (moving === idx) { setMoving(null); }
    else {
      const key = dayKey;
      const prevIds = [...(ordIds[key] || [])];
      const ids = [...prevIds];
      const cIds = ids.filter(id => { const p = pmMap[id]; return p && !p.isAdm && !p.isTodo && !dismissed[id]; });
      const fId = cIds[moving], tId = cIds[idx];
      const fi = ids.indexOf(fId); ids.splice(fi, 1);
      const ti = ids.indexOf(tId); ids.splice(moving < idx ? ti+1 : ti, 0, fId);
      setUndoStack(u => [...u, { type:"reorder", key, prevIds }]);
      setOrdIds(prev => ({ ...prev, [key]: ids }));
      setMoving(null);
    }
  };

  const addToSync = (stopId, toStage) => {
    const s = pmMap[stopId]; if (!s || !s.jn) return;
    const actionMap = { sage:"Mark SOLD", tomato:"Mark DECLINED", blueberry:"Mark NO BID", graphite:"Mark COMPLETED" };
    const action = actionMap[toStage];
    if (action) setSyncQueue(q => [...q.filter(x => x.id !== stopId), { id:stopId, cn:s.cn, jn:s.jn, action, stage:toStage, ts:new Date().toLocaleString() }]);
  };

  // Helper to find a stop across all data sources
  const findStop = (id) => pmMap[id] || pipelineEvents.find(s => s.id === id) || {};

  const moveStage = async (stopId, toStage) => {
    if (toStage === "sage") { setSoldPick({ id:stopId, ...findStop(stopId), prevStage:findStop(stopId)?.ck }); return; }
    const stop = findStop(stopId);
    const prevCk = stop?.ck;
    setUndoStack(u => [...u, { type:"stage", id:stopId, prev:prevCk }]);
    addToSync(stopId, toStage);
    // Write to Google Calendar
    const colorId = CID_REV[toStage];
    if (token && colorId) {
      await updateEventColor(token, stopId, colorId);
      // Log to Google Sheet
      appendSheetLog(token, stopId, stop.jn, stop.cn, stop.addr, prevCk, toStage);
      loadEvents(); // refresh to see change
    }
  };

  const confirmSold = async (date) => {
    if (!soldPick) return;
    setUndoStack(u => [...u, { type:"stage", id:soldPick.id, prev:soldPick.prevStage }]);
    setSoldDates(p => ({ ...p, [soldPick.id]: date }));
    addToSync(soldPick.id, "sage");
    if (token) {
      await updateEventColor(token, soldPick.id, "2");
      appendSheetLog(token, soldPick.id, soldPick.jn, soldPick.cn, soldPick.addr, soldPick.prevStage, "sage");
      loadEvents();
    }
    setSoldPick(null);
  };

  const dismissStop = id => { setUndoStack(u => [...u, { type:"dismiss", id }]); setDismissed(p => ({...p, [id]:true})); setActStop(null); };
  const undismissStop = id => { setDismissed(p => { const n={...p}; delete n[id]; return n; }); };

  const undo = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack(u => u.slice(0, -1));
    if (last.type === "stage") {
      const colorId = CID_REV[last.prev];
      if (token && colorId) { updateEventColor(token, last.id, colorId); loadEvents(); }
      setSoldDates(p => { const n={...p}; delete n[last.id]; return n; });
    } else if (last.type === "reorder") { setOrdIds(prev => ({ ...prev, [last.key]: last.prevIds })); }
    else if (last.type === "dismiss") { undismissStop(last.id); }
  };

  const logInteraction = (stopId, type, detail) => { setInterLog(prev => ({...prev, [stopId]:[...(prev[stopId]||[]),{type,ts:new Date().toLocaleString("en-US",{month:"numeric",day:"numeric",hour:"numeric",minute:"2-digit"}),detail}]})); };

  const navUrl = useMemo(() => { const a=cs.filter(s=>s.addr).map(s=>s.addr); if(a.length<2)return a.length===1?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a[0])}`:null; return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(a[0])}&destination=${encodeURIComponent(a[a.length-1])}${a.length>2?`&waypoints=${a.slice(1,-1).map(encodeURIComponent).join("|")}`:""}`;}, [cs]);

  const Badge = ({s}) => { const w=WS[s.wt]||WS.am; return <span style={{padding:"2px 8px",borderRadius:5,fontSize:10,fontWeight:700,background:w.bg,border:`1px solid ${w.bd}`,color:w.c,whiteSpace:"nowrap"}}>{w.lb||s.wl}</span>; };
  const StageButtons = ({stop,compact}) => { const stages=[...PO,"graphite"]; return <div style={{display:"flex",gap:compact?3:4,flexWrap:"wrap",marginTop:compact?4:8}}>{stages.filter(k=>k!==stop.ck).map(k=><button key={k} onClick={e=>{e.stopPropagation();moveStage(stop.id,k);}} style={{padding:compact?"2px 5px":"3px 7px",borderRadius:4,background:"transparent",border:`1px solid ${C[k]||"#555"}25`,color:C[k]||"#555",fontSize:compact?8:9,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:2}}><Dot color={k} sz={compact?3:4}/>{compact?(k==="graphite"?"Done":PL[k]?.split(" ")[0]?.slice(0,4)):(k==="graphite"?"Admin / Done":PL[k])}</button>)}</div>; };
  const ContactBtns = ({s,compact}) => <div style={{display:"flex",gap:compact?4:8,marginTop:compact?6:8}}>{s.phone&&<a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>{e.stopPropagation();logInteraction(s.id,"call",s.phone);}} style={{flex:1,padding:compact?"7px 0":"10px 0",borderRadius:8,background:"#111420",border:"1px solid #1e2536",color:"#a0a8b8",fontSize:compact?11:13,fontWeight:600,textDecoration:"none",textAlign:"center"}}>📞</a>}{s.phone&&<button onClick={e=>{e.stopPropagation();logInteraction(s.id,"text","templates");setTextSheet(s);}} style={{flex:1,padding:compact?"7px 0":"10px 0",borderRadius:8,background:"#111420",border:"1px solid #1e2536",color:"#a0a8b8",fontSize:compact?11:13,fontWeight:600,cursor:"pointer"}}>💬</button>}{s.addr&&<a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.addr)}`} target="_blank" onClick={e=>e.stopPropagation()} style={{flex:1,padding:compact?"7px 0":"10px 0",borderRadius:8,background:"#111420",border:"1px solid #1e2536",color:"#a0a8b8",fontSize:compact?11:13,fontWeight:600,textDecoration:"none",textAlign:"center"}}>🧭</a>}<button onClick={e=>{e.stopPropagation();setPopup(s);}} style={{flex:1,padding:compact?"7px 0":"10px 0",borderRadius:8,background:C[s.ck]+"15",border:`1px solid ${C[s.ck]}33`,color:C[s.ck],fontSize:compact?11:13,fontWeight:600,cursor:"pointer"}}>Full</button></div>;
  const InteractionHistory = ({stopId}) => { const log=interLog[stopId]; if(!log?.length)return null; return <div style={{marginTop:6,padding:"6px 8px",background:"#0a0c12",borderRadius:6,border:"1px solid #161b25"}}><div style={{fontSize:8,fontWeight:700,color:"#5a6580",letterSpacing:1,marginBottom:4}}>CONTACT LOG</div>{log.slice(-5).reverse().map((e,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 0",fontSize:10,color:"#8a95a8"}}><span>{e.type==="call"?"📞":"💬"}</span><span style={{color:"#8a9ab0"}}>{e.type==="call"?"Called":"Texted"}</span><span style={{marginLeft:"auto",color:"#5a6580"}}>{e.ts}</span></div>)}</div>; };

  // ═══ SIGN IN SCREEN ═══════════════════════════════════════════════════
  if (!token) {
    return <div style={{ height:"100dvh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#090b10", fontFamily:"Inter,-apple-system,sans-serif", color:"#f0f4fa", padding:20 }}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"/>
      <div style={{ fontSize:28, fontWeight:800, marginBottom:4 }}>MTS Field CRM</div>
      <div style={{ fontSize:13, color:"#7a8a9a", marginBottom:32 }}>Sales & Route Planning</div>
      <button onClick={initAuth} style={{ padding:"14px 32px", borderRadius:10, background:"#2a3550", border:"1px solid #2a3548", color:"#f0f4fa", fontSize:15, fontWeight:700, cursor:"pointer" }}>Sign in with Google</button>
      {error && <div style={{ marginTop:16, color:"#D50000", fontSize:12 }}>{error}</div>}
    </div>;
  }

  // ═══ LOADING ═══════════════════════════════════════════════════════════
  if (loading && !Object.keys(rawEvents).length) {
    return <div style={{ height:"100dvh", display:"flex", alignItems:"center", justifyContent:"center", background:"#090b10", color:"#7a8a9a", fontFamily:"Inter,sans-serif" }}>
      <div style={{ textAlign:"center" }}><div style={{ fontSize:16, fontWeight:600, marginBottom:8 }}>Loading your calendar...</div><div style={{ fontSize:11 }}>Fetching {businessDays.length} business days</div></div>
    </div>;
  }

  // ═══ MAIN APP ═════════════════════════════════════════════════════════
  const dayLabels = businessDays.map((d, i) => {
    const opts = { weekday:"short", month:"numeric", day:"numeric" };
    const label = d.toLocaleDateString("en-US", opts);
    const isToday = d.toDateString() === new Date().toDateString();
    return { label: label + (isToday ? " (Today)" : ""), d };
  });

  return (
    <div ref={cRef} style={{height:"100dvh",width:"100%",background:"#090b10",display:"flex",flexDirection:"column",fontFamily:"'Inter',-apple-system,system-ui,sans-serif",color:"#f0f4fa",overflow:"hidden"}}>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <style>{`.scr::-webkit-scrollbar{width:3px}.scr::-webkit-scrollbar-track{background:transparent}.scr::-webkit-scrollbar-thumb{background:#1e253644;border-radius:2px}.safe-bottom{padding-bottom:max(8px,env(safe-area-inset-bottom))}.gmnoprint,.gm-bundled-control,.gm-style-cc,.gm-control-active,.gm-fullscreen-control,.gm-style .adp,.gm-style .adp-placemark{display:none!important}.gm-style button[title]{display:none!important}`}</style>

      {/* NAV */}
      <div style={{display:"flex",alignItems:"center",gap:4,padding:"6px 8px",background:"#0d0f14",borderBottom:"1px solid #161b25",flexShrink:0,zIndex:20}}>
        <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setActStop(null);setMoving(null);setReorderMode(false);setDismissed({});}} style={{padding:"5px 8px",borderRadius:6,border:"1px solid #1e2536",background:"#0a0c12",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",outline:"none",appearance:"auto",WebkitAppearance:"auto"}}>
          {dayLabels.map((d,i)=><option key={i} value={i}>{d.label}</option>)}
        </select>
        {!searchOpen?<>
          <button onClick={()=>{setSearchOpen(true);setTimeout(()=>searchRef.current?.focus(),50);}} style={{width:28,height:28,borderRadius:6,background:"transparent",border:"1px solid #1e2536",color:"#5a6580",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>🔍</button>
          <button onClick={undo} style={{width:28,height:28,borderRadius:6,background:undoStack.length?"#1e253666":"transparent",border:"1px solid #1e2536",color:undoStack.length?"#a0a8b8":"#2a3550",fontSize:12,cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} disabled={!undoStack.length}>↩</button>
          <button onClick={loadEvents} style={{width:28,height:28,borderRadius:6,background:loading?"#1e253666":"transparent",border:"1px solid #1e2536",color:loading?"#039BE5":"#5a6580",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}} title="Refresh">⟳</button>
        </>:
        <div style={{display:"flex",alignItems:"center",gap:3,flex:1,minWidth:0}}>
          <input ref={searchRef} value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"){setSearchOpen(false);setSearchQ("");}}} placeholder="Name or address..." style={{flex:1,padding:"5px 8px",borderRadius:6,border:"1px solid #1e2536",background:"#0a0c12",color:"#f0f4fa",fontSize:12,outline:"none",minWidth:0}}/>
          <button onClick={()=>{setSearchOpen(false);setSearchQ("");}} style={{padding:"4px 6px",borderRadius:5,background:"transparent",border:"none",color:"#8a95a8",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>✕</button>
        </div>}
        {!searchOpen&&<div style={{flex:1}}/>}
        {!searchOpen&&<div style={{display:"flex",gap:2,background:"#0a0c12",borderRadius:7,padding:2}}>
          {[{k:"route",l:"Route"},{k:"pipeline",l:"Pipeline"},{k:"deskpipe",l:"DeskPipe"}].map(v=><button key={v.k} onClick={()=>{setView(v.k);setActStop(null);setMoving(null);setReorderMode(false);}} style={{padding:"4px 10px",borderRadius:5,border:"none",background:view===v.k?"#2a3550":"transparent",color:view===v.k?"#fff":"#5a6580",fontSize:12,fontWeight:600,cursor:"pointer",position:"relative"}}>{v.l}{v.k==="pipeline"&&syncQueue.length>0&&<span style={{position:"absolute",top:-2,right:-2,width:14,height:14,borderRadius:7,background:"#F4511E",color:"#fff",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{syncQueue.length}</span>}</button>)}
        </div>}
        <button onClick={()=>setShowLeg(!showLeg)} style={{width:28,height:28,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",background:showLeg?"#2a3550":"transparent",border:"1px solid #1e2536",color:"#5a6580",fontSize:12,cursor:"pointer",flexShrink:0}}>🎨</button>
        {showLeg&&<div onClick={()=>setShowLeg(false)} style={{position:"fixed",inset:0,zIndex:99}}><div onClick={e=>e.stopPropagation()} style={{position:"absolute",top:44,right:8,background:"#0d0f14",border:"1px solid #1e2536",borderRadius:12,padding:14,width:200,boxShadow:"0 16px 50px rgba(0,0,0,.6)",zIndex:100}}>
          {PO.map(k=><div key={k} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0"}}><Dot color={k} sz={9}/><span style={{fontSize:11,color:"#a0a8b8"}}>{PL[k]}</span></div>)}
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0"}}><Dot color="graphite" sz={9}/><span style={{fontSize:11,color:"#a0a8b8"}}>Admin / Done</span></div>
        </div></div>}
      </div>

      {/* TODO */}
      <div style={{background:"#0b0d12",borderBottom:"1px solid #161b25",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",padding:"4px 10px",gap:5}}>
          <button onClick={()=>setTodoOpen(!todoOpen)} style={{background:"none",border:"none",color:"#5a6580",fontSize:11,cursor:"pointer",fontWeight:700,letterSpacing:1,display:"flex",alignItems:"center",gap:4}}>
            <span style={{transform:todoOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>TODO
            {todos.length>0&&<span style={{background:"#2a3550",borderRadius:10,padding:"0 6px",fontSize:10,color:"#8a95a8"}}>{todos.length}</span>}
          </button>
          <div style={{flex:1}}/>
          {!todoInput?<button onClick={()=>{setTodoInput(true);setTodoOpen(true);setTimeout(()=>todoRef.current?.focus(),50);}} style={{width:22,height:22,borderRadius:5,background:"transparent",border:"1px dashed #1e2536",color:"#5a6580",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>:
          <div style={{display:"flex",gap:4}}>
            <input ref={todoRef} value={todoText} onChange={e=>setTodoText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addTodo();if(e.key==="Escape"){setTodoInput(false);setTodoText("");}}} placeholder="TODO..." style={{padding:"3px 8px",borderRadius:5,border:"1px solid #1e2536",background:"#111420",color:"#f0f4fa",fontSize:12,width:160,outline:"none"}}/>
            <button onClick={addTodo} style={{padding:"3px 8px",borderRadius:5,border:"none",background:"#33B67933",color:"#33B679",fontSize:10,fontWeight:700,cursor:"pointer"}}>Add</button>
          </div>}
        </div>
        {todoOpen&&todos.length>0&&<div style={{padding:"0 10px 8px"}}>{todos.map(t=><div key={t.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,background:"#101318",border:"1px solid #1e2536",marginBottom:4}}>
          <div style={{width:16,height:16,borderRadius:4,border:"2px solid #333",flexShrink:0}}/>
          <span style={{fontSize:13,fontWeight:500,color:"#a0a8b8",flex:1}}>{(t.cn||"").replace(/^TODO:\s*/i,"").trim()}</span>
        </div>)}</div>}
      </div>

      {/* ═══ ROUTE ═══ */}
      {view === "route" ? (
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Fixed top: reorder banner + map + controls */}
          <div style={{flexShrink:0}}>
            {reorderMode&&<div style={{padding:"6px 12px",background:"#1a0f28",borderBottom:"1px solid #301a40",display:"flex",alignItems:"center",gap:8}}>
              {moving!==null?<><Dot color={cs[moving]?.ck||"basil"} sz={10}/><span style={{fontSize:12,fontWeight:600,color:"#c8a0e8"}}>Moving: {cs[moving]?.cn} — tap destination</span><button onClick={()=>setMoving(null)} style={{marginLeft:"auto",padding:"3px 8px",borderRadius:5,background:"#2a3550",border:"none",color:"#a0a8b8",fontSize:10,cursor:"pointer"}}>Deselect</button></>:
              <span style={{fontSize:12,fontWeight:500,color:"#9a80c8"}}>↕ Tap a stop to pick it up</span>}
            </div>}
            <div style={{borderBottom:"1px solid #161b25"}}>
              <div style={{display:"flex",alignItems:"center"}}>
                <button onClick={()=>setMapOpen(!mapOpen)} style={{flex:1,padding:"8px 12px",background:"#0a0c12",border:"none",color:"#5a7090",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
                  <span style={{transform:mapOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>
                  🗺 {cs.length} stops{completedStops.length>0?` · ${completedStops.length} done`:""}
                </button>
                <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setActStop(null);}}} style={{padding:"6px 10px",margin:"4px 2px",borderRadius:8,background:reorderMode?"#8E24AA22":"#1e253644",border:`1px solid ${reorderMode?"#8E24AA55":"#2a3550"}`,color:reorderMode?"#c8a0e8":"#5a7090",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>{reorderMode?"✕ Done":"↕ Reorder"}</button>
                {navUrl&&<a href={navUrl} target="_blank" rel="noopener noreferrer" style={{padding:"6px 10px",margin:"4px 4px 4px 0",borderRadius:8,background:"#039BE518",border:"1px solid #039BE533",color:"#039BE5",fontSize:11,fontWeight:700,textDecoration:"none",whiteSpace:"nowrap",flexShrink:0}}>🧭 All</a>}
              </div>
              {mapOpen&&cs.length>0&&<RouteMap stops={cs} activeIdx={moving!==null?moving:actStop} onSelect={i=>{if(reorderMode)handleTap(i);else setActStop(actStop===i?null:i);}}/>}
            </div>
            {admins.length>0&&<div style={{padding:"5px 10px",display:"flex",gap:4,flexWrap:"wrap",borderBottom:"1px solid #0e1018"}}>{admins.map(a=><span key={a.id} style={{padding:"3px 8px",borderRadius:6,background:"#0d0f14",border:"1px solid #161b25",fontSize:10,color:"#555"}}>⚫ {a.cn}</span>)}</div>}
          </div>

          {/* Scrollable card list */}
          <div className="scr" style={{flex:1,overflowY:"auto",paddingBottom:"max(12px, env(safe-area-inset-bottom))"}}>
          {(()=>{
            const q=searchQ.toLowerCase();
            const list=q?cs.filter(s=>(s.cn||"").toLowerCase().includes(q)||(s.addr||"").toLowerCase().includes(q)||(s.jn||"").includes(q)):cs;
            if(q&&list.length===0)return <div style={{padding:30,textAlign:"center",color:"#5a6580",fontSize:13}}>No matches</div>;
            let sn=0;
            return list.map((s,idx)=>{
              sn++;const isA=actStop===idx;const isMov=moving===idx;const isNext=idx===0&&!reorderMode;
              return <SwipeCard key={s.id} enabled={!reorderMode} onSwipeRight={()=>dismissStop(s.id)} onSwipeLeft={()=>{if(s.addr)window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.addr)}`,"_blank");}}>
                <div onClick={()=>{if(reorderMode)handleTap(idx);else setActStop(isA?null:idx);}} style={{padding:isNext?"12px 14px":"10px 14px",borderBottom:"1px solid #0e1018",cursor:reorderMode?"grab":"pointer",background:isMov?"#1a0f28":reorderMode?"#0a0c12":isNext?"#0d1520":isA?"#0f1520":"transparent",borderLeft:`4px solid ${isMov?"#8E24AA":isNext?C[s.ck]:isA&&!reorderMode?C[s.ck]:"transparent"}`,opacity:reorderMode&&!isMov&&moving!==null?.7:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:isNext?34:30,height:isNext?34:30,borderRadius:"50%",background:C[s.ck],display:"flex",alignItems:"center",justifyContent:"center",fontSize:isNext?15:13,fontWeight:700,color:"#fff",border:s.db?"1.5px dashed rgba(255,255,255,.4)":isMov?"2px solid #8E24AA":isNext?"2px solid rgba(255,255,255,.3)":"none",flexShrink:0}}>{sn}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:isNext?16:15,fontWeight:isNext?700:600,color:"#f0f4fa",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{isNext?"▸ ":""}{s.cn}</div>
                      <div style={{fontSize:12,color:"#7a8aa0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.addr}</div>
                    </div>
                    <Badge s={s}/>
                  </div>
                  {s.con&&<div style={{marginTop:4,marginLeft:isNext?44:40,fontSize:12,color:"#c85a9e",fontWeight:500,fontStyle:"italic"}}>⚠ {s.con}</div>}
                  {isA&&!reorderMode&&<div style={{marginTop:10,marginLeft:40,paddingTop:10,borderTop:"1px solid #161b25"}}>
                    {s.notes&&<div style={{fontSize:13,color:"#7a8898",lineHeight:1.5,marginBottom:8,display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{s.notes}</div>}
                    <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:8,flexWrap:"wrap"}}>
                      <span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 8px",borderRadius:5,background:C[s.ck]+"15",border:`1px solid ${C[s.ck]}30`,fontSize:10,fontWeight:700,color:C[s.ck]}}><Dot color={s.ck} sz={5}/>{PL[s.ck]}</span>
                      {s.jn&&<a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{padding:"2px 8px",borderRadius:5,fontSize:10,fontWeight:700,background:"#1a1e28",border:"1px solid #2a3040",color:"#8a95a8",textDecoration:"none"}}>#{s.jn} ↗</a>}
                      {s.age&&<span style={{fontSize:10,color:"#5a6580"}}>{s.age}</span>}
                    </div>
                    <ContactBtns s={s}/><InteractionHistory stopId={s.id}/><StageButtons stop={s}/>
                  </div>}
                </div>
              </SwipeCard>;
            });
          })()}

          {completedStops.length>0&&<div style={{borderTop:"1px solid #161b25"}}>
            <button onClick={()=>setCompletedOpen(!completedOpen)} style={{width:"100%",padding:"8px 12px",background:"#0a0c10",border:"none",color:"#33B679",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:completedOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>✓ Completed · {completedStops.length}
            </button>
            {completedOpen&&completedStops.map(s=><div key={s.id} style={{padding:"8px 14px",borderBottom:"1px solid #0a0c10",opacity:.5,display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:24,height:24,borderRadius:"50%",background:C[s.ck]+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#fff"}}>✓</div>
              <div style={{flex:1}}><div style={{fontSize:13,color:"#8a95a8",textDecoration:"line-through"}}>{s.cn}</div></div>
              <button onClick={()=>undismissStop(s.id)} style={{padding:"3px 8px",borderRadius:5,background:"transparent",border:"1px solid #1e2536",color:"#8a95a8",fontSize:9,fontWeight:600,cursor:"pointer"}}>Restore</button>
            </div>)}
          </div>}

          </div>{/* end scrollable list */}

        </div>

      ) : view === "pipeline" ? (
        /* ═══ PIPELINE ═══ */
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {syncQueue.length>0&&<div style={{padding:"8px 10px",background:"#1a0a0a",borderBottom:"1px solid #3a1a1a",flexShrink:0}}>
            <div style={{fontSize:10,fontWeight:700,color:"#F4511E",letterSpacing:1,marginBottom:6}}>🔄 SINGLEOPS SYNC · {syncQueue.length}</div>
            {syncQueue.map((q,qi)=><div key={q.id+qi} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:"#111420",borderRadius:6,marginBottom:3,border:"1px solid #1e2536"}}>
              <Dot color={q.stage} sz={8}/><div style={{flex:1,minWidth:0}}><span style={{fontSize:12,fontWeight:600,color:"#e8ecf4"}}>{q.cn}</span><span style={{fontSize:10,color:"#F4511E",marginLeft:6,fontWeight:600}}>{q.action}</span></div>
              {q.jn&&<a href={`https://app.singleops.com/jobs?search=${q.jn}`} target="_blank" rel="noopener noreferrer" style={{padding:"3px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"#1a1e28",border:"1px solid #2a3040",color:"#8a95a8",textDecoration:"none",flexShrink:0}}>SO #{q.jn} ↗</a>}
              <button onClick={()=>setSyncQueue(p=>p.filter((_,i)=>i!==qi))} style={{padding:"4px 8px",borderRadius:5,background:"#0B804322",border:"1px solid #0B804344",color:"#33B679",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>Done ✓</button>
            </div>)}
          </div>}

          {needsAttention.length>0&&<div style={{padding:"8px 10px",background:"#1a1410",borderBottom:"1px solid #3a2a1a",flexShrink:0}}>
            <div style={{fontSize:10,fontWeight:700,color:"#F6BF26",letterSpacing:1,marginBottom:6}}>⚡ NEEDS ATTENTION · {needsAttention.length}</div>
            <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
              {needsAttention.slice(0,5).map(s=><div key={s.id} onClick={()=>{setPipeStage(s.ck);setExpandedPipe(s.id);}} style={{flexShrink:0,padding:"6px 10px",borderRadius:8,background:"#111420",border:`1px solid ${C[s.ck]}33`,cursor:"pointer",minWidth:180}}>
                <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:3}}><Dot color={s.ck} sz={6}/><span style={{fontSize:11,fontWeight:600,color:"#f0f4fa"}}>{s.cn}</span><span style={{marginLeft:"auto",fontSize:9,color:"#c85a5a",fontWeight:700}}>{s.age}</span></div>
                <div style={{fontSize:9,color:"#8a7050"}}>{s.rule.msg}</div>
                {s.phone&&<button onClick={e=>{e.stopPropagation();setTextSheet(s);}} style={{marginTop:4,padding:"3px 8px",borderRadius:4,background:C[s.ck]+"15",border:`1px solid ${C[s.ck]}33`,color:C[s.ck],fontSize:9,fontWeight:700,cursor:"pointer"}}>💬 {s.rule.action}</button>}
              </div>)}
            </div>
          </div>}

          <div style={{display:"flex",padding:"6px 8px",gap:3,overflowX:"auto",flexShrink:0,background:"#0b0d12",borderBottom:"1px solid #161b25"}}>
            {PO.map(k=>{const cnt=pipelineEvents.filter(s=>s.ck===k).length;return <button key={k} onClick={()=>{setPipeStage(k);setExpandedPipe(null);}} style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${pipeStage===k?C[k]+"55":"#161b25"}`,background:pipeStage===k?C[k]+"15":"transparent",color:pipeStage===k?C[k]:"#7a8a9a",fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,flexShrink:0}}><Dot color={k} sz={6}/>{PL[k].split(" ")[0]} <span style={{fontWeight:800}}>{cnt}</span></button>;})}
          </div>

          <div style={{padding:"6px 8px",background:"#0a0c10",borderBottom:"1px solid #161b25",flexShrink:0}}>
            <input value={pipeSearch} onChange={e=>setPipeSearch(e.target.value)} placeholder="Search pipeline..." style={{width:"100%",padding:"6px 10px",borderRadius:6,border:"1px solid #1e2536",background:"#111420",color:"#f0f4fa",fontSize:12,outline:"none",boxSizing:"border-box"}}/>
          </div>

          <div className="scr" style={{flex:1,overflowY:"auto",padding:"10px 10px max(10px, env(safe-area-inset-bottom))"}}>
            {(()=>{
              let items=pipelineEvents.filter(s=>s.ck===pipeStage);
              if(pipeSearch){const q=pipeSearch.toLowerCase();items=items.filter(s=>(s.cn||"").toLowerCase().includes(q)||(s.addr||"").toLowerCase().includes(q)||(s.jn||"").includes(q));}
              if(items.length===0)return <div style={{textAlign:"center",padding:40,color:"#2a3550",fontSize:13}}>{pipeSearch?`No matches`:`No items in ${PL[pipeStage]}`}</div>;
              return items.map(s=>{
                const isExp=expandedPipe===s.id;
                const isAging=FU_RULES.some(r=>r.stage===s.ck&&s.ageDays>=r.days);
                return <div key={s.id} onClick={()=>setExpandedPipe(isExp?null:s.id)} style={{padding:"12px 14px",background:"#0d0f14",borderRadius:10,border:`1px solid ${isAging?"#4a3a1a":"#161b25"}`,marginBottom:6,borderLeft:`4px solid ${C[pipeStage]}`,cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:14,fontWeight:600,color:"#e8ecf4"}}>{s.cn}</div><div style={{fontSize:12,color:"#7a8a9a"}}>{s.addr}</div></div>
                    {s.db&&<span style={{fontSize:11,color:WS.driveby.c}}>🚗</span>}
                    <span style={{fontSize:10,color:s.ageDays>5?"#c85a5a":"#7a8a9a",fontWeight:600}}>{s.age}</span>
                  </div>
                  {isAging&&<div style={{marginTop:4,fontSize:10,color:"#c8a050",fontStyle:"italic"}}>⚡ {FU_RULES.find(r=>r.stage===s.ck)?.msg}</div>}
                  {s.autoDeclined&&<div style={{marginTop:4,fontSize:10,color:"#D50000",fontStyle:"italic"}}>⏰ Auto-declined after 14 days</div>}
                  {s.jn&&<a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{display:"inline-block",marginTop:4,fontSize:10,fontWeight:700,color:"#8a95a8",textDecoration:"none",padding:"2px 8px",borderRadius:4,background:"#0a0c12",border:"1px solid #161b25"}}>SO #{s.jn} ↗</a>}
                  {isExp&&<div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #161b25"}}>
                    {s.phone&&<div style={{fontSize:12,color:"#8898a8",marginBottom:3}}>📞 {s.phone}</div>}
                    {s.email&&<div style={{fontSize:12,color:"#8898a8",marginBottom:6}}>✉️ {s.email}</div>}
                    {s.notes&&<div style={{fontSize:12,color:"#6a7a8a",lineHeight:1.5,padding:8,background:"#0a0c12",borderRadius:6,border:"1px solid #161b25",marginBottom:8,maxHeight:100,overflowY:"auto"}}>{s.notes}</div>}
                    {s.con&&<div style={{fontSize:11,color:"#c85a9e",fontStyle:"italic",marginBottom:6}}>⚠ {s.con}</div>}
                    <ContactBtns s={s} compact/><InteractionHistory stopId={s.id}/><StageButtons stop={s}/>
                  </div>}
                </div>;
              });
            })()}
          </div>
        </div>
      ) : (
        /* ═══ DESKPIPE KANBAN ═══ */
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{padding:"6px 10px",fontSize:10,fontWeight:700,color:"#5a6580",letterSpacing:1,borderBottom:"1px solid #161b25",background:"#0b0d12",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
            <span>PIPELINE KANBAN</span>
            <span style={{fontWeight:400,color:"#2a3548"}}>·</span>
            <span style={{fontWeight:400,color:"#7a8a9a"}}>{pipelineEvents.length} total · this week</span>
          </div>
          <div style={{flex:1,display:"flex",overflowX:"auto",overflowY:"hidden",gap:0,background:"#070910"}}>
            {PO.map(stageKey => {
              const stageItems = pipelineEvents.filter(s => s.ck === stageKey);
              return <div key={stageKey}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                onDrop={e => {
                  e.preventDefault();
                  const stopId = e.dataTransfer.getData("text/plain");
                  if (stopId && stageKey) moveStage(stopId, stageKey);
                }}
                style={{
                  minWidth:200, maxWidth:260, flex:"0 0 auto", display:"flex", flexDirection:"column",
                  borderRight:"1px solid #111825", background:"#0a0c10",
                }}>
                {/* Column header */}
                <div style={{padding:"10px 12px",borderBottom:`2px solid ${C[stageKey]}`,flexShrink:0,display:"flex",alignItems:"center",gap:6}}>
                  <Dot color={stageKey} sz={8}/>
                  <span style={{fontSize:12,fontWeight:700,color:C[stageKey]}}>{PL[stageKey]}</span>
                  <span style={{marginLeft:"auto",fontSize:11,fontWeight:800,color:C[stageKey],opacity:.6}}>{stageItems.length}</span>
                </div>
                {/* Cards */}
                <div className="scr" style={{flex:1,overflowY:"auto",padding:6}}>
                  {stageItems.length === 0 && <div style={{padding:"20px 8px",textAlign:"center",color:"#2a3550",fontSize:11}}>No items</div>}
                  {stageItems.map(s => (
                    <div key={s.id} draggable
                      onDragStart={e => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; }}
                      style={{
                        padding:"10px 12px",marginBottom:5,borderRadius:8,cursor:"grab",
                        background:"#0d0f14",border:`1px solid #1e2536`,borderLeft:`3px solid ${C[stageKey]}`,
                        transition:"box-shadow .15s",
                      }}
                      onMouseEnter={e => e.currentTarget.style.boxShadow = `0 0 12px ${C[stageKey]}22`}
                      onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}
                    >
                      <div style={{fontSize:13,fontWeight:600,color:"#e8ecf4",marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
                      {s.addr && <div style={{fontSize:10,color:"#7a8a9a",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.addr}</div>}
                      <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                        {s.db && <span style={{fontSize:9,color:WS.driveby.c,fontWeight:700}}>🚗 DB</span>}
                        {s.jn && <a href={`https://app.singleops.com/jobs?search=${s.jn}`} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{fontSize:9,fontWeight:700,color:"#8a95a8",textDecoration:"none",padding:"1px 5px",borderRadius:3,background:"#111420",border:"1px solid #1e2536"}}>#{s.jn}</a>}
                        <span style={{fontSize:9,color:s.ageDays>5?"#c85a5a":"#5a6580",fontWeight:600,marginLeft:"auto"}}>{s.age}</span>
                      </div>
                      {s.autoDeclined && <div style={{marginTop:3,fontSize:9,color:"#D50000"}}>⏰ Auto-declined 14d</div>}
                      {s.phone && <div style={{marginTop:6,display:"flex",gap:4}}>
                        <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{padding:"4px 8px",borderRadius:5,background:"#111420",border:"1px solid #1e2536",color:"#8898a8",fontSize:10,textDecoration:"none",fontWeight:600}}>📞</a>
                        <a href={`sms:${s.phone.replace(/\D/g,"")}`} style={{padding:"4px 8px",borderRadius:5,background:"#111420",border:"1px solid #1e2536",color:"#8898a8",fontSize:10,textDecoration:"none",fontWeight:600}}>💬</a>
                        {s.addr && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.addr)}`} target="_blank" style={{padding:"4px 8px",borderRadius:5,background:"#111420",border:"1px solid #1e2536",color:"#8898a8",fontSize:10,textDecoration:"none",fontWeight:600}}>🧭</a>}
                      </div>}
                    </div>
                  ))}
                </div>
              </div>;
            })}
          </div>
        </div>
      )}

      <NotePopup stop={popup} onClose={()=>setPopup(null)} contactLog={popup?interLog[popup.id]:[]}/>
      <SoldPicker stop={soldPick} onConfirm={confirmSold} onCancel={()=>setSoldPick(null)}/>
      <TextSheet stop={textSheet} onClose={()=>setTextSheet(null)} onSend={(id,label)=>logInteraction(id,"text",label)}/>
    </div>
  );
}
