/* ═══════════════════════════════════════════════════════════════════════════
   OAuth callback — exchanges Google's code for tokens and stores the refresh
   token server-side.
   ───────────────────────────────────────────────────────────────────────────
   Google redirects here with ?code=…&state=…. We verify state (CSRF), swap the
   code for { access_token, refresh_token } using the client secret (server-only),
   stash the refresh token in Netlify Blobs keyed by a random session id, and set
   that session id as a first-party HttpOnly cookie. Because the refresh token
   never touches the browser and the session cookie is first-party, Safari's
   cookie-clearing (ITP) can't break token renewal the way it broke the old
   Google-cookie silent flow.
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

function fail(origin, reason) {
  // Bounce back to the app with an error flag; the app keeps the old GIS
  // sign-in as a fallback so the user is never stranded.
  const headers = new Headers();
  headers.append("Set-Cookie", `mts_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  headers.set("Location", `${origin}/?oauth_error=${encodeURIComponent(reason)}`);
  return new Response(null, { status: 302, headers });
}

export default async (req) => {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req.headers.get("cookie"));

  if (!code || !state || state !== cookies.mts_oauth_state) {
    return fail(origin, "state_mismatch");
  }

  const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(origin, "server_misconfigured");

  let data;
  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${origin}/api/oauth/callback`,
        grant_type: "authorization_code",
      }),
    });
    data = await resp.json();
    if (!resp.ok) return fail(origin, "exchange_failed");
  } catch {
    return fail(origin, "exchange_network");
  }

  if (!data.refresh_token) {
    // prompt=consent should always yield one; if not, don't half-store a session.
    return fail(origin, "no_refresh_token");
  }

  const sessionId = crypto.randomUUID();
  try {
    const store = getStore("mts-oauth");
    await store.set(
      sessionId,
      JSON.stringify({ refresh_token: data.refresh_token, createdAt: Date.now() })
    );
  } catch {
    return fail(origin, "store_failed");
  }

  const headers = new Headers();
  // 400-day session cookie (browser max). HttpOnly server-set cookies are NOT
  // subject to Safari's 7-day script-storage cap, so the session persists.
  headers.append(
    "Set-Cookie",
    `mts_sess=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`
  );
  headers.append("Set-Cookie", `mts_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  headers.set("Location", `${origin}/?signedin=1`);
  return new Response(null, { status: 302, headers });
};
