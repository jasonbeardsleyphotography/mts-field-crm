import { useState, useEffect, useCallback, useRef } from "react";
import { getDriveStorage } from "./driveSync";
import { IconX, IconRefresh } from "./icons";
import { getMyName, setMyName } from "./myName";
import { isShortcutReady, isSendReady } from "./realwork";
import { isPhoneLike } from "./device";
import { getRouteCalendars, listCalendarsWithToday } from "./calendarSource";
import { getNavApp, setNavApp } from "./openMaps";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Account & connection check
   ───────────────────────────────────────────────────────────────────────────
   One screen that tests every connection the app depends on, for whichever
   Google account is signed in, and says plainly what to do about anything that
   isn't right. Built for setting up a second person's account, and for the
   "it's not syncing" moments after that.

   Each check is read-only: nothing here creates, changes or deletes anything.
   The per-account settings live here too (route calendar, your name, RealWork,
   weekends, navigation app, duplicate contacts) so each is next to its check.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

function freshToken(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
  } catch {}
  return fallback;
}

const gb = (n) => (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + " GB";

// Every row the check shows, in order — drawn straight away with a spinner,
// then filled in as each check finishes.
const ROW_LABELS = ["Signed in as", "Stays signed in", "Calendar", "Google Drive", "Contacts",
  "Your name in customer texts", "RealWork app", "Photo uploads", "App version"];

async function runChecks(token, h, emit) {
  const { onServerSignIn, onPickCalendar, onEditName, onRealWork, onContactCleanup } = h;
  const tok = freshToken(token);
  const auth = { headers: { Authorization: `Bearer ${tok}` } };
  const out = [];
  const add = (label, state, detail, action) => { out.push({ label, state, detail, actions: [action].flat().filter(Boolean) }); emit?.([...out]); };

  if (!tok) {
    add("Signed in", "bad", "No Google sign-in on this device. Sign in first, then run this again.");
    return out;
  }

  // 1. Which account?
  let email = null;
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", auth);
    if (r.ok) email = (await r.json())?.id || null;
  } catch {}
  add("Signed in as", email ? "ok" : "bad",
      email || "Couldn't confirm which account is signed in — check your signal, or sign out and back in.");

  // 2. Lasting sign-in (server session)
  try {
    const r = await fetch("/api/token", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) add("Stays signed in", "ok", "Lasting sign-in is on for this device.");
    else if (r.status === 403) add("Stays signed in", "bad",
      "This Google account isn't approved for MTS Field's server features (shared links, AI, lasting sign-in).");
    else add("Stays signed in", "warn",
      "Lasting sign-in isn't set up on this device, so you'll be asked to sign in more often.",
      onServerSignIn ? { label: "Turn on lasting sign-in", run: onServerSignIn } : null);
  } catch { add("Stays signed in", "warn", "Couldn't reach the app's server — check your signal."); }

  // 3. Calendar(s) the route reads — and, if they're empty today, whether
  //    another calendar on this account has the visits.
  try {
    const cals = await listCalendarsWithToday(tok);
    const route = getRouteCalendars();
    const onRoute = cals.filter(c => route.includes(c.id));
    const routeToday = onRoute.reduce((n, c) => n + (c.today || 0), 0);
    const names = onRoute.map(c => c.primary ? `${c.name} (main)` : c.name).join(", ") || "main calendar";
    const others = cals.filter(c => !route.includes(c.id) && c.today > 0);
    const pick = onPickCalendar ? { label: "Choose route calendar", run: onPickCalendar } : null;  // always offered, even when it works
    if (routeToday) {
      add("Calendar", "ok", `${routeToday} event${routeToday === 1 ? "" : "s"} today on the route's calendar: ${names}.`, pick);
    } else if (others.length) {
      add("Calendar", "warn",
        `Nothing today on the route's calendar (${names}), but ${others.map(c => `"${c.name}" has ${c.today}`).join(", ")} today. If your visits are booked there, choose it as the route calendar.`, pick);
    } else {
      add("Calendar", "warn",
        `Nothing today on the route's calendar (${names}) or any other calendar on this account. If visits are booked on a different Google account, share that calendar with this account, then choose it here.`, pick);
    }
  } catch { add("Calendar", "bad", "Couldn't read this account's calendars. Sign out and back in, and allow Calendar access.", onPickCalendar ? { label: "Choose route calendar", run: onPickCalendar } : null); }

  // 4. Drive (photos, notes, sync between devices)
  try {
    const st = await getDriveStorage(tok);
    if (st.limit == null) add("Google Drive", "ok", `Connected · ${gb(st.used)} used.`);
    else if (st.full) add("Google Drive", "bad", `FULL — ${gb(st.used)} of ${gb(st.limit)}. Photos and notes can't sync until space is freed (Settings → Free up Drive space, then empty Drive's Trash).`);
    else add("Google Drive", st.usedPct > 90 ? "warn" : "ok",
      `Connected · ${gb(st.used)} of ${gb(st.limit)} used (${st.usedPct.toFixed(0)}%).${st.usedPct > 90 ? " Nearly full." : ""}`);
  } catch { add("Google Drive", "bad", "Couldn't reach Google Drive. Sign out and back in, and allow Drive access."); }

  // 5. Contacts (caller ID for clients)
  {
    const dup = onContactCleanup ? { label: "Remove duplicate contacts", run: onContactCleanup } : null;
    try {
      const r = await fetch("https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names", auth);
      add("Contacts", r.ok ? "ok" : "bad", r.ok
        ? "Connected — new clients are added to this account's contacts."
        : `Couldn't read contacts (error ${r.status}). Sign out and back in, and allow Contacts access.`, r.ok ? dup : null);
    } catch { add("Contacts", "bad", "Couldn't reach Google Contacts — check your signal."); }
  }

  // 6. Name used in messages to customers
  {
    const n = getMyName();
    add("Your name in customer texts", n ? "ok" : "warn",
      n ? `Texts and follow-up emails are signed “${n}”.` : "Not set — texts would say “your Monster Tree estimator”.",
      onEditName ? { label: n ? "Change name" : "Set your name", run: onEditName } : null);
  }

  // 6b. RealWork app hand-off (iPhone Shortcuts) — a phone step.
  {
    const open = isShortcutReady(), send = isSendReady();
    const act = onRealWork ? { label: open ? "RealWork settings" : "Set up RealWork app", run: onRealWork } : null;
    if (!isPhoneLike()) add("RealWork app", "ok", "Phone only — on a computer, Done goes straight to the next stop.", act);
    else add("RealWork app", open ? "ok" : "warn",
      open ? `On — RealWork opens the app, not the browser${send ? ", and photos are sent with it" : ""}.`
           : "Not set up — RealWork opens in the browser instead of the app.", act);
  }

  // 7. Anything stuck on this device?
  try {
    const q = JSON.parse(localStorage.getItem("mts-photo-queue") || "[]");
    add("Photo uploads", q.length ? "warn" : "ok", q.length
      ? `${q.length} visit${q.length === 1 ? "" : "s"} with photos still waiting to upload (Settings → Photo uploads).`
      : "Nothing waiting — every photo on this device has reached Drive.");
  } catch {}

  // 8. Which version is running
  try {
    const keys = (await caches.keys()).filter(k => k.startsWith("mts-field-v"));
    if (keys.length) add("App version", "ok", keys.sort((a, b) => parseInt(a.slice(11)) - parseInt(b.slice(11))).pop().replace("mts-field-", ""));
  } catch {}

  return out;
}

export default function AccountCheck({ token, onClose, onServerSignIn, onPickCalendar, onRealWork, onContactCleanup,
  onNameChanged, includeWeekends, onToggleWeekends, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [navApp, setNavAppState] = useState(getNavApp);
  const chooseNav = (app) => { setNavApp(app); setNavAppState(app); };

  // Latest handlers, so the checks don't re-run every time App re-renders.
  const h = useRef({});
  h.current = { onServerSignIn, onPickCalendar, onRealWork, onContactCleanup, onEditName: () => {
    const n = window.prompt("Your first name, as customers should see it in texts and emails:", getMyName());
    if (n != null) { setMyName(n); onNameChanged?.(); run(); }
  } };
  const wrap = (k) => h.current[k] ? () => h.current[k]() : null;
  const gen = useRef(0);
  const hasRows = useRef(false);
  const [partial, setPartial] = useState(null);
  const run = useCallback(async () => {
    const g = ++gen.current;
    setBusy(true);
    // First run: fill rows in as they finish. Re-runs keep the old rows until
    // the new set is ready, so nothing flashes.
    const first = !hasRows.current;
    try {
      const out = await runChecks(token, {
        onServerSignIn: wrap("onServerSignIn"), onPickCalendar: wrap("onPickCalendar"), onEditName: wrap("onEditName"),
        onRealWork: wrap("onRealWork"), onContactCleanup: wrap("onContactCleanup"),
      }, first ? (part) => { if (g === gen.current) setPartial(part); } : null);
      if (g === gen.current) { setRows(out); setPartial(null); hasRows.current = true; }
    } finally { if (g === gen.current) setBusy(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runs on open, and again when a screen opened from here closes (refreshKey).
  useEffect(() => { run(); }, [run, refreshKey]);

  const mark = { ok: ["✓", "#10B981"], warn: ["!", "#F6BF26"], bad: ["✕", "#ff6b6b"] };
  const allGood = rows && rows.every(r => r.state === "ok");

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 360, background: "#0a0b10",
      display: "flex", flexDirection: "column", fontFamily: "'DM Sans',system-ui,sans-serif",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
        padding: "max(14px, var(--safe-top)) 16px 12px", borderBottom: "1px solid #1a2030",
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>
            Account & Connection Check
          </div>
          <div style={{ fontSize: 11.5, color: "#90a0b5", marginTop: 2 }}>
            {busy ? "Checking…" : rows ? (allGood ? "Everything is connected." : "Some things need attention.") : ""}
          </div>
        </div>
        <button onClick={run} disabled={busy} aria-label="Run again" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, background: "transparent",
          border: "1px solid #253049", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconRefresh size={16} color="#9aadc8" /></button>
        <button onClick={onClose} aria-label="Close" style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, background: "transparent",
          border: "1px solid #253049", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}><IconX size={16} color="#9aadc8" /></button>
      </div>

      <style>{`@keyframes acspin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px max(20px, env(safe-area-inset-bottom))" }}>
        {(rows || ROW_LABELS.map(l => (partial || []).find(r => r.label === l) || { label: l, pending: true })).map((r, i) => {
          if (r.pending) return (
            <div key={i} style={{ display: "flex", gap: 12, padding: "13px 0", borderBottom: "1px solid #141a28", alignItems: "center" }}>
              <span style={{
                width: 20, height: 20, margin: "0 2px", borderRadius: 10, flexShrink: 0,
                border: "2px solid #253049", borderTopColor: "#7db4ff", animation: "acspin .8s linear infinite",
              }} />
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#8a9ab0" }}>{r.label}</div>
            </div>
          );
          const [glyph, color] = mark[r.state];
          return (
            <div key={i} style={{ display: "flex", gap: 12, padding: "13px 0", borderBottom: "1px solid #141a28" }}>
              <span style={{
                width: 24, height: 24, borderRadius: 12, flexShrink: 0, marginTop: 1,
                background: `${color}22`, border: `1px solid ${color}88`, color,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 900,
              }}>{glyph}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: "#e6ecf5" }}>{r.label}</div>
                <div style={{ fontSize: 12.5, color: "#b2bfd1", marginTop: 3, lineHeight: 1.45, overflowWrap: "anywhere" }}>{r.detail}</div>
                {r.actions.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {r.actions.map((a, j) => (
                      <button key={j} onClick={a.run} style={{
                        padding: "8px 12px", borderRadius: 8,
                        background: "rgba(26,115,232,.15)", border: "1px solid rgba(26,115,232,.4)",
                        color: "#7db4ff", fontSize: 11.5, fontWeight: 800, fontFamily: F,
                        letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
                      }}>{a.label}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {/* Weekends (per device) */}
        {onToggleWeekends && (
          <div style={{ padding: "14px 0", borderBottom: "1px solid #141a28" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#e6ecf5" }}>Weekends</div>
            <div style={{ fontSize: 12.5, color: "#a9b8cc", marginTop: 3, lineHeight: 1.45 }}>
              Whether Saturdays and Sundays show in the day picker.
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              {[[false, "Weekdays only"], [true, "Include weekends"]].map(([val, label]) => {
                const on = !!includeWeekends === val;
                return (
                  <button key={label} onClick={() => { if (!on) onToggleWeekends(); }} style={{
                    flex: 1, padding: "11px 0", borderRadius: 10, cursor: "pointer",
                    background: on ? "rgba(16,185,129,.15)" : "transparent",
                    border: `1px solid ${on ? "rgba(16,185,129,.6)" : "#253049"}`,
                    color: on ? "#34d399" : "#a9b8cc", fontSize: 13, fontWeight: 800,
                  }}>{on ? "✓ " : ""}{label}</button>
                );
              })}
            </div>
          </div>
        )}

        {/* Navigation app (per device) */}
        <div style={{ padding: "14px 0", borderBottom: "1px solid #141a28" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#e6ecf5" }}>Navigation app</div>
          <div style={{ fontSize: 12.5, color: "#a9b8cc", marginTop: 3, lineHeight: 1.45 }}>
            Which app the Navigate buttons open on this phone. On a computer, Google Maps opens in the browser.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {[["google", "Google Maps"], ["apple", "Apple Maps"]].map(([id, label]) => {
              const on = navApp === id;
              return (
                <button key={id} onClick={() => chooseNav(id)} style={{
                  flex: 1, padding: "11px 0", borderRadius: 10, cursor: "pointer",
                  background: on ? "rgba(16,185,129,.15)" : "transparent",
                  border: `1px solid ${on ? "rgba(16,185,129,.6)" : "#253049"}`,
                  color: on ? "#34d399" : "#a9b8cc", fontSize: 13, fontWeight: 800,
                }}>{on ? "✓ " : ""}{label}</button>
              );
            })}
          </div>
        </div>

        {rows && (
          <div style={{ fontSize: 11.5, color: "#818fa4", lineHeight: 1.5, padding: "14px 0" }}>
            The checks only read — nothing is created or changed unless you tap a button. Each person signs in with
            their own Google account and sees their own calendar, Drive and contacts.
          </div>
        )}
      </div>
    </div>
  );
}
