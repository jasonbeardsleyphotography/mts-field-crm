import { tagColor } from "./backlogModel";

/* A SingleOps-style tag: a rounded pill with the tag's colour dot and its full
   name. `state` "inc" = picked (outlined in the tag's colour, with a check),
   "exc" = excluded (red outline, struck through). */
export default function TagPill({ tag, state, count, onClick, small }) {
  const col = tagColor(tag);
  const Tag = onClick ? "button" : "span";
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
