import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import { C } from "./theme";
import { STATUS, money, jobColor, singleOpsJobUrl, tagShort, seasonWindowNow, seasonKeysOf, gradientColor, EMERGENCY_COLOR, PRIORITY_COLOR, PAUSED_COLOR, SEASON_COLOR } from "./backlogModel";
import JobHours from "./JobHours.jsx";
import TagPill, { TagRow, TagStrip, TagStripKey } from "./TagPill.jsx";
import { useBacklog } from "./useBacklog";
import { fmtH, useHoursUnit, dayOsh } from "./hours";
import TagFilter, { emptyTags, passTags } from "./TagFilter.jsx";
import { PauseForm, promiseText, PurgatoryModal, CheckBackBanner } from "./Backlog.jsx";
import { useJobPoints, loadMaps } from "./BacklogMap.jsx";
import { shopGet, shopDays, shopPatch, shopSchedRange, stampNow, shopSettings, saveYard } from "./shop/shopApi";
import { freshCore, mergeCore, live, isoOf, addDays, weekStartOf, assetsOn } from "./shop/ShopBoard.jsx";
import { sharedDay, setSharedDay } from "./sharedDay";
import { checkJob, crewTags, TAG_RULES, UNMAPPED_TAGS } from "./crewCheck";
import { useShop, starIcon, SHOP_ADDR } from "./shopLocation";

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
const DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const km = (a, b) => {
  const R = 6371, d = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
export const miles = (k) => `${(k * 0.621).toFixed(k < 16 ? 1 : 0)} mi`;
const firstName = (p) => (p?.name || "").split(" ")[0];
const byCrewRaw = (assign) => {
  const out = {};
  Object.entries(assign || {}).forEach(([ref, a]) => { if (a?.crew && !ref.startsWith("_")) (out[a.crew] = out[a.crew] || []).push({ ref, ...a }); });
  return out;
};

/** Round-trip length (km) yard → stops in order → yard. */
const tripKm = (yard, pts) => {
  if (!pts.length) return 0;
  let t = 0, prev = yard || pts[0];
  pts.forEach((p) => { t += km(prev, p); prev = p; });
  return t + (yard ? km(prev, yard) : 0);
};
/** Shortest order (straight-line) for a crew's stops, starting and ending at the yard.
    Up to 8 stops: every order is tried. More: nearest-next, then 2-opt clean-up. */
function bestOrder(yard, stops) {
  const n = stops.length;
  if (n < 2) return stops.map((_, i) => i);
  const P = stops.map((s) => s.p);
  const cost = (ord) => tripKm(yard, ord.map((i) => P[i]));
  if (n <= 8) {
    let best = null, bestC = Infinity;
    const perm = (arr, k) => {
      if (k === arr.length) { const c = cost(arr); if (c < bestC) { bestC = c; best = arr.slice(); } return; }
      for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
    };
    perm(stops.map((_, i) => i), 0);
    return best;
  }
  const left = new Set(stops.map((_, i) => i)), ord = [];
  let cur = yard || P[0];
  while (left.size) {
    let bi = null, bd = Infinity;
    left.forEach((i) => { const d = km(cur, P[i]); if (d < bd) { bd = d; bi = i; } });
    ord.push(bi); left.delete(bi); cur = P[bi];
  }
  for (let improved = true, guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const cand = [...ord.slice(0, i), ...ord.slice(i, k + 1).reverse(), ...ord.slice(k + 1)];
      if (cost(cand) + 1e-9 < cost(ord)) { ord.splice(0, n, ...cand); improved = true; }
    }
  }
  return ord;
}

/** The crews on the Shop Board for a day: its own record, else the latest earlier one, else the standing setup. */
export async function crewsForDay(iso, allOps = false) {
  const raw = mergeCore(await shopGet("core"), freshCore());
  const core = { ...raw, assets: assetsOn(raw.assets, iso) };    // broken on THIS day
  let day = await shopGet(`day.${iso}`), from = iso;
  if (!day?.crews) {
    const before = (await shopDays()).filter((d) => d < iso).sort();
    for (let i = before.length - 1; i >= 0 && !day?.crews; i--) { day = await shopGet(`day.${before[i]}`); from = before[i]; }
  }
  const crews = day?.crews ? day.crews : core.crews;
  // who is off that day (Shop Board week record: vacation / sick / training)
  const sun = isoOf(weekStartOf(new Date(iso + "T12:00:00")));
  const di = Math.round((new Date(iso + "T12:00:00") - new Date(sun + "T12:00:00")) / 86400000);
  const wk = await shopGet(`week.${sun}`);
  const off = new Set(Object.entries(wk?.cells || {}).filter(([k, v]) => k.endsWith(`:${di}`) && v && !["on", "light"].includes(v.code)).map(([k]) => k.split(":")[0]));
  // the same order as the Shop Board's yard (crews sort by where they sit there; see packBoxes)
  const pos = (day?.crews && day.pos) || {};
  const ordered = live(crews).map((c, i) => ({ c, h: pos[c.id] || { x: i * 10, y: 0 } }))
    .sort((a, b) => (a.h.y - b.h.y) || (a.h.x - b.h.x)).map((x) => x.c);
  return { core, off, offCode: Object.fromEntries(Object.entries(wk?.cells || {}).filter(([k, v]) => k.endsWith(`:${di}`) && v && !["on", "light"].includes(v.code)).map(([k, v]) => [k.split(":")[0], v.code])),
           crews: allOps ? ordered : ordered.filter((c) => ["GTC", "PHC", "LC"].includes(c.ops || "GTC")), from: day?.crews ? from : "standing" };
}

function ScheduleMap({ jobs, points, assign, crewColor, selected, onPick, yardOf, shop, children }) {
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
        title: `${j.name} · ${fmtH(j.treeHrs ?? j.hrs)}`,
        icon: on
          ? { path: g.SymbolPath.CIRCLE, scale: sel ? 13 : 11, fillColor: crewColor(a.crew), fillOpacity: 1, strokeColor: sel ? "#fff" : "#0b0e11", strokeWeight: sel ? 3 : 1.5 }
          : { path: g.SymbolPath.CIRCLE, scale: sel ? 9 : 5, fillColor: jobColor(j), fillOpacity: 0.8, strokeColor: sel ? "#fff" : "#0b0e11", strokeWeight: sel ? 2.5 : 1 },
        label: on ? { text: String((a.order ?? 0) + 1), color: "#0b0e11", fontSize: "11px", fontWeight: "700" } : undefined,
      });
      m.addListener("click", () => pickRef.current?.(j.ref));
      layers.current.push(m);
      if (on || !fitted.current) { bounds.extend(p); any = true; }
    });
    const yardsDrawn = new Set();
    Object.entries(byCrew).forEach(([crew, list]) => {
      list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const y = yardOf?.(crew);
      const path = list.map((x) => x.p);
      if (y) {
        layers.current.push(new g.Polyline({ map: map.current, path: [y, ...path, y], strokeColor: crewColor(crew), strokeOpacity: 0.35, strokeWeight: 2, clickable: false }));
        if (!yardsDrawn.has(`${y.lat},${y.lng}`)) { yardsDrawn.add(`${y.lat},${y.lng}`); bounds.extend(y); }
      }
      if (path.length > 1) layers.current.push(new g.Polyline({ map: map.current, path, strokeColor: crewColor(crew), strokeOpacity: 0.9, strokeWeight: 3, clickable: false }));
    });
    if (shop) layers.current.push(new g.Marker({ map: map.current, position: shop, zIndex: 5, clickable: false, title: `Shop — ${shop.addr}`, icon: starIcon(g) }));
    if (any && !fitted.current) { map.current.fitBounds(bounds, 30); fitted.current = true; }
  }, [jobs, points, assign, selected, crewColor, yardOf, shop]);
  useEffect(() => { const p = selected && points[selected]; if (p && map.current) map.current.panTo(p); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 320 }}>
      <div ref={el} style={{ position: "absolute", inset: 0, background: "#1d2329" }} />
      {err && <div className="err" style={{ position: "absolute", top: 8, left: 8 }}>{err}</div>}
      {children}
    </div>
  );
}

/* Red: the crew can't do it as set up. Amber: call about it. Grey: what to load. */
function JobChecks({ r }) {
  if (!r || (!r.problems && !r.calls.length && !r.gear.length && !(r.prefer || []).length)) return null;
  const chip = (bg, fg) => ({ display: "inline-block", fontSize: 10.5, padding: "1px 6px", borderRadius: 2, background: bg, color: fg, marginRight: 4, marginTop: 3 });
  return (
    <div>
      {r.missing.map((m, i) => <span key={i} style={chip("rgba(217,59,43,.18)", "#ff9a8f")} title={m.why}>needs {m.label}{m.why !== "not on this crew" ? ` · ${m.why}` : ""}</span>)}
      {r.short && <span style={chip("rgba(217,59,43,.18)", "#ff9a8f")}>{r.short.need}-person job · crew has {r.short.have}</span>}
      {(r.prefer || []).map((t, i) => <span key={`p${i}`} style={chip("rgba(229,161,0,.16)", "#f0c050")}>{t}</span>)}
      {r.calls.length > 0 && <span style={chip("rgba(229,161,0,.16)", "#f0c050")} title={r.calls.join("\n")}>📞 {r.calls.length} to cover when calling</span>}
      {r.gear.length > 0 && <span style={chip("#2a333a", "#98A3AB")}>load: {r.gear.join(", ")}</span>}
    </div>
  );
}

/* Everything the office should raise when calling to schedule this day's jobs. */
function CallList({ assign, checks, jobBy, crews, crewColor }) {
  const [open, setOpen] = useState(true);
  const rows = Object.entries(assign).filter(([ref, a]) => a?.crew && !ref.startsWith("_") && checks[ref]?.calls?.length)
    .map(([ref, a]) => ({ ref, a, j: jobBy[ref], calls: checks[ref].calls }));
  if (!rows.length) return null;
  return (
    <div className="card" style={{ borderLeft: `4px solid ${C.amber}` }}>
      <button className="card-h st" style={{ width: "100%", color: C.ink, fontSize: 12 }} onClick={() => setOpen((o) => !o)}>
        📞 Office call list · {rows.length} job{rows.length === 1 ? "" : "s"}<span className="spacer" />{open ? "▴" : "▾"}
      </button>
      {open && (
        <div style={{ padding: "6px 10px", display: "grid", gap: 6 }}>
          {rows.map(({ ref, a, j, calls }) => (
            <div key={ref} style={{ fontSize: 12.5 }}>
              <b>{j?.name || a.label}</b> <span className="hint">#{ref} · {j?.town || a.town} · <span style={{ color: crewColor(a.crew) }}>{(crews.find((c) => c.id === a.crew) || {}).name}</span></span>
              <ul style={{ margin: "2px 0 0 16px", color: "#d8d2c4", fontSize: 12 }}>{calls.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Which tags need which machine — the rules the "fits this crew" check uses. */
function TagRules({ onClose }) {
  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, display: "grid", gap: 6, maxWidth: 760 }}>
      <div className="st" style={{ fontSize: 13 }}>Tag → equipment (what “fits this crew” checks)</div>
      <div className="hint" style={{ padding: 0 }}>A job fits a crew when the crew has the machines its tags call for (not broken that day), and enough people for its #-PERSON tag. Aerial tags (BUCKET, LIFT, CLIMBING, CLIMBABLE, GROUND) are alternatives — any one will do — unless the job is also tagged REQUIRED. Tell me anything that's wrong and I'll change it.</div>
      {TAG_RULES.map((r) => (
        <div key={r.label} style={{ display: "flex", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
          <span className="mono" style={{ width: 230, color: "#c8ced2" }}>{r.tags.join(", ")}</span>
          <span>→ <b>{r.label}</b>: {r.what}{r.later ? "" : ""}</span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, fontSize: 12.5 }}><span className="mono" style={{ width: 230, color: "#c8ced2" }}>#2 / #3 / #4 PERSON</span><span>→ that many people working on the crew that day</span></div>
      <div className="hint" style={{ padding: 0, marginTop: 4 }}>No machine needed / special:</div>
      {Object.entries(UNMAPPED_TAGS).map(([t, w]) => (
        <div key={t} style={{ display: "flex", gap: 8, fontSize: 12.5 }}><span className="mono" style={{ width: 230, color: "#c8ced2" }}>{t}</span><span className="hint" style={{ padding: 0 }}>{w}</span></div>
      ))}
      <div><button className="btn st" onClick={onClose}>Close</button></div>
    </div>
  );
}

/** Next weekday (Mon–Fri) after an ISO date. */
/* WEEKENDS (owner, Nov 24): off by default for all scheduling; the "Weekends" switch on
   the Schedule turns them on (per device). Off = Sat/Sun dimmed, the week view is Mon–Fri
   and multi-day jobs carry over Mon–Fri only. */
let weekendsOn = (() => { try { return localStorage.getItem("mts-sched-weekends") === "1"; } catch { return false; } })();
const nextWorkday = (d) => { const x = new Date(d + "T12:00:00"); do { x.setDate(x.getDate() + 1); } while (!weekendsOn && (x.getDay() === 0 || x.getDay() === 6)); return isoOf(x); };
/* SEASON SWITCHES (owner, Nov 24): permanent check boxes for the seasonal work.
   Unticked = jobs tagged only for that season are left out of the job list (jobs with
   no season tag always show). A box GLOWS while today is inside its window, with the
   work days left; outside, it counts down to the window opening. Per device. */
const SEASON_KEYS = ["WINTER", "SPRING", "SUMMER", "FALL", "OAK"];
function SeasonBar({ on, setOn, jobs }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "stretch", marginBottom: 10 }}>
      <span className="st" style={{ fontSize: 11.5, color: C.inkDim, alignSelf: "center" }}>Seasonal work</span>
      {SEASON_KEYS.map((k) => {
        const w = seasonWindowNow(k);
        const n = jobs.filter((j) => seasonKeysOf(j.tags).includes(k)).length;
        const lit = w?.inNow;
        const checked = on[k] !== false;
        return (
          <label key={k} title={lit ? `In season now — ${w.workdays} work days left` : `Opens ${w?.nextStart ? w.nextStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}`}
                 style={{ display: "flex", gap: 7, alignItems: "center", padding: "5px 10px", borderRadius: 5, cursor: "pointer", userSelect: "none",
                          background: lit ? "rgba(255,213,79,.14)" : C.panel, border: `1.5px solid ${lit ? "#FFD54F" : C.edge}`,
                          boxShadow: lit ? "0 0 10px rgba(255,213,79,.55), inset 0 0 6px rgba(255,213,79,.25)" : "none", opacity: checked ? 1 : 0.55 }}>
            <input type="checkbox" checked={checked} onChange={() => setOn({ ...on, [k]: !checked })} style={{ width: 16, height: 16, accentColor: "#E5A100" }} />
            <span style={{ display: "grid", lineHeight: 1.15 }}>
              <b className="st" style={{ fontSize: 12.5, color: lit ? "#FFE082" : C.ink }}>{k === "OAK" ? "Oak pruning" : w?.label}{lit ? " ●" : ""} <span className="mono" style={{ fontWeight: 400, color: C.inkDim }}>{n}</span></b>
              <span style={{ fontSize: 10.5, color: lit ? "#ffe9a8" : C.inkFaint }}>{lit ? `in season · ${w.workdays} work days left` : w?.workdays != null ? `opens in ${w.workdays} work days` : ""}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

const urgency = (j) => (j.status === "emergency" ? 0 : j.status === "priority" ? 1 : 2);

/* Emergency / Priority jobs not on any crew this week — impossible to miss. */
function UrgentBanner({ jobs, assign, plannedOn, onPick }) {
  const open = jobs.filter((j) => (j.status === "emergency" || j.status === "priority") && !j.nextVisit && !assign[j.ref]?.crew && !plannedOn[j.ref]);
  if (!open.length) return null;
  const em = open.filter((j) => j.status === "emergency"), pr = open.filter((j) => j.status === "priority");
  const row = (list, color, title, sub) => list.length > 0 && (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", borderRadius: 4, background: color, color: "#fff", marginBottom: 6, boxShadow: `0 0 0 2px ${color}55, 0 4px 14px rgba(0,0,0,.4)` }}>
      <b className="st" style={{ fontSize: 14, letterSpacing: ".08em" }}>{title} · {list.length} not scheduled</b>
      <span style={{ fontSize: 12, opacity: 0.9 }}>{sub}</span>
      {list.map((j) => (
        <button key={j.ref} onClick={() => onPick(j.ref)} style={{ background: "rgba(0,0,0,.25)", color: "#fff", borderRadius: 3, padding: "4px 8px", fontSize: 12.5, border: "1px solid rgba(255,255,255,.35)" }}>
          {j.name} · {j.town} · {fmtH(j.treeHrs)}
        </button>
      ))}
    </div>
  );
  return (
    <div style={{ marginBottom: 6 }}>
      {row(em, "#C4122F", "🚨 EMERGENCY", "Highest priority — tap one to place it.")}
      {row(pr, "#A3168A", "⚑ PRIORITY", "Next in line after emergencies.")}
    </div>
  );
}

/* ═══ WEEK VIEW ═══════════════════════════════════════════════════════════════
   Crews down the side, Mon–Sat across. Each cell = that crew's day: a load bar
   (tree-work hours vs a normal day for the people working), the jobs in order
   (multi-day jobs show "2/3"), and warnings. Drag a job from the list on the
   right into any cell, or drag a job between cells to move it (all its days
   move together). Tap a day's header to open that day. */
function WeekGrid({ days, boards, week, jobBy, entryHrs, crewColor, selected, onSelect, onDropJob, onMoveJob, onRemove, onOpenDay, checksFor, today }) {
  const [over, setOver] = useState(null);
  // crews: every crew on any day of the week, in the order of the first day that has them
  const crews = [];
  const seen = new Set();
  days.forEach((d) => (boards[d]?.crews || []).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); crews.push(c); } }));
  const peopleOnDay = (d, c) => { const b = boards[d]; return b ? (c.people || []).filter((id) => b.core.people[id] && !b.core.people[id].del && !b.off.has(id)).length : 0; };
  const cellJobs = (d, crewId) => Object.entries(week[d]?.assign || {}).filter(([r, a]) => a?.crew === crewId && !r.startsWith("_"))
    .map(([ref, a]) => ({ ref, ...a })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const dayTotals = (d) => { const all = Object.entries(week[d]?.assign || {}).filter(([r, a]) => a?.crew && !r.startsWith("_")).map(([ref, a]) => ({ ref, ...a })); return { n: all.length, h: all.reduce((t, x) => t + entryHrs(x), 0) }; };
  const drop = (e, d, crewId) => {
    e.preventDefault(); setOver(null);
    const mv = e.dataTransfer.getData("text/x-wk");
    if (mv) { const [ref, from] = mv.split("|"); onMoveJob(from, ref, d, crewId); return; }
    const ref = e.dataTransfer.getData("text/x-job");
    if (ref) onDropJob(d, ref, crewId);
  };
  if (!crews.length) return <div className="hint">Loading the week's crews…</div>;
  const col = `150px repeat(${days.length}, minmax(150px, 1fr))`;
  return (
    <div className="card" style={{ overflow: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: col, minWidth: 150 + days.length * 150 }}>
        <div style={{ padding: 8, borderBottom: `1px solid ${C.edge}` }} className="hint">Crew</div>
        {days.map((d) => {
          const dt = new Date(d + "T12:00:00"), t = dayTotals(d);
          return (
            <button key={d} onClick={() => onOpenDay(d)} title="Open this day"
                    style={{ padding: "6px 8px", textAlign: "left", borderBottom: `1px solid ${C.edge}`, borderLeft: `1px solid ${C.edgeSoft}`, background: d === today ? "#252e35" : "transparent" }}>
              <b className="st" style={{ fontSize: 12.5 }}>{DN[dt.getDay()]} {dt.getDate()}</b>
              <div className="hint" style={{ padding: 0 }}>{t.n} job{t.n === 1 ? "" : "s"} · {fmtH(t.h, 0)}</div>
            </button>
          );
        })}
        {crews.map((c) => (
          <Fragment key={c.id}>
            <div style={{ padding: 8, borderBottom: `1px solid ${C.edgeSoft}`, borderLeft: `4px solid ${crewColor(c.id)}` }}>
              <b className="st" style={{ fontSize: 12.5 }}>{c.name}</b>
              <div className="hint" style={{ padding: 0 }}>{c.ops || "GTC"}</div>
            </div>
            {days.map((d) => {
              const onBoard = (boards[d]?.crews || []).some((x) => x.id === c.id);
              const list = cellJobs(d, c.id);
              const ppl = peopleOnDay(d, c), target = dayOsh(ppl);
              const load = list.reduce((t, x) => t + entryHrs(x), 0);
              const pct = target ? load / target : 0;
              const barCol = !list.length ? C.edge : pct < 0.8 ? C.amber : pct <= 1.1 ? C.green : C.red;
              const key = `${d}|${c.id}`;
              return (
                <div key={key} onDragOver={(e) => { if (onBoard) { e.preventDefault(); if (over !== key) setOver(key); } }} onDragLeave={() => setOver((o) => (o === key ? null : o))}
                     onDrop={(e) => onBoard && drop(e, d, c.id)}
                     style={{ padding: 6, borderBottom: `1px solid ${C.edgeSoft}`, borderLeft: `1px solid ${C.edgeSoft}`, minHeight: 74, minWidth: 0, overflow: "hidden",
                              background: !onBoard ? "repeating-linear-gradient(135deg, #1a1f23 0 6px, #171b1f 6px 12px)" : over === key ? "#2b353d" : d === today ? "#1f262c" : "transparent",
                              outline: over === key ? `2px solid ${crewColor(c.id)}` : "none", outlineOffset: -2 }}>
                  {!onBoard ? <div className="hint" style={{ padding: 0 }}>not on the board</div> : (
                    <>
                      <div title={`${fmtH(load)} of a normal ${fmtH(target, 2)} day for ${ppl} people`} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 3, background: "#2a333a", overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, pct * 100)}%`, height: "100%", background: barCol }} />
                        </div>
                        <span className="mono" style={{ fontSize: 10.5, color: barCol === C.edge ? C.inkFaint : barCol }}>{fmtH(load, 0)}/{fmtH(target, 0)}</span>
                      </div>
                      <div style={{ display: "grid", gap: 3 }}>
                        {list.map((x) => {
                          const j = jobBy[x.ref], r = checksFor(d, c, x);
                          const urgent = j?.status === "emergency" ? "#FF1744" : j?.status === "priority" ? "#FF4FD8" : null;
                          return (
                            <div key={x.ref} draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-wk", `${x.ref}|${d}`); e.dataTransfer.effectAllowed = "move"; }}
                                 onClick={() => onSelect(x.ref)} title={`${j?.name || x.label} — ${j?.town || x.town}`}
                                 style={{ display: "flex", gap: 4, alignItems: "center", padding: "3px 5px", borderRadius: 3, cursor: "grab", fontSize: 11.5, minWidth: 0,
                                          background: selected === x.ref ? C.tileHi : C.tile, borderLeft: `3px solid ${urgent || (j ? jobColor(j) : C.edge)}`,
                                          boxShadow: r?.problems ? "inset 0 0 0 1px #D93B2B" : "none" }}>
                              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {x.parts > 1 && <b style={{ color: "#9cc4e4", marginRight: 3 }}>{x.part}/{x.parts}</b>}{j ? j.name : x.label}
                                <span className="hint" style={{ padding: 0 }}> {j?.town || x.town}</span>
                              </span>
                              {r?.problems > 0 && <span title="Doesn't suit this crew — open the day" style={{ color: "#ff9a8f" }}>⚠</span>}
                              <span className="mono" style={{ fontSize: 10.5, color: C.inkDim }}>{fmtH(entryHrs(x), 1).replace(/ .*/, "")}</span>
                              <button className="btn" style={{ padding: "0 4px", fontSize: 10 }} title="Take off (all its days)" onClick={(e) => { e.stopPropagation(); onRemove(d, x.ref); }}>✕</button>
                            </div>
                          );
                        })}
                        {!list.length && <div className="hint" style={{ padding: 0 }}>{ppl ? "drop jobs here" : "nobody working"}</div>}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="hint" style={{ padding: "6px 10px" }}>Bar = tree work vs a normal day ({fmtH(dayOsh(1), 2)} per person working): amber light · green about right · red heavy. Drag jobs from the list into a day, or between days. Jobs bigger than a day carry on to the crew's next weekdays (shown 1/2, 2/2).</div>
    </div>
  );
}

export default function Schedule({ me }) {
  useHoursUnit();
  const [iso, setIso] = useState(() => sharedDay(isoOf(new Date())));
  useEffect(() => { setSharedDay(iso); }, [iso]);
  const { data, jobs, pause, resume, remove: deleteJob } = useBacklog();
  const [rowAct, setRowAct] = useState(null);        // { ref, kind: "del" } on a backlog row
  const [purgJob, setPurgJob] = useState(null);      // the Purgatory pop-up
  const [seasonsOn, setSeasonsOn] = useState(() => { try { return JSON.parse(localStorage.getItem("mts-sched-seasons") || "{}"); } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem("mts-sched-seasons", JSON.stringify(seasonsOn)); } catch {} }, [seasonsOn]);
  const [tagF, setTagF] = useState(emptyTags);
  const [fitCrew, setFitCrew] = useState(null);      // crew id: list only jobs that crew can do
  const [rulesOpen, setRulesOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [board, setBoard] = useState(null);          // { core, crews, from }
  const [weekends, setWeekendsState] = useState(weekendsOn);
  const setWeekends = (v) => { weekendsOn = v; setWeekendsState(v); try { localStorage.setItem("mts-sched-weekends", v ? "1" : "0"); } catch {} };
  const [mode, setMode] = useState(() => { try { return localStorage.getItem("mts-sched-mode") || "day"; } catch { return "day"; } });
  useEffect(() => { try { localStorage.setItem("mts-sched-mode", mode); } catch {} }, [mode]);
  const [boards, setBoards] = useState({});          // iso -> crews for that day (week view)
  const [assign, setAssign] = useState({});          // this day: ref -> { crew, order, label, hrs, at, by }
  const [week, setWeek] = useState({});              // iso -> assign (planned on other days)
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState("open");          // open | all
  const [sort, setSort] = useState(() => { try { return localStorage.getItem("mts-sched-sort") || "old"; } catch { return "old"; } });
  useEffect(() => { try { localStorage.setItem("mts-sched-sort", sort); } catch {} }, [sort]);
  const [saving, setSaving] = useState(0);
  const [err, setErr] = useState("");
  const shop = useShop();
  const gen = useRef(0);

  const { points, state: geoState } = useJobPoints(jobs);
  const jobBy = useMemo(() => Object.fromEntries(jobs.map((j) => [j.ref, j])), [jobs]);
  /** The hours an entry puts on its day: a multi-day part's share, else the job's tree work. */
  const entryHrs = useCallback((x) => (x.parts ? (x.hrs || 0) : jobBy[x.ref] ? jobBy[x.ref].treeHrs : (x.hrs ?? 0)), [jobBy]);

  // load the day: crews from the Shop Board + this week's schedules
  useEffect(() => {
    const g = ++gen.current;
    setBoard(null); setSelected(null); setFitCrew(null);
    (async () => {
      const [b, wk] = await Promise.all([crewsForDay(iso), shopSchedRange(isoOf(weekStartOf(new Date(iso + "T12:00:00"))), 7)]);
      if (g !== gen.current) return;
      setBoard(b); setWeek(wk); setAssign(wk[iso]?.assign || {});
    })();
  }, [iso]);

  // week view: the crews for every day of the week (each day can differ on the Shop Board)
  const weekStartIso = isoOf(weekStartOf(new Date(iso + "T12:00:00")));
  const weekDays = useMemo(() => (weekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]).map((i) => isoOf(addDays(new Date(weekStartIso + "T12:00:00"), i))), [weekStartIso, weekends]);
  useEffect(() => {
    if (mode !== "week") return;
    let dead = false;
    Promise.all(weekDays.map((d) => crewsForDay(d).then((b) => [d, b]))).then((list) => { if (!dead) setBoards(Object.fromEntries(list)); });
    const t = setInterval(async () => { if (document.hidden || savingRef.current) return; const wk = await shopSchedRange(weekStartIso, 7); if (!dead && !savingRef.current) setWeek(wk); }, 10000);
    return () => { dead = true; clearInterval(t); };
  }, [mode, weekStartIso, weekends]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Does each scheduled job suit its crew? (equipment, crew size, things to call about)
  const checks = useMemo(() => {
    const out = {};
    if (!board) return out;
    Object.entries(byCrewRaw(assign)).forEach(([crewId, list]) => {
      const c = board.crews.find((x) => x.id === crewId); if (!c) return;
      const on = (c.people || []).filter((id) => board.core.people[id] && !board.core.people[id].del && !board.off.has(id)).length;
      list.forEach((x) => { out[x.ref] = checkJob(jobBy[x.ref]?.tags || x.tags, c, board.core.assets, on); });
    });
    return out;
  }, [board, assign, jobBy]);
  // Older entries saved before tags were stored: add them once, so the Shop Board can check them too.
  useEffect(() => {
    if (!board || !jobs.length) return;
    const fix = {};
    Object.entries(assign).forEach(([ref, a]) => { if (a?.crew && !ref.startsWith("_") && !a.tags && jobBy[ref]) fix[ref] = { ...a, tags: jobBy[ref].tags || [] }; });
    if (Object.keys(fix).length) save(fix);
  }, [board, assign, jobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const peopleOn = useCallback((c) => (c.people || []).filter((id) => board?.core.people[id] && !board.core.people[id].del && !board.off.has(id)).length, [board]);
  const crewIdx = useMemo(() => Object.fromEntries((board?.crews || []).map((c, i) => [c.id, i])), [board]);
  const crewColor = useCallback((id) => CREW_COLORS[(crewIdx[id] ?? 0) % CREW_COLORS.length], [crewIdx]);
  const byCrew = useMemo(() => {
    const out = {};
    Object.entries(assign).forEach(([ref, a]) => { if (a?.crew && !ref.startsWith("_")) (out[a.crew] = out[a.crew] || []).push({ ref, ...a }); });
    Object.values(out).forEach((l) => l.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
    return out;
  }, [assign]);
  const plannedOn = useMemo(() => {
    const out = {};
    Object.entries(week).forEach(([d, s]) => { if (d !== iso || mode === "week") Object.entries(s.assign || {}).forEach(([ref, a]) => { if (a?.crew && !ref.startsWith("_")) out[ref] = out[ref] && out[ref] < d ? out[ref] : d; }); });
    return out;
  }, [week, iso, mode]);
  const checksFor = useCallback((d, c, x) => {
    const b = boards[d]; if (!b) return null;
    const on = (c.people || []).filter((id) => b.core.people[id] && !b.core.people[id].del && !b.off.has(id)).length;
    return checkJob(jobBy[x.ref]?.tags || x.tags, c, b.core.assets, on);
  }, [boards, jobBy]);

  const isoRef = useRef(iso); isoRef.current = iso;
  /** Save job entries on any day (the day shown, or another day of the week). */
  const saveDay = async (dayIso, entries) => {
    const at = stampNow(), by = me?.name || me?.email || "?";
    const patch = {};
    Object.entries(entries).forEach(([ref, v]) => { patch[ref] = { ...v, at, by }; });
    if (dayIso === isoRef.current) setAssign((cur) => ({ ...cur, ...patch }));
    setWeek((w) => ({ ...w, [dayIso]: { ...(w[dayIso] || {}), assign: { ...((w[dayIso] || {}).assign || {}), ...patch } } }));
    setSaving((n) => n + 1);
    const merged = await shopPatch(`sched.${dayIso}`, { assign: patch });
    setSaving((n) => n - 1);
    if (!merged) setErr("Couldn't save the last change — check your connection. It will show again once saved.");
    else { setErr(""); setWeek((w) => ({ ...w, [dayIso]: merged })); }
  };
  const save = (entries) => saveDay(iso, entries);
  const label = (j) => ({ label: `${j.name} #${j.ref}`, town: j.town, hrs: j.treeHrs ?? j.hrs ?? 0, tags: j.tags || [] });
  // every crew runs out of the one shop (owner, Nov 24)
  const yardOf = useCallback(() => shop, [shop]);
  const autoOrder = (crewId) => {
    const items = byCrew[crewId] || [];
    const yard = yardOf(crewId);
    if (!yard) { setErr(`Still finding the shop (${SHOP_ADDR}) on the map — try again in a moment.`); return; }
    const placed = items.filter((x) => points[x.ref]), unplaced = items.filter((x) => !points[x.ref]);
    const ord = bestOrder(yard, placed.map((x) => ({ p: points[x.ref] })));
    const finalList = [...ord.map((i) => placed[i]), ...unplaced];
    const entries = {};
    finalList.forEach((x, i) => { if ((x.order ?? -1) !== i) entries[x.ref] = { ...assign[x.ref], order: i }; });
    if (Object.keys(entries).length) save(entries);
  };
  /* Put a job on a crew on a day. A job bigger than what the crew has left that
     day is split: today's share, then the same crew on the next weekdays (Sat/Sun
     skipped), a full day each, until it's done — "Day 1 of 3", "Day 2 of 3"…
     Each day counts only its own share. All its days are stored on each part,
     so taking it off (or moving it) takes every day with it. */
  const addToDay = async (dayIso, ref, crew, dayBoard, dayAssign) => {
    const j = jobBy[ref]; if (!j) return;
    const b = dayBoard || boards[dayIso] || board;
    const c = (b?.crews || []).find((x) => x.id === crew);
    const ppl = c ? (c.people || []).filter((id) => b.core.people[id] && !b.core.people[id].del && !b.off.has(id)).length : 2;
    const cap = Math.max(dayOsh(ppl || 1), 1);
    const A = dayAssign || (dayIso === iso ? assign : week[dayIso]?.assign) || {};
    const list = Object.entries(A).filter(([r, a]) => a?.crew === crew && r !== ref && !r.startsWith("_")).map(([r, a]) => ({ ref: r, ...a }));
    const used = list.reduce((t, x) => t + entryHrs(x), 0);
    const total = j.treeHrs ?? j.hrs ?? 0;
    const left = cap - used;
    const parts = [], days = [];
    const first = total <= Math.max(left, 0) + 0.25 ? total : left >= 1 ? left : Math.min(total, cap);
    parts.push(first); days.push(dayIso);
    let rest = total - first, d = dayIso, guard = 0;
    // following weekdays: only what the crew still has free that day (other jobs already
    // there count), so 24 free then 16 free rolls the rest into a third day
    while (rest > 0.25 && guard++ < 40) {
      d = nextWorkday(d);
      let A2 = week[d]?.assign;
      if (!A2) { try { A2 = (await shopGet(`sched.${d}`))?.assign || {}; } catch { A2 = {}; } }
      const b2 = boards[d];
      const c2 = b2 ? (b2.crews || []).find((x) => x.id === crew) : c;
      if (b2 && !c2) continue;                                       // crew not on the board that day
      const ppl2 = b2 && c2 ? (c2.people || []).filter((id) => b2.core.people[id] && !b2.core.people[id].del && !b2.off.has(id)).length : ppl;
      const cap2 = dayOsh(ppl2 || 0);
      const used2 = Object.entries(A2).filter(([r, a]) => a?.crew === crew && r !== ref && !r.startsWith("_")).reduce((t, [r, a]) => t + entryHrs({ ref: r, ...a }), 0);
      const free = cap2 - used2;
      if (free < 1) continue;                                        // full that day: try the next one
      const p = Math.min(rest, free);
      parts.push(p); days.push(d); rest -= p;
    }
    if (rest > 0.25) { parts[parts.length - 1] += rest; }
    const base = { crew, ...label(j), total };
    const multi = parts.length > 1 ? { parts: parts.length, days } : { parts: null, days: null };
    for (let k = 0; k < parts.length; k++) {
      const order = k === 0 ? (list.length ? Math.max(...list.map((x) => x.order ?? 0)) + 1 : 0) : -1;   // later days: first thing in the morning
      await saveDay(days[k], { [ref]: { ...base, ...multi, part: parts.length > 1 ? k + 1 : null, hrs: parts[k], order } });
    }
    setSelected(null);
  };
  const addTo = (ref, crew) => addToDay(iso, ref, crew);
  /** Take a job off (every day of it, if it spans several). */
  const removeFrom = (dayIso, ref) => {
    const e = (dayIso === iso ? assign : week[dayIso]?.assign || {})[ref] || {};
    (e.days && e.days.length ? e.days : [dayIso]).forEach((d) => saveDay(d, { [ref]: { crew: null, days: null, parts: null, part: null } }));
  };
  const remove = (ref) => removeFrom(iso, ref);
  /** Move a job (all its days) to another crew / day: it's re-planned from there. */
  const moveTo = async (fromIso, ref, toIso, crew) => {
    const e = (fromIso === iso ? assign : week[fromIso]?.assign || {})[ref] || {};
    if (fromIso === toIso && e.crew === crew) return;
    const gone = new Set(e.days && e.days.length ? e.days : [fromIso]);
    await Promise.all([...gone].map((d) => saveDay(d, { [ref]: { crew: null, days: null, parts: null, part: null } })));
    const A = { ...((toIso === iso ? assign : week[toIso]?.assign) || {}) }; delete A[ref];
    await addToDay(toIso, ref, crew, null, A);
  };
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
  const fitC = fitCrew && board?.crews.find((c) => c.id === fitCrew);
  const fitLeft = fitC ? Math.max(0, dayOsh(peopleOn(fitC)) - (byCrew[fitC.id] || []).reduce((t, x) => t + entryHrs(x), 0)) : 0;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const on = fitC ? peopleOn(fitC) : 0;
    return jobs.filter((j) => !assign[j.ref]?.crew)
      .filter((j) => show === "all" || (j.status !== "hold" && j.status !== "sched" && j.status !== "paused" && !j.nextVisit && !plannedOn[j.ref]))
      .filter((j) => !s || `${j.name} ${j.ref} ${j.addr} ${j.zone} ${j.tags.join(" ")} ${j.paused?.reason || ""}`.toLowerCase().includes(s))
      .filter((j) => passTags(j, tagF))
      .filter((j) => { const ks = seasonKeysOf(j.tags); return !ks.length || ks.some((k) => seasonsOn[k] !== false); })
      .filter((j) => !fitC || checkJob(j.tags, fitC, board.core.assets, on).problems === 0)

      // Emergency, then Priority jobs always sit at the top, whatever the sort
      .sort((a, b) => urgency(a) - urgency(b) || (nearCrew ? (distTo[a.ref] ?? 1e9) - (distTo[b.ref] ?? 1e9)
        : sort === "zone" ? (parseFloat(a.zone) || 99) - (parseFloat(b.zone) || 99)
        : sort === "old" ? (b.days || 0) - (a.days || 0)
        : sort === "big" ? (b.treeHrs || 0) - (a.treeHrs || 0)
        : STATUS[a.status].rank - STATUS[b.status].rank || b.lateWeeks - a.lateWeeks));
  }, [jobs, assign, show, plannedOn, q, sort, nearCrew, distTo, tagF, fitC, peopleOn, board, seasonsOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const [limit, setLimit] = useState(80);
  useEffect(() => setLimit(80), [q, show, sort]);
  // Stable list for the map (a new array every render made it rebuild every
  // marker on each re-render, which could swallow a tap mid-rebuild).
  const mapJobs = useMemo(() => jobs.filter((j) => assign[j.ref]?.crew || list.includes(j)), [jobs, assign, list]);
  const onMapPick = useCallback((r) => { setPausing(false); setSelected((s) => (s === r ? null : r)); }, []);

  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  if (!data) return <div className="wrap hint">Upload the backlog workbook on the Backlog tab first — the Schedule plans its jobs.</div>;

  const wkStart = weekStartOf(new Date(iso + "T12:00:00"));
  const sel = selected && jobBy[selected];
  const today = isoOf(new Date());

  return (
    <div className="wrap" style={{ maxWidth: 1800 }}>
      {/* day / week picker */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button className="btn st" data-primary={mode === "week" ? 1 : 0} onClick={() => setMode((m) => (m === "week" ? "day" : "week"))}
                title="Show the whole week above the crews (scroll down for the day)">{mode === "week" ? "▴ Hide week" : "▾ Week view"}</button>
        <button className="btn st" onClick={() => setIso(isoOf(addDays(new Date(iso + "T12:00:00"), -7)))}>‹</button>
        {(weekends ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]).map((i) => {
          const d = addDays(wkStart, i), di = isoOf(d);
          const n = Object.entries((di === iso ? { assign } : week[di])?.assign || {}).filter(([k, a]) => a?.crew && !k.startsWith("_")).length;
          return (
            <button key={di} className="chip st" data-on={di === iso ? 1 : 0} onClick={() => setIso(di)}
                    title={!weekends && (d.getDay() === 0 || d.getDay() === 6) ? "Weekend — off (turn on with the Weekends switch)" : undefined}
                    style={{ borderColor: di === today ? "#6b7880" : undefined, opacity: !weekends && (d.getDay() === 0 || d.getDay() === 6) ? 0.4 : 1 }}>
              {DN[d.getDay()]} {d.getDate()}{n ? <b>{n}</b> : null}
            </button>
          );
        })}
        <button className="btn st" onClick={() => setIso(isoOf(addDays(new Date(iso + "T12:00:00"), 7)))}>›</button>
        <button className="btn st" onClick={() => setIso(today)}>Today</button>
        <span className="spacer" />
        <button className="chip st" data-on={weekends ? 1 : 0} onClick={() => setWeekends(!weekends)} title="Weekends are off unless this is on">{weekends ? "Weekends: ON" : "Weekends: off"}</button>
        <button className="btn st" onClick={() => setRulesOpen((o) => !o)}>Tag → equipment</button>
        <span className="hint">{saving ? "Saving…" : board ? (board.from === iso ? "Crews from this day's Shop Board." : board.from === "standing" ? "Crews from the standing Shop Board setup." : `Crews from the Shop Board (same as ${board.from}).`) : ""}</span>
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      <CheckBackBanner jobs={jobs} onResume={resume} onEdit={(j) => setPurgJob(j)} />
      <UrgentBanner jobs={jobs} assign={assign} plannedOn={plannedOn} onPick={(r) => setSelected(r)} />
      {purgJob && <PurgatoryModal j={jobBy[purgJob.ref] || purgJob} onPause={pause} onResume={resume} onClose={() => setPurgJob(null)} />}
      {rulesOpen && <TagRules onClose={() => setRulesOpen(false)} />}
      {sel && (
        <div className="card" style={{ padding: "8px 12px", marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderColor: "#58666f" }}>
          <b>{sel.name}</b><span className="hint">#{sel.ref} · {sel.town} · {fmtH(sel.treeHrs)} tree work{sel.grindHrs ? ` + ${fmtH(sel.grindHrs)} stump` : ""} · {money(sel.price)}{plannedOn[sel.ref] ? ` · planned ${plannedOn[sel.ref]}` : ""}</span>
          <span className="spacer" />
          {assign[sel.ref]?.crew
            ? <button className="btn st" data-danger="1" onClick={() => { remove(sel.ref); setSelected(null); }}>Take off the schedule</button>
            : <span className="hint">Tap “Add here” on a crew.</span>}
          <button className="btn st" onClick={() => setSelected(null)}>Clear</button>
        </div>
      )}

      {mode === "week" && (
        <div style={{ marginBottom: 12 }}>
          <WeekGrid days={weekDays} boards={boards} week={week} jobBy={jobBy} entryHrs={entryHrs} crewColor={crewColor}
                    selected={selected} onSelect={(r) => setSelected((s) => (s === r ? null : r))}
                    onDropJob={(d, ref, crew) => addToDay(d, ref, crew, boards[d])} onMoveJob={moveTo} onRemove={removeFrom}
                    onOpenDay={(d) => setIso(d)} checksFor={checksFor} today={today} />
        </div>
      )}
      <CallList assign={assign} checks={checks} jobBy={jobBy} crews={board?.crews || []} crewColor={crewColor} />
      <div className="st hint" style={{ padding: "6px 0 4px", fontSize: 11.5 }}>{new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} — crews</div>
      {/* crews: smaller boxes across the top (owner, Nov 24); scroll sideways if there are many */}
      <div style={{ display: "flex", gap: 8, overflowX: "auto", alignItems: "flex-start", paddingBottom: 8, marginBottom: 12 }}>
          {!board && <div className="hint">Loading crews…</div>}
          {(board?.crews || []).map((c) => {
            const items = byCrew[c.id] || [];
            const total = items.reduce((t, x) => t + entryHrs(x), 0);
            const stumpTotal = items.reduce((t, x) => t + (jobBy[x.ref]?.grindHrs || 0) + (jobBy[x.ref]?.cleanupHrs || 0), 0);
            const target = dayOsh(peopleOn(c)), gap = target - total;
            const fitting = fitCrew === c.id;
            const yard = yardOf(c.id);
            const trip = tripKm(yard, items.map((x) => points[x.ref]).filter(Boolean));
            const ppl = (c.people || []).map((id) => board.core.people[id]).filter((p) => p && !p.del);
            const offHere = ppl.filter((p) => board.off.has(p.id));
            const probs = items.reduce((n, x) => n + (checks[x.ref]?.problems || 0), 0);
            return (
              <div key={c.id} className="card" onDragOver={(e) => e.preventDefault()}
                   onDrop={(e) => { e.preventDefault(); const ref = e.dataTransfer.getData("text/x-job"); if (ref) addTo(ref, c.id); }}
                   style={{ flex: "0 0 290px", maxHeight: 440, overflowY: "auto", borderTop: `4px solid ${crewColor(c.id)}`, boxShadow: fitting ? `0 0 0 2px ${crewColor(c.id)}` : "none" }}>
                <div className="card-h st" style={{ color: C.ink, fontSize: 12.5 }}>
                  {c.name}<span className="hint" style={{ textTransform: "none", letterSpacing: 0 }}>{ppl.filter((p) => !board.off.has(p.id)).map(firstName).join(", ") || "nobody on it"}{offHere.length ? ` (${offHere.map(firstName).join(", ")} off)` : ""}</span>
                  {probs > 0 && <span className="st" style={{ color: "#fff", background: C.red, borderRadius: 2, padding: "1px 6px", fontSize: 10.5 }} title="See the red notes on the jobs below">⚠ {probs}</span>}
                  <span className="spacer" />
                  <button className="chip st" data-on={fitting ? 1 : 0} style={{ borderColor: fitting ? crewColor(c.id) : undefined }}
                          onClick={() => setFitCrew((f) => (f === c.id ? null : c.id))} title="List only the jobs this crew can do">{fitting ? "✓ Finding work" : "Find work"}</button>
                  <span className="mono" style={{ color: target && gap > 0.05 ? C.amber : total > target + 1 ? C.amber : C.inkDim, textTransform: "none" }}
                        title={`Tree work on this crew vs a normal day: ${peopleOn(c)} people × ${fmtH(dayOsh(1), 2)}`}>
                    {fmtH(total)} / {fmtH(target, 2)}
                  </span>
                  {stumpTotal > 0 && <span className="mono" style={{ color: "#c9a0dc", fontSize: 11, textTransform: "none" }} title="Stump grinding + cleanup — not counted in the day's load">+{fmtH(stumpTotal)} stump</span>}
                </div>
                {target > 0 && gap > 0.05 && (
                  <div style={{ margin: "6px 8px 0", padding: "4px 8px", borderRadius: 2, background: "rgba(229,161,0,.14)", color: "#f0c050", fontSize: 12 }}>
                    {items.length ? "Light day" : "No work yet"}: {fmtH(gap)} short of a full day for {peopleOn(c)} {peopleOn(c) === 1 ? "person" : "people"} ({fmtH(target, 2)}).
                  </div>
                )}
                {target > 0 && total > target + 1 && (
                  <div style={{ margin: "6px 8px 0", padding: "4px 8px", borderRadius: 2, background: "rgba(229,161,0,.14)", color: "#f0c050", fontSize: 12 }}>
                    Heavy day: {fmtH(total - target)} more than a normal day for {peopleOn(c)} people.
                  </div>
                )}
                {items.length > 0 && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px 0", flexWrap: "wrap" }}>
                    <span className="hint">{trip ? `★ From the shop · ≈ ${miles(trip)} round trip, straight-line` : "★ From the shop"}</span>
                    <span className="spacer" />
                    {items.length > 1 && <button className="btn st" onClick={() => autoOrder(c.id)} title="Shortest order from the shop and back">Best order</button>}
                  </div>
                )}
                <div style={{ padding: 6, display: "grid", gap: 4, minHeight: 40 }}>
                  {items.map((x, i) => {
                    const j = jobBy[x.ref];
                    const prev = i > 0 ? points[items[i - 1].ref] : yard, here = points[x.ref];
                    return (
                      <div key={x.ref} onClick={() => setSelected(x.ref)}
                           style={{ display: "flex", gap: 6, alignItems: "center", padding: "5px 6px", background: selected === x.ref ? C.tileHi : C.tile, borderRadius: 3, cursor: "pointer" }}>
                        <span className="mono" style={{ width: 18, height: 18, borderRadius: 9, background: crewColor(c.id), color: "#0b0e11", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{j ? j.name : x.label}</div>
                          {x.parts > 1 && <div style={{ fontSize: 11, color: "#9cc4e4" }}>Day {x.part} of {x.parts} · {fmtH(x.hrs)} today of {fmtH(x.total)}</div>}
                          <div className="hint" style={{ fontSize: 11 }}>{j?.town || x.town}{j ? "" : ` · ${fmtH(x.hrs)}`}{prev && here ? ` · ${miles(km(prev, here))} from ${i === 0 ? "the shop" : "last"}` : ""}{!j ? " · no longer in the backlog" : ""}</div>
                          <JobChecks r={checks[x.ref]} />
                        </span>
                        {j && <JobHours j={j} size={13} />}
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

      {/* map + the job list underneath */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 12, alignItems: "start" }}>
        <div style={{ position: "sticky", top: 70 }}>
        <div className="card">
          <div style={{ height: "min(62vh, 620px)" }}>
            <ScheduleMap jobs={mapJobs} points={points} assign={assign}
                         crewColor={crewColor} selected={selected} onPick={onMapPick} yardOf={yardOf} shop={shop}>
              {sel && (
                <div className="card" style={{ position: "absolute", left: 10, right: 10, bottom: 10, zIndex: 5, padding: "10px 12px", background: "rgba(27,33,38,.97)", boxShadow: "0 6px 20px rgba(0,0,0,.5)", maxHeight: "60%", overflow: "auto" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{sel.name}{sel.paused ? ":" : ""}</b> {sel.paused && <span style={{ color: "#d7c4ff" }}>{sel.paused.reason}</span>} <span className="mono hint">#{sel.ref}</span>
                      <div className="hint">{sel.addr || sel.town}{sel.zone ? ` · Zone ${sel.zone}` : ""}{sel.crew ? ` · ${sel.crew}` : ""} · {money(sel.price)}</div>
                      <div style={{ fontSize: 12.5, marginTop: 3 }}>
                        {sel.days != null && <span style={{ color: jobColor(sel) }}>{Math.round(sel.days)} days waiting · </span>}
                        <span style={{ color: STATUS[sel.status].color }}>{promiseText(sel)}</span>
                        {plannedOn[sel.ref] ? <span className="hint"> · planned {plannedOn[sel.ref]}</span> : null}
                        {assign[sel.ref]?.crew ? <span className="hint"> · on {(board?.crews || []).find((c) => c.id === assign[sel.ref].crew)?.name || "a crew"} today</span> : null}
                      </div>
                      {sel.tags?.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }}>{sel.tags.map((t) => <TagPill key={t} tag={t} small />)}</div>}
                      {sel.note && <div style={{ marginTop: 4, fontSize: 12, color: "#c8ced2", lineHeight: 1.4 }}>{sel.note}</div>}
                      <JobChecks r={checks[sel.ref]} />
                    </div>
                    <JobHours j={sel} />
                    <button className="btn" onClick={() => setSelected(null)} aria-label="Close">✕</button>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {!assign[sel.ref]?.crew && (board?.crews || []).map((c) => (
                      <button key={c.id} className="btn st" style={{ borderColor: crewColor(c.id) }} onClick={() => addTo(sel.ref, c.id)}>+ {c.name}</button>
                    ))}
                    {assign[sel.ref]?.crew && <button className="btn st" data-danger="1" onClick={() => { remove(sel.ref); setSelected(null); }}>Take off the schedule</button>}
                    <a className="btn st" href={singleOpsJobUrl(sel.ref)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>Open in SingleOps</a>
                    <button className="btn st" style={{ borderColor: "#B388FF" }} onClick={() => setPurgJob(sel)}>{sel.paused ? "Purgatory…" : "⏸ Purgatory…"}</button>
                  </div>

                </div>
              )}
            </ScheduleMap>
          </div>
          <div className="hint" style={{ padding: "6px 10px" }}>{geoState || "Numbered dots = this day's stops, in order. Small dots = backlog jobs (coloured by status). ★ = the shop."}</div>
        </div>
        <div style={{ marginTop: 10 }}><SeasonBar on={seasonsOn} setOn={setSeasonsOn} jobs={jobs} /></div>
        </div>

        {/* backlog */}
        <div className="card">
          <div className="card-b" style={{ display: "grid", gap: 8 }}>
            {fitC && (
              <div style={{ padding: "6px 8px", borderRadius: 3, border: `1px solid ${crewColor(fitC.id)}`, display: "grid", gap: 5 }}>
                <div style={{ fontSize: 12.5 }}>Showing jobs <b style={{ color: crewColor(fitC.id) }}>{fitC.name}</b> can do (its machines, {peopleOn(fitC)} people). It has <b>{fmtH(fitLeft)}</b> left to fill today.</div>
                <div className="hint" style={{ padding: 0 }}>Tags this crew covers:</div>
                <TagRow tags={crewTags(fitC, board.core.assets, peopleOn(fitC))} />
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="chip st" onClick={() => setFitCrew(null)}>Show every job</button>
                </div>
              </div>
            )}
            <input className="inp" placeholder="Search name, job #, street, zone, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            <TagFilter jobs={jobs} value={tagF} onChange={setTagF} compact />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <select className="inp" style={{ width: "auto", flex: 1 }} value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="old">Oldest first</option>
                <option value="late">Most past promise first</option>
                <option value="big">Biggest first</option>
                <option value="zone">By zone</option>
                {(board?.crews || []).filter((c) => (byCrew[c.id] || []).length).map((c) => <option key={c.id} value={`near:${c.id}`}>Nearest to {c.name}'s stops</option>)}
              </select>
              <button className="chip st" data-on={show === "all" ? 1 : 0} onClick={() => setShow((v) => (v === "all" ? "open" : "all"))}>
                {show === "all" ? "Showing all (incl. Purgatory)" : "Hiding scheduled / Purgatory"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 11, color: C.inkDim }} title="The band on the left of each job">
              <span>Band:</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>newest <i style={{ width: 70, height: 7, borderRadius: 4, background: `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(gradientColor).join(",")})` }} /> oldest</span>
              {[[EMERGENCY_COLOR, "emergency"], [PRIORITY_COLOR, "priority"], [SEASON_COLOR, "waiting for season"], [PAUSED_COLOR, "purgatory"]].map(([c, l]) => (
                <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{l}</span>
              ))}
            </div>
            <TagStripKey />
            <div className="hint">{list.length} jobs · {fmtH(list.reduce((t, j) => t + (j.treeHrs || 0), 0), 0)} tree work · {fmtH(list.reduce((t, j) => t + (j.grindHrs || 0), 0), 0)} stump. Drag onto a crew, or tap to pick.</div>
          </div>
          <div style={{ maxHeight: "62vh", overflow: "auto", padding: "0 8px 8px", display: "grid", gap: 4 }}>
            {list.slice(0, limit).map((j) => (
              <div key={j.ref}>
              <div draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-job", j.ref); e.dataTransfer.effectAllowed = "move"; }}
                   onClick={() => setSelected((s) => (s === j.ref ? null : j.ref))}
                   style={{ display: "flex", gap: 8, padding: "6px 8px", borderRadius: 3, cursor: "grab", background: selected === j.ref ? C.tileHi : C.tile, borderLeft: `7px solid ${jobColor(j)}`,
                            boxShadow: j.status === "emergency" ? "inset 0 0 0 2px #FF1744" : j.status === "priority" ? "inset 0 0 0 1px #FF4FD8" : "none" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {j.status === "emergency" && <b style={{ color: "#fff", background: "#C4122F", borderRadius: 2, padding: "0 5px", marginRight: 5, fontSize: 10.5 }}>EMERGENCY</b>}
                    {j.status === "priority" && <b style={{ color: "#fff", background: "#A3168A", borderRadius: 2, padding: "0 5px", marginRight: 5, fontSize: 10.5 }}>PRIORITY</b>}
                    <b>{j.name}{j.paused ? ":" : ""}</b> {j.paused && <span style={{ color: "#d7c4ff" }}>{j.paused.reason}</span>} <span className="hint">#{j.ref}</span></div>
                  <div className="hint" style={{ fontSize: 11 }}>
                    {j.town}{j.zone ? ` · Z${j.zone}` : ""} · {j.crew || "?"} · {Math.round(j.days || 0)} d · {j.status === "over" ? (j.seasonal ? j.dueText : `${Math.round(j.lateWeeks)} wk late`) : j.seasonal ? j.dueText : STATUS[j.status].label}
                    {plannedOn[j.ref] ? ` · planned ${plannedOn[j.ref]}` : ""}{distTo[j.ref] != null ? ` · ${miles(distTo[j.ref])}` : ""}
                  </div>
                  <TagStrip tags={j.tags} />
                </span>
                <JobHours j={j} size={13} />
                {selected === j.ref && <span style={{ display: "flex", flexDirection: "column", gap: 3 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn" style={{ padding: "1px 6px", borderColor: "#B388FF" }} title={j.paused ? "In Purgatory — edit" : "Purgatory — can't be scheduled yet"}
                          onClick={() => setPurgJob(j)}>⏸</button>
                  <button className="btn" style={{ padding: "1px 6px" }} data-danger="1" title="Delete from the backlog"
                          onClick={() => setRowAct((r) => (r?.ref === j.ref && r.kind === "del" ? null : { ref: j.ref, kind: "del" }))}>🗑</button>
                </span>}
              </div>
              {rowAct?.ref === j.ref && rowAct.kind === "del" && (
                <div style={{ margin: "3px 0 6px", padding: 8, border: "1px solid #D93B2B", borderRadius: 3, background: "rgba(217,59,43,.08)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5 }}>Delete <b>{j.name}</b> (#{j.ref}) from the Dispatch backlog? It won't come back on the next import. You can restore it on the Backlog tab.</span>
                  <button className="btn st" data-danger="1" onClick={async () => { try { await deleteJob(j.ref, j.name); setRowAct(null); setSelected(null); } catch (e) { setErr(`Couldn't delete (${e.message}).`); } }}>Yes, delete</button>
                  <button className="btn st" onClick={() => setRowAct(null)}>Cancel</button>
                </div>
              )}
              </div>
            ))}
            {list.length > limit && <button className="btn st" onClick={() => setLimit((l) => l + 100)}>Show more</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
