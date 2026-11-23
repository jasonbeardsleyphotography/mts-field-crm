import { useEffect, useState } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   Hours, in the unit the viewer picks.
   The workbook's hours are always ON-SITE HOURS (OSH). The office also thinks
   in SALES HOURS (SH): 1 SH = 0.78 OSH, so SH = OSH ÷ 0.78.
   A normal day is 6.24 OSH (= 8 SH) per person on the crew.
   The choice is per device (Dispatch header: OSH | SH).
   ═══════════════════════════════════════════════════════════════════════════ */

export const OSH_PER_SH = 0.78;
export const DAY_OSH_PER_PERSON = 6.24;
const KEY = "mts-dispatch-hours-unit";
let unit = (() => { try { return localStorage.getItem(KEY) === "SH" ? "SH" : "OSH"; } catch { return "OSH"; } })();
const subs = new Set();

export const hoursUnit = () => unit;
export function setHoursUnit(u) {
  unit = u === "SH" ? "SH" : "OSH";
  try { localStorage.setItem(KEY, unit); } catch {}
  subs.forEach((f) => f(unit));
}
/** Re-render when the unit changes. */
export function useHoursUnit() {
  const [u, setU] = useState(unit);
  useEffect(() => { subs.add(setU); setU(unit); return () => subs.delete(setU); }, []);
  return u;
}
/** OSH → the number in the chosen unit. */
export const inUnit = (osh) => (unit === "SH" ? (osh || 0) / OSH_PER_SH : (osh || 0));
/** The chosen unit → OSH (for filters typed in the chosen unit). */
export const toOsh = (v) => (unit === "SH" ? (v || 0) * OSH_PER_SH : (v || 0));
const num = (n, dec) => (Math.round(n * 10 ** dec) / 10 ** dec).toLocaleString(undefined, { maximumFractionDigits: dec });
/** "12.4 OSH" / "15.9 SH" from on-site hours. */
export const fmtH = (osh, dec = 1) => (osh == null ? "—" : `${num(inUnit(osh), dec)} ${unit}`);
/** Just the number, no unit. */
export const numH = (osh, dec = 1) => num(inUnit(osh), dec);
/** A normal day's load for a crew of n people, in OSH. */
export const dayOsh = (people) => people * DAY_OSH_PER_PERSON;
