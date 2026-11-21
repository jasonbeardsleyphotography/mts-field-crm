import { useState } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   Bottom-left ☰ menu for Dispatch and Soil: Field · Dispatch · Soil switcher,
   Admin (users & access) for admins, and sign-out for sign-in-link sessions.
   The field app has its own copy of the switcher (src/AppSwitcher.jsx) — the
   builds are kept separate on purpose.
   ═══════════════════════════════════════════════════════════════════════════ */

const APPS = [
  { id: "field", label: "Field", href: "/" },
  { id: "dispatch", label: "Dispatch", href: "/dispatch/" },
  { id: "soil", label: "Soil", href: "/soil/" },
];

export default function AppMenu({ me, current, onAdmin, onSignOut, buttonStyle }) {
  const [open, setOpen] = useState(false);
  if (!me?.perms) return null;
  const p = me.perms;
  const can = { field: p.field, dispatch: p.dispatch || p.shop || p.admin, soil: p.soil || p.admin };
  const apps = APPS.filter((a) => can[a.id] || a.id === current);
  const go = (href) => { window.location.href = href; };

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Menu" title="Menu"
        style={{ position: "fixed", left: 12, bottom: "max(12px, env(safe-area-inset-bottom))", zIndex: 1300, width: 48, height: 48,
                 borderRadius: 12, background: "#1a2035", border: "1px solid #2a3550", boxShadow: "0 2px 10px rgba(0,0,0,.45)",
                 display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", ...buttonStyle }}>
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#c4d0e0" strokeWidth={2.2} strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1400, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Menu"
            style={{ width: "100%", maxWidth: 520, background: "#0d0f18", color: "#e6ecf5", borderTopLeftRadius: 18, borderTopRightRadius: 18,
                     padding: "8px 16px", paddingBottom: "max(18px, env(safe-area-inset-bottom))", fontFamily: "system-ui, sans-serif" }}>
            <div style={{ width: 42, height: 4, borderRadius: 2, background: "#2a3550", margin: "4px auto 14px" }} />
            <div style={{ display: "flex", gap: 4, background: "#080a10", border: "1px solid #1a2030", borderRadius: 10, padding: 3 }}>
              {apps.map((a) => {
                const on = a.id === current;
                return (
                  <button key={a.id} onClick={() => (on ? setOpen(false) : go(a.href))} aria-current={on ? "page" : undefined}
                    style={{ flex: 1, minHeight: 44, borderRadius: 8, border: "none", cursor: "pointer", background: on ? "#1f2a40" : "transparent",
                             color: on ? "#fff" : "#8a9ab0", fontFamily: "'Barlow Condensed','Oswald',sans-serif", fontSize: 15, fontWeight: 700,
                             letterSpacing: 1, textTransform: "uppercase" }}>
                    {a.label}
                  </button>
                );
              })}
            </div>
            {p.admin && (
              <button onClick={() => { setOpen(false); onAdmin ? onAdmin() : go("/dispatch/#admin"); }} style={rowStyle}>
                <b>Admin</b><span style={{ color: "#8a9ab0", fontSize: 12.5 }}>Users &amp; access — who can use which app</span>
              </button>
            )}
            {me.via === "link" && onSignOut && (
              <button onClick={() => { setOpen(false); onSignOut(); }} style={{ ...rowStyle, color: "#ff8a80" }}>
                <b>Sign out</b><span style={{ color: "#8a9ab0", fontSize: 12.5 }}>{me.name || me.email}</span>
              </button>
            )}
            <div style={{ color: "#6b7a90", fontSize: 12, marginTop: 12, textAlign: "center" }}>Signed in as {me.email}</div>
          </div>
        </div>
      )}
    </>
  );
}

const rowStyle = {
  width: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, marginTop: 10, padding: "12px 12px",
  minHeight: 52, background: "transparent", border: "1px solid #1a2030", borderRadius: 10, color: "#e6ecf5", cursor: "pointer",
  textAlign: "left", fontSize: 14.5,
};
