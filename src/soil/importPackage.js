/* ═══════════════════════════════════════════════════════════════════════════
   Import a site package (.zip) — the format of the 670 Boughton Hill package:
     data/soil_samples.geojson   samples with lab values + metadata (required)
     data/site_history.json      timeline ("internal" = staff only)
     data/tree_schema.json       tree fields (no trees yet)
     lab_reports/*.pdf           one per sample; matched by lab number in the name
     BH-cutouts.json (optional)  boundary + house/barn/driveway cut-outs
   Read on this device, then saved to the server. Client data never goes into
   the code repository.
   ═══════════════════════════════════════════════════════════════════════════ */

import JSZip from "jszip";
import { soilApi } from "./api";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
const VALUE_KEYS = ["ph", "P", "K", "Ca", "Mg", "S", "B", "Mn", "Zn", "Cu", "Fe", "Al", "Pb", "cec", "exacid", "ca_bs", "mg_bs", "k_bs", "om"];

export async function readSitePackage(file, { name, client } = {}) {
  const zip = await JSZip.loadAsync(file);
  const find = (re) => Object.values(zip.files).find((f) => !f.dir && re.test(f.name) && !/__MACOSX/.test(f.name));
  const geo = find(/soil_samples\.geojson$/i);
  if (!geo) throw new Error("This zip has no data/soil_samples.geojson — is it a site package?");
  const gj = JSON.parse(await geo.async("string"));
  const meta = gj.metadata || {};
  const hist = find(/site_history\.json$/i);
  const history = hist ? JSON.parse(await hist.async("string")) : null;
  const schema = find(/tree_schema\.json$/i);
  const treeSchema = schema ? JSON.parse(await schema.async("string")) : null;
  const cut = find(/cutouts?\.json$/i);
  const shapes = cut ? (JSON.parse(await cut.async("string")).shapes || []) : [];
  const pdfs = Object.values(zip.files).filter((f) => !f.dir && /\.pdf$/i.test(f.name) && !/__MACOSX/.test(f.name));

  const address = meta.site || history?.site || "";
  const siteName = name || address.replace(/^\d+\s+/, "").replace(/\s+(Rd|Road|St|Street|Ave|Dr|Ln|Lane)\b.*$/i, "").trim() || "Site";
  const id = slug(siteName);
  const testId = `${meta.sampled || "test"}-${slug(meta.lab || "lab").slice(0, 12)}`;

  const files = [];
  const samples = (gj.features || []).map((f) => {
    const p = f.properties || {};
    const [lng, lat] = f.geometry?.coordinates || [];
    const pdf = pdfs.find((x) => p.lab_number && x.name.includes(p.lab_number));
    const key = pdf ? pdf.name.split("/").pop().replace(/[^A-Za-z0-9._ -]/g, "_") : null;
    if (pdf) files.push({ key, entry: pdf });
    const values = {};
    VALUE_KEYS.forEach((k) => { if (p[k] != null && p[k] !== "") values[k] = +p[k]; });
    return {
      id: p.sample || p.lab_sample_id, label: p.lab_sample_id || p.sample, labNumber: p.lab_number || "",
      location: p.location || "", lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
      values, pdf: key,
    };
  });

  const site = {
    id, name: siteName, client: client || "", address,
    shapes,
    history: history ? { events: history.events || [], counts: history.counts || {}, open_items: history.open_items || [], source: history.source || "" } : null,
    treeSchema,
    tests: [{
      id: testId, type: "S", date: meta.sampled || null, reported: meta.reported || null,
      lab: meta.lab || "", order: meta.order || "", method: "Modified Morgan",
      units: meta.units || {}, ranges: meta.lab_reference_ranges || {}, phTarget: [6.0, 6.8],
      note: meta.note || "", samples,
    }],
  };
  return { site, files };
}

/** Save a read package to the server, PDFs one at a time. */
export async function uploadSitePackage({ site, files }, onStep = () => {}) {
  onStep("Saving the property…");
  await soilApi("site", { method: "PUT", body: { site } });
  let i = 0;
  for (const f of files) {
    onStep(`Uploading lab reports… ${++i} of ${files.length}`);
    const buf = await f.entry.async("arraybuffer");
    await soilApi(`pdf?site=${encodeURIComponent(site.id)}&key=${encodeURIComponent(f.key)}`, { method: "PUT", raw: buf });
  }
  onStep("");
  return site.id;
}
