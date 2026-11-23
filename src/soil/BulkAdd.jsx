import { useState } from "react";
import { soilApi } from "./api";
import AddTest from "./AddTest.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   Add soil reports — any number of lab PDFs at once, from the Soil home.
   The office names report files like:
       Steves, 1845 Colby St 14420, 05-21-2021, S, Rear Lawn.pdf
       (client last name, street + zip, date, S = soil / F = foliar, area)
   1. Each file name is read to find the property: an existing one with the
      same street number, street and zip, or a new one.
   2. You confirm the matches (and can change any).
   3. Each property's reports are read by AI and checked in a table, then saved.
   ═══════════════════════════════════════════════════════════════════════════ */

const SUFFIX = { street: "st", road: "rd", drive: "dr", lane: "ln", avenue: "ave", circle: "cir", court: "ct", trail: "trl", place: "pl", terrace: "ter", boulevard: "blvd", parkway: "pkwy", hill: "hill" };
const pad = (n) => String(n).padStart(2, "0");

/** Read the office's file name pattern. Returns null if it doesn't fit. */
export function parseReportName(name) {
  const base = name.replace(/\.pdf$/i, "").trim();
  const parts = base.split(/,\s+/).map((x) => x.trim()).filter(Boolean);   // "2025,12,01" has no spaces, so stays whole
  if (parts.length < 2) return null;
  const client = parts[0];
  const zip = (parts[1].match(/\b(\d{5})\s*$/) || [])[1] || "";
  const street = parts[1].replace(/\s*\d{5}\s*$/, "").trim();
  if (!/^\d+\s+\S/.test(street)) return null;
  let date = null, type = null, rest = parts.slice(2);
  const readDate = (t) => {
    let m = t.match(/^(\d{4})[,\-.](\d{1,2})[,\-.](\d{1,2})\b/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
    return null;
  };
  if (rest.length && readDate(rest[0])) {
    date = readDate(rest[0]);
    const after = rest[0].replace(/^\S+\s*/, "");               // "05-21-2021 S" (README example)
    if (/^[SF]$/i.test(after)) type = after.toUpperCase();
    rest = rest.slice(1);
  }
  if (!type && rest.length && /^[SF]$/i.test(rest[0])) { type = rest[0].toUpperCase(); rest = rest.slice(1); }
  return { client, street, zip, date, type, area: rest.join(", ") };
}

const addrKey = (s) => {
  const t = String(s || "").toLowerCase().replace(/[.#]/g, "").split(",")[0].trim().split(/\s+/);
  const num = t[0], word = (t.slice(1).find((w) => !/^(n|s|e|w|north|south|east|west)$/.test(w)) || "");
  return `${num} ${SUFFIX[word] || word}`;
};
const zipOf = (s) => (String(s || "").match(/\b(\d{5})\b(?!.*\b\d{5}\b)/) || [])[1] || "";
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

export default function BulkAdd({ sites, onClose, onDone }) {
  const [groups, setGroups] = useState(null);      // [{ key, info, files:[{file,hint}], target: siteId|"new", newSite }]
  const [step, setStep] = useState("pick");        // pick | confirm | read
  const [loaded, setLoaded] = useState({});        // siteId -> full site (for existing ones)
  const [saved, setSaved] = useState({});
  const [err, setErr] = useState("");

  const pick = (list) => {
    setErr("");
    const by = new Map();
    [...list].filter((f) => /\.pdf$/i.test(f.name)).forEach((file) => {
      const info = parseReportName(file.name);
      const key = info ? `${addrKey(info.street)}|${info.zip}` : `?${file.name}`;
      if (!by.has(key)) {
        const match = info && sites.find((s) => addrKey(s.address) === addrKey(info.street) && (!info.zip || !zipOf(s.address) || zipOf(s.address) === info.zip));
        by.set(key, {
          key, info, files: [], target: match ? match.id : "new",
          newSite: info ? { name: info.client, client: info.client, address: `${info.street}${info.zip ? ` ${info.zip}` : ""}` } : { name: "", client: "", address: "" },
        });
      }
      by.get(key).files.push({ file, hint: info ? { date: info.date, type: info.type, area: info.area } : {} });
    });
    const g = [...by.values()];
    if (!g.length) { setErr("Choose PDF lab reports."); return; }
    setGroups(g); setStep("confirm");
  };

  const setG = (i, patch) => setGroups((cur) => cur.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  const start = async () => {
    setErr("");
    for (const g of groups) if (g.target === "new" && (!g.newSite.name.trim() || !g.newSite.address.trim())) { setErr("Give every new property a name and an address."); return; }
    const need = [...new Set(groups.filter((g) => g.target !== "new").map((g) => g.target))];
    try {
      const full = {};
      for (const id of need) full[id] = (await soilApi(`site?id=${encodeURIComponent(id)}`)).site;
      setLoaded(full); setStep("read");
    } catch (e) { setErr(`Couldn't open a property (${e.message}).`); }
  };

  const siteFor = (g) => {
    if (g.target !== "new") return loaded[g.target];
    let id = slug(g.newSite.name + " " + g.newSite.address.split(" ").slice(0, 2).join(" "));
    while (sites.some((s) => s.id === id)) id += "-2";
    return { id, name: g.newSite.name.trim(), client: g.newSite.client.trim(), address: g.newSite.address.trim(), shapes: [], history: null, tests: [] };
  };

  const allSaved = groups && groups.every((g) => saved[g.key]);

  return (
    <div className="sheet" role="dialog" aria-label="Add soil reports" style={{ maxHeight: "94dvh" }}>
      <div className="sheet-h">
        <div style={{ flex: 1 }}>
          <div className="t-h">Add soil reports</div>
          <div className="t-sub">Choose the lab report PDFs. Each file name tells the app which property it belongs to, e.g. “Steves, 1845 Colby St 14420, 05-21-2021, S, Rear Lawn”.</div>
        </div>
        <button className="b-icon" onClick={() => (allSaved ? onDone() : onClose())} aria-label="Close">✕</button>
      </div>
      <div className="sheet-b">
        {step === "pick" && (
          <>
            <label className="b-main" style={{ display: "inline-flex" }}>
              Choose PDF reports
              <input type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { const l = [...(e.target.files || [])]; e.target.value = ""; if (l.length) pick(l); }} />
            </label>
            <div className="t-sub" style={{ marginTop: 6 }}>You can pick reports for several properties at once.</div>
          </>
        )}
        {err && <div className="err" style={{ padding: "8px 0" }}>{err}</div>}

        {step === "confirm" && groups && (
          <>
            <div className="lbl">Check which property each report goes to</div>
            {groups.map((g, i) => (
              <div key={g.key} className="card pad" style={{ marginBottom: 8 }}>
                <div className="t-sub" style={{ marginBottom: 6 }}>{g.files.map((f) => f.file.name).join(" · ")}</div>
                {!g.info && <div className="t-sub" style={{ color: "#b3261e", marginBottom: 6 }}>This file name doesn't follow the naming pattern — choose the property below.</div>}
                <label className="fld">Property
                  <select value={g.target} onChange={(e) => setG(i, { target: e.target.value })}>
                    <option value="new">New property…</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.address}</option>)}
                  </select>
                </label>
                {g.target === "new" && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
                    <label className="fld">Name<input className="inp" value={g.newSite.name} onChange={(e) => setG(i, { newSite: { ...g.newSite, name: e.target.value } })} /></label>
                    <label className="fld">Client<input className="inp" value={g.newSite.client} onChange={(e) => setG(i, { newSite: { ...g.newSite, client: e.target.value } })} /></label>
                    <label className="fld">Address (add the town if you can)<input className="inp" value={g.newSite.address} onChange={(e) => setG(i, { newSite: { ...g.newSite, address: e.target.value } })} /></label>
                  </div>
                )}
                {g.target !== "new" && <div className="t-sub">✓ Matched to an existing property by its address.</div>}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="b-main" onClick={start}>Read the reports</button>
              <button className="b-sec" onClick={() => { setGroups(null); setStep("pick"); }}>Start over</button>
            </div>
            <div className="t-sub" style={{ marginTop: 6 }}>The reports go to Google's Gemini AI to be read. Nothing is saved until you check and save each property.</div>
          </>
        )}

        {step === "read" && groups && groups.map((g) => {
          const site = siteFor(g);
          return (
            <div key={g.key} className="card pad" style={{ marginBottom: 12 }}>
              <div className="t-h" style={{ fontSize: 17 }}>{site.name}{g.target === "new" ? " (new)" : ""}</div>
              <div className="t-sub" style={{ marginBottom: 8 }}>{site.address}</div>
              {saved[g.key]
                ? <div className="t-sub" style={{ color: "#1b5e20" }}>✓ Saved. {g.target === "new" ? "Open the property to place its samples on the map." : ""}</div>
                : <AddTest site={site} embedded initialFiles={g.files} onClose={() => {}} onSaved={() => setSaved((s) => ({ ...s, [g.key]: true }))} />}
            </div>
          );
        })}
        {allSaved && <button className="b-main" onClick={onDone}>Done</button>}
      </div>
    </div>
  );
}
