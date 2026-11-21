import { useState, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   Field · Dispatch · Soil switcher, at the top of the ☰ menu.
   Asks the server which tools this account may use (the same sign-in the field
   app already has), and shows only those. Nothing shows if the server can't
   say — the field app itself is never affected.
   Dispatch and Soil have their own copy of this row (src/dispatch/AppMenu.jsx);
   they are separate builds and must not share code with the field app.
   ═══════════════════════════════════════════════════════════════════════════ */

let cached = null;           // per page load: { perms } or false

const APPS = [
  { id: "field", label: "Field", href: "/" },
  { id: "dispatch", label: "Dispatch", href: "/dispatch/" },
  { id: "soil", label: "Soil", href: "/soil/" },
];

export default function AppSwitcher({ pendingUploads = 0 }) {
  const [me, setMe] = useState(cached);
  useEffect(() => {
    if (cached !== null) return;
    let dead = false;
    fetch("/api/dispatch/me", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : false)).catch(() => false)
      .then((d) => { cached = d && d.perms ? d : false; if (!dead) setMe(cached); });
    return () => { dead = true; };
  }, []);

  if (!me) return null;
  const p = me.perms;
  const can = { field: true, dispatch: p.dispatch || p.shop || p.admin, soil: p.soil || p.admin };
  const apps = APPS.filter((a) => can[a.id]);
  if (apps.length < 2 && !p.admin) return null;

  const go = (href) => {
    if (pendingUploads > 0 && !window.confirm(`${pendingUploads} stop${pendingUploads === 1 ? " has" : "s have"} photos still uploading. They'll carry on when you come back to the Field app. Switch anyway?`)) return;
    window.location.href = href;
  };

  return (
    <div style={{ margin: "0 6px 12px" }}>
      <div style={{ display: "flex", gap: 4, background: "#080a10", border: "1px solid #1a2030", borderRadius: 10, padding: 3 }}>
        {apps.map((a) => {
          const on = a.id === "field";
          return (
            <button key={a.id} onClick={() => !on && go(a.href)} aria-current={on ? "page" : undefined}
              style={{ flex: 1, minHeight: 40, borderRadius: 8, border: "none", cursor: on ? "default" : "pointer",
                       background: on ? "#1f2a40" : "transparent", color: on ? "#fff" : "#8a9ab0",
                       fontFamily: "'Oswald',sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>
              {a.label}
            </button>
          );
        })}
      </div>
      {p.admin && (
        <button onClick={() => go("/dispatch/#admin")}
          style={{ marginTop: 6, width: "100%", minHeight: 36, borderRadius: 8, border: "1px solid #1a2030", background: "transparent",
                   color: "#8a9ab0", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
          Admin — users &amp; access
        </button>
      )}
    </div>
  );
}
