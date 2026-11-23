import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { STATUS, jobColor } from "./backlogModel";
import { fmtH } from "./hours";

/* ═══════════════════════════════════════════════════════════════════════════
   Map of backlog jobs. Each address is looked up once (server: US Census
   geocoder, free; browser fallback: Google's geocoder) and remembered on the
   server, so later loads are instant.
   ═══════════════════════════════════════════════════════════════════════════ */

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
let mapsPromise = null;
export function loadMaps() {
  if (window.google?.maps?.Map) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
    s.async = true;
    s.onload = () => (window.google?.maps?.Map ? ok() : fail(new Error("Maps failed")));
    s.onerror = () => { mapsPromise = null; fail(new Error("Maps script failed")); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}

/** Look up coordinates for every job; returns { ref: {lat,lng} | null }. */
export function useJobPoints(jobs) {
  const [points, setPoints] = useState({});
  const [state, setState] = useState("");
  const key = jobs.map((j) => j.ref).join(",");
  useEffect(() => {
    if (!jobs.length) return;
    let dead = false;
    (async () => {
      setState("Finding job locations…");
      let pts = {};
      try {
        const r = await api("geocode", { method: "POST", body: { items: jobs.map((j) => ({ id: j.ref, addr: j.addr })) } });
        pts = r.points || {};
      } catch {}
      if (dead) return;
      setPoints(pts);
      // Anything the server couldn't place: try Google's geocoder in the browser.
      const missing = jobs.filter((j) => !pts[j.ref] && j.addr);
      if (missing.length) {
        try {
          await loadMaps();
          const gc = new window.google.maps.Geocoder();
          const found = {};
          for (const j of missing) {
            if (dead) return;
            const res = await new Promise((ok) => gc.geocode({ address: j.addr }, (r, st) => ok({ r, st })));
            if (res.st === "REQUEST_DENIED" || res.st === "OVER_DAILY_LIMIT") break;
            const loc = res.r?.[0]?.geometry?.location;
            if (loc) { const p = { lat: loc.lat(), lng: loc.lng() }; found[j.addr] = p; pts = { ...pts, [j.ref]: p }; }
            await new Promise((ok) => setTimeout(ok, 120));
          }
          if (!dead) setPoints(pts);
          if (Object.keys(found).length) api("geocode", { method: "PUT", body: { points: found } }).catch(() => {});
        } catch {}
      }
      if (!dead) {
        const n = jobs.filter((j) => !pts[j.ref]).length;
        setState(n ? `${n} job${n === 1 ? "" : "s"} couldn't be placed on the map.` : "");
      }
    })();
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { points, state };
}

export default function BacklogMap({ jobs, points, selected, onPick, colorBy = "status", zoneColors = {}, children }) {
  const el = useRef(null);
  const map = useRef(null);
  const markers = useRef(new Map());
  const fitted = useRef(false);
  const [err, setErr] = useState("");
  const pickRef = useRef(onPick); pickRef.current = onPick;

  useEffect(() => {
    let dead = false;
    loadMaps().then(() => {
      if (dead || !el.current) return;
      map.current = new window.google.maps.Map(el.current, {
        center: { lat: 43.12, lng: -77.55 }, zoom: 10,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false,
        styles: [
          { elementType: "geometry", stylers: [{ color: "#1d2329" }] },
          { elementType: "labels.text.fill", stylers: [{ color: "#8a959d" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#14181c" }] },
          { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c353c" }] },
          { featureType: "water", stylers: [{ color: "#0f2433" }] },
          { featureType: "poi", stylers: [{ visibility: "off" }] },
        ],
      });
      setErr("");
    }).catch(() => setErr("The map couldn't load."));
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    const g = window.google?.maps;
    if (!map.current || !g) return;
    const want = new Set();
    const bounds = new g.LatLngBounds();
    jobs.forEach((j) => {
      const p = points[j.ref]; if (!p) return;
      want.add(j.ref); bounds.extend(p);
      const color = colorBy === "zone" ? (zoneColors[j.zone] || "#7d8a94") : colorBy === "age" ? jobColor(j) : STATUS[j.status].color;
      const sel = selected === j.ref;
      const icon = {
        path: g.SymbolPath.CIRCLE, scale: sel ? 10 : Math.max(5, Math.min(9, 4 + (j.treeHrs ?? j.hrs ?? 0) / 6)),
        fillColor: color, fillOpacity: 0.92, strokeColor: sel ? "#ffffff" : "#0b0e11", strokeWeight: sel ? 3 : 1.2,
      };
      let m = markers.current.get(j.ref);
      if (!m) {
        m = new g.Marker({ map: map.current, position: p, icon, title: `${j.name} · ${fmtH(j.treeHrs ?? j.hrs)}` });
        m.addListener("click", () => pickRef.current?.(j.ref));
        markers.current.set(j.ref, m);
      } else { m.setIcon(icon); m.setPosition(p); }
      m.setZIndex(sel ? 999 : STATUS_Z[j.status]);
    });
    for (const [ref, m] of markers.current) if (!want.has(ref)) { m.setMap(null); markers.current.delete(ref); }
    if (!fitted.current && want.size) { map.current.fitBounds(bounds, 30); fitted.current = true; }
  }, [jobs, points, selected, colorBy, zoneColors]);

  useEffect(() => {
    const p = selected && points[selected];
    if (p && map.current) map.current.panTo(p);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}>
      <div ref={el} style={{ position: "absolute", inset: 0, borderRadius: 3, background: "#1d2329" }} />
      {err && <div className="err" style={{ position: "absolute", top: 10, left: 10 }}>{err}</div>}
      {children}
    </div>
  );
}
const STATUS_Z = { over: 60, soon: 50, ok: 40, season: 25, flex: 20, sched: 30, hold: 10, paused: 15 };
