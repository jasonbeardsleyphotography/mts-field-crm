/* ═══════════════════════════════════════════════════════════════════════════
   Linkify — turns phone numbers in plain text into tappable tel: links.
   ───────────────────────────────────────────────────────────────────────────
   Why this exists: Notes in calendar event descriptions often contain phone
   numbers like "call wife Kellyn when OTW 702-496-6050". On mobile we want
   that number to be a one-tap dial. Plain text spans don't do that, and the
   surrounding card is a swipeable target so users can't easily select the
   number to copy it either.

   Recognized formats:
     - 555-555-5555
     - (555) 555-5555
     - 555.555.5555
     - 5555555555
     - +1 555 555 5555

   Email addresses are also linkified to mailto:.

   Each link calls stopPropagation on its tap so it doesn't trigger the
   parent card's swipe / expand handlers.
   ═══════════════════════════════════════════════════════════════════════════ */

// US phone numbers — reasonable but not exhaustive. Avoids matching things
// like "1234567890123" (too long) or random groups of digits. The negative
// lookbehind/lookahead prevent matching within a longer digit string.
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Combined matcher — we walk through the string finding either pattern,
// whichever comes first, so we don't double-process.
function* tokenize(text) {
  if (!text) return;
  let cursor = 0;
  // Reset both regexes for repeated calls
  PHONE_RE.lastIndex = 0;
  EMAIL_RE.lastIndex = 0;
  const phones = [...text.matchAll(PHONE_RE)].map(m => ({ kind: "phone", start: m.index, end: m.index + m[0].length, value: m[0] }));
  const emails = [...text.matchAll(EMAIL_RE)].map(m => ({ kind: "email", start: m.index, end: m.index + m[0].length, value: m[0] }));
  const matches = [...phones, ...emails].sort((a, b) => a.start - b.start);
  // Filter overlaps — keep first when they collide (rare; emails won't match phone patterns)
  const clean = [];
  for (const m of matches) {
    if (clean.length && m.start < clean[clean.length - 1].end) continue;
    clean.push(m);
  }
  for (const m of clean) {
    if (m.start > cursor) yield { kind: "text", value: text.slice(cursor, m.start) };
    yield m;
    cursor = m.end;
  }
  if (cursor < text.length) yield { kind: "text", value: text.slice(cursor) };
}

function normalizePhone(raw) {
  // Strip everything except digits and leading +
  const cleaned = raw.replace(/[^\d+]/g, "");
  // tel: URIs accept the cleaned form directly; iOS handles formatting.
  return cleaned;
}

export default function Linkify({ text, style, linkColor = "#3B82F6" }) {
  if (!text) return null;
  const parts = [...tokenize(text)];
  const linkStyle = {
    color: linkColor,
    textDecoration: "underline",
    textDecorationColor: `${linkColor}77`,
    fontWeight: 700,
  };
  return (
    <span style={style}>
      {parts.map((p, i) => {
        if (p.kind === "phone") {
          return (
            <a
              key={i}
              href={`tel:${normalizePhone(p.value)}`}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              style={linkStyle}
            >{p.value}</a>
          );
        }
        if (p.kind === "email") {
          return (
            <a
              key={i}
              href={`mailto:${p.value}`}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              style={linkStyle}
            >{p.value}</a>
          );
        }
        return <span key={i}>{p.value}</span>;
      })}
    </span>
  );
}
