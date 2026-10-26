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
import { authorizeRequest } from "../lib/accounts.mjs";

const STORE = "mts-plans";
const MAX_BODY = 256 * 1024;              // plans are small: coords + labels + URLs
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

// Only an approved, signed-in user may create a plan. (Reading one stays
// public — that is what a crew link is for.) The old check accepted ANY valid
// Google token, from any account and any app.
async function callerIsAuthed(req) {
  return (await authorizeRequest(req, getStore)).ok;
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

    // The app now picks the id itself, so it can copy the finished link the
    // instant the button is tapped — iOS only allows a copy during the tap, and
    // waiting for this server round trip was why the link often wasn't copied.
    // A client-chosen id must be long enough to be unguessable (16+ characters
    // of the same charset the /plan/:id route accepts) and must not already
    // exist: an existing plan is never overwritten.
    const { id: wanted, ...plan } = body;
    const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{16,40}$/;
    let id;
    const store = getStore(STORE);
    if (wanted !== undefined) {
      if (typeof wanted !== "string" || !CLIENT_ID_RE.test(wanted)) return json({ error: "bad_id" }, 400);
      try {
        if (await store.get(wanted)) return json({ error: "id_taken" }, 409);
      } catch {
        return json({ error: "store_error" }, 500);
      }
      id = wanted;
    } else {
      // Older app versions don't send one. 20 hex characters = 80 bits.
      id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    }
    try {
      await store.set(id, JSON.stringify({ ...plan, createdAt: Date.now() }));
    } catch {
      return json({ error: "store_failed" }, 500);
    }
    return json({ id }, 200, { "Cache-Control": "no-store" });
  }

  return json({ error: "method_not_allowed" }, 405);
};
