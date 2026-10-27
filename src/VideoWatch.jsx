import DriveVideo from "./DriveVideo";

/* ═══════════════════════════════════════════════════════════════════════════
   Standalone video player page — /watch/:fileId
   Rendered for anonymous clients who clicked a share link. No Google auth,
   no app shell — just a page that loads and plays the video immediately.
   Bytes come from the video-stream edge function (Range-aware Drive proxy),
   not Drive's iframe player, which is what produced "No preview available".
   ═══════════════════════════════════════════════════════════════════════════ */
export default function VideoWatch({ fileId, title }) {

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
        <DriveVideo fileId={fileId} autoPlay frameHeight="75dvh"
          style={{ width: "100%", maxHeight: "80dvh", borderRadius: 10 }} />
        <a href={`https://drive.google.com/file/d/${fileId}/view`} target="_blank" rel="noopener noreferrer"
          style={{ display: "block", textAlign: "center", marginTop: 12, color: "#8aa0c0", fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
          Trouble playing? Open in Google Drive
        </a>
      </div>
    </div>
  );
}
