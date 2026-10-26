/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Open driving directions
   ───────────────────────────────────────────────────────────────────────────
   Tries the Google Maps app first (comgooglemaps://). If the app isn't
   installed — a new user's phone, or any laptop/Chromebook — that link does
   nothing at all, so if the page is still in front a moment later, open
   Google Maps on the web instead, which works everywhere.
   ═══════════════════════════════════════════════════════════════════════════ */

const isTouchPhone = () => {
  try { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent); } catch { return false; }
};

/** addrs: one address, or several in driving order (last is the destination). */
export function openDirections(addrs) {
  const list = (Array.isArray(addrs) ? addrs : [addrs]).filter(Boolean);
  if (!list.length) return;
  const enc = list.map(a => encodeURIComponent(a));
  const dest = enc[enc.length - 1];
  const waypoints = enc.slice(0, -1).join("%7C");
  const web = `https://www.google.com/maps/dir/?api=1&destination=${dest}${waypoints ? `&waypoints=${waypoints}` : ""}&travelmode=driving`;

  if (!isTouchPhone()) { window.open(web, "_blank", "noopener"); return; }

  const app = list.length === 1
    ? `comgooglemaps://?daddr=${dest}&directionsmode=driving`
    : `comgooglemaps://?saddr=&daddr=${enc.join("+to:")}&directionsmode=driving`;
  let left = false;
  const onHide = () => { if (document.visibilityState === "hidden") left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (!left && document.visibilityState === "visible") window.location.href = web;
  }, 1500);
  window.location.href = app;
}
