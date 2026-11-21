/* ═══════════════════════════════════════════════════════════════════════════
   Soil API — /api/soil/*
   ───────────────────────────────────────────────────────────────────────────
   Property soil maps and lab results. Blobs store "mts-soil":
     index                 [{ id, name, client, address, samples, lastTest }]
     site/<id>             the whole property record (see below)
     pdf/<id>/<key>        a lab report PDF
     link/<token>          { site, createdAt } — a client's private link
   Site record: { id, name, client, address, zip, center, shapes[], history{events[], counts, open_items},
                  tests[{ id, date, reported, lab, order, type, units, ranges, note, samples[] }],
                  treeSchema, links[{ token, createdAt, revoked }] }

   Staff (Soil permission) see everything. Admins can change things.
   A client link sees ONE property, read-only, and the server removes every
   "internal" field (dollar amounts, hours) and the link list before sending.
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { caller } from "../lib/session.mjs";

const S = () => getStore("mts-soil");
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "no-store" };
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...NOINDEX } });

const idOk = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(v);
const keyOk = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.pdf$/i.test(v);
const tokenOk = (v) => typeof v === "string" && /^[a-z0-9]{24,48}$/.test(v);

async function getJSON(key, fallback = null) {
  try { const raw = await S().get(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
const putJSON = (key, v) => S().set(key, JSON.stringify(v));

/** What a client is allowed to see: no internal fields, no links. */
function clientView(site) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (k !== "internal" && k !== "links") o[k] = strip(x);
      return o;
    }
    return v;
  };
  return strip(site);
}

function indexEntry(site) {
  const tests = site.tests || [];
  return {
    id: site.id, name: site.name, client: site.client || "", address: site.address || "",
    samples: tests.reduce((n, t) => n + (t.samples?.length || 0), 0),
    lastTest: tests.map((t) => t.date).filter(Boolean).sort().pop() || null,
    mapped: tests.some((t) => (t.samples || []).some((s) => s.lat != null)),
  };
}
async function saveSite(site) {
  await putJSON(`site/${site.id}`, site);
  const idx = (await getJSON("index", [])).filter((e) => e.id !== site.id);
  idx.push(indexEntry(site));
  idx.sort((a, b) => a.name.localeCompare(b.name));
  await putJSON("index", idx);
}

const randomToken = () => {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 36);
};

async function clientSite(token) {
  if (!tokenOk(token)) return null;
  const link = await getJSON(`link/${token}`);
  if (!link?.site) return null;
  const site = await getJSON(`site/${link.site}`);
  if (!site) return null;
  const rec = (site.links || []).find((l) => l.token === token);
  if (!rec || rec.revoked) return null;
  return site;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/(api\/soil|\.netlify\/functions\/soil)\/?/, "").replace(/\/$/, "");
  const q = (k) => url.searchParams.get(k);
  const method = req.method;

  // ── client (private link) ────────────────────────────────────────────────
  if (route === "public" && method === "GET") {
    const site = await clientSite(q("t"));
    if (!site) return json({ error: "link_not_valid" }, 404);
    return json({ site: clientView(site) });
  }
  if (route === "pdf" && method === "GET" && q("t")) {
    const site = await clientSite(q("t"));
    if (!site || site.id !== q("site") || !keyOk(q("key"))) return json({ error: "not_found" }, 404);
    return pdfResponse(site.id, q("key"));
  }

  // ── staff ─────────────────────────────────────────────────────────────────
  const me = await caller(req, getStore);
  if (!me) return json({ error: "signed_out" }, 401);
  if (route === "me") return json(me);
  const canSee = me.perms.soil || me.perms.admin;
  const canEdit = me.perms.admin;
  if (!canSee) return json({ error: "no_soil_access" }, 403);

  if (route === "sites" && method === "GET") return json({ sites: await getJSON("index", []) });

  if (route === "site" && method === "GET") {
    if (!idOk(q("id"))) return json({ error: "bad_id" }, 400);
    const site = await getJSON(`site/${q("id")}`);
    if (!site) return json({ error: "not_found" }, 404);
    if (!canEdit) delete site.links;
    return json({ site, canEdit });
  }

  if (route === "pdf" && method === "GET") {
    if (!idOk(q("site")) || !keyOk(q("key"))) return json({ error: "bad_request" }, 400);
    return pdfResponse(q("site"), q("key"));
  }

  if (!canEdit) return json({ error: "admins_only" }, 403);

  if (route === "site" && method === "PUT") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_data" }, 400); }
    const site = b?.site;
    if (!site || !idOk(site.id) || !site.name || !Array.isArray(site.tests)) return json({ error: "bad_data" }, 400);
    const old = await getJSON(`site/${site.id}`);
    site.links = old?.links || [];                  // links are only changed through /link
    if (!b.replaceShapes && old?.shapes?.length && !site.shapes?.length) site.shapes = old.shapes;
    // Re-importing must not lose pins placed by hand.
    for (const t of site.tests) for (const smp of t.samples || []) {
      if (smp.lat != null) continue;
      const o = old?.tests?.find((x) => x.id === t.id)?.samples?.find((x) => x.id === smp.id);
      if (o?.lat != null) { smp.lat = o.lat; smp.lng = o.lng; }
    }
    if (!site.center && old?.center) site.center = old.center;
    if (!site.center && site.address && !site.tests.some((t) => (t.samples || []).some((x) => x.lat != null))) {
      site.center = await geocodeAddress(site.address);
    }
    site.updatedAt = Date.now(); site.updatedBy = me.name || me.email;
    await saveSite(site);
    return json({ ok: true, id: site.id });
  }

  if (route === "shapes" && method === "PUT") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_data" }, 400); }
    if (!idOk(b?.id) || !Array.isArray(b.shapes)) return json({ error: "bad_data" }, 400);
    const site = await getJSON(`site/${b.id}`);
    if (!site) return json({ error: "not_found" }, 404);
    site.shapes = b.shapes.filter((s) => ["boundary", "area", "line"].includes(s?.type) && Array.isArray(s.coords))
      .map((s) => ({ type: s.type, name: String(s.name || "").slice(0, 60), coords: s.coords.map((p) => [+p[0], +p[1]]), ...(s.type === "line" ? { width: +s.width || 5 } : {}) }));
    await saveSite(site);
    return json({ ok: true, shapes: site.shapes });
  }

  if (route === "samples" && method === "PUT") {
    // Place / move sample pins: { id, positions: { "<testId>/<sampleId>": [lat, lng] | null } }
    let b; try { b = await req.json(); } catch { return json({ error: "bad_data" }, 400); }
    if (!idOk(b?.id) || typeof b.positions !== "object") return json({ error: "bad_data" }, 400);
    const site = await getJSON(`site/${b.id}`);
    if (!site) return json({ error: "not_found" }, 404);
    for (const t of site.tests || []) for (const s of t.samples || []) {
      const p = b.positions[`${t.id}/${s.id}`];
      if (p === null) { delete s.lat; delete s.lng; }
      else if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) { s.lat = +p[0]; s.lng = +p[1]; }
    }
    await saveSite(site);
    return json({ ok: true });
  }

  if (route === "pdf" && method === "PUT") {
    if (!idOk(q("site")) || !keyOk(q("key"))) return json({ error: "bad_request" }, 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 5.5e6 || buf.byteLength < 100) return json({ error: "bad_size" }, 400);
    if (new TextDecoder().decode(new Uint8Array(buf.slice(0, 5))) !== "%PDF-") return json({ error: "not_a_pdf" }, 400);
    await S().set(`pdf/${q("site")}/${q("key")}`, buf);
    return json({ ok: true });
  }

  if (route === "link" && method === "POST") {
    let b; try { b = await req.json(); } catch { b = {}; }
    if (!idOk(b?.site)) return json({ error: "bad_id" }, 400);
    const site = await getJSON(`site/${b.site}`);
    if (!site) return json({ error: "not_found" }, 404);
    const token = randomToken();
    await putJSON(`link/${token}`, { site: site.id, createdAt: Date.now() });
    site.links = [...(site.links || []), { token, createdAt: Date.now(), by: me.name || me.email }];
    await saveSite(site);
    return json({ ok: true, token, url: `${url.origin}/soil/c/${token}` });
  }
  if (route === "link" && method === "DELETE") {
    const site = idOk(q("site")) && await getJSON(`site/${q("site")}`);
    if (!site) return json({ error: "not_found" }, 404);
    site.links = (site.links || []).map((l) => (l.token === q("token") ? { ...l, revoked: Date.now() } : l));
    await saveSite(site);
    try { await S().delete(`link/${q("token")}`); } catch {}
    return json({ ok: true, links: site.links });
  }

  if (route === "site" && method === "DELETE") {
    if (!idOk(q("id"))) return json({ error: "bad_id" }, 400);
    const site = await getJSON(`site/${q("id")}`);
    for (const l of site?.links || []) { try { await S().delete(`link/${l.token}`); } catch {} }
    await S().delete(`site/${q("id")}`);
    await putJSON("index", (await getJSON("index", [])).filter((e) => e.id !== q("id")));
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
};

/** Property location from its address (US Census geocoder, free, no key). */
async function geocodeAddress(address) {
  try {
    const u = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" +
      new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const m = (await r.json())?.result?.addressMatches?.[0]?.coordinates;
    return m && isFinite(m.y) && isFinite(m.x) ? { lat: m.y, lng: m.x } : null;
  } catch { return null; }
}

async function pdfResponse(siteId, key) {
  const buf = await S().get(`pdf/${siteId}/${key}`, { type: "arrayBuffer" });
  if (!buf) return json({ error: "not_found" }, 404);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${key.replace(/"/g, "")}"`,
      ...NOINDEX,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
