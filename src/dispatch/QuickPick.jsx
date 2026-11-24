import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { C } from "./theme";
import { STATUS, jobColor, singleOpsJobUrl, tagShort } from "./backlogModel";
import { useBacklog } from "./useBacklog";
import { useJobPoints, loadMaps } from "./BacklogMap.jsx";
import JobHours from "./JobHours.jsx";
import TagPill from "./TagPill.jsx";
import TagFilter, { emptyTags, passTags } from "./TagFilter.jsx";
import { PauseForm, promiseText } from "./Backlog.jsx";
import { crewsForDay, km, miles } from "./Schedule.jsx";
import { shopGet, shopPatch, stampNow, shopSettings } from "./shop/shopApi";
import { isoOf } from "./shop/ShopBoard.jsx";
import { checkJob } from "./crewCheck";
import { useShop, starIcon } from "./shopLocation";
import { fmtH, useHoursUnit, dayOsh, inUnit, hoursUnit } from "./hours";

/* ═══════════════════════════════════════════════════════════════════════════
   Quick pick — for the field: a crew calls and needs more work.
   Pick the crew (the app knows its machines and people from today's Shop
   Board), pick a range of hours, and the map shows the jobs that match,
   nearest first — nearest to the crew's last stop today (or the yard, or
   where you are). Tap one to add it to that crew's day.
   Made for a phone; works the same on a computer.
   ═══════════════════════════════════════════════════════════════════════════ */

const CREW_COLORS = ["#4FC3F7", "#FFB74D", "#BA68C8", "#81C784", "#F06292", "#FFF176", "#4DB6AC", "#E57373"];
// hour ranges in the viewer's unit
const RANGES = [["any", "Any", 0, Infinity], ["s", "Under 2", 0, 2], ["m", "2–4", 2, 4], ["l", "4–8", 4, 8], ["xl", "8+", 8, Infinity]];
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const directions = (addr) => (isIOS() ? `https://maps.apple.com/?daddr=${encodeURIComponent(addr)}` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`);

function QuickMap({ jobs, points, origin, selected, onPick, crewColor, shop }) {
  const shopMark = useRef(null);
  const el = useRef(null), map = useRef(null), marks = useRef(new Map()), originMark = useRef(null), lastFit = useRef("");
  const pickRef = useRef(onPick); pickRef.current = onPick;
  const [ready, setReady] = useState(false), [err, setErr] = useState("");
  useEffect(() => {
    loadMaps().then(() => {
      if (!el.current) return;
      map.current = new window.google.maps.Map(el.current, {
        center: { lat: 43.12, lng: -77.55 }, zoom: 10, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
        gestureHandling: "greedy",
        styles: [{ elementType: "geometry", stylers: [{ color: "#1d2329" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#8a959d" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#14181c" }] }, { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c353c" }] },
          { featureType: "water", stylers: [{ color: "#0f2433" }] }, { featureType: "poi", stylers: [{ visibility: "off" }] }],
      });
      setReady(true);
    }).catch(() => setErr("The map couldn't load."));
  }, []);
  useEffect(() => {
    const g = window.google?.maps; if (!ready || !g) return;
    const want = new Set();
    jobs.forEach((j, i) => {
      const p = points[j.ref]; if (!p) return;
      want.add(j.ref);
      const sel = selected === j.ref, top = i < 5;
      const icon = { path: g.SymbolPath.CIRCLE, scale: sel ? 12 : top ? 9 : 7, fillColor: jobColor(j), fillOpacity: 0.95, strokeColor: sel ? "#fff" : "#0b0e11", strokeWeight: sel ? 3 : 1.4 };
      let m = marks.current.get(j.ref);
      if (!m) {
        m = new g.Marker({ map: map.current, position: p, icon, title: j.name });
        m.addListener("click", () => pickRef.current?.(j.ref));
        marks.current.set(j.ref, m);
      } else { m.setIcon(icon); m.setPosition(p); }
      m.setZIndex(sel ? 999 : 500 - i);
    });
    for (const [ref, m] of marks.current) if (!want.has(ref)) { m.setMap(null); marks.current.delete(ref); }
    // origin
    if (originMark.current) { originMark.current.setMap(null); originMark.current = null; }
    if (shop && !shopMark.current) shopMark.current = new g.Marker({ map: map.current, position: shop, zIndex: 900, clickable: false, title: `Shop — ${shop.addr}`, icon: starIcon(g) });
    if (origin?.p) {
      originMark.current = new g.Marker({ map: map.current, position: origin.p, zIndex: 1000, clickable: false, title: origin.label,
        icon: { path: "M -8 -8 L 8 -8 L 8 8 L -8 8 Z", fillColor: crewColor || "#E7E2D6", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2, scale: 1 } });
    }
    // re-fit when the starting point or the match set changes a lot
    const key = `${origin?.p?.lat},${origin?.p?.lng}|${jobs.slice(0, 8).map((j) => j.ref).join(",")}`;
    if (key !== lastFit.current) {
      lastFit.current = key;
      const b = new g.LatLngBounds(); let n = 0;
      if (origin?.p) { b.extend(origin.p); n++; }
      jobs.slice(0, 8).forEach((j) => { if (points[j.ref]) { b.extend(points[j.ref]); n++; } });
      if (n > 1) map.current.fitBounds(b, 60); else if (n === 1 && origin?.p) map.current.panTo(origin.p);
    }
  }, [ready, jobs, points, origin, selected, crewColor, shop]);
  useEffect(() => { const p = selected && points[selected]; if (p && map.current) map.current.panTo(p); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={el} style={{ position: "absolute", inset: 0, background: "#1d2329" }} />
      {err && <div className="err" style={{ position: "absolute", top: 8, left: 8 }}>{err}</div>}
    </div>
  );
}

export default function QuickPick({ me }) {
  useHoursUnit();
  const iso = isoOf(new Date());
  const { data, jobs, pause, resume } = useBacklog();
  const { points } = useJobPoints(jobs);
  const [board, setBoard] = useState(null);
  const [assign, setAssign] = useState({});
  const shop = useShop();
  const [crewId, setCrewId] = useState(() => { try { return localStorage.getItem("mts-qp-crew") || ""; } catch { return ""; } });
  const [range, setRange] = useState("any");
  const [fit, setFit] = useState(true);
  const [tagF, setTagF] = useState(emptyTags);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [near, setNear] = useState("crew");          // crew | me
  const [me_, setMe] = useState(null);              // my position (this device only, never sent)
  const [selected, setSelected] = useState(null);
  const [sheet, setSheet] = useState("peek");       // peek | full
  const [pausing, setPausing] = useState(false);
  const [msg, setMsg] = useState("");
  const [top, setTop] = useState(110);
  const [folded, setFolded] = useState(false);       // filters folded to one line

  useEffect(() => {
    const h = document.querySelector(".hd");
    const set = () => setTop(h ? h.getBoundingClientRect().height : 110);
    set(); window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  }, []);
  useEffect(() => { try { localStorage.setItem("mts-qp-crew", crewId); } catch {} }, [crewId]);
  useEffect(() => {
    let dead = false;
    (async () => {
      const [b, s] = await Promise.all([crewsForDay(iso), shopGet(`sched.${iso}`)]);
      if (dead) return;
      setBoard(b); setAssign(s?.assign || {});
    })();
    const t = setInterval(async () => { if (!document.hidden) { const s = await shopGet(`sched.${iso}`); if (s?.assign) setAssign(s.assign); } }, 15000);
    return () => { dead = true; clearInterval(t); };
  }, [iso]);

  const crews = board?.crews || [];
  const crew = crews.find((c) => c.id === crewId) || null;
  const crewColor = (id) => CREW_COLORS[Math.max(0, crews.findIndex((c) => c.id === id)) % CREW_COLORS.length];
  const peopleOn = useCallback((c) => (c?.people || []).filter((id) => board?.core.people[id] && !board.core.people[id].del && !board.off.has(id)).length, [board]);
  const jobBy = useMemo(() => Object.fromEntries(jobs.map((j) => [j.ref, j])), [jobs]);
  const stops = useMemo(() => Object.entries(assign).filter(([ref, a]) => a?.crew === crewId && !ref.startsWith("_")).map(([ref, a]) => ({ ref, ...a })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [assign, crewId]);
  const loaded = stops.reduce((t, x) => t + (jobBy[x.ref] ? jobBy[x.ref].treeHrs : (x.hrs || 0)), 0);
  const left = crew ? Math.max(0, dayOsh(peopleOn(crew)) - loaded) : 0;

  // where "nearest" is measured from
  const origin = useMemo(() => {
    if (near === "me") return me_ ? { p: me_, label: "You are here" } : null;
    const last = [...stops].reverse().find((x) => points[x.ref]);
    if (last) return { p: points[last.ref], label: `${crew?.name || "Crew"}'s last stop: ${jobBy[last.ref]?.name || last.label}` };
    if (crew && shop) return { p: { lat: shop.lat, lng: shop.lng }, label: "the shop (no stops yet today)" };
    return null;
  }, [near, me_, stops, points, crew, jobBy, shop]);
  const locate = () => {
    setMsg("Finding you…");
    navigator.geolocation?.getCurrentPosition(
      (pos) => { setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setNear("me"); setMsg(""); },
      () => setMsg("Couldn't get your location — allow location for this site, or use the crew's last stop."),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
  };

  const matches = useMemo(() => {
    const [, , lo, hi] = RANGES.find((r) => r[0] === range) || RANGES[0];
    const on = crew ? peopleOn(crew) : 0;
    return jobs
      .filter((j) => !assign[j.ref]?.crew && !["paused", "hold", "sched", "season"].includes(j.status))
      .filter((j) => { const h = inUnit(j.treeHrs || 0); return h >= lo && h < hi; })
      .filter((j) => passTags(j, tagF))
      .filter((j) => !fit || !crew || checkJob(j.tags, crew, board.core.assets, on).problems === 0)
      .map((j) => ({ j, d: origin?.p && points[j.ref] ? km(origin.p, points[j.ref]) : null }))
      .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || (b.j.days || 0) - (a.j.days || 0));
  }, [jobs, assign, range, tagF, fit, crew, board, origin, points, peopleOn]);
  const shown = useMemo(() => matches.map((m) => m.j), [matches]);
  const distOf = useMemo(() => Object.fromEntries(matches.map((m) => [m.j.ref, m.d])), [matches]);
  const sel = selected && jobBy[selected];

  const add = async (j) => {
    if (!crew) return;
    const at = stampNow(), by = me?.name || me?.email || "?";
    const order = stops.length ? Math.max(...stops.map((x) => x.order ?? 0)) + 1 : 0;
    const entry = { crew: crew.id, order, label: `${j.name} #${j.ref}`, town: j.town, hrs: j.treeHrs ?? j.hrs ?? 0, tags: j.tags || [], at, by };
    setAssign((a) => ({ ...a, [j.ref]: entry }));
    const merged = await shopPatch(`sched.${iso}`, { assign: { [j.ref]: entry } });
    if (!merged) { setMsg("Couldn't save — check your connection and try again."); setAssign((a) => { const n = { ...a }; delete n[j.ref]; return n; }); }
    else { setAssign(merged.assign || {}); setMsg(`${j.name} added to ${crew.name} today (stop ${order + 1}).`); setSelected(null); }
  };

  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  if (!data) return <div className="wrap hint">Upload the backlog workbook on the Backlog tab first.</div>;

  const pill = { position: "absolute", left: 8, right: 8, zIndex: 6, background: "rgba(27,33,38,.96)", border: `1px solid ${C.edge}`, borderRadius: 6, boxShadow: "0 6px 20px rgba(0,0,0,.45)" };
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, top, overflow: "hidden" }}>
      <QuickMap shop={shop} jobs={shown} points={points} origin={origin} selected={selected} onPick={(r) => { setPausing(false); setSelected((s) => (s === r ? null : r)); setSheet("peek"); }} crewColor={crew ? crewColor(crew.id) : null} />

      {/* controls */}
      <div style={{ ...pill, top: 8, padding: 8, display: "grid", gap: 7, maxHeight: "55%", overflow: "auto" }}>
        {folded ? (
          <button onClick={() => setFolded(false)} style={{ display: "flex", gap: 8, alignItems: "center", textAlign: "left" }}>
            {crew && <i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: crewColor(crew.id) }} />}
            <b className="st" style={{ fontSize: 12.5 }}>{crew ? crew.name : "No crew picked"}</b>
            <span className="hint" style={{ padding: 0 }}>{(RANGES.find((r) => r[0] === range) || RANGES[0])[1]} {hoursUnit()}{crew && fit ? " · fits crew" : ""}{tagF.inc.length + tagF.exc.length ? ` · ${tagF.inc.length + tagF.exc.length} tags` : ""} · {near === "me" ? "near me" : "near crew"}</span>
            <span className="spacer" /><span className="hint" style={{ padding: 0 }}>Filters ▾</span>
          </button>
        ) : <>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, alignItems: "center" }}>
          {!board && <span className="hint">Loading crews…</span>}
          {crews.map((c) => (
            <button key={c.id} className="chip st" data-on={crewId === c.id ? 1 : 0} onClick={() => { setCrewId(c.id); setNear("crew"); setSelected(null); }}
                    style={{ borderColor: crewId === c.id ? crewColor(c.id) : undefined, flexShrink: 0, padding: "8px 11px" }}>
              <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: crewColor(c.id), marginRight: 5 }} />{c.name}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", alignItems: "center", paddingBottom: 2 }}>
          <span className="hint" style={{ padding: 0, flexShrink: 0 }}>{hoursUnit()}</span>
          {RANGES.map(([k, l]) => <button key={k} className="chip st" data-on={range === k ? 1 : 0} style={{ flexShrink: 0, padding: "7px 10px" }} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", alignItems: "center", paddingBottom: 2 }}>
          {crew && <button className="chip st" data-on={fit ? 1 : 0} style={{ flexShrink: 0, padding: "7px 10px" }} onClick={() => setFit((v) => !v)} title="Only jobs this crew's machines and people can do">{fit ? "✓ Fits crew" : "Fits crew: off"}</button>}
          <button className="chip st" data-on={tagsOpen || tagF.inc.length + tagF.exc.length ? 1 : 0} style={{ flexShrink: 0, padding: "7px 10px" }} onClick={() => setTagsOpen((v) => !v)}>Tags{tagF.inc.length + tagF.exc.length ? ` (${tagF.inc.length + tagF.exc.length})` : ""}</button>
          <button className="chip st" data-on={near === "crew" ? 1 : 0} style={{ flexShrink: 0, padding: "7px 10px" }} onClick={() => setNear("crew")}>Near crew</button>
          <button className="chip st" data-on={near === "me" ? 1 : 0} style={{ flexShrink: 0, padding: "7px 10px" }} onClick={locate}>Near me</button>
        </div>
        {tagsOpen && <TagFilter jobs={jobs.filter((j) => !assign[j.ref]?.crew)} value={tagF} onChange={setTagF} compact />}
        {crew && (
          <div className="hint" style={{ padding: 0 }}>
            {crew.name}: {peopleOn(crew)} people · {fmtH(loaded)} of {fmtH(dayOsh(peopleOn(crew)), 2)} loaded today{origin ? ` · from ${origin.label}` : " · set a yard address in Schedule → Yards"}
          </div>
        )}
        {!crew && board && <div className="hint" style={{ padding: 0 }}>Pick the crew that called.</div>}
        <button className="chip st" style={{ justifySelf: "start" }} onClick={() => setFolded(true)}>▴ Fold filters</button>
        </>}
        {msg && <div style={{ fontSize: 12.5, color: "#f0c050" }}>{msg}</div>}
      </div>

      {/* bottom sheet: the selected job, or nearest matches */}
      <div style={{ ...pill, bottom: 8, maxHeight: sel ? "62%" : sheet === "full" ? "70%" : "40%", display: "flex", flexDirection: "column" }}>
        {sel ? (
          <div style={{ padding: 10, overflow: "auto", display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{sel.name}{sel.paused ? ":" : ""}</b> {sel.paused && <span style={{ color: "#d7c4ff" }}>{sel.paused.reason}</span>} <span className="mono hint">#{sel.ref}</span>
                <div className="hint" style={{ padding: 0 }}>{sel.addr}{distOf[sel.ref] != null ? ` · ${miles(distOf[sel.ref])}` : ""}{sel.crew ? ` · ${sel.crew}` : ""}</div>
                <div style={{ fontSize: 12.5 }}><span style={{ color: jobColor(sel) }}>{Math.round(sel.days || 0)} days waiting</span> · <span style={{ color: STATUS[sel.status].color }}>{promiseText(sel)}</span></div>
              </div>
              <JobHours j={sel} />
              <button className="btn" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            </div>
            {sel.tags?.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{sel.tags.map((t) => <TagPill key={t} tag={t} small />)}</div>}
            {crew && (() => { const r = checkJob(sel.tags, crew, board.core.assets, peopleOn(crew)); return r.problems || r.calls.length ? (
              <div style={{ fontSize: 12 }}>
                {r.missing.map((m, i) => <div key={i} style={{ color: "#ff9a8f" }}>Needs {m.label} — {m.why}</div>)}
                {r.short && <div style={{ color: "#ff9a8f" }}>{r.short.need}-person job · {crew.name} has {r.short.have}</div>}
                {r.calls.map((t, i) => <div key={i} style={{ color: "#f0c050" }}>📞 {t}</div>)}
              </div>) : null; })()}
            {sel.note && <div style={{ fontSize: 12.5, color: "#c8ced2", lineHeight: 1.4 }}>{sel.note}</div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {crew && <button className="btn st" data-primary="1" style={{ borderColor: crewColor(crew.id), padding: "10px 13px" }} onClick={() => add(sel)}>+ Add to {crew.name} today</button>}
              <a className="btn st" style={{ textDecoration: "none", padding: "10px 13px" }} href={directions(sel.addr)} target="_blank" rel="noopener noreferrer">Directions</a>
              <a className="btn st" style={{ textDecoration: "none", padding: "10px 13px" }} href={singleOpsJobUrl(sel.ref)} target="_blank" rel="noopener noreferrer">SingleOps</a>
              <button className="btn st" style={{ borderColor: "#B388FF", padding: "10px 13px" }} onClick={() => setPausing((v) => !v)}>⏸ Purgatory…</button>
            </div>
            {pausing && <PauseForm j={sel} onPause={pause} onResume={resume} onDone={() => { setPausing(false); setSelected(null); }} />}
          </div>
        ) : (
          <>
            <button onClick={() => setSheet((s) => (s === "full" ? "peek" : "full"))} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${C.edgeSoft}` }}>
              <b className="st" style={{ fontSize: 12.5 }}>{matches.length} match{matches.length === 1 ? "" : "es"}</b>
              <span className="hint" style={{ padding: 0 }}>{origin ? "nearest first" : "oldest first"}</span>
              <span className="spacer" />
              <span className="hint" style={{ padding: 0 }}>{sheet === "full" ? "▾ less" : "▴ more"}</span>
            </button>
            <div style={{ overflow: "auto", padding: 6, display: "grid", gap: 4 }}>
              {matches.slice(0, 40).map(({ j, d }) => (
                <button key={j.ref} onClick={() => { setSelected(j.ref); setPausing(false); }}
                        style={{ display: "flex", gap: 8, alignItems: "center", textAlign: "left", padding: "8px 8px", background: C.tile, borderRadius: 3, borderLeft: `4px solid ${jobColor(j)}` }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b>{j.name}</b> <span className="hint" style={{ padding: 0 }}>{j.town}</span></div>
                    <div className="hint" style={{ padding: 0 }}>{d != null ? miles(d) + " · " : ""}{Math.round(j.days || 0)} d · {j.needs.join(", ") || "no special equipment"}</div>
                  </span>
                  <JobHours j={j} size={14} />
                </button>
              ))}
              {!matches.length && <div className="hint">No jobs match. Widen the hours, turn off “Fits crew”, or clear tags.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
