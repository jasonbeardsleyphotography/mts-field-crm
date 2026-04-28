import { useState, useEffect, useRef } from "react";
import PhotoMarkup from "./PhotoMarkup";
import CameraView from "./CameraView";
import { saveFieldToDrive, loadFieldFromDrive } from "./driveSync";
import { loadField, saveField, peekField, primeField } from "./fieldStore";
import { incUpload, decUpload } from "./uploadStatus";
import { markStopForPhotoSync } from "./photoSync";
import {
  enqueueVideo,
  listForStop as listVideoQueueForStop,
  onQueueChange as onVideoQueueChange,
  forceUploadNow as forceVideoUploadNow,
  cancelQueueItem as cancelVideoQueueItem,
  retryQueueItem as retryVideoQueueItem,
  getUploadMode as getVideoUploadMode,
  setUploadMode as setVideoUploadMode,
  isWifi,
} from "./videoQueue";
import { IconArrowLeft, IconRefresh, IconCamera, IconImage, IconDownload, IconPen, IconEraser, IconMic, IconVolume2, IconSparkles, IconYoutube, IconMail, IconX, IconZap, IconClipboard, IconPhone, IconMessageSquare, IconNavigation, IconCheckCircle, IconRotateCcw, IconSend } from "./icons";

const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Onsite Window
   Full-screen data capture for a client stop. Opens via swipe-right.
   Saves continuously to IndexedDB (via fieldStore). "← Route" returns
   without marking done. "Done →" moves card to pipeline.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function OnsiteWindow({ stop, onBack, onDone, onDecline, onMarkReject, token }) {
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
  const [speechField, setSpeechField] = useState(null); // "scope" | "addon" | null
  const recognitionRef = useRef(null);
  const keepListeningRef = useRef(false); // controls iOS auto-restart

  const [aiScopeResult, setAiScopeResult] = useState(fd.aiScopeSummary || "");
  const [aiAddonResult, setAiAddonResult] = useState(fd.aiAddonEmail || "");
  const [aiScopeLoading, setAiScopeLoading] = useState(false);
  const [aiAddonLoading, setAiAddonLoading] = useState(false);
  const [declineConfirm, setDeclineConfirm] = useState(false);
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [jobNotesOpen, setJobNotesOpen] = useState(false);
  const [isRevision, setIsRevision] = useState(false);
  // Prior visit notes — loaded once on mount, shown only when isRevision is true
  const [priorVisit, setPriorVisit] = useState(null);
  const [priorVisitOpen, setPriorVisitOpen] = useState(false);
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

  // ── PRIOR VISIT NOTES ────────────────────────────────────────────────
  // Snapshot the field data that existed at the time OnsiteWindow mounts.
  // Stored in a ref so it doesn't update mid-session as the user edits.
  // Only shown when isRevision === true.
  useEffect(() => {
    loadField(s.id).then(data => {
      if (!data || Object.keys(data).length === 0) return;
      const scope = data.scopeNotes || data.myNotes || "";
      const addon = data.addonNotes || "";
      if (scope || addon) setPriorVisit({ scopeNotes: scope, addonNotes: addon });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);

  // ── PHOTO HANDLING ──────────────────────────────────────────────────
  // processPhoto delegates to the module-level _processPhoto so that photo
  // processing (FileReader + canvas resize) continues even if the user taps
  // Done before the async work completes. The photo is saved to IndexedDB
  // regardless; UI state is only updated if the component is still mounted.
  const processPhoto = (file, section = "scope") => {
    if (!file) return;
    _processPhoto(file, section, s.id).then(photo => {
      if (!photo || !mountedRef.current) return;
      if (section === "addon") setAddonPhotos(prev => [...prev, photo]);
      else setScopePhotos(prev => [...prev, photo]);
    });
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
    // Clear the Drive URL so the freshly-edited version shows immediately,
    // then re-queue this stop so the edited photo gets re-uploaded to Drive.
    const update = (p, i) => i === markupIdx ? { ...p, dataUrl, url: undefined } : p;
    if (markupSection === "addon") setAddonPhotos(prev => prev.map(update));
    else setScopePhotos(prev => prev.map(update));
    markStopForPhotoSync(s.id);
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
          setAudioClips(prev => [...prev, { dataUrl: reader.result, ts: Date.now(), duration: recDuration, size: blob.size }]);
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

  // ── SPEECH-TO-TEXT ──────────────────────────────────────────────────
  // iOS Safari does NOT support r.continuous = true — it silently stops
  // after the first phrase and fires onend. We work around this by auto-
  // restarting recognition (with a fresh instance) whenever onend fires
  // while keepListeningRef is still true. Desktop Chrome supports true
  // continuous, but the restart approach works there too.
  const toggleSpeech = (field) => {
    if (speechField === field) {
      keepListeningRef.current = false;
      recognitionRef.current?.stop();
      setSpeechField(null);
      return;
    }
    keepListeningRef.current = false;
    recognitionRef.current?.abort();

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition isn't supported in this browser.\n\niPhone: use Safari.\nAndroid: use Chrome.\nDesktop: use Chrome or Edge.");
      return;
    }

    const base = (field === "scope" ? scopeNotes : addonNotes);
    const prefix = base && !base.endsWith(" ") ? base + " " : base;
    let accumulated = ""; // persists across restart cycles

    const startListening = () => {
      const r = new SR();
      r.continuous = false;      // iOS ignores true; restart-on-end handles continuous feel
      r.interimResults = true;
      r.lang = "en-US";

      r.onresult = (e) => {
        let finals = "";
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            finals += e.results[i][0].transcript + " ";
            accumulated += e.results[i][0].transcript + " ";
          } else {
            interim += e.results[i][0].transcript;
          }
        }
        if (field === "scope") setScopeNotes(prefix + accumulated + interim);
        else setAddonNotes(prefix + accumulated + interim);
      };

      r.onerror = (evt) => {
        if (evt.error === "not-allowed") {
          keepListeningRef.current = false;
          alert("Microphone access denied.\n\niPhone: Settings → Safari → Microphone → Allow.\nDesktop: tap the lock icon in the address bar.");
          setSpeechField(null);
        } else if (evt.error === "audio-capture") {
          keepListeningRef.current = false;
          alert("No microphone detected. Check your device settings.");
          setSpeechField(null);
        }
        // 'no-speech', 'network', 'aborted': let onend handle restart
      };

      r.onend = () => {
        if (keepListeningRef.current) {
          // Auto-restart: gives iOS continuous-feel without needing r.continuous
          setTimeout(() => {
            if (keepListeningRef.current) {
              try { startListening(); }
              catch {
                keepListeningRef.current = false;
                if (field === "scope") setScopeNotes(prefix + accumulated);
                else setAddonNotes(prefix + accumulated);
                setSpeechField(null);
              }
            }
          }, 80); // small gap prevents iOS "already started" error
        } else {
          // User tapped stop — commit final text
          if (field === "scope") setScopeNotes(prefix + accumulated);
          else setAddonNotes(prefix + accumulated);
          setSpeechField(null);
        }
      };

      recognitionRef.current = r;
      try { r.start(); }
      catch {
        keepListeningRef.current = false;
        setSpeechField(null);
      }
    };

    keepListeningRef.current = true;
    setSpeechField(field);
    startListening();
  };

  // ── YOUTUBE: track mount status for safe state updates after async ops ──
  // IMPORTANT: this hook MUST stay above the early returns (showCamera / markupIdx)
  // so React sees the same hook order on every render.
  useEffect(() => {
    mountedRef.current = true; stopIdRef.current = s.id;
    return () => { mountedRef.current = false; };
  }, [s.id]);

  // ── MARKUP OVERLAY ──────────────────────────────────────────────────
  // Camera view — rapid capture mode
  if (showCamera) {
    return <CameraView
      onPhoto={(dataUrl) => {
        const photo = { dataUrl, ts: Date.now() };
        if (cameraSection === "addon") setAddonPhotos(prev => [...prev, photo]);
        else setScopePhotos(prev => [...prev, photo]);
        markStopForPhotoSync(s.id); // queue for Drive upload
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

  // ── YOUTUBE: enqueue for background upload via videoQueue ──────────────
  // The actual upload (compress → chunked PUT to YouTube) runs entirely
  // inside videoQueue.js, persisted to its own IndexedDB store. By the
  // time enqueueVideo() resolves the file is safely written to IDB and
  // will upload on the next opportunity (WiFi by default), even if the
  // app is closed and reopened. This is what fixes the 6-hour upload
  // problem — the upload doesn't depend on this component being mounted.

  // Live queue items for this stop (what's currently uploading/pending)
  const [videoQueueItems, setVideoQueueItems] = useState([]);
  const [uploadMode, setUploadModeState] = useState(getVideoUploadMode());
  const [showQueuePanel, setShowQueuePanel] = useState(false);

  useEffect(() => {
    let alive = true;
    listVideoQueueForStop(s.id).then(items => { if (alive) setVideoQueueItems(items); });
    const off = onVideoQueueChange((all) => {
      if (alive) setVideoQueueItems(all.filter(i => i.stopId === s.id));
    });
    return () => { alive = false; off(); };
  }, [s.id]);

  // When the queue produces a YouTube URL, fieldStore is updated and a
  // "mts-field-synced" event is dispatched. Re-pull videoUrls from IDB.
  useEffect(() => {
    const handler = async () => {
      try {
        const fd = await loadField(s.id);
        if (fd && mountedRef.current) {
          if (fd.videoUrls) setVideoUrls(fd.videoUrls);
          else if (fd.videoUrl) setVideoUrls([fd.videoUrl]);
        }
      } catch {}
    };
    window.addEventListener("mts-field-synced", handler);
    return () => window.removeEventListener("mts-field-synced", handler);
  }, [s.id]);

  const handleYtFile = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const lastName = (s.cn || "").split(" ").pop();
      const jobPart = s.jn ? ` #${s.jn}` : "";
      const datePart = new Date().toLocaleDateString("en-US", {month:"2-digit",day:"2-digit",year:"numeric"});
      // Sequence number = existing uploaded videos + already-queued videos + this one
      const totalCount = videoUrls.length + videoQueueItems.length + 1;
      const seqNum = String(totalCount).padStart(2, "0");
      const title = `${lastName}${jobPart} ${datePart} - ${seqNum}`;
      try {
        await enqueueVideo({ stopId: s.id, file, title });
      } catch (err) {
        console.warn("Failed to enqueue video:", err);
        alert("Failed to queue video: " + (err.message || err));
      }
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

  // ── RENDER ────────────────────────────────────────────────────────────
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
        {/* Mark to Reject in SingleOps — sends to pipeline with orange warning flag */}
        {onMarkReject && (!rejectConfirm ? (
          <button onClick={()=>setRejectConfirm(true)} title="Flag: reject in SingleOps" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:"transparent",border:"1px solid #3a2810",cursor:"pointer",flexShrink:0}}>
            <span style={{fontSize:13}}>🚫</span>
          </button>
        ) : (
          <button onClick={()=>{setRejectConfirm(false);onMarkReject();}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"rgba(255,140,0,.25)",border:"1px solid rgba(255,140,0,.5)",color:"#FF8C00",fontSize:9,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite",flexShrink:0,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>🚫 REJECT?</button>
        ))}
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

        {/* ── JOB NOTES (collapsible, always shows preview) ─────────── */}
        {s.notes && (
          <div style={{borderBottom:"1px solid #1a2030"}}>
            <button onClick={()=>setJobNotesOpen(!jobNotesOpen)} style={{width:"100%",padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:jobNotesOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7,color:"#4a5a70"}}>▶</span>
              <span style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F}}>JOB NOTES</span>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#3a4a60" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              {!jobNotesOpen && <span style={{flex:1,fontSize:12,color:"#8898a8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginLeft:4}}>{s.notes.length > 80 ? s.notes.slice(0,80) + "…" : s.notes}</span>}
            </button>
            {jobNotesOpen && <div style={{padding:"0 16px 12px",fontSize:13,color:"#8898a8",lineHeight:1.6}}>{s.notes}</div>}
          </div>
        )}

        {/* ── NOTES FROM LAST VISIT (revision mode only) ───────────────── */}
        {isRevision && priorVisit && (priorVisit.scopeNotes || priorVisit.addonNotes) && (
          <div style={{borderBottom:"1px solid #1a2030",background:"rgba(255,107,157,.03)"}}>
            <button onClick={()=>setPriorVisitOpen(!priorVisitOpen)} style={{width:"100%",padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:priorVisitOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7,color:"#FF6B9D"}}>▶</span>
              <span style={{fontSize:10,fontWeight:700,color:"#FF6B9D",letterSpacing:1,textTransform:"uppercase",fontFamily:F}}>Notes from last visit</span>
              {!priorVisitOpen && <span style={{flex:1,fontSize:12,color:"#a07080",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginLeft:4}}>{(priorVisit.scopeNotes || priorVisit.addonNotes || "").slice(0,80)}{(priorVisit.scopeNotes || priorVisit.addonNotes || "").length > 80 ? "…" : ""}</span>}
            </button>
            {priorVisitOpen && (
              <div style={{padding:"0 16px 12px",display:"flex",flexDirection:"column",gap:10}}>
                {priorVisit.scopeNotes && (
                  <div>
                    <div style={{fontSize:9,fontWeight:700,color:"#FF6B9D",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>Scope</div>
                    <div style={{fontSize:13,color:"#8898a8",lineHeight:1.6,padding:"8px 10px",borderRadius:8,background:"#0e1020",border:"1px solid #1a2035"}}>{priorVisit.scopeNotes}</div>
                  </div>
                )}
                {priorVisit.addonNotes && (
                  <div>
                    <div style={{fontSize:9,fontWeight:700,color:"#FF8A65",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>Add-on</div>
                    <div style={{fontSize:13,color:"#8898a8",lineHeight:1.6,padding:"8px 10px",borderRadius:8,background:"#0e1020",border:"1px solid #1a2035"}}>{priorVisit.addonNotes}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── SCOPE ────────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#3B82F6",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F}}>SCOPE</div>
            <button onClick={() => toggleSpeech("scope")} style={{display:"flex",alignItems:"center",gap:4,padding:"5px 10px",borderRadius:7,background:speechField==="scope"?"rgba(255,59,48,.15)":"rgba(59,130,246,.08)",border:`1px solid ${speechField==="scope"?"rgba(255,59,48,.35)":"rgba(59,130,246,.2)"}`,color:speechField==="scope"?"#FF3B30":"#4a80c0",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
              <IconMic size={12} color={speechField==="scope"?"#FF3B30":"#4a80c0"}/>
              {speechField==="scope" ? <>■ Stop{<span style={{animation:"pulse 1s infinite",display:"inline-block",width:5,height:5,borderRadius:3,background:"#FF3B30",marginLeft:3}}/>}</> : "Dictate"}
            </button>
          </div>
          <textarea value={scopeNotes} onChange={e => setScopeNotes(e.target.value)} placeholder="Scope of work..." rows={6}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1120",border:`1px solid ${speechField==="scope"?"rgba(59,130,246,.5)":"#1a2540"}`,color:"#e0e8f0",fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none",transition:"border-color .15s"}} onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />

          {/* Scope photos */}
          {scopePhotos.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
            {scopePhotos.map((p, i) => (
              <div key={i} style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                <img src={p.url || p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("scope");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                <button onClick={e=>{e.stopPropagation();removeScopePhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                  <div onClick={()=>{setMarkupIdx(i);setMarkupSection("scope");}} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                  <a href={p.url || p.dataUrl} download={`scope_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={11} color="#ccc"/></a>
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
        </div>

        {/* ── ADD-ON ──────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#FF8A65",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F}}>ADD-ON</div>
            <button onClick={() => toggleSpeech("addon")} style={{display:"flex",alignItems:"center",gap:4,padding:"5px 10px",borderRadius:7,background:speechField==="addon"?"rgba(255,59,48,.15)":"rgba(255,138,101,.08)",border:`1px solid ${speechField==="addon"?"rgba(255,59,48,.35)":"rgba(255,138,101,.2)"}`,color:speechField==="addon"?"#FF3B30":"#c07040",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
              <IconMic size={12} color={speechField==="addon"?"#FF3B30":"#c07040"}/>
              {speechField==="addon" ? <>■ Stop{<span style={{animation:"pulse 1s infinite",display:"inline-block",width:5,height:5,borderRadius:3,background:"#FF3B30",marginLeft:3}}/>}</> : "Dictate"}
            </button>
          </div>
          <textarea value={addonNotes} onChange={e => setAddonNotes(e.target.value)} placeholder="Additional recommendations..." rows={3}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1120",border:`1px solid ${speechField==="addon"?"rgba(255,138,101,.5)":"#1a2540"}`,color:"#e0e8f0",fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none",transition:"border-color .15s"}} onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />

          {/* Add-on photos */}
          {addonPhotos.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
            {addonPhotos.map((p, i) => (
              <div key={i} style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                <img src={p.url || p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("addon");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                <button onClick={e=>{e.stopPropagation();removeAddonPhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                  <div onClick={()=>{setMarkupIdx(i);setMarkupSection("addon");}} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                  <a href={p.url || p.dataUrl} download={`addon_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"4px 8px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={11} color="#ccc"/></a>
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
        </div>

        {/* ── VIDEO ─────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>VIDEO{(ytUploadCount > 0 || videoQueueItems.length > 0) && <span style={{fontSize:9,color:"#F6BF26",fontWeight:700,padding:"1px 8px",borderRadius:10,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.2)",marginLeft:6,animation:"pulse 1s infinite"}}>↑ {videoQueueItems.length || ytUploadCount} pending</span>}</div>

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
                    <button onClick={() => deleteYouTubeVideo(url, idx)} style={{padding:"4px 6px",borderRadius:5,background:"rgba(200,60,60,.08)",border:"1px solid rgba(200,60,60,.15)",color:"#e06060",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}>
                      <IconX size={10} color="#e06060" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>}

          {/* ── QUEUED / IN-PROGRESS UPLOADS ──────────────────────────── */}
          {videoQueueItems.length > 0 && <div style={{marginBottom:8,borderRadius:8,background:"rgba(246,191,38,.04)",border:"1px solid rgba(246,191,38,.15)",overflow:"hidden"}}>
            <div style={{padding:"6px 10px",display:"flex",alignItems:"center",gap:6,background:"rgba(246,191,38,.06)",borderBottom:"1px solid rgba(246,191,38,.1)"}}>
              <span style={{fontSize:9,color:"#F6BF26",fontWeight:800,fontFamily:F,letterSpacing:0.6,textTransform:"uppercase",flex:1}}>
                {videoQueueItems.length} pending • {uploadMode === "wifi" ? "WiFi only" : uploadMode === "always" ? "Auto upload" : "WiFi + on-demand"}
              </span>
              <button onClick={() => setShowQueuePanel(v=>!v)} style={{padding:"2px 8px",borderRadius:5,background:"transparent",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5}}>
                {showQueuePanel ? "HIDE" : "SHOW"}
              </button>
            </div>
            {showQueuePanel && <>
              {/* Mode toggle row */}
              <div style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:6,borderBottom:"1px solid rgba(246,191,38,.1)"}}>
                <span style={{fontSize:9,color:"#7a7050",fontWeight:600,fontFamily:F,letterSpacing:0.4,textTransform:"uppercase"}}>Mode:</span>
                {[["wifi","WiFi only"],["hybrid","Hybrid"],["always","Always"]].map(([m,lbl]) => (
                  <button key={m} onClick={() => { setVideoUploadMode(m); setUploadModeState(m); }} style={{padding:"3px 8px",borderRadius:5,background:uploadMode===m?"rgba(246,191,38,.15)":"transparent",border:`1px solid ${uploadMode===m?"rgba(246,191,38,.4)":"#252d47"}`,color:uploadMode===m?"#F6BF26":"#5a6580",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>{lbl}</button>
                ))}
              </div>
              {videoQueueItems.map(it => {
                const sizeMB = ((it.compressedSize || it.originalSize) / (1024*1024)).toFixed(1);
                const origMB = (it.originalSize / (1024*1024)).toFixed(0);
                const statusColor = it.status === "error" ? "#FF5555" : it.status === "uploading" ? "#10B981" : it.status === "compressing" ? "#5a90b0" : "#7a7050";
                const statusLabel =
                  it.status === "queued" ? "Waiting…" :
                  it.status === "compressing" ? `Compressing ${it.progress||0}%` :
                  it.status === "ready" ? "Ready" :
                  it.status === "uploading" ? `Uploading ${it.progress||0}%` :
                  it.status === "error" ? "Failed" :
                  it.status === "paused" ? "Paused" : it.status;
                return (
                  <div key={it.id} style={{padding:"8px 10px",borderTop:"1px solid rgba(246,191,38,.06)"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <div style={{flex:1,minWidth:0,fontSize:11,color:"#c0c8d0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.title}</div>
                      <span style={{fontSize:9,color:statusColor,fontWeight:800,fontFamily:F,letterSpacing:0.4,textTransform:"uppercase",flexShrink:0}}>{statusLabel}</span>
                    </div>
                    {/* Progress bar */}
                    <div style={{height:3,background:"rgba(255,255,255,.05)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
                      <div style={{height:"100%",width:`${it.progress||0}%`,background:statusColor,transition:"width .3s"}}/>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{flex:1,fontSize:9,color:"#5a6580",fontFamily:F,letterSpacing:0.3}}>
                        {it.compressedSize ? `${origMB}MB → ${sizeMB}MB` : `${origMB}MB`}
                      </div>
                      {(it.status === "queued" || it.status === "ready") && uploadMode !== "always" && !it.forceNow && (
                        <button onClick={() => forceVideoUploadNow(it.id)} style={{padding:"3px 8px",borderRadius:5,background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.25)",color:"#10B981",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Upload now</button>
                      )}
                      {it.status === "error" && (
                        <button onClick={() => retryVideoQueueItem(it.id)} style={{padding:"3px 8px",borderRadius:5,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Retry</button>
                      )}
                      <button onClick={() => { if(window.confirm("Cancel and remove this video from the queue?")) cancelVideoQueueItem(it.id); }} style={{padding:"3px 6px",borderRadius:5,background:"transparent",border:"1px solid #252d47",color:"#a06060",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,display:"flex",alignItems:"center"}}>
                        <IconX size={10} color="#a06060"/>
                      </button>
                    </div>
                    {it.error && <div style={{fontSize:9,color:"#FF8888",marginTop:3,fontFamily:F}}>{it.error}</div>}
                  </div>
                );
              })}
            </>}
          </div>}

          {/* Upload button — brighter red to stand out */}
          <input ref={ytFileRef} type="file" accept="video/*" onChange={handleYtFile} style={{display:"none"}} />
          <button onClick={() => ytFileRef.current?.click()} style={{width:"100%",padding:"11px 0",borderRadius:8,background:"rgba(255,0,0,.12)",border:"1px solid rgba(255,0,0,.4)",color:"#ff4040",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <IconYoutube size={15} color="#ff4040"/><span>{(videoUrls.length + videoQueueItems.length) > 0 ? `Add another video (${videoUrls.length + videoQueueItems.length + 1})` : "Upload video to YouTube"}</span>
          </button>
        </div>

        {/* ── VOICE MEMO ──────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{fontSize:10,fontWeight:600,color:"#3a4860",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:6}}>VOICE MEMO</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {!recording ? (
              <button onClick={startRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,background:"rgba(255,59,48,.04)",border:"1px solid rgba(255,59,48,.15)",color:"#8a5050",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                <span style={{width:8,height:8,borderRadius:4,background:"#8a5050",display:"inline-block"}}/>Record
              </button>
            ) : (
              <button onClick={stopRecording} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,background:"rgba(255,59,48,.15)",border:"1px solid rgba(255,59,48,.35)",color:"#FF3B30",fontSize:11,fontWeight:700,cursor:"pointer",animation:"pulse 1s infinite"}}>
                <span style={{width:8,height:8,borderRadius:2,background:"#FF3B30",display:"inline-block"}}/>Stop · {fmtDur(recDuration)}
              </button>
            )}
          </div>
          <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
          {audioClips.length > 0 && <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
            {audioClips.map((clip, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540"}}>
                <button onClick={() => playAudio(i)} style={{width:28,height:28,borderRadius:14,background:playingIdx===i?"rgba(255,59,48,.15)":"rgba(59,130,246,.1)",border:"none",color:playingIdx===i?"#FF3B30":"#3B82F6",fontSize:12,fontWeight:900,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{playingIdx===i?"■":"▶"}</button>
                <div style={{flex:1,fontSize:11,color:"#6a7a90"}}>Memo · {clip.duration ? fmtDur(clip.duration) : "—"}{clip.size ? ` · ${(clip.size/1024).toFixed(0)} KB` : ""}</div>
                <button onClick={() => removeAudio(i)} style={{padding:"3px 8px",borderRadius:6,background:"rgba(200,60,60,.1)",border:"1px solid rgba(200,60,60,.2)",color:"#e06060",fontSize:10,fontWeight:700,cursor:"pointer"}}><IconX size={12} /></button>
              </div>
            ))}
          </div>}
        </div>

      </div>

      {/* ── STICKY BOTTOM BAR ──────────────────────────────────────── */}
      <div style={{flexShrink:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#0d0f18",borderTop:"1px solid #1a1f2e",display:"flex",gap:8,zIndex:101}}>
        {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}><IconPhone size={18} color="#a0b8d0"/></a>}
        {s.phone && <button onClick={() => window.open(`sms:${s.phone.replace(/\D/g,"")}`,"_self")} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={18} color="#a0b8d0"/></button>}
        {s.addr && <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.addr)}`} target="_blank" rel="noreferrer" style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}><IconNavigation size={18} color="#3B82F6"/></a>}
        <button onClick={onDone} style={{flex:3,padding:"12px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconCheckCircle size={18} color="#10B981"/><span style={{fontSize:13,color:"#10B981",fontWeight:800,fontFamily:F,letterSpacing:0.5}}>DONE</span></button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Module-level photo processor — lives OUTSIDE React so FileReader + canvas
   work completes even if OnsiteWindow unmounts (user taps Done mid-pick).
   The photo is written to IndexedDB immediately; the component only updates
   its own state if it's still mounted when the promise resolves.
   ═══════════════════════════════════════════════════════════════════════════ */
function _processPhoto(file, section, stopId) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = async () => {
        const MAX = 2400;
        let w = img.width, h = img.height;
        if (w > MAX) { h = h * MAX / w; w = MAX; }
        if (h > MAX) { w = w * MAX / h; h = MAX; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const photo = { dataUrl: c.toDataURL("image/jpeg", 0.82), ts: Date.now() };
        // Persist to IndexedDB regardless of component mount state
        try {
          const saved = await loadField(stopId).catch(() => ({}));
          const key = section === "addon" ? "addonPhotos" : "scopePhotos";
          const existing = saved?.[key] || [];
          const next = { ...(saved || {}), [key]: [...existing, photo], savedAt: Date.now() };
          primeField(stopId, next);
          await saveField(stopId, next).catch(() => {});
          // Queue photo for Drive upload (happens in background when online)
          markStopForPhotoSync(stopId);
        } catch(e) { console.warn("Photo background save failed:", e); }
        resolve(photo);
      };
      img.onerror = () => resolve(null);
      img.src = ev.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Module-level upload helper — lives OUTSIDE the React component so the
   browser's network layer keeps the fetch alive regardless of whether
   OnsiteWindow is still mounted. The component wrapper above fires this off
   and only touches React state if still mounted when the promise resolves.
   ═══════════════════════════════════════════════════════════════════════════ */
async function _uploadToYouTube(file, title, propToken, stopId) {
  if (!file || !title) return null;
  try {
    const tokenData = JSON.parse(localStorage.getItem("mts-token") || "null");
    const tok = tokenData?.token || propToken;
    if (!tok) return null;

    // ── Determine MIME type ───────────────────────────────────────────
    // iOS Safari often leaves file.type empty for .mov (QuickTime) files.
    // Sending the wrong Content-Type causes YouTube to accept the upload
    // but fail to process it ("processing will begin shortly" forever).
    let mimeType = file.type;
    if (!mimeType) {
      const ext = (file.name || "").split(".").pop().toLowerCase();
      const MAP = { mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v",
                    avi: "video/x-msvideo", webm: "video/webm", mkv: "video/x-matroska" };
      mimeType = MAP[ext] || "video/mp4";
    }

    // ── Init resumable session ────────────────────────────────────────
    // X-Upload-Content-Type and X-Upload-Content-Length let YouTube
    // know the total size upfront, preventing truncated-upload issues.
    const metadata = { snippet: { title }, status: { privacyStatus: "unlisted" } };
    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(file.size),
        },
        body: JSON.stringify(metadata),
      }
    );
    if (!initRes.ok) {
      console.warn("YouTube upload init failed:", initRes.status);
      return null;
    }
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) return null;

    // ── Upload the file ───────────────────────────────────────────────
    // Content-Length is required for YouTube to know the upload is
    // complete and to begin processing. Without it, partial uploads
    // are accepted silently and never finish processing.
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(file.size),
      },
      body: file,
    });
    if (!uploadRes.ok && uploadRes.status !== 201) {
      console.warn("YouTube PUT failed:", uploadRes.status);
      return null;
    }
    const result = await uploadRes.json();
    if (!result.id) return null;

    const ytUrl = `https://youtu.be/${result.id}`;

    // ── Persist locally ───────────────────────────────────────────────
    const saved = await loadField(stopId).catch(() => ({}));
    const existing = saved?.videoUrls || (saved?.videoUrl ? [saved.videoUrl] : []);
    if (existing.includes(ytUrl)) return ytUrl; // deduplicate
    const next = { ...(saved || {}), videoUrls: [...existing, ytUrl], savedAt: Date.now() };
    primeField(stopId, next);
    await saveField(stopId, next).catch(() => {});

    // ── Push to Drive immediately ─────────────────────────────────────
    // Without this, the pipeline card detail loads Drive's older copy
    // (which doesn't have the new URL yet) and overwrites local data.
    saveFieldToDrive(tok, stopId, next).catch(() => {});

    return ytUrl;
  } catch (e) {
    console.warn("YouTube upload failed:", e);
    return null;
  }
}
