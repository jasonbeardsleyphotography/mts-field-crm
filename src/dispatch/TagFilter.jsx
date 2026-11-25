import { useMemo, useState } from "react";
import TagPill from "./TagPill.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Filter jobs by their SingleOps tags (owner, Nov 25): two lists —
   INCLUDE (green) and EXCLUDE (red) — each with its own ANY / ALL switch.
   Tap a tag once = include, twice = exclude, three times = clear.
   The tag filter always decides WHICH jobs show; the sort only orders them.
   ═══════════════════════════════════════════════════════════════════════════ */

// incAll: job must have every included tag (else any one); excAll: job is left out only if it has every excluded tag (else any one)
export const emptyTags = () => ({ inc: [], exc: [], any: false, excAll: false });
export const tagsActive = (f) => f.inc.length + f.exc.length > 0;
export function passTags(j, f) {
  const T = j.tags || [];
  if (f.exc.length) {
    const hit = f.excAll ? f.exc.every((t) => T.includes(t)) : f.exc.some((t) => T.includes(t));
    if (hit) return false;
  }
  if (!f.inc.length) return true;
  return f.any ? f.inc.some((t) => T.includes(t)) : f.inc.every((t) => T.includes(t));
}

const GROUP_NAMES = { "#": "Crew size", "02": "Aerial / climbing", "03": "Equipment", "04": "Lines", "05": "Site", "06": "Gear", "07": "Scheduling", "08": "Season", "09": "Client", "10": "Other" };

export default function TagFilter({ jobs, value, onChange, compact }) {
  const [open, setOpen] = useState(!compact);
  const counts = useMemo(() => {
    const c = {};
    jobs.forEach((j) => (j.tags || []).forEach((t) => { c[t] = (c[t] || 0) + 1; }));
    return c;
  }, [jobs]);
  const groups = useMemo(() => {
    const g = {};
    Object.keys(counts).sort().forEach((t) => { const k = t.startsWith("#") ? "#" : /^\d\d /.test(t) ? t.slice(0, 2) : "10"; (g[k] = g[k] || []).push(t); });
    return Object.entries(g).sort(([a], [b]) => (a === "#" ? "00" : a).localeCompare(b === "#" ? "00" : b));
  }, [counts]);
  const state = (t) => (value.inc.includes(t) ? "inc" : value.exc.includes(t) ? "exc" : "");
  const cycle = (t) => {
    const s = state(t);
    const inc = value.inc.filter((x) => x !== t), exc = value.exc.filter((x) => x !== t);
    if (s === "") inc.push(t); else if (s === "inc") exc.push(t);
    onChange({ ...value, inc, exc });
  };
  const n = value.inc.length + value.exc.length;
  const mode = (on, set, a, b) => (
    <span style={{ display: "inline-flex", border: "1px solid #3a454d", borderRadius: 3, overflow: "hidden" }}>
      {[[false, a], [true, b]].map(([v, l]) => (
        <button key={l} className="st" onClick={() => set(v)} style={{ fontSize: 11, padding: "3px 8px", background: on === v ? "#3a454d" : "transparent", color: on === v ? "#fff" : "#9aa5ad" }}>{l}</button>
      ))}
    </span>
  );
  const row = (kind) => {
    const list = value[kind];
    const inc = kind === "inc";
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "4px 6px", borderRadius: 3, background: inc ? "rgba(23,160,91,.10)" : "rgba(217,59,43,.10)" }}>
        <b className="st" style={{ fontSize: 11.5, width: 62, color: inc ? "#7fe0a8" : "#ff9a8f" }}>{inc ? "INCLUDE" : "EXCLUDE"}</b>
        {inc ? mode(!value.any, (v) => onChange({ ...value, any: !v }), "ANY", "ALL")
             : mode(!!value.excAll, (v) => onChange({ ...value, excAll: v }), "ANY", "ALL")}
        {!list.length && <span style={{ fontSize: 11.5, color: "#8E99A1" }}>{inc ? "tap a tag once" : "tap a tag twice"}</span>}
        {list.map((t) => <TagPill key={t} tag={t} state={kind} small onClick={() => cycle(t)} />)}
        <span style={{ fontSize: 11, color: "#8E99A1" }}>{list.length > 1 ? (inc ? (value.any ? "jobs with any of these" : "jobs with all of these") : (value.excAll ? "leave out jobs with all of these" : "leave out jobs with any of these")) : ""}</span>
      </div>
    );
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button className="chip st" data-on={open ? 1 : 0} onClick={() => setOpen((o) => !o)}>Tags{n ? ` (${n})` : ""} {open ? "▴" : "▾"}</button>
        {n > 0 && <button className="chip st" onClick={() => onChange(emptyTags())}>Clear tags</button>}
      </div>
      {(open || n > 0) && row("inc")}
      {(open || n > 0) && row("exc")}
      {open && (
        <div style={{ display: "grid", gap: 5, maxHeight: compact ? "38vh" : "none", overflow: "auto" }}>
          <div className="hint" style={{ padding: 0 }}>Tap once = include · twice = exclude · three times = clear</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start" }}>
            {groups.flatMap(([, tags]) => tags).map((t) => <TagPill key={t} tag={t} state={state(t)} count={counts[t]} filled onClick={() => cycle(t)} />)}
          </div>
        </div>
      )}
    </div>
  );
}
