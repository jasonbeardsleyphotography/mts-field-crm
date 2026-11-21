import { useState, useEffect, useCallback } from "react";
import { soilApi, redeemLink } from "./api";
import { CSS } from "./theme";
import SitePage from "./SitePage.jsx";
import { readSitePackage, uploadSitePackage, uploadArchive } from "./importPackage";
import { fmtDate } from "./soilData";
import AppMenu from "../dispatch/AppMenu.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS Soil — /soil (staff) and /soil/c/<token> (a client's private page).
   ═══════════════════════════════════════════════════════════════════════════ */

const clientToken = () => (location.pathname.match(/^\/soil\/c\/([a-z0-9]{24,48})\/?$/) || [])[1] || null;

function ClientView({ token }) {
  const [site, setSite] = useState(undefined);
  useEffect(() => {
    soilApi(`public?t=${token}`).then((r) => setSite(r.site)).catch(() => setSite(null));
  }, [token]);
  if (site === undefined) return <div className="gate t-sub">Opening…</div>;
  if (!site) return (
    <div className="gate"><div className="t-h">This link isn't working</div>
      <p className="t-sub" style={{ marginTop: 8 }}>It may have been turned off or mistyped. Please ask Monster Tree Service of Rochester for a new link.</p></div>
  );
  return <SitePage site={site} mode="client" token={token} />;
}

function ImportBox({ onDone }) {
  const [pkg, setPkg] = useState(null);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [step, setStep] = useState("");
  const [err, setErr] = useState("");
  const read = async (file) => {
    setErr(""); setStep("Reading the package…");
    try {
      const p = await readSitePackage(file);
      setPkg(p); if (p.site) setName(p.site.name); setClient(""); setStep("");
    } catch (e) { setErr(e.message || String(e)); setStep(""); }
  };
  const save = async () => {
    setErr("");
    if (pkg.kind === "archive") {
      try { await uploadArchive(pkg, setStep); setPkg(null); onDone(null); }
      catch (e) { setErr(`Couldn't save (${e.message}). Running it again is safe — it picks up where it stopped.`); setStep(""); }
      return;
    }
    try {
      const site = { ...pkg.site, name: name.trim() || pkg.site.name, client: client.trim() };
      site.id = site.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || site.id;
      const id = await uploadSitePackage({ site, files: pkg.files }, setStep);
      setPkg(null); onDone(id);
    } catch (e) { setErr(`Couldn't save (${e.message}).`); setStep(""); }
  };
  return (
    <div className="card pad">
      <div className="lbl">Add properties from a .zip (a site package or the soil test archive)</div>
      {!pkg ? (
        <label className="b-sec" style={{ display: "inline-block", marginTop: 6 }}>
          {step || "Choose the package zip…"}
          <input type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) read(f); }} />
        </label>
      ) : pkg.kind === "archive" ? (
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
          <div className="t-sub">Soil test archive: {pkg.sites.length} properties · {pkg.sites.reduce((n, s) => n + s.tests.reduce((m, t) => m + t.samples.length, 0), 0)} samples · {pkg.files.length} lab reports.
            Properties already here are updated; pins you've placed are kept.</div>
          <div className="t-sub">{pkg.sites.map((s) => s.name).join(" · ")}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="b-main" disabled={!!step} onClick={save}>{step || "Import all"}</button>
            <button className="b-sec" disabled={!!step} onClick={() => setPkg(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
          <div className="t-sub">{pkg.site.address} · {pkg.site.tests[0].samples.length} samples · {pkg.files.length} lab reports
            {pkg.site.shapes.length ? ` · ${pkg.site.shapes.length} cut-out shapes` : ""}{pkg.site.history ? " · history" : ""}</div>
          <label className="fld">Property name (shown as the account name)<input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="fld">Client name (optional)<input className="inp" value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Stoner" /></label>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="b-main" disabled={!!step} onClick={save}>{step || "Save property"}</button>
            <button className="b-sec" disabled={!!step} onClick={() => setPkg(null)}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function StaffView() {
  const [me, setMe] = useState(undefined);
  const [linkErr, setLinkErr] = useState("");
  const [sites, setSites] = useState(null);
  const [open, setOpen] = useState(() => (location.hash.match(/site=([a-z0-9-]+)/) || [])[1] || null);
  const [site, setSite] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const m = location.hash.match(/signin=([a-z0-9]+)/);
      if (m) {
        history.replaceState(null, "", location.pathname);
        try { await redeemLink(m[1]); } catch (e) { setLinkErr(e.code === "link_expired" ? "That sign-in link has expired." : "That sign-in link has already been used or isn't valid. Ask for a new one."); }
      }
      try { setMe(await soilApi("me")); } catch { setMe(null); }
    })();
  }, []);

  const loadSites = useCallback(async () => {
    try { setSites((await soilApi("sites")).sites); setErr(""); } catch (e) { setErr(`Couldn't load properties (${e.message}).`); setSites([]); }
  }, []);
  const allowed = me && (me.perms?.soil || me.perms?.admin);
  useEffect(() => { if (allowed) loadSites(); }, [allowed, loadSites]);

  useEffect(() => {
    const onHash = () => setOpen((location.hash.match(/site=([a-z0-9-]+)/) || [])[1] || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!open || !allowed) { setSite(null); return; }
    let dead = false;
    setSite(undefined);
    soilApi(`site?id=${open}`).then((r) => { if (!dead) { setSite(r.site); setCanEdit(!!r.canEdit); } })
      .catch((e) => { if (!dead) { setSite(null); setErr(`Couldn't open that property (${e.message}).`); } });
    return () => { dead = true; };
  }, [open, allowed]);

  const go = (id) => { location.hash = id ? `site=${id}` : ""; };
  const signOut = async () => {
    try { await fetch("/api/dispatch/logout", { method: "POST", credentials: "same-origin" }); } catch {}
    location.reload();
  };
  const menu = <AppMenu me={me} current="soil" onSignOut={signOut} />;

  if (me === undefined) return <div className="gate t-sub">Opening Soil…</div>;
  if (!me) return (
    <div className="gate">
      <div className="t-h">MTS Soil</div>
      {linkErr && <p className="err">{linkErr}</p>}
      <p className="t-sub" style={{ marginTop: 8 }}>Sign in with a sign-in link from the owner, or open the <a href="/">field app</a> in this browser, sign in, and come back.</p>
    </div>
  );
  if (!allowed) return (
    <div className="gate"><div className="t-h">No Soil access</div>
      <p className="t-sub" style={{ marginTop: 8 }}>You're signed in as <b>{me.email}</b>, which doesn't have Soil switched on. Ask the owner to switch it on in Admin.</p></div>
  );

  if (open) {
    if (site === undefined) return <div className="gate t-sub">Opening the property…</div>;
    if (site) return <SitePage site={site} mode="staff" canEdit={canEdit} onBack={() => { go(null); loadSites(); }}
      menu={<AppMenu me={me} current="soil" onSignOut={signOut} buttonStyle={{ position: "absolute", left: 10, bottom: 30, zIndex: 950 }} />} />;
  }

  return (
    <div className="home">
      {menu}
      <header className="sp-hd">
        <div style={{ flex: 1 }}>
          <div className="t-h">Soil</div>
          <div className="t-sub">Monster Tree Service of Rochester · soil tests by property</div>
        </div>
      </header>
      <div className="home-b">
        {err && <div className="err">{err}</div>}
        {!sites && <div className="t-sub">Loading…</div>}
        {sites && !sites.length && <div className="t-sub">No properties yet.{me.perms.admin ? " Add one from a site package below." : ""}</div>}
        <div className="grid">
          {(sites || []).map((s) => (
            <button key={s.id} className="card site" onClick={() => go(s.id)}>
              <div className="t-h" style={{ fontSize: 17 }}>{s.name}</div>
              <div className="t-sub">{s.address}</div>
              <div className="t-sub" style={{ marginTop: 6 }}>{s.samples} sample{s.samples === 1 ? "" : "s"}{s.lastTest ? ` · last test ${fmtDate(s.lastTest)}` : ""}{s.mapped ? " · on the map" : ""}</div>
            </button>
          ))}
        </div>
        {me.perms.admin && <div style={{ marginTop: 16 }}><ImportBox onDone={(id) => { loadSites(); if (id) go(id); }} /></div>}
      </div>
    </div>
  );
}

export default function SoilApp() {
  const token = clientToken();
  return (
    <div className="soil">
      <style>{CSS}</style>
      {token ? <ClientView token={token} /> : <StaffView />}
    </div>
  );
}
