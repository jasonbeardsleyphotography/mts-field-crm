/* ═══════════════════════════════════════════════════════════════════════════
   Soil: gradient layers, colour scales and the maths behind the map.
   Colour stops, inverse-distance weighting (power 2, local metres) and the
   45 m → 130 m fade are taken unchanged from the BH-soil-gradient-map
   prototype, which is the spec for map behaviour.
   ═══════════════════════════════════════════════════════════════════════════ */

export const METRICS = {
  ph: { label: "Soil pH", short: "pH", stops: [[6.0, "#1a9850"], [6.5, "#91cf60"], [6.8, "#d9ef8b"], [7.0, "#fee08b"], [7.3, "#fc8d59"], [7.6, "#d73027"], [7.9, "#a50026"]], d: 1, note: "Green = in the target range, red = too alkaline" },
  Fe: { label: "Iron", short: "Fe", unit: "ppm", stops: [[1.5, "#d73027"], [2.7, "#fc8d59"], [4, "#fee08b"], [6, "#91cf60"], [10.5, "#1a9850"]], d: 1, note: "Red = low" },
  P: { label: "Phosphorus", short: "P", unit: "ppm", stops: [[0.4, "#d73027"], [2, "#fc8d59"], [4, "#fee08b"], [14, "#91cf60"], [33, "#1a9850"]], d: 1, note: "Red = low" },
  K: { label: "Potassium", short: "K", unit: "ppm", stops: [[60, "#d73027"], [100, "#fee08b"], [160, "#91cf60"], [200, "#1a9850"]], d: 0, note: "Red = low" },
  om: { label: "Organic matter", short: "OM", unit: "%", stops: [[3.5, "#d73027"], [4, "#fc8d59"], [5, "#fee08b"], [6, "#91cf60"], [11.5, "#1a9850"]], d: 1, note: "Red = low" },
  Ca: { label: "Calcium", short: "Ca", unit: "ppm", stops: [[1200, "#1a9850"], [1500, "#91cf60"], [2500, "#fee08b"], [4000, "#fc8d59"], [6100, "#d73027"]], d: 0, note: "Red = high" },
};
export const METRIC_ORDER = ["ph", "Fe", "P", "K", "om", "Ca"];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function colorAt(m, v) {
  const s = METRICS[m].stops;
  if (v <= s[0][0]) return hex(s[0][1]);
  if (v >= s[s.length - 1][0]) return hex(s[s.length - 1][1]);
  for (let i = 1; i < s.length; i++) if (v <= s[i][0]) {
    const t = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
    const a = hex(s[i - 1][1]), b = hex(s[i][1]);
    return a.map((x, k) => Math.round(x + (b[k] - x) * t));
  }
  return hex(s[s.length - 1][1]);
}
export const legendCss = (m) => {
  const st = METRICS[m].stops, lo = st[0][0], hi = st[st.length - 1][0];
  return "linear-gradient(to right," + st.map((x) => `${x[1]} ${((x[0] - lo) / (hi - lo) * 100).toFixed(1)}%`).join(",") + ")";
};

/** Local metric projection around a centre point. */
export function projector(points) {
  const lat0 = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p[1], 0) / points.length;
  const KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110540;
  return { KX, KY, XY: (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KY] };
}

export function inRings(x, y, rings) {
  let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}

/**
 * Draw the interpolated layer. samples: [{lat,lng,value}], regions: polygons
 * (arrays of rings of [lat,lon]) to clip to, shapes: stored boundary/area/line.
 * Returns { url, bounds } for an image overlay, or null.
 */
export function renderGradient({ metric, samples, regions, shapes, fade, proj, allPoints }) {
  const act = samples.filter((s) => s.value != null && isFinite(s.value));
  if (!act.length) return null;
  const { XY, KX, KY } = proj;
  const sp = act.map((d) => [...XY(d.lat, d.lng), d.value]);
  const reg = [...regions];
  shapes.filter((s) => s.type === "boundary").forEach((s) => reg.push([s.coords]));
  let s, n, w, e;
  if (reg.length) {
    const all = reg.flat(2);
    s = Math.min(...all.map((p) => p[0])); n = Math.max(...all.map((p) => p[0]));
    w = Math.min(...all.map((p) => p[1])); e = Math.max(...all.map((p) => p[1]));
  } else {
    const pad = 60;
    s = Math.min(...allPoints.map((p) => p[0])) - pad / KY; n = Math.max(...allPoints.map((p) => p[0])) + pad / KY;
    w = Math.min(...allPoints.map((p) => p[1])) - pad / KX; e = Math.max(...allPoints.map((p) => p[1])) + pad / KX;
  }
  const regXY = reg.map((p) => p.map((r) => r.map((q) => XY(q[0], q[1]))));
  const areas = shapes.filter((x) => x.type === "area").map((x) => [x.coords.map((q) => XY(q[0], q[1]))]);
  const lines = shapes.filter((x) => x.type === "line").map((x) => ({ pts: x.coords.map((q) => XY(q[0], q[1])), hw: (x.width || 5) / 2 }));
  const wm = (e - w) * KX, hm = (n - s) * KY, maxPx = 600;
  const W = Math.max(2, Math.round(wm >= hm ? maxPx : maxPx * wm / hm)), H = Math.max(2, Math.round(hm > wm ? maxPx : maxPx * hm / wm));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"); const img = ctx.createImageData(W, H);
  for (let r = 0; r < H; r++) {
    const lat = n - (r + 0.5) / H * (n - s);
    for (let c = 0; c < W; c++) {
      const lon = w + (c + 0.5) / W * (e - w);
      const [x, y] = XY(lat, lon);
      if (regXY.length && !regXY.some((p) => inRings(x, y, p))) continue;
      if (areas.some((p) => inRings(x, y, p))) continue;
      if (lines.some((l) => { for (let i = 1; i < l.pts.length; i++) if (segDist(x, y, l.pts[i - 1], l.pts[i]) <= l.hw) return true; return false; })) continue;
      let num = 0, den = 0, dmin = 1e9, exact = null;
      for (const [sx, sy, v] of sp) {
        const d = Math.hypot(x - sx, y - sy);
        if (d < dmin) dmin = d;
        if (d < 0.5) { exact = v; break; }
        const wt = 1 / (d * d); num += wt * v; den += wt;
      }
      const v = exact !== null ? exact : num / den;
      let a = 1;
      if (fade) a = dmin <= 45 ? 1 : dmin >= 130 ? 0 : 1 - (dmin - 45) / 85;
      if (a <= 0) continue;
      const col = colorAt(metric, v), i = (r * W + c) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = Math.round(255 * a);
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: cv.toDataURL(), bounds: [[s, w], [n, e]] };
}

/* ── What each test means, in plain English ──────────────────────────────── */
export const NUTRIENTS = [
  { k: "ph", label: "Soil pH", unit: "", why: "pH controls which nutrients roots can actually take up. Above about 7.0, iron and manganese get locked up even when plenty is in the soil — the cause of yellow leaves with green veins (chlorosis) on oaks, birches, maples and other trees that prefer slightly acidic soil. Most trees do best around 6.0–6.5." },
  { k: "om", label: "Organic matter", unit: "%", why: "Decomposed plant material. It holds water and nutrients, feeds soil life and keeps soil loose so roots can breathe. More is generally better for trees; mulch rings and leaving leaves build it over time." },
  { k: "P", label: "Phosphorus", unit: "ppm", why: "Needed for root growth and energy within the plant. Established trees need little, and too much runs off into waterways, so it's only added when a test shows it's low." },
  { k: "K", label: "Potassium", unit: "ppm", why: "Helps trees regulate water, harden off for winter and resist stress and disease." },
  { k: "Ca", label: "Calcium", unit: "ppm", why: "Builds cell walls. Very high calcium usually comes from limestone in the soil or parent rock, and goes hand in hand with high pH." },
  { k: "Mg", label: "Magnesium", unit: "ppm", why: "The centre of the chlorophyll molecule — needed for green leaves. Too much relative to calcium and potassium can tighten soil structure." },
  { k: "S", label: "Sulfur", unit: "ppm", why: "Used to build proteins. Elemental sulfur is also what we apply to slowly bring pH down." },
  { k: "Fe", label: "Iron", unit: "ppm", why: "Needed to make chlorophyll. Iron shortage shows as yellow leaves with green veins, and in high-pH soil it's usually the pH, not a lack of iron, that's the problem." },
  { k: "Mn", label: "Manganese", unit: "ppm", why: "Another chlorophyll helper. Like iron, it becomes hard for roots to take up as pH rises." },
  { k: "Zn", label: "Zinc", unit: "ppm", why: "Needed for leaf and shoot growth; shortage shows as small, crowded leaves." },
  { k: "Cu", label: "Copper", unit: "ppm", why: "Needed in tiny amounts for healthy growth. Low readings are common and rarely cause problems by themselves." },
  { k: "B", label: "Boron", unit: "ppm", why: "Needed in tiny amounts for new growth and buds. The line between too little and too much is narrow." },
  { k: "Al", label: "Aluminum", unit: "ppm", why: "Only a concern in very acidic soil, where it can injure roots. Low numbers are good." },
  { k: "Pb", label: "Lead", unit: "ppm", why: "A safety check. Low numbers mean no lead concern for people or plants." },
  { k: "cec", label: "Cation exchange capacity", unit: "meq/100g", why: "How much nutrient the soil can hold, like the size of a pantry. Clay and organic matter raise it; sandy soil is low." },
  { k: "ca_bs", label: "Calcium base saturation", unit: "%", why: "How much of the soil's nutrient-holding space is taken by calcium. Very high values go with high pH." },
  { k: "mg_bs", label: "Magnesium base saturation", unit: "%", why: "Share of the holding space taken by magnesium." },
  { k: "k_bs", label: "Potassium base saturation", unit: "%", why: "Share of the holding space taken by potassium. Low values mean potassium is crowded out by calcium and magnesium." },
  { k: "exacid", label: "Exchangeable acidity", unit: "meq/100g", why: "Acidity held in the soil. Zero means the soil is not acidic at all." },
];

/** Low / ok / high against a [lo, hi] range (either end may be null). pH uses its target. */
export function rating(k, v, ranges = {}, phTarget) {
  if (v == null || !isFinite(v)) return null;
  if (k === "ph") {
    const t = phTarget || [6.0, 6.8];
    return v < t[0] - 0.3 ? "low" : v > t[1] ? "high" : "ok";
  }
  const r = ranges[k];
  if (!r) return null;
  if (r[0] != null && v < r[0]) return "low";
  if (r[1] != null && v > r[1]) return "high";
  return "ok";
}
export const RATING = {
  low: { label: "Low", color: "#c0392b" },
  ok: { label: "In range", color: "#2e7d32" },
  high: { label: "High", color: "#d35400" },
};
export const fmtVal = (v) => (v == null ? "—" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : String(+(+v).toFixed(2)));
export const fmtDate = (d) => {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (/^\d{4}-\d{2}$/.test(d)) return new Date(d + "-15T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return d;
};

/* ── Tests from other labs / leaf tests ──────────────────────────────────────
   A test can list its own `fields` (key, label, unit) and each sample its own
   lab `ratings` (the lab's words, e.g. "Relatively High"). Labs use different
   methods, so a test is only ever judged against its own lab's ranges. */
export const testDate = (t) => t?.date || t?.received || t?.reported || null;

const EXTRA_WHY = {
  bph: "Buffer pH tells the lab how much lime the soil would need to raise its pH. Only matters when soil is acidic.",
  salts: "Dissolved salts, e.g. from road salt. High levels pull water out of roots and burn evergreen needles.",
  h_bs: "Share of the soil's nutrient-holding space taken by acidity (hydrogen).",
  density: "How heavy a scoop of the soil is; used by the lab in its calculations.",
  N: "Nitrogen drives leaf and shoot growth and green colour.",
  Na: "Sodium — high levels usually mean road salt or salty water.",
};
const LEAF_WHY = {
  N: "Nitrogen in the leaves — drives growth and green colour.",
  P: "Phosphorus in the leaves — energy and root growth.",
  K: "Potassium in the leaves — water control and stress tolerance.",
  Ca: "Calcium in the leaves — cell walls. High leaf calcium is common on limestone soils.",
  Mg: "Magnesium in the leaves — the centre of chlorophyll.",
  S: "Sulfur in the leaves — needed for proteins.",
  B: "Boron in the leaves — new growth and buds.",
  Cu: "Copper in the leaves — needed in small amounts.",
  Fe: "Iron in the leaves — needed to make chlorophyll.",
  Mn: "Manganese in the leaves. Low leaf manganese is a common cause of yellow leaves on trees in high-pH soil, even when the soil has plenty — the roots just can't take it up.",
  Zn: "Zinc in the leaves — leaf and shoot growth.",
  Na: "Sodium in the leaves — high levels point to salt exposure.",
};
export function whyFor(k, test) {
  if (test?.type === "F") return LEAF_WHY[k] || "";
  return NUTRIENTS.find((n) => n.k === k)?.why || EXTRA_WHY[k] || "";
}
export function fieldsFor(test) {
  if (test?.fields?.length) return test.fields;
  return NUTRIENTS.map((n) => ({ k: n.k, label: n.label, unit: n.unit }));
}
const word = (w) => {
  const s = String(w || "").toLowerCase();
  if (/deficient|below|very low|\blow\b/.test(s)) return "low";
  if (/above|very high|high|excess/.test(s)) return "high";
  if (/optimum|medium|normal|sufficient|adequate/.test(s)) return "ok";
  return null;
};
/** low / ok / high for one value of one sample. */
export function rate(test, sample, k) {
  const v = sample?.values?.[k];
  if (sample?.ratings?.[k]) return word(sample.ratings[k]);
  if (test?.type === "F") {
    const r = test.ranges?.[k]; if (!r || v == null) return null;
    return r[0] != null && v < r[0] ? "low" : r[1] != null && v > r[1] ? "high" : "ok";
  }
  return rating(k, v, test?.ranges, test?.phTarget);
}
/** Which map colour layers make sense for a test. The colour scales are set
    for Modified Morgan ppm; other methods only get pH and organic matter. */
export function metricsFor(test, samples) {
  if (!test || test.type === "F") return [];
  const has = (m) => samples.some((s) => s.values?.[m] != null);
  const ok = test.method === "Modified Morgan" && !test.fields ? METRIC_ORDER : ["ph", "om"];
  return ok.filter(has);
}
