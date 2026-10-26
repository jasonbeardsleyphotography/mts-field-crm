/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Contacts cleanup
   ───────────────────────────────────────────────────────────────────────────
   Finds duplicate client contacts this app created and removes the extras.

   They exist because the auto-push kept no durable record for a client with no
   phone number, and committed the "already pushed" list only after its whole
   loop finished — so every calendar reload that interrupted the loop started
   over and created the same people again.

   Nothing here touches a contact this app did not create. The filter is
   deliberately narrow: the given name must carry the app's own "CLIENT "
   prefix, or the notes field must carry its own signature line. A contact with
   no duplicate is never a candidate, and every group keeps one.
   ═══════════════════════════════════════════════════════════════════════════ */

const PEOPLE = "https://people.googleapis.com/v1";
const APP_NOTE = "MTS Rochester Tree Service Client";
const NAME_PREFIX = "CLIENT ";

async function api(token, path, opts = {}) {
  const res = await fetch(`${PEOPLE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`Contacts ${res.status}`);
    err.status = res.status;
    try { err.detail = (await res.json())?.error?.message || ""; } catch {}
    throw err;
  }
  return res.json();
}

/** Every contact in "My Contacts", paginated. */
export async function listAllContacts(token, onProgress) {
  const out = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      personFields: "names,phoneNumbers,emailAddresses,addresses,biographies,clientData,metadata",
      pageSize: "1000",
      sortOrder: "LAST_MODIFIED_ASCENDING",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const d = await api(token, `/people/me/connections?${params}`);
    for (const p of d.connections || []) out.push(p);
    pageToken = d.nextPageToken || null;
    onProgress?.(out.length);
  } while (pageToken);
  return out;
}

/** Was this contact created by this app? Narrow on purpose. */
export function isAppContact(person) {
  const given = person?.names?.[0]?.givenName || "";
  if (given.startsWith(NAME_PREFIX)) return true;
  return (person?.biographies || []).some(b => String(b?.value || "").includes(APP_NOTE));
}

const digits = (v) => String(v || "").replace(/\D/g, "");

/** A phone number reduced to its last 10 digits. Google may store a number as
 *  "+1 585-555-0101" while the calendar has "585-555-0101"; compared as raw
 *  digits those differ ("15855550101" vs "5855550101"), which made a client
 *  already in Contacts look new. */
export const phone10 = (v) => { const d = digits(v); return d.length > 10 ? d.slice(-10) : d; };

/** The tag this app writes on every contact it creates (People API clientData,
 *  which is private to this app). Lets it recognise its own contacts even if a
 *  phone number or email is later edited. */
export const CLIENT_KEY_FIELD = "mtsClientKey";

/** The one key that identifies a client: phone, else email, else name+address. */
export function clientKeyFor({ phone, email, cn, addr } = {}) {
  const p = phone10(phone);
  if (p) return `p:${p}`;
  const e = String(email || "").trim().toLowerCase();
  if (e) return `e:${e}`;
  const n = String(cn || "").trim().toLowerCase();
  return n ? `n:${n}|${String(addr || "").trim().toLowerCase()}` : null;
}

/**
 * Every client key already present in "My Contacts", mapped to its contact.
 *
 * Read from the full contact LIST, not from search. Google's contact search is
 * indexed lazily and routinely misses a contact created a few minutes earlier
 * — on another device, say — which is how a client added from the phone got
 * added again from the Chromebook. The list reflects what is actually there.
 */
export async function loadContactIndex(token) {
  const people = await listAllContacts(token);
  const idx = new Map();
  for (const p of people) {
    const rn = p.resourceName;
    for (const ph of p.phoneNumbers || []) { const k = phone10(ph.value); if (k) idx.set(`p:${k}`, rn); }
    for (const em of p.emailAddresses || []) { const k = String(em.value || "").trim().toLowerCase(); if (k) idx.set(`e:${k}`, rn); }
    for (const cd of p.clientData || []) { if (cd?.key === CLIENT_KEY_FIELD && cd.value) idx.set(cd.value, rn); }
  }
  return idx;
}

/** Identity for grouping: the same person, however the record was built. */
function identityOf(person) {
  const n = person?.names?.[0] || {};
  const name = `${n.givenName || ""} ${n.familyName || ""}`
    .replace(new RegExp(`^${NAME_PREFIX}`), "")
    .trim().toLowerCase().replace(/\s+/g, " ");
  const phone = phone10(person?.phoneNumbers?.[0]?.value);
  const email = (person?.emailAddresses?.[0]?.value || "").trim().toLowerCase();
  // Phone is the strongest signal; fall back through email, then the name.
  if (phone) return `p:${phone}`;
  if (email) return `e:${email}`;
  return name ? `n:${name}` : null;
}

// How complete a record is, so the copy we keep is the richest one.
function richness(person) {
  return (person?.phoneNumbers?.length || 0) * 4
       + (person?.emailAddresses?.length || 0) * 3
       + (person?.addresses?.length || 0) * 2
       + (person?.biographies?.length || 0);
}

/**
 * Group app-created contacts into duplicate sets.
 * Returns { groups, deletable, scanned, appContacts } where deletable is a
 * flat list of people safe to remove. Every group keeps exactly one.
 */
export function findDuplicateContacts(people) {
  const appContacts = people.filter(isAppContact);
  const byIdentity = new Map();
  for (const p of appContacts) {
    const id = identityOf(p);
    if (!id) continue;
    if (!byIdentity.has(id)) byIdentity.set(id, []);
    byIdentity.get(id).push(p);
  }
  const groups = [];
  const deletable = [];
  for (const [id, list] of byIdentity) {
    if (list.length < 2) continue;   // a lone contact is never a duplicate
    // Keep the richest; ties go to the oldest, which is the one most likely to
    // already be synced to the phone and known to iOS.
    const sorted = [...list].sort((a, b) => {
      const r = richness(b) - richness(a);
      if (r) return r;
      const at = a.metadata?.sources?.[0]?.updateTime || "";
      const bt = b.metadata?.sources?.[0]?.updateTime || "";
      return String(at).localeCompare(String(bt));
    });
    const keep = sorted[0];
    const drop = sorted.slice(1);
    groups.push({ id, name: (keep.names?.[0]?.displayName) || id, keep, drop });
    deletable.push(...drop);
  }
  groups.sort((a, b) => b.drop.length - a.drop.length);
  return { groups, deletable, scanned: people.length, appContacts: appContacts.length };
}

/** Delete in batches. The API caps a batch at 500; 200 keeps each request small
 *  and the progress readout honest. */
export async function deleteContacts(token, resourceNames, onProgress) {
  let done = 0, failed = 0;
  for (let i = 0; i < resourceNames.length; i += 200) {
    const chunk = resourceNames.slice(i, i + 200);
    try {
      await api(token, "/people:batchDeleteContacts", {
        method: "POST",
        body: JSON.stringify({ resourceNames: chunk }),
      });
      done += chunk.length;
    } catch {
      failed += chunk.length;
    }
    onProgress?.({ done, failed, total: resourceNames.length });
  }
  return { done, failed };
}
