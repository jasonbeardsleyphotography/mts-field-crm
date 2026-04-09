import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { parseEvent, stageColor } from "./parseEvent";
import RouteMap, { AM_COLOR, PM_COLOR } from "./RouteMap";
import SwipeCard from "./SwipeCard";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS FIELD ROUTE — Main App
   Built for bright sun, one thumb, between-stops glances.
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SCOPES = "https://www.googleapis.com/auth/calendar";

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getBusinessDays(n) {
  const days = []; let d = new Date(); d.setHours(0,0,0,0);
  while (days.length < n) { if (d.getDay()!==0 && d.getDay()!==6) days.push(new Date(d)); d.setDate(d.getDate()+1); }
  return days;
}

// ── GOOGLE CALENDAR API ──────────────────────────────────────────────────────
async function fetchEvents(token, dayStart, dayEnd) {
  const url = `${CAL_BASE}/events?timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250&timeZone=America/New_York`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return ((await res.json()).items || []);
}

// ── LOCALSTORAGE HELPERS ─────────────────────────────────────────────────────
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e) { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  // Restore cached token
  const [token, setToken] = useState(() => {
    const saved = lsGet("mts-token", null);
    if (saved && saved.expiry > Date.now()) return saved.token;
    return null;
  });
  const saveToken = (t) => {
    setToken(t);
    if (t) lsSet("mts-token", { token: t, expiry: Date.now() + 55 * 60 * 1000 });
    else { try { localStorage.removeItem("mts-token"); } catch(e) {} }
  };

  // ── SILENT RE-AUTH ────────────────────────────────────────────────────────
  const silentReauth = useCallback(() => {
    return new Promise((resolve) => {
      if (!window.google?.accounts?.oauth2) { resolve(false); return; }
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: r => {
          if (r.access_token) { saveToken(r.access_token); resolve(true); }
          else resolve(false);
        },
        error_callback: () => resolve(false),
      });
      client.requestAccessToken({ prompt: "" });
    });
  }, []);

  // Auto-refresh token 5 min before expiry
  useEffect(() => {
    if (!token) return;
    const saved = lsGet("mts-token", null);
    if (!saved?.expiry) return;
    const msUntilRefresh = Math.max(saved.expiry - Date.now() - 5 * 60 * 1000, 10000);
    const timer = setTimeout(() => { silentReauth(); }, msUntilRefresh);
    return () => clearTimeout(timer);
  }, [token, silentReauth]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [rawEvents, setRawEvents] = useState({});
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(10));
  const [selDay, setSelDay] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [dismissed, setDismissed] = useState(() => lsGet("mts-dismissed", {}));
  useEffect(() => { lsSet("mts-dismissed", dismissed); }, [dismissed]);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [textSheet, setTextSheet] = useState(null);
  const [otwMinutes, setOtwMinutes] = useState(null);
  const [mapOpen, setMapOpen] = useState(true);

  // ── PERSISTED UNDO STACK ──────────────────────────────────────────────────
  const [undoStack, setUndoStack] = useState(() => lsGet("mts-undo", []));
  useEffect(() => { lsSet("mts-undo", undoStack); }, [undoStack]);

  const [reorderMode, setReorderMode] = useState(false);
  const [moving, setMoving] = useState(null);
  const [ordIds, setOrdIds] = useState(() => lsGet("mts-route-order", {}));
  useEffect(() => { lsSet("mts-route-order", ordIds); }, [ordIds]);

  // ── AUTH ─────────────────────────────────────────────────────────────────
  const initAuth = useCallback(() => {
    if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 200); return; }
    window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: r => { if (r.access_token) { saveToken(r.access_token); setError(null); } else setError("Sign-in failed"); },
    }).requestAccessToken();
  }, []);

  // ── AUTHED FETCH — wraps fetchEvents with silent reauth on 401 ────────
  const authedFetchEvents = useCallback(async (tok, dayStart, dayEnd) => {
    try {
      return await fetchEvents(tok, dayStart, dayEnd);
    } catch(e) {
      if (e.status === 401 || (e.message && e.message.includes("401"))) {
        const ok = await silentReauth();
        if (ok) {
          const freshToken = lsGet("mts-token", null)?.token;
          if (freshToken) return await fetchEvents(freshToken, dayStart, dayEnd);
        }
        saveToken(null);
      }
      throw e;
    }
  }, [silentReauth]);

  // ── LOAD — today first, then background-fill remaining days ──────────
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const days = getBusinessDays(10);
      setBusinessDays(days);

      // PHASE 1: Load today immediately
      const today = days[0];
      const ts = new Date(today); ts.setHours(0,0,0,0);
      const te = new Date(today); te.setHours(23,59,59,999);
      const todayEvents = await authedFetchEvents(token, ts, te);
      setRawEvents(prev => ({ ...prev, [today.toDateString()]: todayEvents }));
      setSelDay(0); setExpanded(null); setReorderMode(false); setMoving(null);
      setLoading(false);

      // PHASE 2: Background-fill remaining days
      const remaining = days.slice(1);
      (async () => {
        for (const day of remaining) {
          try {
            const s = new Date(day); s.setHours(0,0,0,0);
            const e = new Date(day); e.setHours(23,59,59,999);
            const events = await authedFetchEvents(token, s, e);
            setRawEvents(prev => ({ ...prev, [day.toDateString()]: events }));
          } catch(err) {
            console.warn("Background load failed for", day.toDateString(), err);
          }
        }
      })();

    } catch (e) {
      setError(e.message);
      if (e.message.includes("401")) saveToken(null);
      setLoading(false);
    }
  }, [token, authedFetchEvents]);

  useEffect(() => { if (token) load(); }, [token, load]);

  // ── PARSE ────────────────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  const allParsed = useMemo(() => {
    const raw = rawEvents[dayKey] || [];
    return raw.map(parseEvent).filter(Boolean).filter(s => !s.isAdmin);
  }, [rawEvents, dayKey]);

  useEffect(() => {
    if (!dayKey || !allParsed.length) return;
    const saved = ordIds[dayKey] || [];
    const parsedIds = allParsed.map(s => s.id);

    // Default order: AM tasks → PM tasks → TDs
    const buildDefault = () => {
      const amTasks = allParsed.filter(s => s.isTask && (s.window||"").startsWith("AM"));
      const pmTasks = allParsed.filter(s => s.isTask && !(s.window||"").startsWith("AM"));
      const tds = allParsed.filter(s => !s.isTask);
      return [...amTasks, ...pmTasks, ...tds].map(s => s.id);
    };

    if (!saved.length) {
      setOrdIds(prev => ({...prev, [dayKey]: buildDefault()}));
      return;
    }
    const newIds = parsedIds.filter(id => !saved.includes(id));
    const validSaved = saved.filter(id => parsedIds.includes(id));
    if (newIds.length > 0 || validSaved.length !== saved.length) {
      // New stops get inserted in AM/PM order, not just appended
      const newAM = allParsed.filter(s => newIds.includes(s.id) && s.isTask && (s.window||"").startsWith("AM")).map(s => s.id);
      const newPM = allParsed.filter(s => newIds.includes(s.id) && s.isTask && !(s.window||"").startsWith("AM")).map(s => s.id);
      const newTD = allParsed.filter(s => newIds.includes(s.id) && !s.isTask).map(s => s.id);
      // Find insertion points: AM goes before first PM in saved, PM before first TD, TDs at end
      const firstPMIdx = validSaved.findIndex(id => { const s = allParsed.find(x => x.id === id); return s && s.isTask && !(s.window||"").startsWith("AM"); });
      const firstTDIdx = validSaved.findIndex(id => { const s = allParsed.find(x => x.id === id); return s && !s.isTask; });
      let merged = [...validSaved];
      // Insert new TDs at end
      merged.push(...newTD);
      // Insert new PM before TDs
      const pmInsert = firstTDIdx >= 0 ? firstTDIdx : merged.length - newTD.length;
      merged.splice(pmInsert, 0, ...newPM);
      // Insert new AM before PM
      const amInsert = firstPMIdx >= 0 ? firstPMIdx : pmInsert;
      merged.splice(amInsert, 0, ...newAM);
      setOrdIds(prev => ({...prev, [dayKey]: merged}));
    }
  }, [dayKey, allParsed]);

  const stopMap = useMemo(() => { const m = {}; allParsed.forEach(s => m[s.id] = s); return m; }, [allParsed]);
  const currentOrder = (ordIds[dayKey]?.length > 0) ? ordIds[dayKey] : allParsed.map(s => s.id);
  const stops = currentOrder.map(id => stopMap[id]).filter(Boolean);

  const active = useMemo(() => stops.filter(s => !dismissed[s.id]), [stops, dismissed]);
  const completed = useMemo(() => stops.filter(s => dismissed[s.id]), [stops, dismissed]);
  const mapStops = useMemo(() => active.filter(s => s.isTask), [active]);

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  const dismiss = id => { setUndoStack(u => [...u, {type:"dismiss",id}]); setDismissed(p => ({...p,[id]:true})); setExpanded(null); };
  const restore = id => { setUndoStack(u => [...u, {type:"restore",id}]); setDismissed(p => { const n={...p}; delete n[id]; return n; }); };
  const undo = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length-1];
    setUndoStack(u => u.slice(0,-1));
    if (last.type === "dismiss") setDismissed(p => { const n={...p}; delete n[last.id]; return n; });
    if (last.type === "restore") setDismissed(p => ({...p, [last.id]: true}));
    if (last.type === "reorder") setOrdIds(prev => ({...prev, [dayKey]: last.prevOrder}));
  };
  const navigate = addr => {
    if (!addr) return;
    const q = encodeURIComponent(addr);
    window.location.href = `comgooglemaps://?daddr=${q}&directionsmode=driving`;
  };

  const handleReorderTap = (idx) => {
    if (!reorderMode) return;
    if (moving === null) {
      setMoving(idx); setExpanded(null);
    } else if (moving === idx) {
      setMoving(null);
    } else {
      const activeIds = active.map(s => s.id);
      const prevOrder = [...(ordIds[dayKey] || currentOrder)];
      const fromId = activeIds[moving];
      const toId = activeIds[idx];
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

  // ── NAV ALL — with waypoints + current location as origin ──────────────
  const navAll = useCallback(() => {
    const addrs = mapStops.filter(s=>s.addr).map(s=>s.addr);
    if (!addrs.length) return;
    if (addrs.length === 1) { navigate(addrs[0]); return; }
    // saddr= blank uses device GPS as origin
    const chain = addrs.map(a => encodeURIComponent(a)).join("+to:");
    window.location.href = `comgooglemaps://?saddr=&daddr=${chain}&directionsmode=driving`;
  }, [mapStops]);
  const hasStopsWithAddr = mapStops.some(s => s.addr);

  const dayLabels = businessDays.map(d => {
    const isToday = d.toDateString() === new Date().toDateString();
    return d.toLocaleDateString("en-US",{weekday:"short",month:"numeric",day:"numeric"}) + (isToday ? " ★" : "");
  });

  // ── SIGN IN ──────────────────────────────────────────────────────────────
  if (!token) return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0a0c12",fontFamily:"'Barlow Condensed','DM Sans',system-ui,sans-serif",color:"#f0f4fa",padding:20}}>
      <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&family=DM+Sans:wght@500;700;800&display=swap" rel="stylesheet"/>
      <div style={{fontSize:32,fontWeight:900,letterSpacing:2,textTransform:"uppercase",fontFamily:"'Barlow Condensed',sans-serif"}}>MTS</div>
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
      <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <style>{`.scr::-webkit-scrollbar{width:0}.gmnoprint,.gm-bundled-control,.gm-style-cc,.gm-control-active,.gm-fullscreen-control,.gm-style .adp,.gm-style button[title]{display:none!important}`}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:5,padding:"8px 10px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0}}>
        <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setReorderMode(false);setMoving(null);}} style={{padding:"6px 8px",borderRadius:8,border:"1px solid #1a2030",background:"#0a0c12",color:"#f0f4fa",fontSize:13,fontWeight:700,cursor:"pointer",outline:"none",appearance:"auto"}}>
          {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
        </select>
        <div style={{flex:1}}/>
        <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}} style={{padding:"5px 10px",borderRadius:8,background:reorderMode?"rgba(142,36,170,.15)":"#1a2240",border:`1px solid ${reorderMode?"rgba(142,36,170,.4)":"#2a3560"}`,color:reorderMode?"#c8a0e8":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}>{reorderMode?"✕ Done":"↕ Reorder"}</button>
        {reorderMode && <button onClick={()=>{
          // Reset to default AM → PM → TD order
          const amTasks = allParsed.filter(s => s.isTask && (s.window||"").startsWith("AM"));
          const pmTasks = allParsed.filter(s => s.isTask && !(s.window||"").startsWith("AM"));
          const tds = allParsed.filter(s => !s.isTask);
          const fresh = [...amTasks, ...pmTasks, ...tds].map(s => s.id);
          setUndoStack(u => [...u, {type:"reorder", prevOrder: ordIds[dayKey] || currentOrder}]);
          setOrdIds(prev => ({...prev, [dayKey]: fresh}));
          setMoving(null);
        }} style={{padding:"5px 10px",borderRadius:8,background:"rgba(200,90,60,.1)",border:"1px solid rgba(200,90,60,.25)",color:"#e8a080",fontSize:11,fontWeight:700,cursor:"pointer"}}>↻ Reset</button>}
        {hasStopsWithAddr && !reorderMode && <button onClick={navAll} style={{padding:"5px 10px",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:11,fontWeight:700,cursor:"pointer"}}>🧭 All</button>}
        <button onClick={undo} disabled={!undoStack.length} style={{width:34,height:34,borderRadius:8,background:undoStack.length?"#1a2240":"transparent",border:"1px solid #1a2030",color:undoStack.length?"#f0f4fa":"#2a3050",fontSize:13,cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center"}}>↩</button>
      </div>

      {/* ── MAP ────────────────────────────────────────────────────────── */}
      <div style={{flexShrink:0,borderBottom:"1px solid #1a2030"}}>
        <button onClick={()=>setMapOpen(!mapOpen)} style={{width:"100%",padding:"4px 12px",background:"none",border:"none",color:"#3a4560",fontSize:10,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
          <span style={{transform:mapOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7}}>▶</span>
          {mapOpen?"hide map":"show map"}
        </button>
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
            <div onClick={() => { if (reorderMode) handleReorderTap(idx); else setExpanded(isExp ? null : s.id); }}
              ref={el => { if (el && expanded === s.id) setTimeout(() => el.scrollIntoView({behavior:"smooth",block:"nearest"}), 50); }}
              style={{
              padding:"14px 16px", borderBottom:"1px solid #0e1220",
              cursor: reorderMode ? "grab" : "pointer",
              background: isMov ? "rgba(142,36,170,.08)" : isNext ? "#0e1525" : reorderMode ? "#0a0c12" : "transparent",
              borderLeft: `4px solid ${isMov ? "#8E24AA" : isNext ? circleColor : "transparent"}`,
              opacity: reorderMode && !isMov && moving !== null ? .5 : 1,
              transition: "opacity .15s",
            }}>
              {/* ── MAIN ROW: High-contrast sunlight-readable ──────────── */}
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:isNext?38:32,height:isNext?38:32,borderRadius:"50%",background:circleColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:s.isTask?(isNext?16:14):9,fontWeight:900,color:"#fff",flexShrink:0,border:s.db?"2px dashed rgba(255,255,255,.5)":isMov?"2px solid #8E24AA":!s.isTask?"1px solid #3a3060":"none",letterSpacing:s.isTask?0:-.5,fontFamily:"'Barlow Condensed',sans-serif",textShadow:"0 1px 2px rgba(0,0,0,.5)"}}>{s.isTask?taskNum:"TD"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{
                    fontSize:isNext?17:15, fontWeight:isNext?900:800,
                    color: s.isTask ? "#FFFFFF" : "#d0c8e8",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                    fontFamily:"'Barlow Condensed',sans-serif",
                    textTransform:"uppercase",
                    letterSpacing: isNext ? 1 : 0.5,
                    textShadow: isNext ? "0 0 8px rgba(255,255,255,.15)" : "none",
                  }}>{isNext?"▸ ":""}{s.cn}</div>
                  {s.addr && <div style={{fontSize:11,color:"#8a96a8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:2,fontWeight:600,letterSpacing:0.2}}>{s.addr}</div>}
                </div>
                {s.isTask && s.window && <span style={{padding:"3px 8px",borderRadius:6,fontSize:11,fontWeight:900,color:isAM?"#66BB6A":"#64B5F6",background:winBg,border:`1px solid ${winColor}40`,flexShrink:0,letterSpacing:1,fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase"}}>{s.window}</span>}
                {s.isTask && s.db && <span style={{padding:"3px 6px",borderRadius:6,fontSize:10,fontWeight:900,color:"#FFD54F",background:"rgba(255,213,79,.12)",border:"1px solid rgba(255,213,79,.3)",flexShrink:0,letterSpacing:1,fontFamily:"'Barlow Condensed',sans-serif"}}>DB</span>}
                {!s.isTask && s.timeLabel && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:700,color:"#9a8cc0",background:"rgba(100,80,160,.1)",border:"1px solid rgba(100,80,160,.2)",flexShrink:0}}>{s.timeLabel}</span>}
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>e.stopPropagation()} style={{padding:"5px 10px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:12,textDecoration:"none",fontWeight:700,flexShrink:0}}>📞</a>}
              </div>

              {s.constraint && !reorderMode && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(255,80,160,.12)",border:"1px solid rgba(255,80,160,.25)",color:"#FF80AB",fontSize:12,fontWeight:800,display:"inline-block",letterSpacing:0.3,fontFamily:"'Barlow Condensed','DM Sans',sans-serif",textTransform:"uppercase"}}>{s.constraint}</div>}

              {s.titleContext && !reorderMode && <div style={{marginTop:4,marginLeft:isNext?50:44,fontSize:12,color:"#b0b8c8",lineHeight:1.5,fontStyle:"italic",fontWeight:500}}>{s.titleContext}</div>}

              {isExp && <div style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {s.notes && <div style={{fontSize:13,color:"#a0b0c0",lineHeight:1.6,marginBottom:10,fontWeight:500}}>{s.notes}</div>}
                {s.phone && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:3,fontWeight:600}}>📞 {s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:8,fontWeight:600}}>✉️ {s.email}</div>}
                <div style={{display:"flex",gap:8,marginTop:4}}>
                  {s.phone && <button onClick={e=>{e.stopPropagation();setTextSheet(s);setOtwMinutes(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#a0b8d0",fontSize:13,fontWeight:700,cursor:"pointer"}}>💬 Text</button>}
                  {s.addr && <button onClick={e=>{e.stopPropagation();navigate(s.addr);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:700,cursor:"pointer"}}>🧭 Navigate</button>}
                  <button onClick={e=>{e.stopPropagation();dismiss(s.id);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(51,182,121,.1)",border:"1px solid rgba(51,182,121,.2)",color:"#33B679",fontSize:13,fontWeight:700,cursor:"pointer"}}>✓ Done</button>
                </div>
              </div>}
            </div>
          </SwipeCard>;
        }); })()}

        {/* ── COMPLETED ────────────────────────────────────────────────── */}
        {completed.length>0 && <div style={{borderTop:"1px solid #1a2030"}}>
          <button onClick={()=>setCompletedOpen(!completedOpen)} style={{width:"100%",padding:"10px 16px",background:"#0a0c10",border:"none",color:"#33B679",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            <span style={{transform:completedOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:8}}>▶</span>
            ✓ {completed.length} completed
          </button>
          {completedOpen && completed.map(s => (
            <div key={s.id} style={{padding:"10px 16px",borderBottom:"1px solid #0a0e16",display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:24,height:24,borderRadius:"50%",background:s.color+"44",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#fff"}}>✓</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,color:"#6a7890",textDecoration:"line-through",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
                {s.addr && <div style={{fontSize:10,color:"#3a4560",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.addr}</div>}
              </div>
              <button onClick={()=>restore(s.id)} style={{padding:"6px 14px",borderRadius:8,background:"rgba(255,183,77,.08)",border:"1px solid rgba(255,183,77,.25)",color:"#FFB74D",fontSize:11,fontWeight:800,cursor:"pointer",letterSpacing:0.3,fontFamily:"'Barlow Condensed',sans-serif",textTransform:"uppercase",whiteSpace:"nowrap"}}>↩ RESTORE</button>
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

          <button onClick={()=>{window.open(`sms:${textSheet.phone.replace(/\D/g,"")}`,"_self");setTextSheet(null);}} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",cursor:"pointer",textAlign:"left"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#90a8c0"}}>Custom</div>
            <div style={{fontSize:11,color:"#5a6580",marginTop:2}}>Open blank message</div>
          </button>

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
