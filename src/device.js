/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Is this a phone?
   ───────────────────────────────────────────────────────────────────────────
   True on a phone or tablet: its PRIMARY pointer is a finger ("coarse"). A
   laptop or Chromebook — even one with a touchscreen — reports its trackpad or
   mouse as the primary pointer, so it counts as a computer. Used to keep
   phone-only steps (the RealWork hand-off and its iPhone Shortcuts) off the
   desktop.
   ═══════════════════════════════════════════════════════════════════════════ */
export function isPhoneLike() {
  try { return !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches; }
  catch { return false; }
}
