/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Event Parser
   Parses Google Calendar events into structured stop objects.
   ═══════════════════════════════════════════════════════════════════════════ */

const STAGE_COLORS = { "10":"#0B8043","3":"#8E24AA","7":"#039BE5","1":"#7986CB","5":"#F6BF26","4":"#E67C73","2":"#33B679","11":"#D50000","9":"#3F51B5","8":"#616161" };
export function stageColor(colorId) { return STAGE_COLORS[colorId] || "#039BE5"; }

export function parseEvent(ev) {
  const s = ev.summary || "", rd = ev.description || "";
  const desc = rd.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();

  // Filter: skip MTS NOTE and ***NOTE!*** events
  if (/MTS NOTE/i.test(s) || /\*{2,}NOTE[!]*\*{2,}/i.test(s)) return null;

  // Parse fields — handle varying title formats from SingleOps
  // Format: Task | #NUM SEGMENT1 - SEGMENT2 - SEGMENT3 - ...
  // Address is always first segment(s), client name follows, then visit type
  const jobMatch = s.match(/Task \| #(\d+)/);
  const jobNum = jobMatch ? jobMatch[1] : null;

  // Split everything after "Task | #NUM " by dashes
  const afterJob = s.replace(/^Task \| #\d+\s*/, "");
  const segments = afterJob.split(/\s*-\s*/).map(x => x.trim()).filter(Boolean);

  // Detect if a segment looks like an address (starts with number + street-like words or is a zip)
  const looksLikeAddr = (t) => /^\d+\s+\w/.test(t) && /\b(rd|st|ave|dr|ln|ct|blvd|way|pl|cir|pkwy|hwy|ter|trail|road|street|avenue|drive|lane|court)\b/i.test(t) || /^\d{5}$/.test(t.trim()) || /\b\d{5}\b/.test(t);

  // Walk segments: skip address-like ones, first non-address is the client name
  let clientName = "", titleContext = "";
  const addrSegments = [];
  let nameIdx = -1;
  if (segments.length >= 2) {
    // First segment is always part of address
    addrSegments.push(segments[0]);
    // Check subsequent segments — if they look like addresses, they're part of address too
    for (let i = 1; i < segments.length; i++) {
      if (nameIdx === -1 && looksLikeAddr(segments[i])) {
        addrSegments.push(segments[i]);
      } else if (nameIdx === -1) {
        clientName = segments[i];
        nameIdx = i;
      } else {
        // Everything after client name is title context
        titleContext = segments.slice(i).join(" – ");
        break;
      }
    }
    if (nameIdx === -1 && segments.length >= 2) {
      // Fallback: no address-like segment found, use original pattern (seg 1 = name)
      clientName = segments[1] || segments[0];
      if (segments.length > 2) titleContext = segments.slice(2).join(" – ");
    }
  } else if (segments.length === 1) {
    clientName = segments[0];
  }

  // If no job match, fall back to raw title cleanup
  if (!jobMatch) {
    clientName = s.replace(/^TODO:\s*/i,"").replace(/^TASK\s+/i,"").trim();
  }

  // Address: prefer Google Calendar location field, fall back to parsed address segments
  const parsedAddr = addrSegments.join(", ");
  const address = ev.location || parsedAddr;

  const mobileMatch = desc.match(/Mobile:\s*([\d\-(). +]+?)(?:\s*$|\s*Email)/);
  const phoneMatch = desc.match(/Phone:\s*([\d\-(). +]+?)(?:\s*$|\s*Mobile)/);
  const phone = (mobileMatch && mobileMatch[1].trim().length > 5 ? mobileMatch[1].trim() : "") || (phoneMatch && phoneMatch[1].trim().length > 5 ? phoneMatch[1].trim() : "");
  const emailMatch = desc.match(/Email:\s*(\S+@\S+)/);
  const email = emailMatch ? emailMatch[1].trim() : "";
  const notesMatch = desc.match(/Notes:\s*([\s\S]*)/);
  const notes = notesMatch ? notesMatch[1].replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim() : "";

  const isDriveBy = /drive[\s-]?by/i.test(s);
  const isTask = /^Task\b/i.test(s);
  const isTodo = /^TODO:/i.test(s);
  const isAdmin = (ev.colorId === "8" || ev.colorId === "11") && !isTask && !isTodo;

  const start = new Date(ev.start?.dateTime || ev.start?.date);
  const end = new Date(ev.end?.dateTime || ev.end?.date);
  const startH = start.getHours() + start.getMinutes()/60;
  const durH = (end - start) / 36e5;
  let window = startH < 10.5 ? "AM" : "PM";
  const fmt = d => d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}).replace(":00","");
  const timeLabel = fmt(start) + "–" + fmt(end);

  // Constraints
  let constraint = "";
  if (/CALL (WHEN|FIRST|BEFORE|OTW)/i.test(s)) constraint = "📞 CALL FIRST";
  if (/NOT BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/NOT BEFORE\s*([\d:]+)/i)[1];
  if (/([\d:]+)\s*OR LATER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + s.match(/([\d:]+)\s*OR LATER/i)[1] + " or later";
  if (/CAN'?T MEET BEFORE\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CAN'?T MEET BEFORE\s*([\d:]+)/i)[1];
  if (/CANNOT MEET BEFORE\s*(\w+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Not before " + s.match(/CANNOT MEET BEFORE\s*(\w+)/i)[1];
  if (/CAN'?T MEET (PAST|AFTER)\s*([\d:]+)/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "Before " + s.match(/CAN'?T MEET (?:PAST|AFTER)\s*([\d:]+)/i)[1];
  if (/CAN'?T MEET OUTSIDE/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "⏰ " + fmt(start) + "–" + fmt(end) + " ONLY";
  if (/EARLIER IS BETTER/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "⏰ EARLIER IS BETTER";
  if (/MEET (?:AT |.+?AT )(.+?)$/i.test(s)) { const m = s.match(/MEET (?:AT |.+?AT )(.+?)$/i); if (m) constraint = (constraint ? constraint + " · " : "") + "📍 " + m[1].slice(0,40); }
  if (/YARD STICK/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "🪧 Yard stick";
  if (/WE CAN MOVE/i.test(s)) constraint = (constraint ? constraint + " · " : "") + "↔ Flexible";
  if (!constraint && !isDriveBy && durH < 3) constraint = "⏰ " + fmt(start) + "–" + fmt(end);

  // Clean up title context — strip visit type prefixes
  if (titleContext) {
    titleContext = titleContext.replace(/^On Site (?:Estimate|Site)\s*[-–]?\s*/i, "");
    titleContext = titleContext.replace(/^DRIVE[\s-]?BY\s*[-–]?\s*/i, "");
    if (titleContext.length <= 2) titleContext = "";
  }

  const color = stageColor(ev.colorId);

  return {
    id: ev.id, cn: clientName, addr: address, phone, email, notes, desc,
    jn: jobNum, db: isDriveBy, isTask, isTodo, isAdmin, constraint, color,
    colorId: ev.colorId, raw: s, rawD: rd, window, timeLabel, titleContext,
  };
}
