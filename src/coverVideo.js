/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Make a live camera <video> fill its box
   ───────────────────────────────────────────────────────────────────────────
   The viewfinders used `object-fit: cover`, which should be enough. On iPhone
   it isn't always: WebKit has drawn the camera stream at its own size, centred
   with black bars, instead of filling the screen — most often after the lens
   changes (0.5× ultrawide) or the stream's dimensions change mid-session.

   So the video element is sized to cover its parent without object-fit, in
   pure CSS: the parent is a size container, and the video is
     width  = max(100% of the box's width,  box height × stream aspect)
     height = max(100% of the box's height, box width  ÷ stream aspect)
   centred, overflow clipped. Because it's CSS, a rotation re-lays it out in
   the same frame as the rotation itself — no stale pixel size for a beat
   (that showed as the picture shrinking, then snapping, mid-rotation). Only
   the stream's aspect ratio comes from JS, and even a stale ratio still
   covers the screen.
   ═══════════════════════════════════════════════════════════════════════════ */
import { useEffect } from "react";

export function useCoverVideo(videoRef) {
  useEffect(() => {
    const v = videoRef.current;
    const box = v?.parentElement;
    if (!v || !box) return;
    box.style.containerType = "size";
    Object.assign(v.style, {
      inset: "auto", right: "auto", bottom: "auto",
      left: "50%", top: "50%", transform: "translate(-50%, -50%)",
      width: "max(100cqw, calc(100cqh * var(--ar, 0.5625)))",
      height: "max(100cqh, calc(100cqw / var(--ar, 0.5625)))",
      maxWidth: "none", maxHeight: "none",
    });
    let last = 0;
    const setAspect = () => {
      const { videoWidth: w, videoHeight: h } = v;
      if (!w || !h) return;
      const ar = w / h;
      if (Math.abs(ar - last) > 0.001) { last = ar; v.style.setProperty("--ar", ar.toFixed(5)); }
    };
    const evs = ["loadedmetadata", "resize", "playing"];
    evs.forEach(e => v.addEventListener(e, setAspect));
    // The stream rotates with the phone; some iOS versions change its size
    // without firing "resize", so check briefly after any rotation too.
    let raf = 0, until = 0;
    const burst = () => {
      until = performance.now() + 800;
      const tick = () => { setAspect(); if (performance.now() < until) raf = requestAnimationFrame(tick); };
      cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    };
    window.addEventListener("resize", burst);
    window.addEventListener("orientationchange", burst);
    const t = setInterval(setAspect, 1000);
    setAspect();
    return () => {
      evs.forEach(e => v.removeEventListener(e, setAspect));
      window.removeEventListener("resize", burst);
      window.removeEventListener("orientationchange", burst);
      cancelAnimationFrame(raf);
      clearInterval(t);
      refreshSystemEdges();
    };
  }, [videoRef]);
}

/* While a full-screen camera is up, iOS draws its own dark blur along the top
   and bottom edges of the web app (under the status bar and home indicator),
   based on what the page shows there. It doesn't always re-check after the
   camera closes, so the blur lingers over the normal app. Changing the page's
   theme colour and nudging layout makes iOS re-sample those edges. */
export function refreshSystemEdges() {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    const orig = meta?.getAttribute("content");
    if (meta) meta.setAttribute("content", "#000000");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (meta && orig) meta.setAttribute("content", orig);
      const el = document.scrollingElement || document.documentElement;
      el.scrollTop = 1; el.scrollTop = 0;
      window.dispatchEvent(new Event("resize"));
    }));
  } catch {}
}
