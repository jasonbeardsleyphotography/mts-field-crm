import { useState, useMemo, useEffect } from "react";
import SoilMap from "./SoilMap.jsx";
import { soilApi, pdfUrl } from "./api";
import { METRICS, legendCss, RATING, fmtVal, fmtDate, testDate, whyFor, fieldsFor, rate, metricsFor } from "./soilData";

/* ═══════════════════════════════════════════════════════════════════════════
   One property: map + soil layers, samples, findings, history.
   mode "client": read-only, reached by a private link; the server has already
   removed every staff-only field before this page receives the data.
   ═══════════════════════════════════════════════════════════════════════════ */

const money = (n) => `$${Math.round(n).toLocaleString()}`;

function Legend({ metric }) {
  const st = METRICS[metric].stops, lo = st[0][0], hi = st[st.length - 1][0];
  const ticks = st.filter((x, i) => i === 0 || i === st.length - 1 || (x[0] - st[i - 1][0]) / (hi - lo) > 0.08);
  return (
    <div>
      <div style={{ height: 14, borderRadius: 3, background: legendCss(metric) }} />
      <div style={{ position: "relative", height: 16, fontSize: 11, color: "#4a5a50" }}>
        {ticks.map((x) => (
          <span key={x[0]} className="mono" style={{ position: "absolute", left: `${Math.min(96, Math.max(4, (x[0] - lo) / (hi - lo) * 100))}%`, transform: "translateX(-50%)" }}>{x[0]}</span>
        ))}
      </div>
    </div>
  );
}

/** Where a value sits: low · in range · high. */
function RangeBar({ k, v, range, phTarget }) {
  if (v == null) return null;
  let pos, band = [33.3, 66.6];
  if (k === "ph") {
    const lo = 5.5, hi = 8.0, t = phTarget || [6.0, 6.8];
    pos = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * 100;
    band = [(t[0] - lo) / (hi - lo) * 100, (t[1] - lo) / (hi - lo) * 100];
  } else if (range) {
    const [a, b] = range;
    if (a != null && b != null) pos = v < a ? (v / a) * 33.3 : v <= b ? 33.3 + ((v - a) / (b - a)) * 33.3 : 66.6 + Math.min(1, (v - b) / (b * 2)) * 33.3;
    else if (a != null) { band = [33.3, 100]; pos = v < a ? (v / a) * 33.3 : 33.3 + Math.min(1, (v - a) / (a * 4)) * 66.6; }
    else { band = [0, 66.6]; pos = v <= b ? (v / b) * 66.6 : 66.6 + Math.min(1, (v - b) / b) * 33.3; }
  } else return null;
  return (
    <div className="rb" aria-hidden="true">
      <div className="rb-band" style={{ left: `${band[0]}%`, width: `${band[1] - band[0]}%` }} />
      <div className="rb-dot" style={{ left: `${Math.max(1, Math.min(99, pos))}%` }} />
    </div>
  );
}

function Recs({ recs }) {
  if (!recs?.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="lbl">Lab's recommendations</div>
      {recs.map((r, i) => (
        <div key={i} className="why" style={{ marginBottom: 6 }}>
          <b>{r.for}</b>{r.targetPh ? ` · target pH ${r.targetPh}` : ""}{r.per ? ` · ${r.per}` : ""}
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 4, marginTop: 6, fontSize: 13 }}>
            <span>Lime<br /><b>{r.lime}</b></span><span>N<br /><b>{r.N}</b></span><span>P₂O₅<br /><b>{r.P2O5}</b></span><span>K₂O<br /><b>{r.K2O}</b></span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SampleDetail({ s, test, siteId, token, onClose, included, onToggle }) {
  const vals = fieldsFor(test).filter((f) => s.values?.[f.k] != null);
  const [why, setWhy] = useState(null);
  return (
    <div className="sheet" role="dialog" aria-label={`Sample ${s.id}`}>
      <div className="sheet-h">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-h">{test?.type === "F" ? "Leaf test" : `Sample ${s.id}`}</div>
          <div className="t-sub">{s.location || s.label}{testDate(test) ? ` · ${fmtDate(testDate(test))}` : ""}</div>
        </div>
        <button className="b-icon" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="sheet-b">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {s.pdf && <a className="b-main" href={pdfUrl(siteId, s.pdf, token)} target="_blank" rel="noopener noreferrer">Open lab report (PDF)</a>}
          {onToggle && s.lat != null && test?.type !== "F" && (
            <button className="b-sec" onClick={onToggle}>{included ? "Leave out of map colours" : "Include in map colours"}</button>
          )}
        </div>
        <div className="t-sub" style={{ marginBottom: 8 }}>
          {test?.lab}{s.labNumber ? ` · lab number ${s.labNumber}` : ""}{s.label && s.label !== s.labNumber ? ` · labelled “${s.label}”` : ""}
        </div>
        {test?.transcribed && <div className="why" style={{ marginBottom: 8 }}>These values were typed in from the lab report. The PDF above is the original.</div>}
        {test?.type === "F" && <div className="why" style={{ marginBottom: 8 }}>{test.note}</div>}
        {vals.map((f) => {
          const v = s.values[f.k];
          const r = rate(test, s, f.k);
          const rg = test?.ranges?.[f.k];
          const w = whyFor(f.k, test);
          const labWord = s.ratings?.[f.k];
          return (
            <div key={f.k} className="vrow">
              <button className="vrow-h" onClick={() => setWhy(why === f.k ? null : f.k)} aria-expanded={why === f.k} disabled={!w && !rg}>
                <span className="vrow-l">{f.label}</span>
                <span className="mono vrow-v">{s.valueNotes?.[f.k] || fmtVal(v)}<small>{f.unit ? ` ${f.unit}` : ""}</small></span>
                {r && <span className="chipr" style={{ color: RATING[r].color, borderColor: RATING[r].color }}>{labWord || RATING[r].label}</span>}
              </button>
              {!test?.fields && <RangeBar k={f.k} v={v} range={rg} phTarget={test?.phTarget} />}
              {test?.fields && rg && <RangeBar k={f.k === "ph" ? "x" : f.k} v={v} range={rg} />}
              {why === f.k && (
                <div className="why">
                  {w}
                  {rg && <div className="t-sub" style={{ marginTop: 4 }}>{test?.type === "F" ? "Normal range" : "Lab range"}: {rg[0] ?? "—"} to {rg[1] ?? "—"}{f.unit ? ` ${f.unit}` : ""}</div>}
                  {f.k === "ph" && test?.type !== "F" && <div className="t-sub" style={{ marginTop: 4 }}>Most trees do best at pH 6.0–6.5; lawns and flowers around 6.5.</div>}
                </div>
              )}
            </div>
          );
        })}
        <div className="t-sub" style={{ marginTop: 10 }}>Tap any line for what it means.</div>
        <Recs recs={s.recs} />
        {s.recText && <div className="why" style={{ marginTop: 8 }}>{s.recText}</div>}
        {s.comment && (<><div className="lbl" style={{ marginTop: 12 }}>Lab's comments</div><div className="why">{s.comment}</div></>)}
      </div>
    </div>
  );
}

/** Plain-English headline findings across the samples of one test. */
function findings(samples, test) {
  const out = [];
  const n = samples.length; if (!n) return out;
  const of = (c) => (n === 1 ? (c ? "This sample" : "") : `${c} of ${n} samples`);
  if (test?.type !== "F") {
    const hiPh = samples.filter((s) => s.values?.ph > 7.0).length;
    if (hiPh) out.push({ tone: "bad", text: `${of(hiPh)} ${n === 1 ? "is" : "are"} above pH 7.0 (alkaline). At that pH trees struggle to take up iron and manganese, which shows as yellowing leaves.` });
    const lowPh = samples.filter((s) => s.values?.ph != null && s.values.ph < 5.5).length;
    if (lowPh) out.push({ tone: "bad", text: `${of(lowPh)} ${n === 1 ? "is" : "are"} below pH 5.5 (strongly acidic) — lime would help.` });
    const okPh = samples.filter((s) => s.values?.ph != null && s.values.ph >= 5.5 && s.values.ph <= 6.8).length;
    if (okPh) out.push({ tone: "good", text: `${of(okPh)} ${n === 1 ? "is" : "are"} at pH ${n === 1 ? samples[0].values.ph : "6.8 or below"} — in or near the 6.0–6.5 target for trees.` });
  }
  fieldsFor(test).forEach((f) => {
    if (f.k === "ph" || /_bs$|cec|exacid|density|bph/.test(f.k)) return;
    const lo = samples.filter((s) => rate(test, s, f.k) === "low").length;
    const hi = samples.filter((s) => rate(test, s, f.k) === "high").length;
    const name = f.label.toLowerCase();
    if (lo) out.push({ tone: "warn", text: `${of(lo)} ${n === 1 ? "is" : "are"} low in ${name}.` });
    if (hi && ["Ca", "Mg", "P", "K", "Mn", "B", "N", "salts"].includes(f.k)) out.push({ tone: "info", text: `${of(hi)} ${n === 1 ? "is" : "are"} high in ${name}.` });
  });
  const om = samples.map((s) => s.values?.om).filter((v) => v != null);
  if (om.length > 1) out.push({ tone: "info", text: `Organic matter ranges from ${Math.min(...om)}% to ${Math.max(...om)}% (average ${(om.reduce((a, b) => a + b, 0) / om.length).toFixed(1)}%).` });
  else if (om.length === 1) out.push({ tone: "info", text: `Organic matter is ${om[0]}%.` });
  samples.forEach((s) => { if (s.comment) out.push({ tone: "info", text: `Lab's comment: ${s.comment}` }); });
  return out;
}

export default function SitePage({ site: initial, mode = "staff", canEdit = false, token, onBack }) {
  const [site, setSite] = useState(initial);
  useEffect(() => setSite(initial), [initial]);
  const tests = site.tests || [];
  const [testId, setTestId] = useState(() => (tests.find((t) => t.samples?.some((s) => s.lat != null)) || tests[0])?.id);
  const test = tests.find((t) => t.id === testId) || tests[0];
  const [metricPick, setMetric] = useState("ph");
  const [fade, setFade] = useState(true);
  const [opacity, setOpacity] = useState(0.6);
  const [excluded, setExcluded] = useState(() => new Set());
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("layers");
  const [parcelStatus, setParcelStatus] = useState("");
  const [drawMode, setDrawMode] = useState(null);
  const [draft, setDraft] = useState([]);
  const [lineWidth, setLineWidth] = useState(5);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [newLink, setNewLink] = useState("");

  const samples = useMemo(() => (test?.samples || []).map((s) => ({ ...s, key: `${test.id}/${s.id}`, included: !excluded.has(`${test.id}/${s.id}`) })), [test, excluded]);
  const metrics = useMemo(() => metricsFor(test, samples), [test, samples]);
  const metric = metrics.includes(metricPick) ? metricPick : metrics[0] || null;
  const [placing, setPlacing] = useState(null);       // sample key being placed on the map
  const sel = samples.find((s) => s.key === selected);
  const toggle = (key) => setExcluded((ex) => { const n = new Set(ex); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const placedCount = samples.filter((s) => s.lat != null).length;
  const facts = useMemo(() => findings(samples, test), [samples, test]);

  const saveShapes = async (shapes) => {
    setBusy("Saving…"); setErr("");
    try { const r = await soilApi("shapes", { method: "PUT", body: { id: site.id, shapes } }); setSite((s) => ({ ...s, shapes: r.shapes })); }
    catch (e) { setErr(`Couldn't save (${e.message}).`); }
    setBusy("");
  };
  const finishDraw = () => {
    const need = drawMode === "line" ? 2 : 3;
    if (draft.length < need) { setErr(`Add at least ${need} points first.`); return; }
    const def = { boundary: "Property boundary", area: (site.shapes || []).some((s) => s.type === "area") ? "Barn" : "House", line: "Driveway" }[drawMode];
    const name = window.prompt("Name this shape", def) || def;
    const sh = { type: drawMode, name, coords: draft.slice(), ...(drawMode === "line" ? { width: +lineWidth || 5 } : {}) };
    setDrawMode(null); setDraft([]); setErr("");
    saveShapes([...(site.shapes || []), sh]);
  };
  const placeAt = async (p) => {
    const key = placing; if (!key) return;
    setSite((st) => ({ ...st, tests: st.tests.map((t) => ({ ...t, samples: t.samples.map((x) => (`${t.id}/${x.id}` === key ? { ...x, lat: p[0], lng: p[1] } : x)) })) }));
    const next = samples.find((x) => x.key !== key && x.lat == null);
    setPlacing(next ? next.key : null);
    if (!next) setDrawMode(null);
    try { await soilApi("samples", { method: "PUT", body: { id: site.id, positions: { [key]: p } } }); }
    catch (e) { setErr(`Couldn't save that pin (${e.message}).`); }
  };
  const loadShapesFile = async (file) => {
    try {
      const j = JSON.parse(await file.text());
      if (!Array.isArray(j.shapes)) throw new Error();
      await saveShapes(j.shapes);
    } catch { setErr("That file isn't a saved shapes file (BH-cutouts.json)."); }
  };
  const makeLink = async () => {
    setErr("");
    try {
      const r = await soilApi("link", { method: "POST", body: { site: site.id } });
      setNewLink(r.url);
      setSite((s) => ({ ...s, links: [...(s.links || []), { token: r.token, createdAt: Date.now() }] }));
    } catch (e) { setErr(`Couldn't make a link (${e.message}).`); }
  };
  const revoke = async (t) => {
    if (!window.confirm("Turn this link off? Anyone using it will lose access.")) return;
    try { const r = await soilApi(`link?site=${encodeURIComponent(site.id)}&token=${t}`, { method: "DELETE" }); setSite((s) => ({ ...s, links: r.links })); }
    catch (e) { setErr(`Couldn't turn it off (${e.message}).`); }
  };

  const TABS = [["layers", "Map"], ["samples", "Samples"], ["findings", "Findings"], ...(site.history ? [["history", "History"]] : []), ...(canEdit && mode === "staff" ? [["admin", "Admin"]] : [])];

  return (
    <div className="sp">
      <header className="sp-hd">
        {onBack && <button className="b-icon" onClick={onBack} aria-label="All properties">‹</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-h">{site.name}{site.client && site.client !== site.name ? <span className="t-sub"> · {site.client}</span> : null}</div>
          <div className="t-sub">{site.address}{test ? ` · ${test.samples?.length || 0} sample${test.samples?.length === 1 ? "" : "s"} · ${fmtDate(testDate(test))}` : ""}</div>
        </div>
        {mode === "client" && <div className="brand-mini">Monster Tree Service<br />of Rochester</div>}
      </header>

      <div className="sp-body">
        <div className="sp-map">
          <SoilMap samples={samples} metric={metric} fade={fade} opacity={opacity} shapes={site.shapes || []}
                   draft={draft} drawMode={drawMode} center={site.center}
                   onMapClick={(p) => (drawMode === "place" ? placeAt(p) : setDraft((d) => [...d, p]))}
                   selected={selected} onSelect={(k) => { setSelected(k); }} onParcelStatus={setParcelStatus} />
          {placedCount === 0 && !placing && test?.type !== "F" && <div className="sp-banner" style={{ top: "auto", bottom: 90, right: 80 }}>
            These samples haven't been placed on the map yet{canEdit && mode === "staff" ? " — use “Place samples” on the Map tab." : "."}</div>}
          {test?.type === "F" && <div className="sp-banner" style={{ top: "auto", bottom: 90, right: 80 }}>This is a leaf test, so it has no map colours. See Samples and Findings.</div>}
        </div>

        <aside className="sp-side">
          <nav className="sp-tabs" role="tablist">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
          </nav>

          {drawMode === "place" && (
            <div className="drawbar">
              <div>Tap the map where <b>{samples.find((x) => x.key === placing)?.location || "this sample"}</b> was taken.</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <select className="inp" style={{ flex: "1 1 160px", width: "auto" }} value={placing || ""} onChange={(e) => setPlacing(e.target.value)}>
                  {samples.map((x) => <option key={x.key} value={x.key}>{x.id} · {x.location || x.label}{x.lat != null ? " (placed)" : ""}</option>)}
                </select>
                <button className="b-sec" onClick={() => { setDrawMode(null); setPlacing(null); }}>Done</button>
              </div>
            </div>
          )}
          {drawMode && drawMode !== "place" && (
            <div className="drawbar">
              <div>{{ boundary: "Tap around the property edge, then Finish.", area: "Tap around the building, then Finish.", line: "Tap along the middle of the driveway, then Finish." }[drawMode]} ({draft.length} points)</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button className="b-main" onClick={finishDraw}>Finish</button>
                <button className="b-sec" onClick={() => setDraft((d) => d.slice(0, -1))}>Undo point</button>
                <button className="b-sec" onClick={() => { setDrawMode(null); setDraft([]); }}>Cancel</button>
              </div>
            </div>
          )}
          {err && <div className="err">{err}</div>}

          {tab === "layers" && (
            <div className="pad">
              {tests.length > 1 && (
                <label className="fld">Test
                  <select value={test?.id} onChange={(e) => { setTestId(e.target.value); setSelected(null); }}>
                    {tests.map((t) => <option key={t.id} value={t.id}>{fmtDate(testDate(t))} · {t.type === "F" ? "Leaf test" : "Soil test"} · {t.lab}</option>)}
                  </select>
                </label>
              )}
              {canEdit && mode === "staff" && test?.type !== "F" && (
                <button className="b-sec" style={{ width: "100%", marginBottom: 12 }} onClick={() => { setDrawMode("place"); setPlacing((samples.find((x) => x.lat == null) || samples[0])?.key); }}>
                  📍 Place samples on the map{placedCount < samples.length ? ` (${samples.length - placedCount} not placed)` : ""}
                </button>
              )}
              {metric ? (<>
              <div className="lbl">Colour the map by</div>
              <div className="seg">
                {metrics.map((m) => (
                  <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)}>{METRICS[m].label}</button>
                ))}
              </div>
              <Legend metric={metric} />
              <div className="t-sub">{METRICS[metric].label}{METRICS[metric].unit ? `, ${METRICS[metric].unit}` : ""} · {METRICS[metric].note}</div>
              {test?.method !== "Modified Morgan" && <div className="t-sub">This lab uses a different test method, so only pH{metrics.includes("om") ? " and organic matter" : ""} can be coloured on the map.</div>}
              {placedCount < 3 && <div className="t-sub" style={{ marginTop: 4 }}>Map colours need at least 3 placed samples to be meaningful.</div>}
              </>) : <div className="t-sub">{test?.type === "F" ? "Leaf tests don't colour the map." : "Nothing to colour on the map for this test."}</div>}
              {metric && <>
              <label className="fld-row">Opacity
                <input type="range" min="0.2" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(+e.target.value)} style={{ flex: 1 }} />
              </label>
              <label className="fld-row"><input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} /> Fade areas far from any sample</label>
              <div className="t-sub">Colours between sample points are estimates (inverse distance weighting). Far from a sample they're guesses, which is why they fade.</div>
              </>}
              {parcelStatus && !(site.shapes || []).some((s) => s.type === "boundary") && <div className="t-sub" style={{ marginTop: 6 }}>{parcelStatus}</div>}
              <div className="lbl" style={{ marginTop: 14 }}>Samples used for the colours</div>
              {samples.map((s) => (
                <label key={s.key} className="srow">
                  <input type="checkbox" checked={s.included} onChange={() => toggle(s.key)} />
                  <button className="srow-n" onClick={(e) => { e.preventDefault(); setSelected(s.key); }}>{s.id} · {s.location || s.label}</button>
                  <span className="mono srow-v">{metric ? fmtVal(s.values?.[metric]) : ""}</span>
                </label>
              ))}
              {test?.note && <div className="t-sub" style={{ marginTop: 8 }}>{test.note}</div>}
            </div>
          )}

          {tab === "samples" && (
            <div className="pad">
              {tests.length > 1 && (
                <label className="fld">Test
                  <select value={test?.id} onChange={(e) => { setTestId(e.target.value); setSelected(null); }}>
                    {tests.map((t) => <option key={t.id} value={t.id}>{fmtDate(testDate(t))} · {t.type === "F" ? "Leaf test" : "Soil test"} · {t.lab}</option>)}
                  </select>
                </label>
              )}
              <div className="t-sub" style={{ marginBottom: 8 }}>{test?.lab}{test?.reported ? ` · reported ${fmtDate(test.reported)}` : ""}. Tap a sample for every value and its lab report.</div>
              {samples.map((s) => (
                <button key={s.key} className="scard" onClick={() => setSelected(s.key)}>
                  <div className="scard-t"><b>{s.id}</b> {s.location || s.label}</div>
                  <div className="scard-v mono">
                    {fieldsFor(test).filter((f) => s.values?.[f.k] != null).slice(0, 6).map((f) => {
                      const r = rate(test, s, f.k);
                      return <span key={f.k} style={{ color: r ? RATING[r].color : undefined }}>{METRICS[f.k]?.short || f.k} {s.valueNotes?.[f.k] || fmtVal(s.values[f.k])}</span>;
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}

          {tab === "findings" && (
            <div className="pad">
              {tests.length > 1 && <div className="t-sub" style={{ marginBottom: 8 }}>Showing: {test?.type === "F" ? "leaf test" : "soil test"} of {fmtDate(testDate(test))}. Switch tests on the Samples tab.</div>}
              {site.internal?.dataNotes && mode === "staff" && <div className="staff" style={{ display: "block", marginBottom: 10 }}>Staff only — data notes: {site.internal.dataNotes}</div>}
              <div className="lbl">What the {test?.type === "F" ? "leaf test shows" : "soil tests show"}</div>
              {facts.map((f, i) => <div key={i} className={`fact ${f.tone}`}>{f.text}</div>)}
              <div className="t-sub" style={{ marginTop: 10 }}>
                Each sample is compared with the lab's own ranges ({test?.lab || "lab"}{test?.method ? `, ${test.method}` : ""}). Tap a sample for its full results and what each value means.
                {test?.transcribed ? " These values were typed in from the lab report." : ""}
              </div>
            </div>
          )}

          {tab === "history" && site.history && (
            <div className="pad">
              <div className="lbl">Work on this property</div>
              <ol className="tl">
                {[...(site.history.events || [])].reverse().map((e, i) => (
                  <li key={i}>
                    <div className="tl-d mono">{fmtDate(e.date)}</div>
                    <div><b>{e.type}</b> — {e.summary}
                      {e.internal && mode === "staff" && (
                        <div className="staff">Staff only: {[e.internal.amount_usd != null && money(e.internal.amount_usd), e.internal.hours != null && `${e.internal.hours} h`].filter(Boolean).join(" · ")}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {site.history.open_items?.length > 0 && (
                <><div className="lbl" style={{ marginTop: 12 }}>Coming up</div>
                  <ul className="ul">{site.history.open_items.map((x, i) => <li key={i}>{x}</li>)}</ul></>
              )}
              {site.history.counts && Object.keys(site.history.counts).length > 0 && (
                <><div className="lbl" style={{ marginTop: 12 }}>Tree counts</div>
                  <ul className="ul">{Object.entries(site.history.counts).map(([k, v]) => <li key={k}>{k.replace(/_/g, " ")}: {String(v)}</li>)}</ul></>
              )}
            </div>
          )}

          {tab === "admin" && (
            <div className="pad">
              <div className="lbl">Client link</div>
              <div className="t-sub">A private, read-only page for this property only. It doesn't show dollar amounts, hours or anything else in the app. Turn a link off any time.</div>
              <button className="b-main" style={{ marginTop: 8 }} onClick={makeLink}>Make a client link</button>
              {newLink && (
                <div style={{ marginTop: 8 }}>
                  <input className="inp mono" readOnly value={newLink} onFocus={(e) => e.target.select()} />
                  <button className="b-sec" style={{ marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(newLink)}>Copy link</button>
                </div>
              )}
              {(site.links || []).length > 0 && (
                <ul className="ul" style={{ marginTop: 8 }}>
                  {site.links.map((l) => (
                    <li key={l.token} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="mono" style={{ flex: 1, opacity: l.revoked ? 0.5 : 1 }}>…{l.token.slice(-6)} · {new Date(l.createdAt).toLocaleDateString()}{l.revoked ? " · off" : ""}</span>
                      {!l.revoked && <button className="b-sec" onClick={() => revoke(l.token)}>Turn off</button>}
                    </li>
                  ))}
                </ul>
              )}

              <div className="lbl" style={{ marginTop: 16 }}>Boundary &amp; cut-outs</div>
              <div className="t-sub">Trace the property edge, and the house, barn and driveway to leave them out of the colours.</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                <button className="b-sec" onClick={() => { setDrawMode("boundary"); setDraft([]); setTab("layers"); }}>Draw boundary</button>
                <button className="b-sec" onClick={() => { setDrawMode("area"); setDraft([]); setTab("layers"); }}>Draw house / barn</button>
                <button className="b-sec" onClick={() => { setDrawMode("line"); setDraft([]); setTab("layers"); }}>Draw driveway</button>
                <label className="fld-row" style={{ margin: 0 }}>width <input type="number" min="1" max="30" value={lineWidth} onChange={(e) => setLineWidth(e.target.value)} style={{ width: 54 }} /> m</label>
              </div>
              {(site.shapes || []).map((s, i) => (
                <div key={i} className="srow">
                  <span style={{ minWidth: 70 }}>{s.type === "boundary" ? "Boundary" : s.type === "line" ? `Line ${s.width} m` : "Area"}</span>
                  <b style={{ flex: 1 }}>{s.name}</b>
                  <button className="b-sec" onClick={() => saveShapes(site.shapes.filter((_, j) => j !== i))}>Delete</button>
                </div>
              ))}
              <label className="b-sec" style={{ display: "inline-block", marginTop: 8 }}>
                Load cut-outs file (BH-cutouts.json)
                <input type="file" accept=".json,.geojson" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadShapesFile(f); }} />
              </label>
              {busy && <div className="t-sub">{busy}</div>}
            </div>
          )}
        </aside>
      </div>

      {sel && (
        <SampleDetail s={sel} test={test} siteId={site.id} token={token} onClose={() => setSelected(null)}
                      included={sel.included} onToggle={() => toggle(sel.key)} />
      )}
    </div>
  );
}
