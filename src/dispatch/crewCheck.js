/* ═══════════════════════════════════════════════════════════════════════════
   Does a crew suit a job? — shared by the Schedule and the Shop Board.
   A job's SingleOps tags are checked against the crew it's scheduled on:
     • equipment tags → the crew must have that kind of unit, and it must not
       be in the shop / tagged out
     • #2 / #3 / #4 PERSON → enough people on the crew that day
     • scheduling tags → things the office should cover when calling the client
     • gear tags → reminders of what to load
   Tags that don't matter here (PAPER INVOICE, OLD RATE…) are ignored.
   ═══════════════════════════════════════════════════════════════════════════ */

const norm = (t) => String(t || "").trim().toUpperCase().replace(/\s+/g, " ");

/** Equipment a tag needs: label + how to recognise a unit that provides it. */
const NEEDS = [
  { tags: ["02 BUCKET"], label: "Bucket truck", ok: (a) => a.shape === "BUCKET" || /bucket/i.test(a.tag || "") },
  { tags: ["02 LIFT", "02 LIFT REGULAR"], label: "Lift", ok: (a) => a.shape === "SPIDER" },
  { tags: ["02 LIFT TALL!"], label: "Tall lift (CMC 100HD)", ok: (a) => a.code === "100" || /100HD/i.test(a.name || "") },
  { tags: ["03 AVANT"], label: "Avant", ok: (a) => a.shape === "LOADER" },
  { tags: ["03 BIG CHIP"], label: "Big chipper (19XPC)", ok: (a) => /19XPC/i.test(a.name || "") },
  { tags: ["03 WOOD TRUCK"], label: "Wood truck", ok: (a) => a.cat === "DUMP TRUCK" },
  { tags: ["03 CRANE"], label: "Crane", ok: () => false, note: "not in the fleet — book one" },
  { tags: ["07 STUMPS", "07 STUMP CLEANUP"], label: "Stump grinder", ok: (a) => a.shape === "GRINDER" },
];

/** Things to cover when the office calls to schedule. */
const CALLS = {
  "09 MUST BE HOME": "Client must be home — confirm they'll be there",
  "09 NEIGHBOR PERMISSION": "Neighbour's permission needed — confirm it's been given",
  "09 OBSTACLE": "Obstacle on site — ask the client to move it",
  "09 APPT. SCHEDULED": "Appointment already promised — keep to it",
  "09 PET WASTE": "Ask the client to clear pet waste",
  "09 SHORT": "Short job — can be paired with another nearby",
  "07 EXTRA NOTICE": "Client wants extra notice before the crew comes",
  "07 SCHEDULE (DATE)": "Client asked for a specific date",
  "07 SCHEDULE (DAY)": "Client asked for a specific day of the week",
  "07 CHECK NOTES": "Read the job notes before scheduling",
  "07 *PARTIAL*": "Partial job — confirm which part is being done",
  "07 **EMERGENCY**": "Emergency job",
  "07 *STORM*": "Storm work",
  "07 DRY/FROZEN": "Needs dry or frozen ground — check the forecast",
  "07 MIDDAY DUMP": "Plan a midday dump run",
  "07 EOD": "End-of-day job",
  "07 PREVIEW": "Preview the site first",
  "05 PARKING": "Parking is tight — plan where the trucks go",
  "05 TRAFFIC": "Traffic control needed",
  "05 SEPTIC": "Septic system — keep heavy equipment off it",
  "05 IRRIGATION": "Irrigation — ask where the lines and heads are",
  "05 LIGHTING": "Landscape lighting — ask where it is",
  "05 POISON IVY": "Poison ivy on site",
  "05 HELICOPTER": "Helicopter work — special arrangements",
  "04 PRIMARY": "Primary power lines — check clearance / utility",
  "04 SECONDARY": "Secondary lines — check clearance",
  "04 SERVICE": "Service drop — check clearance",
  "04 LINE DROP": "Line drop needed — arrange with the utility",
};

/** Reminders of what to load. */
const GEAR = {
  "06 CABLE": "cabling kit", "06 EXTRA LADDER": "extra ladder", "06 EXTRA MATS": "extra ground mats", "06 GRCS": "GRCS rigging",
  "06 SANITIZE": "sanitizer for tools", "06 SHEARS": "shears", "06 WRAPTOR": "Wraptor", "02 REQUIRED": "required equipment (see notes)",
};

const isDown = (a) => a.status === "shop" || a.status === "tagged";

/**
 * Check one job against one crew.
 * tags: the job's SingleOps tags; crew: { iron:[assetId], people:[personId] };
 * assets: id → asset (with spec); peopleOn: how many of the crew are working that day.
 */
export function checkJob(tags, crew, assets, peopleOn) {
  const T = (tags || []).map(norm);
  const units = (crew?.iron || []).map((id) => assets?.[id]).filter((a) => a && !a.del);
  const missing = [];
  NEEDS.forEach((n) => {
    if (!n.tags.some((t) => T.includes(t))) return;
    const have = units.filter(n.ok);
    if (!have.length) missing.push({ label: n.label, why: n.note || "not on this crew" });
    else if (have.every(isDown)) missing.push({ label: n.label, why: `${have[0].name} is ${have[0].status === "shop" ? "in the shop" : "tagged out"}` });
  });
  const size = T.map((t) => (t.match(/^#(\d) PERSON$/) || [])[1]).filter(Boolean).map(Number);
  const need = size.length ? Math.max(...size) : 0;
  const short = need && peopleOn != null && peopleOn < need ? { need, have: peopleOn } : null;
  const calls = T.filter((t) => CALLS[t]).map((t) => CALLS[t]);
  const gear = T.filter((t) => GEAR[t]).map((t) => GEAR[t]);
  return { missing, short, calls, gear, problems: missing.length + (short ? 1 : 0) };
}

/** One line per problem, for lists and tooltips. */
export function problemLines(name, r) {
  const out = r.missing.map((m) => `${name}: needs ${m.label} — ${m.why}`);
  if (r.short) out.push(`${name}: ${r.short.need}-person job, crew has ${r.short.have}`);
  return out;
}
