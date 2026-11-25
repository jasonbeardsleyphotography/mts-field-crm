import { useMemo, useState, useEffect } from "react";
import { api } from "./api";
import { useBacklog } from "./useBacklog";
import { workdaysBetween } from "./backlogModel";
import { C } from "./theme";

/* ═══════════════════════════════════════════════════════════════════════════
   PERFORMANCE (owner, Nov 25) — our promise vs what we did.
   For every visit in the Visit exports uploaded so far (kept across uploads in
   backlog.history): the day it was sold (Converted to Active), the promise
   (Backlog, in weeks; the window is promise → promise + 2), and the day the
   work started (Start). Weeks are Mon–Fri work weeks from the sold day, the same
   way "where it lands" counts them. 99 (flexible) and seasonal jobs are left out.
   ═══════════════════════════════════════════════════════════════════════════ */

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const wk = (a, b) => workdaysBetween(new Date(a + "T12:00:00"), new Date(b + "T12:00:00")) / 5;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
const f1 = (n) => (n == null || isNaN(n) ? "—" : n.toFixed(1));
const avg = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
const monthLabel = (ym) => new Date(ym + "-15T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" });
const RANGES = [["3", "Last 3 months"], ["6", "Last 6 months"], ["12", "Last 12 months"], ["all", "Everything"]];

/* What kind of visit it is (owner, Nov 25). Only "main" counts toward the backlog promise:
   emergency (1–5 days), priority (within 2 weeks), stump-only jobs (2–4 weeks) and the
   follow-up stump visits (grinding after the main job, cleanup / soil & seed after grinding)
   are measured separately. */
const isTreeTag = (t) => /^0[23] /.test(t) && !/STUMP|GRIND/i.test(t);
export function kindOf(ref, h, history, lineItems) {
  const tags = h.tags || [];
  if (tags.some((t) => /EMERGENCY/i.test(t))) return "emergency";
  if (tags.some((t) => /\*\*PRIORITY\*\*|^07 PRIORITY/i.test(t))) return "priority";
  const grind = tags.some((t) => /^07 STUMPS?$/i.test(t)) || h.stumps;
  const clean = tags.some((t) => /STUMP CLEAN/i.test(t)), seed = tags.some((t) => /SEED/i.test(t));
  const li = lineItems?.[ref];
  const treeHrs = li ? (h.hrs || 0) - (li.grindHrs || 0) - (li.cleanupHrs || 0) - (li.seedHrs || 0) : null;
  const stumpy = grind || clean || seed;
  const noTree = h.tags ? !tags.some(isTreeTag) : /-\d+$/.test(ref) && !/-1$/.test(ref);
  const stumpOnly = stumpy && (treeHrs != null ? treeHrs <= 0.25 : noTree);
  if (!stumpOnly) return "main";
  const base = ref.split("-")[0];
  const hasMain = Object.entries(history).some(([r, o]) => r !== ref && r.split("-")[0] === base && !(o.stumps && (o.tags ? !o.tags.some(isTreeTag) : /-\d+$/.test(r) && !/-1$/.test(r))));
  if (!grind && (clean || seed)) return seed && !clean ? "seed" : "cleanup";
  return hasMain ? "followGrind" : "stumpJob";
}

const noPromise = { n: 0 };
function rowsOf(history, today, lineItems) {
  const out = [];
  noPromise.n = 0;
  for (const [ref, h] of Object.entries(history || {})) {
    if (!h.activeAt) continue;
    const kind = kindOf(ref, h, history, lineItems);
    const started = h.start && h.start <= today ? h.start : (h.done || "");
    const finished = h.done || "";
    if (kind === "main") {
      // no Backlog entry in SingleOps (blank — or 0 / a stray ".2") = no promise: left out entirely (owner, Nov 25)
      if (h.promised == null || h.promised < 1 || h.promised >= 99 || h.seasonal) { if (h.promised == null || h.promised < 1) noPromise.n++; continue; }
      const weeks = started ? wk(h.activeAt, started) : wk(h.activeAt, today);
      const result = !started ? (weeks > h.promised + 2 ? "waitingLate" : "waiting")
        : weeks < h.promised ? "early" : weeks <= h.promised + 2 ? "onTime" : "late";
      out.push({ ref, ...h, kind, started, weeks, result, over: Math.max(0, weeks - (h.promised + 2)) });
    } else {
      const end = finished || started;
      const days = Math.round((new Date((end || today) + "T12:00:00") - new Date(h.activeAt + "T12:00:00")) / 86400000);
      out.push({ ref, ...h, kind, started, finished, end, days, weeks: wk(h.activeAt, end || today), open: !end });
    }
  }
  return out;
}
const median = (l) => { if (!l.length) return null; const a = [...l].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const wdays = (a, b) => workdaysBetween(new Date(a + "T12:00:00"), new Date(b + "T12:00:00"));

function Tile({ big, label, sub, color }) {
  return (
    <div className="card" style={{ padding: "10px 14px", minWidth: 150, borderTop: `3px solid ${color || C.edge}` }}>
      <div className="st" style={{ fontSize: 26, color: color || C.ink }}>{big}</div>
      <div style={{ fontSize: 12.5 }}>{label}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.inkDim }}>{sub}</div>}
    </div>
  );
}

function Table({ title, rows, keyLabel }) {
  return (
    <div className="card">
      <div className="card-h st">{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ color: C.inkDim, textAlign: "right" }}>
            <th style={{ textAlign: "left", padding: "6px 10px" }}>{keyLabel}</th><th style={{ padding: 6 }}>Started</th><th style={{ padding: 6 }}>On time or early</th><th style={{ padding: 6 }}>Late</th><th style={{ padding: 6 }}>Avg promise</th><th style={{ padding: 6 }}>Avg actual</th><th style={{ padding: "6px 10px" }}>Avg late by</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: `1px solid ${C.edgeSoft}`, textAlign: "right" }}>
                <td style={{ textAlign: "left", padding: "6px 10px" }}>{r.label}</td>
                <td className="mono" style={{ padding: 6 }}>{r.n}</td>
                <td className="mono" style={{ padding: 6, color: "#6fd39a" }}>{pct(r.ok, r.n)}</td>
                <td className="mono" style={{ padding: 6, color: r.late ? "#ff8a7a" : C.inkDim }}>{pct(r.late, r.n)}</td>
                <td className="mono" style={{ padding: 6 }}>{f1(r.prom)} wk</td>
                <td className="mono" style={{ padding: 6 }}>{f1(r.act)} wk</td>
                <td className="mono" style={{ padding: "6px 10px" }}>{r.lateBy == null ? "—" : `${f1(r.lateBy)} wk`}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="hint" style={{ padding: 10 }}>Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const summarize = (key, label, list) => {
  const late = list.filter((r) => r.result === "late");
  return { key, label, n: list.length, ok: list.filter((r) => r.result === "early" || r.result === "onTime").length, late: late.length,
           prom: avg(list.map((r) => r.promised)), act: avg(list.map((r) => r.weeks)), lateBy: avg(late.map((r) => r.over)) };
};

/* a separate measure: tiles + a short list of the ones that missed */
function Separate({ title, target, note, n, good, goodLabel, avgLabel, avg, open, misses, color }) {
  return (
    <div className="card" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="card-h st">{title}<span className="spacer" /><span style={{ fontSize: 11.5, color: C.inkDim, textTransform: "none", letterSpacing: 0 }}>{target}</span></div>
      <div className="card-b" style={{ display: "grid", gap: 8 }}>
        {note && <div className="hint" style={{ padding: 0 }}>{note}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Tile big={n} label="finished" />
          {good != null && <Tile big={pct(good, n)} label={goodLabel} color="#6fd39a" />}
          <Tile big={avg} label={avgLabel} />
          {open != null && <Tile big={open} label="still open" color={open ? "#f0c050" : undefined} />}
        </div>
        {misses && misses.length > 0 && (
          <div style={{ display: "grid", gap: 3, fontSize: 12.5 }}>
            {misses.slice(0, 12).map((m) => (
              <div key={m.ref} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="mono" style={{ color: C.inkDim, width: 70 }}>#{m.ref}</span><b>{m.name}</b><span style={{ color: C.inkDim }}>{m.town}</span>
                <span className="spacer" style={{ flex: 1 }} /><span style={{ color: "#ff8a7a" }}>{m.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Performance() {
  const { data } = useBacklog();
  const [range, setRange] = useState(() => { try { return localStorage.getItem("mts-perf-range") || "12"; } catch { return "12"; } });
  const [stumpState, setStumpState] = useState({});
  useEffect(() => { api("stumps").then((r) => setStumpState(r.stumps || {})).catch(() => {}); }, []);
  const today = isoOf(new Date());
  const all = useMemo(() => rowsOf(data?.history, today, data?.lineItems), [data, today]);
  const from = range === "all" ? "" : isoOf(new Date(new Date().setMonth(new Date().getMonth() - Number(range))));
  const main = all.filter((r) => r.kind === "main");
  const started = main.filter((r) => r.started && r.started >= from);
  const waiting = main.filter((r) => !r.started);
  const s = summarize("all", "All", started);
  const early = started.filter((r) => r.result === "early").length;
  const byMonth = Object.entries(started.reduce((m, r) => ((m[r.activeAt.slice(0, 7)] = m[r.activeAt.slice(0, 7)] || []).push(r), m), {}))
    .sort((a, b) => b[0].localeCompare(a[0])).map(([k, l]) => summarize(k, monthLabel(k), l));
  const byPromise = Object.entries(started.reduce((m, r) => ((m[r.promised] = m[r.promised] || []).push(r), m), {}))
    .sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, l]) => summarize(k, `${k}–${Number(k) + 2} weeks`, l));
  const byRep = Object.entries(started.reduce((m, r) => ((m[r.rep || "—"] = m[r.rep || "—"] || []).push(r), m), {}))
    .sort((a, b) => b[1].length - a[1].length).map(([k, l]) => summarize(k, k, l));
  const worst = started.filter((r) => r.result === "late").sort((a, b) => b.over - a.over).slice(0, 25);
  const overdue = waiting.filter((r) => r.result === "waitingLate").sort((a, b) => b.over - a.over);
  const completed = Object.values(data?.history || {}).filter((h) => h.done).length;
  const noTags = Object.values(data?.history || {}).some((h) => !h.tags);

  /* ── kept separate ── */
  const inRange = (r) => r.end && r.end >= from;
  const em = all.filter((r) => r.kind === "emergency"), emDone = em.filter(inRange);
  const pr = all.filter((r) => r.kind === "priority"), prDone = pr.filter(inRange);
  const sj = all.filter((r) => r.kind === "stumpJob"), sjDone = sj.filter((r) => r.started && r.started >= from);
  // grinding after the main job: main visit finished → grinding visit finished (work days)
  const hist = data?.history || {};
  const mainDone = (ref) => {
    const base = ref.split("-")[0];
    const ds = all.filter((o) => o.ref !== ref && o.ref.split("-")[0] === base && o.kind === "main").map((o) => hist[o.ref]?.done).filter(Boolean).sort();
    return ds[ds.length - 1] || "";
  };
  const fg = all.filter((r) => r.kind === "followGrind").map((r) => ({ ...r, mainAt: mainDone(r.ref) }));
  const fgDone = fg.filter((r) => r.finished && r.mainAt && r.finished >= from).map((r) => ({ ...r, gap: wdays(r.mainAt, r.finished) }));
  const fgOpen = fg.filter((r) => !r.finished && r.mainAt).map((r) => ({ ...r, gap: wdays(r.mainAt, today) }));
  // cleanup / soil & seed after grinding: SingleOps visits (cleanup visit finished − grinding finished) + this app's Stumps stages
  const grindDoneOf = (ref) => {
    const base = ref.split("-")[0];
    const ds = Object.entries(hist).filter(([r, h]) => r !== ref && r.split("-")[0] === base && h.done && (h.stumps || (h.tags || []).some((t) => /^07 STUMPS?$/i.test(t)))).map(([, h]) => h.done).sort();
    return ds[ds.length - 1] || "";
  };
  const cl = [], sd = [];
  all.filter((r) => r.kind === "cleanup" || r.kind === "seed").forEach((r) => {
    const g = grindDoneOf(r.ref); if (!g || !r.finished || r.finished < from) return;
    (r.kind === "cleanup" ? cl : sd).push({ ref: r.ref, name: r.name, town: r.town, gap: wdays(g, r.finished), src: "SingleOps" });
  });
  Object.entries(stumpState).forEach(([ref, st]) => {
    const L = st.log || {}; const nm = st.snap?.name || ref, town = st.snap?.town || "";
    const ground = L.cleanup || L.seed;                    // the day it was ground (moved on from grinding)
    const cleanDone = L.cleanup && (L.seed || L.done);
    if (L.cleanup && cleanDone && cleanDone >= from && !cl.some((x) => x.ref === ref)) cl.push({ ref, name: nm, town, gap: wdays(L.cleanup, cleanDone), src: "app" });
    if (L.seed && L.done && L.done >= from && !sd.some((x) => x.ref === ref)) sd.push({ ref, name: nm, town, gap: wdays(ground, L.done), src: "app" });
  });
  const f1d = (n) => (n == null ? "—" : `${n.toFixed(1)} work days`);

  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  return (
    <div className="wrap" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {RANGES.map(([k, l]) => <button key={k} className="chip st" data-on={range === k ? 1 : 0} onClick={() => { setRange(k); try { localStorage.setItem("mts-perf-range", k); } catch {} }}>{l}</button>)}
      </div>
      <div className="hint" style={{ padding: 0 }}>
        BACKLOG PROMISE: on time = work started within promise → promise + 2 work weeks of the day it was converted to active.
        Jobs with no Backlog weeks in SingleOps{noPromise.n ? ` (${noPromise.n} on file)` : ""} are left out completely.
        Left out here and measured on their own below: emergencies, priority jobs, stump-only jobs, and the follow-up stump visits
        (grinding after the main job, cleanup and soil & seed after grinding). Flexible (99) and seasonal jobs are left out.
      </div>
      {(completed < 20 || noTags) && (
        <div className="card" style={{ borderLeft: "4px solid #f0c050" }}><div className="card-b" style={{ fontSize: 13.5 }}>
          {completed < 20 ? <>Only {completed} completed visits are on file so far. </> : null}
          For real numbers, upload a SingleOps <b>Visit export with ALL stages</b> (Active AND Completed) covering the time you want to measure,
          on Schedule → Backlog → Update from SingleOps.{noTags ? " Visits uploaded before today don't carry their tags yet — one new upload sorts emergencies, priority and stump visits properly." : ""}
        </div></div>
      )}
      <div className="st" style={{ fontSize: 13, color: C.inkDim }}>Backlog promise</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Tile big={s.n} label="jobs started" sub={range === "all" ? "everything on file" : RANGES.find((x) => x[0] === range)[1].toLowerCase()} />
        <Tile big={pct(s.ok, s.n)} label="on time or early" sub={`${early} early · ${s.ok - early} in the window`} color="#6fd39a" />
        <Tile big={pct(s.late, s.n)} label="started late" sub={s.lateBy == null ? "" : `late by ${f1(s.lateBy)} wk on average`} color="#ff8a7a" />
        <Tile big={`${f1(s.act)} wk`} label="sold → started, average" sub={`promised ${f1(s.prom)} wk on average`} />
        <Tile big={overdue.length} label="not started, already past promise" sub={`${waiting.length} not started in all`} color="#f0c050" />
      </div>
      <Table title="By month sold" keyLabel="Sold in" rows={byMonth} />
      <Table title="By promise" keyLabel="Promised" rows={byPromise} />
      <Table title="By sales rep" keyLabel="Rep" rows={byRep} />
      <div className="card">
        <div className="card-h st">Latest starts past the promise (worst first)</div>
        <div className="card-b" style={{ display: "grid", gap: 4, fontSize: 13 }}>
          {!worst.length && <div className="hint">None.</div>}
          {worst.map((r) => (
            <div key={r.ref} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ color: C.inkDim, width: 70 }}>#{r.ref}</span><b>{r.name}</b><span style={{ color: C.inkDim }}>{r.town}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <span>sold {new Date(r.activeAt + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · promised {r.promised}–{r.promised + 2} · started after {f1(r.weeks)} wk</span>
              <b style={{ color: "#ff8a7a" }}>+{f1(r.over)} wk</b>
            </div>
          ))}
        </div>
      </div>

      <div className="st" style={{ fontSize: 13, color: C.inkDim, marginTop: 8 }}>Measured separately — not in the numbers above</div>
      <Separate title="🚨 Emergencies" target="should be done within 1–5 days of the sale" color="#FF1744"
                n={emDone.length} good={emDone.filter((r) => r.days <= 5).length} goodLabel="done within 5 days"
                avg={emDone.length ? `${f1(avg(emDone.map((r) => r.days)))} days` : "—"} avgLabel="sold → done, average"
                open={em.filter((r) => r.open).length}
                misses={emDone.filter((r) => r.days > 5).sort((a, b) => b.days - a.days).map((r) => ({ ...r, text: `${r.days} days` }))} />
      <Separate title="⭐ Priority" target="should be done within 2 weeks of the sale" color="#FF4FD8"
                n={prDone.length} good={prDone.filter((r) => r.weeks <= 2).length} goodLabel="done within 2 weeks"
                avg={prDone.length ? `${f1(avg(prDone.map((r) => r.weeks)))} wk` : "—"} avgLabel="sold → done, average"
                open={pr.filter((r) => r.open).length}
                misses={prDone.filter((r) => r.weeks > 2).sort((a, b) => b.weeks - a.weeks).map((r) => ({ ...r, text: `${f1(r.weeks)} wk` }))} />
      <Separate title="🪵 Stump-only jobs" target="2–4 week backlog" color="#e8743b"
                note="Jobs sold for stump work only (no tree work on the job)."
                n={sjDone.length} good={sjDone.filter((r) => r.weeks <= 4).length} goodLabel="started within 4 weeks"
                avg={sjDone.length ? `${f1(avg(sjDone.map((r) => r.weeks)))} wk` : "—"} avgLabel="sold → started, average"
                open={sj.filter((r) => !r.started).length}
                misses={sjDone.filter((r) => r.weeks > 4).sort((a, b) => b.weeks - a.weeks).map((r) => ({ ...r, text: `${f1(r.weeks)} wk` }))} />
      <Separate title="Grinding after the main job" target="no promise — how long it usually takes" color="#a0522d"
                note="Stump grinding visits (mostly the “-2” ones): work days from the main job's visit being completed to the grinding visit being completed."
                n={fgDone.length} avg={fgDone.length ? f1d(avg(fgDone.map((r) => r.gap))) : "—"} avgLabel={`average · median ${fgDone.length ? f1d(median(fgDone.map((r) => r.gap))) : "—"}`}
                open={fgOpen.length}
                misses={fgOpen.sort((a, b) => b.gap - a.gap).map((r) => ({ ...r, text: `waiting ${r.gap} work days since the main job` }))} />
      <Separate title="Stump cleanup after grinding" target="no promise — how long it usually takes" color="#8d6e63"
                note="Work days from grinding to the cleanup being done (SingleOps cleanup visits, and jobs moved along on the Stumps tab)."
                n={cl.length} avg={cl.length ? f1d(avg(cl.map((r) => r.gap))) : "—"} avgLabel={`average · median ${cl.length ? f1d(median(cl.map((r) => r.gap))) : "—"}`} />
      <Separate title="Soil & seed after grinding" target="no promise — how long it usually takes" color="#3cb44b"
                note="Work days from grinding to soil & seed being done."
                n={sd.length} avg={sd.length ? f1d(avg(sd.map((r) => r.gap))) : "—"} avgLabel={`average · median ${sd.length ? f1d(median(sd.map((r) => r.gap))) : "—"}`} />
    </div>
  );
}
