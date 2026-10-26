/* ═══════════════════════════════════════════════════════════════════════════
   Logout — actually end the server session.
   ───────────────────────────────────────────────────────────────────────────
   "Sign out" used to clear only the token held in the browser. The 400-day
   session cookie and the stored Google refresh token both survived, so the
   next reload silently signed the same person straight back in. On a shared
   phone or Chromebook that meant the NEXT person to open the app got the
   previous person's calendar and contacts. This deletes the stored session and
   expires the cookie.

   The Google grant itself is deliberately not revoked: that would also sign
   the same account out on every OTHER device it uses.
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { parseCookies } from "../lib/accounts.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  const sid = parseCookies(req.headers.get("cookie")).mts_sess;
  if (sid) {
    try { await getStore("mts-oauth").delete(sid); } catch { /* still clear the cookie */ }
  }
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", "mts_sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
