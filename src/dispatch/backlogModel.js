/* What the dashboard needs to know about each job, worked out once. */
// Copied from the field app's singleOpsCatalog.js (SingleOps' tag colours) so
// Dispatch doesn't share a code bundle with the field app.
const SINGLEOPS_JOB_TAG_COLORS = {
  crew: "#ff1f8f", "02": "#33cc33", "02r": "#10e0a0", "03": "#a0522d", "04": "#ffe600", "05": "#ff4a12",
  "06": "#1f9e1f", "07u": "#ff38e0", "07": "#9a00d6", "07s": "#880088", "08": "#9c9c1c", "09": "#1f3dff",
  "10c": "#f07070", "10b": "#b0605a", phc: "#7090b0", adj: "#ffffff", staff: "#0a8a8a",
};
/** SingleOps' global search for a job number. */
export const singleOpsJobUrl = (jn) =>
  `https://app.singleops.com/search/full_global_search?search_string=${encodeURIComponent(String(jn || "").trim())}`;

import { equipmentNeeds } from "./crewCheck";

/** Colour by how long a job has waited: newest green → oldest dark red. */
const AGE_STOPS = [[0, [23, 160, 91]], [60, [145, 207, 96]], [120, [229, 200, 60]], [180, [240, 140, 60]], [270, [217, 59, 43]], [365, [140, 20, 30]]];
export function ageColor(days) {
  const d = Math.max(0, days || 0);
  for (let i = 1; i < AGE_STOPS.length; i++) {
    if (d <= AGE_STOPS[i][0]) {
      const [a0, c0] = AGE_STOPS[i - 1], [a1, c1] = AGE_STOPS[i], t = (d - a0) / (a1 - a0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(",")})`;
    }
  }
  return `rgb(${AGE_STOPS[AGE_STOPS.length - 1][1].join(",")})`;
}
export const AGE_LEGEND = [[0, "new"], [60, "2 mo"], [120, "4 mo"], [180, "6 mo"], [270, "9 mo"], [365, "1 yr+"]];

export const STATUS = {
  over:  { label: "Past promise",   color: "#D93B2B", rank: 0 },
  soon:  { label: "Due in 2 weeks", color: "#E5A100", rank: 1 },
  ok:    { label: "On time",        color: "#17A05B", rank: 2 },
  flex:  { label: "Flexible (99)",  color: "#7d8a94", rank: 3 },
  sched: { label: "Scheduled",      color: "#3A8DD8", rank: 4 },
  hold:  { label: "On hold",        color: "#8a6bb8", rank: 5 },
};
export const STATUS_ORDER = ["over", "soon", "ok", "flex", "sched", "hold"];

const groupOf = (tag) => {
  if (tag.startsWith("#")) return "crew";
  const p = tag.slice(0, 2);
  if (p === "07" && /\*|EMERGENCY|STORM/.test(tag)) return "07u";
  if (p === "07" && /STUMP/.test(tag)) return "07s";
  if (p === "02" && /REQUIRED/.test(tag)) return "02r";
  if (p === "10") return /CALL BACK/.test(tag) ? "10c" : "10b";
  return p;
};
export const tagColor = (tag) => SINGLEOPS_JOB_TAG_COLORS[groupOf(tag)] || "#8e9bb7";
export const tagShort = (tag) => tag.replace(/^\d\d\s+/, "").replace(/^#(\d) PERSON$/, "$1-person");

/** Facets used for filtering: label → (job) → value(s). */
export const FACETS = {
  zone:   { label: "Zone",      of: (j) => j.zone || "—" },
  crew:   { label: "Crew size", of: (j) => j.crew || "?" },
  equip:  { label: "Equipment", of: (j) => j.equip.length ? j.equip : ["None listed"] },
  season: { label: "Season",    of: (j) => j.season.length ? j.season : ["Any"] },
  rep:    { label: "Sales rep", of: (j) => j.rep || "—" },
};

export function enrich(data) {
  const priority = new Set(Object.values(data.priority || {}).flat());
  const schedBy = {};
  (data.scheduled || []).forEach((s) => { (schedBy[s.ref] = schedBy[s.ref] || []).push(s); });
  return data.jobs.map((j) => {
    const crewTag = j.tags.find((t) => /^#\d PERSON$/.test(t));
    const equip = j.tags.filter((t) => /^0[23] /.test(t) && !/REQUIRED/.test(t)).map(tagShort);
    const season = j.tags.filter((t) => /^08 /.test(t)).map(tagShort);
    const visits = schedBy[j.ref] || [];
    const nextVisit = visits.map((v) => v.date).sort()[0] || j.schedDate;
    let status;
    if (j.onHold) status = "hold";
    else if (nextVisit) status = "sched";
    else if ((j.promised ?? 99) >= 99) status = "flex";
    else if (j.diff != null && j.diff < 0) status = "over";
    else if (j.diff != null && j.diff < 2) status = "soon";
    else status = "ok";
    // Hours split: tree work (pruning, removals…) vs stump grinding, stump
    // cleanup and soil & seed. Labor line items are hours and come off the
    // total; service items without labor hours are shown as quantities.
    const li = data.lineItems?.[j.ref];
    const grindHrs = li ? li.grindHrs : (j.stumpHrs || 0);
    const cleanupHrs = li?.cleanupHrs || 0, seedHrs = li?.seedHrs || 0;
    const treeHrs = Math.max(0, (j.hrs || 0) - grindHrs - cleanupHrs - seedHrs);
    return {
      ...j,
      treeHrs, grindHrs, cleanupHrs, seedHrs,
      cleanupQty: li?.cleanup || 0, seedQty: li?.seed || 0, grindUnits: li?.grindUnits || 0,
      needs: equipmentNeeds(j.tags),
      name: [j.first, j.last].filter(Boolean).join(" ") || j.last || j.ref,
      crew: crewTag ? `${crewTag[1]}-person` : "",
      equip, season,
      status,
      nextVisit,
      visitWho: visits[0]?.who || j.schedWho,
      priority: priority.has(j.ref),
      note: j.notes || data.notes?.[j.ref] || "",
      lateWeeks: j.diff != null && j.diff < 0 ? -j.diff : 0,
    };
  });
}

export const money = (n) => n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n).toLocaleString()}`;
export const hrs = (n) => n == null ? "—" : `${Math.round(n).toLocaleString()} h`;
export const monthName = (ym, long) => {
  const d = new Date(`${ym}-01T12:00:00`);
  return d.toLocaleDateString(undefined, { month: long ? "long" : "short", ...(long ? { year: "numeric" } : {}) });
};
