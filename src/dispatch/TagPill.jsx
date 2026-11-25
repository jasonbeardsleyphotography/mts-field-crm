import { tagColor } from "./backlogModel";

/* A SingleOps-style tag: a rounded pill with the tag's colour dot and its full
   name. `state` "inc" = picked (outlined in the tag's colour, with a check),
   "exc" = excluded (red outline, struck through). */
export default function TagPill({ tag, state, count, onClick, small, filled }) {
  const col = tagColor(tag);
  const Tag = onClick ? "button" : "span";
  if (filled) {
    const n = parseInt(col.slice(1), 16), lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    const light = lum > 175 && state !== "exc";                 // yellow etc.: dark text reads better than white
    // big, filled with the tag's colour, bright white text + border (owner, Nov 25: easier to read)
    return (
      <Tag onClick={onClick} title={state === "inc" ? "Must have — tap again for must NOT have" : state === "exc" ? "Must NOT have — tap again to clear" : "Tap = must have"}
           style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, background: state === "exc" ? "#2a2f33" : col,
                    border: state ? "3px solid #ffffff" : "1.5px solid rgba(255,255,255,.85)", color: light ? "#111" : "#ffffff", fontSize: 13, fontWeight: 700, letterSpacing: ".02em",
                    textShadow: light ? "none" : "0 1px 2px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.9)", whiteSpace: "nowrap", cursor: onClick ? "pointer" : "default", fontFamily: "inherit",
                    textDecoration: state === "exc" ? "line-through" : "none", boxShadow: state === "inc" ? "0 0 0 2px rgba(23,160,91,.9)" : "none" }}>
        {state === "inc" ? "✓ " : state === "exc" ? "✕ " : ""}{tag}
        {count != null && <b style={{ fontWeight: 600, opacity: 0.9 }}>{count}</b>}
      </Tag>
    );
  }
  return (
    <Tag onClick={onClick} title={state === "inc" ? "Must have" : state === "exc" ? "Must NOT have" : undefined}
         style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: small ? "2px 8px 2px 5px" : "3px 10px 3px 6px", borderRadius: 999,
                  background: "#20272d", border: `1.5px solid ${state === "inc" ? col : state === "exc" ? "#D93B2B" : "#38434b"}`,
                  color: "#d9d4c8", fontSize: small ? 10.5 : 11.5, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap",
                  textDecoration: state === "exc" ? "line-through" : "none", cursor: onClick ? "pointer" : "default", fontFamily: "inherit" }}>
      <i style={{ width: small ? 9 : 11, height: small ? 9 : 11, borderRadius: "50%", background: col, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", fontStyle: "normal", fontSize: 8, color: "#fff" }}>
        {state === "inc" ? "✓" : state === "exc" ? "✕" : ""}
      </i>
      {tag}
      {count != null && <b style={{ fontWeight: 500, color: "#7d8a94", marginLeft: 2 }}>{count}</b>}
    </Tag>
  );
}

/* A job's tags in a tidy row for lists (owner, Nov 24: pills in narrow rows looked
   scattered): all the same size, always in the same order (by tag number), short names
   ("02 LIFT REGULAR" → "LIFT REGULAR"), the colour dot says which group; the full name is
   on hover. Wraps cleanly; never wider than the row. */
const short = (t) => t.replace(/^\d\d\s+/, "").replace(/^#(\d) PERSON$/, "$1-PERSON");
export function TagRow({ tags, max }) {
  const list = [...(tags || [])].sort((a, b) => a.localeCompare(b));
  const shown = max ? list.slice(0, max) : list;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4, minWidth: 0 }}>
      {shown.map((t) => (
        <span key={t} title={t}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 18, padding: "0 6px 0 5px", borderRadius: 9, maxWidth: 150,
                       background: "#1d2328", border: "1px solid #333d45", fontSize: 10.5, fontWeight: 600, letterSpacing: ".02em",
                       color: "#d4cfc3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textTransform: "uppercase" }}>
          <i style={{ width: 7, height: 7, borderRadius: "50%", background: tagColor(t), flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{short(t)}</span>
        </span>
      ))}
      {max && list.length > max && <span className="hint" style={{ padding: 0, fontSize: 10.5 }}>+{list.length - max}</span>}
    </div>
  );
}

/* TAG STRIP (owner, Nov 24: the tag rows were still "all over the place"). Every job
   row shows the same five fixed columns, in the same place, so the eye can run down
   the list:  CREW | AERIAL | EQUIPMENT | SEASON | CALL. Each mark is a short code in
   a fixed-width box; hover (or open the job) for the full tag names. */
const STRIP = [
  { key: "crew", w: 40, items: [[/^#2 PERSON$/, "2P"], [/^#3 PERSON$/, "3P"], [/^#4 PERSON$/, "4P"]], join: true },
  { key: "aerial", w: 92, items: [[/^02 BUCKET$/, "BKT"], [/^02 LIFT( REGULAR)?$/, "LIFT"], [/^02 LIFT TALL/, "TALL"], [/^02 CLIMB/, "CLMB"], [/^02 GROUND$/, "GRND"], [/^02 REQUIRED$/, "REQ"]] },
  { key: "equip", w: 104, items: [[/^03 AVANT$/, "AVNT"], [/^03 AVANT[_]BIG$/, "755"], [/^03 BIG CHIP$/, "19XP"], [/^03 WOOD TRUCK$/, "WOOD"], [/^03 CRANE$/, "CRANE"], [/^07 STUMPS$/, "STMP"]] },
  { key: "season", w: 80, items: [[/^08 WINTER$/, "WIN"], [/^08 SPRING$/, "SPR"], [/^08 SUMMER$/, "SUM"], [/^08 (FALL|AUTUMN)$/, "FALL"], [/^08 OAK/, "OAK"]] },
];
const STRIP_COLORS = { crew: "#ff1f8f", aerial: "#33cc33", equip: "#b0703f", season: "#a8a820" };
export function TagStrip({ tags }) {
  const T = tags || [];
  // the client-call tags only (owner, Nov 25) — same list as crewCheck's CALLS
  const calls = T.filter((t) => /^09 (MUST BE HOME|NEIGHBOR PERMISSION|OBSTACLE|APPT\. SCHEDULED|PET WASTE|SHORT)$|^07 (EXTRA NOTICE|SCHEDULE \(DATE\)|SCHEDULE \(DAY\))$/.test(t));
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", minWidth: 0 }} title={T.join(" · ")}>
      {STRIP.map((col) => {
        const hits = [];
        col.items.forEach(([re, code]) => { const t = T.find((x) => re.test(x)); if (t && !hits.some((h) => h.code === code)) hits.push({ code, t }); });
        const marks = col.join && hits.length ? [{ code: hits.map((h) => h.code.replace("P", "")).join("/") + "P", t: hits.map((h) => h.t).join(", ") }] : hits;
        return (
          <span key={col.key} style={{ flex: `0 0 ${col.w}px`, display: "flex", gap: 2, overflow: "hidden" }}>
            {marks.map((m) => (
              <span key={m.code} title={m.t} style={{ fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 10, fontWeight: 600, lineHeight: "15px", padding: "0 3px",
                                                     borderRadius: 2, background: "#232b31", color: "#e3ded2", borderBottom: `2px solid ${STRIP_COLORS[col.key]}`, whiteSpace: "nowrap" }}>{m.code}</span>
            ))}
          </span>
        );
      })}
      {calls.length > 0 && <span title={`Confirm with the client:\n${calls.join("\n")}`} style={{ fontSize: 10.5, color: "#f0c050", whiteSpace: "nowrap" }}>☎</span>}
    </div>
  );
}
/** The key to the strip's codes. */
export function TagStripKey() {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 10.5, color: "#98A3AB" }}>
      <span><b style={{ color: STRIP_COLORS.crew }}>▬</b> crew size (2P, 3P, 2/3P)</span>
      <span><b style={{ color: STRIP_COLORS.aerial }}>▬</b> aerial (BKT bucket, LIFT, TALL 100HD, CLMB, GRND, REQ)</span>
      <span><b style={{ color: STRIP_COLORS.equip }}>▬</b> equipment (AVNT, 755 big Avant, 19XP big chipper, WOOD, CRANE, STMP)</span>
      <span><b style={{ color: STRIP_COLORS.season }}>▬</b> season (WIN SPR SUM FALL OAK)</span>
      <span style={{ color: "#f0c050" }}>☎ confirm with the client when calling</span>
    </div>
  );
}
