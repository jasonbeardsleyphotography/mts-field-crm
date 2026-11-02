/* ═══════════════════════════════════════════════════════════════════════════
   AI summary of a card video — Edge Function
   ───────────────────────────────────────────────────────────────────────────
   POST /api/video-summary  { fileId, client }   (Authorization: Bearer <Google token>)

   1. Checks the caller is an approved account (same list as the server).
   2. Fetches the video from the caller's Google Drive (their own token).
   3. Uploads it to Gemini's file store, waits until Gemini has processed it.
   4. Asks Gemini (the same model the app's other AI uses) for a summary built
      for a tree-service estimate, and returns it.
   5. Deletes the uploaded copy from Gemini.

   The response is streamed as one JSON object per line — progress steps, then
   {"result": …} or {"error": …} — so the card can show where it's up to, and
   so the request can run for as long as Gemini takes (an edge function can keep
   streaming; a regular function would time out after a few seconds).
   Nothing here is stored server-side; the app saves the result on the card.
   ═══════════════════════════════════════════════════════════════════════════ */

import { emailForToken, isAllowedEmail } from "../lib/accounts.mjs";

const GEMINI = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-2.5-flash";
const MAX_BYTES = 400 * 1024 * 1024;   // ~an hour of phone video at the app's bitrate

const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? Deno.env.get(k) ?? "";

const PROMPT = `You are helping an estimator for Monster Tree Service of Rochester (a tree care company).
This video was recorded at a client's property during an estimate visit. Use everything that is SAID
in the video (the estimator and the client talking) and what is visible. Do not invent anything that
isn't in the video. Return ONLY JSON with exactly these fields:
{
  "summary": "2-4 plain sentences: what the client wants done and the main points discussed",
  "workItems": [ { "work": "e.g. Remove / Prune / Crown raise / Stump grind / Cable", "tree": "species or description", "where": "location on the property", "notes": "size, condition, hazards, debris/cleanup wishes" } ],
  "clientConcerns": [ "things the client is worried about or asked for" ],
  "access": [ "access and obstacles: fences, gates, wires, structures, driveway, slope, neighbors" ],
  "followUps": [ "things to price, check or confirm before quoting" ],
  "transcript": "a clean transcript of the speech, with speaker changes on new lines; empty string if nobody speaks"
}
Use empty arrays when there is nothing for a field. If there is no speech, say so in the summary.`;

function mimeFor(m, name) {
  m = String(m || "").toLowerCase();
  if (m === "video/quicktime") return "video/mov";
  if (m.startsWith("video/")) return m;
  if (/\.webm$/i.test(name || "")) return "video/webm";
  if (/\.mov$/i.test(name || "")) return "video/mov";
  return "video/mp4";
}

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const email = token ? await emailForToken(token) : null;
  if (!email || !(await isAllowedEmail(email))) {
    return new Response(JSON.stringify({ error: "Not signed in with an approved account." }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const key = env("GEMINI_API_KEY") || env("VITE_GEMINI_KEY");
  if (!key) return new Response(JSON.stringify({ error: "The AI key isn't set up on the server." }), { status: 500, headers: { "content-type": "application/json" } });

  let body = {};
  try { body = await request.json(); } catch {}
  const fileId = String(body.fileId || "");
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) return new Response(JSON.stringify({ error: "Bad video id." }), { status: 400, headers: { "content-type": "application/json" } });
  const client = String(body.client || "").slice(0, 80);

  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o) => w.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});

  (async () => {
    let geminiFile = null;
    try {
      // 1. The video, from the caller's Drive.
      await send({ step: "Getting the video from Drive…" });
      const g = { headers: { Authorization: `Bearer ${token}` } };
      const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size`, g);
      if (!metaRes.ok) throw new Error(`Couldn't find the video in Drive (${metaRes.status}).`);
      const meta = await metaRes.json();
      const size = Number(meta.size || 0);
      if (size > MAX_BYTES) throw new Error("That video is too long to summarize (over ~400 MB).");
      const vidRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, g);
      if (!vidRes.ok) throw new Error(`Couldn't download the video from Drive (${vidRes.status}).`);
      const bytes = new Uint8Array(await vidRes.arrayBuffer());
      const mime = mimeFor(meta.mimeType, meta.name);

      // 2. Upload to Gemini's file store.
      await send({ step: "Sending it to the AI…" });
      const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
        method: "POST",
        headers: {
          "x-goog-api-key": key,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(bytes.length),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: `mts-${fileId}` } }),
      });
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!start.ok || !uploadUrl) throw new Error(`The AI didn't accept the upload (${start.status}).`);
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
        body: bytes,
      });
      const upJson = await up.json().catch(() => ({}));
      geminiFile = upJson?.file;
      if (!up.ok || !geminiFile?.name) throw new Error(`Upload to the AI failed (${up.status}).`);

      // 3. Wait for Gemini to finish processing the video.
      await send({ step: "The AI is watching the video…" });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (geminiFile.state !== "ACTIVE") {
        if (geminiFile.state === "FAILED") throw new Error("The AI couldn't read this video.");
        if (Date.now() > deadline) throw new Error("The AI took too long to process the video.");
        await new Promise((r) => setTimeout(r, 3000));
        await send({ step: "The AI is watching the video…" });
        const st = await fetch(`${GEMINI}/v1beta/${geminiFile.name}`, { headers: { "x-goog-api-key": key } });
        if (st.ok) geminiFile = await st.json();
      }

      // 4. Ask for the summary (streamed, so the connection never sits idle).
      await send({ step: "Writing the summary…" });
      const gen = await fetch(`${GEMINI}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { file_data: { mime_type: geminiFile.mimeType || mime, file_uri: geminiFile.uri } },
            { text: PROMPT + (client ? `\nThe client's name is ${client}.` : "") },
          ] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, mediaResolution: "MEDIA_RESOLUTION_LOW" },
        }),
      });
      if (!gen.ok || !gen.body) {
        const t = await gen.text().catch(() => "");
        throw new Error(`The AI returned an error (${gen.status}). ${t.slice(0, 160)}`);
      }
      const reader = gen.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "", text = "", lastPing = Date.now();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5));
            for (const p of j?.candidates?.[0]?.content?.parts || []) if (p.text) text += p.text;
          } catch {}
        }
        if (Date.now() - lastPing > 4000) { lastPing = Date.now(); await send({ step: "Writing the summary…" }); }
      }
      let result;
      try { result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
      catch { result = { summary: text.trim().slice(0, 4000), workItems: [], clientConcerns: [], access: [], followUps: [], transcript: "" }; }
      await send({ result });
    } catch (e) {
      await send({ error: e?.message || String(e) });
    } finally {
      if (geminiFile?.name) {
        try { await fetch(`${GEMINI}/v1beta/${geminiFile.name}`, { method: "DELETE", headers: { "x-goog-api-key": key } }); } catch {}
      }
      try { await w.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
};

export const config = { path: "/api/video-summary" };
