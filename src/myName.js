/* ═══════════════════════════════════════════════════════════════════════════
   MTS — The salesperson's own name, for messages sent to customers
   ───────────────────────────────────────────────────────────────────────────
   The "on my way" text and the follow-up templates used to be hard-wired to
   "Jason", so a second salesperson's customers would hear from the wrong
   person. The name is now a per-device setting (Settings → Your name),
   filled in automatically the first time an account is confirmed: "Jason" for
   the owner's accounts (recognised by fingerprint, like the server's approved
   list), otherwise the Google account's first name.
   ═══════════════════════════════════════════════════════════════════════════ */

const KEY = "mts-my-name";
const OWNER = new Set([
  "20e41e5a59a9e03d82b24ed1d55411705a6df86b36175a2d284345e56468cb9f",
  "5e23005b665a38a63de2d1a69d597d7c605ec51f896d3b61dd0aaf178e571c05",
]);

export function getMyName() {
  try { return (localStorage.getItem(KEY) || "").trim(); } catch { return ""; }
}
export function setMyName(name) {
  try { localStorage.setItem(KEY, String(name || "").trim()); } catch {}
}

/** "{myName}" in a template → the name, or a neutral stand-in if unset. */
export function fillMyName(text) {
  return String(text || "").replace(/\{myName\}/g, getMyName() || "your Monster Tree estimator");
}

async function sha256(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

/** Set the name once, if this device doesn't have one yet. */
export async function ensureMyName(token, accountEmail) {
  if (getMyName()) return;
  try {
    if (accountEmail && OWNER.has(await sha256(accountEmail.toLowerCase()))) { setMyName("Jason"); return; }
  } catch {}
  try {
    const r = await fetch("https://people.googleapis.com/v1/people/me?personFields=names",
      { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const given = (await r.json())?.names?.[0]?.givenName;
    if (given) setMyName(given);
  } catch {}
}
