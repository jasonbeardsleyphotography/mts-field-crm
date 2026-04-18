/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Icon System
   Clean SVG line icons. Consistent 1.5px stroke. No fills.
   Modern, minimal, platform-independent.
   ═══════════════════════════════════════════════════════════════════════════ */

const Icon = ({ d, size = 18, color = "currentColor", strokeWidth = 1.5, fill = "none", viewBox = "0 0 24 24", style = {} }) => (
  <svg width={size} height={size} viewBox={viewBox} fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display:"block", flexShrink:0, ...style }}>
    <path d={d} />
  </svg>
);

const IconMulti = ({ paths, size = 18, color = "currentColor", strokeWidth = 1.5, fill = "none", viewBox = "0 0 24 24", style = {} }) => (
  <svg width={size} height={size} viewBox={viewBox} fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display:"block", flexShrink:0, ...style }}>
    {paths.map((p, i) => typeof p === "string" ? <path key={i} d={p} /> : <path key={i} {...p} />)}
  </svg>
);

// ── NAVIGATION ────────────────────────────────────────────────────────────
export const IconArrowLeft = (p) => <Icon {...p} d="M19 12H5M12 5l-7 7 7 7" />;
export const IconArrowRight = (p) => <Icon {...p} d="M5 12h14M12 19l7-7-7-7" />;
export const IconChevronRight = (p) => <Icon {...p} d="M9 18l6-6-6-6" />;
export const IconChevronDown = (p) => <Icon {...p} d="M6 9l6 6 6-6" />;
export const IconUndo = (p) => <IconMulti {...p} paths={["M3 7v6h6","M3 13C5.33 7.33 12.67 4.67 17 7c4.33 2.33 5.67 7 3 10"]} />;
export const IconRefresh = (p) => <IconMulti {...p} paths={["M23 4v6h-6","M1 20v-6h6","M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0018.49 15"]} />;

// ── ROUTE / MAP ───────────────────────────────────────────────────────────
export const IconNavigation = (p) => <Icon {...p} d="M3 11l19-9-9 19-2-8-8-2z" />;
export const IconMapPin = (p) => <IconMulti {...p} paths={["M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z","M12 7a3 3 0 100 6 3 3 0 000-6z"]} />;
export const IconReorder = (p) => <IconMulti {...p} paths={["M8 6h13","M8 12h13","M8 18h13","M3 6h.01","M3 12h.01","M3 18h.01"]} />;

// ── COMMUNICATION ─────────────────────────────────────────────────────────
export const IconMessageSquare = (p) => <IconMulti {...p} paths={["M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"]} />;
export const IconMail = (p) => <IconMulti {...p} paths={["M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z","M22 6l-10 7L2 6"]} />;
export const IconPhone = (p) => <Icon {...p} d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />;
export const IconSend = (p) => <IconMulti {...p} paths={["M22 2L11 13","M22 2L15 22l-4-9-9-4 20-7z"]} />;

// ── CAMERA / PHOTO ────────────────────────────────────────────────────────
export const IconCamera = (p) => <IconMulti {...p} paths={["M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z","M12 17a4 4 0 100-8 4 4 0 000 8z"]} />;
export const IconImage = (p) => <IconMulti {...p} paths={["M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2z","M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z","M21 15l-5-5L5 21"]} />;
export const IconDownload = (p) => <IconMulti {...p} paths={["M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4","M7 10l5 5 5-5","M12 15V3"]} />;

// ── AUDIO / SPEAKER ───────────────────────────────────────────────────────
export const IconVolume2 = (p) => <IconMulti {...p} paths={["M11 5L6 9H2v6h4l5 4V5z","M19.07 4.93a10 10 0 010 14.14","M15.54 8.46a5 5 0 010 7.07"]} />;
export const IconVolumeX = (p) => <IconMulti {...p} paths={["M11 5L6 9H2v6h4l5 4V5z","M23 9l-6 6","M17 9l6 6"]} />;
export const IconMic = (p) => <IconMulti {...p} paths={["M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z","M19 10v2a7 7 0 01-14 0v-2","M12 19v4","M8 23h8"]} />;
export const IconMicOff = (p) => <IconMulti {...p} paths={["M1 1l22 22","M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6","M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23","M12 19v4M8 23h8"]} />;

// ── EDITING / MARKUP ──────────────────────────────────────────────────────
export const IconPen = (p) => <Icon {...p} d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />;
export const IconEraser = (p) => <IconMulti {...p} paths={["M20 20H7L3 16l10-10 7 7-3.5 3.5","M6.5 17.5l4-4"]} />;
export const IconArrowUpRight = (p) => <IconMulti {...p} paths={["M7 17L17 7","M7 7h10v10"]} />;
export const IconScissors = (p) => <IconMulti {...p} paths={["M6 9a3 3 0 100-6 3 3 0 000 6z","M6 15a3 3 0 100 6 3 3 0 000-6z","M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"]} />;

// ── AI / SPARKLE ──────────────────────────────────────────────────────────
export const IconSparkles = (p) => <IconMulti {...p} paths={["M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z","M19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z","M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17z"]} />;
export const IconZap = (p) => <Icon {...p} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />;

// ── PIPELINE / WORKFLOW ───────────────────────────────────────────────────
export const IconTrendingUp = (p) => <IconMulti {...p} paths={["M23 6l-9.5 9.5-5-5L1 18","M17 6h6v6"]} />;
export const IconFlag = (p) => <IconMulti {...p} paths={["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z","M4 22v-7"]} />;
export const IconRotateCcw = (p) => <IconMulti {...p} paths={["M1 4v6h6","M3.51 15a9 9 0 102.13-9.36L1 10"]} />;
export const IconCheckCircle = (p) => <IconMulti {...p} paths={["M22 11.08V12a10 10 0 11-5.93-9.14","M22 4L12 14.01l-3-3"]} />;
export const IconXCircle = (p) => <IconMulti {...p} paths={["M22 12a10 10 0 11-20 0 10 10 0 0120 0z","M15 9l-6 6","M9 9l6 6"]} />;
export const IconPause = (p) => <IconMulti {...p} paths={["M6 4h4v16H6z","M14 4h4v16h-4z"]} />;
export const IconFire = (p) => <Icon {...p} d="M12 22c5.523 0 10-4.477 10-10 0-2.5-1-5-2.5-7C18 7 16 8.5 15.5 10c-.5-2-2-4-4-5.5C11 6 9.5 7.5 9 9.5 8 7 6 5.5 5 4.5 3.5 6.5 2 9 2 12c0 5.523 4.477 10 10 10z" />;
export const IconRevision = (p) => <IconMulti {...p} paths={["M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7","M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"]} />;

// ── UTILITY ───────────────────────────────────────────────────────────────
export const IconPlus = (p) => <IconMulti {...p} paths={["M12 5v14","M5 12h14"]} />;
export const IconX = (p) => <IconMulti {...p} paths={["M18 6L6 18","M6 6l12 12"]} />;
export const IconSearch = (p) => <IconMulti {...p} paths={["M21 21l-4.35-4.35","M17 11A6 6 0 111 11a6 6 0 0116 0z"]} />;
export const IconTrash = (p) => <IconMulti {...p} paths={["M3 6h18","M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"]} />;
export const IconEdit = (p) => <IconMulti {...p} paths={["M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7","M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"]} />;
export const IconSettings = (p) => <IconMulti {...p} paths={["M12 15a3 3 0 100-6 3 3 0 000 6z","M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"]} />;
export const IconEye = (p) => <IconMulti {...p} paths={["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z","M12 9a3 3 0 100 6 3 3 0 000-6z"]} />;
export const IconCloud = (p) => <Icon {...p} d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />;
export const IconCloudOff = (p) => <IconMulti {...p} paths={["M22.61 16.95A5 5 0 0018 10h-1.26a8 8 0 00-9.06-5.09","M5 5a8 8 0 004 15h9a5 5 0 001.7-.3","M1 1l22 22"]} />;
export const IconVideo = (p) => <IconMulti {...p} paths={["M23 7l-7 5 7 5V7z","M1 5h14a2 2 0 012 2v10a2 2 0 01-2 2H1V5z"]} />;
export const IconYoutube = (p) => <IconMulti {...p} paths={["M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46a2.78 2.78 0 00-1.95 1.96A29 29 0 001 12a29 29 0 00.46 5.58A2.78 2.78 0 003.41 19.54C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 001.95-1.96A29 29 0 0023 12a29 29 0 00-.46-5.58z","M9.75 15.02l5.75-3.02-5.75-3.02v6.04z"]} />;
export const IconClipboard = (p) => <IconMulti {...p} paths={["M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2","M9 2h6a1 1 0 011 1v2a1 1 0 01-1 1H9a1 1 0 01-1-1V3a1 1 0 011-1z"]} />;
export const IconStar = (p) => <Icon {...p} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />;
export const IconSingleops = (p) => <IconMulti {...p} paths={["M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z","M14 2v6h6","M12 18v-6","M9 15h6"]} />;

// Convenience: icon button wrapper
export const IconBtn = ({ icon: Ic, onClick, color, bg, border, size = 18, title, style = {}, disabled }) => (
  <button onClick={onClick} title={title} disabled={disabled} style={{
    display:"flex", alignItems:"center", justifyContent:"center",
    padding:8, borderRadius:8, border: border || "1px solid rgba(255,255,255,.06)",
    background: bg || "transparent", color: color || "currentColor",
    cursor: disabled ? "default" : "pointer", opacity: disabled ? .4 : 1,
    flexShrink:0, ...style,
  }}>
    <Ic size={size} color={color || "currentColor"} />
  </button>
);
