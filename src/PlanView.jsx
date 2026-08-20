import { useState, useEffect, useRef, useCallback } from "react";
import TileMap from "./TileMap";
import {
  boundsOf, fitZoom, distanceMeters, compassFrom, fmtDistance, MAX_Z,
} from "./tileMath";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Shared Site Plan (public crew viewer)
   ───────────────────────────────────────────────────────────────────────────
   Rendered for /plan/:id, before <App/> mounts, so a crew member opening the
   texted link never touches Google sign-in and needs no app install.

   Shows the job's tree pins on satellite imagery plus a live blue dot for the
   viewer, so someone standing on the property can walk to the right tree —
   which is the thing a flat exported image can't do. Tapping a pin shows that
   tree's photo and how far away it is.

   Uses TileMap (free Esri imagery), NOT the Google Maps JS API: this link can
   be opened by any number of crew any number of times, and a metered map API
   would bill every one of those views.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

export default function PlanView({ planId }) {
  const [plan, setPlan] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | missing | error
  const [view, setView] = useState(null);        // { center, zoom }
  const [sel, setSel] = useState(null);          // selected pin index
  const [userPos, setUserPos] = useState(null);  // { lat, lng, acc }
  const [locState, setLocState] = useState("idle"); // idle | asking | on | denied
  const watchId = useRef(null);

  // ── Load the plan ─────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/plan?id=${encodeURIComponent(planId)}`);
        if (dead) return;
        if (r.status === 404) { setState("missing"); return; }
        if (!r.ok) { setState("error"); return; }
        const data = await r.json();
        if (dead) return;
        const pins = (data.pins || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
        if (!pins.length) { setState("missing"); return; }
        setPlan({ ...data, pins });
        // Open framed on the whole job. fitZoom against a nominal viewport, then
        // ease off one step so pins aren't jammed against the edges.
        const b = boundsOf(pins);
        setView({
          center: { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 },
          zoom: Math.min(MAX_Z, Math.max(15, fitZoom(b, 320) - 0.4)),
        });
        setState("ready");
      } catch {
        if (!dead) setState("error");
      }
    })();
    return () => { dead = true; };
  }, [planId]);

  // ── Live location ─────────────────────────────────────────────────────────
  // Deliberately behind a button: browsers suppress permission prompts that
  // fire on load, and the crew should see the map before being asked.
  const enableLocation = useCallback(() => {
    if (!("geolocation" in navigator)) { setLocState("denied"); return; }
    setLocState("asking");
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setUserPos({
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          acc: Math.round(pos.coords.accuracy || 0),
        });
        setLocState("on");
      },
      () => setLocState("denied"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }, []);

  useEffect(() => () => {
    if (watchId.current != null) {
      try { navigator.geolocation.clearWatch(watchId.current); } catch {}
    }
  }, []);

  const recenter = () => {
    if (userPos) setView(v => ({ center: { lat: userPos.lat, lng: userPos.lng }, zoom: Math.max(v.zoom, 18) }));
  };

  // ── Simple states ─────────────────────────────────────────────────────────
  const shell = (msg, sub) => (
    <div style={{
      minHeight: "100dvh", background: "#0a0b10", color: "#e0e8f0",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24, fontFamily: B, textAlign: "center",
    }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{msg}</div>
        {sub && <div style={{ fontSize: 13, color: "#5a6580", marginTop: 8, lineHeight: 1.5 }}>{sub}</div>}
      </div>
    </div>
  );
  if (state === "loading") return shell("Loading site plan…");
  if (state === "missing") return shell("Site plan not found", "This link may be incorrect or the plan may have been removed.");
  if (state === "error") return shell("Couldn't load the site plan", "Check your connection and try again.");

  const selPin = sel != null ? plan.pins[sel] : null;
  const selDist = selPin && userPos
    ? `${fmtDistance(distanceMeters(userPos, selPin))} ${compassFrom(userPos, selPin)}`
    : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0b10", fontFamily: B, overflow: "hidden" }}>
      <TileMap
        center={view.center}
        zoom={view.zoom}
        onViewChange={setView}
        pins={plan.pins}
        selectedIndex={sel}
        onPinTap={setSel}
        parcel={plan.parcel || []}
        userPos={userPos}
      />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        padding: "max(12px, env(safe-area-inset-top)) 14px 14px",
        background: "linear-gradient(to bottom, rgba(0,0,0,.78) 0%, transparent 100%)",
        pointerEvents: "none",
      }}>
        <div style={{
          fontSize: 15, fontWeight: 700, color: "#fff", fontFamily: F,
          textTransform: "uppercase", letterSpacing: 1, textShadow: "0 1px 4px rgba(0,0,0,.7)",
        }}>{plan.client || "Site Plan"}</div>
        {plan.address && (
          <div style={{ fontSize: 12, color: "#cbd5e3", marginTop: 2, textShadow: "0 1px 4px rgba(0,0,0,.7)" }}>
            {plan.address}
          </div>
        )}
        <div style={{ fontSize: 11, color: "#8fa0b6", marginTop: 3, textShadow: "0 1px 4px rgba(0,0,0,.7)" }}>
          {plan.pins.length} marked {plan.pins.length === 1 ? "location" : "locations"} · tap a pin for its photo
        </div>
      </div>

      {/* ── Location controls ──────────────────────────────────────────── */}
      <div style={{
        position: "absolute", right: "max(14px, env(safe-area-inset-right))",
        bottom: selPin ? "calc(max(20px, env(safe-area-inset-bottom)) + 300px)" : "max(20px, env(safe-area-inset-bottom))",
        display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end",
        transition: "bottom .2s",
      }}>
        {locState !== "on" && (
          <button
            onClick={enableLocation}
            disabled={locState === "asking"}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "12px 18px", borderRadius: 999,
              background: "#1a73e8", border: "none", color: "#fff",
              fontSize: 13, fontWeight: 800, fontFamily: F, letterSpacing: 0.5,
              textTransform: "uppercase", cursor: "pointer",
              boxShadow: "0 4px 16px rgba(0,0,0,.5)",
              opacity: locState === "asking" ? 0.7 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3.5" fill="#fff" stroke="none" />
              <circle cx="12" cy="12" r="7.5" />
              <line x1="12" y1="1.5" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22.5" />
              <line x1="1.5" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22.5" y2="12" />
            </svg>
            {locState === "asking" ? "Locating…" : "Show my location"}
          </button>
        )}
        {locState === "on" && (
          <button onClick={recenter} aria-label="Recenter on me" style={{
            width: 48, height: 48, borderRadius: 24,
            background: "rgba(28,28,30,.9)", border: "1px solid rgba(255,255,255,.18)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.5)", padding: 0,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4c9aff" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3.5" fill="#4c9aff" stroke="none" />
              <circle cx="12" cy="12" r="7.5" />
              <line x1="12" y1="1.5" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22.5" />
              <line x1="1.5" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22.5" y2="12" />
            </svg>
          </button>
        )}
        {locState === "denied" && (
          <div style={{
            maxWidth: 220, padding: "8px 12px", borderRadius: 10,
            background: "rgba(0,0,0,.78)", color: "#ffb4b4", fontSize: 11.5, lineHeight: 1.45,
          }}>
            Location is blocked. Turn it on for this site in your browser settings to see
            where you are — the pins still work without it.
          </div>
        )}
      </div>

      {/* ── Pin sheet ──────────────────────────────────────────────────── */}
      {selPin && (
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0,
          background: "#0e1120", borderTop: "1px solid #253049",
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: "14px 16px max(16px, env(safe-area-inset-bottom))",
          boxShadow: "0 -12px 40px rgba(0,0,0,.65)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 15, background: "#F6BF26",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: F, fontWeight: 700, color: "#1a1400", fontSize: 15, flexShrink: 0,
            }}>{selPin.n ?? sel + 1}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: "#e6ecf5" }}>
                {selPin.label || `Location ${selPin.n ?? sel + 1}`}
              </div>
              {selDist && (
                <div style={{ fontSize: 12.5, color: "#4c9aff", fontWeight: 700, marginTop: 2 }}>
                  {selDist} from you
                </div>
              )}
            </div>
            <button onClick={() => setSel(null)} aria-label="Close" style={{
              width: 32, height: 32, borderRadius: 16, background: "transparent",
              border: "1px solid #253049", color: "#8aa0c0", cursor: "pointer",
              fontSize: 16, lineHeight: 1, flexShrink: 0,
            }}>✕</button>
          </div>
          {selPin.photo ? (
            <img src={selPin.photo} alt="" style={{
              width: "100%", maxHeight: "42vh", objectFit: "contain",
              borderRadius: 10, background: "#0a0c14", display: "block",
            }} />
          ) : (
            <div style={{ fontSize: 12.5, color: "#5a6580", padding: "14px 0" }}>
              No photo for this location.
            </div>
          )}
          {plan.pins.length > 1 && (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={() => setSel((sel - 1 + plan.pins.length) % plan.pins.length)} style={navBtn}>‹ Prev</button>
              <button onClick={() => setSel((sel + 1) % plan.pins.length)} style={navBtn}>Next ›</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const navBtn = {
  flex: 1, padding: "9px 0", borderRadius: 8,
  background: "rgba(255,255,255,.07)", border: "1px solid #253049",
  color: "#c8d4e4", fontSize: 12, fontWeight: 700,
  fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer",
};
