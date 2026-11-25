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
     GET    paused                  (dispatch) jobs on pause { ref: { reason, until, by, at } }
     POST   paused {ref, reason, until} | {ref, remove}   pause / edit / resume a job
     GET    deleted                 (dispatch) jobs deleted from the backlog { ref: { at, by, name } }
     POST   deleted {ref, name} | {ref, restore}          delete / restore a job
     GET    stumps                  (dispatch) stump workflow per job { ref: { stage, called, clearFrom, clearTo, note, snap } }
     POST   stumps {ref, set}                              change one job's stage / dates / note
     POST   geocode  {items:[{id,addr}]}  (dispatch) lat/lng, cached
   ═══════════════════════════════════════════════════════════════════════════ */

import { getStore as blobStore } from "@netlify/blobs";
/* STRONG reads everywhere (owner, Nov 24): Netlify Blobs' default "eventual" reads can
   return a copy up to ~60 s old. A save built on an old copy wrote it back over newer
   work — that erased a person the owner had just added and brought back people he had
   deleted. Every read here is now the latest version. */
const getStore = (n) => blobStore(typeof n === "string" ? { name: n, consistency: "strong" } : n);
import { parseCookies, appPermissions, loadUserList, forgetUserCache, isOwnerEmail, APPS, emailForToken } from "../lib/accounts.mjs";
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

  // For the field app's edge functions (which can't read the Admin list):
  // is the Google account behind this access token allowed to use the field app?
  if (route === "allowed-field" && method === "GET") {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const email = token ? await emailForToken(token) : null;
    const ok = !!email && (await appPermissions(email, getStore)).field;
    return json({ ok }, ok ? 200 : 403);
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

  // ── Shop Board (needs Shop Board or Admin) ───────────────────────────────
  if (route.startsWith("shop/")) {
    // Shop Board users edit the board; Dispatch users can read it (the Schedule
    // shows its crews) and edit only the day schedules (sched.<date>).
    if (!me.perms.shop && !me.perms.dispatch && !me.perms.admin) return json({ error: "no_shop_access" }, 403);
    return shopRoute(route.slice(5), req, url, me);
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
  // Jobs "on pause": the office can't schedule them yet (client wants to meet
  // first, away until spring…). Stored apart from the workbook so a new upload
  // keeps them. { ref: { reason, until, by, at } }; removed = { removed: true, at }.
  if (route === "paused" && method === "GET") {
    const raw = await D().get("backlog/paused");
    return json({ paused: raw ? JSON.parse(raw) : {} });
  }
  if (route === "paused" && method === "POST") {
    const b = await body();
    const ref = String(b?.ref || "").slice(0, 40);
    if (!ref) return json({ error: "bad_data" }, 400);
    const raw = await D().get("backlog/paused");
    const all = raw ? JSON.parse(raw) : {};
    if (b.remove) all[ref] = { removed: true, at: Date.now(), by: me.name || me.email };
    else {
      const reason = String(b.reason || "").trim().slice(0, 300);
      if (!reason) return json({ error: "reason_needed" }, 400);
      const until = /^\d{4}-\d{2}-\d{2}$/.test(b.until || "") ? b.until : "";
      all[ref] = { reason, until, by: me.name || me.email, at: Date.now(), since: all[ref]?.removed ? Date.now() : (all[ref]?.since || Date.now()) };
    }
    // drop removal markers older than 60 days
    for (const [k, v] of Object.entries(all)) if (v.removed && Date.now() - v.at > 60 * 86400000) delete all[k];
    await D().set("backlog/paused", JSON.stringify(all));
    return json({ paused: all });
  }
  // Jobs deleted from the Dispatch backlog (done, cancelled, duplicates). Kept
  // apart from the workbook so a re-import doesn't bring them back.
  // { ref: { at, by, name } }; restoring removes the entry.
  if (route === "deleted" && method === "GET") {
    const raw = await D().get("backlog/deleted");
    return json({ deleted: raw ? JSON.parse(raw) : {} });
  }
  if (route === "deleted" && method === "POST") {
    const b = await body();
    const ref = String(b?.ref || "").slice(0, 40);
    if (!ref) return json({ error: "bad_data" }, 400);
    const raw = await D().get("backlog/deleted");
    const all = raw ? JSON.parse(raw) : {};
    if (b.restore) delete all[ref];
    else all[ref] = { at: Date.now(), by: me.name || me.email, name: String(b.name || "").slice(0, 80) };
    await D().set("backlog/deleted", JSON.stringify(all));
    return json({ deleted: all });
  }
  // STUMPS workflow (owner, Nov 25): per job { stage, called, clearFrom, clearTo, note, snap, at, by }.
  // One job per save; the newest save of a job wins (server clock). snap = the job's details
  // when it entered a stage, so cleanup / soil & seed jobs stay listed after SingleOps closes the visit.
  if (route === "stumps" && method === "GET") {
    const raw = await D().get("stumps/state");
    return json({ stumps: raw ? JSON.parse(raw) : {} });
  }
  if (route === "stumps" && method === "POST") {
    const b = await body();
    const ref = String(b?.ref || "").slice(0, 40);
    if (!ref || !b.set || typeof b.set !== "object") return json({ error: "bad_data" }, 400);
    const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "");
    const STAGES = ["waiting", "stakeout", "grind", "cleanup", "seed", "done"];
    const raw = await D().get("stumps/state");
    const all = raw ? JSON.parse(raw) : {};
    const cur = all[ref] || {};
    const n = { ...cur };
    if ("stage" in b.set) n.stage = STAGES.includes(b.set.stage) ? b.set.stage : "";
    for (const k of ["called", "clearFrom", "clearTo", "doneOn"]) if (k in b.set) n[k] = d(b.set[k]);
    if ("note" in b.set) n.note = String(b.set.note || "").slice(0, 600);
    if (b.set.snap && typeof b.set.snap === "object" && JSON.stringify(b.set.snap).length <= 6000) n.snap = b.set.snap;
    n.at = Date.now(); n.by = me.name || me.email;
    all[ref] = n;
    // forget jobs marked done more than a year ago
    for (const [k, v] of Object.entries(all)) if (v.stage === "done" && Date.now() - (v.at || 0) > 400 * 86400000) delete all[k];
    await D().set("stumps/state", JSON.stringify(all));
    return json({ stumps: all });
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

/* ═══ Shop Board storage ═══════════════════════════════════════════════════
   Blobs store "mts-shop". Keys: core | day.YYYY-MM-DD | week.YYYY-MM-DD |
   presence. Clients send only what they changed ("patches"); the server
   merges them here, item by item, so two managers working at once don't
   undo each other:
     core:  assets / crews / people / rigs — newer "at" wins per item; log merged
     day:   crews by "at"; pos / stacks per key (null = remove)
     week:  cells by "at"
   A unit's spec (drawing, family, what it tows) is never stored — the board
   re-applies it from its code on every read. */
const SH = () => getStore("mts-shop");
const SHOP_KEY = /^(core|(day|week|sched)\.\d{4}-\d{2}-\d{2})$/;
const byAt = (cur = {}, inc = {}) => {
  const out = { ...cur };
  for (const [k, v] of Object.entries(inc || {})) {
    if (!v || typeof v !== "object") continue;
    if (!out[k] || (v.at || 0) >= (out[k].at || 0)) out[k] = v;
  }
  return out;
};
const perKey = (cur = {}, inc = {}) => {
  const out = { ...cur };
  for (const [k, v] of Object.entries(inc || {})) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
};
function mergeShop(key, cur, patch, replace, t) {
  if (key.startsWith("sched.")) return { assign: byAt(replace || !cur ? {} : cur.assign, patch.assign) };
  if (replace || !cur) cur = key === "core" ? { assets: {}, crews: {}, people: {}, rigs: {}, log: [] } : key.startsWith("day.") ? { crews: {}, stacks: {}, pos: {}, keyAt: {} } : { cells: {} };
  if (key === "core") {
    const log = new Map();
    [...(cur.log || []), ...(patch.log || [])].forEach((e) => e && e.id && log.set(e.id, e));
    return {
      assets: byAt(cur.assets, patch.assets), crews: byAt(cur.crews, patch.crews),
      people: byAt(cur.people, patch.people), rigs: byAt(cur.rigs, patch.rigs),
      log: [...log.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      resetAt: Math.max(cur.resetAt || 0, patch.resetAt || 0),
    };
  }
  if (key.startsWith("day.")) {
    // pos / stacks have no time stamps of their own, so the server remembers
    // when it last set each key; an older request never overwrites a newer one.
    const keyAt = { ...(cur.keyAt || {}) };
    const apply = (map, inc, tag) => {
      const out = { ...(map || {}) };
      for (const [k, v] of Object.entries(inc || {})) {
        if ((keyAt[tag + k] || 0) > t) continue;
        if (v === null) delete out[k]; else out[k] = v;
        keyAt[tag + k] = t;
      }
      return out;
    };
    return { crews: byAt(cur.crews, patch.crews), stacks: apply(cur.stacks, patch.stacks, "s:"), pos: apply(cur.pos, patch.pos, "p:"), keyAt, at: Date.now() };
  }
  return { cells: byAt(cur.cells, patch.cells) };
}
/** Is this patch (sent at server time t) reflected in the stored value — or overtaken by something newer? */
function landed(key, v, patch, t) {
  if (!v) return false;
  const ent = (cur, inc) => Object.entries(inc || {}).every(([id, x]) => !x || typeof x !== "object" || ((cur || {})[id]?.at || 0) >= (x.at || 0));
  if (key === "core") return ["assets", "crews", "people", "rigs"].every((c) => ent(v[c], patch[c])) && (patch.log || []).every((e) => (v.log || []).some((x) => x.id === e.id) || (v.log || []).length >= 40);
  if (key.startsWith("day.")) {
    const keys = (inc, tag) => Object.keys(inc || {}).every((k) => ((v.keyAt || {})[tag + k] || 0) >= t);
    return ent(v.crews, patch.crews) && keys(patch.pos, "p:") && keys(patch.stacks, "s:");
  }
  if (key.startsWith("sched.")) return ent(v.assign, patch.assign);
  return ent(v.cells, patch.cells);
}

async function shopRoute(sub, req, url, me) {
  const method = req.method;
  if (sub === "get" && method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!SHOP_KEY.test(key)) return json({ error: "bad_key" }, 400);
    const raw = await SH().get(key);
    return json({ key, value: raw ? JSON.parse(raw) : null, now: Date.now() });
  }
  // Yard addresses (where the Schedule's "best order" starts and ends).
  if (sub === "settings" && method === "GET") {
    const raw = await SH().get("settings");
    return json({ settings: raw ? JSON.parse(raw) : { yards: {} }, now: Date.now() });
  }
  if (sub === "settings" && method === "POST") {
    if (!me.perms.dispatch && !me.perms.admin) return json({ error: "no_access" }, 403);
    let b; try { b = await req.json(); } catch { return json({ error: "bad_data" }, 400); }
    const name = String(b?.yard || "").slice(0, 40), addr = String(b?.addr || "").trim().slice(0, 160);
    if (!name || !addr) return json({ error: "bad_data" }, 400);
    let pt = null;
    try { pt = (await censusBatch([{ addr }]))[0] || null; } catch {}
    if (!pt && isFinite(b.lat) && isFinite(b.lng)) pt = { lat: +b.lat, lng: +b.lng };   // browser fallback
    if (!pt) return json({ error: "address_not_found" }, 422);
    const raw = await SH().get("settings");
    const st = raw ? JSON.parse(raw) : { yards: {} };
    st.yards = { ...(st.yards || {}), [name]: { addr, lat: pt.lat, lng: pt.lng, by: me.name || me.email, at: Date.now() } };
    await SH().set("settings", JSON.stringify(st));
    return json({ settings: st, now: Date.now() });
  }
  if (sub === "sched-range" && method === "GET") {
    // the schedules of several days at once (the Schedule marks jobs planned on other days)
    const from = url.searchParams.get("from") || "", n = Math.min(31, +url.searchParams.get("days") || 7);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json({ error: "bad_date" }, 400);
    const out = {};
    for (let i = 0; i < n; i++) {
      const d = new Date(from + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const raw = await SH().get(`sched.${iso}`);
      if (raw) out[iso] = JSON.parse(raw);
    }
    return json({ sched: out, now: Date.now() });
  }
  if (sub === "days" && method === "GET") {
    const { blobs } = await SH().list({ prefix: "day." });
    return json({ days: blobs.map((b) => b.key.slice(4)), now: Date.now() });
  }
  if (sub === "patch" && method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_data" }, 400); }
    if (!SHOP_KEY.test(b?.key || "") || typeof b.patch !== "object") return json({ error: "bad_data" }, 400);
    if (b.replace && b.key === "core" && !me.perms.admin) return json({ error: "admins_only" }, 403);
    const isSched = b.key.startsWith("sched.");
    if (isSched ? !(me.perms.dispatch || me.perms.admin) : !(me.perms.shop || me.perms.admin)) return json({ error: "no_access" }, 403);
    // Blobs has no "write only if unchanged", so two saves at the same instant
    // could overwrite each other. Write, look again a moment later, and
    // re-apply this patch if a simultaneous save wiped it (never over newer edits).
    const t = Date.now();
    let merged = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await SH().get(b.key);
      const cur = raw ? JSON.parse(raw) : null;
      if (attempt > 0 && landed(b.key, cur, b.patch, t)) { merged = cur; break; }
      merged = mergeShop(b.key, cur, b.patch, !!b.replace && attempt === 0, t);
      await SH().set(b.key, JSON.stringify(merged));
      // a daily safety copy of the board (core), so lost work can always be recovered
      if (b.key === "core" && attempt === 0) {
        const bk = `bak/core.${new Date().toISOString().slice(0, 10)}`;
        try { if (!(await SH().get(bk)) && cur) await SH().set(bk, JSON.stringify(cur)); } catch {}
      }
      await new Promise((ok) => setTimeout(ok, 80 + Math.random() * 160));
    }
    return json({ ok: true, value: merged, now: Date.now() });
  }
  if (sub === "presence" && method === "POST") {
    let b; try { b = await req.json(); } catch { b = {}; }
    let p = {}; try { p = JSON.parse((await SH().get("presence")) || "{}"); } catch {}
    const now = Date.now();
    for (const k of Object.keys(p)) if (now - (p[k].at || 0) > 120000) delete p[k];
    if (b.uid && /^[a-z0-9]{4,16}$/.test(b.uid)) p[b.uid] = { name: me.name || me.email.split("@")[0], at: now };
    await SH().set("presence", JSON.stringify(p));
    return json({ presence: p, now });
  }
  return json({ error: "not_found" }, 404);
}
