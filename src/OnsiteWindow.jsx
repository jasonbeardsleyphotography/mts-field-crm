import { useState, useEffect, useRef } from "react";
import PhotoMarkup from "./PhotoMarkup";
import CameraView from "./CameraView";
import { saveFieldToDrive, loadFieldFromDrive } from "./driveSync";
import { loadField, saveField, peekField, primeField } from "./fieldStore";
import { IconArrowLeft, IconRefresh, IconCamera, IconImage, IconDownload, IconPen, IconEraser, IconMic, IconVolume2, IconSparkles, IconYoutube, IconMail, IconX, IconZap, IconClipboard, IconPhone, IconMessageSquare, IconNavigation, IconCheckCircle, IconRotateCcw, IconSend } from "./icons";

const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Onsite Window
   Full-screen data capture for a client stop. Opens via swipe-right.
   Saves continuously to IndexedDB (via fieldStore). "← Route" returns
   without marking done. "Done →" moves card to pipeline.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function OnsiteWindow({ stop, onBack, onDone, onDecline, token }) {
  const s = stop;
  // Synchronous peek for initial state — returns {} or the localStorage
  // mirror if one exists. The real async load runs below and hydrates.
  const fd = peekField(s.id);
  // Backward compat: migrate old myNotes/photos to scope
  const [scopeNotes, setScopeNotes] = useState(fd.scopeNotes || fd.myNotes || "");
  const [addonNotes, setAddonNotes] = useState(fd.addonNotes || "");
  const [scopePhotos, setScopePhotos] = useState(fd.scopePhotos || fd.photos || []);
  const [addonPhotos, setAddonPhotos] = useState(fd.addonPhotos || []);
  // Support multiple video uploads — stored as array
  const [videoUrls, setVideoUrls] = useState(fd.videoUrls || (fd.videoUrl ? [fd.videoUrl] : []));
  const [audioClips, setAudioClips] = useState(fd.audioClips || []);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [markupIdx, setMarkupIdx] = useState(null);
  const [markupSection, setMarkupSection] = useState("scope"); // which photo array to edit
  const [showCamera, setShowCamera] = useState(false);
  const [cameraSection, setCameraSection] = useState("scope");
  const [recording, setRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [playingIdx, setPlayingIdx] = useState(null);
  const ytFileRef = useRef(null);
  const [ytUploadCount, setYtUploadCount] = useState(0);
  const mountedRef = useRef(true);
  const stopIdRef = useRef(s.id);

  const [aiScopeResult, setAiScopeResult] = useState(fd.aiScopeSummary || "");
  const [aiAddonResult, setAiAddonResult] = useState(fd.aiAddonEmail || "");
  const [aiScopeLoading, setAiScopeLoading] = useState(false);
  const [aiAddonLoading, setAiAddonLoading] = useState(false);
  const [declineConfirm, setDeclineConfirm] = useState(false);
  const [jobNotesOpen, setJobNotesOpen] = useState(false);
  const [isRevision, setIsRevision] = useState(false);
  const [swipeX, setSwipeX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const swipeDir = useRef(null);
  const scopeLibRef = useRef(null);
  const addonLibRef = useRef(null);
  const mediaRecRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const audioElRef = useRef(null);
  const notesRef = useRef(null);

  // Reset scroll on unmount so route screen isn't left zoomed
  useEffect(() => { return () => { setTimeout(() => { try { window.scrollTo(0,0); } catch(e){} }, 80); }; }, []);

  // Auto-save on every change — IndexedDB (local) + Drive.
  // Emit "mts-field-synced" so Pipeline's field-summary memo refreshes if the
  // user flips to Pipeline with OnsiteWindow already open.
  useEffect(() => {
    const data = { scopeNotes, addonNotes, scopePhotos, addonPhotos, videoUrls, audioClips, aiScopeSummary: aiScopeResult, aiAddonEmail: aiAddonResult };
    // Prime the sync peek so Pipeline sees fresh data immediately, then
    // asynchronously persist to IDB.
    primeField(s.id, data);
    saveField(s.id, data).catch(() => {});
    try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
    // Sync to Drive (debounced via timer)
    if (token) {
      if (window._fieldSyncTimer) clearTimeout(window._fieldSyncTimer);
      window._fieldSyncTimer = setTimeout(() => {
        saveFieldToDrive(token, s.id, data).catch(() => {});
      }, 3000);
    }
  }, [scopeNotes, addonNotes, scopePhotos, addonPhotos, videoUrls, audioClips, aiScopeResult, aiAddonResult, s.id]);

  // On mount (or when stop changes), hydrate from IndexedDB.
  // If peekField returned empty we'll get the data here; if it had a
  // localStorage-mirror value we'll still get the fresher IDB read.
  useEffect(() => {
    let dead = false;
    loadField(s.id).then(data => {
      if (dead || !data || Object.keys(data).length === 0) return;
      primeField(s.id, data);
      // Only overwrite local state if the user hasn't typed anything yet.
      // Otherwise we'd clobber in-progress edits — unlikely but possible if
      // the user opens a stop, starts typing, then the load resolves late.
      if (!scopeNotes && (data.scopeNotes || data.myNotes)) setScopeNotes(data.scopeNotes || data.myNotes || "");
      if (!addonNotes && data.addonNotes) setAddonNotes(data.addonNotes);
      if (scopePhotos.length === 0 && (data.scopePhotos || data.photos)) setScopePhotos(data.scopePhotos || data.photos || []);
      if (addonPhotos.length === 0 && data.addonPhotos) setAddonPhotos(data.addonPhotos);
      if (videoUrls.length === 0 && (data.videoUrls || data.videoUrl)) setVideoUrls(data.videoUrls || (data.videoUrl ? [data.videoUrl] : []));
      if (audioClips.length === 0 && data.audioClips) setAudioClips(data.audioClips);
      if (!aiScopeResult && data.aiScopeSummary) setAiScopeResult(data.aiScopeSummary);
      if (!aiAddonResult && data.aiAddonEmail) setAiAddonResult(data.aiAddonEmail);
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  // If localStorage is empty (desktop), pull from Drive
  useEffect(() => {
    const hasLocal = !!(fd.scopeNotes || fd.myNotes || fd.addonNotes || (fd.scopePhotos || fd.photos || []).length);
    if (!hasLocal && token) {
      setCloudLoading(true);
      loadFieldFromDrive(token, s.id).then(cloud => {
        if (cloud) {
          if (cloud.scopeNotes || cloud.myNotes) setScopeNotes(cloud.scopeNotes || cloud.myNotes || "");
          if (cloud.addonNotes) setAddonNotes(cloud.addonNotes);
          if (cloud.scopePhotos || cloud.photos) setScopePhotos(cloud.scopePhotos || cloud.photos || []);
          if (cloud.addonPhotos) setAddonPhotos(cloud.addonPhotos);
          if (cloud.videoUrls) setVideoUrls(cloud.videoUrls); else if (cloud.videoUrl) setVideoUrls([cloud.videoUrl]);
          if (cloud.audioClips) setAudioClips(cloud.audioClips);
          if (cloud.aiScopeSummary) setAiScopeResult(cloud.aiScopeSummary);
          if (cloud.aiAddonEmail) setAiAddonResult(cloud.aiAddonEmail);
          // Save to IndexedDB for next time
          saveField(s.id, cloud).catch(() => {});
          primeField(s.id, cloud);
        }
        setCloudLoading(false);
      }).catch(() => setCloudLoading(false));
    }
  }, [s.id, token]);

  // ── PHOTO HANDLING ──────────────────────────────────────────────────
  const processPhoto = (file, section = "scope") => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 2400;
        let w = img.width, h = img.height;
        if (w > MAX) { h = h * MAX / w; w = MAX; }
        if (h > MAX) { w = w * MAX / h; h = MAX; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const photo = { dataUrl: c.toDataURL("image/jpeg", 0.82), ts: Date.now() };
        if (section === "addon") setAddonPhotos(prev => [...prev, photo]);
        else setScopePhotos(prev => [...prev, photo]);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  const handleScopePhotos = (e) => { Array.from(e.target.files || []).forEach(f => processPhoto(f, "scope")); e.target.value = ""; };
  const handleAddonPhotos = (e) => { Array.from(e.target.files || []).forEach(f => processPhoto(f, "addon")); e.target.value = ""; };
  const removeScopePhoto = (i) => setScopePhotos(prev => prev.filter((_, j) => j !== i));
  const removeAddonPhoto = (i) => setAddonPhotos(prev => prev.filter((_, j) => j !== i));
  const removePhoto = (i, section) => {
    if (section === "addon") setAddonPhotos(prev => prev.filter((_, j) => j !== i));
    else setScopePhotos(prev => prev.filter((_, j) => j !== i));
  };
  const handleMarkupSave = (dataUrl) => {
    if (markupSection === "addon") setAddonPhotos(prev => prev.map((p, i) => i === markupIdx ? { ...p, dataUrl } : p));
    else setScopePhotos(prev => prev.map((p, i) => i === markupIdx ? { ...p, dataUrl } : p));
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

  // YouTube thumbnail + ID helpers
  const getYtId = (url) => url?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];

  // ── YOUTUBE DELETE ──────────────────────────────────────────────────
  const deleteYouTubeVideo = async (url, idx) => {
    const videoId = getYtId(url);
    if (!videoId) {
      // No valid YT ID — just remove from app
      setVideoUrls(prev => prev.filter((_, i) => i !== idx));
      return;
    }

    const tokenData = JSON.parse(localStorage.getItem("mts-token") || "null");
    const tok = tokenData?.token || token;
    if (!tok) {
      alert("Not signed in — can't delete from YouTube.");
      return;
    }

    const confirmed = window.confirm("Delete this video from YouTube AND remove it from the app?");
    if (!confirmed) return;

    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?id=${videoId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${tok}` },
        }
      );

      if (res.ok || res.status === 204) {
        // 204 No Content = success
        setVideoUrls(prev => prev.filter((_, i) => i !== idx));
      } else if (res.status === 404) {
        // Already deleted on YouTube — clean it up in the app anyway
        setVideoUrls(prev => prev.filter((_, i) => i !== idx));
      } else {
        const err = await res.text();
        console.error("YouTube delete failed:", err);
        alert("Could not delete from YouTube. Removing from app only.");
        setVideoUrls(prev => prev.filter((_, i) => i !== idx));
      }
    } catch(e) {
      console.warn("YouTube delete error:", e);
      alert("Network error — removing from app only.");
      setVideoUrls(prev => prev.filter((_, i) => i !== idx));
    }
  };

  // ── MARKUP OVERLAY ──────────────────────────────────────────────────
  // Camera view — rapid capture mode
  if (showCamera) {
    return <CameraView
      onPhoto={(dataUrl) => {
        const photo = { dataUrl, ts: Date.now() };
        if (cameraSection === "addon") setAddonPhotos(prev => [...prev, photo]);
        else setScopePhotos(prev => [...prev, photo]);
      }}
      onClose={() => setShowCamera(false)}
    />;
  }

  if (markupIdx !== null) {
    const photos = markupSection === "addon" ? addonPhotos : scopePhotos;
    if (photos[markupIdx]) {
      return <PhotoMarkup photoDataUrl={photos[markupIdx].dataUrl} onSave={handleMarkupSave} onCancel={() => setMarkupIdx(null)} />;
    }
  }

  // ── GEMINI AI ───────────────────────────────────────────────────────

  const callGemini = async (prompt) => {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  };

  const generateScopeSummary = async () => {
    if (!GEMINI_KEY) { setAiScopeResult("Add VITE_GEMINI_KEY to .env"); return; }
    setAiScopeLoading(true);
    try {
      const text = await callGemini(`You are an ISA-certified arborist's field assistant. Summarize these field notes into a structured estimate summary. Include: species/trees observed, conditions found, recommended treatments, equipment needed, and a rough job value estimate if enough info exists. Be concise and professional.

Client: ${s.cn}
Address: ${s.addr}
Job notes from office: ${s.notes || "None"}
Scope notes: ${scopeNotes || "None"}
Constraints: ${s.constraint || "None"}`);
      setAiScopeResult(text);
    } catch(e) { setAiScopeResult("Error: " + e.message); }
    setAiScopeLoading(false);
  };

  const generateAddonEmail = async () => {
    if (!GEMINI_KEY) { setAiAddonResult("Add VITE_GEMINI_KEY to .env"); return; }
    setAiAddonLoading(true);
    try {
      const text = await callGemini(`You are an ISA-certified arborist writing a professional, educational email to a homeowner. Based on these additional findings discovered during a site visit:

1. For each issue found, write a brief educational paragraph explaining what it is, why it matters for tree/plant health, and what treatments or recommendations exist.
2. Reference science-based information — cite Cornell Cooperative Extension, Northeast university extension resources, or ISA best practices where relevant. Use phrases like "According to Cornell Extension research..." or "ISA best management practices recommend..."
3. NEVER use the word "chemical" — instead use "treatments," "applications," "plant healthcare solutions," or "recommendations."
4. Tone should be educational but down-to-earth — like a knowledgeable neighbor explaining things, not a textbook.
5. Keep it warm and professional. Do not be alarming.
6. End with a brief recommendation and offer to discuss further.
7. Sign as Jason from Monster Tree Service of Rochester.

Client first name: ${(s.cn || "").split(" ")[0]}
Add-on findings: ${addonNotes || "None"}
Property: ${s.addr || ""}`);
      setAiAddonResult(text);
    } catch(e) { setAiAddonResult("Error: " + e.message); }
    setAiAddonLoading(false);
  };

  // ── YOUTUBE: background upload, no naming prompt, no description ──────
  useEffect(() => {
    mountedRef.current = true; stopIdRef.current = s.id;
    return () => { mountedRef.current = false; };
  }, [s.id]);

  const uploadToYouTube = async (file, title) => {
    if (!file || !title) return;
    if (mountedRef.current) setYtUploadCount(n => n + 1);
    try {
      const tokenData = JSON.parse(localStorage.getItem("mts-token") || "null");
      const tok = tokenData?.token || token;
      if (!tok) { if (mountedRef.current) setYtUploadCount(n => n - 1); return; }
      const metadata = { snippet: { title }, status: { privacyStatus: "unlisted" } };
      const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      const uploadUrl = initRes.headers.get("Location");
      if (uploadUrl) {
        const uploadRes = await fetch(uploadUrl, {
          method: "PUT", headers: { "Content-Type": file.type || "video/mp4" }, body: file,
        });
        const result = await uploadRes.json();
        if (result.id) {
          const ytUrl = `https://youtu.be/${result.id}`;
          const saved = await loadField(stopIdRef.current);
          const existing = saved.videoUrls || (saved.videoUrl ? [saved.videoUrl] : []);
          const next = { ...saved, videoUrls: [...existing, ytUrl], savedAt: Date.now() };
          primeField(stopIdRef.current, next);
          await saveField(stopIdRef.current, next).catch(() => {});
          if (mountedRef.current) setVideoUrls(prev => [...prev, ytUrl]);
        }
      }
    } catch(e) { console.warn("YouTube upload failed:", e); }
    if (mountedRef.current) setYtUploadCount(n => n - 1);
  };

  const handleYtFile = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const lastName = (s.cn || "").split(" ").pop();
      const jobPart = s.jn ? ` #${s.jn}` : "";
      const datePart = new Date().toLocaleDateString("en-US", {month:"2-digit",day:"2-digit",year:"numeric"});
      const suffix = videoUrls.length > 0 ? ` (${videoUrls.length + 1})` : "";
      uploadToYouTube(file, `${lastName}${jobPart} ${datePart}${suffix}`);
    }
    e.target.value = "";
  };

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
    <div style={{position:"fixed",inset:0,zIndex:100,background:"#0a0b10",display:"flex",flexDirection:"column",fontFamily:B,color:"#f0f4fa",overflow:"hidden"}}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",paddingTop:"max(10px,env(safe-area-inset-top))",background:"#0d0f18",borderBottom:"1px solid #1a1f2e",flexShrink:0}}>
        <button onClick={onBack} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:8,background:"transparent",border:"1px solid #252d47",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,flexShrink:0}}><IconArrowLeft size={13} color="#90a8c0"/>Route</button>
        <div style={{flex:1,minWidth:0,textAlign:"center"}}>
          <div style={{fontSize:15,fontWeight:600,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
        </div>
        <button onClick={()=>setIsRevision(!isRevision)} title="Revision" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:isRevision?"rgba(255,107,157,.15)":"transparent",border:isRevision?"1px solid rgba(255,107,157,.3)":"1px solid #252d47",cursor:"pointer",flexShrink:0}}><IconRotateCcw size={15} color={isRevision?"#FF6B9D":"#3a4a60"}/></button>
        {/* Decline — moved from bottom bar so it can't be hit when reaching for DONE */}
        {!declineConfirm ? (
          <button onClick={()=>setDeclineConfirm(true)} title="Decline lead" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:"transparent",border:"1px solid #252d47",cursor:"pointer",flexShrink:0}}><IconX size={15} color="#a06060"/></button>
        ) : (
          <button onClick={()=>{setDeclineConfirm(false);onDecline();}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"rgba(200,60,60,.2)",border:"1px solid rgba(200,60,60,.4)",color:"#FF5555",fontSize:10,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite",flexShrink:0,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Confirm?</button>
        )}
        <button onClick={onDone} style={{display:"flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:8,background:"#10B981",border:"none",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,flexShrink:0}}><IconCheckCircle size={13} color="#fff"/>DONE</button>
      </div>

      {/* ── SCROLLABLE BODY ────────────────────────────────────────────── */}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{flex:1,overflowY:"auto",paddingBottom:"max(80px,calc(70px + env(safe-area-inset-bottom)))",transform:`translateX(${swipeX}px)`,transition:swiping?"none":"transform .25s"}}>

        {cloudLoading && <div style={{padding:"12px 16px",background:"rgba(59,130,246,.06)",borderBottom:"1px solid rgba(59,130,246,.1)",fontSize:12,color:"#5a8ab0",display:"flex",gap:8,alignItems:"center"}}>
          <span style={{animation:"spin 1s linear infinite",display:"flex"}}><IconRefresh size={13} color="#5a8ab0"/></span> Loading from cloud...
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>}

        {swipeX < -30 && <div style={{position:"fixed",top:"50%",right:12,transform:"translateY(-50%)",padding:"10px 14px",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.3)",color:"#10B981",fontSize:12,fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",opacity:Math.min(Math.abs(swipeX)/120,1),zIndex:102}}>→ PIPELINE</div>}

        {/* Address + contact */}
        <div style={{padding:"10px 16px",background:"#0d0f18",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:12,color:"#96a2b4",fontFamily:F,textTransform:"uppercase",letterSpacing:1}}>{s.addr}</div>
          <div style={{fontSize:11,color:"#4a5a70",marginTop:2}}>
            {s.window && <span style={{marginRight:8}}>{s.window}</span>}
            {s.jn && <span>#{s.jn}</span>}
            {s.constraint && <span style={{marginLeft:8,color:"#FF80AB"}}>{s.constraint}</span>}
          </div>
          <div style={{display:"flex",gap:12,marginTop:6,flexWrap:"wrap"}}>
            {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{fontSize:12,color:"#a0b8d0",textDecoration:"none",display:"flex",alignItems:"center",gap:4}}><IconPhone size={12} color="#a0b8d0"/>{s.phone}</a>}
            {s.email && <a href={`mailto:${s.email}`} style={{fontSize:12,color:"#a0b8d0",textDecoration:"none",display:"flex",alignItems:"center",gap:4}}><IconMail size={12} color="#a0b8d0"/>{s.email}</a>}
          </div>
        </div>

        {/* ── JOB NOTES (collapsible) ────────────────────────────────── */}
        {s.notes && (
          <div style={{borderBottom:"1px solid #1a2030"}}>
            <button onClick={()=>setJobNotesOpen(!jobNotesOpen)} style={{width:"100%",padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:jobNotesOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7,color:"#4a5a70"}}>▶</span>
              <span style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F}}>JOB NOTES</span>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#3a4a60" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
            {jobNotesOpen && <div style={{padding:"0 16px 12px",fontSize:13,color:"#8898a8",lineHeight:1.6}}>{s.notes}</div>}
          </div>
        )}

        {/* ── SCOPE ────────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#3B82F6",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,marginBottom:8}}>SCOPE</div>
          <textarea value={scopeNotes} onChange={e => setScopeNotes(e.target.value)} placeholder="Equipment, treatments, what you're quoting..." rows={6}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none"}}  onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />

          {/* Scope photos */}
          {scopePhotos.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
            {scopePhotos.map((p, i) => (
              <div key={i} style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                <img src={p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("scope");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                <button onClick={e=>{e.stopPropagation();removeScopePhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                  <div onClick={()=>{setMarkupIdx(i);setMarkupSection("scope");}} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                  <a href={p.dataUrl} download={`scope_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={11} color="#ccc"/></a>
                </div>
              </div>
            ))}
          </div>}
          <input ref={scopeLibRef} type="file" accept="image/*" multiple onChange={handleScopePhotos} style={{display:"none"}} />
          <div style={{display:"flex",gap:6,marginTop:8}}>
            <button onClick={()=>{setCameraSection("scope");setShowCamera(true);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconCamera size={16} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Camera</span>
            </button>
            <button onClick={()=>scopeLibRef.current?.click()} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconImage size={16} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Library</span>
            </button>
          </div>

          {/* AI Scope Summary */}
          <button onClick={generateScopeSummary} disabled={aiScopeLoading || !scopeNotes.trim()} style={{width:"100%",marginTop:8,padding:"10px 12px",borderRadius:8,background:aiScopeLoading?"rgba(59,130,246,.08)":scopeNotes.trim()?"rgba(59,130,246,.12)":"transparent",border:`1px solid ${scopeNotes.trim()?"rgba(59,130,246,.3)":"#1a2030"}`,color:scopeNotes.trim()?"#3B82F6":"#2a3050",fontSize:12,fontWeight:700,cursor:aiScopeLoading?"default":scopeNotes.trim()?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
            <IconSparkles size={14} color={scopeNotes.trim()?"#3B82F6":"#2a3050"}/>
            {aiScopeLoading ? "Generating..." : aiScopeResult ? "Regenerate Summary" : "Generate Summary"}
          </button>
          {aiScopeResult && <div style={{marginTop:8,padding:"10px 12px",borderRadius:8,background:"rgba(59,130,246,.04)",border:"1px solid rgba(59,130,246,.15)"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <span style={{fontSize:10,fontWeight:700,color:"#3B82F6",letterSpacing:1,textTransform:"uppercase",fontFamily:F,flex:1}}>AI Summary</span>
              <button onClick={()=>{navigator.clipboard?.writeText(aiScopeResult).catch(()=>{});}} style={{padding:"3px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:10,fontWeight:700,cursor:"pointer"}}>Copy</button>
              <button onClick={()=>setAiScopeResult("")} style={{padding:"3px 6px",borderRadius:5,background:"transparent",border:"1px solid #1a2030",color:"#4a5a70",cursor:"pointer",display:"flex",alignItems:"center"}}><IconX size={10} color="#4a5a70"/></button>
            </div>
            <textarea value={aiScopeResult} onChange={e=>setAiScopeResult(e.target.value)} rows={6} style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:6,background:"rgba(255,255,255,.02)",border:"1px solid rgba(59,130,246,.15)",color:"#a0b8d0",fontSize:13,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none"}} />
          </div>}
        </div>

        {/* ── ADD-ON ──────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#FF8A65",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,marginBottom:8}}>ADD-ON</div>
          <textarea value={addonNotes} onChange={e => setAddonNotes(e.target.value)} placeholder="Additional findings — box tree moth, dead limb over driveway, etc..." rows={3}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none"}}  onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />

          {/* Add-on photos */}
          {addonPhotos.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
            {addonPhotos.map((p, i) => (
              <div key={i} style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                <img src={p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("addon");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                <button onClick={e=>{e.stopPropagation();removeAddonPhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                  <div onClick={()=>{setMarkupIdx(i);setMarkupSection("addon");}} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                  <a href={p.dataUrl} download={`addon_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={11} color="#ccc"/></a>
                </div>
              </div>
            ))}
          </div>}
          <input ref={addonLibRef} type="file" accept="image/*" multiple onChange={handleAddonPhotos} style={{display:"none"}} />
          <div style={{display:"flex",gap:6,marginTop:8}}>
            <button onClick={()=>{setCameraSection("addon");setShowCamera(true);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconCamera size={16} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Camera</span>
            </button>
            <button onClick={()=>addonLibRef.current?.click()} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconImage size={16} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Library</span>
            </button>
          </div>

          {/* AI Add-On Email */}
          <button onClick={generateAddonEmail} disabled={aiAddonLoading || !addonNotes.trim()} style={{width:"100%",marginTop:8,padding:"10px 12px",borderRadius:8,background:aiAddonLoading?"rgba(255,138,101,.08)":addonNotes.trim()?"rgba(255,138,101,.12)":"transparent",border:`1px solid ${addonNotes.trim()?"rgba(255,138,101,.3)":"#1a2030"}`,color:addonNotes.trim()?"#FF8A65":"#2a3050",fontSize:12,fontWeight:700,cursor:aiAddonLoading?"default":addonNotes.trim()?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
            <IconSparkles size={14} color={addonNotes.trim()?"#FF8A65":"#2a3050"}/>
            {aiAddonLoading ? "Generating..." : aiAddonResult ? "Regenerate Email" : "Generate Email"}
          </button>
          {aiAddonResult && <div style={{marginTop:8,padding:"10px 12px",borderRadius:8,background:"rgba(255,138,101,.04)",border:"1px solid rgba(255,138,101,.15)"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <span style={{fontSize:10,fontWeight:700,color:"#FF8A65",letterSpacing:1,textTransform:"uppercase",fontFamily:F,flex:1}}>AI Follow-up Email</span>
              <button onClick={()=>{
                const subject = `Additional findings from your estimate — Monster Tree Service`;
                const emailTo = s.email || "";
                window.open(`mailto:${emailTo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(aiAddonResult)}`, "_self");
              }} style={{padding:"3px 8px",borderRadius:5,background:"rgba(255,138,101,.08)",border:"1px solid rgba(255,138,101,.25)",color:"#FF8A65",fontSize:10,fontWeight:700,cursor:"pointer"}}>Send</button>
              <button onClick={()=>{navigator.clipboard?.writeText(aiAddonResult).catch(()=>{});}} style={{padding:"3px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:10,fontWeight:700,cursor:"pointer"}}>Copy</button>
              <button onClick={()=>setAiAddonResult("")} style={{padding:"3px 6px",borderRadius:5,background:"transparent",border:"1px solid #1a2030",color:"#4a5a70",cursor:"pointer",display:"flex",alignItems:"center"}}><IconX size={10} color="#4a5a70"/></button>
            </div>
            <textarea value={aiAddonResult} onChange={e=>setAiAddonResult(e.target.value)} rows={8} style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:6,background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,138,101,.15)",color:"#c8b0a0",fontSize:13,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none"}} />
          </div>}
        </div>

        {/* ── VOICE MEMO ──────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {!recording ? (
              <button onClick={startRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:8,background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.25)",color:"#FF3B30",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                <span style={{width:10,height:10,borderRadius:5,background:"#FF3B30",display:"inline-block"}}/>Record
              </button>
            ) : (
              <button onClick={stopRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 16px",borderRadius:8,background:"rgba(255,59,48,.2)",border:"1px solid rgba(255,59,48,.4)",color:"#FF3B30",fontSize:12,fontWeight:700,cursor:"pointer",animation:"pulse 1s infinite"}}>
                <span style={{width:10,height:10,borderRadius:2,background:"#FF3B30",display:"inline-block"}}/>Stop · {fmtDur(recDuration)}
              </button>
            )}
          </div>
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
          {audioClips.length > 0 && <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
            {audioClips.map((clip, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540"}}>
                <button onClick={() => playAudio(i)} style={{width:28,height:28,borderRadius:14,background:playingIdx===i?"rgba(255,59,48,.15)":"rgba(59,130,246,.1)",border:"none",color:playingIdx===i?"#FF3B30":"#3B82F6",fontSize:12,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{playingIdx===i?"■":"▶"}</button>
                <div style={{flex:1,fontSize:11,color:"#6a7a90"}}>Memo · {clip.duration ? fmtDur(clip.duration) : "—"}</div>
                <button onClick={() => removeAudio(i)} style={{padding:"3px 8px",borderRadius:6,background:"rgba(200,60,60,.1)",border:"1px solid rgba(200,60,60,.2)",color:"#e06060",fontSize:10,fontWeight:700,cursor:"pointer"}}><IconX size={12} /></button>
              </div>
            ))}
          </div>}
        </div>

        {/* ── VIDEO ─────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>VIDEO{ytUploadCount > 0 && <span style={{fontSize:9,color:"#F6BF26",fontWeight:700,padding:"1px 8px",borderRadius:10,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.2)",marginLeft:6}}>↑ Uploading…</span>}</div>

          {/* Title rename modal */}

          {/* Uploaded videos list */}
          {videoUrls.length > 0 && <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
            {videoUrls.map((url, idx) => {
              const vid = getYtId(url);
              return (
                <div key={idx} style={{borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",overflow:"hidden"}}>
                  {vid && <img src={`https://img.youtube.com/vi/${vid}/mqdefault.jpg`} alt="" style={{width:"100%",height:90,objectFit:"cover"}} />}
                  <div style={{padding:"6px 8px",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{fontSize:9,color:"#5a6890",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{url}</div>
                    <button onClick={() => {
                      const html = `<a href="${url}">Link to Video Review</a>`;
                      if (navigator.clipboard?.write) {
                        navigator.clipboard.write([new ClipboardItem({
                          "text/html": new Blob([html], {type:"text/html"}),
                          "text/plain": new Blob([url], {type:"text/plain"}),
                        })]).catch(()=>navigator.clipboard?.writeText(url));
                      } else { navigator.clipboard?.writeText(url); }
                    }} style={{padding:"4px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#5a90b0",fontSize:10,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>Copy link</button>
                    {/* DELETE — removes from app AND from YouTube */}
                    <button onClick={() => deleteYouTubeVideo(url, idx)} style={{padding:"4px 6px",borderRadius:5,background:"rgba(200,60,60,.08)",border:"1px solid rgba(200,60,60,.15)",color:"#e06060",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}>
                      <IconX size={10} color="#e06060" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>}

          {/* Upload button — always visible */}
          <input ref={ytFileRef} type="file" accept="video/*" onChange={handleYtFile} style={{display:"none"}} />
          <button onClick={() => ytFileRef.current?.click()} style={{width:"100%",padding:"10px 0",borderRadius:8,background:"rgba(255,0,0,.06)",border:"1px dashed rgba(255,0,0,.2)",color:"#cc4040",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <IconYoutube size={14} color="#cc4040"/><span>{videoUrls.length > 0 ? `Add another video (${videoUrls.length + 1})` : "Upload video"}</span>
          </button>
        </div>

      </div>

      {/* ── STICKY BOTTOM BAR ──────────────────────────────────────── */}
      <div style={{flexShrink:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#0d0f18",borderTop:"1px solid #1a1f2e",display:"flex",gap:8,zIndex:101}}>
        {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}><IconPhone size={18} color="#a0b8d0"/></a>}
        {s.phone && <button onClick={() => window.open(`sms:${s.phone.replace(/\D/g,"")}`,"_self")} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={18} color="#a0b8d0"/></button>}
        {s.addr && <button onClick={() => { window.location.href = `comgooglemaps://?daddr=${encodeURIComponent(s.addr)}&directionsmode=driving`; }} style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconNavigation size={18} color="#3B82F6"/></button>}
        <button onClick={onDone} style={{flex:3,padding:"12px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconCheckCircle size={18} color="#10B981"/><span style={{fontSize:13,color:"#10B981",fontWeight:800,fontFamily:F,letterSpacing:0.5}}>DONE</span></button>
      </div>
    </div>
  );
}
