/* ═══════════════════════════════════════════════════════════════════════════
   Token endpoint — mints a fresh Google access token from the stored refresh
   token, with no user interaction.
   ───────────────────────────────────────────────────────────────────────────
   The app calls GET /api/token whenever it needs a token. We read the session
   cookie, look up the refresh token in Blobs, and exchange it with Google for a
   short-lived access token that we return to the browser. No popup, ever —
   until the refresh token itself dies (in this project's "Testing" status,
   Google expires refresh tokens after ~7 days, so the user re-consents weekly).

   Returns 401 on any failure so the client cleanly falls back to interactive
   sign-in instead of hanging.
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default async (req) => {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sessionId = cookies.mts_sess;
  if (!sessionId) return json({ error: "no_session" }, 401);

  let sess;
  try {
    const store = getStore("mts-oauth");
    const raw = await store.get(sessionId);
    if (!raw) return json({ error: "no_session" }, 401);
    sess = JSON.parse(raw);
  } catch {
    return json({ error: "store_error" }, 401);
  }
  if (!sess?.refresh_token) return json({ error: "no_session" }, 401);

  const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: "server_misconfigured" }, 500);

  let data;
  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: sess.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    data = await resp.json();
    if (!resp.ok || !data.access_token) {
      // Refresh token expired (7-day Testing limit) or was revoked. Drop the
      // dead session so the client re-consents.
      try { await getStore("mts-oauth").delete(sessionId); } catch {}
      return json({ error: "refresh_failed" }, 401);
    }
  } catch {
    return json({ error: "refresh_network" }, 401);
  }

  return json({ access_token: data.access_token, expires_in: data.expires_in });
};
