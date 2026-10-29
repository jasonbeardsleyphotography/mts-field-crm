/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Freeze recorder
   ───────────────────────────────────────────────────────────────────────────
   A short running log of what the app is doing — camera steps, background
   jobs, errors — written to this phone's storage AS IT HAPPENS, so it
   survives a force-quit. When the app freezes, the last line written is the
   step that never finished.

   A heartbeat every 0.5s records that the app is still responsive; when the
   app comes back from being stuck, the gap is logged as a STALL. If it never
   comes back (force-quit), the next launch reports when it was last alive.

   Settings → Copy freeze report formats the last few sessions as text to
   paste to support. Kept deliberately cheap: one small localStorage write per
   entry, entries capped, no per-item logging inside big loops.
   (Keys are NOT under "mts-field-": that prefix means "visit record".)
   ═══════════════════════════════════════════════════════════════════════════ */

const KEY = "mts-freeze-log";            // { sessions: [ {id, start, ver, ua, lastBeat, entries:[...] } ] }
const MAX_ENTRIES = 300;                 // per session
const MAX_SESSIONS = 4;
const BEAT_MS = 500;
const STALL_MS = 1500;

let data = null;
let cur = null;
let lastBeat = 0;
let saveQueued = false;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null") || { sessions: [] }; }
  catch { return { sessions: [] }; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch {
    // Storage full: drop the oldest sessions and try once more.
    try { data.sessions = data.sessions.slice(-1); localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
  }
}

/** Record one step. Written to storage immediately (that's the point). */
export function flog(ev, detail) {
  if (!cur) return;
  const e = [Date.now() - cur.start, ev];
  if (detail !== undefined) e.push(typeof detail === "string" ? detail.slice(0, 160) : detail);
  cur.entries.push(e);
  if (cur.entries.length > MAX_ENTRIES) cur.entries.splice(0, cur.entries.length - MAX_ENTRIES);
  cur.lastBeat = Date.now();
  save();
}

/** Time an async step: logs "<ev> …" before and "<ev> ✓ Nms" / "<ev> ✗" after. */
export async function ftime(ev, fn) {
  const t = Date.now();
  flog(ev + " …");
  try { const r = await fn(); flog(ev + " ✓", `${Date.now() - t}ms`); return r; }
  catch (e) { flog(ev + " ✗", `${Date.now() - t}ms ${e?.message || e}`); throw e; }
}

export function startFreezeLog(version) {
  if (cur) return;
  data = load();
  // The previous session ended — note how. If its last heartbeat came long
  // after its last logged step, it was alive and idle; if not, it died
  // (force-quit) right after that step.
  const prev = data.sessions[data.sessions.length - 1];
  cur = {
    id: Date.now(), start: Date.now(), ver: version || "", lastBeat: Date.now(),
    ua: (navigator.userAgent || "").replace(/^Mozilla\/5\.0 /, "").slice(0, 140),
    entries: [],
  };
  data.sessions.push(cur);
  if (data.sessions.length > MAX_SESSIONS) data.sessions = data.sessions.slice(-MAX_SESSIONS);
  flog("app start", prev ? `previous session last alive ${new Date(prev.lastBeat).toLocaleTimeString()}` : "");
  try { flog("screen", `${window.innerWidth}x${window.innerHeight} · zoom ${(window.visualViewport?.scale || 1).toFixed(2)}`); } catch {}
  try {
    caches.keys().then(ks => {
      const v = ks.filter(k => k.startsWith("mts-field-v")).sort((a, b) => parseInt(a.slice(11)) - parseInt(b.slice(11))).pop();
      if (v) { cur.ver = v.replace("mts-field-", ""); save(); }
    }).catch(() => {});
  } catch {}

  lastBeat = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    if (gap > STALL_MS) flog("STALL — app was unresponsive", `${gap}ms`);
    cur.lastBeat = now;
    // Persist the heartbeat cheaply (piggy-backs the next save if one is due).
    if (!saveQueued) { saveQueued = true; setTimeout(() => { saveQueued = false; save(); }, 5000); }
  }, BEAT_MS);

  document.addEventListener("visibilitychange", () => flog(`app ${document.visibilityState}`));

  // ── Touch & screen diagnostics ───────────────────────────────────────────
  // A real report showed the camera's buttons "frozen" while the app itself
  // was running fine — taps simply never reached them, right after the phone
  // was rotated. So: log every touch (where, and what element is actually on
  // top at that spot), every rotation/resize, and the page's zoom level.
  const scr = () => {
    const vv = window.visualViewport;
    const ang = (() => { try { return screen.orientation?.angle ?? window.orientation ?? 0; } catch { return "?"; } })();
    return `${window.innerWidth}x${window.innerHeight} rot ${ang}°` + (vv ? ` zoom ${vv.scale.toFixed(2)}${vv.scale !== 1 ? ` @${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)}` : ""}` : "");
  };
  const desc = (el) => {
    if (!el || !el.tagName) return "nothing";
    const lab = el.getAttribute?.("aria-label") || (el.closest?.("button")?.getAttribute("aria-label"));
    const txt = (el.textContent || "").trim().slice(0, 18).replace(/\s+/g, " ");
    return `${el.tagName.toLowerCase()}${lab ? `[${lab}]` : ""}${!lab && txt ? `"${txt}"` : ""}`;
  };
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; if (!t) return;
    const top = document.elementFromPoint(t.clientX, t.clientY);
    flog("touch", `${e.touches.length}f at ${Math.round(t.clientX)},${Math.round(t.clientY)} → on top: ${desc(top)} · target: ${desc(e.target)} · ${scr()}`);
  }, { capture: true, passive: true });
  document.addEventListener("click", (e) => flog("click", desc(e.target)), { capture: true, passive: true });
  document.addEventListener("gesturestart", () => flog("page pinch started", scr()), { capture: true, passive: true });
  let rz = null;
  const onResize = () => { clearTimeout(rz); rz = setTimeout(() => flog("screen changed", scr()), 250); };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
  window.addEventListener("pagehide", () => flog("app closing"));
  window.addEventListener("error", (e) => flog("ERROR", `${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => flog("ERROR (async)", String(e.reason?.message || e.reason || "")));
}

const fmtT = (ms) => {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
};

/** The report text: newest session first. */
export function freezeReport() {
  const d = data || load();
  const out = [`MTS Field freeze report — ${new Date().toLocaleString()}`];
  for (const s of [...d.sessions].reverse()) {
    out.push("");
    out.push(`=== Session started ${new Date(s.start).toLocaleString()} · ${s.ver} ===`);
    out.push(`device: ${s.ua}`);
    if (s !== cur) {
      const last = s.entries[s.entries.length - 1];
      out.push(`last alive ${new Date(s.lastBeat).toLocaleTimeString()} · last step: ${last ? last[1] + (last[2] != null ? " " + JSON.stringify(last[2]) : "") : "(none)"}`);
    }
    for (const [t, ev, det] of s.entries) out.push(`${fmtT(t).padStart(7)}  ${ev}${det != null ? "  " + (typeof det === "string" ? det : JSON.stringify(det)) : ""}`);
  }
  return out.join("\n");
}
