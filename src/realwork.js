/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Opening RealWork
   ───────────────────────────────────────────────────────────────────────────
   Two ways in, and which one is used is the user's choice:

   1. The website (default). Always works, but iOS opens it in Safari.

   2. The RealWork APP, via an iPhone Shortcut. RealWork doesn't publish a link
      scheme, and its web address doesn't hand off to the app, so there is no
      direct way for a web page to open it. What a web page CAN do is run a
      Shortcut by name (shortcuts://run-shortcut?name=…), and a Shortcut can
      "Open App". So the user makes a one-action Shortcut once, and this calls
      it. The Shortcuts app flashes up for a moment on the way.

   Option 2 is only used after the user has confirmed it works. If it were used
   blind and the Shortcut didn't exist, they would land on an error in the
   Shortcuts app with no way forward.
   ═══════════════════════════════════════════════════════════════════════════ */

export const REALWORK_WEB_URL = "https://app.realworklabs.com/jobs/published/new";
// What the user is told to call the Shortcut. They can change it in setup, so a
// slightly different name isn't a dead end.
export const DEFAULT_SHORTCUT_NAME = "Open RealWork";
const NAME_KEY = "mts-realwork-shortcut-name";

export function getShortcutName() {
  try { return (localStorage.getItem(NAME_KEY) || "").trim() || DEFAULT_SHORTCUT_NAME; }
  catch { return DEFAULT_SHORTCUT_NAME; }
}
export function setShortcutName(name) {
  try {
    const n = String(name || "").trim();
    if (n && n !== DEFAULT_SHORTCUT_NAME) localStorage.setItem(NAME_KEY, n);
    else localStorage.removeItem(NAME_KEY);
  } catch {}
}

const KEY = "mts-realwork-shortcut";

export function isShortcutReady() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
export function setShortcutReady(on) {
  try { on ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch {}
}

export const shortcutHref = () =>
  `shortcuts://run-shortcut?name=${encodeURIComponent(getShortcutName())}`;

/** The address a link should point at right now. */
export const realworkHref = () => (isShortcutReady() ? shortcutHref() : REALWORK_WEB_URL);

/** Open RealWork the way the user has chosen. Call from a tap where possible. */
export function openRealWork() {
  try {
    if (isShortcutReady()) { window.location.href = shortcutHref(); return true; }
    const w = window.open(REALWORK_WEB_URL, "_blank");
    // Never leave a handle back to this page in a window we didn't write.
    if (w) { try { w.opener = null; } catch {} }
    return !!w;
  } catch { return false; }
}

/** Run the Shortcut regardless of the saved choice — for the setup test. */
export function testShortcut() {
  try { window.location.href = shortcutHref(); } catch {}
}

/* ── Send a photo to RealWork (optional, second Shortcut) ─────────────────────
   "Send to RealWork" saves the photo it is given to Photos and then opens
   RealWork, so the photo is first in RealWork's picker. When it is switched on,
   tapping Done copies the visit's first photo and runs it — no picker, no share
   sheet. It is a SEPARATE Shortcut from "Open RealWork" on purpose: run with no
   photo, its save step can fail before RealWork opens, so visits without
   photos keep using the plain one. Off until the user has tested it. */
export const DEFAULT_SEND_NAME = "Send to RealWork";
const SEND_NAME_KEY = "mts-realwork-send-name";
const SEND_ON_KEY = "mts-realwork-send";

export function getSendName() {
  try { return (localStorage.getItem(SEND_NAME_KEY) || "").trim() || DEFAULT_SEND_NAME; }
  catch { return DEFAULT_SEND_NAME; }
}
export function setSendName(name) {
  try {
    const n = String(name || "").trim();
    if (n && n !== DEFAULT_SEND_NAME) localStorage.setItem(SEND_NAME_KEY, n);
    else localStorage.removeItem(SEND_NAME_KEY);
  } catch {}
}
export function isSendReady() {
  try { return localStorage.getItem(SEND_ON_KEY) === "1"; } catch { return false; }
}
export function setSendReady(on) {
  try { on ? localStorage.setItem(SEND_ON_KEY, "1") : localStorage.removeItem(SEND_ON_KEY); } catch {}
}

// input=clipboard hands the Shortcut whatever is on the clipboard — the photo
// MTS Field copied a moment earlier.
export const sendShortcutHref = () =>
  `shortcuts://run-shortcut?name=${encodeURIComponent(getSendName())}&input=clipboard`;

export function runSendShortcut() {
  try { window.location.href = sendShortcutHref(); } catch {}
}
