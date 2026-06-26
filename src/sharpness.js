/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Sharpness Scoring
   Cheap blur-detection heuristic (Laplacian variance) used by CameraView's
   burst capture to pick the sharpest of a few quick frames, since the web
   platform exposes no real focus-lock/focus-detection API on iOS Safari.
   ═══════════════════════════════════════════════════════════════════════════ */

// Returns a numeric sharpness score (Laplacian variance). Higher = sharper.
// Throws on failure — caller must catch.
export function scoreSharpness(source, targetWidth = 400) {
  const srcW = source.width, srcH = source.height;
  const w = Math.min(targetWidth, srcW);
  const h = Math.round(srcH * (w / srcW));

  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d");
  ctx.drawImage(source, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap =
        gray[idx - w] + gray[idx + w] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}
