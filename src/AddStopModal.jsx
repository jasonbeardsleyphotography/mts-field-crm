/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Add Stop Modal
   ───────────────────────────────────────────────────────────────────────────
   The "Add a stop" dialog. Was inline in App.jsx; extracted because it now
   manages two typeaheads (client name → existing client, address → Google
   Places suggestions) and its state was getting tangled with the parent.

   When the user selects an existing client by name, address/phone/email
   get autofilled. When they select a Places suggestion for the address,
   only the address fills. The user can override anything — the autofills
   are suggestions, not commitments.
   ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useEffect, useRef } from "react";
import { makeDebouncedSuggester, endAutocompleteSession, isPlacesConfigured } from "./placesAutocomplete";
import { searchClients } from "./clientIndex";

const F = "'Oswald',sans-serif";
const B = "'DM Sans',system-ui,sans-serif";

export default function AddStopModal({
  open,
  onClose,
  onSubmit,
  clientIndex,        // built by parent from pipeline + events
}) {
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [time, setTime] = useState("AM");
  // What KIND of thing we're adding. visit/driveby land on the Route as
  // calendar events (parseEvent classifies them by summary text); todo lands on
  // the Route as a TD; pipeline goes straight to a Pipeline lead.
  const [type, setType] = useState("visit");

  // Suggestion state
  const [nameSuggestions, setNameSuggestions] = useState([]);
  const [addrSuggestions, setAddrSuggestions] = useState([]);
  const [showNameDrop, setShowNameDrop] = useState(false);
  const [showAddrDrop, setShowAddrDrop] = useState(false);

  // Debounced address suggester — created once, persists across renders.
  const addrSuggester = useRef(null);
  if (!addrSuggester.current) addrSuggester.current = makeDebouncedSuggester(200);

  // Reset everything on close
  const reset = () => {
    setName(""); setAddr(""); setPhone(""); setEmail(""); setNotes("");
    setTime("AM"); setType("visit");
    setNameSuggestions([]); setAddrSuggestions([]);
    setShowNameDrop(false); setShowAddrDrop(false);
    endAutocompleteSession();
  };

  useEffect(() => { if (!open) reset(); }, [open]);

  // ── Name typeahead ───────────────────────────────────────────────────
  const onNameChange = (val) => {
    setName(val);
    const matches = searchClients(clientIndex, val, 6);
    setNameSuggestions(matches);
    setShowNameDrop(matches.length > 0);
  };

  const pickClient = (rec) => {
    setName(rec.cn);
    if (rec.addr && !addr) setAddr(rec.addr);
    if (rec.phone && !phone) setPhone(rec.phone);
    if (rec.email && !email) setEmail(rec.email);
    setShowNameDrop(false);
  };

  // ── Address typeahead ────────────────────────────────────────────────
  const onAddrChange = (val) => {
    setAddr(val);
    if (!isPlacesConfigured()) return; // Quietly skip — input still works manually
    addrSuggester.current(val, (results) => {
      setAddrSuggestions(results);
      setShowAddrDrop(results.length > 0);
    });
  };

  const pickAddress = (sug) => {
    setAddr(sug.description);
    setShowAddrDrop(false);
    endAutocompleteSession();
  };

  if (!open) return null;

  const submit = () => {
    if (!name.trim() && !addr.trim()) return;
    onSubmit({
      name: name.trim(),
      addr: addr.trim(),
      phone: phone.trim(),
      email: email.trim(),
      notes: notes.trim(),
      time,
      type,
      // Back-compat for any caller still keying off dest.
      dest: type === "pipeline" ? "pipeline" : "route",
    });
    onClose();
  };

  // The four things the + button can create. `timed` = shows the AM/PM/All-Day
  // window picker (only real visits/drive-bys have an arrival window).
  const TYPES = [
    { id: "visit",    label: "Visit",    emoji: "📍", color: "#3B82F6", timed: true,  hint: "Scheduled estimate appointment" },
    { id: "driveby",  label: "Drive-by", emoji: "🚗", color: "#FFD54F", timed: true,  hint: "Quick look at the property — no appointment" },
    { id: "todo",     label: "To-Do",    emoji: "✓",  color: "#B39DDB", timed: false, hint: "A task or reminder tied to a client" },
    { id: "pipeline", label: "Pipeline", emoji: "📋", color: "#F6BF26", timed: false, hint: "Straight to a Pipeline lead (Estimate Needed)" },
  ];
  const activeType = TYPES.find(t => t.id === type) || TYPES[0];

  const inputStyle = {
    width: "100%", boxSizing: "border-box",
    padding: "10px 12px", borderRadius: 8,
    background: "#0e1120", border: "1px solid #1a2540",
    color: "#e0e8f0", fontSize: 14, fontFamily: B,
    outline: "none",
  };
  const dropStyle = {
    position: "absolute", left: 0, right: 0, top: "100%",
    background: "#0a0c14", border: "1px solid #1a2540",
    borderTop: "none", borderRadius: "0 0 8px 8px",
    maxHeight: 200, overflowY: "auto", zIndex: 10,
    boxShadow: "0 6px 18px rgba(0,0,0,.5)",
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.6)",
      backdropFilter: "blur(4px)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#0d0f18", border: "1px solid #1a2030", borderRadius: 14,
        padding: 20, maxWidth: 360, width: "100%",
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#f0f4fa", marginBottom: 14, fontFamily: F, letterSpacing: 1, textTransform: "uppercase" }}>Add a stop</div>

        {/* Type picker — Visit / Drive-by / To-Do / Pipeline (2×2 grid) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
          {TYPES.map(t => {
            const on = type === t.id;
            return (
              <button key={t.id} onClick={() => setType(t.id)} style={{
                padding: "9px 0", borderRadius: 8,
                background: on ? t.color + "22" : "#0a0c14",
                border: `1px solid ${on ? t.color + "88" : "#1a2540"}`,
                color: on ? t.color : "#5a6580",
                fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: F,
                textTransform: "uppercase", letterSpacing: 0.5, transition: "all .15s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
                <span style={{ fontSize: 13 }}>{t.emoji}</span>{t.label}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: "#5a6580", marginBottom: 10, padding: "6px 10px", borderRadius: 6, background: "rgba(255,255,255,.02)", border: "1px solid #161c2a", lineHeight: 1.4 }}>{activeType.hint}</div>

        {/* Client name with typeahead */}
        <div style={{ position: "relative", marginBottom: 8 }}>
          <input
            value={name}
            onChange={e => onNameChange(e.target.value)}
            onFocus={() => name.length >= 2 && setShowNameDrop(nameSuggestions.length > 0)}
            onBlur={() => setTimeout(() => setShowNameDrop(false), 150)}
            placeholder="Client name (e.g. Smith)"
            style={inputStyle}
          />
          {showNameDrop && nameSuggestions.length > 0 && (
            <div style={dropStyle}>
              <div style={{ padding: "6px 10px", fontSize: 9, color: "#5a6580", fontWeight: 700, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", background: "#080a14", borderBottom: "1px solid #1a2030" }}>EXISTING CLIENTS</div>
              {nameSuggestions.map((rec, i) => (
                <button key={i} onMouseDown={(e) => e.preventDefault() /* stop blur from firing first */} onClick={() => pickClient(rec)} style={{
                  width: "100%", textAlign: "left", padding: "8px 10px",
                  background: "transparent", border: "none", borderBottom: i < nameSuggestions.length - 1 ? "1px solid #0e1220" : "none",
                  color: "#e0e8f0", cursor: "pointer", display: "block",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f4fa", fontFamily: F, textTransform: "uppercase", letterSpacing: 0.5 }}>{rec.cn}</div>
                  {rec.addr && <div style={{ fontSize: 10, color: "#6a7890", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rec.addr}</div>}
                  {rec.phone && <div style={{ fontSize: 10, color: "#5a6580", marginTop: 1 }}>{rec.phone}</div>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Address with Places autocomplete */}
        <div style={{ position: "relative", marginBottom: 8 }}>
          <input
            value={addr}
            onChange={e => onAddrChange(e.target.value)}
            onFocus={() => addr.length >= 3 && setShowAddrDrop(addrSuggestions.length > 0)}
            onBlur={() => setTimeout(() => setShowAddrDrop(false), 150)}
            placeholder={isPlacesConfigured() ? "Address (start typing...)" : "Address"}
            style={inputStyle}
          />
          {showAddrDrop && addrSuggestions.length > 0 && (
            <div style={dropStyle}>
              <div style={{ padding: "6px 10px", fontSize: 9, color: "#5a6580", fontWeight: 700, fontFamily: F, letterSpacing: 0.5, textTransform: "uppercase", background: "#080a14", borderBottom: "1px solid #1a2030" }}>GOOGLE PLACES</div>
              {addrSuggestions.map((sug, i) => (
                <button key={sug.placeId} onMouseDown={(e) => e.preventDefault()} onClick={() => pickAddress(sug)} style={{
                  width: "100%", textAlign: "left", padding: "8px 10px",
                  background: "transparent", border: "none", borderBottom: i < addrSuggestions.length - 1 ? "1px solid #0e1220" : "none",
                  color: "#e0e8f0", cursor: "pointer", display: "block",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#f0f4fa" }}>{sug.mainText}</div>
                  {sug.secondaryText && <div style={{ fontSize: 10, color: "#6a7890", marginTop: 1 }}>{sug.secondaryText}</div>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Phone + email — autofilled by client pick, otherwise manual */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" inputMode="tel" style={{ ...inputStyle, flex: 1 }} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" inputMode="email" style={{ ...inputStyle, flex: 1.3 }} />
        </div>

        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Notes (scope, constraints, what to quote...)"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }}
        />

        {/* Time frame — only for visits & drive-bys (real arrival windows) */}
        {activeType.timed && <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {["AM", "PM", "All Day"].map(t => (
            <button key={t} onClick={() => setTime(t)} style={{
              flex: 1, padding: "8px 0", borderRadius: 8,
              background: time === t ? (t === "AM" ? "rgba(46,125,50,.2)" : "rgba(30,136,229,.2)") : "transparent",
              border: `1px solid ${time === t ? (t === "AM" ? "#66BB6A" : "#64B5F6") : "#1a2030"}`,
              color: time === t ? (t === "AM" ? "#66BB6A" : "#64B5F6") : "#4a5a70",
              fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F, letterSpacing: 0.5,
            }}>{t}</button>
          ))}
        </div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, background: "transparent", border: "1px solid #1a2030", color: "#5a6580", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} style={{
            flex: 2, padding: "10px 0", borderRadius: 8,
            background: activeType.color + "26",
            border: `1px solid ${activeType.color}55`,
            color: activeType.color,
            fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>
            {type === "pipeline" ? "Add to Pipeline →" : `Add ${activeType.label} →`}
          </button>
        </div>
      </div>
    </div>
  );
}
