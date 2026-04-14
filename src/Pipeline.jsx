import { useState, useEffect, useMemo, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Pipeline
   Hybrid: list+tabs on mobile, kanban columns on desktop.
   Auto-aging: Proposal Sent → Stale (3d), Stale → Declined (3d),
   Follow Up → Declined (3d). Paused cards skip aging.
   Bulk email with mailto: templates for Outlook.
   ═══════════════════════════════════════════════════════════════════════════ */

const STAGES = [
  { id: "estimate_needed", label: "Estimate needed", short: "Estimate", color: "#039BE5", bg: "rgba(3,155,229,.1)" },
  { id: "waiting", label: "Waiting", short: "Waiting", color: "#8E24AA", bg: "rgba(142,36,170,.1)" },
  { id: "strong", label: "Strong", short: "Strong", color: "#33B679", bg: "rgba(51,182,121,.1)" },
  { id: "weak", label: "Weak", short: "Weak", color: "#FF8A65", bg: "rgba(255,138,101,.1)" },
  { id: "follow_up", label: "Follow up", short: "Follow up", color: "#F6BF26", bg: "rgba(246,191,38,.1)" },
  { id: "sold", label: "Sold", short: "Sold", color: "#0B8043", bg: "rgba(11,128,67,.1)" },
  { id: "declined", label: "Declined", short: "Declined", color: "#616161", bg: "rgba(97,97,97,.1)" },
];

const PIPELINE_KEY = "mts-pipeline";
const FIELD_KEY = id => `mts-field-${id}`;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

// SingleOps: no direct URL mapping, so copy job # and open search
const SINGLEOPS_URL = "https://app.singleops.com/jobs";

const EMAIL_TEMPLATES = [
  { id: "followup", label: "Follow-up reminder", subject: "Following up on your estimate — MTS Rochester",
    body: "Hi {firstName},\n\nI wanted to follow up on the estimate we provided for work at your property. If you have any questions or would like to move forward, please don't hesitate to reach out.\n\nThank you,\nJason\nMonster Tree Service of Rochester" },
  { id: "proposal", label: "Proposal nudge", subject: "Your tree care proposal — MTS Rochester",
    body: "Hi {firstName},\n\nJust checking in to see if you had a chance to review the proposal we sent over. I'm happy to answer any questions or make adjustments.\n\nBest,\nJason\nMonster Tree Service of Rochester" },
  { id: "seasonal", label: "Seasonal reminder", subject: "Seasonal tree care reminder — MTS Rochester",
    body: "Hi {firstName},\n\nAs we head into the next season, I wanted to reach out about the tree care needs we discussed at your property. Now is a great time to schedule this work.\n\nFeel free to call or text me anytime.\n\nJason\nMonster Tree Service of Rochester" },
];

function loadPipeline() { try { return JSON.parse(localStorage.getItem(PIPELINE_KEY)) || {}; } catch(e) { return {}; } }
function savePipeline(data) { try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(data)); } catch(e) {} }
function loadFieldData(id) { try { return JSON.parse(localStorage.getItem(FIELD_KEY(id))) || {}; } catch(e) { return {}; } }

const F = "'Oswald',sans-serif";

// ═════════════════════════════════════════════════════════════════════════════
export default function Pipeline({ onSwitchToRoute, search = "" }) {
  const [pipeline, setPipeline] = useState(() => loadPipeline());
  const [activeTab, setActiveTab] = useState("all");
  const [selectedCard, setSelectedCard] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState({}); // {id: true}
  const [emailSheet, setEmailSheet] = useState(false);
  const [emailPreview, setEmailPreview] = useState(null); // template object
  const [pauseMenu, setPauseMenu] = useState(null); // card id showing pause options
  const [detailCard, setDetailCard] = useState(null); // full detail popup

  // Persist
  useEffect(() => { savePipeline(pipeline); }, [pipeline]);

  // ── AUTO-AGING ──────────────────────────────────────────────────────────
  useEffect(() => {
    const now = Date.now();
    let changed = false;
    const updated = { ...pipeline };
    Object.keys(updated).forEach(id => {
      const card = updated[id];
      if (card.pauseUntil && now < card.pauseUntil) return;
      if (card.pauseUntil && now >= card.pauseUntil) {
        updated[id] = { ...card, pauseUntil: null, stageChangedAt: now };
        changed = true;
        return;
      }
      const age = now - (card.stageChangedAt || card.addedAt || now);
      if (card.stage === "waiting" && age > THREE_DAYS) {
        updated[id] = { ...card, stage: "weak", stageChangedAt: now };
        changed = true;
      } else if (card.stage === "weak" && age > THREE_DAYS) {
        updated[id] = { ...card, stage: "declined", stageChangedAt: now, autoDeclined: true };
        changed = true;
      } else if (card.stage === "follow_up" && age > THREE_DAYS) {
        updated[id] = { ...card, stage: "declined", stageChangedAt: now, autoDeclined: true };
        changed = true;
      }
    });
    if (changed) setPipeline(updated);
  }, []);

  // Cards grouped by stage
  const cardsByStage = useMemo(() => {
    const groups = {};
    STAGES.forEach(s => { groups[s.id] = []; });
    Object.values(pipeline).forEach(card => {
      if (groups[card.stage]) groups[card.stage].push(card);
    });
    Object.keys(groups).forEach(k => {
      groups[k].sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0));
    });
    return groups;
  }, [pipeline]);

  const allCards = useMemo(() => Object.values(pipeline), [pipeline]);

  // Cards in waiting for 2+ days (due for follow-up nudge)
  const dueForFollowUp = useMemo(() => {
    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return allCards.filter(c => c.stage === "waiting" && !c.pauseUntil && (now - (c.stageChangedAt || c.addedAt || now)) > TWO_DAYS);
  }, [allCards]);

  // Search filter
  const searchFilter = useCallback((card) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (card.cn || "").toLowerCase().includes(q) || (card.addr || "").toLowerCase().includes(q) || (card.jn || "").includes(q);
  }, [search]);

  // Move card to stage
  const moveCard = useCallback((id, newStage) => {
    setPipeline(prev => ({
      ...prev,
      [id]: { ...prev[id], stage: newStage, stageChangedAt: Date.now(), autoDeclined: false },
    }));
  }, []);

  // Reactivate = move from declined back to estimate_needed
  const reactivate = useCallback((id) => {
    moveCard(id, "estimate_needed");
  }, [moveCard]);

  // Toggle hot lead
  const toggleHot = useCallback((id) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], hot: !prev[id]?.hot } }));
  }, []);

  // Pause for N days
  const pauseFor = useCallback((id, days) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], pauseUntil: Date.now() + days * 24 * 60 * 60 * 1000 } }));
    setPauseMenu(null);
  }, []);

  // Unpause
  const unpause = useCallback((id) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], pauseUntil: null, stageChangedAt: Date.now() } }));
  }, []);

  // Days since stage change
  const daysSince = (ts) => {
    if (!ts) return "—";
    const d = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
    return d === 0 ? "today" : d === 1 ? "1d" : `${d}d`;
  };

  // Copy job # and open SingleOps
  const openSingleOps = (jn) => {
    if (!jn) return;
    navigator.clipboard?.writeText(jn).catch(() => {});
    window.open(SINGLEOPS_URL, "_blank");
  };

  // Desktop drag
  const onDragStart = (e, id) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (e, stageId) => { e.preventDefault(); if (dragId) { moveCard(dragId, stageId); setDragId(null); } };

  // Select mode
  const toggleSelect = (id) => { setSelected(prev => { const n = { ...prev }; if (n[id]) delete n[id]; else n[id] = true; return n; }); };
  const selectedCards = useMemo(() => Object.keys(selected).map(id => pipeline[id]).filter(Boolean), [selected, pipeline]);
  const selectedCount = selectedCards.length;

  // ── BULK EMAIL ──────────────────────────────────────────────────────────
  const sendBulkEmail = (template) => {
    selectedCards.forEach((card, i) => {
      const firstName = (card.cn || "").split(" ")[0];
      const body = template.body.replace(/\{firstName\}/g, firstName);
      const subject = template.subject;
      const email = card.email || "";
      if (!email) return;
      // Stagger mailto opens slightly so browser doesn't block them
      setTimeout(() => {
        window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
      }, i * 800);
    });
    setEmailPreview(null);
    setEmailSheet(false);
    setSelectMode(false);
    setSelected({});
  };

  // ── RENDER CARD ─────────────────────────────────────────────────────────
  const renderCard = (card, compact) => {
    if (!searchFilter(card)) return null;
    const stage = STAGES.find(s => s.id === card.stage);
    const fd = loadFieldData(card.id);
    const photoCount = (fd.photos || []).length;
    const hasNotes = !!(fd.myNotes);
    const hasVideo = !!(fd.videoUrl);
    const isSelected = !!selected[card.id];
    const isDeclined = card.stage === "declined";

    return (
      <div
        key={card.id}
        draggable={!selectMode}
        onDragStart={e => onDragStart(e, card.id)}
        onClick={() => {
          if (selectMode) { toggleSelect(card.id); return; }
          setDetailCard(card);
        }}
        style={{
          padding: compact ? "10px 12px" : "12px 14px",
          background: isSelected ? "rgba(3,155,229,.08)" : card.hot ? "rgba(255,160,0,.04)" : "#0d1018",
          borderBottom: "1px solid #0e1220",
          borderLeft: `3px solid ${isSelected ? "#039BE5" : card.hot ? "#FFB300" : stage?.color || "#555"}`,
          cursor: "pointer",
          transition: "background .15s",
          opacity: isDeclined && !selectMode ? 0.6 : 1,
        }}
      >
        {/* Top row */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {selectMode && <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${isSelected?"#039BE5":"#2a3560"}`,background:isSelected?"#039BE5":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:12,color:"#fff",fontWeight:800}}>{isSelected?"✓":""}</div>}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:compact?14:15,fontWeight:600,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {card.hot && <span style={{color:"#FFB300",marginRight:4}}>🔥</span>}
              {card.pauseUntil && Date.now() < card.pauseUntil && <span style={{color:"#8a96a8",marginRight:4}}>⏸</span>}
              {card.cn}
            </div>
            {card.addr && <div style={{fontSize:11,color:"#6a7890",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1,fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{card.addr}</div>}
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,flexShrink:0}}>
            {!compact && <span style={{fontSize:10,padding:"2px 8px",borderRadius:99,background:stage?.bg,color:stage?.color,fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>{stage?.label}</span>}
            <span style={{fontSize:10,color:card.stage==="weak"?"#FF8A65":"#4a5a70"}}>{daysSince(card.stageChangedAt || card.addedAt)}</span>
          </div>
        </div>

        {/* Indicators */}
        {!selectMode && <div style={{display:"flex",gap:6,marginTop:6,alignItems:"center"}}>
          {photoCount > 0 && <span style={{fontSize:10,color:"#5a6580"}}>📷 {photoCount}</span>}
          {hasNotes && <span style={{fontSize:10,color:"#5a6580"}}>📝</span>}
          {hasVideo && <span style={{fontSize:10,color:"#5a6580"}}>🎬</span>}
          {card.jn && <button onClick={e=>{e.stopPropagation();openSingleOps(card.jn);}} style={{fontSize:10,color:"#039BE5",background:"none",border:"none",cursor:"pointer",fontWeight:600,padding:0}}>SO #{card.jn} 📋</button>}
          <div style={{flex:1}}/>
          <div style={{position:"relative"}}>
            {card.pauseUntil && Date.now() < card.pauseUntil ? (
              <button onClick={e=>{e.stopPropagation();unpause(card.id);}} style={{padding:"2px 6px",borderRadius:4,background:"rgba(138,150,168,.12)",border:"1px solid rgba(138,150,168,.25)",color:"#8a96a8",fontSize:9,cursor:"pointer",fontWeight:600}}>⏸ {Math.ceil((card.pauseUntil - Date.now()) / (24*60*60*1000))}d</button>
            ) : (
              <button onClick={e=>{e.stopPropagation();setPauseMenu(pauseMenu===card.id?null:card.id);}} style={{padding:"2px 6px",borderRadius:4,background:pauseMenu===card.id?"rgba(138,150,168,.12)":"transparent",border:"1px solid #1a2030",color:"#2a3050",fontSize:10,cursor:"pointer"}}>⏸</button>
            )}
            {pauseMenu === card.id && <div style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#0d1018",border:"1px solid #1a2540",borderRadius:8,padding:4,zIndex:30,display:"flex",gap:3}}>
              {[3,7,14].map(d => <button key={d} onClick={e=>{e.stopPropagation();pauseFor(card.id,d);}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(138,150,168,.08)",border:"1px solid #1a2540",color:"#8a96a8",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>{d}d</button>)}
            </div>}
          </div>
          <button onClick={e=>{e.stopPropagation();toggleHot(card.id);}} style={{padding:"2px 6px",borderRadius:4,background:card.hot?"rgba(255,179,0,.12)":"transparent",border:card.hot?"1px solid rgba(255,179,0,.3)":"1px solid #1a2030",color:card.hot?"#FFB300":"#2a3050",fontSize:10,cursor:"pointer"}}>🔥</button>
        </div>}
      </div>
    );
  };

  // ── MOBILE: List + Tabs ──────────────────────────────────────────────────
  const mobileView = () => {
    const filtered = activeTab === "all" ? allCards : (cardsByStage[activeTab] || []);
    const sorted = [...filtered].filter(searchFilter).sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0));

    return (
      <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
        {/* Select toggle */}
        <div style={{display:"flex",gap:6,padding:"6px 10px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0,alignItems:"center"}}>
          <div style={{flex:1}}/>
          <button onClick={()=>{setSelectMode(!selectMode);setSelected({});}} style={{padding:"5px 10px",borderRadius:8,background:selectMode?"rgba(3,155,229,.15)":"#1a2240",border:`1px solid ${selectMode?"rgba(3,155,229,.3)":"#2a3560"}`,color:selectMode?"#039BE5":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}>{selectMode?"✕ Done":"Select"}</button>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",overflowX:"auto",borderBottom:"1px solid #1a2030",flexShrink:0,background:"#0d1018"}}>
          <button onClick={()=>setActiveTab("all")} style={{padding:"8px 14px",fontSize:11,fontWeight:activeTab==="all"?700:500,color:activeTab==="all"?"#039BE5":"#4a5a70",borderBottom:activeTab==="all"?"2px solid #039BE5":"2px solid transparent",background:"transparent",border:"none",borderBottomStyle:"solid",cursor:"pointer",whiteSpace:"nowrap",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>All ({allCards.length})</button>
          {STAGES.map(st => {
            const count = (cardsByStage[st.id] || []).length;
            return <button key={st.id} onClick={()=>setActiveTab(st.id)} style={{padding:"8px 12px",fontSize:11,fontWeight:activeTab===st.id?700:500,color:activeTab===st.id?st.color:"#4a5a70",borderBottom:activeTab===st.id?`2px solid ${st.color}`:"2px solid transparent",background:"transparent",border:"none",borderBottomStyle:"solid",cursor:"pointer",whiteSpace:"nowrap",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",position:"relative"}}>
              {st.short} {count > 0 && <span style={{fontSize:9,color:st.color,marginLeft:2}}>({count})</span>}
              {st.id === "weak" && count > 0 && <span style={{position:"absolute",top:4,right:2,width:5,height:5,borderRadius:3,background:"#FF8A65"}}/>}
            </button>;
          })}
        </div>

        {/* Summary */}
        <div style={{padding:"6px 14px",background:"#0a0c12",borderBottom:"1px solid #1a2030",display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:14,fontWeight:600,color:"#f0f4fa"}}>{sorted.length} cards</span>
          {(cardsByStage.weak || []).length > 0 && <span style={{fontSize:11,color:"#FF8A65",fontWeight:600}}>{cardsByStage.weak.length} stale</span>}
        </div>

        {/* Follow-up reminder banner */}
        {dueForFollowUp.length > 0 && !selectMode && <div style={{padding:"8px 14px",background:"rgba(246,191,38,.06)",borderBottom:"1px solid rgba(246,191,38,.15)",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,color:"#F6BF26",fontWeight:600,flex:1}}>{dueForFollowUp.length} proposal{dueForFollowUp.length>1?"s":""} sent 2+ days ago — follow up?</span>
          <button onClick={()=>{setSelectMode(true);const sel={};dueForFollowUp.forEach(c=>{sel[c.id]=true;});setSelected(sel);}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>📧 Select all</button>
        </div>}

        {/* Card list */}
        <div style={{flex:1,overflowY:"auto",paddingBottom:selectMode && selectedCount>0?"max(70px,calc(60px + env(safe-area-inset-bottom)))":"max(12px,env(safe-area-inset-bottom))"}}>
          {sorted.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No cards{search ? ` matching "${search}"` : ""}</div>}
          {sorted.map(card => renderCard(card, false))}
        </div>

        {/* Select mode action bar */}
        {selectMode && selectedCount > 0 && (
          <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",background:"#0d1018",borderTop:"1px solid #1a2030",display:"flex",gap:8,alignItems:"center",paddingBottom:"max(10px,env(safe-area-inset-bottom))",zIndex:50}}>
            <span style={{fontSize:12,color:"#90a8c0",fontWeight:600}}>{selectedCount} selected</span>
            <div style={{flex:1}}/>
            <button onClick={()=>setEmailSheet(true)} style={{padding:"8px 16px",borderRadius:8,background:"rgba(3,155,229,.12)",border:"1px solid rgba(3,155,229,.25)",color:"#039BE5",fontSize:12,fontWeight:700,cursor:"pointer"}}>📧 Email</button>
            <button onClick={()=>{selectedCards.forEach(c=>moveCard(c.id,"follow_up"));setSelected({});setSelectMode(false);}} style={{padding:"8px 12px",borderRadius:8,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>→ Follow up</button>
          </div>
        )}
      </div>
    );
  };

  // ── DESKTOP: Kanban columns ──────────────────────────────────────────────
  const desktopView = () => (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* Select toggle */}
      <div style={{display:"flex",gap:6,padding:"6px 10px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0,alignItems:"center"}}>
        <div style={{flex:1}}/>
        <button onClick={()=>{setSelectMode(!selectMode);setSelected({});}} style={{padding:"5px 10px",borderRadius:8,background:selectMode?"rgba(3,155,229,.15)":"#1a2240",border:`1px solid ${selectMode?"rgba(3,155,229,.3)":"#2a3560"}`,color:selectMode?"#039BE5":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}>{selectMode?"✕ Done":"Select"}</button>
        {selectMode && selectedCount > 0 && <button onClick={()=>setEmailSheet(true)} style={{padding:"5px 10px",borderRadius:8,background:"rgba(3,155,229,.12)",border:"1px solid rgba(3,155,229,.25)",color:"#039BE5",fontSize:11,fontWeight:700,cursor:"pointer"}}>📧 {selectedCount} selected</button>}
      </div>
      <div style={{display:"flex",flex:1,overflow:"hidden",gap:0}}>
        {STAGES.map(st => {
          const cards = (cardsByStage[st.id] || []).filter(searchFilter);
          return (
            <div key={st.id} onDragOver={onDragOver} onDrop={e => onDrop(e, st.id)}
              style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",borderRight:"1px solid #1a2030"}}>
              <div style={{padding:"8px 10px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:4,background:st.color,flexShrink:0}}/>
                  <span style={{fontSize:11,fontWeight:600,color:st.color,fontFamily:F,textTransform:"uppercase",letterSpacing:1,flex:1}}>{st.label}</span>
                  <span style={{fontSize:10,color:"#4a5a70",fontWeight:600}}>{cards.length}</span>
                </div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:4}}>
                {cards.map(card => <div key={card.id} style={{marginBottom:4}}>{renderCard(card, true)}</div>)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      <div className="mts-pipeline-mobile" style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>{mobileView()}</div>
      <div className="mts-pipeline-desktop" style={{display:"none",flex:1,overflow:"hidden"}}>{desktopView()}</div>

      {/* ── FULL CARD DETAIL POPUP ──────────────────────────────────── */}
      {detailCard && (() => {
        const card = detailCard;
        const fd = loadFieldData(card.id);
        const stage = STAGES.find(st => st.id === card.stage);
        const isDeclined = card.stage === "declined";
        const ytId = (fd.videoUrl || "").match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];
        return <div onClick={() => setDetailCard(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",backdropFilter:"blur(6px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:10,overflowY:"auto"}}>
          <div onClick={e => e.stopPropagation()} style={{background:"#0d1018",border:"1px solid #1a2030",borderRadius:14,width:"100%",maxWidth:700,maxHeight:"90vh",overflowY:"auto",padding:0}}>

            {/* Header */}
            <div style={{padding:"16px 20px",background:"#0a0c12",borderBottom:"1px solid #1a2030",display:"flex",alignItems:"center",gap:10,position:"sticky",top:0,zIndex:1}}>
              <div style={{flex:1}}>
                <div style={{fontSize:20,fontWeight:700,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.5}}>{card.hot && "🔥 "}{card.cn}</div>
                {card.addr && <div style={{fontSize:13,color:"#8a96a8",fontFamily:F,textTransform:"uppercase",letterSpacing:1,marginTop:2}}>{card.addr}</div>}
              </div>
              <span style={{padding:"4px 12px",borderRadius:99,background:stage?.bg,color:stage?.color,fontSize:12,fontWeight:700,fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{stage?.label}</span>
              <button onClick={() => setDetailCard(null)} style={{width:32,height:32,borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#5a6580",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>

            <div style={{padding:"16px 20px"}}>
              {/* Contact */}
              <div style={{display:"flex",gap:16,marginBottom:16,flexWrap:"wrap"}}>
                {card.phone && <div style={{fontSize:14,color:"#a0b8d0"}}>📞 <a href={`tel:${card.phone.replace(/\D/g,"")}`} style={{color:"#a0b8d0"}}>{card.phone}</a></div>}
                {card.email && <div style={{fontSize:14,color:"#a0b8d0"}}>✉️ <a href={`mailto:${card.email}`} style={{color:"#a0b8d0"}}>{card.email}</a></div>}
                {card.jn && <button onClick={() => openSingleOps(card.jn)} style={{fontSize:14,color:"#039BE5",background:"none",border:"none",cursor:"pointer",fontWeight:600,padding:0}}>SingleOps #{card.jn} 📋</button>}
              </div>

              {/* Job notes */}
              {card.notes && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>JOB NOTES</div>
                <div style={{fontSize:14,color:"#8898a8",lineHeight:1.6,fontStyle:"italic"}}>{card.notes}</div>
              </div>}

              {/* My notes */}
              {fd.myNotes && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>MY NOTES</div>
                <div style={{fontSize:14,color:"#b0b8c8",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{fd.myNotes}</div>
              </div>}

              {/* AI Summary */}
              {fd.aiSummary && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>AI SUMMARY</div>
                <div style={{fontSize:14,color:"#a0b0c8",lineHeight:1.6,whiteSpace:"pre-wrap",padding:12,borderRadius:10,background:"rgba(127,119,221,.06)",border:"1px solid rgba(127,119,221,.12)"}}>{fd.aiSummary}</div>
              </div>}

              {/* Photos — large grid */}
              {(fd.photos || []).length > 0 && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:8}}>PHOTOS ({fd.photos.length})</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))",gap:8}}>
                  {fd.photos.map((p, i) => (
                    <div key={i} style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1px solid #1a2540",aspectRatio:"4/3"}}>
                      <img src={p.dataUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                      <a href={p.dataUrl} download={`${card.cn.replace(/\s+/g,"_")}_${i+1}.jpg`} style={{position:"absolute",bottom:6,right:6,padding:"4px 10px",borderRadius:6,background:"rgba(0,0,0,.7)",color:"#fff",fontSize:11,textDecoration:"none",fontWeight:600}}>⬇ Download</a>
                    </div>
                  ))}
                </div>
              </div>}

              {/* Video */}
              {fd.videoUrl && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>VIDEO</div>
                {ytId ? (
                  <div style={{position:"relative",paddingBottom:"56.25%",borderRadius:10,overflow:"hidden"}}>
                    <iframe src={`https://www.youtube.com/embed/${ytId}`} style={{position:"absolute",inset:0,width:"100%",height:"100%",border:"none"}} allowFullScreen />
                  </div>
                ) : (
                  <a href={fd.videoUrl} target="_blank" rel="noopener noreferrer" style={{fontSize:14,color:"#6a8aB0"}}>{fd.videoUrl}</a>
                )}
              </div>}

              {/* Audio clips */}
              {(fd.audioClips || []).length > 0 && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>VOICE MEMOS ({fd.audioClips.length})</div>
                {fd.audioClips.map((clip, i) => (
                  <audio key={i} controls src={clip.dataUrl} style={{width:"100%",marginBottom:4,height:36}} />
                ))}
              </div>}

              {/* Metadata */}
              <div style={{fontSize:12,color:"#4a5a70",marginBottom:16}}>
                Added {card.addedAt ? new Date(card.addedAt).toLocaleDateString() : "—"} · {card.constraint || "No constraints"}
              </div>

              {/* Stage move */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {isDeclined && <button onClick={() => { reactivate(card.id); setDetailCard({...card, stage:"estimate_needed"}); }} style={{padding:"8px 16px",borderRadius:8,background:"rgba(255,183,77,.1)",border:"1px solid rgba(255,183,77,.3)",color:"#FFB74D",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>↩ REACTIVATE</button>}
                {STAGES.filter(st => st.id !== card.stage && !(isDeclined && st.id !== "estimate_needed")).map(st => (
                  <button key={st.id} onClick={() => { moveCard(card.id, st.id); setDetailCard({...card, stage: st.id}); }} style={{padding:"8px 14px",borderRadius:8,background:st.bg,border:`1px solid ${st.color}40`,color:st.color,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{st.label}</button>
                ))}
              </div>
            </div>
          </div>
        </div>;
      })()}

      {/* ── EMAIL TEMPLATE SHEET ──────────────────────────────────────── */}
      {emailSheet && <div onClick={()=>{setEmailSheet(false);setEmailPreview(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:emailPreview?"center":"flex-end",justifyContent:"center",padding:emailPreview?20:0}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d1018",border:"1px solid #1a2030",borderRadius:emailPreview?14:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:emailPreview?18:"max(18px,env(safe-area-inset-bottom))"}}>

          {!emailPreview ? <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1,fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}>Email {selectedCount} clients</span>
              <button onClick={()=>{setEmailSheet(false);}} style={{width:28,height:28,borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            <div style={{fontSize:11,color:"#5a6580",marginBottom:10}}>Choose a template — each email will be personalized with the client's name.</div>
            {EMAIL_TEMPLATES.map(t => (
              <button key={t.id} onClick={()=>setEmailPreview(t)} style={{width:"100%",padding:"12px 14px",marginBottom:6,borderRadius:8,background:"#0e1525",border:"1px solid #1a2540",cursor:"pointer",textAlign:"left"}}>
                <div style={{fontSize:13,fontWeight:700,color:"#a0b8d0"}}>{t.label}</div>
                <div style={{fontSize:11,color:"#4a5a70",marginTop:2}}>{t.subject}</div>
              </button>
            ))}
          </> : <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <button onClick={()=>setEmailPreview(null)} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"1px solid #2a3560",color:"#5a6580",fontSize:11,cursor:"pointer"}}>← Back</button>
              <span style={{fontSize:13,fontWeight:700,color:"#f0f4fa",flex:1}}>{emailPreview.label}</span>
            </div>
            <div style={{fontSize:11,color:"#5a6580",marginBottom:6}}>Preview for {selectedCards[0]?.cn || "—"}:</div>
            <div style={{padding:"10px 12px",borderRadius:8,background:"#0e1525",border:"1px solid #1a2540",marginBottom:10}}>
              <div style={{fontSize:11,color:"#6a8aB0",marginBottom:4,fontWeight:600}}>Subject: {emailPreview.subject}</div>
              <div style={{fontSize:12,color:"#8898a8",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{emailPreview.body.replace(/\{firstName\}/g, (selectedCards[0]?.cn || "").split(" ")[0])}</div>
            </div>
            <div style={{fontSize:10,color:"#4a5a70",marginBottom:10}}>Will send to: {selectedCards.map(c => c.email || "(no email)").join(", ")}</div>
            <button onClick={()=>sendBulkEmail(emailPreview)} style={{width:"100%",padding:"12px 0",borderRadius:8,background:"rgba(3,155,229,.15)",border:"1px solid rgba(3,155,229,.25)",color:"#039BE5",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}>📧 SEND {selectedCount} EMAILS</button>
            <div style={{fontSize:10,color:"#3a4a60",marginTop:6,textAlign:"center"}}>Opens each in Outlook — tap Send on each one</div>
          </>}
        </div>
      </div>}
    </div>
  );
}

export { STAGES, loadPipeline, savePipeline };
