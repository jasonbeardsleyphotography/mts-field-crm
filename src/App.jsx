import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { parseEvent, stageColor } from "./parseEvent";
import RouteMap, { AM_COLOR, PM_COLOR } from "./RouteMap";
import SwipeCard from "./SwipeCard";
import OnsiteWindow from "./OnsiteWindow";
import UniversalSearch from "./UniversalSearch";
import Pipeline, { savePipeline, loadPipeline, pushCalendarColor } from "./Pipeline";
import { saveAppState, loadAppState, loadFieldFromDrive, listFieldFiles, onSyncStatus, onAuthError, queueFieldDriveSync } from "./driveSync";
import { loadField, listFieldIds, updateField, getDirtyFieldIds, deleteFieldDB, deleteField } from "./fieldStore";
import { startPhotoSyncWatcher } from "./photoSync";
import { photoKey } from "./imageUtils";
import { startVideoQueueWatcher, pendingCount as videoPendingCount, onQueueChange as onVideoQueueChange, deleteVideoQueueDB } from "./videoQueue";
import { pruneLog as pruneVideoLog } from "./videoLog";
import UploadTracker from "./UploadTracker";
import DebugPanel from "./DebugPanel";
import PhotoUploads from "./PhotoUploads";
import DriveCleanup from "./DriveCleanup";
import ContactCleanup from "./ContactCleanup";
import { loadContactIndex, clientKeyFor, phone10, CLIENT_KEY_FIELD, saveClientContact } from "./googleContacts";
import RealWorkHandoff from "./RealWorkHandoff";
import RealWorkSetup from "./RealWorkSetup";
import IphoneVideoSetup from "./IphoneVideoSetup";
import { isIphoneVideoReady } from "./iphoneVideo";
import { isShortcutReady } from "./realwork";
import NextStopCard from "./NextStopCard";
import VideoUploads from "./VideoUploads";
import StoragePanel from "./StoragePanel";
import RecoveryScreen from "./RecoveryScreen";
import Linkify from "./Linkify";
import AddStopModal from "./AddStopModal";
import AccountCheck from "./AccountCheck";
import MediaRecover from "./MediaRecover";
import { startPrefsBackup } from "./devicePrefs";
import { openDirections } from "./openMaps";
import { getMyName, setMyName, ensureMyName } from "./myName";
import { openAccountGate, closeAccountGate } from "./accountGate";
import { buildClientIndex } from "./clientIndex";
import {
  IconArrowLeft, IconNavigation, IconMessageSquare, IconVolume2,
  IconClipboard, IconX, IconRotateCcw, IconRefresh, IconReorder, IconUndo,
  IconPlus, IconSearch, IconTrash, IconChevronDown, IconChevronRight,
  IconCloud, IconCloudOff, IconCheckCircle, IconEdit, IconPhone, IconMail, IconClock, IconCalendar,
  IconNoSymbol, IconDatabase, IconVideo, IconImage
} from "./icons";
import { flog, freezeReport } from "./freezeLog";

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
// How many days the day-selector offers. Today loads first and the rest stream
// in one at a time in the background (see load()'s Phase 2), so a longer list
// costs nothing at startup — it just means more days are reachable for
// scheduling ahead and for moving a stop to a later date.
const DAY_COUNT = 30;

function getBusinessDays(n, includeWeekends = false) {
  const days = []; let d = new Date(); d.setHours(0,0,0,0);
  while (days.length < n) { if (includeWeekends || (d.getDay()!==0 && d.getDay()!==6)) days.push(new Date(d)); d.setDate(d.getDate()+1); }
  return days;
}

// ── GOOGLE CALENDAR API ──────────────────────────────────────────────────────
async function fetchEvents(token, dayStart, dayEnd) {
  const url = `${CAL_BASE}/events?timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250&timeZone=America/New_York`;
  // Give up on a request after 20s: on a weak signal it could otherwise hang
  // for minutes behind the full-screen "Loading…" (the caller retries).
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let res;
  try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal }); }
  finally { clearTimeout(timer); }
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
  // The primary calendar's id IS the account's address, and calendar access is
  // the one permission every sign-in has (the route needs it) — the server
  // checks accounts the same way. People API is only a fallback.
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id",
      { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      const id = (await r.json())?.id;
      if (typeof id === "string" && id.includes("@")) return id.toLowerCase();
    }
  } catch {}
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

// The Drive pull's record of which visit files it has already downloaded
// (file name → Drive modifiedTime). It used to be stored at
// "mts-field-remote-seen" — inside the prefix fieldStore treats as visit
// records, so a sweep over "every visit" loaded it as one and overwrote it
// with an empty visit summary. The pull then forgot everything and
// re-downloaded every visit, again and again: the source of the freezes.
const REMOTE_SEEN_KEY = "mts-remote-seen";
function loadRemoteSeen() {
  const cur = lsGet(REMOTE_SEEN_KEY, null);
  if (cur && typeof cur === "object") return cur;
  // One-time move from the old key, if it still holds the real map.
  const old = lsGet("mts-field-remote-seen", null);
  const looksReal = old && typeof old === "object" && Object.values(old).some(v => typeof v === "number" && v > 1e12);
  return looksReal ? { ...old } : {};
}
function saveRemoteSeen(seen) { lsSet(REMOTE_SEEN_KEY, seen); }

// Work captured on this device that hasn't reached Drive yet. A switch to a
// different account must not delete it.
async function pendingLocalWork() {
  let photos = 0, notes = 0, videos = 0;
  try { photos = JSON.parse(localStorage.getItem("mts-photo-queue") || "[]").length; } catch {}
  try { notes = getDirtyFieldIds().length; } catch {}
  try { videos = await videoPendingCount(); } catch {}
  return { photos, notes, videos, any: photos + notes + videos > 0 };
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
/* One row of the Settings sheet.

   Defined HERE, at module level, on purpose. It used to be declared inside the
   sheet's render code, which makes it a brand-new component type on every
   render of the app — so React threw away and rebuilt every row each time
   anything changed. The route keeps changing while the calendar fills in
   (up to 30 updates after a sync or the weekend toggle), and a tap that lands
   while its button is being torn down and rebuilt simply does nothing. That
   was the settings menu "freezing". A stable component is only re-rendered,
   never rebuilt, so taps always land. */
/* Did someone sign out on purpose on this device?

   Signing out used to clear only the token in the browser; the next launch
   then silently signed the same person back in — through the server session,
   or failing that through Google's own silent sign-in. On a shared phone or
   Chromebook that hands the next person the previous person's account. So an
   explicit sign-out leaves this flag, and automatic sign-in is skipped until
   someone signs in on purpose. Returning from the server sign-in (?signedin)
   counts as on purpose. */
function explicitlySignedOut() {
  try {
    if (new URLSearchParams(window.location.search).has("signedin")) {
      localStorage.removeItem("mts-signed-out");
      return false;
    }
    return localStorage.getItem("mts-signed-out") === "1";
  } catch { return false; }
}

function SettingsRow({ icon, label, sub, onClick, danger, accent }) {
  return (
    <button onClick={onClick} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"9px 6px",background:"transparent",border:"none",borderBottom:"1px solid #131a28",cursor:"pointer",textAlign:"left"}}>
      <span style={{width:32,height:32,borderRadius:8,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",background:(accent||"#5a6580")+"1a",border:`1px solid ${(accent||"#5a6580")}55`}}>{icon}</span>
      <span style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14.5,fontWeight:700,color:danger?"#FF6B6B":"#e6ecf5"}}>{label}</div>
        {sub && <div style={{fontSize:11.5,color:"#707c9a",marginTop:1,lineHeight:1.35}}>{sub}</div>}
      </span>
    </button>
  );
}

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
      try { localStorage.removeItem("mts-signed-out"); } catch {}
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
  /* Pacing for silent re-auth.
     okAt   — when one last SUCCEEDED. A 401 arriving seconds after a refresh
              is not a stale token, so refreshing again cannot help.
     failAt/fails — exponential backoff after failures, so a service that keeps
              rejecting us is asked once a minute, not once a request.
     gisAt  — when the GIS fallback last ran. THAT is the path that puts a
              Google window on screen; /api/token is silent. Rationing it is
              what stops the popup flicker.
     The singleton below only ever deduped CONCURRENT calls, which is why a
     stream of sequential 401/403s could still produce a popup each. */
  const _reauthGate = useRef({ okAt: 0, failAt: 0, fails: 0, gisAt: 0 });
  const GIS_POPUP_MIN_GAP = 5 * 60 * 1000;

  const silentReauth = useCallback((opts = {}) => {
    const { force = false, ignoreCooldown = false } = opts;
    const g = _reauthGate.current;
    const now = Date.now();
    if (!force && !ignoreCooldown) {
      if (now - g.okAt < 30_000) return Promise.resolve(true);
      const backoff = Math.min(10 * 60_000, 30_000 * Math.pow(2, Math.max(0, g.fails - 1)));
      if (g.fails > 0 && now - g.failAt < backoff) return Promise.resolve(false);
    }
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
          if (d?.access_token) {
            // A server session for a different account than this device last
            // confirmed (e.g. a sign-out whose server call never landed): hold
            // all Drive/Contacts writes until the account check re-runs.
            let known = null; try { known = localStorage.getItem("mts-account"); } catch {}
            if (d.email && known && known.includes("@") && d.email.toLowerCase() !== known) closeAccountGate();
            saveToken(d.access_token, d.expires_in); return true;
          }
        }
      } catch { /* network — fall through to GIS */ }
      // 2) Fall back to the original GIS silent token. This is the visible one:
      //    GIS opens (and usually instantly closes) a Google window, so it is
      //    rationed. Skipping it is not a loss — the app still has whatever
      //    token it holds, and the Reconnect banner is the honest way to ask
      //    for a real sign-in.
      if (!force && Date.now() - g.gisAt < GIS_POPUP_MIN_GAP) return false;
      g.gisAt = Date.now();
      return await _gisSilentReauth();
    })();
    _reauthInFlight.current.then(
      (ok) => {
        const t = Date.now();
        if (ok) { g.okAt = t; g.fails = 0; }
        else {
          g.failAt = t; g.fails++;
          // Silent recovery has genuinely stopped working. Say so once, so the
          // Reconnect banner can offer a real sign-in — that is the honest
          // alternative to retrying forever behind the user's back.
          if (g.fails >= 3) setNeedsReconnect(true);
        }
      },
      () => { g.failAt = Date.now(); g.fails++; }
    );
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
    // Signed out on purpose: show the sign-in screen, don't sign anyone back in.
    if (explicitlySignedOut()) { setAuthBootChecked(true); return; }
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
      const ok = await silentReauth({ ignoreCooldown: true });
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
    // Deliberately NOT forced: this fires from every rejected Drive call, and
    // a burst of them must collapse into at most one refresh attempt.
    onAuthError(() => { silentReauth(); });
  }, [silentReauth]);

  // ── ACCOUNT IDENTITY / CLEAR-ON-SWITCH ────────────────────────────────────
  // Once per load, resolve which Google account this token belongs to. If it's
  // a DIFFERENT account than last time on this device, wipe local data + reload
  // so nothing bleeds across accounts (own-device usage means this effectively
  // never fires; it's a safety net). First sign-in just records the account.
  // If identity can't be resolved (offline), we do nothing and retry next load.
  const _acctChecked = useRef(false);
  const _prefsBackupStarted = useRef(false);
  // Set when a different account signs in while the previous one still has
  // unsent work on this device: { prev, next, pending }.
  const [acctConflict, setAcctConflict] = useState(null);
  useEffect(() => {
    if (!token || _acctChecked.current) return;
    _acctChecked.current = true;
    let cancelled = false, retry = null;
    const check = async () => {
      const acct = await fetchGoogleAccountId(token);
      if (cancelled) return;
      // Couldn't tell (offline / slow): Drive can't be reached either, so keep
      // the gate shut and try again shortly rather than waiting for a reload.
      if (!acct) { retry = setTimeout(check, 15000); return; }
      let prev = null;
      try { prev = localStorage.getItem("mts-account"); } catch {}
      // Only treat it as a switch on a genuine email↔email difference — a
      // destructive wipe needs unambiguous proof of a different account.
      const bothEmails = prev && prev.includes("@") && acct.includes("@");
      if (prev && prev !== acct && bothEmails) {
        const pending = await pendingLocalWork();
        if (pending.any) { setAcctConflict({ prev, next: acct, pending }); return; } // gate stays shut
        await clearLocalDataForAccountSwitch(acct); // wipes + reloads
        return;
      }
      try { localStorage.setItem("mts-account", acct); } catch {}
      openAccountGate();
      ensureMyName(token, acct).catch(() => {});
      if (!_prefsBackupStarted.current) {
        _prefsBackupStarted.current = true;
        startPrefsBackup(() => { const t = lsGet("mts-token", null); return t && t.expiry > Date.now() ? t.token : null; });
      }
    };
    check();
    return () => { cancelled = true; clearTimeout(retry); _acctChecked.current = false; };
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
      if (p.has("oauth_error")) {
        const why = p.get("oauth_error");
        setError(why === "account_not_allowed"
          ? "That Google account isn't approved for MTS Field. Sign in with an approved account."
          : "Sign-in didn't complete — try again, or use classic sign-in.");
      }
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
  const [businessDays, setBusinessDays] = useState(() => getBusinessDays(DAY_COUNT, includeWeekends));
  const [selDay, setSelDay] = useState(0);
  // Always-current ref so load(preserveDay=true) reads the real selDay
  // without needing selDay in its useCallback deps (which would cause a
  // full re-fetch every time the user switches days).
  const selDayRef = useRef(0);
  useEffect(() => { selDayRef.current = selDay; }, [selDay]);
  const [expanded, setExpanded] = useState(null);
  // Bring a card fully into view when it is OPENED — once.
  //
  // This used to be an inline `ref={el => ...scrollIntoView(...)}` on the card.
  // An inline callback ref is a new function on every render, so React re-ran
  // it on every re-render of the whole screen while a card was open, and each
  // run scheduled a smooth scroll back to that card. An open card is taller
  // than the list's visible area, so scrolling away from it was constantly
  // dragged back: the list "fought" you, and only while a card was open,
  // because a closed card never ran the code. Keying this on `expanded` means
  // it fires when the open card CHANGES and at no other time.
  useEffect(() => {
    if (!expanded) return;
    const t = setTimeout(() => {
      try {
        const sel = `[data-stop-card="${(window.CSS && CSS.escape) ? CSS.escape(expanded) : expanded}"]`;
        document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch {}
    }, 50);
    return () => clearTimeout(t);
  }, [expanded]);
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
    try {
      const r = await saveClientContact(token, card);
      setContactResult(r === "saved" ? "saved" : "updated");
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
  const phoneContactCache = useRef((() => {
    // Migrate the old key format (a bare digit string) to the prefixed one.
    // Without this, every client with a phone would look uncached on the first
    // run after the update and be re-evaluated through searchContacts — which
    // does not reliably return contacts it has not indexed, so some would be
    // created a second time. The whole point of this change is to stop making
    // duplicates, so it must not make a parting batch of them.
    const raw = lsGet("mts-phone-contact-cache-v2", {}) || {};
    const out = { ...raw };
    for (const [k, v] of Object.entries(raw)) {
      // Bare digits (oldest format) or "p:<digits>" — re-key by the last 10
      // digits so "+1 585…" and "585…" are the same client.
      const m = k.match(/^(?:p:)?(\d+)$/);
      if (m) { const k10 = `p:${phone10(m[1])}`; if (!out[k10]) out[k10] = v; }
    }
    return out;
  })());
  const persistPhoneCache = useCallback(() => {
    try { lsSet("mts-phone-contact-cache-v2", phoneContactCache.current); } catch {}
  }, []);

  /* A key that identifies this client even when there is no phone number.
     THE phone-only key is what produced the screen full of identical
     "CLIENT Shawn Beldue" entries: the cache was only ever written when
     phoneDigits was non-empty, so a client with just an email had nothing
     stopping a re-run from creating them again, and again. */
  const contactKeyFor = (card) => clientKeyFor(card);

  /* Add a client to Google Contacts — once, across every device.

     `index` is the caller's snapshot of the user's actual contact list (see
     loadContactIndex). It is the check that counts: the per-device cache below
     only remembers what THIS device did, so on its own the phone, the
     Chromebook and the laptop each added the same client once. Matching runs
     on the phone's last 10 digits, the email, or the tag this app writes on
     every contact it creates. With no index — the list couldn't be read —
     nothing is created: skipping a client until next time is harmless, a
     duplicate isn't. */
  const autoPushContact = useCallback(async (card, index) => {
    if (!token || !card) return false;
    if (!card.phone && !card.email) return false;
    const cacheKey = contactKeyFor(card);
    if (!cacheKey) return false;

    // This device already handled it (or is handling it right now).
    if (phoneContactCache.current[cacheKey]) return true;

    // Already in Google Contacts, from any device.
    const p10 = phone10(card.phone);
    const email = String(card.email || "").trim().toLowerCase();
    // Email only decides for clients with no phone: a spouse or office email
    // shared with an existing contact mustn't stop a new number getting its
    // own caller-ID contact.
    const found = index && (index.get(cacheKey) || (p10 && index.get(`p:${p10}`)) || (!p10 && email && index.get(`e:${email}`)));
    if (found) {
      phoneContactCache.current[cacheKey] = found;
      persistPhoneCache();
      return true;
    }
    if (!index) return false;   // never create blind

    // Claim the key before the network call, so an overlapping run can't also
    // create this client.
    phoneContactCache.current[cacheKey] = "pending";
    persistPhoneCache();

    const [givenName, ...rest] = (card.cn || "Unknown").split(" ");
    const familyName = rest.join(" ");
    const body = {
      // Prefix first name with CLIENT so it sorts/displays clearly in the phone app
      names: [{ givenName: `CLIENT ${givenName}`, familyName }],
      ...(card.phone ? { phoneNumbers: [{ value: card.phone, type: "mobile" }] } : {}),
      ...(card.email ? { emailAddresses: [{ value: card.email }] } : {}),
      ...(card.addr  ? { addresses: [{ formattedValue: card.addr, type: "home" }] } : {}),
      biographies: [{ value: `MTS Rochester Tree Service Client${card.jn ? ` — Job #${card.jn}` : ""}`, contentType: "TEXT_PLAIN" }],
      // Private to this app: how every device recognises this contact later.
      clientData: [{ key: CLIENT_KEY_FIELD, value: cacheKey }],
    };

    try {
      const res = await fetch("https://people.googleapis.com/v1/people:createContact", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        let rn = "created";
        try { rn = (await res.json())?.resourceName || "created"; } catch {}
        phoneContactCache.current[cacheKey] = rn;
        // Keep the snapshot current for the rest of this run.
        index.set(cacheKey, rn);
        if (p10) index.set(`p:${p10}`, rn);
        if (email) index.set(`e:${email}`, rn);
      } else {
        delete phoneContactCache.current[cacheKey];   // allow a later retry
      }
      persistPhoneCache();
      return res.ok;
    } catch {
      if (phoneContactCache.current[cacheKey] === "pending") {
        delete phoneContactCache.current[cacheKey];
        persistPhoneCache();
      }
      return false;
    }
  }, [token, persistPhoneCache]);

  // Track which stops have already been auto-pushed so we don't re-push on
  // every calendar reload. Stored by event id to survive app restarts.
  const [contactsPushed, setContactsPushed] = useState(() => lsGet("mts-contacts-pushed-v2", {}));
  useEffect(() => { lsSet("mts-contacts-pushed-v2", contactsPushed); }, [contactsPushed]);
  // A ref mirror, so the push loop reads what has been pushed AS OF NOW rather
  // than what React state held when its closure was created.
  const contactsPushedRef = useRef(contactsPushed);
  contactsPushedRef.current = contactsPushed;
  // Only one push loop may run. The effect below re-fires whenever the loaded
  // events change, which happens on every calendar reload — and a second loop
  // starting while the first was still working was the other half of the
  // duplicate-contact bug.
  const contactPushRunning = useRef(false);
  // The contact-list snapshot, reused for a few minutes: the push effect
  // re-fires on every calendar change while the week loads, and re-reading a
  // whole contact book each time burned People API quota for nothing.
  const contactIndexRef = useRef({ at: 0, index: null });
  // Stops whose contact couldn't be created this session (e.g. Google rejects
  // the data) — capped so one bad stop can't trigger endless full re-reads.
  const contactFailsRef = useRef({});

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
  // Sign out of THIS device for real: end the server session (so a reload
  // can't sign back in), drop the local token, and block automatic sign-in
  // until someone signs in on purpose. Other devices stay signed in.
  const signOutEverywhereHere = async () => {
    try { localStorage.setItem("mts-signed-out", "1"); } catch {}
    setToken(null); setNeedsReconnect(false); _acctChecked.current = false;
    try { localStorage.removeItem("mts-token"); } catch {}
    // Wait (briefly) for the server session to end, then reload so nothing of
    // this account — route, pipeline, cached Drive folders — stays in memory
    // for whoever signs in next.
    try {
      await Promise.race([
        fetch("/api/logout", { method: "POST", credentials: "same-origin" }),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    } catch {}
    try { location.reload(); } catch {}
  };

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
  // Which load is current. A newer load bumps it, and an older background
  // fill that sees a different number stops.
  const loadGenRef = useRef(0);
  const load = useCallback(async (preserveDay = false) => {
    // Use the freshest token available. A background silent-reauth may have
    // written a newer token to localStorage than the one captured in this
    // callback's closure; using the stale closure token would 401 needlessly
    // (and, when the closure token is the DEAD one, keep failing every retry).
    const savedTok = lsGet("mts-token", null);
    const tok = (savedTok?.token && savedTok.expiry > Date.now()) ? savedTok.token : token;
    if (!tok) return;
    // Claim this load as the current one BEFORE any await, so an older load
    // that is still waiting on the network can never overtake a newer one.
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const days = getBusinessDays(DAY_COUNT, includeWeekendsRef.current);
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
      // A newer load started while this one was fetching — let it win.
      if (loadGenRef.current !== gen) return;
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

      // PHASE 2: Background-fill remaining days.
      //
      // Two things keep this from making the app feel frozen:
      //  • A newer load cancels an older one. Toggling weekends, or a sync,
      //    used to start a fresh 30-day fill while the previous one was still
      //    running, so two (or three) loops fought over the same state.
      //  • Results are applied in small batches, not one day at a time. Each
      //    application re-renders the whole app; thirty of them back to back
      //    is what made the settings sheet and route list stutter.
      const remaining = days.slice(1);
      (async () => {
        let pending = [];   // [{ dk, events, localStops }]
        let flushedOnce = false;
        const flush = () => {
          if (!pending.length || loadGenRef.current !== gen) { pending = []; return; }
          const batch = pending; pending = [];
          setRawEvents(prev => {
            const next = { ...prev };
            for (const { dk, events, localStops } of batch) {
              next[dk] = events;
              for (const [id, { event, dk: ldk }] of Object.entries(localStops)) {
                if (ldk === dk)
                  next[dk] = [...(next[dk] || []).filter(e => e.id !== id && e.id !== event.id), event];
              }
            }
            return next;
          });
        };
        for (const day of remaining) {
          if (loadGenRef.current !== gen) return;   // superseded by a newer load
          try {
            const s = new Date(day); s.setHours(0,0,0,0);
            const e = new Date(day); e.setHours(23,59,59,999);
            const events = await authedFetchEvents(tok, s, e);
            if (loadGenRef.current !== gen) return;
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
            pending.push({ dk: day.toDateString(), events, localStops: localStops2 });
            // The first batch goes out after two days, so tomorrow — the day
            // most often checked right after opening — appears as fast as before.
            if (pending.length >= (flushedOnce ? 6 : 2)) { flush(); flushedOnce = true; }
          } catch(err) {
            console.warn("Background load failed for", day.toDateString(), err);
          }
        }
        flush();
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
      // A superseded load's failure is stale news — the newer load owns the
      // screen now, so don't paint its error over that.
      if (loadGenRef.current !== gen) return;
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
  // One-time tidy-up of the old download-record key (see REMOTE_SEEN_KEY):
  // move it, then delete the bogus "remote-seen" visit it was mistaken for.
  useEffect(() => {
    try {
      if (localStorage.getItem(REMOTE_SEEN_KEY) == null) saveRemoteSeen(loadRemoteSeen());
      if (localStorage.getItem("mts-field-remote-seen") != null) deleteField("remote-seen").catch(() => {});
    } catch {}
  }, []);
  const _pullRunning = useRef(false);
  const pullFromDrive = useCallback(async (force = false) => {
    if (!token) return;
    // One pull at a time. Every visibility change and the 5-minute timer used
    // to start another full pull alongside any still running.
    if (_pullRunning.current) return;
    _pullRunning.current = true;
    const _pt = Date.now();
    flog("bg: Drive sync started", force ? "full" : "");
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
      const seen = loadRemoteSeen();
      let seenChanged = false;
      let downloads = 0;
      // Which visits exist on this device — one key-only read, instead of
      // loading every visit record in full (1,400+ of them, photos included)
      // on every pull just to see whether it's empty.
      const localIds = new Set(await listFieldIds().catch(() => []));
      for (const f of (files || [])) {
        const id = f.name.replace(/\.json$/, "");
        const localEmpty = !localIds.has(id);
        const remoteTs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
        const lastSeen = seen[id] || 0;
        // Pull when forced (manual sync / reconcile), when we have no local
        // copy, or when Drive's file changed since the last time we pulled it.
        // MERGE photo/audio/video arrays by key (union) rather than overwriting
        // — photos captured locally that haven't synced yet must never be
        // erased by a stale Drive snapshot.
        // A visit this device has never had, untouched for 60+ days: don't
        // fetch it now — opening its card fetches it. On a fresh install this
        // is the difference between downloading every visit ever (1,400+,
        // minutes of a frozen phone) and just the recent ones.
        if (!force && localEmpty && remoteTs && Date.now() - remoteTs > 60 * 86400e3) continue;
        if (force || localEmpty || remoteTs > lastSeen) {
          // Stay out of the camera's way, and give the screen a breath
          // between downloads so the app never locks up during a big pull.
          while (window.__mtsCameraOpen) await new Promise(r => setTimeout(r, 1000));
          if (++downloads % 5 === 0) await new Promise(r => setTimeout(r, 60));
          // Save progress as it goes: an interrupted pull used to lose all of
          // it and start from scratch next launch.
          if (downloads % 20 === 0 && seenChanged) saveRemoteSeen(seen);
          const data = await loadFieldFromDrive(token, id);
          if (data) {
            await updateField(id, (existing) => {
              const ex = existing || {};
              // Union-merge photo arrays by ts/url so neither side loses items.
              // Union pins by id. On collision prefer whichever side the user
              // actually dragged into place; otherwise defer to the newer side.
              const unionPins = (a = [], b = [], preferB) => {
                const m = new Map();
                for (const p of (a || [])) if (p?.id) m.set(p.id, p);
                for (const p of (b || [])) {
                  if (!p?.id) continue;
                  const prev = m.get(p.id);
                  if (!prev) { m.set(p.id, p); continue; }
                  if (!!p.adjusted !== !!prev.adjusted) m.set(p.id, p.adjusted ? p : prev);
                  else m.set(p.id, preferB ? p : prev);
                }
                return [...m.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
              };
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
              // Every other field (job tags, line items, iPhone video log,
              // client name/job #, anything added later) comes from the newer
              // side, falling back to whichever side has it — previously only
              // the fields listed below were ever copied down, so the rest
              // never reached a second device.
              const others = {};
              for (const k of new Set([...Object.keys(ex), ...Object.keys(data)])) {
                if (k === "savedAt" || k.startsWith("_")) continue;
                others[k] = cloudNewer ? (data[k] ?? ex[k]) : (ex[k] ?? data[k]);
              }
              return {
                ...others,
                savedAt: Math.max(ex.savedAt || 0, data.savedAt || 0) || Date.now(),
                iphoneVideoLog: unionByKey(ex.iphoneVideoLog || [], data.iphoneVideoLog || [], e => e?.ts),
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
                // Map pins were missing from this list, so a device that had
                // none of its own (a laptop) never received the ones captured
                // on the phone — the pins reached Drive but the merge dropped
                // them on the way back down. Union by pin id, and let a
                // hand-corrected position win over a raw GPS one.
                mapPins: unionPins(ex.mapPins, data.mapPins, cloudNewer),
              };
            }).catch(() => {});
            // Record the modifiedTime we just pulled so we don't re-download
            // this file until Drive changes it again.
            if (remoteTs) { seen[id] = remoteTs; seenChanged = true; }
          }
        }
      }
      if (seenChanged) saveRemoteSeen(seen);
      setLastSyncTime(Date.now());
      window.dispatchEvent(new CustomEvent("mts-field-synced"));
    } catch(e) { console.warn("Pull failed:", e); flog("bg: Drive sync failed", e?.message); }
    finally {
      flog("bg: Drive sync finished", `${Date.now() - _pt}ms`);
      _pullRunning.current = false;
      if (_pullWatchdog.current) { clearTimeout(_pullWatchdog.current); _pullWatchdog.current = null; }
      setSyncPulling(false);
    }
  }, [token]);

  // (The one-time "re-pull everything, re-upload everything" reconcile that
  // lived here is gone. Its last run — added to pick up visits filed in a
  // duplicate Drive folder — re-uploaded every record with its photos, which
  // made the phone sluggish (camera included) and restarted from scratch if
  // interrupted. It isn't needed: a fresh install pulls every visit because
  // it has none locally, the regular pull fetches anything newer from any
  // folder, and edits made offline are flushed by the dirty-field retry.)

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
      if (!s.isTask || contactsPushedRef.current[s.id] || !(s.phone || s.email)) return false;
      if ((contactFailsRef.current[s.id] || 0) >= 3) return false;
      if (seen.has(s.id)) return false; // same event can appear across day buckets
      seen.add(s.id);
      return true;
    });
    if (unpushed.length === 0) return;
    if (contactPushRunning.current) return;
    contactPushRunning.current = true;
    let dead = false;
    let pushedAny = false;
    (async () => {
      try {
        // Read the actual contact list once for this run. If it can't be read,
        // stop here — this run would otherwise be guessing.
        // Stops this device has already matched need no list at all.
        // Recorded immediately (ref + storage) so a reload never redoes work,
        // but React state is updated once at the end: setting it per contact
        // re-rendered the whole app after every one — 100+ full re-renders on
        // the first open of a day, while the camera was in use.
        const markPushed = (id) => {
          const next = { ...contactsPushedRef.current, [id]: Date.now() };
          contactsPushedRef.current = next;
          lsSet("mts-contacts-pushed-v2", next);
          pushedAny = true;
        };
        const rest = [];
        for (const stop of unpushed) {
          const k = contactKeyFor(stop);
          if (k && phoneContactCache.current[k] && phoneContactCache.current[k] !== "pending") markPushed(stop.id);
          else rest.push(stop);
        }
        if (!rest.length) return;
        flog("bg: contacts job started", `${rest.length} to check`);
        let index;
        const cached = contactIndexRef.current;
        if (cached.index && Date.now() - cached.at < 10 * 60 * 1000) index = cached.index;
        else {
          try { index = await loadContactIndex(token); contactIndexRef.current = { at: Date.now(), index }; }
          catch (e) { console.warn("Contacts: couldn't read the contact list; skipping this run", e); return; }
        }
        for (const stop of rest) {
          if (dead) return;
          while (window.__mtsCameraOpen && !dead) await new Promise(r => setTimeout(r, 1000));
          // Re-check against the live record: an earlier iteration, or a run
          // that was interrupted, may already have handled this stop.
          if (contactsPushedRef.current[stop.id]) continue;
          const ok = await autoPushContact(stop, index);
          // Recorded NOW, not after the whole loop: a reload partway through
          // used to throw away the progress and push the same clients again.
          if (ok) markPushed(stop.id);
          else {
            contactFailsRef.current[stop.id] = (contactFailsRef.current[stop.id] || 0) + 1;
            contactIndexRef.current = { at: 0, index: null };   // re-read next time
          }
          await new Promise(r => setTimeout(r, 400));
        }
      } finally {
        flog("bg: contacts job finished");
        contactPushRunning.current = false;
        if (pushedAny) setContactsPushed(contactsPushedRef.current);
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
  const [photoUploadsOpen, setPhotoUploadsOpen] = useState(false);
  const [driveCleanupOpen, setDriveCleanupOpen] = useState(false);
  const [accountCheckOpen, setAccountCheckOpen] = useState(false);
  const [mediaRecoverOpen, setMediaRecoverOpen] = useState(false);
  const [freezeReportText, setFreezeReportText] = useState(null);
  // Freeze report: note when the whole app is redrawing unusually often.
  const _renders = useRef(0);
  _renders.current++;
  useEffect(() => {
    const iv = setInterval(() => {
      if (_renders.current > 25) flog("app: busy redrawing", `${_renders.current} redraws in 5s`);
      _renders.current = 0;
    }, 5000);
    return () => clearInterval(iv);
  }, []);
  const [, setMyNameTick] = useState(0);   // re-render after the name is edited
  const [contactCleanupOpen, setContactCleanupOpen] = useState(false);
  const [realworkSetupOpen, setRealworkSetupOpen] = useState(false);
  const [iphoneSetupOpen, setIphoneSetupOpen] = useState(false);
  // How many stops still have photos waiting for Drive. Surfaced on the
  // settings button itself: the previous answer lived only in a debug panel
  // behind a five-tap gesture, which is how four stops sat wedged for days
  // without anything ever saying so.
  const [photoQueueCount, setPhotoQueueCount] = useState(0);
  useEffect(() => {
    const read = () => {
      try { setPhotoQueueCount(JSON.parse(localStorage.getItem("mts-photo-queue") || "[]").length); }
      catch { setPhotoQueueCount(0); }
    };
    read();
    const iv = setInterval(read, 15000);
    window.addEventListener("mts-field-synced", read);
    return () => { clearInterval(iv); window.removeEventListener("mts-field-synced", read); };
  }, []);
  const [debugOpen, setDebugOpen] = useState(false);
  // The next-stop screen (8-second countdown + Navigate). Unchanged in behaviour.
  // The one addition: if the app was closed by iOS while you were away in
  // RealWork, it is restored on relaunch (within 20 minutes) so the next stop is
  // still waiting instead of being lost.
  const [nextStopCard, setNextStopCard] = useState(() => {
    try {
      const pend = lsGet("mts-pending-next", null);
      if (pend?.next && Date.now() - (pend.ts || 0) < 20 * 60 * 1000) return pend.next;
    } catch {}
    return null;
  });
  useEffect(() => { try { localStorage.removeItem("mts-pending-next"); } catch {} }, []);
  // Shown between Done and the next-stop screen: pick a photo / open RealWork.
  const [handoff, setHandoff] = useState(null); // { stopId, cn, next }
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
  const markDone = (id, opts = {}) => {
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
    let nextInfo = null;
    if (activeTasks.length > 0) {
      const doneCount = allTasks.filter(s => dismissed[s.id] || s.id === id).length;
      nextInfo = {
        stop: activeTasks[0],
        stopNumber: doneCount + 1,
        totalStops: allTasks.length,
      };
    }
    if (stop?.isTask) {
      // The visit is saved and filed above, so it is safe to leave the app from
      // here. Park the next stop first: if iOS closes the app while you are in
      // RealWork, it comes back on relaunch.
      if (nextInfo) {
        try {
          lsSet("mts-pending-next", {
            ts: Date.now(),
            next: { ...nextInfo, stop: { id: nextInfo.stop.id, cn: nextInfo.stop.cn, addr: nextInfo.stop.addr } },
          });
        } catch {}
      }
      // sendClip: a promise that the visit's first photo is on the clipboard,
      // when "Send to RealWork" is on. The hand-off then skips its picker.
      setHandoff({ stopId: id, cn: stop.cn, next: nextInfo, sendClip: opts.sendClip || null });
    } else if (nextInfo) {
      setNextStopCard(nextInfo);
    }
    // Contacts auto-save on calendar import — no prompt needed.
  };
  // Leaving the RealWork step — by picking, skipping, or coming back — hands
  // over to the existing next-stop screen, whose countdown starts fresh now.
  const handoffRef = useRef(null);
  handoffRef.current = handoff;
  const releaseHandoff = useCallback(() => {
    const h = handoffRef.current;
    if (!h) return;
    handoffRef.current = null;
    setHandoff(null);
    try { localStorage.removeItem("mts-pending-next"); } catch {}
    if (h.next) setNextStopCard(h.next);
  }, []);

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
    openDirections(addr);
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
    openDirections(addrs);   // starts from the phone's current location
  }, [mapStops]);
  const hasStopsWithAddr = mapStops.some(s => s.addr);

  // With a long day list, plain dates get hard to scan — call out today and
  // tomorrow by name, and mark the start of each new week so the list reads
  // clearly when scrolling a month out.
  // Memoized: toLocaleDateString for 30 days on every App render was a real
  // cost — the App re-renders constantly during a sync, camera open or not.
  // Hot-card count for the Pipeline tab. Was computed during EVERY render by
  // parsing the whole 1,400-card pipeline from storage; now refreshed on a
  // timer and when the view changes.
  const [hotCount, setHotCount] = useState(0);
  useEffect(() => {
    const read = () => {
      try {
        const pl = JSON.parse(localStorage.getItem("mts-pipeline") || "{}");
        setHotCount(Object.values(pl).filter(c => c.hot && c.stage !== "declined" && c.stage !== "sold").length);
      } catch {}
    };
    read();
    const iv = setInterval(read, 30000);
    return () => clearInterval(iv);
  }, [view]);

  const dayLabels = useMemo(() => businessDays.map((d, i) => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const base = d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
    if (d.toDateString() === today.toDateString()) return `${base} ★ TODAY`;
    if (d.toDateString() === tomorrow.toDateString()) return `${base} · TOMORROW`;
    // Monday (or the first entry of a new week) gets a subtle week marker.
    const prev = businessDays[i - 1];
    const newWeek = prev && d.getDay() < prev.getDay();
    return newWeek ? `— ${base}` : base;
  }), [businessDays]);

  // Flips the weekend opt-in, persists it, and reloads the day list/events
  // from scratch — the day-index meanings shift once weekends are added to
  // or removed from the sequence, so a partial patch isn't safe here.
  const toggleIncludeWeekends = () => {
    const next = !includeWeekends;
    setIncludeWeekends(next);
    includeWeekendsRef.current = next;
    lsSet("mts-include-weekends", next);
    setSelDay(0);
    setBusinessDays(getBusinessDays(DAY_COUNT, next));
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
    <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0b10",color:"#707c9a",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:600,letterSpacing:1}}>Signing in…</div></div>
    </div>
  );

  if (!token) return (
    <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0a0b10",fontFamily:"'Oswald','DM Sans',system-ui,sans-serif",color:"#f0f4fa",padding:20,paddingTop:"max(20px,var(--safe-top))",boxSizing:"border-box"}}>
      <div style={{fontSize:28,fontWeight:900,letterSpacing:3,textTransform:"uppercase",fontFamily:"'Oswald',sans-serif"}}>MTS FIELD SALES</div>
      <div style={{fontSize:12,color:"#707c9a",marginBottom:32,fontWeight:500,letterSpacing:1}}>Monster Tree Service of Rochester</div>
      <button onClick={serverSignIn} style={{padding:"16px 40px",borderRadius:12,background:"#1a2035",border:"1px solid #2a3560",color:"#f0f4fa",fontSize:16,fontWeight:700,cursor:"pointer",letterSpacing:.5}}>Sign in with Google</button>
      {/* Fallback: the original popup sign-in, in case the redirect flow ever
          has trouble — so a backend hiccup can never lock you out. */}
      <button onClick={initAuth} style={{marginTop:14,padding:"8px 16px",borderRadius:8,background:"transparent",border:"none",color:"#707c9a",fontSize:12,fontWeight:600,cursor:"pointer",letterSpacing:.3,textDecoration:"underline"}}>Trouble signing in? Use classic sign-in</button>
      {error && <div style={{marginTop:16,color:"#ff5555",fontSize:12}}>{error}</div>}
    </div>
  );

  if (loading && !Object.keys(rawEvents).length) return (
    <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#0a0b10",color:"#707c9a",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:700}}>Loading...</div></div>
    </div>
  );

  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div style={{position:"fixed",inset:0,background:"#0a0b10",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',system-ui,sans-serif",color:"#f0f4fa",overflow:"hidden",paddingTop:"var(--safe-top)",boxSizing:"border-box"}}>
      {/* Reconnect bar — shown when a silent token refresh failed but we still
          have local data. Keeps the app usable and offers ONE interactive
          re-auth instead of bouncing to the sign-in screen in a loop. */}
      {needsReconnect && (
        <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"rgba(246,191,38,.16)",borderBottom:"1px solid rgba(246,191,38,.4)"}}>
          <span style={{flex:1,fontSize:12.5,color:"#F6BF26",fontWeight:700}}>{Object.keys(rawEvents).length === 0 ? "Can't reach Google — reconnect to load your stops." : "Google session expired — reconnect to sync."}</span>
          <button onClick={async () => {
            // Fast path first: a silent reauth often succeeds without the full
            // sign-in redirect. Only if that fails do we bounce to serverSignIn.
            const ok = await silentReauth({ force: true });
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
          <button onClick={async () => { const ok = await silentReauth({ force: true }); await new Promise(r=>setTimeout(r,200)); load(true); if(!ok) setNeedsReconnect(true); }} style={{padding:"6px 14px",borderRadius:8,background:"rgba(255,85,85,.2)",border:"1px solid rgba(255,85,85,.5)",color:"#ff8080",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>Retry Now</button>
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
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
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
          <button onClick={()=>setView("route")} style={{padding:"5px 12px",borderRadius:8,background:view==="route"?"#1a2035":"transparent",border:"none",cursor:"pointer",fontFamily:"'Oswald',sans-serif",fontWeight:700,fontSize:12,letterSpacing:1.5,textTransform:"uppercase",color:view==="route"?"#f0f4fa":"#607591",transition:"all .15s"}}>Route</button>
          <button onClick={()=>setView("pipeline")} style={{padding:"5px 12px",borderRadius:8,background:view==="pipeline"?"#1a2035":"transparent",border:"none",cursor:"pointer",fontFamily:"'Oswald',sans-serif",fontWeight:700,fontSize:12,letterSpacing:1.5,textTransform:"uppercase",color:view==="pipeline"?"#10B981":"#607591",transition:"all .15s",display:"flex",alignItems:"center",gap:4}}>
            Pipeline
            {hotCount > 0 && <span style={{fontSize:9,padding:"1px 5px",borderRadius:999,background:"rgba(255,179,0,.2)",color:"#FFB300",fontWeight:800}}>{hotCount}🔥</span>}
          </button>
        </div>
        {token && <button onClick={async () => {
            // If we're in an error state — OR the route never loaded — refresh
            // the token first, then re-fetch stops. Tapping this button when the
            // route is empty is a natural recovery instinct, so make it actually
            // recover: a stops-load, not just a Drive field sync.
            const routeEmpty = Object.keys(rawEvents).length === 0;
            if (syncIndicator === "error" || syncIndicator === "auth-error" || routeEmpty) {
              await silentReauth({ force: true });
              // Give the new token a moment to settle in localStorage
              await new Promise(r => setTimeout(r, 300));
            }
            if (routeEmpty) { setNeedsReconnect(false); load(true); }
            // Pull everything (force, ignoring the seen-map), union-merging
            // Drive into local, then send up whatever this device hasn't
            // synced yet. (It used to re-upload EVERY visit with its photos,
            // which tied the phone up for minutes after a tap.)
            triggerCloudSync(true);
            await pullFromDrive(true);
            await flushDirtyFields();
          }}
          title={syncPulling ? "Syncing…" : (syncIndicator==="error"||syncIndicator==="auth-error") ? "Sync error — tap to retry" : "Tap to force full sync"}
          style={{background:"none",border:"none",cursor:"pointer",padding:"2px 6px",display:"flex",alignItems:"center",gap:3}}>
          {(syncIndicator==="error"||syncIndicator==="auth-error") ? <IconCloudOff size={13} color="#FF5555"/> : (syncIndicator==="syncing"||syncPulling) ? <IconCloud size={13} color="#F6BF26"/> : <IconCloud size={13} color="#10B981"/>}
          {/* data-synctick references syncTick (updated every minute) so the
              "Xm ago" label re-renders and stays current between syncs. */}
          {lastSyncTime>0 && <span data-synctick={syncTick} style={{fontSize:9,color:(syncIndicator==="syncing"||syncPulling)?"#F6BF26":"#527187",fontFamily:"'Oswald',sans-serif"}}>{(syncIndicator==="syncing"||syncPulling)?"syncing…":Math.floor((Date.now()-lastSyncTime)/60000)<1?"now":`${Math.floor((Date.now()-lastSyncTime)/60000)}m`}</span>}
        </button>}
        <div style={{flex:1}} onClick={handleDebugTap}/>
        {view === "route" && <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={()=>setSearchOpen(true)} title="Search everything" style={{padding:"5px 7px",borderRadius:8,background:"transparent",border:"1px solid #2a3560",color:"#526887",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <IconSearch size={14} color="#526887" />
          </button>
          <select value={selDay} onChange={e=>{setSelDay(Number(e.target.value));setExpanded(null);setReorderMode(false);setMoving(null);}} style={{padding:"5px 10px",borderRadius:8,border:"1px solid #2a3560",background:"#0a0b10",color:"#f0f4fa",fontSize:11,fontWeight:600,cursor:"pointer",outline:"none",appearance:"auto",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>
            {dayLabels.map((l,i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </div>}
        {view === "pipeline" && <button onClick={()=>setSearchOpen(true)} title="Search everything" style={{padding:"5px 7px",borderRadius:8,background:"transparent",border:"1px solid #2a3560",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <IconSearch size={14} color="#526887" />
        </button>}
        {view === "pipeline" && pipelineSelectMode && pipelineSelectedCount > 0 && (
          <button onClick={()=>setPipelineBulkEmailTick(t=>t+1)} style={{padding:"5px 10px",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
            Email {pipelineSelectedCount}
          </button>
        )}
        {view === "pipeline" && (
          <button onClick={()=>{setPipelineSelectMode(s=>!s);setPipelineSelectedCount(0);}} style={{padding:"5px 10px",borderRadius:8,background:pipelineSelectMode?"rgba(59,130,246,.15)":"transparent",border:`1px solid ${pipelineSelectMode?"rgba(59,130,246,.3)":"#2a3560"}`,color:pipelineSelectMode?"#3B82F6":"#607591",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
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
            <button onClick={()=>setMoving(null)} style={{marginLeft:"auto",padding:"3px 10px",borderRadius:6,background:"#1a2035",border:"none",color:"#9eb3c8",fontSize:10,fontWeight:700,cursor:"pointer"}}>Cancel</button>
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
        {active.length === 0 && <div style={{padding:40,textAlign:"center",color:"#424b7e",fontSize:14,fontWeight:600}}>No stops</div>}

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
              data-stop-card={s.id}
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
                  {s.addr && <div style={{fontSize:12,color:"#a4aebe",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:2,fontWeight:500,letterSpacing:1,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase"}}>{s.addr}</div>}
                </div>
                {s.isTask && s.window && <span style={{padding:"3px 8px",borderRadius:6,fontSize:11,fontWeight:900,color:isAM?"#66BB6A":"#64B5F6",background:winBg,border:`1px solid ${winColor}40`,flexShrink:0,letterSpacing:1,fontFamily:"'Oswald',sans-serif",textTransform:"uppercase"}}>{s.window}</span>}
                {s.isTask && s.db && <span style={{padding:"3px 6px",borderRadius:6,fontSize:10,fontWeight:900,color:"#FFD54F",background:"rgba(255,213,79,.12)",border:"1px solid rgba(255,213,79,.3)",flexShrink:0,letterSpacing:1,fontFamily:"'Oswald',sans-serif"}}>DB</span>}
                {!s.isTask && s.timeLabel && <span style={{padding:"3px 8px",borderRadius:6,fontSize:10,fontWeight:700,color:"#a79bc8",background:"rgba(100,80,160,.1)",border:"1px solid rgba(100,80,160,.2)",flexShrink:0}}>{s.timeLabel}</span>}
                {!reorderMode && s.phone && <a href={`tel:${s.phone.replace(/\D/g,"")}`} onClick={e=>{e.stopPropagation();markContact(s.id,"call");}} style={{padding:"5px 10px",borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#9eb3c8",fontSize:12,textDecoration:"none",fontWeight:700,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}><IconPhone size={13} color="#9eb3c8"/></a>}
              </div>

              {s.constraint && <div style={{marginTop:6,marginLeft:isNext?50:44,padding:"4px 10px",borderRadius:6,background:"rgba(255,80,160,.12)",border:"1px solid rgba(255,80,160,.25)",color:"#FF80AB",fontSize:12,fontWeight:800,display:"inline-block",letterSpacing:0.3,fontFamily:"'Oswald','DM Sans',sans-serif",textTransform:"uppercase"}}>{s.constraint}</div>}

              {s.titleContext && !reorderMode && <div style={{marginTop:4,marginLeft:isNext?50:44,fontSize:12,color:"#b8bfce",lineHeight:1.5,fontStyle:"italic",fontWeight:500}}>{s.titleContext}</div>}

              {isExp && <div onClick={e=>e.stopPropagation()} style={{marginTop:12,marginLeft:isNext?50:44,paddingTop:12,borderTop:"1px solid #1a2030"}}>
                {lastContact[s.id] && (() => {
                  const lc = lastContact[s.id];
                  const mins = Math.floor((Date.now() - lc.at) / 60000);
                  const label = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;
                  const kindLabel = lc.kind === "sms" ? "Texted" : lc.kind === "call" ? "Called" : lc.kind === "email" ? "Emailed" : "Contacted";
                  return <div style={{fontSize:11,color:"#64B5F6",marginBottom:8,fontWeight:600,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>{kindLabel} · {label}</div>;
                })()}
                {s.notes && <div style={{fontSize:13,color:"#abbac8",lineHeight:1.6,marginBottom:10,fontWeight:500}}><Linkify text={s.notes} linkColor="#7BB3FF"/></div>}
                {s.phone && <div style={{fontSize:13,color:"#aac0d5",marginBottom:3,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconPhone size={13} color="#aac0d5"/>{s.phone}</div>}
                {s.email && <div style={{fontSize:13,color:"#aac0d5",marginBottom:8,fontWeight:600,display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#aac0d5"/>{s.email}</div>}
                {declineConfirm === s.id ? (
                  <button onClick={()=>decline(s.id)} style={{width:"100%",padding:"11px 0",marginTop:4,borderRadius:8,background:"rgba(200,60,60,.15)",border:"1px solid rgba(200,60,60,.3)",color:"#FF5555",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",animation:"pulse 1s infinite",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconX size={14} color="#FF5555"/>CONFIRM DECLINE?</button>
                ) : rejectConfirm === s.id ? (
                  <button onClick={()=>markReject(s.id)} style={{width:"100%",padding:"11px 0",marginTop:4,borderRadius:8,background:"rgba(255,140,0,.15)",border:"1px solid rgba(255,140,0,.4)",color:"#FF8C00",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",textTransform:"uppercase",animation:"pulse 1s infinite",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconNoSymbol size={14} color="#FF8C00"/>CONFIRM REJECT?</button>
                ) : (
                  <div style={{display:"flex",gap:6,marginTop:4}}>
                    {s.phone && <button onClick={()=>{setTextSheet(s);setOtwMinutes(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconMessageSquare size={16} color="#aac0d5"/></button>}
                    {s.notes && <button onClick={()=>speakStop(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:ttsSpeaking?"rgba(100,80,200,.18)":"rgba(100,80,200,.08)",border:"1px solid rgba(100,80,200,.2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{ttsSpeaking ? <IconX size={16} color="#9a91c9"/> : <IconVolume2 size={16} color="#9a91c9"/>}</button>}
                    <button onClick={()=>openOnsite(s)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconClipboard size={16} color="#10B981"/></button>
                    <button onClick={()=>setMovePicker(movePicker?.stopId === s.id ? null : { stopId: s.id })} title="Move to another day" style={{flex:1,padding:"10px 0",borderRadius:8,background:movePicker?.stopId===s.id?"rgba(246,191,38,.18)":"rgba(246,191,38,.06)",border:`1px solid ${movePicker?.stopId===s.id?"rgba(246,191,38,.4)":"rgba(246,191,38,.15)"}`,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconCalendar size={16} color="#F6BF26"/></button>
                    <button onClick={()=>{setDeclineConfirm(s.id);setRejectConfirm(null);}} style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(200,60,60,.06)",border:"1px solid rgba(200,60,60,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={16} color="#af7979"/></button>
                    <button onClick={()=>{setRejectConfirm(s.id);setDeclineConfirm(null);}} title="Flag: reject in SingleOps" style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(255,140,0,.06)",border:"1px solid rgba(255,140,0,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconNoSymbol size={16} color="#a07030"/></button>
                    {!s.isTask && <button onClick={()=>deleteStop(s.id)} title="Delete permanently" style={{flex:1,padding:"10px 0",borderRadius:8,background:"rgba(100,100,100,.06)",border:"1px solid rgba(100,100,100,.15)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconTrash size={16} color="#607591"/></button>}
                  </div>
                )}
                {/* Day picker popover — shown beneath action row when active */}
                {movePicker?.stopId === s.id && (
                  <div style={{marginTop:8,padding:10,borderRadius:8,background:"#0a0c14",border:"1px solid rgba(246,191,38,.25)"}}>
                    <div style={{fontSize:9,color:"#F6BF26",fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",marginBottom:8}}>Move to which day?</div>
                    {/* Scrollable: the day list now runs a month out, which would
                        otherwise stretch this card far down the screen. */}
                    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,maxHeight:240,overflowY:"auto"}}>
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
                              color: isCurrent ? "#526887" : "#F6BF26",
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
                    <button onClick={() => setMovePicker(null)} style={{width:"100%",marginTop:8,padding:"6px 0",borderRadius:6,background:"transparent",border:"1px solid #1a2030",color:"#707c9a",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase"}}>Cancel</button>
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
            <button onClick={()=>{setRouteSearchOpen(false);setRouteSearch("");}} style={{padding:"6px 8px",borderRadius:6,background:"transparent",border:"none",color:"#607591",fontSize:12,cursor:"pointer"}}><IconX size={13} color="#607591"/></button>
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
                <div style={{fontSize:13,color:"#818da2",textDecoration:"line-through",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.cn}</div>
                {s.addr && <div style={{fontSize:10,color:"#526187",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{s.addr}</div>}
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
        <button onClick={()=>setSettingsOpen(true)} title={photoQueueCount>0?`Settings — ${photoQueueCount} stop(s) with photos still uploading`:"Settings & tools"}
          style={{position:"relative",width:34,height:34,borderRadius:8,background:"#1a2035",border:"1px solid #252d47",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#8aa0c0" strokeWidth={2} strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          {photoQueueCount>0 && <span style={{position:"absolute",top:-3,right:-3,minWidth:15,height:15,padding:"0 3px",borderRadius:8,background:"#F6BF26",color:"#1a1400",fontSize:9.5,fontWeight:800,fontFamily:"'Oswald',sans-serif",display:"flex",alignItems:"center",justifyContent:"center",border:"1.5px solid #080a10"}}>{photoQueueCount}</span>}
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
            <span style={{fontSize:11,fontWeight:700,fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",color:reorderMode?"#c8a0e8":"#717fa6"}}>{reorderMode?"DONE":"REORDER"}</span>
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
          onClick={()=>{ if(signOutConfirm){ signOutEverywhereHere(); setSignOutConfirm(false);} else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }}
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
        const Row = SettingsRow;
        return (
          <div onClick={()=>setSettingsOpen(false)} style={{position:"fixed",inset:0,zIndex:350,background:"rgba(0,0,0,.55)",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",borderTop:"1px solid #1a2030",borderTopLeftRadius:18,borderTopRightRadius:18,padding:"8px 16px",paddingBottom:"max(16px,env(safe-area-inset-bottom))",boxShadow:"0 -14px 44px rgba(0,0,0,.55)",maxHeight:"74dvh",overflowY:"auto",WebkitOverflowScrolling:"touch",overscrollBehavior:"contain"}}>
              <div style={{width:42,height:4,borderRadius:2,background:"#2a3550",margin:"4px auto 12px"}}/>
              <div style={{fontSize:11,fontWeight:800,color:"#607591",letterSpacing:1.2,textTransform:"uppercase",fontFamily:"'Oswald',sans-serif",margin:"0 6px 6px"}}>Settings &amp; Tools</div>
              <Row accent="#10B981"
                icon={<IconCheckCircle size={17} color="#10B981"/>}
                label="Account & connection check"
                sub="Test sign-in, Calendar, Drive and Contacts for this account"
                onClick={()=>{ setAccountCheckOpen(true); setSettingsOpen(false); }} />
              <Row accent="#FF8A80"
                icon={<IconClipboard size={17} color="#FF8A80"/>}
                label="Copy freeze report"
                sub="After a freeze: reopen the app, tap this, paste it to support"
                onClick={()=>{
                  const txt = freezeReport();
                  try { navigator.clipboard?.writeText(txt).catch(() => {}); } catch {}
                  setFreezeReportText(txt); setSettingsOpen(false);
                }} />
              <Row accent="#F6BF26"
                icon={<IconImage size={17} color="#F6BF26"/>}
                label="Recover photos & videos"
                sub="Find a card's photos and videos in your Drive and put them back"
                onClick={()=>{ setMediaRecoverOpen(true); setSettingsOpen(false); }} />
              <Row accent="#5a8ab0"
                icon={<IconRefresh size={17} color="#9aadc8" style={{animation:loading?"spin 1s linear infinite":undefined}}/>}
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
              <Row accent={photoQueueCount>0?"#F6BF26":"#5a8ab0"}
                icon={<IconImage size={17} color={photoQueueCount>0?"#F6BF26":"#8aa0c0"}/>}
                label="Photo uploads"
                sub={photoQueueCount>0
                  ? `${photoQueueCount} stop${photoQueueCount===1?"":"s"} still waiting — tap to see why`
                  : "All photos on this device have reached Drive"}
                onClick={()=>{ setPhotoUploadsOpen(true); setSettingsOpen(false); }} />
              <Row accent="#F6BF26"
                icon={<IconTrash size={17} color="#F6BF26"/>}
                label="Free up Drive space"
                sub="Remove duplicate photos this app left in Drive"
                onClick={()=>{ setDriveCleanupOpen(true); setSettingsOpen(false); }} />
              <Row accent="#B39DDB"
                icon={<IconEdit size={17} color="#B39DDB"/>}
                label={`Your name: ${getMyName() || "not set"}`}
                sub="Used in “on my way” texts and follow-up emails to customers"
                onClick={()=>{ const n = window.prompt("Your first name, as customers should see it in texts and emails:", getMyName()); if (n != null) { setMyName(n); setMyNameTick(t => t + 1); } }} />
              <Row accent="#FF8A80"
                icon={<IconVideo size={17} color="#FF8A80"/>}
                label="iPhone Video button"
                sub={isIphoneVideoReady() ? "On — opens the Camera app in Video mode" : "Set up so it opens the Camera app in Video mode"}
                onClick={()=>{ setIphoneSetupOpen(true); setSettingsOpen(false); }} />
              <Row accent="#7db4ff"
                icon={<IconPhone size={17} color="#7db4ff"/>}
                label="RealWork app"
                sub={isShortcutReady() ? "On — RealWork opens the app, not the browser" : "Set up so RealWork opens the app instead of the browser"}
                onClick={()=>{ setRealworkSetupOpen(true); setSettingsOpen(false); }} />
              <Row accent="#F6BF26"
                icon={<IconPhone size={17} color="#F6BF26"/>}
                label="Duplicate contacts"
                sub="Remove repeat CLIENT entries from your phone contacts"
                onClick={()=>{ setContactCleanupOpen(true); setSettingsOpen(false); }} />
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
                onClick={()=>{ if(signOutConfirm){ signOutEverywhereHere(); setSignOutConfirm(false); setSettingsOpen(false); } else { setSignOutConfirm(true); setTimeout(()=>setSignOutConfirm(false),3000); } }} />
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
            if (form.callout) descParts.push(`Callout: ${form.callout.replace(/\s+/g, " ")}`);
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
        <button onClick={()=>{setPipelineSearchOpen(false);setPipelineSearch("");}} style={{padding:"6px 8px",borderRadius:6,background:"transparent",border:"none",color:"#607591",cursor:"pointer"}}><IconX size={13} color="#607591"/></button>
      </div>}
      {view === "pipeline" && <Pipeline onSwitchToRoute={(cardId) => { setView("route"); setSelDay(0); if (cardId) { setDismissed(prev => { const n={...prev}; delete n[cardId]; return n; }); const pl=loadPipeline(); delete pl[cardId]; savePipeline(pl); } }} search={pipelineSearch} onCloudSync={triggerCloudSync} token={token} lastContact={lastContact} markContact={markContact} selectMode={pipelineSelectMode} setSelectMode={setPipelineSelectMode} onSelectCountChange={setPipelineSelectedCount} bulkEmailTick={pipelineBulkEmailTick} />}

      {/* ── TEXT SHEET ─────────────────────────────────────────────────── */}
      {textSheet && <div onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:"max(18px,env(safe-area-inset-bottom))"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1}}>Text {(textSheet.cn||"").split(" ")[0]}</span>
            <span style={{fontSize:12,color:"#707c9a"}}>{textSheet.phone}</span>
            <button onClick={()=>{setTextSheet(null);setOtwMinutes(null);}} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#707c9a",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={13} color="#707c9a"/></button>
          </div>

          <button onClick={()=>{window.open(`sms:${textSheet.phone.replace(/\D/g,"")}`,"_self");markContact(textSheet.id,"sms");setTextSheet(null);}} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",cursor:"pointer",textAlign:"left"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#9eb3c8"}}>Custom</div>
            <div style={{fontSize:11,color:"#707c9a",marginTop:2}}>Open blank message</div>
          </button>

          {otwMinutes === null ? (
            <div>
              <div style={{fontSize:11,fontWeight:700,color:"#707c9a",marginBottom:6,letterSpacing:.5}}>OTW — how far out are you?</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {[["4–6","4 to 6 minutes"],["5–7","5 to 7 minutes"],["6–8","6 to 8 minutes"],["8–10","8 to 10 minutes"],["10–12","10 to 12 minutes"],["12–15","12 to 15 minutes"],["15–20","15 to 20 minutes"],["20–25","20 to 25 minutes"],["30–40","30 to 40 minutes"],["40–50","40 to 50 minutes"],["45–1 hr","45 minutes to an hour"]].map(([label,txt]) => (
                  <button key={label} onClick={()=>{
                    const fn = (textSheet.cn||"").split(" ")[0];
                    const msg = `Hi there ${fn}, this is ${getMyName() ? `${getMyName()} with ` : ""}Monster Tree Service, and I'm just reaching out to let you know that I'm headed toward your property and I'm about ${txt} away.`;
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
        onDone={(opts) => markDone(onsiteStop.id, opts)}
        sendToRealWorkOnDone={!!onsiteStop?.isTask}
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
      {handoff && (
        <RealWorkHandoff
          stopId={handoff.stopId}
          cn={handoff.cn}
          sendClip={handoff.sendClip}
          token={token}
          onRelease={releaseHandoff}
        />
      )}

      {nextStopCard && !handoff && (
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

      {photoUploadsOpen && (
        <PhotoUploads token={token} onClose={() => setPhotoUploadsOpen(false)}
                      onFreeSpace={() => { setPhotoUploadsOpen(false); setDriveCleanupOpen(true); }} />
      )}

      {driveCleanupOpen && (
        <DriveCleanup token={token} onClose={() => setDriveCleanupOpen(false)} />
      )}

      {acctConflict && (
        <div style={{position:"fixed",inset:0,zIndex:500,background:"rgba(0,0,0,.8)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"#0d0f18",border:"1px solid #3a2a20",borderRadius:14,padding:20,maxWidth:380,width:"100%",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
            <div style={{fontSize:15,fontWeight:800,color:"#FFB74D",fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>Unsent work on this phone</div>
            <div style={{fontSize:13.5,color:"#d4e1f0",lineHeight:1.5}}>
              You signed in as <b>{acctConflict.next}</b>, but this phone still has work from <b>{acctConflict.prev}</b> that hasn't reached its Google Drive yet:
              <div style={{margin:"10px 0",color:"#FFCC80"}}>
                {[acctConflict.pending.photos && `${acctConflict.pending.photos} visit${acctConflict.pending.photos===1?"":"s"} with photos`,
                  acctConflict.pending.notes && `${acctConflict.pending.notes} visit${acctConflict.pending.notes===1?"":"s"} with notes`,
                  acctConflict.pending.videos && `${acctConflict.pending.videos} video${acctConflict.pending.videos===1?"":"s"}`].filter(Boolean).join(" · ")}
              </div>
              Sign back in as {acctConflict.prev} and let it finish uploading first. Nothing has been sent to either account.
            </div>
            <button onClick={signOutEverywhereHere} style={{marginTop:16,width:"100%",padding:"12px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.5)",color:"#34d399",fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'Oswald',sans-serif",letterSpacing:.5,textTransform:"uppercase"}}>Sign out — I'll switch back</button>
            <button onClick={() => { if (window.confirm(`Permanently delete the unsent work from ${acctConflict.prev} on this phone and continue as ${acctConflict.next}?`)) clearLocalDataForAccountSwitch(acctConflict.next); }} style={{marginTop:8,width:"100%",padding:"10px 0",borderRadius:10,background:"transparent",border:"1px solid #4a2a2a",color:"#ff8a80",fontSize:12,fontWeight:700,cursor:"pointer"}}>Delete it and continue as {acctConflict.next}</button>
          </div>
        </div>
      )}

      {freezeReportText != null && (
        <div style={{position:"fixed",inset:0,zIndex:360,background:"#0a0b10",display:"flex",flexDirection:"column",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"max(14px, var(--safe-top)) 16px 12px",borderBottom:"1px solid #1a2030"}}>
            <div style={{flex:1}}>
              <div style={{fontSize:15,fontWeight:800,color:"#fff",fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>Freeze report</div>
              <div style={{fontSize:11.5,color:"#8a9ab0",marginTop:2}}>Copied — paste it into your chat with Claude.</div>
            </div>
            <button onClick={() => setFreezeReportText(null)} aria-label="Close" style={{width:38,height:38,borderRadius:19,background:"transparent",border:"1px solid #253049",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={16} color="#9aadc8"/></button>
          </div>
          <div style={{display:"flex",gap:8,padding:"10px 16px"}}>
            <button onClick={() => { try { navigator.clipboard?.writeText(freezeReportText).catch(() => {}); } catch {} }} style={{flex:1,padding:"11px 0",borderRadius:10,background:"rgba(16,185,129,.15)",border:"1px solid rgba(16,185,129,.5)",color:"#34d399",fontSize:12.5,fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:.5,textTransform:"uppercase",cursor:"pointer"}}>Copy again</button>
            {typeof navigator !== "undefined" && navigator.share && (
              <button onClick={() => { navigator.share({ title: "MTS Field freeze report", text: freezeReportText }).catch(() => {}); }} style={{flex:1,padding:"11px 0",borderRadius:10,background:"rgba(26,115,232,.15)",border:"1px solid rgba(26,115,232,.45)",color:"#7db4ff",fontSize:12.5,fontWeight:800,fontFamily:"'Oswald',sans-serif",letterSpacing:.5,textTransform:"uppercase",cursor:"pointer"}}>Share…</button>
            )}
          </div>
          <pre style={{flex:1,overflow:"auto",margin:0,padding:"8px 16px max(16px, env(safe-area-inset-bottom))",color:"#c8d4e4",fontSize:10.5,lineHeight:1.45,whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:"ui-monospace,Menlo,monospace"}}>{freezeReportText}</pre>
        </div>
      )}

      {mediaRecoverOpen && (
        <MediaRecover token={token} onClose={() => setMediaRecoverOpen(false)} />
      )}

      {accountCheckOpen && (
        <AccountCheck token={token} onServerSignIn={serverSignIn} onClose={() => setAccountCheckOpen(false)} />
      )}

      {iphoneSetupOpen && (
        <div onClick={() => setIphoneSetupOpen(false)} style={{position:"fixed",inset:0,zIndex:360,background:"rgba(0,0,0,.6)",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
          <div onClick={e => e.stopPropagation()} style={{background:"#0d0f18",borderTop:"1px solid #1a2030",borderTopLeftRadius:18,borderTopRightRadius:18,padding:"16px 18px",paddingBottom:"max(18px,env(safe-area-inset-bottom))",maxHeight:"85vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",marginBottom:12}}>
              <div style={{flex:1,fontSize:14,fontWeight:800,color:"#fff",fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>iPhone Video button</div>
              <button onClick={() => setIphoneSetupOpen(false)} aria-label="Close" style={{width:34,height:34,borderRadius:17,background:"transparent",border:"1px solid #253049",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={15} color="#9aadc8"/></button>
            </div>
            <IphoneVideoSetup />
          </div>
        </div>
      )}

      {realworkSetupOpen && (
        <div onClick={() => setRealworkSetupOpen(false)} style={{position:"fixed",inset:0,zIndex:360,background:"rgba(0,0,0,.6)",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
          <div onClick={e => e.stopPropagation()} style={{background:"#0d0f18",borderTop:"1px solid #1a2030",borderTopLeftRadius:18,borderTopRightRadius:18,padding:"16px 18px",paddingBottom:"max(18px,env(safe-area-inset-bottom))",maxHeight:"85vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",marginBottom:12}}>
              <div style={{flex:1,fontSize:14,fontWeight:800,color:"#fff",fontFamily:"'Oswald',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>Open the RealWork app</div>
              <button onClick={() => setRealworkSetupOpen(false)} aria-label="Close" style={{width:34,height:34,borderRadius:17,background:"transparent",border:"1px solid #253049",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={15} color="#9aadc8"/></button>
            </div>
            <RealWorkSetup />
          </div>
        </div>
      )}

      {contactCleanupOpen && (
        <ContactCleanup token={token} onClose={() => setContactCleanupOpen(false)} />
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
        <button onClick={() => { if (undoToastTimer.current) clearTimeout(undoToastTimer.current); setUndoToast(null); }} style={{padding:"6px 10px",borderRadius:6,background:"transparent",border:"none",color:"#64816c",cursor:"pointer",display:"flex",alignItems:"center"}}><IconX size={14} color="#64816c"/></button>
      </div>}

      {/* ── TTS ERROR TOAST ────────────────────────────────────────── */}
      {ttsError && <div style={{position:"fixed",bottom:undoToast?"56px":"0",left:0,right:0,padding:"10px 16px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#2a1a1a",borderTop:"1px solid rgba(255,85,85,.35)",display:"flex",alignItems:"flex-start",gap:10,zIndex:151,transition:"bottom .2s"}}>
        <div style={{flex:1,fontSize:12,color:"#FF8888",fontWeight:500,lineHeight:1.45}}>
          <div style={{fontWeight:700,marginBottom:2,fontFamily:"'Oswald',sans-serif",letterSpacing:0.5,textTransform:"uppercase",fontSize:11}}>TTS failed</div>
          <div style={{fontSize:11,color:"#e0a0a0",wordBreak:"break-word"}}>{ttsError}</div>
        </div>
        <button onClick={() => setTtsError(null)} style={{padding:"4px 8px",borderRadius:6,background:"transparent",border:"none",color:"#af7979",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}><IconX size={14} color="#af7979"/></button>
      </div>}

      {/* (UploadTracker is mounted inline above the bottom bar — see above) */}
    </div>
  );
}
