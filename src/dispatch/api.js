/* Dispatch ↔ server. Every call carries the session cookie (same site). */

export class ApiError extends Error {
  constructor(status, code) { super(code || `error ${status}`); this.status = status; this.code = code; }
}

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`/api/dispatch/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new ApiError(r.status, data?.error);
  return data;
}

export const APP_LABELS = {
  field: "Field app",
  dispatch: "Dispatch (backlog & schedule)",
  shop: "Shop Board",
  soil: "Soil",
  admin: "Admin",
};
