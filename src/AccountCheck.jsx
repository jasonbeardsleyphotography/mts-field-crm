import { useState, useEffect, useCallback } from "react";
import { getDriveStorage } from "./driveSync";
import { IconX, IconRefresh } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Account & connection check
   ───────────────────────────────────────────────────────────────────────────
   One screen that tests every connection the app depends on, for whichever
   Google account is signed in, and says plainly what to do about anything that
   isn't right. Built for setting up a second person's account, and for the
   "it's not syncing" moments after that.

   Each check is read-only: nothing here creates, changes or deletes anything.
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

async function runChecks(token, onServerSignIn) {
  const tok = freshToken(token);
  const auth = { headers: { Authorization: `Bearer ${tok}` } };
  const out = [];
  const add = (label, state, detail, action) => out.push({ label, state, detail, action });

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

  // 3. Calendar (where the route comes from)
  try {
    const s = new Date(); s.setHours(0, 0, 0, 0);
    const e = new Date(); e.setHours(23, 59, 59, 999);
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&timeMin=${s.toISOString()}&timeMax=${e.toISOString()}&maxResults=250&fields=items(id)`, auth);
    if (!r.ok) add("Calendar", "bad", `Couldn't read this account's calendar (error ${r.status}). Sign out and back in, and allow Calendar access.`);
    else {
      const n = ((await r.json())?.items || []).length;
      add("Calendar", n ? "ok" : "warn", n
        ? `${n} event${n === 1 ? "" : "s"} on this account's calendar today.`
        : "Nothing on this account's calendar today. The route reads THIS account's own calendar — if visits are booked on a different account, they won't show here.");
    }
  } catch { add("Calendar", "bad", "Couldn't reach Google Calendar — check your signal."); }

  // 4. Drive (photos, notes, sync between devices)
  try {
    const st = await getDriveStorage(tok);
    if (st.limit == null) add("Google Drive", "ok", `Connected · ${gb(st.used)} used.`);
    else if (st.full) add("Google Drive", "bad", `FULL — ${gb(st.used)} of ${gb(st.limit)}. Photos and notes can't sync until space is freed (Settings → Free up Drive space, then empty Drive's Trash).`);
    else add("Google Drive", st.usedPct > 90 ? "warn" : "ok",
      `Connected · ${gb(st.used)} of ${gb(st.limit)} used (${st.usedPct.toFixed(0)}%).${st.usedPct > 90 ? " Nearly full." : ""}`);
  } catch { add("Google Drive", "bad", "Couldn't reach Google Drive. Sign out and back in, and allow Drive access."); }

  // 5. Contacts (caller ID for clients)
  try {
    const r = await fetch("https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names", auth);
    add("Contacts", r.ok ? "ok" : "bad", r.ok
      ? "Connected — new clients are added to this account's contacts."
      : `Couldn't read contacts (error ${r.status}). Sign out and back in, and allow Contacts access.`);
  } catch { add("Contacts", "bad", "Couldn't reach Google Contacts — check your signal."); }

  // 6. Anything stuck on this device?
  try {
    const q = JSON.parse(localStorage.getItem("mts-photo-queue") || "[]");
    add("Photo uploads", q.length ? "warn" : "ok", q.length
      ? `${q.length} visit${q.length === 1 ? "" : "s"} with photos still waiting to upload (Settings → Photo uploads).`
      : "Nothing waiting — every photo on this device has reached Drive.");
  } catch {}

  // 7. Which version is running
  try {
    const keys = (await caches.keys()).filter(k => k.startsWith("mts-field-v"));
    if (keys.length) add("App version", "ok", keys.sort().pop().replace("mts-field-", ""));
  } catch {}

  return out;
}

export default function AccountCheck({ token, onClose, onServerSignIn }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try { setRows(await runChecks(token, onServerSignIn)); }
    finally { setBusy(false); }
  }, [token, onServerSignIn]);

  useEffect(() => { run(); }, [run]);

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

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px max(20px, env(safe-area-inset-bottom))" }}>
        {(rows || []).map((r, i) => {
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
                {r.action && (
                  <button onClick={r.action.run} style={{
                    marginTop: 8, padding: "8px 12px", borderRadius: 8,
                    background: "rgba(26,115,232,.15)", border: "1px solid rgba(26,115,232,.4)",
                    color: "#7db4ff", fontSize: 11.5, fontWeight: 800, fontFamily: F,
                    letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
                  }}>{r.action.label}</button>
                )}
              </div>
            </div>
          );
        })}
        {rows && (
          <div style={{ fontSize: 11.5, color: "#818fa4", lineHeight: 1.5, padding: "14px 0" }}>
            Checks only read — nothing is created or changed. Each person signs in with
            their own Google account and sees their own calendar, Drive and contacts.
          </div>
        )}
      </div>
    </div>
  );
}
