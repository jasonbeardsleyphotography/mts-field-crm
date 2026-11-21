import { useState } from "react";
import { soilApi } from "./api";
import { NUTRIENTS, fmtDate } from "./soilData";

/* ═══════════════════════════════════════════════════════════════════════════
   Add a soil (or leaf) test to a property from its lab PDF(s).
   1. Each PDF goes to /api/soil-extract, where AI reads the values.
   2. Everything it read is shown in an editable table — check and correct it.
   3. Only then is it saved: the PDFs, and the test on the property.
   Nothing is saved until "Save test". The test is marked as read by AI.
   ═══════════════════════════════════════════════════════════════════════════ */

const EXTRA = { N: "Nitrogen", Na: "Sodium", no3: "Nitrate-N", salts: "Soluble salts", bph: "Buffer pH", h_bs: "Hydrogen saturation" };
const LABEL = { ...Object.fromEntries(NUTRIENTS.map((n) => [n.k, n.label])), ...EXTRA };
const ORDER = ["ph", "bph", "om", "N", "P", "K", "Ca", "Mg", "S", "B", "Mn", "Zn", "Cu", "Fe", "Al", "Pb", "Na", "no3", "salts", "cec", "exacid", "ca_bs", "mg_bs", "k_bs", "h_bs"];
const DEFAULT_UNIT = Object.fromEntries(NUTRIENTS.map((n) => [n.k, n.unit]));
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16);
const safeKey = (name) => name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 110) || "report.pdf";

async function extract(file, onStep) {
  const r = await fetch("/api/soil-extract", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/pdf" }, body: file });
  if (!r.ok || !r.body) { let m = `error ${r.status}`; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", out = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.step) onStep(m.step);
      if (m.error) throw new Error(m.error);
      if (m.result) out = m.result;
    }
  }
  if (!out) throw new Error("The AI didn't answer. Check your connection and try again.");
  return out;
}

/** One AI result + its PDF → a test in the app's format. */
function toTest(res, pdfKey, n) {
  const type = res.type === "F" ? "F" : "S";
  const isMorgan = type === "S" && /modified morgan/i.test(res.method || "") && /umass|massachusetts/i.test(res.lab || "");
  const samples = (res.samples || []).map((s, i) => ({
    id: String(i + 1).padStart(3, "0"),
    label: s.label || `Sample ${i + 1}`, labNumber: s.labNumber || "", location: s.location || s.label || "",
    values: Object.fromEntries(Object.entries(s.values || {}).filter(([, v]) => typeof v === "number" && isFinite(v))),
    ratings: s.ratings || undefined, valueNotes: s.valueNotes || undefined,
    recText: s.recommendations || undefined, comment: s.comment || undefined,
    pdf: pdfKey, _units: s.units || {}, _ranges: s.ranges || {},
  }));
  const keys = ORDER.filter((k) => samples.some((s) => s.values[k] != null));
  const ranges = {};
  samples.forEach((s) => Object.entries(s._ranges).forEach(([k, r]) => { if (Array.isArray(r) && !ranges[k]) ranges[k] = r; }));
  const date = res.sampled || res.received || res.reported || null;
  return {
    id: `${date || "test"}-${slug(res.lab) || "lab"}-${n}`,
    type, date, received: res.received || null, reported: res.reported || null,
    lab: res.lab || "", order: res.order || "", method: isMorgan ? "Modified Morgan" : (res.method || (type === "F" ? "Leaf tissue analysis" : "")),
    transcribed: "ai", ranges, ...(type === "S" ? { phTarget: [6.0, 6.8] } : {}),
    ...(isMorgan ? {} : { fields: keys.map((k) => ({ k, label: LABEL[k] || k, unit: samples.find((s) => s._units[k])?._units[k] || DEFAULT_UNIT[k] || "" })) }),
    note: type === "F" ? "Leaf (tissue) test. It measures what is inside the leaves, so it is read differently from a soil test." : "",
    samples,
  };
}

export default function AddTest({ site, onClose, onSaved }) {
  const [files, setFiles] = useState([]);          // [{ file, key, state, step, error }]
  const [tests, setTests] = useState([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const read = async (list) => {
    setErr(""); setTests([]);
    const fs = [...list].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf").map((f) => ({ file: f, key: safeKey(f.name), state: "waiting", step: "" }));
    if (!fs.length) { setErr("Choose one or more PDF lab reports."); return; }
    setFiles(fs);
    const out = [];
    for (let i = 0; i < fs.length; i++) {
      const upd = (patch) => setFiles((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      upd({ state: "reading" });
      try {
        const res = await extract(fs[i].file, (step) => upd({ step }));
        out.push(toTest(res, fs[i].key, i + 1));
        upd({ state: "done", step: `${res.samples.length} sample${res.samples.length === 1 ? "" : "s"} found` });
      } catch (e) { upd({ state: "error", step: e.message }); }
    }
    // Reports from the same lab and date become one test with all their samples.
    const merged = [];
    out.forEach((t) => {
      const same = merged.find((m) => m.type === t.type && m.lab === t.lab && m.date === t.date && !!m.fields === !!t.fields);
      if (!same) { merged.push(t); return; }
      t.samples.forEach((s) => same.samples.push({ ...s, id: String(same.samples.length + 1).padStart(3, "0") }));
      if (same.fields) same.fields = [...same.fields, ...t.fields.filter((f) => !same.fields.some((g) => g.k === f.k))];
      same.ranges = { ...t.ranges, ...same.ranges };
    });
    setTests(merged);
  };

  const setTest = (ti, patch) => setTests((cur) => cur.map((t, i) => (i === ti ? { ...t, ...patch } : t)));
  const setSample = (ti, si, patch) => setTests((cur) => cur.map((t, i) => (i !== ti ? t : { ...t, samples: t.samples.map((s, j) => (j === si ? { ...s, ...patch } : s)) })));
  const setValue = (ti, si, k, raw) => setTests((cur) => cur.map((t, i) => (i !== ti ? t : {
    ...t, samples: t.samples.map((s, j) => {
      if (j !== si) return s;
      const values = { ...s.values };
      if (raw === "" || raw == null) delete values[k]; else { const n = parseFloat(raw); if (isFinite(n)) values[k] = n; }
      return { ...s, values };
    }),
  })));

  const save = async () => {
    setErr("");
    try {
      const used = new Set(tests.flatMap((t) => t.samples.map((s) => s.pdf)));
      let i = 0;
      for (const f of files.filter((x) => used.has(x.key))) {
        setBusy(`Saving lab reports… ${++i}`);
        await soilApi(`pdf?site=${encodeURIComponent(site.id)}&key=${encodeURIComponent(f.key)}`, { method: "PUT", raw: await f.file.arrayBuffer() });
      }
      setBusy("Saving the test…");
      const clean = tests.map((t) => ({ ...t, samples: t.samples.map(({ _units, _ranges, ...s }) => s) }));
      const ids = new Set((site.tests || []).map((t) => t.id));
      clean.forEach((t) => { while (ids.has(t.id)) t.id += "x"; ids.add(t.id); });
      const next = { ...site, tests: [...(site.tests || []), ...clean] };
      delete next.links;
      await soilApi("site", { method: "PUT", body: { site: next } });
      const fresh = await soilApi(`site?id=${encodeURIComponent(site.id)}`);
      setBusy("");
      onSaved(fresh.site, clean[0]?.id);
    } catch (e) { setBusy(""); setErr(`Couldn't save (${e.message}). Nothing was lost — try Save again.`); }
  };

  const keysOf = (t) => (t.fields ? t.fields.map((f) => f.k) : ORDER.filter((k) => t.samples.some((s) => s.values[k] != null)));

  return (
    <div className="sheet" role="dialog" aria-label="Add a soil test" style={{ maxHeight: "92dvh" }}>
      <div className="sheet-h">
        <div style={{ flex: 1 }}>
          <div className="t-h">Add a soil test</div>
          <div className="t-sub">{site.name} · upload the lab report PDF(s). AI reads the values; you check them before anything is saved.</div>
        </div>
        <button className="b-icon" onClick={onClose} aria-label="Close" disabled={!!busy}>✕</button>
      </div>
      <div className="sheet-b">
        <label className="b-main" style={{ display: "inline-flex" }}>
          Choose PDF report(s)
          <input type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { const l = [...(e.target.files || [])]; e.target.value = ""; if (l.length) read(l); }} />
        </label>
        <div className="t-sub" style={{ marginTop: 6 }}>The reports go to Google's Gemini AI to be read (the same AI the field app uses).</div>
        {files.map((f, i) => (
          <div key={i} className="t-sub" style={{ marginTop: 6, color: f.state === "error" ? "#b3261e" : undefined }}>
            {f.state === "done" ? "✓" : f.state === "error" ? "✕" : "…"} {f.file.name} — {f.step || (f.state === "waiting" ? "waiting" : "")}
          </div>
        ))}
        {err && <div className="err" style={{ padding: "8px 0" }}>{err}</div>}

        {tests.map((t, ti) => {
          const keys = keysOf(t);
          return (
            <div key={ti} style={{ marginTop: 16, borderTop: "1px solid #ebe6da", paddingTop: 12 }}>
              <div className="lbl">{t.type === "F" ? "Leaf test" : "Soil test"} {ti + 1} — check everything below</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
                <label className="fld">Date sampled / received<input className="inp" type="date" value={t.date || ""} onChange={(e) => setTest(ti, { date: e.target.value || null })} /></label>
                <label className="fld">Lab<input className="inp" value={t.lab} onChange={(e) => setTest(ti, { lab: e.target.value })} /></label>
                <label className="fld">Method<input className="inp" value={t.method} onChange={(e) => setTest(ti, { method: e.target.value })} /></label>
              </div>
              <div className="t-sub">{t.reported ? `Reported ${fmtDate(t.reported)}. ` : ""}{t.method === "Modified Morgan" ? "UMass Modified Morgan: full map colours." : "Different method: only pH and organic matter colour the map."}</div>
              <div style={{ overflowX: "auto", marginTop: 8 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={th}>Sample</th><th style={th}>Where</th>
                      {keys.map((k) => <th key={k} style={th}>{LABEL[k] || k}<br /><small style={{ fontWeight: 400 }}>{t.fields?.find((f) => f.k === k)?.unit || DEFAULT_UNIT[k] || ""}</small></th>)}
                      <th style={th} />
                    </tr>
                  </thead>
                  <tbody>
                    {t.samples.map((s, si) => (
                      <tr key={si}>
                        <td style={td}><input className="inp" style={{ width: 110 }} value={s.label} onChange={(e) => setSample(ti, si, { label: e.target.value })} /></td>
                        <td style={td}><input className="inp" style={{ width: 150 }} value={s.location} onChange={(e) => setSample(ti, si, { location: e.target.value })} /></td>
                        {keys.map((k) => (
                          <td key={k} style={td}>
                            <input className="inp mono" style={{ width: 74, padding: "8px 6px" }} inputMode="decimal" defaultValue={s.values[k] ?? ""}
                                   title={s.ratings?.[k] ? `Lab rating: ${s.ratings[k]}` : undefined}
                                   onBlur={(e) => setValue(ti, si, k, e.target.value.trim())} />
                          </td>
                        ))}
                        <td style={td}><button className="b-sec" style={{ minHeight: 36 }} onClick={() => setTest(ti, { samples: t.samples.filter((_, j) => j !== si) })}>Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        {tests.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
            <button className="b-main" disabled={!!busy || !tests.some((t) => t.samples.length)} onClick={save}>{busy || "Save test"}</button>
            <button className="b-sec" disabled={!!busy} onClick={onClose}>Cancel</button>
            <span className="t-sub">After saving, use “Place samples on the map” on the Map tab.</span>
          </div>
        )}
      </div>
    </div>
  );
}
const th = { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #d9d3c4", whiteSpace: "nowrap", fontSize: 12 };
const td = { padding: "3px 4px", borderBottom: "1px solid #f0ece2" };
