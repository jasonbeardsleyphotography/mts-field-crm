/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Account gate
   ───────────────────────────────────────────────────────────────────────────
   Nothing is written to Google Drive or Contacts until the app has confirmed
   WHICH Google account is signed in on this device.

   Why: the sync routines all start the moment a sign-in token appears, while
   the "is this the same account as last time?" check is a network call that
   finishes a moment later. On a phone switching accounts, that gap was enough
   for the previous person's queued photos, notes and pipeline to be written
   into the NEW person's Drive. Drive and Contacts writers now wait here; App
   opens the gate once the account is confirmed as the expected one.
   ═══════════════════════════════════════════════════════════════════════════ */

let open = false;
const waiters = [];

export function waitForAccount() {
  return open ? Promise.resolve() : new Promise(r => waiters.push(r));
}

export function openAccountGate() {
  open = true;
  waiters.splice(0).forEach(r => r());
}

export function isAccountGateOpen() { return open; }

/** A token for a possibly different account arrived mid-session: hold writes
 *  again until App re-confirms the account. */
export function closeAccountGate() { open = false; }
