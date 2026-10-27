import { notifyPrefsChanged } from "./devicePrefs";
/* ═══════════════════════════════════════════════════════════════════════════
   MTS — "iPhone Video": open the iPhone's own Camera app, in Video mode
   ───────────────────────────────────────────────────────────────────────────
   A web app can't open the Camera app, let alone pick its mode. A Shortcut can:
   the Shortcuts "Open Camera" action has a mode setting, and Video is one of
   them. So, as with RealWork, the user makes a one-action Shortcut once and the
   button runs it by name. The recording is made by the Camera app and saved to
   Photos as normal — nothing goes through MTS Field.

   Off until the user has tested it, for the same reason as RealWork: run blind
   with no such Shortcut, they'd land on an error in the Shortcuts app.
   ═══════════════════════════════════════════════════════════════════════════ */

export const DEFAULT_IPHONE_VIDEO_NAME = "iPhone Video";
const NAME_KEY = "mts-iphone-video-name";
const ON_KEY = "mts-iphone-video";

export function getIphoneVideoName() {
  try { return (localStorage.getItem(NAME_KEY) || "").trim() || DEFAULT_IPHONE_VIDEO_NAME; }
  catch { return DEFAULT_IPHONE_VIDEO_NAME; }
}
export function setIphoneVideoName(name) {
  try {
    const n = String(name || "").trim();
    if (n && n !== DEFAULT_IPHONE_VIDEO_NAME) localStorage.setItem(NAME_KEY, n);
    else localStorage.removeItem(NAME_KEY);
  } catch {}
  notifyPrefsChanged();
}
export function isIphoneVideoReady() {
  try { return localStorage.getItem(ON_KEY) === "1"; } catch { return false; }
}
export function setIphoneVideoReady(on) {
  try { on ? localStorage.setItem(ON_KEY, "1") : localStorage.removeItem(ON_KEY); } catch {}
  notifyPrefsChanged();
}

export const iphoneVideoHref = () =>
  `shortcuts://run-shortcut?name=${encodeURIComponent(getIphoneVideoName())}`;

export function runIphoneVideo() {
  try { window.location.href = iphoneVideoHref(); } catch {}
}

/** "Oct 26, 2026, 3:42 PM" */
export const fmtCaptured = (ts) =>
  new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
