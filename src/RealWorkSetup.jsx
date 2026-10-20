import { useState } from "react";
import {
  REALWORK_SHORTCUT_NAME, isShortcutReady, setShortcutReady, testShortcut,
} from "./realwork";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Set up "open the RealWork app" (one time, about a minute)
   ───────────────────────────────────────────────────────────────────────────
   A web page can't open another app directly. It can run an iPhone Shortcut,
   and a Shortcut can open an app — so this walks through making that Shortcut,
   tests it, and only turns it on once the user says it worked.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function RealWorkSetup({ onChange }) {
  const [ready, setReady] = useState(isShortcutReady());
  const [tested, setTested] = useState(false);

  const apply = (on) => { setShortcutReady(on); setReady(on); onChange?.(on); };

  const btn = (accent, solid = false) => ({
    display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
    padding: "13px 0", borderRadius: 10, cursor: "pointer", boxSizing: "border-box",
    background: solid ? accent : `${accent}22`, border: `1px solid ${solid ? accent : accent + "88"}`,
    color: solid ? "#04140d" : accent, fontSize: 13, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.5, textTransform: "uppercase",
  });
  const step = (n, children) => (
    <div style={{ display: "flex", gap: 10, padding: "8px 0" }}>
      <span style={{
        width: 22, height: 22, borderRadius: 11, flexShrink: 0, background: "#1a2540",
        color: "#7db4ff", fontSize: 12, fontWeight: 800, fontFamily: F,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>{n}</span>
      <span style={{ fontSize: 13, color: "#cfd8e6", lineHeight: 1.5 }}>{children}</span>
    </div>
  );
  const b = (t) => <b style={{ color: "#fff" }}>{t}</b>;

  if (ready) {
    return (
      <div>
        <div style={{
          padding: "10px 12px", borderRadius: 9, marginBottom: 12,
          background: "rgba(16,185,129,.12)", border: "1px solid rgba(16,185,129,.4)",
          color: "#a8dca0", fontSize: 12.5, lineHeight: 1.5,
        }}>
          On. RealWork opens the app, not the browser. Shortcuts will flash up for a
          moment on the way — that's normal.
        </div>
        <button onClick={testShortcut} style={btn("#7db4ff")}>Test it</button>
        <button onClick={() => apply(false)} style={{ ...btn("#5a6580"), marginTop: 8 }}>
          Switch back to the browser
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#8aa0c0", lineHeight: 1.55, marginBottom: 6 }}>
        Right now RealWork opens in the browser. To open the app instead, make a
        one-step Shortcut on your iPhone:
      </div>
      {step(1, <>Open the {b("Shortcuts")} app (it's built in) and tap {b("+")}.</>)}
      {step(2, <>Tap {b("Add Action")}, search {b("Open App")}, and choose it.</>)}
      {step(3, <>Tap the blue {b("App")} word and pick {b("RealWork")}.</>)}
      {step(4, <>Tap the title at the top and name it exactly {b(REALWORK_SHORTCUT_NAME)}, then tap {b("Done")}.</>)}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => { setTested(true); testShortcut(); }} style={btn("#7db4ff")}>
          Test it
        </button>
        {tested && (
          <>
            <div style={{ fontSize: 12, color: "#8aa0c0", lineHeight: 1.5 }}>
              Did the RealWork app open? Come back here and tell me.
            </div>
            <button onClick={() => apply(true)} style={btn("#10B981", true)}>
              Yes — use it
            </button>
          </>
        )}
      </div>
    </div>
  );
}
