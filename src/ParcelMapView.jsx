import { useState, useRef, useEffect } from "react";
import { loadMaps, geocode } from "./RouteMap";
import { attachParcelOverlay, detachParcelOverlay, parcelFeatureToInfo } from "./parcelOverlay";
import { IconX, IconCamera } from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Parcel Map View
   Full-screen satellite map + tax-parcel boundary overlay for a single stop,
   reached from OnsiteWindow. Tap a parcel to see read-only owner/tax info in
   a bottom sheet. "Snapshot" captures the current view (including whatever
   parcel lines are drawn) and hands the image back to the caller, which
   stores it the same way a camera photo is stored.
   ═══════════════════════════════════════════════════════════════════════════ */

const F = "'Oswald',sans-serif";

export default function ParcelMapView({ stop, onClose, onSnapshot }) {
  const ref = useRef(null);
  const map = useRef(null);
  const parcelHandle = useRef(null);
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState(null); // parcel info shown in bottom sheet
  const [snapping, setSnapping] = useState(false);
  const [snapError, setSnapError] = useState(null);

  useEffect(() => { loadMaps().then(() => setReady(true)).catch(() => {}); }, []);

  // Create map, centered on the stop's geocoded address, with overlay attached.
  useEffect(() => {
    if (!ready || !ref.current || map.current) return;
    let dead = false;
    (async () => {
      const center = await geocode(stop?.addr) || { lat: 43.12, lng: -77.50 };
      if (dead || !ref.current) return;
      map.current = new window.google.maps.Map(ref.current, {
        center, zoom: 18,
        mapTypeId: "hybrid",
        disableDefaultUI: true, gestureHandling: "greedy", backgroundColor: "#10131a",
        zoomControl: false, mapTypeControl: false, streetViewControl: false,
        fullscreenControl: false, keyboardShortcuts: false, clickableIcons: false,
      });
      parcelHandle.current = attachParcelOverlay(map.current, {
        onParcelClick: (feature) => setInfo(parcelFeatureToInfo(feature)),
      });
    })();
    return () => {
      dead = true;
      if (parcelHandle.current) { detachParcelOverlay(parcelHandle.current); parcelHandle.current = null; }
    };
  }, [ready, stop?.addr]);

  const dismissInfo = () => setInfo(null);

  const takeSnapshot = async () => {
    if (!ref.current || snapping) return;
    setSnapping(true);
    setSnapError(null);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(ref.current, { useCORS: true, logging: false });
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      await onSnapshot(dataUrl);
    } catch (e) {
      console.warn("Parcel map snapshot failed:", e);
      setSnapError("Snapshot failed — try again.");
      setSnapping(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 300, overflow: "hidden" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }}>
        {!ready && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#5a6580", fontSize: 13, fontFamily: F }}>
            Loading map...
          </div>
        )}
      </div>

      {/* ── TOP BAR ─────────────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        padding: "max(12px, env(safe-area-inset-top)) 14px 12px",
        background: "linear-gradient(to bottom, rgba(0,0,0,.7) 0%, transparent 100%)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: F, textTransform: "uppercase", letterSpacing: 1, textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
          {stop?.addr || "Parcel Map"}
        </div>
        <button onClick={onClose} aria-label="Close parcel map" style={{
          width: 36, height: 36, borderRadius: 18,
          background: "rgba(28,28,30,.72)", border: "1px solid rgba(255,255,255,.14)",
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
        }}>
          <IconX size={18} color="#fff" />
        </button>
      </div>

      {/* ── SNAPSHOT BUTTON ─────────────────────────────────────────────── */}
      <div style={{
        position: "absolute", bottom: "max(24px, env(safe-area-inset-bottom))", left: 0, right: 0,
        display: "flex", justifyContent: "center", pointerEvents: "none",
      }}>
        <button
          onClick={takeSnapshot}
          disabled={!ready || snapping}
          style={{
            pointerEvents: "auto",
            display: "flex", alignItems: "center", gap: 8,
            padding: "12px 22px", borderRadius: 999,
            background: "rgba(28,28,30,.85)", border: "1px solid rgba(255,255,255,.16)",
            color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: F, letterSpacing: 0.5,
            cursor: ready && !snapping ? "pointer" : "default",
            opacity: ready && !snapping ? 1 : 0.55,
            boxShadow: "0 4px 16px rgba(0,0,0,.4)",
          }}
        >
          <IconCamera size={17} color="#fff" />
          {snapping ? "Saving..." : "Snapshot"}
        </button>
      </div>

      {snapError && (
        <div style={{
          position: "absolute", bottom: "max(84px, calc(env(safe-area-inset-bottom) + 60px))", left: "50%",
          transform: "translateX(-50%)", padding: "8px 14px", borderRadius: 8,
          background: "rgba(239,68,68,.9)", color: "#fff", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
        }}>
          {snapError}
        </div>
      )}

      {/* ── BOTTOM SHEET — parcel info ──────────────────────────────────── */}
      {info && (
        <div onClick={dismissInfo} style={{ position: "fixed", inset: 0, zIndex: 1 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: "#13161f", borderTop: "1px solid #252d47",
              borderTopLeftRadius: 16, borderTopRightRadius: 16,
              padding: "16px 18px max(20px, env(safe-area-inset-bottom))",
              boxShadow: "0 -8px 30px rgba(0,0,0,.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", fontFamily: F, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {info.owner}
              </div>
              <button onClick={dismissInfo} aria-label="Close" style={{
                width: 28, height: 28, borderRadius: 14, background: "transparent",
                border: "1px solid #252d47", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", flexShrink: 0, marginLeft: 10,
              }}>
                <IconX size={14} color="#5a6580" />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#c8d0e8" }}>
              {info.parcelAddr && <Row label="Property" value={info.parcelAddr} />}
              {info.mailAddr && <Row label="Mailing address" value={info.mailAddr} />}
              {info.sbl && <Row label="SBL / tax ID" value={info.sbl} />}
              {info.acres != null && <Row label="Acreage" value={`${info.acres} ac`} />}
              {info.assessedValue != null && <Row label="Assessed value" value={`$${Number(info.assessedValue).toLocaleString()}`} />}
              {info.propClass && <Row label="Property class" value={info.propClass} />}
              {(info.muni || info.county) && <Row label="Municipality" value={[info.muni, info.county].filter(Boolean).join(", ")} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#5a6580", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontFamily: F, flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
}
