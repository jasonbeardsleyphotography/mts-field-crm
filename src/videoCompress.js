/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Video Compression
   ───────────────────────────────────────────────────────────────────────────
   Re-encodes a user-picked video to 720p H.264 ~2 Mbps + AAC audio. The
   target output is "looks great on a phone, fine to share with customers,
   ~25–35 MB for a 2-minute clip" regardless of whether iOS handed us a
   500 MB 4K HEVC original or a 58 MB pre-compressed file.

   ffmpeg.wasm is loaded lazily — the first call pulls ~30 MB of WASM from
   a CDN. That blob is then cached by the browser (and our service worker)
   so subsequent calls are instant. We do NOT bundle it into the main app
   build because that would make the initial page load brutal on cellular.

   If load or transcode fails for ANY reason (older iOS, no SharedArrayBuffer
   headers, out-of-memory), we fall through and return the original file
   unchanged. The queue will still upload it — just slower. Compression is
   an optimization, not a correctness requirement.
   ═══════════════════════════════════════════════════════════════════════════ */

// Compression target — H.264 baseline, 720p, ~2 Mbps video, 128k AAC audio.
// CRF 28 + maxrate 2M produces customer-shareable quality at a fraction of
// the size. iOS Safari decodes H.264 hardware-accelerated for playback.
const TARGET = {
  videoCodec: "libx264",
  preset: "ultrafast",        // ffmpeg.wasm is ~5x slower than native ffmpeg, so prefer fast over small
  crf: "28",
  maxrate: "2M",
  bufsize: "4M",
  scale: "scale='min(1280,iw)':'-2'", // cap long-edge at 1280px, keep aspect, even pixel count
  audioCodec: "aac",
  audioBitrate: "128k",
};

// ffmpeg.wasm singleton — loaded once on first compress() call
let _ffmpegPromise = null;

async function loadFFmpeg() {
  if (_ffmpegPromise) return _ffmpegPromise;

  _ffmpegPromise = (async () => {
    // Dynamic import keeps ffmpeg.wasm out of the main bundle entirely.
    // The user only pays the ~30 MB download the first time they upload
    // a video; after that it sits in the browser's HTTP cache.
    const { FFmpeg } = await import("https://esm.sh/@ffmpeg/ffmpeg@0.12.10");
    const { fetchFile, toBlobURL } = await import("https://esm.sh/@ffmpeg/util@0.12.1");

    const ffmpeg = new FFmpeg();
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

    // ffmpeg.wasm requires SharedArrayBuffer for multi-threaded core.
    // The single-threaded core works without cross-origin isolation
    // headers, which is the only realistic option for a Netlify-hosted
    // PWA without custom headers. It's slower but it works everywhere.
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });

    return { ffmpeg, fetchFile };
  })();

  // If load fails, clear the promise so the next call retries instead of
  // permanently returning the rejected promise.
  _ffmpegPromise.catch(() => { _ffmpegPromise = null; });

  return _ffmpegPromise;
}

/**
 * Compress a video file to 720p H.264 ~2 Mbps.
 * @param {File|Blob} file - input video
 * @param {(percent: number) => void} [onProgress] - 0–100 progress callback
 * @returns {Promise<{blob: Blob, originalSize: number, compressedSize: number, skipped: boolean, reason?: string}>}
 *   On compression failure, returns {blob: file, skipped: true, reason}.
 */
export async function compressVideo(file, onProgress) {
  const originalSize = file.size;

  // Skip compression for tiny files — already small enough that the
  // ~45 sec compression overhead isn't worth it. Threshold: 20 MB.
  // (Compressing a 15 MB clip to 12 MB saves 30 sec of upload time but
  //  costs 45 sec of compression time. Net loss.)
  if (originalSize < 20 * 1024 * 1024) {
    return { blob: file, originalSize, compressedSize: originalSize, skipped: true, reason: "under-threshold" };
  }

  let ffmpeg, fetchFile;
  try {
    ({ ffmpeg, fetchFile } = await loadFFmpeg());
  } catch (e) {
    console.warn("ffmpeg load failed — uploading original:", e);
    return { blob: file, originalSize, compressedSize: originalSize, skipped: true, reason: "ffmpeg-load-failed" };
  }

  const inputName = "in." + ((file.name || "").split(".").pop().toLowerCase() || "mov");
  const outputName = "out.mp4";

  // Wire up progress reporting before kicking off the transcode.
  // ffmpeg.wasm's progress event fires with {progress, time} where progress
  // is 0–1 of the input duration processed.
  let progressHandler = null;
  if (onProgress) {
    progressHandler = ({ progress }) => {
      const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
      onProgress(pct);
    };
    ffmpeg.on("progress", progressHandler);
  }

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // The argument order matters: input flags before -i, output flags
    // after. -movflags +faststart relocates the moov atom to the start
    // of the file so YouTube can begin processing without the full upload
    // (and so the file streams nicely on mobile if shared directly).
    await ffmpeg.exec([
      "-i", inputName,
      "-vf", TARGET.scale,
      "-c:v", TARGET.videoCodec,
      "-preset", TARGET.preset,
      "-crf", TARGET.crf,
      "-maxrate", TARGET.maxrate,
      "-bufsize", TARGET.bufsize,
      "-c:a", TARGET.audioCodec,
      "-b:a", TARGET.audioBitrate,
      "-movflags", "+faststart",
      "-y", outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    // data is a Uint8Array — wrap as a Blob with the right MIME type
    const blob = new Blob([data.buffer], { type: "video/mp4" });

    // Clean up the virtual filesystem so successive runs don't accumulate
    // memory. ffmpeg.wasm is single-threaded but its WASM heap persists.
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}

    return {
      blob,
      originalSize,
      compressedSize: blob.size,
      skipped: false,
    };
  } catch (e) {
    console.warn("ffmpeg transcode failed — uploading original:", e);
    return { blob: file, originalSize, compressedSize: originalSize, skipped: true, reason: "transcode-failed" };
  } finally {
    if (progressHandler) {
      try { ffmpeg.off("progress", progressHandler); } catch {}
    }
  }
}
