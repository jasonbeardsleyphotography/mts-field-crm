import { useState, useMemo, useEffect, useRef } from "react";
import { IconSearch, IconX } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Universal Search
   One search box that spans EVERYTHING the app knows about a client, not just
   the screen you're on:

     • Today's route stops          → open the on-site screen
     • Pipeline cards (every job)   → jump to the card in the Pipeline view
     • Calendar appointments        → open the on-site screen for that visit

   Default scope is the pipeline (every job ever recorded) plus the currently
   loaded route/calendar. "Search all history" pulls a wider calendar range on
   demand for a deeper sweep. Each hit shows its status/stage so you can tell
   them apart, and tapping opens it where it lives.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

const STAGE_META = {
  sold:            { label: "Sold",            color: "#10B981" },
  estimate_needed: { label: "Estimate Needed", color: "#3B82F6" },
  strong:          { label: "Strong Lead",     color: "#34D399" },
  follow_up:       { label: "Follow-up",       color: "#A78BFA" },
  weak:            { label: "Weak Lead",        color: "#FF8A65" },
  waiting:         { label: "Waiting",          color: "#F6BF26" },
  declined:        { label: "Declined",         color: "#ef4444" },
};

const titleCase = (s) => (s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function fmtDate(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

// Merge the three data sources into one deduped record list. Priority decides
// which wins when the same id appears in more than one source: a stop you can
// act on today (route) beats a pipeline card, which beats a raw calendar event.
function buildRecords({ routeStops, pipeline, weekEvents, deepEvents, deep }) {
  const byId = new Map();
  const add = (rec) => {
    if (!rec.id || !rec.cn || !rec.cn.trim()) return;
    const ex = byId.get(rec.id);
    if (!ex || rec._priority >= ex._priority) byId.set(rec.id, rec);
  };

  const calendar = deep ? [...(weekEvents || []), ...(deepEvents || [])] : (weekEvents || []);
  for (const ev of calendar) {
    add({
      id: ev.id, _priority: 1, source: "calendar",
      cn: ev.cn, addr: ev.addr, phone: ev.phone, email: ev.email, jn: ev.jn,
      status: ev._startMs ? `Scheduled ${fmtDate(ev._startMs)}` : "Scheduled",
      statusColor: "#7BB3FF", _recency: ev._startMs || 0, raw: ev,
    });
  }
  for (const card of Object.values(pipeline || {})) {
    const meta = STAGE_META[card.stage] || { label: titleCase(card.stage) || "Lead", color: "#7a8aaa" };
    add({
      id: card.id, _priority: 2, source: "pipeline",
      cn: card.cn, addr: card.addr, phone: card.phone, email: card.email, jn: card.jn,
      status: meta.label, statusColor: meta.color,
      _recency: card.stageChangedAt || card.addedAt || 0, raw: card,
    });
  }
  for (const s of routeStops || []) {
    const isAM = (s.window || "").startsWith("AM");
    add({
      id: s.id, _priority: 3, source: "route",
      cn: s.cn, addr: s.addr, phone: s.phone, email: s.email, jn: s.jn,
      status: `On route${s.window ? " · " + s.window : ""}`,
      statusColor: isAM ? "#10B981" : "#3B82F6",
      _recency: Date.now(), raw: s,
    });
  }
  return [...byId.values()];
}

const RENDER_CAP = 150;

export default function UniversalSearch({
  open, onClose, routeStops, pipeline, weekEvents,
  deepEvents, deepLoading, onDeepSearch, onOpenStop, onOpenCard,
}) {
  const [q, setQ] = useState("");
  const [deep, setDeep] = useState(false);
  const inputRef = useRef(null);

  // Reset on each open; focus the field.
  useEffect(() => {
    if (open) {
      setQ(""); setDeep(false);
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 60);
    }
  }, [open]);

  const records = useMemo(
    () => buildRecords({ routeStops, pipeline, weekEvents, deepEvents, deep }),
    [routeStops, pipeline, weekEvents, deepEvents, deep]
  );

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const digits = term.replace(/\D/g, "");
    const out = records.filter(r =>
      (r.cn || "").toLowerCase().includes(term) ||
      (r.addr || "").toLowerCase().includes(term) ||
      (r.email || "").toLowerCase().includes(term) ||
      (r.jn || "").toLowerCase().includes(term) ||
      (digits.length >= 3 && (r.phone || "").replace(/\D/g, "").includes(digits))
    );
    out.sort((a, b) => b._recency - a._recency);
    return out;
  }, [records, q]);

  if (!open) return null;

  const openRecord = (rec) => {
    if (rec.source === "pipeline") onOpenCard(rec.raw);
    else onOpenStop(rec.raw);
  };

  const enableDeep = () => { setDeep(true); onDeepSearch?.(); };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "#0a0b10", display: "flex", flexDirection: "column" }}>
      {/* Search bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "max(10px, env(safe-area-inset-top)) 12px 10px",
        background: "#0d0f18", borderBottom: "1px solid #1a1f2e", flexShrink: 0,
      }}>
        <IconSearch size={16} color="#4a80c0" />
        <input
          ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search everyone — name, address, phone, email, job #"
          style={{ flex: 1, padding: "8px 4px", background: "transparent", border: "none", color: "#e0e8f0", fontSize: 16, fontFamily: "'DM Sans',system-ui", outline: "none" }}
        />
        <button onClick={onClose} aria-label="Close search" style={{ padding: 6, background: "transparent", border: "none", cursor: "pointer", display: "flex" }}>
          <IconX size={18} color="#5a6580" />
        </button>
      </div>

      {/* Scope row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", borderBottom: "1px solid #11151f", flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: "#4a5a70", fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", flex: 1 }}>
          {q.trim()
            ? `${results.length} result${results.length === 1 ? "" : "s"}${results.length > RENDER_CAP ? ` · showing ${RENDER_CAP}` : ""}`
            : "Pipeline + route" + (deep ? " + all calendar history" : "")}
        </span>
        {!deep ? (
          <button onClick={enableDeep} style={{ padding: "4px 10px", borderRadius: 999, background: "rgba(59,130,246,.1)", border: "1px solid rgba(59,130,246,.3)", color: "#4a80c0", fontSize: 10, fontWeight: 800, cursor: "pointer", fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>
            + Search all history
          </button>
        ) : (
          <span style={{ fontSize: 10, color: deepLoading ? "#F6BF26" : "#10B981", fontWeight: 800, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase" }}>
            {deepLoading ? "Loading history…" : "History included"}
          </span>
        )}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
        {!q.trim() && (
          <div style={{ padding: "40px 24px", textAlign: "center", color: "#3a4560", fontSize: 13, lineHeight: 1.6 }}>
            Search across every client — today's stops, your whole pipeline, and
            scheduled appointments. Tap a result to open it.
          </div>
        )}
        {q.trim() && results.length === 0 && (
          <div style={{ padding: "40px 24px", textAlign: "center", color: "#3a4560", fontSize: 13, lineHeight: 1.6 }}>
            No matches for “{q.trim()}”.
            {!deep && <><br /><button onClick={enableDeep} style={{ marginTop: 10, padding: "6px 14px", borderRadius: 8, background: "rgba(59,130,246,.1)", border: "1px solid rgba(59,130,246,.3)", color: "#4a80c0", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase" }}>Search all calendar history</button></>}
          </div>
        )}
        {results.slice(0, RENDER_CAP).map(r => (
          <button key={`${r.source}:${r.id}`} onClick={() => openRecord(r)} style={{
            width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10,
            padding: "11px 16px", background: "transparent", border: "none",
            borderBottom: "1px solid #0e1218", cursor: "pointer",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e8eef6", fontFamily: F, textTransform: "uppercase", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.cn}</div>
              {r.addr && <div style={{ fontSize: 11, color: "#6a7890", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.addr}</div>}
              {r.jn && <div style={{ fontSize: 10, color: "#3a4560", marginTop: 1 }}>#{r.jn}</div>}
            </div>
            <div style={{
              flexShrink: 0, fontSize: 9, fontWeight: 800, fontFamily: F, letterSpacing: 0.4,
              textTransform: "uppercase", color: r.statusColor,
              padding: "3px 9px", borderRadius: 999,
              background: r.statusColor + "1a", border: `1px solid ${r.statusColor}44`,
              maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center",
            }}>{r.status}</div>
          </button>
        ))}
        {results.length > RENDER_CAP && (
          <div style={{ padding: "14px 24px", textAlign: "center", color: "#3a4560", fontSize: 12 }}>
            +{results.length - RENDER_CAP} more — keep typing to narrow it down.
          </div>
        )}
      </div>
    </div>
  );
}
