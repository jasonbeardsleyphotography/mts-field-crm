import { useState, useEffect } from "react";
import { getRouteCalendars, setRouteCalendars, listCalendarsWithToday } from "./calendarSource";
import { IconX } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Choose which calendar(s) the route reads
   Lists every calendar the signed-in account can see, with how many events
   each has today, so the one holding the SingleOps visits is easy to spot.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

function freshToken(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
  } catch {}
  return fallback;
}

export default function RouteCalendarPicker({ token, onClose, onSaved }) {
  const [cals, setCals] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set(getRouteCalendars()));

  useEffect(() => {
    let dead = false;
    listCalendarsWithToday(freshToken(token))
      .then(list => { if (!dead) setCals(list.sort((a, b) => (b.primary - a.primary) || ((b.today || 0) - (a.today || 0)))); })
      .catch(e => { if (!dead) setErr(e.message || String(e)); });
    return () => { dead = true; };
  }, [token]);

  const toggle = (id) => setPicked(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const save = () => {
    const ids = (cals || []).map(c => c.id).filter(id => picked.has(id));
    setRouteCalendars(ids.length ? ids : ["primary"]);
    onSaved?.();
    onClose?.();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 360, background: "#0a0b10", display: "flex", flexDirection: "column", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "max(14px, var(--safe-top)) 16px 12px", borderBottom: "1px solid #1a2030" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>Route calendar</div>
          <div style={{ fontSize: 11.5, color: "#8a9ab0", marginTop: 2 }}>Tick the calendar(s) your visits are booked on.</div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ width: 38, height: 38, borderRadius: 19, background: "transparent", border: "1px solid #253049", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><IconX size={16} color="#9aadc8" /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px" }}>
        {!cals && !err && <div style={{ color: "#8a9ab0", fontSize: 13, padding: 20, textAlign: "center" }}>Looking at your calendars…</div>}
        {err && <div style={{ color: "#ff9a9a", fontSize: 13, padding: 20, textAlign: "center" }}>Couldn't list your calendars: {err}</div>}
        {(cals || []).map(c => {
          const on = picked.has(c.id);
          return (
            <button key={c.id} onClick={() => toggle(c.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 4px", background: "transparent", border: "none", borderBottom: "1px solid #141a28", cursor: "pointer", textAlign: "left" }}>
              <span style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0, border: `2px solid ${on ? "#10B981" : "#3a4560"}`, background: on ? "#10B981" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#04140d", fontWeight: 900, fontSize: 14 }}>{on ? "✓" : ""}</span>
              <span style={{ width: 10, height: 10, borderRadius: 5, flexShrink: 0, background: c.color || "#7090b0" }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "#e6ecf5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}{c.primary ? "  (main)" : ""}</span>
                <span style={{ display: "block", fontSize: 12, color: c.today ? "#7ee2b8" : "#8a9ab0", marginTop: 2 }}>
                  {c.today == null ? "Couldn't read" : c.today === 0 ? "Nothing today" : `${c.today} event${c.today === 1 ? "" : "s"} today`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ padding: "10px 16px max(14px, env(safe-area-inset-bottom))", borderTop: "1px solid #1a2030" }}>
        <button onClick={save} disabled={!cals} style={{ width: "100%", padding: "14px 0", borderRadius: 10, background: "rgba(16,185,129,.15)", border: "1px solid rgba(16,185,129,.5)", color: "#34d399", fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", cursor: cals ? "pointer" : "default", opacity: cals ? 1 : 0.5 }}>Use these and reload the route</button>
      </div>
    </div>
  );
}
