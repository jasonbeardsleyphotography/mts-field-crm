import { useState } from "react";
import {
  DEFAULT_SHORTCUT_NAME, getShortcutName, setShortcutName,
  isShortcutReady, setShortcutReady, testShortcut,
} from "./realwork";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Set up "open the RealWork app" (one time, about a minute)
   ───────────────────────────────────────────────────────────────────────────
   A web page can't open another app directly. It can run an iPhone Shortcut,
   and a Shortcut can open an app — so this walks through making that Shortcut,
   tests it, and only turns it on once the user says it worked.

   It has to be a SHORTCUT, not an Automation: an Automation runs on a trigger
   (a time, a place) and can't be started from a button. The two live on
   different tabs of the Shortcuts app, which is the easy thing to get wrong.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function RealWorkSetup({ onChange }) {
  const [ready, setReady] = useState(isShortcutReady());
  const [tested, setTested] = useState(false);
  const [name, setName] = useState(getShortcutName());

  const apply = (on) => { setShortcutReady(on); setReady(on); onChange?.(on); };
  const saveName = (v) => { setName(v); setShortcutName(v); };

  const btn = (accent, solid = false) => ({
    display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
    padding: "13px 0", borderRadius: 10, cursor: "pointer", boxSizing: "border-box",
    background: solid ? accent : `${accent}22`, border: `1px solid ${solid ? accent : accent + "88"}`,
    color: solid ? "#04140d" : accent, fontSize: 13, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.5, textTransform: "uppercase",
  });
  const step = (n, children) => (
    <div style={{ display: "flex", gap: 10, padding: "9px 0", borderBottom: "1px solid #141a28" }}>
      <span style={{
        width: 22, height: 22, borderRadius: 11, flexShrink: 0, background: "#1a2540",
        color: "#7db4ff", fontSize: 12, fontWeight: 800, fontFamily: F,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>{n}</span>
      <span style={{ fontSize: 13, color: "#cfd8e6", lineHeight: 1.55 }}>{children}</span>
    </div>
  );
  const b = (t) => <b style={{ color: "#fff" }}>{t}</b>;
  const hint = (children) => (
    <div style={{ fontSize: 12, color: "#8aa0c0", lineHeight: 1.5, marginTop: 4 }}>{children}</div>
  );

  const nameField = (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#4a5a70", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 4 }}>
        Name of your Shortcut
      </div>
      <input
        value={name}
        onChange={e => saveName(e.target.value)}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{
          width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
          background: "#141a29", border: "1px solid #253049", color: "#e6ecf5", fontSize: 14,
        }}
      />
      {hint(<>Must match the name in the Shortcuts app exactly. Normally {b(DEFAULT_SHORTCUT_NAME)}.</>)}
    </div>
  );

  if (ready) {
    return (
      <div>
        <div style={{
          padding: "10px 12px", borderRadius: 9, marginBottom: 12,
          background: "rgba(16,185,129,.12)", border: "1px solid rgba(16,185,129,.4)",
          color: "#a8dca0", fontSize: 12.5, lineHeight: 1.5,
        }}>
          On. RealWork opens the app, not the browser. The Shortcuts app flashes up
          for a moment on the way — that's normal.
        </div>
        <button onClick={testShortcut} style={btn("#7db4ff")}>Test it</button>
        {nameField}
        <button onClick={() => apply(false)} style={{ ...btn("#5a6580"), marginTop: 12 }}>
          Switch back to the browser
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        padding: "10px 12px", borderRadius: 9, marginBottom: 10,
        background: "rgba(246,191,38,.1)", border: "1px solid rgba(246,191,38,.35)",
        color: "#f0d58a", fontSize: 12.5, lineHeight: 1.5,
      }}>
        You need a <b>Shortcut</b>, not an <b>Automation</b>. Automations run on a
        trigger (a time, a place) and can't be started from a button. Ignore the
        Automation tab.
      </div>

      {step(1, <>Open the {b("Shortcuts")} app. If you can't find it, swipe down on your Home Screen and type {b("Shortcuts")}.</>)}
      {step(2, <>Along the bottom you'll see tabs. Tap {b("Shortcuts")} — {b("not")} Automation. {hint("You should see tiles for any shortcuts you already have, or an empty page.")}</>)}
      {step(3, <>Tap the {b("+")} at the top right. {hint(<>A blank shortcut opens, titled “New Shortcut”.</>)}</>)}
      {step(4, <>Tap {b("Add Action")}. {hint("On some versions this is a search box at the bottom that says “Search Actions”. Either way, you want to search for an action.")}</>)}
      {step(5, <>Type {b("Open App")} and tap the result called {b("Open App")}. {hint("Not “Open URL” or “Open Apps”.")}</>)}
      {step(6, <>The action now reads “Open <span style={{ color: "#4c9aff" }}>App</span>”. Tap the blue {b("App")} and choose {b("RealWork")} from the list.</>)}
      {step(7, <>Name it: tap {b("New Shortcut")} at the top (or the small arrow next to it), tap {b("Rename")}, and type {b(DEFAULT_SHORTCUT_NAME)}.</>)}
      {step(8, <>Tap {b("Done")}. You should now see a tile called “{DEFAULT_SHORTCUT_NAME}” on the Shortcuts tab.</>)}
      {step(9, <>{b("Check it works on its own:")} tap that tile once. The RealWork app should open. If it does, come back here. {hint("If it doesn't, the Shortcut isn't set up right yet — nothing in MTS Field will fix that.")}</>)}

      {nameField}

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => { setTested(true); testShortcut(); }} style={btn("#7db4ff")}>
          Test it from here
        </button>
        {tested && (
          <>
            <div style={{ fontSize: 12, color: "#8aa0c0", lineHeight: 1.5 }}>
              Did the RealWork app open? If you came back to this screen, tell me below.
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
