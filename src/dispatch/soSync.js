import { crewsForDay } from "./Schedule.jsx";
import { shopSchedRange, shopPatch, stampNow } from "./shop/shopApi";
import { isoOf } from "./shop/ShopBoard.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   SINGLEOPS SCHEDULE → THE APP'S SCHEDULE (owner, Nov 25), run after a Visit
   export is imported. In SingleOps the "Assignee" is the crew's foreman (e.g.
   "Max Crew", "Mike L", "Jeff Royston"); the visit's Start → Stop are its days.
   For each day, the job goes on the crew that has that person on the Shop Board
   that day.

   NEVER ERASE THE OWNER'S WORK:
   • Entries this import writes carry by = SO_BY. Only those are ever moved or
     taken off by a later import (when SingleOps changes the date/foreman).
   • If the job is placed BY HAND anywhere from today on, the app's plan wins:
     nothing is added, the difference is only reported.
   • A day where the job was taken off BY HAND is never filled again.
   • Moving / taking off an imported entry in the Schedule makes it hand-made.
   Stump resources ("Stump Grinding", "Stump Cleanup") are not crews: skipped
   (the Stumps tab shows the date).
   ═══════════════════════════════════════════════════════════════════════════ */

import { SO_BY } from "./soConst";
export { SO_BY };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
const nice = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const toks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

/** Names in an Assignee(s) cell that are people (foremen), not stump resources. */
export function assigneePeople(who) {
  return String(who || "").split(/[|,;/]/).map((w) => w.trim()).filter(Boolean)
    .filter((w) => !/stump|grind|clean|seed|soil/i.test(w))
    .map((w) => w.replace(/\s+crew$/i, "").trim()).filter(Boolean);
}
/** A board person matches "Mike L" / "Max" / "Jeff Royston". */
function sameName(person, who) {
  const p = toks(person), w = toks(who);
  if (!p.length || !w.length || p[0] !== w[0]) return false;
  if (p.length === 1 || w.length === 1) return true;
  return p[1].startsWith(w[1]) || w[1].startsWith(p[1]);
}
/** The crew that has one of these people working that day (foremen first). */
export function crewFor(board, names) {
  const hits = [];
  for (const c of board.crews || []) {
    for (const pid of c.people || []) {
      const p = board.core.people[pid];
      if (!p || p.del || board.off.has(pid)) continue;
      if (names.some((n) => sameName(p.name, n))) hits.push({ c, fore: !!p.foreman });
    }
  }
  hits.sort((a, b) => Number(b.fore) - Number(a.fore));
  return hits[0]?.c || null;
}
const workdays = (from, to) => {
  const out = []; let d = from, guard = 0;
  while (d <= to && guard++ < 90) { const w = new Date(d + "T12:00:00").getDay(); if (w !== 0 && w !== 6) out.push(d); d = addDays(d, 1); }
  return out.length ? out : [from];          // a weekend-only visit keeps its own day
};

/**
 * jobs: enriched backlog jobs (soStart / soStop / soWho from the Visit export).
 * Returns summary lines. Writes only sched.<day> entries (merged per job on the server).
 */
export async function syncSingleOps(jobs) {
  const today = isoOf(new Date());
  const lastDay = addDays(today, 61);
  const sched = { ...(await shopSchedRange(today, 31)), ...(await shopSchedRange(addDays(today, 31), 31)) };
  const hand = {}, mine = {}, handOff = {};            // ref → [{iso, e}] placed by hand / by this import; ref → Set(iso) taken off by hand
  for (const [iso, rec] of Object.entries(sched)) {
    for (const [ref, e] of Object.entries(rec?.assign || {})) {
      if (!e || ref.startsWith("_")) continue;
      if (e.by === SO_BY) { if (e.crew) (mine[ref] = mine[ref] || []).push({ iso, e }); }
      else if (e.crew) (hand[ref] = hand[ref] || []).push({ iso, e });
      else (handOff[ref] = handOff[ref] || new Set()).add(iso);
    }
  }
  const boards = {};
  const boardOf = async (iso) => (boards[iso] = boards[iso] || await crewsForDay(iso, true));
  const patches = {};
  const put = (iso, ref, v) => { (patches[iso] = patches[iso] || {})[ref] = v; };
  const lines = [], noCrew = [], differ = [];
  let added = 0, moved = 0, kept = 0, stumpRes = 0;
  const handled = new Set();

  for (const j of jobs) {
    if (!j.soStart || !j.soStop || !j.soWho || j.soStop < today) continue;
    const names = assigneePeople(j.soWho);
    if (!names.length) { stumpRes++; continue; }
    handled.add(j.ref);
    const days = workdays(j.soStart < today ? today : j.soStart, j.soStop > lastDay ? lastDay : j.soStop);
    if (hand[j.ref]?.length) {               // the app's own plan wins
      const ours = [...new Set(hand[j.ref].map((x) => x.iso))].sort();
      if (ours.join() !== days.join()) differ.push(`${j.name} (#${j.ref}): SingleOps ${days.map(nice).join(", ")} with ${names.join(" / ")} — your plan has ${ours.map(nice).join(", ")}`);
      continue;
    }
    const want = {};
    for (const d of days) {
      if (handOff[j.ref]?.has(d)) continue;   // taken off by hand that day: leave it off
      const c = crewFor(await boardOf(d), names);
      if (!c) { noCrew.push(`${j.name} (#${j.ref}) on ${nice(d)}: ${names.join(" / ")} isn't on a crew that day`); continue; }
      want[d] = c.id;
    }
    const wd = Object.keys(want).sort();
    const total = j.treeHrs ?? j.hrs ?? 0;
    const n = wd.length;
    const old = mine[j.ref] || [];
    wd.forEach((d, k) => {
      const have = old.find((x) => x.iso === d);
      if (have && have.e.crew === want[d] && (have.e.parts || 1) === (n > 1 ? n : 1)) { kept++; return; }
      put(d, j.ref, {
        crew: want[d], label: `${j.name} #${j.ref}`, town: j.town, tags: j.tags || [], total,
        hrs: n > 1 ? total / n : total, parts: n > 1 ? n : null, days: n > 1 ? wd : null, part: n > 1 ? k + 1 : null,
        order: 50 + k, src: "singleops", soWho: j.soWho,
      });
      if (have) moved++; else added++;
    });
    old.filter((x) => !want[x.iso]).forEach((x) => { put(x.iso, j.ref, { crew: null, days: null, parts: null, part: null }); moved++; });
  }
  // imported entries whose visit SingleOps no longer schedules (done, moved past the range, unassigned): take them off
  for (const [ref, list] of Object.entries(mine)) {
    if (handled.has(ref)) continue;
    list.forEach((x) => put(x.iso, ref, { crew: null, days: null, parts: null, part: null }));
    moved++;
  }
  const at = stampNow();
  let failed = 0;
  for (const [iso, p] of Object.entries(patches)) {
    const assign = Object.fromEntries(Object.entries(p).map(([ref, v]) => [ref, { ...v, at, by: SO_BY }]));
    if (!(await shopPatch(`sched.${iso}`, { assign }))) failed++;
  }
  lines.push(`SingleOps schedule → crews: ${added} day${added === 1 ? "" : "s"} added, ${moved} updated, ${kept} already right. Anything you placed or took off by hand was left alone.`);
  if (stumpRes) lines.push(`${stumpRes} visits are assigned to Stump Grinding / Stump Cleanup (not crews) — see the Stumps tab.`);
  if (differ.length) lines.push(`Your plan differs from SingleOps for ${differ.length} job${differ.length === 1 ? "" : "s"} (yours kept): ${differ.slice(0, 6).join(" · ")}${differ.length > 6 ? " …" : ""}`);
  if (noCrew.length) lines.push(`Not placed — nobody by that name on a crew that day on the Shop Board: ${noCrew.slice(0, 6).join(" · ")}${noCrew.length > 6 ? ` … (${noCrew.length} in all)` : ""}`);
  if (failed) lines.push(`⚠ ${failed} day${failed === 1 ? "" : "s"} couldn't be saved — import again to finish.`);
  return lines;
}
