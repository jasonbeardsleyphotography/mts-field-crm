/* ═══════════════════════════════════════════════════════════════════════════
   Dispatch API — /api/dispatch/*
   ───────────────────────────────────────────────────────────────────────────
   Server side of the Dispatch tools (/dispatch) and the owner's Admin screen.
   Kept apart from the field app: its own Blobs stores ("mts-dispatch",
   "mts-admin") and its own session cookie (mts_dsess).

   Who is calling — checked in this order:
     1. A Dispatch session (mts_dsess), made by redeeming a sign-in link. This
        is how people without a Google account get in: the owner makes a link
        on the Admin screen and sends it to them. No email service and nobody
        else's permission is needed.
     2. The field app's lasting Google sign-in on the same browser (mts_sess),
        which already records the account's email.
   What they may do comes from appPermissions() (netlify/lib/accounts.mjs):
   the owner always has everything.

   Routes
     GET    me                      who am I + permissions
     POST   redeem   {code}         sign-in link → session cookie
     POST   logout
     GET    users                   (admin) the user list
     PUT    users    {email,name,apps}
     DELETE users?email=
     POST   link     {email}        (admin) one-time sign-in link, 14 days
     GET    backlog                 (dispatch) the last uploaded workbook data
     PUT    backlog  {…}            (dispatch) replace it
     POST   geocode  {items:[{id,addr}]}  (dispatch) lat/lng, cached
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore } from "@netlify/blobs";
import { parseCookies, appPermissions, loadUserList, forgetUserCache, isOwnerEmail, APPS } from "../lib/accounts.mjs";
import { caller as sessionCaller } from "../lib/session.mjs";

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

const D = () => getStore("mts-dispatch");
const SESS_DAYS = 400;
const LINK_DAYS = 14;
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const caller = (req) => sessionCaller(req, getStore);

const randomCode = () => {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 32);
};

// ── Geocoding: US Census batch geocoder (free, no key). Results cached by
//    address so each address is looked up once. ──────────────────────────────
async function censusBatch(items) {
  const csv = items.map((it, i) => {
    const m = String(it.addr).replace(/,\s*USA$/i, "").split(",").map((x) => x.trim());
    const street = m[0] || "", city = m[1] || "";
    const sz = (m[2] || "").match(/([A-Z]{2})\s*(\d{5})?/i) || [];
    const q = (v) => `"${String(v || "").replace(/"/g, "")}"`;
    return [i, q(street), q(city), q(sz[1] || "NY"), q(sz[2] || "")].join(",");
  }).join("\n");
  const fd = new FormData();
  fd.append("addressFile", new Blob([csv], { type: "text/csv" }), "a.csv");
  fd.append("benchmark", "Public_AR_Current");
  const r = await fetch("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`census ${r.status}`);
  const out = {};
  for (const line of (await r.text()).split("\n")) {
    const cells = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (!cells || cells.length < 6) continue;
    const idx = Number(cells[0]);
    if (cells[2] === "Match" && cells[5]) {
      const [lng, lat] = cells[5].split(",").map(Number);
      if (isFinite(lat) && isFinite(lng)) out[idx] = { lat, lng };
    }
  }
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/(api\/dispatch|\.netlify\/functions\/dispatch)\/?/, "").replace(/\/$/, "");
  const method = req.method;
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  // ── sign-in ────────────────────────────────────────────────────────────
  if (route === "redeem" && method === "POST") {
    const { code } = await body();
    if (!code || !/^[a-z0-9]{20,40}$/.test(code)) return json({ error: "bad_link" }, 400);
    const raw = await D().get(`link/${code}`);
    if (!raw) return json({ error: "link_used_or_unknown" }, 404);
    const link = JSON.parse(raw);
    await D().delete(`link/${code}`);                       // one use only
    if (Date.now() > link.exp) return json({ error: "link_expired" }, 410);
    const perms = await appPermissions(link.email, getStore);
    if (!perms.dispatch && !perms.shop && !perms.soil && !perms.admin) return json({ error: "no_access" }, 403);
    const sid = crypto.randomUUID();
    await D().set(`sess/${sid}`, JSON.stringify({ email: link.email, createdAt: Date.now() }));
    return json({ ok: true, email: link.email }, 200, {
      "Set-Cookie": `mts_dsess=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESS_DAYS * 86400}`,
    });
  }
  if (route === "logout" && method === "POST") {
    const sid = parseCookies(req.headers.get("cookie")).mts_dsess;
    if (sid) { try { await D().delete(`sess/${sid}`); } catch {} }
    return json({ ok: true }, 200, { "Set-Cookie": "mts_dsess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  const me = await caller(req);
  if (route === "me") {
    if (!me) return json({ error: "signed_out" }, 401);
    return json(me);
  }
  if (!me) return json({ error: "signed_out" }, 401);

  // ── admin: users ─────────────────────────────────────────────────────────
  if (route === "users" || route === "link") {
    if (!me.perms.admin) return json({ error: "admins_only" }, 403);
    const store = getStore("mts-admin");
    const list = (await loadUserList(getStore, true)) || {};
    if (route === "users" && method === "GET") return json({ users: list });
    if (route === "users" && method === "PUT") {
      const b = await body();
      const email = cleanEmail(b.email);
      if (!okEmail(email)) return json({ error: "bad_email" }, 400);
      if (await isOwnerEmail(email)) return json({ error: "owner_is_fixed" }, 400);
      const apps = {};
      APPS.forEach((a) => { apps[a] = !!(b.apps || {})[a]; });
      list[email] = { name: String(b.name || "").slice(0, 60), apps, at: Date.now(), by: me.email };
      await store.set("users", JSON.stringify(list)); forgetUserCache();
      return json({ ok: true, users: list });
    }
    if (route === "users" && method === "DELETE") {
      const email = cleanEmail(url.searchParams.get("email"));
      if (await isOwnerEmail(email)) return json({ error: "owner_is_fixed" }, 400);
      // Kept as "removed" rather than deleted, so a built-in field-app account
      // stays switched off instead of falling back to the built-in list.
      if (list[email]) list[email] = { ...list[email], removed: true, apps: {}, at: Date.now(), by: me.email };
      else list[email] = { name: "", removed: true, apps: {}, at: Date.now(), by: me.email };
      await store.set("users", JSON.stringify(list)); forgetUserCache();
      return json({ ok: true, users: list });
    }
    if (route === "link" && method === "POST") {
      const email = cleanEmail((await body()).email);
      if (!okEmail(email)) return json({ error: "bad_email" }, 400);
      const code = randomCode();
      await D().set(`link/${code}`, JSON.stringify({ email, exp: Date.now() + LINK_DAYS * 86400000, by: me.email }));
      // Send Soil-only people straight to Soil; everyone else lands in Dispatch.
      const apps = list[email]?.apps || {};
      const where = !apps.dispatch && !apps.shop && !apps.admin && apps.soil ? "soil" : "dispatch";
      return json({ ok: true, url: `${url.origin}/${where}/#signin=${code}`, days: LINK_DAYS });
    }
    return json({ error: "not_found" }, 404);
  }

  // ── dispatch data ────────────────────────────────────────────────────────
  if (!me.perms.dispatch && !me.perms.admin) return json({ error: "no_dispatch_access" }, 403);

  if (route === "backlog" && method === "GET") {
    const raw = await D().get("backlog/current");
    return raw
      ? new Response(raw, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
      : json({ empty: true });
  }
  if (route === "backlog" && method === "PUT") {
    const b = await body();
    if (!b || !Array.isArray(b.jobs)) return json({ error: "bad_data" }, 400);
    const rec = { ...b, uploadedAt: Date.now(), uploadedBy: me.name || me.email };
    await D().set("backlog/current", JSON.stringify(rec));
    return json({ ok: true, uploadedAt: rec.uploadedAt });
  }
  if (route === "geocode" && method === "POST") {
    const { items } = await body();
    if (!Array.isArray(items)) return json({ error: "bad_data" }, 400);
    const key = (a) => String(a || "").trim().toLowerCase();
    let cache = {};
    try { cache = JSON.parse((await D().get("geo")) || "{}"); } catch {}
    const out = {}, need = [];
    for (const it of items.slice(0, 2000)) {
      const k = key(it.addr); if (!k) continue;
      if (k in cache) out[it.id] = cache[k]; else need.push(it);
    }
    let added = 0, failed = false;
    for (let i = 0; i < need.length; i += 500) {
      const chunk = need.slice(i, i + 500);
      try {
        const res = await censusBatch(chunk);
        chunk.forEach((it, j) => { const v = res[j] || null; cache[key(it.addr)] = v; out[it.id] = v; added++; });
      } catch { failed = true; break; }
    }
    if (added) await D().set("geo", JSON.stringify(cache));
    return json({ points: out, looked: added, failed });
  }
  if (route === "geocode" && method === "PUT") {
    // Browser-side fallback results (Google geocoder) for addresses Census missed.
    const { points } = await body();
    let cache = {};
    try { cache = JSON.parse((await D().get("geo")) || "{}"); } catch {}
    for (const [addr, p] of Object.entries(points || {})) {
      if (p && isFinite(p.lat) && isFinite(p.lng)) cache[String(addr).trim().toLowerCase()] = { lat: +p.lat, lng: +p.lng, g: 1 };
    }
    await D().set("geo", JSON.stringify(cache));
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
};
