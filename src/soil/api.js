/* Soil ↔ server. */
export class ApiError extends Error {
  constructor(status, code) { super(code || `error ${status}`); this.status = status; this.code = code; }
}

export async function soilApi(path, { method = "GET", body, raw } = {}) {
  const r = await fetch(`/api/soil/${path}`, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : raw ? { "Content-Type": "application/pdf" } : undefined,
    body: body ? JSON.stringify(body) : raw,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new ApiError(r.status, data?.error);
  return data;
}

/** Redeem a Dispatch/Soil sign-in link (same sessions as Dispatch). */
export async function redeemLink(code) {
  const r = await fetch("/api/dispatch/redeem", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
  });
  if (!r.ok) { let e = null; try { e = (await r.json()).error; } catch {} throw new ApiError(r.status, e); }
}

export const pdfUrl = (siteId, key, token) =>
  `/api/soil/pdf?site=${encodeURIComponent(siteId)}&key=${encodeURIComponent(key)}${token ? `&t=${token}` : ""}`;
