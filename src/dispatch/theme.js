/* Dispatch look: the Shop Board's yard palette (steel greys, stencil type),
   so the three tools read as one family. */

export const C = {
  bg: "#14181C", panel: "#1B2126", tile: "#232B31", tileHi: "#293339",
  edge: "#313C44", edgeSoft: "#242D34",
  ink: "#F3EFE6", inkDim: "#B9C2C9", inkFaint: "#8E99A1",     // brighter (owner, Nov 24: easier to read)
  green: "#17A05B", amber: "#E5A100", blue: "#3A8DD8", red: "#D93B2B", grey: "#6E7A83",
};

export const CSS = `
.dx, .dx * { box-sizing: border-box; }
.dx { font-family:'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif; background:${C.bg}; color:${C.ink};
      min-height:100vh; -webkit-font-smoothing:antialiased; font-size:13.5px; font-weight:450; }
.dx button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
.dx input, .dx select, .dx textarea { font:inherit; color:${C.ink}; }
.dx :focus-visible { outline:2px solid ${C.ink}; outline-offset:2px; border-radius:2px; }
.st { font-family:'Barlow Condensed','Arial Narrow',sans-serif; text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
.mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }

.hd { position:sticky; top:0; z-index:40; background:${C.panel}; border-bottom:1px solid ${C.edge}; }
.chev { height:5px; background:repeating-linear-gradient(115deg,${C.edge} 0 9px,transparent 9px 18px); }
.hd-in { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:10px 16px 9px; }
.brand { font-size:19px; line-height:1; font-weight:700; letter-spacing:.09em; }
.brand small { display:block; font-size:10px; color:${C.inkFaint}; letter-spacing:.14em; margin-top:4px; font-weight:500; }
.tabs { display:flex; gap:2px; background:${C.bg}; border:1px solid ${C.edge}; border-radius:3px; padding:2px; flex-wrap:wrap; }
.tab { padding:6px 12px; font-size:12.5px; border-radius:2px; color:${C.inkDim}; }
.tab[aria-selected="true"] { background:${C.tileHi}; color:${C.ink}; box-shadow:inset 0 1px 0 #3b464e; }
.tab[disabled] { opacity:.45; cursor:default; }
.spacer { flex:1 1 20px; }
.who { font-size:11px; color:${C.inkFaint}; }
@media (max-width:640px) {
  .hd-in { padding:6px 10px 6px; gap:6px; }
  .brand { display:none; }
  .who { display:none; }
  .tab { padding:6px 8px; font-size:11.5px; }
}

.btn { padding:8px 13px; border:1px solid ${C.edge}; border-radius:2px; font-size:11.5px; letter-spacing:.07em; color:${C.ink}; }
.btn:hover { background:${C.tileHi}; }
.btn[data-primary="1"] { border-color:#4f5c65; background:${C.tileHi}; }
.btn[data-danger="1"] { border-color:#5c2e2a; color:#E8867B; }
.btn[disabled] { opacity:.4; cursor:default; }
.chip { font-size:11px; letter-spacing:.06em; padding:5px 9px; border:1px solid ${C.edge}; border-radius:2px; color:${C.inkDim}; white-space:nowrap; }
.chip[data-on="1"] { background:${C.tileHi}; color:${C.ink}; border-color:#58666f; }
.chip b { font-weight:500; color:${C.inkFaint}; margin-left:5px; }
.chip[data-on="1"] b { color:${C.inkDim}; }
.inp { background:${C.bg}; border:1px solid ${C.edge}; border-radius:2px; padding:8px 10px; font-size:13px; width:100%; }
.inp::placeholder { color:${C.inkFaint}; }

.card { background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; }
.card-h { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid ${C.edgeSoft};
          font-size:11px; letter-spacing:.14em; color:${C.inkFaint}; flex-wrap:wrap; }
.card-b { padding:12px; }
.wrap { padding:12px 16px 90px; max-width:1500px; margin:0 auto; }
.lbl { font-size:9.5px; letter-spacing:.16em; color:${C.inkFaint}; }
.hint { font-size:11.5px; color:${C.inkFaint}; line-height:1.5; }
.err { color:#ff9a8f; font-size:12.5px; line-height:1.5; }
.gate { max-width:420px; margin:12vh auto; padding:24px; }
.gate h2 { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.07em; font-size:20px; margin-bottom:10px; }
.gate p { color:${C.inkDim}; line-height:1.55; margin-bottom:12px; font-size:13px; }
`;
