/* Save a queued/failed/local video out of the app onto the device. On iOS
   this opens the share sheet (Save Video → Photos, or Save to Files);
   elsewhere it falls back to a direct download. Works even if the upload
   never succeeds, so a recorded video is never trapped in the app. Prefers
   the in-hand blob so the share call stays inside the tap gesture (iOS
   requirement). Shared by OnsiteWindow, VideoUploads, and StoragePanel. */

import { getVideoFile, fileFromQueueItem, peekLiveVideoFile } from "./videoQueue";

// Returns true if the save/share flow completed (a durable copy was made),
// false if it couldn't run or the user dismissed it — so callers can mark the
// video as backed-up only when it actually is.
export async function saveVideoToDevice(item) {
  try {
    // Prefer the in-memory copy: it's readable even when iOS has evicted the
    // IDB bytes, and it's synchronous so navigator.share stays inside the tap
    // gesture. Fall back to the IDB blob, then to the async lookup.
    let file = (item?.id && peekLiveVideoFile(item.id)) || null;
    if (!file) file = item?.file ? fileFromQueueItem(item) : null;
    // Bounded wait: a wedged IndexedDB connection (e.g. right after the app
    // was under enough memory pressure to go blank/reload) can otherwise
    // leave this awaiting forever with the button showing no feedback at
    // all, reading to the user as "not responding." 10s is well past the
    // internal IDB retry budget (~2s) so this only ever fires on a genuine
    // hang, not a slow-but-working read.
    if (!file) {
      file = await Promise.race([
        getVideoFile(item.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
      ]).catch(() => null);
    }
    if (!file) { alert("This video's file couldn't be found in storage."); return false; }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true; // share sheet completed (user picked Save Video / a target)
      } catch (e) {
        if (e && e.name !== "AbortError") console.warn("share failed", e);
        return false; // user dismissed, or share failed — not confirmed saved
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name || "video.mp4";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch (e) {
    alert("Couldn't save the video: " + (e?.message || e));
    return false;
  }
}
