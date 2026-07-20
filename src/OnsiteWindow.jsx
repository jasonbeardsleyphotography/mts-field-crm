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
  deleteItem as deleteVideoQueueItem,
  markSavedToDevice,
} from "./videoQueue";
import { saveVideoToDevice } from "./videoSave";
import { SINGLEOPS_ITEMS, SINGLEOPS_JOB_TAGS, SINGLEOPS_JOB_TAG_GROUPS } from "./singleOpsCatalog";
import { IconArrowLeft, IconRefresh, IconCamera, IconImage, IconDownload, IconPen, IconEraser, IconSparkles, IconVideo, IconMail, IconX, IconZap, IconClipboard, IconPhone, IconMessageSquare, IconNavigation, IconCheckCircle, IconSend, IconNoSymbol, IconMapPin } from "./icons";

const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const SINGLEOPS_URL = "https://app.singleops.com/";
// Photos are appended by several independent async paths (camera capture,
// library import, parcel-map snapshot) that can each take a different amount
// of time to downscale/save — two photos taken back-to-back can finish
// processing in the OPPOSITE order they were taken, landing out of sequence
// in the array. Since nothing sorts at render time, that scramble was
// directly visible. Sorting by `ts` (set synchronously at capture, not at
// resolution) after every append guarantees chronological order regardless
// of which async op finishes first. Used both in-component and by the
// module-level _processPhoto below, so it's a plain top-level function.
function sortPhotosByTs(arr) {
  return [...arr].sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));
}
// Lowercased lookup so the AI's item pick (which can drift in case/whitespace)
// still resolves to the exact catalog string SingleOps expects.
const SINGLEOPS_ITEMS_LOWER = new Map(SINGLEOPS_ITEMS.map(i => [i.toLowerCase(), i]));
function resolveCatalogItem(name) {
  if (!name) return "";
  const exact = SINGLEOPS_ITEMS_LOWER.get(String(name).trim().toLowerCase());
  return exact || "";
}

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

// Lightweight typeahead over the ~450-item SingleOps catalog — used both to
// fix an AI mismatch and to add a line item manually with zero AI cost.
// Native <select>/<datalist> were considered but a custom filtered list is
// far more reliable cross-browser (iOS Safari's datalist support is poor).
function CatalogPicker({ value, onChange, placeholder = "Search catalog…" }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);
  useEffect(() => { setQuery(value || ""); }, [value]);
  const matches = query.trim().length >= 2
    ? SINGLEOPS_ITEMS.filter(i => i.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8)
    : [];
  return (
    <div style={{position:"relative"}}>
      <input
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        style={{width:"100%",boxSizing:"border-box",padding:"7px 9px",borderRadius:7,background:"#0a0c14",border:"1px solid rgba(59,130,246,.35)",color:"#e0e8f0",fontSize:11,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none"}}
      />
      {open && matches.length > 0 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:20,marginTop:2,background:"#141826",border:"1px solid #253049",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,.5)",maxHeight:200,overflowY:"auto"}}>
          {matches.map(m => (
            <button key={m} onMouseDown={e => e.preventDefault()} onClick={() => { onChange(m); setQuery(m); setOpen(false); }}
              style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",background:"transparent",border:"none",borderBottom:"1px solid #1a2035",color:"#c8d0e0",fontSize:11,cursor:"pointer"}}>
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// This is now the SINGLE shared editing screen for a stop/card — both the
// Route "swipe a card off the route" flow AND the Pipeline card detail view
// render this same component, so the two can never drift out of sync again
// the way they had been. `backLabel` and `topBar` are the two extension
// points Pipeline uses to layer its own chrome (stage-move bar, repeat-client
// banner, etc. — concepts that don't exist in Route) around the identical
// shared editor beneath.
export default function OnsiteWindow({ stop, onBack, onDone, onDecline, onMarkReject, onEditDetails, token, backLabel = "Route", topBar = null, belowScopePhotosSlot = null, bottomExtra = null }) {
  const s = stop;
  // Synchronous peek for initial state — returns {} or the localStorage
  // mirror if one exists. The real async load runs below and hydrates.
  const fd = peekField(s.id);
  // Backward compat: migrate old myNotes/photos to scope
  const [scopeNotes, setScopeNotes] = useState(fd.scopeNotes || fd.myNotes || "");
  const [addonNotes, setAddonNotes] = useState(fd.addonNotes || "");
  // Structured line items extracted (on-demand, AI-assisted) from the free-text
  // notes above. Free text stays the source of truth — these are a machine-
  // readable summary of it, meant to feed future automation (proposal
  // building, etc.) without requiring separate data entry.
  const [lineItems, setLineItems] = useState(fd.lineItems || []);
  const [suggestedItems, setSuggestedItems] = useState([]); // pending AI suggestions awaiting tap-to-confirm
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractError, setExtractError] = useState(null);
  // Per-JOB tags (equipment/crew/access/scheduling) — matches SingleOps's own
  // tag list, applied once to the whole visit, not per line item.
  const [jobTags, setJobTags] = useState(fd.jobTags || []);
  const [suggestedTags, setSuggestedTags] = useState([]);
  const [tagSuggestLoading, setTagSuggestLoading] = useState(false);
  // sortPhotosByTs on initial load too, so any photo array already saved
  // out of order (from before this ordering fix existed) self-corrects the
  // moment the card is opened, not just for newly-added photos.
  const [scopePhotos, setScopePhotos] = useState(() => sortPhotosByTs(fd.scopePhotos || fd.photos || []));
  const [addonPhotos, setAddonPhotos] = useState(() => sortPhotosByTs(fd.addonPhotos || []));
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
  const [saveSafetyPrompt, setSaveSafetyPrompt] = useState(null); // { id, file } just-recorded video awaiting a durable save
  const [videoSavedToast, setVideoSavedToast] = useState(false);
  const [savingVideo, setSavingVideo] = useState(false);
  // Editing the stop's own contact/address details, in place in the header.
  const [editingDetails, setEditingDetails] = useState(false);
  const [editCn, setEditCn] = useState(s.cn || "");
  const [editAddr, setEditAddr] = useState(s.addr || "");
  const [editPhone, setEditPhone] = useState(s.phone || "");
  const [editEmail, setEditEmail] = useState(s.email || "");
  const [editJn, setEditJn] = useState(s.jn || "");
  const openEditDetails = () => {
    setEditCn(s.cn || ""); setEditAddr(s.addr || ""); setEditPhone(s.phone || "");
    setEditEmail(s.email || ""); setEditJn(s.jn || "");
    setEditingDetails(true);
  };
  const saveEditDetails = () => {
    onEditDetails && onEditDetails({
      cn: editCn.trim(), addr: editAddr.trim(),
      phone: editPhone.trim(), email: editEmail.trim(), jn: editJn.trim(),
    });
    setEditingDetails(false);
  };
  // (formerly: ytUploadCount — now tracked entirely via videoQueueItems)
  const mountedRef = useRef(true);
  const stopIdRef = useRef(s.id);

  const [aiScopeResult, setAiScopeResult] = useState(fd.aiScopeSummary || "");
  const [aiAddonResult, setAiAddonResult] = useState(fd.aiAddonEmail || "");
  const [aiScopeLoading, setAiScopeLoading] = useState(false);
  const [aiAddonLoading, setAiAddonLoading] = useState(false);
  const [declineConfirm, setDeclineConfirm] = useState(false);
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [jobNotesOpen, setJobNotesOpen] = useState(false);


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
      lineItems,
      jobTags,
      aiScopeSummary: aiScopeResult,
      aiAddonEmail: aiAddonResult,
      // Persist client name + job # so the background photo uploader (which
      // only has the stop id) can name files after the client, like videos do.
      cn: s.cn,
      jn: s.jn,
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
          lineItems: latest.lineItems,
          jobTags: latest.jobTags,
          aiScopeSummary: latest.aiScopeSummary,
          aiAddonEmail: latest.aiAddonEmail,
          cn: s.cn,
          jn: s.jn,
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
  }, [hydrated, scopeNotes, addonNotes, scopePhotos, addonPhotos, videoUrls, audioClips, lineItems, jobTags, aiScopeResult, aiAddonResult, s.id, token]);

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
        lineItems: d.lineItems,
        jobTags: d.jobTags,
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
          lineItems: d.lineItems,
          jobTags: d.jobTags,
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
        const idbLineItems = data.lineItems || [];
        const idbJobTags = data.jobTags || [];

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
        if (idbLineItems.length)   setLineItems(prev => mergeByKey(idbLineItems, prev, li => li.id));
        if (idbJobTags.length)     setJobTags(prev => Array.from(new Set([...idbJobTags, ...prev])));

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
      (fd.scopePhotos || fd.photos || []).length || fd._scopePhotoCount || fd._addonPhotoCount || (fd.lineItems || []).length || (fd.jobTags || []).length);
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
          lineItems:   mergeByKey(cloud.lineItems, local.lineItems, li => li.id),
          jobTags:     Array.from(new Set([...(cloud.jobTags || []), ...(local.jobTags || [])])),
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
        if (merged.lineItems?.length) setLineItems(prev => mergeByKey(merged.lineItems, prev, li => li.id));
        if (merged.jobTags?.length) setJobTags(prev => Array.from(new Set([...merged.jobTags, ...prev])));
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
          const exLineItems = ex.lineItems || [];
          const exJobTags = ex.jobTags || [];
          return {
            ...merged,
            scopePhotos: mergeByKey(merged.scopePhotos || [], exScope, photoKey),
            addonPhotos: mergeByKey(merged.addonPhotos || [], exAddon, photoKey),
            audioClips:  mergeByKey(merged.audioClips  || [], exAudio, a => a.ts || a.timestamp || a.url),
            videoUrls:   Array.from(new Set([...(merged.videoUrls || []), ...exVids])),
            lineItems:   mergeByKey(merged.lineItems || [], exLineItems, li => li.id),
            jobTags:     Array.from(new Set([...(merged.jobTags || []), ...exJobTags])),
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
      if (section === "addon") setAddonPhotos(prev => sortPhotosByTs([...prev, photo]));
      else setScopePhotos(prev => sortPhotosByTs([...prev, photo]));
      // Immediate, serialized Drive sync — see camera onPhoto for the rationale.
      if (token) queueFieldDriveSync(token, s.id);
    });
  };
  const handleScopePhotos = (e) => { Array.from(e.target.files || []).forEach(f => processPhoto(f, "scope")); e.target.value = ""; };

  // Single Library picker accepts BOTH photos and videos — routes each file
  // by its actual MIME type instead of making the user pick a separate
  // "photo library" vs "video library" button for what's the same OS picker.
  const handleScopeLibraryFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    let videoSeq = videoUrls.length + videoQueueItems.length;
    for (const file of files) {
      if (file.type.startsWith("video/")) {
        videoSeq++;
        const lastName = (s.cn || "").split(" ").pop();
        const jobPart = s.jn ? ` #${s.jn}` : "";
        const datePart = new Date().toLocaleDateString("en-US", {month:"2-digit",day:"2-digit",year:"numeric"});
        const title = `${lastName}${jobPart} ${datePart} - ${String(videoSeq).padStart(2,"0")}`;
        try {
          // Library imports are already safe — the original still lives in the
          // phone's Photos library — so mark them backed-up and skip the prompt.
          await enqueueVideo({ stopId: s.id, file, title, alreadyInLibrary: true });
        } catch (err) {
          console.warn("Failed to enqueue video:", err);
          alert("Failed to queue video: " + (err.message || err));
        }
      } else {
        processPhoto(file, "scope");
      }
    }
  };
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
    // Stash the pre-edit image the FIRST time a photo is marked up, so the
    // editor can offer "Revert to original" later (e.g. to undo accidental
    // pocket marks). Only set once — never overwrite with an annotated frame.
    const update = (p, i) => i === markupIdx
      ? { ...p, originalDataUrl: p.originalDataUrl || p.dataUrl, dataUrl, url: undefined }
      : p;
    if (markupSection === "addon") setAddonPhotos(prev => prev.map(update));
    else setScopePhotos(prev => prev.map(update));
    // Write through to IDB by stable key match (not index — IDB ordering
    // may differ from state ordering).
    if (key !== null) {
      const arrKey = markupSection === "addon" ? "addonPhotos" : "scopePhotos";
      updateField(s.id, (existing) => ({
        [arrKey]: (existing[arrKey] || existing.photos || []).map(p =>
          photoKey(p) === key ? { ...p, originalDataUrl: p.originalDataUrl || p.dataUrl, dataUrl, url: undefined } : p
        ),
      })).catch(() => {});
    }
    markStopForPhotoSync(s.id);
    setMarkupIdx(null);
  };

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

  useEffect(() => {
    let alive = true;
    listVideoQueueForStop(s.id).then(items => { if (alive) setVideoQueueItems(items); });
    const off = onVideoQueueChange((all) => {
      if (alive) setVideoQueueItems(all.filter(i => i.stopId === s.id));
    });
    return () => { alive = false; off(); };
  }, [s.id]);

  // Local preview for still-pending/failed videos: the raw file blob is
  // already in hand (from the live queue subscription above), so build an
  // object URL per item instead of waiting on the Drive upload to finish.
  // Cached by item id; revoked as soon as an id drops out of the queue
  // (uploaded, canceled, or removed) so blob URLs don't leak.
  const videoObjectUrlsRef = useRef(new Map());
  const [videoObjectUrls, setVideoObjectUrls] = useState(new Map());
  useEffect(() => {
    const cache = videoObjectUrlsRef.current;
    const liveIds = new Set(videoQueueItems.map(it => it.id));
    let changed = false;
    for (const it of videoQueueItems) {
      if (!cache.has(it.id) && it.file) {
        try { cache.set(it.id, URL.createObjectURL(it.file)); changed = true; } catch {}
      }
    }
    for (const id of [...cache.keys()]) {
      if (!liveIds.has(id)) {
        try { URL.revokeObjectURL(cache.get(id)); } catch {}
        cache.delete(id);
        changed = true;
      }
    }
    if (changed) setVideoObjectUrls(new Map(cache));
  }, [videoQueueItems]);
  // Revoke everything left when the stop screen unmounts.
  useEffect(() => () => {
    videoObjectUrlsRef.current.forEach(url => { try { URL.revokeObjectURL(url); } catch {} });
    videoObjectUrlsRef.current.clear();
  }, []);

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
            addonPhotos: sortPhotosByTs([...(existing.addonPhotos || []), photo]),
          }));
        } catch (e) { console.warn("Parcel snapshot IDB save failed:", e); }
        setAddonPhotos(prev => sortPhotosByTs([...prev, photo]));
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
            return { [key]: sortPhotosByTs([...existingPhotos, photo]) };
          });
        } catch (e) { console.warn("Camera photo IDB save failed:", e); }
        // Now reflect in component state so the UI updates
        if (cameraSection === "addon") setAddonPhotos(prev => sortPhotosByTs([...prev, photo]));
        else setScopePhotos(prev => sortPhotosByTs([...prev, photo]));
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
        const update = (p, i) => i === markupIdx
          ? { ...p, originalDataUrl: p.originalDataUrl || p.dataUrl, dataUrl, url: undefined }
          : p;
        if (markupSection === "addon") setAddonPhotos(prev => prev.map(update));
        else setScopePhotos(prev => prev.map(update));
        if (key !== null) {
          const arrKey = markupSection === "addon" ? "addonPhotos" : "scopePhotos";
          updateField(s.id, (existing) => ({
            [arrKey]: (existing[arrKey] || existing.photos || []).map(p =>
              photoKey(p) === key ? { ...p, originalDataUrl: p.originalDataUrl || p.dataUrl, dataUrl, url: undefined } : p
            ),
          })).catch(() => {});
        }
        markStopForPhotoSync(s.id);
      };
      return (
        <PhotoMarkup
          key={markupIdx}
          photoDataUrl={markupSrc}
          originalDataUrl={photos[markupIdx]?.originalDataUrl || null}
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

  // ── LINE ITEM EXTRACTION ────────────────────────────────────────────
  // Turns the free-text Scope/Add-on notes into structured, machine-readable
  // line items (action + target + qty + notes) — same manual-tap, same cheap
  // gemini-2.5-flash model as the AI Scope Summary / Add-on Email above. Never
  // runs automatically (not on typing, not on a timer, not per-photo) — only
  // when the user taps the button, exactly like the two calls above it. The
  // free-text notes remain the source of truth; this is a derived, editable
  // summary of them meant to feed future automation (e.g. proposal building)
  // without requiring separate manual data entry in the field.
  const extractLineItems = async () => {
    if (!GEMINI_KEY) { setExtractError("Add VITE_GEMINI_KEY to .env"); return; }
    const combined = `${scopeNotes || ""}\n${addonNotes || ""}`.trim();
    if (!combined) { setExtractError("Add some scope or add-on notes first."); return; }
    setExtractLoading(true);
    setExtractError(null);
    try {
      // The full real SingleOps catalog is handed to the model so it matches
      // against Jason's ACTUAL billable items — not a made-up category. ~450
      // items is only a few thousand tokens, trivial cost on gemini-2.5-flash.
      const raw = await callGemini(`You are an ISA-certified arborist's field assistant. Read these field notes and extract each distinct piece of work as a structured line item, matched against the company's real SingleOps catalog. Respond with ONLY a JSON array — no markdown fences, no prose, no explanation.

Each item must have exactly these fields:
- "item": the SINGLE closest matching name from the CATALOG list below, copied EXACTLY as it appears there (character-for-character). If nothing in the catalog is a reasonable match, use "" (empty string) — do NOT invent a name or force a bad match.
- "target": short label for the tree/plant/area this work applies to (e.g. "Sugar Maple", "Arborvitae hedge") — this is the SPECIES/TARGET, separate from the catalog item name.
- "location": short location on the property, or "" if not mentioned (e.g. "Front yard", "Left of driveway")
- "qty": a number (default 1 if not stated)
- "notes": a short phrase capturing any extra detail (specific limbs, condition, "quote only", etc.)

Only include items that describe actual billable tree/plant work — skip general commentary. If nothing qualifies, return [].

CATALOG (pick "item" only from this exact list, or ""):
${SINGLEOPS_ITEMS.join(" | ")}

Field notes:
${combined}`);
      let items;
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        items = JSON.parse(cleaned);
        if (!Array.isArray(items)) throw new Error("not an array");
      } catch {
        setExtractError("Couldn't read the AI's response — try again.");
        setExtractLoading(false);
        return;
      }
      const existingKeys = new Set(lineItems.map(li => `${li.item}|${li.target}|${li.location}|${li.notes}`.toLowerCase()));
      const fresh = items
        .filter(it => it && it.target)
        .map((it, i) => ({
          id: `li_${Date.now()}_${i}`,
          // Re-resolve against the catalog ourselves rather than trusting the
          // model's casing/whitespace verbatim — guarantees an exact match to
          // what's actually in SingleOps, or "" (shown as unmatched) if it drifted.
          item: resolveCatalogItem(it.item),
          target: String(it.target).slice(0, 60),
          location: String(it.location || "").slice(0, 60),
          qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
          notes: String(it.notes || "").slice(0, 200),
        }))
        // Skip items that look identical to ones already confirmed, so re-running
        // extraction after adding a sentence doesn't re-suggest everything.
        .filter(it => !existingKeys.has(`${it.item}|${it.target}|${it.location}|${it.notes}`.toLowerCase()));
      setSuggestedItems(fresh);
      if (fresh.length === 0 && items.length > 0) setExtractError("No new items — everything found is already in your list.");
    } catch(e) {
      setExtractError("Extraction failed: " + e.message);
    }
    setExtractLoading(false);
  };

  // ── JOB TAGS: AI-assisted suggestion from the same real SingleOps tag
  // list, tap-to-confirm, same manual-only cost pattern as everything above.
  const suggestJobTags = async () => {
    if (!GEMINI_KEY) { setExtractError("Add VITE_GEMINI_KEY to .env"); return; }
    const combined = `${scopeNotes || ""}\n${addonNotes || ""}`.trim();
    if (!combined) { setExtractError("Add some scope or add-on notes first."); return; }
    setTagSuggestLoading(true);
    try {
      const tagList = SINGLEOPS_JOB_TAGS.map(t => t.tag).join(" | ");
      const raw = await callGemini(`You are a tree service dispatcher. Read these field notes and pick any tags from the CATALOG below that clearly apply to this job (equipment needed, access/site conditions, scheduling flags). Respond with ONLY a JSON array of exact tag strings from the list — no markdown, no prose. Only include tags with clear textual support in the notes (e.g. mentions of a crane, poison ivy, a septic system, a specific crew size). Do NOT guess crew size or equipment unless stated or clearly implied. If nothing applies, return [].

CATALOG:
${tagList}

Field notes:
${combined}`);
      let tags;
      try {
        const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        tags = JSON.parse(cleaned);
        if (!Array.isArray(tags)) throw new Error("not an array");
      } catch { setTagSuggestLoading(false); return; }
      const validTags = new Set(SINGLEOPS_JOB_TAGS.map(t => t.tag));
      const fresh = tags.filter(t => validTags.has(t) && !jobTags.includes(t));
      setSuggestedTags(fresh);
    } catch {}
    setTagSuggestLoading(false);
  };
  const toggleJobTag = (tag) => setJobTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const acceptSuggestedTag = (tag) => { setJobTags(prev => [...prev, tag]); setSuggestedTags(prev => prev.filter(t => t !== tag)); };
  const acceptAllSuggestedTags = () => { setJobTags(prev => Array.from(new Set([...prev, ...suggestedTags]))); setSuggestedTags([]); };

  const acceptSuggestedItem = (id) => {
    const item = suggestedItems.find(it => it.id === id);
    if (!item) return;
    setLineItems(prev => [...prev, item]);
    setSuggestedItems(prev => prev.filter(it => it.id !== id));
  };
  const acceptAllSuggested = () => {
    setLineItems(prev => [...prev, ...suggestedItems]);
    setSuggestedItems([]);
  };
  const dismissSuggestedItem = (id) => setSuggestedItems(prev => prev.filter(it => it.id !== id));
  const removeLineItem = (id) => setLineItems(prev => prev.filter(it => it.id !== id));
  const updateLineItem = (id, patch) => setLineItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  const updateSuggestedItem = (id, patch) => setSuggestedItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  const addManualLineItem = () => setLineItems(prev => [...prev, { id: `li_${Date.now()}_m`, item: "", target: "", location: "", qty: 1, notes: "" }]);
  // Composed, copy-ready Target string matching how SingleOps actually
  // displays it (qty + location + species), e.g. "1 Front Middle Pin Oak".
  const targetString = (it) => [it.qty > 1 ? it.qty : null, it.location, it.target].filter(Boolean).join(" ");

  // ── VIDEO: enqueue for background upload to Google Drive via videoQueue ──
  // The actual upload (chunked PUT to Drive) runs entirely inside videoQueue.js,
  // persisted to its own IndexedDB store. By the time enqueueVideo() resolves
  // the file is safely written to IDB and will upload on the next opportunity,
  // even if the app is closed and reopened. Drive URLs are saved to the card
  // as google.com/file/d/{id}/preview links, which work in any browser.
  // (State hooks for videoQueueItems / uploadMode live above the early
  //  returns, in the hook section, per Rules of Hooks.)

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

  const handleRecordedVideo = async (file) => {
    setShowVideoRecorder(false);
    try {
      const id = await enqueueVideo({ stopId: s.id, file, title: buildVideoTitle() });
      // The only copy of a fresh recording lives in app storage/memory, both of
      // which iOS can wipe. Immediately push the user to drop a durable copy in
      // their Photos library so the video can never be lost — regardless of
      // whether the upload ever succeeds.
      if (id) setSaveSafetyPrompt({ id, file });
    } catch (err) {
      console.warn("Failed to enqueue recorded video:", err);
      alert("Failed to queue video: " + (err.message || err));
    }
  };

  // Short WebAudio "success" chime — two quick ascending tones. No external
  // asset/network dependency, so it's instant and works offline.
  const playSavedChime = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [660, 990].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t0 = ctx.currentTime + i * 0.09;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.18);
      });
      setTimeout(() => { try { ctx.close(); } catch {} }, 500);
    } catch {}
  };

  const handleSafetySave = async () => {
    const p = saveSafetyPrompt;
    if (!p || savingVideo) return;
    setSavingVideo(true);
    try {
      // The iOS share sheet that follows (Save Video / AirDrop / etc.) is a
      // platform-level picker Apple requires for any web app writing to
      // Photos — there is no scriptable "just save it" API, so that one
      // dialog can't be removed. Everything on OUR side closes immediately
      // and cleanly the instant it reports success — no extra confirmation
      // step of our own.
      const ok = await saveVideoToDevice({ id: p.id, file: p.file });
      if (ok) {
        try { await markSavedToDevice(p.id); } catch {}
        setSaveSafetyPrompt(null);
        try { navigator.vibrate?.([15, 40, 15]); } catch {}
        playSavedChime();
        setVideoSavedToast(true);
        setTimeout(() => setVideoSavedToast(false), 2200);
      }
      // If not ok (user dismissed the share sheet), keep the prompt up so they
      // can try again — the whole point is not to let it slip by unsaved.
    } finally {
      setSavingVideo(false);
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
        scopeNotes, addonNotes, videoUrls, audioClips, lineItems, jobTags,
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
  // Two nested layers: an outer viewport-covering backdrop, and an inner
  // "shell" that holds the actual header/body/bottom-bar content. On phones
  // (the common case) the shell fills the backdrop edge-to-edge exactly like
  // before — zero visual change. Past a desktop-width breakpoint (see the
  // media query in the <style> block below), the backdrop dims to a
  // translucent overlay and the shell shrinks to a centered, rounded,
  // shadowed card — so on a wide monitor this reads as a popup floating
  // over the page behind it, not a screen stretched wall-to-wall. The
  // save-safety prompt / toast stay direct children of the OUTER backdrop
  // (not the shell) so they stay correctly full-viewport-centered
  // regardless of how narrow the shell gets.
  return (
    <div className="mts-onsite-backdrop" style={{position:"fixed",inset:0,zIndex:100,background:"#0a0b10",display:"flex",flexDirection:"column",overflow:"hidden"}}>

      {/* ── SAVE-TO-PHONE SAFETY PROMPT ────────────────────────────────────
          Fires right after every in-app recording. A fresh recording lives
          only in app storage/memory, both of which iOS can wipe — so we push
          the user to drop an un-losable copy in their Photos library before
          anything else. The upload still runs in the background regardless. */}
      {saveSafetyPrompt && (
        <div style={{position:"fixed",inset:0,zIndex:400,background:"rgba(0,0,0,.82)",backdropFilter:"blur(3px)",WebkitBackdropFilter:"blur(3px)",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{width:"100%",maxWidth:400,background:"#0e1220",border:"1px solid #253049",borderRadius:16,padding:"22px 20px",boxShadow:"0 20px 60px rgba(0,0,0,.6)"}}>
            <div style={{fontSize:34,textAlign:"center",marginBottom:8}}>🎬</div>
            <div style={{fontSize:17,fontWeight:900,color:"#e6ecf5",fontFamily:F,letterSpacing:0.5,textAlign:"center",textTransform:"uppercase",marginBottom:8}}>Save this video to your phone</div>
            <div style={{fontSize:13,color:"#9fb0c4",lineHeight:1.55,textAlign:"center",marginBottom:18}}>
              This keeps a permanent copy in your <b style={{color:"#cdd8e6"}}>Photos</b> so it can never be lost — even if the upload fails. It uploads in the background either way.
            </div>
            <button onClick={handleSafetySave} disabled={savingVideo} style={{width:"100%",padding:"14px 0",borderRadius:11,background:"#10B981",border:"none",color:"#04140d",fontSize:14,fontWeight:900,fontFamily:F,letterSpacing:0.8,textTransform:"uppercase",cursor:savingVideo?"default":"pointer",opacity:savingVideo?0.7:1,display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:10}}>
              {savingVideo ? "Saving…" : (<><IconDownload size={17} color="#04140d"/> Save to Phone</>)}
            </button>
            <button onClick={() => setSaveSafetyPrompt(null)} disabled={savingVideo} style={{width:"100%",padding:"9px 0",borderRadius:9,background:"transparent",border:"none",color:"#6a7688",fontSize:12,fontWeight:700,fontFamily:F,letterSpacing:0.4,cursor:savingVideo?"default":"pointer",opacity:savingVideo?0.5:1}}>
              Skip — rely on the upload only
            </button>
            <div style={{fontSize:10.5,color:"#c98a3a",textAlign:"center",marginTop:8,lineHeight:1.45}}>
              ⚠ If you skip and the upload fails, this video could be lost.
            </div>
          </div>
        </div>
      )}

      {/* Brief "video saved" confirmation — fires once saveVideoToDevice
          actually confirms the share/save completed, then auto-dismisses.
          Pairs with the chime + haptic in handleSafetySave. */}
      {videoSavedToast && (
        <div style={{position:"fixed",top:"max(70px, calc(env(safe-area-inset-top) + 60px))",left:"50%",transform:"translateX(-50%)",zIndex:410,display:"flex",alignItems:"center",gap:8,padding:"12px 20px",borderRadius:999,background:"#10B981",color:"#04140d",fontSize:13,fontWeight:900,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",boxShadow:"0 8px 24px rgba(16,185,129,.4)",pointerEvents:"none",animation:"vs-toast .25s ease-out"}}>
          <span style={{fontSize:16}}>👍</span> Video Saved!
        </div>
      )}
      <style>{`
@keyframes vs-toast{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
@media (min-width: 860px) {
  .mts-onsite-backdrop { background: rgba(0,0,0,.6) !important; padding: 3vh 24px; align-items: center; justify-content: center; }
  .mts-onsite-shell { max-width: 760px !important; max-height: 94vh !important; border-radius: 16px !important; border: 1px solid #1a2030; box-shadow: 0 24px 70px rgba(0,0,0,.65); }
}
`}</style>

      <div className="mts-onsite-shell" style={{display:"flex",flexDirection:"column",flex:1,width:"100%",height:"100%",background:"#0a0b10",fontFamily:B,color:"#f0f4fa",overflow:"hidden"}}>

      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",paddingTop:"max(10px,env(safe-area-inset-top))",background:"#0d0f18",borderBottom:"1px solid #1a1f2e",flexShrink:0}}>
        <button onClick={onBack} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:8,background:"transparent",border:"1px solid #252d47",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,flexShrink:0}}><IconArrowLeft size={13} color="#90a8c0"/>{backLabel}</button>
        {/* Cloud-save status. Green cloud = this stop is safely synced to the
            cloud; amber cloud + "SAVING" = saved on this device, still pushing up. */}
        <div title={cloudSynced ? "Saved to cloud" : "Saved on this device — still syncing to cloud"}
          style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={cloudSynced?"#10B981":"#F6BF26"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.5-1.5A4 4 0 0 0 6 19h11.5z"/>
          </svg>
          {!cloudSynced && <span style={{fontSize:9,fontWeight:800,color:"#F6BF26",fontFamily:F,letterSpacing:0.5}}>SAVING</span>}
        </div>
        <div style={{flex:1,minWidth:0}}/>
        {/* Decline — moved from bottom bar so it can't be hit when reaching for DONE */}
        {onDecline && (!declineConfirm ? (
          <button onClick={()=>setDeclineConfirm(true)} title="Decline lead" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"6px 8px",borderRadius:8,background:"transparent",border:"1px solid #252d47",cursor:"pointer",flexShrink:0}}><IconX size={15} color="#a06060"/></button>
        ) : (
          <button onClick={()=>{setDeclineConfirm(false);onDecline();}} style={{display:"flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:8,background:"rgba(200,60,60,.2)",border:"1px solid rgba(200,60,60,.4)",color:"#FF5555",fontSize:10,fontWeight:800,cursor:"pointer",animation:"pulse 1s infinite",flexShrink:0,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Confirm?</button>
        ))}
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

      {/* Extension slot for chrome that only makes sense in ONE calling
          context (e.g. Pipeline's stage-move bar) — absent (null) for Route,
          so Route's appearance is completely unchanged. */}
      {topBar}

      {/* ── SCROLLABLE BODY ────────────────────────────────────────────── */}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{flex:1,overflowY:"auto",paddingBottom:"max(80px,calc(70px + env(safe-area-inset-bottom)))",transform:`translateX(${swipeX}px)`,transition:swiping?"none":"transform .25s"}}>

        {cloudLoading && <div style={{padding:"12px 16px",background:"rgba(59,130,246,.06)",borderBottom:"1px solid rgba(59,130,246,.1)",fontSize:12,color:"#5a8ab0",display:"flex",gap:8,alignItems:"center"}}>
          <span style={{animation:"spin 1s linear infinite",display:"flex"}}><IconRefresh size={13} color="#5a8ab0"/></span> Loading from cloud...
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>}

        {swipeX < -30 && <div style={{position:"fixed",top:"50%",right:12,transform:"translateY(-50%)",padding:"10px 14px",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.3)",color:"#10B981",fontSize:12,fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",opacity:Math.min(Math.abs(swipeX)/120,1),zIndex:102}}>→ PIPELINE</div>}

        {/* Address + contact, all in one compact header block:
            Row 1: name/address/constraint (left) — phone/email (right)
            Row 2: job # (left) — Parcel Map (right), directly across from
                   each other so both fit on one line instead of Parcel Map
                   eating a whole extra bordered row of its own. */}
        <div style={{padding:"10px 16px",background:"#0d0f18",borderBottom:"1px solid #1a2030"}}>
          {editingDetails ? (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <input value={editCn} onChange={e=>setEditCn(e.target.value)} placeholder="Client name" style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:8,background:"#0a0c14",border:"1px solid #253049",color:"#fff",fontSize:13,fontFamily:B,outline:"none"}} />
              <input value={editAddr} onChange={e=>setEditAddr(e.target.value)} placeholder="Address" style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:8,background:"#0a0c14",border:"1px solid #253049",color:"#e0e8f0",fontSize:13,fontFamily:B,outline:"none"}} />
              <div style={{display:"flex",gap:8}}>
                <input value={editPhone} onChange={e=>setEditPhone(e.target.value)} placeholder="Phone" style={{flex:1,minWidth:0,boxSizing:"border-box",padding:"8px 10px",borderRadius:8,background:"#0a0c14",border:"1px solid #253049",color:"#e0e8f0",fontSize:13,fontFamily:B,outline:"none"}} />
                <input value={editEmail} onChange={e=>setEditEmail(e.target.value)} placeholder="Email" style={{flex:1,minWidth:0,boxSizing:"border-box",padding:"8px 10px",borderRadius:8,background:"#0a0c14",border:"1px solid #253049",color:"#e0e8f0",fontSize:13,fontFamily:B,outline:"none"}} />
              </div>
              <input value={editJn} onChange={e=>setEditJn(e.target.value)} placeholder="Job #" style={{width:"100%",boxSizing:"border-box",padding:"8px 10px",borderRadius:8,background:"#0a0c14",border:"1px solid #253049",color:"#7ec4ff",fontSize:13,fontFamily:B,outline:"none"}} />
              <div style={{display:"flex",gap:8,marginTop:2}}>
                <button onClick={()=>setEditingDetails(false)} style={{flex:1,padding:"8px 0",borderRadius:8,background:"transparent",border:"1px solid #252d47",color:"#90a8c0",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Cancel</button>
                <button onClick={saveEditDetails} style={{flex:1,padding:"8px 0",borderRadius:8,background:"#10B981",border:"none",color:"#04140d",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Save</button>
              </div>
            </div>
          ) : (
          <>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
            {/* Left: name + address */}
            <div style={{minWidth:0,flex:1}}>
              <div style={{fontSize:16,fontWeight:700,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.2,marginBottom:3}}>{s.cn}</div>
              <div style={{fontSize:12,color:"#96a2b4",fontFamily:F,textTransform:"uppercase",letterSpacing:1}}>{s.addr}</div>
              {s.constraint && (
                <div style={{fontSize:11,color:"#FF80AB",marginTop:2}}>{s.constraint}</div>
              )}
            </div>
            {/* Right: phone/email */}
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0,textAlign:"right",maxWidth:"50%"}}>
              {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{fontSize:12,color:"#a0b8d0",textDecoration:"none",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"}}>{s.phone}<IconPhone size={12} color="#a0b8d0"/></a>}
              {s.email && <a href={`mailto:${s.email}`} style={{fontSize:12,color:"#a0b8d0",textDecoration:"none",display:"flex",alignItems:"center",gap:4,maxWidth:"100%",minWidth:0}}><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.email}</span><IconMail size={12} color="#a0b8d0"/></a>}
            </div>
          </div>

          {/* Job # — edit — Parcel Map, all on one row */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginTop:10}}>
            {s.jn ? (
              <button onClick={() => { navigator.clipboard?.writeText(s.jn).catch(() => {}); window.open(SINGLEOPS_URL, "_blank"); }} title="Copy job # and open SingleOps" style={{display:"flex",alignItems:"center",gap:5,padding:"6px 14px",borderRadius:8,background:"rgba(96,181,255,.12)",border:"1px solid rgba(96,181,255,.4)",color:"#7ec4ff",fontSize:11,fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",cursor:"pointer",flexShrink:0,boxShadow:"0 0 12px rgba(96,181,255,.35)"}}>
                <IconClipboard size={13} color="#7ec4ff"/>#{s.jn}
              </button>
            ) : <div />}
            {onEditDetails && (
              <button onClick={openEditDetails} title="Edit client / address details" style={{display:"flex",alignItems:"center",justifyContent:"center",padding:6,borderRadius:8,background:"transparent",border:"1px solid #252d47",cursor:"pointer",flexShrink:0}}>
                <IconPen size={13} color="#90a8c0"/>
              </button>
            )}
            <button onClick={() => setShowParcelMap(true)} style={{display:"flex",alignItems:"center",gap:5,padding:"6px 14px",borderRadius:8,background:"rgba(255,214,0,.08)",border:"1px solid rgba(255,214,0,.25)",color:"#FFD600",fontSize:11,fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",cursor:"pointer",flexShrink:0}}>
              <IconMapPin size={13} color="#FFD600"/>Parcel Map
            </button>
          </div>
          </>
          )}
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
            {jobNotesOpen && <div style={{padding:"0 16px 12px",fontSize:13,color:"#8898a8",lineHeight:1.6}}><Linkify text={s.notes} linkColor="#7BB3FF"/></div>}
          </div>
        )}

        {/* ── SCOPE ────────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <textarea value={scopeNotes} onChange={e => setScopeNotes(e.target.value)} placeholder="Scope of work..." rows={5}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:10,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:14,fontFamily:B,lineHeight:1.6,resize:"vertical",outline:"none",transition:"border-color .15s"}} onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />

          {/* Single Library input handles BOTH photos and videos — routed by
              MIME type in handleScopeLibraryFiles, so there's one picker
              instead of separate photo/video library buttons. */}
          <input ref={scopeLibRef} type="file" accept="image/*,video/*" multiple onChange={handleScopeLibraryFiles} style={{display:"none"}} />
          <div style={{display:"flex",gap:6,marginTop:10}}>
            <button onClick={()=>{setCameraSection("scope");setShowCamera(true);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconCamera size={16} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Camera</span>
            </button>
            {/* Record Video — right alongside Camera, one tap away instead of
                a separate section scrolled below. */}
            <button onClick={() => setShowVideoRecorder(true)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(255,59,48,.06)",border:"1px dashed rgba(255,59,48,.3)",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:5}}>
              <IconVideo size={16} color="#FF6B5E"/><span style={{fontSize:11,color:"#FF6B5E",fontWeight:600}}>Video</span>
            </button>
          </div>
          <button onClick={()=>scopeLibRef.current?.click()} style={{width:"100%",padding:"8px 0",marginTop:6,borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <IconImage size={14} color="#5a7090"/><span style={{fontSize:11,color:"#5a7090",fontWeight:600}}>Library (photo or video)</span>
          </button>

          {/* Scope photos — shown below the capture/import controls. */}
          {scopePhotos.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:12}}>
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

          {/* Extension slot — Pipeline uses this for its Download All Photos
              button (individual JPGs, no zip), which has no Route equivalent.
              Rendered after the photo grid per request. Null on Route. */}
          {belowScopePhotosSlot}
        </div>

        {/* ── VIDEO ─────────────────────────────────────────────────── */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a2030"}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
            <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,flex:1}}>VIDEO</div>
            {/* Global upload pause/resume — applies to every stop's queue, not
                just this one — kept reachable but compact, no longer nested
                behind a SHOW/HIDE toggle. */}
            {videoQueueItems.length > 0 && (
              <button onClick={() => { setVideoQueuePaused(!queuePaused); setQueuePausedState(!queuePaused); }} title={queuePaused ? "Resume uploads" : "Pause uploads"} style={{padding:"3px 9px",borderRadius:999,background:queuePaused?"rgba(246,191,38,.15)":"rgba(16,185,129,.1)",border:`1px solid ${queuePaused?"rgba(246,191,38,.4)":"rgba(16,185,129,.3)"}`,color:queuePaused?"#F6BF26":"#10B981",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.4,textTransform:"uppercase",whiteSpace:"nowrap"}}>
                {queuePaused ? "▶ Resume" : "⏸ Pause"}
              </button>
            )}
          </div>

          {/* One merged, always-visible list: still-local (pending/uploading/
              error) videos first — since those need attention — then videos
              already safely uploaded to Drive. No collapsed/hidden section:
              a failed upload is never something you have to go dig for. */}
          {(videoQueueItems.length > 0 || videoUrls.length > 0) && (
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
              {videoQueueItems.map(it => {
                const sizeMB = (it.fileSize / (1024*1024)).toFixed(1);
                const statusColor =
                  it.status === "error" ? "#FF5555" :
                  it.status === "uploading" ? "#10B981" :
                  it.status === "local" ? "#8898a8" : "#7a7050";
                const statusLabel =
                  it.status === "queued" ? "Waiting…" :
                  it.status === "uploading" ? `Uploading ${it.progress||0}%` :
                  it.status === "error" ? "Failed" :
                  it.status === "local" ? "On this phone only" : it.status;
                const previewUrl = videoObjectUrls.get(it.id);
                return (
                  <div key={it.id} style={{borderRadius:8,background:"#0e1120",border:"1px solid rgba(246,191,38,.25)",overflow:"hidden"}}>
                    {previewUrl && <video controls preload="metadata" src={previewUrl} style={{width:"100%",height:160,display:"block",background:"#000"}} />}
                    <div style={{padding:"8px 10px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                        <div style={{flex:1,minWidth:0,fontSize:11,color:"#c0c8d0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.title}</div>
                        <span style={{fontSize:9,color:statusColor,fontWeight:800,fontFamily:F,letterSpacing:0.4,textTransform:"uppercase",flexShrink:0}}>{statusLabel}</span>
                      </div>
                      {/* At-risk banner: still only in evictable app storage AND no
                          durable phone copy. Loud until the user saves it or it
                          uploads — so a video can't silently slip away. */}
                      {!it.savedToDevice && (
                        <div style={{display:"flex",alignItems:"center",gap:6,margin:"2px 0 6px",padding:"5px 8px",borderRadius:6,background:"rgba(201,138,58,.12)",border:"1px solid rgba(201,138,58,.35)"}}>
                          <span style={{fontSize:12}}>⚠</span>
                          <span style={{flex:1,fontSize:9.5,color:"#e0a860",fontWeight:700,fontFamily:F,letterSpacing:0.3,lineHeight:1.35}}>Not backed up — save to your phone so it can't be lost</span>
                          <button onClick={async () => { const ok = await saveVideoToDevice(it); if (ok) { try { await markSavedToDevice(it.id); } catch {} } }} style={{padding:"3px 9px",borderRadius:5,background:"#c98a3a",border:"none",color:"#1a1206",fontSize:9,fontWeight:900,cursor:"pointer",fontFamily:F,letterSpacing:0.4,textTransform:"uppercase",whiteSpace:"nowrap"}}>Save now</button>
                        </div>
                      )}
                      <div style={{height:3,background:"rgba(255,255,255,.05)",borderRadius:2,overflow:"hidden",marginBottom:4}}>
                        <div style={{height:"100%",width:`${it.progress||0}%`,background:statusColor,transition:"width .3s"}}/>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{flex:1,fontSize:9,color:"#5a6580",fontFamily:F,letterSpacing:0.3,display:"flex",alignItems:"center",gap:4}}>
                          <span>{sizeMB}MB</span>
                          {it.savedToDevice && <span style={{color:"#10B981",fontWeight:800}} title="A copy is saved on your phone">✓ on phone</span>}
                        </div>
                        {/* Save the raw video to the phone (Photos/Files) — always
                            available so a failed upload can never strand the video. */}
                        <button onClick={async () => { const ok = await saveVideoToDevice(it); if (ok) { try { await markSavedToDevice(it.id); } catch {} } }} title="Save this video to your phone" style={{padding:"3px 8px",borderRadius:5,background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.3)",color:"#10B981",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",display:"flex",alignItems:"center",gap:3}}>
                          <IconDownload size={11} color="#10B981"/>Save
                        </button>
                        <button onClick={() => retryVideoQueueItem(it.id)} style={{padding:"3px 8px",borderRadius:5,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
                          {it.status === "uploading" ? "Restart" : it.status === "local" ? "Upload" : "Retry"}
                        </button>
                        {it.status === "local" ? (
                          <button onClick={() => { if(window.confirm("Permanently delete this video from the phone? This can't be undone — save it to Photos/Files first if you still need it.")) deleteVideoQueueItem(it.id); }} style={{padding:"3px 6px",borderRadius:5,background:"transparent",border:"1px solid #252d47",color:"#a06060",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,display:"flex",alignItems:"center"}}>
                            <IconX size={10} color="#a06060"/>
                          </button>
                        ) : (
                          <button onClick={() => { if(window.confirm("Stop uploading this video? It stays on this card so you can save it to your phone or upload it later.")) cancelVideoQueueItem(it.id); }} style={{padding:"3px 6px",borderRadius:5,background:"transparent",border:"1px solid #252d47",color:"#a06060",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,display:"flex",alignItems:"center"}}>
                            <IconX size={10} color="#a06060"/>
                          </button>
                        )}
                      </div>
                      {(it.status === "error" || it.status === "local") && <div style={{fontSize:9,color:"#9fb0c0",marginTop:3,fontFamily:F,lineHeight:1.5}}>{it.status === "error" ? "Upload failed, but the video is still saved on this phone." : "This video is kept on this phone."} Tap <b style={{color:"#10B981"}}>Save</b> to keep a copy in Photos/Files.</div>}
                      {it.error && <div style={{fontSize:9,color:"#FF8888",marginTop:3,fontFamily:F}}>{it.error}</div>}
                    </div>
                  </div>
                );
              })}
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
            </div>
          )}
        </div>

        {/* ADD-ON section removed per request. addonNotes/addonPhotos data
            (and its sync/hydration machinery) is left intact so nothing on
            OLD cards that already has add-on content is lost or orphaned —
            there is just no longer any UI here to add to or edit it. */}

        {/* ── LINE ITEMS ─────────────────────────────────────────────────
            Structured, machine-readable summary of the Scope/Add-on notes
            above, built by tapping "Extract" (AI-assisted, manual only —
            never runs automatically). Free text stays the source of truth;
            "item" is matched against the REAL SingleOps catalog (see
            singleOpsCatalog.js) so this is ready to feed proposal-building
            automation, not a made-up category. */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#3B82F6",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,flex:1}}>Line Items</div>
            <button onClick={extractLineItems} disabled={extractLoading} style={{padding:"6px 12px",borderRadius:8,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:10,fontWeight:800,cursor:extractLoading?"default":"pointer",opacity:extractLoading?0.6:1,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",display:"flex",alignItems:"center",gap:5}}>
              <IconSparkles size={12} color="#3B82F6"/>{extractLoading ? "Reading notes…" : "Extract from notes"}
            </button>
          </div>

          {extractError && <div style={{fontSize:11,color:"#F6BF26",marginBottom:8,fontFamily:B}}>{extractError}</div>}

          {/* Suggested (pending) items — tap-to-confirm, nothing saved until accepted */}
          {suggestedItems.length > 0 && (
            <div style={{marginBottom:10,padding:"8px 10px",borderRadius:10,background:"rgba(59,130,246,.05)",border:"1px dashed rgba(59,130,246,.25)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{flex:1,fontSize:10,color:"#5a90c0",fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Suggested — tap to add</div>
                <button onClick={acceptAllSuggested} style={{padding:"3px 9px",borderRadius:6,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.35)",color:"#10B981",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.3,textTransform:"uppercase",whiteSpace:"nowrap"}}>Add all</button>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {suggestedItems.map(it => (
                  <div key={it.id} style={{padding:"7px 9px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540"}}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        {it.item ? (
                          <div style={{fontSize:12,color:"#e0e8f0",fontWeight:700}}>{it.item}</div>
                        ) : (
                          <div style={{marginBottom:4}}>
                            <div style={{fontSize:10,color:"#F6BF26",fontWeight:700,marginBottom:3}}>⚠ No catalog match — pick one:</div>
                            <CatalogPicker value={it.item} onChange={v => updateSuggestedItem(it.id, { item: v })} />
                          </div>
                        )}
                        <div style={{fontSize:10,color:"#5a6580",marginTop:2}}>Target: {targetString(it)}</div>
                        {it.notes && <div style={{fontSize:10,color:"#5a6580",marginTop:1}}>{it.notes}</div>}
                      </div>
                      <button onClick={() => acceptSuggestedItem(it.id)} style={{padding:"4px 10px",borderRadius:6,background:"rgba(16,185,129,.12)",border:"1px solid rgba(16,185,129,.3)",color:"#10B981",fontSize:10,fontWeight:800,cursor:"pointer",flexShrink:0}}>Add</button>
                      <button onClick={() => dismissSuggestedItem(it.id)} style={{width:26,height:26,borderRadius:6,background:"transparent",border:"1px solid #252d47",color:"#a06060",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><IconX size={11} color="#a06060"/></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confirmed items */}
          {lineItems.length === 0 && suggestedItems.length === 0 && !extractLoading && (
            <div style={{fontSize:11,color:"#4a5a70",fontStyle:"italic",fontFamily:B,marginBottom:8}}>No line items yet — write your Scope/Add-on notes, then tap Extract.</div>
          )}
          {lineItems.length > 0 && (
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
              {lineItems.map(it => (
                <div key={it.id} style={{padding:"7px 9px",borderRadius:8,background:"#0e1120",border:`1px solid ${it.item ? "#1a2540" : "rgba(246,191,38,.3)"}`}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      {it.item ? (
                        <div style={{fontSize:12,color:"#e0e8f0",fontWeight:700}}>{it.item}</div>
                      ) : (
                        <div style={{marginBottom:4}}>
                          <div style={{fontSize:10,color:"#F6BF26",fontWeight:700,marginBottom:3}}>⚠ No catalog match — pick one:</div>
                          <CatalogPicker value={it.item} onChange={v => updateLineItem(it.id, { item: v })} />
                        </div>
                      )}
                      <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap"}}>
                        <input value={it.target} onChange={e => updateLineItem(it.id, { target: e.target.value })} placeholder="Species/target" style={{flex:"1 1 120px",padding:"5px 7px",borderRadius:6,background:"#0a0c14",border:"1px solid #1a2540",color:"#c8d0e0",fontSize:10,fontFamily:B}} />
                        <input value={it.location} onChange={e => updateLineItem(it.id, { location: e.target.value })} placeholder="Location" style={{flex:"1 1 100px",padding:"5px 7px",borderRadius:6,background:"#0a0c14",border:"1px solid #1a2540",color:"#c8d0e0",fontSize:10,fontFamily:B}} />
                        <input type="number" min="1" value={it.qty} onChange={e => updateLineItem(it.id, { qty: Math.max(1, Number(e.target.value) || 1) })} style={{width:48,padding:"5px 7px",borderRadius:6,background:"#0a0c14",border:"1px solid #1a2540",color:"#c8d0e0",fontSize:10,fontFamily:B}} />
                      </div>
                      <div style={{fontSize:9,color:"#4a5a70",marginTop:3}}>Target: {targetString(it)}</div>
                      {it.notes && <div style={{fontSize:10,color:"#5a6580",marginTop:1}}>{it.notes}</div>}
                    </div>
                    <button onClick={() => removeLineItem(it.id)} style={{width:26,height:26,borderRadius:6,background:"transparent",border:"1px solid #252d47",color:"#a06060",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><IconX size={11} color="#a06060"/></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button onClick={addManualLineItem} style={{width:"100%",padding:"8px 0",borderRadius:8,background:"transparent",border:"1px dashed #1a2540",color:"#5a7090",fontSize:11,fontWeight:600,cursor:"pointer"}}>+ Add line item manually</button>
        </div>

        {/* ── JOB TAGS ──────────────────────────────────────────────────
            Per-JOB (not per-line-item) tags matching SingleOps's own tag
            list exactly — equipment, crew size, access/site conditions,
            scheduling flags. Tap to toggle; "Suggest" is the same cheap,
            manual-only AI pattern as Line Items. */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1a1f2e"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#8B5CF6",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,flex:1}}>Job Tags</div>
            <button onClick={suggestJobTags} disabled={tagSuggestLoading} style={{padding:"6px 12px",borderRadius:8,background:"rgba(139,92,246,.1)",border:"1px solid rgba(139,92,246,.3)",color:"#8B5CF6",fontSize:10,fontWeight:800,cursor:tagSuggestLoading?"default":"pointer",opacity:tagSuggestLoading?0.6:1,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",display:"flex",alignItems:"center",gap:5}}>
              <IconSparkles size={12} color="#8B5CF6"/>{tagSuggestLoading ? "Reading notes…" : "Suggest"}
            </button>
          </div>

          {suggestedTags.length > 0 && (
            <div style={{marginBottom:10,padding:"8px 10px",borderRadius:10,background:"rgba(139,92,246,.05)",border:"1px dashed rgba(139,92,246,.25)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{flex:1,fontSize:10,color:"#a78bda",fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Suggested</div>
                <button onClick={acceptAllSuggestedTags} style={{padding:"3px 9px",borderRadius:6,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.35)",color:"#10B981",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.3,textTransform:"uppercase",whiteSpace:"nowrap"}}>Add all</button>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {suggestedTags.map(tag => (
                  <button key={tag} onClick={() => acceptSuggestedTag(tag)} style={{padding:"5px 10px",borderRadius:999,background:"rgba(16,185,129,.12)",border:"1px solid rgba(16,185,129,.35)",color:"#10B981",fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>+ {tag}</button>
                ))}
              </div>
            </div>
          )}

          {jobTags.length > 0 && (
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
              {jobTags.map(tag => (
                <button key={tag} onClick={() => toggleJobTag(tag)} style={{padding:"5px 10px",borderRadius:999,background:"rgba(139,92,246,.15)",border:"1px solid rgba(139,92,246,.4)",color:"#c8b0f0",fontSize:10,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4}}>
                  {tag}<IconX size={9} color="#c8b0f0"/>
                </button>
              ))}
            </div>
          )}

          {/* Full picker, grouped for scanability */}
          <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:160,overflowY:"auto",padding:"8px 9px",borderRadius:8,background:"#0a0c14",border:"1px solid #1a2540"}}>
            {Object.entries(SINGLEOPS_JOB_TAG_GROUPS).map(([groupKey, groupLabel]) => {
              const inGroup = SINGLEOPS_JOB_TAGS.filter(t => t.group === groupKey && !jobTags.includes(t.tag));
              if (!inGroup.length) return null;
              return (
                <div key={groupKey}>
                  <div style={{fontSize:8,color:"#4a5a70",fontWeight:700,letterSpacing:0.5,textTransform:"uppercase",marginBottom:3}}>{groupLabel}</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                    {inGroup.map(t => (
                      <button key={t.tag} onClick={() => toggleJobTag(t.tag)} style={{padding:"3px 8px",borderRadius:999,background:"transparent",border:"1px solid #252d47",color:"#7a8aaa",fontSize:9,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>{t.tag}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* Extension slot rendered just above the sticky bar — Pipeline uses
          this for its "Move back to Route" action, which has no Route
          equivalent (a Route stop is already in Route). Null there. */}
      {bottomExtra && (
        <div style={{flexShrink:0,padding:"8px 16px 0",background:"#0d0f18"}}>
          {bottomExtra}
        </div>
      )}

      {/* ── STICKY BOTTOM BAR ──────────────────────────────────────── */}
      <div style={{flexShrink:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#0d0f18",borderTop:"1px solid #1a1f2e",display:"flex",gap:8,zIndex:101}}>
        {s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}><IconPhone size={18} color="#a0b8d0"/></a>}
        {s.phone && <button onClick={() => window.open(`sms:${s.phone.replace(/\D/g,"")}`,"_self")} style={{flex:1,padding:"12px 0",borderRadius:10,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={18} color="#a0b8d0"/></button>}
        {s.addr && <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.addr)}`} target="_blank" rel="noreferrer" style={{flex:1,padding:"12px 0",borderRadius:10,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",textDecoration:"none"}}><IconNavigation size={18} color="#3B82F6"/></a>}
        <button onClick={handleDone} style={{flex:3,padding:"12px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconCheckCircle size={18} color="#10B981"/><span style={{fontSize:13,color:"#10B981",fontWeight:800,fontFamily:F,letterSpacing:0.5}}>DONE</span></button>
      </div>
      </div>{/* end .mts-onsite-shell */}
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
            return { [key]: sortPhotosByTs([...existingPhotos, photo]) };
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
