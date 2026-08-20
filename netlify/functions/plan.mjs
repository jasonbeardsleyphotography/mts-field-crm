/* ═══════════════════════════════════════════════════════════════════════════
   Shared site plan — create (authenticated) and read (public).
   ───────────────────────────────────────────────────────────────────────────
   POST /api/plan   → stores a plan, returns { id }. Requires a valid Google
                      access token, so this isn't an open write endpoint.
   GET  /api/plan?id=…  → returns the stored plan. NO auth: the whole point is
                      that a crew member can open the link with no login and no
                      app install.

   Plans are stored in Netlify Blobs (same mechanism as the OAuth sessions in
   oauth-callback.mjs / token.mjs) and never expire — a link Jason texts to a
   crew keeps working.
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";

const STORE = "mts-plans";
const MAX_BODY = 256 * 1024;              // plans are small: coords + labels + URLs
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

// Confirm the caller is a real signed-in user. Checked against Google rather
// than our own session cookie so it works for BOTH sign-in paths — the server
// session and the classic GIS popup (which sets no cookie).
async function callerIsAuthed(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return false;
  try {
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`
    );
    if (!r.ok) return false;
    const info = await r.json();
    return !!(info && (info.sub || info.email) && !info.error);
  } catch {
    return false;
  }
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
    try {
      const raw = await getStore(STORE).get(id);
      if (!raw) return json({ error: "not_found" }, 404);
      return new Response(raw, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Safe to cache: a plan is immutable once created.
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      return json({ error: "store_error" }, 500);
    }
  }

  if (req.method === "POST") {
    if (!(await callerIsAuthed(req))) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: "bad_json" }, 400);
    }
    if (!body || !Array.isArray(body.pins) || body.pins.length === 0) {
      return json({ error: "no_pins" }, 400);
    }

    // Short id, and constrained to the same charset the /plan/:id route accepts.
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    try {
      await getStore(STORE).set(id, JSON.stringify({ ...body, createdAt: Date.now() }));
    } catch {
      return json({ error: "store_failed" }, 500);
    }
    return json({ id }, 200, { "Cache-Control": "no-store" });
  }

  return json({ error: "method_not_allowed" }, 405);
};
