import { useState } from "react";
import {
  DEFAULT_SHORTCUT_NAME, getShortcutName, setShortcutName,
  isShortcutReady, setShortcutReady, testShortcut,
  DEFAULT_SEND_NAME, getSendName, setSendName, isSendReady, setSendReady, runSendShortcut,
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

function OpenRealWorkSetup({ onChange }) {
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
    <div style={{ fontSize: 12, color: "#9aadc8", lineHeight: 1.5, marginTop: 4 }}>{children}</div>
  );

  const nameField = (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#607591", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 4 }}>
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
            <div style={{ fontSize: 12, color: "#9aadc8", lineHeight: 1.5 }}>
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


/* ── Section 2: send a photo automatically after Done ─────────────────────────
   A second Shortcut, "Send to RealWork", that saves the photo it's given to
   Photos and then opens RealWork. When it's on, Done copies the visit's first
   photo and runs it: no picker, no share sheet. */

// A small labelled picture for the test, so the test doesn't need a real job
// photo. It does land in Photos — the screen says so.
function makeTestPng() {
  const c = document.createElement("canvas");
  c.width = 600; c.height = 360;
  const g = c.getContext("2d");
  g.fillStyle = "#0e1220"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#F6BF26"; g.font = "bold 40px sans-serif"; g.textAlign = "center";
  g.fillText("MTS Field test photo", c.width / 2, c.height / 2 - 10);
  g.fillStyle = "#8aa0c0"; g.font = "24px sans-serif";
  g.fillText("Safe to delete", c.width / 2, c.height / 2 + 34);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("png"))), "image/png"));
}

function SendToRealWorkSetup() {
  const [on, setOn] = useState(isSendReady());
  const [name, setName] = useState(getSendName());
  const [tested, setTested] = useState(false);
  const [msg, setMsg] = useState(null);

  const toggle = (v) => { setSendReady(v); setOn(v); };
  const saveName = (v) => { setName(v); setSendName(v); };

  const test = () => {
    setMsg(null);
    // Claim the copy inside this tap; the picture is filled in a moment later.
    let write;
    try {
      write = navigator.clipboard.write([new ClipboardItem({ "image/png": makeTestPng() })]);
    } catch {
      setMsg("This browser can't copy pictures, so this won't work here.");
      return;
    }
    write.then(
      () => { setTested(true); runSendShortcut(); },
      () => setMsg("Couldn't copy the test picture. Try again."),
    );
  };

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
      <div style={{ fontSize: 11, fontWeight: 800, color: "#607591", fontFamily: F, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 4 }}>
        Name of this Shortcut
      </div>
      <input value={name} onChange={e => saveName(e.target.value)}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 8,
                 background: "#141a29", border: "1px solid #253049", color: "#e6ecf5", fontSize: 14 }} />
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", fontFamily: F, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6 }}>
        Send a photo after Done
      </div>
      {on ? (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: 9, marginBottom: 12,
            background: "rgba(16,185,129,.12)", border: "1px solid rgba(16,185,129,.4)",
            color: "#a8dca0", fontSize: 12.5, lineHeight: 1.5,
          }}>
            On. When you tap Done on a visit with photos, its first photo goes to your
            Photos and RealWork opens — the photo is first in RealWork's picker. Visits
            with no photos just open RealWork.
          </div>
          {nameField}
          <button onClick={() => toggle(false)} style={{ ...btn("#5a6580"), marginTop: 12 }}>Turn off</button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: "#9aadc8", lineHeight: 1.55, marginBottom: 4 }}>
            Optional. Skips the photo picker after Done: the first photo is sent
            automatically. Needs a second Shortcut, built from the one you already have:
          </div>
          {step(1, <>In the Shortcuts app, press and hold your {b(DEFAULT_SHORTCUT_NAME)} tile and tap {b("Duplicate")}.</>)}
          {step(2, <>Open the copy, tap its name at the top, tap {b("Rename")}, and type {b(DEFAULT_SEND_NAME)}.</>)}
          {step(3, <>The first block should read {b("Receive Images from Share Sheet")}. If it doesn't, tap the {b("ⓘ")} button, turn on {b("Show in Share Sheet")}, and set the types to {b("Images")} only.</>)}
          {step(4, <>Under “If there's no input”, tap the blue word and choose {b("Get Clipboard")}, if it's offered.</>)}
          {step(5, <>Below that it needs, in order: {b("Save Shortcut Input to Recents")}, then {b("Open RealWork")}. Add a missing one by typing its name into the search bar at the bottom.</>)}
          {step(6, <>Go back to {b(DEFAULT_SHORTCUT_NAME)} and make sure it contains only {b("Open RealWork")} — remove any Receive or Save blocks from it.</>)}
          {step(7, <>In the iPhone {b("Settings")} app: {b("Apps")} → {b("Shortcuts")} → {b("Paste from Other Apps")} → {b("Allow")}. Otherwise iOS asks permission every time.</>)}
          {nameField}
          {msg && <div style={{ marginTop: 10, fontSize: 12, color: "#ff9a9a" }}>{msg}</div>}
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={test} style={btn("#7db4ff")}>Test it from here</button>
            <div style={{ fontSize: 11.5, color: "#818c9d", lineHeight: 1.45 }}>
              The test saves a small “MTS Field test photo” picture to your Photos and
              opens RealWork. Delete the picture afterwards.
            </div>
            {tested && (
              <button onClick={() => toggle(true)} style={btn("#10B981", true)}>
                It worked — use it after Done
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Both RealWork setups, one after the other. */
export default function RealWorkSetup({ onChange }) {
  return (
    <div>
      <OpenRealWorkSetup onChange={onChange} />
      <div style={{ height: 1, background: "#1a2030", margin: "22px 0 18px" }} />
      <SendToRealWorkSetup />
    </div>
  );
}
