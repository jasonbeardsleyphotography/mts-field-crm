/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Parcel Boundary Overlay
   ───────────────────────────────────────────────────────────────────────────
   Draws NY State tax-parcel boundary lines over the satellite map using
   google.maps.Data, fed by free public ArcGIS REST FeatureServers. Shared by
   RouteMap.jsx (driving toggle) and ParcelMapView.jsx (on-site detail view)
   so both consume one fetch/render/cleanup implementation.

   Source coverage (confirmed): NYS_Tax_Parcels_Public covers Wayne, Ontario,
   and Livingston counties; it does NOT cover Monroe, Yates, or Orleans —
   those run their own county GIS and opt out of the state mirror. A
   Monroe-specific FeatureServer URL was located but could not be reached
   from the dev sandbox (proxy returned 403 on the CONNECT tunnel for both
   ny.gov and monroecounty.gov — a sandbox network-policy artifact, not
   necessarily a real restriction). VERIFY FROM A REAL BROWSER before
   relying on it; if it's genuinely unreachable, that's fine — see
   fetchParcelsForBounds below, a failed/empty source just contributes no
   features, never an error. Yates and Orleans have no known free source
   yet; add entries to PARCEL_SOURCES if/when one is found.
   ═══════════════════════════════════════════════════════════════════════════ */

export const PARCEL_SOURCES = [
  {
    id: "nys",
    name: "NYS Tax Parcels Public",
    url: "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/0",
  },
  {
    id: "monroe",
    name: "Monroe County Parcels",
    url: "https://maps.monroecounty.gov/server/rest/services/Hosted/Parcels_Geocortex/FeatureServer/0",
  },
];

// Below this zoom the per-parcel detail is too dense to be useful and the
// bbox query would cover far too much ground — clear the layer instead.
export const PARCEL_MIN_ZOOM = 15;

export const PARCEL_OUT_FIELDS = [
  "PRIMARY_OWNER", "MAIL_ADDR", "MAIL_CITY", "MAIL_STATE", "MAIL_ZIP",
  "PARCEL_ADDR", "SBL", "CALC_ACRES", "TOTAL_AV", "PROP_CLASS",
  "COUNTY_NAME", "MUNI_NAME",
];

const IDLE_DEBOUNCE_MS = 400;
const FETCH_TIMEOUT_MS = 9000;
const RESULT_RECORD_CAP = 4000;

// Comma-delimited envelope: the most broadly-compatible geometry form for an
// ArcGIS bbox query (xmin,ymin,xmax,ymax). Avoids any JSON-encoding edge cases.
function boundsToEnvelopeString(bounds) {
  const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
  return `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`;
}

// AbortSignal.timeout() only exists on iOS Safari 16+. On older devices it's
// undefined and calling it throws BEFORE the fetch starts — which would make
// every parcel query silently fail. Fall back to a manual AbortController.
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
  } catch {}
  try {
    const c = new AbortController();
    setTimeout(() => { try { c.abort(); } catch {} }, ms);
    return c.signal;
  } catch { return undefined; }
}

// Returns { features, ok, error }:
//   ok=true  → the server responded successfully (features may still be empty
//              if there are genuinely no parcels in the viewport)
//   ok=false → HTTP error, Esri error payload, CORS, timeout, or network fail
async function queryOneSource(source, bounds) {
  // Request ALL fields (outFields=*) rather than a hand-listed set: if even one
  // named field is missing from a layer's schema, ArcGIS rejects the entire
  // query and returns zero geometry — which reads as "the overlay is broken."
  const params = new URLSearchParams({
    f: "geojson",
    where: "1=1",
    geometry: boundsToEnvelopeString(bounds),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    resultRecordCount: String(RESULT_RECORD_CAP),
  });
  try {
    const res = await fetch(`${source.url}/query?${params}`, {
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[parcelOverlay] ${source.id} query failed: HTTP ${res.status}`, await res.text().catch(() => ""));
      return { id: source.id, features: [], ok: false, error: `HTTP ${res.status}` };
    }
    const geojson = await res.json();
    if (!Array.isArray(geojson?.features)) {
      // Esri error responses are JSON with an .error.message even on a 200
      // status, so this is the other place a broken query hides silently.
      const msg = geojson?.error?.message || "no features array";
      console.warn(`[parcelOverlay] ${source.id} returned no features:`, msg, geojson?.error || geojson);
      return { id: source.id, features: [], ok: false, error: msg };
    }
    const features = geojson.features;
    // Tag each feature with its source id so parcelFeatureToInfo can apply
    // any source-specific field-name quirks defensively.
    features.forEach(f => { f.properties = { ...f.properties, __sourceId: source.id }; });
    return { id: source.id, features, ok: true, error: null };
  } catch (e) {
    // Network failure, timeout, CORS, or a county the source doesn't cover
    // all land here — still treated as "no parcels here" for the user, but
    // logged so a genuinely broken query is diagnosable instead of invisible.
    console.warn(`[parcelOverlay] ${source.id} query threw:`, e?.message || e);
    return { id: source.id, features: [], ok: false, error: e?.message || String(e) };
  }
}

// Fan the query out to every configured source for the current viewport and
// merge results. No county-detection/routing: a source outside its coverage
// area (or genuinely unreachable) just contributes zero features.
// Returns { type, features, anyOk, errors } so callers can distinguish a
// genuinely-empty viewport (anyOk=true, no features) from a broken fetch
// (anyOk=false → every source errored).
export async function fetchParcelsForBounds(bounds) {
  const results = await Promise.all(PARCEL_SOURCES.map(s => queryOneSource(s, bounds)));
  const features = results.flatMap(r => r.features);
  const anyOk = results.some(r => r.ok);
  const errors = results.filter(r => !r.ok && r.error).map(r => r.error);
  // Per-source breakdown so the UI can show exactly which source returned what
  // (e.g. NYS errored while Monroe returned a clean empty result).
  const sources = results.map(r => ({ id: r.id, ok: r.ok, count: r.features.length, error: r.error }));
  return { type: "FeatureCollection", features, anyOk, errors, sources };
}

// Attach a parcel overlay to an existing google.maps.Map. Returns a handle
// to pass to detachParcelOverlay. Wires:
//  - a debounced `idle` listener that re-fetches when the viewport settles
//    and zoom >= PARCEL_MIN_ZOOM, else clears the layer
//  - a click listener on map.data invoking onParcelClick(feature)
//  - stroke-only styling so satellite imagery stays legible underneath
export function attachParcelOverlay(map, { onParcelClick, onStatus } = {}) {
  if (!map || !map.data || !window.google?.maps) return null;

  // onStatus(state) lets the UI surface what's happening instead of a silent
  // blank: "zoom" | "loading" | "ok" | "empty" | "error".
  const status = (state, extra) => { try { onStatus?.({ state, ...extra }); } catch {} };

  map.data.setStyle({
    strokeColor: "#FFD600",
    strokeWeight: 2,
    strokeOpacity: 0.85,
    fillOpacity: 0,
    clickable: true,
  });

  let debounceTimer = null;
  let activeFetch = 0;

  const refresh = () => {
    const zoom = map.getZoom();
    if (zoom == null || zoom < PARCEL_MIN_ZOOM) {
      map.data.forEach(f => map.data.remove(f));
      status("zoom");
      return;
    }
    const bounds = map.getBounds();
    if (!bounds) return;
    const myFetch = ++activeFetch;
    status("loading");
    fetchParcelsForBounds(bounds).then(geojson => {
      if (myFetch !== activeFetch) return; // a newer fetch superseded this one
      map.data.forEach(f => map.data.remove(f));
      if (geojson.features.length) {
        map.data.addGeoJson(geojson);
        status("ok", { count: geojson.features.length, sources: geojson.sources });
      } else if (geojson.anyOk) {
        // A source responded fine, there just aren't parcels in this viewport.
        // Pass the per-source breakdown so the UI can reveal whether the
        // COVERING source actually errored (masked by another's empty-OK).
        status("empty", { sources: geojson.sources, errors: geojson.errors });
      } else {
        // Every source errored/timed out/was blocked — a real failure.
        status("error", { errors: geojson.errors, sources: geojson.sources });
      }
    });
  };

  const idleListener = map.addListener("idle", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, IDLE_DEBOUNCE_MS);
  });

  const clickListener = onParcelClick
    ? map.data.addListener("click", (e) => onParcelClick(e.feature))
    : null;

  // Run once immediately in case the map is already idle when attached.
  refresh();

  return { map, idleListener, clickListener, debounceTimerRef: () => debounceTimer };
}

// Tears down listeners and clears features added by this overlay. Safe to
// call multiple times or on an already-detached/null handle.
export function detachParcelOverlay(handle) {
  if (!handle) return;
  const { map, idleListener, clickListener } = handle;
  try { idleListener?.remove(); } catch {}
  try { clickListener?.remove(); } catch {}
  try { map?.data?.forEach(f => map.data.remove(f)); } catch {}
}

// Pulls read-only display fields off a clicked google.maps.Data.Feature into
// a plain object for the info panel. Defensive against missing fields since
// schemas vary slightly between sources.
export function parcelFeatureToInfo(feature) {
  const get = (key) => {
    try { return feature.getProperty(key); } catch { return undefined; }
  };
  const mailParts = [get("MAIL_ADDR"), get("MAIL_CITY"), get("MAIL_STATE"), get("MAIL_ZIP")]
    .filter(Boolean);
  return {
    owner: get("PRIMARY_OWNER") || "Unknown owner",
    mailAddr: mailParts.join(", ") || null,
    parcelAddr: get("PARCEL_ADDR") || null,
    sbl: get("SBL") || null,
    acres: get("CALC_ACRES") ?? null,
    assessedValue: get("TOTAL_AV") ?? null,
    propClass: get("PROP_CLASS") || null,
    county: get("COUNTY_NAME") || null,
    muni: get("MUNI_NAME") || null,
  };
}
