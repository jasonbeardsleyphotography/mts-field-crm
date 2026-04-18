import { useState, useRef, useEffect, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Camera View
   Full-screen camera with zoom slider. Tap shutter for rapid capture.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function CameraView({ onPhoto, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const trackRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(5);
  const [zoomSupported, setZoomSupported] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        // Check zoom support
        const caps = track.getCapabilities?.() || {};
        if (caps.zoom) {
          setMinZoom(caps.zoom.min ?? 1);
          setMaxZoom(caps.zoom.max ?? 5);
          setZoom(caps.zoom.min ?? 1);
          setZoomSupported(true);
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
          setReady(true);
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

  const applyZoom = useCallback(async (val) => {
    setZoom(val);
    if (trackRef.current && zoomSupported) {
      try {
        await trackRef.current.applyConstraints({ advanced: [{ zoom: val }] });
      } catch(e) {}
    }
  }, [zoomSupported]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    onPhoto(canvas.toDataURL("image/jpeg", 0.85));
    setCount(c => c + 1);
    setFlash(true);
    setTimeout(() => setFlash(false), 100);
  }, [onPhoto]);

  const close = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onClose();
  };

  // Percentage for the zoom slider label
  const zoomPct = zoomSupported ? Math.round(((zoom - minZoom) / (maxZoom - minZoom)) * 100) : 0;

  return (
    <div style={{position:"fixed",inset:0,background:"#000",zIndex:300,display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top)"}}>
      {/* Viewfinder */}
      <div style={{flex:1,position:"relative",overflow:"hidden"}}>
        <video ref={videoRef} playsInline muted autoPlay style={{width:"100%",height:"100%",objectFit:"cover"}} />
        <canvas ref={canvasRef} style={{display:"none"}} />
        {flash && <div style={{position:"absolute",inset:0,background:"#fff",opacity:.35,pointerEvents:"none"}} />}
        {count > 0 && <div style={{position:"absolute",top:16,right:16,padding:"4px 12px",borderRadius:99,background:"rgba(51,182,121,.9)",color:"#fff",fontSize:14,fontWeight:700}}>{count} 📷</div>}

        {/* Zoom label */}
        {zoomSupported && <div style={{position:"absolute",top:16,left:16,padding:"4px 10px",borderRadius:99,background:"rgba(0,0,0,.5)",color:"#fff",fontSize:13,fontWeight:700}}>{zoom.toFixed(1)}×</div>}

        {/* Vertical zoom slider on right edge */}
        {zoomSupported && (
          <div style={{position:"absolute",right:16,top:"50%",transform:"translateY(-50%)",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            <span style={{color:"rgba(255,255,255,.6)",fontSize:10}}>+</span>
            <input
              type="range" min={minZoom} max={maxZoom} step={0.1} value={zoom}
              onChange={e => applyZoom(parseFloat(e.target.value))}
              style={{
                appearance:"slider-vertical", WebkitAppearance:"slider-vertical",
                writingMode:"vertical-lr", direction:"rtl",
                width:28, height:160,
                cursor:"pointer", accentColor:"#fff",
              }}
            />
            <span style={{color:"rgba(255,255,255,.6)",fontSize:10}}>−</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={{padding:"16px 0",paddingBottom:"max(16px,env(safe-area-inset-bottom))",background:"#000",display:"flex",alignItems:"center",justifyContent:"center",gap:40}}>
        <button onClick={close} style={{width:50,height:50,borderRadius:25,background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        <button onClick={capture} disabled={!ready} style={{width:72,height:72,borderRadius:36,background:"#fff",border:"4px solid rgba(255,255,255,.4)",cursor:ready?"pointer":"default",opacity:ready?1:.4,boxShadow:"0 0 20px rgba(255,255,255,.2)"}}>
          <div style={{width:60,height:60,borderRadius:30,border:"3px solid #000",margin:"auto"}} />
        </button>
        <div style={{width:50}} />
      </div>
    </div>
  );
}
