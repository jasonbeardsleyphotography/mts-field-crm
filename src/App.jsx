import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { parseEvent, stageColor } from "./parseEvent";
import RouteMap, { AM_COLOR, PM_COLOR } from "./RouteMap";
import SwipeCard from "./SwipeCard";
import OnsiteWindow from "./OnsiteWindow";
import UniversalSearch from "./UniversalSearch";
import Pipeline, { savePipeline, loadPipeline, pushCalendarColor } from "./Pipeline";
import { saveAppState, loadAppState, loadFieldFromDrive, listFieldFiles, onSyncStatus, onAuthError, queueFieldDriveSync } from "./driveSync";
import { loadField, listFieldIds, updateField, getDirtyFieldIds, deleteFieldDB } from "./fieldStore";
import { startPhotoSyncWatcher } from "./photoSync";
import { photoKey } from "./imageUtils";
import { startVideoQueueWatcher, pendingCount as videoPendingCount, onQueueChange as onVideoQueueChange, deleteVideoQueueDB } from "./videoQueue";
import { pruneLog as pruneVideoLog } from "./videoLog";
import UploadTracker from "./UploadTracker";
import DebugPanel from "./DebugPanel";
import NextStopCard from "./NextStopCard";
import VideoUploads from "./VideoUploads";
import StoragePanel from "./StoragePanel";
import RecoveryScreen from "./RecoveryScreen";
import Linkify from "./Linkify";
import AddStopModal from "./AddStopModal";
import { buildClientIndex } from "./clientIndex";
import {
  IconArrowLeft, IconNavigation, IconMessageSquare, IconVolume2,
  IconClipboard, IconX, IconRotateCcw, IconRefresh, IconReorder, IconUndo,
  IconPlus, IconSearch, IconTrash, IconChevronDown, IconChevronRight,
  IconCloud, IconCloudOff, IconCheckCircle, IconEdit, IconPhone, IconMail, IconClock, IconCalendar,
  IconNoSymbol, IconDatabase, IconVideo
} from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS FIELD ROUTE — Main App
   Built for bright sun, one thumb, between-stops glances.
   ═══════════════════════════════════════════════════════════════════════════ */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";
// NOTE: no youtube scope. The app uploads videos to Drive now (not YouTube),
// so youtube is dead weight — and Google rejects youtube + drive.file in the
// same authorization request ("scopes that cannot be requested together",
// Error 400: invalid_request), which was blocking sign-in. Deleting a legacy
// YouTube video from the card still works; only the YouTube-side delete no-ops.
const SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/contacts";

// ── HELPERS ──────────────────────────────────────────────────────────────────
// includeWeekends: opt-in (persisted via mts-include-weekends) — when false
// (the long-standing default), Saturdays/Sundays are skipped entirely, so
// there was no day tab to select and no way to add a visit to a weekend.
function getBusinessDays(n, includeWeekends = false) {
  const days = []; let d = new Date(); d.setHours(0,0,0,0);
  while (days.length < n) { if (includeWeekends || (d.getDay()!==0 && d.getDay()!==6)) days.push(new Date(d)); d.setDate(d.getDate()+1); }
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

// Resolve the signed-in Google account's identity (email) via the People API.
// Uses the already-granted `contacts` scope, so no extra consent prompt.
async function fetchGoogleAccountId(token) {
  try {
    const r = await fetch(
      "https://people.googleapis.com/v1/people/me?personFields=emailAddresses",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const emails = d.emailAddresses || [];
    const primary = emails.find(e => e.metadata?.primary) || emails[0];
    // Return ONLY a real email as the account identity. Previously this fell
    // back to the People API resourceName (e.g. "people/c123") when the email
    // list came back empty (partial response / permission warmup right after
    // sign-in). That resourceName then got stored as the account id, and on a
    // later load — when the email DID resolve — the mismatch looked like a
    // different account and wiped ALL local data (pipeline, photos, videos).
    // Returning null instead just makes the caller retry next load, harmless.
    return primary?.value ? primary.value.toLowerCase() : null;
  } catch { return null; }
}

// Wipe all app data on this device (keeping only the current auth token), then
// reload. Called when a DIFFERENT Google account signs in so one account's
// pipeline/photos/videos/caches never bleed into another's. Each account's data
// is safe in its own Drive and re-syncs on next load.
async function clearLocalDataForAccountSwitch(newAccountId) {
  try {
    const remove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("mts-") && k !== "mts-token") remove.push(k);
    }
    remove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
    localStorage.setItem("mts-account", newAccountId);
  } catch {}
  try { await deleteFieldDB(); } catch {}
  try { await deleteVideoQueueDB(); } catch {}
  try { location.reload(); } catch {}
}
// Persist locally-created route stops (id starts with "local-") across reloads.
// Format: { [id]: { event: <raw event obj>, dk: <dayKey string> } }
function localStopsGet() { return lsGet("mts-local-stops", {}); }
function localStopsSet(val) { lsSet("mts-local-stops", val); }

// Manual corrections to a calendar-derived stop's contact/address details.
// Calendar-parsed stops are recomputed fresh from the event every load, so
// edits can't live on the parsed object itself — this is a merge-on-top layer
// keyed by stop id, applied wherever the final stop list is built.
// Format: { [id]: { cn?, addr?, phone?, email?, jn? } }
function stopOverridesGet() { return lsGet("mts-stop-overrides", {}); }
function stopOverridesSet(val) { lsSet("mts-stop-overrides", val); }

// ═════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  // Restore cached token. If it's past its stored expiry we boot with token
  // null — but we suppress the sign-in screen via `authBootChecked` until the
  // cold-start silent reauth (below) has had a chance to refresh it. That's
  // what fixes the "every SW reload kicks me to the login screen" pain.
  const [token, setToken] = useState(() => {
    const saved = lsGet("mts-token", null);
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
    return null;
  });
  // Track whether we've completed the initial silent-reauth attempt. While
  // this is false AND we have no token, we render a loader instead of the
  // sign-in screen so the user doesn't see a flash of "Sign in" before
  // silent reauth completes.
  const [authBootChecked, setAuthBootChecked] = useState(() => {
    const saved = lsGet("mts-token", null);
    // Only skip the boot check when there's a usable fresh token.
    return !!(saved?.token && saved.expiry > Date.now());
  });
  // Mid-session token trouble (silent reauth failed but we still have local
  // data): instead of bouncing to the full sign-in screen, we keep the app
  // usable and surface a single "Reconnect Google" affordance.
  const [needsReconnect, setNeedsReconnect] = useState(false);
  // Guards so auth triggers can't stack into a popup storm.
  const _interactiveInFlight = useRef(false); // an interactive popup is open
  const _lastVisReauth = useRef(0);           // last visibility-driven silent reauth
  const _authBusy = useRef(false);            // any auth flow active (defer SW reload)
  const saveToken = (t, expiresIn) => {
    setToken(t);
    if (t) {
      // Use the actual expires_in from Google's response (seconds) when
      // available, with a 60s safety buffer. Fall back to 55 min if unknown.
      const ttlMs = ((typeof expiresIn === "number" ? expiresIn : 3300) * 1000) - 60000;
      lsSet("mts-token", { token: t, expiry: Date.now() + Math.max(ttlMs, 60000) });
    }
    else { try { localStorage.removeItem("mts-token"); } catch(e) {} }
  };

  // ── SILENT RE-AUTH ────────────────────────────────────────────────────────
  // Singleton guard: if a silent reauth is already in flight, return the same
  // promise instead of launching a second token request. This prevents the
  // rapid-fire popup loop that occurs when multiple concurrent Drive/Calendar
  // 401 responses each independently call silentReauth().
  // GIS silent token (the ORIGINAL implicit-flow mechanism) — now only a
  // FALLBACK, used when the server session flow isn't available (non-Safari,
  // or before the user has done the server sign-in once).
  const _gisSilentReauth = useCallback(() => new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(watchdog); resolve(ok); };
    const watchdog = setTimeout(() => finish(false), 30000);
    if (!window.google?.accounts?.oauth2) { finish(false); return; }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPES,
      callback: r => { if (r.access_token) { saveToken(r.access_token, r.expires_in); finish(true); } else finish(false); },
      error_callback: () => finish(false),
    });
    client.requestAccessToken({ prompt: "" });
  }), []);

  const _reauthInFlight = useRef(null);
  const silentReauth = useCallback(() => {
    if (_reauthInFlight.current) return _reauthInFlight.current;
    _reauthInFlight.current = (async () => {
      // 1) SERVER SESSION (refresh-token flow). Silent, and immune to Safari
      //    clearing Google's cookies because the refresh token lives on our
      //    server behind a first-party session cookie — this is the fix for the
      //    recurring hourly sign-in popups. Returns 401 when there's no session
      //    yet or the refresh token has expired (weekly in Testing mode).
      try {
        const r = await fetch("/api/token", { credentials: "same-origin", cache: "no-store" });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          if (d?.access_token) { saveToken(d.access_token, d.expires_in); return true; }
        }
      } catch { /* network — fall through to GIS */ }
      // 2) Fall back to the original GIS silent token.
      return await _gisSilentReauth();
    })();
    _reauthInFlight.current.finally(() => { _reauthInFlight.current = null; });
    return _reauthInFlight.current;
  }, [_gisSilentReauth]);

  // ── COLD-START SILENT REAUTH ──────────────────────────────────────────────
  // On boot, if there's no fresh token (none, or past stored expiry), try
  // silent reauth before falling back to the sign-in screen. GIS has to load
  // first, so we poll briefly. If silent reauth succeeds the user never sees
  // the sign-in UI; if it fails (no Google session in this browser) we flip
  // authBootChecked so the sign-in screen renders.
  useEffect(() => {
    if (authBootChecked) return;
    let cancelled = false;
    // Retry silent reauth a few times with backoff before giving up and
    // showing the sign-in screen. Most cold-start failures are transient (GIS
    // script still warming up, a network blip, app resumed from deep
    // background) rather than a genuinely dead Google session — retrying
    // absorbs those so the user isn't bounced to "Sign in" unnecessarily. If
    // the session really is gone, every attempt fails and we still land on the
    // sign-in screen, just a couple seconds later.
    const BACKOFFS = [400, 900, 1800, 3000]; // ms between attempts — a few more,
    // longer waits so a flaky-cellular cold start (the stated field environment)
    // doesn't give up on a perfectly-alive server session after barely ~1s.
    let attempt = 0;
    const run = async () => {
      if (cancelled) return;
      // Note: no longer gated on GIS being loaded — silentReauth tries the
      // server session (/api/token) first, which needs no Google script. GIS is
      // only used as a fallback inside silentReauth.
      const ok = await silentReauth();
      if (cancelled) return;
      if (ok) { setAuthBootChecked(true); return; }
      if (attempt < BACKOFFS.length) {
        const delay = BACKOFFS[attempt++];
        setTimeout(run, delay);
        return;
      }
      // Exhausted retries — show the sign-in screen, but do NOT delete the
      // stored token record. Deleting it made the visibility handler treat the
      // user as having explicitly signed out (`if (!saved && authBootChecked)
      // return`), so a merely-transient cold-start failure on flaky cell became
      // a permanent strand on the sign-in screen with no auto-recovery. Keeping
      // the (expired) record lets the next foreground silently retry; explicit
      // sign-out is the only path that should clear it.
      setAuthBootChecked(true);
    };
    run();
    return () => { cancelled = true; };
  }, [authBootChecked, silentReauth]);

  // Auto-refresh token on a 50-min interval while the tab is active. Gated on
  // having a token — no point polling if we don't have anything to refresh.
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => { silentReauth(); }, 50 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token, silentReauth]);

  // Visibility-change refresh — installed unconditionally so it fires even
  // when the in-memory token is null (e.g. after an error cleared it, or on
  // boot before cold-start reauth completes). Checks localStorage directly
  // rather than relying on `token` state, and skips if the user explicitly
  // signed out (no stored token at all and authBootChecked is true).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const saved = lsGet("mts-token", null);
      // If there's no stored record at all AND boot already finished, the user
      // explicitly signed out — respect that and don't auto-reauth.
      if (!saved && authBootChecked) return;
      const needsRefresh = !saved || saved.expiry - Date.now() < 20 * 60 * 1000;
      // Rate-limit: rapid focus flips on a Chromebook must not stack reauths.
      if (needsRefresh && Date.now() - _lastVisReauth.current > 60_000) {
        _lastVisReauth.current = Date.now();
        silentReauth();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [silentReauth, authBootChecked]);

  // ── DRIVE AUTH ERROR HANDLER ─────────────────────────────────────────────
  // When any Drive API call returns 401/403, automatically attempt a silent
  // token refresh so the next sync attempt uses a fresh token.
  useEffect(() => {
    onAuthError(() => { silentReauth(); });
  }, [silentReauth]);

  // ── ACCOUNT IDENTITY / CLEAR-ON-SWITCH ────────────────────────────────────
  // Once per load, resolve which Google account this token belongs to. If it's
  // a DIFFERENT account than last time on this device, wipe local data + reload
  // so nothing bleeds across accounts (own-device usage means this effectively
  // never fires; it's a safety net). First sign-in just records the account.
  // If identity can't be resolved (offline), we do nothing and retry next load.
  const _acctChecked = useRef(false);
  useEffect(() => {
    if (!token || _acctChecked.current) return;
    _acctChecked.current = true;
    (async () => {
      const acct = await fetchGoogleAccountId(token);
      if (!acct) { _acctChecked.current = false; return; } // couldn't resolve — retry
      let prev = null;
      try { prev = localStorage.getItem("mts-account"); } catch {}
      // Only wipe on a genuine email↔email switch. Guard against ever nuking
      // data when either side isn't a real email (legacy resourceName values,
      // or any non-email that slipped in) — a destructive wipe must require
      // unambiguous proof of a different account, not a format mismatch.
      const bothEmails = prev && prev.includes("@") && acct.includes("@");
      if (prev && prev !== acct && bothEmails) {
        await clearLocalDataForAccountSwitch(acct); // wipes + reloads
        return;
      }
      try { localStorage.setItem("mts-account", acct); } catch {}
    })();
  }, [token]);

  // ── OFFLINE PHOTO QUEUE ───────────────────────────────────────────────────
  // Start the watcher once we have a valid token. The watcher installs
  // window "online" and visibilitychange listeners so it only runs once total.
  // It also fires immediately to process any queue from a prior session.
  useEffect(() => {
    if (!token) return;
    const getTok = () => {
      const saved = lsGet("mts-token", null);
      return (saved && saved.expiry > Date.now()) ? saved.token : null;
    };
    startPhotoSyncWatcher(getTok);
    startVideoQueueWatcher(getTok);
    // Prune the video diagnostic log on each startup so it doesn't grow
    // unbounded across many sessions.
    pruneVideoLog().catch(() => {});
  }, [token]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Handle the return from the server sign-in redirect (/api/oauth/callback
  // bounces back with ?signedin=1 or ?oauth_error=…). Surface any error and
  // strip the one-time flags so a later refresh doesn't repeat them.
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.has("oauth_error")) setError("Sign-in didn't complete — try again, or use classic sign-in.");
      if (p.has("signedin") || p.has("oauth_error")) {
        p.delete("signedin"); p.delete("oauth_error");
        const qs = p.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
      }
    } catch {}
  }, []);

  const [rawEvents, setRawEvents] = useState({});
  // Opt-in: include Saturdays/Sundays as selectable/addable days. Persisted
  // so the choice sticks across sessions. Default false preserves existing
  // behavior for anyone who hasn't opted in.
  const [includeWeekends, setIncludeWeekends] = useState(() => lsGet("mts-include-weekends", false));
  const includeWeekendsRef = useRef(includeWeekends);
  useEffect(() => { includeWeekendsRef.current = includeWeekends; }, [includeWeekends]);
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(10, includeWeekends));
  const [selDay, setSelDay] = useState(0);
  // Always-current ref so load(preserveDay=true) reads the real selDay
  // without needing selDay in its useCallback deps (which would cause a
  // full re-fetch every time the user switches days).
  const selDayRef = useRef(0);
  useEffect(() => { selDayRef.current = selDay; }, [selDay]);
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
  const [stopOverridesVersion, setStopOverridesVersion] = useState(0); // bumped when a stop's details are manually edited
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
  // Local cache mapping a normalized phone digit-string → contact resourceName.
  // Persists across sessions in localStorage. Once we've matched a phone to
  // a Google Contact (or seen the auto-pusher try and fail), we never call
  // people:createContact for that number again. This prevents the duplicate
  // "CLIENT Mark Reigelsperger / CLIENT Mark Reigelsperger" issue when the
  // People API's searchContacts index hasn't warmed up after sign-in.
  // -v2: the previous cache could be poisoned by Other-Contacts false matches
  // (clients that never got a real, caller-ID-capable contact). Bumping the key
  // forces a one-time re-evaluation with the fixed dedup so those get created.
  const phoneContactCache = useRef(lsGet("mts-phone-contact-cache-v2", {}));
  const persistPhoneCache = useCallback(() => {
    try { lsSet("mts-phone-contact-cache-v2", phoneContactCache.current); } catch {}
  }, []);

  const autoPushContact = useCallback(async (card) => {
    if (!token || !card) return false;
    if (!card.phone && !card.email) return false;
    const phoneDigits = (card.phone || "").replace(/\D/g, "");

    // Cache hit — already pushed (or already known to exist). Skip entirely.
    if (phoneDigits && phoneContactCache.current[phoneDigits]) {
      return true;
    }

    const [givenName, ...rest] = (card.cn || "Unknown").split(" ");
    const familyName = rest.join(" ");
    const body = {
      // Prefix first name with CLIENT so it sorts/displays clearly in the phone app
      names: [{ givenName: `CLIENT ${givenName}`, familyName }],
      ...(card.phone ? { phoneNumbers: [{ value: card.phone, type: "mobile" }] } : {}),
      ...(card.email ? { emailAddresses: [{ value: card.email }] } : {}),
      ...(card.addr  ? { addresses: [{ formattedValue: card.addr, type: "home" }] } : {}),
      biographies: [{ value: `MTS Rochester Tree Service Client${card.jn ? ` — Job #${card.jn}` : ""}`, contentType: "TEXT_PLAIN" }],
    };

    try {
      // Dedupe ONLY against primary "My Contacts" — those are what sync to the
      // phone and supply caller ID. We deliberately do NOT skip creation when a
      // number is found only in Google's auto-collected "Other Contacts": those
      // never sync to the iPhone, so treating them as "already exists" left
      // clients calling in as a bare number with no name. If only an Other
      // Contact exists we still create a real contact (effectively promoting it).
      if (phoneDigits) {
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        const matchesPhone = (person) =>
          (person?.phoneNumbers || []).some(p => p.value?.replace(/\D/g, "") === phoneDigits);
        let existing = null;
        // Primary contacts search by phone.
        try {
          const sr = await fetch(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(card.phone)}&readMask=names,phoneNumbers&pageSize=10`, auth);
          if (sr.ok) {
            const sd = await sr.json();
            existing = sd.results?.find(r => matchesPhone(r.person))?.person;
          }
        } catch {}
        // Fallback: name-based search in case searchContacts hasn't indexed the
        // number yet (the well-known warmup race right after sign-in).
        if (!existing && card.cn) {
          try {
            const ns = await fetch(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(card.cn)}&readMask=names,phoneNumbers&pageSize=10`, auth);
            if (ns.ok) {
              const nsd = await ns.json();
              existing = nsd.results?.find(r => matchesPhone(r.person))?.person;
            }
          } catch {}
        }
        if (existing?.resourceName) {
          // Already a real (synced) contact — record in cache so we don't re-create.
          phoneContactCache.current[phoneDigits] = existing.resourceName;
          persistPhoneCache();
          return true;
        }
      }

      // No existing contact found — create one.
      const res = await fetch("https://people.googleapis.com/v1/people:createContact", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok && phoneDigits) {
        // Stash the new resourceName so subsequent runs skip even the
        // search step. Belt-and-suspenders against any future warmup race.
        try {
          const created = await res.json();
          phoneContactCache.current[phoneDigits] = created.resourceName || "created";
          persistPhoneCache();
        } catch {
          phoneContactCache.current[phoneDigits] = "created";
          persistPhoneCache();
        }
      }
      return res.ok;
    } catch { return false; }
  }, [token, persistPhoneCache]);

  // Track which stops have already been auto-pushed so we don't re-push on
  // every calendar reload. Stored by event id to survive app restarts.
  const [contactsPushed, setContactsPushed] = useState(() => lsGet("mts-contacts-pushed-v2", {}));
  useEffect(() => { lsSet("mts-contacts-pushed-v2", contactsPushed); }, [contactsPushed]);

  // (Auto-contact-push effect is defined below, after allParsed is declared.)

  const [view, setView] = useState(() => lsGet("mts-view", "route"));
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [pipelineSearchOpen, setPipelineSearchOpen] = useState(false);
  const [pipelineSelectMode, setPipelineSelectMode] = useState(false);
  const [pipelineSelectedCount, setPipelineSelectedCount] = useState(0);
  // Incrementing this tick tells Pipeline to open its email sheet (avoids
  // lifting emailSheet state up into App — Pipeline owns all email logic).
  const [pipelineBulkEmailTick, setPipelineBulkEmailTick] = useState(0);
  const [routeSearch, setRouteSearch] = useState("");
  const [routeSearchOpen, setRouteSearchOpen] = useState(false);
  // Universal search overlay (spans pipeline + route + calendar).
  const [searchOpen, setSearchOpen] = useState(false);
  const [deepEvents, setDeepEvents] = useState([]);
  const [deepLoading, setDeepLoading] = useState(false);

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
  // Safari requires popups to open SYNCHRONOUSLY inside the user-gesture call
  // stack — if requestAccessToken() runs even one tick later (e.g. inside a
  // setTimeout while waiting for the GIS script to load), Safari refuses to
  // treat it as a real popup and falls back to a top-level redirect to
  // accounts.google.com that's missing parameters the token-client flow needs,
  // landing on a "400. That's an error. ... malformed" page. Chrome is more
  // lenient about the timing, which is why this only showed up in Safari.
  //
  // Fix: build the token client ONCE, ahead of time (as soon as GIS loads),
  // and keep it in a ref. The click handler then does nothing but call
  // requestAccessToken() on the already-built client — zero async hops
  // between the tap and the popup request, so Safari honors it as a gesture.
  const _tokenClientRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const tryInit = () => {
      if (cancelled || _tokenClientRef.current) return;
      if (!window.google?.accounts?.oauth2) { setTimeout(tryInit, 200); return; }
      _tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: r => {
          _interactiveInFlight.current = false; _authBusy.current = false;
          if (r.access_token) { saveToken(r.access_token, r.expires_in); setError(null); setNeedsReconnect(false); }
          else setError("Sign-in failed — try again.");
        },
        // Without this, a blocked/dismissed popup produced NO feedback and the
        // user just kept tapping — a big part of the Chromebook loop.
        error_callback: (err) => {
          _interactiveInFlight.current = false; _authBusy.current = false;
          const t = err?.type || "";
          setError(
            t.includes("popup") ? "Sign-in popup was blocked or closed. Allow pop-ups for this site and try again."
            : "Couldn't complete sign-in. Check your connection / cookies and try again."
          );
        },
      });
    };
    tryInit();
    return () => { cancelled = true; };
  }, []);
  const initAuth = useCallback(() => {
    if (!_tokenClientRef.current) {
      // GIS still hasn't loaded by the time the user tapped — extremely rare,
      // but calling requestAccessToken from here would hit the Safari issue
      // above. Surface a retry prompt instead of silently breaking.
      setError("Still loading sign-in — try again in a moment");
      return;
    }
    // Singleton: never open a second popup while one is already open — stacked
    // popups are exactly what made the loop feel unrecoverable.
    if (_interactiveInFlight.current) return;
    _interactiveInFlight.current = true;
    _authBusy.current = true;
    // Safety: if GIS never fires callback nor error_callback (rare), release the
    // guards after 60s so sign-in isn't permanently blocked.
    setTimeout(() => { _interactiveInFlight.current = false; _authBusy.current = false; }, 60_000);
    _tokenClientRef.current.requestAccessToken();
  }, []);

  // ── SERVER SIGN-IN (authorization-code flow) ──────────────────────────────
  // Top-level redirect to our backend, which sends the user to Google's consent
  // screen and stores a refresh token server-side. After this ONE sign-in, token
  // renewal is silent (via /api/token) for as long as the refresh token lives
  // (weekly in Testing mode) — no more hourly popups. This is the primary
  // sign-in; initAuth() (the GIS popup) remains as a fallback.
  const serverSignIn = useCallback(() => {
    _authBusy.current = true;
    window.location.href = "/api/oauth/start";
  }, []);

  // ── AUTHED FETCH — wraps fetchEvents with silent reauth on 401 ────────
  // Only clears the saved token when silent reauth itself confirms the user
  // has no usable Google session. Transient errors after a successful reauth
  // are rethrown without nuking the token.
  const authedFetchEvents = useCallback(async (tok, dayStart, dayEnd) => {
    try {
      return await fetchEvents(tok, dayStart, dayEnd);
    } catch(e) {
      if (e.status === 401 || (e.message && e.message.includes("401"))) {
        const ok = await silentReauth();
        if (ok) {
          const freshToken = lsGet("mts-token", null)?.token;
          if (freshToken) return await fetchEvents(freshToken, dayStart, dayEnd);
          // Reauth said OK but token isn't readable — extremely rare race.
          // Don't clear the token; let the caller retry.
        } else {
          // Silent reauth failed — but don't nuke the token and bounce to the
          // full sign-in screen (that's what made the Chromebook loop). Keep
          // the app usable on local data and surface a single "Reconnect
          // Google" affordance for one interactive re-auth.
          setNeedsReconnect(true);
        }
      }
      throw e;
    }
  }, [silentReauth]);

  // ── LOAD — today first, then background-fill remaining days ──────────
  const load = useCallback(async (preserveDay = false) => {
    // Use the freshest token available. A background silent-reauth may have
    // written a newer token to localStorage than the one captured in this
    // callback's closure; using the stale closure token would 401 needlessly
    // (and, when the closure token is the DEAD one, keep failing every retry).
    const savedTok = lsGet("mts-token", null);
    const tok = (savedTok?.token && savedTok.expiry > Date.now()) ? savedTok.token : token;
    if (!tok) return;
    setLoading(true);
    setError(null);
    try {
      const days = getBusinessDays(10, includeWeekendsRef.current);
      setBusinessDays(days);

      // PHASE 1: Load the currently-selected day first (or today on initial load)
      // When preserveDay=true (manual refresh), stay on the current selDay index.
      // On initial load, always jump to today (index 0).
      const targetIdx = preserveDay ? selDayRef.current : 0;
      const targetDay = days[targetIdx] || days[0];
      const ts = new Date(targetDay); ts.setHours(0,0,0,0);
      const te = new Date(targetDay); te.setHours(23,59,59,999);
      // Retry today's fetch a couple of times before giving up. On a PWA
      // cold-launched from a locked/sleeping phone, the network stack can
      // report "online" a beat before it can actually complete a request —
      // a bare fetch() failure here (not a 401, which authedFetchEvents
      // already retries once via silent reauth) previously had ZERO retry,
      // so that one transient hiccup left the route permanently empty for
      // today until the user manually reopened the app. Mirrors the same
      // backoff pattern already used for cold-start silent reauth above.
      let todayEvents, loadErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        try { todayEvents = await authedFetchEvents(tok, ts, te); loadErr = null; break; }
        catch (err) {
          loadErr = err;
          // A 401 that authedFetchEvents' own inline reauth couldn't fix is a
          // real auth failure, not a transient hiccup — retrying won't help.
          if (err?.status === 401 || (err?.message || "").includes("401")) break;
          if (attempt < 4) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        }
      }
      if (loadErr) throw loadErr;
      const localStops1 = localStopsGet();
      // Roll forward any local stops from past dates to today so they don't disappear.
      const validDayKeys1 = new Set(days.map(d => d.toDateString()));
      const todayDk = targetDay.toDateString();
      let ls1Changed = false;
      for (const [id, entry] of Object.entries(localStops1)) {
        if (!validDayKeys1.has(entry.dk)) {
          // Confirmed-pushed stops whose date passed — Calendar already owns them, safe to drop.
          if (entry.pushedId) { delete localStops1[id]; }
          else { localStops1[id] = { ...entry, dk: todayDk }; }
          ls1Changed = true;
        }
      }
      if (ls1Changed) localStopsSet(localStops1);
      setRawEvents(prev => {
        const next = { ...prev, [targetDay.toDateString()]: todayEvents };
        for (const [id, { event, dk }] of Object.entries(localStops1)) {
          next[dk] = [...(next[dk] || []).filter(e => e.id !== id && e.id !== event.id), event];
        }
        return next;
      });
      if (!preserveDay) setSelDay(0);
      setExpanded(null); setReorderMode(false); setMoving(null);
      // Phase 1 succeeded — clear any lingering failure/reconnect UI so the
      // red "couldn't load" banner and yellow reconnect bar don't stick around
      // after stops have actually come in.
      setError(null); setNeedsReconnect(false);
      setLoading(false);

      // PHASE 2: Background-fill remaining days
      const remaining = days.slice(1);
      (async () => {
        for (const day of remaining) {
          try {
            const s = new Date(day); s.setHours(0,0,0,0);
            const e = new Date(day); e.setHours(23,59,59,999);
            const events = await authedFetchEvents(tok, s, e);
            const localStops2 = localStopsGet();
            // Clean up confirmed-pushed local stops whose real Calendar event came back.
            const fetchedIds = new Set(events.map(ev => ev.id));
            let lsChanged2 = false;
            for (const [sid, entry] of Object.entries(localStops2)) {
              if (entry.dk === day.toDateString() && entry.pushedId && fetchedIds.has(entry.pushedId)) {
                delete localStops2[sid];
                lsChanged2 = true;
              }
            }
            if (lsChanged2) localStopsSet(localStops2);
            setRawEvents(prev => {
              const next = { ...prev, [day.toDateString()]: events };
              for (const [id, { event, dk }] of Object.entries(localStops2)) {
                if (dk === day.toDateString())
                  next[dk] = [...(next[dk] || []).filter(e => e.id !== id && e.id !== event.id), event];
              }
              return next;
            });
          } catch(err) {
            console.warn("Background load failed for", day.toDateString(), err);
          }
        }
      })();

    } catch (e) {
      // authedFetchEvents has already handled the auth side (cleared the token
      // only if silent reauth failed). Don't double-clear here — a transient
      // network error that surfaces as "401" in the message would otherwise
      // log the user out unnecessarily.
      //
      // But DO flag auth failures: when the fetch ultimately fails with a 401
      // that silent reauth couldn't fix, no amount of "Retry" or reopening the
      // app will recover it — the Google session is genuinely dead (e.g. a
      // Testing-mode refresh token that expired after a week). The only fix is
      // an interactive reconnect, so surface that prominently instead of a
      // powerless "retrying…" banner.
      const isAuth = e?.status === 401 || (e?.message || "").includes("401");
      if (isAuth) setNeedsReconnect(true);
      setError(e.message);
      setLoading(false);
    }
  }, [token, authedFetchEvents]);

  // Only call load() when the token transitions from null → non-null (initial
  // sign-in or cold-start reauth). A mid-session token refresh via silentReauth
  // changes token from t1 → t2 — triggering load() there resets all route state
  // (loading flash, expanded=null, selDay=0) mid-use, causing the mobile flicker
  // loop where the app appears to reload on every token refresh.
  //
  // Initialized to null (NOT the current token) so that a warm boot with a
  // cached token is still treated as a null → token transition and fires the
  // initial load(). Initializing to `token` would skip that load and leave the
  // route screen empty until a manual refresh.
  const _prevTokenRef = useRef(null);
  useEffect(() => {
    const wasNull = !_prevTokenRef.current;
    _prevTokenRef.current = token;
    if (token && wasNull) load();
  }, [token, load]);

  // Self-healing fallback for the case above: if Phase 1's own 5-attempt
  // retry still failed (cold-launch network stack genuinely wasn't ready
  // within ~10s), don't just sit on an empty route forever — keep retrying
  // in the background, and retry immediately the moment the device reports
  // it's back online. This is what previously required a full force-quit +
  // reopen to recover from.
  useEffect(() => {
    // Stop auto-retrying once we've surfaced a hard auth failure — a dead
    // session can't be fixed by re-fetching, and looping every 5s just drains
    // battery/data with failing /api/token calls. The Reconnect bar is the
    // recovery path in that state.
    if (!token || !error || loading || needsReconnect || Object.keys(rawEvents).length > 0) return;
    const t = setTimeout(() => load(true), 5000);
    const onOnline = () => load(true);
    window.addEventListener("online", onOnline);
    return () => { clearTimeout(t); window.removeEventListener("online", onOnline); };
  }, [token, error, loading, needsReconnect, rawEvents, load]);

  // ── DAY-ROLLOVER RECOVERY ────────────────────────────────────────────────
  // The installed PWA stays mounted across background→foreground on iOS, and
  // load() only fires on a null→token transition — so if the app is left open
  // past midnight and merely RESUMED (not relaunched), businessDays[0] still
  // points at yesterday, dayKey resolves to yesterday, and the route shows the
  // wrong day (usually empty) with no fix short of a full relaunch. That warm-
  // resume-after-midnight case is almost certainly a major driver of the
  // recurring "no stops when I open the app, but reopening fixes it" reports:
  // a force-quit relaunch recomputes businessDays via load(), a resume does not.
  // On every foreground (and once a minute while foregrounded), if the real
  // "today" no longer matches businessDays[0], recompute the day list and
  // reload today.
  useEffect(() => {
    if (!token) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      // Compare businessDays[0] to what getBusinessDays WOULD produce as the
      // first day RIGHT NOW — NOT to the raw calendar "today". When weekends are
      // excluded (the default) and today is a weekend, the first business day is
      // the next weekday, which never equals the raw today — so the old check
      // saw a permanent "mismatch" and called load() forever (infinite loop:
      // nonstop refresh spinner, flicker, eventual crash). The freshly-computed
      // expected first day already accounts for weekends, so it only differs
      // from businessDays[0] on a GENUINE rollover.
      const expectedFirst = getBusinessDays(1, includeWeekendsRef.current)[0];
      const firstBiz = businessDays[0];
      if (firstBiz && expectedFirst && firstBiz.toDateString() !== expectedFirst.toDateString()) {
        load(false); // recomputes businessDays + fetches today, jumps to today
      }
    };
    document.addEventListener("visibilitychange", check);
    const iv = setInterval(check, 60 * 1000);
    check(); // also catch a resume that fired no visibility event
    return () => { document.removeEventListener("visibilitychange", check); clearInterval(iv); };
  }, [token, businessDays, load]);

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
            // Use timestamp-based merge (same as pullFromDrive) so a stale
            // cloud version never silently clobbers a locally-moved card.
            const merged = { ...local };
            for (const [cid, dc] of Object.entries(cloud.pipeline)) {
              const lc = local[cid];
              if (!lc || (dc.stageChangedAt || 0) >= (lc.stageChangedAt || 0)) merged[cid] = dc;
            }
            savePipeline(merged);
          }
          // Merge dismissed by newest timestamp (same rule as pullFromDrive) —
          // NOT a blind cloud-wins spread, which could re-hide a card the user
          // just un-dismissed locally by stamping the stale cloud value over it.
          if (cloud.dismissed) {
            setDismissed(prev => {
              const m = { ...prev };
              for (const [id, ts] of Object.entries(cloud.dismissed)) {
                if ((ts || 0) > (prev[id] || 0)) m[id] = ts;
              }
              return m;
            });
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

  // Push the small app-state JSON (pipeline + dismissed + lastContact) to
  // Drive. This deliberately does NOT re-upload field records anymore — every
  // genuine field edit already pushes itself via queueFieldDriveSync at the
  // point of edit (OnsiteWindow auto-save/flush/unmount, Pipeline note edits,
  // photoSync, videoQueue), and any push that failed is retried by the
  // dirty-flush below. The old "re-upload every field record on every pipeline
  // or contact change" loop saturated the connection — uploading hundreds of
  // MB of base64 photos serially each time a card moved or a client was called
  // — which is what made syncing feel slow, and it also re-stamped Drive
  // records with this device's clock, corrupting the cross-device merge.
  const triggerCloudSync = useCallback(async (immediate = false) => {
    if (!token) return;
    const run = () => saveAppState(token, loadPipeline(), dismissed, lastContact).catch(() => {});
    if (immediate) { await run(); return; }
    if (cloudSyncTimer.current) clearTimeout(cloudSyncTimer.current);
    cloudSyncTimer.current = setTimeout(run, 2000);
  }, [token, dismissed, lastContact]);

  useEffect(() => { triggerCloudSync(); }, [dismissed, lastContact, triggerCloudSync]);

  // ── DIRTY-FIELD FLUSH ───────────────────────────────────────────────────
  // Re-push only the field records whose Drive sync hasn't been confirmed
  // (edited offline, or a push that 401'd / failed). queueFieldDriveSync reads
  // fresh data from IDB, is serialized + coalesced per stop, and clears the
  // dirty flag on success. Running it sequentially avoids hammering Drive.
  const _flushingDirty = useRef(false);
  const flushDirtyFields = useCallback(async () => {
    if (!token || _flushingDirty.current) return;
    const ids = getDirtyFieldIds();
    if (!ids.length) return;
    _flushingDirty.current = true;
    try {
      for (const id of ids) {
        await queueFieldDriveSync(token, id);
      }
    } finally {
      _flushingDirty.current = false;
    }
  }, [token]);

  // Push EVERY local field record to Drive (not just dirty ones). Used by the
  // manual sync button and the one-time post-deploy reconcile, so data captured
  // before the dirty-tracking existed — or that failed to upload under the old
  // 5MB-capped path — finally lands on Drive via the resumable/slim path.
  // queueFieldDriveSync reads fresh IDB per stop, so callers should pull first
  // (to union-merge Drive into local) before calling this, ensuring we push the
  // superset and never clobber another device's photos.
  const _pushingAll = useRef(false);
  const pushAllFields = useCallback(async () => {
    if (!token || _pushingAll.current) return;
    _pushingAll.current = true;
    try {
      const ids = await listFieldIds();
      for (const id of ids) {
        const fd = await loadField(id);
        if (fd && Object.keys(fd).length) await queueFieldDriveSync(token, id);
      }
    } finally {
      _pushingAll.current = false;
    }
  }, [token]);

  // Retry dirty field pushes every 60s while visible, and whenever the tab
  // regains focus or the device comes back online.
  useEffect(() => {
    if (!token) return;
    const tick = () => { if (document.visibilityState === "visible") flushDirtyFields(); };
    const iv = setInterval(tick, 60 * 1000);
    const onOnline = () => flushDirtyFields();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", tick);
    // Kick once shortly after boot to drain anything left from a prior session.
    const boot = setTimeout(flushDirtyFields, 4000);
    return () => {
      clearInterval(iv);
      clearTimeout(boot);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [token, flushDirtyFields]);

  // Tracks a safety watchdog timer for pullFromDrive so setSyncPulling(false)
  // fires even if iOS freezes JS mid-fetch (AbortController signals handle the
  // common case; this catches the rare full-freeze scenario).
  const _pullWatchdog = useRef(null);
  const pullFromDrive = useCallback(async (force = false) => {
    if (!token) return;
    // Clear any prior watchdog before starting a fresh pull.
    if (_pullWatchdog.current) clearTimeout(_pullWatchdog.current);
    setSyncPulling(true);
    // Force-clear the yellow indicator after 3 minutes — belt-and-suspenders
    // for cases where the AbortController fires but the catch never runs.
    _pullWatchdog.current = setTimeout(() => { setSyncPulling(false); }, 3 * 60 * 1000);
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
      // Per-file record of the last Drive modifiedTime we actually pulled.
      // The download gate compares Drive's CURRENT modifiedTime against this
      // stored value — both are Drive server timestamps, so the decision is
      // immune to clock skew between devices and to local savedAt being
      // re-stamped to "now" on every merge. (The old gate compared Drive's
      // server clock against this device's local clock, which could wrongly
      // skip a genuinely-updated remote file.)
      const seen = lsGet("mts-field-remote-seen", {});
      let seenChanged = false;
      for (const f of (files || [])) {
        const id = f.name.replace(/\.json$/, "");
        const localData = await loadField(id);
        const localEmpty = !localData || Object.keys(localData).length === 0;
        const remoteTs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
        const lastSeen = seen[id] || 0;
        // Pull when forced (manual sync / reconcile), when we have no local
        // copy, or when Drive's file changed since the last time we pulled it.
        // MERGE photo/audio/video arrays by key (union) rather than overwriting
        // — photos captured locally that haven't synced yet must never be
        // erased by a stale Drive snapshot.
        if (force || localEmpty || remoteTs > lastSeen) {
          const data = await loadFieldFromDrive(token, id);
          if (data) {
            await updateField(id, (existing) => {
              const ex = existing || {};
              // Union-merge photo arrays by ts/url so neither side loses items.
              const unionByKey = (a = [], b = [], getKey) => {
                const map = new Map();
                for (const item of a) { const k = getKey(item); if (k != null) map.set(k, item); }
                for (const item of b) {
                  const k = getKey(item);
                  if (k == null) continue;
                  if (map.has(k)) {
                    const ex2 = map.get(k);
                    // Prefer local dataUrl (highest fidelity, may include unsynced markup edits)
                    map.set(k, { ...item, ...ex2, dataUrl: ex2.dataUrl || item.dataUrl });
                  } else map.set(k, item);
                }
                return [...map.values()].sort((x, y) => (x.ts || x.timestamp || 0) - (y.ts || y.timestamp || 0));
              };
              const localScope = ex.scopePhotos || ex.photos || [];
              const localAddon = ex.addonPhotos || [];
              const localAudio = ex.audioClips  || [];
              const localVids  = ex.videoUrls   || (ex.videoUrl ? [ex.videoUrl] : []);
              const cloudScope = data.scopePhotos || data.photos || [];
              const cloudAddon = data.addonPhotos || [];
              const cloudAudio = data.audioClips  || [];
              const cloudVids  = data.videoUrls   || (data.videoUrl ? [data.videoUrl] : []);
              // For text/AI fields: use whichever device's record has the newer
              // savedAt. Drive's savedAt is the phone's IDB write time (embedded
              // in the JSON); local savedAt is this device's last write time.
              // This fixes the case where the phone edits notes and the
              // Chromebook's pullFromDrive kept its own older text because
              // "local || drive" always preferred the non-empty local value.
              // Photos are always union-merged regardless of which text wins.
              const cloudNewer = (data.savedAt || 0) >= (ex.savedAt || 0);
              return {
                // Use ?? (not ||) so the winning side's value is taken LITERALLY,
                // including an intentional "" (a note the user cleared). With ||,
                // an empty string was treated as "absent" and the merge fell
                // through to the other side's stale text — so deleting a note on
                // the newer device silently resurrected the old note, and then
                // re-uploaded it, resurrecting it on the first device too.
                scopeNotes:     cloudNewer ? ((data.scopeNotes ?? data.myNotes) ?? ex.scopeNotes ?? "") : (ex.scopeNotes ?? (data.scopeNotes ?? data.myNotes) ?? ""),
                addonNotes:     cloudNewer ? (data.addonNotes ?? ex.addonNotes ?? "") : (ex.addonNotes ?? data.addonNotes ?? ""),
                aiScopeSummary: cloudNewer ? (data.aiScopeSummary ?? ex.aiScopeSummary ?? "") : (ex.aiScopeSummary ?? data.aiScopeSummary ?? ""),
                aiAddonEmail:   cloudNewer ? (data.aiAddonEmail   ?? ex.aiAddonEmail   ?? "") : (ex.aiAddonEmail   ?? data.aiAddonEmail   ?? ""),
                scopePhotos: unionByKey(localScope, cloudScope, photoKey),
                addonPhotos: unionByKey(localAddon, cloudAddon, photoKey),
                audioClips:  unionByKey(localAudio, cloudAudio, a => a.ts || a.timestamp || a.url),
                videoUrls:   Array.from(new Set([...localVids, ...cloudVids])),
              };
            }).catch(() => {});
            // Record the modifiedTime we just pulled so we don't re-download
            // this file until Drive changes it again.
            if (remoteTs) { seen[id] = remoteTs; seenChanged = true; }
          }
        }
      }
      if (seenChanged) lsSet("mts-field-remote-seen", seen);
      setLastSyncTime(Date.now());
      window.dispatchEvent(new CustomEvent("mts-field-synced"));
    } catch(e) { console.warn("Pull failed:", e); }
    finally {
      if (_pullWatchdog.current) { clearTimeout(_pullWatchdog.current); _pullWatchdog.current = null; }
      setSyncPulling(false);
    }
  }, [token]);

  // ── ONE-TIME POST-DEPLOY RECONCILE ──────────────────────────────────────
  // Defined AFTER pullFromDrive so its dependency array doesn't reference that
  // const before initialization (a temporal-dead-zone crash on render).
  // Bump RECONCILE_VERSION whenever a sync bug fix needs every device to
  // re-push its local data. Runs once per device per version: pull (union
  // Drive→local), then push all local fields (union→Drive). This is what
  // gets the phone's complete-but-never-successfully-uploaded records onto
  // Drive so other devices can finally see them.
  const RECONCILE_VERSION = "2026-05-fetch-timeout";
  useEffect(() => {
    if (!token) return;
    if (lsGet("mts-reconcile-version", "") === RECONCILE_VERSION) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        await pullFromDrive(true);
        if (cancelled) return;
        await pushAllFields();
        if (cancelled) return;
        lsSet("mts-reconcile-version", RECONCILE_VERSION);
      } catch (e) { console.warn("Reconcile failed:", e); }
    }, 5000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [token, pullFromDrive, pushAllFields]);

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

  // Periodic pull every 5 minutes while the app is visible — ensures the
  // desktop picks up phone edits (notes, photos) without requiring a tab-switch.
  useEffect(() => {
    if (!token) return;
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") pullFromDrive();
    }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [token, pullFromDrive]);

  // 1-minute tick so the "Xm ago" sync counter stays current between re-renders.
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSyncTick(t => t + 1), 60000);
    return () => clearInterval(iv);
  }, []);

  // ── PARSE ────────────────────────────────────────────────────────────────
  const dayKey = businessDays[selDay]?.toDateString();
  // Depend on THIS day's events array, not the whole rawEvents object. Startup
  // loads today first, then background-fills the other 9 days one by one — each
  // call replaced the rawEvents object, so keying on `rawEvents` recomputed
  // allParsed (→ stopMap → stops → markers) up to 9 times as the background
  // days streamed in, tearing down and rebuilding every map marker each time.
  // That was the startup "flickering." rawEvents[dayKey] keeps a stable
  // reference once today is loaded (background fills touch OTHER keys), so the
  // route + markers settle once and stay put.
  const rawForDay = rawEvents[dayKey];
  const allParsed = useMemo(() => {
    const raw = rawForDay || [];
    return raw.map(parseEvent).filter(Boolean).filter(s => !s.isAdmin);
  }, [rawForDay, dayKey]);

  // ── CLIENT INDEX — for the Add Stop modal's name autosuggest ─────────
  // Pulls from pipeline (every job ever recorded) + the current week's
  // parsed events. Rebuilt only when those sources change so typing is fast.
  // The week's events span all days currently loaded into rawEvents.
  const allEventsAcrossDays = useMemo(() => {
    const out = [];
    for (const day of Object.values(rawEvents)) {
      for (const ev of (day || [])) {
        const p = parseEvent(ev);
        if (p && !p.isAdmin) {
          // Tag with start ms for recency ranking
          const t = ev.start?.dateTime || ev.start?.date;
          p._startMs = t ? new Date(t).getTime() : 0;
          out.push(p);
        }
      }
    }
    return out;
  }, [rawEvents]);
  // addStopOpen also lives down in the ACTIONS section; we declare it here
  // because the pipelineSnapshot effect below depends on it. The actual
  // assignment happens here exactly once — the lower declaration was removed.
  const [addStopOpen, setAddStopOpen] = useState(false);
  const [pipelineSnapshot, setPipelineSnapshot] = useState(() => loadPipeline());
  // Refresh pipelineSnapshot when the Add-Stop modal or universal search opens
  // so we search/suggest against the latest pipeline state.
  useEffect(() => { if (addStopOpen || searchOpen) setPipelineSnapshot(loadPipeline()); }, [addStopOpen, searchOpen]);

  // Deep search: pull a wide calendar range (≈8 months back, 3 ahead) on demand
  // so the universal search can reach scheduled appointments beyond the loaded
  // week. Parsed the same way as the route so results open identically.
  const runDeepSearch = useCallback(async () => {
    if (!token || deepLoading) return;
    setDeepLoading(true);
    try {
      const start = new Date(); start.setMonth(start.getMonth() - 8);
      const end = new Date(); end.setMonth(end.getMonth() + 3);
      const raw = await authedFetchEvents(token, start, end);
      const parsed = (raw || []).map(ev => {
        const p = parseEvent(ev);
        if (!p || p.isAdmin) return null;
        const t = ev.start?.dateTime || ev.start?.date;
        p._startMs = t ? new Date(t).getTime() : 0;
        return p;
      }).filter(Boolean);
      setDeepEvents(parsed);
    } catch (e) {
      console.warn("[deepSearch] failed:", e?.message || e);
    } finally {
      setDeepLoading(false);
    }
  }, [token, deepLoading, authedFetchEvents]);
  const clientIndex = useMemo(
    () => buildClientIndex(pipelineSnapshot, allEventsAcrossDays),
    [pipelineSnapshot, allEventsAcrossDays]
  );

  // Auto-push new contacts to Google Contacts silently. Scans EVERY loaded day
  // (not just the one being viewed) so a client you call on a day you haven't
  // opened still gets a caller-ID contact. Pushes one at a time at 400ms
  // intervals; each stop is pushed at most once, ever (tracked in contactsPushed).
  useEffect(() => {
    if (!token || !allEventsAcrossDays.length) return;
    const seen = new Set();
    const unpushed = allEventsAcrossDays.filter(s => {
      if (!s.isTask || contactsPushed[s.id] || !(s.phone || s.email)) return false;
      if (seen.has(s.id)) return false; // same event can appear across day buckets
      seen.add(s.id);
      return true;
    });
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
  }, [allEventsAcrossDays, token]);

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

  const stopMap = useMemo(() => {
    const overrides = stopOverridesGet();
    const m = {};
    allParsed.forEach(s => { m[s.id] = overrides[s.id] ? { ...s, ...overrides[s.id] } : s; });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParsed, stopOverridesVersion]);
  const currentOrder = (ordIds[dayKey]?.length > 0) ? ordIds[dayKey] : allParsed.map(s => s.id);
  // Memoized so `stops` keeps a stable identity across unrelated re-renders
  // (e.g. the rapid state churn while a cloud sync runs). Without this, every
  // render produced a brand-new array, re-running the RouteMap marker/geocode
  // effects and re-fitting the map bounds — which read on screen as the map
  // "shaking back and forth" whenever sync fired.
  const stops = useMemo(
    () => currentOrder.map(id => stopMap[id]).filter(Boolean),
    [currentOrder.join(","), stopMap]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  );

  // Dismissed is a global id→timestamp map. A dismissed stop is hidden from
  // active and shown in Completed on whatever day its route includes it. (A
  // previous attempt to scope this to the dismissal DATE broke delete/complete
  // on any non-today day: the timestamp is the moment you TAP — always today —
  // so acting on a future day's stop never matched that day and the stop popped
  // back. Reverted. Calendar events have a unique id per day, so this global
  // model is correct for them; the cross-day artifact only affects stable-id
  // local stops, handled by deleting the local stop itself.)
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
    // Remove from local stop persistence if it's a local event
    if (id.startsWith("local-")) {
      const ls = localStopsGet(); delete ls[id]; localStopsSet(ls);
    }
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
  const [rejectConfirm, setRejectConfirm] = useState(null);  // stop id awaiting reject confirm
  const [signOutConfirm, setSignOutConfirm] = useState(false);
  const [uploadsOpen, setUploadsOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false); // route "hamburger" settings sheet
  const [debugOpen, setDebugOpen] = useState(false);
  const [nextStopCard, setNextStopCard] = useState(null); // { stop, stopNumber, totalStops }
  const _debugTapCount = useRef(0);
  const _debugTapTimer = useRef(null);
  const handleDebugTap = () => {
    _debugTapCount.current += 1;
    if (_debugTapTimer.current) clearTimeout(_debugTapTimer.current);
    _debugTapTimer.current = setTimeout(() => { _debugTapCount.current = 0; }, 1000);
    if (_debugTapCount.current >= 5) { _debugTapCount.current = 0; setDebugOpen(true); }
  };

  // ── HEALTH BANNER ─────────────────────────────────────────────────────────
  // Surfaces actionable issues when the app returns to foreground so the user
  // knows immediately if something needs attention rather than hunting for clues.
  const [healthBanner, setHealthBanner] = useState(null); // null | { type, message, action?, actionLabel? }
  const _healthDismissed = useRef(new Set());

  const checkHealth = useCallback(async () => {
    if (!token || !navigator.onLine) return;
    try {
      const photoQ = (() => { try { return JSON.parse(localStorage.getItem("mts-photo-queue") || "[]"); } catch { return []; } })();
      const dirtyIds = getDirtyFieldIds();
      const vidPending = await videoPendingCount().catch(() => 0);

      // Priority order: video errors > stuck videos > photos pending > dirty fields
      // Only show if not already dismissed this session for this type.
      if (vidPending > 0 && !_healthDismissed.current.has("videos")) {
        setHealthBanner({
          type: "videos",
          message: `${vidPending} video upload${vidPending > 1 ? "s" : ""} pending`,
          actionLabel: "View",
          action: () => setUploadsOpen(true),
        });
        return;
      }
      if (photoQ.length > 0 && !_healthDismissed.current.has("photos")) {
        setHealthBanner({
          type: "photos",
          message: `${photoQ.length} stop${photoQ.length > 1 ? "s" : ""} have photos waiting to upload`,
          actionLabel: null,
          action: null,
        });
        return;
      }
      if (dirtyIds.length > 0 && !_healthDismissed.current.has("dirty")) {
        setHealthBanner({
          type: "dirty",
          message: `${dirtyIds.length} stop${dirtyIds.length > 1 ? "s" : ""} have unsaved changes pending sync`,
          actionLabel: null,
          action: null,
        });
        return;
      }
    } catch {}
  }, [token]);

  // Run health check on foreground return and once shortly after auth.
  // Also re-check after sync events so the banner clears when issues resolve.
  useEffect(() => {
    if (!token) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Clear dismissed set on foreground so the banner reappears if still unresolved.
        _healthDismissed.current = new Set();
        checkHealth();
      }
    };
    const onSynced = () => { setHealthBanner(null); checkHealth(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("mts-field-synced", onSynced);
    // videoQueue's own pub/sub fires on every item status change (finished,
    // errored, progressed) — wiring it here makes the pending count tick
    // down live while the user is glancing at the screen, instead of only
    // updating on the next visibility flip or field-sync event.
    const offVideoQueue = onVideoQueueChange(() => { if (document.visibilityState === "visible") checkHealth(); });
    const t = setTimeout(checkHealth, 6000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("mts-field-synced", onSynced);
      offVideoQueue();
      clearTimeout(t);
    };
  }, [token, checkHealth]);
  // (addStopOpen is declared above, near the clientIndex computation — its
  // useEffect needs to fire when this flag flips, and the effect lives there.)

  // Move-day picker — open when user taps the calendar icon on a card.
  // { stopId, anchorRect } so the popover can position near the button.
  const [movePicker, setMovePicker] = useState(null);

  // Move a calendar event to a different day (preserves time of day).
  // Calls events.patch on Google Calendar, then optimistically moves the
  // event between rawEvents[oldKey] and rawEvents[newKey] so the UI updates
  // instantly. If the API call fails we revert.
  const moveStopToDay = useCallback(async (id, targetDate) => {
    const stop = stopMap[id];
    if (!stop || !token) return;
    if (id.startsWith("local-")) {
      // Locally-created event that isn't on Google Calendar yet — move it
      // in both the in-memory rawEvents map and localStorage. Time of day stays the same.
      const oldKey = dayKey;
      const newKey = targetDate.toDateString();
      if (oldKey === newKey) return;
      // Compute updated event outside setState so we can persist it
      const oldList = rawEvents[oldKey] || [];
      const found = oldList.find(e => e.id === id);
      if (!found) return;
      const oldStart = new Date(found.start?.dateTime || found.start?.date);
      const oldEnd = new Date(found.end?.dateTime || found.end?.date);
      const newStart = new Date(targetDate);
      newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
      const durMs = oldEnd.getTime() - oldStart.getTime();
      const newEnd = new Date(newStart.getTime() + durMs);
      const updated = { ...found, start: { dateTime: newStart.toISOString() }, end: { dateTime: newEnd.toISOString() } };
      const ls = localStopsGet();
      if (ls[id]) { ls[id] = { event: updated, dk: newKey }; localStopsSet(ls); }
      setRawEvents(prev => {
        const oldL = prev[oldKey] || [];
        const newL = prev[newKey] || [];
        if (!oldL.find(e => e.id === id)) return prev;
        return { ...prev, [oldKey]: oldL.filter(e => e.id !== id), [newKey]: [...newL, updated] };
      });
      return;
    }

    // Real calendar event — patch it on Google Calendar first.
    // We need the original event's start/end so we can preserve duration.
    const oldList = rawEvents[dayKey] || [];
    const original = oldList.find(e => e.id === id);
    if (!original) return;

    const isAllDay = !!original.start?.date;
    let patchBody;
    if (isAllDay) {
      const newDateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD
      const oldStart = new Date(original.start.date);
      const oldEnd = new Date(original.end?.date || original.start.date);
      const days = Math.max(1, Math.round((oldEnd - oldStart) / 86400000));
      const newEnd = new Date(targetDate);
      newEnd.setDate(newEnd.getDate() + days);
      patchBody = {
        start: { date: newDateStr },
        end: { date: newEnd.toISOString().slice(0, 10) },
      };
    } else {
      const oldStart = new Date(original.start.dateTime);
      const oldEnd = new Date(original.end.dateTime);
      const newStart = new Date(targetDate);
      newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), oldStart.getSeconds(), 0);
      const durMs = oldEnd.getTime() - oldStart.getTime();
      const newEnd = new Date(newStart.getTime() + durMs);
      patchBody = {
        start: { dateTime: newStart.toISOString() },
        end: { dateTime: newEnd.toISOString() },
      };
    }

    // Optimistic UI update
    const oldKey = dayKey;
    const newKey = targetDate.toDateString();
    setRawEvents(prev => {
      const cur = prev[oldKey] || [];
      const target = prev[newKey] || [];
      return {
        ...prev,
        [oldKey]: cur.filter(e => e.id !== id),
        [newKey]: [...target, { ...original, ...patchBody }],
      };
    });
    setExpanded(null);
    setMovePicker(null);

    // Push to Google
    try {
      const res = await fetch(`${CAL_BASE}/events/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("[Cal] move event failed:", res.status, txt);
        // Revert
        setRawEvents(prev => {
          const cur = prev[newKey] || [];
          const target = prev[oldKey] || [];
          return {
            ...prev,
            [newKey]: cur.filter(e => e.id !== id),
            [oldKey]: [...target, original],
          };
        });
        alert("Failed to move event in Google Calendar. The event was put back on its original day.");
      }
    } catch (e) {
      console.warn("[Cal] move event error:", e);
    }
  }, [stopMap, token, dayKey, rawEvents]);

  // Decline = remove from route with confirmation
  // Once a stop is handled (declined / rejected / done), a locally-added stop
  // must be removed from the local-stops list — otherwise it keeps rolling
  // forward to the next day and reappearing, even though it's dismissed. Only
  // deleteStop did this before; markDone/decline/markReject didn't, which is why
  // a swiped-to-Pipeline local stop kept coming back on the next day.
  const dropLocalStop = (id) => {
    if (!id || !id.startsWith("local-")) return;
    const ls = localStopsGet();
    if (ls[id]) { delete ls[id]; localStopsSet(ls); }
  };

  const decline = (id) => {
    setUndoStack(u => [...u, {type:"dismiss",id}]);
    setDismissed(p => ({...p,[id]:Date.now()}));
    dropLocalStop(id);
    setExpanded(null);
    setDeclineConfirm(null);
    setOnsiteStop(null);
  };

  // markReject = flag the stop for rejection in SingleOps and push to pipeline
  const markReject = (id) => {
    const stop = stopMap[id];
    if (stop) {
      const pl = loadPipeline();
      const ex = pl[id];
      // If the card has already been moved beyond estimate_needed, preserve
      // the stage — only update contact info and mark the reject flag.
      const keepStage = ex && ex.stage !== "estimate_needed";
      pl[id] = {
        id, cn: stop.cn, addr: stop.addr, phone: stop.phone, email: stop.email,
        jn: stop.jn, notes: stop.notes, constraint: stop.constraint,
        stage: keepStage ? ex.stage : "estimate_needed",
        addedAt: ex?.addedAt || Date.now(),
        stageChangedAt: keepStage ? ex.stageChangedAt : Date.now(),
        hot: ex?.hot ?? false,
        ...(ex?.estimateSentAt ? { estimateSentAt: ex.estimateSentAt } : {}),
        ...(ex?.pauseUntil ? { pauseUntil: ex.pauseUntil } : {}),
        pendingRejectInSingleops: true,
      };
      savePipeline(pl);
      if (token) pushCalendarColor(id, pl[id].stage, token);
    }
    setDismissed(p => ({...p,[id]:Date.now()}));
    dropLocalStop(id);
    setExpanded(null);
    setRejectConfirm(null);
  };

  // markDone = move to pipeline as "estimate_needed"
  const markDone = (id) => {
    const stop = stopMap[id];
    setUndoStack(u => [...u, {type:"dismiss",id}]);
    setDismissed(p => ({...p,[id]:Date.now()})); // triggers cloud sync automatically
    dropLocalStop(id);
    setExpanded(null);
    setOnsiteStop(null);
    if (stop) {
      const pl = loadPipeline();
      const ex = pl[id];
      // Preserve the stage if the card has already been moved off estimate_needed.
      // The same GCal event can show up on multiple days' routes; marking it
      // "done" again must not reset work the user already did in the pipeline.
      const keepStage = ex && ex.stage !== "estimate_needed";
      pl[id] = {
        id, cn: stop.cn, addr: stop.addr, phone: stop.phone, email: stop.email,
        jn: stop.jn, notes: stop.notes, constraint: stop.constraint,
        stage: keepStage ? ex.stage : "estimate_needed",
        addedAt: ex?.addedAt || Date.now(),
        stageChangedAt: keepStage ? ex.stageChangedAt : Date.now(),
        hot: ex?.hot ?? false,
        ...(ex?.estimateSentAt ? { estimateSentAt: ex.estimateSentAt } : {}),
        ...(ex?.pauseUntil ? { pauseUntil: ex.pauseUntil } : {}),
      };
      savePipeline(pl);
      if (token) pushCalendarColor(id, pl[id].stage, token);
      // Also sync field data to Drive. queueFieldDriveSync reads fresh data
      // from IDB (base64 media included), is serialized per stop, and marks the
      // id dirty for automatic retry if this push fails.
      if (token) queueFieldDriveSync(token, id);
    }
    if (undoToastTimer.current) clearTimeout(undoToastTimer.current);
    setUndoToast({ id, cn: stop?.cn || "Stop", stop });
    undoToastTimer.current = setTimeout(() => setUndoToast(null), 10000);
    // Show next-stop card: first undismissed task stop after this one.
    // Use active (pre-filtered, excludes already-dismissed) so the index is
    // relative to what the user actually sees — avoids off-by-one when
    // earlier dismissed stops exist in the full stops array.
    const activeTasks = active.filter(s => s.isTask && s.id !== id);
    const allTasks = stops.filter(s => s.isTask);
    if (activeTasks.length > 0) {
      const doneCount = allTasks.filter(s => dismissed[s.id] || s.id === id).length;
      setNextStopCard({
        stop: activeTasks[0],
        stopNumber: doneCount + 1,
        totalStops: allTasks.length,
      });
    }
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
    if (last.type === "restore") setDismissed(p => ({...p, [last.id]: Date.now()}));
    if (last.type === "reorder") setOrdIds(prev => ({...prev, [dayKey]: last.prevOrder}));
  };
  const navigate = addr => {
    if (!addr) return;
    const q = encodeURIComponent(addr);
    window.location.href = `comgooglemaps://?daddr=${q}&directionsmode=driving`;
  };


  // ── TEXT-TO-SPEECH ────────────────────────────────────────────────────────
  // Uses browser speechSynthesis — no API, no lag, works offline.
  // Works through CarPlay/Bluetooth: iOS pauses speechSynthesis whenever the
  // audio route changes (plug/unplug CarPlay, Bluetooth handoff). We keep a
  // 500ms interval that calls resume() whenever synthesis is paused but still
  // active, which transparently handles the route-change pause.
  const ttsAudioRef = useRef(null); // kept as stub so nothing else breaks
  const ttsSafetyTimer = useRef(null); // holds the resume interval ID while speaking
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [ttsError, setTtsError] = useState(null);

  // W3C Audio Session API (Safari 17+). "transient-solo" makes the spoken
  // notes behave like a nav prompt: other audio (Music, podcasts — including
  // over CarPlay) pauses while we speak and resumes after. Silent no-op on
  // browsers without the API.
  const setAudioSession = (type) => {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
  };

  const resetTts = () => {
    setTtsSpeaking(false);
    if (ttsSafetyTimer.current) { clearInterval(ttsSafetyTimer.current); ttsSafetyTimer.current = null; }
    if (window.speechSynthesis?.speaking || window.speechSynthesis?.paused) window.speechSynthesis.cancel();
    setAudioSession("auto");
  };

  const speakStop = (stop) => {
    if (ttsSpeaking) { resetTts(); return; }
    if (!window.speechSynthesis) { setTtsError("TTS not supported in this browser"); return; }

    const text = stop.notes || "No notes available.";
    setTtsError(null);

    // Cancel only when something is actually in the queue. An unconditional
    // cancel() right before speak() trips a WebKit bug that silently drops
    // the new utterance — that was the old "first tap does nothing" behavior.
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending || synth.paused) synth.cancel();

    // iOS pauses speechSynthesis when the audio route changes (CarPlay plug/unplug,
    // Bluetooth handoff). This interval resumes it whenever that happens.
    const resumeInterval = setInterval(() => {
      if (synth.paused && synth.speaking) {
        synth.resume();
      }
    }, 500);
    ttsSafetyTimer.current = resumeInterval;

    const finish = () => {
      clearInterval(resumeInterval);
      ttsSafetyTimer.current = null;
      setTtsSpeaking(false);
      setAudioSession("auto");
    };

    let attempts = 0;
    const attempt = () => {
      attempts++;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.88;
      u.pitch = 1;

      // If WebKit silently drops the utterance (the cancel→speak race),
      // no onstart/onerror ever fires. Detect that and retry instead of
      // leaving the user to tap again.
      let started = false;
      const dropWatchdog = setTimeout(() => {
        if (!started && !synth.speaking) {
          if (attempts < 2) { attempt(); }
          else { finish(); setTtsError("Audio didn't start — tap to try again"); }
        }
      }, 400);

      // Only flip the button to "active" when speech actually begins. On iOS,
      // setting ttsSpeaking=true before speak() causes a stuck-active state when
      // the system silently fails to start: the button shows active with no audio,
      // the next tap resets it, and the tap after that finally works. Waiting for
      // onstart means if iOS drops the utterance silently, the button stays tappable
      // and the next tap retries normally.
      u.onstart = () => { started = true; clearTimeout(dropWatchdog); setTtsSpeaking(true); };

      u.onend = () => {
        clearTimeout(dropWatchdog);
        finish();
      };

      u.onerror = (ev) => {
        clearTimeout(dropWatchdog);
        // "interrupted" = stopped by another utterance; "canceled" = user/cancel() call.
        if (ev.error === "interrupted" || ev.error === "canceled") {
          finish();
          return;
        }
        // Retry once on transient failures (CarPlay/Bluetooth handoff).
        if (attempts < 2) {
          setTimeout(attempt, 350);
          return;
        }
        finish();
        setTtsError(
          (ev.error === "synthesis-failed" || ev.error === "audio-busy")
            ? "Audio unavailable — if CarPlay is active, try again after tapping the screen"
            : "TTS: " + ev.error
        );
      };

      synth.speak(u);
    };

    // Pause other audio (Music/CarPlay) for the duration, like a nav prompt.
    setAudioSession("transient-solo");
    // Speak synchronously inside the tap — iOS requires the session's first
    // speak() to run under user activation, and the utterance uses the
    // default voice, so there is nothing to wait for. (The old code deferred
    // this behind a getVoices() gate that never resolved on first tap.)
    attempt();
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

  // Flips the weekend opt-in, persists it, and reloads the day list/events
  // from scratch — the day-index meanings shift once weekends are added to
  // or removed from the sequence, so a partial patch isn't safe here.
  const toggleIncludeWeekends = () => {
    const next = !includeWeekends;
    setIncludeWeekends(next);
    includeWeekendsRef.current = next;
    lsSet("mts-include-weekends", next);
    setSelDay(0);
    setBusinessDays(getBusinessDays(10, next));
    load(false);
  };

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
      // RELOAD-LOOP BREAKER: auto-reloading on every controllerchange is a known
      // footgun — if the controller keeps changing (a wedged SW update, flaky
      // network serving inconsistent sw.js, an activate that re-claims), the page
      // reloads over and over and iOS Safari shows "A problem repeatedly
      // occurred." Cap it: no more than 2 auto-reloads within 30s. After that we
      // stop reloading and just let the current code run — a stale tab is far
      // better than an app that won't open at all.
      try {
        const now = Date.now();
        const hist = JSON.parse(sessionStorage.getItem("mts-sw-reloads") || "[]").filter(t => now - t < 30000);
        if (hist.length >= 2) { console.warn("SW reload loop suppressed"); return; }
        hist.push(now);
        sessionStorage.setItem("mts-sw-reloads", JSON.stringify(hist));
      } catch {}
      refreshing = true;
      // Don't reload in the middle of an auth flow (interactive popup or
      // reconnect) — a reload there restarts cold-start reauth and can feed the
      // popup loop. Defer until auth is idle.
      const doReload = () => {
        if (_authBusy.current) { setTimeout(doReload, 1500); return; }
        window.location.reload();
      };
      doReload();
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

  // While the cold-start silent reauth is still in flight, show a brief
  // loading view instead of the sign-in screen — otherwise the user sees a
  // flash of "Sign in with Google" on every page reload before silent reauth
  // completes.
  if (!token && !authBootChecked) return (
    <div style={{height:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0b10",color:"#5a6580",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:600,letterSpacing:1}}>Signing in…</div></div>
    </div>
  );

  if (!token) return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0a0b10",fontFamily:"'Oswald','DM Sans',system-ui,sans-serif",color:"#f0f4fa",padding:20,paddingTop:"max(20px,env(safe-area-inset-top))",boxSizing:"border-box"}}>
      <div style={{fontSize:28,fontWeight:900,letterSpacing:3,textTransform:"uppercase",fontFamily:"'Oswald',sans-serif"}}>MTS FIELD SALES</div>
      <div style={{fontSize:12,color:"#5a6580",marginBottom:32,fontWeight:500,letterSpacing:1}}>Monster Tree Service of Rochester</div>
      <button onClick={serverSignIn} style={{padding:"16px 40px",borderRadius:12,background:"#1a2035",border:"1px solid #2a3560",color:"#f0f4fa",fontSize:16,fontWeight:700,cursor:"pointer",letterSpacing:.5}}>Sign in with Google</button>
      {/* Fallback: the original popup sign-in, in case the redirect flow ever
          has trouble — so a backend hiccup can never lock you out. */}
      <button onClick={initAuth} style={{marginTop:14,padding:"8px 16px",borderRadius:8,background:"transparent",border:"none",color:"#5a6580",fontSize:12,fontWeight:600,cursor:"pointer",letterSpacing:.3,textDecoration:"underline"}}>Trouble signing in? Use classic sign-in</button>
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
      {/* Reconnect bar — shown when a silent token refresh failed but we still
          have local data. Keeps the app usable and offers ONE interactive
          re-auth instead of bouncing to the sign-in screen in a loop. */}
      {needsReconnect && (
        <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(246,191,38,.16)",borderBottom:"1px solid rgba(246,191,38,.4)"}}>
          <span style={{flex:1,fontSize:12.5,color:"#F6BF26",fontWeight:700}}>{Object.keys(rawEvents).length === 0 ? "Can't reach Google — reconnect to load your stops." : "Google session expired — reconnect to sync."}</span>
          <button onClick={async () => {
            // Fast path first: a silent reauth often succeeds without the full
            // sign-in redirect. Only if that fails do we bounce to serverSignIn.
            const ok = await silentReauth();
            if (ok) { setNeedsReconnect(false); await new Promise(r=>setTimeout(r,200)); load(true); }
            else { serverSignIn(); }
          }} style={{padding:"8px 16px",borderRadius:8,background:"rgba(246,191,38,.28)",border:"1px solid rgba(246,191,38,.6)",color:"#F6BF26",fontSize:12.5,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>Reconnect</button>
        </div>
      )}
      {/* Shown when today's stops failed to load (all retries exhausted) and
          nothing has come in yet — a background retry is already scheduled,
          but this gives an immediate manual option instead of forcing a
          full app restart to recover, which was the only fix before. */}
      {error && !loading && Object.keys(rawEvents).length === 0 && !needsReconnect && (
        <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"rgba(255,85,85,.1)",borderBottom:"1px solid rgba(255,85,85,.3)"}}>
          <span style={{flex:1,fontSize:12,color:"#ff8080",fontWeight:600}}>Couldn't load today's stops — retrying automatically…</span>
          <button onClick={async () => { const ok = await silentReauth(); await new Promise(r=>setTimeout(r,200)); load(true); if(!ok) setNeedsReconnect(true); }} style={{padding:"6px 14px",borderRadius:8,background:"rgba(255,85,85,.2)",border:"1px solid rgba(255,85,85,.5)",color:"#ff8080",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>Retry Now</button>
        </div>
      )}
      <style>{`
.scr::-webkit-scrollbar{width:0}
.mts-pl-col{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.07) transparent}
.mts-pl-col::-webkit-scrollbar{width:3px}
.mts-pl-col::-webkit-scrollbar-track{background:transparent}
.mts-pl-col::-webkit-scrollbar-thumb{background:rgba(255,255,255,.09);border-radius:99px}
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
        {token && <button onClick={async () => {
            // If we're in an error state — OR the route never loaded — refresh
            // the token first, then re-fetch stops. Tapping this button when the
            // route is empty is a natural recovery instinct, so make it actually
            // recover: a stops-load, not just a Drive field sync.
            const routeEmpty = Object.keys(rawEvents).length === 0;
            if (syncIndicator === "error" || syncIndicator === "auth-error" || routeEmpty) {
              await silentReauth();
              // Give the new token a moment to settle in localStorage
              await new Promise(r => setTimeout(r, 300));
            }
            if (routeEmpty) { setNeedsReconnect(false); load(true); }
            // Full reconcile: pull everything (force, ignoring the seen-map),
            // union-merging Drive into local, THEN push every local field back
            // so this device's complete data lands on Drive. Pull-before-push
            // guarantees we upload the superset and never clobber another
            // device's photos.
            triggerCloudSync(true);
            await pullFromDrive(true);
            await pushAllFields();
          }}
          title={syncPulling ? "Syncing…" : (syncIndicator==="error"||syncIndicator==="auth-error") ? "Sync error — tap to retry" : "Tap to force full sync"}
          style={{background:"none",border:"none",cursor:"pointer",padding:"2px 6px",display:"flex",alignItems:"center",gap:3}}>
          {(syncIndicator==="error"||syncIndicator==="auth-error") ? <IconCloudOff size={13} color="#FF5555"/> : (syncIndicator==="syncing"||syncPulling) ? <IconCloud size={13} color="#F6BF26"/> : <IconCloud size={13} color="#10B981"/>}
          {/* data-synctick references syncTick (updated every minute) so the
              "Xm ago" label re-renders and stays current between syncs. */}
          {lastSyncTime>0 && <span data-synctick={syncTick} style={{fontSize:9,color:(syncIndicator==="syncing"||syncPulling)?"#F6BF26":"#3a5060",fontFamily:"'Oswald',sans-serif"}}>{(syncIndicator==="syncing"||syncPulling)?"syncing…":Math.floor((Date.now()-lastSyncTime)/60000)<1?"now":`${Math.floor((Date.now()-lastSyncTime)/60000)}m`}</span>}
        </button>}
        <div style={{flex:1}} onClick={handleDebugTap}/>
        {view === "route" && <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={()=>setSearchOpen(true)} title="Search everything" style={{padding:"5px 7px",borderRadius:8,background:"transparent",border:"1px solid #2a3560",color:"#3a4a60",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <IconSearch size={14} color="#3a4a60" />
          </button>
          <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setReorderMode(false);setMoving(null);}} style={{padding:"5px 10px",borderRadius:8,border:"1px solid #2a3560",background:"#0a0b10",color:"#f0f4fa",fontSize:11,fontWeight:600,cursor:"pointer",outline:"none",appearance:"auto",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
            {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </div>}
        {view === "pipeline" && <button onClick={()=>setSearchOpen(true)} title="Search everything" style={{padding:"5px 7px",borderRadius:8,background:"transparent",border:"1px solid #2a3560",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IconSearch size={14} color="#3a4a60" />
        </button>}
        {view === "pipeline" && pipelineSelectMode && pipelineSelectedCount > 0 && (
          <button onClick={()=>setPipelineBulkEmailTick(t=>t+1)} style={{padding:"5px 10px",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
            Email {pipelineSelectedCount}
          </button>
        )}
        {view === "pipeline" && (
          <button onClick={()=>{setPipelineSelectMode(s=>!s);setPipelineSelectedCount(0);}} style={{padding:"5px 10px",borderRadius:8,background:pipelineSelectMode?"rgba(59,130,246,.15)":"transparent",border:`1px solid ${pipelineSelectMode?"rgba(59,130,246,.3)":"#2a3560"}`,color:pipelineSelectMode?"#3B82F6":"#4a5a70",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
            {pipelineSelectMode ? <><svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Done</> : "Select"}
            {pipelineSelectMode && pipelineSelectedCount > 0 && <span style={{fontSize:9,padding:"1px 5px",borderRadius:99,background:"rgba(59,130,246,.25)",color:"#3B82F6",fontWeight:800}}>{pipelineSelectedCount}</span>}
          </button>
        )}
      </div>

      {/* ── HEALTH BANNER ───────────────────────────────────────────── */}
      {healthBanner && (
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",background:"rgba(246,191,38,.08)",borderBottom:"1px solid rgba(246,191,38,.2)",flexShrink:0}}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#F6BF26" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span style={{flex:1,fontSize:11,color:"#d4a820",fontWeight:600}}>{healthBanner.message}</span>
          {healthBanner.action && (
            <button onClick={() => { healthBanner.action(); setHealthBanner(null); _healthDismissed.current.add(healthBanner.type); }} style={{padding:"3px 10px",borderRadius:6,background:"rgba(246,191,38,.15)",border:"1px solid rgba(246,191,38,.3)",color:"#F6BF26",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0}}>{healthBanner.actionLabel}</button>
          )}
          <button onClick={() => { _healthDismissed.current.add(healthBanner.type); setHealthBanner(null); }} style={{background:"none",border:"none",color:"#7a6020",cursor:"pointer",padding:2,display:"flex",flexShrink:0}}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

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
          {/* Always mounted while on the Route view — do NOT gate on
              mapStops.length. Gating tore the whole Google Map down (and, now,
              ran its unmount teardown) every time the stop list momentarily
              emptied during startup churn or a day switch, then rebuilt it from
              scratch — a full re-init + re-geocode that read as the map
              vanishing and "taking forever to load." RouteMap no-ops cleanly
              with zero stops. */}
          <RouteMap stops={mapStops} selectedId={expanded}/>
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
                {s.notes && <div style={{fontSize:13,color:"#a0b0c0",lineHeight:1.6,marginBottom:10,fontWeight:500}}><Linkify text={s.notes} linkColor="#7BB3FF"/></div>}
                {s.phone && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:3,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconPhone size={13} color="#a0b8d0"/>{s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#a0b8d0",marginBottom:8,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#a0b8d0"/>{s.email}</div>}
                {declineConfirm === s.id ? (
                  <button onClick={()=>decline(s.id)} style={{width:"100%",padding:"11px 0",marginTop:4,borderRadius:8,background:"rgba(200,60,60,.15)",border:"1px solid rgba(200,60,60,.3)",color:"#FF5555",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",animation:"pulse 1s infinite",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconX size={14} color="#FF5555"/>CONFIRM DECLINE?</button>
                ) : rejectConfirm === s.id ? (
                  <button onClick={()=>markReject(s.id)} style={{width:"100%",padding:"11px 0",marginTop:4,borderRadius:8,background:"rgba(255,140,0,.15)",border:"1px solid rgba(255,140,0,.4)",color:"#FF8C00",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",animation:"pulse 1s infinite",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconNoSymbol size={14} color="#FF8C00"/>CONFIRM REJECT?</button>
                ) : (
                  <div style={{display:"flex",gap:6,marginTop:4}}>
                    {s.phone && <button onClick={()=>{setTextSheet(s);setOtwMinutes(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={16} color="#a0b8d0"/></button>}
                    {s.notes && <button onClick={()=>speakStop(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:ttsSpeaking?"rgba(100,80,200,.18)":"rgba(100,80,200,.08)",border:"1px solid rgba(100,80,200,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{ttsSpeaking ? <IconX size={16} color="#8a80c0"/> : <IconVolume2 size={16} color="#8a80c0"/>}</button>}
                    <button onClick={()=>openOnsite(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconClipboard size={16} color="#10B981"/></button>
                    <button onClick={()=>setMovePicker(movePicker?.stopId === s.id ? null : { stopId: s.id })} title="Move to another day" style={{flex:1,padding:"10px 0",borderRadius:8,background:movePicker?.stopId===s.id?"rgba(246,191,38,.18)":"rgba(246,191,38,.06)",border:`1px solid ${movePicker?.stopId===s.id?"rgba(246,191,38,.4)":"rgba(246,191,38,.15)"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconCalendar size={16} color="#F6BF26"/></button>
                    <button onClick={()=>{setDeclineConfirm(s.id);setRejectConfirm(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(200,60,60,.06)",border:"1px solid rgba(200,60,60,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={16} color="#a06060"/></button>
                    <button onClick={()=>{setRejectConfirm(s.id);setDeclineConfirm(null);}} title="Flag: reject in SingleOps" style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(255,140,0,.06)",border:"1px solid rgba(255,140,0,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconNoSymbol size={16} color="#a07030"/></button>
                    {!s.isTask && <button onClick={()=>deleteStop(s.id)} title="Delete permanently" style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(100,100,100,.06)",border:"1px solid rgba(100,100,100,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconTrash size={16} color="#4a5a70"/></button>}
                  </div>
                )}
                {/* Day picker popover — shown beneath action row when active */}
                {movePicker?.stopId === s.id && (
                  <div style={{marginTop:8,padding:10,borderRadius:8,background:"#0a0c14",border:"1px solid rgba(246,191,38,.25)"}}>
                    <div style={{fontSize:9,color:"#F6BF26",fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",marginBottom:8}}>Move to which day?</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6}}>
                      {businessDays.map((d, idx) => {
                        const isCurrent = idx === selDay;
                        const label = d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
                        return (
                          <button
                            key={idx}
                            disabled={isCurrent}
                            onClick={() => moveStopToDay(s.id, d)}
                            style={{
                              padding: "8px 6px",
                              borderRadius: 6,
                              background: isCurrent ? "transparent" : "rgba(246,191,38,.08)",
                              border: `1px solid ${isCurrent ? "#1a2030" : "rgba(246,191,38,.25)"}`,
                              color: isCurrent ? "#3a4a60" : "#F6BF26",
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: isCurrent ? "default" : "pointer",
                              fontFamily: "'Oswald',sans-serif",
                              letterSpacing: 0.5,
                              textTransform: "uppercase",
                            }}
                          >
                            {label}{isCurrent ? " (now)" : ""}
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={() => setMovePicker(null)} style={{width:"100%",marginTop:8,padding:"6px 0",borderRadius:6,background:"transparent",border:"1px solid #1a2030",color:"#5a6580",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>Cancel</button>
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
            ) : null}
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

      {/* ── INLINE UPLOAD TRACKER ─────────────────────────────────────
          Sits in the document flow above the bottom bar so the Reorder
          button is never hidden by upload progress. */}
      <UploadTracker stopMap={stopMap} inline onOpenUploads={() => setUploadsOpen(true)} />

      {/* ── BOTTOM BAR ──────────────────────────────────────────────── */}
      {view === "route" && <div style={{borderTop:"1px solid #0e1520",padding:"4px 8px",paddingBottom:"max(4px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",gap:5,background:"#080a10",flexShrink:0}}>
        {/* Settings — hamburger menu holding sync, weekend toggle, video
            uploads, data recovery, storage, and sign out (previously all loose
            on this bar). Bottom-left. */}
        <button onClick={()=>setSettingsOpen(true)} title="Settings & tools"
          style={{width:34,height:34,borderRadius:8,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#8aa0c0" strokeWidth={2} strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        {/* Undo */}
        <button onClick={undo} disabled={!undoStack.length} title="Undo"
          style={{width:34,height:34,borderRadius:8,background:"#1a2035",border:"1px solid #1a2030",cursor:undoStack.length?"pointer":"default",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <IconUndo size={15} color={undoStack.length?"#5a6580":"#1a2035"}/>
        </button>
        {/* Reorder — narrower, centered */}
        <div style={{flex:1,display:"flex",justifyContent:"center"}}>
          <button onClick={()=>{if(reorderMode){setReorderMode(false);setMoving(null);}else{setReorderMode(true);setMoving(null);setExpanded(null);}}}
            title={reorderMode?"Done reordering":"Reorder stops"}
            style={{height:34,padding:"0 20px",borderRadius:8,background:reorderMode?"rgba(142,36,170,.2)":"rgba(255,255,255,.04)",border:`1px solid ${reorderMode?"rgba(142,36,170,.5)":"#252d47"}`,cursor:"pointer",display:"flex",alignItems:"center",gap:5,transition:"all .15s"}}>
            <IconReorder size={14} color={reorderMode?"#c8a0e8":"#5a6890"}/>
            <span style={{fontSize:11,fontWeight:700,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",color:reorderMode?"#c8a0e8":"#5a6890"}}>{reorderMode?"DONE":"REORDER"}</span>
          </button>
        </div>
        {/* Add Visit */}
        <button onClick={()=>setAddStopOpen(true)} title="Add a stop"
          style={{width:34,height:34,borderRadius:8,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <IconPlus size={15} color="#3B82F6" />
        </button>
      </div>}
      {view === "pipeline" && <div style={{borderTop:"1px solid #0e1520",padding:"4px 10px",paddingBottom:"max(4px,env(safe-area-inset-bottom))",display:"flex",alignItems:"center",justifyContent:"flex-end",gap:6,background:"#080a10",flexShrink:0}}>
        {/* Video Uploads — always reachable */}
        <button onClick={()=>setUploadsOpen(true)} title="Video uploads"
          style={{width:32,height:32,borderRadius:8,background:"rgba(255,107,94,.1)",border:"1px solid rgba(255,107,94,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IconVideo size={14} color="#FF6B5E" />
        </button>
        {/* Data Recovery */}
        <button onClick={()=>setRecoveryOpen(true)} title="Find old job photos"
          style={{width:32,height:32,borderRadius:8,background:"rgba(99,102,241,.1)",border:"1px solid rgba(99,102,241,.25)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IconClock size={14} color="#818cf8" />
        </button>
        <button
          onClick={()=>{ if(signOutConfirm){ setToken(null); setNeedsReconnect(false); _acctChecked.current=false; try{localStorage.removeItem("mts-token");}catch(e){} setSignOutConfirm(false);} else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }}
          title={signOutConfirm ? "Tap again to confirm" : "Sign out"}
          style={{width:32,height:32,borderRadius:8,background:signOutConfirm?"rgba(255,85,85,.15)":"transparent",border:`1px solid ${signOutConfirm?"rgba(255,85,85,.4)":"#1a2035"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transition:"all .15s"}}>
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke={signOutConfirm?"#FF5555":"#3a4a60"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>}

      {/* ── ROUTE SETTINGS SHEET ─────────────────────────────────────────
          Holds the tools that used to be loose across the route bottom bar +
          header (sync, weekend toggle, video uploads, data recovery, storage,
          sign out), opened from the bottom-left hamburger. */}
      {settingsOpen && (() => {
        const Row = ({ icon, label, sub, onClick, danger, accent }) => (
          <button onClick={onClick} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"12px 6px",background:"transparent",border:"none",borderBottom:"1px solid #131a28",cursor:"pointer",textAlign:"left"}}>
            <span style={{width:36,height:36,borderRadius:9,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:(accent||"#5a6580")+"1a",border:`1px solid ${(accent||"#5a6580")}55`}}>{icon}</span>
            <span style={{flex:1,minWidth:0}}>
              <div style={{fontSize:14.5,fontWeight:700,color:danger?"#FF6B6B":"#e6ecf5"}}>{label}</div>
              {sub && <div style={{fontSize:11.5,color:"#5a6580",marginTop:1,lineHeight:1.35}}>{sub}</div>}
            </span>
          </button>
        );
        return (
          <div onClick={()=>setSettingsOpen(false)} style={{position:"fixed",inset:0,zIndex:350,background:"rgba(0,0,0,.55)",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",borderTop:"1px solid #1a2030",borderTopLeftRadius:18,borderTopRightRadius:18,padding:"8px 16px",paddingBottom:"max(16px,env(safe-area-inset-bottom))",boxShadow:"0 -14px 44px rgba(0,0,0,.55)"}}>
              <div style={{width:42,height:4,borderRadius:2,background:"#2a3550",margin:"4px auto 12px"}}/>
              <div style={{fontSize:11,fontWeight:800,color:"#4a5a70",letterSpacing:1.2,textTransform:"uppercase",fontFamily:"'Oswald',sans-serif",margin:"0 6px 6px"}}>Settings &amp; Tools</div>
              <Row accent="#5a8ab0"
                icon={<IconRefresh size={17} color="#8aa0c0" style={{animation:loading?"spin 1s linear infinite":undefined}}/>}
                label="Sync now" sub="Reload today's stops from the calendar"
                onClick={()=>{ load(true); setSettingsOpen(false); }} />
              <Row accent={includeWeekends?"#F6BF26":"#5a6580"}
                icon={<IconCalendar size={17} color={includeWeekends?"#F6BF26":"#8aa0c0"}/>}
                label={includeWeekends?"Weekends: On":"Weekends: Off"}
                sub={includeWeekends?"Saturdays & Sundays are selectable days":"Tap to include Saturdays & Sundays"}
                onClick={()=>{ toggleIncludeWeekends(); }} />
              <Row accent="#FF6B5E"
                icon={<IconVideo size={17} color="#FF6B5E"/>}
                label="Video uploads" sub="Queued, uploading, or failed videos"
                onClick={()=>{ setUploadsOpen(true); setSettingsOpen(false); }} />
              <Row accent="#818cf8"
                icon={<IconClock size={17} color="#818cf8"/>}
                label="Find old job photos" sub="Search past visits by name or date"
                onClick={()=>{ setRecoveryOpen(true); setSettingsOpen(false); }} />
              <Row accent="#818cf8"
                icon={<IconDatabase size={17} color="#818cf8"/>}
                label="Storage usage" sub="Photo/video storage on this device"
                onClick={()=>{ setStorageOpen(true); setSettingsOpen(false); }} />
              <Row danger accent="#FF6B6B"
                icon={<svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#FF6B6B" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>}
                label={signOutConfirm?"Tap again to confirm sign out":"Sign out"}
                sub={signOutConfirm?"Your data is safe in Drive and re-syncs on next sign in":null}
                onClick={()=>{ if(signOutConfirm){ setToken(null); setNeedsReconnect(false); _acctChecked.current=false; try{localStorage.removeItem("mts-token");}catch(e){} setSignOutConfirm(false); setSettingsOpen(false); } else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }} />
            </div>
          </div>
        );
      })()}

      {/* ── ADD STOP POPUP ─────────────────────────────────────────── */}
      <AddStopModal
        open={addStopOpen}
        onClose={() => setAddStopOpen(false)}
        clientIndex={clientIndex}
        onSubmit={(form) => {
          const id = "local-" + Date.now();
          if (form.dest === "pipeline") {
            const pl = loadPipeline();
            pl[id] = {
              id,
              cn: form.name || form.addr,
              addr: form.addr,
              phone: form.phone,
              email: form.email,
              notes: form.notes,
              stage: "estimate_needed",
              addedAt: Date.now(),
              stageChangedAt: Date.now(),
              hot: false,
            };
            savePipeline(pl);
            if (token) pushCalendarColor(id, "estimate_needed", token);
          } else {
            // Add to currently-selected day's route. The event SUMMARY prefix is
            // what parseEvent keys off to classify the stop:
            //   "TASK …"            → a Visit (scheduled estimate)
            //   "TASK … - DRIVE BY" → a Visit flagged drive-by (DB badge)
            //   "TODO: …"           → a To-Do (renders as a TD, no arrival window)
            const label = form.name || form.addr;
            const isTodo = form.type === "todo";
            const isDriveBy = form.type === "driveby";
            const summary = isTodo
              ? `TODO: ${label}`
              : isDriveBy ? `TASK ${label} - DRIVE BY` : `TASK ${label}`;
            // To-Dos have no arrival window — give them a full-day span. Visits
            // and drive-bys use the chosen window (AM 8–12, PM 11–3).
            const [startHour, endHour] =
              isTodo ? [8, 17] :
              form.time === "AM" ? [8, 12] :
              form.time === "PM" ? [11, 15] :
              [8, 17]; // All Day → full work day
            const startDt = new Date(businessDays[selDay] || new Date());
            startDt.setHours(startHour, 0, 0, 0);
            const endDt = new Date(startDt); endDt.setHours(endHour, 0, 0, 0);
            // Build a description that includes phone/email if provided so
            // parseEvent can extract them.
            const descParts = [];
            if (form.phone) descParts.push(`Phone: ${form.phone}`);
            if (form.email) descParts.push(`Email: ${form.email}`);
            if (form.notes) descParts.push(`Notes: ${form.notes}`);
            const localEvent = {
              id,
              summary,
              location: form.addr,
              start: { dateTime: startDt.toISOString() },
              end: { dateTime: endDt.toISOString() },
              colorId: isTodo ? "5" : "7", // TDs a different calendar color than visits
              description: descParts.join("\n"),
            };
            // Persist locally so the stop is immediately visible (and survives reload
            // in case the Calendar push below fails while offline).
            const ls = localStopsGet(); ls[id] = { event: localEvent, dk: dayKey }; localStopsSet(ls);
            setRawEvents(prev => {
              const dayEvts = prev[dayKey] || [];
              return { ...prev, [dayKey]: [...dayEvts, localEvent] };
            });
            // Push to Google Calendar so the stop persists across day rollovers and
            // syncs to the desktop view. Replace the local event with the real one on
            // success; on failure (offline) the local stop stays in localStorage and
            // will roll forward to today on the next load().
            if (token) {
              (async () => {
                try {
                  const res = await fetch(`${CAL_BASE}/events`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                      summary: localEvent.summary,
                      location: localEvent.location,
                      start: localEvent.start,
                      end: localEvent.end,
                      colorId: localEvent.colorId,
                      description: localEvent.description,
                    }),
                  });
                  if (res.ok) {
                    const created = await res.json();
                    const realId = created.id;
                    // Keep local stop as a fallback until Phase 2 confirms Calendar API
                    // returns the event. Without this, a transient API miss on next reload
                    // would silently lose the appointment with no recovery path.
                    const lsNow = localStopsGet();
                    if (lsNow[id]) {
                      lsNow[id] = { event: created, dk: lsNow[id].dk || dayKey, pushedId: realId };
                      localStopsSet(lsNow);
                    }
                    // Swap the local placeholder with the real Calendar event
                    setRawEvents(prev => {
                      const dayEvts = (prev[dayKey] || []).filter(e => e.id !== id);
                      return { ...prev, [dayKey]: [...dayEvts, created] };
                    });
                    setOrdIds(prev => {
                      const order = prev[dayKey] || [];
                      return { ...prev, [dayKey]: order.map(oid => oid === id ? realId : oid) };
                    });
                  }
                } catch(e) {
                  console.warn("Calendar push for local stop failed (offline?):", e);
                }
              })();
            }
          }
        }}
      />
      </>}{/* end route view */}

      {/* ── PIPELINE VIEW ──────────────────────────────────────────── */}
      {view === "pipeline" && pipelineSearchOpen && <div style={{padding:"6px 8px",borderBottom:"1px solid #0e1218",background:"#090b0f",display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
        <input value={pipelineSearch} onChange={e=>setPipelineSearch(e.target.value)} autoFocus placeholder="Search pipeline..." style={{flex:1,padding:"6px 10px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:16,fontFamily:"'DM Sans',system-ui",outline:"none"}} onBlur={()=>{try{window.scrollTo(0,0);}catch(e){}}} />
        <button onClick={()=>{setPipelineSearchOpen(false);setPipelineSearch("");}} style={{padding:"6px 8px",borderRadius:6,background:"transparent",border:"none",color:"#4a5a70",cursor:"pointer"}}><IconX size={13} color="#4a5a70"/></button>
      </div>}
      {view === "pipeline" && <Pipeline onSwitchToRoute={(cardId) => { setView("route"); setSelDay(0); if (cardId) { setDismissed(prev => { const n={...prev}; delete n[cardId]; return n; }); const pl=loadPipeline(); delete pl[cardId]; savePipeline(pl); } }} search={pipelineSearch} onCloudSync={triggerCloudSync} token={token} lastContact={lastContact} markContact={markContact} selectMode={pipelineSelectMode} setSelectMode={setPipelineSelectMode} onSelectCountChange={setPipelineSelectedCount} bulkEmailTick={pipelineBulkEmailTick} />}

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
        onEditDetails={(edits) => {
          const overrides = stopOverridesGet();
          overrides[onsiteStop.id] = { ...(overrides[onsiteStop.id] || {}), ...edits };
          stopOverridesSet(overrides);
          setStopOverridesVersion(v => v + 1);
          setOnsiteStop(prev => prev ? { ...prev, ...edits } : prev);
          // If this stop already has a pipeline card, keep its details in sync too.
          const pl = loadPipeline();
          if (pl[onsiteStop.id]) {
            pl[onsiteStop.id] = { ...pl[onsiteStop.id], ...edits };
            savePipeline(pl);
          }
        }}
        onMarkReject={() => {
          const stop = stopMap[onsiteStop.id];
          if (stop) {
            const pl = loadPipeline();
            const ex = pl[onsiteStop.id];
            const keepStage = ex && ex.stage !== "estimate_needed";
            pl[onsiteStop.id] = {
              id: onsiteStop.id, cn: stop.cn, addr: stop.addr, phone: stop.phone, email: stop.email,
              jn: stop.jn, notes: stop.notes, constraint: stop.constraint,
              stage: keepStage ? ex.stage : "estimate_needed",
              addedAt: ex?.addedAt || Date.now(),
              stageChangedAt: keepStage ? ex.stageChangedAt : Date.now(),
              hot: ex?.hot ?? false,
              ...(ex?.estimateSentAt ? { estimateSentAt: ex.estimateSentAt } : {}),
              ...(ex?.pauseUntil ? { pauseUntil: ex.pauseUntil } : {}),
              pendingRejectInSingleops: true,
            };
            savePipeline(pl);
            if (token) pushCalendarColor(onsiteStop.id, pl[onsiteStop.id].stage, token);
          }
          setDismissed(p => ({...p,[onsiteStop.id]:Date.now()}));
          setExpanded(null);
          setOnsiteStop(null);
        }}
      />}

      {/* ── NEXT STOP CARD ───────────────────────────────────────── */}
      {nextStopCard && (
        <NextStopCard
          stop={nextStopCard.stop}
          stopNumber={nextStopCard.stopNumber}
          totalStops={nextStopCard.totalStops}
          onDismiss={() => setNextStopCard(null)}
          onNavigate={(stop) => {
            setNextStopCard(null);
            setView("route");
            setExpanded(stop.id);
          }}
        />
      )}

      {/* ── UNIVERSAL SEARCH ──────────────────────────────────────── */}
      <UniversalSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        routeStops={stops}
        pipeline={pipelineSnapshot}
        weekEvents={allEventsAcrossDays}
        deepEvents={deepEvents}
        deepLoading={deepLoading}
        onDeepSearch={runDeepSearch}
        onOpenStop={(stop) => { setSearchOpen(false); openOnsite(stop); }}
        onOpenCard={(card) => { setSearchOpen(false); setView("pipeline"); setPipelineSearch(card.cn || card.jn || ""); setPipelineSearchOpen(true); }}
      />

      {/* ── VIDEO UPLOAD MANAGER ──────────────────────────────────── */}
      <VideoUploads open={uploadsOpen} onClose={() => setUploadsOpen(false)} stopMap={stopMap} />
      <StoragePanel open={storageOpen} onClose={() => setStorageOpen(false)} token={token} />

      {/* ── DATA RECOVERY SCREEN ─────────────────────────────────── */}
      {recoveryOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 300 }}>
          <RecoveryScreen token={token} onBack={() => setRecoveryOpen(false)} />
        </div>
      )}

      {/* ── DEBUG PANEL (5-tap on header spacer) ─────────────────── */}
      {debugOpen && (
        <DebugPanel
          onClose={() => setDebugOpen(false)}
          token={token}
          lastSyncTime={lastSyncTime}
        />
      )}

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

      {/* (UploadTracker is mounted inline above the bottom bar — see above) */}
    </div>
  );
}
