import { useMemo, useState } from "react";
import TagPill from "./TagPill.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Filter jobs by their SingleOps tags. Tap a tag once = must have it (green),
   twice = must NOT have it (red), three times = ignore it again.
   "Match all / any" decides how several green tags combine.
   ═══════════════════════════════════════════════════════════════════════════ */

export const emptyTags = () => ({ inc: [], exc: [], any: false });
export const tagsActive = (f) => f.inc.length + f.exc.length > 0;
export function passTags(j, f) {
  const T = j.tags || [];
  if (f.exc.some((t) => T.includes(t))) return false;
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
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button className="chip st" data-on={open ? 1 : 0} onClick={() => setOpen((o) => !o)}>Tags{n ? ` (${n})` : ""} {open ? "▴" : "▾"}</button>
        {value.inc.map((t) => <TagPill key={t} tag={t} state="inc" small onClick={() => cycle(t)} />)}
        {value.exc.map((t) => <TagPill key={t} tag={t} state="exc" small onClick={() => cycle(t)} />)}
        {value.inc.length > 1 && <button className="chip st" onClick={() => onChange({ ...value, any: !value.any })}>{value.any ? "Match ANY green" : "Match ALL green"}</button>}
        {n > 0 && <button className="chip st" onClick={() => onChange(emptyTags())}>Clear tags</button>}
      </div>
      {open && (
        <div style={{ display: "grid", gap: 5, maxHeight: compact ? "38vh" : "none", overflow: "auto" }}>
          <div className="hint" style={{ padding: 0 }}>Tap once = must have · twice = must NOT have · three times = clear</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start" }}>
            {groups.flatMap(([, tags]) => tags).map((t) => <TagPill key={t} tag={t} state={state(t)} count={counts[t]} filled onClick={() => cycle(t)} />)}
          </div>
        </div>
      )}
    </div>
  );
}
