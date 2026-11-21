import { useState, useEffect, useCallback } from "react";
import { api } from "./api";
import { CSS } from "./theme";
import Admin from "./Admin.jsx";
import Backlog from "./Backlog.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS Dispatch — a separate tool on the field app's site (/dispatch).
   Sign-in: a one-time link the owner makes on the Admin tab (works for any
   email address), or the field app's Google sign-in on the same browser.
   ═══════════════════════════════════════════════════════════════════════════ */

const TABS = [
  { id: "backlog", label: "Backlog", need: "dispatch" },
  { id: "schedule", label: "Schedule", need: "dispatch", soon: true },
  { id: "shop", label: "Shop Board", need: "shop", soon: true },
  { id: "admin", label: "Admin", need: "admin" },
];

const LINK_ERRORS = {
  link_used_or_unknown: "That sign-in link has already been used (each link works once), or it was mistyped. Ask for a new one.",
  link_expired: "That sign-in link has expired. Ask for a new one.",
  no_access: "That account doesn't have access to Dispatch. Ask the owner to switch it on.",
};

export default function DispatchApp() {
  const [me, setMe] = useState(undefined);       // undefined = loading, null = signed out
  const [linkErr, setLinkErr] = useState("");
  const [tab, setTab] = useState(() => { try { return localStorage.getItem("mts-dispatch-tab") || "backlog"; } catch { return "backlog"; } });

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

  const pick = (id) => { setTab(id); try { localStorage.setItem("mts-dispatch-tab", id); } catch {} };
  const allowed = (t) => me?.perms?.[t.need] || (t.need === "dispatch" && me?.perms?.admin);
  const tabs = me ? TABS.filter(allowed) : [];
  const current = tabs.find((t) => t.id === tab && !t.soon) || tabs.find((t) => !t.soon);

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
            {tabs.map((t) => (
              <button key={t.id} className="tab st" role="tab" aria-selected={current?.id === t.id}
                      disabled={t.soon} title={t.soon ? "Coming next" : undefined} onClick={() => pick(t.id)}>
                {t.label}{t.soon ? " · soon" : ""}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <span className="who">{me.name || me.email}</span>
          {me.via === "link" && <button className="btn st" onClick={signOut}>Sign out</button>}
        </div>
      </header>
      {!current && <div className="wrap hint">This account has no Dispatch tools switched on yet.</div>}
      {current?.id === "backlog" && <Backlog me={me} />}
      {current?.id === "admin" && <Admin me={me} />}
    </div>
  );
}
