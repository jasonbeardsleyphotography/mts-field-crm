import { useState } from "react";
import { buildStreamUrl } from "./driveUpload";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Play a video stored in Drive, with a fallback
   ───────────────────────────────────────────────────────────────────────────
   First choice is the app's own stream (raw bytes, instant start). If the
   browser can't play those bytes — iPhones fail on some WebM recordings
   (first frame shows, then "couldn't load"), and a stream can drop mid-way —
   switch to Google Drive's own player, which plays Drive's converted copy of
   the video on any device.
   ═══════════════════════════════════════════════════════════════════════════ */
export default function DriveVideo({ fileId, style, frameHeight = 240, autoPlay = false }) {
  const [fallback, setFallback] = useState(false);
  if (fallback) {
    return (
      <iframe
        src={`https://drive.google.com/file/d/${fileId}/preview`}
        title="Video"
        allow="autoplay; fullscreen"
        allowFullScreen
        style={{ border: 0, background: "#000", display: "block", ...style, height: frameHeight }}
      />
    );
  }
  return (
    <video
      controls
      playsInline
      autoPlay={autoPlay}
      preload="metadata"
      src={buildStreamUrl(fileId)}
      onError={() => setFallback(true)}
      style={{ background: "#000", display: "block", ...style }}
    />
  );
}
