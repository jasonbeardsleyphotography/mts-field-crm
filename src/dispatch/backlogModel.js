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

/* ── Colours ────────────────────────────────────────────────────────────────
   Age colours are spread by RANK, not by raw days: the newest job is green,
   the oldest dark red, and every shade in between is used by about the same
   number of jobs (raw days put most jobs at the two ends). Jobs on pause and
   jobs waiting for their season are left out of the scale and get their own
   colour. */
const AGE_STOPS = ["#17A05B", "#5DB94A", "#A5CC3A", "#E3D23A", "#F2B134", "#EE8530", "#DE5A2C", "#C8352A", "#8C141E"];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function gradientColor(t) {
  const x = Math.min(1, Math.max(0, t || 0)) * (AGE_STOPS.length - 1), i = Math.min(AGE_STOPS.length - 2, Math.floor(x)), f = x - i;
  const a = hex(AGE_STOPS[i]), b = hex(AGE_STOPS[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}
export const PAUSED_COLOR = "#B388FF";
export const EMERGENCY_COLOR = "#FF1744";
export const PRIORITY_COLOR = "#FF4FD8";
export const SEASON_COLOR = "#3FC1C9";
/** The colour of a job's dot / bar when colouring by age. */
export const jobColor = (j) => (j.status === "emergency" ? EMERGENCY_COLOR : j.status === "priority" ? PRIORITY_COLOR
  : j.status === "paused" ? PAUSED_COLOR : j.status === "season" ? SEASON_COLOR : gradientColor(j.ageT));
/** Legend for the age scale: [t, label] at five points along it. */
export function ageLegend(jobs) {
  const d = jobs.filter((j) => j.ageT != null).map((j) => j.days || 0).sort((a, b) => a - b);
  if (!d.length) return [];
  const lab = (x) => (x < 60 ? `${Math.round(x)} d` : x < 365 ? `${Math.round(x / 30.4)} mo` : `${(x / 365).toFixed(1)} yr`);
  return [0, 0.25, 0.5, 0.75, 1].map((t) => [t, lab(d[Math.round(t * (d.length - 1))])]);
}

export const STATUS = {
  emergency: { label: "EMERGENCY",       color: EMERGENCY_COLOR, rank: -2 },
  priority:  { label: "Priority",        color: PRIORITY_COLOR, rank: -1 },
  paused: { label: "Purgatory",          color: PAUSED_COLOR, rank: 7 },
  over:   { label: "Past promise",       color: "#D93B2B", rank: 0 },
  soon:   { label: "Due in 2 weeks",     color: "#E5A100", rank: 1 },
  ok:     { label: "On time",            color: "#17A05B", rank: 2 },
  season: { label: "Waiting for season", color: SEASON_COLOR, rank: 4 },
  flex:   { label: "Flexible (99)",      color: "#7d8a94", rank: 3 },
  sched:  { label: "Scheduled",          color: "#3A8DD8", rank: 5 },
  hold:   { label: "On hold (workbook)", color: "#6E7A83", rank: 6 },
};
export const STATUS_ORDER = ["emergency", "priority", "paused", "over", "soon", "ok", "season", "flex", "sched", "hold"];

/* ── Seasons ────────────────────────────────────────────────────────────────
   A job with a season tag is due in its season, not by its weeks promise:
     winter Jan 1–Mar 31 · spring Apr 1–Jun 30 · summer Jul 1–Sep 30 · fall Oct 1–Dec 31
     OAK = oak pruning, Nov 1–Mar 31 (outside oak-wilt season) — confirmed by the owner
     "OAK 2027" = the oak window starting Nov 1, 2027 — confirmed
   • In its season now → due by the season's end (amber in the last 2 weeks).
   • Out of season → "Waiting for season": not overdue.
   • Past promise only if a whole season window went by after it was sold
     (a window counts if it ends at least the promised lead time — or 4 weeks
     for flexible jobs — after the sale), e.g. sold in October with a winter
     tag and still not done on April 1. */
const SEASONS = {
  WINTER: { label: "Winter", m: [0, 2] }, SPRING: { label: "Spring", m: [3, 5] },
  SUMMER: { label: "Summer", m: [6, 8] }, FALL: { label: "Fall", m: [9, 11] }, AUTUMN: { label: "Fall", m: [9, 11] },
  OAK: { label: "Oak season", m: [10, 2] },
};
const DAYMS = 86400000;
export function seasonsOf(tags) {
  const out = [];
  (tags || []).forEach((t) => {
    const m = String(t).toUpperCase().match(/^08\s+([A-Z]+)(?:\s+(\d{4}))?/);
    // "OAK 2027" = the oak window that starts Nov 1, 2027 (owner, Nov 23)
    if (m && SEASONS[m[1]]) out.push({ ...SEASONS[m[1]], key: m[1], notBefore: m[2] ? new Date(+m[2], SEASONS[m[1]].m[0], 1) : null });
  });
  return out;
}
function windowsOf(se, y0, y1) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    const [a, b] = se.m;
    const start = new Date(y, a, 1), end = new Date(b >= a ? y : y + 1, b + 1, 0, 23, 59);
    if (se.notBefore && end < se.notBefore) continue;
    out.push({ start: se.notBefore && start < se.notBefore ? se.notBefore : start, end, label: se.label, year: start.getFullYear() });
  }
  return out;
}
const fmtD = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
/** Season verdict for a job, or null if it has no season tag. */
export function seasonStatus(j, today = new Date()) {
  const ss = seasonsOf(j.tags); if (!ss.length) return null;
  const sold = j.activeAt ? new Date(j.activeAt + "T12:00:00") : new Date(today - (j.days || 0) * DAYMS);
  const lead = ((j.promised && j.promised < 99) ? j.promised : 4) * 7 * DAYMS;
  const wins = ss.flatMap((se) => windowsOf(se, sold.getFullYear() - 1, today.getFullYear() + 2))
    .filter((w) => w.end - sold >= lead);
  const missed = wins.filter((w) => w.end < today).sort((a, b) => b.end - a.end)[0];
  const now = wins.find((w) => w.start <= today && today <= w.end);
  const next = wins.filter((w) => w.start > today).sort((a, b) => a.start - b.start)[0];
  const names = [...new Set(ss.map((x) => x.label))].join(" / ");
  if (missed) {
    const wk = (today - missed.end) / (7 * DAYMS);
    return { status: "over", lateWeeks: wk, text: `Missed ${missed.label.toLowerCase()} ${missed.year}${now ? ` · in season again now, do by ${fmtD(now.end)}` : ""}` };
  }
  if (now) {
    const left = (now.end - today) / DAYMS;
    const wd = workdaysBetween(today, now.end);
    return { status: left < 14 ? "soon" : "ok", lateWeeks: 0, countdown: wd, until: now.end,
             text: `${now.label} job · in season · ${wd} work day${wd === 1 ? "" : "s"} left until overdue (${fmtD(now.end)})` };
  }
  const wd = next ? workdaysBetween(today, next.end) : null;
  return { status: "season", lateWeeks: 0, countdown: wd, until: next?.end,
           text: `${names} job · season opens ${next ? fmtD(next.start) : "—"}${next ? ` · overdue after ${fmtD(next.end)} (${wd} work days)` : ""}` };
}

/** Mon–Fri days from a (exclusive) to b (inclusive). */
export function workdaysBetween(a, b) {
  const x = new Date(a); x.setHours(12, 0, 0, 0);
  const end = new Date(b); end.setHours(12, 0, 0, 0);
  let n = 0;
  while (x < end && n < 2000) { x.setDate(x.getDate() + 1); const d = x.getDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

/* WHERE A JOB LANDS (owner, Nov 24) — for answering "when are you coming?".
   Weeks are Mon–Fri work weeks. Week 1 = the first full work week after the sale
   (the Monday after it). A "13–15 weeks" promise lands in week 14 or 15, i.e. the
   week of (week-1 Monday + 13 weeks) or the week after. Sold Wed Jul 1 → week 1
   starts Jul 6 → lands the week of Oct 5 or Oct 12. */
const nextMonday = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); do { x.setDate(x.getDate() + 1); } while (x.getDay() !== 1); return x; };
const addWeeks = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n * 7); return x; };
const fmtWk = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
export function landing(j, today = new Date()) {
  if (!j.activeAt || j.promised == null || j.promised >= 99) return null;
  const w1 = nextMonday(new Date(j.activeAt + "T12:00:00"));
  const a = addWeeks(w1, j.promised), b = addWeeks(w1, j.promised + 1);
  const endB = new Date(b); endB.setDate(endB.getDate() + 4);            // Friday of the later week
  const t = new Date(today); t.setHours(12, 0, 0, 0);
  const sold = new Date(j.activeAt + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const band = j.promisedLabel || `${j.promised}-${j.promised + 2}`;
  let when;
  if (t > endB) { const late = Math.max(1, Math.round((t - endB) / (7 * DAYMS))); when = `was due the week of ${fmtWk(a)} or ${fmtWk(b)} — ${late} week${late === 1 ? "" : "s"} overdue`; }
  else if (t >= a) when = `due now — the week of ${fmtWk(a)} or ${fmtWk(b)}`;
  else { const wd = workdaysBetween(t, a); when = `should land the week of ${fmtWk(a)} or ${fmtWk(b)} (${Math.ceil(wd / 5)} work week${Math.ceil(wd / 5) === 1 ? "" : "s"} away)`; }
  return { a: a.toISOString().slice(0, 10), b: b.toISOString().slice(0, 10), text: `Sold ${sold}, promised ${band} weeks → ${when}` };
}

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

/**
 * paused: { ref: { reason, until, by, at } } — jobs put "on pause" by the office
 * (client can't be done yet, wants to meet again first…). Kept apart from the
 * workbook so a new upload doesn't lose them. A paused job never counts as late.
 */
export function enrich(data, paused = {}, today = new Date()) {
  const priority = new Set(Object.values(data.priority || {}).flat());
  const schedBy = {};
  (data.scheduled || []).forEach((s) => { (schedBy[s.ref] = schedBy[s.ref] || []).push(s); });
  const todayIso = today.toISOString().slice(0, 10);
  const out = data.jobs.map((j) => {
    const crewTag = j.tags.find((t) => /^#\d PERSON$/.test(t));
    const equip = j.tags.filter((t) => /^0[23] /.test(t) && !/REQUIRED/.test(t)).map(tagShort);
    const season = j.tags.filter((t) => /^08 /.test(t)).map(tagShort);
    const visits = schedBy[j.ref] || [];
    const nextVisit = visits.map((v) => v.date).sort()[0] || j.schedDate;
    // Purgatory (owner, Nov 24) = jobs paused here + jobs ON HOLD in SingleOps, together.
    const p = paused[j.ref] && !paused[j.ref].removed ? paused[j.ref]
      : j.onHold ? { reason: "On hold in SingleOps", by: "SingleOps", soHold: true } : null;
    const se = seasonStatus(j, today);
    let status, lateWeeks = j.diff != null && j.diff < 0 ? -j.diff : 0, dueText = "";
    // SingleOps tags 07 **EMERGENCY** / 07 **PRIORITY**: ALWAYS on top — above Purgatory,
    // on hold and scheduled alike (owner, Nov 24). The Schedule's alert counts unscheduled ones.
    if (j.tags.some((t) => /EMERGENCY/i.test(t))) status = "emergency";
    else if (j.tags.some((t) => /\*\*PRIORITY\*\*|^07 PRIORITY/i.test(t))) status = "priority";
    else if (p) status = "paused";
    else if (j.onHold) status = "hold";
    else if (nextVisit) status = "sched";
    else if (se) { status = se.status; lateWeeks = se.lateWeeks; dueText = se.text; }
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
      cleanupQty: li?.cleanup || 0, seedQty: li?.seed || 0, seedUnit: li?.seedUnit || "", grindUnits: li?.grindUnits || 0,
      needs: equipmentNeeds(j.tags),
      name: [j.first, j.last].filter(Boolean).join(" ") || j.last || j.ref,
      crew: crewTag ? `${crewTag[1]}-person` : "",
      equip, season,
      status, dueText, seasonal: !!se, countdown: se?.countdown ?? null, land: se ? null : landing(j, today),
      paused: p, checkBack: !!(p?.until && p.until <= todayIso),
      nextVisit,
      visitWho: visits[0]?.who || j.schedWho,
      priority: priority.has(j.ref),
      note: j.notes || data.notes?.[j.ref] || "",
      lateWeeks,
    };
  });
  // age rank (0 = newest … 1 = oldest) among the jobs on the colour scale
  const ranked = out.filter((j) => !["paused", "season", "emergency", "priority"].includes(j.status)).sort((a, b) => (a.days || 0) - (b.days || 0));
  const n = ranked.length;
  for (let i = 0; i < n;) {
    let k = i; while (k + 1 < n && (ranked[k + 1].days || 0) === (ranked[i].days || 0)) k++;
    const t = n > 1 ? ((i + k) / 2) / (n - 1) : 0;
    for (let x = i; x <= k; x++) ranked[x].ageT = t;
    i = k + 1;
  }
  return out;
}

export const money = (n) => n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n).toLocaleString()}`;
export const monthName = (ym, long) => {
  const d = new Date(`${ym}-01T12:00:00`);
  return d.toLocaleDateString(undefined, { month: long ? "long" : "short", ...(long ? { year: "numeric" } : {}) });
};
