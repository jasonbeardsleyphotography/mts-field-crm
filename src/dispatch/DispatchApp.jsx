import { useState, useEffect, useCallback } from "react";
import { api } from "./api";
import { CSS } from "./theme";
import Admin from "./Admin.jsx";
import Backlog from "./Backlog.jsx";
import AppMenu from "./AppMenu.jsx";
import ShopBoard from "./shop/ShopBoard.jsx";
import Schedule from "./Schedule.jsx";
import QuickPick from "./QuickPick.jsx";
import { useHoursUnit, setHoursUnit } from "./hours";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS Dispatch — a separate tool on the field app's site (/dispatch).
   Sign-in: a one-time link the owner makes on the Admin tab (works for any
   email address), or the field app's Google sign-in on the same browser.
   ═══════════════════════════════════════════════════════════════════════════ */

const TABS = [
  { id: "shop", label: "Shop Board", need: "shop" },
  { id: "schedule", label: "Schedule", need: "dispatch" },
  { id: "backlog", label: "Backlog", need: "dispatch" },
  { id: "quick", label: "Quick pick", need: "dispatch" },
  { id: "admin", label: "Admin", need: "admin", hidden: true },   // opened from the ☰ menu
];

const LINK_ERRORS = {
  link_used_or_unknown: "That sign-in link has already been used (each link works once), or it was mistyped. Ask for a new one.",
  link_expired: "That sign-in link has expired. Ask for a new one.",
  no_access: "That account doesn't have access to Dispatch. Ask the owner to switch it on.",
};

export default function DispatchApp() {
  const unit = useHoursUnit();
  const [me, setMe] = useState(undefined);       // undefined = loading, null = signed out
  const [linkErr, setLinkErr] = useState("");
  const [tab, setTab] = useState(() => {
    if (/(^#|&)admin\b/.test(location.hash)) { history.replaceState(null, "", location.pathname); return "admin"; }
    try { const t = localStorage.getItem("mts-dispatch-tab"); return t && t !== "admin" ? t : "shop"; } catch { return "shop"; }
  });

  const loadMe = useCallback(async () => {
    try { setMe(await api("me")); } catch { setMe(null); }
  }, []);

  useEffect(() => {
    (async () => {
      const m = location.hash.match(/signin=([a-z0-9]+)/);
      if (m) {
        history.replaceState(null, "", location.pathname);   // the link is single-use; don't leave it in history
        try { await api("redeem", { method: "POST", body: { code: m[1] } }); }
        catch (e) { setLinkErr(LINK_ERRORS[e.code] || "That sign-in link didn't work. Ask for a new one."); }
      }
      loadMe();
    })();
  }, [loadMe]);

  const pick = (id) => { setTab(id); if (id !== "admin") { try { localStorage.setItem("mts-dispatch-tab", id); } catch {} } };
  const allowed = (t) => me?.perms?.[t.need] || me?.perms?.admin;
  const tabs = me ? TABS.filter(allowed) : [];
  const current = tabs.find((t) => t.id === tab) || tabs.find((t) => !t.soon);

  const signOut = async () => {
    try { await api("logout", { method: "POST" }); } catch {}
    loadMe();
  };

  if (me === undefined) return <div className="dx"><style>{CSS}</style><div className="gate hint">Opening Dispatch…</div></div>;

  if (!me) return (
    <div className="dx"><style>{CSS}</style>
      <div className="gate card">
        <h2>MTS Dispatch</h2>
        {linkErr && <p className="err">{linkErr}</p>}
        <p>Sign in one of two ways:</p>
        <p><b>With a sign-in link</b> — the owner sends you one. Open it on this device and you stay signed in.</p>
        <p><b>With your MTS Field app Google sign-in</b> — open the <a href="/" style={{ color: "#9cc4e4" }}>field app</a> in this
          browser, sign in, then come back to this page.</p>
      </div>
    </div>
  );

  return (
    <div className="dx">
      <style>{CSS}</style>
      <header className="hd">
        <div className="chev" />
        <div className="hd-in">
          <div className="brand st">Dispatch<small>MONSTER TREE SERVICE · ROCHESTER</small></div>
          <div className="tabs" role="tablist">
            {tabs.filter((t) => !t.hidden).map((t) => (
              <button key={t.id} className="tab st" role="tab" aria-selected={current?.id === t.id}
                      title={t.soon ? "Not built yet" : undefined} onClick={() => pick(t.id)}>
                {t.label}{t.soon ? " · soon" : ""}
              </button>
            ))}
          </div>
          <div className="spacer" />
          {current && current.id !== "shop" && current.id !== "admin" && (
            <div className="tabs" role="group" aria-label="Hours shown as" title="On-site hours (OSH) or sales hours (SH). 1 SH = 0.78 OSH. The workbook's hours are OSH.">
              {["OSH", "SH"].map((u) => <button key={u} className="tab st" aria-selected={unit === u} onClick={() => setHoursUnit(u)}>{u}</button>)}
            </div>
          )}
          <span className="who">{me.name || me.email}</span>
        </div>
      </header>
      {!current && (
        <div className="wrap hint" style={{ maxWidth: 640 }}>
          You're signed in as <b style={{ color: "#E7E2D6" }}>{me.email}</b>, which has no Dispatch tools switched on.
          Ask the owner to switch them on in Admin — or, if this is the wrong account, sign in to the field app with the right one.
        </div>
      )}
      {current?.soon && (
        <div className="wrap" style={{ maxWidth: 640 }}>
          <div className="card"><div className="card-b" style={{ display: "grid", gap: 10 }}>
            <div className="st" style={{ fontSize: 16 }}>{current.label} — not built yet</div>
            <div className="hint">This will be the Schedule: drag backlog jobs onto crews and days, with a map to route them. It uses the Shop Board's crews, and is next on the list.</div>
            <div className="hint">The tab is here so you can see where it will live. Nothing on it works yet.</div>
          </div></div>
        </div>
      )}
      {current?.id === "backlog" && <Backlog me={me} />}
      {current?.id === "shop" && <ShopBoard user={me} isAdmin={!!me.perms.admin} />}
      {current?.id === "schedule" && <Schedule me={me} />}
      {current?.id === "quick" && <QuickPick me={me} />}
      {current?.id === "admin" && <Admin me={me} />}
      <AppMenu me={me} current="dispatch" onAdmin={() => pick("admin")} onSignOut={signOut}
               buttonStyle={current?.id === "quick" ? { left: "auto", right: 12, bottom: "calc(40% + 16px)", width: 42, height: 42 } : undefined} />
    </div>
  );
}
