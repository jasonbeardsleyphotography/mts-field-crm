import { IconFire, IconRevision, IconPause, IconMail, IconX, IconCheckCircle, IconNoSymbol } from "./icons";
import OnsiteWindow from "./OnsiteWindow";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// Extract a Drive file ID from any Drive URL format we store.
function _driveFileId(url) {
  const m = (url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
             (url || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m?.[1] || null;
}

// Fetch a photo as a Blob. Uses Drive API with auth for Drive-hosted photos
// (direct fetch of thumbnail URLs is blocked by CORS on programmatic requests).
async function _fetchPhotoBlob(p, token) {
  if (p.dataUrl) {
    const res = await fetch(p.dataUrl);
    return await res.blob();
  }
  const fileId = _driveFileId(p.url);
  if (fileId && token) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.blob();
  }
  const res = await fetch(p.url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.blob();
}

// Trigger a direct file download via a blob: URL. Works on iOS 13+ (saves to
// Downloads / Files app), desktop, and Android. Does NOT use the Web Share API
// — that shows a system share sheet instead of downloading the file directly.
async function _saveBlobAsFile(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}
import { loadFieldFromDrive } from "./driveSync";
import { loadField, peekField, primeField, updateField } from "./fieldStore";
import { downscaleDataUrl, stripPhotoDataUrls, OVERSIZE_DATAURL_LEN, photoKey } from "./imageUtils";
import { listAll as listAllQueue, onQueueChange } from "./videoQueue";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Pipeline
   Hybrid: list+tabs on mobile, kanban columns on desktop.
   Auto-aging: Proposal Sent → Stale (3d), Stale → Declined (3d),
   Follow Up → Declined (3d). Paused cards skip aging.
   Bulk email with mailto: templates for Outlook.
   ═══════════════════════════════════════════════════════════════════════════ */

const STAGES = [
  { id: "estimate_needed", label: "Estimate needed", short: "Estimate", letter: "E", color: "#039BE5", bg: "rgba(3,155,229,.1)" },
  { id: "waiting",         label: "Waiting",         short: "Waiting",  letter: "W", color: "#8E24AA", bg: "rgba(142,36,170,.1)" },
  { id: "strong",          label: "Strong",          short: "Strong",   letter: "S", color: "#33B679", bg: "rgba(51,182,121,.1)" },
  { id: "weak",            label: "Weak",            short: "Weak",     letter: "K", color: "#E67C73", bg: "rgba(230,124,115,.1)" },
  { id: "follow_up",       label: "Follow up",       short: "Follow up",letter: "F", color: "#F6BF26", bg: "rgba(246,191,38,.1)" },
  { id: "sold",            label: "Sold",            short: "Sold",     letter: "✓", color: "#0B8043", bg: "rgba(11,128,67,.1)" },
  { id: "declined",        label: "Declined",        short: "Declined", letter: "D", color: "#616161", bg: "rgba(97,97,97,.1)" },
];

// Google Calendar colorId for each pipeline stage — must match the canonical
// color system used across the app (parseEvent.js STAGE_COLORS):
//   Basil (10)    = New Lead          Peacock (7)   = Proposal Sent – Strong
//   Grape (3)     = Needs Discussion  Lavender (1)  = Proposal Sent – Weak
//   Banana (5)    = Follow-Up 1       Flamingo (4)  = Follow-Up 2
//   Sage (2)      = Sold              Tomato (11)   = Declined
//   Graphite (8)  = Admin/Completed
const STAGE_CAL_COLOR = {
  estimate_needed: "10", // Basil    #0B8043  → New Lead
  waiting:         "3",  // Grape    #8E24AA  → Needs Discussion
  strong:          "7",  // Peacock  #039BE5  → Proposal Sent – Strong
  weak:            "1",  // Lavender #7986CB  → Proposal Sent – Weak
  follow_up:       "5",  // Banana   #F6BF26  → Follow-Up 1
  sold:            "2",  // Sage     #33B679  → Sold
  declined:        "11", // Tomato   #D50000  → Declined
};

async function pushCalendarColor(eventId, stage, token) {
  if (!token || !eventId || eventId.startsWith("local-")) return;
  const colorId = STAGE_CAL_COLOR[stage];
  if (!colorId) return;
  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ colorId }) }
    );
  } catch(e) { console.warn("Calendar color push failed:", e); }
}

async function pushToGoogleContacts(card, token) {
  if (!token || !card) return { success: false };
  const [givenName, ...rest] = (card.cn || "Unknown").split(" ");
  const familyName = rest.join(" ");
  const body = {
    names: [{ givenName, familyName }],
    ...(card.phone ? { phoneNumbers: [{ value: card.phone, type: "mobile" }] } : {}),
    ...(card.email ? { emailAddresses: [{ value: card.email }] } : {}),
    ...(card.addr  ? { addresses: [{ formattedValue: card.addr, type: "home" }] } : {}),
    ...(card.jn    ? { biographies: [{ value: `MTS Rochester — Job #${card.jn}`, contentType: "TEXT_PLAIN" }] } : {}),
  };
  try {
    // Search for existing contact by phone first
    if (card.phone) {
      const raw = (card.phone || "").replace(/\D/g, "");
      const sr = await fetch(
        `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(card.phone)}&readMask=names,phoneNumbers,emailAddresses,metadata&pageSize=5`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const sd = await sr.json();
      const existing = sd.results?.find(r =>
        (r.person?.phoneNumbers || []).some(p => p.value?.replace(/\D/g, "") === raw)
      );
      if (existing?.person?.resourceName) {
        const rn = existing.person.resourceName;
        const mask = ["names", card.phone && "phoneNumbers", card.email && "emailAddresses", card.addr && "addresses"].filter(Boolean).join(",");
        await fetch(
          `https://people.googleapis.com/v1/${rn}:updateContact?updatePersonFields=${mask}`,
          { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, etag: existing.person.etag }) }
        );
        return { success: true, action: "updated" };
      }
    }
    await fetch("https://people.googleapis.com/v1/people:createContact", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { success: true, action: "created" };
  } catch(e) { console.warn("Contact push failed:", e); return { success: false }; }
}

const PIPELINE_KEY = "mts-pipeline";
const FIELD_KEY = id => `mts-field-${id}`;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const FIVE_DAYS  = 5 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// SingleOps — open the base URL and copy the job number to clipboard for quick paste
const SINGLEOPS_URL = "https://app.singleops.com/";

const EMAIL_TEMPLATES = [
  { id: "checkin", label: "Quick check-in", subject: "Quick question about your estimate — Jason @ Monster Tree",
    body: "Hey {firstName}!\n\nJason with Monster Tree Service of Rochester here. Just wanted to pop in and make sure you got everything you needed from the proposal we sent over.\n\nAny questions at all? Happy to jump on a quick call or answer by email — whatever's easier for you. No pressure whatsoever.\n\nTalk soon,\nJason\nMonster Tree Service of Rochester" },
  { id: "followup", label: "Friendly follow-up", subject: "Following up on your tree care estimate — MTS Rochester",
    body: "Hi {firstName},\n\nJason from Monster Tree Service of Rochester here. Just following up on the estimate we put together for your property — wanted to make sure you had everything you need to make a decision.\n\nIf anything was unclear or if you'd like to talk through options, I'm just a text or call away. No rush at all on my end!\n\nBest,\nJason\nMonster Tree Service of Rochester" },
  { id: "seasonal", label: "Seasonal / schedule heads-up", subject: "Our schedule is filling in — MTS Rochester",
    body: "Hey {firstName},\n\nJason with Monster Tree here! Just wanted to give you a heads-up that our schedule is starting to fill in for the season. I didn't want you to miss your window if the tree work is still on your radar.\n\nNo pressure at all — just keeping you in the loop. If you have any questions or want to move forward, feel free to reach out anytime.\n\nThanks,\nJason\nMonster Tree Service of Rochester" },
];

const SMS_TEMPLATES = [
  { id: "sms_checkin", label: "Quick check-in",
    body: "Hey {firstName}, Jason with Monster Tree here! Just checking in to see if you had a chance to look over your proposal. Any questions at all? Happy to help 🌳" },
  { id: "sms_followup", label: "Friendly follow-up",
    body: "Hi {firstName}! Jason from MTS Rochester. Wanted to make sure the proposal came through okay. No rush — just here if you need anything!" },
  { id: "sms_seasonal", label: "Schedule heads-up",
    body: "Hey {firstName}, Jason with Monster Tree here. Just a heads up — our schedule is starting to fill in for the season. Didn't want you to miss your window if you're still interested! No pressure, just keeping you posted 🌿" },
];

function loadPipeline() { try { return JSON.parse(localStorage.getItem(PIPELINE_KEY)) || {}; } catch(e) { return {}; } }
function savePipeline(data) { try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(data)); } catch(e) {} }

// Union-merge two photo arrays by ts (timestamp key). Neither array is
// discarded — photos present only in local get kept (not yet synced to Drive),
// photos present only in cloud get kept (Drive is the canonical record).
// When the same photo appears in both, local dataUrl wins (highest fidelity,
// includes markup edits) and cloud url wins (canonical share link).
function _mergePhotoArrays(local = [], cloud = []) {
  const byKey = new Map();
  for (const p of local) {
    const k = photoKey(p);
    if (k) byKey.set(k, p);
  }
  for (const p of cloud) {
    const k = photoKey(p);
    if (!k) continue;
    if (byKey.has(k)) {
      const ex = byKey.get(k);
      byKey.set(k, { ...ex, ...p, dataUrl: ex.dataUrl || p.dataUrl });
    } else {
      byKey.set(k, p);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

const F = "'Oswald',sans-serif";

// Downscale any oversized (legacy 4K) photo dataUrls in a stop's field, one at
// a time to keep peak memory low, and persist the result through fieldStore's
// queue. Returns the updated field if anything shrank, else null.
async function _shrinkOversizedPhotosInField(id, field) {
  if (!field) return null;
  const sections = ["scopePhotos", "addonPhotos", "photos"];
  let changed = false;
  const next = { ...field };
  for (const key of sections) {
    const arr = field[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const out = [];
    for (const p of arr) {
      if (p && p.dataUrl && typeof p.dataUrl === "string" && p.dataUrl.length > OVERSIZE_DATAURL_LEN) {
        const small = await downscaleDataUrl(p.dataUrl);
        if (small !== p.dataUrl) { out.push({ ...p, dataUrl: small }); changed = true; }
        else out.push(p);
      } else {
        out.push(p);
      }
    }
    next[key] = out;
  }
  if (!changed) return null;
  await updateField(id, () => {
    const u = {};
    for (const key of sections) if (Array.isArray(next[key])) u[key] = next[key];
    return u;
  }).catch(() => {});
  return next;
}

// ═════════════════════════════════════════════════════════════════════════════
export default function Pipeline({ onSwitchToRoute, search = "", onCloudSync, token, lastContact = {}, markContact = () => {}, selectMode = false, setSelectMode = () => {}, onSelectCountChange = () => {}, bulkEmailTick = 0 }) {
  const [pipeline, setPipeline] = useState(() => loadPipeline());
  const [activeTab, setActiveTab] = useState("estimate_needed");
  const [selectedCard, setSelectedCard] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [selected, setSelected] = useState({}); // {id: true}
  const [emailSheet, setEmailSheet] = useState(false);
  const [emailPreview, setEmailPreview] = useState(null);
  const [pauseMenu, setPauseMenu] = useState(null);
  const [detailCard, setDetailCard] = useState(null);
  const [pipelineSheet, setPipelineSheet] = useState(null); // {card, type:'email'|'sms'}
  const [fieldCache, setFieldCache] = useState({}); // Drive-loaded field data cache
  const [detailLoading, setDetailLoading] = useState(false);
  const [contactSave, setContactSave] = useState({}); // {[cardId]: 'saving'|'saved'|'error'}
  // Email client preference — persisted so user doesn't have to re-select
  const [emailClient, setEmailClient] = useState(() => localStorage.getItem("mts-email-client") || "outlook_web");
  const [bulkEmailQueue, setBulkEmailQueue] = useState(null); // [{email,subject,body,name,cardId,opened}] | null
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [customTemplates, setCustomTemplates] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mts-email-templates") || "null") || {}; } catch { return {}; }
  });
  const [draftTemplates, setDraftTemplates] = useState(null); // edits in progress
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  // Pipeline undo — stores the card state snapshot before the last manual move
  const pipelineRef = useRef({});      // always-current mirror of pipeline (avoids stale closure)
  const [undoAction, setUndoAction] = useState(null); // { prevCard, label } | null
  const undoTimerRef = useRef(null);
  // Always-current ref to fieldCache so closures can access it without stale captures
  const fieldCacheRef = useRef({});
  useEffect(() => { fieldCacheRef.current = fieldCache; }, [fieldCache]);


  // ── DOWNLOAD PHOTOS ───────────────────────────────────────────────────
  const [downloadingPhotos, setDownloadingPhotos] = useState(false);

  // Individual JPGs, never a zip — on mobile (where Web Share supports
  // multiple files) this opens ONE share sheet with every photo attached, so
  // "Save Images" drops them all into Photos as separate files in one tap.
  // On desktop (no file-sharing support) it downloads each file individually
  // to the Downloads folder, one after another.
  const downloadAllPhotos = useCallback(async (card, scopePhotos, addonPhotos) => {
    const cleanName = card.cn.replace(/[^a-z0-9_\- ]/gi, "_");
    const all = [
      ...scopePhotos.map((p, i) => ({ p, name: `${cleanName}_scope_${String(i + 1).padStart(2, "0")}.jpg` })),
      ...addonPhotos.map((p, i) => ({ p, name: `${cleanName}_addon_${String(i + 1).padStart(2, "0")}.jpg` })),
    ].filter(x => x.p.dataUrl || x.p.url);
    if (!all.length) return;

    setDownloadingPhotos(true);
    try {
      const files = [];
      // Sequential to avoid hammering Drive API with many parallel auth'd fetches
      for (const { p, name } of all) {
        try {
          const blob = await _fetchPhotoBlob(p, token);
          files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
        } catch {}
      }
      if (!files.length) return;
      if (navigator.canShare && navigator.canShare({ files })) {
        try { await navigator.share({ files }); }
        catch (e) { if (e?.name !== "AbortError") console.warn("share failed:", e); }
        return;
      }
      for (const f of files) { await _saveBlobAsFile(f, f.name); }
    } catch (e) {
      console.warn("downloadAllPhotos failed:", e);
    } finally {
      setDownloadingPhotos(false);
    }
  }, [token]);

  // Land on "All" whenever this mounts with a search already filled in (e.g.
  // jumping here from Universal Search) — otherwise the tab bar keeps
  // showing "Estimate Needed" highlighted while the list is actually
  // searching every stage, which reads as a UI glitch.
  useEffect(() => { if (search.trim()) setActiveTab("all"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist
  useEffect(() => { savePipeline(pipeline); }, [pipeline]);
  useEffect(() => { if (onCloudSync) onCloudSync(); }, [pipeline, onCloudSync]);
  // Keep pipelineRef current so moveCard can snapshot prev state without a stale closure
  useEffect(() => { pipelineRef.current = pipeline; }, [pipeline]);

  // ── LOAD FIELD DATA FROM DRIVE WHEN DETAIL OPENS ───────────────────────
  useEffect(() => {
    if (!detailCard || !token) return;
    const id = detailCard.id;
    let dead = false;
    setDetailLoading(true);
    (async () => {
      let local = await loadField(id);
      if (dead) return;

      // Recovery: legacy photos captured at full 4K resolution OOM-crash the
      // renderer on open. Downscale any oversized photos (one at a time, so peak
      // memory stays low) and persist the shrink so the card renders safely AND
      // syncs a small payload to Drive. No-ops once photos are within budget.
      const shrunk = await _shrinkOversizedPhotosInField(id, local);
      if (dead) return;
      if (shrunk) local = shrunk;

      const hasLocal = !!(local.scopeNotes || local.myNotes || local.addonNotes ||
        (local.scopePhotos || local.photos || []).length ||
        (local.addonPhotos || []).length ||
        local.videoUrls?.length || local.videoUrl ||
        local.audioClips?.length);

      // Show local IDB data immediately — don't wait for the Drive round-trip.
      // This eliminates the first-open blank-photo window: IDB reads take ~10ms
      // while Drive takes 1–3s. The Drive merge below will update fieldCache
      // again with any cross-device photos once it arrives.
      if (hasLocal) {
        primeField(id, local);
        setFieldCache(prev => ({ ...prev, [id]: local }));
      }

      // Always try Drive to get freshest data (especially cross-device)
      try {
        const cloud = await loadFieldFromDrive(token, id);
        if (dead) return;
        if (cloud && Object.keys(cloud).length > 0) {
          // Run the merge through fieldStore's per-stop queue (updateField)
          // so it serializes with any concurrent writes (photoSync upload
          // completions, OnsiteWindow auto-save, photo capture). Reading
          // `existing` FRESHLY inside the transformer guarantees we don't
          // clobber photos added during the ~1-3s Drive round-trip.
          let merged = null;
          await updateField(id, (existing) => {
            const ex = existing || {};
            const localScope = ex.scopePhotos || ex.photos || [];
            const localAddon = ex.addonPhotos || [];
            const localAudio = ex.audioClips  || [];
            const localVids  = ex.videoUrls   || (ex.videoUrl ? [ex.videoUrl] : []);
            const cloudScope = cloud.scopePhotos || cloud.photos || [];
            const cloudAddon = cloud.addonPhotos || [];
            const cloudAudio = cloud.audioClips || [];
            const cloudVids  = cloud.videoUrls  || [];
            merged = {
              ...ex,
              ...cloud,
              scopePhotos: _mergePhotoArrays(localScope, cloudScope),
              addonPhotos: _mergePhotoArrays(localAddon, cloudAddon),
              audioClips: cloudAudio.length >= localAudio.length ? cloudAudio : localAudio,
              videoUrls: [...new Set([...localVids, ...cloudVids])],
            };
            return merged;
          }).catch(() => {});
          if (merged) {
            primeField(id, merged);
            setFieldCache(prev => ({ ...prev, [id]: merged }));
          }
        } else if (!hasLocal) {
          // No local data and Drive returned empty — nothing to show
        }
      } catch {
        // Drive failed — local data was already shown above
      }
      if (!dead) setDetailLoading(false);
    })();
    return () => { dead = true; };
  }, [detailCard?.id, token]);

  // Runs on mount, on interval (every 5 min when tab visible), and when the
  // tab becomes visible again — catches cards that entered 'waiting' after
  // mount and ages them without requiring a full reload.
  useEffect(() => {
    const ageCards = () => {
      const now = Date.now();
      let changed = false;
      setPipeline(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(id => {
          const card = updated[id];
          if (card.pauseUntil && now < card.pauseUntil) return;
          if (card.pauseUntil && now >= card.pauseUntil) {
            updated[id] = { ...card, pauseUntil: null, stageChangedAt: now };
            changed = true;
            return;
          }
          const age = now - (card.stageChangedAt || card.addedAt || now);
          // NOTE: "estimate_needed" and "waiting" never auto-age — cards only
          // leave those columns when the user explicitly moves them.
          if (card.stage === "strong" && age > FIVE_DAYS) {
            updated[id] = { ...card, stage: "follow_up", stageChangedAt: now };
            changed = true;
          } else if (card.stage === "weak" && age > THREE_DAYS) {
            updated[id] = { ...card, stage: "declined", stageChangedAt: now, autoDeclined: true };
            changed = true;
          } else if (card.stage === "follow_up" && age > THREE_DAYS) {
            updated[id] = { ...card, stage: "declined", stageChangedAt: now, autoDeclined: true };
            changed = true;
          }
        });
        return changed ? updated : prev;
      });
    };

    ageCards();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") ageCards();
    }, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") ageCards(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Cards grouped by stage
  const cardsByStage = useMemo(() => {
    const groups = {};
    STAGES.forEach(s => { groups[s.id] = []; });
    Object.values(pipeline).forEach(card => {
      // Bucket any card whose stage isn't a known stage (missing/null/legacy
      // or renamed value, or a corrupted cloud-merged record) into
      // estimate_needed instead of dropping it. Previously such a card landed
      // in NO group, making it invisible on the desktop kanban and in every
      // mobile stage tab — reachable only via the "All" tab or search. That
      // was a real "shows in search but not on any board / lost card" vector.
      const bucket = groups[card.stage] ? card.stage : "estimate_needed";
      groups[bucket].push(card);
    });
    Object.keys(groups).forEach(k => {
      if (k === "declined") {
        groups[k].sort((a, b) => (b.stageChangedAt || b.addedAt || 0) - (a.stageChangedAt || a.addedAt || 0));
      } else {
        groups[k].sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (a.addedAt || 0) - (b.addedAt || 0));
      }
    });
    return groups;
  }, [pipeline]);

  const allCards = useMemo(() => Object.values(pipeline), [pipeline]);

  // Precomputed per-card field summary — uses fieldStore.peekField (sync).
  // If a card's data isn't in the peek mirror yet, we kick off an async
  // IDB load below which primes the mirror and bumps the version.
  const [fieldSummaryVersion, setFieldSummaryVersion] = useState(0);
  useEffect(() => {
    const bump = () => setFieldSummaryVersion(v => v + 1);
    window.addEventListener("mts-field-synced", bump);
    return () => window.removeEventListener("mts-field-synced", bump);
  }, []);

  // Hydrate all cards from IndexedDB to get full data (photos, etc.) into the mirror.
  // peekField only returns the slim localStorage mirror (no photos), so we always load
  // from IDB to get accurate photo counts and to prime the mirror for closures.
  useEffect(() => {
    let dead = false;
    (async () => {
      let hydrated = false;
      for (const card of allCards) {
        try {
          const fresh = await loadField(card.id);
          if (dead) return;
          if (fresh && Object.keys(fresh).length > 0) {
            // Prime a base64-stripped copy: the summary only needs photo COUNTS,
            // and holding every card's full-res base64 in the mirror OOM-crashes
            // the renderer. The open card's full data lives in fieldCache.
            primeField(card.id, stripPhotoDataUrls(fresh));
            hydrated = true;
          }
        } catch {}
      }
      if (hydrated && !dead) setFieldSummaryVersion(v => v + 1);
    })();
    return () => { dead = true; };
  }, [allCards]);

  const fieldSummaryMap = useMemo(() => {
    const m = {};
    for (const card of allCards) {
      const fd = peekField(card.id);
      m[card.id] = {
        photoCount: (fd.scopePhotos || fd.photos || []).length + (fd.addonPhotos || []).length,
        hasNotes: !!(fd.scopeNotes || fd.myNotes || fd.addonNotes),
        hasVideo: !!(fd.videoUrls?.length || fd.videoUrl),
      };
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCards, fieldSummaryVersion]);

  // ── Live video upload queue indexed by stopId ─────────────────────────
  // So each pipeline card can show a small "↑ uploading 47%" pill if it
  // has active uploads. Without this, when a card moves from route to
  // pipeline, the user loses sight of in-flight uploads.
  const [queueByStop, setQueueByStop] = useState({});
  useEffect(() => {
    let alive = true;
    const ingest = (all) => {
      const m = {};
      for (const it of all) {
        if (!m[it.stopId]) m[it.stopId] = [];
        m[it.stopId].push(it);
      }
      if (alive) setQueueByStop(m);
    };
    listAllQueue().then(ingest);
    const off = onQueueChange(ingest);
    return () => { alive = false; off(); };
  }, []);

  // When the Drive upload queue finishes a video, update fieldCache
  // with the new Drive URL so the detail popup shows it without needing a reload.
  useEffect(() => {
    const handler = (e) => {
      const { stopId, shareUrl } = e.detail || {};
      if (!stopId || !shareUrl) return;
      setFieldCache(prev => {
        const cur = prev[stopId] || {};
        const existing = cur.videoUrls || [];
        if (existing.includes(shareUrl)) return prev;
        return { ...prev, [stopId]: { ...cur, videoUrls: [...existing, shareUrl] } };
      });
    };
    window.addEventListener("mts-video-uploaded", handler);
    return () => window.removeEventListener("mts-video-uploaded", handler);
  }, []);

  // Cards in waiting for 2+ days (due for follow-up nudge)
  const dueForFollowUp = useMemo(() => {
    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return allCards.filter(c => c.stage === "waiting" && !c.pauseUntil && (now - (c.stageChangedAt || c.addedAt || now)) > TWO_DAYS);
  }, [allCards]);

  // Search filter
  const searchFilter = useCallback((card) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (card.cn || "").toLowerCase().includes(q) || (card.addr || "").toLowerCase().includes(q) || (card.jn || "").includes(q);
  }, [search]);

  // Move card to stage + push color to Google Calendar
  // Records estimateSentAt the first time a card leaves estimate_needed.
  // opts.noUndo = true skips the undo snapshot (used by auto-aging so you
  // can't undo automatic decays — only manual moves should be undoable).
  const moveCard = useCallback((id, newStage, opts = {}) => {
    if (!opts.noUndo) {
      const prevCard = pipelineRef.current[id];
      if (prevCard) {
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
        const toLabel = STAGES.find(s => s.id === newStage)?.short || newStage;
        setUndoAction({ prevCard, label: `${prevCard.cn} → ${toLabel}` });
        undoTimerRef.current = setTimeout(() => setUndoAction(null), 6000);
      }
    }
    setPipeline(prev => {
      const card = prev[id];
      const leavingEstimate = card?.stage === "estimate_needed" && newStage !== "estimate_needed";
      return {
        ...prev,
        [id]: {
          ...card,
          stage: newStage,
          stageChangedAt: Date.now(),
          autoDeclined: false,
          ...(leavingEstimate && !card?.estimateSentAt ? { estimateSentAt: Date.now() } : {}),
        },
      };
    });
    if (token) pushCalendarColor(id, newStage, token);
  }, [token]);

  const undoMove = useCallback(() => {
    if (!undoAction) return;
    const { prevCard } = undoAction;
    setPipeline(prev => ({ ...prev, [prevCard.id]: prevCard }));
    if (token) pushCalendarColor(prevCard.id, prevCard.stage, token);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoAction(null);
  }, [undoAction, token]);

  // Reactivate = move from declined back to estimate_needed
  const reactivate = useCallback((id) => {
    moveCard(id, "estimate_needed");
  }, [moveCard]);

  // Toggle hot lead
  const toggleHot = useCallback((id) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], hot: !prev[id]?.hot } }));
  }, []);

  // Toggle revision flag
  const toggleRevision = useCallback((id) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], revision: !prev[id]?.revision } }));
  }, []);

  // Pause for N days
  const pauseFor = useCallback((id, days) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], pauseUntil: Date.now() + days * 24 * 60 * 60 * 1000 } }));
    setPauseMenu(null);
  }, []);

  // Unpause
  const unpause = useCallback((id) => {
    setPipeline(prev => ({ ...prev, [id]: { ...prev[id], pauseUntil: null, stageChangedAt: Date.now() } }));
  }, []);

  // Days since stage change
  const daysSince = (ts) => {
    if (!ts) return "—";
    const d = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
    return d === 0 ? "today" : d === 1 ? "1d" : `${d}d`;
  };

  // Tiny "tick" sound for clipboard-copy feedback — synthesized via WebAudio
  // so no audio asset is needed.
  const playCopiedSound = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 1100;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      osc.onended = () => ctx.close();
    } catch {}
  };

  const copyClientName = (name) => {
    if (!name) return;
    navigator.clipboard?.writeText(name).then(playCopiedSound).catch(() => {});
  };

  // Format a lastContact entry into "Called · 2h ago" style.
  // Returns null if no contact recorded.
  const formatContact = (lc) => {
    if (!lc || !lc.at) return null;
    const mins = Math.floor((Date.now() - lc.at) / 60000);
    const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins/60)}h ago` : `${Math.floor(mins/1440)}d ago`;
    const kind = lc.kind === "sms" ? "Texted" : lc.kind === "call" ? "Called" : lc.kind === "email" ? "Emailed" : "Contacted";
    return `${kind} · ${ago}`;
  };

  // Open SingleOps and copy job number to clipboard for quick paste
  const openSingleOps = (jn) => {
    if (!jn) return;
    navigator.clipboard?.writeText(jn).catch(() => {});
    window.open(SINGLEOPS_URL, "_blank");
  };

  // Desktop drag
  const onDragStart = (e, id) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (e, stageId) => { e.preventDefault(); if (dragId) { moveCard(dragId, stageId); setDragId(null); } };

  // Select mode
  const toggleSelect = (id) => { setSelected(prev => { const n = { ...prev }; if (n[id]) delete n[id]; else n[id] = true; return n; }); };
  const selectedCards = useMemo(() => Object.keys(selected).map(id => pipeline[id]).filter(Boolean), [selected, pipeline]);
  const selectedCount = selectedCards.length;
  useEffect(() => { onSelectCountChange(selectedCount); }, [selectedCount, onSelectCountChange]);
  useEffect(() => { if (!selectMode) setSelected({}); }, [selectMode]);
  // Header Email button (App.jsx) increments bulkEmailTick to open the sheet.
  useEffect(() => { if (bulkEmailTick > 0) setEmailSheet(true); }, [bulkEmailTick]);

  // ── BULK EMAIL + SMS ────────────────────────────────────────
  // ── EMAIL COMPOSE HELPER ─────────────────────────────────────────────
  // Builds the compose URL for the selected email client.
  // Exposed separately so the bulk queue can put it in an <a href> — that
  // lets middle-click / right-click → open in new tab work natively.
  const buildComposeUrl = useCallback((to, subject, body, client) => {
    const cl = client || emailClient;
    if (cl === "outlook_web") {
      return `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    } else if (cl === "outlook_live") {
      return `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    } else {
      return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
  }, [emailClient]);

  const openEmailCompose = useCallback((to, subject, body, client) => {
    const url = buildComposeUrl(to, subject, body, client);
    if ((client || emailClient) === "mailto") window.open(url, "_self");
    else window.open(url, "_blank");
  }, [buildComposeUrl, emailClient]);

  const saveEmailClient = (cl) => {
    setEmailClient(cl);
    localStorage.setItem("mts-email-client", cl);
  };

  // Effective templates — defaults merged with any user edits stored in localStorage
  const effectiveTemplates = EMAIL_TEMPLATES.map(t => ({ ...t, ...(customTemplates?.[t.id] || {}) }));

  const saveCustomTemplates = (updates) => {
    setCustomTemplates(updates);
    try { localStorage.setItem("mts-email-templates", JSON.stringify(updates)); } catch {}
  };

  // Build the queue — user then taps each recipient button to open one tab per click
  // Auto-moves Strong / Weak cards → Follow Up when an email campaign is sent
  const sendBulkEmail = (template) => {
    const queue = selectedCards
      .filter(c => c.email)
      .map(c => {
        const firstName = (c.cn || "").split(" ")[0];
        const body = template.body.replace(/\{firstName\}/g, firstName);
        return { email: c.email, subject: template.subject, body, name: firstName, cardId: c.id, opened: false };
      });
    setBulkEmailQueue(queue);
    // Auto-advance: Strong/Weak → Follow Up after sending an email campaign
    selectedCards.forEach(c => {
      if (c.stage === "strong" || c.stage === "weak") moveCard(c.id, "follow_up");
    });
  };

  const sendBulkSms = (template) => {
    selectedCards.forEach((card, i) => {
      const firstName = (card.cn || "").split(" ")[0];
      const body = template.body.replace(/\{firstName\}/g, firstName);
      const phone = (card.phone || "").replace(/\D/g, "");
      if (!phone) return;
      setTimeout(() => {
        window.open(`sms:${phone}&body=${encodeURIComponent(body)}`, "_self");
        markContact(card.id, "sms");
      }, i * 1200);
    });
    setPipelineSheet(null); setSelectMode(false); setSelected({});
  };

  // ── RENDER CARD ─────────────────────────────────────────────────────────
  const renderCard = (card, compact) => {
    if (!searchFilter(card)) return null;
    const stage = STAGES.find(s => s.id === card.stage);
    const summary = fieldSummaryMap[card.id] || { photoCount: 0, hasNotes: false, hasVideo: false };
    const { photoCount, hasNotes, hasVideo } = summary;
    const isSelected = !!selected[card.id];
    const isDeclined = card.stage === "declined";
    const isPendingReject = !!card.pendingRejectInSingleops;
    // Days-without-contact warning: show if 7+ days since last contact AND card is active
    const lc = lastContact[card.id];
    const daysSinceContact = lc?.at ? Math.floor((Date.now() - lc.at) / (24 * 60 * 60 * 1000)) : null;
    const contactWarning = !isDeclined && card.stage !== "sold" && daysSinceContact !== null && daysSinceContact >= 7;

    return (
      <div
        key={card.id}
        draggable={!selectMode}
        onDragStart={e => onDragStart(e, card.id)}
        onClick={() => {
          if (selectMode) { toggleSelect(card.id); return; }
          // Clear stale cache so the render uses peekField (in-memory mirror,
          // always current) until the async IDB+Drive load completes.
          setFieldCache(prev => { const n = { ...prev }; delete n[card.id]; return n; });
          setDetailCard(card);
        }}
        style={{
          padding: compact ? "10px 12px" : "12px 14px",
          background: isPendingReject ? "rgba(255,140,0,.10)" : isSelected ? "rgba(59,130,246,.08)" : card.hot ? "rgba(255,160,0,.05)" : "#0e1020",
          borderBottom: "1px solid #0e1220",
          borderLeft: `4px solid ${isPendingReject ? "#FF8C00" : isSelected ? "#3B82F6" : card.hot ? "#FFB300" : stage?.color || "#555"}`,
          cursor: "pointer",
          transition: "background .15s",
          opacity: isDeclined && !selectMode ? 0.6 : 1,
        }}
      >
        {/* Reject-in-SingleOps banner */}
        {isPendingReject && <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,padding:"4px 8px",borderRadius:6,background:"rgba(255,140,0,.2)",border:"1px solid rgba(255,140,0,.4)"}}>
          <IconNoSymbol size={12} color="#FF8C00"/>
          <span style={{fontSize:10,fontWeight:800,color:"#FF8C00",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",flex:1}}>REJECT IN SINGLEOPS</span>
          <button onClick={e=>{e.stopPropagation();setPipeline(prev=>{const next={...prev};if(next[card.id]){next[card.id]={...next[card.id],pendingRejectInSingleops:false};}return next;});}} style={{padding:"2px 6px",borderRadius:4,background:"rgba(255,140,0,.2)",border:"1px solid rgba(255,140,0,.4)",color:"#FF8C00",fontSize:9,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.3}}>DONE</button>
        </div>}
        {/* Top row */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {selectMode && <div style={{width:22,height:22,borderRadius:6,border:`2px solid ${isSelected?"#3B82F6":"#252d47"}`,background:isSelected?"#3B82F6":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:12,color:"#fff",fontWeight:800}}>{isSelected && <IconCheckCircle size={13} color="#fff"/>}</div>}
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:compact?14:15,fontWeight:600,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {card.hot && <IconFire size={12} color="#FFB300" style={{marginRight:3,flexShrink:0}}/>}
              {card.revision && <IconRevision size={12} color="#FF6B9D" style={{marginRight:3,flexShrink:0}}/>}
              {card.pauseUntil && Date.now() < card.pauseUntil && <IconPause size={12} color="#8a96a8" style={{marginRight:3,flexShrink:0}}/>}
              {card.cn}
            </div>
            {card.addr && <div style={{fontSize:11,color:"#6a7890",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1,fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{card.addr}</div>}
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,flexShrink:0}}>
            {!compact && <span style={{fontSize:10,padding:"2px 4px 2px 3px",borderRadius:99,background:stage?.bg,color:stage?.color,fontWeight:700,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",display:"inline-flex",alignItems:"center",gap:5}}>
              <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:14,height:14,borderRadius:7,background:stage?.color,color:"#fff",fontSize:9,fontWeight:800}}>{stage?.letter}</span>
              <span style={{paddingRight:6}}>{stage?.label}</span>
            </span>}
            {compact && <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:16,height:16,borderRadius:8,background:stage?.color,color:"#fff",fontSize:10,fontWeight:800}}>{stage?.letter}</span>}
            {(() => {
              const lc = formatContact(lastContact[card.id]);
              return lc ? <span style={{fontSize:9,color:"#64B5F6",fontWeight:600,fontFamily:F,letterSpacing:0.3,textTransform:"uppercase"}}>{lc}</span> : null;
            })()}
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <span style={{fontSize:10,color:card.stage==="weak"?"#FF8A65":"#4a5a70"}}>{daysSince(card.estimateSentAt || (card.stage !== "estimate_needed" ? card.stageChangedAt : null) || card.addedAt)}</span>
              {contactWarning && <span style={{fontSize:9,padding:"1px 4px",borderRadius:4,background:"rgba(230,124,115,.12)",border:"1px solid rgba(230,124,115,.25)",color:"#E67C73",fontWeight:700,fontFamily:F}}>⚠{daysSinceContact}d</span>}
              {(() => {
                const q = queueByStop[card.id] || [];
                if (q.length === 0) return null;
                const hasErr = q.some(i => i.status === "error");
                const color = hasErr ? "#FF5555" : "#10B981";
                return <span style={{fontSize:9,padding:"1px 4px",borderRadius:4,background:`${color}18`,border:`1px solid ${color}44`,color,fontWeight:700}}>↑</span>;
              })()}
            </div>
          </div>
        </div>

      </div>
    );
  };

  // ── MOBILE: List + Tabs ──────────────────────────────────────────────────
  const mobileView = () => {
    // A search must always look across every stage — a card the tab filter
    // would otherwise hide (because activeTab resets to "estimate_needed"
    // every time this component remounts, e.g. jumping here from Universal
    // Search) previously read as "not in the pipeline" when it was really
    // just sitting on a different, currently-unselected tab.
    const filtered = (search.trim() || activeTab === "all") ? allCards : (cardsByStage[activeTab] || []);
    const sorted = [...filtered].filter(searchFilter).sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (a.addedAt || 0) - (b.addedAt || 0));

    return (
      <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
        {/* Tabs */}
        <div style={{display:"flex",overflowX:"auto",borderBottom:"1px solid #1a2030",flexShrink:0,background:"#0d0f18"}}>
          <button onClick={()=>setActiveTab("all")} style={{padding:"8px 14px",fontSize:11,fontWeight:activeTab==="all"?700:500,color:activeTab==="all"?"#3B82F6":"#4a5a70",borderBottom:activeTab==="all"?"2px solid #039BE5":"2px solid transparent",background:"transparent",border:"none",borderBottomStyle:"solid",cursor:"pointer",whiteSpace:"nowrap",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>All ({allCards.length})</button>
          {STAGES.map(st => {
            const count = (cardsByStage[st.id] || []).length;
            return <button key={st.id} onClick={()=>setActiveTab(st.id)} style={{padding:"8px 12px",fontSize:11,fontWeight:activeTab===st.id?700:500,color:activeTab===st.id?st.color:"#4a5a70",borderBottom:activeTab===st.id?`2px solid ${st.color}`:"2px solid transparent",background:"transparent",border:"none",borderBottomStyle:"solid",cursor:"pointer",whiteSpace:"nowrap",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",position:"relative"}}>
              {st.short} {count > 0 && <span style={{fontSize:9,color:st.color,marginLeft:2}}>({count})</span>}
              {st.id === "weak" && count > 0 && <span style={{position:"absolute",top:4,right:2,width:5,height:5,borderRadius:3,background:"#FF8A65"}}/>}
            </button>;
          })}
        </div>

        {/* Summary */}
        <div style={{padding:"6px 14px",background:"#0a0b10",borderBottom:"1px solid #1a2030",display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:14,fontWeight:600,color:"#f0f4fa"}}>{sorted.length} cards</span>
          {(cardsByStage.weak || []).length > 0 && <span style={{fontSize:11,color:"#FF8A65",fontWeight:600}}>{cardsByStage.weak.length} stale</span>}
          {selectMode && sorted.length > 0 && (
            <button onClick={()=>{
              const allInTab = sorted.every(c => selected[c.id]);
              if (allInTab) {
                setSelected(prev => { const n={...prev}; sorted.forEach(c=>delete n[c.id]); return n; });
              } else {
                setSelected(prev => { const n={...prev}; sorted.forEach(c=>{n[c.id]=true;}); return n; });
              }
            }} style={{marginLeft:"auto",padding:"3px 9px",borderRadius:5,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
              {sorted.every(c => selected[c.id]) ? "Deselect All" : "Select All"}
            </button>
          )}
        </div>

        {/* Follow-up reminder banner */}
        {dueForFollowUp.length > 0 && !selectMode && <div style={{padding:"8px 14px",background:"rgba(246,191,38,.06)",borderBottom:"1px solid rgba(246,191,38,.15)",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,color:"#F6BF26",fontWeight:600,flex:1}}>{dueForFollowUp.length} card{dueForFollowUp.length>1?"s":""} waiting 2+ days — follow up?</span>
          <button onClick={()=>{setSelectMode(true);const sel={};dueForFollowUp.forEach(c=>{sel[c.id]=true;});setSelected(sel);}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#F6BF26"/>Select all</span></button>
        </div>}

        {/* Card list */}
        <div className="mts-pl-col" style={{flex:1,overflowY:"auto",paddingBottom:selectMode && selectedCount>0?"max(70px,calc(60px + env(safe-area-inset-bottom)))":"max(12px,env(safe-area-inset-bottom))"}}>
          {sorted.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No cards{search ? ` matching "${search}"` : ""}</div>}
          {sorted.map(card => renderCard(card, false))}
        </div>

      </div>
    );
  };

  // ── DESKTOP: Kanban columns ──────────────────────────────────────────────
  const desktopView = () => (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      <div style={{display:"flex",flex:1,overflow:"hidden",gap:0}}>
        {STAGES.map(st => {
          const cards = (cardsByStage[st.id] || []).filter(searchFilter);
          return (
            <div key={st.id} onDragOver={onDragOver} onDrop={e => onDrop(e, st.id)}
              style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",borderRight:"1px solid #1a2030"}}>
              <div style={{padding:"8px 10px",background:"#0d0f18",borderBottom:"1px solid #1a2030",flexShrink:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:4,background:st.color,flexShrink:0}}/>
                  <span style={{fontSize:11,fontWeight:600,color:st.color,fontFamily:F,textTransform:"uppercase",letterSpacing:1,flex:1}}>{st.label}</span>
                  <span style={{fontSize:10,color:"#4a5a70",fontWeight:600}}>{cards.length}</span>
                  {selectMode && cards.length > 0 && (
                    <button onClick={()=>{
                      const allInCol = cards.every(c => selected[c.id]);
                      if (allInCol) {
                        setSelected(prev => { const n={...prev}; cards.forEach(c=>delete n[c.id]); return n; });
                      } else {
                        setSelected(prev => { const n={...prev}; cards.forEach(c=>{n[c.id]=true;}); return n; });
                      }
                    }} style={{padding:"2px 7px",borderRadius:5,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:9,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",flexShrink:0}}>
                      {cards.every(c => selected[c.id]) ? "Deselect" : "All"}
                    </button>
                  )}
                </div>
              </div>
              <div className="mts-pl-col" style={{flex:1,overflowY:"auto",padding:4,paddingBottom:selectMode && selectedCount>0?"max(70px,calc(60px + env(safe-area-inset-bottom)))":4}}>
                {cards.map(card => <div key={card.id} style={{marginBottom:4}}>{renderCard(card, true)}</div>)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      <div className="mts-pipeline-mobile" style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>{mobileView()}</div>
      <div className="mts-pipeline-desktop" style={{display:"none",flex:1,overflow:"hidden"}}>{desktopView()}</div>

      {/* ── SELECT MODE ACTION BAR (shared mobile + desktop) ───────── */}
      {selectMode && selectedCount > 0 && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",background:"#0d0f18",borderTop:"1px solid #1a2030",display:"flex",gap:8,alignItems:"center",paddingBottom:"max(10px,env(safe-area-inset-bottom))",zIndex:50}}>
          <span style={{fontSize:12,color:"#90a8c0",fontWeight:600}}>{selectedCount} selected</span>
          <div style={{flex:1}}/>
          <button onClick={()=>setEmailSheet(true)} style={{padding:"8px 14px",borderRadius:8,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:12,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#3B82F6"/>Email</span></button>
          <button onClick={()=>setPipelineSheet({card:null,type:"sms_bulk"})} style={{padding:"8px 14px",borderRadius:8,background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.2)",color:"#10B981",fontSize:12,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}>💬 Text</span></button>
          <button onClick={()=>setBulkMoveOpen(true)} style={{padding:"8px 14px",borderRadius:8,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>Move →</button>
          {bulkMoveOpen && (
            <div onClick={()=>setBulkMoveOpen(false)} style={{position:"fixed",inset:0,zIndex:200}}>
              <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:"calc(max(10px,env(safe-area-inset-bottom)) + 54px)",right:16,background:"#0d0f18",border:"1px solid #1a2030",borderRadius:12,padding:"8px 0",minWidth:180,boxShadow:"0 4px 20px rgba(0,0,0,.5)"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",padding:"4px 14px 8px",fontFamily:F}}>Move {selectedCount} cards to</div>
                {STAGES.filter(st => st.id !== "declined").map(st => (
                  <button key={st.id} onClick={()=>{
                    selectedCards.forEach(c => moveCard(c.id, st.id));
                    setBulkMoveOpen(false);
                    setSelected({});
                    setSelectMode(false);
                  }} style={{width:"100%",padding:"9px 14px",background:"transparent",border:"none",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",gap:8}}>
                    <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:16,height:16,borderRadius:8,background:st.color,color:"#fff",fontSize:9,fontWeight:800,flexShrink:0}}>{st.letter}</span>
                    <span style={{fontSize:13,color:"#c0d0e0",fontWeight:600}}>{st.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── UNDO TOAST ─────────────────────────────────────────────── */}
      {undoAction && (
        <div style={{position:"fixed",bottom:"max(80px,calc(70px + env(safe-area-inset-bottom)))",left:"50%",transform:"translateX(-50%)",zIndex:300,display:"flex",alignItems:"center",gap:10,padding:"10px 16px",borderRadius:12,background:"#1a2035",border:"1px solid #2a3560",boxShadow:"0 4px 20px rgba(0,0,0,.5)",whiteSpace:"nowrap",pointerEvents:"all"}}>
          <span style={{fontSize:12,color:"#90a8c0",fontFamily:F,letterSpacing:0.5}}>{undoAction.label}</span>
          <button onClick={undoMove} style={{padding:"5px 12px",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.35)",color:"#3B82F6",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>UNDO</button>
          <button onClick={()=>{clearTimeout(undoTimerRef.current);setUndoAction(null);}} style={{width:20,height:20,borderRadius:4,background:"transparent",border:"none",color:"#4a5a70",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>✕</button>
        </div>
      )}

      {/* ── FULL CARD DETAIL POPUP ──────────────────────────────────── */}
      {detailCard && (() => {
        const card = detailCard;
        const fd = fieldCache[card.id] || peekField(card.id);
        const stage = STAGES.find(st => st.id === card.stage);
        const isDeclined = card.stage === "declined";
        const scopePhotos = fd.scopePhotos || fd.photos || [];
        const addonPhotos = fd.addonPhotos || [];

        // Pipeline's card detail view now renders the SAME OnsiteWindow
        // component the Route "swipe a card" flow uses — one shared editing
        // screen instead of two hand-maintained copies that kept drifting
        // apart. backLabel/topBar are OnsiteWindow's extension points for the
        // chrome that's genuinely Pipeline-only (stage moves, repeat-client
        // banner, photo zip export, jump-to-Route) and has no Route
        // equivalent; everything else — notes, photos, video, AI summaries,
        // Line Items, Job Tags — is now identical between the two screens.
        return (
          <OnsiteWindow
            key={card.id}
            stop={{
              id: card.id, cn: card.cn, addr: card.addr, phone: card.phone,
              email: card.email, jn: card.jn, notes: card.notes,
              constraint: card.constraint,
            }}
            token={token}
            backLabel="Close"
            onBack={() => setDetailCard(null)}
            onDone={() => setDetailCard(null)}
            onDecline={() => { moveCard(card.id, "declined"); setDetailCard(null); }}
            onEditDetails={(edits) => {
              setPipeline(prev => prev[card.id] ? { ...prev, [card.id]: { ...prev[card.id], ...edits } } : prev);
              setDetailCard(prev => prev ? { ...prev, ...edits } : prev);
            }}
            topBar={
              // Return-client banner removed per request. Stage-move bar is
              // the only thing left here — genuinely Pipeline-only, no Route
              // equivalent.
              <div style={{padding:"10px 20px",background:"#0a0b10",borderBottom:"1px solid #1a2030",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{padding:"4px 12px",borderRadius:99,background:stage?.bg,color:stage?.color,fontSize:11,fontWeight:700,fontFamily:F,textTransform:"uppercase",letterSpacing:0.5,flexShrink:0}}>{stage?.label}</span>
                {isDeclined && <button onClick={() => { reactivate(card.id); setDetailCard({...card, stage:"estimate_needed"}); }} style={{padding:"6px 12px",borderRadius:8,background:"rgba(255,183,77,.1)",border:"1px solid rgba(255,183,77,.3)",color:"#FFB74D",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>↩ REACTIVATE</button>}
                {STAGES.filter(st => st.id !== card.stage && !(isDeclined && st.id !== "estimate_needed")).map(st => (
                  <button key={st.id} onClick={() => { moveCard(card.id, st.id); setDetailCard(null); }} style={{padding:"6px 10px",borderRadius:8,background:st.bg,border:`1px solid ${st.color}40`,color:st.color,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase",letterSpacing:0.3}}>{st.label}</button>
                ))}
              </div>
            }
            belowScopePhotosSlot={(scopePhotos.length + addonPhotos.length) > 0 && (
              <button onClick={() => downloadAllPhotos(card, scopePhotos, addonPhotos)} disabled={downloadingPhotos} style={{width:"100%",marginTop:12,padding:"6px 0",borderRadius:7,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.2)",color:"#10B981",fontSize:10,fontWeight:700,cursor:downloadingPhotos?"default":"pointer",opacity:downloadingPhotos?0.6:1,fontFamily:F,letterSpacing:0.3,textTransform:"uppercase"}}>
                {downloadingPhotos ? "Saving…" : `Download All Photos (${scopePhotos.length + addonPhotos.length})`}
              </button>
            )}
            bottomExtra={
              <button
                onClick={() => {
                  if (window.confirm(`Move ${card.cn} back to today's Route?\n\nThis removes the card from the Pipeline board and puts it back as an active, unfinished visit on today's Route — same as it was before you first marked it done.`)) {
                    setDetailCard(null);
                    onSwitchToRoute(card.id);
                  }
                }}
                style={{width:"100%",padding:"9px 0",borderRadius:8,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.3,textTransform:"uppercase"}}
              >→ Move back to Route</button>
            }
          />
        );
      })()}

      {/* ── EMAIL TEMPLATE SHEET ──────────────────────────────────────── */}
      {emailSheet && <div onClick={()=>{setEmailSheet(false);setEmailPreview(null);setBulkEmailQueue(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:emailPreview||bulkEmailQueue?"center":"flex-end",justifyContent:"center",padding:emailPreview||bulkEmailQueue?20:0}}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:emailPreview||bulkEmailQueue?14:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",maxHeight:"85vh",overflowY:"auto",paddingBottom:emailPreview||bulkEmailQueue?18:"max(18px,env(safe-area-inset-bottom))"}}>

          {/* ── Email client toggle ── */}
          <div style={{display:"flex",gap:4,marginBottom:14,background:"#0a0c14",borderRadius:8,padding:3}}>
            {[["outlook_web","Outlook (work)"],["outlook_live","Outlook.com"],["mailto","Default app"]].map(([id,label])=>(
              <button key={id} onClick={()=>saveEmailClient(id)} style={{flex:1,padding:"5px 0",borderRadius:6,background:emailClient===id?"#1a2540":"transparent",border:emailClient===id?"1px solid #2a3560":"1px solid transparent",color:emailClient===id?"#90b8e0":"#3a4a60",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase",letterSpacing:0.3,transition:"all .15s"}}>{label}</button>
            ))}
          </div>

          {/* ── Bulk queue: tap each recipient to open their compose window ── */}
          {bulkEmailQueue ? <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <button onClick={()=>setBulkEmailQueue(null)} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"1px solid #2a3560",color:"#5a6580",fontSize:11,cursor:"pointer"}}>← Back</button>
              <span style={{fontSize:13,fontWeight:700,color:"#f0f4fa",flex:1}}>Tap each to open in Outlook</span>
            </div>
            <div style={{fontSize:10,color:"#4a5060",marginBottom:10}}>Each tap opens one compose window — browsers only allow one per click.</div>
            {bulkEmailQueue.map((item, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 12px",borderRadius:8,background:item.opened?"rgba(16,185,129,.05)":"#0e1120",border:`1px solid ${item.opened?"rgba(16,185,129,.2)":"#1a2540"}`,marginBottom:6}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:item.opened?"#10B981":"#a0b8d0"}}>{item.name} — {item.email}</div>
                  <div style={{fontSize:10,color:"#4a5a70",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.subject}</div>
                </div>
                {item.opened
                  ? <span style={{fontSize:11,color:"#10B981",fontWeight:700}}>✓ Opened</span>
                  : <a href={buildComposeUrl(item.email, item.subject, item.body)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={()=>{
                        markContact(item.cardId, "email");
                        setBulkEmailQueue(prev => prev.map((x,j) => j===i ? {...x,opened:true} : x));
                      }}
                      onAuxClick={()=>{
                        // middle-click — track as opened too
                        markContact(item.cardId, "email");
                        setBulkEmailQueue(prev => prev.map((x,j) => j===i ? {...x,opened:true} : x));
                      }}
                      style={{padding:"6px 14px",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0,textDecoration:"none",display:"inline-block"}}>
                      Open →
                    </a>
                }
              </div>
            ))}
            {bulkEmailQueue.every(x=>x.opened) && <div style={{textAlign:"center",padding:"10px 0",fontSize:12,color:"#10B981",fontWeight:700}}>✓ All {bulkEmailQueue.length} opened</div>}
          </> : !emailPreview ? <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1,fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}>Email {selectedCount} clients</span>
              <button onClick={()=>{setEmailSheet(false);}} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
              <span style={{fontSize:11,color:"#5a6580",flex:1}}>Choose a template — each email is personalized with the client's name.</span>
              <button onClick={()=>{ setDraftTemplates(effectiveTemplates.reduce((acc,t)=>({...acc,[t.id]:{subject:t.subject,body:t.body}}),{})); setTemplateEditorOpen(true); }} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"1px solid #2a3560",color:"#5a6580",fontSize:10,cursor:"pointer",fontWeight:700}}>✏ Edit</button>
            </div>
            {effectiveTemplates.map(t => (
              <button key={t.id} onClick={()=>setEmailPreview(t)} style={{width:"100%",padding:"12px 14px",marginBottom:6,borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",cursor:"pointer",textAlign:"left"}}>
                <div style={{fontSize:13,fontWeight:700,color:"#a0b8d0"}}>{t.label}</div>
                <div style={{fontSize:11,color:"#4a5a70",marginTop:2}}>{t.subject}</div>
              </button>
            ))}
          </> : <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <button onClick={()=>setEmailPreview(null)} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"1px solid #2a3560",color:"#5a6580",fontSize:11,cursor:"pointer"}}>← Back</button>
              <span style={{fontSize:13,fontWeight:700,color:"#f0f4fa",flex:1}}>{emailPreview.label}</span>
            </div>
            <div style={{fontSize:11,color:"#5a6580",marginBottom:6}}>Preview for {selectedCards[0]?.cn || "—"}:</div>
            <div style={{padding:"10px 12px",borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",marginBottom:10}}>
              <div style={{fontSize:11,color:"#6a8aB0",marginBottom:4,fontWeight:600}}>Subject: {emailPreview.subject}</div>
              <div style={{fontSize:12,color:"#8898a8",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{emailPreview.body.replace(/\{firstName\}/g, (selectedCards[0]?.cn || "").split(" ")[0])}</div>
            </div>
            <div style={{fontSize:10,color:"#4a5a70",marginBottom:10}}>Will send to: {selectedCards.map(c => c.email || "(no email)").join(", ")}</div>
            <button onClick={()=>sendBulkEmail(emailPreview)} style={{width:"100%",padding:"12px 0",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}><span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><IconMail size={15} color="#3B82F6"/>PREPARE {selectedCount} EMAILS →</span></button>
          </>}
        </div>
      </div>}

      {/* ── TEMPLATE EDITOR OVERLAY ───────────────────────────────────── */}
      {templateEditorOpen && draftTemplates && (
        <div onClick={()=>setTemplateEditorOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.8)",backdropFilter:"blur(4px)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:14,padding:18,maxWidth:520,width:"100%",maxHeight:"88vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Edit Email Templates</span>
              <button onClick={()=>setTemplateEditorOpen(false)} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            <div style={{fontSize:10,color:"#4a5060",marginBottom:12,lineHeight:1.5}}>
              Use <span style={{color:"#a0b8d0",fontWeight:700}}>{"{firstName}"}</span> where you want the client's first name inserted.
              Font and signature are controlled by your Outlook compose settings (Settings → Compose and reply → Default font).
            </div>
            {EMAIL_TEMPLATES.map(t => (
              <div key={t.id} style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"#0a0c14",border:"1px solid #1a2030"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#3B82F6",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>{t.label}</div>
                <div style={{fontSize:10,color:"#4a5a70",marginBottom:4}}>Subject line:</div>
                <input value={draftTemplates[t.id]?.subject ?? t.subject}
                  onChange={e => setDraftTemplates(prev => ({...prev,[t.id]:{...prev[t.id],subject:e.target.value}}))}
                  style={{width:"100%",boxSizing:"border-box",padding:"7px 10px",borderRadius:7,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:12,fontFamily:"inherit",marginBottom:8,outline:"none"}} />
                <div style={{fontSize:10,color:"#4a5a70",marginBottom:4}}>Body:</div>
                <textarea value={draftTemplates[t.id]?.body ?? t.body}
                  onChange={e => setDraftTemplates(prev => ({...prev,[t.id]:{...prev[t.id],body:e.target.value}}))}
                  rows={7}
                  style={{width:"100%",boxSizing:"border-box",padding:"7px 10px",borderRadius:7,background:"#0e1120",border:"1px solid #1a2540",color:"#e0e8f0",fontSize:12,fontFamily:"inherit",lineHeight:1.5,resize:"vertical",outline:"none"}} />
                <button onClick={()=>setDraftTemplates(prev=>({...prev,[t.id]:{subject:t.subject,body:t.body}}))}
                  style={{fontSize:10,color:"#5a6580",background:"transparent",border:"none",cursor:"pointer",padding:"2px 0",textDecoration:"underline"}}>Reset to default</button>
              </div>
            ))}
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <button onClick={()=>setTemplateEditorOpen(false)} style={{flex:1,padding:"10px 0",borderRadius:8,background:"transparent",border:"1px solid #2a3560",color:"#5a6580",fontSize:12,cursor:"pointer"}}>Cancel</button>
              <button onClick={()=>{
                const updates = {};
                EMAIL_TEMPLATES.forEach(t => { updates[t.id] = { subject: draftTemplates[t.id]?.subject ?? t.subject, body: draftTemplates[t.id]?.body ?? t.body }; });
                saveCustomTemplates(updates);
                setTemplateEditorOpen(false);
              }} style={{flex:2,padding:"10px 0",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:12,fontWeight:800,cursor:"pointer"}}>Save Templates</button>
            </div>
          </div>
        </div>
      )}

      {/* ── PIPELINE MESSAGE SHEET (per-card email/sms + bulk sms) ─────── */}
      {pipelineSheet && (() => {
        const isBulk = pipelineSheet.type === "sms_bulk";
        const isSms = pipelineSheet.type === "sms" || isBulk;
        const card = pipelineSheet.card;
        const firstName = card ? (card.cn || "").split(" ")[0] : null;
        const templates = isSms ? SMS_TEMPLATES : EMAIL_TEMPLATES;
        const title = isBulk
          ? `Text ${selectedCount} clients`
          : isSms
            ? `Text ${firstName}`
            : `Email ${firstName}`;
        return (
          <div onClick={()=>setPipelineSheet(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#0d0f18",border:"1px solid #1a2030",borderRadius:"14px 14px 0 0",padding:18,maxWidth:480,width:"100%",paddingBottom:"max(18px,env(safe-area-inset-bottom))"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1,fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}>{title}</span>
                {!isBulk && card && (isSms ? card.phone : card.email) && <span style={{fontSize:11,color:"#5a6580"}}>{isSms ? card.phone : card.email}</span>}
                <button onClick={()=>setPipelineSheet(null)} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={13} color="#5a6580"/></button>
              </div>
              {isBulk && <div style={{fontSize:11,color:"#5a6580",marginBottom:10}}>Choose a template — each message will be personalized with the client's name.</div>}
              {templates.map(t => (
                <button key={t.id} onClick={() => {
                  if (isBulk) {
                    sendBulkSms(t);
                  } else if (isSms) {
                    const phone = (card.phone || "").replace(/\D/g,"");
                    const body = t.body.replace(/\{firstName\}/g, firstName);
                    window.open(`sms:${phone}&body=${encodeURIComponent(body)}`, "_self");
                    markContact(card.id, "sms");
                    setPipelineSheet(null);
                  } else {
                    const body = t.body.replace(/\{firstName\}/g, firstName);
                    openEmailCompose(card.email, t.subject, body);
                    markContact(card.id, "email");
                    setPipelineSheet(null);
                  }
                }} style={{width:"100%",padding:"12px 14px",marginBottom:8,borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",cursor:"pointer",textAlign:"left"}}>
                  <div style={{fontSize:13,fontWeight:700,color:isSms?"#10B981":"#a0b8d0"}}>{t.label}</div>
                  <div style={{fontSize:11,color:"#4a5a70",marginTop:3,lineHeight:1.4}}>{t.body.replace(/\{firstName\}/g, firstName || "[Name]").slice(0,90)}…</div>
                </button>
              ))}
              {/* Custom / blank */}
              {!isBulk && <button onClick={()=>{
                if (isSms) {
                  const phone = (card.phone||"").replace(/\D/g,"");
                  window.open(`sms:${phone}`,"_self");
                  markContact(card.id, "sms");
                } else {
                  window.open(`mailto:${card.email}`,"_self");
                  markContact(card.id, "email");
                }
                setPipelineSheet(null);
              }} style={{width:"100%",padding:"10px 14px",borderRadius:8,background:"transparent",border:"1px solid #1a2030",cursor:"pointer",textAlign:"left"}}>
                <div style={{fontSize:12,fontWeight:700,color:"#5a6580"}}>Custom</div>
                <div style={{fontSize:11,color:"#3a4a60",marginTop:2}}>Open blank {isSms?"message":"email"}</div>
              </button>}
            </div>
          </div>
        );
      })()}

    </div>
  );
}

export { STAGES, loadPipeline, savePipeline, pushCalendarColor };

/* ═══════════════════════════════════════════════════════════════════════════
   Module-level helpers — outside React so async work survives navigation
   ═══════════════════════════════════════════════════════════════════════════ */


