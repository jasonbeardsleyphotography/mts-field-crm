import { useEffect, useState } from "react";
/* Weekends on/off (owner, Nov 25): ONE switch for the Shop Board and the Schedule, per device
   (localStorage `mts-sched-weekends`, "1" = on). Off by default: Sat/Sun leave the day strips. */
const KEY = "mts-sched-weekends";
let on = (() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })();
const subs = new Set();
export const weekendsOn = () => on;
export function setWeekendsOn(v) { on = !!v; try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {} subs.forEach((f) => f(on)); }
export function useWeekends() {
  const [v, setV] = useState(on);
  useEffect(() => { subs.add(setV); setV(on); return () => subs.delete(setV); }, []);
  return [v, setWeekendsOn];
}
