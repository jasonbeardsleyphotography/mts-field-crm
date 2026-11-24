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
