/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Make a live camera <video> fill its box
   ───────────────────────────────────────────────────────────────────────────
   The viewfinders used `object-fit: cover`, which should be enough. On iPhone
   it isn't always: WebKit has drawn the camera stream at its own size, centred
   with black bars, instead of filling the screen — most often after the lens
   changes (0.5× ultrawide) or the stream's dimensions change mid-session.

   So the video element is sized explicitly instead: the same aspect ratio as
   the stream, scaled up until it covers its parent, centred, the overflow
   clipped by the parent. Nothing is left to object-fit. Re-measured whenever
   the stream or the screen changes size.
   ═══════════════════════════════════════════════════════════════════════════ */
import { useEffect } from "react";

export function useCoverVideo(videoRef) {
  useEffect(() => {
    const v = videoRef.current;
    const box = v?.parentElement;
    if (!v || !box) return;
    const fit = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      const cw = box.clientWidth, ch = box.clientHeight;
      if (!vw || !vh || !cw || !ch) return;
      const k = Math.max(cw / vw, ch / vh);
      const w = Math.ceil(vw * k), h = Math.ceil(vh * k);
      Object.assign(v.style, {
        inset: "auto", right: "auto", bottom: "auto",
        width: w + "px", height: h + "px",
        left: Math.round((cw - w) / 2) + "px", top: Math.round((ch - h) / 2) + "px",
        maxWidth: "none", maxHeight: "none",
      });
    };
    const evs = ["loadedmetadata", "resize", "playing"];
    evs.forEach(e => v.addEventListener(e, fit));
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(box);
    // The stream's size can change without an event on some iOS versions
    // (switching lens via zoom); a light poll catches it.
    const t = setInterval(fit, 700);
    fit();
    return () => {
      evs.forEach(e => v.removeEventListener(e, fit));
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
      ro?.disconnect();
      clearInterval(t);
    };
  }, [videoRef]);
}
