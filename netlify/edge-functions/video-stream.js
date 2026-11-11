/* ═══════════════════════════════════════════════════════════════════════════
   Video stream proxy — Edge Function
   ───────────────────────────────────────────────────────────────────────────
   The client-facing /watch/:id page needs a <video> src that actually
   streams bytes with Range support. Google Drive's user-facing links
   (/preview iframe, uc?export=download) are unreliable for this:
   - /preview shows "No preview available" for many webm/mp4 uploads
   - uc?export=download serves an HTML "can't scan for viruses" interstitial
     instead of raw bytes once a file is a few dozen MB

   The Drive API's files.get?alt=media endpoint has neither problem — it
   streams raw bytes and honors Range requests, same as a normal CDN. It
   just needs a server-side API key (never exposed to the browser) because
   it isn't part of the OAuth-only client surface. Files uploaded by the
   app are already shared "anyone with link", so the API key only ever
   reads files that are already public — it doesn't expand access.

   Edge Functions (not regular serverless Functions) because Lambda-style
   functions buffer the whole response in memory with a payload limit far
   below typical video sizes. Edge Functions stream the response straight
   through.
   ═══════════════════════════════════════════════════════════════════════════ */

import { isAllowedEmail } from "../lib/accounts.mjs";

// ── Only stream OUR videos ──────────────────────────────────────────────────
// This used to stream ANY publicly shared Drive file to anyone who had its id
// — an open proxy riding on our API key. Now a file must be a video, and when
// Drive says who owns it, the owner must be one of the app's approved accounts.
// Checked once per file and remembered for 10 minutes (a player makes many
// Range requests per viewing). If Drive can't be asked right now (rate limit,
// outage), the video plays anyway: a client's link mustn't break on a blip.
const verdicts = new Map();   // id -> { ok, at }
const VERDICT_MS = 10 * 60 * 1000;
const VIDEO_NAME = /\.(mp4|m4v|mov|webm|3gp)$/i;

async function isOurVideo(id, apiKey) {
  const hit = verdicts.get(id);
  if (hit && Date.now() - hit.at < VERDICT_MS) return hit.ok;
  let ok = true;
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=mimeType,name,owners(emailAddress)&key=${apiKey}`);
    if (r.status === 404) ok = false;
    else if (r.ok) {
      const m = await r.json();
      const isVideo = String(m.mimeType || "").startsWith("video/") || VIDEO_NAME.test(m.name || "");
      const owners = (m.owners || []).map(o => o.emailAddress).filter(Boolean);
      let ownerOk = true;
      if (owners.length) {
        ownerOk = false;
        for (const e of owners) if (await isAllowedEmail(e)) { ownerOk = true; break; }
      }
      ok = isVideo && ownerOk;
    }
  } catch { /* can't ask Drive right now: allow (see above) */ }
  verdicts.set(id, { ok, at: Date.now() });
  if (verdicts.size > 2000) verdicts.delete(verdicts.keys().next().value);
  return ok;
}

export default async (request) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return new Response("Missing or invalid id", { status: 400 });
  }

  const apiKey = Deno.env.get("GOOGLE_DRIVE_API_KEY");
  if (!apiKey) {
    return new Response("Server misconfigured: no GOOGLE_DRIVE_API_KEY", { status: 500 });
  }
  if (!(await isOurVideo(id, apiKey))) {
    return new Response("Not available", { status: 404 });
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${apiKey}`;
  const range = request.headers.get("range");

  const driveRes = await fetch(driveUrl, {
    headers: range ? { Range: range } : {},
  });

  if (!driveRes.ok && driveRes.status !== 206) {
    return new Response(`Drive returned ${driveRes.status}`, { status: driveRes.status === 404 ? 404 : 502 });
  }

  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = driveRes.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");

  return new Response(driveRes.body, { status: driveRes.status, headers });
};

export const config = { path: "/api/video-stream" };
