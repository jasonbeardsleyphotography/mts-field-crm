/* ═══════════════════════════════════════════════════════════════════════════
   Which Google accounts may use this app's server features
   ───────────────────────────────────────────────────────────────────────────
   Before this, the server never checked WHO was signed in: any Google account
   that could get through the OAuth consent screen got a lasting server session
   and could store plans here. The only gate was Google's "Testing" test-user
   list — and switching the project to "In production" (the obvious cure for the
   weekly re-sign-in) would have quietly opened it to everyone.

   The allowed accounts are stored as SHA-256 fingerprints of the lower-cased
   address, so the addresses themselves never appear in the code. More can be
   added without a code change through the ALLOWED_GOOGLE_EMAILS environment
   variable in Netlify (comma-separated plain addresses).
   ═══════════════════════════════════════════════════════════════════════════ */

const BUILT_IN = new Set([
  "20e41e5a59a9e03d82b24ed1d55411705a6df86b36175a2d284345e56468cb9f", // owner
  "5e23005b665a38a63de2d1a69d597d7c605ec51f896d3b61dd0aaf178e571c05", // main sales account (signs in to the app)
  "de47890413c8ccc0ccda34c22be9d5b52620c34f7734a9fff6fe3e60734f7233", // sales account 2
]);

export const OWNER_HASH = "20e41e5a59a9e03d82b24ed1d55411705a6df86b36175a2d284345e56468cb9f";

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ── Admin-controlled user list ────────────────────────────────────────────
   The owner manages who may use which app (Field app, Dispatch, Shop Board,
   Admin) on the Admin screen; the list lives in Netlify Blobs ("mts-admin" /
   "users"). Rules:
     • The owner always has every app — nothing in the list can lock them out.
     • If an address is in the list, the list decides.
     • If it isn't, the field app falls back to the built-in list + env var
       above (so nothing changed for existing accounts until the owner edits).
   Functions pass their getStore in; edge functions don't, and keep the old
   built-in behaviour. */
export const APPS = ["field", "dispatch", "shop", "admin"];
let userCache = null, userCacheAt = 0;
export async function loadUserList(getStore, fresh = false) {
  if (!getStore) return null;
  if (!fresh && userCache && Date.now() - userCacheAt < 30000) return userCache;
  const raw = await getStore("mts-admin").get("users");
  userCache = raw ? JSON.parse(raw) : {};
  userCacheAt = Date.now();
  return userCache;
}
export function forgetUserCache() { userCache = null; }
export async function isOwnerEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return !!e && (await sha256(e)) === OWNER_HASH;
}
/** { field, dispatch, shop, admin } for this address. */
export async function appPermissions(email, getStore) {
  const e = String(email || "").trim().toLowerCase();
  const none = { field: false, dispatch: false, shop: false, admin: false };
  if (!e || !e.includes("@")) return none;
  if (await isOwnerEmail(e)) return { field: true, dispatch: true, shop: true, admin: true };
  if (getStore) {
    try {
      const rec = (await loadUserList(getStore))?.[e];
      if (rec) return rec.removed ? none : { ...none, ...(rec.apps || {}) };
    } catch { /* store unreachable: fall back to the built-in list */ }
  }
  return { ...none, field: await isAllowedEmail(e) };
}

export async function isAllowedEmail(email, getStore) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (getStore) return (await appPermissions(e, getStore)).field;
  // Works in regular functions (process.env) and edge functions (Netlify.env).
  const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? globalThis.process?.env?.[k] ?? "";
  const extra = String(env("ALLOWED_GOOGLE_EMAILS") || "")
    .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(e)) return true;
  return BUILT_IN.has(await sha256(e));
}

/** The Google account an access token belongs to, or null if it can't be told.
 *  Uses the primary calendar, whose id IS the account's address: every token
 *  this app holds has calendar access, so no extra permission is needed. */
export async function emailForToken(accessToken) {
  if (!accessToken) return null;
  try {
    const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d?.id === "string" && d.id.includes("@") ? d.id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) {
      try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {}
    }
  });
  return out;
}

/**
 * Is this request from an allowed, signed-in user?
 * Accepts either a Google access token (Authorization: Bearer …), checked by
 * asking Google whose it is, or this app's own session cookie.
 *
 * A session created before accounts were recorded has no email yet; it is let
 * through here, and /api/token fills the email in (or ends the session) on its
 * next renewal, which the app does on every launch.
 */
export async function authorizeRequest(req, getStore) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (token) {
    const email = await emailForToken(token);
    if (email && await isAllowedEmail(email, getStore)) return { ok: true, email };
  }
  const sid = parseCookies(req.headers.get("cookie")).mts_sess;
  if (sid) {
    try {
      const raw = await getStore("mts-oauth").get(sid);
      if (raw) {
        const sess = JSON.parse(raw);
        if (!sess.email || await isAllowedEmail(sess.email, getStore)) return { ok: true, email: sess.email || null };
      }
    } catch { /* fall through */ }
  }
  return { ok: false };
}
