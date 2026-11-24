/* ═══════════════════════════════════════════════════════════════════════════
   Read the GTC Backlog workbook (.xlsm/.xlsx) into plain data.
   ───────────────────────────────────────────────────────────────────────────
   Takes the file's bytes, wherever they came from (an upload today; later the
   same SharePoint file fetched live), so the dashboard doesn't care which.
   Columns are found by their HEADER TEXT, not their position, so re-ordering
   or adding columns in the workbook doesn't break this. Values are the ones
   Excel last calculated and saved in the file (formulas are not re-run).
   ═══════════════════════════════════════════════════════════════════════════ */

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const num = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,]/g, "")); return isFinite(n) ? n : null; };
const str = (v) => (v == null ? "" : String(v).trim());
const iso = (v) => {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  return null;
};
const ref = (v) => str(v).replace(/\.0$/, "");

function rowsOf(XLSX, wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

/** Find the header row (the first row containing all `must` labels) and map label → column. */
function headerMap(rows, must, scan = 15) {
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    const cells = (rows[i] || []).map(norm);
    if (must.every((m) => cells.includes(norm(m)))) {
      const map = {};
      cells.forEach((c, j) => { if (c && !(c in map)) map[c] = j; });   // first occurrence wins
      return { at: i, col: (label) => map[norm(label)] };
    }
  }
  return null;
}

/* The forecast and priority tabs are a rolling 12 months: a month earlier than
   "today" in the sheet really means that month NEXT year (its column header
   still says the old year). */
const rollMonth = (ym, asOf) => {
  if (!ym || !asOf || ym >= asOf.slice(0, 7)) return ym;
  return `${+ym.slice(0, 4) + 1}${ym.slice(4)}`;
};

/** Line items from any table with Item Name + Quantity + a visit/job number. */
const stripHtml = (h) => str(h).replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{2,}/g, "\n").trim();
function readLineItems(rows, lineItems, notes) {
  const lh = rows && headerMap(rows, ["Item Name", "Quantity"]);
  if (!lh) return 0;
  const refCol = lh.col("Visit Ref #") ?? lh.col("Ref #") ?? lh.col("Job #");
  if (refCol == null) return 0;
  let n = 0;
  for (let i = lh.at + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = ref(row[refCol]); const item = str(row[lh.col("Item Name")]); const qty = num(row[lh.col("Quantity")]) || 0;
    if (!id || !item || !qty) continue;
    const acc = lh.col("Accepted") != null ? row[lh.col("Accepted")] : null;
    if (acc === false || norm(acc) === "false") continue;     // declined options aren't work to do
    const isLabor = /labor/i.test(str(lh.col("Item Category") != null ? row[lh.col("Item Category")] : "")) || /labor/i.test(item);
    const o = (lineItems[id] = lineItems[id] || { grindHrs: 0, grindUnits: 0, cleanup: 0, cleanupHrs: 0, seed: 0, seedHrs: 0, seedUnit: "", pruneHrs: 0, removeHrs: 0, other: {} });
    const unit = lh.col("Unit of Measure") != null ? str(row[lh.col("Unit of Measure")]) : "";
    // SingleOps line-item export: the crew hours are the Labor lines (Pruning / Removal /
    // Stump Grind Labor); the service lines carry what was sold. Stump debris removal is a
    // count and soil & seed installation is square feet — they have no hours of their own.
    if (/stump/i.test(item) && /grind/i.test(item)) { if (isLabor) o.grindHrs += qty; else o.grindUnits += qty; }
    else if (/stump/i.test(item) && /(debris|clean)/i.test(item)) { if (isLabor) o.cleanupHrs += qty; else o.cleanup += qty; }
    else if (/soil\s*(and|&)\s*seed|seed.*install|hydroseed(?!ing mulch)/i.test(item) && !/mulch/i.test(item)) { if (isLabor) o.seedHrs += qty; else { o.seed += qty; o.seedUnit = /square/i.test(unit) ? "sq ft" : unit; } }
    else if (isLabor && /prun/i.test(item)) o.pruneHrs += qty;
    else if (isLabor && /remov/i.test(item)) o.removeHrs += qty;
    else o.other[item] = (o.other[item] || 0) + qty;
    if (notes && !notes[id]) {
      const parts = ["Internal Notes", "Crew Notes"].map((k) => (lh.col(k) != null ? stripHtml(row[lh.col(k)]) : "")).filter(Boolean);
      if (parts.length) notes[id] = [...new Set(parts)].join("\n— ");
    }
    n++;
  }
  return n;
}

export async function parseBacklogWorkbook(arrayBuffer, fileName = "") {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const warnings = [];

  // ── Visit Export: one row per active job ──────────────────────────────────
  const ve = rowsOf(XLSX, wb, "Visit Export");
  if (!ve) throw new Error('This file has no "Visit Export" tab — is it the GTC Backlog workbook?');
  const h = headerMap(ve, ["Ref #", "Client Last", "Job Location"]);
  if (!h) throw new Error('Couldn\'t find the header row (Ref #, Client Last, Job Location) on the "Visit Export" tab.');
  const g = (r, label) => { const c = h.col(label); return c == null ? null : r[c]; };
  let asOf = null;
  for (let i = 0; i < h.at; i++) {
    const row = ve[i] || [];
    const k = row.findIndex((c) => norm(c) === "today's date");
    if (k >= 0 && row[k + 1]) asOf = iso(row[k + 1]);
  }

  const jobs = [];
  for (let i = h.at + 1; i < ve.length; i++) {
    const r = ve[i] || [];
    const id = ref(g(r, "Ref #"));
    if (!id || !/^\d/.test(id)) continue;
    const addr = str(g(r, "Job Location")).replace(/,\s*USA$/i, "");
    const parts = addr.split(",").map((x) => x.trim());
    const tags = str(g(r, "Tags")).split(",").map((t) => t.trim()).filter(Boolean);
    const sched = str(g(r, "Sched / Unsched"));
    const schedM = sched.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(.*)$/);
    jobs.push({
      ref: id,
      last: str(g(r, "Client Last")),
      first: str(g(r, "Client First")),
      addr,
      town: parts[1] || "",
      zip: ref(g(r, "Job Zip")),
      zone: str(g(r, "Zone")),
      weeks: num(g(r, "Weeks")),                     // weeks since it went active
      promised: num(g(r, "Backlog")),                // promised backlog band, weeks (99 = flexible)
      promisedLabel: str(g(r, "Wks Prom")),
      diff: num(g(r, "Diff Prom vs. Weeks")),        // promised − waited; below 0 = past promise
      dueRange: str(g(r, "Due Date Range")),
      days: num(g(r, "Days in backlog")),
      hrs: num(g(r, "Estimated Hours")) ?? num(g(r, "Hrs")),
      stumpHrs: num(g(r, "Stump Hrs")) || 0,
      netHrs: num(g(r, "Net Hrs")),
      price: num(g(r, "Total Price")),
      stumpRev: num(g(r, "Stump Revenue")) || 0,
      rep: str(g(r, "Sales Rep(s)")),
      stage: str(g(r, "Current Stage")),
      onHold: g(r, "On Hold") === true || norm(g(r, "On Hold")) === "true",
      activeAt: iso(g(r, "Converted to Active")),
      tags,
      notes: str(g(r, "Job Notes")),
      schedDate: schedM ? iso(schedM[1]) : null,
      schedWho: schedM ? schedM[2].trim() : "",
    });
  }
  if (!jobs.length) throw new Error('No jobs found on the "Visit Export" tab.');

  // ── Line items (stump grinding, cleanup, soil & seed…) ─────────────────────
  // Any tab with Visit Ref # + Item Name + Quantity (today "Stump Labor Line
  // Items"; if more items are added to that SingleOps report, they're picked
  // up too). Labor-category quantities are hours; service quantities are units.
  const lineItems = {};       // ref -> { grindHrs, grindUnits, cleanup, cleanupHrs, seed, seedHrs, other: {name: qty} }
  wb.SheetNames.forEach((name) => readLineItems(rowsOf(XLSX, wb, name), lineItems));

  // ── Job Notes ──────────────────────────────────────────────────────────────
  const notes = {};
  const jn = rowsOf(XLSX, wb, "Job Notes");
  const jh = jn && headerMap(jn, ["Job #", "Job Notes"]);
  if (jh) for (let i = jh.at + 1; i < jn.length; i++) {
    const r = jn[i] || []; const id = ref(r[jh.col("Job #")]);
    if (id) notes[id] = str(r[jh.col("Job Notes")]);
  } else warnings.push('No "Job Notes" tab found.');

  // ── Scheduled Jobs: one row per line item; keep one per visit+date ─────────
  const scheduled = [];
  const sj = rowsOf(XLSX, wb, "Scheduled Jobs");
  const sh = sj && headerMap(sj, ["Visit Ref #", "Scheduled Date"]);
  if (sh) {
    const seen = new Set();
    for (let i = sh.at + 1; i < sj.length; i++) {
      const r = sj[i] || []; const id = ref(r[sh.col("Visit Ref #")]); const d = iso(r[sh.col("Scheduled Date")]);
      if (!id || !d || seen.has(id + d)) continue;
      seen.add(id + d);
      scheduled.push({ ref: id, date: d, who: str(r[sh.col("Assignees")]), stage: str(r[sh.col("Visit Stage")]) });
    }
  }

  // ── Zones: zip → town, rep, zone ───────────────────────────────────────────
  const zones = {};
  const zn = rowsOf(XLSX, wb, "Zones");
  const zh = zn && headerMap(zn, ["Zip Code", "Zone"]);
  if (zh) for (let i = zh.at + 1; i < zn.length; i++) {
    const r = zn[i] || []; const z = ref(r[zh.col("Zip Code")]);
    if (z) zones[z] = { town: str(r[zh.col("Town")]), rep: str(r[zh.col("Rep")]), zone: str(r[zh.col("Zone")]) };
  }

  // ── Priority Work: month columns of job numbers ────────────────────────────
  const priority = {};
  const pw = rowsOf(XLSX, wb, "Priority Work");
  if (pw && pw[0]) {
    const months = pw[0].map((c) => (c instanceof Date ? rollMonth(iso(c).slice(0, 7), asOf) : null));
    for (let i = 1; i < pw.length; i++) {
      (pw[i] || []).forEach((c, j) => {
        const id = ref(c);
        if (months[j] && /^\d{4,6}(-\d+)?$/.test(id)) {
          const list = (priority[months[j]] = priority[months[j]] || []);
          if (!list.includes(id)) list.push(id);
        }
      });
    }
  }

  // ── High Level Backlog View: monthly capacity forecast ─────────────────────
  let forecast = null;
  const hl = rowsOf(XLSX, wb, "High Level Backlog View");
  if (hl) {
    const labelCol = 3;                               // column D holds the row labels
    const monthRow = hl.find((r) => norm(r?.[labelCol]) === "month" && r.slice(labelCol + 1).some((c) => c instanceof Date));
    if (monthRow) {
      const cols = [];
      monthRow.forEach((c, j) => { if (j > labelCol && c instanceof Date) cols.push({ j, month: rollMonth(iso(c).slice(0, 7), asOf) }); });
      const byLabel = {};
      const emp = [];
      let inEmp = false;
      hl.forEach((r) => {
        const lab = str(r?.[labelCol]);
        if (!lab) return;
        if (norm(lab) === "employee (gtc)") { inEmp = true; return; }
        const vals = cols.map(({ j }) => num(r[j]));
        if (inEmp) { if (vals.some((v) => v != null)) emp.push({ name: lab, days: vals }); }
        else byLabel[lab] = vals;
      });
      const order = cols.map((c, k) => ({ ...c, k })).sort((a, b) => a.month.localeCompare(b.month));
      const pick = (lab) => { const v = byLabel[lab]; return v ? order.map((o) => v[o.k]) : null; };
      forecast = {
        months: order.map((o) => o.month),
        workableHrs: pick("Workable Hours Remaining - After Priority") || pick("Workable Hours Remaining - All"),
        workableHrsAll: pick("Workable Hours Remaining - All"),
        priorityHrs: pick("Hours held for Priority"),
        backlogBOM: pick("Backlog Hours Remaining BOM"),
        backlogEOM: pick("Backlog Hours remaining EOM"),
        workableDays: pick("Workable Days Remaining"),
        productivity: (() => { const r = hl.find((x) => norm(x?.[0]).startsWith("productivity factor")); return r ? order.map((o) => num(r[o.j])) : null; })(),
        employees: emp.map((e) => ({ name: e.name, days: order.map((o) => e.days[o.k]) })),
      };
    }
  }
  if (!forecast) warnings.push("Couldn't read the monthly forecast on the High Level Backlog View tab.");

  return {
    version: 1,
    fileName,
    asOf,
    jobs,
    lineItems,
    notes,
    scheduled,
    zones,
    priority,
    forecast,
    warnings,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SingleOps exports (CSV), the quicker way to refresh (owner, Nov 24).
   • Visit export — one row per visit, the same rows and job numbers as the
     workbook's "Visit Export" tab. The workbook's extra columns are worked out
     here: weeks waiting (from "Converted to Active"), promise band and due
     range (from "Backlog"), scheduled date / crew (Start, Stop, Assignees).
     Hours = "Remaining Hours" (what is left to do).
   • Line-item report (Item Name + Quantity + Visit Ref #) — stump grinding,
     cleanup, soil & seed split.
   What the exports don't carry is kept from the last upload: job notes, the
   zip → zone table, the stump split (if no line-item file), the forecast.
   ═══════════════════════════════════════════════════════════════════════════ */
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const soDate = (v) => {
  const t = str(v); if (!t) return null;
  let m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (m && MON[m[1].toLowerCase()] != null) return `${m[3]}-${String(MON[m[1].toLowerCase()] + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return iso(t) || (/^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null);
};
const isoAdd = (d, days) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + Math.round(days)); return x; };
const mdy = (x) => `${String(x.getMonth() + 1).padStart(2, "0")}/${String(x.getDate()).padStart(2, "0")}/${String(x.getFullYear()).slice(2)}`;
const truthy = (v) => v === true || norm(v) === "true";

function visitJobs(rows, h, prev, today) {
  const g = (r, label) => { const c = h.col(label); return c == null ? null : r[c]; };
  const prevBy = Object.fromEntries((prev?.jobs || []).map((j) => [j.ref, j]));
  const jobs = [];
  for (let i = h.at + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const id = ref(g(r, "Ref #"));
    if (!id || !/^\d/.test(id)) continue;
    const left = num(g(r, "Remaining Hours")), est = num(g(r, "Estimated Hours"));
    const hrs = left != null ? left : est;
    if (hrs != null && hrs <= 0 && soDate(g(r, "Completion Date"))) continue;    // finished
    const addr = str(g(r, "Job Location")).replace(/,\s*USA$/i, "");
    const zip = ref(g(r, "Job Zip"));
    const activeAt = soDate(g(r, "Converted to Active"));
    const days = activeAt ? Math.max(0, Math.round((new Date(today + "T12:00:00") - new Date(activeAt + "T12:00:00")) / 86400000)) : null;
    const weeks = days != null ? days / 7 : null;
    const promised = num(g(r, "Backlog"));
    const p = prevBy[id];
    const start = soDate(g(r, "Start")), stop = soDate(g(r, "Stop")) || start;
    const sched = start && stop && stop >= today;
    jobs.push({
      ref: id,
      last: str(g(r, "Client Last")) || str(g(r, "Client Company")),
      first: str(g(r, "Client First")),
      addr,
      town: str(g(r, "Job City")) || addr.split(",")[1]?.trim() || "",
      zip,
      zone: prev?.zones?.[zip]?.zone || p?.zone || "",
      weeks,
      promised,
      promisedLabel: promised == null ? "" : promised >= 99 ? "99" : `${promised}-${promised + 2}`,
      diff: promised != null && promised < 99 && weeks != null ? promised - weeks : null,
      dueRange: activeAt && promised != null && promised < 99 ? `${mdy(isoAdd(activeAt, promised * 7))} - ${mdy(isoAdd(activeAt, (promised + 3) * 7 - 1))}` : "",
      days,
      hrs,
      stumpHrs: p?.stumpHrs || 0,
      netHrs: hrs,
      price: num(g(r, "Total Price")),
      stumpRev: p?.stumpRev || 0,
      rep: str(g(r, "Sales Rep(s)")) || str(g(r, "Sales Rep")),
      stage: str(g(r, "Current Stage")),
      onHold: truthy(g(r, "On Hold")),
      activeAt,
      tags: str(g(r, "Tags")).split(",").map((t) => t.trim()).filter(Boolean),
      notes: p?.notes || prev?.notes?.[id] || "",
      schedDate: sched ? (start >= today ? start : today) : null,
      schedWho: sched ? str(g(r, "Assignee(s)")) || str(g(r, "Assignees")) : "",
      phone: [...new Set([str(g(r, "Client Mobile")), str(g(r, "Client Phone"))].filter(Boolean))].join(" / "),
      email: str(g(r, "Client Email")),
    });
  }
  return jobs;
}

/**
 * Read any mix of files into backlog data: the GTC Backlog workbook (.xlsm/.xlsx),
 * a SingleOps Visit export (.csv) and/or a line-item report (.csv).
 * files: [{ name, buf: ArrayBuffer }]; prev: the backlog data saved now (for what CSVs lack).
 * Returns { data, summary: [lines] }.
 */
export async function importBacklogFiles(files, prev) {
  const XLSX = await import("xlsx");
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const summary = [];
  let data = null;
  // 1. a workbook replaces everything
  for (const f of files.filter((x) => /\.xls[xm]?$/i.test(x.name))) {
    data = await parseBacklogWorkbook(f.buf, f.name);
    summary.push(`${f.name}: the GTC Backlog workbook — ${data.jobs.length} jobs.`);
  }
  const base = data || prev || null;
  // 2. CSVs
  const csvs = [];
  for (const f of files.filter((x) => /\.csv$/i.test(x.name))) {
    const wb = XLSX.read(new Uint8Array(f.buf), { type: "array", raw: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: false });
    csvs.push({ f, rows });
  }
  const visit = csvs.find(({ rows }) => { const h = headerMap(rows, ["Ref #", "Job Location"]); return h && (h.col("Remaining Hours") != null || h.col("Estimated Hours") != null); });
  const jobExp = csvs.find(({ rows }) => { const h = headerMap(rows, ["Ref #", "Job Location"]); return h && h.col("Total Estimated Hours") != null && h.col("Remaining Hours") == null; });
  if (visit) {
    const h = headerMap(visit.rows, ["Ref #", "Job Location"]);
    const jobs = visitJobs(visit.rows, h, base, today);
    if (!jobs.length) throw new Error(`${visit.f.name}: no visits found.`);
    const before = new Set((base?.jobs || []).map((j) => j.ref));
    const now = new Set(jobs.map((j) => j.ref));
    const added = jobs.filter((j) => !before.has(j.ref)).length;
    const gone = [...before].filter((r) => !now.has(r)).length;
    const noZone = jobs.filter((j) => !j.zone).length;
    const noNotes = jobs.filter((j) => !j.notes).length;
    data = {
      version: 1, source: "singleops-visit-csv", fileName: visit.f.name, asOf: today, jobs,
      lineItems: Object.fromEntries(Object.entries(base?.lineItems || {}).filter(([r]) => now.has(r))),
      notes: base?.notes || {}, scheduled: [], zones: base?.zones || {}, priority: base?.priority || {},
      forecast: base?.forecast || null, forecastFrom: base?.forecastFrom || base?.asOf || null,
      warnings: [],
    };
    summary.push(`${visit.f.name}: SingleOps visit export — ${jobs.length} visits (${added} new, ${gone} gone since the last upload).`);
    if (base) summary.push(`Kept from the last upload: job notes, zones${base.forecast ? ", the forecast" : ""}${Object.keys(data.lineItems).length ? ", the stump split" : ""}.`);
    if (noZone) summary.push(`${noZone} visits have no zone (their zip isn't on the workbook's zone list).`);
    const hasLines = csvs.some((c) => c !== visit && headerMap(c.rows, ["Item Name", "Quantity"]));
    if (base && !hasLines) summary.push(`Job notes carried over for ${jobs.length - noNotes} visits (the visit export has no notes — add the line-item report for SingleOps notes).`);
  } else if (jobExp) {
    throw new Error(`${jobExp.f.name} is the Job export. Please use the Visit export — its job numbers (like 27722-2) and remaining hours match what gets scheduled.`);
  }
  // 3. line items (stump grinding, cleanup, soil & seed)
  for (const c of csvs) {
    if (c === visit) continue;
    const li = {}, liNotes = {};
    const n = readLineItems(c.rows, li, liNotes);
    if (!n) { if (c !== jobExp) summary.push(`${c.f.name}: not recognised (expected a Visit export or a line-item report).`); continue; }
    if (!data && !base) throw new Error("Upload the Visit export (or the workbook) first, then the line items.");
    data = data || { ...base };
    data.lineItems = { ...(data.lineItems || {}), ...li };      // visits not in this report keep what they had
    // notes from SingleOps (Internal + Crew notes) win over the workbook's
    let nn = 0;
    data.jobs = data.jobs.map((j) => (liNotes[j.ref] ? (nn++, { ...j, notes: liNotes[j.ref] }) : j));
    const matched = data.jobs.filter((j) => li[j.ref]).length;
    summary.push(`${c.f.name}: line items for ${Object.keys(li).length} visits (${matched} of the ${data.jobs.length} in the backlog) — stump grinding hours, stump cleanup and soil & seed counts${nn ? `, notes for ${nn}` : ""}.`);
    if (matched < data.jobs.length) summary.push(`${data.jobs.length - matched} backlog visits aren't in the line-item report (it may be filtered to unscheduled visits) — they keep their last stump split.`);
  }
  if (!data) throw new Error("Nothing to import — choose the SingleOps Visit export (.csv), a line-item report, or the GTC Backlog workbook.");
  return { data, summary };
}
