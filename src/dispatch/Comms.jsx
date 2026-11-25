import { useState, useEffect, useMemo } from "react";
import { C } from "./theme";
import { crewsForDay } from "./Schedule.jsx";
import { shopGet, shopPatch, stampNow } from "./shop/shopApi";
import { isoOf, addDays, live } from "./shop/ShopBoard.jsx";

/* ═══════════════════════════════════════════════════════════════════════════
   COMMS (owner, Nov 25) — group texts from the phone, in one tap.
   • A crew → a group text to the people working on it that day.
   • Active today → everyone working that day: the office, the yard, every crew
     (nobody off duty / on holiday).
   • All company → everyone on the board, whatever their state.
   Each button is a link that opens the phone's own Messages app with the people
   already filled in (iPhone: sms://open?addresses=…; Android: sms:…). Nothing is
   sent from here; you type and send in Messages. Numbers live on each person
   (People → ✎ Edit, or the list at the bottom of this page).
   ═══════════════════════════════════════════════════════════════════════════ */

const OFFICE_DEFAULT = ["p09", "p13"];            // same as the Shop Board: Liz D, Mike T
const homeOf = (p) => p.home || (OFFICE_DEFAULT.includes(p.id) ? "office" : "yard");
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/** Digits only; a 10-digit US number gets +1. Returns "" if it doesn't look like a phone number. */
export const cleanPhone = (v) => {
  const d = String(v || "").replace(/[^\d+]/g, "");
  const n = d.replace(/^\+/, "");
  if (n.length === 10) return `+1${n}`;
  if (n.length === 11 && n[0] === "1") return `+${n}`;
  return n.length >= 7 ? (d.startsWith("+") ? d : n) : "";
};
const pretty = (p) => { const m = String(p).match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p; };
const smsHref = (nums, body) => {
  const b = body ? encodeURIComponent(body) : "";
  return isIOS()
    ? `sms://open?addresses=${nums.join(",")}${b ? `&body=${b}` : ""}`
    : `sms:${nums.join(",")}${b ? `?body=${b}` : ""}`;
};

function TextButton({ title, sub, people, body, color, big }) {
  const nums = [...new Set(people.map((p) => cleanPhone(p.phone)).filter(Boolean))];
  const missing = people.filter((p) => !cleanPhone(p.phone));
  const [copied, setCopied] = useState(false);
  const style = {
    display: "flex", alignItems: "center", gap: 12, padding: big ? "16px 16px" : "13px 14px", borderRadius: 8, textDecoration: "none",
    background: nums.length ? C.tile : "#1a1f23", border: `1px solid ${C.edge}`, borderLeft: `6px solid ${color || C.edge}`, color: C.ink,
    opacity: nums.length ? 1 : 0.55,
  };
  const inner = (
    <>
      <span style={{ fontSize: big ? 26 : 22 }}>💬</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b className="st" style={{ fontSize: big ? 17 : 15.5, display: "block" }}>{title} <span className="mono" style={{ fontWeight: 400, color: C.inkDim }}>{nums.length}</span></b>
        <span style={{ fontSize: 12.5, color: C.inkDim, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>
        {missing.length > 0 && <span style={{ fontSize: 11.5, color: "#f0c050", display: "block" }}>No number: {missing.map((p) => p.name).join(", ")}</span>}
      </span>
      <span style={{ fontSize: 22, color: C.inkDim }}>›</span>
    </>
  );
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {nums.length ? <a href={smsHref(nums, body)} style={style}>{inner}</a> : <div style={style}>{inner}</div>}
      {nums.length > 0 && (
        <button className="chip st" style={{ justifySelf: "end", fontSize: 10.5 }}
                onClick={async () => { try { await navigator.clipboard.writeText(nums.join(", ")); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} }}>
          {copied ? "Copied ✓" : "Copy numbers"}
        </button>
      )}
    </div>
  );
}

export default function Comms({ me }) {
  const today = isoOf(new Date());
  const [iso, setIso] = useState(today);
  const [board, setBoard] = useState(null);
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");
  const [showNums, setShowNums] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const canEdit = !!(me?.perms?.shop || me?.perms?.admin);

  const load = async (d) => { try { setBoard(await crewsForDay(d, true)); setErr(""); } catch (e) { setErr(`Couldn't load the board (${e.message}).`); } };
  useEffect(() => { setBoard(null); load(iso); }, [iso]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = useMemo(() => (board ? live(board.core.people).sort((a, b) => a.name.localeCompare(b.name)) : []), [board]);
  const off = board?.off || new Set();
  const working = people.filter((p) => !off.has(p.id));
  const offPeople = people.filter((p) => off.has(p.id));
  const onCrew = new Set((board?.crews || []).flatMap((c) => c.people || []));
  const office = working.filter((p) => !onCrew.has(p.id) && homeOf(p) === "office");
  const yard = working.filter((p) => !onCrew.has(p.id) && homeOf(p) !== "office");
  const dayLabel = (d) => (d === today ? "Today" : d === isoOf(addDays(new Date(), 1)) ? "Tomorrow" : new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
  const crewColors = ["#4FC3F7", "#FFB74D", "#BA68C8", "#81C784", "#F06292", "#FFF176", "#4DB6AC", "#E57373"];

  /* phone numbers: saved on the person in the Shop Board (one person per save, newest wins) */
  const saveNumbers = async () => {
    setSaving(true); setErr("");
    try {
      const core = await shopGet("core");
      const at = stampNow(), by = me?.name || me?.email || "?";
      const patch = { people: {} };
      Object.entries(edits).forEach(([id, v]) => {
        const base = (core?.people || {})[id] || board.core.people[id];
        if (!base) return;
        patch.people[id] = { ...base, phone: cleanPhone(v) || String(v || "").trim(), at, by };
      });
      if (!Object.keys(patch.people).length) { setSaving(false); return; }
      const r = await shopPatch("core", patch);
      if (!r) throw new Error("not saved");
      setEdits({}); await load(iso);
    } catch (e) { setErr(`Couldn't save the numbers (${e.message}) — check your connection and try again.`); }
    setSaving(false);
  };

  return (
    <div className="wrap" style={{ maxWidth: 720, paddingBottom: 90 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {[today, isoOf(addDays(new Date(), 1))].map((d) => (
          <button key={d} className="chip st" data-on={iso === d ? 1 : 0} style={{ padding: "8px 14px" }} onClick={() => setIso(d)}>{dayLabel(d)}</button>
        ))}
        <input type="date" className="inp" style={{ width: "auto", padding: "6px 8px" }} value={iso} onChange={(e) => e.target.value && setIso(e.target.value)} />
      </div>

      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {!board && <div className="hint">Loading the board…</div>}

      {board && (
        <div style={{ display: "grid", gap: 12 }}>
          <TextButton big title="Active today" color="#17A05B" people={working} body={body}
                      sub={`${dayLabel(iso)}: office ${office.length} · yard ${yard.length} · on crews ${working.length - office.length - yard.length}${offPeople.length ? ` · ${offPeople.length} off (left out)` : ""}`} />

          <div className="st" style={{ fontSize: 12, color: C.inkDim, marginTop: 6 }}>Crews · {dayLabel(iso)}</div>
          {(board.crews || []).filter((c) => (c.people || []).length).map((c, i) => {
            const ppl = (c.people || []).map((id) => board.core.people[id]).filter((p) => p && !p.del && !off.has(p.id));
            return <TextButton key={c.id} title={c.name} color={crewColors[i % crewColors.length]} people={ppl} body={body}
                               sub={ppl.map((p) => p.name.split(" ")[0]).join(", ") || "nobody working"} />;
          })}
          {yard.length > 0 && <TextButton title="In the yard (not on a crew)" color="#6E7A83" people={yard} body={body} sub={yard.map((p) => p.name).join(", ")} />}
          <div className="st" style={{ fontSize: 12, color: C.inkDim, marginTop: 6 }}>Everyone</div>
          <TextButton big title="All company" color="#3A8DD8" people={people} body={body}
                      sub="Everyone — office, yard and anyone off" />
          {offPeople.length > 0 && <div className="hint" style={{ padding: 0 }}>Off {dayLabel(iso).toLowerCase()}: {offPeople.map((p) => p.name).join(", ")} — only in “All company”.</div>}
          <div className="hint" style={{ padding: 0 }}>Each button opens your phone's Messages with those people filled in; you write and send it there. On a computer without texting, use “Copy numbers”.</div>

          {/* phone numbers, all on one page for loading them in */}
          <div className="card" style={{ marginTop: 8 }}>
            <button className="card-h st" style={{ width: "100%" }} onClick={() => setShowNums((v) => !v)}>
              📇 Phone numbers ({people.filter((p) => cleanPhone(p.phone)).length} of {people.length}){!canEdit ? " · view only" : ""}<span className="spacer" />{showNums ? "▴" : "▾"}
            </button>
            {showNums && (
              <div className="card-b" style={{ display: "grid", gap: 6 }}>
                {people.map((p) => {
                  const v = edits[p.id] ?? p.phone ?? "";
                  const ok = !v || cleanPhone(v);
                  return (
                    <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ width: 150, flexShrink: 0, fontSize: 13.5 }}>{p.name}</span>
                      <input className="inp" type="tel" inputMode="tel" disabled={!canEdit} value={v} placeholder="585-555-1234"
                             onChange={(e) => setEdits((x) => ({ ...x, [p.id]: e.target.value }))}
                             style={{ borderColor: ok ? undefined : C.red }} />
                      {v && cleanPhone(v) && <span className="hint" style={{ padding: 0, whiteSpace: "nowrap" }}>{pretty(cleanPhone(v))}</span>}
                    </label>
                  );
                })}
                {canEdit && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button className="btn st" data-primary="1" disabled={saving || !Object.keys(edits).length} onClick={saveNumbers}>{saving ? "Saving…" : "Save numbers"}</button>
                    {Object.keys(edits).length > 0 && <span className="hint" style={{ padding: 0 }}>{Object.keys(edits).length} changed</span>}
                  </div>
                )}
                <div className="hint" style={{ padding: 0 }}>Numbers are kept with each person on the Shop Board (also editable there: People → ✎ Edit). Only people signed in to Dispatch can see them.</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
