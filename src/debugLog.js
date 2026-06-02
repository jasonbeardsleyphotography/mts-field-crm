/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Persistent Debug Log
   ───────────────────────────────────────────────────────────────────────────
   Circular ring buffer stored in localStorage. Captures errors, warnings,
   and key lifecycle events with timestamps so post-mortem debugging is
   possible even after the app is closed and reopened.

   Max 100 entries — old ones roll off automatically. Each entry:
     { level: "error"|"warn"|"info", context, message, data?, ts }
   ═══════════════════════════════════════════════════════════════════════════ */

const LS_KEY  = "mts-debug-log";
const MAX_LEN = 100;

let _listeners = [];

function _read() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}

function _write(entries) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(entries)); }
  catch {}
  _listeners.forEach(fn => fn(entries));
}

function _append(level, context, message, data) {
  const entry = { level, context, message, ts: Date.now() };
  if (data !== undefined) {
    // Serialize data safely — don't let huge objects bloat the log
    try {
      const str = JSON.stringify(data);
      entry.data = str.length > 500 ? str.slice(0, 500) + "…" : str;
    } catch {}
  }
  const entries = _read();
  entries.push(entry);
  if (entries.length > MAX_LEN) entries.splice(0, entries.length - MAX_LEN);
  _write(entries);
}

export function logError(context, message, data) { _append("error", context, message, data); }
export function logWarn(context, message, data)  { _append("warn",  context, message, data); }
export function logInfo(context, message, data)  { _append("info",  context, message, data); }

export function getLog() { return _read(); }
export function clearLog() { _write([]); }

/** Subscribe to log changes. Returns unsubscribe fn. */
export function onLogChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

/** Export the log as a JSON blob download. */
export function downloadLog() {
  try {
    const entries = _read();
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `mts-debug-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {}
}
