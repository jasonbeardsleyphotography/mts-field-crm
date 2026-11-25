import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "./api";
import { useBacklog } from "./useBacklog";
import { fmtH, useHoursUnit } from "./hours";
import { C } from "./theme";
import { importBacklogFiles } from "./parseWorkbook";
import TagPill from "./TagPill.jsx";
import { STATUS, STATUS_ORDER, FACETS, tagColor, tagShort, money, monthName, singleOpsJobUrl, jobColor, gradientColor, ageLegend, PAUSED_COLOR, SEASON_COLOR } from "./backlogModel";
import { EQUIPMENT_ORDER } from "./crewCheck";
import BacklogMap, { useJobPoints } from "./BacklogMap.jsx";
import JobHours from "./JobHours.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Backlog — managing the jobs, oldest first.
   Jobs are grouped by priority (past promise → due soon → on time → flexible →
   scheduled → on hold) or by the equipment they need, oldest first inside each
   group, with the map beside the list (coloured by age by default). Tree-work
   hours lead; stump grinding, cleanup and soil & seed are shown separately.
   Data: the last workbook uploaded (shared). Nothing is written back to Excel.
   ═══════════════════════════════════════════════════════════════════════════ */

const ZONE_PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1"];
const GROUPS = {
  oldest: { label: "Oldest", note: "every job, oldest first — no categories" },
  priority: { label: "Priority", note: "past promise first · oldest first in each" },
  equipment: { label: "Equipment", note: "what the job needs · oldest first in each" },
  zone: { label: "Zone", note: "oldest first in each" },
};
const NO_EQUIP = "No special equipment";
const sumTree = (l) => l.reduce((t, j) => t + (j.treeHrs || 0), 0);
const sumGrind = (l) => l.reduce((t, j) => t + (j.grindHrs || 0), 0);
const oldestFirst = (a, b) => (b.days || 0) - (a.days || 0);

export function promiseText(j) {
  if (j.status === "emergency" || j.status === "priority")
    return `${j.status === "emergency" ? "EMERGENCY" : "Priority"}${j.nextVisit ? " · scheduled" : ""}${j.lateWeeks > 0 ? ` · ${Math.round(j.lateWeeks)} wk past promise` : ""}`;
  if (j.status === "paused") return `Purgatory${j.paused?.until ? ` · check back ${new Date(j.paused.until + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`;
  if (j.dueText) return j.dueText;
  if (j.status === "sched") return `Scheduled ${new Date(j.nextVisit + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${j.visitWho ? ` · ${j.visitWho}` : ""}`;
  if (j.status === "hold") return "On hold";
  if (j.status === "flex") return "Flexible / seasonal";
  if (j.status === "over") return `${Math.round(j.lateWeeks)} wk past promise (${j.promisedLabel} wk)`;
  return `Due within ${Math.max(0, Math.round(j.diff))} wk (${j.promisedLabel} wk)`;
}

function Forecast({ f }) {
  if (!f || !f.months?.length) return <div className="hint">No forecast in this workbook.</div>;
  const n = f.months.length, bom = f.backlogBOM || [], cap = f.workableHrs || [];
  const max = Math.max(1, ...bom.map((v) => v || 0), ...cap.map((v) => v || 0));
  const W = 620, H = 160, pad = 26, bw = (W - pad) / n;
  const clearIdx = (f.backlogEOM || []).findIndex((v) => v != null && v <= 0);
  return (
    <div>
      <div className="hint" style={{ marginBottom: 6 }}>
        {clearIdx >= 0 ? <>At the workbook's pace the backlog is worked off during <b style={{ color: C.ink }}>{monthName(f.months[clearIdx], true)}</b>.</> : <>The backlog isn't worked off within these 12 months.</>}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} width="100%" style={{ display: "block", maxWidth: 720 }}>
        {f.months.map((m, i) => {
          const x = pad + i * bw, b = Math.max(0, bom[i] || 0), c = Math.max(0, cap[i] || 0);
          const hb = (b / max) * (H - 10), hc = (c / max) * (H - 10);
          return (
            <g key={m}>
              <rect x={x + bw * 0.12} y={H - hb} width={bw * 0.5} height={hb} fill={i === clearIdx ? "#5d7d6a" : "#56636c"} rx="1.5"><title>{`${monthName(m, true)}: ${fmtH(b, 0)} backlog at the start`}</title></rect>
              <rect x={x + bw * 0.64} y={H - hc} width={bw * 0.22} height={hc} fill={C.green} opacity=".85" rx="1"><title>{`${monthName(m, true)}: ${fmtH(c, 0)} crew time available`}</title></rect>
              <text x={x + bw / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={C.inkDim} className="st">{monthName(m)}</text>
            </g>
          );
        })}
      </svg>
      <div className="hint">Grey: backlog hours left (start of month) · Green: crew hours available</div>
    </div>
  );
}

/** Put a job on pause (or edit why), with an optional date to check back. */
export function PauseForm({ j, onPause, onResume, onDone }) {
  const [reason, setReason] = useState(j.paused?.reason || "");
  const [until, setUntil] = useState(j.paused?.until || "");
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const go = async (fn) => { setBusy(true); setErr(""); try { await fn(); onDone?.(); } catch (e) { setErr(`Couldn't save (${e.message}).`); } setBusy(false); };
  return (
    <div style={{ display: "grid", gap: 6, padding: 8, border: `1px solid ${PAUSED_COLOR}`, borderRadius: 3, background: "rgba(179,136,255,.07)" }} onClick={(e) => e.stopPropagation()}>
      <div className="hint" style={{ padding: 0 }}>Why can't it be scheduled yet? Shown on the card as “{j.name}: …”. Jobs in Purgatory never count as late.{j.paused?.soHold ? " (It's on hold in SingleOps — take it off hold there to bring it back.)" : ""}</div>
      <input className="inp" autoFocus placeholder="e.g. wants to meet again with Jason first" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter" && reason.trim()) go(() => onPause(j.ref, reason.trim(), until)); }} />
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="hint" style={{ padding: 0 }}>Check back on (optional)</span>
        <input className="inp" type="date" style={{ width: "auto" }} value={until} onChange={(e) => setUntil(e.target.value)} />
        <span className="spacer" />
        {j.paused && !j.paused.soHold && <button className="btn st" disabled={busy} onClick={() => go(() => onResume(j.ref))}>Back to the backlog</button>}
        <button className="btn st" data-primary="1" disabled={busy || !reason.trim()} onClick={() => go(() => onPause(j.ref, reason.trim(), until))}>{j.paused && !j.paused.soHold ? "Save" : "Move to Purgatory"}</button>
        <button className="btn st" onClick={() => onDone?.()}>Cancel</button>
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

/** Purgatory as a pop-up (owner, Nov 24) — over the page, not squeezed into a row. */
export function PurgatoryModal({ j, onPause, onResume, onClose }) {
  if (!j) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1500, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", padding: 16, display: "grid", gap: 10, borderTop: `4px solid ${PAUSED_COLOR}`, boxShadow: "0 18px 50px rgba(0,0,0,.6)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <b className="st" style={{ fontSize: 15, color: "#d7c4ff" }}>⏸ Purgatory</b>
          <span style={{ fontSize: 14 }}><b>{j.name}</b> <span className="mono hint">#{j.ref}</span></span>
          <span className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="hint" style={{ padding: 0, lineHeight: 1.5 }}>
          Jobs in Purgatory are left off the schedule and never count as late. If you set a <b style={{ color: C.ink }}>check-back date</b>,
          then from that day on the job is shown in a big <b style={{ color: "#f0c050" }}>⏰ Check back</b> banner at the top of the Schedule and the
          Backlog, and its card is flagged, until you either bring it back to the backlog or give it a new date. It never leaves Purgatory by itself.
        </div>
        <PauseForm j={j} onPause={onPause} onResume={onResume} onDone={onClose} />
      </div>
    </div>
  );
}

/** Purgatory jobs whose check-back date has come: a big, can't-miss banner. */
export function CheckBackBanner({ jobs, onResume, onEdit }) {
  const due = jobs.filter((j) => j.checkBack && j.paused && !j.paused.soHold);
  if (!due.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 5, background: "linear-gradient(90deg, rgba(229,161,0,.22), rgba(179,136,255,.18))", border: "2px solid #E5A100", boxShadow: "0 0 0 3px rgba(229,161,0,.15), 0 6px 18px rgba(0,0,0,.35)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
        <b className="st" style={{ fontSize: 15, color: "#ffd166" }}>⏰ Check back · {due.length} job{due.length === 1 ? "" : "s"} from Purgatory</b>
        <span style={{ fontSize: 12, color: "#e8dcc0" }}>Their check-back day has come. Call them, then bring them back to the backlog or set a new date.</span>
      </div>
      <div style={{ display: "grid", gap: 5 }}>
        {due.map((j) => (
          <div key={j.ref} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "rgba(0,0,0,.25)", padding: "6px 8px", borderRadius: 3 }}>
            <b>{j.name}:</b><span style={{ color: "#d7c4ff" }}>{j.paused.reason}</span>
            <span className="hint" style={{ padding: 0 }}>check back {j.paused.until === today ? "today" : `since ${new Date(j.paused.until + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}{j.phone ? ` · ${j.phone}` : ""}</span>
            <span className="spacer" />
            <button className="btn st" data-primary="1" onClick={() => onResume(j.ref)}>Back to the backlog</button>
            <button className="btn st" onClick={() => onEdit(j)}>New date…</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Delete a job from the Dispatch backlog — asks first. */
export function DeleteConfirm({ j, onDelete, onDone }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  return (
    <div style={{ padding: 8, border: "1px solid #D93B2B", borderRadius: 3, background: "rgba(217,59,43,.08)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
      <span style={{ fontSize: 12.5 }}>Delete <b>{j.name}</b> (#{j.ref}) from the Dispatch backlog? It won't come back on the next import; you can restore it from "deleted" at the top.</span>
      <button className="btn st" data-danger="1" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(j.ref, j.name); onDone?.(); } catch (e) { setErr(`Couldn't delete (${e.message}).`); } setBusy(false); }}>Yes, delete</button>
      <button className="btn st" onClick={() => onDone?.()}>Cancel</button>
      {err && <span className="err">{err}</span>}
    </div>
  );
}

/** "When will we get there?" — the promise window in Mon–Fri weeks, or the season countdown. */
export function LandLine({ j, size = 12.5 }) {
  if (j.nextVisit) return <div style={{ fontSize: size, color: "#9cc4e4" }}>Scheduled {new Date(j.nextVisit + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}{j.visitWho ? ` · ${j.visitWho}` : ""}</div>;
  if (j.seasonal) return <div style={{ fontSize: size, color: SEASON_COLOR }}>⏳ {j.dueText}</div>;
  if (j.land) return <div style={{ fontSize: size, color: /overdue/.test(j.land.text) ? "#ff9a8f" : "#d9d4c8" }}>📅 {j.land.text}</div>;
  if ((j.promised ?? 99) >= 99) return <div className="hint" style={{ padding: 0 }}>Flexible (99) — no promised window</div>;
  return null;
}

function JobCard({ j, selected, onSelect, cardRef, colorBy, zoneColors, onPause, onResume, onDelete }) {
  const [open, setOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const st = STATUS[j.status];
  const bar = colorBy === "zone" ? (zoneColors[j.zone] || C.edge) : colorBy === "age" ? jobColor(j) : st.color;
  return (
    <div ref={cardRef} className="card" onClick={() => onSelect(j.ref)}
         style={{ display: "flex", overflow: "hidden", cursor: "pointer", boxShadow: selected ? `0 0 0 2px ${C.ink}` : "none" }}>
      <div style={{ width: 5, background: bar, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, padding: "8px 10px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{j.name}{j.paused ? ":" : ""}</b>
              {j.paused && <span style={{ fontSize: 13.5, color: "#d7c4ff" }}>{j.paused.reason}</span>}
              {j.priority && <span title="On the Priority Work list" style={{ color: C.amber }}>★</span>}
              <span className="mono hint">#{j.ref}</span>
            </div>
            <div className="hint" style={{ marginTop: 1 }}>
              {j.town}{j.zone ? ` · Zone ${j.zone}` : ""}{j.crew ? ` · ${j.crew}` : ""}{j.rep ? ` · ${j.rep}` : ""}
            </div>
            <div style={{ marginTop: 3, fontSize: 12.5, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ color: jobColor(j), fontWeight: 600 }}>{j.days != null ? `${Math.round(j.days)} days waiting` : ""}</span>
              <span style={{ color: st.color }}>{promiseText(j)}</span>
              {j.checkBack && <span className="st" style={{ fontSize: 10.5, background: PAUSED_COLOR, color: "#1b1426", padding: "1px 6px", borderRadius: 2 }}>Check back now</span>}
              {j.paused && <span className="hint" style={{ padding: 0 }}>paused by {j.paused.by}</span>}
            </div>
            <LandLine j={j} />
          </div>
          <JobHours j={j} />
          <span className="mono hint" style={{ minWidth: 52, textAlign: "right" }}>{money(j.price)}</span>
        </div>
        {(j.needs.length > 0 || j.tags.length > 0) && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {j.tags.map((t) => <TagPill key={t} tag={t} small />)}
          </div>
        )}
        {j.note && (
          <div onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
               style={{ marginTop: 6, fontSize: 12.5, color: "#c8ced2", lineHeight: 1.45, ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }) }}>
            {j.note}
          </div>
        )}
        {selected && (
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
            <a className="btn st" href={singleOpsJobUrl(j.ref)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>Open in SingleOps</a>
            <a className="btn st" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(j.addr)}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>Address</a>
            <button className="btn st" style={{ borderColor: PAUSED_COLOR }} onClick={() => { setDeleting(false); setPausing((v) => !v); }}>{j.paused ? "Purgatory: edit / bring back" : "⏸ Purgatory…"}</button>
            <button className="btn st" data-danger="1" onClick={() => { setPausing(false); setDeleting((v) => !v); }}>🗑 Delete…</button>
            <span className="hint" style={{ alignSelf: "center" }}>{j.addr}{j.dueRange ? ` · window ${j.dueRange}` : ""}</span>
          </div>
        )}
        {selected && pausing && <PurgatoryModal j={j} onPause={onPause} onResume={onResume} onClose={() => setPausing(false)} />}
        {selected && deleting && <div style={{ marginTop: 8 }}><DeleteConfirm j={j} onDelete={onDelete} onDone={() => setDeleting(false)} /></div>}
      </div>
    </div>
  );
}

function CallActions({ j, pause, resume, remove }) {
  const [act, setAct] = useState(null);
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <a className="btn st" href={singleOpsJobUrl(j.ref)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>Open in SingleOps</a>
        <button className="btn st" style={{ borderColor: PAUSED_COLOR }} onClick={() => setAct((a) => (a === "pause" ? null : "pause"))}>{j.paused ? "Purgatory: edit / bring back" : "⏸ Purgatory…"}</button>
        <button className="btn st" data-danger="1" onClick={() => setAct((a) => (a === "del" ? null : "del"))}>🗑 Delete…</button>
      </div>
      {act === "pause" && <PurgatoryModal j={j} onPause={pause} onResume={resume} onClose={() => setAct(null)} />}
      {act === "del" && <DeleteConfirm j={j} onDelete={remove} onDone={() => setAct(null)} />}
    </div>
  );
}

function Group({ title, color, jobs, open, onToggle, children }) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderLeft: `4px solid ${color || C.edge}`, textAlign: "left", background: C.panel }}>
        <span className="st" style={{ fontSize: 13.5, color: C.ink }}>{title}</span>
        <span className="mono hint">{jobs.length} job{jobs.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <span className="mono" style={{ fontSize: 12, color: C.inkDim }}>{fmtH(sumTree(jobs))} tree{sumGrind(jobs) ? ` · ${fmtH(sumGrind(jobs))} stump` : ""}</span>
        {jobs.length > 0 && <span className="mono hint" style={{ color: jobColor(jobs[0]) }}>oldest {Math.round(jobs[0].days || 0)} d</span>}
        <span className="hint">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div style={{ padding: 8, display: "grid", gap: 6, borderTop: `1px solid ${C.edgeSoft}` }}>{children}</div>}
    </div>
  );
}

export default function Backlog() {
  useHoursUnit();
  const { data, jobs, err: loadErr, load, pause, resume, deleted, restore, remove } = useBacklog();
  const [callQ, setCallQ] = useState("");
  const [purgJob, setPurgJob] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(new Set());
  const [facet, setFacet] = useState({});
  const [openFacet, setOpenFacet] = useState("");
  const [groupBy, setGroupBy] = useState(() => { try { return localStorage.getItem("mts-backlog-group") || "priority"; } catch { return "priority"; } });
  const [colorBy, setColorBy] = useState("age");
  const [closed, setClosed] = useState(() => new Set(["sched", "hold", "season"]));
  const [selected, setSelected] = useState(null);
  const [limits, setLimits] = useState({});
  const [showForecast, setShowForecast] = useState(false);
  const fileRef = useRef(null);
  const cardRefs = useRef({});

  useEffect(() => { try { localStorage.setItem("mts-backlog-group", groupBy); } catch {} }, [groupBy]);

  const [summary, setSummary] = useState([]);
  /* SingleOps Visit export (.csv) + optional line-item report (.csv), or the GTC Backlog workbook. */
  const upload = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setBusy(`Reading ${files.map((f) => f.name).join(", ")}…`); setErr(""); setSummary([]);
    try {
      const { data: parsed, summary: sum } = await importBacklogFiles(await Promise.all(files.map(async (f) => ({ name: f.name, buf: await f.arrayBuffer() }))), data || null);
      setBusy("Saving…");
      await api("backlog", { method: "PUT", body: parsed });
      await load();
      setBusy(""); setSummary(sum);
    } catch (e) { setBusy(""); setErr(e.status ? `Couldn't save it (${e.message}).` : (e.message || String(e))); }
  };

  const { points, state: geoState } = useJobPoints(jobs);
  const zoneColors = useMemo(() => {
    const zs = [...new Set(jobs.map((j) => j.zone))].sort((a, b) => (parseFloat(a) || 999) - (parseFloat(b) || 999));
    return Object.fromEntries(zs.map((z, i) => [z, ZONE_PALETTE[i % ZONE_PALETTE.length]]));
  }, [jobs]);

  const passFacets = (j, skip) => Object.entries(facet).every(([k, set]) => {
    if (k === skip || !set.size) return true;
    const v = FACETS[k].of(j);
    return Array.isArray(v) ? v.some((x) => set.has(x)) : set.has(v);
  });
  const passText = (j) => { const s = q.trim().toLowerCase(); return !s || `${j.name} ${j.ref} ${j.addr} ${j.note} ${j.tags.join(" ")} ${j.rep}`.toLowerCase().includes(s); };
  const shown = useMemo(() => jobs.filter((j) => passText(j) && passFacets(j) && (!status.size || status.has(j.status))).sort(oldestFirst),
    [jobs, q, facet, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    if (groupBy === "equipment") {
      return [...EQUIPMENT_ORDER, NO_EQUIP].map((k) => ({ key: k, title: k, color: k === NO_EQUIP ? C.edge : "#6d8796", jobs: shown.filter((j) => (k === NO_EQUIP ? !j.needs.length : j.needs.includes(k))) })).filter((g) => g.jobs.length);
    }
    if (groupBy === "zone") {
      const zs = [...new Set(shown.map((j) => j.zone || "—"))].sort((a, b) => (parseFloat(a) || 999) - (parseFloat(b) || 999));
      return zs.map((z) => ({ key: z, title: /^\d/.test(z) ? `Zone ${z}` : z, color: zoneColors[z], jobs: shown.filter((j) => (j.zone || "—") === z) }));
    }
    if (groupBy === "oldest") return [{ key: "all", title: "All jobs — oldest first", color: C.edge, jobs: shown }];
    return STATUS_ORDER.map((k) => ({ key: k, title: STATUS[k].label, color: STATUS[k].color, jobs: shown.filter((j) => j.status === k) })).filter((g) => g.jobs.length);
  }, [shown, groupBy, zoneColors]);

  const pick = (ref) => {
    setSelected((s) => (s === ref ? null : ref));
    const j = jobs.find((x) => x.ref === ref); if (!j) return;
    const g = groups.find((x) => x.jobs.some((y) => y.ref === ref));
    if (g) {
      setClosed((c) => { const n = new Set(c); n.delete(g.key); return n; });
      const idx = g.jobs.findIndex((y) => y.ref === ref);
      if (idx >= (limits[g.key] || 25)) setLimits((l) => ({ ...l, [g.key]: idx + 10 }));
    }
    setTimeout(() => cardRefs.current[ref]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
  };
  const toggleSet = (set, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };
  const facetCounts = (k) => {
    const counts = new Map();
    jobs.forEach((j) => {
      if (!passText(j) || !passFacets(j, k) || (status.size && !status.has(j.status))) return;
      const v = FACETS[k].of(j);
      (Array.isArray(v) ? v : [v]).forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
    });
    const vals = [...counts.entries()];
    return k === "zone" ? vals.sort((a, b) => (parseFloat(a[0]) || 999) - (parseFloat(b[0]) || 999)) : vals.sort((a, b) => b[1] - a[1]);
  };

  if (data === undefined) return <div className="wrap hint">Loading the backlog…</div>;

  const uploader = (
    <>
      <input ref={fileRef} type="file" accept=".csv,.xlsm,.xlsx" multiple style={{ display: "none" }} onChange={(e) => { const l = [...(e.target.files || [])]; e.target.value = ""; upload(l); }} />
      <button className="btn st" data-primary="1" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy || (data ? "Update from SingleOps" : "Upload the backlog")}</button>
    </>
  );
  if (!data) return (
    <div className="wrap" style={{ maxWidth: 640 }}>
      <div className="card"><div className="card-b" style={{ display: "grid", gap: 12 }}>
        <div className="st" style={{ fontSize: 16 }}>No backlog loaded yet</div>
        <div className="hint">Upload the SingleOps <b>Visit export</b> (.csv) — plus, if you like, the line-item report for stump / soil & seed hours — or the GTC Backlog workbook (.xlsm). Nothing is ever written back.</div>
        <div>{uploader}</div>
        {(err || loadErr) && <div className="err">{err || loadErr}</div>}
      </div></div>
    </div>
  );

  const sel = selected && jobs.find((j) => j.ref === selected);
  const legend = ageLegend(jobs);
  const filtersOn = q || status.size || Object.values(facet).some((s) => s.size);

  const callHits = (() => {
    const t = callQ.trim().toLowerCase(); if (t.length < 2) return [];
    const digits = t.replace(/\D/g, "");
    return jobs.filter((j) => `${j.name} ${j.last} ${j.ref} ${j.addr} ${j.email || ""}`.toLowerCase().includes(t)
      || (digits.length >= 4 && String(j.phone || "").replace(/\D/g, "").includes(digits))).slice(0, 6);
  })();
  return (
    <div className="wrap" style={{ maxWidth: 1800 }}>
      <CheckBackBanner jobs={jobs} onResume={resume} onEdit={(j) => setPurgJob(j)} />
      {purgJob && <PurgatoryModal j={purgJob} onPause={pause} onResume={resume} onClose={() => setPurgJob(null)} />}
      {/* someone's on the phone: where does their job land? */}
      <div className="card" style={{ padding: 10, marginBottom: 10, borderLeft: `4px solid ${C.blue}` }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b className="st" style={{ fontSize: 13 }}>📞 Someone calling?</b>
          <input className="inp" style={{ flex: "1 1 280px", maxWidth: 520, fontSize: 15 }} placeholder="Type their name, street, phone or job #" value={callQ} onChange={(e) => setCallQ(e.target.value)} />
          {callQ && <button className="btn st" onClick={() => setCallQ("")}>Clear</button>}
          <span className="hint" style={{ padding: 0 }}>Weeks are Mon–Fri work weeks counted from the day it was accepted (13 weeks after Wed Jul 1 = Wed Sep 30).</span>
        </div>
        {callQ.trim().length >= 2 && (
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {callHits.map((j) => (
              <div key={j.ref} style={{ padding: "8px 10px", background: C.tile, borderRadius: 3, borderLeft: `4px solid ${jobColor(j)}` }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <b style={{ fontSize: 15 }}>{j.name}</b> <span className="mono hint">#{j.ref}</span>
                    <div className="hint" style={{ padding: 0 }}>{j.addr}{j.phone ? ` · ${j.phone}` : ""}</div>
                    <div style={{ marginTop: 4, fontWeight: 600 }}><LandLine j={j} size={15.5} /></div>
                    <div style={{ fontSize: 12.5, marginTop: 2, color: STATUS[j.status].color }}>{STATUS[j.status].label}{j.paused ? ` — ${j.paused.reason}` : ""} · {Math.round(j.days || 0)} days since it was sold</div>
                  </div>
                  <JobHours j={j} />
                </div>
                {j.tags.length > 0 && <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 6 }}>{j.tags.map((t) => <TagPill key={t} tag={t} small />)}</div>}
                {j.note && <div style={{ marginTop: 6, fontSize: 12.5, color: "#c8ced2", whiteSpace: "pre-wrap" }}>{j.note}</div>}
                <CallActions j={j} pause={pause} resume={resume} remove={remove} />
              </div>
            ))}
            {!callHits.length && <div className="hint">No job matches “{callQ}”.</div>}
          </div>
        )}
      </div>
      {/* one slim line of totals + the status filters */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className="mono" style={{ fontSize: 13 }}>{shown.length} jobs · <b>{fmtH(sumTree(shown))} tree work</b> · {fmtH(sumGrind(shown))} stump grinding · {money(shown.reduce((t, j) => t + (j.price || 0), 0))}</span>
        <span className="spacer" />
        <span className="hint">{data.source === "singleops-visit-csv" ? "SingleOps visit export" : data.fileName}{data.asOf ? ` · ${data.source === "singleops-visit-csv" ? "as of" : "sheet"} ${new Date(data.asOf + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>
        {uploader}
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {summary.length > 0 && (
        <div className="card" style={{ padding: "8px 12px", marginBottom: 8, borderLeft: `4px solid ${C.green}`, fontSize: 12.5, display: "grid", gap: 2 }}>
          <b className="st" style={{ fontSize: 12 }}>Updated</b>
          {summary.map((l, i) => <span key={i}>{l}</span>)}
          <span className="hint" style={{ padding: 0 }}>Choose the files together: SingleOps → Visits → Export (CSV); optionally the line-item report too. The workbook still works.</span>
          <button className="chip st" style={{ justifySelf: "start" }} onClick={() => setSummary([])}>OK</button>
        </div>
      )}
      {Object.keys(deleted).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <button className="chip st" data-on={showDeleted ? 1 : 0} onClick={() => setShowDeleted((v) => !v)}>{Object.keys(deleted).length} deleted {showDeleted ? "▴" : "▾"}</button>
          {showDeleted && (
            <div className="card" style={{ marginTop: 6, padding: 8, display: "grid", gap: 4 }}>
              {Object.entries(deleted).sort((a, b) => b[1].at - a[1].at).map(([ref, d]) => (
                <div key={ref} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <b>{d.name || ref}</b><span className="hint" style={{ padding: 0 }}>#{ref} · deleted by {d.by} {new Date(d.at).toLocaleDateString()}</span>
                  <span className="spacer" />
                  <button className="btn st" onClick={() => restore(ref)}>Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-b" style={{ display: "grid", gap: 8, padding: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="lbl st">Group</span>
            {Object.entries(GROUPS).map(([k, g]) => <button key={k} className="chip st" data-on={groupBy === k ? 1 : 0} onClick={() => setGroupBy(k)}>{g.label}</button>)}
            <span className="hint">{GROUPS[groupBy].note}</span>
            <span className="spacer" />
            <input className="inp" style={{ width: 260 }} placeholder="Search name, job #, street, note, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
            {STATUS_ORDER.map((k) => {
              const n = jobs.filter((j) => j.status === k).length;
              return <button key={k} className="chip st" data-on={status.has(k) ? 1 : 0} onClick={() => setStatus((s) => toggleSet(s, k))}
                             style={{ borderColor: status.has(k) ? STATUS[k].color : undefined }}><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: STATUS[k].color, marginRight: 5 }} />{STATUS[k].label}<b>{n}</b></button>;
            })}
            <span className="vr" style={{ width: 1, height: 18, background: C.edge, margin: "0 4px" }} />
            {Object.entries(FACETS).map(([k, fc]) => (
              <button key={k} className="chip st" data-on={openFacet === k || facet[k]?.size ? 1 : 0} onClick={() => setOpenFacet((o) => (o === k ? "" : k))}>
                {fc.label}{facet[k]?.size ? ` (${facet[k].size})` : ""} {openFacet === k ? "▴" : "▾"}
              </button>
            ))}
            {filtersOn && <button className="btn st" onClick={() => { setQ(""); setStatus(new Set()); setFacet({}); }}>Clear</button>}
          </div>
          {openFacet && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {facetCounts(openFacet).map(([v, c]) => (
                <button key={v} className="chip st" data-on={facet[openFacet]?.has(v) ? 1 : 0}
                        onClick={() => setFacet((fc) => ({ ...fc, [openFacet]: toggleSet(fc[openFacet] || new Set(), v) }))}>{v}<b>{c}</b></button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,520px),1fr))", gap: 12, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((g) => {
            const open = !closed.has(g.key), lim = limits[g.key] || 25;
            return (
              <Group key={g.key} title={g.title} color={g.color} jobs={g.jobs} open={open} onToggle={() => setClosed((c) => toggleSet(c, g.key))}>
                {g.jobs.slice(0, lim).map((j) => (
                  <JobCard key={j.ref} j={j} selected={selected === j.ref} onSelect={pick} colorBy={colorBy} zoneColors={zoneColors} onPause={pause} onResume={resume} onDelete={remove}
                           cardRef={(el) => { if (el) cardRefs.current[j.ref] = el; }} />
                ))}
                {g.jobs.length > lim && <button className="btn st" onClick={() => setLimits((l) => ({ ...l, [g.key]: lim + 50 }))}>Show {Math.min(50, g.jobs.length - lim)} more of {g.jobs.length - lim}</button>}
              </Group>
            );
          })}
          {!groups.length && <div className="hint">No jobs match.</div>}
          <div className="card">
            <button className="card-h st" style={{ width: "100%" }} onClick={() => setShowForecast((v) => !v)}>Capacity forecast (from the workbook)<span className="spacer" />{showForecast ? "▴" : "▾"}</button>
            {showForecast && <div className="card-b"><Forecast f={data.forecast} /></div>}
          </div>
        </div>

        <div className="card" style={{ position: "sticky", top: 70 }}>
          <div className="card-h st" style={{ gap: 6 }}>
            Map
            <span className="spacer" />
            {[["age", "By age"], ["status", "By priority"], ["zone", "By zone"]].map(([k, l]) => <button key={k} className="chip st" data-on={colorBy === k ? 1 : 0} onClick={() => setColorBy(k)}>{l}</button>)}
          </div>
          <div style={{ height: "min(72vh, 760px)" }}>
            <BacklogMap jobs={shown} points={points} selected={selected} onPick={pick} colorBy={colorBy} zoneColors={zoneColors}>
              {sel && (
                <div className="card" style={{ position: "absolute", left: 10, right: 10, bottom: 10, padding: "10px 12px", background: "rgba(27,33,38,.97)", boxShadow: "0 6px 20px rgba(0,0,0,.5)", zIndex: 5 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{sel.name}{sel.paused ? ":" : ""}</b> {sel.paused && <span style={{ color: "#d7c4ff" }}>{sel.paused.reason}</span>} <span className="mono hint">#{sel.ref}</span>
                      <div className="hint">{sel.addr}</div>
                      <div style={{ fontSize: 12.5, marginTop: 3 }}><span style={{ color: jobColor(sel) }}>{Math.round(sel.days || 0)} days waiting</span> · <span style={{ color: STATUS[sel.status].color }}>{promiseText(sel)}</span></div>
                      {sel.needs.length > 0 && <div className="hint" style={{ marginTop: 3 }}>Needs: {sel.needs.join(", ")}</div>}
                    </div>
                    <JobHours j={sel} />
                    <button className="btn" onClick={() => setSelected(null)} aria-label="Close">✕</button>
                  </div>
                </div>
              )}
            </BacklogMap>
          </div>
          <div style={{ padding: "6px 10px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {colorBy === "age" && (
              <>
                <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  newest <i style={{ width: 120, height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${[0, .125, .25, .375, .5, .625, .75, .875, 1].map(gradientColor).join(",")})` }} /> oldest
                </span>
                <span className="hint">({legend.map(([, l]) => l).join(" · ")})</span>
                <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 5, background: SEASON_COLOR }} />waiting for season</span>
                <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 5, background: PAUSED_COLOR }} />purgatory</span>
              </>
            )}
            {colorBy === "status" && STATUS_ORDER.map((k) => <span key={k} className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 5, background: STATUS[k].color }} />{STATUS[k].label}</span>)}
            <span className="hint">{geoState || "Bigger dot = more tree work. Tap a dot for the job."}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
