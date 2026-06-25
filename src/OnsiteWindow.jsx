import { useState, useEffect, useRef } from "react";
import PhotoMarkup from "./PhotoMarkup";
import CameraView from "./CameraView";
import ParcelMapView from "./ParcelMapView";
import VideoRecorder from "./VideoRecorder";
import { loadFieldFromDrive, queueFieldDriveSync } from "./driveSync";
import { loadField, peekField, primeField, mergeField, updateField, saveFieldSync, getFieldSlim, getDirtyFieldIds } from "./fieldStore";
import { loadPipeline } from "./Pipeline";
import { incUpload, decUpload } from "./uploadStatus";
import { markStopForPhotoSync } from "./photoSync";
import { downscaleDataUrl, newPhotoId, photoKey } from "./imageUtils";
import { buildShareUrl, buildStreamUrl } from "./driveUpload";

function _driveFileId(url) {
  const m = (url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
             (url || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m?.[1] || null;
}
async function _fetchPhotoBlob(p, token) {
  if (p.dataUrl) { const r = await fetch(p.dataUrl); return r.blob(); }
  const fileId = _driveFileId(p.url);
  if (fileId && token) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.blob();
  }
  const r = await fetch(p.url); if (!r.ok) throw new Error(); return r.blob();
}
async function _saveBlobAsFile(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}
import Linkify from "./Linkify";
import {
  enqueueVideo,
  listForStop as listVideoQueueForStop,
  onQueueChange as onVideoQueueChange,
  cancelItem as cancelVideoQueueItem,
  retryItem as retryVideoQueueItem,
  isPaused as isVideoQueuePaused,
  setPaused as setVideoQueuePaused,
} from "./videoQueue";
import { IconArrowLeft, IconRefresh, IconCamera, IconImage, IconDownload, IconPen, IconEraser, IconMic, IconVolume2, IconSparkles, IconVideo, IconMail, IconX, IconZap, IconClipboard, IconPhone, IconMessageSquare, IconNavigation, IconCheckCircle, IconSend, IconNoSymbol, IconMapPin } from "./icons";

const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Onsite Window
   Full-screen data capture for a client stop. Opens via swipe-right.
   Saves continuously to IndexedDB (via fieldStore). "← Route" returns
   without marking done. "Done →" moves card to pipeline.
   ═══════════════════════════════════════════════════════════════════════════ */

const ZONES = ["Front", "Back", "Tree", "Other"];
const ZONE_COLORS = { Front:"#3B82F6", Back:"#8B5CF6", Tree:"#10B981", Other:"#F6BF26" };

function PhotoZoneTag({ zone, onChange }) {
  const [open, setOpen] = useState(false);
  const col = zone ? (ZONE_COLORS[zone] || "#7a8aaa") : "#3a4a60";
  return (
    <div style={{position:"relative",width:140}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",padding:"3px 6px",borderRadius:5,background:zone?"rgba(255,255,255,.05)":"transparent",border:`1px solid ${zone?col+"40":"#1a2540"}`,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
        {zone && <div style={{width:5,height:5,borderRadius:99,background:col,flexShrink:0}}/>}
        <span style={{fontSize:9,fontWeight:700,color:zone?col:"#3a4a60",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,flex:1,textAlign:"left"}}>{zone || "Tag zone"}</span>
        <svg width={7} height={7} viewBox="0 0 24 24" fill="none" stroke={zone?col:"#3a4a60"} strokeWidth={3}><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 2px)",left:0,zIndex:10,background:"#0d1020",border:"1px solid #1a2540",borderRadius:8,padding:4,display:"flex",flexDirection:"column",gap:2,minWidth:100,boxShadow:"0 4px 16px rgba(0,0,0,.5)"}}>
          {zone && <button onClick={()=>{onChange(null);setOpen(false);}} style={{padding:"4px 8px",borderRadius:5,background:"transparent",border:"none",cursor:"pointer",textAlign:"left",fontSize:10,color:"#5a6a8a",fontWeight:700}}>— Clear</button>}
          {ZONES.map(z => (
            <button key={z} onClick={()=>{onChange(z);setOpen(false);}} style={{padding:"4px 8px",borderRadius:5,background:z===zone?"rgba(255,255,255,.06)":"transparent",border:"none",cursor:"pointer",textAlign:"left",fontSize:10,color:ZONE_COLORS[z],fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
              <div style={{width:5,height:5,borderRadius:99,background:ZONE_COLORS[z]}}/>
              {z}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [dlSet, setDlSet] = useState(() => new Set());
  // markupSrc is what we actually pass to PhotoMarkup. Normally it's the
  // photo's dataUrl (base64 from IDB). But if the photo has been "promoted"
  // (uploaded to Drive and dataUrl evicted to save space), we fetch it back
  // from Drive into a blob URL on demand. The blob URL is revoked when
  // markup closes.
  const [markupSrc, setMarkupSrc] = useState(null);
  const [markupLoading, setMarkupLoading] = useState(false);
  const [markupSection, setMarkupSection] = useState("scope"); // which photo array to edit
  const [showCamera, setShowCamera] = useState(false);
  const [cameraSection, setCameraSection] = useState("scope");
  const [showParcelMap, setShowParcelMap] = useState(false);
  const [showVideoRecorder, setShowVideoRecorder] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [playingIdx, setPlayingIdx] = useState(null);
  const ytFileRef = useRef(null);
  // (formerly: ytUploadCount — now tracked entirely via videoQueueItems)
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

  // ── PROPERTY MEMORY ──────────────────────────────────────────────────────
  // Synchronous read from pipeline localStorage — zero async cost.
  // Matches by address prefix OR client last name. Shows up to 3 prior visits.
  const propertyHistory = (() => {
    try {
      const pl = loadPipeline();
      const lastName = (s.cn || "").split(/\s+/).pop().toLowerCase();
      const addrKey  = (s.addr || "").split(",")[0].toLowerCase().trim();
      return Object.values(pl)
        .filter(c => {
          if (c.id === s.id) return false;
          const cLast = (c.cn || "").split(/\s+/).pop().toLowerCase();
          const cAddr = (c.addr || "").split(",")[0].toLowerCase().trim();
          return (addrKey.length > 4 && cAddr.includes(addrKey)) ||
                 (lastName.length > 2  && cLast === lastName);
        })
        .sort((a, b) => (b.stageChangedAt || b.addedAt || 0) - (a.stageChangedAt || a.addedAt || 0))
        .slice(0, 3);
    } catch { return []; }
  })();
  const [historyOpen, setHistoryOpen] = useState(false);

  // ── CONFIDENCE INDICATOR ────────────────────────────────────────────────
  const [cloudSynced, setCloudSynced] = useState(() => !getDirtyFieldIds().includes(s.id));
  useEffect(() => {
    const check = () => setCloudSynced(!getDirtyFieldIds().includes(s.id));
    window.addEventListener("mts-field-synced", check);
    return () => window.removeEventListener("mts-field-synced", check);
  }, [s.id]);
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
  // CRITICAL: 'hydrated' is STATE, not a ref, because the auto-save effect
  // must re-run when it flips true. With a ref, React doesn't know to
  // re-evaluate dependent effects, so saves stay gated forever after the
  // initial pass.
  const [hydrated, setHydrated] = useState(false);
  // Pending local-save timer — debounces writes to absorb dictation bursts
  // (which fire setState per character). Without this, a single dictated
  // sentence triggers ~30 multi-MB IDB writes, raising iOS memory pressure
  // enough to kill the JS context.
  const localSaveTimerRef = useRef(null);
  const pendingDataRef = useRef(null);

  const downloadPhoto = async (p, filename, key) => {
    setDlSet(s => new Set([...s, key]));
    try { await _saveBlobAsFile(await _fetchPhotoBlob(p, token), filename); }
    catch (e) { console.warn("Photo download failed:", e); }
    finally { setDlSet(s => { const n = new Set(s); n.delete(key); return n; }); }
  };

  // Reset scroll on unmount so route screen isn't left zoomed
  useEffect(() => { return () => { setTimeout(() => { try { window.scrollTo(0,0); } catch(e){} }, 80); }; }, []);

  // Auto-save on every change — IndexedDB (local) + Drive.
  //
  // CRITICAL ARCHITECTURE: This effect ONLY writes text + AI fields via
  // mergeField. It NEVER touches photos. Photo modifications (add/remove/
  // markup-edit) go through dedicated updateField calls. This eliminates
  // the wipe surface entirely — text changes cannot corrupt photo data
  // because they never write to that field.
  //
  // Gated on `hydrated` so we don't write before knowing what IDB holds.
  //
  // Rate-limited to at most one write per 500ms (leading-trailing pattern:
  // first change in a window schedules a save 500ms out; subsequent changes
  // update pendingDataRef without resetting the timer). Absorbs dictation
  // bursts while guaranteeing no change waits more than 500ms to hit IDB.
  useEffect(() => {
    if (!hydrated) return;
    // Text/AI fields only — these go to IDB via mergeField (which preserves
    // photos via shallow merge with existing IDB record).
    const textPartial = {
      scopeNotes,
      addonNotes,
      videoUrls,
      audioClips,
      aiScopeSummary: aiScopeResult,
      aiAddonEmail: aiAddonResult,
    };
    // Full snapshot (text + photos) for the in-memory mirror, the
    // pagehide flush, and the Drive sync. State is authoritative for
    // what the user is currently looking at.
    const fullSnapshot = { ...textPartial, scopePhotos, addonPhotos };
    primeField(s.id, fullSnapshot);
    pendingDataRef.current = fullSnapshot;
    // Leading-trailing rate limit — if a save is already scheduled, just
    // update pendingDataRef and let the existing timer fire.
    if (!localSaveTimerRef.current) {
      localSaveTimerRef.current = setTimeout(() => {
        localSaveTimerRef.current = null;
        // Re-read pendingDataRef at fire time to get the freshest text.
        const latest = pendingDataRef.current;
        if (!latest) return;
        const latestTextOnly = {
          scopeNotes: latest.scopeNotes,
          addonNotes: latest.addonNotes,
          videoUrls: latest.videoUrls,
          audioClips: latest.audioClips,
          aiScopeSummary: latest.aiScopeSummary,
          aiAddonEmail: latest.aiAddonEmail,
        };
        // mergeField is queued — photos in IDB are preserved by the
        // shallow-merge in fieldStore (existing photos stay because
        // textPartial doesn't include those keys).
        mergeField(s.id, latestTextOnly).then(() => {
          try { window.dispatchEvent(new CustomEvent("mts-field-synced")); } catch {}
        });
      }, 500);
    }
    if (token) {
      // Per-stop timer key — opening OnsiteWindow for a different stop must
      // not cancel the pending Drive save for this stop. A shared
      // window._fieldSyncTimer would be cleared by the next stop's effect.
      const timerKey = `_mtsFieldSync_${s.id}`;
      if (window[timerKey]) clearTimeout(window[timerKey]);
      window[timerKey] = setTimeout(() => {
        window[timerKey] = null;
        // Serialized + coalesced; reads fresh IDB at execution time so Drive
        // never gets a stale photo/text snapshot.
        queueFieldDriveSync(token, s.id);
      }, 3000);
    }
  }, [hydrated, scopeNotes, addonNotes, scopePhotos, addonPhotos, videoUrls, audioClips, aiScopeResult, aiAddonResult, s.id, token]);

  // ── PANIC FLUSH ──────────────────────────────────────────────────────────
  // iOS aggressively suspends WKWebView pages on backgrounding / app switch
  // / memory pressure. When that happens mid-rate-limit-window, the latest
  // few hundred ms of typing would be lost. These handlers flush the slim
  // localStorage mirror synchronously (guaranteed to land before suspend)
  // and fire an async IDB write that may or may not commit before suspend.
  // On next open, peekField → getFieldSlim returns the latest text.
  useEffect(() => {
    const flush = () => {
      if (!pendingDataRef.current) return;
      // 1. Synchronous slim mirror update — text is safe even if iOS
      //    interrupts before IDB commits.
      saveFieldSync(s.id, pendingDataRef.current);
      // 2. Cancel the pending timer and fire mergeField now so the IDB
      //    write at least starts.
      if (localSaveTimerRef.current) {
        clearTimeout(localSaveTimerRef.current);
        localSaveTimerRef.current = null;
      }
      const d = pendingDataRef.current;
      mergeField(s.id, {
        scopeNotes: d.scopeNotes,
        addonNotes: d.addonNotes,
        videoUrls: d.videoUrls,
        audioClips: d.audioClips,
        aiScopeSummary: d.aiScopeSummary,
        aiAddonEmail: d.aiAddonEmail,
      }).catch(() => {});
      // 3. Also try to push the full record (photos included) to Drive now.
      //    iOS may suspend before this completes, but if it lands the data
      //    is durable cross-device. Fire from a fresh IDB read so we don't
      //    push stale state.
      const timerKey = `_mtsFieldSync_${s.id}`;
      if (window[timerKey]) { clearTimeout(window[timerKey]); window[timerKey] = null; }
      if (token) queueFieldDriveSync(token, s.id);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id, token]);

  // Flush any pending rate-limited save on component unmount.
  useEffect(() => {
    const stopId = s.id;
    const capturedToken = token;
    return () => {
      if (localSaveTimerRef.current) {
        clearTimeout(localSaveTimerRef.current);
        localSaveTimerRef.current = null;
      }
      if (pendingDataRef.current) {
        const d = pendingDataRef.current;
        // Slim mirror synchronously, IDB asynchronously (fire-and-forget).
        saveFieldSync(stopId, d);
        mergeField(stopId, {
          scopeNotes: d.scopeNotes,
          addonNotes: d.addonNotes,
          videoUrls: d.videoUrls,
          audioClips: d.audioClips,
          aiScopeSummary: d.aiScopeSummary,
          aiAddonEmail: d.aiAddonEmail,
        }).catch(() => {});
        pendingDataRef.current = null;
      }
      // Promote the pending 3-sec Drive timer to fire immediately so photos
      // captured right before Done don't sit local-only for 3 seconds.
      // (Critical for cross-device: Chromebook only sees what's on Drive.)
      const timerKey = `_mtsFieldSync_${stopId}`;
      if (window[timerKey]) { clearTimeout(window[timerKey]); window[timerKey] = null; }
      if (capturedToken) queueFieldDriveSync(capturedToken, stopId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id, token]);

  // On mount (or when stop changes), hydrate from IndexedDB.
  // If peekField returned empty we'll get the data here; if it had a
  // localStorage-mirror value we'll still get the fresher IDB read.
  //
  // CRITICAL: For arrays (photos, audio, videos) we MERGE by timestamp
  // rather than choosing IDB-or-state. This handles the case where the
  // user captures a photo within the 50-200ms hydration window — state
  // would have only the new photo (because _processPhoto's read-modify-
  // write reads from IDB, not state), and a naive "keep state if non-
  // empty" rule would drop the older IDB photos.
  //
  // RECOVERY CHECK: After loading, compare IDB photo counts against the
  // slim localStorage mirror's claimed counts. The slim mirror records
  // _scopePhotoCount / _addonPhotoCount on every save. If IDB has FEWER
  // photos than the slim claims, something wiped them (the bug we just
  // fixed, or a future regression). Attempt restore from Drive.
  useEffect(() => {
    setHydrated(false);
    let dead = false;
    loadField(s.id).then(async data => {
      if (dead) return;
      if (data && Object.keys(data).length > 0) {
        primeField(s.id, data);
        const idbScopeNotes = data.scopeNotes || data.myNotes || "";
        const idbScopePhotos = data.scopePhotos || data.photos || [];
        const idbAddonPhotos = data.addonPhotos || [];
        const idbVideoUrls = data.videoUrls || (data.videoUrl ? [data.videoUrl] : []);
        const idbAudioClips = data.audioClips || [];

        // Scalars: only adopt IDB value if state is still the initial default.
        if (idbScopeNotes)        setScopeNotes(prev => prev || idbScopeNotes);
        if (data.addonNotes)      setAddonNotes(prev => prev || data.addonNotes);
        if (data.aiScopeSummary)  setAiScopeResult(prev => prev || data.aiScopeSummary);
        if (data.aiAddonEmail)    setAiAddonResult(prev => prev || data.aiAddonEmail);

        // Arrays: merge by ts/timestamp/url so anything captured during the
        // hydration window survives alongside whatever was already in IDB.
        // State takes precedence on collision (preserves PhotoMarkup edits).
        const mergeByKey = (idb, prev, getKey) => {
          if (prev.length === 0) return idb;
          const map = new Map();
          idb.forEach(item => map.set(getKey(item), item));
          prev.forEach(item => map.set(getKey(item), item)); // prev wins on key collision
          return [...map.values()].sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));
        };
        if (idbScopePhotos.length) setScopePhotos(prev => mergeByKey(idbScopePhotos, prev, photoKey));
        if (idbAddonPhotos.length) setAddonPhotos(prev => mergeByKey(idbAddonPhotos, prev, photoKey));
        if (idbAudioClips.length)  setAudioClips(prev => mergeByKey(idbAudioClips, prev, a => a.ts || a.timestamp || a.url));
        if (idbVideoUrls.length)   setVideoUrls(prev => prev.length === 0 ? idbVideoUrls : Array.from(new Set([...idbVideoUrls, ...prev])));

        // ── RECOVERY CHECK ──────────────────────────────────────────────
        // Compare what IDB actually has against what the slim mirror
        // claimed it had at the last save. If we're missing photos,
        // attempt restore from Drive.
        const slim = getFieldSlim(s.id);
        if (slim) {
          const expectedScope = slim._scopePhotoCount || 0;
          const expectedAddon = slim._addonPhotoCount || 0;
          const actualScope = idbScopePhotos.length;
          const actualAddon = idbAddonPhotos.length;
          if (expectedScope > actualScope || expectedAddon > actualAddon) {
            console.warn(`[Onsite] Photo count mismatch for ${s.id}: scope expected ${expectedScope} got ${actualScope}, addon expected ${expectedAddon} got ${actualAddon}. Attempting Drive restore.`);
            if (token) {
              try {
                const cloud = await loadFieldFromDrive(token, s.id);
                if (!dead && cloud && (Array.isArray(cloud.scopePhotos) || Array.isArray(cloud.addonPhotos))) {
                  const cloudScope = cloud.scopePhotos || cloud.photos || [];
                  const cloudAddon = cloud.addonPhotos || [];
                  // Restore photos by merging Drive + whatever local has.
                  if (cloudScope.length > actualScope) {
                    setScopePhotos(prev => mergeByKey(cloudScope, prev, photoKey));
                  }
                  if (cloudAddon.length > actualAddon) {
                    setAddonPhotos(prev => mergeByKey(cloudAddon, prev, photoKey));
                  }
                  // Persist the recovered photos to IDB immediately so
                  // they're durable even if user closes Onsite right away.
                  await updateField(s.id, (existing) => {
                    const merged = {};
                    if (cloudScope.length > actualScope) {
                      merged.scopePhotos = mergeByKey(cloudScope, existing.scopePhotos || [], photoKey);
                    }
                    if (cloudAddon.length > actualAddon) {
                      merged.addonPhotos = mergeByKey(cloudAddon, existing.addonPhotos || [], photoKey);
                    }
                    return merged;
                  });
                  console.log(`[Onsite] Recovered ${Math.max(0, cloudScope.length - actualScope) + Math.max(0, cloudAddon.length - actualAddon)} photo(s) from Drive for ${s.id}`);
                }
              } catch (e) {
                console.warn("[Onsite] Drive recovery failed:", e);
              }
            }
          }
        }
      }
      // Open the save gate AFTER setState calls are queued. React batches
      // them, so the auto-save effect re-runs once with merged state.
      if (!dead) setHydrated(true);
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  
  // If no local data, pull from Drive to populate on first open.
  // _scopePhotoCount/_addonPhotoCount are stored in the slim localStorage mirror
  // even though the actual base64 data isn't — use them to detect existing photos
  // so we don't fire a Drive pull that could overwrite locally-captured photos.
  useEffect(() => {
    const hasLocal = !!(fd.scopeNotes || fd.myNotes || fd.addonNotes ||
      (fd.scopePhotos || fd.photos || []).length || fd._scopePhotoCount || fd._addonPhotoCount);
    if (!hasLocal && token) {
      let dead = false;
      setCloudLoading(true);
      loadFieldFromDrive(token, s.id).then(async cloud => {
        if (dead) return;
        if (!cloud || Object.keys(cloud).length === 0) { setCloudLoading(false); return; }
        // Always merge with current IDB state — never overwrite locally-captured photos
        // with older or empty Drive data. This prevents a race where photos taken in
        // this session get erased when a slow Drive response arrives.
        const local = await loadField(s.id).catch(() => ({}));
        if (dead) return;
        // Merge by ts/url so duplicates from cloud vs local collapse and any
        // photos captured DURING the Drive fetch (already in state, may not
        // yet be in IDB) survive.
        const mergeByKey = (a, b, getKey) => {
          const map = new Map();
          (a || []).forEach(item => map.set(getKey(item), item));
          (b || []).forEach(item => map.set(getKey(item), item));
          return [...map.values()].sort((x, y) => (x.ts || x.timestamp || 0) - (y.ts || y.timestamp || 0));
        };
        const merged = {
          ...local,
          ...cloud,
          scopePhotos: mergeByKey(cloud.scopePhotos || cloud.photos, local.scopePhotos || local.photos, photoKey),
          addonPhotos: mergeByKey(cloud.addonPhotos, local.addonPhotos, photoKey),
          audioClips:  mergeByKey(cloud.audioClips,  local.audioClips, a => a.ts || a.timestamp || a.url),
          videoUrls:   Array.from(new Set([...(cloud.videoUrls || []), ...(local.videoUrls || [])])),
        };
        // Functional setState everywhere — preserves anything the user
        // captured/typed during the Drive fetch window (state takes
        // precedence on key collision via the merge above).
        if (cloud.scopeNotes || cloud.myNotes) setScopeNotes(prev => prev || cloud.scopeNotes || cloud.myNotes || "");
        if (cloud.addonNotes) setAddonNotes(prev => prev || cloud.addonNotes);
        if ((merged.scopePhotos || []).length) setScopePhotos(prev => mergeByKey(merged.scopePhotos, prev, photoKey));
        if ((merged.addonPhotos || []).length) setAddonPhotos(prev => mergeByKey(merged.addonPhotos, prev, photoKey));
        if (merged.videoUrls?.length) setVideoUrls(prev => Array.from(new Set([...merged.videoUrls, ...prev])));
        else if (cloud.videoUrl) setVideoUrls(prev => prev.length === 0 ? [cloud.videoUrl] : prev);
        if (merged.audioClips?.length) setAudioClips(prev => mergeByKey(merged.audioClips, prev, a => a.ts || a.timestamp || a.url));
        if (cloud.aiScopeSummary) setAiScopeResult(prev => prev || cloud.aiScopeSummary);
        if (cloud.aiAddonEmail) setAiAddonResult(prev => prev || cloud.aiAddonEmail);
        // Route through the per-stop write queue so this can't clobber
        // concurrent photoSync writes that may have completed during the
        // Drive fetch above.
        updateField(s.id, (existing) => {
          const ex = existing || {};
          const exScope = ex.scopePhotos || ex.photos || [];
          const exAddon = ex.addonPhotos || [];
          const exAudio = ex.audioClips || [];
          const exVids  = ex.videoUrls || (ex.videoUrl ? [ex.videoUrl] : []);
          return {
            ...merged,
            scopePhotos: mergeByKey(merged.scopePhotos || [], exScope, photoKey),
            addonPhotos: mergeByKey(merged.addonPhotos || [], exAddon, photoKey),
            audioClips:  mergeByKey(merged.audioClips  || [], exAudio, a => a.ts || a.timestamp || a.url),
            videoUrls:   Array.from(new Set([...(merged.videoUrls || []), ...exVids])),
          };
        }).catch(() => {});
        primeField(s.id, merged);
        setCloudLoading(false);
      }).catch(() => { if (!dead) setCloudLoading(false); });
      return () => { dead = true; };
    }
  }, [s.id, token]);

  // ── PHOTO HANDLING ──────────────────────────────────────────────────
  // processPhoto delegates to the module-level _processPhoto so that photo
  // processing (FileReader + canvas resize) continues even if the user taps
  // Done before the async work completes. The photo is saved to IndexedDB
  // regardless; UI state is only updated if the component is still mounted.
  // ── PHOTO HANDLERS ────────────────────────────────────────────────────
  // EVERY mutation here writes to IDB through updateField IMMEDIATELY, so
  // photos are durable independent of the auto-save effect. The auto-save
  // never touches photos (text-only payload), which means there is no
  // code path that can wipe photos via a text change. All writes go
  // through fieldStore's shared per-stop queue, so they can never race
  // with each other or with photoSync.
  const processPhoto = (file, section = "scope") => {
    if (!file) return;
    _processPhoto(file, section, s.id).then(photo => {
      if (!photo || !mountedRef.current) return;
      if (section === "addon") setAddonPhotos(prev => [...prev, photo]);
      else setScopePhotos(prev => [...prev, photo]);
      // Immediate, serialized Drive sync — see camera onPhoto for the rationale.
      if (token) queueFieldDriveSync(token, s.id);
    });
  };
  const handleScopePhotos = (e) => { Array.from(e.target.files || []).forEach(f => processPhoto(f, "scope")); e.target.value = ""; };
  const handleAddonPhotos = (e) => { Array.from(e.target.files || []).forEach(f => processPhoto(f, "addon")); e.target.value = ""; };
  const removeScopePhoto = (i) => {
    // Identify the photo by stable key (id/ts/url) so we never delete the
    // wrong one if state and IDB orderings drift.
    const target = scopePhotos[i];
    const key = target ? photoKey(target) : null;
    setScopePhotos(prev => prev.filter((_, j) => j !== i));
    if (key !== null) {
      updateField(s.id, (existing) => ({
        scopePhotos: (existing.scopePhotos || existing.photos || []).filter(p => photoKey(p) !== key),
      })).catch(() => {});
    }
  };
  const removeAddonPhoto = (i) => {
    const target = addonPhotos[i];
    const key = target ? photoKey(target) : null;
    setAddonPhotos(prev => prev.filter((_, j) => j !== i));
    if (key !== null) {
      updateField(s.id, (existing) => ({
        addonPhotos: (existing.addonPhotos || []).filter(p => photoKey(p) !== key),
      })).catch(() => {});
    }
  };
  const removePhoto = (i, section) => {
    if (section === "addon") removeAddonPhoto(i);
    else removeScopePhoto(i);
  };
  const handleMarkupSave = (dataUrl) => {
    // Clear the Drive URL so the freshly-edited version shows immediately,
    // then re-queue this stop so the edited photo gets re-uploaded to Drive.
    const photos = markupSection === "addon" ? addonPhotos : scopePhotos;
    const target = photos[markupIdx];
    const key = target ? photoKey(target) : null;
    const update = (p, i) => i === markupIdx ? { ...p, dataUrl, url: undefined } : p;
    if (markupSection === "addon") setAddonPhotos(prev => prev.map(update));
    else setScopePhotos(prev => prev.map(update));
    // Write through to IDB by stable key match (not index — IDB ordering
    // may differ from state ordering).
    if (key !== null) {
      const arrKey = markupSection === "addon" ? "addonPhotos" : "scopePhotos";
      updateField(s.id, (existing) => ({
        [arrKey]: (existing[arrKey] || existing.photos || []).map(p =>
          photoKey(p) === key ? { ...p, dataUrl, url: undefined } : p
        ),
      })).catch(() => {});
    }
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

  // URL type helpers — kept for backward compat with legacy YouTube links on older cards
  const getYtId = (url) => url?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];
  const getDriveFileId = (url) => url?.match(/\/(?:file\/d|watch)\/([a-zA-Z0-9_-]+)/)?.[1];

  // ── VIDEO DELETE ────────────────────────────────────────────────────
  // Handles both Drive (new) and YouTube (legacy) URLs.
  const deleteVideo = async (url, idx) => {
    const driveId = getDriveFileId(url);
    const ytId    = getYtId(url);

    const tokenData = JSON.parse(localStorage.getItem("mts-token") || "null");
    const tok = tokenData?.token || token;

    if (driveId) {
      if (!window.confirm("Delete this video from Google Drive AND remove it from the app?")) return;
      if (tok) {
        try {
          await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${tok}` },
          });
        } catch(e) { console.warn("Drive delete error:", e); }
      }
      setVideoUrls(prev => prev.filter((_, i) => i !== idx));
    } else if (ytId) {
      if (!window.confirm("Delete this video from YouTube AND remove it from the app?")) return;
      if (tok) {
        try {
          await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${ytId}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${tok}` },
          });
        } catch(e) { console.warn("YouTube delete error:", e); }
      }
      setVideoUrls(prev => prev.filter((_, i) => i !== idx));
    } else {
      // Unknown URL — just remove from app
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

  // ── MARKUP SOURCE LOADER ────────────────────────────────────────────
  // When the user enters markup mode, pick the right image source. If the
  // photo has been promoted (no local dataUrl), fetch it from its Drive URL
  // into a blob URL we can pass to PhotoMarkup.
  useEffect(() => {
    if (markupIdx === null) {
      // Cleanup any previous blob URL
      if (markupSrc && markupSrc.startsWith("blob:")) {
        try { URL.revokeObjectURL(markupSrc); } catch {}
      }
      setMarkupSrc(null);
      setMarkupLoading(false);
      return;
    }
    const photos = markupSection === "addon" ? addonPhotos : scopePhotos;
    const photo = photos[markupIdx];
    if (!photo) return;
    // Local copy available: use it directly
    if (photo.dataUrl) {
      setMarkupSrc(photo.dataUrl);
      setMarkupLoading(false);
      return;
    }
    // No local copy — fetch from Drive
    if (!photo.url) {
      setMarkupSrc(""); // "" = settled with no usable source (not null = still pending)
      setMarkupLoading(false);
      return;
    }
    let cancelled = false;
    let createdBlobUrl = null;
    setMarkupLoading(true);
    (async () => {
      try {
        // Extract Drive file ID so we can download via the Drive API with
        // Authorization header. The drive.google.com/thumbnail URL is public
        // but doesn't send CORS headers, so a programmatic fetch() is blocked
        // by the browser even though the <img> tag displays it fine.
        const fileIdMatch = photo.url.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
                            photo.url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        const fileId = fileIdMatch?.[1];
        let res;
        if (fileId && token) {
          res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        } else {
          res = await fetch(photo.url);
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        if (cancelled) return;
        createdBlobUrl = URL.createObjectURL(blob);
        setMarkupSrc(createdBlobUrl);
        setMarkupLoading(false);
      } catch (e) {
        console.warn("[Markup] failed to load photo from URL:", e);
        if (!cancelled) {
          setMarkupSrc(""); // "" = failed, not null = still pending
          setMarkupLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (createdBlobUrl) {
        try { URL.revokeObjectURL(createdBlobUrl); } catch {}
      }
    };
  }, [markupIdx, markupSection, scopePhotos, addonPhotos]);

  // ── VIDEO QUEUE STATE — must stay above early returns (Rules of Hooks) ──
  // These power the queue panel UI shown in the VIDEO section. The actual
  // upload work (streaming PUT to Drive) runs entirely inside
  // videoQueue.js, persisted to IDB, so it survives this component
  // unmounting. These hooks just keep the on-screen queue panel in sync.
  const [videoQueueItems, setVideoQueueItems] = useState([]);
  const [queuePaused, setQueuePausedState] = useState(isVideoQueuePaused());
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
  //
  // CRITICAL: Only update state if the value ACTUALLY changed. Otherwise
  // we trigger a feedback loop with the auto-save useEffect below (which
  // also dispatches "mts-field-synced" on every save). A naïve setVideoUrls
  // call here would cause: save → dispatch → handler → setVideoUrls (new
  // array ref) → save → dispatch → ... infinite render loop, screen flashes,
  // component eventually unmounts and bails to the routing screen, taking
  // any unsaved photo state with it. (This is the bug that was eating
  // photos taken with the camera, since camera photos only live in React
  // state until the auto-save effect runs.)
  useEffect(() => {
    const handler = async () => {
      try {
        const fd = await loadField(s.id);
        if (!fd || !mountedRef.current) return;
        const incoming = fd.videoUrls || (fd.videoUrl ? [fd.videoUrl] : []);
        setVideoUrls(prev => {
          if (prev.length === incoming.length && prev.every((v, i) => v === incoming[i])) {
            return prev;
          }
          return incoming;
        });
      } catch {}
    };
    window.addEventListener("mts-field-synced", handler);
    // Also listen for the dedicated video-uploaded event from videoQueue
    window.addEventListener("mts-video-uploaded", handler);
    return () => {
      window.removeEventListener("mts-field-synced", handler);
      window.removeEventListener("mts-video-uploaded", handler);
    };
  }, [s.id]);

  // ── MARKUP OVERLAY ──────────────────────────────────────────────────
  // Font shorthands — declared before any early return so they're in scope
  // for the camera/markup loading spinners that use fontFamily:F.
  const F = "'Oswald',sans-serif";
  const B = "'DM Sans',system-ui,sans-serif";

  // Parcel map — satellite + tax-parcel overlay, scoped to this stop
  if (showParcelMap) {
    return <ParcelMapView
      stop={s}
      onClose={() => setShowParcelMap(false)}
      onSnapshot={async (rawDataUrl) => {
        // Same downscale-then-store flow as camera photos (see showCamera
        // below) so snapshot photos get every existing guarantee — no
        // clobbering on concurrent writes, no Drive sync loss.
        const dataUrl = await downscaleDataUrl(rawDataUrl);
        const photo = { dataUrl, ts: Date.now(), id: newPhotoId() };
        try {
          await updateField(s.id, (existing) => ({
            addonPhotos: [...(existing.addonPhotos || []), photo],
          }));
        } catch (e) { console.warn("Parcel snapshot IDB save failed:", e); }
        setAddonPhotos(prev => [...prev, photo]);
        markStopForPhotoSync(s.id);
        if (token) queueFieldDriveSync(token, s.id);
        setShowParcelMap(false);
      }}
    />;
  }

  // Camera view — rapid capture mode
  if (showCamera) {
    return <CameraView
      onPhoto={async (rawDataUrl) => {
        // Downscale to the 2400px budget BEFORE storing. The camera captures at
        // up to 4K; raw 4K base64 OOM-crashes the renderer when several are
        // shown and bloats the Drive payload so sync fails.
        const dataUrl = await downscaleDataUrl(rawDataUrl);
        const photo = { dataUrl, ts: Date.now(), id: newPhotoId() };
        const key = cameraSection === "addon" ? "addonPhotos" : "scopePhotos";
        // CRITICAL: Persist to IDB BEFORE updating React state, through
        // fieldStore's shared per-stop queue. The queue serializes this
        // write with the auto-save's mergeField and any other photo ops,
        // so concurrent writes can't read the same "before" state and
        // clobber each other.
        try {
          await updateField(s.id, (existing) => {
            const existingPhotos = existing[key] || existing.photos || [];
            return { [key]: [...existingPhotos, photo] };
          });
        } catch (e) { console.warn("Camera photo IDB save failed:", e); }
        // Now reflect in component state so the UI updates
        if (cameraSection === "addon") setAddonPhotos(prev => [...prev, photo]);
        else setScopePhotos(prev => [...prev, photo]);
        markStopForPhotoSync(s.id); // queue for Drive upload
        // IMMEDIATE Drive sync so photos can't be lost if the user closes the
        // app before the 3-sec auto-save timer fires. Serialized + coalesced
        // per stop so rapid captures can't race and overwrite each other with
        // a stale snapshot — reads fresh IDB at execution time.
        if (token) queueFieldDriveSync(token, s.id);
      }}
      onClose={() => setShowCamera(false)}
    />;
  }

  if (markupIdx !== null) {
    const photos = markupSection === "addon" ? addonPhotos : scopePhotos;
    if (photos[markupIdx]) {
      // null = effect not yet run — always show spinner (resolves in one tick for local photos)
      // ""   = effect settled with no usable source — show error
      // url  = ready
      if (markupLoading || markupSrc === null) {
        return (
          <div style={{ position:"fixed", inset:0, background:"#000", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", color:"#a0b0c0", fontFamily:F, letterSpacing:1, textTransform:"uppercase", fontSize:11 }}>
            {markupLoading ? "Loading photo from Drive…" : "Preparing…"}
          </div>
        );
      }
      if (markupSrc === "") {
        return (
          <div style={{ position:"fixed", inset:0, background:"#000", zIndex:1000, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"#FF8888", fontFamily:F, padding:20 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:8, letterSpacing:1, textTransform:"uppercase" }}>Could not load photo</div>
            <div style={{ fontSize:11, color:"#7a8090", marginBottom:20, textAlign:"center" }}>The local copy was cleaned up and the cloud copy could not be reached. Check your connection and try again.</div>
            <button onClick={() => setMarkupIdx(null)} style={{ padding:"10px 20px", background:"transparent", border:"1px solid #2a3560", borderRadius:8, color:"#a0b8d0", fontSize:12, fontWeight:700, cursor:"pointer" }}>BACK</button>
          </div>
        );
      }
      // Save edits to the current photo without closing markup, then switch index.
      const saveMarkupOnly = (dataUrl) => {
        const target = photos[markupIdx];
        const key = target ? photoKey(target) : null;
        const update = (p, i) => i === markupIdx ? { ...p, dataUrl, url: undefined } : p;
        if (markupSection === "addon") setAddonPhotos(prev => prev.map(update));
        else setScopePhotos(prev => prev.map(update));
        if (key !== null) {
          const arrKey = markupSection === "addon" ? "addonPhotos" : "scopePhotos";
          updateField(s.id, (existing) => ({
            [arrKey]: (existing[arrKey] || existing.photos || []).map(p =>
              photoKey(p) === key ? { ...p, dataUrl, url: undefined } : p
            ),
          })).catch(() => {});
        }
        markStopForPhotoSync(s.id);
      };
      return (
        <PhotoMarkup
          key={markupIdx}
          photoDataUrl={markupSrc}
          onSave={handleMarkupSave}
          onCancel={() => setMarkupIdx(null)}
          hasPrev={markupIdx > 0}
          hasNext={markupIdx < photos.length - 1}
          onPrev={(dataUrl, hasEdits) => { if (hasEdits) saveMarkupOnly(dataUrl); setMarkupIdx(i => i - 1); }}
          onNext={(dataUrl, hasEdits) => { if (hasEdits) saveMarkupOnly(dataUrl); setMarkupIdx(i => i + 1); }}
        />
      );
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

  // ── VIDEO: enqueue for background upload to Google Drive via videoQueue ──
  // The actual upload (chunked PUT to Drive) runs entirely inside videoQueue.js,
  // persisted to its own IndexedDB store. By the time enqueueVideo() resolves
  // the file is safely written to IDB and will upload on the next opportunity,
  // even if the app is closed and reopened. Drive URLs are saved to the card
  // as google.com/file/d/{id}/preview links, which work in any browser.
  // (State hooks for videoQueueItems / uploadMode / showQueuePanel live
  //  above the early returns, in the hook section, per Rules of Hooks.)

  // Shared by both video sources (in-app recorder + library picker) so queued
  // items are named consistently regardless of how they were captured.
  const buildVideoTitle = () => {
    const lastName = (s.cn || "").split(" ").pop();
    const jobPart = s.jn ? ` #${s.jn}` : "";
    const datePart = new Date().toLocaleDateString("en-US", {month:"2-digit",day:"2-digit",year:"numeric"});
    // Sequence number = existing uploaded videos + already-queued videos + this one
    const totalCount = videoUrls.length + videoQueueItems.length + 1;
    const seqNum = String(totalCount).padStart(2, "0");
    return `${lastName}${jobPart} ${datePart} - ${seqNum}`;
  };

  const handleYtFile = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        await enqueueVideo({ stopId: s.id, file, title: buildVideoTitle() });
      } catch (err) {
        console.warn("Failed to enqueue video:", err);
        alert("Failed to queue video: " + (err.message || err));
      }
    }
    e.target.value = "";
  };

  const handleRecordedVideo = async (file) => {
    setShowVideoRecorder(false);
    try {
      await enqueueVideo({ stopId: s.id, file, title: buildVideoTitle() });
    } catch (err) {
      console.warn("Failed to enqueue recorded video:", err);
      alert("Failed to queue video: " + (err.message || err));
    }
  };

  if (showVideoRecorder) {
    return <VideoRecorder
      onRecorded={handleRecordedVideo}
      onClose={() => setShowVideoRecorder(false)}
    />;
  }

  // Explicit final save then call onDone — guarantees current React state
  // (all visible photos/notes) is persisted to IDB before the component unmounts
  // and markDone reads from IDB to upload to Drive.
  // Goes through the per-stop write queue so concurrent photoSync URL writes
  // aren't clobbered — we merge state's photos with IDB's photos by ts/url,
  // preferring state's dataUrl (newer markup) and IDB's url (newer sync).
  const handleDone = async () => {
    await updateField(s.id, (existing) => {
      const ex = existing || {};
      const mergePhotos = (state = [], idb = []) => {
        const map = new Map();
        for (const p of idb) { const k = photoKey(p); if (k != null) map.set(k, p); }
        for (const p of state) {
          const k = photoKey(p);
          if (k == null) continue;
          const ex2 = map.get(k);
          map.set(k, ex2 ? { ...ex2, ...p, url: p.url || ex2.url, syncedAt: p.syncedAt || ex2.syncedAt } : p);
        }
        return [...map.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      };
      return {
        scopeNotes, addonNotes, videoUrls, audioClips,
        aiScopeSummary: aiScopeResult, aiAddonEmail: aiAddonResult,
        scopePhotos: mergePhotos(scopePhotos, ex.scopePhotos || ex.photos || []),
        addonPhotos: mergePhotos(addonPhotos, ex.addonPhotos || []),
      };
    }).catch(() => {});
    onDone();
  };

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
    if (swipeX < -120) handleDone();
    setSwipeX(0); setSwiping(false); swipeDir.current = null;
  };

  // ── RENDER ────────────────────────────────────────────────────────────
  return (
    <div style={{position:"fixed",inset:0,zIndex:100,background:"#0a0b10",display:"flex",flexDirection:"column",fontFamily:B,color:"#f0f4fa",overflow:"hidden"}}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",paddingTop:"max(10px,env(safe-area-inset-top))",background:"#0d0f18",borderBottom:"1px solid #1a1f2e",flexShrink:0}}>
        <button onClick={onBack} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:8,background:"transparent",border:"1px solid #252d47",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,flexShrink:0}}><IconArrowLeft size={13} color="#90a8c0"/>Route</button>
        {/* Confidence indicator — local always green; cloud shows sync state.
            Stacked vertically as bare dots (no labels) to save header width. */}
        <div style={{display:"flex",flexDirection:"column",gap:2,flexShrink:0}}>
          <div title="Saved locally"><svg width={7} height={7} viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#10B981"/></svg></div>
          <div title={cloudSynced ? "Synced to cloud" : "Pending cloud push"}><svg width={7} height={7} viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill={cloudSynced?"#10B981":"#F6BF26"}/></svg></div>
        </div>
        <div style={{flex:1,minWidth:0}}/>
        {/* Decline — moved from bottom bar so it can't be hit when reaching for DONE */}
        {!declineConfirm ? (
          <button onClick={()=>setDeclineConfirm(true)} title="Decline lead" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:"transparent",border:"1px solid #252d47",cursor:"pointer",flexShrink:0}}><IconX size={15} color="#a06060"/></button>
        ) : (
          <button onClick={()=>{setDeclineConfirm(false);onDecline();}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"rgba(200,60,60,.2)",border:"1px solid rgba(200,60,60,.4)",color:"#FF5555",fontSize:10,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite",flexShrink:0,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Confirm?</button>
        )}
        {/* Mark to Reject in SingleOps — sends to pipeline with orange warning flag */}
        {onMarkReject && (!rejectConfirm ? (
          <button onClick={()=>setRejectConfirm(true)} title="Flag: reject in SingleOps" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:"transparent",border:"1px solid #3a2810",cursor:"pointer",flexShrink:0}}>
            <IconNoSymbol size={15} color="#a07030"/>
          </button>
        ) : (
          <button onClick={()=>{setRejectConfirm(false);onMarkReject();}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"rgba(255,140,0,.25)",border:"1px solid rgba(255,140,0,.5)",color:"#FF8C00",fontSize:9,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite",flexShrink:0,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",whiteSpace:"nowrap"}}><IconNoSymbol size={13} color="#FF8C00"/>REJECT?</button>
        ))}
        <button onClick={handleDone} style={{display:"flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:8,background:"#10B981",border:"none",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,flexShrink:0}}><IconCheckCircle size={13} color="#fff"/>DONE</button>
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
          <div style={{fontSize:16,fontWeight:700,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.2,marginBottom:3}}>{s.cn}</div>
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
          <button onClick={() => setShowParcelMap(true)} style={{display:"flex",alignItems:"center",gap:5,marginTop:8,padding:"6px 11px",borderRadius:8,background:"rgba(255,214,0,.08)",border:"1px solid rgba(255,214,0,.25)",color:"#FFD600",fontSize:11,fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",cursor:"pointer"}}>
            <IconMapPin size={13} color="#FFD600"/>Parcel Map
          </button>
        </div>

        {/* ── PROPERTY MEMORY ────────────────────────────────────────── */}
        {propertyHistory.length > 0 && (
          <div style={{borderBottom:"1px solid #1a2030",background:"rgba(139,92,246,.03)"}}>
            <button onClick={()=>setHistoryOpen(!historyOpen)} style={{width:"100%",padding:"9px 16px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:historyOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7,color:"#8B5CF6"}}>▶</span>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span style={{fontSize:10,fontWeight:700,color:"#8B5CF6",letterSpacing:1,textTransform:"uppercase",fontFamily:F}}>Property History</span>
              <span style={{fontSize:9,color:"#6B46C1",padding:"1px 6px",borderRadius:999,background:"rgba(139,92,246,.12)",border:"1px solid rgba(139,92,246,.2)",fontWeight:700}}>{propertyHistory.length}</span>
              {!historyOpen && <span style={{flex:1,fontSize:11,color:"#7060a0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginLeft:4}}>{propertyHistory[0].cn} · {propertyHistory[0].stage?.replace(/_/g," ")}</span>}
            </button>
            {historyOpen && (
              <div style={{padding:"0 16px 12px",display:"flex",flexDirection:"column",gap:6}}>
                {propertyHistory.map(c => {
                  const stageColors = { sold:"#10B981", declined:"#ef4444", estimate_needed:"#3B82F6", weak:"#FF8A65", waiting:"#F6BF26" };
                  const col = stageColors[c.stage] || "#7a8aaa";
                  const ageMs = Date.now() - (c.stageChangedAt || c.addedAt || 0);
                  const ageDays = Math.round(ageMs / 86400000);
                  const ageStr = ageDays < 30 ? `${ageDays}d ago` : ageDays < 365 ? `${Math.round(ageDays/30)}mo ago` : `${Math.round(ageDays/365)}yr ago`;
                  return (
                    <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:8,background:"#0d0f1a",border:"1px solid #1a2035"}}>
                      <div style={{width:7,height:7,borderRadius:99,background:col,flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:700,color:"#c8d0e8",fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{c.cn}</div>
                        <div style={{fontSize:10,color:"#5a6a8a",marginTop:1}}>{c.addr}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:10,color:col,fontWeight:700,textTransform:"uppercase",fontFamily:F}}>{c.stage?.replace(/_/g," ")}</div>
                        <div style={{fontSize:9,color:"#4a5a70"}}>{ageStr}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── JOB NOTES (collapsible, always shows preview) ─────────── */}
        {s.notes && (
          <div style={{borderBottom:"1px solid #1a2030"}}>
            <button onClick={()=>setJobNotesOpen(!jobNotesOpen)} style={{width:"100%",padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:6,textAlign:"left"}}>
              <span style={{transform:jobNotesOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7,color:"#4a5a70"}}>▶</span>
              <span style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F}}>JOB NOTES</span>
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="#3a4a60" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              {!jobNotesOpen && <span style={{flex:1,fontSize:12,color:"#8898a8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginLeft:4}}>{s.notes.length > 80 ? s.notes.slice(0,80) + "…" : s.notes}</span>}
            </button>
            {jobNotesOpen && <div style={{padding:"0 16px 12px",fontSize:13,color:"#8898a8",lineHeight:1.6}}><Linkify text={s.notes} linkColor="#7BB3FF"/></div>}
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
              <div key={photoKey(p)||i} style={{display:"flex",flexDirection:"column",gap:3}}>
                <div style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                  <img src={p.url || p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("scope");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                  <button onClick={e=>{e.stopPropagation();removeScopePhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                  <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                    <div onClick={()=>{setMarkupIdx(i);setMarkupSection("scope");}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={12} color="#ccc"/></div>
                    <button onClick={e=>{e.stopPropagation();downloadPhoto(p,`scope_${i+1}.jpg`,`scope_${i}`);}} disabled={dlSet.has(`scope_${i}`)} style={{padding:"5px 10px",borderRadius:6,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",opacity:dlSet.has(`scope_${i}`)?0.5:1}}><IconDownload size={13} color="#ccc"/></button>
                  </div>
                </div>
                {/* Zone tag */}
                <PhotoZoneTag zone={p.zone} onChange={zone => {
                  updateField(s.id, ex => {
                    const arr = ex.scopePhotos || ex.photos || [];
                    return { scopePhotos: arr.map((ph,j) => j===i ? {...ph,zone} : ph) };
                  }).catch(()=>{});
                  setScopePhotos(prev => prev.map((ph,j) => j===i ? {...ph,zone} : ph));
                }} />
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
              <div key={photoKey(p)||i} style={{display:"flex",flexDirection:"column",gap:3}}>
                <div style={{position:"relative",width:140,height:140,borderRadius:10,overflow:"hidden",border:"1px solid #1a2540"}}>
                  <img src={p.url || p.dataUrl} alt="" onClick={() => {setMarkupIdx(i);setMarkupSection("addon");}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                  <button onClick={e=>{e.stopPropagation();removeAddonPhoto(i);}} style={{position:"absolute",top:4,right:4,width:24,height:24,borderRadius:12,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={12} color="#ff6666"/></button>
                  <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:4}}>
                    <div onClick={()=>{setMarkupIdx(i);setMarkupSection("addon");}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={12} color="#ccc"/></div>
                    <button onClick={e=>{e.stopPropagation();downloadPhoto(p,`addon_${i+1}.jpg`,`addon_${i}`);}} disabled={dlSet.has(`addon_${i}`)} style={{padding:"5px 10px",borderRadius:6,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",opacity:dlSet.has(`addon_${i}`)?0.5:1}}><IconDownload size={13} color="#ccc"/></button>
                  </div>
                </div>
                <PhotoZoneTag zone={p.zone} onChange={zone => {
                  updateField(s.id, ex => {
                    const arr = ex.addonPhotos || [];
                    return { addonPhotos: arr.map((ph,j) => j===i ? {...ph,zone} : ph) };
                  }).catch(()=>{});
                  setAddonPhotos(prev => prev.map((ph,j) => j===i ? {...ph,zone} : ph));
                }} />
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
          <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:5}}>VIDEO{videoQueueItems.length > 0 && <span style={{fontSize:9,color:"#F6BF26",fontWeight:700,padding:"1px 8px",borderRadius:10,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.2)",marginLeft:6,animation:"pulse 1s infinite"}}>↑ {videoQueueItems.length} pending</span>}</div>

          {/* Uploaded videos list */}
          {videoUrls.length > 0 && <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
            {videoUrls.map((url, idx) => {
              const ytId    = getYtId(url);
              const driveId = getDriveFileId(url);
              // Rebuild the watch link fresh from driveId — fixes older cards that
              // saved a Drive /preview link (the "No preview available" iframe).
              const shareLink = driveId ? buildShareUrl(driveId) : url;
              return (
                <div key={idx} style={{borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",overflow:"hidden"}}>
                  {ytId && <img src={`https://img.youtube.com/vi/${ytId}/mqdefault.jpg`} alt="" style={{width:"100%",height:90,objectFit:"cover"}} />}
                  {driveId && <video controls preload="metadata" src={buildStreamUrl(driveId)} style={{width:"100%",height:160,display:"block",background:"#000"}} />}
                  <div style={{padding:"6px 8px",display:"flex",alignItems:"center",gap:6}}>
                    <div style={{fontSize:9,color:"#5a6890",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{shareLink}</div>
                    {typeof navigator !== "undefined" && navigator.share && (
                      <button onClick={async () => {
                        const name = (s.cn || "").split(" ")[0];
                        try {
                          await navigator.share({
                            title: "Property Video Review",
                            text: name ? `${name}, here's your property video review from Monster Tree Service:` : "Your property video review from Monster Tree Service:",
                            url: shareLink,
                          });
                        } catch { /* user dismissed the share sheet */ }
                      }} style={{padding:"4px 8px",borderRadius:5,background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.3)",color:"#10B981",fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>Share</button>
                    )}
                    <button onClick={() => {
                      const html = `<a href="${shareLink}">Link to Video Review</a>`;
                      if (navigator.clipboard?.write) {
                        navigator.clipboard.write([new ClipboardItem({
                          "text/html": new Blob([html], {type:"text/html"}),
                          "text/plain": new Blob([shareLink], {type:"text/plain"}),
                        })]).catch(()=>navigator.clipboard?.writeText(shareLink));
                      } else { navigator.clipboard?.writeText(shareLink); }
                    }} style={{padding:"4px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#5a90b0",fontSize:10,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>Copy link</button>
                    <button onClick={() => deleteVideo(url, idx)} style={{padding:"4px 6px",borderRadius:5,background:"rgba(200,60,60,.08)",border:"1px solid rgba(200,60,60,.15)",color:"#e06060",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}>
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
                {videoQueueItems.length} pending {queuePaused ? "• PAUSED" : ""}
              </span>
              <button onClick={() => setShowQueuePanel(v=>!v)} style={{padding:"2px 8px",borderRadius:5,background:"transparent",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5}}>
                {showQueuePanel ? "HIDE" : "SHOW"}
              </button>
            </div>
            {showQueuePanel && <>
              {/* Pause/resume toggle */}
              <div style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:6,borderBottom:"1px solid rgba(246,191,38,.1)"}}>
                <button onClick={() => { setVideoQueuePaused(!queuePaused); setQueuePausedState(!queuePaused); }} style={{padding:"4px 10px",borderRadius:5,background:queuePaused?"rgba(246,191,38,.15)":"rgba(16,185,129,.1)",border:`1px solid ${queuePaused?"rgba(246,191,38,.4)":"rgba(16,185,129,.3)"}`,color:queuePaused?"#F6BF26":"#10B981",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
                  {queuePaused ? "▶ RESUME UPLOADS" : "⏸ PAUSE UPLOADS"}
                </button>
              </div>
              {videoQueueItems.map(it => {
                const sizeMB = (it.fileSize / (1024*1024)).toFixed(1);
                const statusColor = it.status === "error" ? "#FF5555" : it.status === "uploading" ? "#10B981" : "#7a7050";
                const statusLabel =
                  it.status === "queued" ? "Waiting…" :
                  it.status === "uploading" ? `Uploading ${it.progress||0}%` :
                  it.status === "error" ? "Failed" : it.status;
                return (
                  <div key={it.id} style={{padding:"8px 10px",borderTop:"1px solid rgba(246,191,38,.06)"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <div style={{flex:1,minWidth:0,fontSize:11,color:"#c0c8d0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.title}</div>
                      <span style={{fontSize:9,color:statusColor,fontWeight:800,fontFamily:F,letterSpacing:0.4,textTransform:"uppercase",flexShrink:0}}>{statusLabel}</span>
                    </div>
                    <div style={{height:3,background:"rgba(255,255,255,.05)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
                      <div style={{height:"100%",width:`${it.progress||0}%`,background:statusColor,transition:"width .3s"}}/>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{flex:1,fontSize:9,color:"#5a6580",fontFamily:F,letterSpacing:0.3}}>
                        {sizeMB}MB
                      </div>
                      {(it.status === "error" || it.status === "uploading") && (
                        <button onClick={() => retryVideoQueueItem(it.id)} style={{padding:"3px 8px",borderRadius:5,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
                          {it.status === "uploading" ? "Restart" : "Retry"}
                        </button>
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

          {/* Record in-app — capped to ~720p/1.5Mbps so uploads stay fast over cellular */}
          <button onClick={() => setShowVideoRecorder(true)} style={{width:"100%",padding:"11px 0",borderRadius:8,background:"rgba(255,59,48,.08)",border:"1px solid rgba(255,59,48,.3)",color:"#FF6B5E",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <IconVideo size={15} color="#FF6B5E"/><span>{(videoUrls.length + videoQueueItems.length) > 0 ? `Record another video (${videoUrls.length + videoQueueItems.length + 1})` : "Record Video"}</span>
          </button>
          <input ref={ytFileRef} type="file" accept="video/*" onChange={handleYtFile} style={{display:"none"}} />
          <button onClick={() => ytFileRef.current?.click()} style={{width:"100%",padding:"9px 0",marginTop:6,borderRadius:8,background:"transparent",border:"1px solid #1a2540",color:"#5a7090",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <IconVideo size={13} color="#5a7090"/><span>Choose from Library</span>
          </button>
          <div style={{marginTop:6,fontSize:9,lineHeight:1.4,color:"#5a6580",fontFamily:F,letterSpacing:0.2,textAlign:"center"}}>
            Library imports upload faster at <strong style={{color:"#8a93a8"}}>1080p</strong> (iPhone Settings → Camera → Record Video) than 4K.
          </div>
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
        <button onClick={handleDone} style={{flex:3,padding:"12px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconCheckCircle size={18} color="#10B981"/><span style={{fontSize:13,color:"#10B981",fontWeight:800,fontFamily:F,letterSpacing:0.5}}>DONE</span></button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Module-level photo processor — lives OUTSIDE React so FileReader + canvas
   work completes even if OnsiteWindow unmounts (user taps Done mid-pick).
   The photo is written to IndexedDB immediately via fieldStore's shared
   per-stop write queue (updateField), so it cannot race with the auto-save
   effect, the remove handlers, or photoSync's upload-completion writes.
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
        const photo = { dataUrl: c.toDataURL("image/jpeg", 0.82), ts: Date.now(), id: newPhotoId() };
        // updateField is queued per-stop in fieldStore, so this composes
        // safely with concurrent text saves and other photo ops.
        try {
          await updateField(stopId, (existing) => {
            const key = section === "addon" ? "addonPhotos" : "scopePhotos";
            const existingPhotos = existing[key] || existing.photos || [];
            return { [key]: [...existingPhotos, photo] };
          });
          markStopForPhotoSync(stopId);
        } catch (e) { console.warn("Photo background save failed:", e); }
        resolve(photo);
      };
      img.onerror = () => resolve(null);
      img.src = ev.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
