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
// `what` = plain words for the "Tag → equipment" list the owner checks.
// `aerial` = one of the ways up the tree. A job tagged with several aerial
//   options can be done with ANY of them — unless it is also tagged
//   02 REQUIRED, then every aerial machine tagged is needed (owner, Nov 23).
//   Climbing / climbable / ground need no machine: every foreman can do them.
// `later` = a later stage of the job (stump grinding): grouped and shown, but a
//   tree crew is NOT expected to carry it, so it doesn't count against a crew.
const NEEDS = [
  { tags: ["02 BUCKET"], label: "Bucket truck", what: "the bucket truck (F750 BUCKET)", aerial: true, ok: (a) => a.shape === "BUCKET" || /bucket/i.test(a.tag || "") },
  { tags: ["02 LIFT", "02 LIFT REGULAR"], label: "Lift", what: "any spider lift (CMC 83HD, 83HD+, 100HD)", aerial: true, ok: (a) => a.shape === "SPIDER" },
  { tags: ["02 LIFT TALL!"], label: "Tall lift (CMC 100HD)", what: "the CMC 100HD — needed when tagged alone; with LIFT too it's preferred but an 83 ft lift can do it", ok: (a) => a.code === "100" || /100HD/i.test(a.name || "") },
  { tags: ["03 AVANT"], label: "Avant", what: "any Avant", ok: (a) => a.shape === "LOADER" },
  { tags: ["03 AVANT_BIG"], label: "Big Avant (755i)", what: "the Avant 755i", ok: (a) => /755/.test(`${a.name} ${a.spec}`) },
  { tags: ["03 BIG CHIP"], label: "Big chipper (19XPC)", what: "a Bandit 19XPC", ok: (a) => /19XPC/i.test(a.name || "") },
  { tags: ["03 WOOD TRUCK"], label: "Wood truck", what: "a dump truck (WOOD TRUCK, RATTLIN LOG, the 2027 F750)", ok: (a) => a.cat === "DUMP TRUCK" },
  { tags: ["03 CRANE"], label: "Crane", what: "not in the fleet — book one", ok: () => false, note: "not in the fleet — book one" },
  { tags: ["07 STUMPS", "07 STUMP CLEANUP"], label: "Stump grinder", what: "the Rayco grinder — a later stage, not needed on the tree crew", ok: (a) => a.shape === "GRINDER", later: true },
];
/** Aerial options that need no machine (every foreman can climb / work from the ground). */
const CREW_AERIAL = { "02 CLIMBING": "climbing", "02 CLIMBABLE": "climbable — a lift or bucket job a climber CAN do", "02 GROUND": "ground work" };
/** Tags with no machine of their own (shown on the "Tag → equipment" list). */
export const UNMAPPED_TAGS = {
  ...Object.fromEntries(Object.entries(CREW_AERIAL).map(([t, w]) => [t, `${w} — any crew (no machine)`])),
  "02 REQUIRED": "with several aerial tags: ALL of them are needed (e.g. LIFT + BUCKET + REQUIRED = both). Without it, any one will do.",
};
/** For the "Tag → equipment" list. */
export const TAG_RULES = NEEDS.map((n) => ({ tags: n.tags, label: n.label, what: n.what + (n.aerial ? " (or another aerial option tagged, unless REQUIRED)" : ""), later: !!n.later }));

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
  "06 SANITIZE": "sanitizer for tools", "06 SHEARS": "shears", "06 WRAPTOR": "Wraptor",
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
  const usable = (n) => units.filter(n.ok).some((u) => !isDown(u));
  const why = (n) => { const have = units.filter(n.ok); return !have.length ? (n.note || "not on this crew") : `${have[0].name} is broken`; };
  const tagged = NEEDS.filter((n) => !n.later && n.tags.some((t) => T.includes(t)));
  // LIFT + LIFT TALL! together = the tall lift is best, but a regular lift CAN do it (owner, Nov 24):
  // the tall lift becomes one more aerial option, and its absence only a soft note.
  const tallToo = T.includes("02 LIFT TALL!") && (T.includes("02 LIFT REGULAR") || T.includes("02 LIFT"));
  const isAerial = (n) => n.aerial || (tallToo && n.tags.includes("02 LIFT TALL!"));
  const prefer = [];
  if (tallToo) { const tall = NEEDS.find((n) => n.tags.includes("02 LIFT TALL!")); if (!usable(tall)) prefer.push("best with the tall lift (CMC 100HD) — an 83 ft lift can do it"); }
  // machines that are always needed when tagged
  tagged.filter((n) => !isAerial(n)).forEach((n) => { if (!usable(n)) missing.push({ label: n.label, why: why(n) }); });
  // aerial: any one option will do, unless 02 REQUIRED (then every machine tagged)
  const aer = tagged.filter(isAerial);
  if (aer.length) {
    if (T.includes("02 REQUIRED")) aer.forEach((n) => { if (!usable(n)) missing.push({ label: n.label, why: why(n) + " · REQUIRED" }); });
    else if (!Object.keys(CREW_AERIAL).some((t) => T.includes(t)) && !aer.some(usable))
      missing.push({ label: aer.map((n) => n.label).join(" or "), why: aer.length > 1 ? "none on this crew" : why(aer[0]) });
  }
  const size = T.map((t) => (t.match(/^#(\d) PERSON$/) || [])[1]).filter(Boolean).map(Number);
  const need = size.length ? Math.max(...size) : 0;
  const short = need && peopleOn != null && peopleOn < need ? { need, have: peopleOn } : null;
  const calls = T.filter((t) => CALLS[t]).map((t) => CALLS[t]);
  const gear = T.filter((t) => GEAR[t]).map((t) => GEAR[t]);
  return { missing, short, calls, gear, prefer, problems: missing.length + (short ? 1 : 0) };
}

/** One line per problem, for lists and tooltips. */
export function problemLines(name, r) {
  const out = r.missing.map((m) => `${name}: needs ${m.label} — ${m.why}`);
  if (r.short) out.push(`${name}: ${r.short.need}-person job, crew has ${r.short.have}`);
  return out;
}

/** The special equipment a job's tags call for (labels), in a fixed order. */
export const EQUIPMENT_ORDER = NEEDS.map((n) => n.label);
export function equipmentNeeds(tags) {
  const T = (tags || []).map(norm);
  return NEEDS.filter((n) => n.tags.some((t) => T.includes(t))).map((n) => n.label);
}

/** Can this crew do this job today (equipment that works + enough people)? */
export function fitsCrew(tags, crew, assets, peopleOn) {
  return checkJob(tags, crew, assets, peopleOn).problems === 0;
}
