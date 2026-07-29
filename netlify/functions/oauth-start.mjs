/* ═══════════════════════════════════════════════════════════════════════════
   OAuth start — kicks off Google's authorization-code flow.
   ───────────────────────────────────────────────────────────────────────────
   Redirects the browser to Google's consent screen with access_type=offline
   so Google returns a REFRESH TOKEN (the implicit/token flow the app used
   before never gets one). The callback stores that refresh token server-side.
   A random `state` is set as a short-lived cookie for CSRF protection and
   verified in the callback.
   ═══════════════════════════════════════════════════════════════════════════ */

// Calendar, Drive files, Contacts. Kept in sync with SCOPES in src/App.jsx.
// NO youtube scope: the app uploads to Drive now, and Google rejects
// youtube + drive.file together ("scopes that cannot be requested together",
// Error 400: invalid_request), which was blocking the sign-in redirect.
const SCOPES =
  "https://www.googleapis.com/auth/calendar " +
  "https://www.googleapis.com/auth/drive.file " +
  "https://www.googleapis.com/auth/contacts";

export default async (req) => {
  const url = new URL(req.url);
  const origin = url.origin;
  const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response("Server misconfigured: missing VITE_GOOGLE_CLIENT_ID", { status: 500 });
  }

  const state = crypto.randomUUID();
  const redirectUri = `${origin}/api/oauth/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline"); // → refresh token
  authUrl.searchParams.set("prompt", "consent");       // force a refresh token even on re-consent
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  const headers = new Headers();
  // SameSite=Lax so the cookie rides along on the top-level GET redirect Google
  // sends back to /api/oauth/callback.
  headers.append(
    "Set-Cookie",
    `mts_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.set("Location", authUrl.toString());
  return new Response(null, { status: 302, headers });
};
