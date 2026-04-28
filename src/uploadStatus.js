/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Upload Status Tracker
   Module-level (not React) so it survives component unmounts.
   OnsiteWindow calls inc/dec when YouTube uploads start/finish.
   Pipeline subscribes to show "↑ Uploading…" in the detail popup even
   after the user has navigated away from the Onsite screen.
   ═══════════════════════════════════════════════════════════════════════════ */

const _pending = {};       // { [stopId]: number }
const _listeners = new Set();

/** Call when a YouTube upload begins for a stop. */
export function incUpload(stopId) {
  _pending[stopId] = (_pending[stopId] || 0) + 1;
  _listeners.forEach(fn => fn(stopId, _pending[stopId]));
}

/** Call when a YouTube upload finishes (success or error) for a stop. */
export function decUpload(stopId) {
  _pending[stopId] = Math.max(0, (_pending[stopId] || 1) - 1);
  _listeners.forEach(fn => fn(stopId, _pending[stopId]));
}

/** Returns true if there's at least one active upload for this stop. */
export function isUploadPending(stopId) {
  return (_pending[stopId] || 0) > 0;
}

/**
 * Subscribe to upload count changes.
 * @param {(stopId: string, count: number) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onUploadChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
