/* Shop Board ↔ server (/api/dispatch/shop/*). The server merges every patch
   item by item; see shopRoute in netlify/functions/dispatch.mjs.

   Time stamps decide which edit wins, so they use the SERVER's clock (each
   reply carries it), not this computer's — a laptop whose clock is a few
   minutes off can't make an old edit beat a new one. */

let offset = 0;
const learn = (now) => { if (typeof now === "number") offset = now - Date.now(); };
export const stampNow = () => Date.now() + offset;

async function call(path, init) {
  const r = await fetch(`/api/dispatch/shop/${path}`, { credentials: "same-origin", cache: "no-store", ...init });
  if (!r.ok) throw new Error(`shop ${r.status}`);
  const d = await r.json();
  learn(d.now);
  return d;
}

export async function shopGet(key) {
  try { return (await call(`get?key=${encodeURIComponent(key)}`)).value; } catch { return null; }
}
export async function shopDays() {
  try { return (await call("days")).days || []; } catch { return []; }
}
/** Send only what changed; returns the merged record from the server (or null on failure). */
export async function shopPatch(key, patch, replace = false) {
  try {
    return (await call("patch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, patch, replace }) })).value;
  } catch { return null; }
}
export async function shopPresence(uid) {
  try {
    return (await call("presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid }) })).presence || {};
  } catch { return {}; }
}

/** Items of a map that differ between two versions (for patches). */
export function changed(before = {}, after = {}) {
  const out = {};
  for (const [k, v] of Object.entries(after || {})) if (JSON.stringify(v) !== JSON.stringify((before || {})[k])) out[k] = v;
  return out;
}
/** Keys that differ, with null for removed ones (for per-key maps: pos, stacks). */
export function changedKeys(before = {}, after = {}) {
  const out = changed(before, after);
  for (const k of Object.keys(before || {})) if (!(k in (after || {}))) out[k] = null;
  return out;
}
