/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Wake Lock helper
   Keeps the screen on during an active upload so iOS doesn't suspend JS
   mid-transfer just because the screen auto-dimmed. Shared by videoQueue.js
   and photoSync.js. Silently no-ops on browsers without Wake Lock support.
   ═══════════════════════════════════════════════════════════════════════════ */

export function createWakeLockHandle() {
  let lock = null;
  return {
    async acquire() {
      if (!("wakeLock" in navigator) || lock) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => { lock = null; });
      } catch {}
    },
    release() {
      try { lock?.release(); } catch {}
      lock = null;
    },
  };
}
