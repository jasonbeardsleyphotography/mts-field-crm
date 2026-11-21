/* Soil look: light and high-contrast so it reads outdoors in sun; big tap
   targets (44px+) for gloved/wet fingers. */
export const CSS = `
.soil, .soil * { box-sizing: border-box; }
.soil { font-family:'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif; color:#14201a; background:#f4f1ea; font-size:15px; -webkit-font-smoothing:antialiased; }
.soil button, .soil input, .soil select { font:inherit; color:inherit; }
.soil a { color:#1b5e20; }
.mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
.t-h { font-family:'Barlow Condensed','Arial Narrow',sans-serif; font-weight:700; font-size:20px; letter-spacing:.02em; line-height:1.15; }
.t-sub { font-size:13px; color:#4a5a50; line-height:1.45; }
.lbl { font-family:'Barlow Condensed',sans-serif; font-weight:700; text-transform:uppercase; letter-spacing:.1em; font-size:12.5px; color:#3c4b42; margin:4px 0 8px; }
.err { color:#b3261e; font-size:13.5px; padding:8px 14px; }
.gate { max-width:460px; margin:14vh auto; padding:24px; }
.pad { padding:14px; }
.card { background:#fff; border:1px solid #d9d3c4; border-radius:10px; }
.inp { width:100%; padding:11px 12px; border:1px solid #b9b2a2; border-radius:8px; background:#fff; font-size:15px; }
.fld { display:grid; gap:4px; font-size:13px; color:#3c4b42; margin-bottom:10px; }
.fld select { padding:11px; border:1px solid #b9b2a2; border-radius:8px; background:#fff; }
.fld-row { display:flex; align-items:center; gap:10px; margin:10px 0 4px; font-size:14px; min-height:40px; }
.fld-row input[type=checkbox] { width:22px; height:22px; }
.b-main, .b-sec { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 16px; border-radius:10px; font-weight:600; font-size:14.5px; cursor:pointer; text-decoration:none; }
.b-main { background:#1b5e20; color:#fff !important; border:1px solid #1b5e20; }
.b-sec { background:#fff; color:#14201a !important; border:1px solid #b9b2a2; }
.b-main[disabled], .b-sec[disabled] { opacity:.5; }
.b-icon { width:44px; height:44px; border-radius:22px; border:1px solid #b9b2a2; background:#fff; font-size:20px; cursor:pointer; flex-shrink:0; }

.sp { height:100vh; height:100dvh; display:flex; flex-direction:column; }
.sp-hd { display:flex; align-items:center; gap:10px; padding:max(10px, env(safe-area-inset-top)) 14px 10px; background:#fff; border-bottom:1px solid #d9d3c4; flex-shrink:0; }
.brand-mini { font-family:'Barlow Condensed',sans-serif; font-weight:700; font-size:12px; line-height:1.15; text-align:right; color:#1b5e20; text-transform:uppercase; letter-spacing:.06em; }
.sp-hd .t-sub { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
@media (max-width:820px) { .sp-hd .t-h { font-size:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .brand-mini { font-size:9.5px; } .sp-hd { padding-top:max(8px, env(safe-area-inset-top)); padding-bottom:8px; } }
.sp-body { flex:1; display:flex; min-height:0; }
.sp-map { flex:1; position:relative; min-width:0; }
.sp-side { width:390px; flex-shrink:0; overflow-y:auto; background:#faf8f3; border-left:1px solid #d9d3c4; order:-1; border-right:1px solid #d9d3c4; padding-bottom:env(safe-area-inset-bottom); }
@media (max-width:820px) {
  .sp-body { flex-direction:column; }
  .sp-map { flex:none; height:56vh; height:56dvh; }
  .sp-side { width:auto; order:0; border:0; border-top:1px solid #d9d3c4; flex:1; }
}
.sp-tabs { display:flex; position:sticky; top:0; z-index:5; background:#faf8f3; border-bottom:1px solid #d9d3c4; overflow-x:auto; }
.sp-tabs button { flex:1; min-height:46px; padding:0 12px; border:0; background:none; font-weight:600; font-size:14px; color:#4a5a50; border-bottom:3px solid transparent; cursor:pointer; white-space:nowrap; }
.sp-tabs button[aria-selected=true] { color:#14201a; border-bottom-color:#1b5e20; }
.seg { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
.seg button { min-height:42px; padding:0 13px; border-radius:21px; border:1px solid #b9b2a2; background:#fff; cursor:pointer; font-size:14px; }
.seg button[aria-pressed=true] { background:#1b5e20; color:#fff; border-color:#1b5e20; }
.srow { display:flex; align-items:center; gap:10px; min-height:44px; border-bottom:1px solid #ebe6da; font-size:14px; }
.srow input[type=checkbox] { width:22px; height:22px; flex-shrink:0; }
.srow-n { flex:1; text-align:left; background:none; border:0; padding:8px 0; cursor:pointer; min-width:0; }
.srow-v { font-weight:600; }
.scard { display:block; width:100%; text-align:left; background:#fff; border:1px solid #d9d3c4; border-radius:10px; padding:11px 12px; margin-bottom:8px; cursor:pointer; }
.scard-t { font-size:14.5px; }
.scard-v { display:flex; gap:12px; flex-wrap:wrap; margin-top:5px; font-size:13px; font-weight:600; }
.fact { padding:10px 12px; border-radius:8px; margin-bottom:8px; font-size:14px; line-height:1.45; border-left:4px solid; background:#fff; }
.fact.bad { border-color:#c0392b; } .fact.warn { border-color:#e5a100; } .fact.good { border-color:#2e7d32; } .fact.info { border-color:#6d7f8c; }
.tl { list-style:none; margin:0; padding:0; }
.tl li { display:grid; grid-template-columns:86px 1fr; gap:10px; padding:9px 0; border-bottom:1px solid #ebe6da; font-size:14px; line-height:1.45; }
.tl-d { color:#4a5a50; font-size:12.5px; padding-top:2px; }
.staff { margin-top:4px; font-size:12.5px; color:#7a4b00; background:#fff3d6; border:1px solid #f0d58a; border-radius:6px; padding:3px 8px; display:inline-block; }
.ul { margin:0; padding-left:18px; font-size:14px; line-height:1.6; }
.drawbar { background:#fff8e1; border:1px solid #f0d58a; padding:10px 14px; font-size:14px; }

.sheet { position:fixed; left:0; right:0; bottom:0; max-height:78vh; max-height:78dvh; overflow-y:auto; background:#fff; border-top-left-radius:16px; border-top-right-radius:16px; box-shadow:0 -10px 36px rgba(0,0,0,.25); z-index:1200; padding-bottom:env(safe-area-inset-bottom); }
@media (min-width:821px) { .sheet { left:auto; right:16px; bottom:16px; top:80px; width:420px; max-height:none; border-radius:14px; } }
.sheet-h { display:flex; gap:10px; align-items:flex-start; padding:14px 14px 10px; position:sticky; top:0; background:#fff; border-bottom:1px solid #ebe6da; }
.sheet-b { padding:12px 14px 18px; }
.vrow { padding:6px 0 8px; border-bottom:1px solid #f0ece2; }
.vrow-h { display:flex; align-items:center; gap:8px; width:100%; background:none; border:0; padding:4px 0; cursor:pointer; text-align:left; min-height:36px; }
.vrow-l { flex:1; font-size:14.5px; }
.vrow-v { font-weight:600; font-size:15px; } .vrow-v small { font-weight:400; color:#4a5a50; font-size:11.5px; }
.chipr { font-size:11.5px; font-weight:700; border:1.5px solid; border-radius:10px; padding:1px 7px; }
.rb { position:relative; height:8px; border-radius:4px; background:#ece6d8; margin:4px 0 2px; }
.rb-band { position:absolute; top:0; bottom:0; background:#b9dfb5; border-radius:4px; }
.rb-dot { position:absolute; top:-4px; width:16px; height:16px; margin-left:-8px; border-radius:8px; background:#14201a; border:2px solid #fff; box-shadow:0 1px 3px rgba(0,0,0,.4); }
.why { font-size:13.5px; line-height:1.5; color:#2b3a31; background:#f7f4ec; border-radius:8px; padding:8px 10px; margin-top:6px; }

.sp-pin { width:44px; height:30px; border-radius:15px; border:2px solid #fff; background:#14201a; color:#fff; box-shadow:0 1px 5px rgba(0,0,0,.7);
  display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1; font-family:'IBM Plex Mono',monospace; }
.sp-pin b { font-size:9px; opacity:.8; font-weight:500; } .sp-pin span { font-size:12px; font-weight:600; margin-top:1px; }
.sp-pin.off { opacity:.45; } .sp-pin.sel { background:#1b5e20; border-color:#ffeb3b; transform:scale(1.15); }
.sp-head { width:44px; height:44px; background:conic-gradient(from -25deg, rgba(26,115,232,.55) 0 50deg, transparent 50deg); border-radius:50%; }
.sp-banner { position:absolute; top:10px; left:10px; right:10px; z-index:900; background:rgba(255,255,255,.97); color:#14201a; border-radius:10px; padding:10px 12px; font-size:14px; line-height:1.4; box-shadow:0 2px 10px rgba(0,0,0,.3); }
.sp-ctl { position:absolute; right:10px; bottom:26px; z-index:900; display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
.sp-fab { min-width:50px; height:50px; border-radius:25px; border:0; background:#fff; color:#14201a; font-size:20px; font-weight:700; box-shadow:0 2px 8px rgba(0,0,0,.45); cursor:pointer; padding:0 14px; }
.sp-fab.on { background:#1a73e8; color:#fff; font-size:14px; }
.sp-fab-wide { font-size:15px; background:#1a73e8; color:#fff; }
.sp-fab:not(.on):not(.sp-fab-wide) { font-size:15px; }
.leaflet-control-attribution { font-size:10px; }

.home { min-height:100vh; }
.home-b { padding:16px; max-width:1000px; margin:0 auto; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px; }
.site { text-align:left; padding:14px; cursor:pointer; }
`;
