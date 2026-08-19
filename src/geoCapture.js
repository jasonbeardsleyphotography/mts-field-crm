/* ═══════════════════════════════════════════════════════════════════════════
   MTS — GPS Capture
   ───────────────────────────────────────────────────────────────────────────
   Keeps a WARM location fix while an on-site card is open so that stamping a
   photo (or dropping a pin) is effectively instant instead of waiting several
   seconds for a cold GPS lock at the moment of the tap.

   A cold `getCurrentPosition` on a phone can take 2–10s — far too slow to sit
   between the shutter and the saved photo. A background `watchPosition` keeps
   a recent fix on hand, so capture just reads the last known value.

   Every fix carries its `acc` (accuracy radius in metres) so the UI can be
   honest about how much to trust a point — under tree canopy this is often
   10m+, which matters a lot when the points represent individual trees.
   ═══════════════════════════════════════════════════════════════════════════ */

let _last = null;      // { lat, lng, acc, ts }
let _watchId = null;
let _warmCount = 0;    // ref-count so nested screens don't kill each other's watch

function _store(pos) {
  _last = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    acc: Math.round(pos.coords.accuracy || 0),
    ts: Date.now(),
  };
}

/** Begin keeping a warm fix. Call on mount; pair with stopGeoWarm on unmount. */
export function startGeoWarm() {
  _warmCount++;
  if (_watchId != null || !("geolocation" in navigator)) return;
  try {
    _watchId = navigator.geolocation.watchPosition(
      _store,
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  } catch { /* permission denied / unsupported — capture falls back to one-shot */ }
}

/** Release one warm-hold. The watch stops once nothing holds it. */
export function stopGeoWarm() {
  _warmCount = Math.max(0, _warmCount - 1);
  if (_warmCount === 0 && _watchId != null) {
    try { navigator.geolocation.clearWatch(_watchId); } catch {}
    _watchId = null;
  }
}

/** Last known fix if it's still fresh enough, else null. Synchronous. */
export function peekGeo(maxAgeMs = 60_000) {
  if (!_last) return null;
  return (Date.now() - _last.ts) <= maxAgeMs ? { ..._last } : null;
}

/**
 * Best available fix. Returns the warm one when fresh (instant), otherwise
 * asks for a one-shot fix. Resolves null rather than throwing so callers can
 * simply skip geotagging when location isn't available — a photo without
 * coordinates must never fail to save.
 */
export function getCurrentGeo({ maxAgeMs = 20_000, timeout = 8000 } = {}) {
  const warm = peekGeo(maxAgeMs);
  if (warm) return Promise.resolve(warm);
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Hard cap: never let a slow lock hang the capture flow.
    setTimeout(() => done(peekGeo(120_000)), timeout + 250);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => { _store(pos); done({ ..._last }); },
        () => done(peekGeo(120_000)),
        { enableHighAccuracy: true, timeout, maximumAge: maxAgeMs }
      );
    } catch { done(null); }
  });
}
