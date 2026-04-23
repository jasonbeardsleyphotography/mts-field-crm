import { IconFire, IconRevision, IconPause, IconMail, IconX, IconCheckCircle, IconPhone, IconTrash, IconEdit, IconClipboard, IconSingleops, IconVideo, IconStar, IconCamera, IconImage, IconDownload, IconPen, IconYoutube } from "./icons";
import CameraView from "./CameraView";
import PhotoMarkup from "./PhotoMarkup";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { loadFieldFromDrive, saveFieldToDrive } from "./driveSync";
import { loadField, saveField, peekField, primeField } from "./fieldStore";

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

// Google Calendar colorId for each pipeline stage
const STAGE_CAL_COLOR = {
  estimate_needed: "7",  // Peacock  #039BE5
  waiting:         "3",  // Grape    #8E24AA
  strong:          "2",  // Sage     #33B679
  weak:            "4",  // Flamingo #E67C73
  follow_up:       "5",  // Banana   #F6BF26
  sold:            "10", // Basil    #0B8043
  declined:        "8",  // Graphite #616161
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

const GEMINI_KEY = import.meta.env.VITE_GEMINI_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const PIPELINE_KEY = "mts-pipeline";
const FIELD_KEY = id => `mts-field-${id}`;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

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

const F = "'Oswald',sans-serif";

// ═════════════════════════════════════════════════════════════════════════════
export default function Pipeline({ onSwitchToRoute, search = "", onCloudSync, token, lastContact = {}, markContact = () => {} }) {
  const [pipeline, setPipeline] = useState(() => loadPipeline());
  const [activeTab, setActiveTab] = useState("estimate_needed");
  const [selectedCard, setSelectedCard] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState({}); // {id: true}
  const [emailSheet, setEmailSheet] = useState(false);
  const [emailPreview, setEmailPreview] = useState(null);
  const [pauseMenu, setPauseMenu] = useState(null);
  const [detailCard, setDetailCard] = useState(null);
  const [pipelineSheet, setPipelineSheet] = useState(null); // {card, type:'email'|'sms'}
  const [fieldCache, setFieldCache] = useState({}); // Drive-loaded field data cache
  const [detailLoading, setDetailLoading] = useState(false);
  const [editFields, setEditFields] = useState({}); // editable overrides for detail popup
  const [contactSave, setContactSave] = useState({}); // {[cardId]: 'saving'|'saved'|'error'}
  const [detailAiScopeLoading, setDetailAiScopeLoading] = useState(false);
  const [detailAiAddonLoading, setDetailAiAddonLoading] = useState(false);
  // Email client preference — persisted so user doesn't have to re-select
  const [emailClient, setEmailClient] = useState(() => localStorage.getItem("mts-email-client") || "outlook_web");
  const [bulkEmailQueue, setBulkEmailQueue] = useState(null); // [{email,subject,body,name,cardId,opened}] | null
  // Detail popup — camera / markup / YouTube upload state
  const [detailShowCamera, setDetailShowCamera] = useState(null); // "scope" | "addon" | null
  const [detailMarkup, setDetailMarkup] = useState(null); // { section, idx } | null
  const [detailYtCount, setDetailYtCount] = useState(0);
  const detailScopeLibRef = useRef(null);
  const detailAddonLibRef = useRef(null);
  const detailYtFileRef = useRef(null);

  // Save edited field data to IndexedDB (and Drive if token available)
  const saveEditedField = useCallback((id, key, value) => {
    setEditFields(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));
    const current = peekField(id);
    const updated = { ...current, [key]: value };
    primeField(id, updated);
    saveField(id, updated).catch(() => {});
    if (token) {
      if (window._pipelineFieldSync) clearTimeout(window._pipelineFieldSync);
      window._pipelineFieldSync = setTimeout(() => {
        saveFieldToDrive(token, id, updated).catch(() => {});
      }, 2000);
    }
  }, [token]);

  // ── GEMINI AI — used in detail popup ─────────────────────────────────
  const callGemini = async (prompt) => {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  };

  const generateDetailScopeSummary = async (card, fd) => {
    if (!GEMINI_KEY) { saveEditedField(card.id, "aiScopeSummary", "Add VITE_GEMINI_KEY to .env"); return; }
    setDetailAiScopeLoading(true);
    try {
      const text = await callGemini(`You are an ISA-certified arborist's field assistant. Summarize these field notes into a structured estimate summary. Include: species/trees observed, conditions found, recommended treatments, equipment needed, and a rough job value estimate if enough info exists. Be concise and professional.

Client: ${card.cn}
Address: ${card.addr}
Job notes from office: ${card.notes || "None"}
Scope notes: ${fd.scopeNotes || fd.myNotes || "None"}
Constraints: ${card.constraint || "None"}`);
      saveEditedField(card.id, "aiScopeSummary", text);
    } catch(e) { saveEditedField(card.id, "aiScopeSummary", "Error: " + e.message); }
    setDetailAiScopeLoading(false);
  };

  const generateDetailAddonEmail = async (card, fd) => {
    if (!GEMINI_KEY) { saveEditedField(card.id, "aiAddonEmail", "Add VITE_GEMINI_KEY to .env"); return; }
    setDetailAiAddonLoading(true);
    try {
      const text = await callGemini(`You are an ISA-certified arborist writing a professional, educational email to a homeowner. Based on these additional findings discovered during a site visit:

1. For each issue found, write a brief educational paragraph explaining what it is, why it matters for tree/plant health, and what treatments or recommendations exist.
2. Reference science-based information — cite Cornell Cooperative Extension, Northeast university extension resources, or ISA best practices where relevant.
3. NEVER use the word "chemical" — instead use "treatments," "applications," "plant healthcare solutions," or "recommendations."
4. Tone should be educational but down-to-earth. Keep it warm and professional.
5. End with a brief recommendation and offer to discuss further.
6. Sign as Jason from Monster Tree Service of Rochester.

Client first name: ${(card.cn || "").split(" ")[0]}
Add-on findings: ${fd.addonNotes || "None"}
Property: ${card.addr || ""}`);
      saveEditedField(card.id, "aiAddonEmail", text);
    } catch(e) { saveEditedField(card.id, "aiAddonEmail", "Error: " + e.message); }
    setDetailAiAddonLoading(false);
  };

  // ── DETAIL POPUP — PHOTO / VIDEO HELPERS ─────────────────────────────
  const detailAddPhoto = (dataUrl, section, cardId) => {
    const photo = { dataUrl, ts: Date.now() };
    const key = section === "addon" ? "addonPhotos" : "scopePhotos";
    setEditFields(prev => {
      const cur = prev[cardId] || {};
      const existing = cur[key] || peekField(cardId)[key] || [];
      return { ...prev, [cardId]: { ...cur, [key]: [...existing, photo] } };
    });
    // Persist
    const cur = peekField(cardId);
    const existingArr = cur[key] || [];
    const updated = { ...cur, [key]: [...existingArr, photo] };
    primeField(cardId, updated);
    saveField(cardId, updated).catch(() => {});
  };

  const detailRemovePhoto = (idx, section, cardId) => {
    const key = section === "addon" ? "addonPhotos" : "scopePhotos";
    setEditFields(prev => {
      const cur = prev[cardId] || {};
      const existing = cur[key] || peekField(cardId)[key] || [];
      return { ...prev, [cardId]: { ...cur, [key]: existing.filter((_, i) => i !== idx) } };
    });
    const cur = peekField(cardId);
    const existingArr = cur[key] || [];
    const updated = { ...cur, [key]: existingArr.filter((_, i) => i !== idx) };
    primeField(cardId, updated);
    saveField(cardId, updated).catch(() => {});
  };

  const detailSaveMarkup = (newDataUrl, idx, section, cardId) => {
    const key = section === "addon" ? "addonPhotos" : "scopePhotos";
    setEditFields(prev => {
      const cur = prev[cardId] || {};
      const existing = [...(cur[key] || peekField(cardId)[key] || [])];
      existing[idx] = { ...existing[idx], dataUrl: newDataUrl };
      return { ...prev, [cardId]: { ...cur, [key]: existing } };
    });
    const cur = peekField(cardId);
    const existingArr = [...(cur[key] || [])];
    existingArr[idx] = { ...existingArr[idx], dataUrl: newDataUrl };
    const updated = { ...cur, [key]: existingArr };
    primeField(cardId, updated);
    saveField(cardId, updated).catch(() => {});
    setDetailMarkup(null);
  };

  const detailHandleLibraryPhotos = (e, section, cardId) => {
    Array.from(e.target.files || []).forEach(file => {
      _detailProcessPhoto(file, section, cardId, detailAddPhoto);
    });
    e.target.value = "";
  };

  const detailHandleYtFile = (e, card, fd) => {
    const file = e.target.files?.[0];
    if (file) {
      const videoUrls = fd.videoUrls || (fd.videoUrl ? [fd.videoUrl] : []);
      const lastName = (card.cn || "").split(" ").pop();
      const jobPart = card.jn ? ` #${card.jn}` : "";
      const datePart = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
      const suffix = videoUrls.length > 0 ? ` (${videoUrls.length + 1})` : "";
      const title = `${lastName}${jobPart} ${datePart}${suffix}`;
      setDetailYtCount(n => n + 1);
      _uploadToYouTubeForDetail(file, title, token, card.id).then(ytUrl => {
        if (ytUrl) {
          setEditFields(prev => {
            const cur = prev[card.id] || {};
            const existing = cur.videoUrls || peekField(card.id).videoUrls || [];
            return { ...prev, [card.id]: { ...cur, videoUrls: [...existing, ytUrl] } };
          });
        }
        setDetailYtCount(n => n - 1);
      }).catch(() => setDetailYtCount(n => n - 1));
    }
    e.target.value = "";
  };

  const detailDeleteVideo = async (url, idx, card, fd) => {
    const videoId = url?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];
    if (videoId && token) {
      const confirmed = window.confirm("Delete this video from YouTube AND remove it from the app?");
      if (!confirmed) return;
      try {
        await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
      } catch(e) { console.warn("YT delete error:", e); }
    }
    const key = "videoUrls";
    setEditFields(prev => {
      const cur = prev[card.id] || {};
      const existing = cur[key] || fd.videoUrls || [];
      return { ...prev, [card.id]: { ...cur, [key]: existing.filter((_, i) => i !== idx) } };
    });
    const cur = peekField(card.id);
    const updated = { ...cur, videoUrls: (cur.videoUrls || []).filter((_, i) => i !== idx) };
    primeField(card.id, updated);
    saveField(card.id, updated).catch(() => {});
  };

  // Persist
  useEffect(() => { savePipeline(pipeline); }, [pipeline]);
  useEffect(() => { if (onCloudSync) onCloudSync(); }, [pipeline]);

  // ── LOAD FIELD DATA FROM DRIVE WHEN DETAIL OPENS ───────────────────────
  useEffect(() => {
    if (!detailCard || !token) return;
    const id = detailCard.id;
    let dead = false;
    setDetailLoading(true);
    (async () => {
      const local = await loadField(id);
      if (dead) return;
      const hasLocal = !!(local.scopeNotes || local.myNotes || local.addonNotes ||
        (local.scopePhotos || local.photos || []).length ||
        (local.addonPhotos || []).length ||
        local.videoUrls?.length || local.videoUrl ||
        local.audioClips?.length);
      // Always try Drive to get freshest data (especially cross-device)
      try {
        const cloud = await loadFieldFromDrive(token, id);
        if (dead) return;
        if (cloud && Object.keys(cloud).length > 0) {
          // Merge: Drive wins on text/AI, but keep whichever photo array is longer
          const merged = {
            ...local,
            ...cloud,
            scopePhotos: (cloud.scopePhotos || cloud.photos || []).length >= (local.scopePhotos || local.photos || []).length
              ? (cloud.scopePhotos || cloud.photos || [])
              : (local.scopePhotos || local.photos || []),
            addonPhotos: (cloud.addonPhotos || []).length >= (local.addonPhotos || []).length
              ? (cloud.addonPhotos || [])
              : (local.addonPhotos || []),
            audioClips: (cloud.audioClips || []).length >= (local.audioClips || []).length
              ? (cloud.audioClips || [])
              : (local.audioClips || []),
            videoUrls: cloud.videoUrls?.length ? cloud.videoUrls : (local.videoUrls || (local.videoUrl ? [local.videoUrl] : [])),
          };
          primeField(id, merged);
          setFieldCache(prev => ({ ...prev, [id]: merged }));
        } else if (hasLocal) {
          setFieldCache(prev => ({ ...prev, [id]: local }));
        }
      } catch {
        if (hasLocal) setFieldCache(prev => ({ ...prev, [id]: local }));
      }
      if (!dead) setDetailLoading(false);
    })();
    return () => { dead = true; };
  }, [detailCard?.id, token]);

  // ── AUTO-AGING ──────────────────────────────────────────────────────────
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
          if (card.stage === "waiting" && age > THREE_DAYS) {
            updated[id] = { ...card, stage: "weak", stageChangedAt: now };
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
      if (groups[card.stage]) groups[card.stage].push(card);
    });
    Object.keys(groups).forEach(k => {
      groups[k].sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (a.addedAt || 0) - (b.addedAt || 0));
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

  // Hydrate missing cards from IndexedDB. Runs whenever the card set changes.
  useEffect(() => {
    let dead = false;
    (async () => {
      let hydrated = false;
      for (const card of allCards) {
        const existing = peekField(card.id);
        if (existing && Object.keys(existing).length > 0) continue;
        try {
          const fresh = await loadField(card.id);
          if (dead) return;
          if (fresh && Object.keys(fresh).length > 0) {
            primeField(card.id, fresh);
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
  const moveCard = useCallback((id, newStage) => {
    setPipeline(prev => ({
      ...prev,
      [id]: { ...prev[id], stage: newStage, stageChangedAt: Date.now(), autoDeclined: false },
    }));
    if (token) pushCalendarColor(id, newStage, token);
  }, [token]);

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

  // ── BULK EMAIL + SMS ────────────────────────────────────────
  // ── EMAIL COMPOSE HELPER ─────────────────────────────────────────────
  // Opens a compose window in the user's preferred email client.
  // Direct user-gesture call (no setTimeout) so browsers don't block the popup.
  const openEmailCompose = useCallback((to, subject, body, client) => {
    const cl = client || emailClient;
    if (cl === "outlook_web") {
      const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(url, "_blank");
    } else if (cl === "outlook_live") {
      const url = `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(url, "_blank");
    } else {
      window.open(`mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
    }
  }, [emailClient]);

  const saveEmailClient = (cl) => {
    setEmailClient(cl);
    localStorage.setItem("mts-email-client", cl);
  };

  // Build the queue — user then taps each recipient button to open one tab per click
  const sendBulkEmail = (template) => {
    const queue = selectedCards
      .filter(c => c.email)
      .map(c => {
        const firstName = (c.cn || "").split(" ")[0];
        const body = template.body.replace(/\{firstName\}/g, firstName);
        return { email: c.email, subject: template.subject, body, name: firstName, cardId: c.id, opened: false };
      });
    setBulkEmailQueue(queue);
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

    return (
      <div
        key={card.id}
        draggable={!selectMode}
        onDragStart={e => onDragStart(e, card.id)}
        onClick={() => {
          if (selectMode) { toggleSelect(card.id); return; }
          setDetailCard(card);
        }}
        style={{
          padding: compact ? "10px 12px" : "12px 14px",
          background: isSelected ? "rgba(59,130,246,.08)" : card.hot ? "rgba(255,160,0,.05)" : "#0e1020",
          borderBottom: "1px solid #0e1220",
          borderLeft: `4px solid ${isSelected ? "#3B82F6" : card.hot ? "#FFB300" : stage?.color || "#555"}`,
          cursor: "pointer",
          transition: "background .15s",
          opacity: isDeclined && !selectMode ? 0.6 : 1,
        }}
      >
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
            <span style={{fontSize:10,color:card.stage==="weak"?"#FF8A65":"#4a5a70"}}>{daysSince(card.stageChangedAt || card.addedAt)}</span>
          </div>
        </div>

        {/* Indicators */}
        {!selectMode && <div style={{display:"flex",gap:6,marginTop:6,alignItems:"center"}}>
          {photoCount > 0 && <span style={{display:"flex",alignItems:"center",gap:2,fontSize:10,color:"#5a6580"}}><IconCamera size={11} color="#5a6580"/>{photoCount}</span>}
          {hasNotes && <IconEdit size={11} color="#5a6580"/>}
          {hasVideo && <IconVideo size={11} color="#5a6580"/>}
          {card.jn && <button onClick={e=>{e.stopPropagation();openSingleOps(card.jn);}} style={{fontSize:10,color:"#3B82F6",background:"none",border:"none",cursor:"pointer",fontWeight:600,padding:0}}>SO #{card.jn}</button>}
          <div style={{flex:1}}/>
          {/* Quick email + SMS shortcuts */}
          {card.email && <button onClick={e=>{e.stopPropagation();setPipelineSheet({card,type:"email"});}} style={{padding:"2px 7px",borderRadius:4,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:9,fontWeight:700,cursor:"pointer"}}>✉</button>}
          {card.phone && <button onClick={e=>{e.stopPropagation();setPipelineSheet({card,type:"sms"});}} style={{padding:"2px 7px",borderRadius:4,background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",color:"#10B981",fontSize:9,fontWeight:700,cursor:"pointer"}}>💬</button>}
          <div style={{position:"relative"}}>
            {card.pauseUntil && Date.now() < card.pauseUntil ? (
              <button onClick={e=>{e.stopPropagation();unpause(card.id);}} style={{padding:"2px 6px",borderRadius:4,background:"rgba(138,150,168,.12)",border:"1px solid rgba(138,150,168,.25)",color:"#8a96a8",fontSize:9,cursor:"pointer",fontWeight:600}}><span style={{display:"flex",alignItems:"center",gap:3}}><IconPause size={10} color="#8a96a8"/>{Math.ceil((card.pauseUntil - Date.now()) / (24*60*60*1000))}d</span></button>
            ) : (
              <button onClick={e=>{e.stopPropagation();setPauseMenu(pauseMenu===card.id?null:card.id);}} style={{padding:"2px 6px",borderRadius:4,background:pauseMenu===card.id?"rgba(138,150,168,.12)":"transparent",border:"1px solid #1a2030",color:"#2a3050",fontSize:10,cursor:"pointer"}}><IconPause size={12} color={pauseMenu===card.id?"#8a96a8":"#2a3050"}/></button>
            )}
            {pauseMenu === card.id && <div style={{position:"absolute",top:"100%",right:0,marginTop:4,background:"#0d0f18",border:"1px solid #1a2540",borderRadius:8,padding:4,zIndex:30,display:"flex",gap:3}}>
              {[3,7,14].map(d => <button key={d} onClick={e=>{e.stopPropagation();pauseFor(card.id,d);}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(138,150,168,.08)",border:"1px solid #1a2540",color:"#8a96a8",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>{d}d</button>)}
            </div>}
          </div>
          <button onClick={e=>{e.stopPropagation();toggleHot(card.id);}} style={{padding:"2px 6px",borderRadius:4,background:card.hot?"rgba(255,179,0,.12)":"transparent",border:card.hot?"1px solid rgba(255,179,0,.3)":"1px solid #1a2030",color:card.hot?"#FFB300":"#2a3050",fontSize:10,cursor:"pointer"}}><IconFire size={13} color={card.hot?"#FFB300":"#2a3050"}/></button>
          <button onClick={e=>{e.stopPropagation();toggleRevision(card.id);}} style={{padding:"2px 6px",borderRadius:4,background:card.revision?"rgba(255,107,157,.12)":"transparent",border:card.revision?"1px solid rgba(255,107,157,.3)":"1px solid #1a2030",color:card.revision?"#FF6B9D":"#2a3050",fontSize:10,cursor:"pointer"}}><IconRevision size={13} color={card.revision?"#FF6B9D":"#2a3050"}/></button>
        </div>}
      </div>
    );
  };

  // ── MOBILE: List + Tabs ──────────────────────────────────────────────────
  const mobileView = () => {
    const filtered = activeTab === "all" ? allCards : (cardsByStage[activeTab] || []);
    const sorted = [...filtered].filter(searchFilter).sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (a.addedAt || 0) - (b.addedAt || 0));

    return (
      <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
        {/* Select toggle */}
        <div style={{display:"flex",gap:6,padding:"6px 10px",background:"#0d0f18",borderBottom:"1px solid #1a2030",flexShrink:0,alignItems:"center"}}>
          <div style={{flex:1}}/>
          <button onClick={()=>{setSelectMode(!selectMode);setSelected({});}} style={{padding:"5px 10px",borderRadius:8,background:selectMode?"rgba(59,130,246,.15)":"#1a2035",border:`1px solid ${selectMode?"rgba(59,130,246,.3)":"#252d47"}`,color:selectMode?"#3B82F6":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}>{selectMode ? <><IconX size={13}/>Done</> : "Select"}</span></button>
        </div>

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
        </div>

        {/* Follow-up reminder banner */}
        {dueForFollowUp.length > 0 && !selectMode && <div style={{padding:"8px 14px",background:"rgba(246,191,38,.06)",borderBottom:"1px solid rgba(246,191,38,.15)",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,color:"#F6BF26",fontWeight:600,flex:1}}>{dueForFollowUp.length} card{dueForFollowUp.length>1?"s":""} waiting 2+ days — follow up?</span>
          <button onClick={()=>{setSelectMode(true);const sel={};dueForFollowUp.forEach(c=>{sel[c.id]=true;});setSelected(sel);}} style={{padding:"5px 10px",borderRadius:6,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#F6BF26"/>Select all</span></button>
        </div>}

        {/* Card list */}
        <div style={{flex:1,overflowY:"auto",paddingBottom:selectMode && selectedCount>0?"max(70px,calc(60px + env(safe-area-inset-bottom)))":"max(12px,env(safe-area-inset-bottom))"}}>
          {sorted.length === 0 && <div style={{padding:40,textAlign:"center",color:"#2a3050",fontSize:14,fontWeight:600}}>No cards{search ? ` matching "${search}"` : ""}</div>}
          {sorted.map(card => renderCard(card, false))}
        </div>

        {/* Select mode action bar */}
        {selectMode && selectedCount > 0 && (
          <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"10px 16px",background:"#0d0f18",borderTop:"1px solid #1a2030",display:"flex",gap:8,alignItems:"center",paddingBottom:"max(10px,env(safe-area-inset-bottom))",zIndex:50}}>
            <span style={{fontSize:12,color:"#90a8c0",fontWeight:600}}>{selectedCount} selected</span>
            <div style={{flex:1}}/>
            <button onClick={()=>setEmailSheet(true)} style={{padding:"8px 16px",borderRadius:8,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:12,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#3B82F6"/>Email</span></button>
            <button onClick={()=>setPipelineSheet({card:null,type:"sms_bulk"})} style={{padding:"8px 16px",borderRadius:8,background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.2)",color:"#10B981",fontSize:12,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}>💬 Text</span></button>
            <button onClick={()=>{selectedCards.forEach(c=>moveCard(c.id,"follow_up"));setSelected({});setSelectMode(false);}} style={{padding:"8px 12px",borderRadius:8,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.25)",color:"#F6BF26",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>→ Follow up</button>
          </div>
        )}
      </div>
    );
  };

  // ── DESKTOP: Kanban columns ──────────────────────────────────────────────
  const desktopView = () => (
    <div style={{display:"flex",flexDirection:"column",flex:1,overflow:"hidden"}}>
      {/* Select toggle */}
      <div style={{display:"flex",gap:6,padding:"6px 10px",background:"#0d0f18",borderBottom:"1px solid #1a2030",flexShrink:0,alignItems:"center"}}>
        <div style={{flex:1}}/>
        <button onClick={()=>{setSelectMode(!selectMode);setSelected({});}} style={{padding:"5px 10px",borderRadius:8,background:selectMode?"rgba(59,130,246,.15)":"#1a2035",border:`1px solid ${selectMode?"rgba(59,130,246,.3)":"#252d47"}`,color:selectMode?"#3B82F6":"#5a6580",fontSize:11,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}>{selectMode ? <><IconX size={13}/>Done</> : "Select"}</span></button>
        {selectMode && selectedCount > 0 && <button onClick={()=>setEmailSheet(true)} style={{padding:"5px 10px",borderRadius:8,background:"rgba(59,130,246,.12)",border:"1px solid rgba(59,130,246,.25)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer"}}><span style={{display:"flex",alignItems:"center",gap:5}}><IconMail size={13} color="#3B82F6"/>{selectedCount} selected</span></button>}
      </div>
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
                </div>
              </div>
              <div style={{flex:1,overflowY:"auto",padding:4}}>
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

      {/* ── FULL CARD DETAIL POPUP ──────────────────────────────────── */}
      {detailCard && (() => {
        const card = detailCard;
        const baseFd = fieldCache[card.id] || peekField(card.id);
        const overrides = editFields[card.id] || {};
        const fd = { ...baseFd, ...overrides };
        const stage = STAGES.find(st => st.id === card.stage);
        const isDeclined = card.stage === "declined";
        const B = "'DM Sans',system-ui,sans-serif";
        const editStyle = (color) => ({width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,background:"rgba(255,255,255,.03)",border:`1px solid ${color}30`,color,fontSize:14,fontFamily:B,lineHeight:1.2,resize:"vertical",outline:"none",minHeight:"unset"});
        const scopePhotos = fd.scopePhotos || fd.photos || [];
        const addonPhotos = fd.addonPhotos || [];
        const videoUrls = fd.videoUrls || (fd.videoUrl ? [fd.videoUrl] : []);
        const getYtId = url => url?.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1];

        // Camera overlay — renders above everything else in the popup
        if (detailShowCamera) return <CameraView
          onPhoto={(dataUrl) => { detailAddPhoto(dataUrl, detailShowCamera, card.id); }}
          onClose={() => setDetailShowCamera(null)}
        />;

        // Markup overlay
        if (detailMarkup) {
          const photos = detailMarkup.section === "addon" ? addonPhotos : scopePhotos;
          if (photos[detailMarkup.idx]) return <PhotoMarkup
            photoDataUrl={photos[detailMarkup.idx].dataUrl}
            onSave={dataUrl => detailSaveMarkup(dataUrl, detailMarkup.idx, detailMarkup.section, card.id)}
            onCancel={() => setDetailMarkup(null)}
          />;
        }

        return <div onClick={() => setDetailCard(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.65)",backdropFilter:"blur(4px)",WebkitBackdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
          <div onClick={e => e.stopPropagation()} style={{background:"#0d0f18",width:"100%",maxWidth:880,height:"100%",maxHeight:"min(100vh, 900px)",display:"flex",flexDirection:"column",overflow:"hidden",borderRadius:14,boxShadow:"0 20px 60px rgba(0,0,0,.6)",border:"1px solid #1a2030"}}>
            <div style={{flex:1,overflowY:"auto"}}>

            {/* Header — paddingTop respects iPhone notch / Dynamic Island */}
            <div style={{padding:"16px 20px",paddingTop:"max(16px, env(safe-area-inset-top))",background:"#0a0b10",borderBottom:"1px solid #1a2030",display:"flex",alignItems:"center",gap:10,position:"sticky",top:0,zIndex:1}}>
              <div style={{flex:1}}>
                <div style={{fontSize:20,fontWeight:700,color:"#fff",fontFamily:F,textTransform:"uppercase",letterSpacing:1.5}}>{card.hot && <IconFire size={16} color="#FFB300" style={{marginRight:6,flexShrink:0}}/>}{card.cn}</div>
                {card.addr && <div style={{fontSize:13,color:"#8a96a8",fontFamily:F,textTransform:"uppercase",letterSpacing:1,marginTop:2}}>{card.addr}</div>}
                {(() => {
                  const lc = formatContact(lastContact[card.id]);
                  return lc ? <div style={{fontSize:11,color:"#64B5F6",marginTop:4,fontWeight:600,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>{lc}</div> : null;
                })()}
              </div>
              {detailLoading && <div style={{fontSize:10,color:"#3B82F6",fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>↻</span> syncing</div>}
              <span style={{padding:"4px 12px",borderRadius:99,background:stage?.bg,color:stage?.color,fontSize:12,fontWeight:700,fontFamily:F,textTransform:"uppercase",letterSpacing:0.5}}>{stage?.label}</span>
              <button onClick={() => setDetailCard(null)} style={{width:32,height:32,borderRadius:8,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>

            <div style={{padding:"16px 20px"}}>
              {/* Stage move bar — sits above contact info for quick access */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14,paddingBottom:12,borderBottom:"1px solid #1a2030"}}>
                {isDeclined && <button onClick={() => { reactivate(card.id); setDetailCard({...card, stage:"estimate_needed"}); }} style={{padding:"6px 12px",borderRadius:8,background:"rgba(255,183,77,.1)",border:"1px solid rgba(255,183,77,.3)",color:"#FFB74D",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:F,textTransform:"uppercase"}}>↩ REACTIVATE</button>}
                {STAGES.filter(st => st.id !== card.stage && !(isDeclined && st.id !== "estimate_needed")).map(st => (
                  <button key={st.id} onClick={() => { moveCard(card.id, st.id); setDetailCard(null); }} style={{padding:"6px 10px",borderRadius:8,background:st.bg,border:`1px solid ${st.color}40`,color:st.color,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:F,textTransform:"uppercase",letterSpacing:0.3}}>{st.label}</button>
                ))}
              </div>

              {/* Contact */}
              <div style={{display:"flex",gap:16,marginBottom:16,flexWrap:"wrap"}}>
                {card.phone && <div style={{fontSize:14,color:"#a0b8d0",display:"flex",alignItems:"center",gap:6}}><IconPhone size={14} color="#a0b8d0"/><a href={`tel:${card.phone.replace(/\D/g,"")}`} onClick={()=>markContact(card.id,"call")} style={{color:"#a0b8d0",textDecoration:"none"}}>{card.phone}</a></div>}
                {card.email && <button onClick={()=>{navigator.clipboard?.writeText(card.email).catch(()=>{});markContact(card.id,"email");}} style={{fontSize:14,color:"#a0b8d0",background:"none",border:"none",cursor:"pointer",padding:0,display:"flex",alignItems:"center",gap:6}} title="Copy email">
                  <IconMail size={14} color="#a0b8d0"/><span style={{color:"#a0b8d0"}}>{card.email}</span>
                </button>}
                {card.jn && <button onClick={() => openSingleOps(card.jn)} style={{fontSize:14,color:"#3B82F6",background:"none",border:"none",cursor:"pointer",fontWeight:600,padding:0}}><span style={{display:"flex",alignItems:"center",gap:4}}>SingleOps #{card.jn}<IconClipboard size={12} color="#3B82F6"/></span></button>}
              </div>

              {/* Job notes */}
              {card.notes && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>JOB NOTES</div>
                <div style={{fontSize:14,color:"#8898a8",lineHeight:1.6,fontStyle:"italic"}}>{card.notes}</div>
              </div>}

              {/* Scope section */}
              {(fd.scopeNotes || fd.myNotes) && <div style={{marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:"#3B82F6",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>SCOPE</div>
                <textarea value={fd.scopeNotes || fd.myNotes || ""} onChange={e => saveEditedField(card.id, "scopeNotes", e.target.value)} rows={Math.max(5, Math.round(Math.ceil((fd.scopeNotes || fd.myNotes || "").length / 60) * 1.3))} style={editStyle("#b0b8c8")} />
                <button onClick={() => saveEditedField(card.id, "scopeNotes", (fd.scopeNotes || fd.myNotes || "").toUpperCase())} style={{marginTop:4,padding:"5px 12px",borderRadius:6,background:"rgba(176,184,200,.06)",border:"1px solid rgba(176,184,200,.15)",color:"#6a7a90",fontSize:10,fontWeight:800,cursor:"pointer",letterSpacing:1}}>AA → ALL CAPS</button>
                <button onClick={() => generateDetailScopeSummary(card, fd)} disabled={detailAiScopeLoading} style={{marginTop:6,width:"100%",padding:"9px 12px",borderRadius:8,background:detailAiScopeLoading?"rgba(59,130,246,.05)":"rgba(59,130,246,.1)",border:"1px solid rgba(59,130,246,.25)",color:detailAiScopeLoading?"#3a5a80":"#3B82F6",fontSize:11,fontWeight:700,cursor:detailAiScopeLoading?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
                  <span style={{fontSize:13}}>{detailAiScopeLoading?"⏳":"✦"}</span>
                  {detailAiScopeLoading ? "Generating summary…" : fd.aiScopeSummary ? "Regenerate scope summary" : "Generate scope summary"}
                </button>
              </div>}

              {fd.aiScopeSummary && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>AI SCOPE SUMMARY</div>
                <textarea value={fd.aiScopeSummary} onChange={e => saveEditedField(card.id, "aiScopeSummary", e.target.value)} style={editStyle("#a0b0c8")} />
              </div>}

              {/* Scope photos — fully editable */}
              <div style={{marginBottom:16}}>
                {scopePhotos.length > 0 && <>
                  <div style={{fontSize:11,fontWeight:700,color:"#3B82F6",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:8}}>SCOPE PHOTOS ({scopePhotos.length})</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))",gap:8,marginBottom:8}}>
                    {scopePhotos.map((p, i) => (
                      <div key={i} style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1px solid #1a2540",aspectRatio:"4/3"}}>
                        <img src={p.dataUrl} alt="" onClick={() => setDetailMarkup({section:"scope",idx:i})} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                        <button onClick={() => detailRemovePhoto(i,"scope",card.id)} style={{position:"absolute",top:4,right:4,width:22,height:22,borderRadius:11,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={11} color="#ff6666"/></button>
                        <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:3}}>
                          <div onClick={() => setDetailMarkup({section:"scope",idx:i})} style={{padding:"3px 7px",borderRadius:5,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                          <a href={p.dataUrl} download={`${card.cn.replace(/\s+/g,"_")}_scope_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"3px 7px",borderRadius:5,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={10} color="#ccc"/></a>
                        </div>
                      </div>
                    ))}
                  </div>
                </>}
                <input ref={detailScopeLibRef} type="file" accept="image/*" multiple onChange={e => detailHandleLibraryPhotos(e,"scope",card.id)} style={{display:"none"}} />
                <div style={{display:"flex",gap:6}}>
                  <button onClick={() => setDetailShowCamera("scope")} style={{flex:1,padding:"8px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                    <IconCamera size={14} color="#5a7090"/><span style={{fontSize:10,color:"#5a7090",fontWeight:600}}>Camera</span>
                  </button>
                  <button onClick={() => detailScopeLibRef.current?.click()} style={{flex:1,padding:"8px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                    <IconImage size={14} color="#5a7090"/><span style={{fontSize:10,color:"#5a7090",fontWeight:600}}>Library</span>
                  </button>
                </div>
              </div>

              {/* Add-on section */}
              {fd.addonNotes && <div style={{marginBottom:16}}>
                <div style={{fontSize:12,fontWeight:700,color:"#FF8A65",letterSpacing:1.5,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>ADD-ON</div>
                <textarea value={fd.addonNotes} onChange={e => saveEditedField(card.id, "addonNotes", e.target.value)} rows={Math.max(4, Math.ceil((fd.addonNotes || "").length / 60))} style={editStyle("#c8b0a0")} />
                <button onClick={() => saveEditedField(card.id, "addonNotes", (fd.addonNotes || "").toUpperCase())} style={{marginTop:4,padding:"5px 12px",borderRadius:6,background:"rgba(200,176,160,.06)",border:"1px solid rgba(200,176,160,.15)",color:"#8a6a50",fontSize:10,fontWeight:800,cursor:"pointer",letterSpacing:1}}>AA → ALL CAPS</button>
                <button onClick={() => generateDetailAddonEmail(card, fd)} disabled={detailAiAddonLoading} style={{marginTop:6,width:"100%",padding:"9px 12px",borderRadius:8,background:detailAiAddonLoading?"rgba(255,138,101,.05)":"rgba(255,138,101,.1)",border:"1px solid rgba(255,138,101,.25)",color:detailAiAddonLoading?"#906050":"#FF8A65",fontSize:11,fontWeight:700,cursor:detailAiAddonLoading?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>
                  <span style={{fontSize:13}}>{detailAiAddonLoading?"⏳":"✦"}</span>
                  {detailAiAddonLoading ? "Generating email…" : fd.aiAddonEmail ? "Regenerate add-on email" : "Generate add-on email"}
                </button>
              </div>}

              {fd.aiAddonEmail && <div style={{marginBottom:16}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,flex:1}}>AI ADD-ON EMAIL</span>
                  <button onClick={()=>{
                    const subject = `Additional findings from your estimate — Monster Tree Service`;
                    openEmailCompose(card.email||"", subject, fd.aiAddonEmail);
                  }} style={{padding:"3px 8px",borderRadius:5,background:"rgba(255,138,101,.08)",border:"1px solid rgba(255,138,101,.25)",color:"#FF8A65",fontSize:10,fontWeight:700,cursor:"pointer"}}>Send</button>
                  <button onClick={()=>{navigator.clipboard?.writeText(fd.aiAddonEmail).catch(()=>{});}} style={{padding:"3px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:10,fontWeight:700,cursor:"pointer"}}>Copy</button>
                </div>
                <textarea value={fd.aiAddonEmail} onChange={e => saveEditedField(card.id, "aiAddonEmail", e.target.value)} style={editStyle("#c8a090")} />
              </div>}

              {/* Add-on photos — fully editable */}
              <div style={{marginBottom:16}}>
                {addonPhotos.length > 0 && <>
                  <div style={{fontSize:11,fontWeight:700,color:"#FF8A65",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:8}}>ADD-ON PHOTOS ({addonPhotos.length})</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))",gap:8,marginBottom:8}}>
                    {addonPhotos.map((p, i) => (
                      <div key={i} style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1px solid #1a2540",aspectRatio:"4/3"}}>
                        <img src={p.dataUrl} alt="" onClick={() => setDetailMarkup({section:"addon",idx:i})} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer"}} />
                        <button onClick={() => detailRemovePhoto(i,"addon",card.id)} style={{position:"absolute",top:4,right:4,width:22,height:22,borderRadius:11,background:"rgba(0,0,0,.7)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><IconX size={11} color="#ff6666"/></button>
                        <div style={{position:"absolute",bottom:4,left:4,display:"flex",gap:3}}>
                          <div onClick={() => setDetailMarkup({section:"addon",idx:i})} style={{padding:"3px 7px",borderRadius:5,background:"rgba(0,0,0,.7)",cursor:"pointer"}}><IconPen size={10} color="#ccc"/></div>
                          <a href={p.dataUrl} download={`${card.cn.replace(/\s+/g,"_")}_addon_${i+1}.jpg`} onClick={e=>e.stopPropagation()} style={{padding:"3px 7px",borderRadius:5,background:"rgba(0,0,0,.7)",cursor:"pointer",textDecoration:"none"}}><IconDownload size={10} color="#ccc"/></a>
                        </div>
                      </div>
                    ))}
                  </div>
                </>}
                <input ref={detailAddonLibRef} type="file" accept="image/*" multiple onChange={e => detailHandleLibraryPhotos(e,"addon",card.id)} style={{display:"none"}} />
                <div style={{display:"flex",gap:6}}>
                  <button onClick={() => setDetailShowCamera("addon")} style={{flex:1,padding:"8px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                    <IconCamera size={14} color="#5a7090"/><span style={{fontSize:10,color:"#5a7090",fontWeight:600}}>Camera</span>
                  </button>
                  <button onClick={() => detailAddonLibRef.current?.click()} style={{flex:1,padding:"8px 0",borderRadius:8,background:"#0e1120",border:"1px dashed #1a2540",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4}}>
                    <IconImage size={14} color="#5a7090"/><span style={{fontSize:10,color:"#5a7090",fontWeight:600}}>Library</span>
                  </button>
                </div>
              </div>

              {/* Video — upload, view, delete */}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
                  VIDEO
                  {detailYtCount > 0 && <span style={{fontSize:9,color:"#F6BF26",fontWeight:700,padding:"1px 8px",borderRadius:10,background:"rgba(246,191,38,.1)",border:"1px solid rgba(246,191,38,.2)"}}>↑ Uploading…</span>}
                </div>
                {videoUrls.map((url, i) => {
                  const vid = getYtId(url);
                  return <div key={i} style={{marginBottom:8,borderRadius:8,background:"#0e1120",border:"1px solid #1a2540",overflow:"hidden"}}>
                    {vid ? (
                      <div style={{position:"relative",paddingBottom:"56.25%"}}>
                        <iframe src={`https://www.youtube.com/embed/${vid}`} style={{position:"absolute",inset:0,width:"100%",height:"100%",border:"none"}} allowFullScreen />
                      </div>
                    ) : (
                      <a href={url} target="_blank" rel="noopener noreferrer" style={{display:"block",padding:"10px 12px",fontSize:13,color:"#6a8ab0"}}>{url}</a>
                    )}
                    <div style={{padding:"6px 8px",display:"flex",gap:6,alignItems:"center"}}>
                      <div style={{fontSize:9,color:"#5a6890",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{url}</div>
                      <button onClick={()=>{const html=`<a href="${url}">Link to Video Review</a>`;if(navigator.clipboard?.write){navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([url],{type:"text/plain"})})]).catch(()=>navigator.clipboard?.writeText(url));}else{navigator.clipboard?.writeText(url);}}} style={{padding:"4px 8px",borderRadius:5,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#5a90b0",fontSize:10,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>Copy link</button>
                      <button onClick={() => detailDeleteVideo(url, i, card, fd)} style={{padding:"4px 6px",borderRadius:5,background:"rgba(200,60,60,.08)",border:"1px solid rgba(200,60,60,.15)",color:"#e06060",cursor:"pointer",display:"flex",alignItems:"center",flexShrink:0}}><IconX size={10} color="#e06060"/></button>
                    </div>
                  </div>;
                })}
                <input ref={detailYtFileRef} type="file" accept="video/*" onChange={e => detailHandleYtFile(e, card, fd)} style={{display:"none"}} />
                <button onClick={() => detailYtFileRef.current?.click()} style={{width:"100%",padding:"9px 0",borderRadius:8,background:"rgba(255,0,0,.06)",border:"1px dashed rgba(255,0,0,.2)",color:"#cc4040",fontSize:11,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  <IconYoutube size={13} color="#cc4040"/>{videoUrls.length > 0 ? `Add another video (${videoUrls.length + 1})` : "Upload video"}
                </button>
              </div>

              {/* Audio clips */}
              {(fd.audioClips || []).length > 0 && <div style={{marginBottom:16}}>
                <div style={{fontSize:11,fontWeight:700,color:"#4a5a70",letterSpacing:1,textTransform:"uppercase",fontFamily:F,marginBottom:4}}>VOICE MEMOS ({fd.audioClips.length})</div>
                {fd.audioClips.map((clip, i) => (
                  <audio key={i} controls src={clip.dataUrl} style={{width:"100%",marginBottom:4,height:36}} />
                ))}
              </div>}

              {/* Metadata */}
              <div style={{fontSize:12,color:"#4a5a70",marginBottom:16}}>
                Added {card.addedAt ? new Date(card.addedAt).toLocaleDateString() : "—"} · {card.constraint || "No constraints"}
              </div>

            </div>
            </div>{/* end scrollable */}

            {/* Sticky bottom bar — Route button lives here so it doesn't crowd the header */}
            <div style={{flexShrink:0,padding:"10px 20px",paddingBottom:"max(10px,env(safe-area-inset-bottom))",background:"#0a0b10",borderTop:"1px solid #1a2030",display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={() => { setDetailCard(null); onSwitchToRoute(card.id); }} style={{flex:1,padding:"11px 0",borderRadius:10,background:"rgba(59,130,246,.08)",border:"1px solid rgba(59,130,246,.2)",color:"#3B82F6",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>← Route</button>
              <button onClick={() => setDetailCard(null)} style={{flex:2,padding:"11px 0",borderRadius:10,background:"#1a2035",border:"1px solid #2a3560",color:"#8898a8",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:F,letterSpacing:0.5,textTransform:"uppercase"}}>Close</button>
            </div>

          </div>{/* end centered card */}
        </div>;{/* end backdrop */}
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
                  : <button onClick={()=>{
                      openEmailCompose(item.email, item.subject, item.body);
                      markContact(item.cardId, "email");
                      setBulkEmailQueue(prev => prev.map((x,j) => j===i ? {...x,opened:true} : x));
                    }} style={{padding:"6px 14px",borderRadius:8,background:"rgba(59,130,246,.15)",border:"1px solid rgba(59,130,246,.3)",color:"#3B82F6",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0}}>
                      Open →
                    </button>
                }
              </div>
            ))}
            {bulkEmailQueue.every(x=>x.opened) && <div style={{textAlign:"center",padding:"10px 0",fontSize:12,color:"#10B981",fontWeight:700}}>✓ All {bulkEmailQueue.length} opened</div>}
          </> : !emailPreview ? <>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:15,fontWeight:700,color:"#f0f4fa",flex:1,fontFamily:F,letterSpacing:1,textTransform:"uppercase"}}>Email {selectedCount} clients</span>
              <button onClick={()=>{setEmailSheet(false);}} style={{width:28,height:28,borderRadius:6,background:"#1a2035",border:"1px solid #2a3560",color:"#5a6580",fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            <div style={{fontSize:11,color:"#5a6580",marginBottom:10}}>Choose a template — each email will be personalized with the client's name.</div>
            {EMAIL_TEMPLATES.map(t => (
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

export { STAGES, loadPipeline, savePipeline };

/* ═══════════════════════════════════════════════════════════════════════════
   Module-level helpers — outside React so async work survives navigation
   ═══════════════════════════════════════════════════════════════════════════ */

// Photo resize + immediate IndexedDB save for the detail popup
function _detailProcessPhoto(file, section, cardId, addCallback) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 2400;
      let w = img.width, h = img.height;
      if (w > MAX) { h = h * MAX / w; w = MAX; }
      if (h > MAX) { w = w * MAX / h; h = MAX; }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", 0.82);
      addCallback(dataUrl, section, cardId);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// YouTube upload — network request is browser-managed, not tied to component
async function _uploadToYouTubeForDetail(file, title, token, stopId) {
  try {
    const tokenData = JSON.parse(localStorage.getItem("mts-token") || "null");
    const tok = tokenData?.token || token;
    if (!tok) return null;
    const metadata = { snippet: { title }, status: { privacyStatus: "unlisted" } };
    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(metadata) }
    );
    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) return null;
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT", headers: { "Content-Type": file.type || "video/mp4" }, body: file,
    });
    const result = await uploadRes.json();
    return result.id ? `https://youtu.be/${result.id}` : null;
  } catch(e) { console.warn("YouTube upload failed:", e); return null; }
}
