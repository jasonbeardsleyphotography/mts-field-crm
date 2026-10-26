import { useState } from "react";
import {
  DEFAULT_IPHONE_VIDEO_NAME, getIphoneVideoName, setIphoneVideoName,
  isIphoneVideoReady, setIphoneVideoReady, runIphoneVideo,
} from "./iphoneVideo";

/* One-time setup for the iPhone Video button: make a Shortcut that opens the
   Camera app in Video mode, test it, turn it on. */

const F = "'Oswald',sans-serif";

export default function IphoneVideoSetup({ onReady }) {
  const [on, setOn] = useState(isIphoneVideoReady());
  const [name, setName] = useState(getIphoneVideoName());
  const [tested, setTested] = useState(false);

  const toggle = (v) => { setIphoneVideoReady(v); setOn(v); if (v) onReady?.(); };
  const saveName = (v) => { setName(v); setIphoneVideoName(v); };

  const btn = (accent, solid = false) => ({
    display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
    padding: "13px 0", borderRadius: 10, cursor: "pointer", boxSizing: "border-box",
    background: solid ? accent : `${accent}22`, border: `1px solid ${solid ? accent : accent + "88"}`,
    color: solid ? "#04140d" : accent, fontSize: 13, fontWeight: 800, fontFamily: F,
    letterSpacing: 0.5, textTransform: "uppercase",
  });
  const b = (t) => <b style={{ color: "#fff" }}>{t}</b>;
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
  const nameField = (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#7d8fa8", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 4 }}>
        Name of the Shortcut
      </div>
      <input value={name} onChange={e => saveName(e.target.value)}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
                 background: "#141a29", border: "1px solid #253049", color: "#e6ecf5", fontSize: 14 }} />
    </div>
  );

  if (on) {
    return (
      <div>
        <div style={{
          padding: "10px 12px", borderRadius: 9, marginBottom: 12,
          background: "rgba(16,185,129,.12)", border: "1px solid rgba(16,185,129,.4)",
          color: "#a8dca0", fontSize: 12.5, lineHeight: 1.5,
        }}>
          On. iPhone Video copies the client's address, notes the time on the card, and
          opens the Camera app in Video mode.
        </div>
        {nameField}
        <button onClick={() => toggle(false)} style={{ ...btn("#5a6580"), marginTop: 12 }}>Turn off</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#9fb0c6", lineHeight: 1.55, marginBottom: 4 }}>
        A web app can't open the Camera app by itself, but a Shortcut can — and it can
        choose Video mode. One-time setup, about a minute:
      </div>
      {step(1, <>Open the {b("Shortcuts")} app and tap {b("+")}. If it opens to “Describe a Shortcut”, you can type {b("Open the Camera in Video mode")} instead and skip to step 4 — or switch to editing it yourself.</>)}
      {step(2, <>In the search bar at the bottom, type {b("Open Camera")} and tap that action.</>)}
      {step(3, <>The action names a mode in blue (usually {b("Photo")}). Tap it and choose {b("Video")}.</>)}
      {step(4, <>Tap the name at the top, tap {b("Rename")}, type {b(DEFAULT_IPHONE_VIDEO_NAME)}, then tap {b("Done")}.</>)}
      {step(5, <>{b("Check it on its own:")} tap the new tile once. The Camera app should open, already in Video mode.</>)}
      {nameField}
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => { setTested(true); runIphoneVideo(); }} style={btn("#7db4ff")}>Test it from here</button>
        {tested && (
          <button onClick={() => toggle(true)} style={btn("#10B981", true)}>It worked — use it</button>
        )}
      </div>
    </div>
  );
}
