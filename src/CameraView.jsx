import { useState, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Camera View
   Full-screen inline camera using getUserMedia. Tap shutter to capture,
   photos save instantly, camera stays open for rapid-fire shooting.
   Tap ✕ to close. Much faster than iOS file picker.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function CameraView({ onPhoto, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: 0.1 });
  const [zoomSupported, setZoomSupported] = useState(false);

  // Start camera
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          setReady(true);
        }

        // Detect zoom support via MediaStreamTrack capabilities
        const track = stream.getVideoTracks()[0];
        if (track) {
          const caps = track.getCapabilities?.();
          if (caps?.zoom) {
            setZoomRange({
              min: caps.zoom.min ?? 1,
              max: caps.zoom.max ?? 1,
              step: caps.zoom.step ?? 0.1,
            });
            setZoomSupported(true);
          }
        }
      } catch(e) {
        console.warn("Camera failed:", e);
        onClose();
      }
    })();
    return () => {
      dead = true;
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Apply zoom via MediaStreamTrack constraints
  const applyZoom = useCallback(async (val) => {
    setZoom(val);
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && zoomSupported) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: val }] });
      } catch(e) {
        console.warn("Zoom constraint failed:", e);
      }
    }
  }, [zoomSupported]);

  // Capture — MAX 2400, quality 0.82
  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const MAX = 2400;
    let w = video.videoWidth, h = video.videoHeight;
    if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
    if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    onPhoto(dataUrl);
    setCount(c => c + 1);
    // Flash effect
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
  }, [onPhoto]);

  const close = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onClose();
  };

  return (
    <div style={{position:"fixed",inset:0,background:"#000",zIndex:300,display:"flex",flexDirection:"column"}}>
      {/* Viewfinder */}
      <div style={{flex:1,position:"relative",overflow:"hidden"}}>
        <video ref={videoRef} playsInline muted autoPlay
          style={{width:"100%",height:"100%",objectFit:"cover"}} />
        <canvas ref={canvasRef} style={{display:"none"}} />

        {/* Flash overlay */}
        {flash && <div style={{position:"absolute",inset:0,background:"#fff",opacity:.4,transition:"opacity .1s",pointerEvents:"none"}} />}

        {/* Count badge */}
        {count > 0 && <div style={{position:"absolute",top:16,right:16,padding:"4px 12px",borderRadius:99,background:"rgba(51,182,121,.9)",color:"#fff",fontSize:14,fontWeight:700}}>
          {count} 📷
        </div>}

        {/* Zoom level overlay */}
        {zoomSupported && zoom !== 1 && (
          <div style={{position:"absolute",top:16,left:16,padding:"4px 10px",borderRadius:99,background:"rgba(0,0,0,.55)",color:"#fff",fontSize:13,fontWeight:700,letterSpacing:0.5}}>
            {zoom.toFixed(1)}×
          </div>
        )}
      </div>

      {/* Zoom slider — only rendered when hardware zoom is available */}
      {zoomSupported && (
        <div style={{background:"#000",padding:"8px 24px 4px",display:"flex",alignItems:"center",gap:12}}>
          <span style={{color:"rgba(255,255,255,.4)",fontSize:11,fontWeight:600,minWidth:16}}>1×</span>
          <input
            type="range"
            min={zoomRange.min}
            max={zoomRange.max}
            step={zoomRange.step}
            value={zoom}
            onChange={e => applyZoom(parseFloat(e.target.value))}
            style={{flex:1,accentColor:"#fff",height:4,cursor:"pointer"}}
          />
          <span style={{color:"rgba(255,255,255,.4)",fontSize:11,fontWeight:600,minWidth:28}}>{zoomRange.max.toFixed(0)}×</span>
        </div>
      )}

      {/* Controls */}
      <div style={{padding:"16px 0",paddingBottom:"max(16px, env(safe-area-inset-bottom))",background:"#000",display:"flex",alignItems:"center",justifyContent:"center",gap:40}}>
        {/* Close */}
        <button onClick={close} style={{width:50,height:50,borderRadius:25,background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        {/* Shutter */}
        <button onClick={capture} disabled={!ready} style={{width:72,height:72,borderRadius:36,background:"#fff",border:"4px solid rgba(255,255,255,.4)",cursor:ready?"pointer":"default",opacity:ready?1:.4,transition:"transform .1s",boxShadow:"0 0 20px rgba(255,255,255,.2)"}}>
          <div style={{width:60,height:60,borderRadius:30,border:"3px solid #000",margin:"auto"}} />
        </button>

        {/* Spacer */}
        <div style={{width:50}} />
      </div>
    </div>
  );
}
