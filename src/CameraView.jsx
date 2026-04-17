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

  // Capture
  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
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
      </div>

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
