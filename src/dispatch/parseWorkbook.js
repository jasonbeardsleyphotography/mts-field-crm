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
  wb.SheetNames.forEach((name) => {
    const rows = rowsOf(XLSX, wb, name);
    const lh = rows && headerMap(rows, ["Item Name", "Quantity"]);
    if (!lh) return;
    const refCol = lh.col("Visit Ref #") ?? lh.col("Ref #") ?? lh.col("Job #");
    if (refCol == null) return;
    for (let i = lh.at + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const id = ref(row[refCol]); const item = str(row[lh.col("Item Name")]); const qty = num(row[lh.col("Quantity")]) || 0;
      if (!id || !item || !qty) continue;
      const acc = row[lh.col("Accepted")];
      if (acc === false || norm(acc) === "false") continue;     // declined options aren't work to do
      const isLabor = /labor/i.test(str(row[lh.col("Item Category")])) || /labor/i.test(item);
      const o = (lineItems[id] = lineItems[id] || { grindHrs: 0, grindUnits: 0, cleanup: 0, cleanupHrs: 0, seed: 0, seedHrs: 0, other: {} });
      if (/stump/i.test(item) && /grind/i.test(item)) { if (isLabor) o.grindHrs += qty; else o.grindUnits += qty; }
      else if (/stump/i.test(item) && /(debris|clean)/i.test(item)) { if (isLabor) o.cleanupHrs += qty; else o.cleanup += qty; }
      else if (/(seed|topsoil|soil)/i.test(item)) { if (isLabor) o.seedHrs += qty; else o.seed += qty; }
      else o.other[item] = (o.other[item] || 0) + qty;
    }
  });

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
