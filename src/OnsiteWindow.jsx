import { useState, useEffect, useRef } from "react";
import PhotoMarkup from "./PhotoMarkup";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Onsite Window
   Full-screen data capture for a client stop. Opens via swipe-right.
   Saves continuously to localStorage. "← Route" returns without marking done.
   "Done →" moves card to pipeline.
   ═══════════════════════════════════════════════════════════════════════════ */

const FIELD_KEY = id => `mts-field-${id}`;
function loadFieldData(id) { try { return JSON.parse(localStorage.getItem(FIELD_KEY(id))) || {}; } catch(e) { return {}; } }
function saveFieldData(id, data) { try { localStorage.setItem(FIELD_KEY(id), JSON.stringify(data)); } catch(e) {} }

export default function OnsiteWindow({ stop, onBack, onDone, onDecline }) {
  const s = stop;
  const fd = loadFieldData(s.id);
  const [myNotes, setMyNotes] = useState(fd.myNotes || "");
  const [videoUrl, setVideoUrl] = useState(fd.videoUrl || "");
  const [photos, setPhotos] = useState(fd.photos || []);
  const [audioClips, setAudioClips] = useState(fd.audioClips || []); // [{dataUrl, ts, duration}]
  const [markupIdx, setMarkupIdx] = useState(null);
  const [showVideoInput, setShowVideoInput] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [playingIdx, setPlayingIdx] = useState(null);
  const [declineConfirm, setDeclineConfirm] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const swipeDir = useRef(null);
  const cameraRef = useRef(null);
  const libraryRef = useRef(null);
  const mediaRecRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const audioElRef = useRef(null);
  const notesRef = useRef(null);

  // Auto-save on every change
  useEffect(() => {
    saveFieldData(s.id, { myNotes, videoUrl, photos, audioClips });
  }, [myNotes, videoUrl, photos, audioClips, s.id]);

  // ── PHOTO HANDLING ──────────────────────────────────────────────────
  const processPhoto = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > MAX) { h = h * MAX / w; w = MAX; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        setPhotos(prev => [...prev, { dataUrl: c.toDataURL("image/jpeg", 0.7), ts: Date.now() }]);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  const handleCamera = (e) => { processPhoto(e.target.files?.[0]); e.target.value = ""; };
  const handleLibrary = (e) => { processPhoto(e.target.files?.[0]); e.target.value = ""; };
  const removePhoto = (i) => setPhotos(prev => prev.filter((_, j) => j !== i));
  const handleMarkupSave = (dataUrl) => {
    setPhotos(prev => prev.map((p, i) => i === markupIdx ? { ...p, dataUrl } : p));
    setMarkupIdx(null);
  };

  // ── AUDIO RECORDING ─────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = () => {
          setAudioClips(prev => [...prev, { dataUrl: reader.result, ts: Date.now(), duration: recDuration }]);
        };
        reader.readAsDataURL(blob);
        setRecDuration(0);
      };
      mediaRecRef.current = mr;
      mr.start();
      setRecording(true);
      let sec = 0;
      recTimerRef.current = setInterval(() => { sec++; setRecDuration(sec); }, 1000);
    } catch(e) {
      console.warn("Mic access denied", e);
    }
  };

  const stopRecording = () => {
    if (mediaRecRef.current && recording) {
      clearInterval(recTimerRef.current);
      mediaRecRef.current.stop();
      setRecording(false);
    }
  };

  const removeAudio = (i) => setAudioClips(prev => prev.filter((_, j) => j !== i));

  const playAudio = (i) => {
    if (playingIdx === i) {
      audioElRef.current?.pause();
      setPlayingIdx(null);
      return;
    }
    if (audioElRef.current) audioElRef.current.pause();
    const a = new Audio(audioClips[i].dataUrl);
    a.onended = () => setPlayingIdx(null);
    a.play();
    audioElRef.current = a;
    setPlayingIdx(i);
  };

  const fmtDur = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  // YouTube thumbnail
  const ytId = videoUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];

  // ── MARKUP OVERLAY ──────────────────────────────────────────────────
  if (markupIdx !== null && photos[markupIdx]) {
    return <PhotoMarkup photoDataUrl={photos[markupIdx].dataUrl} onSave={handleMarkupSave} onCancel={() => setMarkupIdx(null)} />;
  }

  const F = "'Oswald',sans-serif";
  const B = "'DM Sans',system-ui,sans-serif";

  // Swipe left on body → pipeline
  const onTouchStart = (e) => { swipeStartX.current = e.touches[0].clientX; swipeStartY.current = e.touches[0].clientY; swipeDir.current = null; setSwiping(true); };
  const onTouchMove = (e) => {
    if (!swiping) return;
    const dx = e.touches[0].clientX - swipeStartX.current;
    const dy = e.touches[0].clientY - swipeStartY.current;
    if (swipeDir.current === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) swipeDir.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    if (swipeDir.current === "h" && dx < 0) setSwipeX(dx);
  };
  const onTouchEnd = () => {
    if (swipeX < -120) onDone();
    setSwipeX(0); setSwiping(false); swipeDir.current = null;
  };

  return (
    <div style={{position:"fixed",inset:0,zIndex:100,background:"#0a0c12",display:"flex",flexDirection:"column",fontFamily:B,color:"#f0f4fa",overflow:"hidden"}}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:"#0d1018",borderBottom:"1px solid #1a2030",flexShrink:0,paddingTop:"max(10px,env(safe-area-inset-top))"}}>
        <button onClick={onBack} style={{padding:"6px 14px",borderRadius:8,background:"transparent",border:"1px solid #2a3560",color:"#90a8c0",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5}}>← ROUTE</button>
        <div style={{flex:1,minWidth:0,textAlign:"center"}}>
          <div style={{fontSize:16,fontWeight:600,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
        </div>
        <button onClick={onDone} style={{padding:"6px 14px",borderRadius:8,background:"#33B679",border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5}}>DONE →</button>
      </div>

      {/* ── SCROLLABLE BODY ────────────────────────────────────────────── */}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{flex:1,overflowY:"auto",paddingBottom:"max(80px,calc(70px + env(safe-area-inset-bottom)))",transform:`translateX(${swipeX}px)`,transition:swiping?"none":"transform .25s"}}>

        {/* Swipe-to-pipeline hint */}
        {swipeX < -30 && <div style={{position:"fixed",top:"50%",right:12,transform:"translateY(-50%)",padding:"10px 14px",borderRadius:10,background:"rgba(51,182,121,.15)",border:"1px solid rgba(51,182,121,.3)",color:"#33B679",fontSize:12,fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",opacity:Math.min(Math.abs(swipeX)/120,1),zIndex:102}}>→ PIPELINE</div>}

        {/* Address + meta */}
        <div style={{padding:"10px 16px",background:"#0d1018",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:12,color:"#96a2b4",fontFamily:F,textTransform:"uppercase",letterSpacing:1}}>{s.addr}</div>
          <div style={{fontSize:11,color:"#4a5a70",marginTop:2}}>
            {s.window && <span style={{marginRight:8}}>{s.window}</span>}
            {s.jn && <span>#{s.jn}</span>}
            {s.constraint && <span style={{marginLeft:8,color:"#FF80AB"}}>{s.constraint}</span>}
          </div>
        </div>

        {/* ── JOB NOTES (read-only from SingleOps) ──────────────────── */}
        {s.notes && (
          <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5,display:"flex",alignItems:"center",gap:5}}>JOB NOTES <span style={{fontSize:8,color:"#3a4a60"}}>🔒</span></div>
            <div style={{fontSize:13,color:"#8898a8",lineHeight:1.6}}>{s.notes}</div>
          </div>
        )}

        {/* ── MY NOTES + AUDIO ──────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>MY NOTES</div>
          <textarea
            ref={notesRef}
            value={myNotes}
            onChange={e => setMyNotes(e.target.value)}
            placeholder="Dictate or type field observations..."
            rows={5}
            style={{
              width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,
              background:"#0e1525",border:"1px solid #1a2540",color:"#e0e8f0",
              fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none",
            }}
          />

          {/* Audio recorder */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
            {!recording ? (
              <button onClick={startRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:8,background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.25)",color:"#FF3B30",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                <span style={{width:10,height:10,borderRadius:5,background:"#FF3B30",display:"inline-block"}}/>
                Record voice memo
              </button>
            ) : (
              <button onClick={stopRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:8,background:"rgba(255,59,48,.2)",border:"1px solid rgba(255,59,48,.4)",color:"#FF3B30",fontSize:12,fontWeight:700,cursor:"pointer",animation:"pulse 1s infinite"}}>
                <span style={{width:10,height:10,borderRadius:2,background:"#FF3B30",display:"inline-block"}}/>
                Stop · {fmtDur(recDuration)}
              </button>
            )}
          </div>
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>

          {/* Audio clips */}
          {audioClips.length > 0 && (
            <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
              {audioClips.map((clip, i) => (
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,background:"#0e1525",border:"1px solid #1a2540"}}>
                  <button onClick={() => playAudio(i)} style={{width:28,height:28,borderRadius:14,background:playingIdx===i?"rgba(255,59,48,.15)":"rgba(3,155,229,.1)",border:"none",color:playingIdx===i?"#FF3B30":"#039BE5",fontSize:12,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{playingIdx===i?"■":"▶"}</button>
                  <div style={{flex:1,fontSize:11,color:"#6a7a90"}}>Voice memo · {clip.duration ? fmtDur(clip.duration) : "—"}</div>
                  <button onClick={() => removeAudio(i)} style={{padding:"3px 8px",borderRadius:6,background:"rgba(200,60,60,.1)",border:"1px solid rgba(200,60,60,.2)",color:"#e06060",fontSize:10,fontWeight:700,cursor:"pointer"}}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── PHOTOS ────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>PHOTOS</div>
          {photos.length > 0 && (
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
              {photos.map((p, i) => (
                <div key={i} style={{position:"relative",width:80,height:80,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                  <img src={p.dataUrl} alt="" onClick={() => setMarkupIdx(i)} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                  <button onClick={(e) => { e.stopPropagation(); removePhoto(i); }} style={{position:"absolute",top:3,right:3,width:18,height:18,borderRadius:9,background:"rgba(0,0,0,.7)",border:"none",color:"#ff6666",fontSize:10,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  <div style={{position:"absolute",bottom:3,left:3,display:"flex",gap:3}}>
                    <div onClick={() => setMarkupIdx(i)} style={{padding:"2px 5px",borderRadius:4,background:"rgba(0,0,0,.65)",color:"#ccc",fontSize:8,fontWeight:700,cursor:"pointer"}}>✏️</div>
                    <a href={p.dataUrl} download={`mts_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"2px 5px",borderRadius:4,background:"rgba(0,0,0,.65)",color:"#ccc",fontSize:8,fontWeight:700,cursor:"pointer",textDecoration:"none"}}>⬇</a>
                  </div>
                </div>
              ))}
            </div>
          )}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleCamera} style={{display:"none"}} />
          <input ref={libraryRef} type="file" accept="image/*" onChange={handleLibrary} style={{display:"none"}} />
          <div style={{display:"flex",gap:6}}>
            <button onClick={() => cameraRef.current?.click()} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:13,fontWeight:600,cursor:"pointer"}}>📷 Take photo</button>
            <button onClick={() => libraryRef.current?.click()} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:13,fontWeight:600,cursor:"pointer"}}>🖼 Photo library</button>
          </div>
        </div>

        {/* ── VIDEO ─────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>VIDEO</div>
          {videoUrl && !showVideoInput ? (
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px",borderRadius:10,background:"#0e1525",border:"1px solid #1a2540"}}>
              {ytId && <img src={`https://img.youtube.com/vi/${ytId}/default.jpg`} alt="" style={{width:56,height:42,borderRadius:6,objectFit:"cover"}} />}
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,color:"#a0b0c0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{videoUrl}</div>
              </div>
              <button onClick={() => setShowVideoInput(true)} style={{padding:"4px 10px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#5a6580",fontSize:10,fontWeight:700,cursor:"pointer"}}>Edit</button>
              <button onClick={() => { setVideoUrl(""); setShowVideoInput(false); }} style={{padding:"4px 10px",borderRadius:6,background:"rgba(200,60,60,.1)",border:"1px solid rgba(200,60,60,.2)",color:"#e06060",fontSize:10,fontWeight:700,cursor:"pointer"}}>✕</button>
            </div>
          ) : showVideoInput ? (
            <div>
              <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="Paste YouTube link..." style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1525",border:"1px solid #2a3560",color:"#e0e8f0",fontSize:13,fontFamily:B,outline:"none"}} />
              <button onClick={() => setShowVideoInput(false)} style={{marginTop:6,padding:"6px 14px",borderRadius:6,background:"#1a2240",border:"1px solid #2a3560",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer"}}>Done</button>
            </div>
          ) : (
            <button onClick={() => setShowVideoInput(true)} style={{width:"100%",padding:"14px 0",borderRadius:10,background:"#0e1525",border:"1px dashed #1a2540",color:"#5a7090",fontSize:13,fontWeight:600,cursor:"pointer"}}>🎬 Paste YouTube link</button>
          )}
        </div>

        {/* ── AI ASSIST (placeholder) ──────────────────────────────── */}
        <div style={{padding:"12px 16px"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>AI ASSIST</div>
          <div style={{padding:"14px",borderRadius:10,background:"linear-gradient(135deg, rgba(127,119,221,.06), rgba(3,155,229,.06))",border:"1px solid rgba(127,119,221,.15)"}}>
            <div style={{fontSize:12,color:"#6a6090",fontWeight:600,marginBottom:6}}>✨ Claude integration coming soon</div>
            <div style={{fontSize:11,color:"#4a5070",lineHeight:1.5}}>Auto-summarize your notes and photos into structured estimates, client emails, and follow-up reminders.</div>
            <button disabled style={{marginTop:10,padding:"10px 20px",borderRadius:8,background:"rgba(127,119,221,.08)",border:"1px solid rgba(127,119,221,.15)",color:"#5a5080",fontSize:12,fontWeight:700,cursor:"default",opacity:.5}}>✨ Generate summary</button>
          </div>
        </div>

      </div>

      {/* ── STICKY BOTTOM BAR ──────────────────────────────────────── */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",background:"#0d1018",borderTop:"1px solid #1a2030",display:"flex",gap:8,paddingBottom:"max(10px,env(safe-area-inset-bottom))",zIndex:101}}>
        {s.phone && <button onClick={() => window.open(`sms:${s.phone.replace(/\D/g,"")}`,"_self")} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2240",border:"1px solid #2a3560",color:"#a0b8d0",fontSize:13,fontWeight:700,cursor:"pointer"}}>💬</button>}
        {s.addr && <button onClick={() => { window.location.href = `comgooglemaps://?daddr=${encodeURIComponent(s.addr)}&directionsmode=driving`; }} style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(3,155,229,.1)",border:"1px solid rgba(3,155,229,.2)",color:"#039BE5",fontSize:13,fontWeight:700,cursor:"pointer"}}>🧭</button>}
        {!declineConfirm ? (
          <button onClick={() => setDeclineConfirm(true)} style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(200,60,60,.08)",border:"1px solid rgba(200,60,60,.2)",color:"#a06060",fontSize:12,fontWeight:700,cursor:"pointer"}}>✕ Decline</button>
        ) : (
          <button onClick={() => { setDeclineConfirm(false); onDecline(); }} style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(200,60,60,.2)",border:"1px solid rgba(200,60,60,.4)",color:"#FF5555",fontSize:12,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite"}}>Confirm decline?</button>
        )}
        <button onClick={onDone} style={{flex:2,padding:"12px 0",borderRadius:10,background:"rgba(51,182,121,.15)",border:"1px solid rgba(51,182,121,.25)",color:"#33B679",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>✓ DONE</button>
      </div>
    </div>
  );
}
