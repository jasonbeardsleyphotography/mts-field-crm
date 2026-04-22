import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { parseEvent, stageColor } from "./parseEvent";
import RouteMap, { AM_COLOR, PM_COLOR } from "./RouteMap";
import SwipeCard from "./SwipeCard";
import OnsiteWindow from "./OnsiteWindow";
import Pipeline, { savePipeline, loadPipeline } from "./Pipeline";
import { saveAppState, loadAppState, saveFieldToDrive, loadFieldFromDrive, listFieldFiles, onSyncStatus } from "./driveSync";
import { loadField, saveField, listFieldIds } from "./fieldStore";
import {
  IconArrowLeft, IconNavigation, IconMessageSquare, IconVolume2,
  IconClipboard, IconX, IconRotateCcw, IconRefresh, IconReorder, IconUndo,
  IconPlus, IconSearch, IconTrash, IconChevronDown, IconChevronRight,
  IconCloud, IconCloudOff, IconCheckCircle, IconEdit, IconPhone, IconMail, IconClock
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

  // ── LAST CONTACT TRACKING ──────────────────────────────────────────────
  // Every phone tap, SMS send, email open writes a timestamp keyed by stop id.
  // Used by UI to show "called 2h ago" etc. instead of just stage-changed-at.
  const [lastContact, setLastContact] = useState(() => lsGet("mts-lastcontact", {}));
  useEffect(() => { lsSet("mts-lastcontact", lastContact); }, [lastContact]);
  const markContact = useCallback((id, kind) => {
    if (!id) return;
    setLastContact(prev => ({ ...prev, [id]: { at: Date.now(), kind } }));
  }, []);

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

  // Silent version of the above, used for auto-save on calendar import.
  // Returns true on success, false on failure. No UI side effects.
  const autoPushContact = useCallback(async (card) => {
    if (!token || !card) return false;
    if (!card.phone && !card.email) return false;
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
      // Dedupe: if a contact with this phone already exists, update rather than create
      if (card.phone) {
        const raw = (card.phone || "").replace(/\D/g, "");
        const sr = await fetch(
          `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(card.phone)}&readMask=names,phoneNumbers,metadata&pageSize=5`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const sd = await sr.json();
        const existing = sd.results?.find(r =>
          (r.person?.phoneNumbers || []).some(p => p.value?.replace(/\D/g,"") === raw)
        );
        if (existing?.person?.resourceName) {
          // Already in contacts — mark as pushed, don't bother updating.
          return true;
        }
      }
      const res = await fetch("https://people.googleapis.com/v1/people:createContact", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch { return false; }
  }, [token]);

  // Track which stops have already been auto-pushed so we don't re-push on
  // every calendar reload. Stored by event id to survive app restarts.
  const [contactsPushed, setContactsPushed] = useState(() => lsGet("mts-contacts-pushed", {}));
  useEffect(() => { lsSet("mts-contacts-pushed", contactsPushed); }, [contactsPushed]);

  // (Auto-contact-push effect is defined below, after allParsed is declared.)

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

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const cloud = await loadAppState(token);
        if (cloud) {
          // Merge pipeline: cloud wins
          if (cloud.pipeline && Object.keys(cloud.pipeline).length > 0) {
            const local = loadPipeline();
            const merged = { ...local, ...cloud.pipeline };
            savePipeline(merged);
          }
          // Merge dismissed: cloud wins, keep local-only
          if (cloud.dismissed) {
            setDismissed(prev => ({ ...prev, ...cloud.dismissed }));
          }
          // Merge lastContact per-id, newest wins (cloud wins on ties)
          if (cloud.lastContact) {
            setLastContact(prev => {
              const m = { ...prev };
              for (const [id, lc] of Object.entries(cloud.lastContact)) {
                const existing = prev[id];
                if (!existing || (lc?.at || 0) >= (existing.at || 0)) m[id] = lc;
              }
              return m;
            });
          }
        }
      } catch(e) {
        console.warn("Cloud pull failed:", e);
      }
    })();
  }, [token]);

  // ── SYNC: push + pull Drive data ────────────────────────────────────────
  const cloudSyncTimer = useRef(null);
  const [lastSyncTime, setLastSyncTime] = useState(0);
  const [syncPulling, setSyncPulling] = useState(false);

  const triggerCloudSync = useCallback(async (immediate = false) => {
    if (!token) return;
    const run = async () => {
      await saveAppState(token, loadPipeline(), dismissed, lastContact).catch(() => {});
      // Iterate IndexedDB for field data — localStorage now only holds a
      // slim mirror that omits base64 photo/audio bytes, so reading from
      // there would push an empty shell to Drive and silently erase media.
      try {
        const ids = await listFieldIds();
        for (const id of ids) {
          try {
            const fd = await loadField(id);
            if (fd && Object.keys(fd).length > 0) {
              await saveFieldToDrive(token, id, fd).catch(() => {});
            }
          } catch {}
        }
      } catch {}
    };
    if (immediate) { await run(); return; }
    if (cloudSyncTimer.current) clearTimeout(cloudSyncTimer.current);
    cloudSyncTimer.current = setTimeout(run, 2000);
  }, [token, dismissed, lastContact]);

  useEffect(() => { triggerCloudSync(); }, [dismissed, lastContact, triggerCloudSync]);

  const pullFromDrive = useCallback(async () => {
    if (!token) return;
    setSyncPulling(true);
    try {
      const state = await loadAppState(token);
      if (state?.pipeline) {
        const local = loadPipeline();
        const merged = { ...local };
        for (const [id, dc] of Object.entries(state.pipeline)) {
          const lc = local[id];
          if (!lc || (dc.stageChangedAt||0) > (lc.stageChangedAt||0)) merged[id] = dc;
        }
        savePipeline(merged);
      }
      if (state?.dismissed) {
        setDismissed(prev => {
          const m = { ...prev };
          for (const [id, ts] of Object.entries(state.dismissed)) {
            if (ts > (prev[id]||0)) m[id] = ts;
          }
          return m;
        });
      }
      if (state?.lastContact) {
        setLastContact(prev => {
          const m = { ...prev };
          for (const [id, lc] of Object.entries(state.lastContact)) {
            const existing = prev[id];
            if (!existing || (lc?.at || 0) > (existing.at || 0)) m[id] = lc;
          }
          return m;
        });
      }
      const files = await listFieldFiles(token);
      for (const f of (files || [])) {
        const id = f.name.replace(/\.json$/, "");
        const localData = await loadField(id);
        const localTs = localData?.savedAt || 0;
        const remoteTs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
        if (localTs === 0 || remoteTs > localTs) {
          const data = await loadFieldFromDrive(token, id);
          if (data) await saveField(id, data).catch(() => {});
        }
      }
      setLastSyncTime(Date.now());
      window.dispatchEvent(new CustomEvent("mts-field-synced"));
    } catch(e) { console.warn("Pull failed:", e); }
    setSyncPulling(false);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const t = setTimeout(() => pullFromDrive(), 3000);
    return () => clearTimeout(t);
  }, [token]);

  useEffect(() => {
    const fn = () => { if (document.visibilityState === "visible" && token) pullFromDrive(); };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, [token, pullFromDrive]);

  // ── PARSE ────────────────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  const allParsed = useMemo(() => {
    const raw = rawEvents[dayKey] || [];
    return raw.map(parseEvent).filter(Boolean).filter(s => !s.isAdmin);
  }, [rawEvents, dayKey]);

  // Auto-push new contacts to Google Contacts silently. Runs when allParsed
  // changes — finds stops with phone/email that haven't been pushed yet and
  // pushes them one at a time at 400ms intervals. Each stop is pushed at
  // most once, ever (tracked in contactsPushed).
  useEffect(() => {
    if (!token || !allParsed.length) return;
    const unpushed = allParsed.filter(s =>
      s.isTask &&
      !contactsPushed[s.id] &&
      (s.phone || s.email)
    );
    if (unpushed.length === 0) return;
    let dead = false;
    (async () => {
      const now = Date.now();
      const updates = {};
      for (const stop of unpushed) {
        if (dead) return;
        const ok = await autoPushContact(stop);
        if (ok) updates[stop.id] = now;
        await new Promise(r => setTimeout(r, 400));
      }
      if (!dead && Object.keys(updates).length > 0) {
        setContactsPushed(prev => ({ ...prev, ...updates }));
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParsed, token]);

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

  // Delete a stop entirely (no pipeline, no restore).
  // For TDs with a real calendar event id, we also mark the event graphite
  // (colorId 8) in Google Calendar so the delete is visible in the source
  // of truth, not just in the app.
  const deleteStop = (id) => {
    setDismissed(p => ({...p, [id]: Date.now()}));
    setExpanded(null);
    // Remove from ordIds so it stays gone
    setOrdIds(prev => {
      const order = prev[dayKey] || [];
      return { ...prev, [dayKey]: order.filter(i => i !== id) };
    });
    // Grey out the event in Google Calendar for TDs with real event ids
    const stop = stopMap[id];
    if (token && id && !id.startsWith("local-") && stop && !stop.isTask) {
      fetch(`${CAL_BASE}/events/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ colorId: "8" }),
      }).catch(e => console.warn("Calendar color push (delete TD) failed:", e));
    }
  };

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  const openOnsite = (stop) => { setOnsiteStop(stop); setExpanded(null); };
  const [declineConfirm, setDeclineConfirm] = useState(null); // stop id awaiting confirm
  const [signOutConfirm, setSignOutConfirm] = useState(false);
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
      // Also sync field data to Drive — read from IDB so base64 media is included
      if (token) {
        loadField(id).then(fd => {
          if (fd && Object.keys(fd).length > 0) {
            saveFieldToDrive(token, id, fd).catch(() => {});
          }
        });
      }
    }
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
    setUndoToast({ id, cn: stop?.cn || "Stop", stop });
    undoToastTimer.current = setTimeout(() => setUndoToast(null), 10000);
    // Contacts auto-save on calendar import — no prompt needed.
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


  // ── TEXT-TO-SPEECH (phone speaker) ────────────────────────────────────
  // Gemini TTS returns raw PCM: signed 16-bit, 24000 Hz, mono. The browser's
  // <audio> element can't play headerless PCM, so we wrap it in a 44-byte
  // RIFF/WAVE header before creating the Blob. Previously this fed raw PCM
  // to Audio() with an audio/wav MIME type — which silently failed to play.
  function pcmToWav(pcm, sampleRate = 24000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcm.length;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);            // fmt chunk size
    view.setUint16(20, 1, true);             // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(pcm);
    return buf;
  }

  const ttsAudioRef = useRef(null);
  const ttsSafetyTimer = useRef(null);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [ttsError, setTtsError] = useState(null);

  const resetTts = () => {
    setTtsSpeaking(false);
    if (ttsAudioRef.current) { try { ttsAudioRef.current.pause(); } catch(e){} ttsAudioRef.current = null; }
    if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
    if (ttsSafetyTimer.current) { clearTimeout(ttsSafetyTimer.current); ttsSafetyTimer.current = null; }
  };

  // Try a single Gemini TTS model. Returns {ok, audio} on success, or
  // {ok:false, error:...} on any failure. Doesn't mutate component state.
  const tryGeminiTts = async (modelId, text, geminiKey) => {
    console.log(`[TTS] Trying model: ${modelId}`);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Read this aloud clearly at a comfortable pace: ${text}` }] }],
            generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } },
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[TTS] ${modelId} returned HTTP ${res.status}:`, body.slice(0, 300));
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) {
        console.warn(`[TTS] ${modelId} returned no audio data. Response:`, data);
        return { ok: false, error: "no audio in response" };
      }
      const pcm = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const wavBuffer = pcmToWav(pcm, 24000);
      const blob = new Blob([wavBuffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      console.log(`[TTS] ${modelId} succeeded, ${pcm.length} PCM bytes, wrapped to WAV`);
      return { ok: true, audio, url };
    } catch (e) {
      console.warn(`[TTS] ${modelId} threw:`, e);
      return { ok: false, error: e?.message || String(e) };
    }
  };

  const speakStop = async (stop) => {
    // If already speaking, stop
    if (ttsSpeaking) { resetTts(); return; }

    const text = stop.notes || "No notes available.";
    const geminiKey = import.meta.env.VITE_GEMINI_KEY;
    setTtsSpeaking(true);
    setTtsError(null);
    if (ttsSafetyTimer.current) clearTimeout(ttsSafetyTimer.current);
    ttsSafetyTimer.current = setTimeout(() => resetTts(), 90000);

    console.log("[TTS] Starting. Key present:", !!geminiKey, "Text length:", text.length);

    // Try Gemini TTS with two model IDs in sequence:
    // 1) gemini-3.1-flash-tts-preview (launched Apr 2026)
    // 2) gemini-2.5-flash-preview-tts (older, may be more broadly accessible)
    const errors = [];
    if (geminiKey) {
      for (const modelId of ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]) {
        const result = await tryGeminiTts(modelId, text, geminiKey);
        if (result.ok) {
          result.audio.onended = () => { URL.revokeObjectURL(result.url); resetTts(); };
          result.audio.onerror = (ev) => {
            console.warn("[TTS] Audio element error:", ev);
            URL.revokeObjectURL(result.url);
            setTtsError("Audio playback failed");
            resetTts();
          };
          ttsAudioRef.current = result.audio;
          try {
            await result.audio.play();
            return;
          } catch (e) {
            console.warn("[TTS] audio.play() rejected:", e);
            errors.push(`play: ${e?.message || e}`);
            URL.revokeObjectURL(result.url);
            // Fall through to speechSynthesis
            break;
          }
        }
        errors.push(`${modelId}: ${result.error}`);
      }
    } else {
      errors.push("no VITE_GEMINI_KEY");
    }

    // Path 3: speechSynthesis fallback (robotic, but reliable if voices load)
    if (window.speechSynthesis) {
      console.log("[TTS] Falling back to speechSynthesis");
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.85;
      u.onend = () => resetTts();
      u.onerror = (ev) => {
        console.warn("[TTS] speechSynthesis error:", ev);
        setTtsError("Browser TTS failed. " + errors.join(" | "));
        resetTts();
      };
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        window.speechSynthesis.speak(u);
      } else {
        // iOS Safari quirk: voices load async. Wait for them.
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.speak(u);
          window.speechSynthesis.onvoiceschanged = null;
        };
        // Safety: if voices never load, surface the error after 2s
        setTimeout(() => {
          if (!window.speechSynthesis.speaking && ttsSpeaking) {
            setTtsError("TTS failed. " + errors.join(" | "));
            resetTts();
          }
        }, 2000);
      }
    } else {
      setTtsError("TTS unavailable. " + errors.join(" | "));
      resetTts();
    }
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
  // Register service worker for PWA + listen for new deploys.
  // When Vite builds a new bundle, the service worker sees new assets and
  // installs a new version. We detect that, skip-waiting it, and reload so
  // the user is on the latest code without manual cache clears.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("/sw.js").then(reg => {
      // Check for updates on load + every 30 min.
      const check = () => reg.update().catch(() => {});
      check();
      const iv = setInterval(check, 30 * 60 * 1000);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            // A new version is ready and there's an existing controller —
            // activate the new SW. The controllerchange handler above will reload.
            nw.postMessage("SKIP_WAITING");
          }
        });
      });
      return () => clearInterval(iv);
    }).catch(() => {});
  }, []);

  if (!token) return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0a0b10",fontFamily:"'Oswald','DM Sans',system-ui,sans-serif",color:"#f0f4fa",padding:20,paddingTop:"max(20px,env(safe-area-inset-top))",boxSizing:"border-box"}}>
      <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=DM+Sans:wght@500;700;800&display=swap" rel="stylesheet"/>
      <div style={{fontSize:28,fontWeight:900,letterSpacing:3,textTransform:"uppercase",fontFamily:"'Oswald',sans-serif"}}>MTS FIELD SALES</div>
      <div style={{fontSize:12,color:"#5a6580",marginBottom:32,fontWeight:500,letterSpacing:1}}>Monster Tree Service of Rochester</div>
      <button onClick={initAuth} style={{padding:"16px 40px",borderRadius:12,background:"#1a2035",border:"1px solid #2a3560",color:"#f0f4fa",fontSize:16,fontWeight:700,cursor:"pointer",letterSpacing:.5}}>Sign in with Google</button>
      {error && <div style={{marginTop:16,color:"#ff5555",fontSize:12}}>{error}</div>}
    </div>
  );

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
        {/* Segmented pill switch — ROUTE | PIPELINE */}
        <div style={{display:"flex",background:"#0a0b10",border:"1px solid #1a2035",borderRadius:10,padding:2,flexShrink:0}}>
          <button onClick={()=>setView("route")} style={{padding:"5px 12px",borderRadius:8,background:view==="route"?"#1a2035":"transparent",border:"none",cursor:"pointer",fontFamily:"'Oswald',sans-serif",fontWeight:700,fontSize:12,letterSpacing:1.5,textTransform:"uppercase",color:view==="route"?"#f0f4fa":"#4a5a70",transition:"all .15s"}}>Route</button>
          <button onClick={()=>setView("pipeline")} style={{padding:"5px 12px",borderRadius:8,background:view==="pipeline"?"#1a2035":"transparent",border:"none",cursor:"pointer",fontFamily:"'Oswald',sans-serif",fontWeight:700,fontSize:12,letterSpacing:1.5,textTransform:"uppercase",color:view==="pipeline"?"#10B981":"#4a5a70",transition:"all .15s",display:"flex",alignItems:"center",gap:4}}>
            Pipeline
            {(() => {
              try {
                const pl = JSON.parse(localStorage.getItem("mts-pipeline") || "{}");
                const hot = Object.values(pl).filter(c => c.hot && c.stage !== "declined" && c.stage !== "sold").length;
                return hot > 0 ? <span style={{fontSize:9,padding:"1px 5px",borderRadius:999,background:"rgba(255,179,0,.2)",color:"#FFB300",fontWeight:800}}>{hot}🔥</span> : null;
              } catch { return null; }
            })()}
          </button>
        </div>
        {token && <button onClick={() => { triggerCloudSync(true); pullFromDrive(); }}
          title="Tap to sync"
          style={{background:"none",border:"none",cursor:"pointer",padding:"2px 6px",display:"flex",alignItems:"center",gap:3}}>
          {syncIndicator==="error" ? <IconCloudOff size={13} color="#FF5555"/> : (syncIndicator==="syncing"||syncPulling) ? <IconCloud size={13} color="#F6BF26"/> : <IconCloud size={13} color="#10B981"/>}
          {lastSyncTime>0 && <span style={{fontSize:9,color:"#3a5060",fontFamily:"'Oswald',sans-serif"}}>{Math.floor((Date.now()-lastSyncTime)/60000)<1?"now":`${Math.floor((Date.now()-lastSyncTime)/60000)}m`}</span>}
        </button>}
        <div style={{flex:1}}/>
        {view === "route" && <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setReorderMode(false);setMoving(null);}} style={{padding:"5px 10px",borderRadius:8,border:"1px solid #2a3560",background:"#0a0b10",color:"#f0f4fa",fontSize:11,fontWeight:600,cursor:"pointer",outline:"none",appearance:"auto",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
          {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
        </select>}
        {view === "pipeline" && <input value={pipelineSearch} onChange={e=>setPipelineSearch(e.target.value)} placeholder="Search..." style={{maxWidth:180,padding:"5px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:12,fontFamily:"'DM Sans',system-ui,sans-serif",outline:"none"}} />}
      </div>

      {/* ── ROUTE VIEW ──────────────────────────────────────────────── */}
      {view === "route" && <>
      {/* ── BODY: map + list (side-by-side on desktop) ─────────────── */}
      <div className="mts-body">

      {/* ── MAP ────────────────────────────────────────────────────────── */}
      <div className="mts-map">
        {reorderMode && <div style={{padding:"5px 12px",background:"rgba(142,36,170,.08)",borderTop:"1px solid rgba(142,36,170,.15)",display:"flex",alignItems:"center",gap:8}}>
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
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>{e.stopPropagation();markContact(s.id,"call");}} style={{padding:"5px 10px",borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#90a8c0",fontSize:12,textDecoration:"none",fontWeight:700,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><IconPhone size={13} color="#90a8c0"/></a>}
              </div>

              {s.constraint && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(255,80,160,.12)",border:"1px solid rgba(255,80,160,.25)",color:"#FF80AB",fontSize:12,fontWeight:800,display:"inline-block",letterSpacing:0.3,fontFamily:"'Oswald','DM Sans',sans-serif",textTransform:"uppercase"}}>{s.constraint}</div>}

              {s.titleContext && !reorderMode && <div style={{marginTop:4,marginLeft:isNext?50:44,fontSize:12,color:"#b0b8c8",lineHeight:1.5,fontStyle:"italic",fontWeight:500}}>{s.titleContext}</div>}

              {isExp && <div onClick={e=>e.stopPropagation()} style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {lastContact[s.id] && (() => {
                  const lc = lastContact[s.id];
                  const mins = Math.floor((Date.now() - lc.at) / 60000);
                  const label = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;
                  const kindLabel = lc.kind === "sms" ? "Texted" : lc.kind === "call" ? "Called" : lc.kind === "email" ? "Emailed" : "Contacted";
                  return <div style={{fontSize:11,color:"#64B5F6",marginBottom:8,fontWeight:600,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>{kindLabel} · {label}</div>;
                })()}
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
      {view === "route" && <div style={{borderTop:"1px solid #0e1520",padding:"4px 10px",paddingBottom:"max(4px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",gap:6,background:"#080a10",flexShrink:0}}>
        {/* Undo — left */}
        <button onClick={undo} disabled={!undoStack.length} title="Undo"
          style={{width:32,height:32,borderRadius:8,background:"transparent",border:`1px solid ${undoStack.length?"#1a2035":"transparent"}`,cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <IconUndo size={14} color={undoStack.length?"#5a6580":"#1a2035"}/>
        </button>
        {/* Reorder — centered, prominent */}
        <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}}
          title={reorderMode?"Done reordering":"Reorder stops"}
          style={{flex:1,height:32,borderRadius:8,background:reorderMode?"rgba(142,36,170,.2)":"rgba(255,255,255,.04)",border:`1px solid ${reorderMode?"rgba(142,36,170,.5)":"#252d47"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,transition:"all .15s"}}>
          <IconReorder size={15} color={reorderMode?"#c8a0e8":"#5a6890"}/>
          <span style={{fontSize:11,fontWeight:700,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",color:reorderMode?"#c8a0e8":"#5a6890"}}>{reorderMode?"DONE":"REORDER"}</span>
        </button>
        {/* Sign out — right */}
        <button
          onClick={()=>{ if(signOutConfirm){ setToken(null); try{localStorage.removeItem("mts-token");}catch(e){} setSignOutConfirm(false);} else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }}
          title={signOutConfirm ? "Tap again to confirm sign out" : "Sign out"}
          style={{width:32,height:32,borderRadius:8,background:signOutConfirm?"rgba(255,85,85,.15)":"transparent",border:`1px solid ${signOutConfirm?"rgba(255,85,85,.4)":"#1a2035"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={signOutConfirm?"#FF5555":"#3a4a60"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>}
      {view === "pipeline" && <div style={{borderTop:"1px solid #0e1520",padding:"4px 10px",paddingBottom:"max(4px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",justifyContent:"flex-end",background:"#080a10",flexShrink:0}}>
        <button
          onClick={()=>{ if(signOutConfirm){ setToken(null); try{localStorage.removeItem("mts-token");}catch(e){} setSignOutConfirm(false);} else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }}
          title={signOutConfirm ? "Tap again to confirm sign out" : "Sign out"}
          style={{width:32,height:32,borderRadius:8,background:signOutConfirm?"rgba(255,85,85,.15)":"transparent",border:`1px solid ${signOutConfirm?"rgba(255,85,85,.4)":"#1a2035"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s"}}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={signOutConfirm?"#FF5555":"#3a4a60"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
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
      {view === "pipeline" && <Pipeline onSwitchToRoute={(cardId) => { setView("route"); if (cardId) { setDismissed(prev => { const n={...prev}; delete n[cardId]; return n; }); const pl=loadPipeline(); delete pl[cardId]; savePipeline(pl); } }} search={pipelineSearch} onCloudSync={triggerCloudSync} token={token} lastContact={lastContact} markContact={markContact} />}

      {/* ── TEXT SHEET ─────────────────────────────────────────────────── */}
      {textSheet && <div onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:"max(18px,env(safe-area-inset-bottom))"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1}}>Text {(textSheet.cn||"").split(" ")[0]}</span>
            <span style={{fontSize:12,color:"#5a6580"}}>{textSheet.phone}</span>
            <button onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={13} color="#5a6580"/></button>
          </div>

          <button onClick={()=>{window.open(`sms:${textSheet.phone.replace(/\D/g,"")}`,"_self");markContact(textSheet.id,"sms");setTextSheet(null);}} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",textAlign:"left"}}>
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
                    markContact(textSheet.id,"sms");
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

      {/* ── UNDO TOAST ─────────────────────────────────────────────── */}
      {undoToast && <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#1a2a20",borderTop:"1px solid rgba(16,185,129,.3)",display:"flex",alignItems:"center",gap:10,zIndex:150}}>
        <div style={{flex:1,fontSize:13,color:"#10B981",fontWeight:600,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconCheckCircle size={13} color="#10B981"/>{undoToast.cn} → PIPELINE</span></div>
        <button onClick={undoToastAction} style={{padding:"6px 16px",borderRadius:8,background:"rgba(255,183,77,.12)",border:"1px solid rgba(255,183,77,.3)",color:"#FFB74D",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5}}>UNDO</button>
        <button onClick={() => { if (undoToastTimer.current) clearTimeout(undoToastTimer.current); setUndoToast(null); }} style={{padding:"6px 10px",borderRadius:6,background:"transparent",border:"none",color:"#4a6050",cursor:"pointer",display:"flex",alignItems:"center"}}><IconX size={14} color="#4a6050"/></button>
      </div>}

      {/* ── TTS ERROR TOAST ────────────────────────────────────────── */}
      {ttsError && <div style={{position:"fixed",bottom:undoToast?"56px":"0",left:0,right:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#2a1a1a",borderTop:"1px solid rgba(255,85,85,.35)",display:"flex",alignItems:"flex-start",gap:10,zIndex:151,transition:"bottom .2s"}}>
        <div style={{flex:1,fontSize:12,color:"#FF8888",fontWeight:500,lineHeight:1.45}}>
          <div style={{fontWeight:700,marginBottom:2,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",fontSize:11}}>TTS failed</div>
          <div style={{fontSize:11,color:"#e0a0a0",wordBreak:"break-word"}}>{ttsError}</div>
        </div>
        <button onClick={() => setTtsError(null)} style={{padding:"4px 8px",borderRadius:6,background:"transparent",border:"none",color:"#a06060",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}><IconX size={14} color="#a06060"/></button>
      </div>}
    </div>
  );
}
