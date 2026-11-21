/* Who is calling a Dispatch / Soil API, and what they may use.
   1. A Dispatch/Soil session (mts_dsess) made by redeeming a sign-in link.
   2. The field app's lasting Google sign-in on the same browser (mts_sess). */
import { parseCookies, appPermissions, loadUserList, isOwnerEmail } from "./accounts.mjs";

export async function whoAmI(req, getStore) {
  const ck = parseCookies(req.headers.get("cookie"));
  if (ck.mts_dsess) {
    try {
      const raw = await getStore("mts-dispatch").get(`sess/${ck.mts_dsess}`);
      if (raw) { const s = JSON.parse(raw); if (s.email) return { email: s.email, via: "link" }; }
    } catch {}
  }
  if (ck.mts_sess) {
    try {
      const raw = await getStore("mts-oauth").get(ck.mts_sess);
      if (raw) { const s = JSON.parse(raw); if (s.email) return { email: s.email, via: "google" }; }
    } catch {}
  }
  return null;
}

export async function caller(req, getStore) {
  const who = await whoAmI(req, getStore);
  if (!who) return null;
  const owner = await isOwnerEmail(who.email);
  const list = (await loadUserList(getStore).catch(() => null)) || {};
  const rec = list[who.email];
  if (rec?.removed && !owner) return null;
  const perms = await appPermissions(who.email, getStore);
  return { ...who, perms, name: rec?.name || "", owner };
}
