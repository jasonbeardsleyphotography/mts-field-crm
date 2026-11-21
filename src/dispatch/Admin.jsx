import { useState, useEffect } from "react";
import { api, APP_LABELS } from "./api";
import { C } from "./theme";

/* ═══════════════════════════════════════════════════════════════════════════
   Admin — who may use which app. Only the owner (and anyone the owner makes
   an admin) sees this. The owner's own access is fixed in code and can't be
   changed or removed here, so there is no way to lock yourself out.
   ═══════════════════════════════════════════════════════════════════════════ */

const APPS = ["field", "dispatch", "shop", "soil", "admin"];
const NOTES = {
  field: "Needs a Google account. While Google sign-in is in Testing mode, also add the address under Test users in Google Cloud.",
  dispatch: "Backlog and Schedule.",
  shop: "Trucks, equipment and crews board.",
  soil: "Soil test maps and results for every property (crew view, with internal history).",
  admin: "Can change this list.",
};

function Checks({ apps, onChange, disabled }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {APPS.map((a) => (
        <button key={a} className="chip st" data-on={apps?.[a] ? 1 : 0} disabled={disabled}
                title={NOTES[a]} onClick={() => onChange({ ...apps, [a]: !apps?.[a] })}>
          {apps?.[a] ? "✓ " : ""}{APP_LABELS[a]}
        </button>
      ))}
    </div>
  );
}

export default function Admin({ me }) {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ email: "", name: "", apps: { dispatch: true } });
  const [links, setLinks] = useState({});        // email -> url
  const [copied, setCopied] = useState("");

  const load = async () => {
    try { setUsers((await api("users")).users || {}); setErr(""); }
    catch (e) { setErr(`Couldn't load the user list (${e.message}).`); }
  };
  useEffect(() => { load(); }, []);

  const save = async (email, name, apps) => {
    try { setUsers((await api("users", { method: "PUT", body: { email, name, apps } })).users); setErr(""); return true; }
    catch (e) { setErr(e.code === "bad_email" ? "That email address doesn't look right." : e.code === "owner_is_fixed" ? "The owner's access is fixed and can't be changed." : `Couldn't save (${e.message}).`); return false; }
  };
  const remove = async (email) => {
    if (!window.confirm(`Remove ${email}? They lose access to every app.`)) return;
    try { setUsers((await api(`users?email=${encodeURIComponent(email)}`, { method: "DELETE" })).users); }
    catch (e) { setErr(`Couldn't remove (${e.message}).`); }
  };
  const makeLink = async (email) => {
    try {
      const r = await api("link", { method: "POST", body: { email } });
      setLinks((l) => ({ ...l, [email]: r.url }));
    } catch (e) { setErr(`Couldn't make a link (${e.message}).`); }
  };
  const copy = async (email) => {
    try { await navigator.clipboard.writeText(links[email]); setCopied(email); setTimeout(() => setCopied(""), 2500); } catch {}
  };

  const list = Object.entries(users || {}).filter(([, u]) => !u.removed).sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
  const removed = Object.entries(users || {}).filter(([, u]) => u.removed);

  return (
    <div className="wrap" style={{ maxWidth: 900 }}>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h st">Who can use what</div>
        <div className="card-b hint">
          You ({me.email}) are the owner: you always have every app, and that can't be changed here.
          Accounts that already use the field app keep working; add one here only to change what it can use.
          <br />People sign in to Dispatch and the Shop Board with a <b>sign-in link</b> you make below — any
          email address works, Google or not. Each link works once, on the device it's opened on, and expires after 14 days.
        </div>
      </div>

      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-h st">Add a person</div>
        <div className="card-b" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 8 }}>
            <input className="inp" placeholder="Email address" type="email" autoComplete="off" value={form.email}
                   onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input className="inp" placeholder="Name (as it should show)" value={form.name}
                   onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <Checks apps={form.apps} onChange={(apps) => setForm({ ...form, apps })} />
          <div>
            <button className="btn st" data-primary="1" disabled={!form.email.trim()}
                    onClick={async () => { if (await save(form.email, form.name, form.apps)) setForm({ email: "", name: "", apps: { dispatch: true } }); }}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h st">People <span className="mono" style={{ marginLeft: "auto" }}>{list.length}</span></div>
        {!users && !err && <div className="card-b hint">Loading…</div>}
        {users && !list.length && <div className="card-b hint">Nobody added yet.</div>}
        {list.map(([email, u]) => (
          <div key={email} style={{ padding: "12px", borderBottom: `1px solid ${C.edgeSoft}`, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{u.name || email}</b>
              {u.name && <span className="hint">{email}</span>}
              <span className="spacer" />
              <button className="btn st" onClick={() => makeLink(email)}>Make sign-in link</button>
              <button className="btn st" data-danger="1" onClick={() => remove(email)}>Remove</button>
            </div>
            <Checks apps={u.apps} onChange={(apps) => save(email, u.name, apps)} />
            {links[email] && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input className="inp mono" readOnly value={links[email]} onFocus={(e) => e.target.select()} style={{ flex: "1 1 260px", fontSize: 11.5 }} />
                <button className="btn st" onClick={() => copy(email)}>{copied === email ? "Copied ✓" : "Copy"}</button>
                <span className="hint" style={{ flexBasis: "100%" }}>Text or email this to {u.name || email}. It works once and expires in 14 days.</span>
              </div>
            )}
          </div>
        ))}
        {removed.length > 0 && (
          <div className="card-b hint">Removed: {removed.map(([e]) => e).join(", ")} — add one again to restore it.</div>
        )}
      </div>
    </div>
  );
}
