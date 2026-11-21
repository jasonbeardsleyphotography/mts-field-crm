/* ═══════════════════════════════════════════════════════════════════════════
   Read a soil / leaf lab report PDF with AI — Edge Function
   ───────────────────────────────────────────────────────────────────────────
   POST /api/soil-extract   body: the PDF (application/pdf)   (Soil admins only)
   Sends the PDF to Gemini (the model the app's other AI uses) and asks for the
   lab's values as JSON. Nothing is saved here: the page shows the values for
   the owner to check and correct, and only saves after that.
   Streamed one JSON object per line (progress, then {"result"} or {"error"}),
   like the video summary, so it can take as long as the AI needs — a regular
   function would be cut off after ~10 seconds.
   Who may call it is checked by asking /api/soil/me with the caller's cookies
   (edge functions don't read the session store directly).
   ═══════════════════════════════════════════════════════════════════════════ */

const GEMINI = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-2.5-flash";
const MAX_BYTES = 6 * 1024 * 1024;
const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? Deno.env.get(k) ?? "";
const jsonRes = (o, status) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const PROMPT = `This PDF is a soil test or plant tissue (leaf) test report from a laboratory, for a tree care company.
Read it carefully and return ONLY JSON in exactly this shape. Copy numbers exactly as printed; never guess or
calculate a value that isn't printed. Use null for anything not on the report.
{
  "lab": "laboratory name",
  "type": "S" for a soil test or "F" for a leaf/plant tissue test,
  "method": "extraction method as printed, e.g. Modified Morgan, Mehlich 3, Morgan, Leaf tissue analysis",
  "sampled": "YYYY-MM-DD or null", "received": "YYYY-MM-DD or null", "reported": "YYYY-MM-DD or null",
  "order": "order / report number or null",
  "samples": [ {
    "label": "the sample ID as printed",
    "labNumber": "lab number for this sample or null",
    "location": "area / field / plant described for this sample, or null",
    "values": { "<key>": number },
    "units":  { "<key>": "unit as printed, e.g. ppm, lbs/acre, %, meq/100g" },
    "ranges": { "<key>": [low or null, high or null] },
    "ratings": { "<key>": "the lab's own word for this value if printed, e.g. Low, Optimum, Above Optimum" },
    "valueNotes": { "<key>": "only when the value is printed with < or >, e.g. less than 0.8" },
    "recommendations": "the lab's fertilizer / lime recommendations for this sample, as plain text, or null",
    "comment": "the lab's written comments for this sample, or null"
  } ]
}
Use these keys where they apply: ph (soil pH), bph (buffer pH), om (organic matter), P, K, Ca, Mg, S, B, Mn, Zn, Cu, Fe,
Al, Pb, Na, N (nitrogen), no3 (nitrate-N), salts (soluble salts), cec (cation exchange capacity), exacid (exchangeable
acidity), ca_bs, mg_bs, k_bs, h_bs (base saturation %). Put each sample in the report in its own entry.`;

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });

  // Soil admins only (checked by the regular Soil API, with the caller's cookies).
  let me = null;
  try {
    const r = await fetch(new URL("/api/soil/me", request.url), { headers: { cookie: request.headers.get("cookie") || "" } });
    if (r.ok) me = await r.json();
  } catch {}
  if (!me?.perms?.admin) return jsonRes({ error: "Only an admin can add soil tests." }, 403);

  const key = env("GEMINI_API_KEY") || env("VITE_GEMINI_KEY");
  if (!key) return jsonRes({ error: "The AI key isn't set up on the server." }, 500);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) return jsonRes({ error: "That PDF is too big (over 6 MB)." }, 413);
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return jsonRes({ error: "That file isn't a PDF." }, 400);

  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (o) => w.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {});

  (async () => {
    try {
      await send({ step: "The AI is reading the report…" });
      const gen = await fetch(`${GEMINI}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: "application/pdf", data: b64(bytes) } }, { text: PROMPT }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      });
      if (!gen.ok || !gen.body) throw new Error(`The AI couldn't read it (${gen.status}).`);
      const reader = gen.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "", text = "", last = Date.now();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          try { text += JSON.parse(line.slice(5))?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || ""; } catch {}
        }
        if (Date.now() - last > 4000) { last = Date.now(); await send({ step: "The AI is reading the report…" }); }
      }
      let result;
      try { result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new Error("The AI's answer couldn't be read. Try again."); }
      if (!Array.isArray(result?.samples) || !result.samples.length) throw new Error("No samples were found in that report.");
      await send({ result });
    } catch (e) {
      await send({ error: e?.message || String(e) });
    } finally {
      try { await w.close(); } catch {}
    }
  })();

  return new Response(readable, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-robots-tag": "noindex" } });
};
