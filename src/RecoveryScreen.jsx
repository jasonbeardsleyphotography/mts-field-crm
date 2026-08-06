import { useState, useCallback, useRef, useEffect } from "react";
import { parseEvent } from "./parseEvent";
import { loadFieldFromDrive } from "./driveSync";
import { listFieldIds, loadField, getFieldSlim } from "./fieldStore";
import { loadPipeline, savePipeline } from "./Pipeline";
import { photoKey } from "./imageUtils";
import {
  IconArrowLeft, IconSearch, IconImage, IconPlus, IconX,
  IconCheckCircle, IconCalendar,
} from "./icons";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Data Recovery Screen
   Search Google Calendar by name/job# or browse any date. Opens field data
   (photos, notes) straight from Drive regardless of age or pipeline status.
   ═══════════════════════════════════════════════════════════════════════════ */

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

// ── HELPERS ──────────────────────────────────────────────────────────────────
function formatDate(d) {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function photoSrc(p) {
  return p.dataUrl || p.url || null;
}

// ── PHOTO LIGHTBOX ────────────────────────────────────────────────────────────
function Lightbox({ photos, startIdx, onClose }) {
  const [idx, setIdx] = useState(startIdx);
  const src = photoSrc(photos[idx]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.93)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: "absolute", top: 16, right: 16, background: "rgba(255,255,255,.15)",
          border: "none", borderRadius: "50%", width: 40, height: 40,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", color: "#fff",
        }}
      >
        <IconX size={20} />
      </button>
      {idx > 0 && (
        <button
          onClick={e => { e.stopPropagation(); setIdx(i => i - 1); }}
          style={{
            position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,.15)", border: "none", borderRadius: "50%",
            width: 40, height: 40, cursor: "pointer", color: "#fff", fontSize: 20,
          }}
        >‹</button>
      )}
      {idx < photos.length - 1 && (
        <button
          onClick={e => { e.stopPropagation(); setIdx(i => i + 1); }}
          style={{
            position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,.15)", border: "none", borderRadius: "50%",
            width: 40, height: 40, cursor: "pointer", color: "#fff", fontSize: 20,
          }}
        >›</button>
      )}
      {src
        ? <img
            src={src}
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: "95vw", maxHeight: "90dvh", objectFit: "contain", borderRadius: 8 }}
            alt=""
          />
        : <div style={{ color: "#888" }}>Photo not available</div>
      }
      <div style={{ position: "absolute", bottom: 16, color: "#888", fontSize: 13 }}>
        {idx + 1} / {photos.length}
      </div>
    </div>
  );
}

// ── FIELD DATA VIEW ───────────────────────────────────────────────────────────
function FieldView({ stop, fieldData, loading, onBack, onAddToPipeline, alreadyInPipeline }) {
  const [lightbox, setLightbox] = useState(null); // index into allPhotos
  const [added, setAdded] = useState(alreadyInPipeline);

  const scopePhotos = fieldData?.scopePhotos || fieldData?.photos || [];
  const addonPhotos = fieldData?.addonPhotos || [];
  const allPhotos = [...scopePhotos, ...addonPhotos];

  const handleAdd = () => {
    onAddToPipeline(stop);
    setAdded(true);
  };

  const hdr = { background: "#0e1120", borderBottom: "1px solid #1a2035", padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top))", display: "flex", alignItems: "center", gap: 12, minHeight: 56, flexShrink: 0 };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#0a0b10", color: "#f0f4fa", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      {lightbox !== null && <Lightbox photos={allPhotos} startIdx={lightbox} onClose={() => setLightbox(null)} />}

      {/* Header */}
      <div style={hdr}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#7b8ab8", cursor: "pointer", padding: 4, display: "flex" }}>
          <IconArrowLeft size={22} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {stop.cn || "Unknown"}
          </div>
          <div style={{ fontSize: 12, color: "#5a6580" }}>
            {stop.jn ? `#${stop.jn} · ` : ""}{stop.addr || ""}
          </div>
        </div>
        {!added ? (
          <button
            onClick={handleAdd}
            style={{
              background: "#1a3a6e", border: "1px solid #2a5080", color: "#7ec8f8",
              borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
            }}
          >
            <IconPlus size={15} /> Add to Pipeline
          </button>
        ) : (
          <div style={{ color: "#4caf82", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
            <IconCheckCircle size={16} /> In Pipeline
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 32px" }}>
        {loading ? (
          <div style={{ color: "#5a6580", textAlign: "center", paddingTop: 48, fontSize: 14 }}>
            Loading data from Drive…
          </div>
        ) : (
          <>
            {/* Photo count summary */}
            {allPhotos.length === 0 && !fieldData?.scopeNotes && !fieldData?.addonNotes ? (
              <div style={{ color: "#5a6580", textAlign: "center", paddingTop: 48, fontSize: 14 }}>
                <IconImage size={32} style={{ display: "block", margin: "0 auto 12px", opacity: .4 }} />
                No photos or notes found for this stop in Drive.<br />
                <span style={{ fontSize: 12, opacity: .7 }}>Photos may still exist in the Drive photos folder by date.</span>
              </div>
            ) : null}

            {/* Photos — scope */}
            {scopePhotos.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#5a6580", textTransform: "uppercase", marginBottom: 10 }}>
                  Scope Photos ({scopePhotos.length})
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                  {scopePhotos.map((p, i) => {
                    const src = photoSrc(p);
                    return (
                      <div
                        key={photoKey(p) || i}
                        onClick={() => setLightbox(i)}
                        style={{
                          aspectRatio: "1", borderRadius: 8, overflow: "hidden",
                          background: "#1a2035", cursor: "pointer", position: "relative",
                        }}
                      >
                        {src
                          ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6580" }}><IconImage size={24} /></div>
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Scope notes */}
            {fieldData?.scopeNotes && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#5a6580", textTransform: "uppercase", marginBottom: 8 }}>Scope Notes</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "#d0d8f0", background: "#0e1120", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap" }}>
                  {fieldData.scopeNotes}
                </div>
              </div>
            )}

            {/* Photos — addon */}
            {addonPhotos.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#5a6580", textTransform: "uppercase", marginBottom: 10 }}>
                  Add-on Photos ({addonPhotos.length})
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                  {addonPhotos.map((p, i) => {
                    const src = photoSrc(p);
                    const globalIdx = scopePhotos.length + i;
                    return (
                      <div
                        key={photoKey(p) || i}
                        onClick={() => setLightbox(globalIdx)}
                        style={{
                          aspectRatio: "1", borderRadius: 8, overflow: "hidden",
                          background: "#1a2035", cursor: "pointer",
                        }}
                      >
                        {src
                          ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6580" }}><IconImage size={24} /></div>
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Addon notes */}
            {fieldData?.addonNotes && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#5a6580", textTransform: "uppercase", marginBottom: 8 }}>Add-on Notes</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "#d0d8f0", background: "#0e1120", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap" }}>
                  {fieldData.addonNotes}
                </div>
              </div>
            )}

            {/* AI summary */}
            {fieldData?.aiScopeSummary && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#5a6580", textTransform: "uppercase", marginBottom: 8 }}>AI Scope Summary</div>
                <div style={{ fontSize: 14, lineHeight: 1.6, color: "#d0d8f0", background: "#0e1120", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap" }}>
                  {fieldData.aiScopeSummary}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── STOP RESULT CARD ──────────────────────────────────────────────────────────
function StopCard({ stop, onClick }) {
  const startStr = stop._startMs ? formatDate(new Date(stop._startMs)) : null;
  return (
    <button
      onClick={() => onClick(stop)}
      style={{
        width: "100%", textAlign: "left", background: "#0e1120",
        border: "1px solid #1a2035", borderRadius: 10, padding: "14px 16px",
        marginBottom: 8, cursor: "pointer", color: "#f0f4fa",
        display: "flex", flexDirection: "column", gap: 4,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15 }}>{stop.cn || "Unknown"}</div>
      {stop.jn && <div style={{ fontSize: 12, color: "#7b8ab8" }}>Job #{stop.jn}</div>}
      {stop.addr && <div style={{ fontSize: 13, color: "#5a6580" }}>{stop.addr}</div>}
      {startStr && <div style={{ fontSize: 12, color: "#3a4560", marginTop: 2 }}>{startStr}</div>}
    </button>
  );
}

// ── MAIN RECOVERY SCREEN ──────────────────────────────────────────────────────
export default function RecoveryScreen({ token, onBack }) {
  const [mode, setMode] = useState("search"); // "search" | "date" | "device"
  const [query, setQuery] = useState("");
  // Default date: today
  const todayStr = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(todayStr);
  const [results, setResults] = useState(null); // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  // "On this device" recovery: every field record saved locally (IndexedDB),
  // regardless of whether its card still exists on Route/Pipeline. This is the
  // safety net for data attached to a card that got renamed/lost (e.g. a card
  // that saved as "stop").
  const [deviceRecords, setDeviceRecords] = useState(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [selected, setSelected] = useState(null); // stop object
  const [fieldData, setFieldData] = useState(null);
  const [fieldLoading, setFieldLoading] = useState(false);
  const inputRef = useRef(null);

  const pipeline = loadPipeline();

  const runSearch = useCallback(async () => {
    if (!token) return;
    if (mode === "search" && !query.trim()) return;
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      let url;
      if (mode === "search") {
        // Full-text search across all calendar events (past and future).
        // No timeMin = no lower bound, so old events are included.
        url = `${CAL_BASE}/events?q=${encodeURIComponent(query.trim())}&maxResults=50&singleEvents=true`;
      } else {
        // All events on a specific calendar date
        const d = new Date(date + "T12:00:00"); // noon to avoid TZ edge
        const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(d); dayEnd.setHours(23, 59, 59, 999);
        url = `${CAL_BASE}/events?timeMin=${dayStart.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=100`;
      }
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Calendar API ${res.status} — try signing out and back in`);
      const data = await res.json();
      const stops = (data.items || [])
        .map(ev => {
          const p = parseEvent(ev);
          if (!p) return null;
          const t = ev.start?.dateTime || ev.start?.date;
          p._startMs = t ? new Date(t).getTime() : 0;
          return p;
        })
        .filter(Boolean)
        .filter(s => s.isTask && !s.isAdmin);
      setResults(stops);
    } catch (e) {
      setError(e.message);
    }
    setSearching(false);
  }, [token, mode, query, date]);

  const openStop = useCallback(async (stop) => {
    setSelected(stop);
    setFieldData(null);
    setFieldLoading(true);
    try {
      const fd = await loadFieldFromDrive(token, stop.id);
      setFieldData(fd || {});
    } catch {
      setFieldData({});
    }
    setFieldLoading(false);
  }, [token]);

  // Scan every locally-stored field record (IndexedDB) and build a browsable
  // list with a name + note preview + photo count, so data attached to a
  // lost/renamed card can still be found and recovered.
  const loadDeviceRecords = useCallback(async () => {
    setDeviceLoading(true);
    try {
      const ids = await listFieldIds();
      const pl = loadPipeline(); // cheap: gives names for records that are pipeline cards
      const out = [];
      for (const id of ids) {
        // Use the SLIM (photo-free) summary for the list — loading every full
        // record (with base64 photos, now 3200px) at once blew up memory and
        // crashed the screen. Photos load only when a single card is tapped.
        const slim = getFieldSlim(id);
        let cn = pl[id]?.cn || "", jn = pl[id]?.jn || "", notes = "", photoCount = 0, savedAt = 0;
        if (slim) {
          notes = (slim.scopeNotes || slim.addonNotes || "").trim();
          photoCount = (slim._scopePhotoCount || 0) + (slim._addonPhotoCount || 0);
          savedAt = slim.savedAt || 0;
        } else {
          // No slim mirror (rare) — read the full record once, take only the
          // light fields, and release it so photos never accumulate.
          let d;
          try { d = await loadField(id); } catch { continue; }
          if (!d) continue;
          cn = cn || d.cn || "";
          jn = jn || d.jn || "";
          notes = (d.scopeNotes || d.myNotes || d.addonNotes || "").trim();
          photoCount = (d.scopePhotos || d.photos || []).length + (d.addonPhotos || []).length;
          savedAt = d.savedAt || 0;
          d = null;
        }
        if (!notes && photoCount === 0) continue; // skip empty records
        out.push({ id, cn, jn, notePreview: notes.slice(0, 120), photoCount, savedAt });
      }
      // Most recently saved first — the lost card was edited within the hour.
      out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      setDeviceRecords(out);
    } finally {
      setDeviceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "device" && deviceRecords === null && !deviceLoading) loadDeviceRecords();
  }, [mode, deviceRecords, deviceLoading, loadDeviceRecords]);

  // Open a device record — load its FULL data (photos included) from IndexedDB
  // now, for just this one card, so the list scan never has to hold photos.
  const openDeviceRecord = useCallback(async (rec) => {
    setSelected({ id: rec.id, cn: rec.cn || "(saved card)", addr: "", jn: rec.jn });
    setFieldData(null);
    setFieldLoading(true);
    try {
      const d = await loadField(rec.id);
      setFieldData(d || {});
    } catch {
      setFieldData({});
    }
    setFieldLoading(false);
  }, []);

  const addToPipeline = useCallback((stop) => {
    const pl = loadPipeline();
    if (!pl[stop.id]) {
      pl[stop.id] = {
        id: stop.id,
        cn: stop.cn, addr: stop.addr, phone: stop.phone, email: stop.email,
        jn: stop.jn, notes: stop.notes, constraint: stop.constraint,
        stage: "estimate_needed",
        addedAt: Date.now(),
        stageChangedAt: Date.now(),
        hot: false,
      };
      savePipeline(pl);
    }
  }, []);

  // Show field data view when a stop is selected
  if (selected) {
    return (
      <FieldView
        stop={selected}
        fieldData={fieldData}
        loading={fieldLoading}
        onBack={() => { setSelected(null); setFieldData(null); }}
        onAddToPipeline={addToPipeline}
        alreadyInPipeline={!!pipeline[selected.id]}
      />
    );
  }

  const hdr = {
    background: "#0e1120", borderBottom: "1px solid #1a2035",
    padding: "12px 16px", paddingTop: "max(12px, env(safe-area-inset-top))",
    display: "flex", alignItems: "center", gap: 12,
    minHeight: 56, flexShrink: 0,
  };
  const tabStyle = (active) => ({
    flex: 1, padding: "9px 0", borderRadius: 8, border: "none", cursor: "pointer",
    fontWeight: 600, fontSize: 14, fontFamily: "inherit",
    background: active ? "#1a2a50" : "transparent",
    color: active ? "#7ec8f8" : "#5a6580",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#0a0b10", color: "#f0f4fa", fontFamily: "'DM Sans',system-ui,sans-serif" }}>

      {/* Header */}
      <div style={hdr}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#7b8ab8", cursor: "pointer", padding: 4, display: "flex" }}>
          <IconArrowLeft size={22} />
        </button>
        <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: .3 }}>Data Recovery</div>
      </div>

      {/* Mode tabs */}
      <div style={{ display: "flex", gap: 6, padding: "12px 16px 0", flexShrink: 0 }}>
        <button style={{ ...tabStyle(mode === "search"), fontSize: 12 }} onClick={() => { setMode("search"); setResults(null); setError(null); }}>
          Name / Job #
        </button>
        <button style={{ ...tabStyle(mode === "date"), fontSize: 12 }} onClick={() => { setMode("date"); setResults(null); setError(null); }}>
          By Date
        </button>
        <button style={{ ...tabStyle(mode === "device"), fontSize: 12 }} onClick={() => { setMode("device"); setError(null); }}>
          On This Device
        </button>
      </div>

      {/* Search controls */}
      <div style={{ padding: "12px 16px", flexShrink: 0 }}>
        {mode === "device" ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, fontSize: 12, color: "#7ec8f8", fontFamily: "inherit", lineHeight: 1.4 }}>
              Everything saved on this device — including a card that lost its name. Newest first.
            </div>
            <button
              onClick={() => { setDeviceRecords(null); loadDeviceRecords(); }}
              disabled={deviceLoading}
              style={{
                background: "#1a3a6e", border: "1px solid #2a5080", borderRadius: 8,
                padding: "10px 16px", color: "#7ec8f8", fontWeight: 700, fontSize: 14,
                cursor: deviceLoading ? "default" : "pointer", opacity: deviceLoading ? .6 : 1,
                fontFamily: "inherit", whiteSpace: "nowrap",
              }}
            >{deviceLoading ? "Scanning…" : "Refresh"}</button>
          </div>
        ) : mode === "search" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") runSearch(); }}
              placeholder='e.g. "Ouriel" or "29740"'
              autoFocus
              style={{
                flex: 1, background: "#0e1120", border: "1px solid #1a2035",
                borderRadius: 8, padding: "10px 14px", color: "#f0f4fa",
                fontSize: 15, fontFamily: "inherit", outline: "none",
              }}
            />
            <button
              onClick={runSearch}
              disabled={searching || !query.trim()}
              style={{
                background: "#1a3a6e", border: "1px solid #2a5080", borderRadius: 8,
                padding: "10px 16px", color: "#7ec8f8", fontWeight: 700, fontSize: 14,
                cursor: searching ? "default" : "pointer", opacity: searching ? .6 : 1,
                display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit",
              }}
            >
              <IconSearch size={16} /> {searching ? "Searching…" : "Search"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              style={{
                flex: 1, background: "#0e1120", border: "1px solid #1a2035",
                borderRadius: 8, padding: "10px 14px", color: "#f0f4fa",
                fontSize: 15, fontFamily: "inherit", outline: "none",
                colorScheme: "dark",
              }}
            />
            <button
              onClick={runSearch}
              disabled={searching || !date}
              style={{
                background: "#1a3a6e", border: "1px solid #2a5080", borderRadius: 8,
                padding: "10px 16px", color: "#7ec8f8", fontWeight: 700, fontSize: 14,
                cursor: searching ? "default" : "pointer", opacity: searching ? .6 : 1,
                display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit",
              }}
            >
              <IconCalendar size={16} /> {searching ? "Loading…" : "Load"}
            </button>
          </div>
        )}

        {mode === "search" && (
          <div style={{ fontSize: 12, color: "#3a4560", marginTop: 8 }}>
            Searches all Google Calendar events — type a client name, job number, or address.
          </div>
        )}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 32px" }}>
        {error && (
          <div style={{ color: "#ff5555", fontSize: 13, padding: "12px 0" }}>{error}</div>
        )}

        {/* ── ON-THIS-DEVICE recovery list ─────────────────────────────── */}
        {mode === "device" && (
          deviceLoading && deviceRecords === null ? (
            <div style={{ color: "#5a6580", textAlign: "center", paddingTop: 40, fontSize: 14 }}>Scanning device storage…</div>
          ) : deviceRecords && deviceRecords.length === 0 ? (
            <div style={{ color: "#5a6580", textAlign: "center", paddingTop: 40, fontSize: 14 }}>No saved notes or photos found on this device.</div>
          ) : deviceRecords ? (
            <>
              <div style={{ fontSize: 12, color: "#3a4560", paddingBottom: 10 }}>
                {deviceRecords.length} saved card{deviceRecords.length !== 1 ? "s" : ""} — tap to view its notes &amp; photos
              </div>
              {deviceRecords.map(rec => (
                <button
                  key={rec.id}
                  onClick={() => openDeviceRecord(rec)}
                  style={{
                    width: "100%", textAlign: "left", background: "#0e1120",
                    border: "1px solid #1a2035", borderRadius: 10, padding: "14px 16px",
                    marginBottom: 8, cursor: "pointer", color: "#f0f4fa",
                    display: "flex", flexDirection: "column", gap: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rec.cn || "(no name)"}</div>
                    <div style={{ fontSize: 11, color: "#7b8ab8", flexShrink: 0 }}>
                      {rec.photoCount > 0 ? `${rec.photoCount} photo${rec.photoCount === 1 ? "" : "s"}` : ""}
                    </div>
                  </div>
                  {rec.jn && <div style={{ fontSize: 12, color: "#7b8ab8" }}>Job #{rec.jn}</div>}
                  {rec.notePreview && <div style={{ fontSize: 12.5, color: "#9aa8c0", lineHeight: 1.4 }}>{rec.notePreview}{rec.notePreview.length >= 120 ? "…" : ""}</div>}
                  {rec.savedAt > 0 && <div style={{ fontSize: 10, color: "#3a4560" }}>saved {formatDate(new Date(rec.savedAt))}</div>}
                </button>
              ))}
            </>
          ) : null
        )}

        {results !== null && results.length === 0 && !searching && (
          <div style={{ color: "#5a6580", textAlign: "center", paddingTop: 40, fontSize: 14 }}>
            No matching jobs found.
            {mode === "search" && <div style={{ fontSize: 12, marginTop: 8, opacity: .7 }}>Try the client's last name or just the job number.</div>}
          </div>
        )}

        {results !== null && results.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "#3a4560", paddingBottom: 10 }}>
              {results.length} job{results.length !== 1 ? "s" : ""} found — tap to view photos &amp; notes
            </div>
            {results.map(stop => (
              <StopCard key={stop.id} stop={stop} onClick={openStop} />
            ))}
          </>
        )}

        {mode !== "device" && results === null && !searching && (
          <div style={{ color: "#3a4560", textAlign: "center", paddingTop: 48, fontSize: 13, lineHeight: 1.7 }}>
            {mode === "search"
              ? 'Enter a name or job number above and tap Search.\nResults include all past and future jobs.'
              : 'Pick a date and tap Load to see all stops from that day.'}
          </div>
        )}
      </div>
    </div>
  );
}
