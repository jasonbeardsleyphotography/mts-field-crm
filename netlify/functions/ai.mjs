/* ═══════════════════════════════════════════════════════════════════════════
   AI — the app's Gemini requests, made from the server.
   ───────────────────────────────────────────────────────────────────────────
   The Gemini API key used to be compiled into the public JavaScript, where
   anyone could read it out of the page and spend the account's quota (and the
   build was set to stop Netlify's secret scanner from warning about it). Now
   the key stays on the server: the app sends its prompt here, and only
   approved, signed-in users get an answer.

   Reads the same environment variable the app was already built with, so no
   new setup is needed. (Rotating the key is still recommended — the old one
   was public for as long as it was in the page.)
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { authorizeRequest } from "../lib/accounts.mjs";

const MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_PROMPT = 60 * 1024;   // the app's prompts are notes-sized

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorizeRequest(req, getStore)).ok) return json({ error: "unauthorized" }, 401);

  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_KEY;
  if (!key) return json({ error: "not_configured" }, 500);

  let prompt;
  try {
    const text = await req.text();
    if (text.length > MAX_PROMPT + 1024) return json({ error: "too_large" }, 413);
    prompt = JSON.parse(text)?.prompt;
  } catch { return json({ error: "bad_json" }, 400); }
  if (typeof prompt !== "string" || !prompt.trim()) return json({ error: "no_prompt" }, 400);
  if (prompt.length > MAX_PROMPT) return json({ error: "too_large" }, 413);

  try {
    const r = await fetch(`${MODEL_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
    return json({ text: d?.candidates?.[0]?.content?.parts?.[0]?.text || "" });
  } catch {
    return json({ error: "upstream_network" }, 502);
  }
};
