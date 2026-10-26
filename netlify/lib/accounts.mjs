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
  "de47890413c8ccc0ccda34c22be9d5b52620c34f7734a9fff6fe3e60734f7233", // sales account 2
]);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function isAllowedEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const extra = String(process.env.ALLOWED_GOOGLE_EMAILS || "")
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
    if (email && await isAllowedEmail(email)) return { ok: true, email };
  }
  const sid = parseCookies(req.headers.get("cookie")).mts_sess;
  if (sid) {
    try {
      const raw = await getStore("mts-oauth").get(sid);
      if (raw) {
        const sess = JSON.parse(raw);
        if (!sess.email || await isAllowedEmail(sess.email)) return { ok: true, email: sess.email || null };
      }
    } catch { /* fall through */ }
  }
  return { ok: false };
}
