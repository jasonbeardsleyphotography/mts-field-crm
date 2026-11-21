import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { api } from "./api";
import { C } from "./theme";
import { enrich, STATUS, money, hrs } from "./backlogModel";
import { useJobPoints, loadMaps } from "./BacklogMap.jsx";
import { shopGet, shopDays, shopPatch, shopSchedRange, stampNow } from "./shop/shopApi";
import { freshCore, mergeCore, live, isoOf, addDays, weekStartOf } from "./shop/ShopBoard.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Schedule — put backlog jobs on the Shop Board's crews for a day.
   • Crews come from that day on the Shop Board (or the day it inherits from).
   • Drag a job onto a crew, or tap a job then "Add here" (phones).
   • The map shows each crew's stops in order and what's left in the backlog;
     "Nearest to <crew>" sorts the backlog by distance to that crew's stops.
   Saved per day on the server (sched.<date>), merged per job, so two people
   can plan at once. Nothing is written to SingleOps or the workbook.
   ═══════════════════════════════════════════════════════════════════════════ */

const CREW_COLORS = ["#4FC3F7", "#FFB74D", "#BA68C8", "#81C784", "#F06292", "#FFF176", "#4DB6AC", "#E57373"];
const DAY_HRS = 8;
const DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const km = (a, b) => {
  const R = 6371, d = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const miles = (k) => `${(k * 0.621).toFixed(k < 16 ? 1 : 0)} mi`;
const firstName = (p) => (p?.name || "").split(" ")[0];

/** The crews on the Shop Board for a day: its own record, else the latest earlier one, else the standing setup. */
async function crewsForDay(iso) {
  const core = mergeCore(await shopGet("core"), freshCore());
  let day = await shopGet(`day.${iso}`), from = iso;
  if (!day?.crews) {
    const before = (await shopDays()).filter((d) => d < iso).sort();
    for (let i = before.length - 1; i >= 0 && !day?.crews; i--) { day = await shopGet(`day.${before[i]}`); from = before[i]; }
  }
  const crews = day?.crews ? day.crews : core.crews;
  return { core, crews: live(crews).filter((c) => ["GTC", "PHC", "LC"].includes(c.ops || "GTC")), from: day?.crews ? from : "standing" };
}

function ScheduleMap({ jobs, points, assign, crewColor, selected, onPick }) {
  const el = useRef(null), map = useRef(null), layers = useRef([]), fitted = useRef(false);
  const pickRef = useRef(onPick); pickRef.current = onPick;
  const [err, setErr] = useState("");
  useEffect(() => {
    loadMaps().then(() => {
      if (!el.current) return;
      map.current = new window.google.maps.Map(el.current, {
        center: { lat: 43.12, lng: -77.55 }, zoom: 10, mapTypeControl: false, streetViewControl: false, clickableIcons: false,
        styles: [{ elementType: "geometry", stylers: [{ color: "#1d2329" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#8a959d" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#14181c" }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c353c" }] },
          { featureType: "water", stylers: [{ color: "#0f2433" }] }, { featureType: "poi", stylers: [{ visibility: "off" }] }],
      });
      setErr("");
    }).catch(() => setErr("The map couldn't load."));
  }, []);
  useEffect(() => {
    const g = window.google?.maps; if (!map.current || !g) return;
    layers.current.forEach((x) => x.setMap(null)); layers.current = [];
    const bounds = new g.LatLngBounds(); let any = false;
    const byCrew = {};
    jobs.forEach((j) => {
      const p = points[j.ref]; if (!p) return;
      const a = assign[j.ref];
      const on = a && a.crew;
      const sel = selected === j.ref;
      if (on) (byCrew[a.crew] = byCrew[a.crew] || []).push({ ...a, p, ref: j.ref });
      const m = new g.Marker({
        map: map.current, position: p, zIndex: on ? 100 + (sel ? 50 : 0) : sel ? 90 : 10,
        title: `${j.name} · ${Math.round(j.hrs || 0)} h`,
        icon: on
          ? { path: g.SymbolPath.CIRCLE, scale: sel ? 13 : 11, fillColor: crewColor(a.crew), fillOpacity: 1, strokeColor: sel ? "#fff" : "#0b0e11", strokeWeight: sel ? 3 : 1.5 }
          : { path: g.SymbolPath.CIRCLE, scale: sel ? 9 : 5, fillColor: STATUS[j.status].color, fillOpacity: 0.75, strokeColor: sel ? "#fff" : "#0b0e11", strokeWeight: sel ? 2.5 : 1 },
        label: on ? { text: String((a.order ?? 0) + 1), color: "#0b0e11", fontSize: "11px", fontWeight: "700" } : undefined,
      });
      m.addListener("click", () => pickRef.current?.(j.ref));
      layers.current.push(m);
      if (on || !fitted.current) { bounds.extend(p); any = true; }
    });
    Object.entries(byCrew).forEach(([crew, list]) => {
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (list.length > 1) layers.current.push(new g.Polyline({ map: map.current, path: list.map((x) => x.p), strokeColor: crewColor(crew), strokeOpacity: 0.9, strokeWeight: 3 }));
    });
    if (any && !fitted.current) { map.current.fitBounds(bounds, 30); fitted.current = true; }
  }, [jobs, points, assign, selected, crewColor]);
  useEffect(() => { const p = selected && points[selected]; if (p && map.current) map.current.panTo(p); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 320 }}>
      <div ref={el} style={{ position: "absolute", inset: 0, background: "#1d2329" }} />
      {err && <div className="err" style={{ position: "absolute", top: 8, left: 8 }}>{err}</div>}
    </div>
  );
}

export default function Schedule({ me }) {
  const [iso, setIso] = useState(() => isoOf(new Date()));
  const [data, setData] = useState(undefined);       // backlog
  const [board, setBoard] = useState(null);          // { core, crews, from }
  const [assign, setAssign] = useState({});          // this day: ref -> { crew, order, label, hrs, at, by }
  const [week, setWeek] = useState({});              // iso -> assign (planned on other days)
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState("open");          // open | all
  const [sort, setSort] = useState("late");
  const [saving, setSaving] = useState(0);
  const [err, setErr] = useState("");
  const gen = useRef(0);

  useEffect(() => { api("backlog").then((d) => setData(d.empty ? null : d)).catch(() => setData(null)); }, []);
  const jobs = useMemo(() => (data ? enrich(data) : []), [data]);
  const { points, state: geoState } = useJobPoints(jobs);
  const jobBy = useMemo(() => Object.fromEntries(jobs.map((j) => [j.ref, j])), [jobs]);

  // load the day: crews from the Shop Board + this week's schedules
  useEffect(() => {
    const g = ++gen.current;
    setBoard(null); setSelected(null);
    (async () => {
      const [b, wk] = await Promise.all([crewsForDay(iso), shopSchedRange(isoOf(weekStartOf(new Date(iso + "T12:00:00"))), 7)]);
      if (g !== gen.current) return;
      setBoard(b); setWeek(wk); setAssign(wk[iso]?.assign || {});
    })();
  }, [iso]);

  // pick up other people's changes to this day
  const savingRef = useRef(0); savingRef.current = saving;
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || savingRef.current) return;
      const g = gen.current;
      const r = await shopGet(`sched.${iso}`);
      if (g === gen.current && r?.assign && !savingRef.current) setAssign(r.assign);
    }, 8000);
    return () => clearInterval(t);
  }, [iso]);

  const crewIdx = useMemo(() => Object.fromEntries((board?.crews || []).map((c, i) => [c.id, i])), [board]);
  const crewColor = useCallback((id) => CREW_COLORS[(crewIdx[id] ?? 0) % CREW_COLORS.length], [crewIdx]);
  const byCrew = useMemo(() => {
    const out = {};
    Object.entries(assign).forEach(([ref, a]) => { if (a?.crew) (out[a.crew] = out[a.crew] || []).push({ ref, ...a }); });
    Object.values(out).forEach((l) => l.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    return out;
  }, [assign]);
  const plannedOn = useMemo(() => {
    const out = {};
    Object.entries(week).forEach(([d, s]) => { if (d !== iso) Object.entries(s.assign || {}).forEach(([ref, a]) => { if (a?.crew) out[ref] = d; }); });
    return out;
  }, [week, iso]);

  const save = async (entries) => {
    const at = stampNow(), by = me?.name || me?.email || "?";
    const patch = {};
    Object.entries(entries).forEach(([ref, v]) => { patch[ref] = { ...v, at, by }; });
    setAssign((cur) => ({ ...cur, ...patch }));
    setSaving((n) => n + 1);
    const merged = await shopPatch(`sched.${iso}`, { assign: patch });
    setSaving((n) => n - 1);
    if (!merged) setErr("Couldn't save the last change — check your connection. It will show again once saved.");
    else { setErr(""); setWeek((w) => ({ ...w, [iso]: merged })); }
  };
  const label = (j) => ({ label: `${j.name} #${j.ref}`, town: j.town, hrs: j.hrs || 0 });
  const addTo = (ref, crew) => {
    const j = jobBy[ref]; if (!j) return;
    const list = (byCrew[crew] || []).filter((x) => x.ref !== ref);
    save({ [ref]: { crew, order: list.length ? Math.max(...list.map((x) => x.order ?? 0)) + 1 : 0, ...label(j) } });
    setSelected(null);
  };
  const remove = (ref) => save({ [ref]: { ...(assign[ref] || {}), crew: null } });
  const move = (crew, idx, dir) => {
    const list = byCrew[crew] || []; const k = idx + dir;
    if (k < 0 || k >= list.length) return;
    const ord = list.map((x, i) => i); [ord[idx], ord[k]] = [ord[k], ord[idx]];
    const entries = {};
    list.forEach((x, i) => { const o = ord.indexOf(i); if ((x.order ?? i) !== o) entries[x.ref] = { ...assign[x.ref], order: o }; });
    save(entries);
  };

  // backlog list
  const nearCrew = sort.startsWith("near:") ? sort.slice(5) : null;
  const distTo = useMemo(() => {
    if (!nearCrew) return {};
    const stops = (byCrew[nearCrew] || []).map((x) => points[x.ref]).filter(Boolean);
    if (!stops.length) return {};
    const out = {};
    jobs.forEach((j) => { const p = points[j.ref]; if (p) out[j.ref] = Math.min(...stops.map((s) => km(p, s))); });
    return out;
  }, [nearCrew, byCrew, points, jobs]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return jobs.filter((j) => !assign[j.ref]?.crew)
      .filter((j) => show === "all" || (j.status !== "hold" && j.status !== "sched" && !plannedOn[j.ref]))
      .filter((j) => !s || `${j.name} ${j.ref} ${j.addr} ${j.zone} ${j.tags.join(" ")}`.toLowerCase().includes(s))
      .sort(nearCrew ? (a, b) => (distTo[a.ref] ?? 1e9) - (distTo[b.ref] ?? 1e9)
        : sort === "zone" ? (a, b) => (parseFloat(a.zone) || 99) - (parseFloat(b.zone) || 99)
        : (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || b.lateWeeks - a.lateWeeks);
  }, [jobs, assign, show, plannedOn, q, sort, nearCrew, distTo]);
  const [limit, setLimit] = useState(80);
  useEffect(() => setLimit(80), [q, show, sort]);

  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  if (!data) return <div className="wrap hint">Upload the backlog workbook on the Backlog tab first — the Schedule plans its jobs.</div>;

  const wkStart = weekStartOf(new Date(iso + "T12:00:00"));
  const sel = selected && jobBy[selected];
  const today = isoOf(new Date());

  return (
    <div className="wrap" style={{ maxWidth: 1800 }}>
      {/* day picker */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button className="btn st" onClick={() => setIso(isoOf(addDays(new Date(iso + "T12:00:00"), -7)))}>‹</button>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const d = addDays(wkStart, i), di = isoOf(d);
          const n = Object.values((di === iso ? { assign } : week[di]) ?.assign || {}).filter((a) => a?.crew).length;
          return (
            <button key={di} className="chip st" data-on={di === iso ? 1 : 0} onClick={() => setIso(di)}
                    style={{ borderColor: di === today ? "#6b7880" : undefined }}>
              {DN[d.getDay()]} {d.getDate()}{n ? <b>{n}</b> : null}
            </button>
          );
        })}
        <button className="btn st" onClick={() => setIso(isoOf(addDays(new Date(iso + "T12:00:00"), 7)))}>›</button>
        <button className="btn st" onClick={() => setIso(today)}>Today</button>
        <span className="spacer" />
        <span className="hint">{saving ? "Saving…" : board ? (board.from === iso ? "Crews from this day's Shop Board." : board.from === "standing" ? "Crews from the standing Shop Board setup." : `Crews from the Shop Board (same as ${board.from}).`) : ""}</span>
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {sel && (
        <div className="card" style={{ padding: "8px 12px", marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderColor: "#58666f" }}>
          <b>{sel.name}</b><span className="hint">#{sel.ref} · {sel.town} · {hrs(sel.hrs)} · {money(sel.price)}{plannedOn[sel.ref] ? ` · planned ${plannedOn[sel.ref]}` : ""}</span>
          <span className="spacer" />
          {assign[sel.ref]?.crew
            ? <button className="btn st" data-danger="1" onClick={() => { remove(sel.ref); setSelected(null); }}>Take off the schedule</button>
            : <span className="hint">Tap “Add here” on a crew.</span>}
          <button className="btn st" onClick={() => setSelected(null)}>Clear</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 12, alignItems: "start" }}>
        {/* crews */}
        <div style={{ display: "grid", gap: 8 }}>
          {!board && <div className="hint">Loading crews…</div>}
          {(board?.crews || []).map((c) => {
            const items = byCrew[c.id] || [];
            const total = items.reduce((t, x) => t + (jobBy[x.ref]?.hrs ?? x.hrs ?? 0), 0);
            const ppl = (c.people || []).map((id) => board.core.people[id]).filter((p) => p && !p.del);
            return (
              <div key={c.id} className="card" onDragOver={(e) => e.preventDefault()}
                   onDrop={(e) => { e.preventDefault(); const ref = e.dataTransfer.getData("text/x-job"); if (ref) addTo(ref, c.id); }}
                   style={{ borderLeft: `4px solid ${crewColor(c.id)}` }}>
                <div className="card-h st" style={{ color: C.ink, fontSize: 12.5 }}>
                  {c.name}<span className="hint" style={{ textTransform: "none", letterSpacing: 0 }}>{ppl.map(firstName).join(", ") || "nobody on it"}</span>
                  <span className="spacer" />
                  <span className="mono" style={{ color: total > DAY_HRS + 1 ? C.amber : C.inkDim }}>{Math.round(total * 10) / 10} h</span>
                </div>
                <div style={{ padding: 6, display: "grid", gap: 4, minHeight: 40 }}>
                  {items.map((x, i) => {
                    const j = jobBy[x.ref];
                    const prev = i > 0 && points[items[i - 1].ref], here = points[x.ref];
                    return (
                      <div key={x.ref} onClick={() => setSelected(x.ref)}
                           style={{ display: "flex", gap: 6, alignItems: "center", padding: "5px 6px", background: selected === x.ref ? C.tileHi : C.tile, borderRadius: 3, cursor: "pointer" }}>
                        <span className="mono" style={{ width: 18, height: 18, borderRadius: 9, background: crewColor(c.id), color: "#0b0e11", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j ? j.name : x.label}</div>
                          <div className="hint" style={{ fontSize: 11 }}>{j?.town || x.town} · {hrs(j?.hrs ?? x.hrs)}{prev && here ? ` · ${miles(km(prev, here))} from last` : ""}{!j ? " · no longer in the backlog" : ""}</div>
                        </span>
                        <button className="btn" style={{ padding: "2px 7px" }} title="Earlier" onClick={(e) => { e.stopPropagation(); move(c.id, i, -1); }}>↑</button>
                        <button className="btn" style={{ padding: "2px 7px" }} title="Later" onClick={(e) => { e.stopPropagation(); move(c.id, i, 1); }}>↓</button>
                        <button className="btn" style={{ padding: "2px 7px" }} title="Take off" onClick={(e) => { e.stopPropagation(); remove(x.ref); }}>✕</button>
                      </div>
                    );
                  })}
                  {!items.length && <div className="hint" style={{ padding: "6px 4px" }}>Drag jobs here{sel ? "" : ", or tap a job and then “Add here”"}.</div>}
                  {sel && !assign[sel.ref]?.crew && (
                    <button className="btn st" data-primary="1" onClick={() => addTo(sel.ref, c.id)}>+ Add {sel.name} here</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* map */}
        <div className="card" style={{ position: "sticky", top: 70 }}>
          <div style={{ height: "min(70vh, 680px)" }}>
            <ScheduleMap jobs={jobs.filter((j) => assign[j.ref]?.crew || list.includes(j))} points={points} assign={assign}
                         crewColor={crewColor} selected={selected} onPick={(r) => setSelected((s) => (s === r ? null : r))} />
          </div>
          <div className="hint" style={{ padding: "6px 10px" }}>{geoState || "Numbered dots = this day's stops, in order. Small dots = backlog jobs (coloured by status)."}</div>
        </div>

        {/* backlog */}
        <div className="card">
          <div className="card-b" style={{ display: "grid", gap: 8 }}>
            <input className="inp" placeholder="Search name, job #, street, zone, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <select className="inp" style={{ width: "auto", flex: 1 }} value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="late">Most past promise first</option>
                <option value="zone">By zone</option>
                {(board?.crews || []).filter((c) => (byCrew[c.id] || []).length).map((c) => <option key={c.id} value={`near:${c.id}`}>Nearest to {c.name}'s stops</option>)}
              </select>
              <button className="chip st" data-on={show === "all" ? 1 : 0} onClick={() => setShow((v) => (v === "all" ? "open" : "all"))}>
                {show === "all" ? "Showing all" : "Hide scheduled / on hold"}
              </button>
            </div>
            <div className="hint">{list.length} jobs · {hrs(list.reduce((t, j) => t + (j.hrs || 0), 0))}. Drag onto a crew, or tap to pick.</div>
          </div>
          <div style={{ maxHeight: "62vh", overflow: "auto", padding: "0 8px 8px", display: "grid", gap: 4 }}>
            {list.slice(0, limit).map((j) => (
              <div key={j.ref} draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-job", j.ref); e.dataTransfer.effectAllowed = "move"; }}
                   onClick={() => setSelected((s) => (s === j.ref ? null : j.ref))}
                   style={{ display: "flex", gap: 8, padding: "6px 8px", borderRadius: 3, cursor: "grab", background: selected === j.ref ? C.tileHi : C.tile, borderLeft: `3px solid ${STATUS[j.status].color}` }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b>{j.name}</b> <span className="hint">#{j.ref}</span></div>
                  <div className="hint" style={{ fontSize: 11 }}>
                    {j.town}{j.zone ? ` · Z${j.zone}` : ""} · {j.crew || "?"} · {j.status === "over" ? `${Math.round(j.lateWeeks)} wk late` : STATUS[j.status].label}
                    {plannedOn[j.ref] ? ` · planned ${plannedOn[j.ref]}` : ""}{distTo[j.ref] != null ? ` · ${miles(distTo[j.ref])}` : ""}
                  </div>
                </span>
                <span className="mono" style={{ fontSize: 12.5 }}>{hrs(j.hrs)}</span>
              </div>
            ))}
            {list.length > limit && <button className="btn st" onClick={() => setLimit((l) => l + 100)}>Show more</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
