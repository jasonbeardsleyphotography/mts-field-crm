import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "./api";
import { C } from "./theme";
import { parseBacklogWorkbook } from "./parseWorkbook";
import { enrich, STATUS, STATUS_ORDER, FACETS, tagColor, tagShort, money, monthName, singleOpsJobUrl, ageColor, AGE_LEGEND } from "./backlogModel";
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
  priority: { label: "Priority", note: "past promise first · oldest first in each" },
  equipment: { label: "Equipment", note: "what the job needs · oldest first in each" },
  zone: { label: "Zone", note: "oldest first in each" },
};
const NO_EQUIP = "No special equipment";
const h1 = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString();
const sumTree = (l) => l.reduce((t, j) => t + (j.treeHrs || 0), 0);
const sumGrind = (l) => l.reduce((t, j) => t + (j.grindHrs || 0), 0);
const oldestFirst = (a, b) => (b.days || 0) - (a.days || 0);

function promiseText(j) {
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
              <rect x={x + bw * 0.12} y={H - hb} width={bw * 0.5} height={hb} fill={i === clearIdx ? "#5d7d6a" : "#56636c"} rx="1.5"><title>{`${monthName(m, true)}: ${Math.round(b)} backlog hours at the start`}</title></rect>
              <rect x={x + bw * 0.64} y={H - hc} width={bw * 0.22} height={hc} fill={C.green} opacity=".85" rx="1"><title>{`${monthName(m, true)}: ${Math.round(c)} crew hours available`}</title></rect>
              <text x={x + bw / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={C.inkDim} className="st">{monthName(m)}</text>
            </g>
          );
        })}
      </svg>
      <div className="hint">Grey: backlog hours left (start of month) · Green: crew hours available</div>
    </div>
  );
}

function JobCard({ j, selected, onSelect, cardRef, colorBy, zoneColors }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[j.status];
  const bar = colorBy === "zone" ? (zoneColors[j.zone] || C.edge) : colorBy === "age" ? ageColor(j.days) : st.color;
  return (
    <div ref={cardRef} className="card" onClick={() => onSelect(j.ref)}
         style={{ display: "flex", overflow: "hidden", cursor: "pointer", boxShadow: selected ? `0 0 0 2px ${C.ink}` : "none" }}>
      <div style={{ width: 5, background: bar, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, padding: "8px 10px" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{j.name}</b>
              {j.priority && <span title="On the Priority Work list" style={{ color: C.amber }}>★</span>}
              <span className="mono hint">#{j.ref}</span>
            </div>
            <div className="hint" style={{ marginTop: 1 }}>
              {j.town}{j.zone ? ` · Zone ${j.zone}` : ""}{j.crew ? ` · ${j.crew}` : ""}{j.rep ? ` · ${j.rep}` : ""}
            </div>
            <div style={{ marginTop: 3, fontSize: 12.5, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ color: ageColor(j.days), fontWeight: 600 }}>{j.days != null ? `${Math.round(j.days)} days waiting` : ""}</span>
              <span style={{ color: st.color }}>{promiseText(j)}</span>
            </div>
          </div>
          <JobHours j={j} />
          <span className="mono hint" style={{ minWidth: 52, textAlign: "right" }}>{money(j.price)}</span>
        </div>
        {(j.needs.length > 0 || j.tags.length > 0) && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {j.needs.map((n) => <span key={n} className="st" style={{ fontSize: 10, letterSpacing: ".05em", padding: "2px 6px", borderRadius: 2, background: "#2f3a43", color: C.ink }}>{n}</span>)}
            {j.tags.filter((t) => !/^0[23] /.test(t) || /REQUIRED|CLIMB|GROUND/.test(t)).map((t) => (
              <span key={t} className="st" style={{ fontSize: 10, letterSpacing: ".05em", padding: "2px 6px", borderRadius: 2, border: `1px solid ${C.edge}`, color: C.inkDim, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <i style={{ width: 6, height: 6, borderRadius: 3, background: tagColor(t) }} />{tagShort(t)}
              </span>
            ))}
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
            <span className="hint" style={{ alignSelf: "center" }}>{j.addr}{j.dueRange ? ` · window ${j.dueRange}` : ""}</span>
          </div>
        )}
      </div>
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
        <span className="mono" style={{ fontSize: 12, color: C.inkDim }}>{h1(sumTree(jobs))} h tree{sumGrind(jobs) ? ` · ${h1(sumGrind(jobs))} h stump` : ""}</span>
        {jobs.length > 0 && <span className="mono hint" style={{ color: ageColor(jobs[0].days) }}>oldest {Math.round(jobs[0].days || 0)} d</span>}
        <span className="hint">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div style={{ padding: 8, display: "grid", gap: 6, borderTop: `1px solid ${C.edgeSoft}` }}>{children}</div>}
    </div>
  );
}

export default function Backlog() {
  const [data, setData] = useState(undefined);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(new Set());
  const [facet, setFacet] = useState({});
  const [openFacet, setOpenFacet] = useState("");
  const [groupBy, setGroupBy] = useState(() => { try { return localStorage.getItem("mts-backlog-group") || "priority"; } catch { return "priority"; } });
  const [colorBy, setColorBy] = useState("age");
  const [closed, setClosed] = useState(() => new Set(["sched", "hold"]));
  const [selected, setSelected] = useState(null);
  const [limits, setLimits] = useState({});
  const [showForecast, setShowForecast] = useState(false);
  const fileRef = useRef(null);
  const cardRefs = useRef({});

  const load = async () => {
    try { const d = await api("backlog"); setData(d.empty ? null : d); setErr(""); }
    catch (e) { setErr(`Couldn't load the backlog (${e.message}).`); setData(null); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { try { localStorage.setItem("mts-backlog-group", groupBy); } catch {} }, [groupBy]);

  const upload = async (file) => {
    if (!file) return;
    setBusy(`Reading ${file.name}…`); setErr("");
    try {
      const parsed = await parseBacklogWorkbook(await file.arrayBuffer(), file.name);
      setBusy("Saving…");
      await api("backlog", { method: "PUT", body: parsed });
      await load(); setBusy("");
    } catch (e) { setBusy(""); setErr(e.status ? `Couldn't save it (${e.message}).` : (e.message || String(e))); }
  };

  const jobs = useMemo(() => (data ? enrich(data) : []), [data]);
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
      <input ref={fileRef} type="file" accept=".xlsm,.xlsx" style={{ display: "none" }} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      <button className="btn st" data-primary="1" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy || (data ? "Update from workbook" : "Upload the backlog workbook")}</button>
    </>
  );
  if (!data) return (
    <div className="wrap" style={{ maxWidth: 640 }}>
      <div className="card"><div className="card-b" style={{ display: "grid", gap: 12 }}>
        <div className="st" style={{ fontSize: 16 }}>No backlog loaded yet</div>
        <div className="hint">Upload the GTC Backlog workbook (.xlsm). Nothing is ever written back to it.</div>
        <div>{uploader}</div>
        {err && <div className="err">{err}</div>}
      </div></div>
    </div>
  );

  const sel = selected && jobs.find((j) => j.ref === selected);
  const filtersOn = q || status.size || Object.values(facet).some((s) => s.size);

  return (
    <div className="wrap" style={{ maxWidth: 1800 }}>
      {/* one slim line of totals + the status filters */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className="mono" style={{ fontSize: 13 }}>{shown.length} jobs · <b>{h1(sumTree(shown))} h tree work</b> · {h1(sumGrind(shown))} h stump grinding · {money(shown.reduce((t, j) => t + (j.price || 0), 0))}</span>
        <span className="spacer" />
        <span className="hint">{data.fileName}{data.asOf ? ` · sheet ${new Date(data.asOf + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span>
        {uploader}
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}

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
                  <JobCard key={j.ref} j={j} selected={selected === j.ref} onSelect={pick} colorBy={colorBy} zoneColors={zoneColors}
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
                      <b>{sel.name}</b> <span className="mono hint">#{sel.ref}</span>
                      <div className="hint">{sel.addr}</div>
                      <div style={{ fontSize: 12.5, marginTop: 3 }}><span style={{ color: ageColor(sel.days) }}>{Math.round(sel.days || 0)} days waiting</span> · <span style={{ color: STATUS[sel.status].color }}>{promiseText(sel)}</span></div>
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
            {colorBy === "age" && AGE_LEGEND.map(([d, l]) => <span key={d} className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 5, background: ageColor(d) }} />{l}</span>)}
            {colorBy === "status" && STATUS_ORDER.map((k) => <span key={k} className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 5, background: STATUS[k].color }} />{STATUS[k].label}</span>)}
            <span className="hint">{geoState || "Bigger dot = more tree-work hours. Tap a dot for the job."}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
