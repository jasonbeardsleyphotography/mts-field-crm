import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { C } from "./theme";
import { STATUS, money, jobColor, singleOpsJobUrl, tagShort } from "./backlogModel";
import JobHours from "./JobHours.jsx";
import { useBacklog } from "./useBacklog";
import { fmtH, useHoursUnit, dayOsh } from "./hours";
import TagFilter, { emptyTags, passTags } from "./TagFilter.jsx";
import { PauseForm, promiseText } from "./Backlog.jsx";
import { useJobPoints, loadMaps } from "./BacklogMap.jsx";
import { shopGet, shopDays, shopPatch, shopSchedRange, stampNow, shopSettings, saveYard } from "./shop/shopApi";
import { freshCore, mergeCore, live, isoOf, addDays, weekStartOf, assetsOn } from "./shop/ShopBoard.jsx";
import { sharedDay, setSharedDay } from "./sharedDay";
import { checkJob, TAG_RULES, UNMAPPED_TAGS } from "./crewCheck";

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
const YARD_NAMES = ["Brighton", "Rush Scottsville"];
const defaultYard = (c) => (["PHC", "LC"].includes(c.ops) ? "Rush Scottsville" : "Brighton");
const yardKey = (crewId) => `_yard:${crewId}`;     // per-day yard choice, stored beside the jobs

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
export async function crewsForDay(iso) {
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
  return { core, off, crews: live(crews).filter((c) => ["GTC", "PHC", "LC"].includes(c.ops || "GTC")), from: day?.crews ? from : "standing" };
}

function ScheduleMap({ jobs, points, assign, crewColor, selected, onPick, yardOf, children }) {
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
        if (!yardsDrawn.has(`${y.lat},${y.lng}`)) {
          yardsDrawn.add(`${y.lat},${y.lng}`); bounds.extend(y);
          layers.current.push(new g.Marker({ map: map.current, position: y, zIndex: 5, clickable: false, title: `Yard: ${y.name}`,
            icon: { path: "M -7 -7 L 7 -7 L 7 7 L -7 7 Z", fillColor: "#E7E2D6", fillOpacity: 1, strokeColor: "#0b0e11", strokeWeight: 1.5, scale: 1 },
            label: { text: "Y", color: "#0b0e11", fontSize: "10px", fontWeight: "700" } }));
        }
      }
      if (path.length > 1) layers.current.push(new g.Polyline({ map: map.current, path, strokeColor: crewColor(crew), strokeOpacity: 0.9, strokeWeight: 3, clickable: false }));
    });
    if (any && !fitted.current) { map.current.fitBounds(bounds, 30); fitted.current = true; }
  }, [jobs, points, assign, selected, crewColor, yardOf]);
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
  if (!r || (!r.problems && !r.calls.length && !r.gear.length)) return null;
  const chip = (bg, fg) => ({ display: "inline-block", fontSize: 10.5, padding: "1px 6px", borderRadius: 2, background: bg, color: fg, marginRight: 4, marginTop: 3 });
  return (
    <div>
      {r.missing.map((m, i) => <span key={i} style={chip("rgba(217,59,43,.18)", "#ff9a8f")} title={m.why}>needs {m.label}{m.why !== "not on this crew" ? ` · ${m.why}` : ""}</span>)}
      {r.short && <span style={chip("rgba(217,59,43,.18)", "#ff9a8f")}>{r.short.need}-person job · crew has {r.short.have}</span>}
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

function YardSettings({ settings, onSaved, onClose }) {
  const names = [...new Set([...YARD_NAMES, ...Object.keys(settings.yards || {})])];
  const [vals, setVals] = useState(() => Object.fromEntries(names.map((n) => [n, settings.yards?.[n]?.addr || ""])));
  const [busy, setBusy] = useState(""), [msg, setMsg] = useState("");
  const save = async (name) => {
    setBusy(name); setMsg("");
    try { onSaved(await saveYard(name, vals[name])); setMsg(`${name} saved.`); }
    catch (e) {
      if (e.message !== "address_not_found") { setMsg(`Couldn't save (${e.message}).`); setBusy(""); return; }
      // the free lookup missed it: try Google's, in this browser
      try {
        await loadMaps();
        const res = await new Promise((ok) => new window.google.maps.Geocoder().geocode({ address: vals[name] }, (r, st) => ok(st === "OK" ? r[0].geometry.location : null)));
        if (!res) throw new Error();
        onSaved(await saveYard(name, vals[name], { lat: res.lat(), lng: res.lng() })); setMsg(`${name} saved.`);
      } catch { setMsg("That address couldn't be found. Check the spelling and include the town."); }
    }
    setBusy("");
  };
  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, display: "grid", gap: 8, maxWidth: 640 }}>
      <div className="st" style={{ fontSize: 13 }}>Yard addresses</div>
      <div className="hint">Where crews start and finish. "Best order" plans the shortest loop from the crew's yard and back (straight-line distance, not roads).</div>
      {names.map((n) => (
        <div key={n} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ width: 130 }}>{n}</span>
          <input className="inp" style={{ flex: "1 1 240px" }} placeholder="Street, town, NY zip" value={vals[n] || ""} onChange={(e) => setVals({ ...vals, [n]: e.target.value })} />
          <button className="btn st" disabled={!vals[n]?.trim() || busy === n} onClick={() => save(n)}>{busy === n ? "Finding…" : "Save"}</button>
        </div>
      ))}
      {msg && <div className="hint">{msg}</div>}
      <div><button className="btn st" onClick={onClose}>Close</button></div>
    </div>
  );
}

export default function Schedule({ me }) {
  useHoursUnit();
  const [iso, setIso] = useState(() => sharedDay(isoOf(new Date())));
  useEffect(() => { setSharedDay(iso); }, [iso]);
  const { data, jobs, pause, resume } = useBacklog();
  const [tagF, setTagF] = useState(emptyTags);
  const [fitCrew, setFitCrew] = useState(null);      // crew id: list only jobs that crew can do
  const [rulesOpen, setRulesOpen] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [board, setBoard] = useState(null);          // { core, crews, from }
  const [assign, setAssign] = useState({});          // this day: ref -> { crew, order, label, hrs, at, by }
  const [week, setWeek] = useState({});              // iso -> assign (planned on other days)
  const [selected, setSelected] = useState(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState("open");          // open | all
  const [sort, setSort] = useState("late");
  const [saving, setSaving] = useState(0);
  const [err, setErr] = useState("");
  const [settings, setSettings] = useState({ yards: {} });
  const [yardsOpen, setYardsOpen] = useState(false);
  const gen = useRef(0);
  useEffect(() => { shopSettings().then(setSettings); }, []);

  const { points, state: geoState } = useJobPoints(jobs);
  const jobBy = useMemo(() => Object.fromEntries(jobs.map((j) => [j.ref, j])), [jobs]);

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
    Object.entries(week).forEach(([d, s]) => { if (d !== iso) Object.entries(s.assign || {}).forEach(([ref, a]) => { if (a?.crew && !ref.startsWith("_")) out[ref] = d; }); });
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
  const label = (j) => ({ label: `${j.name} #${j.ref}`, town: j.town, hrs: j.treeHrs ?? j.hrs ?? 0, tags: j.tags || [] });
  const crewYardName = useCallback((crewId) => {
    const c = (board?.crews || []).find((x) => x.id === crewId);
    return assign[yardKey(crewId)]?.yard || (c ? defaultYard(c) : "Brighton");
  }, [board, assign]);
  const yardOf = useCallback((crewId) => {
    const name = crewYardName(crewId), y = settings.yards?.[name];
    return y ? { lat: y.lat, lng: y.lng, name } : null;
  }, [crewYardName, settings]);
  const autoOrder = (crewId) => {
    const items = byCrew[crewId] || [];
    const yard = yardOf(crewId);
    if (!yard) { setErr(`Set the ${crewYardName(crewId)} yard address first (Yards button, top right) so the route can start there.`); setYardsOpen(true); return; }
    const placed = items.filter((x) => points[x.ref]), unplaced = items.filter((x) => !points[x.ref]);
    const ord = bestOrder(yard, placed.map((x) => ({ p: points[x.ref] })));
    const finalList = [...ord.map((i) => placed[i]), ...unplaced];
    const entries = {};
    finalList.forEach((x, i) => { if ((x.order ?? -1) !== i) entries[x.ref] = { ...assign[x.ref], order: i }; });
    if (Object.keys(entries).length) save(entries);
  };
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
  const fitC = fitCrew && board?.crews.find((c) => c.id === fitCrew);
  const fitLeft = fitC ? Math.max(0, dayOsh(peopleOn(fitC)) - (byCrew[fitC.id] || []).reduce((t, x) => t + (jobBy[x.ref] ? jobBy[x.ref].treeHrs : (x.hrs || 0)), 0)) : 0;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const on = fitC ? peopleOn(fitC) : 0;
    return jobs.filter((j) => !assign[j.ref]?.crew)
      .filter((j) => show === "all" || (j.status !== "hold" && j.status !== "sched" && j.status !== "paused" && !plannedOn[j.ref]))
      .filter((j) => !s || `${j.name} ${j.ref} ${j.addr} ${j.zone} ${j.tags.join(" ")} ${j.paused?.reason || ""}`.toLowerCase().includes(s))
      .filter((j) => passTags(j, tagF))
      .filter((j) => !fitC || checkJob(j.tags, fitC, board.core.assets, on).problems === 0)

      .sort(nearCrew ? (a, b) => (distTo[a.ref] ?? 1e9) - (distTo[b.ref] ?? 1e9)
        : sort === "zone" ? (a, b) => (parseFloat(a.zone) || 99) - (parseFloat(b.zone) || 99)
        : sort === "old" ? (a, b) => (b.days || 0) - (a.days || 0)
        : sort === "big" ? (a, b) => (b.treeHrs || 0) - (a.treeHrs || 0)
        : (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || b.lateWeeks - a.lateWeeks);
  }, [jobs, assign, show, plannedOn, q, sort, nearCrew, distTo, tagF, fitC, peopleOn, board]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {/* day picker */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <button className="btn st" onClick={() => setIso(isoOf(addDays(new Date(iso + "T12:00:00"), -7)))}>‹</button>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const d = addDays(wkStart, i), di = isoOf(d);
          const n = Object.entries((di === iso ? { assign } : week[di])?.assign || {}).filter(([k, a]) => a?.crew && !k.startsWith("_")).length;
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
        <button className="btn st" onClick={() => setRulesOpen((o) => !o)}>Tag → equipment</button>
        <button className="btn st" onClick={() => setYardsOpen((o) => !o)}>Yards</button>
        <span className="hint">{saving ? "Saving…" : board ? (board.from === iso ? "Crews from this day's Shop Board." : board.from === "standing" ? "Crews from the standing Shop Board setup." : `Crews from the Shop Board (same as ${board.from}).`) : ""}</span>
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {yardsOpen && <YardSettings settings={settings} onSaved={setSettings} onClose={() => setYardsOpen(false)} />}
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 12, alignItems: "start" }}>
        {/* crews */}
        <div style={{ display: "grid", gap: 8 }}>
          <CallList assign={assign} checks={checks} jobBy={jobBy} crews={board?.crews || []} crewColor={crewColor} />
          {!board && <div className="hint">Loading crews…</div>}
          {(board?.crews || []).map((c) => {
            const items = byCrew[c.id] || [];
            const total = items.reduce((t, x) => t + (jobBy[x.ref] ? jobBy[x.ref].treeHrs : (x.hrs ?? 0)), 0);
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
                   style={{ borderLeft: `4px solid ${crewColor(c.id)}`, boxShadow: fitting ? `0 0 0 2px ${crewColor(c.id)}` : "none" }}>
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
                    <span className="hint">From</span>
                    <select className="inp" style={{ width: "auto", padding: "3px 6px", fontSize: 11.5 }} value={crewYardName(c.id)}
                            onChange={(e) => save({ [yardKey(c.id)]: { yard: e.target.value } })}>
                      {[...new Set([...YARD_NAMES, ...Object.keys(settings.yards || {})])].map((y) => <option key={y} value={y}>{y}{settings.yards?.[y] ? "" : " (no address)"}</option>)}
                    </select>
                    <span className="hint">{trip ? `≈ ${miles(trip)} round trip, straight-line` : ""}</span>
                    <span className="spacer" />
                    {items.length > 1 && <button className="btn st" onClick={() => autoOrder(c.id)} title="Shortest order from the yard and back">Best order</button>}
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
                          <div className="hint" style={{ fontSize: 11 }}>{j?.town || x.town}{j ? "" : ` · ${fmtH(x.hrs)}`}{prev && here ? ` · ${miles(km(prev, here))} from ${i === 0 ? "yard" : "last"}` : ""}{!j ? " · no longer in the backlog" : ""}</div>
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

        {/* map */}
        <div className="card" style={{ position: "sticky", top: 70 }}>
          <div style={{ height: "min(70vh, 680px)" }}>
            <ScheduleMap jobs={mapJobs} points={points} assign={assign}
                         crewColor={crewColor} selected={selected} onPick={onMapPick} yardOf={yardOf}>
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
                      {sel.tags?.length > 0 && <div className="hint" style={{ marginTop: 3 }}>{sel.tags.map(tagShort).join(" · ")}</div>}
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
                    <button className="btn st" style={{ borderColor: "#B388FF" }} onClick={() => setPausing((v) => !v)}>{sel.paused ? "Edit pause" : "⏸ Pause…"}</button>
                  </div>
                  {pausing && <div style={{ marginTop: 8 }}><PauseForm j={sel} onPause={pause} onResume={resume} onDone={() => setPausing(false)} /></div>}
                </div>
              )}
            </ScheduleMap>
          </div>
          <div className="hint" style={{ padding: "6px 10px" }}>{geoState || "Numbered dots = this day's stops, in order. Small dots = backlog jobs (coloured by status)."}</div>
        </div>

        {/* backlog */}
        <div className="card">
          <div className="card-b" style={{ display: "grid", gap: 8 }}>
            {fitC && (
              <div style={{ padding: "6px 8px", borderRadius: 3, border: `1px solid ${crewColor(fitC.id)}`, display: "grid", gap: 5 }}>
                <div style={{ fontSize: 12.5 }}>Showing jobs <b style={{ color: crewColor(fitC.id) }}>{fitC.name}</b> can do (its machines, {peopleOn(fitC)} people). It has <b>{fmtH(fitLeft)}</b> left to fill today.</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="chip st" onClick={() => setFitCrew(null)}>Show every job</button>
                </div>
              </div>
            )}
            <input className="inp" placeholder="Search name, job #, street, zone, tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            <TagFilter jobs={jobs} value={tagF} onChange={setTagF} compact />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <select className="inp" style={{ width: "auto", flex: 1 }} value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="late">Most past promise first</option>
                <option value="old">Oldest first</option>
                <option value="big">Biggest first</option>
                <option value="zone">By zone</option>
                {(board?.crews || []).filter((c) => (byCrew[c.id] || []).length).map((c) => <option key={c.id} value={`near:${c.id}`}>Nearest to {c.name}'s stops</option>)}
              </select>
              <button className="chip st" data-on={show === "all" ? 1 : 0} onClick={() => setShow((v) => (v === "all" ? "open" : "all"))}>
                {show === "all" ? "Showing all (incl. paused)" : "Hiding scheduled / on hold / paused"}
              </button>
            </div>
            <div className="hint">{list.length} jobs · {fmtH(list.reduce((t, j) => t + (j.treeHrs || 0), 0), 0)} tree work · {fmtH(list.reduce((t, j) => t + (j.grindHrs || 0), 0), 0)} stump. Drag onto a crew, or tap to pick.</div>
          </div>
          <div style={{ maxHeight: "62vh", overflow: "auto", padding: "0 8px 8px", display: "grid", gap: 4 }}>
            {list.slice(0, limit).map((j) => (
              <div key={j.ref} draggable onDragStart={(e) => { e.dataTransfer.setData("text/x-job", j.ref); e.dataTransfer.effectAllowed = "move"; }}
                   onClick={() => setSelected((s) => (s === j.ref ? null : j.ref))}
                   style={{ display: "flex", gap: 8, padding: "6px 8px", borderRadius: 3, cursor: "grab", background: selected === j.ref ? C.tileHi : C.tile, borderLeft: `3px solid ${jobColor(j)}` }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b>{j.name}{j.paused ? ":" : ""}</b> {j.paused && <span style={{ color: "#d7c4ff" }}>{j.paused.reason}</span>} <span className="hint">#{j.ref}</span></div>
                  <div className="hint" style={{ fontSize: 11 }}>
                    {j.town}{j.zone ? ` · Z${j.zone}` : ""} · {j.crew || "?"} · {Math.round(j.days || 0)} d · {j.status === "over" ? (j.seasonal ? j.dueText : `${Math.round(j.lateWeeks)} wk late`) : j.seasonal ? j.dueText : STATUS[j.status].label}
                    {plannedOn[j.ref] ? ` · planned ${plannedOn[j.ref]}` : ""}{distTo[j.ref] != null ? ` · ${miles(distTo[j.ref])}` : ""}
                  </div>
                </span>
                <JobHours j={j} size={13} />
              </div>
            ))}
            {list.length > limit && <button className="btn st" onClick={() => setLimit((l) => l + 100)}>Show more</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
