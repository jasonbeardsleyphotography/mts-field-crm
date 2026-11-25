import { useEffect, useState } from "react";
/* Title-bar look the owner is choosing between (Nov 25): A one bar · B two slim bars ·
   C tabs in the page. Per device; a temporary chooser sits in the Dispatch bar. */
const KEY = "mts-header-look";
let look = (() => { try { return ["A", "B", "C"].includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : "A"; } catch { return "A"; } })();
const subs = new Set();
export const headerLook = () => look;
export const setHeaderLook = (k) => { look = k; try { localStorage.setItem(KEY, k); } catch {} subs.forEach((f) => f(k)); };
export function useHeaderLook() {
  const [v, setV] = useState(look);
  useEffect(() => { subs.add(setV); return () => subs.delete(setV); }, []);
  return v;
}
