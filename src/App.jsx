import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { parseEvent, stageColor } from "./parseEvent";
import RouteMap, { AM_COLOR, PM_COLOR } from "./RouteMap";
import SwipeCard from "./SwipeCard";
import OnsiteWindow from "./OnsiteWindow";
import Pipeline, { savePipeline, loadPipeline } from "./Pipeline";
import { saveAppState, loadAppState, saveFieldToDrive, loadFieldFromDrive, listFieldFiles, fullSyncFromDrive, onSyncStatus } from "./driveSync";
import {
  IconArrowLeft, IconNavigation, IconMessageSquare, IconVolume2,
  IconClipboard, IconX, IconRotateCcw, IconRefresh, IconReorder, IconUndo,
  IconPlus, IconSearch, IconTrash, IconChevronDown, IconChevronRight,
  IconCloud, IconCloudOff, IconCheckCircle, IconEdit, IconPhone, IconMail
} from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS FIELD ROUTE — Main App
   Built for bright sun, one thumb, between-stops glances.
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/contacts";

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

  // Auto-refresh token every 50 min to stay signed in continuously
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => { silentReauth(); }, 50 * 60 * 1000);
    return () => clearInterval(interval);
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

  // ── ONSITE WINDOW ──────────────────────────────────────────────────────
  const [onsiteStop, setOnsiteStop] = useState(null); // stop object when onsite window open
  const [undoToast, setUndoToast] = useState(null); // {id, cn, timer}
  const undoToastTimer = useRef(null);
  const [contactPrompt, setContactPrompt] = useState(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactResult, setContactResult] = useState(null);

  const saveContactFromPrompt = async (card) => {
    if (!token || !card) return;
    setContactSaving(true);
    const [givenName, ...rest] = (card.cn || "Unknown").split(" ");
    const familyName = rest.join(" ");
    const body = {
      names: [{ givenName, familyName }],
      ...(card.phone ? { phoneNumbers: [{ value: card.phone, type: "mobile" }] } : {}),
      ...(card.email ? { emailAddresses: [{ value: card.email }] } : {}),
      ...(card.addr  ? { addresses: [{ formattedValue: card.addr, type: "home" }] } : {}),
      ...(card.jn    ? { biographies: [{ value: `MTS Rochester — Job #${card.jn}`, contentType: "TEXT_PLAIN" }] } : {}),
    };
    try {
      if (card.phone) {
        const raw = (card.phone || "").replace(/\D/g, "");
        const sr = await fetch(
          `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(card.phone)}&readMask=names,phoneNumbers,emailAddresses,metadata&pageSize=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const sd = await sr.json();
        const existing = sd.results?.find(r =>
          (r.person?.phoneNumbers || []).some(p => p.value?.replace(/\D/g,"") === raw)
        );
        if (existing?.person?.resourceName) {
          const rn = existing.person.resourceName;
          const mask = ["names", card.phone && "phoneNumbers", card.email && "emailAddresses", card.addr && "addresses"].filter(Boolean).join(",");
          await fetch(`https://people.googleapis.com/v1/${rn}:updateContact?updatePersonFields=${mask}`, {
            method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, etag: existing.person.etag }),
          });
          setContactResult("updated"); setContactSaving(false);
          setTimeout(() => { setContactPrompt(null); setContactResult(null); }, 2500);
          return;
        }
      }
      await fetch("https://people.googleapis.com/v1/people:createContact", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setContactResult("saved");
    } catch(e) { setContactResult("error"); }
    setContactSaving(false);
    setTimeout(() => { setContactPrompt(null); setContactResult(null); }, 2500);
  };

  const [view, setView] = useState(() => lsGet("mts-view", "route"));
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [routeSearch, setRouteSearch] = useState("");
  const [routeSearchOpen, setRouteSearchOpen] = useState(false);

  // Fix iOS keyboard dismiss causing content to hide behind notch
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => { vv.removeEventListener("resize", onResize); vv.removeEventListener("scroll", onResize); };
  }, []);

  // Persist view state so tab resume doesn't reset
  useEffect(() => { lsSet("mts-view", view); }, [view]);

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

  // ── CLOUD SYNC: Pull app state from Drive on startup ───────────────
  const [syncIndicator, setSyncIndicator] = useState("idle");
  useEffect(() => { return onSyncStatus(setSyncIndicator); }, []);

  // ══════════════════════════════════════════════════════════════════════
  // AUTO-SYNC: pull from Drive on mount + poll + on visibility change
  // Push: debounced on any local change
  // ══════════════════════════════════════════════════════════════════════

  // Track last known Drive modifiedTimes to only pull files that changed
  const lastSyncRef = useRef({ state: 0, fields: {} }); // {state: timestamp, fields: {id: modifiedTime}}
  const [lastSyncTime, setLastSyncTime] = useState(0);
  const [autoPulling, setAutoPulling] = useState(false);

  // Merge Drive field data into localStorage — newest savedAt wins
  const mergeFieldDataFromDrive = useCallback((fieldData) => {
    let changeCount = 0;
    for (const [id, remoteData] of Object.entries(fieldData || {})) {
      const localRaw = localStorage.getItem(`mts-field-${id}`);
      let local = null;
      try { local = localRaw ? JSON.parse(localRaw) : null; } catch(e) {}
      const localSavedAt = local?.savedAt || 0;
      const remoteSavedAt = remoteData?.savedAt || 0;
      // Only overwrite if remote is strictly newer, OR no local data exists
      if (!local || remoteSavedAt > localSavedAt) {
        // Strip the _modifiedTime helper field before storing
        const { _modifiedTime, ...clean } = remoteData;
        localStorage.setItem(`mts-field-${id}`, JSON.stringify(clean));
        changeCount++;
      }
    }
    return changeCount;
  }, []);

  // Full pull from Drive — called on mount, visibility, interval
  const doFullPull = useCallback(async (silent = true) => {
    if (!token) return;
    if (!silent) setAutoPulling(true);
    try {
      const drive = await fullSyncFromDrive(token);
      // Merge app state if Drive is newer than what we have
      if (drive.pipeline) {
        // Merge pipeline card-by-card: newest stageChangedAt wins per card
        const local = loadPipeline();
        let changed = false;
        const merged = { ...local };
        for (const [id, driveCard] of Object.entries(drive.pipeline)) {
          const localCard = local[id];
          const driveTs = driveCard.stageChangedAt || driveCard.addedAt || 0;
          const localTs = localCard?.stageChangedAt || localCard?.addedAt || 0;
          if (!localCard || driveTs > localTs) {
            merged[id] = driveCard;
            changed = true;
          }
        }
        if (changed) savePipeline(merged);
      }
      if (drive.dismissed) {
        // Safe merge: only keep Drive dismissed entries that are newer than local
        // This prevents old Drive data from re-dismissing stops you've already un-dismissed
        setDismissed(prev => {
          const merged = { ...prev };
          for (const [id, driveTs] of Object.entries(drive.dismissed)) {
            const localTs = prev[id] || 0;
            // Only accept Drive entry if it's strictly newer, or local has none
            if (driveTs > localTs) merged[id] = driveTs;
          }
          return merged;
        });
      }
      // Merge field data
      const changed = mergeFieldDataFromDrive(drive.fieldData);
      setLastSyncTime(Date.now());
      if (changed > 0) {
        // Force Pipeline/OnsiteWindow to re-read — bump a counter or reload
        // The simplest approach: dispatch a custom event
        window.dispatchEvent(new CustomEvent("mts-field-synced", { detail: { count: changed } }));
      }
    } catch(e) { console.warn("Auto-pull failed:", e); }
    if (!silent) setAutoPulling(false);
  }, [token, mergeFieldDataFromDrive]);

  // On token present: initial pull + setup polling + visibility listener
  useEffect(() => {
    if (!token) return;
    // Immediate pull on mount
    doFullPull(false);
    // Poll every 30 seconds while tab is visible
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") doFullPull(true);
    }, 30000);
    // Pull when tab becomes visible again (e.g., user switches back from another app)
    const onVisible = () => {
      if (document.visibilityState === "visible") doFullPull(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [token, doFullPull]);

  // Auto-push: whenever pipeline or dismissed changes, push to Drive (debounced)
  const pushTimer = useRef(null);
  const triggerCloudSync = useCallback(async (immediate = false) => {
    if (!token) return;
    const run = async () => {
      const pl = loadPipeline();
      await saveAppState(token, pl, dismissed).catch(() => {});
      // Walk localStorage and push any field data that has local changes
      // (We only push — Drive data is only overwritten by newer savedAt)
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("mts-field-")) {
            const id = key.slice("mts-field-".length);
            const fd = JSON.parse(localStorage.getItem(key) || "{}");
            if (fd && Object.keys(fd).length > 0) {
              // Only push if savedAt exists (means there was a real edit)
              await saveFieldToDrive(token, id, fd).catch(() => {});
            }
          }
        }
      } catch(e) { console.warn("Field sync walk failed:", e); }
    };
    if (immediate) { await run(); return; }
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(run, 2000);
  }, [token, dismissed]);

  useEffect(() => { triggerCloudSync(); }, [dismissed, triggerCloudSync]);

  // Manual pull (for the button)
  const pullFromDrive = useCallback(() => doFullPull(false), [doFullPull]);


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
  const completed = useMemo(() => stops.filter(s => dismissed[s.id]).sort((a, b) => (dismissed[b.id] || 0) - (dismissed[a.id] || 0)), [stops, dismissed]);
  const mapStops = useMemo(() => active.filter(s => s.isTask), [active]);

  // Route search filter
  const filteredActive = useMemo(() => {
    if (!routeSearch.trim()) return active;
    const q = routeSearch.toLowerCase();
    return active.filter(s => (s.cn||"").toLowerCase().includes(q) || (s.addr||"").toLowerCase().includes(q) || (s.jn||"").includes(q));
  }, [active, routeSearch]);

  // Delete a stop entirely (no pipeline, no restore)
  const deleteStop = (id) => {
    setDismissed(p => ({...p, [id]: Date.now()}));
    setExpanded(null);
    // Remove from ordIds so it stays gone
    setOrdIds(prev => {
      const order = prev[dayKey] || [];
      return { ...prev, [dayKey]: order.filter(i => i !== id) };
    });
  };

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  const openOnsite = (stop) => { setOnsiteStop(stop); setExpanded(null); };
  const [declineConfirm, setDeclineConfirm] = useState(null); // stop id awaiting confirm
  const [addStopOpen, setAddStopOpen] = useState(false);
  const [addStopAddr, setAddStopAddr] = useState("");
  const [addStopName, setAddStopName] = useState("");

  // Decline = remove from route with confirmation
  const decline = (id) => {
    setUndoStack(u => [...u, {type:"dismiss",id}]);
    setDismissed(p => ({...p,[id]:Date.now()}));
    setExpanded(null);
    setDeclineConfirm(null);
    setOnsiteStop(null);
  };
  // markDone = move to pipeline as "estimate_needed"
  const markDone = (id) => {
    const stop = stopMap[id];
    setUndoStack(u => [...u, {type:"dismiss",id}]);
    setDismissed(p => ({...p,[id]:Date.now()})); // triggers cloud sync automatically
    setExpanded(null);
    setOnsiteStop(null);
    if (stop) {
      const pl = loadPipeline();
      pl[id] = {
        id, cn: stop.cn, addr: stop.addr, phone: stop.phone, email: stop.email,
        jn: stop.jn, notes: stop.notes, constraint: stop.constraint,
        stage: "estimate_needed", addedAt: Date.now(), stageChangedAt: Date.now(),
        hot: false,
      };
      savePipeline(pl);
      // Also sync field data to Drive
      if (token) {
        const fd = lsGet(`mts-field-${id}`, {});
        if (Object.keys(fd).length > 0) saveFieldToDrive(token, id, fd).catch(() => {});
      }
    }
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
    setUndoToast({ id, cn: stop?.cn || "Stop", stop });
    undoToastTimer.current = setTimeout(() => setUndoToast(null), 10000);
    // Auto-save to Google Contacts silently
    if (stop && (stop.phone || stop.email) && token) {
      saveContactFromPrompt(stop).catch(() => {});
    }
  };
  const undoToastAction = () => {
    if (!undoToast) return;
    setDismissed(p => { const n={...p}; delete n[undoToast.id]; return n; });
    setUndoStack(u => u.slice(0,-1));
    // Remove from pipeline
    const pl = loadPipeline(); delete pl[undoToast.id]; savePipeline(pl);
    // Reopen onsite screen with the stop
    if (undoToast.stop) setOnsiteStop(undoToast.stop);
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
    setUndoToast(null);
  };
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

  // ── TEXT-TO-SPEECH ──────────────────────────────────────────────────────
  const ttsAudioRef = useRef(null);
  const ttsCtxRef = useRef(null);
  const ttsSafetyTimer = useRef(null);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);

  const resetTts = () => {
    setTtsSpeaking(false);
    if (ttsAudioRef.current) { try { ttsAudioRef.current.pause(); } catch(e){} ttsAudioRef.current = null; }
    if (ttsCtxRef.current) { ttsCtxRef.current.close().catch(()=>{}); ttsCtxRef.current = null; }
    if (ttsSafetyTimer.current) { clearTimeout(ttsSafetyTimer.current); ttsSafetyTimer.current = null; }
  };

  const speakStop = async (stop) => {
    if (ttsAudioRef.current && !ttsAudioRef.current.paused) { ttsAudioRef.current.pause(); resetTts(); return; }
    if (ttsCtxRef.current?.state === "running") { resetTts(); return; }
    if (window.speechSynthesis?.speaking) { window.speechSynthesis.cancel(); resetTts(); return; }
    if (ttsSpeaking) { resetTts(); return; }

    const text = stop.notes || "No notes available.";
    const geminiKey = import.meta.env.VITE_GEMINI_KEY;
    setTtsSpeaking(true);
    if (ttsSafetyTimer.current) clearTimeout(ttsSafetyTimer.current);
    ttsSafetyTimer.current = setTimeout(() => resetTts(), 90000);

    // CarPlay fix: create and unlock AudioContext NOW inside the user gesture tap.
    // After any await, iOS considers the gesture chain broken — but AudioContext
    // created here stays unlocked and routes through CarPlay correctly.
    let audioCtx = null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      ttsCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") await audioCtx.resume();
    } catch(e) {}

    if (geminiKey) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: `Read this aloud clearly at a comfortable pace: ${text}` }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } } }),
        });
        const data = await res.json();
        const audioB64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (audioB64 && audioCtx) {
          try {
            const buf = await audioCtx.decodeAudioData(Uint8Array.from(atob(audioB64), c => c.charCodeAt(0)).buffer);
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(audioCtx.destination);
            src.onended = () => resetTts();
            ttsAudioRef.current = { paused: false, pause: () => { try { src.stop(); } catch(e){} } };
            src.start(0);
            return;
          } catch(e) {
            // AudioContext decode failed — fall through to Audio element
          }
          const blob = new Blob([Uint8Array.from(atob(audioB64), c => c.charCodeAt(0))], { type: "audio/mp3" });
          const audio = new Audio(URL.createObjectURL(blob));
          audio.setAttribute("playsinline", "");
          ttsAudioRef.current = audio;
          audio.onended = () => resetTts();
          audio.onerror = () => resetTts();
          audio.play().catch(() => resetTts());
          return;
        }
      } catch(e) { /* fall through */ }
    }

    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.85;
      u.onend = () => resetTts();
      u.onerror = () => resetTts();
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) window.speechSynthesis.speak(u);
      else { window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.speak(u); }
    } else { resetTts(); }
  };

  if (loading && !Object.keys(rawEvents).length) return (
    <div style={{height:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0b10",color:"#5a6580",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:700}}>Loading...</div></div>
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div style={{height:"100dvh",width:"100%",background:"#0a0b10",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',system-ui,sans-serif",color:"#f0f4fa",overflow:"hidden",paddingTop:"env(safe-area-inset-top)",boxSizing:"border-box"}}>
      <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
      <style>{`
.scr::-webkit-scrollbar{width:0}
.gmnoprint,.gm-bundled-control,.gm-style-cc,.gm-control-active,.gm-fullscreen-control,.gm-style .adp,.gm-style button[title]{display:none!important}
.mts-body{display:flex;flex-direction:column;flex:1;overflow:hidden}
.mts-map{flex-shrink:0;border-bottom:1px solid #1a2030}
.mts-list{flex:1;overflow-y:auto}
@keyframes spin{to{transform:rotate(360deg)}}
@media screen and (orientation:landscape){html{-webkit-text-size-adjust:100%}}
@media(min-width:768px){
  .mts-body{flex-direction:row}
  .mts-map{width:45%;min-width:320px;max-width:500px;border-bottom:none;border-right:1px solid #1a2030;overflow:hidden;display:flex;flex-direction:column}
  .mts-map .mts-map-inner{flex:1;min-height:0}
  .mts-map .mts-map-inner>div{height:100%!important}
  .mts-list{flex:1;min-width:0}
  .mts-pipeline-mobile{display:none!important}
  .mts-pipeline-desktop{display:flex!important}
}
      `}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{display:"flex",alignItems:"center",gap:6,padding:"8px 12px",background:"#0d0f18",borderBottom:"1px solid #1a1f2e",flexShrink:0}}>
        <button onClick={()=>setView(view==="route"?"pipeline":"route")} style={{padding:"5px 10px",borderRadius:8,background:"transparent",border:"none",cursor:"pointer",fontFamily:"'Oswald',sans-serif",fontWeight:700,fontSize:13,letterSpacing:2,textTransform:"uppercase",color:view==="route"?"#f0f4fa":"#10B981",transition:"color .2s"}}>{view==="route"?"MTS FIELD":"MTS PIPELINE"}</button>
        {token && (() => {
          const now = Date.now();
          const since = lastSyncTime ? Math.floor((now - lastSyncTime) / 1000) : null;
          const label = autoPulling || syncIndicator === "syncing"
            ? "Syncing…"
            : syncIndicator === "error"
              ? "Retry"
              : since === null ? "Sync"
                : since < 60 ? `✓ ${since}s`
                  : since < 3600 ? `✓ ${Math.floor(since/60)}m`
                    : "✓ Synced";
          const color = syncIndicator === "syncing" || autoPulling ? "#F6BF26"
            : syncIndicator === "error" ? "#FF5555"
              : "#10B981";
          return (
            <button
              onClick={async () => { await triggerCloudSync(true); await pullFromDrive(); }}
              title="Tap to force sync now"
              style={{background:"rgba(255,255,255,.03)",border:`1px solid ${color}30`,cursor:"pointer",padding:"4px 10px",borderRadius:6,display:"flex",alignItems:"center",gap:5,fontSize:10,color,fontWeight:700,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>
              {syncIndicator === "error" ? <IconCloudOff size={12} color={color}/> : <IconCloud size={12} color={color}/>}
              {label}
            </button>
          );
        })()}
        {view === "route" && <>
          <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setReorderMode(false);setMoving(null);}} style={{padding:"5px 10px",borderRadius:8,border:"1px solid #2a3560",background:"#0a0b10",color:"#f0f4fa",fontSize:11,fontWeight:600,cursor:"pointer",outline:"none",appearance:"auto",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
            {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </>}
        {view === "pipeline" && <>
          <div style={{flex:1}}/>
          <input value={pipelineSearch} onChange={e=>setPipelineSearch(e.target.value)} placeholder="Search..." style={{maxWidth:180,padding:"5px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:12,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none"}} />
        </>}
      </div>

      {/* ── ROUTE VIEW ──────────────────────────────────────────────── */}
      {view === "route" && <>
      {/* ── BODY: map + list (side-by-side on desktop) ─────────────── */}
      <div className="mts-body">

      {/* ── MAP ────────────────────────────────────────────────────────── */}
      <div className="mts-map">
        {reorderMode && <div style={{padding:"5px 12px",background:"rgba(142,36,170,.08)",borderBottom:"1px solid rgba(142,36,170,.15)",display:"flex",alignItems:"center",gap:8}}>
          {moving !== null ? <>
            <div style={{width:10,height:10,borderRadius:10,background:active[moving]?.color||"#8E24AA"}}/>
            <span style={{fontSize:12,fontWeight:600,color:"#c8a0e8"}}>Moving: {active[moving]?.cn} — tap where to place</span>
            <button onClick={()=>setMoving(null)} style={{marginLeft:"auto",padding:"3px 10px",borderRadius:6,background:"#1a2035",border:"none",color:"#90a8c0",fontSize:10,fontWeight:700,cursor:"pointer"}}>Cancel</button>
          </> : <span style={{fontSize:12,fontWeight:500,color:"#9a80c8"}}><span style={{display:"flex",alignItems:"center",gap:4}}><IconReorder size={12} color="#9a80c8"/>Tap a stop to pick it up</span></span>}
        </div>}
        <div className="mts-map-inner">
          {mapStops.length>0 && <RouteMap stops={mapStops} selectedId={expanded}/>}
        </div>
      </div>

      {/* ── STOP LIST ──────────────────────────────────────────────────── */}
      <div className="scr mts-list" style={{paddingBottom:"max(12px,env(safe-area-inset-bottom))"}}>
        {active.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No stops</div>}

        {(()=>{ let taskNum = 0; return filteredActive.map((s, idx) => {
          if (s.isTask) taskNum++;
          const isNext = idx === 0 && !reorderMode && s.isTask;
          const isExp = expanded === s.id && !reorderMode;
          const isMov = moving === idx;
          const isAM = (s.window||"").startsWith("AM");
          const circleColor = s.isTask ? (isAM ? AM_COLOR : PM_COLOR) : "#2a2040";
          const winColor = isAM ? "#4CAF50" : "#5a9ec8";
          const winBg = isAM ? "rgba(46,125,50,.12)" : "rgba(30,136,229,.12)";

          return <SwipeCard key={s.id} enabled={!reorderMode} onSwipeRight={() => navigate(s.addr)} onSwipeLeft={() => openOnsite(s)}>
            <div onClick={() => { if (reorderMode) handleReorderTap(idx); else { setDeclineConfirm(null); setCompletedOpen(false); setExpanded(isExp ? null : s.id); } }}
              ref={el => { if (el && expanded === s.id) setTimeout(() => el.scrollIntoView({behavior:"smooth",block:"nearest"}), 50); }}
              style={{
              padding:"14px 16px", borderBottom:"1px solid #0e1220",
              cursor: reorderMode ? "grab" : "pointer",
              background: isMov ? "rgba(142,36,170,.08)" : isNext ? "#0e1120" : reorderMode ? "#0a0b10" : "transparent",
              borderLeft: `4px solid ${isMov ? "#8E24AA" : isNext ? circleColor : "transparent"}`,
              opacity: reorderMode && !isMov && moving !== null ? .5 : 1,
              transition: "opacity .15s",
            }}>
              {/* ── MAIN ROW: High-contrast sunlight-readable ──────────── */}
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:isNext?38:32,height:isNext?38:32,borderRadius:"50%",background:circleColor,display:"flex",alignItems:"center",justifyContent:"center",fontSize:s.isTask?(isNext?16:14):9,fontWeight:900,color:"#fff",flexShrink:0,border:s.db?"2px dashed rgba(255,255,255,.5)":isMov?"2px solid #8E24AA":!s.isTask?"1px solid #3a3060":"none",letterSpacing:s.isTask?0:-.5,fontFamily:"'Oswald',sans-serif",textShadow:"0 1px 2px rgba(0,0,0,.5)"}}>{s.isTask?taskNum:"TD"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{
                    fontSize:isNext?17:15, fontWeight:isNext?900:800,
                    color: s.isTask ? "#FFFFFF" : "#d0c8e8",
                    overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",
                    fontFamily:"'Oswald',sans-serif",
                    textTransform:"uppercase",
                    letterSpacing: isNext ? 1 : 0.5,
                    textShadow: isNext ? "0 0 8px rgba(255,255,255,.15)" : "none",
                  }}>{isNext?"▸ ":""}{s.cn}</div>
                  {s.addr && <div style={{fontSize:12,color:"#96a2b4",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:2,fontWeight:500,letterSpacing:1,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase"}}>{s.addr}</div>}
                </div>
                {s.isTask && s.window && <span style={{padding:"3px 8px",borderRadius:6,fontSize:11,fontWeight:900,color:isAM?"#66BB6A":"#64B5F6",background:winBg,border:`1px solid ${winColor}40`,flexShrink:0,letterSpacing:1,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase"}}>{s.window}</span>}
                {s.isTask && s.db && <span style={{padding:"3px 6px",borderRadius:6,fontSize:10,fontWeight:900,color:"#FFD54F",background:"rgba(255,213,79,.12)",border:"1px solid rgba(255,213,79,.3)",flexShrink:0,letterSpacing:1,fontFamily:"'Oswald',sans-serif"}}>DB</span>}
                {!s.isTask && s.timeLabel && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:700,color:"#9a8cc0",background:"rgba(100,80,160,.1)",border:"1px solid rgba(100,80,160,.2)",flexShrink:0}}>{s.timeLabel}</span>}
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>e.stopPropagation()} style={{padding:"5px 10px",borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#90a8c0",fontSize:12,textDecoration:"none",fontWeight:700,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><IconPhone size={13} color="#90a8c0"/></a>}
              </div>

              {s.constraint && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(255,80,160,.12)",border:"1px solid rgba(255,80,160,.25)",color:"#FF80AB",fontSize:12,fontWeight:800,display:"inline-block",letterSpacing:0.3,fontFamily:"'Oswald','DM Sans',sans-serif",textTransform:"uppercase"}}>{s.constraint}</div>}

              {s.titleContext && !reorderMode && <div style={{marginTop:4,marginLeft:isNext?50:44,fontSize:12,color:"#b0b8c8",lineHeight:1.5,fontStyle:"italic",fontWeight:500}}>{s.titleContext}</div>}

              {isExp && <div onClick={e=>e.stopPropagation()} style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {s.notes && <div style={{fontSize:13,color:"#a0b0c0",lineHeight:1.6,marginBottom:10,fontWeight:500}}>{s.notes}</div>}
                {s.phone && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:3,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconPhone size={13} color="#a0b8d0"/>{s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:8,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#a0b8d0"/>{s.email}</div>}
                {declineConfirm === s.id ? (
                  <button onClick={()=>decline(s.id)} style={{width:"100%",padding:"11px 0",marginTop:4,borderRadius:8,background:"rgba(200,60,60,.15)",border:"1px solid rgba(200,60,60,.3)",color:"#FF5555",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",animation:"pulse 1s infinite",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconX size={14} color="#FF5555"/>CONFIRM DECLINE?</button>
                ) : (
                  <div style={{display:"flex",gap:6,marginTop:4}}>
                    {s.phone && <button onClick={()=>{setTextSheet(s);setOtwMinutes(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={16} color="#a0b8d0"/></button>}
                    {s.addr && <button onClick={()=>navigate(s.addr)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconNavigation size={16} color="#3B82F6"/></button>}
                    {s.notes && <button onClick={()=>speakStop(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:ttsSpeaking?"rgba(100,80,200,.18)":"rgba(100,80,200,.08)",border:"1px solid rgba(100,80,200,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{ttsSpeaking ? <IconX size={16} color="#8a80c0"/> : <IconVolume2 size={16} color="#8a80c0"/>}</button>}
                    <button onClick={()=>openOnsite(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconClipboard size={16} color="#10B981"/></button>
                    <button onClick={()=>setDeclineConfirm(s.id)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(200,60,60,.06)",border:"1px solid rgba(200,60,60,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={16} color="#a06060"/></button>
                    {!s.isTask && <button onClick={()=>deleteStop(s.id)} title="Delete permanently" style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(100,100,100,.06)",border:"1px solid rgba(100,100,100,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconTrash size={16} color="#4a5a70"/></button>}
                  </div>
                )}
              </div>}
            </div>
          </SwipeCard>;
        }); })()}

        {/* ── BOTTOM BAR ────────────────────────────────────────────── */}
        <div style={{borderTop:"1px solid #1a2030",flexShrink:0,background:"#090b0f"}}>
          {/* Search row */}
          {routeSearchOpen && <div style={{padding:"6px 8px",borderBottom:"1px solid #0e1218",display:"flex",gap:6,alignItems:"center"}}>
            <input value={routeSearch} onChange={e=>setRouteSearch(e.target.value)} autoFocus placeholder="Search clients, addresses..." style={{flex:1,padding:"6px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:16,fontFamily:"'DM Sans',system-ui",outline:"none"}} onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />
            <button onClick={()=>{setRouteSearchOpen(false);setRouteSearch("");}} style={{padding:"6px 8px",borderRadius:6,background:"transparent",border:"none",color:"#4a5a70",fontSize:12,cursor:"pointer"}}><IconX size={13} color="#4a5a70"/></button>
          </div>}
          <div style={{display:"flex",alignItems:"center",padding:"4px 8px",gap:4}}>
            {completed.length>0 ? (
              <button onClick={()=>{
                const next = !completedOpen;
                setCompletedOpen(next);
                if (next) setTimeout(() => {
                  const el = document.getElementById("mts-completed-list");
                  if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
                }, 80);
              }} style={{padding:"8px 10px",background:"transparent",border:"none",color:"#10B981",fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                <span style={{transform:completedOpen?"rotate(90deg)":"",transition:"transform .15s",display:"inline-block",fontSize:7}}>▶</span>
                <IconCheckCircle size={13} color="#10B981"/> {completed.length}
              </button>
            ) : <div style={{width:8}}/>}
            <div style={{flex:1}}/>
            <button onClick={()=>setRouteSearchOpen(!routeSearchOpen)} style={{padding:"7px",borderRadius:8,background:routeSearchOpen?"rgba(59,130,246,.12)":"transparent",border:"1px solid #1a2030",color:routeSearchOpen?"#3B82F6":"#3a4a60",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <IconSearch size={15} color={routeSearchOpen?"#3B82F6":"#3a4a60"} />
            </button>
            <button onClick={load} disabled={loading} style={{padding:"7px",borderRadius:8,background:"#1a2035",border:"1px solid #1a2030",color:loading?"#2a3050":"#5a6580",cursor:loading?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <IconRefresh size={15} color={loading?"#2a3050":"#5a6580"} style={{animation:loading?"spin 1s linear infinite":undefined}} />
            </button>
            {hasStopsWithAddr && !reorderMode && <button onClick={navAll} style={{padding:"7px",borderRadius:8,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <IconNavigation size={15} color="#3B82F6" />
            </button>}
            <button onClick={()=>setAddStopOpen(true)} style={{padding:"7px",borderRadius:8,background:"transparent",border:"1px solid #1a2030",color:"#3a4a60",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <IconPlus size={15} color="#3a4a60" />
            </button>
          </div>
        </div>
        {completedOpen && completed.length > 0 && <div id="mts-completed-list">
          {completed.map(s => (
            <div key={s.id} style={{padding:"10px 16px",borderBottom:"1px solid #0a0e16",display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:24,height:24,borderRadius:"50%",background:s.color+"44",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><IconCheckCircle size={13} color="#fff"/></div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,color:"#6a7890",textDecoration:"line-through",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
                {s.addr && <div style={{fontSize:10,color:"#3a4560",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.addr}</div>}
              </div>
              <button onClick={()=>openOnsite(s)} style={{padding:"6px 12px",borderRadius:8,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:11,fontWeight:800,cursor:"pointer",letterSpacing:0.3,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><IconEdit size={13} color="#3B82F6"/>EDIT</button>
              <button onClick={()=>restore(s.id)} style={{padding:"6px 12px",borderRadius:8,background:"rgba(255,183,77,.08)",border:"1px solid rgba(255,183,77,.25)",color:"#FFB74D",fontSize:11,fontWeight:800,cursor:"pointer",letterSpacing:0.3,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}><IconUndo size={13} color="#FFB74D"/>RESTORE</button>
            </div>
          ))}
        </div>}
      </div>
      </div>{/* end mts-body */}

      {/* ── BOTTOM BAR ──────────────────────────────────────────────── */}
      {view === "route" && <div style={{borderTop:"1px solid #0e1520",padding:"3px 10px",paddingBottom:"max(3px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",gap:6,background:"#080a10",flexShrink:0,minHeight:36}}>
        {/* Undo — left */}
        <button onClick={undo} disabled={!undoStack.length}
          style={{display:"flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:8,background:"transparent",border:`1px solid ${undoStack.length?"#1a2035":"transparent"}`,color:undoStack.length?"#5a6580":"#1a2035",fontSize:11,fontWeight:700,cursor:undoStack.length?"pointer":"default",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
          <IconUndo size={14} color={undoStack.length?"#5a6580":"#1a2035"}/>UNDO
        </button>
        <div style={{flex:1}}/>
        {/* Reorder — right */}
        <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}}
          style={{display:"flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:8,background:reorderMode?"rgba(142,36,170,.15)":"transparent",border:`1px solid ${reorderMode?"rgba(142,36,170,.4)":"#1a2035"}`,color:reorderMode?"#c8a0e8":"#3a4a60",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
          <IconReorder size={14} color={reorderMode?"#c8a0e8":"#3a4a60"}/>{reorderMode?"DONE":"REORDER"}
        </button>
        {/* Sign out — arrow-left-start-on-rectangle heroicon */}
        <button onClick={()=>{ setToken(null); try{localStorage.removeItem("mts-token");}catch(e){} }}
          title="Sign out"
          style={{marginLeft:4,width:30,height:30,borderRadius:8,background:"transparent",border:"1px solid #1a2035",color:"#2a3050",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#3a4a60" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>}
            {view === "pipeline" && <div style={{borderTop:"1px solid #0e1520",padding:"5px 10px",paddingBottom:"max(5px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",justifyContent:"flex-end",background:"#080a10",flexShrink:0}}>
        <button onClick={()=>{ setToken(null); try{localStorage.removeItem("mts-token");}catch(e){} }}
          title="Sign out"
          style={{width:28,height:28,borderRadius:8,background:"transparent",border:"1px solid #1a2035",color:"#2a3050",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>
          ⏏
        </button>
      </div>}

      {/* ── ADD STOP POPUP ─────────────────────────────────────────── */}
      {addStopOpen && <div onClick={()=>{setAddStopOpen(false);setAddStopAddr("");setAddStopName("");}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:14,padding:20,maxWidth:360,width:"100%"}}>
          <div style={{fontSize:15,fontWeight:700,color:"#f0f4fa",marginBottom:14,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>Add a stop</div>
          <input value={addStopName} onChange={e=>setAddStopName(e.target.value)} placeholder="Name (e.g. Smith)" style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:14,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none",marginBottom:8}} />
          <input value={addStopAddr} onChange={e=>setAddStopAddr(e.target.value)} placeholder="Address" style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:14,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none",marginBottom:12}} />
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{setAddStopOpen(false);setAddStopAddr("");setAddStopName("");}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"transparent",border:"1px solid #1a2030",color:"#5a6580",fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
            <button onClick={()=>{
              if (!addStopName.trim() && !addStopAddr.trim()) return;
              const id = "local-" + Date.now();
              setRawEvents(prev => {
                const dayEvts = prev[dayKey] || [];
                return {...prev, [dayKey]: [...dayEvts, { id, summary: addStopName.trim() || addStopAddr.trim(), location: addStopAddr.trim(), start:{dateTime:new Date().toISOString()}, end:{dateTime:new Date().toISOString()}, colorId:"7", description:"" }]};
              });
              setAddStopAddr(""); setAddStopName(""); setAddStopOpen(false);
            }} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:13,fontWeight:700,cursor:"pointer"}}>Add</button>
          </div>
        </div>
      </div>}
      </>}{/* end route view */}

      {/* ── PIPELINE VIEW ──────────────────────────────────────────── */}
      {view === "pipeline" && <Pipeline onSwitchToRoute={(cardId) => { setView("route"); if (cardId) { setDismissed(prev => { const n = {...prev}; delete n[cardId]; return n; }); const pl = loadPipeline(); delete pl[cardId]; savePipeline(pl); } }} search={pipelineSearch} onCloudSync={triggerCloudSync} token={token} />}

      {/* ── TEXT SHEET ─────────────────────────────────────────────────── */}
      {textSheet && <div onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:"max(18px,env(safe-area-inset-bottom))"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1}}>Text {(textSheet.cn||"").split(" ")[0]}</span>
            <span style={{fontSize:12,color:"#5a6580"}}>{textSheet.phone}</span>
            <button onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={13} color="#5a6580"/></button>
          </div>

          <button onClick={()=>{window.open(`sms:${textSheet.phone.replace(/\D/g,"")}`,"_self");setTextSheet(null);}} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",textAlign:"left"}}>
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
                  }} style={{flex:"1 0 30%",padding:"10px 0",borderRadius:8,background:"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:13,fontWeight:800,cursor:"pointer",textAlign:"center"}}>{label}</button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>}

      {/* ── ONSITE WINDOW ──────────────────────────────────────────── */}
      {onsiteStop && <OnsiteWindow
        stop={onsiteStop}
        token={token}
        onBack={() => setOnsiteStop(null)}
        onDone={() => markDone(onsiteStop.id)}
        onDecline={() => { decline(onsiteStop.id); setOnsiteStop(null); }}
      />}

      {/* ── CONTACT AUTO-SAVE RESULT BANNER ────────────────────────── */}
      {contactResult && <div style={{position:"fixed",bottom:undoToast?"56px":"0",left:0,right:0,padding:"10px 16px",paddingBottom:undoToast?"10px":"max(10px,env(safe-area-inset-bottom))",background:contactResult==="error"?"#1a0d0d":"#0d1a14",borderTop:`1px solid ${contactResult==="error"?"rgba(200,60,60,.3)":"rgba(16,185,129,.3)"}`,display:"flex",alignItems:"center",gap:10,zIndex:151}}>
        <span style={{fontSize:13,color:contactResult==="error"?"#e06060":contactResult==="updated"?"#60c090":"#10B981",flex:1}}>
          {contactResult==="error"?"✗ Contact save failed":contactResult==="updated"?"✓ Contact updated in Google":"✓ Contact saved to Google"}
        </span>
      </div>}

      {/* ── UNDO TOAST ─────────────────────────────────────────────── */}
      {undoToast && <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#1a2a20",borderTop:"1px solid rgba(16,185,129,.3)",display:"flex",alignItems:"center",gap:10,zIndex:150}}>
        <div style={{flex:1,fontSize:13,color:"#10B981",fontWeight:600,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconCheckCircle size={13} color="#10B981"/>{undoToast.cn} → PIPELINE</span></div>
        <button onClick={undoToastAction} style={{padding:"6px 16px",borderRadius:8,background:"rgba(255,183,77,.12)",border:"1px solid rgba(255,183,77,.3)",color:"#FFB74D",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5}}>UNDO</button>
        <button onClick={() => { if (undoToastTimer.current) clearTimeout(undoToastTimer.current); setUndoToast(null); }} style={{padding:"6px 10px",borderRadius:6,background:"transparent",border:"none",color:"#4a6050",cursor:"pointer",display:"flex",alignItems:"center"}}><IconX size={14} color="#4a6050"/></button>
      </div>}
    </div>
  );
}
