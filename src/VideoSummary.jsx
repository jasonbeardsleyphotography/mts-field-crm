import { useState, useRef, useEffect } from "react";
import { flog } from "./freezeLog";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — AI summary of one card video
   ───────────────────────────────────────────────────────────────────────────
   Shown under each video that has finished uploading to Drive. Tapping it asks
   the server (/api/video-summary, an edge function) to hand the video from
   Drive to Gemini and stream back a summary built for an estimate: what the
   client wants, work items, concerns, access, follow-ups and a transcript.
   The result is saved on the card (and so syncs to other devices).
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

function freshToken(fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem("mts-token") || "null");
    if (saved?.token && saved.expiry > Date.now()) return saved.token;
  } catch {}
  return fallback;
}

/** Plain text of a summary, for pasting into scope notes. */
export function summaryAsText(r) {
  if (!r) return "";
  const out = [];
  if (r.summary) out.push(r.summary);
  const list = (title, arr, fmt = (x) => x) => {
    if (Array.isArray(arr) && arr.length) out.push(`${title}:\n` + arr.map(x => `• ${fmt(x)}`).join("\n"));
  };
  list("Work", r.workItems, (w) => [w.work, w.tree, w.where && `(${w.where})`, w.notes && `— ${w.notes}`].filter(Boolean).join(" "));
  list("Client concerns", r.clientConcerns);
  list("Access", r.access);
  list("Follow up", r.followUps);
  return out.join("\n\n");
}

export default function VideoSummary({ fileId, client, token, saved, onSave, onAddToNotes }) {
  const [phase, setPhase] = useState(saved ? "done" : "idle");   // idle | running | done | error
  const [step, setStep] = useState("");
  const [result, setResult] = useState(saved || null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [added, setAdded] = useState(false);
  const abortRef = useRef(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { if (saved && phase !== "running") { setResult(saved); setPhase("done"); } }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setPhase("running"); setError(""); setStep("Starting…"); setOpen(true); setAdded(false);
    flog("ai: video summary started", fileId);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await fetch("/api/video-summary", {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${freshToken(token)}` },
        body: JSON.stringify({ fileId, client }),
      });
      if (!res.ok || !res.body) {
        let msg = `Server error ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "", final = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.step) setStep(m.step);
          if (m.error) throw new Error(m.error);
          if (m.result) final = m.result;
        }
      }
      if (!final) throw new Error("The summary didn't come back — check your signal and try again.");
      const r = { ...final, at: Date.now() };
      setResult(r); setPhase("done");
      flog("ai: video summary done", fileId);
      onSave?.(r);
    } catch (e) {
      if (e?.name === "AbortError") return;
      setError(e?.message || String(e)); setPhase("error");
      flog("ai: video summary failed", `${fileId} ${e?.message || e}`);
    }
  };

  const btn = (accent) => ({
    padding: "7px 10px", borderRadius: 7, background: `${accent}1f`, border: `1px solid ${accent}66`,
    color: accent, fontSize: 11, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
    textTransform: "uppercase", cursor: "pointer", whiteSpace: "nowrap",
  });
  const sec = (title, items) => Array.isArray(items) && items.length > 0 && (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "#95a5bb", fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>{title}</div>
      {items.map((x, i) => <div key={i} style={{ fontSize: 12.5, color: "#d4e1f0", lineHeight: 1.45, marginTop: 2 }}>• {x}</div>)}
    </div>
  );

  return (
    <div style={{ padding: "6px 8px 8px", borderTop: "1px solid #1a2540" }}>
      {phase === "idle" && (
        <button onClick={run} style={{ ...btn("#B39DDB"), width: "100%", padding: "9px 0" }}>✨ AI summary of this video</button>
      )}
      {phase === "running" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, fontSize: 12, color: "#c9b8ec", lineHeight: 1.4 }}>
            {step} <span style={{ color: "#8a9ab0" }}>Usually 1–2 minutes. Keep the app open.</span>
          </div>
          <button onClick={() => { abortRef.current?.abort(); setPhase(result ? "done" : "idle"); }} style={btn("#8aa0c0")}>Cancel</button>
        </div>
      )}
      {phase === "error" && (
        <div>
          <div style={{ fontSize: 12, color: "#ff9a9a", lineHeight: 1.4 }}>Couldn't summarize: {error}</div>
          <button onClick={run} style={{ ...btn("#B39DDB"), marginTop: 6 }}>Try again</button>
        </div>
      )}
      {phase === "done" && result && (
        <div>
          <button onClick={() => setOpen(o => !o)} style={{ ...btn("#B39DDB"), width: "100%", padding: "8px 0", display: "flex", justifyContent: "center", gap: 6 }}>
            ✨ AI summary {open ? "▴" : "▾"}
          </button>
          {open && (
            <div style={{ marginTop: 8 }}>
              {result.summary && <div style={{ fontSize: 13, color: "#e6ecf5", lineHeight: 1.5 }}>{result.summary}</div>}
              {sec("Work", (result.workItems || []).map(w => [w.work, w.tree, w.where && `(${w.where})`, w.notes && `— ${w.notes}`].filter(Boolean).join(" ")))}
              {sec("Client concerns", result.clientConcerns)}
              {sec("Access", result.access)}
              {sec("Follow up", result.followUps)}
              {result.transcript && (
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => setShowTranscript(t => !t)} style={{ background: "none", border: "none", padding: 0, color: "#8aa0c0", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>
                    {showTranscript ? "Hide transcript ▴" : "Show transcript ▾"}
                  </button>
                  {showTranscript && <div style={{ marginTop: 6, fontSize: 12, color: "#aab9cd", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{result.transcript}</div>}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button onClick={() => { onAddToNotes?.(summaryAsText(result)); setAdded(true); }} disabled={added}
                  style={{ ...btn("#10B981"), flex: 1, opacity: added ? 0.6 : 1 }}>{added ? "Added to scope notes ✓" : "Add to scope notes"}</button>
                <button onClick={run} style={btn("#8aa0c0")}>Redo</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
