/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Google Places Autocomplete
   ───────────────────────────────────────────────────────────────────────────
   Powers the address suggestions in the appointment-create form. Uses the
   "Places API (New)" REST endpoint, which supports CORS from a browser
   without a proxy. Requires a Google Maps API key set as an environment
   variable VITE_GOOGLE_MAPS_API_KEY at build time. If the key is missing,
   suggest() returns [] so the input still works, just without typeahead.

   Cost discipline:
   - Calls are debounced 200 ms before firing — typing "1234 main street"
     should produce ~3 calls, not 17.
   - Locality biased to the user's home turf (Rochester / Finger Lakes)
     via `locationBias.circle`. Reduces noise from other "Main St"s.
   - Session tokens are tracked per autocomplete session (one continuous
     typing-then-select interaction). Google bills the autocomplete + the
     follow-up details fetch as a single transaction when a session token
     is reused, which cuts cost roughly in half.

   The user's text input remains the source of truth — autocomplete only
   suggests, it never overwrites what they've already typed unless they
   tap a suggestion.
   ═══════════════════════════════════════════════════════════════════════════ */

const API_BASE = "https://places.googleapis.com/v1/places:autocomplete";
const KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_GOOGLE_MAPS_API_KEY) || "";

// Approximate center for biasing — Rochester, NY. ~80 km radius covers the
// Finger Lakes service area without being so wide we get matches from
// out-of-state. Tune this if Jason later expands service area.
const BIAS_CENTER = { latitude: 43.1566, longitude: -77.6088 };
const BIAS_RADIUS_M = 80_000;

// Session tokens — Google's docs ask for a UUID-ish string per session.
// We don't need cryptographic randomness here.
let _sessionToken = null;
function getSessionToken() {
  if (!_sessionToken) {
    _sessionToken = "mts_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return _sessionToken;
}
export function endAutocompleteSession() {
  // Call this after a place is selected (or the dialog closes) so the next
  // typing session starts a fresh billing transaction.
  _sessionToken = null;
}

/**
 * Suggest addresses matching the input string.
 * @param {string} input
 * @returns {Promise<Array<{ description: string, placeId: string, mainText: string, secondaryText: string }>>}
 */
export async function suggestAddresses(input) {
  if (!KEY || !input || input.trim().length < 3) return [];
  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        // Limit response size — only fields we render in the dropdown.
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({
        input,
        locationBias: { circle: { center: BIAS_CENTER, radius: BIAS_RADIUS_M } },
        sessionToken: getSessionToken(),
        // Only return ADDRESSES — not establishments, regions, or POIs.
        // The user is typing a job site address, not a business name.
        includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
        // Restrict to US — we don't service international.
        includedRegionCodes: ["us"],
      }),
    });
    if (!res.ok) {
      console.warn("[Places] autocomplete failed:", res.status, await res.text().catch(()=>""));
      return [];
    }
    const data = await res.json();
    return (data.suggestions || [])
      .map(s => s.placePrediction)
      .filter(Boolean)
      .map(p => ({
        description: p.text?.text || "",
        placeId: p.placeId,
        mainText: p.structuredFormat?.mainText?.text || p.text?.text || "",
        secondaryText: p.structuredFormat?.secondaryText?.text || "",
      }));
  } catch (e) {
    console.warn("[Places] autocomplete error:", e);
    return [];
  }
}

// ── A tiny debounce for use inside a React component without bringing
// in a library. Keep one timer reference across renders.
export function makeDebouncedSuggester(delayMs = 200) {
  let timer = null;
  let lastInput = "";
  return (input, cb) => {
    lastInput = input;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const results = await suggestAddresses(input);
      // Stale-call guard: if the user has typed more characters since this
      // call was scheduled, don't deliver results that don't match what
      // they're now seeing. Avoids the "old results flicker after I
      // backspaced" bug.
      if (input === lastInput) cb(results);
    }, delayMs);
  };
}

export function isPlacesConfigured() {
  return !!KEY;
}
