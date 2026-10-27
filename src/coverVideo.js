/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Make a live camera <video> fill its box
   ───────────────────────────────────────────────────────────────────────────
   The viewfinders used `object-fit: cover`, which should be enough. On iPhone
   it isn't always: WebKit has drawn the camera stream at its own size, centred
   with black bars, instead of filling the screen.

   So the video element is given an explicit pixel size: the stream's aspect
   ratio, scaled up until it covers its parent, centred, the overflow clipped
   by the parent. It is re-measured ONLY when something actually changes size
   — the stream (the video's own "resize" event, e.g. a lens switch or
   rotation) or the screen. An earlier version also polled every second and
   used CSS container units with a transform; that was continuous work while
   the camera was open and the camera got sluggish, so it's gone.
   ═══════════════════════════════════════════════════════════════════════════ */
import { useEffect } from "react";

export function useCoverVideo(videoRef) {
  useEffect(() => {
    const v = videoRef.current;
    const box = v?.parentElement;
    if (!v || !box) return;
    let last = "";
    const fit = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      const cw = box.clientWidth, ch = box.clientHeight;
      if (!vw || !vh || !cw || !ch) return;
      const k = Math.max(cw / vw, ch / vh);
      const w = Math.ceil(vw * k), h = Math.ceil(vh * k);
      const l = Math.round((cw - w) / 2), t = Math.round((ch - h) / 2);
      const sig = `${w}x${h}@${l},${t}`;
      if (sig === last) return;          // nothing changed — touch nothing
      last = sig;
      Object.assign(v.style, {
        inset: "auto", right: "auto", bottom: "auto",
        width: w + "px", height: h + "px", left: l + "px", top: t + "px",
        maxWidth: "none", maxHeight: "none",
      });
    };
    // After a rotation the screen size changes first and the stream follows a
    // moment later; two delayed re-checks cover that without a timer running.
    const onScreen = () => { fit(); setTimeout(fit, 250); setTimeout(fit, 700); };
    const evs = ["loadedmetadata", "resize"];
    evs.forEach(e => v.addEventListener(e, fit));
    window.addEventListener("resize", onScreen);
    window.addEventListener("orientationchange", onScreen);
    fit();
    return () => {
      evs.forEach(e => v.removeEventListener(e, fit));
      window.removeEventListener("resize", onScreen);
      window.removeEventListener("orientationchange", onScreen);
      refreshSystemEdges();
    };
  }, [videoRef]);
}

/* While a full-screen camera is up, iOS draws its own dark blur along the top
   and bottom edges of the web app. It doesn't always re-check after the
   camera closes, so the blur lingers over the normal app. Changing the page's
   theme colour and nudging layout makes iOS re-sample those edges. */
export function refreshSystemEdges() {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    const orig = meta?.getAttribute("content");
    if (meta) meta.setAttribute("content", "#000000");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (meta && orig) meta.setAttribute("content", orig);
    }));
  } catch {}
}
