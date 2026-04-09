import { useState, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   MTS — Swipe Card
   Touch-swipeable card wrapper. Right = Done, Left = Navigate.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function SwipeCard({ children, onSwipeRight, onSwipeLeft, enabled }) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const sx = useRef(0), sy = useRef(0), dir = useRef(null);

  const ts = e => { if(!enabled)return; sx.current=e.touches[0].clientX; sy.current=e.touches[0].clientY; dir.current=null; setSwiping(true); };
  const tm = e => { if(!swiping||!enabled)return; const dx=e.touches[0].clientX-sx.current, dy=e.touches[0].clientY-sy.current;
    if(dir.current===null&&(Math.abs(dx)>8||Math.abs(dy)>8)) dir.current=Math.abs(dx)>Math.abs(dy)?"h":"v";
    if(dir.current==="h"){e.preventDefault();e.stopPropagation();setOffset(dx);}
  };
  const te = () => { if(offset>100&&onSwipeRight)onSwipeRight(); else if(offset<-100&&onSwipeLeft)onSwipeLeft(); setOffset(0);setSwiping(false);dir.current=null; };

  const abs = Math.abs(offset), reveal = Math.min(abs/80,1), opacity = 1-Math.min(abs/250,.5), right = offset>0;

  return <div style={{position:"relative",overflow:"hidden"}}>
    {abs>20 && <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:right?"flex-start":"flex-end",justifyContent:"center",padding:"0 20px",opacity:reveal,background:right?"rgba(51,182,121,.1)":"rgba(3,155,229,.1)"}}>
      <div style={{fontSize:20,fontWeight:800,color:right?"#33B679":"#039BE5"}}>{right?"✓":"🧭"}</div>
      <div style={{fontSize:12,fontWeight:700,color:right?"#33B679":"#039BE5",marginTop:2}}>{right?"Done":"Navigate"}</div>
    </div>}
    <div onTouchStart={ts} onTouchMove={tm} onTouchEnd={te}
      style={{transform:`translateX(${offset}px)`,opacity,transition:swiping?"none":"transform .25s,opacity .25s",position:"relative",zIndex:1,touchAction:"pan-y"}}>
      {children}
    </div>
  </div>;
}
