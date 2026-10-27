/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Back up the iPhone's own settings to Drive
   ───────────────────────────────────────────────────────────────────────────
   The RealWork / Send-to-RealWork / iPhone Video Shortcut choices live in
   this phone's storage. Removing the app from the Home Screen deletes that
   storage, so after a reinstall Done stopped auto-opening RealWork until the
   setups were redone. These few settings are now copied to a small file in
   the user's Drive whenever they change, and put back on a fresh install.

   iPhone/iPad only: the Shortcuts don't exist on a laptop, so other devices
   neither restore nor overwrite the backup. A fresh install restores BEFORE
   it ever writes, so a blank phone can't wipe the backup.
   ═══════════════════════════════════════════════════════════════════════════ */
import { savePhoneSettings, loadPhoneSettings } from "./driveSync";

const KEYS = [
  "mts-realwork-shortcut", "mts-realwork-shortcut-name",
  "mts-realwork-send", "mts-realwork-send-name",
  "mts-iphone-video", "mts-iphone-video-name",
];
const RESTORED = "mts-prefs-restored";

const isIOS = () => {
  try { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  catch { return false; }
};

/** Call after any of the settings above change. */
export function notifyPrefsChanged() {
  try { window.dispatchEvent(new Event("mts-prefs-changed")); } catch {}
}

/** Restore on a fresh install, then keep the backup current. Returns a cleanup fn. */
export function startPrefsBackup(getToken) {
  if (!isIOS()) return () => {};
  let ready = false, timer = null;
  const backup = () => {
    if (!ready) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const tok = getToken(); if (!tok) return;
      const prefs = {};
      for (const k of KEYS) { try { prefs[k] = localStorage.getItem(k); } catch {} }
      try { await savePhoneSettings(tok, prefs); } catch {}
    }, 1500);
  };
  window.addEventListener("mts-prefs-changed", backup);
  (async () => {
    try {
      if (!localStorage.getItem(RESTORED)) {
        const tok = getToken();
        const anySet = KEYS.some(k => localStorage.getItem(k) != null);
        if (tok && !anySet) {
          const prefs = await loadPhoneSettings(tok);
          if (prefs) for (const k of KEYS) { if (prefs[k] != null) localStorage.setItem(k, prefs[k]); }
        }
        localStorage.setItem(RESTORED, "1");
        if (anySet) { ready = true; backup(); }   // existing phone: seed the first backup
      }
    } catch {}
    ready = true;
  })();
  return () => { window.removeEventListener("mts-prefs-changed", backup); clearTimeout(timer); };
}
