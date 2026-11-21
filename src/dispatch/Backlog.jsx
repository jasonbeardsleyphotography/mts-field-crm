import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "./api";
import { C } from "./theme";
import { parseBacklogWorkbook } from "./parseWorkbook";
import { enrich, STATUS, STATUS_ORDER, FACETS, tagColor, tagShort, money, hrs, monthName, singleOpsJobUrl } from "./backlogModel";
import BacklogMap, { useJobPoints } from "./BacklogMap.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Backlog dashboard — the GTC Backlog workbook, made readable.
   Data: the last workbook someone uploaded (stored on the server, shared by
   everyone with Dispatch access). Filters and sort are per viewer and change
   nothing in the workbook.
   ═══════════════════════════════════════════════════════════════════════════ */

const SORTS = {
  late:   { label: "Most past promise", fn: (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || b.lateWeeks - a.lateWeeks || (a.diff ?? 99) - (b.diff ?? 99) },
  wait:   { label: "Waiting longest",   fn: (a, b) => (b.days || 0) - (a.days || 0) },
  hours:  { label: "Most hours",        fn: (a, b) => (b.hrs || 0) - (a.hrs || 0) },
  money:  { label: "Highest $",         fn: (a, b) => (b.price || 0) - (a.price || 0) },
  zone:   { label: "Zone",              fn: (a, b) => (parseFloat(a.zone) || 999) - (parseFloat(b.zone) || 999) || (a.town || "").localeCompare(b.town || "") },
};
const ZONE_PALETTE = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1"];

function Tile({ label, value, sub, color, onClick, on }) {
  return (
    <button onClick={onClick} className="card" disabled={!onClick}
            style={{ textAlign: "left", padding: "10px 12px", borderLeft: `3px solid ${color || C.edge}`, cursor: onClick ? "pointer" : "default",
                     background: on ? C.tileHi : C.panel, minWidth: 0 }}>
      <div className="lbl st">{label}</div>
      <div className="mono" style={{ fontSize: 22, marginTop: 4, lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="hint" style={{ marginTop: 3, fontSize: 11 }}>{sub}</div>}
    </button>
  );
}

function Forecast({ f }) {
  if (!f || !f.months?.length) return <div className="hint">No forecast in this workbook.</div>;
  const n = f.months.length;
  const bom = f.backlogBOM || [];
  const cap = f.workableHrs || [];
  const max = Math.max(1, ...bom.map((v) => v || 0), ...cap.map((v) => v || 0));
  const W = 620, H = 190, pad = 26, bw = (W - pad) / n;
  const clearIdx = (f.backlogEOM || []).findIndex((v) => v != null && v <= 0);
  return (
    <div>
      <div className="hint" style={{ marginBottom: 6 }}>
        {clearIdx >= 0
          ? <>At the workbook's pace the backlog is worked off during <b style={{ color: C.ink }}>{monthName(f.months[clearIdx], true)}</b>.</>
          : <>The backlog isn't worked off within these 12 months.</>}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} width="100%" style={{ display: "block" }} role="img" aria-label="Backlog hours remaining and crew hours available, by month">
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad} x2={W} y1={H - t * (H - 10)} y2={H - t * (H - 10)} stroke={C.edgeSoft} />
            <text x={pad - 4} y={H - t * (H - 10) + 3} textAnchor="end" fontSize="9" fill={C.inkFaint} className="mono">{Math.round(max * t / 100) / 10}k</text>
          </g>
        ))}
        {f.months.map((m, i) => {
          const x = pad + i * bw;
          const b = Math.max(0, bom[i] || 0), c = Math.max(0, cap[i] || 0);
          const hb = (b / max) * (H - 10), hc = (c / max) * (H - 10);
          return (
            <g key={m}>
              <rect x={x + bw * 0.12} y={H - hb} width={bw * 0.5} height={hb} fill={i === clearIdx ? "#5d7d6a" : "#56636c"} rx="1.5">
                <title>{`${monthName(m, true)}: ${Math.round(b)} backlog hours at the start`}</title>
              </rect>
              <rect x={x + bw * 0.64} y={H - hc} width={bw * 0.22} height={hc} fill={C.green} opacity=".85" rx="1">
                <title>{`${monthName(m, true)}: ${Math.round(c)} crew hours available (after priority work)`}</title>
              </rect>
              <text x={x + bw / 2} y={H + 14} textAnchor="middle" fontSize="10" fill={i === clearIdx ? C.ink : C.inkDim} className="st">{monthName(m)}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 4 }} className="hint">
        <span><i style={{ display: "inline-block", width: 10, height: 10, background: "#56636c", marginRight: 5 }} />Backlog hours left (start of month)</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, background: C.green, marginRight: 5 }} />Crew hours available</span>
      </div>
    </div>
  );
}

function JobCard({ j, selected, onSelect, cardRef }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[j.status];
  const promise =
    j.status === "sched" ? `Scheduled ${new Date(j.nextVisit + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${j.visitWho ? ` · ${j.visitWho}` : ""}` :
    j.status === "hold" ? "On hold" :
    j.status === "flex" ? "Flexible / seasonal (99)" :
    j.status === "over" ? `${Math.round(j.lateWeeks)} wk past promise (${j.promisedLabel} wk)` :
    `Due within ${Math.max(0, Math.round(j.diff))} wk (${j.promisedLabel} wk)`;
  return (
    <div ref={cardRef} className="card" onClick={() => onSelect(j.ref)}
         style={{ display: "flex", overflow: "hidden", cursor: "pointer", boxShadow: selected ? `0 0 0 2px ${C.ink}` : "none" }}>
      <div style={{ width: 4, background: st.color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, padding: "9px 11px" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <b style={{ fontSize: 14 }}>{j.name}</b>
          {j.priority && <span title="On the Priority Work list" style={{ color: C.amber }}>★</span>}
          <span className="mono hint">#{j.ref}</span>
          <span className="spacer" />
          <span className="mono" style={{ fontSize: 13 }}>{hrs(j.hrs)}</span>
          <span className="mono hint">{money(j.price)}</span>
        </div>
        <div className="hint" style={{ marginTop: 2 }}>
          {j.town}{j.zone ? ` · Zone ${j.zone}` : ""}{j.rep ? ` · ${j.rep}` : ""}{j.days != null ? ` · waiting ${Math.round(j.days)} days` : ""}
        </div>
        <div style={{ marginTop: 4, fontSize: 12.5, color: st.color, fontWeight: 600 }}>{promise}</div>
        {j.tags.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {j.tags.map((t) => (
              <span key={t} className="st" style={{ fontSize: 10, letterSpacing: ".05em", padding: "2px 6px", borderRadius: 2,
                    border: `1px solid ${C.edge}`, color: C.inkDim, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <i style={{ width: 6, height: 6, borderRadius: 3, background: tagColor(t) }} />{tagShort(t)}
              </span>
            ))}
          </div>
        )}
        {j.note && (
          <div onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
               style={{ marginTop: 6, fontSize: 12.5, color: "#c8ced2", lineHeight: 1.45,
                        ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }) }}>
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

export default function Backlog() {
  const [data, setData] = useState(undefined);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(new Set());
  const [facet, setFacet] = useState({});            // key -> Set of values
  const [openFacet, setOpenFacet] = useState("");
  const [sort, setSort] = useState("late");
  const [selected, setSelected] = useState(null);
  const [colorBy, setColorBy] = useState("status");
  const [limit, setLimit] = useState(60);
  const fileRef = useRef(null);
  const cardRefs = useRef({});

  const load = async () => {
    try { const d = await api("backlog"); setData(d.empty ? null : d); setErr(""); }
    catch (e) { setErr(`Couldn't load the backlog (${e.message}).`); setData(null); }
  };
  useEffect(() => { load(); }, []);

  const upload = async (file) => {
    if (!file) return;
    setBusy(`Reading ${file.name}…`); setErr("");
    try {
      const parsed = await parseBacklogWorkbook(await file.arrayBuffer(), file.name);
      setBusy("Saving…");
      await api("backlog", { method: "PUT", body: parsed });
      await load();
      setBusy("");
    } catch (e) {
      setBusy("");
      setErr(e.status ? `Couldn't save it (${e.message}).` : (e.message || String(e)));
    }
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
  const passText = (j) => {
    const s = q.trim().toLowerCase();
    return !s || `${j.name} ${j.ref} ${j.addr} ${j.note} ${j.tags.join(" ")} ${j.rep}`.toLowerCase().includes(s);
  };
  const shown = useMemo(() => jobs
    .filter((j) => passText(j) && passFacets(j) && (!status.size || status.has(j.status)))
    .sort(SORTS[sort].fn), [jobs, q, facet, status, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setLimit(60); }, [q, facet, status, sort]);

  const pick = (ref) => {
    setSelected((s) => (s === ref ? null : ref));
    const idx = shown.findIndex((j) => j.ref === ref);
    if (idx >= limit) setLimit(idx + 20);
    setTimeout(() => cardRefs.current[ref]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  const toggleSet = (set, v) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; };
  const facetCounts = (k) => {
    const counts = new Map();
    jobs.forEach((j) => {
      if (!passText(j) || !passFacets(j, k) || (status.size && !status.has(j.status))) return;
      const v = FACETS[k].of(j);
      (Array.isArray(v) ? v : [v]).forEach((x) => { const c = counts.get(x) || { n: 0, h: 0 }; c.n++; c.h += j.hrs || 0; counts.set(x, c); });
    });
    const vals = [...counts.entries()];
    if (k === "zone") vals.sort((a, b) => (parseFloat(a[0]) || 999) - (parseFloat(b[0]) || 999));
    else vals.sort((a, b) => b[1].n - a[1].n);
    return vals;
  };

  if (data === undefined) return <div className="wrap hint">Loading the backlog…</div>;

  const sumH = (list) => list.reduce((t, j) => t + (j.hrs || 0), 0);
  const sumP = (list) => list.reduce((t, j) => t + (j.price || 0), 0);
  const byStatus = Object.fromEntries(STATUS_ORDER.map((k) => [k, jobs.filter((j) => j.status === k)]));
  const f = data?.forecast;
  const next3 = (f?.workableHrs || []).slice(0, 4).filter((v) => v > 0);
  const weeklyCap = next3.length ? next3.reduce((a, b) => a + b, 0) / next3.length / 4.33 : null;
  const filtersOn = q || status.size || Object.values(facet).some((s) => s.size);

  const uploader = (
    <>
      <input ref={fileRef} type="file" accept=".xlsm,.xlsx,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
             style={{ display: "none" }} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      <button className="btn st" data-primary="1" disabled={!!busy} onClick={() => fileRef.current?.click()}>
        {busy || (data ? "Update from workbook" : "Upload the backlog workbook")}
      </button>
    </>
  );

  if (!data) return (
    <div className="wrap" style={{ maxWidth: 640 }}>
      <div className="card"><div className="card-b" style={{ display: "grid", gap: 12 }}>
        <div className="st" style={{ fontSize: 16 }}>No backlog loaded yet</div>
        <div className="hint">Upload the GTC Backlog workbook (.xlsm). It's read on this device, and the jobs, notes,
          schedule and forecast are saved here for everyone with Dispatch access. Nothing is ever written back to the workbook.</div>
        <div>{uploader}</div>
        {err && <div className="err">{err}</div>}
      </div></div>
    </div>
  );

  return (
    <div className="wrap">
      {/* source line */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <div className="hint">
          From <b style={{ color: C.inkDim }}>{data.fileName || "workbook"}</b>
          {data.asOf ? <> · sheet dated {new Date(data.asOf + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</> : null}
          {data.uploadedAt ? <> · uploaded {new Date(data.uploadedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{data.uploadedBy ? ` by ${data.uploadedBy}` : ""}</> : null}
        </div>
        <span className="spacer" />
        {uploader}
      </div>
      {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
      {data.warnings?.length > 0 && <div className="hint" style={{ marginBottom: 10 }}>{data.warnings.join(" ")}</div>}

      {/* headline numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginBottom: 12 }}>
        <Tile label="Jobs in backlog" value={jobs.length} sub={`${money(sumP(jobs))} sold`} />
        <Tile label="Hours" value={hrs(sumH(jobs))} sub={weeklyCap ? `≈ ${Math.round(sumH(jobs) / weeklyCap)} weeks of crew time` : null} />
        {STATUS_ORDER.map((k) => (
          <Tile key={k} label={STATUS[k].label} value={byStatus[k].length} color={STATUS[k].color}
                sub={`${hrs(sumH(byStatus[k]))} · ${money(sumP(byStatus[k]))}`}
                on={status.has(k)} onClick={() => setStatus((s) => toggleSet(s, k))} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,520px),1fr))", gap: 12, marginBottom: 12 }}>
        <div className="card"><div className="card-h st">Forecast — backlog vs crew hours</div><div className="card-b"><Forecast f={f} /></div></div>
        <div className="card">
          <div className="card-h st">By zone <span className="hint" style={{ textTransform: "none", letterSpacing: 0, marginLeft: "auto" }}>tap a zone to filter</span></div>
          <div className="card-b" style={{ display: "grid", gap: 2, maxHeight: 290, overflow: "auto" }}>
            {(() => {
              const rows = facetCounts("zone");
              const maxH = Math.max(1, ...rows.map(([, c]) => c.h));
              return rows.map(([z, c]) => {
                const over = jobs.filter((j) => j.zone === z && j.status === "over").length;
                const on = facet.zone?.has(z);
                return (
                  <button key={z} onClick={() => setFacet((fc) => ({ ...fc, zone: toggleSet(fc.zone || new Set(), z) }))}
                          style={{ display: "grid", gridTemplateColumns: "92px 1fr auto", gap: 8, alignItems: "center", padding: "3px 4px",
                                   background: on ? C.tileHi : "transparent", borderRadius: 2, textAlign: "left" }}>
                    <span className="st" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <i style={{ width: 8, height: 8, borderRadius: 4, background: zoneColors[z] }} />{/^\d/.test(z) ? `Zone ${z}` : z}
                    </span>
                    <span style={{ height: 10, background: C.edgeSoft, borderRadius: 2, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${(c.h / maxH) * 100}%`, background: "#6d7b85" }} />
                    </span>
                    <span className="mono hint" style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 11 }}>
                      {c.n} · {Math.round(c.h)} h{over ? <b style={{ color: STATUS.over.color, fontWeight: 600 }}> · {over} late</b> : null}
                    </span>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* filters */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-b" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input className="inp" style={{ flex: "1 1 220px", maxWidth: 360 }} placeholder="Search name, job #, street, note, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            {Object.entries(FACETS).filter(([k]) => k !== "zone").map(([k, fc]) => (
              <button key={k} className="chip st" data-on={openFacet === k ? 1 : 0} onClick={() => setOpenFacet((o) => (o === k ? "" : k))}>
                {fc.label}{facet[k]?.size ? ` (${facet[k].size})` : ""} {openFacet === k ? "▴" : "▾"}
              </button>
            ))}
            <span className="spacer" />
            <select className="inp" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value)}>
              {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
            </select>
            {filtersOn && <button className="btn st" onClick={() => { setQ(""); setStatus(new Set()); setFacet({}); }}>Clear filters</button>}
          </div>
          {openFacet && openFacet !== "zone" && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {facetCounts(openFacet).map(([v, c]) => (
                <button key={v} className="chip st" data-on={facet[openFacet]?.has(v) ? 1 : 0}
                        onClick={() => setFacet((fc) => ({ ...fc, [openFacet]: toggleSet(fc[openFacet] || new Set(), v) }))}>
                  {v}<b>{c.n}</b>
                </button>
              ))}
            </div>
          )}
          <div className="hint">
            Showing <b style={{ color: C.ink }}>{shown.length}</b> of {jobs.length} jobs · {hrs(sumH(shown))} · {money(sumP(shown))}
          </div>
        </div>
      </div>

      {/* map + list */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,460px),1fr))", gap: 12, alignItems: "start" }}>
        <div className="card" style={{ position: "sticky", top: 70 }}>
          <div className="card-h st">
            Map
            <span className="spacer" />
            <button className="chip st" data-on={colorBy === "status" ? 1 : 0} onClick={() => setColorBy("status")}>Colour by status</button>
            <button className="chip st" data-on={colorBy === "zone" ? 1 : 0} onClick={() => setColorBy("zone")}>By zone</button>
          </div>
          <div style={{ height: "min(62vh, 620px)" }}>
            <BacklogMap jobs={shown} points={points} selected={selected} onPick={pick} colorBy={colorBy} zoneColors={zoneColors} />
          </div>
          <div className="hint" style={{ padding: "6px 10px" }}>
            {geoState || "Bigger dot = more hours. Tap a dot to find the job."}
          </div>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {shown.slice(0, limit).map((j) => (
            <JobCard key={j.ref} j={j} selected={selected === j.ref} onSelect={pick}
                     cardRef={(el) => { if (el) cardRefs.current[j.ref] = el; else delete cardRefs.current[j.ref]; }} />
          ))}
          {shown.length > limit && (
            <button className="btn st" onClick={() => setLimit((l) => l + 100)}>Show more ({shown.length - limit} more)</button>
          )}
          {!shown.length && <div className="hint">No jobs match these filters.</div>}
        </div>
      </div>
    </div>
  );
}
