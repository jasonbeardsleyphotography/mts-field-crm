import { useState } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   Standalone video player page — /watch/:fileId
   Rendered for anonymous clients who clicked a share link. No Google auth,
   no app shell — just a page that loads and plays the video immediately.
   Bytes come from the video-stream edge function (Range-aware Drive proxy),
   not Drive's iframe player, which is what produced "No preview available".
   ═══════════════════════════════════════════════════════════════════════════ */
export default function VideoWatch({ fileId, title }) {
  const [failed, setFailed] = useState(false);
  const streamUrl = `/api/video-stream?id=${fileId}`;

  return (
    <div style={{
      minHeight: "100dvh", background: "#0a0b10", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: 16, boxSizing: "border-box",
    }}>
      <div style={{ width: "100%", maxWidth: 720 }}>
        {title && (
          <div style={{
            color: "#cdd6e6", fontFamily: "system-ui, sans-serif", fontSize: 15,
            fontWeight: 600, marginBottom: 10, textAlign: "center",
          }}>{title}</div>
        )}
        {!failed ? (
          <video
            controls
            autoPlay
            playsInline
            preload="metadata"
            src={streamUrl}
            onError={() => setFailed(true)}
            style={{ width: "100%", maxHeight: "80dvh", borderRadius: 10, background: "#000" }}
          />
        ) : (
          <div style={{
            color: "#a0b0c0", fontFamily: "system-ui, sans-serif", fontSize: 14,
            textAlign: "center", padding: 30, border: "1px solid #1a2540",
            borderRadius: 10, background: "#0e1120",
          }}>
            This video couldn't load. The link may be invalid, or the video may have been removed.
          </div>
        )}
      </div>
    </div>
  );
}
