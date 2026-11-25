import { useMemo, useState } from "react";
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

function rowsOf(history, today) {
  const out = [];
  for (const [ref, h] of Object.entries(history || {})) {
    if (h.promised == null || h.promised >= 99 || h.seasonal || !h.activeAt) continue;
    const started = h.start && h.start <= today ? h.start : (h.done || "");
    const weeks = started ? wk(h.activeAt, started) : wk(h.activeAt, today);
    const result = !started ? (weeks > h.promised + 2 ? "waitingLate" : "waiting")
      : weeks < h.promised ? "early" : weeks <= h.promised + 2 ? "onTime" : "late";
    out.push({ ref, ...h, started, weeks, result, over: Math.max(0, weeks - (h.promised + 2)) });
  }
  return out;
}

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

export default function Performance() {
  const { data } = useBacklog();
  const [range, setRange] = useState(() => { try { return localStorage.getItem("mts-perf-range") || "12"; } catch { return "12"; } });
  const [stumps, setStumps] = useState(false);
  const today = isoOf(new Date());
  const all = useMemo(() => rowsOf(data?.history, today), [data, today]);
  const from = range === "all" ? "" : isoOf(new Date(new Date().setMonth(new Date().getMonth() - Number(range))));
  const pool = all.filter((r) => stumps || !r.stumps);
  const started = pool.filter((r) => r.started && r.started >= from);
  const waiting = pool.filter((r) => !r.started);
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

  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  return (
    <div className="wrap" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {RANGES.map(([k, l]) => <button key={k} className="chip st" data-on={range === k ? 1 : 0} onClick={() => { setRange(k); try { localStorage.setItem("mts-perf-range", k); } catch {} }}>{l}</button>)}
        <label style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}><input type="checkbox" checked={stumps} onChange={(e) => setStumps(e.target.checked)} /> include stump visits</label>
      </div>
      <div className="hint" style={{ padding: 0 }}>
        Promise = the job's Backlog weeks in SingleOps; on time = work started within promise → promise + 2 work weeks of the day it was converted to active.
        Flexible (99) and seasonal jobs are left out. Counted by the day the work started.
      </div>
      {completed < 20 && (
        <div className="card" style={{ borderLeft: "4px solid #f0c050" }}><div className="card-b" style={{ fontSize: 13.5 }}>
          Only {completed} completed visits are on file so far. For real numbers, upload a SingleOps <b>Visit export with ALL stages</b> (Active AND Completed),
          covering the time you want to measure (e.g. the last 12 months), on Schedule → Backlog → Update from SingleOps. Each upload adds to what's kept.
        </div></div>
      )}
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
    </div>
  );
}
