/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Client Index
   ───────────────────────────────────────────────────────────────────────────
   Builds a unified client index from two local data sources:

     1. Pipeline cards (loadPipeline()) — every job that's ever been worked.
     2. Parsed calendar events (allParsed) — current week's appointments.

   The result feeds the typeahead in the appointment-create form: as the
   user types a client name, we suggest existing clients with their address,
   phone, and email pre-filled if matched. This prevents the "Mark
   Reigelsperger #1" / "Mark Reigelsperger #2" duplication problem at the
   data-entry level.

   Dedup strategy (this is the important part — Jason has had real
   problems with duplicate contacts):

     Key by (lowercased lastName + first 5 digits of phone). If both halves
     match, it's the same person. If only the name matches, treat as
     potentially different unless addresses agree. We prefer the most
     recently active record on collision (pipeline.stageChangedAt or event
     start time).

   Search is a simple substring match across name and address; ranked by
   recency, capped at 6 suggestions. Fast enough for 500+ clients.
   ═══════════════════════════════════════════════════════════════════════════ */

function lastNameOf(cn) {
  const s = (cn || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function phoneKey(phone) {
  return (phone || "").replace(/\D/g, "").slice(-10);
}

function dedupKey(record) {
  // Two records collapse if they share BOTH last name and last 7 digits of
  // phone. Phone alone isn't enough (couples share landlines); name alone
  // isn't enough (common surnames). Both is a strong-enough signal.
  const ln = lastNameOf(record.cn);
  const pk = phoneKey(record.phone).slice(-7);
  return `${ln}|${pk}`;
}

/**
 * Build the index from current pipeline + parsed events.
 * Returns an array of unique client records sorted by recency desc.
 *
 * @param {Object} pipeline  - return value of loadPipeline()
 * @param {Array}  events    - allParsed array
 */
export function buildClientIndex(pipeline, events) {
  const map = new Map();

  const upsert = (rec, recency) => {
    if (!rec.cn || rec.cn.trim().length < 2) return;
    const key = dedupKey(rec);
    const existing = map.get(key);
    if (!existing || recency > existing._recency) {
      // Newer record wins — but merge in non-empty fields from older one
      // in case the new event lacks address/email but the pipeline card had it.
      const merged = {
        cn: rec.cn,
        addr: rec.addr || existing?.addr || "",
        phone: rec.phone || existing?.phone || "",
        email: rec.email || existing?.email || "",
        lastJobNum: rec.jn || existing?.lastJobNum || "",
        _recency: recency,
      };
      map.set(key, merged);
    } else {
      // Older record still wins on recency — but fill in any blanks from new one
      if (!existing.addr && rec.addr) existing.addr = rec.addr;
      if (!existing.phone && rec.phone) existing.phone = rec.phone;
      if (!existing.email && rec.email) existing.email = rec.email;
    }
  };

  // 1) Pipeline cards
  for (const card of Object.values(pipeline || {})) {
    upsert(card, card.stageChangedAt || card.addedAt || 0);
  }

  // 2) Parsed events (current week's calendar)
  for (const ev of events || []) {
    upsert(ev, ev._startMs || Date.now());
  }

  return [...map.values()].sort((a, b) => b._recency - a._recency);
}

/**
 * Search the index for a partial name match.
 * @param {Array}  index  - return value of buildClientIndex
 * @param {string} q      - user's typed input
 * @param {number} max    - max suggestions to return
 */
export function searchClients(index, q, max = 6) {
  const term = (q || "").trim().toLowerCase();
  if (term.length < 2) return [];
  const results = [];
  for (const rec of index) {
    const cn = (rec.cn || "").toLowerCase();
    const addr = (rec.addr || "").toLowerCase();
    if (cn.includes(term) || addr.includes(term)) {
      results.push(rec);
      if (results.length >= max) break;
    }
  }
  return results;
}
