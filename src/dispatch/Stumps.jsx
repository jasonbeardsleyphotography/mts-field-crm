import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "./api";
import { useBacklog } from "./useBacklog";
import { fmtH, useHoursUnit } from "./hours";
import { C } from "./theme";
import { TagRow } from "./TagPill.jsx";
import { singleOpsJobUrl } from "./backlogModel";
import BacklogMap, { useJobPoints } from "./BacklogMap.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   STUMPS (owner, Nov 25) — the stump work that follows the tree work.
   Stages: Waiting on tree work → Needs stake-out → Ready to grind →
   Ready for cleanup → Ready for soil & seed → Done.
   • Which jobs: visits tagged 07 STUMP… or with stump work on their line items.
     Stump-only visits are no longer in the Backlog / Schedule / Quick pick lists.
   • Waiting: tree work is still in the backlog on the same job number (or on this visit).
   • Stake-out: date called + CLEARANCE window (clear from → clear until). The job
     moves to Ready to grind by itself on the clear-from day; the window shows on
     the week calendar and on the job (grind before it ends).
   • A ground visit that SingleOps closes moves on by itself to cleanup / soil &
     seed / done (what it was sold with). Cleanup and soil & seed are outsourced:
     "Contractor report" makes a printable sheet with each job's details.
   Stored on the server: mts-dispatch stumps/state, one job per save.
   ═══════════════════════════════════════════════════════════════════════════ */

export const STAGES = [
  { key: "waiting", label: "Waiting on tree work", short: "Waiting", color: "#7d8a94" },
  { key: "stakeout", label: "Needs stake-out", short: "Stake-out", color: "#f0c050" },
  { key: "grind", label: "Ready to grind", short: "Grind", color: "#e8743b" },
  { key: "cleanup", label: "Ready for cleanup", short: "Cleanup", color: "#a0522d" },
  { key: "seed", label: "Ready for soil & seed", short: "Soil & seed", color: "#3cb44b" },
  { key: "done", label: "Done", short: "Done", color: "#4b5a64" },
];
const ST = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
const nice = (iso, wd) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { ...(wd ? { weekday: "short" } : {}), month: "short", day: "numeric" }) : "");
const mondayOf = (iso) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const needsCleanup = (j) => j.cleanup > 0 || j.cleanupHrs > 0 || j.tags.some((t) => /STUMP CLEAN|DEBRIS/i.test(t));
const needsSeed = (j) => j.seed > 0 || j.seedHrs > 0 || j.tags.some((t) => /SEED/i.test(t));
const afterGrind = (j) => (needsCleanup(j) ? "cleanup" : needsSeed(j) ? "seed" : "done");
const afterCleanup = (j) => (needsSeed(j) ? "seed" : "done");
/** What the job was sold with, in words. */
const workText = (j) => [
  j.grindUnits ? `${j.grindUnits} stump${j.grindUnits === 1 ? "" : "s"} to grind` : "",
  j.cleanup ? `${j.cleanup} stump${j.cleanup === 1 ? "" : "s"} to clean up` : needsCleanup(j) ? "stump cleanup" : "",
  j.seed ? `${Math.round(j.seed)} ${j.seedUnit || "sq ft"} soil & seed` : needsSeed(j) ? "soil & seed" : "",
].filter(Boolean).join(" · ");

/** Every stump job with its stage worked out. */
function buildItems(allJobs, goneStumps, stumps, today) {
  const items = [];
  const seen = new Set();
  for (const j of allJobs) {
    if (!j.stumpVisit) continue;
    const base = j.ref.split("-")[0];
    const treeLeft = !j.stumpOnly || allJobs.some((o) => o.ref !== j.ref && o.ref.split("-")[0] === base && !o.stumpOnly && (o.treeHrs || 0) > 0);
    items.push({
      ref: j.ref, name: j.name, addr: j.addr, town: j.town, zip: j.zip, phone: j.phone || "", tags: j.tags || [],
      notes: j.note || j.notes || "", grindHrs: j.grindHrs || 0, grindUnits: j.grindUnits || 0,
      cleanup: j.cleanupQty || 0, cleanupHrs: j.cleanupHrs || 0, seed: j.seedQty || 0, seedUnit: j.seedUnit || "", seedHrs: j.seedHrs || 0,
      treeHrs: j.stumpOnly ? 0 : j.treeHrs, treeLeft, days: j.days, open: true,
    });
    seen.add(j.ref);
  }
  for (const [ref, g] of Object.entries(goneStumps || {})) {
    if (seen.has(ref)) continue;
    items.push({ ref, ...g, tags: g.tags || [], grindHrs: 0, treeHrs: 0, treeLeft: false, open: false });
    seen.add(ref);
  }
  // stored jobs SingleOps no longer lists and the upload didn't remember: use their snapshot
  for (const [ref, s] of Object.entries(stumps)) {
    if (seen.has(ref) || !s.snap || s.stage === "done") continue;
    items.push({ ref, ...s.snap, tags: s.snap.tags || [], treeLeft: false, open: false });
  }
  for (const it of items) {
    const s = stumps[it.ref] || {};
    let stage = s.stage || (it.open ? (it.treeLeft ? "waiting" : "stakeout") : afterGrind(it));
    let auto = "";
    if (!it.open && (stage === "waiting" || stage === "stakeout" || stage === "grind")) { stage = afterGrind(it); auto = "Closed in SingleOps (ground)"; }
    if (stage === "stakeout" && s.clearFrom && s.clearFrom <= today) { stage = "grind"; auto = "Cleared"; }
    it.st = s; it.stage = stage; it.auto = auto;
    it.hrs = it.grindHrs; it.treeHrsMap = it.grindHrs;
  }
  return items;
}

function snapOf(it) {
  const { ref, name, addr, town, zip, phone, tags, notes, grindUnits, cleanup, cleanupHrs, seed, seedUnit, seedHrs } = it;
  return { ref, name, addr, town, zip, phone, tags: (tags || []).slice(0, 20), notes: String(notes || "").slice(0, 1200), grindUnits, cleanup, cleanupHrs, seed, seedUnit, seedHrs };
}

/* ── week calendar of clearance windows ─────────────────────────────────── */
function ClearanceWeek({ items, today, onPick, selected }) {
  const [mon, setMon] = useState(() => mondayOf(today));
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));
  const rows = items.filter((it) => (it.st.clearFrom || it.st.called) && it.stage !== "done"
    && ((it.st.clearFrom || it.st.called) <= days[6]) && ((it.st.clearTo || it.st.clearFrom || it.st.called) >= days[0]))
    .sort((a, b) => (a.st.clearTo || "9").localeCompare(b.st.clearTo || "9"));
  return (
    <div className="card">
      <div className="card-h st" style={{ flexWrap: "wrap" }}>
        Clearance windows
        <button className="chip st" onClick={() => setMon(addDays(mon, -7))}>‹</button>
        <span style={{ fontSize: 12.5 }}>{nice(days[0])} – {nice(days[6])}</span>
        <button className="chip st" onClick={() => setMon(addDays(mon, 7))}>›</button>
        <button className="chip st" onClick={() => setMon(mondayOf(today))}>This week</button>
        <span className="spacer" />
        <span className="hint" style={{ padding: 0, fontSize: 11.5 }}>bar = clear to dig · 📞 = called</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px repeat(7, minmax(70px, 1fr))", minWidth: 680 }}>
          <div />
          {days.map((d) => (
            <div key={d} className="st" style={{ fontSize: 11, padding: "6px 4px", textAlign: "center", color: d === today ? C.ink : C.inkDim, background: d === today ? "#2a343b" : undefined, opacity: [5, 6].includes(days.indexOf(d)) ? 0.6 : 1 }}>
              {nice(d, true)}
            </div>
          ))}
          {!rows.length && <div className="hint" style={{ gridColumn: "1 / -1", padding: 12 }}>No clearance windows this week. Enter the date called and the clearance dates on a job under “Needs stake-out”.</div>}
          {rows.map((it) => {
            const from = it.st.clearFrom || "", to = it.st.clearTo || it.st.clearFrom || "";
            const ending = to && to >= today && to <= addDays(today, 2) && it.stage !== "done";
            return [
              <button key={it.ref + "n"} onClick={() => onPick(it.ref)} style={{ textAlign: "left", padding: "5px 8px", fontSize: 12.5, borderTop: `1px solid ${C.edgeSoft}`, background: selected === it.ref ? "#2a343b" : undefined, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: ST[it.stage].color, marginRight: 6 }} />{it.name}
              </button>,
              ...days.map((d) => {
                const inWin = from && d >= from && d <= to;
                return (
                  <div key={it.ref + d} style={{ borderTop: `1px solid ${C.edgeSoft}`, padding: "4px 0", position: "relative", minHeight: 26 }}>
                    {inWin && <div style={{ position: "absolute", inset: "6px 0", background: ending ? "#c0392b" : "#2e7d4f", borderTopLeftRadius: d === from ? 8 : 0, borderBottomLeftRadius: d === from ? 8 : 0, borderTopRightRadius: d === to ? 8 : 0, borderBottomRightRadius: d === to ? 8 : 0 }} title={`Clear to dig ${nice(from)} – ${nice(to)}`} />}
                    {it.st.called === d && <span style={{ position: "absolute", left: 4, top: 3, fontSize: 13 }} title={`Called ${nice(d)}`}>📞</span>}
                  </div>
                );
              }),
            ];
          })}
        </div>
      </div>
    </div>
  );
}

/* ── contractor report (cleanup + soil & seed) ──────────────────────────── */
const workFor = (it) => [
  needsCleanup(it) && it.stage !== "seed" ? `Stump cleanup${it.cleanup ? ` — ${it.cleanup} stump${it.cleanup === 1 ? "" : "s"}` : ""}` : "",
  needsSeed(it) ? `Soil & seed${it.seed ? ` — ${Math.round(it.seed)} ${it.seedUnit || "sq ft"}` : ""}` : "",
].filter(Boolean).join(" · ") + (it.stage === "seed" && needsCleanup(it) ? " (cleanup already done)" : "")
  || (it.stage === "cleanup" ? "Stump cleanup" : it.stage === "seed" ? "Soil & seed" : "");
function reportHtml(list, withPhone) {
  const when = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const rows = list.map((it, i) => `
    <section>
      <h2>${i + 1}. ${esc(it.name)} <small>#${esc(it.ref)}</small></h2>
      <p class="addr"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.addr || "")}">${esc(it.addr || "")}</a></p>
      ${withPhone && it.phone ? `<p>Phone: ${esc(it.phone)}</p>` : ""}
      <p class="work"><b>Work:</b> ${esc(workFor(it))}</p>
      ${it.notes ? `<p class="notes">${esc(it.notes).replace(/\n/g, "<br>")}</p>` : ""}
    </section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stump cleanup and soil &amp; seed — ${esc(when)}</title>
<style>body{font:15px/1.45 system-ui,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:16px;margin:0 0 4px}h2 small{color:#666;font-weight:400}
section{border-top:1px solid #ccc;padding:12px 0;break-inside:avoid}p{margin:3px 0}.addr a{color:#0645ad}
.notes{background:#f4f4f4;padding:6px 8px;border-radius:4px;font-size:13.5px}.hint{color:#666;font-size:13px}
.bar{margin:10px 0 16px}@media print{.bar{display:none}}</style></head><body>
<h1>Monster Tree Service of Rochester — stump cleanup and soil &amp; seed</h1>
<p class="hint">${esc(when)} · ${list.length} job${list.length === 1 ? "" : "s"}</p>
<div class="bar"><button onclick="print()">Print / save as PDF</button></div>
${rows}</body></html>`;
}
function reportText(list, withPhone) {
  return list.map((it, i) => [
    `${i + 1}. ${it.name} (#${it.ref})`,
    it.addr,
    withPhone && it.phone ? `Phone: ${it.phone}` : "",
    `Work: ${workFor(it)}`,
    it.notes ? `Notes: ${it.notes.replace(/\n/g, " ")}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}
function ReportSheet({ items, onClose }) {
  const pool = items.filter((it) => it.stage === "cleanup" || it.stage === "seed");
  const [pick, setPick] = useState(() => new Set(pool.map((it) => it.ref)));
  const [withPhone, setWithPhone] = useState(false);
  const [copied, setCopied] = useState(false);
  const list = pool.filter((it) => pick.has(it.ref));
  const open = () => {
    const w = window.open("", "_blank");
    if (!w) { alert("The pop-up was blocked — allow pop-ups for this site, or use Copy as text."); return; }
    w.document.open(); w.document.write(reportHtml(list, withPhone)); w.document.close();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 80, display: "grid", placeItems: "center", padding: 12 }} onClick={onClose}>
      <div className="card" style={{ width: "min(640px, 100%)", maxHeight: "90vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-h st">📄 Contractor report · cleanup + soil & seed<span className="spacer" /><button className="chip st" onClick={onClose}>✕</button></div>
        <div className="card-b" style={{ display: "grid", gap: 8 }}>
          {!pool.length && <div className="hint">No jobs are ready for cleanup or soil & seed.</div>}
          {pool.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <button className="chip st" onClick={() => setPick(new Set(pool.map((it) => it.ref)))}>All</button>
              <button className="chip st" onClick={() => setPick(new Set())}>None</button>
            </div>
          )}
          {pool.map((it) => (
            <label key={it.ref} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5 }}>
              <input type="checkbox" checked={pick.has(it.ref)} onChange={() => setPick((s) => { const n = new Set(s); n.has(it.ref) ? n.delete(it.ref) : n.add(it.ref); return n; })} />
              <span><b>{it.name}</b> · {it.addr}<br /><span style={{ color: ST[it.stage].color }}>{ST[it.stage].label}</span> · <span style={{ color: C.inkDim }}>{workText(it) || "—"}</span></span>
            </label>
          ))}
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={withPhone} onChange={(e) => setWithPhone(e.target.checked)} /> Include clients' phone numbers
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn st" data-primary="1" disabled={!list.length} onClick={open}>Open printable report ({list.length})</button>
            <button className="btn st" disabled={!list.length} onClick={async () => { try { await navigator.clipboard.writeText(reportText(list, withPhone)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} }}>{copied ? "Copied ✓" : "Copy as text (for email / text)"}</button>
          </div>
          <div className="hint" style={{ padding: 0 }}>The report opens in a new tab: print it or save it as a PDF and send it. Nothing is sent from here.</div>
        </div>
      </div>
    </div>
  );
}

/* ── one job ────────────────────────────────────────────────────────────── */
function StumpCard({ it, today, selected, onPick, save, busy }) {
  const s = it.st;
  const [called, setCalled] = useState(s.called || "");
  const [from, setFrom] = useState(s.clearFrom || "");
  const [to, setTo] = useState(s.clearTo || "");
  useEffect(() => { setCalled(s.called || ""); setFrom(s.clearFrom || ""); setTo(s.clearTo || ""); }, [s.called, s.clearFrom, s.clearTo]);
  const dirty = called !== (s.called || "") || from !== (s.clearFrom || "") || to !== (s.clearTo || "");
  const go = (stage, extra) => save(it, { stage, ...(extra || {}) });
  const windowEnds = s.clearTo && it.stage === "grind" ? s.clearTo : "";
  const late = windowEnds && windowEnds < today;
  return (
    <div className="card" style={{ borderLeft: `5px solid ${ST[it.stage].color}`, outline: selected ? `2px solid ${C.ink}` : undefined }} onClick={() => onPick(it.ref)}>
      <div className="card-b" style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>{it.name}</b>
          <a className="mono" href={singleOpsJobUrl(it.ref.split("-")[0])} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.inkDim }} onClick={(e) => e.stopPropagation()}>#{it.ref}</a>
          <span style={{ color: C.inkDim, fontSize: 13 }}>{it.town || it.addr}</span>
          <span className="spacer" style={{ flex: 1 }} />
          {it.grindHrs > 0 && <span className="mono" style={{ fontSize: 13 }}>{fmtH(it.grindHrs)} grind</span>}
        </div>
        <div style={{ fontSize: 13, color: C.inkDim }}>{it.addr}</div>
        {workText(it) && <div style={{ fontSize: 13 }}>{workText(it)}</div>}
        {it.stage === "waiting" && <div style={{ fontSize: 12.5, color: "#f0c050" }}>Tree work still in the backlog{it.treeHrs > 0 ? ` on this visit (${fmtH(it.treeHrs)})` : " on this job"}.</div>}
        {it.auto && <div style={{ fontSize: 12, color: C.inkDim }}>↳ {it.auto}</div>}
        {windowEnds && <div style={{ fontSize: 13, fontWeight: 600, color: late ? "#ff6b5e" : windowEnds <= addDays(today, 2) ? "#f0c050" : "#6fd39a" }}>{late ? `⚠ Clearance ran out ${nice(windowEnds, true)} — call again` : `Clear to dig until ${nice(windowEnds, true)}`}</div>}
        {it.tags.length > 0 && <TagRow tags={it.tags} />}
        {it.notes && <div style={{ fontSize: 12.5, color: C.inkDim, whiteSpace: "pre-wrap", maxHeight: 60, overflow: "hidden" }}>{it.notes}</div>}

        {(it.stage === "stakeout" || it.stage === "grind") && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }} onClick={(e) => e.stopPropagation()}>
            <label style={{ fontSize: 11.5, color: C.inkDim }}>Date called<input className="inp" type="date" value={called} onChange={(e) => setCalled(e.target.value)} style={{ width: 150, display: "block" }} /></label>
            <label style={{ fontSize: 11.5, color: C.inkDim }}>CLEARANCE from<input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150, display: "block" }} /></label>
            <label style={{ fontSize: 11.5, color: C.inkDim }}>CLEARANCE until<input className="inp" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={{ width: 150, display: "block" }} /></label>
            {dirty && <button className="btn st" data-primary="1" disabled={busy || (from && to && to < from)} onClick={() => save(it, { called, clearFrom: from, clearTo: to, ...(it.stage === "stakeout" && !s.stage ? { stage: "stakeout" } : {}) })}>Save dates</button>}
            {from && to && to < from && <span className="err">“Until” is before “from”.</span>}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
          {it.stage === "waiting" && <button className="btn st" disabled={busy} onClick={() => go("stakeout")}>Tree work done → Needs stake-out</button>}
          {it.stage === "stakeout" && <button className="btn st" disabled={busy} onClick={() => go("grind")}>Cleared → Ready to grind</button>}
          {it.stage === "grind" && <button className="btn st" data-primary="1" disabled={busy} onClick={() => go(afterGrind(it))}>Ground ✓ → {ST[afterGrind(it)].label}</button>}
          {it.stage === "cleanup" && <button className="btn st" data-primary="1" disabled={busy} onClick={() => go(afterCleanup(it))}>Cleaned up ✓ → {ST[afterCleanup(it)].label}</button>}
          {it.stage === "seed" && <button className="btn st" data-primary="1" disabled={busy} onClick={() => go("done", { doneOn: today })}>Soil & seed done ✓</button>}
          {it.stage === "grind" && afterGrind(it) === "done" && <span className="hint" style={{ padding: 0 }}>no cleanup / soil & seed sold</span>}
          <select className="inp" style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} value="" disabled={busy}
                  onChange={(e) => e.target.value && go(e.target.value, e.target.value === "done" ? { doneOn: today } : undefined)}>
            <option value="">Move to…</option>
            {STAGES.filter((x) => x.key !== it.stage).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

/* ── the tab ────────────────────────────────────────────────────────────── */
export default function Stumps() {
  useHoursUnit();
  const { data, allJobs, err: loadErr } = useBacklog();
  const [stumps, setStumps] = useState({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(() => { try { return localStorage.getItem("mts-stumps-stage") || "grind"; } catch { return "grind"; } });
  const [sel, setSel] = useState(null);
  const [report, setReport] = useState(false);
  const today = isoOf(new Date());

  const loadStumps = useCallback(async () => { try { setStumps((await api("stumps")).stumps || {}); } catch (e) { setErr(`Couldn't load the stump stages (${e.message}).`); } }, []);
  useEffect(() => { loadStumps(); const t = setInterval(() => { if (!document.hidden) loadStumps(); }, 30000); return () => clearInterval(t); }, [loadStumps]);
  const pickStage = (k) => { setStage(k); setSel(null); try { localStorage.setItem("mts-stumps-stage", k); } catch {} };

  const items = useMemo(() => buildItems(allJobs, data?.goneStumps, stumps, today), [allJobs, data, stumps, today]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map((s) => [s.key, items.filter((it) => it.stage === s.key && (s.key !== "done" || (it.st.at || 0) > Date.now() - 60 * 86400000)).length])), [items]);
  const shown = useMemo(() => items.filter((it) => it.stage === stage && (stage !== "done" || (it.st.at || 0) > Date.now() - 60 * 86400000))
    .sort((a, b) => stage === "grind" ? (a.st.clearTo || "9").localeCompare(b.st.clearTo || "9") || (b.days || 0) - (a.days || 0) : (b.days || 0) - (a.days || 0)), [items, stage]);
  const mapJobs = useMemo(() => shown.filter((it) => it.addr), [shown]);
  const { points, state: geoState } = useJobPoints(mapJobs);

  const save = async (it, set) => {
    setBusy(true); setErr("");
    try {
      const r = await api("stumps", { method: "POST", body: { ref: it.ref, set: { ...set, snap: snapOf(it) } } });
      setStumps(r.stumps || {});
    } catch (e) { setErr(`Couldn't save (${e.message}) — check your connection and try again.`); }
    setBusy(false);
  };

  if (loadErr) return <div className="wrap"><div className="err">{loadErr}</div></div>;
  if (data === undefined) return <div className="wrap hint">Loading…</div>;
  if (!data) return <div className="wrap hint">No backlog uploaded yet — upload the SingleOps exports on Schedule → Backlog.</div>;

  const stakeItems = items.filter((it) => it.stage === "stakeout" || it.stage === "grind");
  return (
    <div className="wrap" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {STAGES.map((s) => (
          <button key={s.key} className="chip st" data-on={stage === s.key ? 1 : 0} onClick={() => pickStage(s.key)}
                  style={{ padding: "8px 12px", fontSize: 12, borderBottom: `3px solid ${s.color}` }}>
            {s.label}<b>{counts[s.key]}</b>
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn st" onClick={() => setReport(true)}>📄 Cleanup + soil & seed report</button>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="hint" style={{ padding: 0 }}>
        {stage === "waiting" && "Stump visits whose tree work is still in the backlog. They move to Needs stake-out when the tree work is done (or tap the button)."}
        {stage === "stakeout" && "Call in the stake-out, then enter the date called and the CLEARANCE window. On the clear-from day the job moves to Ready to grind by itself."}
        {stage === "grind" && "Ready to grind — the ones whose clearance runs out first are at the top."}
        {stage === "cleanup" && "Ground, waiting for stump cleanup (outsourced). Use the report button to send the list to the contractor."}
        {stage === "seed" && "Waiting for soil & seed (outsourced). Use the report button to send the list to the contractor."}
        {stage === "done" && "Finished in the last 60 days."}
      </div>

      {(stage === "stakeout" || stage === "grind") && <ClearanceWeek items={stakeItems} today={today} onPick={setSel} selected={sel} />}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }} className="stumps-grid">
        <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
          {!shown.length && <div className="hint">Nothing here right now.</div>}
          {shown.map((it) => <StumpCard key={it.ref} it={it} today={today} selected={sel === it.ref} onPick={setSel} save={save} busy={busy} />)}
        </div>
        <div style={{ position: "sticky", top: 60, height: "calc(100vh - 140px)", minHeight: 320 }}>
          <BacklogMap jobs={mapJobs} points={points} selected={sel} onPick={setSel} colorBy={(j) => ST[j.stage]?.color || "#888"} />
          {geoState && <div className="hint" style={{ padding: "4px 0" }}>{geoState}</div>}
        </div>
      </div>
      <style>{`@media (max-width: 900px) { .stumps-grid { grid-template-columns: 1fr !important; } .stumps-grid > div:last-child { position: static !important; height: 320px !important; } }`}</style>
      {report && <ReportSheet items={items} onClose={() => setReport(false)} />}
    </div>
  );
}
