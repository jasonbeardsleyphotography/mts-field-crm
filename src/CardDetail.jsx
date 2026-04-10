import { useState, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Card Detail (Enriched)
   Expanded card view with field notes, photo capture, and YouTube link.
   All field data persists to localStorage keyed by event ID.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── STORAGE ──────────────────────────────────────────────────────────────────
const FIELD_KEY = id => `mts-field-${id}`;

function loadFieldData(id) {
  try { return JSON.parse(localStorage.getItem(FIELD_KEY(id))) || {}; }
  catch(e) { return {}; }
}

function saveFieldData(id, data) {
  try { localStorage.setItem(FIELD_KEY(id), JSON.stringify(data)); } catch(e) {}
}

export default function CardDetail({ stop, isNext, onText, onNavigate, onDismiss }) {
  const s = stop;
  const ml = isNext ? 50 : 44;
  const [fieldData, setFieldData] = useState(() => loadFieldData(s.id));
  const [noteText, setNoteText] = useState(fieldData.fieldNotes || "");
  const [videoUrl, setVideoUrl] = useState(fieldData.videoUrl || "");
  const [photos, setPhotos] = useState(fieldData.photos || []); // array of {dataUrl, timestamp}
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const fileRef = useRef(null);
  const noteRef = useRef(null);

  // Persist whenever field data changes
  useEffect(() => {
    const data = { fieldNotes: noteText, videoUrl, photos };
    saveFieldData(s.id, data);
    setFieldData(data);
  }, [noteText, videoUrl, photos, s.id]);

  // Auto-focus note input
  useEffect(() => {
    if (showNoteInput && noteRef.current) noteRef.current.focus();
  }, [showNoteInput]);

  // Photo capture
  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Resize to max 800px wide to keep localStorage manageable
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > MAX) { h = h * MAX / w; w = MAX; }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        setPhotos(prev => [...prev, { dataUrl, ts: Date.now() }]);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const removePhoto = (idx) => {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  };

  // Extract YouTube video ID for thumbnail
  const ytId = videoUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];

  return (
    <div onClick={e => e.stopPropagation()} style={{marginTop:12,marginLeft:ml,paddingTop:12,borderTop:"1px solid #1a2030"}}>

      {/* ── SINGLEOPS DATA (read-only, from calendar) ───────────────── */}
      {s.notes && <div style={{fontSize:13,color:"#a0b0c0",lineHeight:1.6,marginBottom:10,fontWeight:500}}>{s.notes}</div>}
      {s.phone && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:3,fontWeight:600}}>📞 {s.phone}</div>}
      {s.email && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:8,fontWeight:600}}>✉️ {s.email}</div>}

      {/* ── FIELD NOTES ────────────────────────────────────────────────── */}
      <div style={{marginTop:8,marginBottom:8}}>
        {noteText && !showNoteInput && (
          <div onClick={() => setShowNoteInput(true)} style={{padding:"8px 10px",borderRadius:8,background:"#0e1525",border:"1px solid #1a2540",marginBottom:6,cursor:"pointer"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#5a6580",letterSpacing:0.5,marginBottom:3,textTransform:"uppercase",fontFamily:"'Barlow Condensed',sans-serif"}}>Field notes</div>
            <div style={{fontSize:13,color:"#c0c8d8",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{noteText}</div>
          </div>
        )}
        {showNoteInput ? (
          <div style={{marginBottom:6}}>
            <textarea
              ref={noteRef}
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Dictate or type field notes..."
              rows={4}
              style={{
                width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,
                background:"#0e1525",border:"1px solid #2a3560",color:"#e0e8f0",
                fontSize:14,fontFamily:"'DM Sans',system-ui,sans-serif",lineHeight:1.6,
                resize:"vertical",outline:"none",
              }}
            />
            <button onClick={() => setShowNoteInput(false)} style={{marginTop:4,padding:"5px 14px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer"}}>Done editing</button>
          </div>
        ) : (
          !noteText && <button onClick={() => setShowNoteInput(true)} style={{width:"100%",padding:"10px 0",borderRadius:8,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:12,fontWeight:600,cursor:"pointer",marginBottom:6}}>📝 Add field notes</button>
        )}
      </div>

      {/* ── PHOTOS ─────────────────────────────────────────────────────── */}
      <div style={{marginBottom:8}}>
        {photos.length > 0 && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
            {photos.map((p, i) => (
              <div key={i} style={{position:"relative",width:72,height:72,borderRadius:8,overflow:"hidden",border:"1px solid #1a2540"}}>
                <img src={p.dataUrl} alt={`Photo ${i+1}`} style={{width:"100%",height:"100%",objectFit:"cover"}} />
                <button onClick={() => removePhoto(i)} style={{position:"absolute",top:2,right:2,width:18,height:18,borderRadius:9,background:"rgba(0,0,0,.7)",border:"none",color:"#ff6666",fontSize:10,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{display:"none"}} />
        <button onClick={() => fileRef.current?.click()} style={{width:"100%",padding:"10px 0",borderRadius:8,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:12,fontWeight:600,cursor:"pointer",marginBottom:6}}>📷 {photos.length > 0 ? "Add another photo" : "Take photo"}</button>
      </div>

      {/* ── VIDEO LINK ─────────────────────────────────────────────────── */}
      <div style={{marginBottom:10}}>
        {videoUrl && !showVideoInput ? (
          <div style={{padding:"8px 10px",borderRadius:8,background:"#0e1525",border:"1px solid #1a2540",marginBottom:6}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {ytId && <img src={`https://img.youtube.com/vi/${ytId}/default.jpg`} alt="" style={{width:48,height:36,borderRadius:4,objectFit:"cover"}} />}
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:10,fontWeight:700,color:"#5a6580",letterSpacing:0.5,textTransform:"uppercase",fontFamily:"'Barlow Condensed',sans-serif"}}>Video</div>
                <div style={{fontSize:11,color:"#6a8aB0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{videoUrl}</div>
              </div>
              <button onClick={() => setShowVideoInput(true)} style={{padding:"3px 8px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#5a6580",fontSize:10,fontWeight:700,cursor:"pointer"}}>Edit</button>
              <button onClick={() => { setVideoUrl(""); setShowVideoInput(false); }} style={{padding:"3px 8px",borderRadius:6,background:"rgba(200,60,60,.1)",border:"1px solid rgba(200,60,60,.2)",color:"#e06060",fontSize:10,fontWeight:700,cursor:"pointer"}}>✕</button>
            </div>
          </div>
        ) : showVideoInput ? (
          <div style={{marginBottom:6}}>
            <input
              type="url"
              value={videoUrl}
              onChange={e => setVideoUrl(e.target.value)}
              placeholder="Paste YouTube link..."
              style={{
                width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,
                background:"#0e1525",border:"1px solid #2a3560",color:"#e0e8f0",
                fontSize:13,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none",
              }}
            />
            <button onClick={() => setShowVideoInput(false)} style={{marginTop:4,padding:"5px 14px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer"}}>Done</button>
          </div>
        ) : (
          <button onClick={() => setShowVideoInput(true)} style={{width:"100%",padding:"10px 0",borderRadius:8,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:12,fontWeight:600,cursor:"pointer"}}>🎬 Add video link</button>
        )}
      </div>

      {/* ── ACTION BUTTONS ─────────────────────────────────────────────── */}
      <div style={{display:"flex",gap:8,marginTop:4}}>
        {s.phone && <button onClick={onText} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2240",border:"1px solid #2a3560",color:"#a0b8d0",fontSize:13,fontWeight:700,cursor:"pointer"}}>💬 Text</button>}
        {s.addr && <button onClick={onNavigate} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:700,cursor:"pointer"}}>🧭 Navigate</button>}
        <button onClick={onDismiss} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(51,182,121,.1)",border:"1px solid rgba(51,182,121,.2)",color:"#33B679",fontSize:13,fontWeight:700,cursor:"pointer"}}>✓ Done</button>
      </div>
    </div>
  );
}
