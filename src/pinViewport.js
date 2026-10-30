/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Keep the app pinned to the top of the screen
   ───────────────────────────────────────────────────────────────────────────
   Freeze reports showed the cause of "frozen" screens: on an iPhone Home
   Screen app, turning from landscape back to portrait can leave the whole
   page scrolled up by 59pt (the status bar's height). What's drawn and where
   taps land then disagree, so every tap misses — the app looks frozen until
   it's force-quit. The app never scrolls as a page (each screen scrolls its
   own lists), so any page scroll is that bug: put it back immediately.
   ═══════════════════════════════════════════════════════════════════════════ */
import { flog } from "./freezeLog";

export function pinViewport() {
  let pending = false;
  const check = (why) => {
    const vv = window.visualViewport;
    const sx = window.scrollX, sy = window.scrollY;
    const ox = vv ? Math.round(vv.offsetLeft) : 0, oy = vv ? Math.round(vv.offsetTop) : 0;
    const zoomed = vv && Math.abs(vv.scale - 1) > 0.01;
    // A real pinch-zoom offsets the visual viewport; that's the user's doing.
    const shifted = sx || sy || (!zoomed && (ox || oy));
    if (!shifted) return;
    // While typing, iOS may move the page on purpose to keep the field above
    // the keyboard — leave that alone (a check runs again once it's closed).
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
    flog("screen was shifted — reset", `${why} · scroll ${Math.round(sx)},${Math.round(sy)} vv ${ox},${oy}`);
    try { window.scrollTo(0, 0); } catch {}
    try { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; } catch {}
  };
  const soon = (why) => {
    check(why);
    if (pending) return;
    pending = true;
    // iOS settles the layout a moment after rotating; check again as it does.
    [250, 700, 1500].forEach((ms, i, a) => setTimeout(() => { check(why + " (later)"); if (i === a.length - 1) pending = false; }, ms));
  };
  window.addEventListener("scroll", () => check("scroll"), { passive: true });
  window.addEventListener("resize", () => soon("resize"));
  window.addEventListener("orientationchange", () => soon("rotation"));
  window.visualViewport?.addEventListener("scroll", () => check("viewport"));
  window.visualViewport?.addEventListener("resize", () => soon("viewport resize"));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon("back to app"); });
  document.addEventListener("focusout", () => soon("keyboard closed"));
  window.addEventListener("pageshow", () => soon("pageshow"));
  setInterval(() => check("check"), 3000);
}
