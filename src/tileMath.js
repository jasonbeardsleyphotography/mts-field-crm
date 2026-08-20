/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Web Mercator / tile math
   ───────────────────────────────────────────────────────────────────────────
   Shared by the JPEG site-plan export (treeMapExport.js) and the live crew
   viewer (TileMap.jsx). Both draw the same free Esri World Imagery tiles, so
   the projection has to agree exactly between them.

   Tiles are Esri World Imagery: no API key, no quota, no per-view cost. That
   is the whole reason the crew viewer can be handed to any number of people
   without metering.
   ═══════════════════════════════════════════════════════════════════════════ */

export const TILE = 256;
// Deepest zoom at which Esri actually HAS imagery. Past this it serves a grey
// "Map data not yet available" placeholder as a normal 200 image — so nothing
// errors, the map just goes blank-looking. Anything used directly as a TILE
// zoom must therefore be capped here.
export const MAX_TILE_Z = 19;
// Deepest zoom the VIEW may reach. Beyond MAX_TILE_Z the map keeps using
// MAX_TILE_Z tiles scaled up: slightly soft, but real imagery instead of grey.
export const MAX_Z = 21;
export const MIN_Z = 3;

// Esri's path is /tile/{z}/{row}/{col} — row is y, col is x, hence the swap.
export const TILE_URL = (z, x, y) =>
  `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Latitude beyond this can't be represented in Web Mercator.
export const MAX_LAT = 85.05112878;
export const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** lat/lng -> world pixels at zoom `z`. Works for FRACTIONAL z (world size is
 *  continuous), which is what lets the viewer pinch-zoom smoothly. */
export function project(lat, lng, z) {
  const world = TILE * Math.pow(2, z);
  const x = ((lng + 180) / 360) * world;
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  return { x, y };
}

/** Inverse of project — world pixels back to lat/lng. Needed to turn a drag in
 *  screen pixels back into a new map centre. */
export function unproject(x, y, z) {
  const world = TILE * Math.pow(2, z);
  const lng = (x / world) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / world);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

export function boundsOf(points) {
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  return {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lngs), west: Math.min(...lngs),
  };
}

/** Largest zoom at which `b` still fits inside a `w` x `h` pixel viewport.
 *  Capped at MAX_TILE_Z, because callers use the result to pick tiles (the JPEG
 *  export uses it as the tile zoom directly) and a deeper value would select
 *  the "not yet available" placeholder. */
export function fitZoom(b, w, h = w) {
  for (let z = MAX_TILE_Z; z >= MIN_Z; z--) {
    const a = project(b.north, b.west, z);
    const c = project(b.south, b.east, z);
    if (Math.abs(c.x - a.x) <= w && Math.abs(c.y - a.y) <= h) return z;
  }
  return MIN_Z;
}

/** Ground metres covered by one screen pixel — used to size the GPS accuracy
 *  circle so it means the same thing at every zoom level. */
export function metersPerPixel(lat, z) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Compass point from a to b, e.g. "NE" — plain-language direction is far more
 *  useful to someone walking a property than a bearing in degrees. */
export function compassFrom(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

/** Feet, in the units a tree crew actually speaks. */
export function fmtDistance(meters) {
  const ft = meters * 3.28084;
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${(ft / 5280).toFixed(1)} mi`;
}
