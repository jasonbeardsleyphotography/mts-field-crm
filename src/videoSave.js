/* Save a queued/failed/local video out of the app onto the device. On iOS
   this opens the share sheet (Save Video → Photos, or Save to Files);
   elsewhere it falls back to a direct download. Works even if the upload
   never succeeds, so a recorded video is never trapped in the app. Prefers
   the in-hand blob so the share call stays inside the tap gesture (iOS
   requirement). Shared by OnsiteWindow, VideoUploads, and StoragePanel. */

import { getVideoFile, fileFromQueueItem, peekLiveVideoFile } from "./videoQueue";

export async function saveVideoToDevice(item) {
  try {
    // Prefer the in-memory copy: it's readable even when iOS has evicted the
    // IDB bytes, and it's synchronous so navigator.share stays inside the tap
    // gesture. Fall back to the IDB blob, then to the async lookup.
    let file = (item?.id && peekLiveVideoFile(item.id)) || null;
    if (!file) file = item?.file ? fileFromQueueItem(item) : null;
    if (!file) file = await getVideoFile(item.id);
    if (!file) { alert("This video's file couldn't be found in storage."); return; }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file] }).catch(e => {
        if (e && e.name !== "AbortError") console.warn("share failed", e);
      });
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name || "video.mp4";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) {
    alert("Couldn't save the video: " + (e?.message || e));
  }
}
