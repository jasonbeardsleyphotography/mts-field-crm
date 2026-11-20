/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Which Google calendar(s) the route reads
   ───────────────────────────────────────────────────────────────────────────
   The route used to read only the signed-in account's PRIMARY calendar. For a
   second salesperson whose SingleOps appointments land on another calendar
   (a separate "SingleOps" calendar, or one shared from another account), the
   route came up empty. Each device can now choose one or more calendars
   (Settings → Route calendar); the default is still the primary calendar.

   Changes to an appointment (stage colour, moving it to another day) must go
   to the calendar it lives on, so each loaded event's calendar is remembered;
   when it isn't known (an older pipeline card), the chosen calendars are tried
   in turn until one has the event.
   ═══════════════════════════════════════════════════════════════════════════ */

const KEY = "mts-route-calendars";
const API = "https://www.googleapis.com/calendar/v3";

export function getRouteCalendars() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (Array.isArray(v) && v.length) return v;
  } catch {}
  return ["primary"];
}
export function setRouteCalendars(ids) {
  const list = (ids || []).filter(Boolean);
  try {
    if (!list.length || (list.length === 1 && list[0] === "primary")) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

export const calendarBase = (calId) => `${API}/calendars/${encodeURIComponent(calId)}`;

// eventId -> calendarId, for the events loaded this session.
const eventCal = new Map();
export function rememberEventCalendar(eventId, calId) { if (eventId && calId) eventCal.set(eventId, calId); }

/** The calendar new appointments are created on: the first chosen one. */
export const primaryRouteCalendar = () => getRouteCalendars()[0];

/** fetch() against /events/<id> on the calendar the event lives on. */
export async function fetchCalendarEvent(token, eventId, init = {}) {
  const known = eventCal.get(eventId);
  const order = [...new Set([known, ...getRouteCalendars()].filter(Boolean))];
  let res = null;
  for (const calId of order) {
    res = await fetch(`${calendarBase(calId)}/events/${encodeURIComponent(eventId)}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    if (res.status !== 404 && res.status !== 410) {
      if (res.ok) rememberEventCalendar(eventId, calId);
      return res;
    }
  }
  return res;
}

/** Every calendar this account can see, with how many events each has today. */
export async function listCalendarsWithToday(token) {
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const r = await fetch(`${API}/users/me/calendarList?fields=items(id,summary,summaryOverride,primary,accessRole,backgroundColor)&maxResults=100`, auth);
  if (!r.ok) throw new Error(`Calendar list failed (${r.status})`);
  const items = (await r.json()).items || [];
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const e = new Date(); e.setHours(23, 59, 59, 999);
  return Promise.all(items.map(async (c) => {
    let today = null;
    try {
      const er = await fetch(`${calendarBase(c.id)}/events?singleEvents=true&timeMin=${s.toISOString()}&timeMax=${e.toISOString()}&maxResults=100&fields=items(id)`, auth);
      if (er.ok) today = ((await er.json()).items || []).length;
    } catch {}
    return { id: c.primary ? "primary" : c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, color: c.backgroundColor, today };
  }));
}
