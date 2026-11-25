import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useHeaderLook } from "../headerLook";
import { shopGet, shopDays, shopPatch, shopPresence, stampNow, changed, changedKeys } from "./shopApi";
import { checkJob, problemLines } from "../crewCheck";
import { sharedDay, setSharedDay } from "../sharedDay";

/* ═══════════════════════════════════════════════════════════════════════════
   Shop Board — the owner's ShopBoard.jsx, moved into Dispatch.
   Changes from the original (everything else is the owner's design):
   • Saved on the site's server (/api/dispatch/shop) instead of the Claude
     page's storage. Each edit sends only what changed; the server merges it
     item by item, so two managers working at once don't undo each other.
   • Who you are comes from your sign-in, not a typed name.
   • Moving a person or a load to a bin takes it off its crew directly. (The
     original rebuilt every crew from what sat near what on screen, which
     could empty crews built by dropping onto their boxes.)
   • Undo reverts only what you changed; "Copy to rest of week" only fills
     days nobody has planned yet; Reset is for admins only.
   • Time stamps use the server's clock.
   The rule kept: a unit's spec (drawing, family, name, what it tows) comes
   from SEED_ASSETS in this file and is re-applied on every read.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ============================ SEED (from Fleetio export, 08/26/2026) ======= */
const SEED_ASSETS = [{"id":"a01","name":"F750 BUCKET","spec":"2017 F750 Bucket Truck","cat":"AERIAL","shape":"BUCKET","ops":["GTC"],"status":"running","yard":"Brighton","plate":"25633MM","note":"","tag":"Bucket","hc":"truck","pull":["flatbed"],"fam":"AERIAL","code":"BKT","top":"bucket","vl":"F750 BUCKET"},{"id":"a02","name":"F650 CHIP","spec":"2018 F650 Chip Truck - 4X2 2dr Regular Cab 158","cat":"CHIP TRUCK","shape":"CHIPBOX","ops":["GTC"],"status":"running","yard":"Brighton","plate":"25634MM","note":"","tag":"Chip Truck","hc":"truck","pull":["chipper"],"avoid":["flatbed"],"fam":"CHIP","code":"F650","top":"chipbody","vl":"F650 CHIP"},{"id":"a03","name":"F250 LIFT TRUCK","spec":"2019 F250 - Lift Truck","cat":"SERVICE","shape":"PICKUP","ops":["GTC"],"status":"running","yard":"Brighton","plate":"95009MM","note":"","tag":"Lift Truck","hc":"truck","pull":["lift"],"fam":"SERVICE","code":"F250","top":"flatbed","vl":"F250"},{"id":"a04","name":"F350 LIFT TRUCK","spec":"2019 F350 Lift Truck","cat":"SERVICE","shape":"PICKUP","ops":["GTC"],"status":"running","yard":"Brighton","plate":"65099NA","note":"","tag":"Lift Truck","hc":"truck","pull":["lift"],"fam":"SERVICE","code":"F350","top":"flatbed","vl":"F350"},{"id":"a05","name":"F750 CHIP '19","spec":"2019 F750 Chip Truck - 4X2 4dr SuperCab 179-28","cat":"CHIP TRUCK","shape":"CHIPBOX","ops":["GTC"],"status":"running","yard":"Brighton","plate":"31108MN","note":"","tag":"Chip Truck","hc":"truck","pull":["chipper"],"avoid":["flatbed"],"fam":"CHIP","code":"F750","top":"chipbody","vl":"F750 '19"},{"id":"a06","name":"BELMONT 10K","spec":"2020 Belmont Dump Trailer","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"CD 70633","note":"","tag":"Dump Trailer","hc":"trailer","tt":"flatbed","fam":"FLATBED","code":"BEL","top":"flattrailer","vl":"BELMONT"},{"id":"a07","name":"TEXAS","spec":"2021 F750 Chip Truck","cat":"CHIP TRUCK","shape":"CHIPBOX","ops":["GTC"],"status":"running","yard":"Off-site","plate":"74251NE","note":"","tag":"Texas","hc":"truck","pull":["chipper"],"avoid":["flatbed"],"fam":"CHIP","code":"TEX","top":"chipbody","vl":"TEXAS"},{"id":"a08","name":"WOOD TRUCK","spec":"2021 F750 Dump Truck 4X2 4dr SuperCab 179-281","cat":"DUMP TRUCK","shape":"DUMP","ops":["GTC"],"status":"running","yard":"Brighton","plate":"99168NE","note":"","tag":"Wood Truck","hc":"truck","pull":["flatbed"],"fam":"WOOD","code":"WOOD","top":"rolloff","vl":"WOOD TRUCK"},{"id":"a09","name":"CMC 83HD+ '21","spec":"2021 Lift - CMC 83HD+","cat":"SPIDER LIFT","shape":"SPIDER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Lift","hc":"carried","rides":["lift"],"fam":"AERIAL","code":"83+","top":"spider","vl":"CMC 83HD+"},{"id":"a10","name":"LIFT TRAILER '21","spec":"2021 Lift Trailer - No Ramp","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"CA86310","note":"","tag":"Lift Trailer","hc":"trailer","tt":"lift","fam":"LIFTTR","code":"LT21","top":"lifttrailer","vl":"LT '21"},{"id":"a11","name":"AVANT '21","spec":"2021 Avant","cat":"AVANT","shape":"LOADER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Avant","hc":"carried","rides":["flatbed"],"fam":"AVANT","code":"A21","top":"avant","vl":"AVANT 21"},{"id":"a12","name":"RAV4 '21","spec":"2021 Rav 4 - Sales - AWD XLE 4dr SUV","cat":"SALES","shape":"CAR","ops":["SALES"],"status":"running","yard":"Brighton","plate":"KKJ2683","note":"","tag":"Rav4","hc":"truck","fam":"SALES","code":"R21","top":"car","vl":"RAV4 21"},{"id":"a13","name":"REISER 20FT","spec":"2021 Reiser 20 ft. 2-Axle Platform/Flatbed Tra","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"CJ58195","note":"","tag":"Trailer","hc":"trailer","tt":"flatbed","fam":"FLATBED","code":"R20","top":"flattrailer","vl":"REISER 20"},{"id":"a14","name":"DARTH","spec":"2022 F250 PHC Pickup - Black","cat":"PHC RIG","shape":"BOXVAN","ops":["PHC"],"status":"running","yard":"Rush Scottsville","plate":"76997 ML","note":"","tag":"Darth","hc":"truck","fam":"PHC","code":"DRTH","top":"flatbed","vl":"DARTH"},{"id":"a15","name":"BRIDGETTE","spec":"2022 F550 Chip Truck","cat":"CHIP TRUCK","shape":"CHIPBOX","ops":["GTC"],"status":"running","yard":"Brighton","plate":"51734NC","note":"","tag":"Bridgette","hc":"truck","pull":["chipper","grinder"],"fam":"CHIP","code":"BRDG","top":"chipbody550","vl":"BRIDGETTE"},{"id":"a16","name":"CMC 83HD '22","spec":"2022 Lift CMC 83HD","cat":"SPIDER LIFT","shape":"SPIDER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Lift","hc":"carried","rides":["lift"],"fam":"AERIAL","code":"83","top":"spider","vl":"CMC 83HD"},{"id":"a17","name":"RATTLIN LOG","spec":"2023 F750 Dump Truck","cat":"DUMP TRUCK","shape":"DUMP","ops":["GTC"],"status":"running","yard":"Brighton","plate":"38858 ND","note":"","tag":"Rattlin Log","hc":"truck","pull":["flatbed"],"fam":"WOOD","code":"RTL","top":"rolloff","vl":"RATTLIN LOG"},{"id":"a18","name":"ISUZU PHC","spec":"2023 Isuzu PHC Rig","cat":"PHC RIG","shape":"BOXVAN","ops":["PHC"],"status":"running","yard":"Rush Scottsville","plate":"95112ND","note":"","tag":"PHC Rig","hc":"truck","fam":"PHC","code":"ISZ","top":"cabover","vl":"ISUZU"},{"id":"a19","name":"LIFT TRAILER '23","spec":"2023 Lift Trailer - No Ramp","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"cd 71509","note":"","tag":"Lift Trailer","hc":"trailer","tt":"lift","fam":"LIFTTR","code":"LT23","top":"lifttrailer","vl":"LT '23"},{"id":"a20","name":"REISER '23","spec":"2023 Reiser Trailer","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"CD70287","note":"","tag":"Trailer","hc":"trailer","tt":"flatbed","fam":"FLATBED","code":"R23","top":"flattrailer","vl":"REISER 23"},{"id":"a21","name":"BANDIT 19XPC '24","spec":"2024 Bandit 19XPC Big Chipper","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"19A","top":"chipper","vl":"19XPC '24"},{"id":"a22","name":"COROLLA","spec":"2024 Toyota Corolla","cat":"SALES","shape":"CAR","ops":["SALES"],"status":"running","yard":"Brighton","plate":"HYH8990","note":"","tag":"Corolla","hc":"truck","fam":"SALES","code":"COR","top":"car","vl":"COROLLA"},{"id":"a23","name":"CMC 100HD","spec":"2025 CMC 100HD Lift","cat":"SPIDER LIFT","shape":"SPIDER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Lift","hc":"carried","rides":["lift"],"fam":"AERIAL","code":"100","top":"spider100","vl":"CMC 100HD"},{"id":"a24","name":"LIFT TRAILER '25","spec":"2025 NoRamp Lift Trailer","cat":"TRAILER","shape":"TRAILER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"CJ58425","note":"","tag":"Lift Trailer","hc":"trailer","tt":"lift","fam":"LIFTTR","code":"LT25","top":"lifttrailer","vl":"LT '25"},{"id":"a25","name":"HOPPER","spec":"2025 PHC Rig \"Hopper\"","cat":"PHC RIG","shape":"BOXVAN","ops":["PHC"],"status":"running","yard":"Rush Scottsville","plate":"27575NG","note":"","tag":"Hopper","hc":"truck","fam":"PHC","code":"HOP","top":"cabover","vl":"HOPPER"},{"id":"a26","name":"RED REISER TILT","spec":"2025 Red Reiser Tilt Bed Trailer","cat":"TRAILER","shape":"TRAILER","ops":["GTC","LC"],"status":"running","yard":"Brighton","plate":"CH71811","note":"","tag":"Tilt Trailer","hc":"trailer","tt":"flatbed","fam":"FLATBED","code":"TILT","top":"flattrailer","vl":"TILT"},{"id":"a27","name":"RAV4 '26","spec":"2026 Rav 4","cat":"SALES","shape":"CAR","ops":["SALES"],"status":"running","yard":"Brighton","plate":"MCK9239","note":"","tag":"Rav4","hc":"truck","fam":"SALES","code":"R26","top":"car","vl":"RAV4 26"},{"id":"a28","name":"BANDIT 18XP YELLOW","spec":"Bandit 18xp Yellow Chipper","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"running","yard":"Off-site","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"18Y","top":"chipper","vl":"18XP YEL"},{"id":"a29","name":"BANDIT 15XPC","spec":"Bandit 15xpc","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"15","top":"chipper","vl":"15XPC"},{"id":"a30","name":"BANDIT 19XPC '22","spec":"Bandit 19XPC","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"19B","top":"chipper","vl":"19XPC '22"},{"id":"a31","name":"MORBARK 15R","spec":"Morbark 15R","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"parked","yard":"Brighton","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"M15","top":"chipper","vl":"MORBARK 15R"},{"id":"a32","name":"MORBARK 1621","spec":"Morbark 1621","cat":"CHIPPER","shape":"CHIPPER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Chipper","hc":"towed","tt":"chipper","fam":"CHIPPER","code":"M16","top":"chipper","vl":"MORBARK 1621"},{"id":"a33","name":"F550 LAWN","spec":"F550 Lawn Truck Ford 2025","cat":"LAWN","shape":"LANDSCAPE","ops":["LC","PHC"],"status":"running","yard":"Rush Scottsville","plate":"32100NG","note":"","tag":"Lawn Truck","hc":"truck","pull":["flatbed"],"fam":"LAWN","code":"LAWN","top":"landscape","vl":"F550 LAWN"},{"id":"a34","name":"KUBOTA SPRAY","spec":"Kubota Spray Rig","cat":"PHC RIG","shape":"BOXVAN","ops":["PHC","LC"],"status":"running","yard":"Rush Scottsville","plate":"","note":"","tag":"Spray Rig","hc":"carried","rides":["flatbed"],"fam":"PHC","code":"KUB","top":"utv","vl":"KUBOTA"},{"id":"a35","name":"AVANT '18","spec":"Avant 2018","cat":"AVANT","shape":"LOADER","ops":["GTC"],"status":"parked","yard":"Brighton","plate":"","note":"","tag":"Avant","hc":"carried","rides":["flatbed"],"fam":"AVANT","code":"A18","top":"avant","vl":"AVANT 18"},{"id":"a36","name":"AVANT VIRGINIA","spec":"Avant Virginia","cat":"AVANT","shape":"LOADER","ops":["GTC"],"status":"running","yard":"Off-site","plate":"","note":"","tag":"Avant","hc":"carried","rides":["flatbed"],"fam":"AVANT","code":"AVA","top":"avant","vl":"AVANT VA"},{"id":"a37","name":"RAYCO RG45X","spec":"Rayco Stump Grinder and Trailer","cat":"STUMP GRINDER","shape":"GRINDER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"ck79362","note":"","tag":"Grinder","hc":"towed","tt":"grinder","fam":"GRINDER","code":"RG45","top":"grinder","vl":"RG45X"},{"id":"a38","name":"WESTCHESTER F750","spec":"Westchester F750 Chip Truck","cat":"CHIP TRUCK","shape":"CHIPBOX","ops":["GTC"],"status":"running","yard":"Off-site","plate":"27638NG","note":"","tag":"Chip Truck","hc":"truck","pull":["chipper"],"avoid":["flatbed"],"fam":"CHIP","code":"WCH","top":"chipbody","vl":"WESTCHESTER"},{"id":"a39","name":"AVANT 755i","spec":"2025 Avant 755i (the big Avant)","cat":"AVANT","shape":"LOADER","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Big Avant","hc":"towed","tt":"flatbed","fam":"AVANT","code":"755","top":"avant","vl":"AVANT 755"},{"id":"a40","name":"F750 WOOD '27","spec":"2027 Ford F750 Wood Truck","cat":"DUMP TRUCK","shape":"DUMP","ops":["GTC"],"status":"running","yard":"Brighton","plate":"","note":"","tag":"Wood Truck","hc":"truck","pull":["flatbed"],"fam":"WOOD","code":"W27","top":"rolloff","vl":"WOOD '27"}];

const SEED_PEOPLE = [{"id":"p01","name":"James","d":"JAMES","c":"#DC4520"},{"id":"p02","name":"James B","d":"JAMES B","c":"#DEB89A"},{"id":"p03","name":"Jason Beardsley","d":"JASON BEARDSLEY","c":"#8CC220"},{"id":"p04","name":"Jay H","d":"JAY H","c":"#0E7C86"},{"id":"p05","name":"Jeff Royston","d":"JEFF ROYSTON","c":"#66DFC0"},{"id":"p06","name":"Joe G","d":"JOE G","c":"#7A7A7A"},{"id":"p07","name":"Kevin V","d":"KEVIN V","c":"#2E4258"},{"id":"p08","name":"Kory H","d":"KORY H","c":"#9EC0DE"},{"id":"p09","name":"Liz DeMay","d":"LIZ DEMAY","c":"#A8D149"},{"id":"p10","name":"Luke","d":"LUKE","c":"#3B9DE8"},{"id":"p11","name":"Max","d":"MAX","c":"#A88C8C"},{"id":"p12","name":"Mike L","d":"MIKE L","c":"#FFC800"},{"id":"p13","name":"Mike T","d":"MIKE T","c":"#5A6670"},{"id":"p14","name":"Rebecca V","d":"REBECCA V","c":"#5A6670"},{"id":"p15","name":"Robert L","d":"ROBERT L","c":"#B02000"},{"id":"p16","name":"Sarah","d":"SARAH","c":"#00ACA0"},{"id":"p17","name":"Shawn","d":"SHAWN","c":"#A32B7C"},{"id":"p18","name":"Trevor","d":"TREVOR","c":"#A85BC8"}];

const SEED_CREWS = [
  { id: "c01", name: "CREW 1", ops: "GTC", people: ["p18", "p06", "p07"],
    iron: ["a03", "a10", "a09", "a02", "a21", "a08", "a13", "a11"] },
  { id: "c02", name: "CREW 2", ops: "GTC", people: ["p12", "p15", "p17"],
    iron: ["a04", "a19", "a16", "a15", "a30", "a17", "a20", "a36"] },
  { id: "c03", name: "CREW 3", ops: "GTC", people: ["p11", "p10"],
    iron: ["a01", "a06", "a05", "a29"] },
  { id: "c04", name: "CREW 4", ops: "GTC", people: ["p05", "p02"],
    iron: ["a07", "a32"] },
  { id: "c05", name: "PHC", ops: "PHC", people: ["p16", "p01"],
    iron: ["a14", "a18", "a25"] },
  { id: "c06", name: "LAWNS", ops: "LC", people: ["p08"],
    iron: ["a33", "a26", "a34"] },
  { id: "c07", name: "SHOP", ops: "SHOP", people: ["p13", "p14"], iron: [] },
  { id: "c08", name: "SALES", ops: "SALES", people: ["p03"],
    iron: ["a12", "a22", "a27"] },
];

const SEED_RIGS = [
  { id: "r01", name: "LIFT RIG 1", members: ["a03", "a10", "a09"] },
  { id: "r02", name: "LIFT RIG 2", members: ["a04", "a19", "a16"] },
];

/* ============================ STATUS SYSTEM ===============================
   One rule on this board: color only ever means machine condition.
   Nothing else is allowed to be colored, so a red tile always means one thing.
   Semantics borrowed from tag-out practice, not invented.                    */

const ST = {
  running: { key: "running", label: "Running",    short: "RUN",  color: "#17A05B", note: "Safe to operate" },
  watch:   { key: "watch",   label: "Watch",      short: "WCH",  color: "#E5A100", note: "Operable — flagged" },
  tagged:  { key: "tagged",  label: "Broken",        short: "BROKEN", color: "#D93B2B", note: "Broken — do not operate" },
  parked:  { key: "parked",  label: "Parked",     short: "PRK",  color: "#6E7A83", note: "Off the schedule" },
};
const ST_ORDER = ["running", "watch", "tagged", "parked"];

/* Broken is DATED (owner, Nov 23): asset.broken = [{ from: iso, to: iso|null }]
   — broken from `from`, back in service on `to`. Breaking a unit on a future
   day, or bringing it back on a future day, never changes the days before.
   Older records only had status "tagged"/"shop": broken on every day. */
const LEGACY_FROM = "2000-01-01";
const isLegacyDown = (a) => !a.broken && (a.status === "tagged" || a.status === "shop");
const spansOf = (a) => (a.broken ? a.broken.map((x) => ({ ...x })) : isLegacyDown(a) ? [{ from: LEGACY_FROM, to: null }] : []);
const brokenOn = (a, iso) => !!a && spansOf(a).some((x) => x.from <= iso && (!x.to || iso < x.to));
/** The assets as they stand on a day: status "tagged" when broken that day. */
function assetsOn(assets, iso) {
  const out = {};
  for (const [id, a] of Object.entries(assets || {})) {
    const base = a.status === "tagged" || a.status === "shop" ? "running" : a.status;
    out[id] = brokenOn(a, iso) ? { ...a, status: "tagged" } : base === a.status ? a : { ...a, status: base };
  }
  return out;
}
/** New broken spans for a unit put in (on) or taken out (!on) of Broken on a day. */
function brokenAfter(a, iso, on) {
  let sp = spansOf(a);
  if (on) {
    if (sp.some((x) => x.from <= iso && (!x.to || iso < x.to))) return sp;
    const next = sp.map((x) => x.from).filter((f) => f > iso).sort()[0] || null;
    sp.push({ from: iso, to: next });
  } else {
    sp = sp.flatMap((x) => (x.from <= iso && (!x.to || iso < x.to) ? (x.from === iso ? [] : [{ ...x, to: iso }]) : [x]));
  }
  return sp.sort((x, y) => (x.from < y.from ? -1 : 1));
}
const fmtIso = (iso) => (iso === LEGACY_FROM ? "before this board" : new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));

const DAY = {
  on:    { key: "on",    label: "On the board", short: "ON",    color: "#17A05B" },
  vac:   { key: "vac",   label: "Off duty",     short: "OFF",   color: "#3A8DD8" },
  sick:  { key: "sick",  label: "Out sick",     short: "SICK",  color: "#D93B2B" },
  train: { key: "train", label: "Training",     short: "TRN",   color: "#E5A100" },
  light: { key: "light", label: "Light duty",   short: "LIGHT", color: "#6E7A83" },
  hol:   { key: "hol",   label: "Holiday",      short: "HOL",   color: "#8a6bb8" },
};
const DAY_ORDER = ["on", "vac", "sick", "train", "light"];

/* Fleet and Week ahead are parked, not deleted — flip them back on here. */
const TABS = [["crews", "The yard"], ["people", "People"], ["fleet", "Equipment"]];
// const TABS = [["crews", "The yard"], ["fleet", "Fleet"], ["week", "Week ahead"]];

const C = {
  bg: "#14181C", panel: "#1B2126", tile: "#232B31", tileHi: "#293339",
  edge: "#313C44", edgeSoft: "#242D34",
  ink: "#F3EFE6", inkDim: "#B9C2C9", inkFaint: "#8E99A1",      // brighter (owner, Nov 24: easier to read)
};


/* ============================ MACHINE SILHOUETTES =========================
   Side profiles on one shared scale, all sitting on a common ground line, so
   an Avant reads visibly smaller than an F750 without anyone reading a label.
   viewBox is 200 wide for every shape; height varies by machine class.      */

const W = ({ x, y, r }) => (
  <g>
    <circle cx={x} cy={y} r={r} fill="#101418" />
    <circle cx={x} cy={y} r={r * 0.42} fill="var(--mach-lo)" />
  </g>
);

const MACH = {
  CHIPBOX: { h: 72, w: 176, art: (
    <g>
      <rect x="16" y="50" width="152" height="4" fill="var(--mach-lo)" />
      <path d="M54 50V12h116v38z" fill="var(--mach)" />
      <rect x="52" y="9" width="120" height="4" fill="var(--mach-lo)" />
      <path d="M60 20h100v3H60zm0 9h100v3H60z" fill="var(--mach-lo)" opacity=".55" />
      <path d="M18 50V28l12-4h18l4 8v18z" fill="var(--mach)" />
      <path d="M31 28h15l3 5H31z" fill="var(--mach-hi)" />
      <W x={40} y={56} r={9} /><W x={146} y={56} r={9} />
    </g>) },

  DUMP: { h: 72, w: 176, art: (
    <g>
      <rect x="16" y="50" width="152" height="4" fill="var(--mach-lo)" />
      <path d="M56 50l6-30h104l4 30z" fill="var(--mach)" />
      <path d="M60 22h108v4H60z" fill="var(--mach-lo)" />
      <path d="M18 50V28l12-4h18l4 8v18z" fill="var(--mach)" />
      <path d="M31 28h15l3 5H31z" fill="var(--mach-hi)" />
      <path d="M120 44l30 8v3h-30z" fill="var(--mach-lo)" opacity=".6" />
      <W x={40} y={56} r={9} /><W x={146} y={56} r={9} />
    </g>) },

  BUCKET: { h: 112, w: 190, art: (
    <g>
      <path d="M100 54l10-7 62-35 7 12-64 36z" fill="var(--mach)" />
      <rect x="158" y="2" width="28" height="17" rx="2" fill="var(--mach)" />
      <rect x="158" y="2" width="28" height="4" fill="var(--mach-hi)" />
      <rect x="94" y="50" width="20" height="18" rx="2" fill="var(--mach-lo)" />
      <rect x="16" y="88" width="152" height="4" fill="var(--mach-lo)" />
      <rect x="54" y="64" width="114" height="24" fill="var(--mach)" />
      <path d="M60 70h44v3H60zm52 0h44v3h-44z" fill="var(--mach-lo)" opacity=".55" />
      <path d="M18 88V66l12-4h18l4 8v18z" fill="var(--mach)" />
      <path d="M31 66h15l3 5H31z" fill="var(--mach-hi)" />
      <path d="M56 88l-14 12h7l11-9z" fill="var(--mach-lo)" />
      <W x={40} y={94} r={9} /><W x={146} y={94} r={9} />
    </g>) },

  SPIDER: { h: 104, w: 164, art: (
    <g>
      <path d="M78 62l8-7 58-38 7 12-60 39z" fill="var(--mach)" />
      <rect x="140" y="8" width="24" height="15" rx="2" fill="var(--mach)" />
      <rect x="140" y="8" width="24" height="4" fill="var(--mach-hi)" />
      <rect x="64" y="56" width="26" height="14" rx="2" fill="var(--mach-lo)" />
      <rect x="50" y="70" width="56" height="18" rx="2" fill="var(--mach)" />
      <rect x="30" y="88" width="96" height="13" rx="6" fill="#101418" />
      <circle cx="38" cy="94" r="4" fill="var(--mach-lo)" />
      <circle cx="118" cy="94" r="4" fill="var(--mach-lo)" />
      <path d="M30 90L12 100l3 3 18-9zm96 0l18 10-3 3-18-9z" fill="var(--mach-lo)" />
    </g>) },

  PICKUP: { h: 60, w: 132, art: (
    <g>
      <rect x="18" y="38" width="112" height="3" fill="var(--mach-lo)" />
      <path d="M20 40V25l14-5h22l6 9v11z" fill="var(--mach)" />
      <path d="M35 25h19l4 6H35z" fill="var(--mach-hi)" />
      <rect x="62" y="27" width="62" height="13" fill="var(--mach)" />
      <rect x="62" y="25" width="62" height="3" fill="var(--mach-lo)" />
      <W x={38} y={44} r={8} /><W x={108} y={44} r={8} />
    </g>) },

  BOXVAN: { h: 68, w: 172, art: (
    <g>
      <rect x="16" y="48" width="150" height="4" fill="var(--mach-lo)" />
      <rect x="48" y="16" width="118" height="32" fill="var(--mach)" />
      <rect x="120" y="24" width="38" height="15" rx="7" fill="var(--mach-lo)" />
      <path d="M18 48V26l4-4h24v26z" fill="var(--mach)" />
      <path d="M22 26h22v8H22z" fill="var(--mach-hi)" />
      <W x={36} y={54} r={9} /><W x={144} y={54} r={9} />
    </g>) },

  LANDSCAPE: { h: 64, w: 186, art: (
    <g>
      <rect x="18" y="43" width="140" height="3" fill="var(--mach-lo)" />
      <path d="M20 44V27l14-5h20l6 9v13z" fill="var(--mach)" />
      <path d="M35 27h17l4 6H35z" fill="var(--mach-hi)" />
      <rect x="60" y="26" width="98" height="18" fill="var(--mach)" />
      <path d="M64 30h90v2H64zm0 6h90v2H64z" fill="var(--mach-lo)" opacity=".6" />
      <path d="M158 44l26 8v3h-26z" fill="var(--mach-lo)" />
      <W x={38} y={50} r={8.5} /><W x={132} y={50} r={8.5} />
    </g>) },

  CAR: { h: 52, w: 118, art: (
    <g>
      <path d="M24 36l6-11 18-8h34l20 9 8 10z" fill="var(--mach)" />
      <path d="M38 25l12-6h28l14 6z" fill="var(--mach-hi)" />
      <W x={44} y={40} r={7.5} /><W x={96} y={40} r={7.5} />
    </g>) },

  CHIPPER: { h: 62, w: 150, art: (
    <g>
      <path d="M6 42l28-4v5H8z" fill="var(--mach-lo)" />
      <rect x="34" y="20" width="64" height="24" fill="var(--mach)" />
      <rect x="40" y="11" width="36" height="10" rx="2" fill="var(--mach-lo)" />
      <path d="M98 26l40-13 8 17-48 12z" fill="var(--mach)" />
      <path d="M104 28l32-10 3 6-35 9z" fill="var(--mach-hi)" opacity=".7" />
      <W x={70} y={48} r={9} />
    </g>) },

  GRINDER: { h: 60, w: 130, art: (
    <g>
      <rect x="28" y="20" width="58" height="22" rx="2" fill="var(--mach)" />
      <rect x="36" y="13" width="26" height="8" rx="2" fill="var(--mach-lo)" />
      <path d="M84 26l18 4v8l-18 3z" fill="var(--mach-lo)" />
      <circle cx="112" cy="34" r="13" fill="var(--mach)" />
      <circle cx="112" cy="34" r="6" fill="var(--mach-lo)" />
      <path d="M112 19v-4m13 19h4m-17 13v4m-13-17h-4m19-11l3-3m10 15l4-1m-13 15l2 4m-15-13l-4 2" stroke="var(--mach-hi)" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="26" y="42" width="60" height="10" rx="5" fill="#101418" />
      <circle cx="34" cy="47" r="3" fill="var(--mach-lo)" />
      <circle cx="78" cy="47" r="3" fill="var(--mach-lo)" />
    </g>) },

  LOADER: { h: 58, w: 118, art: (
    <g>
      <path d="M58 30l38-13 5 8-39 15z" fill="var(--mach)" />
      <path d="M92 12h18v20l-18-5z" fill="var(--mach-lo)" />
      <rect x="22" y="24" width="34" height="18" rx="2" fill="var(--mach)" />
      <path d="M25 24V11h28v13z" fill="none" stroke="var(--mach-lo)" strokeWidth="3" />
      <rect x="54" y="28" width="14" height="14" fill="var(--mach-lo)" />
      <W x={33} y={45} r={7} /><W x={62} y={45} r={7} />
    </g>) },

  TRAILER: { h: 44, w: 188, deck: 25, art: (
    <g>
      <path d="M6 24l26-4v5H8z" fill="var(--mach-lo)" />
      <rect x="30" y="19" width="152" height="7" fill="var(--mach)" />
      <path d="M96 19h44v3H96z" fill="var(--mach-lo)" />
      <path d="M98 26h40v4H98z" fill="var(--mach-lo)" opacity=".8" />
      <W x={108} y={32} r={7.5} /><W x={130} y={32} r={7.5} />
    </g>) },
};

const Machine = ({ shape, dim }) => {
  const m = MACH[shape] || MACH.PICKUP;
  return (
    <svg viewBox={`0 0 200 ${m.h}`} width="100%" height={m.h} className="mach"
         style={{ opacity: dim ? 0.5 : 1 }} aria-hidden="true" preserveAspectRatio="xMidYMax meet">
      <line x1="4" y1={m.h - 1.5} x2="196" y2={m.h - 1.5} stroke="var(--edge)" strokeWidth="2" />
      {m.art}
    </svg>
  );
};

/* tiny version for crew cards and lists */
const MachineChip = ({ shape }) => {
  const m = MACH[shape] || MACH.PICKUP;
  return (
    <svg viewBox={`0 0 200 ${m.h}`} width="30" height={Math.round(30 * m.h / 200)}
         aria-hidden="true" preserveAspectRatio="xMidYMax meet" style={{ display: "block" }}>
      {m.art}
    </svg>
  );
};

/* ============================ STORAGE ====================================
   Shared key-value. Every entity carries its own `at` stamp so two people
   editing different things never clobber each other.                        */

const K_CORE = "mtsboard.core.v6";
const K_PRES = "mtsboard.presence.v5";
const K_ME   = "mtsboard.me.v5";
const kWeek  = (iso) => `mtsboard.week.v5.${iso}`;

const clone = (o) => JSON.parse(JSON.stringify(o));
let logSeq = 0;

const srvKey = (k) => (k === K_CORE ? "core" : k.startsWith("mtsboard.day.") ? `day.${k.slice(-10)}` : k.startsWith("mtsboard.week.") ? `week.${k.slice(-10)}` : k);
const sSet = () => false;            // the old name gate's local save; unused now
async function sGet(key, shared = true) {
  if (!shared) { try { return JSON.parse(localStorage.getItem(`mts-shop-${key}`) || "null"); } catch { return null; } }
  return shopGet(srvKey(key));
}

/* A unit's spec — its body, family, name, what it tows — belongs to the code.
   Storage only carries what people actually change. Without this, any change
   to the drawings breaks every board that already has saved data.          */
const SPEC = Object.fromEntries(SEED_ASSETS.map((a) => [a.id, a]));
const SPEC_KEYS = ["name", "spec", "cat", "shape", "top", "fam", "code", "vl", "hc", "tt", "pull", "avoid", "rides", "plate"];
const LABEL_KEYS = ["name", "plate", "vl", "spec"];
/* Owner, Nov 23: the board is for scheduling, not fleet upkeep — trailers and
   the sales cars are left off it entirely. A lift or Avant behind a truck is
   assumed to bring its own trailer, so it hooks straight to the truck, like
   the grinder (which can go behind any truck). */
const offBoard = (a) => a && (a.hc === "trailer" || a.cat === "TRAILER" || a.cat === "SALES" || a.shape === "CAR");
const direct = (a) => (a.hc === "carried" ? { ...a, hc: "towed", tt: (a.rides || [])[0] || "flatbed" } : a);
const reSpec = (assets) => {
  const out = {};
  for (const [id, a] of Object.entries(assets || {})) {
    const sp = SPEC[id];
    if (offBoard(sp || a)) continue;
    if (!sp) { out[id] = direct(a); continue; }
    const merged = { ...a };
    SPEC_KEYS.forEach((k) => { if (sp[k] !== undefined) merged[k] = sp[k]; else delete merged[k]; });
    // Labels the owner changed on the Equipment tab (name, plate, drawing label)
    // win over the code's; the drawing / towing keys never do.
    if (a.custom) LABEL_KEYS.forEach((k) => { if (a.custom[k]) merged[k] = a.custom[k]; });
    out[id] = direct(merged);
  }
  return out;
};

const asMap = (arr) => { const o = {}; arr.forEach((x) => { o[x.id] = { ...x, at: 0 }; }); return o; };

function mergeMap(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const cur = out[k];
    if (!cur || (v.at || 0) > (cur.at || 0)) out[k] = v;
  }
  return out;
}
function mergeLog(a, b) {
  const seen = new Map();
  [...(a || []), ...(b || [])].forEach((e) => seen.set(e.id, e));
  return [...seen.values()].sort((x, y) => y.at - x.at).slice(0, 40);
}
function mergeCore(a, b) {
  return {
    resetAt: Math.max((a && a.resetAt) || 0, (b && b.resetAt) || 0),
    assets: reSpec(mergeMap(a && a.assets, b && b.assets)),
    crews:  mergeMap(a && a.crews,  b && b.crews),
    people: mergeMap(a && a.people, b && b.people),
    rigs:   mergeMap(a && a.rigs,   b && b.rigs),
    log:    mergeLog(a && a.log,    b && b.log),
  };
}
const freshCore = () => ({
  assets: reSpec(asMap(SEED_ASSETS)), crews: asMap(SEED_CREWS), people: asMap(SEED_PEOPLE),
  rigs: asMap(SEED_RIGS), log: [],
});
const live = (map) => Object.values(map || {}).filter((x) => !x.del);
/* This device's copy of the board (see the boot in ShopBoard). Not under "mts-field-". */
const CORE_BACKUP = "mts-shop-core-backup";
const saveCoreBackup = (c) => { try { localStorage.setItem(CORE_BACKUP, JSON.stringify({ assets: c.assets, crews: c.crews, people: c.people, rigs: c.rigs, savedAt: Date.now() })); } catch {} };
const loadCoreBackup = () => { try { return JSON.parse(localStorage.getItem(CORE_BACKUP) || "null"); } catch { return null; } };
/* keep this device's latest values for the keys an edit just sent */
const changedKeysApply = (local, sent) => {
  const out = {};
  for (const k of Object.keys(sent || {})) if (local && k in local) out[k] = local[k];
  return out;
};


/* ============================ HITCHED LOAD ================================
   A truck, what it tows, and what rides on the trailer, drawn as one picture
   on a shared ground line. This is the thing an ops manager is actually
   allocating: not a truck and a trailer and an Avant, but that combination. */

const HC = {
  truck:   { key: "truck",   label: "Trucks",   word: "truck"   },
  trailer: { key: "trailer", label: "Trailers", word: "trailer" },
  towed:   { key: "towed",   label: "Towed",    word: "towed"   },
  carried: { key: "carried", label: "Carried",  word: "carried" },
};
const HC_ORDER = ["truck", "trailer", "towed", "carried"];
const canTow = (a) => a && a.hc === "truck";
const isTowed = (a) => a && (a.hc === "towed" || a.hc === "trailer");
const canCarry = (a) => a && a.hc === "trailer";

const GAP = 9;        // hitch gap between tow vehicle and what it pulls
const PAD = 6;

function LoadArt({ members, scale = 1 }) {
  const parts = members.map((a) => ({ a, m: MACH[a.shape] || MACH.PICKUP }));
  const lead = parts.find((p) => p.a.hc === "truck") || parts[0];
  const pull = parts.find((p) => p.a !== lead.a && isTowed(p.a));
  const riders = parts.filter((p) => p.a !== lead.a && p.a !== (pull && pull.a));

  const rowH = Math.max(...parts.map((p) => p.m.h), 44);
  const deck = pull && pull.m.deck ? pull.m.deck : 0;
  const riderScale = 0.72;
  const riderH = riders.length ? Math.max(...riders.map((p) => p.m.h)) * riderScale : 0;
  const H = Math.max(rowH, deck + riderH) + PAD;
  const B = H - 2;                                   // shared ground line

  let x = 0;
  const place = [];
  if (lead) { place.push({ ...lead, x, s: 1, base: B }); x += lead.m.w + GAP; }
  const hitchX = pull ? x - GAP : null;
  if (pull) {
    place.push({ ...pull, x, s: 1, base: B });
    let rx = x + 26;
    riders.forEach((p) => {
      place.push({ ...p, x: rx, s: riderScale, base: B - deck });
      rx += p.m.w * riderScale + 6;
    });
    x += Math.max(pull.m.w, riders.length ? 26 + riders.reduce((t, p) => t + p.m.w * riderScale + 6, 0) : 0) + GAP;
  } else {
    riders.forEach((p) => { place.push({ ...p, x, s: 1, base: B }); x += p.m.w + GAP; });
  }
  const W = Math.max(x - GAP, 40);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={Math.round(H * scale)}
         preserveAspectRatio="xMinYMax meet" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
      <line x1="0" y1={B + 1.5} x2={W} y2={B + 1.5} stroke="var(--edge)" strokeWidth="2" />
      {hitchX != null && (
        <line x1={hitchX - 2} y1={B - 7} x2={hitchX + GAP + 2} y2={B - 7}
              stroke="var(--mach-lo)" strokeWidth="3" strokeLinecap="round" />
      )}
      {place.map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.base - p.m.h * p.s}) scale(${p.s})`}
           style={{ opacity: p.a.status === "parked" ? 0.5 : 1 }}>
          {p.m.art}
        </g>
      ))}
    </svg>
  );
}

/* ============================ PAINT =======================================
   Colour now says what kind of machine it is, and the roof code says which
   one. Condition is no longer a colour — it is a place: anything broken sits
   in the repair bay. That trade is what frees the palette up.               */

const FAMILY = {
  CHIP:    { label: "Chip truck",      c: "#C07A22" },
  WOOD:    { label: "Dump / wood",     c: "#8A6242" },
  AERIAL:  { label: "Bucket & lifts",  c: "#2E8C93" },
  SERVICE: { label: "Pickup",          c: "#4E6E9E" },
  PHC:     { label: "PHC rig",         c: "#7A5AA8" },
  LAWN:    { label: "Lawn",            c: "#5E9440" },
  CHIPPER: { label: "Chipper",         c: "#CF4A2B" },
  AVANT:   { label: "Avant",           c: "#2F9E55" },
  GRINDER: { label: "Grinder",         c: "#A8476E" },
  FLATBED: { label: "Flatbed trailer", c: "#77838C" },
  LIFTTR:  { label: "Lift trailer",    c: "#4E585F" },
  SALES:   { label: "Sales",           c: "#5A6670" },
};

const shade = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(f)
    .map((v) => v.toString(16).padStart(2, "0")).join("");
};
const inkOn = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const L = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return L > 148 ? "#131820" : "#F2EEE5";
};
const tones = (fam) => {
  const c = (FAMILY[fam] || FAMILY.SALES).c;
  return { body: c, hi: shade(c, 0.3), lo: shade(c, -0.34), ink: inkOn(c) };
};

/* ============================ TOP-DOWN ART ================================
   Fourteen bodies, not four. A chip truck carries an Arbortech box that
   overhangs the cab; a wood truck carries a square 20-yard box with ribs like
   a rolloff; every pickup runs a flatbed; a CMC is a tracked machine with its
   outriggers splayed. The unit's name runs up the length of the body, which
   is the only direction with enough room to actually read it.               */

const Whl = ({ w, l, n = 2, r = 11, inset = 1.5 }) => (
  <g fill="#0A0D10">
    {Array.from({ length: n }).map((_, i) => {
      const y = n === 1 ? l * 0.58 : 13 + i * (l - 32 - r);
      return <g key={i}><rect x={-inset} y={y} width="4.6" height={r} rx="1.5" />
        <rect x={w - 4.6 + inset} y={y} width="4.6" height={r} rx="1.5" /></g>;
    })}
  </g>
);
const Cab = ({ w, t, h = 26, inset = 4 }) => (
  <g>
    <rect x={inset} y="0" width={w - inset * 2} height={h} rx="3" fill={t.hi} stroke={t.lo} strokeWidth="1.2" />
    <rect x={inset + 2.5} y="2" width={w - inset * 2 - 5} height="6" rx="1.5" fill={t.lo} opacity=".85" />
  </g>
);

const TOP = {
  /* chip truck — Arbortech body, wider than the cab, barn doors at the rear */
  chipbody: { w: 34, l: 104, lab: [30, 72], art: (t) => (<g><Whl w={34} l={104} />
    <rect x="0.5" y="29" width="33" height="73" rx="2.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="3" y="33" width="28" height="2" fill={t.lo} opacity=".6" />
    <rect x="3" y="97" width="28" height="2" fill={t.lo} opacity=".8" />
    <line x1="17" y1="99" x2="17" y2="102" stroke={t.lo} strokeWidth="1.4" />
    <Cab w={34} t={t} /></g>) },

  /* wood truck — square 20-yard box, ribbed like a rolloff can */
  rolloff: { w: 34, l: 104, lab: [30, 70], art: (t) => (<g><Whl w={34} l={104} />
    <rect x="0.5" y="29" width="33" height="72" rx="1" fill={shade(t.body, -0.3)} stroke={t.lo} strokeWidth="1.6" />
    <rect x="3.5" y="32" width="27" height="66" rx="0.5" fill={shade(t.body, -0.55)} />
    {[38, 50, 62, 74, 86].map((y) => <rect key={y} x="0.5" y={y} width="33" height="1.6" fill={t.lo} opacity=".55" />)}
    <Cab w={34} t={t} /></g>) },

  /* every pickup runs a flatbed — open deck, headboard, stake pockets */
  flatbed: { w: 32, l: 86, lab: [32, 50], art: (t) => (<g><Whl w={32} l={86} />
    <rect x="0" y="30" width="32" height="53" rx="1.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="0" y="30" width="32" height="3.5" fill={t.lo} />
    {[42, 56, 70].map((y) => <g key={y}><rect x="-1" y={y} width="2.5" height="5" fill={t.lo} />
      <rect x="30.5" y={y} width="2.5" height="5" fill={t.lo} /></g>)}
    <Cab w={32} t={t} h={28} /></g>) },

  /* bucket truck — compartmented utility body, boom stowed down the centre */
  bucket: { w: 34, l: 114, lab: [32, 74], art: (t) => (<g><Whl w={34} l={114} />
    <rect x="1" y="30" width="32" height="78" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    {[38, 56, 74, 92].map((y) => <g key={y}><rect x="1" y={y} width="7" height="14" rx="1" fill={t.lo} opacity=".5" />
      <rect x="26" y={y} width="7" height="14" rx="1" fill={t.lo} opacity=".5" /></g>)}
    <path d="M14 34h6l1.5 66h-9z" fill={t.lo} />
    <rect x="10" y="99" width="14" height="11" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.2" />
    <Cab w={34} t={t} /></g>) },

  /* Isuzu style cab-over — flat front, full-width body, roller door */
  cabover: { w: 32, l: 88, lab: [28, 58], art: (t) => (<g><Whl w={32} l={88} />
    <rect x="0" y="26" width="32" height="60" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="2.5" y="79" width="27" height="4" rx="1" fill={t.lo} opacity=".8" />
    <rect x="0.5" y="0" width="31" height="25" rx="2.5" fill={t.hi} stroke={t.lo} strokeWidth="1.2" />
    <rect x="3" y="2" width="26" height="8" rx="1.5" fill={t.lo} opacity=".85" /></g>) },

  /* F550 landscape body — high mesh sides, ramp off the back */
  landscape: { w: 32, l: 94, lab: [32, 54], art: (t) => (<g><Whl w={32} l={94} />
    <rect x="0" y="30" width="32" height="56" rx="1.5" fill={shade(t.body, -0.18)} stroke={t.lo} strokeWidth="1.4" />
    {[0.5, 27.5].map((x) => <rect key={x} x={x} y="30" width="4" height="56" fill={t.lo} opacity=".55" />)}
    <path d="M4 86h24l-3 8H7z" fill={t.lo} />
    <Cab w={32} t={t} h={27} /></g>) },

  /* Kubota spray rig — small UTV, cage and tank */
  utv: { w: 24, l: 50, lab: [26, 20], art: (t) => (<g><Whl w={24} l={50} r={8} />
    <rect x="1.5" y="2" width="21" height="44" rx="4" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="4" y="5" width="16" height="14" rx="2" fill={t.hi} />
    <rect x="4.5" y="24" width="15" height="19" rx="6" fill={t.lo} /></g>) },

  car: { w: 26, l: 62, lab: [22, 22], art: (t) => (<g><Whl w={26} l={62} r={9} />
    <rect x="2" y="0" width="22" height="62" rx="9" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="5" y="12" width="16" height="15" rx="4" fill={t.hi} /></g>) },

  /* CMC — tracks either side, outriggers splayed, boom stowed down the middle */
  spider: { w: 40, l: 68, lab: [22, 26], art: (t) => (<g>
    <path d="M4 14L-2 4l4-2 6 10zm32 0l6-10-4-2-6 10zM4 54l-6 10 4 2 6-10zm32 0l6 10-4 2-6-10z"
          fill={t.lo} />
    <rect x="0.5" y="12" width="8" height="44" rx="4" fill="#0A0D10" />
    <rect x="31.5" y="12" width="8" height="44" rx="4" fill="#0A0D10" />
    <rect x="2.5" y="16" width="4" height="36" rx="2" fill={t.lo} opacity=".7" />
    <rect x="33.5" y="16" width="4" height="36" rx="2" fill={t.lo} opacity=".7" />
    <rect x="10" y="15" width="20" height="38" rx="2.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <path d="M17 18h6l1 40h-8z" fill={t.lo} />
    <rect x="13" y="55" width="14" height="9" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.1" /></g>) },

  /* CMC 100HD — the tall one: longer tracks, longer boom, hi-vis stripes on the boom */
  spider100: { w: 44, l: 80, lab: [24, 32], art: (t) => (<g>
    <path d="M5 15L-2 4l4-2 7 11zm34 0l7-11-4-2-7 11zM5 65l-7 11 4 2 7-11zm34 0l7 11-4 2-7-11z" fill={t.lo} />
    <rect x="0.5" y="12" width="9" height="56" rx="4.5" fill="#0A0D10" />
    <rect x="34.5" y="12" width="9" height="56" rx="4.5" fill="#0A0D10" />
    <rect x="11" y="15" width="22" height="50" rx="2.5" fill={t.body} stroke={t.lo} strokeWidth="1.6" />
    <path d="M18.5 17h7l1 58h-9z" fill={t.lo} />
    {[24, 36, 48, 60].map((y) => <rect key={y} x="18.5" y={y} width="7" height="3" fill="#E5A100" />)}
    <rect x="14" y="68" width="16" height="11" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.2" /></g>) },

  /* Bridgette — the F550 chip truck: shorter, lower body than the F650/F750s */
  chipbody550: { w: 32, l: 94, lab: [30, 60], art: (t) => (<g><Whl w={32} l={94} />
    <rect x="1" y="29" width="30" height="63" rx="2" fill={shade(t.body, 0.12)} stroke={t.lo} strokeWidth="1.4" />
    <rect x="3.5" y="33" width="25" height="2" fill={t.lo} opacity=".6" />
    <rect x="1" y="86" width="30" height="6" rx="1" fill={t.lo} opacity=".55" />
    <Cab w={32} t={t} h={27} /></g>) },

  /* Avant — articulated, loader arms forward */
  avant: { w: 26, l: 50, lab: [30, 18], art: (t) => (<g><Whl w={26} l={50} r={8} inset={0} />
    <path d="M6 4h5l1 12H7zm9 0h5l-1 12h-5z" fill={t.lo} />
    <path d="M8 14h10v6H8z" fill={t.hi} />
    <rect x="3" y="20" width="20" height="12" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="1.5" y="32" width="23" height="15" rx="2.5" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="9" y="30" width="8" height="4" rx="1" fill={t.lo} /></g>) },

  /* Bandit drum chipper — tongue, engine hood, flared infeed at the rear */
  chipper: { w: 26, l: 64, lab: [16, 30], art: (t) => (<g>
    <path d="M13 -10l4 11h-8z" fill={t.lo} /><Whl w={26} l={64} n={1} r={10} />
    <rect x="2" y="1" width="22" height="46" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="5" y="4" width="16" height="10" rx="2" fill={t.hi} opacity=".8" />
    <path d="M2 47h22l4 15H-2z" fill={t.lo} />
    <path d="M4 51h18l2 7H2z" fill={shade(t.body, -0.5)} /></g>) },

  /* flatbed trailer — open deck, stake pockets, tandem axles */
  flattrailer: { w: 30, l: 88, lab: [22, 56], art: (t) => (<g>
    <path d="M15 -11l4.5 12h-9z" fill={t.lo} /><Whl w={30} l={88} r={10} />
    <rect x="0.5" y="2" width="29" height="84" rx="1.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    {[16, 34, 52, 70].map((y) => <g key={y}><rect x="-1" y={y} width="2.5" height="5" fill={t.lo} />
      <rect x="28.5" y={y} width="2.5" height="5" fill={t.lo} /></g>)}
    <rect x="4" y="5" width="22" height="1.6" fill={t.lo} opacity=".5" /></g>) },

  /* lift trailer — narrower, beavertail and ramps at the rear */
  lifttrailer: { w: 26, l: 76, lab: [20, 44], art: (t) => (<g>
    <path d="M13 -11l4 12h-8z" fill={t.lo} /><Whl w={26} l={76} n={1} r={10} />
    <rect x="0.5" y="2" width="25" height="60" rx="1.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <path d="M0.5 62h25l-2 12h-21z" fill={shade(t.body, -0.3)} stroke={t.lo} strokeWidth="1.2" />
    <line x1="13" y1="63" x2="13" y2="73" stroke={t.lo} strokeWidth="1.2" /></g>) },

  /* Rayco — engine forward, cutter wheel at the rear */
  grinder: { w: 26, l: 60, lab: [18, 26], art: (t) => (<g>
    <path d="M13 -10l4 11h-8z" fill={t.lo} /><Whl w={26} l={60} n={1} r={9} />
    <rect x="2" y="1" width="22" height="40" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <circle cx="13" cy="50" r="9" fill={t.lo} stroke={shade(t.body, -0.5)} strokeWidth="1.2" />
    <circle cx="13" cy="50" r="3" fill={t.hi} />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => (
      <rect key={d} x="12" y="40" width="2" height="3.5" fill={t.hi}
            transform={`rotate(${d} 13 50)`} />))}</g>) },
};

/* the name runs up the body; if it will not fit legibly, fall back to the code */
const VName = ({ w, lab, vl, code, ink, halo }) => {
  const [y0, len] = lab || [0, 40];
  vl = vl || code || "—"; code = code || vl;
  const full = Math.min(11.5, (len - 9) / (vl.length * 0.62));
  const use = full >= 7 ? vl : code;
  const size = full >= 7 ? full : Math.min(10.5, (len - 6) / (code.length * 0.6));
  return (
    <text transform={`translate(${w / 2} ${y0 + len / 2}) rotate(-90)`} textAnchor="middle"
          dominantBaseline="central" fill={ink} stroke={halo} strokeWidth="2.6" paintOrder="stroke"
          fontFamily="'Barlow Condensed',sans-serif" fontWeight="700"
          fontSize={Math.max(6.5, size)} letterSpacing="0.5">{use}</text>
  );
};

const TGAP = 7;

/* SIDE VIEWS (owner, Nov 24: "change all the trucks to side views"). Every unit
   is drawn from the side, facing right (trucks drive right, towed units' tongues
   point right at the truck), on a shared ground line; the name goes in an easy-
   to-read tag BELOW it (see HLoad). Same model = same drawing: every 83 ft CMC
   alike, the 100HD longer with a striped boom, all F650/F750 chip trucks alike,
   Bridgette (F550) shorter and lighter, all wood trucks alike. */
const SW = ({ cx, cy, r = 7 }) => <g><circle cx={cx} cy={cy} r={r} fill="#0A0D10" /><circle cx={cx} cy={cy} r={r * 0.42} fill="#5b666e" /></g>;
/** A conventional cab facing right; x = its back, ground = wheel centre line. */
const SCab = ({ x, t, h = 28, g = 36, hood = 10 }) => (
  <g>
    <path d={`M${x} ${g - 2} V${g - h + 5} Q${x} ${g - h} ${x + 5} ${g - h} H${x + 15} L${x + 22} ${g - h + 10} H${x + 22 + hood - 2} Q${x + 22 + hood} ${g - h + 10} ${x + 22 + hood} ${g - h + 13} V${g - 2} Z`}
          fill={t.hi} stroke={t.lo} strokeWidth="1.3" />
    <path d={`M${x + 6} ${g - h + 3} H${x + 14} L${x + 19.5} ${g - h + 10} H${x + 6} Z`} fill="#26343e" />
  </g>
);
const chassis = (x1, x2, g = 36) => <rect x={x1} y={g - 6} width={x2 - x1} height="4" fill="#1b2126" />;
const SIDE = {
  chipbody: { w: 116, h: 44, art: (t) => (<g>{chassis(2, 108)}
    <rect x="2" y="3" width="76" height="29" rx="2.5" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="4" y="6" width="72" height="3" fill={t.lo} opacity=".55" />
    <line x1="6" y1="10" x2="6" y2="30" stroke={t.lo} strokeWidth="1.2" />
    <SCab x={80} t={t} /><SW cx={20} cy={37} /><SW cx={35} cy={37} /><SW cx={98} cy={37} /></g>) },
  chipbody550: { w: 106, h: 44, art: (t) => (<g>{chassis(6, 98)}
    <rect x="6" y="9" width="64" height="23" rx="2" fill={shade(t.body, 0.14)} stroke={t.lo} strokeWidth="1.4" />
    <rect x="8" y="12" width="60" height="2.5" fill={t.lo} opacity=".5" />
    <SCab x={70} t={t} h={27} /><SW cx={24} cy={37} /><SW cx={88} cy={37} /></g>) },
  rolloff: { w: 116, h: 44, art: (t) => (<g>{chassis(2, 108)}
    <rect x="2" y="2" width="76" height="30" rx="1" fill={shade(t.body, -0.25)} stroke={t.lo} strokeWidth="1.6" />
    {[12, 24, 36, 48, 60, 70].map((x) => <rect key={x} x={x} y="2" width="2" height="30" fill={t.lo} opacity=".6" />)}
    <rect x="2" y="2" width="76" height="4" fill={t.lo} opacity=".5" />
    <SCab x={80} t={t} /><SW cx={20} cy={37} /><SW cx={35} cy={37} /><SW cx={98} cy={37} /></g>) },
  flatbed: { w: 100, h: 42, art: (t) => (<g>{chassis(2, 92)}
    <rect x="2" y="25" width="60" height="6" rx="1" fill={t.body} stroke={t.lo} strokeWidth="1.2" />
    <rect x="58" y="13" width="4" height="13" fill={t.lo} />
    <SCab x={64} t={t} h={26} hood={12} /><SW cx={18} cy={37} /><SW cx={86} cy={37} /></g>) },
  bucket: { w: 118, h: 46, art: (t) => (<g>{chassis(2, 110)}
    <rect x="4" y="16" width="72" height="18" rx="1.5" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    {[8, 26, 44, 60].map((x) => <rect key={x} x={x} y="19" width="12" height="12" rx="1" fill={t.lo} opacity=".45" />)}
    <rect x="12" y="9" width="92" height="5" rx="2" fill={t.lo} />
    <rect x="1" y="0" width="13" height="15" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.2" />
    <SCab x={80} t={t} h={27} /><SW cx={22} cy={38} /><SW cx={37} cy={38} /><SW cx={100} cy={38} /></g>) },
  cabover: { w: 104, h: 44, art: (t) => (<g>{chassis(2, 100)}
    <rect x="2" y="3" width="70" height="29" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="4" y="27" width="66" height="3" fill={t.lo} opacity=".6" />
    <rect x="73" y="6" width="27" height="28" rx="3" fill={t.hi} stroke={t.lo} strokeWidth="1.3" />
    <rect x="88" y="9" width="10" height="11" rx="1.5" fill="#26343e" />
    <SW cx={20} cy={37} /><SW cx={88} cy={37} /></g>) },
  landscape: { w: 108, h: 44, art: (t) => (<g>{chassis(2, 100)}
    <rect x="2" y="9" width="66" height="23" rx="1" fill={shade(t.body, -0.2)} stroke={t.lo} strokeWidth="1.4" />
    {[10, 18, 26, 34, 42, 50, 58].map((x) => <line key={x} x1={x} y1="10" x2={x} y2="31" stroke={t.lo} strokeWidth="0.9" opacity=".7" />)}
    <SCab x={70} t={t} h={28} /><SW cx={20} cy={37} /><SW cx={90} cy={37} /></g>) },
  utv: { w: 60, h: 36, art: (t) => (<g>
    <rect x="6" y="18" width="48" height="10" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.2" />
    <ellipse cx="18" cy="15" rx="11" ry="6" fill={t.hi} stroke={t.lo} strokeWidth="1.1" />
    <path d="M33 18 V5 H48 L52 18" fill="none" stroke={t.lo} strokeWidth="2" />
    <SW cx={15} cy={29} r={6} /><SW cx={46} cy={29} r={6} /></g>) },
  car: { w: 70, h: 34, art: (t) => (<g>
    <path d="M4 26 V18 Q6 14 14 13 L24 5 H44 L54 13 Q64 14 66 19 V26 Z" fill={t.body} stroke={t.lo} strokeWidth="1.2" />
    <path d="M26 8 H42 L49 13 H22 Z" fill="#26343e" /><SW cx={17} cy={27} r={6} /><SW cx={54} cy={27} r={6} /></g>) },
  spider: { w: 78, h: 40, art: (t) => (<g>
    <path d="M16 24 L3 38 M58 24 L72 38" stroke={t.lo} strokeWidth="2.6" />
    <rect x="12" y="27" width="50" height="11" rx="5.5" fill="#0A0D10" /><rect x="16" y="30" width="42" height="5" rx="2.5" fill={t.lo} opacity=".6" />
    <rect x="15" y="17" width="44" height="11" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="6" y="11" width="60" height="5" rx="2" fill={t.lo} />
    <rect x="63" y="3" width="12" height="12" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.2" /></g>) },
  spider100: { w: 94, h: 42, art: (t) => (<g>
    <path d="M18 26 L3 40 M70 26 L88 40" stroke={t.lo} strokeWidth="2.8" />
    <rect x="13" y="29" width="62" height="12" rx="6" fill="#0A0D10" /><rect x="17" y="32" width="54" height="5" rx="2.5" fill={t.lo} opacity=".6" />
    <rect x="16" y="18" width="56" height="12" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <rect x="5" y="11" width="76" height="6" rx="2" fill={t.lo} />
    {[14, 30, 46, 62].map((x) => <rect key={x} x={x} y="11" width="6" height="6" fill="#E5A100" />)}
    <rect x="78" y="2" width="14" height="13" rx="2" fill={t.hi} stroke={t.lo} strokeWidth="1.2" /></g>) },
  avant: { w: 66, h: 38, art: (t) => (<g>
    <path d="M47 14 L62 21 L62 25 L46 19 Z" fill={t.body} stroke={t.lo} strokeWidth="1.2" />
    <path d="M60 17 h6 v15 h-9 l3 -4 z" fill={t.lo} />
    <rect x="4" y="16" width="52" height="11" rx="3" fill={t.body} stroke={t.lo} strokeWidth="1.3" />
    <rect x="5" y="11" width="15" height="7" rx="2" fill={shade(t.body, -0.15)} stroke={t.lo} strokeWidth="1.1" />
    <path d="M25 17 L27 2 H42 L44 17" fill="none" stroke={t.lo} strokeWidth="2.2" strokeLinejoin="round" />
    <rect x="25" y="0.5" width="20" height="3.2" rx="1" fill={t.lo} />
    <rect x="30" y="9" width="8" height="8" rx="1.5" fill="#20262b" />
    <SW cx={14} cy={30} r={8} /><SW cx={46} cy={30} r={8} /></g>) },
  chipper: { w: 80, h: 40, art: (t) => (<g>
    <path d="M54 29 H78" stroke={t.lo} strokeWidth="3" /><circle cx="78" cy="29" r="2.5" fill={t.lo} />
    <path d="M2 13 L22 17 V31 L2 33 Z" fill={t.lo} />
    <rect x="22" y="11" width="34" height="20" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <path d="M42 11 V3 H54 V7 H47 V11 Z" fill={t.lo} />
    <rect x="25" y="14" width="12" height="7" rx="1" fill={t.hi} opacity=".8" />
    <SW cx={38} cy={33} /></g>) },
  grinder: { w: 72, h: 38, art: (t) => (<g>
    <path d="M50 26 H70" stroke={t.lo} strokeWidth="3" /><circle cx="70" cy="26" r="2.5" fill={t.lo} />
    <rect x="18" y="11" width="34" height="18" rx="2" fill={t.body} stroke={t.lo} strokeWidth="1.4" />
    <circle cx="12" cy="25" r="9" fill={t.lo} stroke={shade(t.body, -0.5)} strokeWidth="1.2" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => <rect key={d} x="11" y="14" width="2" height="3.5" fill={t.hi} transform={`rotate(${d} 12 25)`} />)}
    <SW cx={36} cy={31} r={6} /></g>) },
};
/* YARD LOOK (owner picks A / B / C on the yard's bottom bar; per device). Units a
   little smaller, names bigger in an easy sans-serif tag, more room between setups. */
const YARD_LOOKS = {
  A: { label: "A · light tag", unit: 0.86, fs: 11.5, font: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif", bg: "#F2EEE5", ink: "#111", gap: 28 },
  B: { label: "B · dark plate", unit: 0.8, fs: 12.5, font: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif", bg: "#0E1215", ink: "#F7F3EA", gap: 32 },
  C: { label: "C · big yellow tag", unit: 0.9, fs: 13, font: "'Arial Narrow', 'Roboto Condensed', Arial, sans-serif", bg: "#FFD54F", ink: "#111", gap: 26 },
};
let yardLook = "A";          // the owner picked A (Nov 24); B and C kept here only for reference
const LOOK = () => YARD_LOOKS[yardLook];
const setYardLook = (k) => { yardLook = YARD_LOOKS[k] ? k : "A"; try { localStorage.setItem("mts-yard-look", yardLook); } catch {} };

/* Units carried on their own trailer when hooked behind a truck (owner: "assume it has
   its own trailer"): drawn sitting on a low deck whose tongue meets the truck. */
const TRAILERED = new Set(["avant", "spider", "spider100", "utv"]);
const TR_LIFT = 7;          // how far the unit sits up on its trailer deck
const TR_TONGUE = 12;       // trailer tongue reaching forward to the truck
let labelCtx = null;
const labelPx = (txt, look) => {
  try { labelCtx = labelCtx || document.createElement("canvas").getContext("2d"); labelCtx.font = `700 ${look.fs}px ${look.font}`; return labelCtx.measureText(txt).width; }
  catch { return txt.length * look.fs * 0.6; }
};
/** A unit's box from the side (falls back to the flatbed pickup drawing for unknown kinds). */
const hBox = (m) => { const sd = SIDE[m.top] || SIDE.flatbed; return { w: sd.w, h: sd.h, side: sd }; };
/** Lay out a load horizontally: the truck at the right facing right, what it tows hooked
    on right behind it (touching), in drawing units (× LOOK().unit on screen). */
function hLayout(members) {
  const look = LOOK(), u = look.unit;
  const lead = members.find((m) => m.hc === "truck") || members[0];
  const rest = members.filter((m) => m !== lead);
  const seq = [lead, ...rest];                       // right to left
  const towed = (i) => i > 0 && lead.hc === "truck";
  const boxes = seq.map((m, i) => {
    const b = hBox(m), tr = towed(i) && TRAILERED.has(m.top);
    const name = String(m.vl || m.code || m.name || "");
    return { ...b, tr, name, lw: labelPx(name, look) / u + 12, fw: b.w + (tr ? TR_TONGUE : 0) };
  });
  const GH = Math.max(...boxes.map((b) => b.h + (b.tr ? TR_LIFT : 0)));
  const TAGH = (look.fs + 7) / u;
  const H = GH + TAGH + 5;
  const padR = Math.max(0, (boxes[0].lw - boxes[0].w) / 2), last = boxes[boxes.length - 1];
  const padL = Math.max(0, (last.lw - last.fw) / 2);
  const W = padL + boxes.reduce((t, b) => t + b.fw, 0) + padR + 2;
  let x = W - padR - 1;
  const placed = seq.map((m, i) => {
    const b = boxes[i];
    x -= b.fw;                                        // hooked units touch: no gap
    const ux = x;                                     // the unit itself sits left of its tongue
    return { m, b, x: ux, y: GH - b.h - (b.tr ? TR_LIFT : 0) };
  });
  return { W, H, GH, TAGH, placed, leadW: boxes[0].w + padR, u };
}
function hDims(members) { const L = hLayout(members); return { w: L.W * L.u, h: L.H * L.u }; }
/** The load from the side, hooked up, each unit's name in a tag underneath. */
function HLoad({ members, scale = 1, broken }) {
  const look = LOOK();
  const { W, H, GH, TAGH, placed, u } = hLayout(members);
  const fs = look.fs / u;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W * u * scale} height={H * u * scale} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      {placed.map(({ m, b, x, y }) => {
        const t = tones(m.fam), dim = m.status === "parked" ? 0.55 : 1;
        const tw = Math.min(b.lw, b.fw - 4);                       // never wider than its own unit: neighbours don't collide
        const cx = x + b.w / 2;
        return (
          <g key={m.id} opacity={dim}>
            {b.tr && (
              <g>
                <rect x={x - 2} y={GH - TR_LIFT - 1} width={b.w + 4} height="4" rx="1" fill="#3a444b" stroke="#1b2126" strokeWidth="0.8" />
                <path d={`M${x + b.w + 2} ${GH - TR_LIFT + 1} L${x + b.fw} ${GH - 5}`} stroke="#3a444b" strokeWidth="3" />
                <circle cx={x + b.w * 0.45} cy={GH - 3} r="3.6" fill="#0A0D10" />
              </g>
            )}
            <g transform={`translate(${x} ${y})`}>{b.side.art(t)}</g>
            {broken && <rect x={x - 3} y={y - 3} width={b.w + 6} height={b.h + 6} rx="4" fill="none" stroke="#D93B2B" strokeWidth="1.8" strokeDasharray="5 3" />}
            <rect x={cx - tw / 2} y={GH + 3} width={tw} height={TAGH} rx={TAGH / 2.6} fill={look.bg} stroke={t.body} strokeWidth={1.4 / u} />
            <text x={cx} y={GH + 3 + TAGH / 2} textAnchor="middle" dominantBaseline="central" fill={look.ink}
                  fontFamily={look.font} fontWeight="700" fontSize={fs} textLength={b.lw - 12 > tw - 8 ? tw - 8 : undefined} lengthAdjust="spacingAndGlyphs">{b.name}</text>
          </g>
        );
      })}
    </svg>
  );
}
/* A shape we do not recognise must degrade, never take the board down. */
const shapeOf = (m) => (m && TOP[m.top]) || TOP.flatbed;

function TopLoad({ members, scale = 1, broken }) {
  const lead = members.find((m) => m.hc === "truck") || members[0];
  const tow = members.find((m) => m !== lead && (m.hc === "towed" || m.hc === "trailer"));
  const riders = members.filter((m) => m !== lead && m !== tow);
  const L = shapeOf(lead);
  const T = tow ? shapeOf(tow) : null;
  const strays = T ? [] : riders;
  const W = Math.max(L.w, T ? T.w : 0, ...strays.map((r) => shapeOf(r).w)) + 4;
  const H = L.l + (T ? TGAP + T.l : 0) + (strays.length ? TGAP + Math.max(...strays.map((r) => shapeOf(r).l)) : 0) + 10;
  const cx = W / 2;
  const unit = (m, y, dim) => {
    const S = shapeOf(m), t = tones(m.fam);
    return (
      <g key={m.id} transform={`translate(${cx - S.w / 2} ${y})`} opacity={dim ? 0.55 : 1}>
        {S.art(t)}
        <VName w={S.w} lab={S.lab} vl={m.vl} code={m.code} ink={t.ink} halo={t.body} />
        {broken && <rect x="-3" y="-3" width={S.w + 6} height={S.l + 6} rx="4" fill="none"
                         stroke="#D93B2B" strokeWidth="1.8" strokeDasharray="5 3" />}
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W * scale} height={H * scale}
         style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      {unit(lead, 0, lead.status === "parked")}
      {T && (
        <>
          <line x1={cx} y1={L.l} x2={cx} y2={L.l + TGAP} stroke={shade(tones(lead.fam).body, -0.45)} strokeWidth="3" />
          {unit(tow, L.l + TGAP, tow.status === "parked")}
          {riders.map((r) => unit(r, L.l + TGAP + (T.l - shapeOf(r).l) / 2, r.status === "parked"))}
        </>
      )}
      {strays.map((r) => unit(r, L.l + TGAP, r.status === "parked"))}
    </svg>
  );
}

/* ============================ THE DAY =====================================
   Crews are not a standing fact, they are what you decided for a date. Each
   day gets its own record. Open a day with no record and you see the previous
   day's arrangement, marked as inherited; the first edit commits it. That is
   the "cohesive day to day" default, without anyone re-dragging every morning. */

const kDay = (iso) => `mtsboard.day.v6.${iso}`;
const DAY_PREFIX = "mtsboard.day.v6.";

const listDays = () => shopDays();

/* COLUMNS (owner, Nov 24): a crew's equipment stands in columns — a truck and
   what it tows, or one unit on its own. crew.cols = [[ids]] says exactly that;
   crew.iron stays the flat list everything else reads. Nothing is ever hooked
   up automatically: a unit dropped in a crew's empty slot gets a column of its
   own; only a drop ON a column hooks it there. A column with nothing left in
   it disappears. Crews saved before columns are read the old way: a truck
   takes the next towed unit in its list. */
function legacyCols(iron, assets) {
  const cols = []; let cur = null, free = false;
  (iron || []).forEach((id) => {
    const a = assets[id]; if (!a || a.del) return;
    if (a.hc === "truck") { cur = [id]; cols.push(cur); free = true; }
    else if (a.hc === "towed" && cur && free) { cur.push(id); free = false; }
    else cols.push([id]);
  });
  return cols;
}
function colsOf(crew, assets) {
  const iron = (crew.iron || []).filter((id) => assets[id] && !assets[id].del);
  const inIron = new Set(iron), seen = new Set();
  let cols = [];
  if (Array.isArray(crew.cols)) {
    cols = crew.cols.map((col) => (col || []).filter((id) => inIron.has(id) && !seen.has(id) && seen.add(id))).filter((col) => col.length);
  }
  const rest = iron.filter((id) => !seen.has(id));
  if (rest.length) cols = cols.concat(legacyCols(rest, assets));
  return cols.map((col) => { const t = col.find((id) => assets[id].hc === "truck"); return t ? [t, ...col.filter((x) => x !== t)] : col; });
}
/** Hitches from the columns: the truck heading a column tows the first unit behind it. */
function deriveHitch(crews, assets) {
  const hitch = {};
  Object.values(crews || {}).forEach((c) => {
    if (!c || c.del) return;
    colsOf(c, assets).forEach((col) => {
      const lead = assets[col[0]];
      if (lead && lead.hc === "truck" && col[1]) hitch[col[1]] = col[0];
    });
  });
  return hitch;
}
/** A crew's columns as loads, in the order they stand. */
function loadsOf(crew, assets) {
  return colsOf(crew, assets).map((col) => {
    const members = col.map((id) => assets[id]);
    return { id: col[0], lead: members[0], members };
  });
}
/** Can these units be hooked onto this column? Returns the new column, or null (→ a column of their own). */
function hookOnto(colIds, ids, assets) {
  const col = colIds.map((i) => assets[i]).filter(Boolean), mv = ids.map((i) => assets[i]).filter(Boolean);
  const cT = col.filter((a) => a.hc === "truck"), cO = col.filter((a) => a.hc !== "truck");
  const mT = mv.filter((a) => a.hc === "truck"), mO = mv.filter((a) => a.hc !== "truck");
  if (cT.length === 1 && !cO.length && !mT.length && mO.length === 1) return [cT[0].id, mO[0].id];   // behind the truck
  if (!cT.length && cO.length === 1 && mT.length === 1 && !mO.length) return [mT[0].id, cO[0].id];   // a truck in front
  return null;
}

/* Where should a newly dropped unit attach inside this crew? */
function placeInCrew(asset, crew, assets, hitch) {
  if (!asset) return null;
  const loads = loadsOf(crew, assets);
  if (asset.hc === "towed" || asset.hc === "trailer") return pickTow(asset, loads, hitch);
  if (asset.hc === "carried") return pickCarrier(asset, loads);
  return null;
}


/* ---- what pulls what ----------------------------------------------------
   Preferences, not rules. A chip truck almost never pulls a flatbed, but
   "almost never" is a flag on the board, not a locked door.               */
const TOWWORD = { chipper: "chipper", grinder: "grinder", flatbed: "flatbed trailer", lift: "lift trailer" };
const towedOf = (load, hitch) =>
  load.members.find((m) => m.id !== load.lead.id && hitch[m.id] === load.lead.id && (m.hc === "towed" || m.hc === "trailer"));

function towScore(truck, tt) {
  if (!tt) return 0;
  if ((truck.avoid || []).includes(tt)) return -1;   // almost never
  if ((truck.pull || []).includes(tt)) return 2;     // what it normally pulls
  if (!(truck.pull || []).length) return 1;          // no habit either way
  return 0;
}

/* the truck that should take this towed unit, best habit first */
function pickTow(asset, loads, hitch) {
  const free = loads.filter((l) => l.lead.hc === "truck" && !towedOf(l, hitch));
  if (!free.length) return null;
  const ranked = free.map((l) => ({ l, s: towScore(l.lead, asset.tt) })).sort((a, b) => b.s - a.s);
  return ranked[0].l.lead.id;
}

/* the trailer that can actually carry this machine */
function pickCarrier(asset, loads) {
  const trailers = loads.flatMap((l) => l.members).filter((m) => m.hc === "trailer");
  const fits = trailers.filter((t) => (asset.rides || []).includes(t.tt));
  return (fits[0] || trailers[0] || {}).id || null;
}

function loadIssues(load, hitch) {
  const out = [];
  const lead = load.lead;
  const towed = towedOf(load, hitch);
  if (lead.hc === "truck" && towed && towScore(lead, towed.tt) < 0)
    out.push(`${lead.tag} rarely pulls a ${TOWWORD[towed.tt] || towed.tag.toLowerCase()}`);
  if (lead.hc !== "truck")
    out.push(`${lead.tag} has no truck to pull it`);
  load.members.filter((m) => m.hc === "carried").forEach((m) => {
    const parent = load.members.find((x) => x.id === hitch[m.id]);
    if (!parent || parent.hc !== "trailer") out.push(`${m.tag} has no trailer — it cannot go out`);
    else if ((m.rides || []).length && !(m.rides || []).includes(parent.tt))
      out.push(`${m.tag} is loaded on a ${TOWWORD[parent.tt] || parent.tag.toLowerCase()}`);
  });
  return out;
}


/* ============================ THE YARD MODEL ==============================
   A day record now carries three things: the crews (name and operation), the
   stacks (which units are hitched to which), and where everything is parked.
   Crew membership is not typed in — it is read back off the yard after every
   move, so what you see on the asphalt is what the day sheet prints.        */

const NEAR = 150;
const CW = 1400;
const CH = 840;

function stacksFrom(crews, assets) {
  const stacks = {};
  const claimed = new Set();
  live(crews).forEach((c) => {
    let lead = null, trailer = null;
    (c.iron || []).forEach((id) => {
      const a = assets[id]; if (!a || a.del) return;
      claimed.add(id);
      if (a.hc === "truck") { lead = id; stacks[id] = [id]; trailer = null; }
      else if (a.hc === "towed" || a.hc === "trailer") {
        const has = lead && stacks[lead].slice(1).some((x) => assets[x] && (assets[x].hc === "towed" || assets[x].hc === "trailer"));
        if (lead && !has) stacks[lead].push(id);
        else { lead = id; stacks[id] = [id]; }
        trailer = a.hc === "trailer" ? id : null;
      } else {
        if (trailer && lead) stacks[lead].push(id);
        else { stacks[id] = [id]; lead = null; }
      }
    });
  });
  live(assets).forEach((a) => { if (!claimed.has(a.id) && !stacks[a.id]) stacks[a.id] = [a.id]; });
  return stacks;
}

/* lay the standing setup out so each crew lands as its own group */
function freshDay(core) {
  const crews = clone(core.crews);
  const stacks = stacksFrom(crews, core.assets);
  const pos = {};
  live(crews).forEach((c, i) => {
    const bx = 74 + (i % 4) * 340, by = 58 + Math.floor(i / 4) * 330;
    pos[c.id] = { x: bx - 12, y: by - 30 };
    (c.people || []).forEach((p, j) => { pos[p] = { x: bx + j * 84, y: by }; });
    const mine = Object.keys(stacks).filter((k) => (c.iron || []).includes(k));
    mine.forEach((k, j) => { pos[k] = { x: bx + j * 76, y: by + 46 }; });
  });
  return { crews, stacks, pos };
}

const leadOf = (day, id) => Object.keys(day.stacks || {}).find((k) => day.stacks[k].includes(id)) || id;

function clusterNodes(nodes) {
  const seen = new Set(), out = [];
  nodes.forEach((a) => {
    if (seen.has(a.id)) return;
    const g = [a]; seen.add(a.id);
    for (let i = 0; i < g.length; i++) {
      nodes.forEach((b) => {
        if (seen.has(b.id)) return;
        if (Math.hypot(g[i].x - b.x, g[i].y - b.y) < NEAR) { g.push(b); seen.add(b.id); }
      });
    }
    out.push(g);
  });
  return out;
}

function yardNodes(day, peopleIds) {
  const pos = day.pos || {}, out = [];
  Object.keys(day.stacks || {}).forEach((id) => pos[id] && out.push({ t: "s", id, ...pos[id] }));
  peopleIds.forEach((id) => pos[id] && out.push({ t: "p", id, ...pos[id] }));
  live(day.crews).forEach((c) => pos[c.id] && out.push({ t: "c", id: c.id, ...pos[c.id] }));
  return out;
}

/* read the yard back into crew membership — this is what keeps the rest of
   the app (day sheet, fleet labels, warnings) working off the same record */
/* Remember a load that went to a bin as one group (truck + what it tows),
   so it shows together there and moves together next time. */
function regroup(day, mem) {
  const st = (day.stacks = day.stacks || {});
  Object.keys(st).forEach((k) => {
    const left = (st[k] || []).filter((x) => !mem.includes(x));
    if (left.length !== (st[k] || []).length) { if (left.length) st[k] = left; else delete st[k]; }
  });
  if (mem.length) st[mem[0]] = mem.slice();
}

/* Take people / units off every crew (used when they go to a bin). */
function pullOut(day, kind, ids, stamp) {
  Object.values(day.crews || {}).forEach((c) => {
    const key = kind === "person" ? "people" : "iron";
    const n = (c[key] || []).length;
    c[key] = (c[key] || []).filter((x) => !ids.includes(x));
    if (c[key].length !== n) { c.at = stamp.at; c.by = stamp.by; }
  });
}

// eslint-disable-next-line no-unused-vars
function materialize(day, peopleIds, stamp) {
  const before = {};
  Object.values(day.crews).forEach((c) => { before[c.id] = JSON.stringify([c.people, c.iron]); });
  Object.values(day.crews).forEach((c) => { c.people = []; c.iron = []; });
  clusterNodes(yardNodes(day, peopleIds)).forEach((g) => {
    const marker = g.find((n) => n.t === "c");
    if (!marker) return;
    const c = day.crews[marker.id]; if (!c || c.del) return;
    c.people = g.filter((n) => n.t === "p").map((n) => n.id);
    c.iron = g.filter((n) => n.t === "s").sort((a, b) => a.x - b.x).flatMap((n) => day.stacks[n.id] || []);
  });
  Object.values(day.crews).forEach((c) => {
    if (before[c.id] !== JSON.stringify([c.people, c.iron])) { c.at = stamp.at; c.by = stamp.by; }
  });
}

/* Everything on no crew today, grouped the way it is hitched. Built from what
   is actually free right now (the original used the day's stored hitch list,
   which drifted from the crews' own order — loads dragged to the yard then
   "disappeared" because half of their stored group was still on a crew). */
function yardGroups(day, assets) {
  const onCrew = new Set();
  live(day.crews).forEach((c) => (c.iron || []).forEach((x) => onCrew.add(x)));
  const free = (id) => { const a = assets[id]; return a && !a.del && !onCrew.has(id); };
  const seen = new Set(), out = [];
  Object.entries(day.stacks || {}).forEach(([k, mem]) => {
    const all = mem && mem.length ? mem : [k];
    const m = all.filter((x) => free(x) && !seen.has(x));
    if (!m.length) return;
    if (m.length === all.length) { m.forEach((x) => seen.add(x)); out.push({ id: m[0], members: m }); }
    else m.forEach((x) => { seen.add(x); out.push({ id: x, members: [x] }); });
  });
  live(assets).forEach((a) => { if (free(a.id) && !seen.has(a.id)) { seen.add(a.id); out.push({ id: a.id, members: [a.id] }); } });
  return out;
}

const rigOf = (core, assetId) =>
  live(core.rigs || {}).find((r) => r.members.includes(assetId)) || null;

/* ============================ YARD LAYOUT =================================
   Crew boxes go where you put them. What goes inside them snaps to a grid and
   the box grows to fit, so nothing can overlap and nothing drifts.          */

const HEAD = 26;
const BPAD = 12;
const PL_W = 118;
const PL_H = 34;
const PL_COLS = 2;
const SL_W = 50;
const SL_GAP = 8;
const SL_COLS = 4;

function loadDims(members) {
  const lead = members.find((m) => m.hc === "truck") || members[0];
  const tow = members.find((m) => m !== lead && (m.hc === "towed" || m.hc === "trailer"));
  const riders = members.filter((m) => m !== lead && m !== tow);
  const L = shapeOf(lead), T = tow ? shapeOf(tow) : null;
  const strays = T ? [] : riders;
  return {
    w: Math.max(L.w, T ? T.w : 0, ...strays.map((r) => shapeOf(r).w)) + 4,
    h: L.l + (T ? TGAP + T.l : 0) + (strays.length ? TGAP + Math.max(...strays.map((r) => shapeOf(r).l)) : 0) + 10,
  };
}

/* Name plates are as wide as the name (estimated from its length) and flow
   across the box, wrapping like words, instead of fixed-size cells. */
let measureCtx = null;
const textW = (t, bold) => {
  try {
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = `${bold ? 700 : 400} 12.5px 'Barlow Condensed','Arial Narrow',sans-serif`;
    return measureCtx.measureText(t).width + t.length * 12.5 * (bold ? 0.08 : 0.07);   // + letter-spacing
  } catch { return t.length * 8.2; }
};
const plateW = (p, off) => Math.ceil(9 + 22 + 4 + textW(`${p.foreman ? "★ " : ""}${p.d || p.name || ""}`, p.foreman) + (off ? 34 : 0) + (p.foreman ? 4 : 0));
function layoutBox(crew, i, core, hitch, anchors, offOf = () => null, vw = CW) {
  const a = anchors[crew.id] || { x: i * 10, y: 0 };
  const ppl = (crew.people || []).map((id) => core.people[id]).filter((p) => p && !p.del)
    .sort((x, y) => (y.foreman ? 1 : 0) - (x.foreman ? 1 : 0));          // foremen first
  const loads = loadsOf(crew, core.assets).map((l) => ({ ...l, d: hDims(l.members) }));
  const w = Math.max(480, vw - 32);
  // the crew's people ride in its title bar (owner, Nov 24), after the name / ✎ Edit / operation
  const HP = Math.round(16 + 12 + textW(crew.name || "", true) * 1.05 + 62 + 48 + 14);
  const pRight = w - 130;                                    // room for the counts / warnings on the right
  const pSlots = [];
  let px = HP, py = 0;
  ppl.forEach((p) => {
    const pw = Math.min(pRight - HP, plateW(p, offOf(p.id)));
    if (px > HP && px + pw > pRight) { px = HP; py += PL_H - 4; }
    pSlots.push({ p, w: pw, x: px, y: 3 + py });
    px += pw + 6;
  });
  const headH = Math.max(HEAD, ppl.length ? py + PL_H + 2 : HEAD);
  // equipment: from the left edge, each column (a load) a cell, flowing right, + one empty cell
  const x0 = BPAD, EW = w - x0 - BPAD;
  const cSlots = [], lSlots = [];
  let cx = 0, cy = 0, rowH = 0, k = 0;
  const rowsOut = [];
  [...loads, null].forEach((l) => {
    const cw = l ? l.d.w + LOOK().gap : 70, ch = l ? l.d.h + 12 : 56;
    if (cx > 0 && cx + cw > EW) { rowsOut.push(rowH); cy += rowH + 6; cx = 0; rowH = 0; }
    cSlots.push({ k, x: x0 + cx, y: headH + BPAD + cy, w: cw, h: ch, l, row: rowsOut.length });
    cx += cw + 6; rowH = Math.max(rowH, ch); k++;
  });
  rowsOut.push(rowH);
  // stretch each cell to its row's height and centre the load in it
  cSlots.forEach((c) => {
    c.h = rowsOut[c.row];
    if (c.l) lSlots.push({ l: c.l, k: c.k, x: c.x + (c.w - c.l.d.w) / 2, y: c.y + (c.h - c.l.d.h) / 2 });
  });
  const eH = cy + rowH;
  const h = headH + BPAD + eH + BPAD;
  return { crew, hint: a, w, h, ppl, loads, pSlots, lSlots, cSlots, headH };
}

const snap24 = (v) => Math.round(v / 24) * 24;

/* Boxes are packed into rows rather than placed at raw coordinates, so two of
   them can never sit on top of each other. Moving a box changes where it sits
   in the order; the packer puts it there and shuffles the rest along.       */
function packBoxes(sized, CW) {
  const G = 16;
  const order = sized.slice().sort((a, b) => (a.hint.y - b.hint.y) || (a.hint.x - b.hint.x));
  let x = G, y = G, rowH = 0;
  return order.map((b) => {
    if (x + b.w + G > CW && x > G) { x = G; y += rowH + G; rowH = 0; }
    const placed = { ...b, x, y };
    x += b.w + G;
    rowH = Math.max(rowH, b.h);
    return placed;
  });
}

/* ============================ DRAG ENGINE ================================
   Pointer-based, so it works with a mouse and with a thumb. Drop zones
   register their DOM node; hit-testing picks the smallest matching rect.    */

/* Rebuilt for smoothness (the owner found the original jumpy):
   • A drag starts only after the pointer really moves (6 px mouse, 10 px
     touch), so a click stays a click. Only the week "paint" markers start at once.
   • The ghost follows the pointer by moving its own element (no React render
     per mouse move); the board re-renders only when the target under the
     pointer changes.
   • Dropping back where the item came from (item.from) does nothing.
   • The click that ends a drag is swallowed, so it doesn't also open a sheet.
   • Escape cancels; near the edges the canvas (and page) scroll by themselves. */
function useDragEngine() {
  const zones = useRef(new Map());
  const st = useRef(null);
  const ghostRef = useRef(null);
  const [drag, setDrag] = useState(null);     // { item, over, x, y } — changes on start, target change, end

  const registerZone = useCallback((id, el, meta) => {
    if (el) zones.current.set(id, { el, meta });
    else zones.current.delete(id);
  }, []);

  const hit = (x, y, kind) => {
    let best = null, bestArea = Infinity;
    zones.current.forEach((z, id) => {
      if (!z.meta.accepts.includes(kind)) return;
      const r = z.el.getBoundingClientRect();
      if (r.width === 0) return;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (area < bestArea) { bestArea = area; best = { id, meta: z.meta, r }; }
      }
    });
    return best;
  };

  const placeGhost = () => {
    const s = st.current, g = ghostRef.current;
    if (s && g) g.style.transform = `translate3d(${Math.round(s.x - s.ox)}px, ${Math.round(s.y - s.oy)}px, 0)`;
  };

  const finish = () => {
    const s = st.current; st.current = null;
    if (s && s.timer) clearInterval(s.timer);
    document.body.style.userSelect = ""; document.body.style.webkitUserSelect = ""; document.body.style.cursor = "";
    setDrag(null);
    return s;
  };

  const begin = useCallback((e, item) => {
    if (e.button != null && e.button > 0) return;
    const br = e.currentTarget ? e.currentTarget.getBoundingClientRect() : { left: e.clientX, top: e.clientY };
    const paintNow = item.kind === "marker" && item.instant === true;
    st.current = {
      item, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      // keep the ghost under the pointer where it was grabbed (capped, since grips are small)
      ox: Math.min(Math.max(0, e.clientX - br.left), 28), oy: Math.min(Math.max(0, e.clientY - br.top), 18),
      active: paintNow, painted: null, over: null,
      axis: item.axis || "free", ptr: e.pointerType || "mouse",
    };
    if (paintNow) setDrag({ item, x: e.clientX, y: e.clientY, over: null });
  }, []);

  useEffect(() => {
    const autoScroll = () => {
      const s = st.current; if (!s || !s.active) return;
      const edge = 56, step = (d) => Math.ceil(((edge - d) / edge) * 18);
      const wrap = document.querySelector(".mb .canvas-wrap");
      if (wrap) {
        const r = wrap.getBoundingClientRect();
        if (s.y > r.top && s.y < r.bottom) {
          if (s.x < r.left + edge && s.x > r.left - 20) wrap.scrollLeft -= step(s.x - r.left);
          else if (s.x > r.right - edge && s.x < r.right + 20) wrap.scrollLeft += step(r.right - s.x);
        }
      }
      if (s.y < edge) window.scrollBy(0, -step(s.y));
      else if (s.y > window.innerHeight - edge) window.scrollBy(0, step(window.innerHeight - s.y));
    };
    const move = (e) => {
      const s = st.current; if (!s) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.active) {
        const need = s.ptr === "touch" ? 10 : 6;
        if (s.axis === "x") {
          if (Math.abs(dx) < need || Math.abs(dx) < Math.abs(dy)) return;
        } else if (Math.hypot(dx, dy) < need) return;
        s.active = true;
        document.body.style.userSelect = "none"; document.body.style.webkitUserSelect = "none"; document.body.style.cursor = "grabbing";
        s.timer = setInterval(autoScroll, 16);
        setDrag({ item: s.item, x: e.clientX, y: e.clientY, over: null });
      }
      s.x = e.clientX; s.y = e.clientY;
      if (e.cancelable) e.preventDefault();
      if (!s.raf) s.raf = requestAnimationFrame(() => { if (st.current) { st.current.raf = 0; placeGhost(); } });
      const over = hit(e.clientX, e.clientY, s.item.kind);
      const id = over ? over.id : null;
      if (id !== s.over) { s.over = id; setDrag((d) => (d ? { ...d, over: id } : d)); }
      if (over && over.meta.paint && over.id !== s.painted) {
        s.painted = over.id;
        over.meta.onDrop(s.item, over.id);
      }
    };
    const up = (e) => {
      const s = st.current; if (!s) return;
      if (s.active) {
        const over = hit(e.clientX, e.clientY, s.item.kind);
        // swallow the click that follows a drag, so it doesn't open a sheet
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 350);
        finish();
        if (over && !over.meta.paint && over.id !== s.item.from) {
          over.meta.onDrop(s.item, over.id,
            { x: e.clientX - over.r.left - (s.ox || 0), y: e.clientY - over.r.top - (s.oy || 0) });
        }
        return;
      }
      st.current = null;       // a plain click: let it through untouched
    };
    const cancel = () => { if (st.current) finish(); };
    const key = (e) => { if (e.key === "Escape" && st.current && st.current.active) finish(); };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  return { drag, begin, registerZone, ghostRef };
}

function Zone({ id, accepts, onDrop, paint, registerZone, children, style, className, onClick }) {
  const ref = useRef(null);
  const cb = useRef({ onDrop, accepts, paint });
  cb.current = { onDrop, accepts, paint };
  useEffect(() => {
    registerZone(id, ref.current, {
      get accepts() { return cb.current.accepts; },
      get paint() { return cb.current.paint; },
      onDrop: (...a) => cb.current.onDrop(...a),
    });
    return () => registerZone(id, null);
  }, [id, registerZone]);
  return <div ref={ref} className={className} style={style} onClick={onClick}>{children}</div>;
}

/* ============================ STYLES ====================================== */
/* Every rule is prefixed with .mb so the board's classes (.btn, .tab, .chip…)
   can't restyle the rest of Dispatch while the board is open. */
function scopeCss(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "", buf = "", i = 0;
  const copyBlock = () => {            // copy from the "{" at i through its matching "}"
    let depth = 0, start = i;
    for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") { depth--; if (!depth) { i++; break; } } }
    return css.slice(start, i);
  };
  const walk = (end) => {
    while (i < end) {
      const ch = css[i];
      if (ch === "{") {
        const sel = buf.trim(); buf = "";
        if (/^@(media|supports)/.test(sel)) {
          out += sel + "{"; i++;
          let depth = 1, j = i;
          for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}") { depth--; if (!depth) break; } }
          walk(j); out += "}"; i = j + 1;
        } else if (/^@/.test(sel)) {
          out += sel + copyBlock();
        } else {
          out += sel.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x.startsWith(".mb") ? x : `.mb ${x}`)).join(", ") + copyBlock();
        }
      } else { buf += ch; i++; }
    }
  };
  walk(css.length);
  return out;
}
const CSS = scopeCss(`

.mb *, .mb *::before, .mb *::after { box-sizing: border-box; }
.mb {
  --bg:${C.bg}; --panel:${C.panel}; --tile:${C.tile}; --edge:${C.edge};
  --ink:${C.ink}; --dim:${C.inkDim}; --faint:${C.inkFaint};
  --mach:#7E8B95; --mach-lo:#59646D; --mach-hi:#AEB9C1;
  font-family:'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;
  background:var(--bg); color:var(--ink);
  -webkit-font-smoothing:antialiased; padding-bottom:70px;
}
.mb button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
.mb :focus-visible { outline:2px solid ${C.ink}; outline-offset:2px; border-radius:2px; }
.stencil { font-family:'Barlow Condensed','Arial Narrow',sans-serif; text-transform:uppercase; letter-spacing:.055em; font-weight:600; }
.mono { font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }

/* --- header: hairline chevron band, the only decorative element ---------- */
.hd { position:relative; z-index:2; background:${C.panel}; border-bottom:1px solid var(--edge); }
.chev { height:5px; background:repeating-linear-gradient(115deg,${C.edge} 0 9px,transparent 9px 18px); }
.hd-in { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:11px 16px 9px; }
.hd.slim .hd-in { padding:3px 14px; gap:10px; }
.hd.slim .tab { padding:4px 11px; font-size:12px; }
.hd.slim .btn { padding:4px 10px; }
.hd.inpage { background:transparent; border-bottom:0; }
.hd.inpage .hd-in { padding:6px 16px 0; gap:10px; }
.hd.inpage .tabs { background:transparent; border:0; }
.hd.inpage .tab { border-bottom:2px solid transparent; border-radius:0; padding:5px 10px; }
.hd.inpage .tab[aria-selected="true"] { background:transparent; box-shadow:none; border-bottom-color:${C.ink}; color:var(--ink); }
.hd.inpage .btn { padding:4px 10px; }
.mb.mb-sub { padding-bottom:0 !important; display:flex; align-items:center; gap:8px; flex-wrap:nowrap; background:transparent !important; min-height:0 !important; }
.mb.mb-sub .tab { padding:5px 11px; }
.mb.mb-sub .btn { padding:4px 10px; }
.mb.mb-sub .tabs { flex-wrap:nowrap; }
.mb.mb-sub .tab, .mb.mb-sub .btn, .mb.mb-sub .sync { white-space:nowrap; flex-shrink:0; }
@media (max-width:640px){
  .hd .hd-in { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; padding:4px 8px; gap:6px; }
  .hd .hd-in::-webkit-scrollbar { display:none; }
  .hd .tabs { flex-wrap:nowrap; flex-shrink:0; }
  .hd .tab { white-space:nowrap; padding:5px 8px; font-size:11.5px; }
  .hd .spacer, .hd .who { display:none; }
  .hd .btn, .hd .sync { white-space:nowrap; flex-shrink:0; }
}
.brand { font-size:19px; line-height:1; font-weight:700; letter-spacing:.09em; }
.brand small { display:block; font-size:10.5px; color:var(--faint); letter-spacing:.14em; margin-top:4px; font-weight:500; }
.tabs { display:flex; gap:2px; background:${C.bg}; border:1px solid var(--edge); border-radius:3px; padding:2px; }
.tab { padding:6px 13px; font-size:12.5px; border-radius:2px; color:var(--dim); }
.tab[aria-selected="true"] { background:${C.tileHi}; color:var(--ink); box-shadow:inset 0 1px 0 #3b464e; }
.spacer { flex:1 1 40px; }
.sync { display:flex; align-items:center; gap:7px; font-size:11px; color:var(--faint); letter-spacing:.04em; }
.dot { width:6px; height:6px; border-radius:50%; background:${ST.running.color}; }
.dot.warn { background:${ST.watch.color}; }
.dot.err { background:${ST.tagged.color}; }
@media (prefers-reduced-motion:no-preference){ .dot.beat { animation:beat 2.4s ease-in-out infinite; } }
@keyframes beat { 0%,100%{opacity:1} 50%{opacity:.32} }
.who { display:flex; gap:5px; align-items:center; }
.who span { font-size:10px; padding:3px 7px; border:1px solid var(--edge); border-radius:2px; color:var(--dim); letter-spacing:.07em; }

/* --- status ribbon: counts double as drop targets ------------------------ */
.rib > div { flex:0 0 auto; }
.rib { display:flex; gap:8px; padding:10px 16px; overflow-x:auto; border-bottom:1px solid ${C.edgeSoft}; background:${C.bg}; scrollbar-width:thin; }
.rp { flex:0 0 auto; min-width:118px; text-align:left; padding:8px 12px 9px; background:${C.panel};
      border:1px solid var(--edge); border-left-width:3px; border-radius:3px; transition:background .12s,transform .12s; }
.rp b { display:block; font-size:23px; line-height:1; font-weight:500; }
.rp i { display:block; font-style:normal; font-size:10.5px; letter-spacing:.1em; color:var(--dim); margin-top:5px; }
.rp[data-on="1"] { background:${C.tileHi}; }
.rp[data-hot="1"] { transform:translateY(-2px); background:${C.tileHi}; box-shadow:0 0 0 1px var(--ink); }

/* --- toolbar ------------------------------------------------------------- */
.tb { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid ${C.edgeSoft}; }
.chip { font-size:11px; letter-spacing:.07em; padding:5px 10px; border:1px solid var(--edge); border-radius:2px; color:var(--dim); }
.chip[data-on="1"] { background:${C.tileHi}; color:var(--ink); border-color:#48555e; }
.srch { background:${C.bg}; border:1px solid var(--edge); border-radius:2px; color:var(--ink);
        padding:6px 10px; font-size:12.5px; width:150px; font-family:inherit; }
.srch::placeholder { color:var(--faint); }

/* --- fleet columns ------------------------------------------------------- */
.cols { display:flex; gap:11px; padding:13px 16px 26px; overflow-x:auto; align-items:flex-start; scroll-snap-type:x proximity; }
.col[data-wide="1"] { flex:1 1 560px; }
.col[data-wide="1"] .col-b { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); align-items:start; }
.col { flex:0 0 254px; scroll-snap-align:start; background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; }
.col-h { display:flex; align-items:baseline; gap:7px; padding:9px 11px; border-bottom:1px solid ${C.edgeSoft}; border-top:3px solid; border-radius:4px 4px 0 0; }
.col-h em { font-style:normal; font-size:12px; letter-spacing:.1em; }
.col-h u { text-decoration:none; margin-left:auto; font-size:11.5px; color:var(--faint); }
.col-b { padding:7px; display:flex; flex-direction:column; gap:5px; min-height:104px; transition:background .12s; }
.col-b[data-hot="1"] { background:#20282e; box-shadow:inset 0 0 0 1px #4b585f; }
.empty { font-size:11.5px; color:var(--faint); letter-spacing:.05em; padding:16px 4px; text-align:center; line-height:1.5; }

/* --- the tile: a magnet on a steel board --------------------------------- */
.tile { display:flex; background:${C.tile}; border:1px solid var(--edge); border-radius:3px;
        box-shadow:0 1px 0 #10151a, 0 2px 5px rgba(0,0,0,.32); overflow:hidden; text-align:left; width:100%; }
.tile:hover { background:${C.tileHi}; }
.grip { flex:0 0 15px; touch-action:none; cursor:grab; border-right:1px solid var(--edge);
        background:repeating-linear-gradient(180deg,transparent 0 3px,#39444c 3px 4px); }
.grip:active { cursor:grabbing; }
.tile-b { flex:1; padding:8px 10px 9px; min-width:0; text-align:left; }
.tile-t { display:flex; align-items:center; gap:7px; }
.tile-t em { font-style:normal; font-size:13.5px; line-height:1.15; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile-s { font-size:10.5px; color:var(--faint); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile-f { display:flex; align-items:center; gap:8px; margin-top:8px; padding-top:7px; border-top:1px solid ${C.edgeSoft}; }
.tile-f .mono { font-size:10.5px; color:var(--dim); }
.tile-f u { text-decoration:none; margin-left:auto; font-size:10px; letter-spacing:.06em; color:var(--dim);
            border:1px solid var(--edge); padding:2px 5px; border-radius:2px; white-space:nowrap; }
.wrench { display:inline-flex; align-items:center; gap:3px; font-size:10px; letter-spacing:.04em; }

/* tagged out gets the physical treatment of a real danger tag */
.tile[data-st="tagged"] { background:
  repeating-linear-gradient(135deg, rgba(217,59,43,.11) 0 7px, transparent 7px 14px), ${C.tile}; }
.tile[data-st="tagged"] .grip { background:repeating-linear-gradient(135deg,${ST.tagged.color} 0 4px,#2a1a19 4px 8px); }
.tile[data-st="parked"] { opacity:.72; }
.tile-sm { border-width:2px; border-color:var(--edge); }
.tile-sm[data-st="running"] { border-color:var(--edge) !important; border-width:1px; }
.tile-sm .grip { flex-basis:11px; }
.tile-sm .tile-b { display:flex; align-items:center; gap:8px; padding:5px 8px; }
.tile-sm .tile-name { margin-top:0; font-size:12.5px; display:block; }
.tile-sm .tile-sub { display:block; font-size:9.5px; }
.sm-ic { flex:0 0 30px; display:flex; align-items:flex-end; justify-content:center; }
.sm-t { flex:1; min-width:0; display:block; }
.sm-st { flex:none; font-size:9px; letter-spacing:.08em; border:1px solid; border-radius:2px; padding:1px 4px; }

.bar { flex:0 0 4px; }
@media (prefers-reduced-motion:no-preference){ .flash { animation:flash 1.6s ease-out 1; } }
@keyframes flash { 0%{box-shadow:0 0 0 2px ${C.ink}} 100%{box-shadow:0 1px 0 #10151a} }

/* --- placard: a person, in hard-hat-sticker form ------------------------- */
.plc { display:inline-flex; align-items:stretch; background:${C.tile}; border:1px solid var(--edge);
       border-radius:2px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,.3); max-width:100%; }
.plc-g { flex:0 0 9px; touch-action:none; cursor:grab; background:repeating-linear-gradient(180deg,transparent 0 2px,#3b464e 2px 3px); border-right:1px solid var(--edge); }
.plc-n { padding:4px 8px; font-size:11px; text-align:left; letter-spacing:.07em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.plc-s { flex:0 0 4px; }

/* --- crews --------------------------------------------------------------- */
.crews { display:grid; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); gap:11px; padding:13px 16px 26px; }
.crew { background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; border-top:3px solid ${C.edge}; }
.crew[data-down="1"] { border-top-color:${ST.tagged.color}; }
.crew[data-thin="1"] { border-top-color:${ST.watch.color}; }
.crew-h { display:flex; align-items:center; gap:8px; padding:9px 11px 8px; border-bottom:1px solid ${C.edgeSoft}; }
.crew-h em { font-style:normal; font-size:14px; letter-spacing:.08em; }
.crew-h u { text-decoration:none; font-size:9.5px; letter-spacing:.1em; color:var(--faint); border:1px solid var(--edge); padding:2px 5px; border-radius:2px; }
.crew-w { margin-left:auto; font-size:10px; letter-spacing:.06em; color:var(--dim); text-align:right; }
.sec { padding:9px 11px 11px; }
.sec-l { font-size:9.5px; letter-spacing:.16em; color:var(--faint); margin-bottom:7px; }
.drop { display:flex; flex-wrap:wrap; gap:5px; min-height:34px; padding:5px; border:1px dashed ${C.edgeSoft}; border-radius:3px; transition:background .12s; }
.drop[data-hot="1"] { background:#20282e; border-color:#5b686f; border-style:solid; }
.mini { display:inline-flex; align-items:center; gap:5px; background:${C.tile}; border:1px solid var(--edge);
        border-left-width:3px; border-radius:2px; padding:3px 7px 3px 5px; font-size:10.5px; letter-spacing:.05em; max-width:100%; }
.mini-g { touch-action:none; cursor:grab; letter-spacing:0; color:var(--faint); }

/* --- week ---------------------------------------------------------------- */
.wk-tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:11px 16px 0; }
.marker { display:flex; align-items:center; gap:6px; padding:5px 10px 5px 7px; border:1px solid var(--edge);
          border-radius:2px; font-size:11px; letter-spacing:.07em; color:var(--dim); touch-action:none; }
.marker[data-on="1"] { background:${C.tileHi}; color:var(--ink); border-color:#4d5a62; }
.swatch { width:11px; height:11px; border-radius:1px; }
.wk-wrap { padding:12px 16px 26px; overflow-x:auto; }
.wk { display:grid; min-width:660px; border:1px solid ${C.edgeSoft}; border-radius:4px; background:${C.panel}; }
.wk-hc { padding:8px 6px; text-align:center; font-size:11px; letter-spacing:.09em; border-bottom:1px solid var(--edge); border-left:1px solid ${C.edgeSoft}; }
.wk-hc small { display:block; font-size:9.5px; color:var(--faint); letter-spacing:.06em; margin-top:3px; font-weight:500; }
.wk-hc[data-today="1"] { background:${C.tileHi}; }
.wk-hn { padding:8px 10px; font-size:9.5px; letter-spacing:.16em; color:var(--faint); border-bottom:1px solid var(--edge); position:sticky; left:0; background:${C.panel}; z-index:2; }
.wk-rn { display:flex; align-items:center; gap:6px; padding:5px 8px 5px 10px; font-size:11px; letter-spacing:.05em;
         border-bottom:1px solid ${C.edgeSoft}; position:sticky; left:0; background:${C.panel}; z-index:2; }
.wk-rn .pc { flex:0 0 4px; align-self:stretch; border-radius:1px; }
.wk-rn .pn { text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.wk-rn .pn:hover { color:#fff; }
.wk-rn .mf { margin-left:auto; font-size:9px; color:var(--faint); border:1px solid var(--edge); padding:1px 4px; border-radius:2px; flex:0 0 auto; }
.wk-rn .mf:hover { color:var(--ink); border-color:#4d5a62; }
.cell { border-left:1px solid ${C.edgeSoft}; border-bottom:1px solid ${C.edgeSoft}; padding:3px;
        touch-action:pan-y; cursor:pointer; min-height:31px; display:flex; align-items:stretch; }
.cell span { flex:1; border-radius:2px; display:flex; align-items:center; justify-content:center;
             font-size:9.5px; letter-spacing:.09em; color:#0f1418; font-weight:600;
             font-family:'Barlow Condensed',sans-serif; }
.cell[data-hot="1"] { box-shadow:inset 0 0 0 1px var(--ink); }
.cell[data-wknd="1"] { background:#181d22; }
.legend { display:flex; gap:13px; flex-wrap:wrap; padding:0 16px 20px; font-size:10.5px; color:var(--faint); letter-spacing:.05em; }
.legend i { display:inline-flex; align-items:center; gap:5px; font-style:normal; }

/* --- sheets -------------------------------------------------------------- */
.scrim { position:fixed; inset:0; background:rgba(8,11,14,.72); z-index:60; display:flex;
         align-items:flex-end; justify-content:center; padding:0; }
@media (min-width:640px){ .scrim { align-items:center; padding:24px; } }
.sheet { background:${C.panel}; border:1px solid var(--edge); border-radius:5px 5px 0 0; width:100%;
         max-width:520px; max-height:88vh; overflow:auto; }
@media (min-width:640px){ .sheet { border-radius:5px; } }
.sheet-h { display:flex; align-items:flex-start; gap:11px; padding:14px 16px; border-bottom:1px solid var(--edge); position:sticky; top:0; background:${C.panel}; }
.sheet-h em { font-style:normal; font-size:17px; letter-spacing:.06em; display:block; }
.sheet-h small { display:block; font-size:11px; color:var(--faint); margin-top:4px; }
.sheet-b { padding:14px 16px 20px; }
.fl { font-size:9.5px; letter-spacing:.16em; color:var(--faint); margin:15px 0 8px; }
.fl:first-child { margin-top:0; }
.opts { display:flex; flex-wrap:wrap; gap:6px; }
.opt { display:flex; align-items:center; gap:7px; padding:7px 11px; border:1px solid var(--edge); border-radius:2px; font-size:11.5px; letter-spacing:.05em; color:var(--dim); }
.opt[data-on="1"] { background:${C.tileHi}; color:var(--ink); border-color:#4d5a62; }
.kv { display:grid; grid-template-columns:104px 1fr; gap:5px 11px; font-size:11.5px; }
.kv dt { color:var(--faint); letter-spacing:.06em; }
.kv dd { margin:0; color:var(--ink); }
.ta { width:100%; background:${C.bg}; border:1px solid var(--edge); border-radius:2px; color:var(--ink);
      padding:8px 10px; font-size:12.5px; font-family:inherit; resize:vertical; min-height:56px; }
.act { display:flex; gap:8px; flex-wrap:wrap; margin-top:18px; padding-top:14px; border-top:1px solid ${C.edgeSoft}; }
.btn { padding:8px 14px; border:1px solid var(--edge); border-radius:2px; font-size:11.5px; letter-spacing:.07em; color:var(--ink); }
.btn:hover { background:${C.tileHi}; }
.btn[data-danger="1"] { border-color:#5c2e2a; color:#E8867B; }

/* --- log ---------------------------------------------------------------- */
.log { padding:0 16px 30px; }
.log h4 { font-size:9.5px; letter-spacing:.16em; color:var(--faint); margin:0 0 9px; font-weight:600; font-family:'Barlow Condensed',sans-serif; }
.log ol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:1px; }
.log li { display:flex; gap:10px; font-size:11.5px; padding:6px 0; border-bottom:1px solid ${C.edgeSoft}; color:var(--dim); }
.log li b { font-weight:500; color:var(--ink); }
.log time { margin-left:auto; color:var(--faint); font-size:10.5px; white-space:nowrap; }

/* --- ghost -------------------------------------------------------------- */
.ghost { position:fixed; left:0; top:0; z-index:200; pointer-events:none; will-change:transform; }
.ghost > :first-child { transform:rotate(-1.2deg) scale(1.04); box-shadow:0 12px 26px rgba(0,0,0,.55); opacity:.97; }
.ghost-shape { display:block; filter:grayscale(1) brightness(1.55); opacity:.8; }
.cslot { position:absolute; border-radius:4px; border:1px dashed transparent; transition:background .1s, border-color .1s; }
.cslot.empty { border-color:#2f3a42; display:flex; align-items:center; justify-content:center; color:#4a565f; font-size:18px; }
.cslot.ready { border-color:#4b5963; }
.cslot.empty.ready { border-color:#7d8b94; color:#9aa6ae; background:rgba(125,139,148,.06); }
.cslot.hot { border:2px solid #E7E2D6; background:rgba(231,226,214,.12); box-shadow:0 0 0 3px rgba(231,226,214,.12); }
.ghost-to { margin-top:6px; display:inline-block; font-size:10.5px; letter-spacing:.08em; padding:3px 8px; border-radius:2px;
            background:#17A05B; color:#08130c; white-space:nowrap; }
.ghost-to.none { background:#2a333a; color:var(--dim); }
.cbox { transition: left .22s ease, top .22s ease, width .18s ease, height .18s ease, background .12s, box-shadow .12s, opacity .12s; }
.cbox.lifted { opacity:.35; }
.slot { transition: left .18s ease, top .18s ease; }
.newcrew { position:absolute; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
           border:1.5px dashed #3e4a52; border-radius:5px; color:var(--faint); text-align:center; padding:10px;
           transition: left .22s ease, top .22s ease, background .12s, border-color .12s, color .12s; }
.newcrew b { font-family:'Barlow Condensed',sans-serif; font-weight:600; letter-spacing:.1em; font-size:13px; color:var(--dim); }
.newcrew span { font-size:10.5px; line-height:1.4; }
.newcrew.ready { border-color:#5b686f; color:var(--dim); }
.newcrew.hot { background:#20282e; border-color:#17A05B; border-style:solid; }
.newcrew.hot b { color:var(--ink); }
.gate { max-width:392px; margin:14vh auto; padding:24px; background:${C.panel}; border:1px solid var(--edge); border-radius:4px; }
.gate h2 { font-size:17px; letter-spacing:.07em; margin:0 0 8px; font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; }
.gate p { font-size:12.5px; color:var(--dim); line-height:1.55; margin:0 0 16px; }
.gate input { width:100%; background:${C.bg}; border:1px solid var(--edge); border-radius:2px; color:var(--ink); padding:9px 11px; font-size:13px; font-family:inherit; }

/* --- operations ---------------------------------------------------------- */
.optag { display:inline-flex; align-items:center; gap:3px; font-size:9px; letter-spacing:.09em;
         color:var(--dim); border:1px solid var(--edge); border-radius:2px; padding:1px 4px 2px; }
.ops { display:flex; gap:3px; flex-wrap:wrap; }
.vr { width:1px; height:20px; background:var(--edge); margin:0 3px; flex:0 0 auto; }
.attn { display:flex; gap:9px; align-items:center; padding:10px 16px 2px; flex-wrap:wrap; }
.note { padding:2px 16px 22px; font-size:11px; color:var(--faint); letter-spacing:.03em; max-width:600px; line-height:1.5; }
.hint { font-size:10.5px; color:var(--faint); padding:5px 3px; }

/* --- machine tile -------------------------------------------------------- */
.mach-wrap { padding:3px 5px 0; }
.mach { display:block; }
.tile-name { font-size:14px; letter-spacing:.06em; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile-sub { font-size:10px; color:var(--faint); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tile-foot { display:flex; align-items:center; gap:7px; margin-top:8px; padding-top:7px; border-top:1px solid ${C.edgeSoft}; }
.tile-foot u { text-decoration:none; margin-left:auto; font-size:9px; letter-spacing:.06em; color:var(--dim);
               border:1px solid var(--edge); padding:2px 5px; border-radius:2px; white-space:nowrap;
               max-width:104px; overflow:hidden; text-overflow:ellipsis; }
.plc-c { flex:0 0 6px; }
.crew-t { display:flex; gap:8px; align-items:center; }
.crew-h u { display:inline-flex; align-items:center; gap:3px; }
.mini-b { display:flex; gap:6px; align-items:center; }

/* --- condition dock: big targets while a unit is in hand ----------------- */
.dock { position:fixed; left:0; right:0; bottom:0; z-index:150; display:flex; align-items:center; gap:12px;
        padding:10px 14px; padding-bottom:calc(10px + env(safe-area-inset-bottom));
        background:rgba(19,23,27,.97); border-top:1px solid var(--edge);
        transform:translateY(108%); pointer-events:none; }
.dock[data-on="1"] { transform:translateY(0); pointer-events:auto; }
@media (prefers-reduced-motion:no-preference){ .dock { transition:transform .16s ease-out; } }
.dock-l { font-size:9.5px; letter-spacing:.14em; color:var(--faint); flex:0 0 auto; }
.dock-r { display:flex; gap:7px; flex:1; }
.dock-r > div { flex:1; }
.dz { display:flex; align-items:center; justify-content:center; gap:6px; padding:14px 6px;
      border:1px solid; border-radius:3px; font-size:10.5px; letter-spacing:.07em;
      color:var(--dim); background:${C.panel}; text-align:center; }
.dz[data-hot="1"] { background:${C.tileHi}; color:var(--ink); box-shadow:inset 0 0 0 2px currentColor; }

@media (max-width:660px){
  .dock { flex-direction:column; align-items:stretch; gap:7px; }
  .dock-l { text-align:center; }
  .dock-r { flex-wrap:wrap; }
  .dock-r > div { flex:1 1 30%; }
  .dz { padding:16px 4px; font-size:10px; }
  .col { flex:0 0 82vw; }
  .cols { padding-bottom:132px; }
}

/* --- day sheet ----------------------------------------------------------- */
.btn[data-primary="1"] { border-color:#4f5c65; background:${C.tileHi}; }
.btn[data-primary="1"]:hover { background:#333e46; }
.note-out { min-height:132px; font-family:'IBM Plex Mono',monospace; font-size:11.5px; line-height:1.65; }
.row-between { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; }
.lnk { font-size:10.5px; letter-spacing:.07em; color:var(--dim); border-bottom:1px solid var(--edge); }
.lnk:hover { color:var(--ink); }
.flags { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
.flags li { font-size:11.5px; color:var(--dim); padding:5px 9px; background:${C.bg};
            border:1px solid ${C.edgeSoft}; border-radius:2px; }
.okmsg { font-size:11px; letter-spacing:.07em; color:${ST.running.color}; align-self:center; }

/* --- the day ------------------------------------------------------------- */
.daybar { border-bottom:1px solid ${C.edgeSoft}; }
.daydate { font-size:14px; letter-spacing:.09em; min-width:112px; text-align:center; }
.inherit { font-size:10px; letter-spacing:.08em; color:${ST.watch.color}; border:1px solid #4a3d1c;
           background:#241f10; padding:3px 8px; border-radius:2px; }
.crew-p { display:flex; flex-wrap:wrap; gap:5px; min-height:34px; padding:8px 10px;
          border-bottom:1px solid ${C.edgeSoft}; transition:background .12s; }
.crew-p[data-hot="1"] { background:#20282e; box-shadow:inset 0 0 0 1px #5b686f; }
.crew-l { display:flex; flex-direction:column; gap:7px; padding:9px 10px 11px; min-height:52px; transition:background .12s; }
.crew-l[data-hot="1"] { background:#20282e; box-shadow:inset 0 0 0 1px #5b686f; }

/* --- a load: truck, what it tows, what rides on it ---------------------- */
.load { display:flex; background:${C.tile}; border:1px solid var(--edge); border-radius:3px; overflow:hidden;
        box-shadow:0 1px 0 #10151a; transition:background .12s; }
.load[data-hot="1"] { background:${C.tileHi}; box-shadow:inset 0 0 0 1px var(--ink); }
.load[data-locked="1"] { border-left:3px solid #6f7b84; }
.load-g { flex:0 0 14px; touch-action:none; cursor:grab; border-right:1px solid var(--edge);
          background:repeating-linear-gradient(180deg,transparent 0 3px,#39444c 3px 4px); }
.load-b { flex:1; min-width:0; padding:6px 9px 8px; }
.load-t { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-top:5px; }
.mtag { font-size:10px; letter-spacing:.07em; color:var(--dim); border-bottom:2px solid; padding:1px 1px 2px; }
.mtag:hover { color:var(--ink); }
.load-a { margin-left:auto; }
.load-warn { margin-top:5px; font-size:9.5px; letter-spacing:.09em; color:${ST.tagged.color}; }

/* --- the yard ----------------------------------------------------------- */
.yard { margin:6px 16px 28px; background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px;
        transition:background .12s; }
.yard[data-hot="1"] { background:#20282e; box-shadow:inset 0 0 0 1px #5b686f; }
.yard-h { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:9px 12px;
          border-bottom:1px solid ${C.edgeSoft}; font-size:9.5px; letter-spacing:.16em; color:var(--faint); }
.yard-row { display:flex; gap:11px; padding:8px 12px; border-bottom:1px solid ${C.edgeSoft}; }
.yard-row:last-child { border-bottom:0; }
.yard-l { flex:0 0 86px; font-size:9.5px; letter-spacing:.13em; color:var(--faint); padding-top:4px; }
.yard-i { flex:1; display:flex; flex-wrap:wrap; gap:5px; min-width:0; }
.rig { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; letter-spacing:.05em;
       background:${C.tile}; border:1px solid #4d5a62; border-left:3px solid #6f7b84;
       border-radius:2px; padding:3px 8px 3px 5px; }
.rig-out { opacity:.45; }
@media (max-width:660px){
  .yard-row { flex-direction:column; gap:5px; }
  .yard-l { flex:none; }
}

.mchip { display:inline-flex; align-items:stretch; border:1px solid ${C.edgeSoft}; border-radius:2px; overflow:hidden; }
.mchip-g { width:8px; touch-action:none; cursor:grab; border-right:1px solid ${C.edgeSoft};
           background:repeating-linear-gradient(180deg,transparent 0 2px,#3b464e 2px 3px); }
.mchip:hover { border-color:var(--edge); }
.mtag { border-bottom-width:2px; border-bottom-style:solid; padding:2px 6px; }
.load-odd { margin-top:4px; font-size:9.5px; letter-spacing:.07em; color:${ST.watch.color}; }

/* --- calendar strip ------------------------------------------------------ */
.wkpick { background:${C.bg}; color:var(--ink); border:1px solid var(--edge); border-radius:2px;
          padding:6px 8px; font-size:11px; letter-spacing:.06em; font-family:'Barlow Condensed',sans-serif;
          text-transform:uppercase; max-width:158px; }
.cal { display:flex; align-items:center; justify-content:center; gap:5px; padding:5px 16px;
       flex-wrap:wrap; border-bottom:1px solid ${C.edgeSoft}; }
.calday { display:flex; align-items:baseline; gap:5px; min-width:0;
          padding:4px 9px; border:1px solid var(--edge); border-radius:3px; color:var(--dim); }
.calday em { font-style:normal; font-size:9px; letter-spacing:.1em; }
.calday b { font-weight:500; font-size:13px; line-height:1; font-family:'IBM Plex Mono',monospace; }
.calday i { width:4px; height:4px; border-radius:50%; background:transparent; align-self:center; }
.calday i[data-saved="1"] { background:${ST.running.color}; }
.calday[data-today="1"] { border-color:#55636c; }
.calday[data-on="1"] { background:${C.tileHi}; color:var(--ink); border-color:#6b7880; box-shadow:inset 0 0 0 1px #6b7880; }
.btn[disabled] { opacity:.4; cursor:default; }

/* --- yard bar ------------------------------------------------------------ */
.ybar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 16px 22px;
        border-top:1px solid ${C.edgeSoft}; margin-top:2px; }
.lgs { display:flex; flex-wrap:wrap; gap:3px 13px; }
.lg { display:inline-flex; align-items:center; gap:5px; font-size:9.5px; color:var(--faint); letter-spacing:.03em; }
.lg i { width:11px; height:11px; border-radius:2px; display:block; }
.lg .ring { background:none; border:1.5px dashed ${ST.tagged.color}; }

/* --- the yard ------------------------------------------------------------ */
.oy-g { display:grid; grid-template-columns:186px minmax(0,1fr) 400px;
        grid-template-areas:"left canvas right"; gap:10px; padding:10px 16px 4px; }
.left { grid-area:left; display:flex; flex-direction:column; gap:10px; }
.left > div { flex:1; display:flex; }
.left > div:not(:first-child) { flex:0 1 auto; min-height:110px; }
.left > div:first-child { flex:0 1 auto; max-height:34vh; }           /* crew room: shorter (owner, Nov 25) */
.left > div:first-child .bin-b { overflow:auto; }
.canvas-wrap { grid-area:canvas; overflow:auto; border:1px solid ${C.edgeSoft}; border-radius:4px; }
.right { grid-area:right; display:flex; flex-direction:column; gap:10px; min-height:0; }
.right > div { display:flex; min-height:0; }
.right > div:first-child { flex:2.2; }      /* at the yard: the big one */
.right > div:not(:first-child) { flex:1; min-height:120px; }   /* in for repair, broken: smaller */
.ppl { display:grid; grid-template-columns:210px minmax(0,1fr); gap:12px; padding:10px 16px 12px; height:calc(100vh - 128px); min-height:560px; }
.ppl-side { background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.ppl-list { display:flex; flex-direction:column; flex:1; min-height:0; overflow:auto; }
.ppl-main { display:flex; flex-direction:column; min-height:0; }
.ppl-main .cal-grid { flex:1; min-height:0; grid-template-rows:auto repeat(6, minmax(64px, 1fr)); }
.ppl-main .cal-d { min-height:0; overflow:hidden; }
@media (max-width:900px){ .ppl { grid-template-columns:1fr; height:auto; } .ppl-list { max-height:40vh; } .ppl-main .cal-d { min-height:96px; } }
.ppl-row { display:grid; grid-template-columns:6px minmax(0,1fr) auto; grid-template-rows:auto auto; column-gap:8px; text-align:left; padding:8px 8px 8px 10px; border-top:1px solid ${C.edgeSoft}; min-height:46px; cursor:pointer; user-select:none; }
.ppl-row .ppl-ed { grid-column:3; grid-row:1 / 3; align-self:center; }
.ppl-row > i { grid-column:1; grid-row:1 / 3; }
.ppl-row > span { grid-column:2; grid-row:1; min-width:0; }
.ppl-row > small { grid-column:2; grid-row:2; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ppl-row i { grid-row:1 / 3; border-radius:2px; }
.ppl-row span { font-size:13.5px; letter-spacing:.05em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ppl-row small { font-size:10.5px; color:var(--faint); }
.ppl-row[data-on="1"] { background:${C.tileHi}; box-shadow:inset 3px 0 0 #17A05B; }
.ppl-edit { padding:12px 14px 14px; overflow:auto; background:${C.panel}; box-shadow:0 18px 50px rgba(0,0,0,.6); }
.ppl-ed { margin-left:auto; font-size:9.5px; letter-spacing:.08em; color:var(--dim); border:1px solid var(--edge); border-radius:2px; padding:2px 6px; flex-shrink:0; }
.ppl-ed:hover { color:var(--ink); border-color:#5d6a73; }
.ppl-main { min-width:0; }
.ppl-main > .ppl-top, .ppl-main > .legend { flex-shrink:0; }
.ppl-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.ppl-month { font-size:20px; letter-spacing:.08em; min-width:190px; text-align:center; }
.cal-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:4px; user-select:none; }
.cal-h { text-align:center; font-size:11px; letter-spacing:.12em; color:var(--faint); padding:4px 0; }
.cal-d { min-height:104px; background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; padding:6px; cursor:pointer; display:flex; flex-direction:column; gap:4px; }
.cal-d:hover { border-color:#4d5a62; }
.cal-d[data-out="1"] { opacity:.45; }
.cal-d[data-wknd="1"] { background:#181d22; }
.cal-d[data-today="1"] b { background:#17A05B; color:#08130c; border-radius:2px; padding:0 4px; }
.cal-d b { font-weight:500; font-size:13px; align-self:flex-start; }
.cal-offs { display:flex; flex-wrap:wrap; gap:3px; }
.cal-off { font-size:10.5px; padding:1px 5px; border-left:3px solid; background:${C.tile}; border-radius:2px; white-space:nowrap; }
.cal-off em { font-style:normal; font-size:9px; letter-spacing:.06em; }
.bin.broke { border-color:#5a2420; background:#1f1514; }
.bin.broke .bin-h { color:#e0796c; }
.plate.locked { cursor:pointer; opacity:.6; }
.plate.warn { box-shadow:0 0 0 1.5px #E5A100; }
.cbox-edit { font-size:9.5px; letter-spacing:.08em; color:var(--dim); border:1px solid var(--edge); border-radius:2px; padding:2px 6px; margin-left:4px; }
.cbox-edit:hover { color:var(--ink); border-color:#5d6a73; }
.right .bin-b { overflow:auto; align-content:flex-start; }
@media (max-width:1100px){
  .oy-g { grid-template-columns:186px minmax(0,1fr); grid-template-areas:"left canvas" "right right"; }
  .right { flex-direction:row; }
  .right > div { flex:1 !important; }
}
@media (max-width:820px){
  .oy-g { grid-template-columns:1fr; grid-template-areas:"left" "canvas" "right"; }
  .right { flex-direction:column; }
}

.bin { background:${C.panel}; border:1px solid ${C.edgeSoft}; border-radius:4px; display:flex;
       flex-direction:column; min-height:104px; width:100%; transition:background .12s; }
.bin.hot { background:#232c33; box-shadow:inset 0 0 0 1px #5b686f; }
.bin-h { display:flex; align-items:center; gap:8px; font-family:'Barlow Condensed',sans-serif;
         font-size:9.5px; letter-spacing:.16em; color:var(--faint); padding:9px 11px;
         border-bottom:1px solid ${C.edgeSoft}; }
.bin-h b { margin-left:auto; font-weight:500; color:var(--dim); font-size:11px; letter-spacing:.04em; }
.bin-b { display:flex; flex-wrap:wrap; gap:6px; padding:9px; align-items:flex-start; flex:1; align-content:flex-start; }
.bin-b.row { align-items:flex-end; align-content:flex-end; overflow:auto; }
.bin-b.kinds { flex-direction:column; flex-wrap:nowrap; gap:4px; overflow:auto; }
.krow { display:flex; flex-direction:column; gap:1px; border-bottom:1px solid #222b31; padding-bottom:3px; }
.krow:last-child { border-bottom:0; }
.krow-h { font-size:9px; letter-spacing:.12em; color:var(--faint); }
.krow-b { display:flex; flex-wrap:wrap; gap:2px 8px; align-items:flex-end; }
.bin.vac { border-color:#33414c; background:#191f26; }
.bin.vac .bin-h { color:#6f8695; }
.bin.rep { border-color:#4a2d29; background:#1e1817; }
.bin.rep .bin-h { color:#c07a70; }

.plate { display:inline-flex; align-items:stretch; background:#242C33; border:1px solid var(--edge);
         border-radius:3px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,.4);
         cursor:grab; touch-action:none; user-select:none; }
.plate:hover { background:#2C363E; border-color:#4a565f; }
.plate:active { cursor:grabbing; }
.plate-c { width:9px; flex:0 0 9px; }
.plate-n { padding:7px 11px; font-family:'Barlow Condensed',sans-serif; text-transform:uppercase;
           letter-spacing:.07em; font-size:12.5px; white-space:nowrap; line-height:1; align-self:center; }
.plate-v { align-self:center; font-family:'Barlow Condensed',sans-serif; font-size:9px; letter-spacing:.1em;
           color:#131820; background:#5F87A6; padding:2px 5px; border-radius:2px; margin:0 7px 0 -3px; }
.plate.off { opacity:.72; }
.plate.fore { border-width:2px; background:#2b353d; box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.5); }
.plate.fore .plate-n { font-weight:700; color:#fff; letter-spacing:.08em; }

.lcard { display:inline-flex; flex-direction:column; align-items:center; gap:3px;
         touch-action:none; cursor:grab; padding:4px; user-select:none; }
.lcard:active { cursor:grabbing; }
.lcard-t { font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.06em;
           font-size:9px; color:var(--faint); text-align:center; max-width:120px; line-height:1.25; }
.lcard.broke .lcard-t { color:#C97066; }
.lcard { position:relative; }
.lcard-w { position:absolute; top:-2px; right:-2px; z-index:2; width:15px; height:15px; border-radius:50%;
           background:${ST.watch.color}; color:#14181C; font-family:'Barlow Condensed',sans-serif;
           font-weight:700; font-size:11px; display:flex; align-items:center; justify-content:center; }
.odd { font-size:10px; letter-spacing:.07em; color:${ST.watch.color}; border:1px solid #4a3d1c;
       background:#241f10; padding:4px 9px; border-radius:2px; cursor:help; }
.bin-h .lnk { margin-left:6px; font-size:9.5px; }

.canvas { position:relative; }
.asphalt { position:absolute; inset:0; background:
  repeating-linear-gradient(90deg,rgba(255,255,255,.028) 0 1px,transparent 1px 88px),
  repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,transparent 1px 88px), #191E23; }
.pin { position:absolute; }
.hull { position:absolute; border:1.5px dashed #4b5860; border-radius:30px; background:rgba(120,140,155,.055); }
.hull-l { position:absolute; top:-12px; left:16px; background:${C.bg}; padding:2px 9px; border-radius:2px;
          font-family:'Barlow Condensed',sans-serif; text-transform:uppercase; letter-spacing:.1em;
          font-size:10.5px; color:var(--dim); display:flex; gap:8px; align-items:center; white-space:nowrap;
          cursor:grab; touch-action:none; }
.hull-b { font:inherit; letter-spacing:inherit; color:var(--ink); }
.hull-l u { text-decoration:none; display:inline-flex; align-items:center; gap:3px; font-size:9px; color:var(--faint); }
.hull-l em { font-style:normal; color:${ST.watch.color}; font-size:9px; }
.hull-l b { font-weight:500; color:var(--faint); font-size:9px; }

/* --- crew boxes ---------------------------------------------------------- */
.cbox { position:absolute; background:rgba(28,34,39,.92); border:1px solid #38434b; border-radius:5px;
        box-shadow:0 2px 8px rgba(0,0,0,.4); transition:background .12s, box-shadow .12s; }
.cbox.hot { background:#28323a; box-shadow:0 0 0 2px #7d8b94, 0 2px 10px rgba(0,0,0,.5); }
.cbox-h { display:flex; align-items:center; gap:7px; height:26px; padding:0 9px 0 0;
          border-bottom:1px solid #2f393f; }
.cbox-g { width:16px; align-self:stretch; cursor:grab; touch-action:none; border-right:1px solid #2f393f;
          border-radius:4px 0 0 0;
          background:repeating-linear-gradient(180deg,transparent 0 3px,#454f57 3px 4px); }
.cbox-g:active { cursor:grabbing; }
.cbox-n { font-size:12.5px; letter-spacing:.09em; color:var(--ink); }
.cbox-h u { text-decoration:none; display:inline-flex; align-items:center; gap:3px; font-size:8.5px;
            letter-spacing:.1em; color:var(--faint); border:1px solid var(--edge); padding:1px 4px; border-radius:2px; }
.cbox-warn { font-style:normal; font-size:10px; letter-spacing:.06em; color:#fff; background:#D93B2B; border-radius:2px; padding:1px 5px; margin-left:auto; cursor:help; }
.cbox-warn + b { margin-left:6px !important; }
.cbox-h b { margin-left:auto; font-weight:500; font-size:9.5px; letter-spacing:.06em; color:var(--faint); }
.cbox-e { position:absolute; left:12px; top:38px; font-size:10px; color:var(--faint); letter-spacing:.04em; }
.slot { position:absolute; }

.lcard-k { position:absolute; top:-3px; left:-4px; z-index:2; font-size:9px; line-height:1;
           background:${C.panel}; border:1px solid var(--edge); border-radius:50%;
           width:16px; height:16px; display:flex; align-items:center; justify-content:center;
           cursor:pointer; color:var(--dim); }
.lcard-k:hover { color:var(--ink); border-color:#5d6a73; }
.lcard.linked { outline:1px solid #6f7b84; outline-offset:2px; border-radius:3px; }
`);


/* ============================ OPERATIONS ==================================
   Service lines. A unit can serve more than one — a lawn truck helping on a
   plant care job is normal, so nothing here is exclusive.                   */
const OPS = {
  GTC:   { key: "GTC",   label: "General tree care", glyph: "M6 2l4 6H8l3 5H7l3 5H1l3-5H0l3-5H1z" },
  PHC:   { key: "PHC",   label: "Plant health care", glyph: "M6 1c3 4 4.5 6 4.5 8A4.5 4.5 0 011.5 9C1.5 7 3 5 6 1z" },
  LC:    { key: "LC",    label: "Lawn care",         glyph: "M1 16V9m3 7V6m3.5 10V8m3.5 8V5" },
  SALES: { key: "SALES", label: "Sales & admin",     glyph: "M1 5h10v9H1zM4 5V2h4v3" },
};
const OP_ORDER = ["GTC", "PHC", "LC", "SALES"];

const OpGlyph = ({ op, size = 11 }) => {
  const o = OPS[op]; if (!o) return null;
  const stroke = op === "LC";
  return (
    <svg viewBox="0 0 12 18" width={size * 0.72} height={size} aria-hidden="true"
         fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"}
         strokeWidth={stroke ? 2 : 0} strokeLinecap="round">
      <path d={o.glyph} />
    </svg>
  );
};
const OpTag = ({ op }) => (
  <span className="optag stencil" title={OPS[op] ? OPS[op].label : op}>
    <OpGlyph op={op} /> {op}
  </span>
);

/* ============================ PERSON PLACARD ==============================
   The SingleOps colour rides on the name, never on a machine, so a colour on
   this board can only ever mean one of two things depending on what it is
   attached to: a person, or a machine's condition.                          */
const Placard = ({ person, onBegin, tone, onClick, sub }) => {
  const label = (
    <>
      {person ? person.d : "—"}
      {sub && <span style={{ color: C.inkFaint, marginLeft: 6, letterSpacing: ".04em" }}>{sub}</span>}
    </>
  );
  return (
    <div className="plc">
      {onBegin && <div className="plc-g" onPointerDown={onBegin} role="button" tabIndex={-1} aria-label="Drag" />}
      <div className="plc-c" style={{ background: (person && person.c) || C.edge }} />
      {onClick
        ? <button className="plc-n stencil" onClick={onClick}>{label}</button>
        : <div className="plc-n stencil">{label}</div>}
      {tone && <div className="plc-s" style={{ background: tone }} />}
    </div>
  );
};

/* ============================ ASSET TILE ================================== */
function AssetTile({ a, crewName, begin, onOpen, flash }) {
  const st = ST[a.status] || ST.running;
  return (
    <div className={`tile tile-sm${flash ? " flash" : ""}`} data-st={a.status} style={{ borderColor: st.color }}>
      <div className="grip" onPointerDown={(e) => begin(e, { kind: "asset", id: a.id, name: a.name, shape: a.shape, instant: true })}
           role="button" tabIndex={-1} aria-label={`Drag ${a.name}`} />
      <button className="tile-b" onClick={onOpen}
              onPointerDown={(e) => { if ((e.pointerType || "mouse") === "mouse") begin(e, { kind: "asset", id: a.id, name: a.name, shape: a.shape }); }}
              aria-label={`${a.name}, ${st.label}`} title={`${a.spec}${a.plate ? " · " + a.plate : ""} — ${st.label}`}>
        <span className="sm-ic" style={{ "--mach": tones(a.fam).body, "--mach-lo": tones(a.fam).lo, "--mach-hi": tones(a.fam).hi }}><MachineChip shape={a.shape} /></span>
        <span className="sm-t">
          <span className="tile-name stencil">{a.name}</span>
          <span className="tile-sub">{crewName ? `On ${crewName}` : a.yard || ""}{a.ops.length ? " · " + a.ops.join("/") : ""}</span>
        </span>
        {a.status !== "running" && <span className="sm-st stencil" style={{ color: st.color, borderColor: st.color }}>{st.short}</span>}
      </button>
    </div>
  );
}

/* ============================ CONDITION DOCK ==============================
   Appears only while a unit is in hand. Five big targets pinned to the bottom
   of the screen, so on a phone you never have to drag across a scrolling row
   of columns to say a machine is in the shop.                               */
function ConditionDock({ drag, registerZone, onDrop }) {
  const on = drag && drag.item.kind === "asset";
  return (
    <div className="dock" data-on={on ? 1 : 0} aria-hidden={!on}>
      <div className="dock-l stencil">Drop to set condition</div>
      <div className="dock-r">
        {ST_ORDER.map((k) => {
          const zid = `dock:${k}`;
          return (
            <Zone key={k} id={zid} accepts={["asset"]} registerZone={registerZone} onDrop={(item) => onDrop(item.id, k)}>
              <div className="dz stencil" data-hot={drag && drag.over === zid ? 1 : 0}
                   style={{ borderColor: ST[k].color }}>
                <span className="swatch" style={{ background: ST[k].color }} />{ST[k].label}
              </div>
            </Zone>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ FLEET ======================================= */
/* Equipment tab columns = kinds of machine (the owner's list: aerial lifts,
   trucks, trailers, material handlers, grinders, chippers…). Condition shows
   as the card's outline; repair and broken units sink to the bottom. */
const EQUIP_GROUPS = [
  { key: "aerial", label: "Aerial lifts", test: (a) => a.cat === "SPIDER LIFT" || a.cat === "AERIAL" || a.fam === "AERIAL" },
  { key: "pickup", label: "Pickups", test: (a) => a.shape === "PICKUP" || /pickup/i.test(a.spec || "") },
  { key: "truck", label: "Trucks", test: (a) => a.hc === "truck" },
  { key: "handler", label: "Material handlers", test: (a) => a.cat === "AVANT" || a.shape === "LOADER" },
  { key: "chipper", label: "Chippers", test: (a) => a.cat === "CHIPPER" || a.shape === "CHIPPER" },
  { key: "grinder", label: "Stump grinders", test: (a) => a.cat === "STUMP GRINDER" || a.shape === "GRINDER" },
  { key: "spray", label: "Sprayers & UTVs", test: (a) => a.top === "utv" },
];
const equipGroupOf = (a) => (EQUIP_GROUPS.find((g) => g.test(a)) || { key: "other" }).key;
const SINK = { running: 0, watch: 1, parked: 2, tagged: 4 };

function FleetView({ core, crewsMap, engine, filters, setFilters, onOpen, flashSet, onAdd }) {
  const { begin } = engine;
  const assets = live(core.assets);
  const crews = live(crewsMap);
  const crewOf = {};
  crews.forEach((c) => c.iron.forEach((i) => { crewOf[i] = c.name; }));
  const yards = ["Brighton", "Rush Scottsville", "Off-site"];

  const shown = assets.filter((a) => {
    if (filters.op && !a.ops.includes(filters.op)) return false;
    if (filters.yard && a.yard !== filters.yard) return false;
    if (filters.st && a.status !== filters.st) return false;
    const q = filters.q.trim().toLowerCase();
    if (q && !(a.name + " " + a.spec + " " + (a.plate || "")).toLowerCase().includes(q)) return false;
    return true;
  });
  const order = (l) => l.sort((x, y) => (SINK[x.status] ?? 0) - (SINK[y.status] ?? 0) || x.name.localeCompare(y.name));
  const groups = [...EQUIP_GROUPS, { key: "other", label: "Other" }]
    .map((g) => ({ ...g, items: order(shown.filter((a) => equipGroupOf(a) === g.key)) }))
    .filter((g) => g.items.length);

  const toggle = (k, v) => setFilters((f) => ({ ...f, [k]: f[k] === v ? "" : v }));
  const count = (k) => assets.filter((a) => a.status === k).length;

  return (
    <>
      <div className="tb">
        {OP_ORDER.map((o) => (
          <button key={o} className="chip stencil" data-on={filters.op === o ? 1 : 0} onClick={() => toggle("op", o)}>
            <OpGlyph op={o} /> {o}
          </button>
        ))}
        <span className="vr" />
        {yards.map((y) => (
          <button key={y} className="chip stencil" data-on={filters.yard === y ? 1 : 0} onClick={() => toggle("yard", y)}>{y}</button>
        ))}
        <div className="spacer" />
        {onAdd && <button className="btn stencil" data-primary="1" onClick={onAdd}>+ Add equipment</button>}
        <input className="srch" placeholder="Find unit or plate" value={filters.q}
               onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
      </div>
      <div className="tb" style={{ paddingTop: 0, borderBottom: `1px solid ${C.edgeSoft}` }}>
        <span className="fl stencil" style={{ margin: 0 }}>CONDITION</span>
        {ST_ORDER.map((k) => (
          <button key={k} className="chip stencil" data-on={filters.st === k ? 1 : 0} onClick={() => toggle("st", k)}
                  style={{ borderColor: ST[k].color }}>
            <span className="swatch" style={{ background: ST[k].color }} />{ST[k].label} <b className="mono" style={{ fontWeight: 500, opacity: .7 }}>{count(k)}</b>
          </button>
        ))}
        <span className="note" style={{ padding: 0 }}>Outline = condition. Tap a unit to change it, or drag it to the bar at the bottom.</span>
      </div>

      <div className="cols">
        {groups.map((g) => (
          <div className="col" key={g.key} data-wide={g.items.length > 8 ? 1 : 0}>
            <div className="col-h" style={{ borderTopColor: C.edge }}>
              <em className="stencil">{g.label}</em>
              {g.items.some((a) => a.status === "tagged") && (
                <span className="mono" style={{ fontSize: 10.5, color: ST.tagged.color }}>
                  {g.items.filter((a) => a.status === "tagged").length} broken
                </span>
              )}
              <u className="mono">{g.items.length}</u>
            </div>
            <div className="col-b">
              {g.items.map((a) => (
                <AssetTile key={a.id} a={a} crewName={crewOf[a.id]} begin={begin}
                           flash={flashSet.has(a.id)} onOpen={() => onOpen(a.id)} />
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <div className="empty">Nothing matches. Adjust the filters.</div>}
      </div>
    </>
  );
}


/* ============================ DATE HELPERS ================================ */
const DNAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const weekStartOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; };
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/* ============================ YARD VIEW =================================== */
const Plate = ({ p, onBegin, off, onClick, locked, warn }) => (
  <span className={`plate${off ? " off" : ""}${locked ? " locked" : ""}${warn ? " warn" : ""}${p.foreman ? " fore" : ""}`} onPointerDown={locked ? undefined : onBegin} onClick={onClick}
        title={locked ? "Off duty today — tap to put them back on duty" : warn || (p.foreman ? "Foreman" : undefined)}
        style={p.foreman ? { borderColor: p.c || "#E7E2D6" } : undefined}>
    <span className="plate-c" style={{ background: p.c }} />
    <span className="plate-n">{p.foreman ? "★ " : ""}{p.d}</span>
    {off && <span className="plate-v">{off}</span>}
  </span>
);


/* Which part of a load card was grabbed: the truck (top) takes the whole load;
   what it tows (below the hitch) comes off on its own — that is how you unhook. */
function grabbed(e, members) {
  if (members.length < 2) return members;
  const svg = e.currentTarget.querySelector && e.currentTarget.querySelector("svg");
  if (!svg) return members;
  const r = svg.getBoundingClientRect();
  const lead = members.find((m) => m.hc === "truck") || members[0];
  const L = hLayout(members);
  const cut = (L.W - 1 - L.leadW) / L.W;                       // left of the hitch = what is towed
  return (e.clientX - r.left) / Math.max(1, r.width) < cut ? members.filter((m) => m !== lead) : members;
}

const LoadCard = ({ members, onBegin, onClick, scale = 1, label = true, broken, odd, linked, onLink }) => (
  <span className={`lcard${broken ? " broke" : ""}${linked ? " linked" : ""}`} onPointerDown={onBegin} onClick={onClick}
        title={label ? undefined : members.map((m) => m.tag).join(" · ")}>
    {odd && odd.length > 0 && <span className="lcard-w" title={odd.join("\n")}>!</span>}
    {members.length > 1 && onLink && (
      <span className="lcard-k" role="button" title={linked ? "Linked — click to unlink" : "Link these so they stay together"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onLink(); }}>{linked ? "\u{1F512}" : "\u26AD"}</span>
    )}
    <HLoad members={members} scale={scale} broken={broken} />
    {label && <span className="lcard-t">{members.map((m) => m.tag).join(" · ")}</span>}
  </span>
);

function stackIssues(members) {
  const out = [];
  const lead = members[0];
  const tow = members.find((m) => m !== lead && (m.hc === "towed" || m.hc === "trailer"));
  const trailer = members.find((m) => m.hc === "trailer");
  if (lead && lead.hc !== "truck") out.push(`${lead.tag} has no truck to pull it`);
  if (lead && tow && towScore(lead, tow.tt) < 0)
    out.push(`${lead.tag} rarely pulls a ${TOWWORD[tow.tt] || tow.tag.toLowerCase()}`);
  members.filter((m) => m.hc === "carried").forEach((m) => {
    if (!trailer) out.push(`${m.tag} has no trailer — it cannot go out`);
    else if ((m.rides || []).length && !(m.rides || []).includes(trailer.tt))
      out.push(`${m.tag} is on a ${TOWWORD[trailer.tt] || trailer.tag.toLowerCase()}`);
  });
  return out;
}

/* YESTERDAY (owner, Nov 25): how today's crews differ from the previous work day
   (Monday compares with Friday). Folds away; remembered per device. */
function YesterdayPanel({ prev, crews, core }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("mts-yard-yesterday") === "1"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("mts-yard-yesterday", open ? "1" : "0"); } catch {} }, [open]);
  if (!prev) return null;
  const pc = prev.crews || {};
  const pname = (id) => ((core.people[id] || {}).name || "?").split(" ")[0];
  const aname = (id) => (core.assets[id] || {}).vl || (core.assets[id] || {}).name || null;
  const rows = live(crews).map((c) => {
    const y = pc[c.id] && !pc[c.id].del ? pc[c.id] : null;
    const yp = new Set((y && y.people) || []), tp = new Set(c.people || []);
    const yi = new Set(((y && y.iron) || []).filter(aname)), ti = new Set((c.iron || []).filter(aname));
    return {
      c, y,
      addP: [...tp].filter((x) => !yp.has(x)), lostP: [...yp].filter((x) => !tp.has(x)), keptP: [...tp].filter((x) => yp.has(x)),
      addI: [...ti].filter((x) => !yi.has(x)), lostI: [...yi].filter((x) => !ti.has(x)),
    };
  });
  const changed = rows.filter((r) => r.addP.length + r.lostP.length + r.addI.length + r.lostI.length > 0).length;
  const label = new Date(prev.iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const chip = (txt, kind) => (
    <span key={kind + txt} style={{ fontSize: 11.5, padding: "1px 6px", borderRadius: 2, marginRight: 4, whiteSpace: "nowrap",
      background: kind === "add" ? "rgba(23,160,91,.2)" : kind === "lost" ? "rgba(217,59,43,.18)" : "transparent",
      color: kind === "add" ? "#7fe0a8" : kind === "lost" ? "#ff9a8f" : C.inkDim, textDecoration: kind === "lost" ? "line-through" : "none" }}>
      {kind === "add" ? "+" : kind === "lost" ? "−" : ""}{txt}
    </span>
  );
  return (
    <div className="yest" style={{ margin: "0 0 8px", border: `1px solid ${C.edgeSoft}`, borderRadius: 4, background: C.panel }}>
      <button onClick={() => setOpen((o) => !o)} style={{ width: "100%", display: "flex", gap: 8, alignItems: "center", padding: "7px 10px", textAlign: "left" }}>
        <b className="stencil" style={{ fontSize: 11.5, letterSpacing: ".1em" }}>Compared with {label}</b>
        <span style={{ fontSize: 11.5, color: changed ? "#f0c050" : C.inkDim }}>{changed ? `${changed} crew${changed === 1 ? "" : "s"} changed` : "same crews"}</span>
        <span className="spacer" style={{ flex: 1 }} /><span style={{ color: C.inkDim }}>{open ? "▴ hide" : "▾ show"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 10px 8px", display: "grid", gap: 4 }}>
          {rows.map((r) => (
            <div key={r.c.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 12 }}>
              <b className="stencil" style={{ width: 70, flexShrink: 0 }}>{r.c.name}</b>
              {!r.y ? <span style={{ color: "#7fe0a8", fontSize: 11.5 }}>new crew today</span> : (
                <span>
                  {r.keptP.map((x) => chip(pname(x), "kept"))}{r.addP.map((x) => chip(pname(x), "add"))}{r.lostP.map((x) => chip(pname(x), "lost"))}
                  {(r.addI.length > 0 || r.lostI.length > 0) && <span style={{ color: C.inkFaint, margin: "0 4px" }}>·</span>}
                  {r.addI.map((x) => chip(aname(x), "add"))}{r.lostI.map((x) => chip(aname(x), "lost"))}
                </span>
              )}
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: C.inkFaint }}>Green + = new on that crew today · red − = was on it {label}, not today. Unchanged equipment isn't listed.</div>
        </div>
      )}
    </div>
  );
}

function YardView({ core, day, iso, dayIndex, week, engine, savedDays, ops, setOps, onOrder, crewJobs = {},
                   onCopy, onLink, onUnlink, look, onLook, onCopyDay, onPasteDay, clip, prevDay,
                   onMove, onNewCrew, onCrew, onPerson, onAddPerson, onOpenAsset, onDate, undoLabel, onUndo }) {
  const { begin, registerZone, drag } = engine;
  const assets = core.assets;
  const roster = live(core.people);
  const pos = day.pos || {};
  const stacks = day.stacks || {};
  const mon = new Date(isoOf(weekStartOf(new Date(iso + "T00:00:00"))) + "T00:00:00");
  const todayIso = isoOf(new Date());

  const membersOf = (lead) => (stacks[lead] || [lead]).map((i) => assets[i]).filter((a) => a && !a.del);
  const opsOfStack = (lead) => {
    const set = new Set();
    membersOf(lead).forEach((m) => (m.ops || []).forEach((o) => set.add(o)));
    return [...set];
  };
  const stackShown = (lead) => { const o = opsOfStack(lead); return !o.length || o.some((x) => ops[x]); };
  const broken = (lead) => membersOf(lead).some((m) => m.status === "tagged");
  // who / what is on a crew today (the bins used screen positions, which left
  // people and trucks dropped onto a crew still showing in the room / yard)
  const crewHas = useMemo(() => {
    const p = new Set(), u = new Set();
    live(day.crews).forEach((c) => { (c.people || []).forEach((x) => p.add(x)); (c.iron || []).forEach((x) => u.add(x)); });
    return { p, u };
  }, [day.crews]);
  const offToday = (pid) => {
    const c = week.cells[`${pid}:${dayIndex}`];
    return c && c.code !== "on" && c.code !== "light" ? DAY[c.code].short : null;
  };

  /* clusters, filtered by which operations are switched on */
  const hitch2 = useMemo(() => deriveHitch(day.crews, core.assets), [day.crews, core.assets]);
  const anchors = day.pos || {};
  // pack the crews to the width actually on screen (the original used a fixed
  // 1400 px, so boxes ran off the right edge on a laptop)
  const wrapRef = useRef(null);
  const [vw, setVw] = useState(CW);
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setVw(Math.max(520, Math.floor(el.clientWidth) - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const boxes = packBoxes(live(day.crews).map((c) => ({ ...c, people: (c.people || []).filter((pid) => !offToday(pid)) }))
    .filter((c) => !c.ops || ops[c.ops] !== false)
    .map((c, i) => layoutBox(c, i, core, hitch2, anchors, offToday, vw)), vw);
  /* the "+ New crew" tile sits where the next box would go; the canvas grows to fit */
  const lastBox = boxes[boxes.length - 1];
  const NEW_W = 220;
  const NEW_H = 118;
  const newTile = !lastBox ? { x: 16, y: 16 }
    : lastBox.x + lastBox.w + 16 + NEW_W <= vw ? { x: lastBox.x + lastBox.w + 16, y: lastBox.y }
    : { x: 16, y: Math.max(...boxes.map((b) => b.y + b.h)) + 16 };
  const canvasH = Math.max(CH, newTile.y + NEW_H + 24, ...boxes.map((b) => b.y + b.h + 24));
  /* dropped on a box: slot it in there. dropped past the end: put it last. */
  const dropCrew = (id, at) => {
    let target = boxes.findIndex((b) => at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h);
    if (target < 0) target = boxes.findIndex((b) => at.y < b.y + b.h / 2);
    const ids = boxes.map((b) => b.crew.id).filter((x) => x !== id);
    ids.splice(target < 0 ? ids.length : Math.min(target, ids.length), 0, id);
    onOrder(ids);
  };

  const room = roster.filter((p) => !crewHas.p.has(p.id) && !offToday(p.id) && homeOf(p) !== "office");
  const office = roster.filter((p) => !crewHas.p.has(p.id) && !offToday(p.id) && homeOf(p) === "office");
  const away = roster.filter((p) => offToday(p.id));
  const gMem = (g) => g.members.map((i) => assets[i]).filter((a) => a && !a.del);
  const gShown = (g) => { const o = new Set(); gMem(g).forEach((m) => (m.ops || []).forEach((x) => o.add(x))); return !o.size || [...o].some((x) => ops[x]); };
  const gDown = (g) => gMem(g).some((m) => m.status === "tagged");
  const parked = yardGroups(day, assets).filter(gShown);
  const yard = parked.filter((g) => !gDown(g));
  const brokeList = parked.filter(gDown);
  const binCard = (g, from, scale, down) => (
    <LoadCard key={g.id} members={gMem(g)} scale={scale} broken={down} onClick={() => onOpenAsset(g.id)}
              onBegin={(e) => { const part = grabbed(e, gMem(g)); begin(e, { kind: "stack", id: part[0].id, members: part.map((m) => m.id), name: part.map((m) => m.tag).join(" · "), from: part.length === gMem(g).length ? from : `part:${from}` }); }} />
  );
  const hot = (id) => (drag && drag.over === id ? " hot" : "");
  const outIssues = [];
  Object.values(crewJobs).forEach((cj) => cj.lines.forEach((t) => outIssues.push(t)));
  live(day.crews).forEach((c) => (c.people || []).forEach((pid) => {
    const p = core.people[pid];
    if (p && !p.del && p.ops && p.ops.length && c.ops && !p.ops.includes(c.ops) && !offToday(pid)) outIssues.push(`${p.name} is on ${c.name} but isn't set up for ${c.ops}`);
  }));
  Object.keys(stacks).forEach((k) => {
    if (!pos[k] || !stackShown(k)) return;
    stackIssues(membersOf(k)).forEach((t) => outIssues.push(t));
  });

  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));

  return (
    <>
      <div className="cal">
        <select className="wkpick stencil" value={isoOf(mon)}
                onChange={(e) => onDate(isoOf(addDays(new Date(e.target.value + "T00:00:00"), dayIndex)))}
                title="Jump to a week">
          {Array.from({ length: 27 }).map((_, k) => {
            const w = addDays(weekStartOf(new Date()), (k - 8) * 7);
            const wi = isoOf(w);
            return (
              <option key={wi} value={wi}>
                {k === 8 ? "This week" : `Week of ${w.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                {k === 8 ? "" : k === 9 ? " · next" : k === 7 ? " · last" : ""}
              </option>
            );
          })}
        </select>
        <button className="btn stencil" onClick={() => onDate(isoOf(addDays(mon, -7)))}>‹</button>
        {days.map((d, i) => {
          const di = isoOf(d);
          return (
            <button key={i} className="calday stencil" data-on={di === iso ? 1 : 0} data-today={di === todayIso ? 1 : 0}
                    onClick={() => onDate(di)}>
              <em>{DNAMES[i]}</em>
              <b>{d.getDate()}</b>
              <i data-saved={savedDays.has(di) ? 1 : 0} />
            </button>
          );
        })}
        <button className="btn stencil" onClick={() => onDate(isoOf(addDays(mon, 7)))}>›</button>
        <button className="btn stencil" onClick={() => onDate(todayIso)}>Today</button>
        <div className="spacer" />
        <button className="btn stencil" data-danger={undoLabel ? 1 : 0} disabled={!undoLabel}
                onClick={onUndo} title={undoLabel || "Nothing to undo"}>
          ↶ Undo{undoLabel ? ` · ${undoLabel}` : ""}
        </button>
      </div>

      <div className="oy-g">
        <div className="left">
          <Zone id="room" accepts={["person"]} registerZone={registerZone} onDrop={(it) => onMove(it, "room")}>
            <div className={`bin${hot("room")}`}>
              <div className="bin-h">CREW ROOM
                <button className="lnk stencil" onClick={onAddPerson}>+ name</button>
                <b>{room.length}</b></div>
              <div className="bin-b">
                {room.map((p) => <Plate key={p.id} p={p} onClick={() => onPerson(p.id)}
                                        onBegin={(e) => begin(e, { kind: "person", id: p.id, name: p.d, color: p.c, from: "room" })} />)}
                {!room.length && <span className="hint">everyone is out</span>}
              </div>
            </div>
          </Zone>
          <Zone id="vac" accepts={["person"]} registerZone={registerZone} onDrop={(it) => onMove(it, "vac")}>
            <div className={`bin vac${hot("vac")}`}>
              <div className="bin-h">OFF DUTY<b>{away.length}</b></div>
              <div className="bin-b">
                {away.map((p) => <Plate key={p.id} p={p} off={offToday(p.id)} onClick={() => onPerson(p.id)} locked />)}
                {!away.length && <span className="hint">nobody off · drop a name here to mark them off today</span>}
              </div>
            </div>
          </Zone>
          <Zone id="office" accepts={["person"]} registerZone={registerZone} onDrop={(it) => onMove(it, "office")}>
            <div className={`bin${hot("office")}`}>
              <div className="bin-h">OFFICE<b>{office.length}</b></div>
              <div className="bin-b">
                {office.map((p) => <Plate key={p.id} p={p} onClick={() => onPerson(p.id)}
                                          onBegin={(e) => begin(e, { kind: "person", id: p.id, name: p.d, color: p.c, from: "office" })} />)}
                {!office.length && <span className="hint">nobody in the office · drop a name here</span>}
              </div>
            </div>
          </Zone>
        </div>

        <div className="canvas-wrap" ref={wrapRef}>
          <YesterdayPanel prev={prevDay} crews={day.crews} core={core} />
          <Zone id="canvas" accepts={["crew"]} registerZone={registerZone}
                onDrop={(it, _z, at) => dropCrew(it.id, at)}>
            <div className="canvas" style={{ width: vw, height: canvasH }}>
              <div className="asphalt" />
              <Zone id="newcrew" accepts={["person", "stack"]} registerZone={registerZone} onDrop={(it) => onMove(it, "newcrew")}
                    className={`newcrew${drag && drag.over === "newcrew" ? " hot" : ""}${drag && (drag.item.kind === "person" || drag.item.kind === "stack") ? " ready" : ""}`}
                    style={{ left: newTile.x, top: newTile.y, width: NEW_W, height: NEW_H }}>
                <b>＋ New crew</b><span>Drop a name or a truck here to start a crew</span>
              </Zone>
              {boxes.map((b) => (
                <Zone key={b.crew.id} id={`crew:${b.crew.id}`} accepts={["person", "stack"]}
                      registerZone={registerZone} onDrop={(it) => onMove(it, `crew:${b.crew.id}`)}
                      className={`cbox${drag && drag.over === `crew:${b.crew.id}` ? " hot" : ""}${drag && drag.item.kind === "crew" && drag.item.id === b.crew.id ? " lifted" : ""}`}
                      style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
                    <div className="cbox-h" style={{ height: b.headH, alignItems: "flex-start", paddingTop: 5 }}>
                      <span className="cbox-g" title="Move this crew"
                            onPointerDown={(e) => begin(e, { kind: "crew", id: b.crew.id, name: b.crew.name })} />
                      <button className="cbox-n stencil" onClick={() => onCrew(b.crew.id)}>{b.crew.name}</button>
                      <button className="cbox-edit stencil" onClick={() => onCrew(b.crew.id)} title="Rename, change operation, add or remove people and equipment">✎ Edit</button>
                      {b.crew.ops && <u className="stencil"><OpGlyph op={b.crew.ops} /> {b.crew.ops}</u>}
                      {crewJobs[b.crew.id]?.lines.length > 0 && (
                        <em className="cbox-warn" title={crewJobs[b.crew.id].lines.join("\n")}>⚠ {crewJobs[b.crew.id].lines.length}</em>
                      )}
                      <b>{b.ppl.filter((p) => !offToday(p.id)).length}p · {b.loads.length}{crewJobs[b.crew.id]?.jobs ? ` · ${crewJobs[b.crew.id].jobs} job${crewJobs[b.crew.id].jobs === 1 ? "" : "s"}` : ""}</b>
                    </div>
                    {b.ppl.length === 0 && b.loads.length === 0 && <span className="cbox-e">empty — drag a name or a truck in</span>}
                    {b.pSlots.map(({ p, x, y, w }) => (
                      <div key={p.id} className="slot" style={{ left: x, top: y, width: w }}>
                        <Plate p={p} off={offToday(p.id)} onClick={() => onPerson(p.id)}
                               warn={p.ops && p.ops.length && b.crew.ops && !p.ops.includes(b.crew.ops) ? `${p.name} isn't set up for ${b.crew.ops}` : ""}
                               onBegin={(e) => begin(e, { kind: "person", id: p.id, name: p.d, color: p.c, from: `crew:${b.crew.id}` })} />
                      </div>
                    ))}
                    {/* one drop slot per column (+ an empty one): drop ON a column to hook there,
                        in the empty slot (or anywhere else in the box) for a column of its own */}
                    {b.cSlots.map(({ k, x, y, w, h, l }) => {
                      const zid = l ? `slot:${b.crew.id}:${k}` : `newcol:${b.crew.id}`;
                      const holding = drag && drag.item.kind === "stack";
                      return (
                        <Zone key={zid} id={zid} accepts={["stack"]} registerZone={registerZone} onDrop={(it) => onMove(it, zid)}
                              className={`cslot${l ? "" : " empty"}${holding ? " ready" : ""}${drag && drag.over === zid ? " hot" : ""}`}
                              style={{ left: x, top: y, width: w, height: h }}>
                          {!l && <span>＋</span>}
                        </Zone>
                      );
                    })}
                    {b.lSlots.map(({ l, x, y }) => (
                      <div key={l.id} className="slot" style={{ left: x, top: y }}>
                        <LoadCard members={l.members} broken={broken(l.id)} odd={stackIssues(l.members)} label={false}
                                  onClick={() => onOpenAsset(l.lead.id)}
                                  onBegin={(e) => { const part = grabbed(e, l.members); begin(e, { kind: "stack", id: part[0].id, members: part.map((m) => m.id),
                                    name: part.map((m) => m.tag).join(" · "), from: part.length === l.members.length ? `crew:${b.crew.id}` : `part:crew:${b.crew.id}` }); }} />
                      </div>
                    ))}
                </Zone>
              ))}
            </div>
          </Zone>
        </div>

        <div className="right">
          <Zone id="yard" accepts={["stack"]} registerZone={registerZone} onDrop={(it) => onMove(it, "yard")}>
            <div className={`bin${hot("yard")}`}>
              <div className="bin-h">AT THE YARD<b>{yard.length}</b></div>
              <div className="bin-b kinds">
                {[...EQUIP_GROUPS, { key: "other", label: "Other" }].map((k) => {
                  const list = yard.filter((g) => equipGroupOf(gMem(g)[0] || {}) === k.key);
                  if (!list.length) return null;
                  return (
                    <div key={k.key} className="krow">
                      <span className="krow-h stencil">{k.label}</span>
                      <div className="krow-b">{list.map((g) => binCard(g, "yard", 1, false))}</div>
                    </div>
                  );
                })}
                {!yard.length && <span className="hint">everything is out</span>}
              </div>
            </div>
          </Zone>
          <Zone id="broke" accepts={["stack"]} registerZone={registerZone} onDrop={(it) => onMove(it, "broke")}>
            <div className={`bin broke${hot("broke")}`}>
              <div className="bin-h">BROKEN · DO NOT OPERATE<b>{brokeList.length}</b></div>
              <div className="hint" style={{ padding: "0 8px" }}>Stays broken on later days until you drag it out. Taking it out on a later day doesn't change the days before.</div>
              <div className="bin-b row">
                {brokeList.map((g) => binCard(g, "broke", 0.95, true))}
                {!brokeList.length && <span className="hint">nothing broken</span>}
              </div>
            </div>
          </Zone>
        </div>
      </div>
      <div className="ybar">
        <span className="fl stencil" style={{ margin: 0 }}>SHOW</span>
        {OP_ORDER.map((o) => (
          <button key={o} className="chip stencil" data-on={ops[o] ? 1 : 0}
                  onClick={() => setOps((s) => ({ ...s, [o]: !s[o] }))}>
            <OpGlyph op={o} /> {o}
          </button>
        ))}
        <span className="vr" />
        <span className="lgs">
          {Object.entries(FAMILY).map(([k, v]) => (
            <span className="lg" key={k}><i style={{ background: v.c }} />{v.label}</span>
          ))}
          <span className="lg"><i className="ring" />down</span>
        </span>
        <div className="spacer" />
        {day.inherited && <span className="inherit stencil">
          {day.inherited === "standing" ? "From the standing setup" : `Same as ${day.inherited}`} — not saved yet
        </span>}
        {outIssues.length > 0 && (
          <span className="odd stencil" title={outIssues.join("\n")}>{outIssues.length} to check</span>
        )}
        <button className="btn stencil" onClick={onCopyDay} title="Remember this day's crews, then go to another day and paste">⧉ Copy this day</button>
        {clip && clip.from !== iso && (
          <button className="btn stencil" data-primary="1" onClick={onPasteDay} title="Put the copied crews on this day">
            ⎘ Paste {new Date(clip.from + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" })} here
          </button>
        )}
        <button className="btn stencil" onClick={() => onCopy("tomorrow")}>Copy to tomorrow →</button>
        <button className="btn stencil" onClick={() => onCopy("week")}>Copy to rest of week</button>
        <button className="btn stencil" data-primary="1" onClick={onNewCrew}>+ New crew</button>
      </div>
    </>
  );
}

const OP_RANK = { GTC: 0, PHC: 1, LC: 2, SHOP: 3, SALES: 4 };
const OP_WORD = { PHC: "PHC", LC: "Lawns", SHOP: "Shop", SALES: "Sales" };

function shortNames(people) {
  const firsts = {};
  people.forEach((p) => { const f = p.name.split(" ")[0]; firsts[f] = (firsts[f] || 0) + 1; });
  const out = {};
  people.forEach((p) => { const f = p.name.split(" ")[0]; out[p.id] = firsts[f] > 1 ? p.name : f; });
  return out;
}

function buildDaySheet(core, crewsMap, week, dayIndex, opt) {
  const roster = live(core.people);
  const short = shortNames(roster);
  const label = (p) => (opt.shortNames ? short[p.id] || p.name : p.name);
  const outCode = (pid) => {
    const c = week.cells[`${pid}:${dayIndex}`];
    return c ? c.code : "on";
  };
  const crews = live(crewsMap).slice()
    .filter((c) => !opt.fieldOnly || ["GTC", "PHC", "LC"].includes(c.ops))
    .sort((a, b) => (OP_RANK[a.ops] != null ? OP_RANK[a.ops] : 9) - (OP_RANK[b.ops] != null ? OP_RANK[b.ops] : 9));

  const segs = [], away = [], grounded = [], bare = [];
  crews.forEach((c) => {
    const names = [];
    c.people.forEach((pid) => {
      const p = core.people[pid];
      if (!p || p.del) return;
      const code = outCode(pid);
      if (code === "vac" || code === "sick" || code === "train") {
        away.push(`${p.name} — ${DAY[code].label.toLowerCase()}`);
        return;
      }
      names.push(label(p));
    });

    const gear = [];
    (c.iron || []).map((i) => core.assets[i]).filter((a) => a && !a.del).forEach((a) => {
      if (a.status === "tagged") {
        grounded.push(`${a.name} — ${ST[a.status].label.toLowerCase()} — on ${c.name}`);
        if (opt.skipDown) return;
      }
      const t = (a.tag || a.name).trim();
      if (t && !gear.includes(t)) gear.push(t);
    });

    if (!names.length && !gear.length) return;
    if (opt.onlyStaffed && !names.length) { if (gear.length) bare.push(c.name); return; }

    let paren = [];
    if (opt.showOp && c.ops && c.ops !== "GTC" && OP_WORD[c.ops]) paren.push(OP_WORD[c.ops]);
    if (opt.showGear) paren = paren.concat(gear);
    // jobs from the Schedule tab, in order
    const jobs = opt.showJobs && opt.jobs ? (opt.jobs[c.id] || []) : [];
    segs.push(names.join(", ") + (paren.length ? ` (${paren.join(", ")})` : "") + (jobs.length ? ` — ${jobs.join(", ")}` : ""));
  });

  return { text: segs.join(opt.sep), segs, away, grounded, bare };
}

function DaySheet({ core, crewsMap, week, iso, dayIndex, onClose }) {
  const shown = new Date(iso + "T00:00:00");
  const day = dayIndex;
  const [opt, setOpt] = useState({
    showGear: true, showOp: true, skipDown: true, onlyStaffed: true,
    shortNames: true, fieldOnly: true, sep: " ---------- ", showJobs: true, jobs: null,
  });
  // the day's jobs from the Schedule tab: crew id -> ["Schreck #27722-2", …] in order
  useEffect(() => {
    let dead = false;
    shopGet(`sched.${iso}`).then((r) => {
      if (dead) return;
      const by = {};
      Object.values(r?.assign || {}).filter((a) => a && a.crew).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach((a) => { (by[a.crew] = by[a.crew] || []).push(a.label + (a.town ? ` (${a.town})` : "")); });
      setOpt((o) => ({ ...o, jobs: by }));
    });
    return () => { dead = true; };
  }, [iso]);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState("");
  const ta = useRef(null);
  const built = buildDaySheet(core, crewsMap, week, day, opt);

  /* regenerate when the day or a switch changes, but leave hand edits alone */
  const sig = `${iso}|${JSON.stringify(opt)}|${JSON.stringify(Object.keys(crewsMap || {}))}`;
  const lastSig = useRef("");
  useEffect(() => {
    if (lastSig.current !== sig) { lastSig.current = sig; setText(built.text); setCopied(""); }
  }, [sig, built.text]);

  const flip = (k) => setOpt((o) => ({ ...o, [k]: !o[k] }));
  const dayName = `${DNAMES[day]} ${shown.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const copy = async () => {
    const value = text;
    try {
      await window.navigator.clipboard.writeText(value);
      setCopied("ok"); return;
    } catch (e) { /* clipboard can be blocked; fall through */ }
    try {
      if (ta.current) {
        ta.current.focus(); ta.current.select();
        const ok = document.execCommand && document.execCommand("copy");
        setCopied(ok ? "ok" : "manual"); return;
      }
    } catch (e) { /* nothing left to try */ }
    if (ta.current) { ta.current.focus(); ta.current.select(); }
    setCopied("manual");
  };

  return (
    <Sheet onClose={onClose} title={`Day sheet · ${dayName}`} sub="Paste this into the SingleOps task. Jobs come from the Schedule tab; add extras by hand.">
      <div className="fl stencil">WHAT GOES IN</div>
      <div className="opts">
        <button className="opt stencil" data-on={opt.showGear ? 1 : 0} onClick={() => flip("showGear")}>Equipment</button>
        <button className="opt stencil" data-on={opt.showJobs ? 1 : 0} onClick={() => flip("showJobs")}>Jobs from the Schedule</button>
        <button className="opt stencil" data-on={opt.showOp ? 1 : 0} onClick={() => flip("showOp")}>PHC / Lawns label</button>
        <button className="opt stencil" data-on={opt.skipDown ? 1 : 0} onClick={() => flip("skipDown")}>Leave out down iron</button>
        <button className="opt stencil" data-on={opt.onlyStaffed ? 1 : 0} onClick={() => flip("onlyStaffed")}>Only crews with people</button>
        <button className="opt stencil" data-on={opt.fieldOnly ? 1 : 0} onClick={() => flip("fieldOnly")}>Field crews only</button>
        <button className="opt stencil" data-on={opt.shortNames ? 1 : 0} onClick={() => flip("shortNames")}>Short first names</button>
        <button className="opt stencil" data-on={opt.sep === "\n" ? 1 : 0}
                onClick={() => setOpt((o) => ({ ...o, sep: o.sep === "\n" ? " ---------- " : "\n" }))}>One crew per line</button>
      </div>

      <div className="fl stencil">{dayName} · {built.segs.length} CREW{built.segs.length === 1 ? "" : "S"}</div>
      <textarea ref={ta} className="ta note-out" value={text} spellCheck={false}
                onChange={(e) => { setText(e.target.value); setCopied(""); }} />
      <div className="row-between">
        <span className="mono" style={{ fontSize: 10.5, color: C.inkFaint }}>{text.length} characters</span>
        {text !== built.text && (
          <button className="lnk stencil" onClick={() => { setText(built.text); setCopied(""); }}>Rebuild from the board</button>
        )}
      </div>

      {built.away.length > 0 && (
        <>
          <div className="fl stencil">LEFT OUT — NOT IN {dayName.split(" ")[0]}</div>
          <ul className="flags">{built.away.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      )}
      {built.grounded.length > 0 && (
        <>
          <div className="fl stencil" style={{ color: ST.tagged.color }}>CHECK BEFORE YOU SEND THIS</div>
          <ul className="flags">{built.grounded.map((g, i) => (
            <li key={i} style={{ color: C.ink }}>{g}{opt.skipDown ? " · left out" : " · still in the note"}</li>
          ))}</ul>
        </>
      )}
      {built.bare.length > 0 && (
        <>
          <div className="fl stencil">CREWS WITH IRON BUT NOBODY ON THEM</div>
          <ul className="flags">{built.bare.map((b, i) => <li key={i}>{b}</li>)}</ul>
        </>
      )}

      <div className="act">
        <button className="btn stencil" data-primary="1" onClick={copy}>Copy for SingleOps</button>
        {copied === "ok" && <span className="okmsg stencil">Copied</span>}
        {copied === "manual" && <span className="okmsg stencil" style={{ color: ST.watch.color }}>
          Selected it for you — press Ctrl/Cmd+C
        </span>}
      </div>
    </Sheet>
  );
}

/* ============================ WEEK ======================================== */
function WeekView({ core, people, engine, week, setCell, marker, setMarker, iso, shift, onDayFocus, onPerson }) {
  const { begin, registerZone, drag } = engine;
  const roster = live(core.people);
  const mon = new Date(iso + "T00:00:00");
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i));
  const todayIso = isoOf(new Date());
  const codeAt = (pid, di) => { const c = week.cells[`${pid}:${di}`]; return c ? c.code : "on"; };
  const outCount = (di) => roster.filter((p) => { const c = codeAt(p.id, di); return c !== "on" && c !== "light"; }).length;

  return (
    <>
      <div className="wk-tools">
        <button className="btn stencil" onClick={() => shift(-7)}>‹ Prev</button>
        <span className="stencil" style={{ fontSize: 13, letterSpacing: ".08em", minWidth: 152, textAlign: "center" }}>
          {mon.toLocaleDateString(undefined, { month: "short", day: "numeric" })} — {addDays(mon, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
        <button className="btn stencil" onClick={() => shift(7)}>Next ›</button>
        <button className="btn stencil" onClick={() => shift(0)}>This week</button>
      </div>

      <div className="wk-tools" style={{ paddingTop: 12 }}>
        <span className="fl stencil" style={{ margin: 0 }}>PICK A MARKER, THEN SWIPE THE DAYS</span>
        {DAY_ORDER.map((k) => (
          <button key={k} className="marker stencil" data-on={marker === k ? 1 : 0}
                  onClick={() => setMarker(k)}
                  onPointerDown={(e) => { setMarker(k); begin(e, { kind: "marker", code: k, name: DAY[k].label, instant: true }); }}>
            <span className="swatch" style={{ background: DAY[k].color }} />{DAY[k].label}
          </button>
        ))}
      </div>

      <div className="wk-wrap">
        <div className="wk" style={{ gridTemplateColumns: "142px repeat(7,minmax(66px,1fr))" }}>
          <div className="wk-hn stencil">CREW MEMBER</div>
          {days.map((d, i) => (
            <button key={i} className="wk-hc stencil" data-today={isoOf(d) === todayIso ? 1 : 0} onClick={() => onDayFocus(i)}>
              {DNAMES[i]} {d.getDate()}
              <small>{outCount(i) ? `${outCount(i)} out` : "full"}</small>
            </button>
          ))}
          {roster.map((p) => (
            <React.Fragment key={p.id}>
              <div className="wk-rn stencil">
                <span className="pc" style={{ background: p.c || C.edge }} />
                <button className="stencil pn" onClick={() => onPerson(p.id)}>{p.d}</button>
                <button className="stencil mf" title={`Mark Mon–Fri as ${DAY[marker].label}`}
                        onClick={() => [1, 2, 3, 4, 5].forEach((i) => setCell(p.id, i, marker))}>M–F</button>
              </div>
              {days.map((d, i) => {
                const code = codeAt(p.id, i), zid = `wc:${p.id}:${i}`;
                return (
                  <Zone key={i} id={zid} accepts={["marker"]} paint registerZone={registerZone}
                        onDrop={(item) => setCell(p.id, i, item.code)}>
                    <div className="cell" data-hot={drag && drag.over === zid ? 1 : 0} data-wknd={i === 0 || i === 6 ? 1 : 0}
                         onClick={() => setCell(p.id, i, marker)}
                         onPointerDown={(e) => begin(e, { kind: "marker", code: marker, name: DAY[marker].label, axis: "x" })}>
                      {code !== "on" && <span style={{ background: DAY[code].color }}>{DAY[code].short}</span>}
                    </div>
                  </Zone>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="legend">
        {DAY_ORDER.map((k) => <i key={k}><span className="swatch" style={{ background: DAY[k].color }} />{DAY[k].label}</i>)}
        <i style={{ color: C.inkFaint }}>Tap a day heading to sort that day by hand.</i>
      </div>
    </>
  );
}

/* ============================ SHEETS ====================================== */
const Sheet = ({ onClose, title, sub, tone, children }) => (
  <div className="scrim" onClick={onClose}>
    <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <div className="sheet-h">
        {tone && <div style={{ width: 4, alignSelf: "stretch", background: tone, borderRadius: 1 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <em className="stencil">{title}</em>
          {sub && <small>{sub}</small>}
        </div>
        <button className="btn stencil" onClick={onClose}>Close</button>
      </div>
      <div className="sheet-b">{children}</div>
    </div>
  </div>
);

function AssetSheet({ a, core, iso, onClose, onStatus, onField, onToggleOp, onDelete, onLabel }) {
  const st = ST[a.status];
  const using = live(core.crews).filter((c) => (c.iron || []).includes(a.id));
  /* text fields commit on blur and on close, so typing is not one write per key */
  const [tag, setTag] = useState(a.tag || "");
  const [note, setNote] = useState(a.note || "");
  const refs = useRef({ tag, note }); refs.current = { tag, note };
  const commitTag = useCallback(() => {
    const v = refs.current.tag.trim();
    if (v !== (a.tag || "")) onField(a.id, "tag", v);
  }, [a.id, a.tag, onField]);
  const commitNote = useCallback(() => {
    if (refs.current.note !== (a.note || "")) onField(a.id, "note", refs.current.note);
  }, [a.id, a.note, onField]);
  useEffect(() => () => { commitTag(); commitNote(); }, [commitTag, commitNote]);
  return (
    <Sheet onClose={onClose} title={a.name} sub={a.spec} tone={st.color}>
      <div style={{ background: C.bg, border: `1px solid ${C.edgeSoft}`, borderRadius: 3, padding: "6px 10px 0",
                    "--mach": tones(a.fam).body, "--mach-lo": tones(a.fam).lo, "--mach-hi": tones(a.fam).hi }}>
        <Machine shape={a.shape} dim={a.status === "parked"} />
      </div>

      <div className="fl stencil">CONDITION{iso ? ` ON ${fmtIso(iso).toUpperCase()}` : ""}</div>
      {spansOf(a).length > 0 && (
        <div className="hint" style={{ padding: "0 0 6px" }}>
          {spansOf(a).map((x, i) => <div key={i}>Broken from {fmtIso(x.from)}{x.to ? ` — back in service ${fmtIso(x.to)}` : " — until taken out of Broken"}</div>)}
        </div>
      )}
      <div className="opts">
        {ST_ORDER.map((k) => (
          <button key={k} className="opt stencil" data-on={a.status === k ? 1 : 0} onClick={() => onStatus(a.id, k)}>
            <span className="swatch" style={{ background: ST[k].color }} />{ST[k].label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.inkDim, marginTop: 8 }}>{st.note}</div>

      <div className="fl stencil">OPERATIONS</div>
      <div className="opts">
        {OP_ORDER.map((o) => (
          <button key={o} className="opt stencil" data-on={a.ops.includes(o) ? 1 : 0} onClick={() => onToggleOp(a.id, o)}>
            <OpGlyph op={o} /> {OPS[o].label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.inkDim, marginTop: 8 }}>
        Pick more than one when a unit gets shared across service lines.
      </div>

      <div className="fl stencil">YARD</div>
      <div className="opts">
        {["Brighton", "Rush Scottsville", "Off-site"].map((y) => (
          <button key={y} className="opt stencil" data-on={a.yard === y ? 1 : 0} onClick={() => onField(a.id, "yard", y)}>{y}</button>
        ))}
      </div>

      <div className="fl stencil">ON A CREW TODAY</div>
      {using.length === 0
        ? <div style={{ fontSize: 11.5, color: C.inkFaint }}>Not on a crew. Assign it on the Crews tab.</div>
        : <div className="opts">{using.map((c) => <span key={c.id} className="mini stencil" style={{ borderLeftColor: C.edge }}>{c.name}</span>)}</div>}

      {onLabel && (
        <>
          <div className="fl stencil">NAME · LABEL ON THE DRAWING · PLATE</div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.3fr 1fr", gap: 6 }}>
            <input className="srch" style={{ width: "100%" }} defaultValue={a.name} key={`n${a.id}`} placeholder="Name"
                   onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.name) onLabel(a.id, "name", v.toUpperCase()); }} />
            <input className="srch" style={{ width: "100%" }} defaultValue={a.vl || ""} key={`v${a.id}`} placeholder="Drawing label"
                   onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a.vl) onLabel(a.id, "vl", v.toUpperCase()); }} />
            <input className="srch" style={{ width: "100%" }} defaultValue={a.plate || ""} key={`p${a.id}`} placeholder="Plate"
                   onBlur={(e) => { const v = e.target.value.trim(); if (v !== (a.plate || "")) onLabel(a.id, "plate", v); }} />
          </div>
          <div style={{ fontSize: 11, color: C.inkDim, marginTop: 6 }}>The drawing and what it can tow stay as they are.</div>
        </>
      )}
      <div className="fl stencil">HOW IT READS IN THE DAY SHEET</div>
      <input className="srch" style={{ width: "100%" }} value={tag} placeholder={a.name}
             onChange={(e) => setTag(e.target.value)} onBlur={commitTag} />
      <div style={{ fontSize: 11, color: C.inkDim, marginTop: 8 }}>
        Short, the way the crew says it — Lift, Chip Truck, Bridgette.
      </div>

      <div className="fl stencil">NOTE</div>
      <textarea className="ta" value={note} placeholder="Anything the next person needs to know."
                onChange={(e) => setNote(e.target.value)} onBlur={commitNote} />

      <div className="fl stencil">IDENTIFICATION</div>
      <dl className="kv">
        <dt>Type</dt><dd>{a.cat}</dd>
        <dt>Plate</dt><dd className="mono">{a.plate || "—"}</dd>
        {a.by && <><dt>Last touched</dt><dd>{a.by} · {ago(a.at)}</dd></>}
      </dl>
      <div style={{ fontSize: 11, color: C.inkFaint, marginTop: 9 }}>
        Service history, meters and reminders stay in Fleetio.
      </div>

      <div className="act">
        <button className="btn stencil" data-danger="1" onClick={() => onDelete(a.id)}>Remove from board</button>
      </div>
    </Sheet>
  );
}

/* Add a unit to the fleet. Its kind (drawing, family, what it tows or rides
   on) is copied from an existing unit of the same kind, so it draws and
   hitches correctly; you give it a name, plate, yard and operations. */
const KIND_NAMES = {
  chipbody: "Chip truck", rolloff: "Dump / wood truck", flatbed: "Pickup (flatbed)", bucket: "Bucket truck",
  cabover: "Cab-over rig (PHC)", landscape: "Lawn truck", utv: "UTV / spray rig",
  spider: "Spider lift", avant: "Avant", chipper: "Chipper", grinder: "Stump grinder",
};
function AddAssetSheet({ onClose, onCreate }) {
  const kinds = Object.keys(KIND_NAMES).map((top) => ({ top, tpl: SEED_ASSETS.find((x) => x.top === top) })).filter((k) => k.tpl);
  const [top, setTop] = useState("chipbody");
  const tpl = (kinds.find((k) => k.top === top) || kinds[0]).tpl;
  const [f, setF] = useState({ name: "", plate: "", yard: "Brighton", tag: "" });
  const [ops, setOps] = useState(() => tpl.ops.slice());
  useEffect(() => { setOps(tpl.ops.slice()); }, [top]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = () => {
    const name = f.name.trim().toUpperCase(); if (!name) return;
    onCreate({
      name, vl: name.slice(0, 12), code: name.replace(/[^A-Z0-9]/g, "").slice(0, 4) || "NEW",
      spec: KIND_NAMES[top] + (f.plate ? " · " + f.plate : ""), plate: f.plate.trim(), yard: f.yard, ops, status: "running", note: "",
      tag: f.tag.trim() || tpl.tag, cat: tpl.cat, shape: tpl.shape, top: tpl.top, fam: tpl.fam, hc: tpl.hc === "carried" ? "towed" : tpl.hc,
      ...(tpl.tt || tpl.rides ? { tt: tpl.tt || tpl.rides[0] } : {}), ...(tpl.pull ? { pull: tpl.pull.slice() } : {}), ...(tpl.avoid ? { avoid: tpl.avoid.slice() } : {}), ...(tpl.rides ? { rides: tpl.rides.slice() } : {}),
    });
  };
  return (
    <Sheet onClose={onClose} title="Add equipment" sub="Pick what kind of unit it is, then name it.">
      <div className="fl stencil">KIND</div>
      <div className="opts">
        {kinds.map((k) => <button key={k.top} className="opt stencil" data-on={top === k.top ? 1 : 0} onClick={() => setTop(k.top)}>{KIND_NAMES[k.top]}</button>)}
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}>
        <TopLoad members={[{ ...tpl, id: "preview", name: f.name || tpl.name, vl: (f.name || tpl.vl || "").toUpperCase().slice(0, 12), status: "running" }]} scale={1.2} />
      </div>
      <div className="fl stencil">NAME</div>
      <input className="srch" style={{ width: "100%" }} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. F750 CHIP '27" autoFocus />
      <div className="fl stencil">PLATE · HOW IT READS IN THE DAY SHEET</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <input className="srch" style={{ width: "100%" }} value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="Plate (optional)" />
        <input className="srch" style={{ width: "100%" }} value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} placeholder={`e.g. ${tpl.tag}`} />
      </div>
      <div className="fl stencil">YARD</div>
      <div className="opts">{["Brighton", "Rush Scottsville", "Off-site"].map((y) => <button key={y} className="opt stencil" data-on={f.yard === y ? 1 : 0} onClick={() => setF({ ...f, yard: y })}>{y}</button>)}</div>
      <div className="fl stencil">OPERATIONS</div>
      <div className="opts">{OP_ORDER.map((o) => { const on = ops.includes(o); return <button key={o} className="opt stencil" data-on={on ? 1 : 0} onClick={() => setOps(on ? ops.filter((x) => x !== o) : [...ops, o])}>{o}</button>; })}</div>
      <div className="act">
        <button className="btn stencil" data-primary="1" disabled={!f.name.trim()} onClick={create}>Add to the fleet</button>
        <button className="btn stencil" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

/* Edit a crew: name, operation, and its people and equipment — with lists and
   pickers, so nothing has to be dragged. Off-duty people can't be added. */
function CrewSheet({ c, core, day, offToday, onClose, onRename, onOps, onDelete, onAddPerson, onRemovePerson, onAddStack, onRemoveStack }) {
  const [name, setName] = useState(c.name);
  const nameRef = useRef(name); nameRef.current = name;
  const killed = useRef(false);
  const commit = useCallback(() => {
    const v = nameRef.current.trim().toUpperCase();
    if (!killed.current && v && v !== c.name) onRename(c.id, v);
  }, [c.id, c.name, onRename]);
  useEffect(() => () => commit(), [commit]);   // closing the sheet saves the name
  const crews = live(day.crews);
  const crewOfPerson = (pid) => crews.find((x) => x.id !== c.id && (x.people || []).includes(pid));
  const people = (c.people || []).map((id) => core.people[id]).filter((p) => p && !p.del);
  const others = live(core.people).filter((p) => !(c.people || []).includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const mine = loadsOf(c, core.assets, deriveHitch(day.crews, core.assets)).map((l) => ({ id: l.id, members: l.members.map((m) => m.id) }));
  const free = yardGroups(day, core.assets);
  const memOf = (g) => g.members.map((m) => core.assets[m]).filter((a) => a && !a.del);
  const opsMismatch = (p) => (p.ops && p.ops.length && c.ops && !p.ops.includes(c.ops) ? `not set up for ${c.ops}` : "");
  const statusWord = (k) => { const m = memOf(k); return m.some((a) => a.status === "tagged") ? " — BROKEN" : ""; };
  return (
    <Sheet onClose={onClose} title={c.name} sub={`${people.length} on the crew · ${mine.length} load${mine.length === 1 ? "" : "s"}`}>
      <div className="fl stencil">CREW NAME</div>
      <input className="srch" style={{ width: "100%" }} value={name}
             onChange={(e) => setName(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === "Enter") { commit(); } }} />
      <div className="fl stencil">OPERATION</div>
      <div className="opts">
        {[...OP_ORDER, "SHOP"].map((l) => (
          <button key={l} className="opt stencil" data-on={c.ops === l ? 1 : 0} onClick={() => onOps(c.id, l)}>
            {OPS[l] ? <><OpGlyph op={l} /> {OPS[l].label}</> : "Shop"}
          </button>
        ))}
      </div>

      <div className="fl stencil">PEOPLE</div>
      <div className="opts">
        {people.map((p) => (
          <span key={p.id} className="mini stencil" style={{ borderLeftColor: p.c || C.edge, gap: 8 }}>
            {p.d}{offToday(p.id) ? <em style={{ color: C.inkFaint, fontStyle: "normal" }}> off today</em> : null}
            {opsMismatch(p) ? <em style={{ color: ST.watch.color, fontStyle: "normal" }}> ⚠ {opsMismatch(p)}</em> : null}
            <button className="lnk" title="Take off this crew" onClick={() => onRemovePerson(p.id)}>✕</button>
          </span>
        ))}
        {!people.length && <span className="hint">Nobody on this crew yet.</span>}
      </div>
      <select className="srch" style={{ width: "100%", marginTop: 8 }} value="" onChange={(e) => { if (e.target.value) onAddPerson(e.target.value); }}>
        <option value="">+ Add a person…</option>
        {others.map((p) => {
          const off = offToday(p.id), on = crewOfPerson(p.id), mm = opsMismatch(p);
          return <option key={p.id} value={p.id} disabled={!!off}>{p.name}{off ? " — off duty" : on ? ` — move from ${on.name}` : ""}{mm ? ` (⚠ ${mm})` : ""}</option>;
        })}
      </select>

      <div className="fl stencil">EQUIPMENT</div>
      <div style={{ display: "grid", gap: 4 }}>
        {mine.map((g) => (
          <div key={g.id} className="mini stencil" style={{ justifyContent: "space-between", borderLeftColor: memOf(g).some((a) => a.status === "tagged") ? ST.tagged.color : C.edge }}>
            <span>{memOf(g).map((m) => m.tag || m.name).join(" · ")}{statusWord(g)}</span>
            <button className="lnk" title="Back to the yard" onClick={() => onRemoveStack(g)}>✕</button>
          </div>
        ))}
        {!mine.length && <span className="hint">No equipment on this crew yet.</span>}
      </div>
      <select className="srch" style={{ width: "100%", marginTop: 8 }} value="" onChange={(e) => { const g = free.find((x) => x.id === e.target.value); if (g) onAddStack(g); }}>
        <option value="">+ Add equipment from the yard…</option>
        {free.map((g) => <option key={g.id} value={g.id}>{memOf(g).map((m) => `${m.tag || m.name} (${m.name})`).join(" · ")}{statusWord(g)}</option>)}
      </select>
      <div style={{ fontSize: 11, color: C.inkDim, marginTop: 8 }}>A truck comes with whatever is hitched to it. Changes save as you make them.</div>

      <div className="act">
        <button className="btn stencil" data-primary="1" onClick={() => { commit(); onClose(); }}>Done</button>
        <button className="btn stencil" data-danger="1" onClick={() => { if (window.confirm(`Delete ${c.name}? Its people go back to the crew room and its equipment to the yard.`)) { killed.current = true; onDelete(c.id); } }}>Delete crew</button>
      </div>
    </Sheet>
  );
}

function PersonSheet({ p, core, onClose, onRename, onRemove, offToday, onBackOnDuty, onCalendar, onSetPerson }) {
  const [name, setName] = useState(p.name);
  const nameRef = useRef(name); nameRef.current = name;
  const killed = useRef(false);
  const commit = useCallback(() => {
    const v = nameRef.current.trim();
    if (!killed.current && v && v !== p.name) onRename(p.id, v);
  }, [p.id, p.name, onRename]);
  useEffect(() => () => commit(), [commit]);
  const crew = live(core.crews).find((c) => (c.people || []).includes(p.id));
  const iron = crew ? crew.iron.map((i) => core.assets[i]).filter((a) => a && !a.del) : [];
  return (
    <Sheet onClose={onClose} title={p.d} sub={crew ? `On ${crew.name}` : "Not on a crew"}>
      <div className="fl stencil">NAME</div>
      <input className="srch" style={{ width: "100%" }} value={name}
             onChange={(e) => setName(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === "Enter") { commit(); onClose(); } }} />
      <div style={{ fontSize: 11, color: C.inkDim, marginTop: 8 }}>
        Spell it the way SingleOps does, so the crew recognizes the name.
      </div>
      {offToday && (
        <div style={{ marginTop: 12, padding: "10px 12px", background: C.bg, border: `1px solid ${C.edgeSoft}`, borderRadius: 3 }}>
          <div style={{ fontSize: 12.5 }}>Off duty today — {offToday.toLowerCase()}.</div>
          <div className="opts" style={{ marginTop: 8 }}>
            <button className="btn stencil" data-primary="1" onClick={onBackOnDuty}>Back on duty today</button>
            <button className="btn stencil" onClick={onCalendar}>Days off calendar</button>
          </div>
        </div>
      )}
      {!offToday && <div className="opts" style={{ marginTop: 10 }}><button className="btn stencil" onClick={onCalendar}>Days off calendar</button></div>}
      <PersonExtras person={p} onSet={onSetPerson} />
      <div className="fl stencil">WITH THEM TODAY</div>
      {iron.length === 0
        ? <div style={{ fontSize: 11.5, color: C.inkFaint }}>No units on their crew.</div>
        : <div className="opts">{iron.map((a) => (
            <span key={a.id} className="mini stencil" style={{ borderLeftColor: ST[a.status].color }}>{a.name}</span>
          ))}</div>}
      <div className="act">
        <button className="btn stencil" data-danger="1"
                onClick={() => { killed.current = true; onRemove(p.id); }}>Remove from board</button>
      </div>
    </Sheet>
  );
}

/* ============================ PEOPLE ======================================
   Who is around, and when. A big month calendar: pick a person, pick a reason,
   then tap days (or drag across them). Days off are saved in the same week
   records the yard reads, so on those days the person sits in Off Duty and
   can't be put on a crew. Each person's operations (GTC / PHC / LC / Shop /
   Sales) are set here; the yard flags anyone put on a crew outside them.   */
const PERSON_OPS = ["GTC", "PHC", "LC", "SHOP", "SALES"];
/* Where a person starts the day when not on a crew: the yard (crew room) or the
   office. Liz D and Mike T default to the office (owner, Nov 24). */
const OFFICE_DEFAULT = ["p09", "p13"];
const homeOf = (p) => p.home || (OFFICE_DEFAULT.includes(p.id) ? "office" : "yard");
/* Person colours: everyone's SingleOps colour, plus any added since. */
const PERSON_COLORS = ["#008299", ...new Set(SEED_PEOPLE.map((p) => p.c)), "#E5A100", "#17A05B", "#3A8DD8", "#D93B2B", "#B388FF", "#FF7043"];
function PersonExtras({ person, onSet }) {
  return (
    <>
      <div className="fl stencil">PHONE (FOR GROUP TEXTS IN COMMS)</div>
      <input className="srch" type="tel" inputMode="tel" style={{ width: "100%" }} key={`ph-${person.id}`} defaultValue={person.phone || ""} placeholder="585-555-1234"
             onBlur={(e) => { const v = e.target.value.trim(); if (v !== (person.phone || "")) onSet(person.id, { phone: v }); }} />
      <div className="fl stencil">COLOUR</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        {PERSON_COLORS.map((c) => (
          <button key={c} title={c === "#008299" ? `${c} (the colour sent for Alexander)` : c} onClick={() => onSet(person.id, { c })}
                  style={{ width: 22, height: 22, borderRadius: 3, background: c, border: person.c === c ? "2px solid #fff" : "1px solid #0b0e11" }} />
        ))}
        <label title="Any colour" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: C.inkDim }}>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(person.c || "") ? person.c : "#888888"} onChange={(e) => onSet(person.id, { c: e.target.value.toUpperCase() })}
                 style={{ width: 28, height: 22, padding: 0, border: 0, background: "none" }} /> other
        </label>
      </div>
      <div className="fl stencil">ROLE · WHERE THEY START</div>
      <div className="opts">
        <label className="opt stencil" data-on={person.foreman ? 1 : 0} style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
          <input type="checkbox" checked={!!person.foreman} onChange={() => onSet(person.id, { foreman: !person.foreman })} style={{ width: 16, height: 16, accentColor: "#E5A100" }} />
          {person.foreman ? "★ Foreman — yes" : "Foreman — no"}
        </label>
        <button className="opt stencil" data-on={homeOf(person) === "yard" ? 1 : 0} onClick={() => onSet(person.id, { home: "yard" })}>Yard</button>
        <button className="opt stencil" data-on={homeOf(person) === "office" ? 1 : 0} onClick={() => onSet(person.id, { home: "office" })}>Office</button>
      </div>
    </>
  );
}
// Owner, Nov 24: only "Off duty" (older sick / training marks still count as off).
const REASONS = [["vac", "Off duty"], ["hol", "🎉 Holiday (everyone)"], ["on", "Back on duty"]];

function PeopleView({ core, me, boardWeekIso, onBoardCell, onRename, onSetOps, onAddPerson, onRemove, onSetPerson }) {
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [picked, setPicked] = useState(() => new Set());   // people to mark (tap names to pick several)
  const sel = picked.size === 1 ? [...picked][0] : null;
  const [editing, setEditing] = useState(null);              // the person whose ✎ Edit is open
  const lastPick = useRef(null);
  const setSel = (id) => setPicked(id ? new Set([id]) : new Set());
  const [reason, setReason] = useState("vac");
  const [weeks, setWeeks] = useState({});        // sunday iso -> cells
  const [err, setErr] = useState("");
  const paint = useRef(null);                    // { code, done:Set } while dragging across days
  const roster = live(core.people).sort((a, b) => a.name.localeCompare(b.name));
  const person = sel && core.people[sel];

  // the 6 calendar weeks shown for this month
  const first = weekStartOf(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const sundays = [0, 1, 2, 3, 4, 5].map((w) => isoOf(addDays(first, w * 7)));
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    Promise.all(sundays.map((sun) => shopGet(`week.${sun}`).then((v) => [sun, v?.cells || {}]))).then((list) => {
      if (g === gen.current) setWeeks(Object.fromEntries(list));
    });
  }, [isoOf(month)]); // eslint-disable-line react-hooks/exhaustive-deps

  const cellOf = (pid, d) => {
    const sun = isoOf(weekStartOf(d)), di = d.getDay();
    return (weeks[sun] || {})[`${pid}:${di}`];
  };
  const codeOf = (pid, d) => { const c = cellOf(pid, d); return c && c.code !== "on" ? c.code : null; };

  /* Mark several people / days at once: one save per week touched. */
  const setMany = (items) => {
    const at = stampNow(), by = (me && me.name) || "?";
    const byWeek = {};
    items.forEach(({ pid, d, code }) => {
      const sun = isoOf(weekStartOf(d)), key = `${pid}:${d.getDay()}`;
      (byWeek[sun] = byWeek[sun] || {})[key] = { code, at, by };
    });
    setWeeks((w) => { const n = { ...w }; Object.entries(byWeek).forEach(([sun, cells]) => { n[sun] = { ...(n[sun] || {}), ...cells }; }); return n; });
    Object.entries(byWeek).forEach(([sun, cells]) => {
      if (sun === boardWeekIso) Object.entries(cells).forEach(([key, val]) => onBoardCell(key, val));   // the yard shows it straight away
      shopPatch(`week.${sun}`, { cells }).then((r) => { if (!r) setErr("Couldn't save a change — check your connection."); else setErr(""); });
    });
  };
  const setDay = (pid, d, code) => setMany([{ pid, d, code }]);
  const tapDay = (d, dragging) => {
    const k = isoOf(d);
    // Holiday: everyone off that day (tap again to put everyone back on)
    if (reason === "hol") {
      if (dragging) { if (paint.current.done.has(k)) return; paint.current.done.add(k); setMany(roster.map((p) => ({ pid: p.id, d, code: paint.current.code }))); return; }
      const allHol = roster.every((p) => codeOf(p.id, d) === "hol");
      const code = allHol ? "on" : "hol";
      paint.current = { code, done: new Set([k]) };
      setMany(roster.map((p) => ({ pid: p.id, d, code })));
      return;
    }
    if (!picked.size) { setErr("Pick one or more people on the left first (tap names), or choose Holiday."); return; }
    const ids = [...picked];
    if (dragging) { if (paint.current.done.has(k)) return; paint.current.done.add(k); setMany(ids.map((pid) => ({ pid, d, code: paint.current.code }))); return; }
    const cur = codeOf(ids[0], d);
    const code = reason === "on" ? "on" : cur === reason ? "on" : reason;   // tap again to clear
    paint.current = { code, done: new Set([k]) };
    setMany(ids.map((pid) => ({ pid, d, code })));
  };
  /* Shift-tap: mark every day from the last tapped day to this one (owner, Nov 25:
     tap Monday, Shift-tap Friday = the whole week) — same reason as the last tap. */
  const lastDay = useRef(null);
  const markRange = (a, b) => {
    const from = a < b ? a : b, to = a < b ? b : a;
    const ids = reason === "hol" ? roster.map((p) => p.id) : [...picked];
    if (!ids.length) { setErr("Pick one or more people on the left first, or choose Holiday."); return; }
    const code = reason === "on" ? "on" : (paint.current && paint.current.code) || reason;
    const list = [];
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) ids.forEach((pid) => list.push({ pid, d: new Date(d), code }));
    setMany(list);
  };
  const onGridMove = (e) => {
    if (!paint.current || !e.buttons) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-day]");
    if (el) tapDay(new Date(el.dataset.day + "T00:00:00"), true);
  };
  useEffect(() => { const up = () => { paint.current = null; }; window.addEventListener("pointerup", up); return () => window.removeEventListener("pointerup", up); }, []);

  const inMonth = (d) => d.getMonth() === month.getMonth();
  const todayIso = isoOf(new Date());
  const offCount = (pid) => days.filter((d) => inMonth(d) && codeOf(pid, d) && codeOf(pid, d) !== "light").length;
  const monthName = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="ppl">
      <div className="ppl-side">
        <div className="bin-h" style={{ border: 0 }}>PEOPLE<button className="lnk stencil" onClick={onAddPerson}>+ add person</button><b>{roster.length}</b></div>
        <div style={{ display: "flex", gap: 6, padding: "0 8px 6px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="hint" style={{ padding: 0 }}>{picked.size > 1 ? `${picked.size} picked` : "Tap a name · Ctrl / Shift for several"}</span>
          <span className="spacer" />
          <button className="lnk stencil" onClick={() => setPicked(new Set(roster.map((p) => p.id)))}>select all</button>
          {picked.size > 0 && <button className="lnk stencil" onClick={() => setPicked(new Set())}>clear</button>}
        </div>
        <div className="ppl-list">
          {roster.map((p, idx) => (
            <div key={p.id} className="ppl-row" data-on={picked.has(p.id) ? 1 : 0} role="button" tabIndex={0}
                 onClick={(e) => {
                   // one person at a time; Ctrl / ⌘ adds or removes one; Shift picks the range (owner, Nov 24)
                   if (e.shiftKey && lastPick.current != null) {
                     const a = roster.findIndex((x) => x.id === lastPick.current), lo = Math.min(a, idx), hi = Math.max(a, idx);
                     setPicked((cur) => { const n = new Set(cur); roster.slice(lo, hi + 1).forEach((x) => n.add(x.id)); return n; });
                   } else if (e.ctrlKey || e.metaKey) {
                     setPicked((cur) => { const n = new Set(cur); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; });
                     lastPick.current = p.id;
                   } else { setPicked((cur) => (cur.size === 1 && cur.has(p.id) ? new Set() : new Set([p.id]))); lastPick.current = p.id; }
                 }}>
              <i style={{ background: p.c || C.edge }} />
              <span className="stencil">{p.foreman ? "★ " : ""}{p.d}</span>
              <small>{(p.ops && p.ops.length ? p.ops : ["all"]).join(" · ")}{offCount(p.id) ? ` · ${offCount(p.id)} off` : ""}</small>
              <button className="ppl-ed stencil" title={`Edit ${p.name}`} onClick={(e) => { e.stopPropagation(); setEditing(p.id); }}>✎ Edit</button>
            </div>
          ))}
        </div>
        {editing && core.people[editing] && !core.people[editing].del && (() => { const person = core.people[editing]; return (
          <div onClick={() => setEditing(null)} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="ppl-edit" onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 100%)", maxHeight: "90vh", borderRadius: 6, border: `1px solid ${C.edge}` }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}><b className="stencil" style={{ fontSize: 14 }}>Edit {person.name}</b><span className="spacer" /><button className="btn stencil" onClick={() => setEditing(null)}>✕</button></div>
            <div className="fl stencil">NAME</div>
            <input className="srch" style={{ width: "100%" }} defaultValue={person.name} key={person.id}
                   onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== person.name) onRename(person.id, v); }} />
            <div className="fl stencil">WORKS IN</div>
            <div className="opts">
              {PERSON_OPS.map((o) => {
                const on = (person.ops || []).includes(o);
                return <button key={o} className="opt stencil" data-on={on ? 1 : 0}
                               onClick={() => onSetOps(person.id, on ? (person.ops || []).filter((x) => x !== o) : [...(person.ops || []), o])}>{on ? "✓ " : ""}{o}</button>;
              })}
            </div>
            <div className="hint" style={{ padding: "6px 0" }}>{person.ops && person.ops.length ? `The yard flags ${person.name.split(" ")[0]} if put on a crew outside these.` : "None ticked = can work anywhere."}</div>
            <PersonExtras person={person} onSet={onSetPerson} />
            <div className="act" style={{ marginTop: 8 }}>
              <button className="btn stencil" data-danger="1" onClick={() => { if (window.confirm(`Remove ${person.name} from the board?`)) { onRemove(person.id); setSel(null); setEditing(null); } }}>Remove from board</button>
              <button className="btn stencil" data-primary="1" onClick={() => setEditing(null)}>Done</button>
            </div>
          </div>
          </div>
        ); })()}
      </div>

      <div className="ppl-main">
        <div className="ppl-top">
          <button className="btn stencil" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
          <span className="stencil ppl-month">{monthName}</span>
          <button className="btn stencil" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
          <button className="btn stencil" onClick={() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonth(d); }}>This month</button>
          <span className="spacer" />
          <span className="hint" style={{ padding: 0 }}>{reason === "hol" ? <>Tap a day: <b style={{ color: C.ink }}>everyone</b> off (tap again to undo)</> : picked.size > 1 ? <>Tap or drag across days to mark <b style={{ color: C.ink }}>{picked.size} people</b>:</> : person ? <>Tap or drag across days to mark <b style={{ color: C.ink }}>{person.name}</b>:</> : "Pick people on the left, then:"}</span>
          {REASONS.map(([k, l]) => (
            <button key={k} className="marker stencil" data-on={reason === k ? 1 : 0} onClick={() => setReason(k)}>
              {k !== "on" && <span className="swatch" style={{ background: DAY[k].color }} />}{l}
            </button>
          ))}
        </div>
        {err && <div className="hint" style={{ color: "#E8867B" }}>{err}</div>}
        <div className="cal-grid" onPointerMove={onGridMove} style={{ touchAction: picked.size || reason === "hol" ? "none" : "auto" }}>
          {DNAMES.map((n) => <div key={n} className="cal-h stencil">{n}</div>)}
          {days.map((d) => {
            const k = isoOf(d);
            const offs = roster.map((p) => ({ p, code: codeOf(p.id, d) })).filter((x) => x.code);
            const mine = sel && codeOf(sel, d);
            return (
              <div key={k} data-day={k} className="cal-d" data-out={inMonth(d) ? 0 : 1} data-today={k === todayIso ? 1 : 0}
                   data-wknd={d.getDay() === 0 || d.getDay() === 6 ? 1 : 0}
                   style={mine ? { boxShadow: `inset 0 0 0 2px ${DAY[mine].color}`, background: `${DAY[mine].color}22` } : undefined}
                   onPointerDown={(e) => { e.preventDefault(); if (e.shiftKey && lastDay.current) markRange(lastDay.current, d); else tapDay(d, false); lastDay.current = d; }}>
                <b className="mono">{d.getDate()}</b>
                <div className="cal-offs">
                  {offs.slice(0, 6).map(({ p, code }) => (
                    <span key={p.id} className="cal-off" style={{ borderLeftColor: p.c || C.edge, opacity: code === "light" ? 0.7 : 1 }} title={`${p.name} — ${DAY[code].label}`}>
                      {(p.name || "").split(" ")[0]} <em style={{ color: DAY[code].color }}>{DAY[code].short}</em>
                    </span>
                  ))}
                  {offs.length > 6 && <span className="cal-off">+{offs.length - 6} more</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="legend" style={{ padding: "8px 0 0" }}>
          <i><span className="swatch" style={{ background: DAY.vac.color }} />Off duty — sits in Off Duty on the yard that day</i>
          <i style={{ color: C.inkFaint }}>Tap a marked day again to clear it.</i>
        </div>
      </div>
    </div>
  );
}

function DayFocus({ dayIndex, iso, core, week, setCell, engine, onClose }) {
  const { begin, registerZone, drag } = engine;
  const roster = live(core.people);
  const d = addDays(new Date(iso + "T00:00:00"), dayIndex);
  const codeAt = (pid) => { const c = week.cells[`${pid}:${dayIndex}`]; return c ? c.code : "on"; };
  return (
    <Sheet onClose={onClose} title={`${DNAMES[dayIndex]} ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
           sub="Drag names between the groups.">
      {DAY_ORDER.map((k) => {
        const zid = `df:${k}`;
        const mine = roster.filter((p) => codeAt(p.id) === k);
        return (
          <div key={k} style={{ marginBottom: 11 }}>
            <div className="sec-l stencil" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="swatch" style={{ background: DAY[k].color }} />{DAY[k].label} · {mine.length}
            </div>
            <Zone id={zid} accepts={["person"]} registerZone={registerZone} onDrop={(item) => setCell(item.id, dayIndex, k)}>
              <div className="drop" data-hot={drag && drag.over === zid ? 1 : 0}>
                {mine.length === 0 && <span style={{ fontSize: 10.5, color: C.inkFaint, padding: "5px 3px" }}>Empty</span>}
                {mine.map((p) => (
                  <Placard key={p.id} person={p} tone={DAY[k].color}
                           onBegin={(e) => begin(e, { kind: "person", id: p.id, name: p.d, instant: true })} />
                ))}
              </div>
            </Zone>
          </div>
        );
      })}
    </Sheet>
  );
}

/* ============================ APP ========================================= */
export default function ShopBoard({ user, isAdmin = false }) {
  const me = useMemo(() => {
    let uid = null;
    try { uid = localStorage.getItem("mts-shop-uid"); if (!uid) { uid = Math.random().toString(36).slice(2, 10); localStorage.setItem("mts-shop-uid", uid); } } catch { uid = "anon"; }
    return { name: (user && (user.name || (user.email || "").split("@")[0])) || "?", uid };
  }, [user]);
  const setMe = () => {};
  const [core, setCore] = useState(freshCore);
  const [tab, setTab] = useState("crews");
  const [sync, setSync] = useState("ok");
  const [lastSync, setLastSync] = useState(Date.now());
  const [presence, setPresence] = useState({});
  const [openAsset, setOpenAsset] = useState(null);
  const [openCrew, setOpenCrew] = useState(null);
  const [openPerson, setOpenPerson] = useState(null);
  const [addAsset, setAddAsset] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [dayFocus, setDayFocus] = useState(null);
  const [flashSet, setFlashSet] = useState(new Set());
  const [filters, setFilters] = useState({ op: "", yard: "", st: "", q: "" });
  const hlook = useHeaderLook();
  const [subSlot, setSubSlot] = useState(null);
  useEffect(() => { setSubSlot(document.getElementById("dx-sub")); return () => setSubSlot(null); }, []);
  const [look, setLookState] = useState(yardLook);
  const onLook = (k) => { setYardLook(k); setLookState(k); };
  const [cur, setCur] = useState(() => sharedDay(isoOf(new Date())));
  useEffect(() => { setSharedDay(cur); }, [cur]);
  const wkIso = useMemo(() => isoOf(weekStartOf(new Date(cur + "T00:00:00"))), [cur]);
  const dayIndex = useMemo(
    () => Math.round((new Date(cur + "T00:00:00") - new Date(wkIso + "T00:00:00")) / 86400000), [cur, wkIso]);
  const [day, setDayArr] = useState({ crews: {}, stacks: {}, pos: {}, inherited: "standing" });
  const [savedDays, setSavedDays] = useState(new Set());
  const [ops, setOps] = useState({ GTC: true, PHC: true, LC: true, SALES: true });
  const [undoLabel, setUndoLabel] = useState("");
  const undoRef = useRef(null);
  const [week, setWeek] = useState({ cells: {} });
  const [marker, setMarker] = useState("vac");
  const [booted, setBooted] = useState(false);

  const engine = useDragEngine();
  const { drag } = engine;
  const coreRef = useRef(core); coreRef.current = core;
  const weekRef = useRef(week); weekRef.current = week;
  const curRef = useRef(cur); curRef.current = cur;
  const dayRef = useRef(day); dayRef.current = day;
  const dayQ = useRef(Promise.resolve());
  const dayPending = useRef(0);          // day saves still on their way to the server
  const meRef = useRef(me); meRef.current = me;
  const tabRef = useRef(tab); tabRef.current = tab;
  const queue = useRef(Promise.resolve());
  const activeUntil = useRef(0);
  const endedAt = useRef(0);
  const dragRef = useRef(false);
  const wasDragging = useRef(false);

  useEffect(() => {
    dragRef.current = !!drag;
    if (drag) wasDragging.current = true;
    else if (wasDragging.current) { wasDragging.current = false; endedAt.current = Date.now(); }
  }, [drag]);

  const people = core.people;

  /* --- boot: pull the board, then put back anything this device knows that the
     server lost (owner, Nov 24: an update erased a person he'd added and revived
     people he'd deleted). Every device keeps its own copy of the board; on opening,
     any person / unit / crew whose copy here is NEWER than the server's (or that the
     server no longer has) is sent back. Time stamps decide, so a deletion stays
     deleted and an older copy never undoes newer work; Reset (resetAt) is honoured. */
  useEffect(() => {
    (async () => {
      let remote = null;
      for (let i = 0; i < 4 && !remote; i++) { remote = await sGet(K_CORE); if (!remote) await new Promise((ok) => setTimeout(ok, 800 * (i + 1))); }
      if (remote) {
        setCore((c) => mergeCore(remote, c));
        const mine = loadCoreBackup();
        if (mine) {
          const floor = remote.resetAt || 0, push = {}; let n = 0;
          ["assets", "crews", "people", "rigs"].forEach((coll) => {
            push[coll] = {};
            Object.entries(mine[coll] || {}).forEach(([id, v]) => {
              const r = (remote[coll] || {})[id];
              if (v && (v.at || 0) > floor && (!r || (v.at || 0) > (r.at || 0))) { push[coll][id] = v; n++; }
            });
          });
          if (n) {
            setCore((c) => mergeCore(push, c));
            const merged = await shopPatch("core", push);
            if (merged) setCore((c) => mergeCore(merged, c));
          }
        }
      } else setSync("err");
      setSavedDays(new Set(await listDays()));
      setBooted(true);
    })();
  }, []);
  // keep this device's copy of the board up to date (only once the server's copy is in)
  useEffect(() => {
    if (!booted) return;
    const t = setTimeout(() => saveCoreBackup(core), 800);
    return () => clearTimeout(t);
  }, [core, booted]);

  useEffect(() => {
    if (!me) return;
    (async () => {
      const w = await sGet(kWeek(wkIso));
      setWeek(w && w.cells ? { cells: w.cells } : { cells: {} });
    })();
  }, [wkIso, me]);

  /* --- open a day: its own record, else yesterday's, else the standing set */
  useEffect(() => {
    if (!me || !booted) return;
    let alive = true;
    (async () => {
      const own = await sGet(kDay(cur));
      if (own && own.crews) {
        if (alive) setDayArr({ crews: own.crews, stacks: own.stacks || stacksFrom(own.crews, coreRef.current.assets), pos: own.pos || {}, inherited: null });
        return;
      }
      const before = (await listDays()).filter((x) => x < cur).sort();
      for (let i = before.length - 1; i >= 0; i--) {
        const prev = await sGet(kDay(before[i]));
        if (prev && prev.crews) {
          if (alive) setDayArr({ crews: clone(prev.crews), stacks: clone(prev.stacks || stacksFrom(prev.crews, coreRef.current.assets)),
                                 pos: clone(prev.pos || {}), inherited: before[i] });
          return;
        }
      }
      if (alive) setDayArr({ ...freshDay(coreRef.current), inherited: "standing" });
    })();
    return () => { alive = false; };
  }, [cur, me, booted]);

  /* --- poll: quick while the board is being worked, quiet when idle ------ */
  useEffect(() => {
    if (!me) return;
    let alive = true, timer = null, beat = 0;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        const remote = await sGet(K_CORE);
        if (remote && alive) {
          const mine = coreRef.current;
          const changed = [];
          for (const [id, v] of Object.entries(remote.assets || {})) {
            const cur = mine.assets[id];
            if (cur && (v.at || 0) > (cur.at || 0) && v.by !== meRef.current.name) changed.push(id);
          }
          // Anti-entropy: if two writes collided and the server lost one of
          // mine, put it back. Converges in one cycle and then stays quiet.
          const merged = mergeCore(remote, mine);
          let behind = false;
          for (const coll of ["assets", "crews", "people"]) {
            for (const [id, v] of Object.entries(merged[coll])) {
              const r = (remote[coll] || {})[id];
              if ((v.at || 0) > 0 && (!r || (v.at || 0) > (r.at || 0))) { behind = true; break; }
            }
            if (behind) break;
          }
          if (behind) {
            const mineNow = coreRef.current, push = {};
            for (const coll of ["assets", "crews", "people", "rigs"]) {
              push[coll] = {};
              for (const [id, v] of Object.entries(mineNow[coll] || {})) {
                const rv = (remote[coll] || {})[id];
                if ((v.at || 0) > 0 && (!rv || (v.at || 0) > (rv.at || 0))) push[coll][id] = v;
              }
            }
            queue.current = queue.current.then(() => shopPatch("core", push));
          }
          setCore((c) => mergeCore(remote, c));
          if (changed.length) {
            activeUntil.current = Date.now() + 45000;
            setFlashSet(new Set(changed));
            setTimeout(() => alive && setFlashSet(new Set()), 1700);
          }
          setLastSync(Date.now()); setSync("ok");
        } else if (alive && !remote) setSync("warn");

        {
          const w = await sGet(kWeek(wkIso));
          if (w && w.cells && alive) {
            const mergedW = mergeMap(w.cells, weekRef.current.cells);
            const behindW = Object.entries(mergedW).some(([k, v]) => {
              const r = w.cells[k];
              return !r || (v.at || 0) > (r.at || 0);
            });
            if (behindW) queue.current = queue.current.then(() => shopPatch(srvKey(kWeek(wkIso)), { cells: mergedW }));
            setWeek((cur) => ({ cells: mergeMap(w.cells, cur.cells) }));
          }
        }

        // The day's crews: pick up other people's moves (skipped while my own
        // edits are still being saved, so they can't be flipped back).
        {
          const iso = curRef.current;
          const busyHands = () => dragRef.current || Date.now() - endedAt.current < 2000;
          const rd = dayPending.current || busyHands() ? null : await sGet(kDay(iso));
          if (rd && rd.crews && alive && !dayPending.current && !busyHands() && curRef.current === iso) {
            setDayArr((c) => ({ crews: mergeMap(rd.crews, c.crews), stacks: rd.stacks || {}, pos: rd.pos || {}, inherited: null }));
            setSavedDays((s2) => (s2.has(iso) ? s2 : new Set(s2).add(iso)));
          }
        }
        if (beat % 4 === 0) {
          const p = await shopPresence(meRef.current.uid);
          if (alive) setPresence(p);
        }
        beat++;
      }
      const gap = Date.now() < activeUntil.current ? 3000 : 10000;
      if (alive) timer = setTimeout(tick, gap);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [me, wkIso]);

  /* --- write path: read, re-apply, write --------------------------------- */
  const snapshot = useCallback((label) => {
    undoRef.current = {
      label, iso: curRef.current, at: Date.now(),
      core: clone(coreRef.current), day: clone(dayRef.current), week: clone(weekRef.current),
      // exactly what this action touches, so Undo never reverts anyone else's edit
      own: { core: { assets: new Set(), crews: new Set(), people: new Set(), rigs: new Set() }, crews: new Set(), pos: new Set(), stacks: new Set(), cells: new Set() },
    };
    setUndoLabel(label);
  }, []);

  /* Record what an edit touched on the undo snapshot taken just before it. */
  const own = (fill) => { const u = undoRef.current; if (u && Date.now() - u.at < 2000) fill(u.own); };

  const undo = useCallback(() => {
    const u = undoRef.current; if (!u) return;
    undoRef.current = null; setUndoLabel("");
    clearTimeout(flushT.current); pendingCells.current = {};   // drop queued week writes
    const at = stampNow(), by = (meRef.current && meRef.current.name) || "?";
    // Put back only the items that changed since the snapshot, stamped now so
    // they win the merge; other people's edits to other items are left alone.
    const revert = (then, nowMap, ids) => {
      const out = {};
      ids.forEach((id) => {
        if (then && then[id]) out[id] = { ...then[id], at, by };
        else if (nowMap && nowMap[id]) out[id] = { ...nowMap[id], del: true, at, by };
      });
      return out;
    };
    const keysBack = (then, ids) => { const out = {}; ids.forEach((k) => { out[k] = then && k in then ? then[k] : null; }); return out; };
    const c = coreRef.current, d = dayRef.current, o = u.own;
    const corePatch = {};
    ["assets", "crews", "people", "rigs"].forEach((k) => { corePatch[k] = revert(u.core[k], c[k], o.core[k]); });
    const dayPatch = { crews: revert(u.day.crews, d.crews, o.crews), pos: keysBack(u.day.pos, o.pos), stacks: keysBack(u.day.stacks, o.stacks) };
    const cells = {};
    o.cells.forEach((k) => { cells[k] = u.week.cells?.[k] ? { ...u.week.cells[k], at, by } : { code: "on", at, by }; });
    setCore((cur) => mergeCore(corePatch, cur));
    const applyKeys = (map, back) => { const out = { ...(map || {}) }; for (const [k, v] of Object.entries(back)) { if (v === null) delete out[k]; else out[k] = v; } return out; };
    if (u.iso === curRef.current) setDayArr((cur) => ({ ...cur, crews: mergeMap(cur.crews, dayPatch.crews), pos: applyKeys(cur.pos, dayPatch.pos), stacks: applyKeys(cur.stacks, dayPatch.stacks) }));
    setWeek((cur) => ({ cells: mergeMap(cur.cells, cells) }));
    queue.current = queue.current.then(async () => {
      await shopPatch("core", corePatch);
      await shopPatch(srvKey(kDay(u.iso)), dayPatch);
      await shopPatch(srvKey(kWeek(isoOf(weekStartOf(new Date(u.iso + "T00:00:00"))))), { cells });
      setLastSync(Date.now());
    }).catch(() => setSync("err"));
  }, []);

  const apply = useCallback((mutate, logText, noSnap) => {
    if (logText && !noSnap) snapshot(logText);
    const stamp = { at: stampNow(), by: (meRef.current && meRef.current.name) || "?" };
    activeUntil.current = Date.now() + 45000;
    const logId = `${stamp.at}-${logSeq++}`;   // same id both times so the merge dedupes
    const withLog = (d) => {
      mutate(d, stamp);
      if (logText) d.log = [{ id: logId, at: stamp.at, by: stamp.by, text: logText }, ...(d.log || []).filter((e) => e.id !== logId)].slice(0, 40);
    };
    const before = coreRef.current;
    const after = clone(before); withLog(after);
    coreRef.current = after;
    setCore(after);
    // Send only the items this edit touched; the server merges them by time stamp.
    const patch = { log: after.log.filter((e) => e.id === logId) };
    ["assets", "crews", "people", "rigs"].forEach((k) => { patch[k] = changed(before[k], after[k]); });
    own((o) => ["assets", "crews", "people", "rigs"].forEach((k) => Object.keys(patch[k]).forEach((id) => o.core[k].add(id))));
    queue.current = queue.current.then(async () => {
      const merged = await shopPatch("core", patch);
      setSync(merged ? "ok" : "err");
      if (merged) { setLastSync(Date.now()); setCore((cur) => mergeCore(merged, cur)); }
    }).catch(() => setSync("err"));
  }, []);

  /* --- week writes: coalesced, one per paint gesture --------------------- */
  const pendingCells = useRef({});
  const pendingIso = useRef(wkIso);
  const flushT = useRef(null);
  const flushCells = useCallback(() => {
    const batch = pendingCells.current, iso = pendingIso.current;
    pendingCells.current = {};
    if (!Object.keys(batch).length) return;
    queue.current = queue.current.then(async () => {
      const merged = await shopPatch(srvKey(kWeek(iso)), { cells: batch });
      setSync(merged ? "ok" : "err");
      if (merged) { setLastSync(Date.now()); setWeek((cur) => ({ cells: mergeMap(merged.cells, cur.cells) })); }
    }).catch(() => setSync("err"));
  }, []);
  const setCell = useCallback((pid, di, code) => {
    const stamp = { at: stampNow(), by: (meRef.current && meRef.current.name) || "?" };
    activeUntil.current = Date.now() + 45000;
    const val = { code, at: stamp.at, by: stamp.by };
    pendingCells.current[`${pid}:${di}`] = val;
    own((o) => o.cells.add(`${pid}:${di}`));
    pendingIso.current = wkIso;
    setWeek((w) => ({ cells: { ...w.cells, [`${pid}:${di}`]: val } }));
    clearTimeout(flushT.current);
    flushT.current = setTimeout(flushCells, 380);
  }, [wkIso, flushCells]);
  useEffect(() => () => { clearTimeout(flushT.current); flushCells(); }, [flushCells]);

  const applyDay = useCallback((mutate, logText) => {
    if (logText) snapshot(logText);
    const stamp = { at: stampNow(), by: (meRef.current && meRef.current.name) || "?" };
    const iso = curRef.current;
    activeUntil.current = Date.now() + 45000;
    const prev = dayRef.current;
    const d = { crews: clone(prev.crews), stacks: clone(prev.stacks || {}), pos: clone(prev.pos || {}) };
    mutate(d, stamp);
    const next = { ...d, inherited: null };
    dayRef.current = next;
    setDayArr(next);
    // An inherited (not yet saved) day is saved whole on its first edit;
    // after that only the crews, positions and hitches this edit touched go up.
    const whole = !!prev.inherited;
    const patch = whole
      ? { crews: d.crews, stacks: changedKeys({}, d.stacks), pos: changedKeys({}, d.pos) }
      : { crews: changed(prev.crews, d.crews), stacks: changedKeys(prev.stacks, d.stacks), pos: changedKeys(prev.pos, d.pos) };
    own((o) => {
      Object.keys(patch.crews).forEach((id) => o.crews.add(id));
      Object.keys(patch.pos).forEach((k) => o.pos.add(k));
      Object.keys(patch.stacks).forEach((k) => o.stacks.add(k));
    });
    dayPending.current++;
    dayQ.current = dayQ.current.then(async () => {
      const merged = await shopPatch(srvKey(kDay(iso)), patch);
      dayPending.current--;
      setSync(merged ? "ok" : "err");
      if (merged) {
        setLastSync(Date.now()); setSavedDays((s2) => new Set(s2).add(iso));
        if (curRef.current === iso) setDayArr((c) => ({ crews: mergeMap(merged.crews, c.crews), stacks: { ...merged.stacks, ...changedKeysApply(c.stacks, patch.stacks) }, pos: { ...merged.pos, ...changedKeysApply(c.pos, patch.pos) }, inherited: null }));
      }
    }).catch(() => setSync("err"));
    if (logText) apply(() => {}, logText, true);
  }, [apply, snapshot]);

  /* --- actions ---------------------------------------------------------- */
  const nameOf = (id) => (coreRef.current.assets[id] || {}).name || id;
  /* put units in / take them out of Broken on the day being viewed */
  const setBroken = (ids, on, label) => {
    const iso = curRef.current;
    const todo = ids.filter((m) => { const a = coreRef.current.assets[m]; return a && brokenOn(a, iso) !== on; });
    if (!todo.length) return;
    apply((d, s) => todo.forEach((m) => {
      const a = d.assets[m]; if (!a) return;
      a.broken = brokenAfter(a, iso, on);
      if (a.status === "tagged" || a.status === "shop") a.status = "running";
      a.at = s.at; a.by = s.by;
    }), `${label || todo.map(nameOf).join(" · ")} → ${on ? "Broken" : "back in service"} ${fmtIso(iso)}`, true);
  };
  const setStatus = (id, code) => {
    const a = coreRef.current.assets[id]; if (!a) return;
    if (code === "tagged") { setBroken([id], true); return; }
    if (brokenOn(a, curRef.current)) setBroken([id], false);
    const base = a.status === "tagged" || a.status === "shop" ? "running" : a.status;
    if (base === code) return;
    apply((d, s) => { const x = d.assets[id]; if (x) { x.status = code; x.at = s.at; x.by = s.by; } },
          `${nameOf(id)} → ${ST[code].label}`);
  };
  const setField = (id, k, v) =>
    apply((d, s) => { const a = d.assets[id]; if (a) { a[k] = v; a.at = s.at; a.by = s.by; } },
          k === "note" ? null : `${nameOf(id)} · ${k} set`);
  const toggleOp = (id, op) => {
    const cur = (coreRef.current.assets[id] || {}).ops || [];
    const next = cur.includes(op) ? cur.filter((x) => x !== op) : [...cur, op];
    const ordered = OP_ORDER.filter((o) => next.includes(o));
    // Assign the target list rather than flipping: apply() re-applies this on
    // top of merged state, so a toggle would cancel itself out.
    apply((d, s) => { const a = d.assets[id]; if (a) { a.ops = ordered; a.at = s.at; a.by = s.by; } },
          `${nameOf(id)} · ${ordered.join(" ") || "no operation"}`);
  };
  const removeAsset = (id) => { setOpenAsset(null); apply((d, s) => { const a = d.assets[id]; if (a) { a.del = true; a.at = s.at; a.by = s.by; } }, `${nameOf(id)} removed`); };

  const idsFor = (kind, id, members) => {
    if (kind === "rig") {
      const r = (coreRef.current.rigs || {})[id];
      return r && !r.del ? r.members.slice() : [];
    }
    if (members && members.length > 1) return members.slice();
    return [id];          // (linked combos were removed: they dragged units in from other crews)
  };

  const dropOn = (kind, id, crewId, afterLead, members) => {
    if (kind === "person") {
      const label = (people[id] || {}).d;
      applyDay((d, s) => {
        Object.values(d.crews).forEach((c) => {
          if (c.people.includes(id)) { c.people = c.people.filter((x) => x !== id); c.at = s.at; c.by = s.by; }
        });
        const c = d.crews[crewId];
        if (c && !c.people.includes(id)) { c.people = [...c.people, id]; c.at = s.at; c.by = s.by; }
      }, `${label} → ${(dayRef.current.crews[crewId] || {}).name || "crew"}`);
      return;
    }
    const ids = idsFor(kind, id, members);
    if (!ids.length) return;
    const assets = coreRef.current.assets;
    const label = ids.map((x) => (assets[x] || {}).tag).filter(Boolean).join(" · ");
    applyDay((d, s) => {
      Object.values(d.crews).forEach((c) => {
        const n = c.iron.length;
        c.iron = c.iron.filter((x) => !ids.includes(x));
        if (c.iron.length !== n) { c.at = s.at; c.by = s.by; }
      });
      const c = d.crews[crewId];
      if (!c) return;
      let at = c.iron.length;
      if (afterLead) {
        // slot it in behind the load you dropped on, so the order still reads
        // truck / what it tows / what rides on it
        const hitch = deriveHitch(d.crews, assets);
        const group = c.iron.filter((x) => x === afterLead || hitch[x] === afterLead
                       || (hitch[x] && hitch[hitch[x]] === afterLead));
        const last = group[group.length - 1];
        const idx = c.iron.indexOf(last);
        if (idx >= 0) at = idx + 1;
      }
      c.iron = [...c.iron.slice(0, at), ...ids, ...c.iron.slice(at)];
      c.at = s.at; c.by = s.by;
    }, `${label} → ${(dayRef.current.crews[crewId] || {}).name || "crew"}`);
  };

  const pullToYard = (kind, id, members) => {
    if (kind === "person") {
      applyDay((d, s) => {
        Object.values(d.crews).forEach((c) => {
          if (c.people.includes(id)) { c.people = c.people.filter((x) => x !== id); c.at = s.at; c.by = s.by; }
        });
      }, `${(people[id] || {}).d} back to the yard`);
      return;
    }
    const ids = idsFor(kind, id, members);
    applyDay((d, s) => {
      Object.values(d.crews).forEach((c) => {
        const n = c.iron.length;
        c.iron = c.iron.filter((x) => !ids.includes(x));
        if (c.iron.length !== n) { c.at = s.at; c.by = s.by; }
      });
    }, `${ids.map((x) => (coreRef.current.assets[x] || {}).tag).join(" · ")} back to the yard`);
  };

  const lockRig = (crewId, members) => {
    const id = `r${Date.now().toString(36)}`;
    const assets = coreRef.current.assets;
    const name = (assets[members[0]] || {}).tag ? `${(assets[members[0]] || {}).tag} rig`.toUpperCase() : "RIG";
    apply((d, s) => { d.rigs[id] = { id, name, members: members.slice(), at: s.at, by: s.by }; },
          `Locked ${members.map((x) => (assets[x] || {}).tag).join(" · ")}`);
  };
  const unlockRig = (id) => {
    const r = (coreRef.current.rigs || {})[id];
    apply((d, s) => { const x = d.rigs[id]; if (x) { x.del = true; x.at = s.at; x.by = s.by; } },
          `Unlocked ${(r || {}).name || "rig"}`);
  };

  const copyDay = async (which) => {
    const base = new Date(curRef.current + "T00:00:00");
    if (which === "prev")  { setCur(isoOf(addDays(base, -1))); return; }
    if (which === "next")  { setCur(isoOf(addDays(base, 1)));  return; }
    if (which === "today") { setCur(isoOf(new Date()));        return; }
    const at = stampNow(), by = (meRef.current && meRef.current.name) || "?";
    const src = dayRef.current;
    const crews = {};
    Object.entries(src.crews || {}).forEach(([id, c]) => { crews[id] = { ...clone(c), at, by }; });
    const payload = { crews, stacks: changedKeys({}, src.stacks || {}), pos: changedKeys({}, src.pos || {}) };
    let targets = which === "tomorrow"
      ? [isoOf(addDays(base, 1))]
      : [1, 2, 3, 4, 5, 6].map((n) => addDays(base, n)).filter((x) => x.getDay() !== 0 && x.getDay() !== 6 && x.getDay() > base.getDay()).map(isoOf);
    const planned = targets.filter((t) => savedDays.has(t));
    if (planned.length) {
      const replace = window.confirm(`${planned.length} of these days already ${planned.length === 1 ? "has" : "have"} a saved plan (${planned.join(", ")}). Replace ${planned.length === 1 ? "it" : "them"} too? Cancel copies only to the empty days.`);
      if (!replace) targets = targets.filter((t) => !savedDays.has(t));
    }
    if (!targets.length) return;
    for (const t of targets) await shopPatch(srvKey(kDay(t)), payload, true);
    if (src.inherited) await shopPatch(srvKey(kDay(curRef.current)), payload, true);   // pin the day you copied from
    setSavedDays((s2) => { const n = new Set(s2); targets.forEach((t) => n.add(t)); n.add(curRef.current); return n; });
    setDayArr((c) => ({ ...c, inherited: null }));
    apply(() => {}, `Day copied to ${targets.length} day${targets.length > 1 ? "s" : ""}`);
  };
  /* COPY / PASTE a day's crews (owner, Nov 24): copy here, go to any day, paste. */
  // the previous work day's crews (Mon → Fri), for "Compared with yesterday"
  const [prevDay, setPrevDay] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = new Date(cur + "T12:00:00");
      do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
      const piso = isoOf(d);
      let rec = await sGet(kDay(piso)), from = piso;
      if (!rec?.crews) {
        const before = (await listDays()).filter((x) => x < piso).sort();
        for (let i = before.length - 1; i >= 0 && !rec?.crews; i--) { rec = await sGet(kDay(before[i])); from = before[i]; }
      }
      if (alive) setPrevDay(rec?.crews ? { iso: piso, from, crews: rec.crews } : null);
    })();
    return () => { alive = false; };
  }, [cur]);
  const [clip, setClip] = useState(() => { try { return JSON.parse(localStorage.getItem("mts-shop-clip") || "null"); } catch { return null; } });
  const copyThisDay = () => {
    const src = dayRef.current;
    const c = { from: curRef.current, crews: clone(src.crews || {}), stacks: clone(src.stacks || {}), pos: clone(src.pos || {}) };
    setClip(c); try { localStorage.setItem("mts-shop-clip", JSON.stringify(c)); } catch {}
  };
  const pasteHere = async () => {
    if (!clip) return;
    const iso = curRef.current;
    const dl = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (savedDays.has(iso) && !window.confirm(`${dl(iso)} already has its own plan. Replace it with the crews from ${dl(clip.from)}?`)) return;
    const at = stampNow(), by = (meRef.current && meRef.current.name) || "?";
    const crews = {};
    Object.entries(clip.crews || {}).forEach(([id, c]) => { crews[id] = { ...clone(c), at, by }; });
    const payload = { crews, stacks: changedKeys({}, clip.stacks || {}), pos: changedKeys({}, clip.pos || {}) };
    const merged = await shopPatch(srvKey(kDay(iso)), payload, true);
    if (merged && curRef.current === iso) setDayArr({ crews: merged.crews || crews, stacks: merged.stacks || {}, pos: merged.pos || {}, inherited: null });
    setSavedDays((s2) => new Set(s2).add(iso));
    apply(() => {}, `Crews from ${dl(clip.from)} pasted on ${dl(iso)}`);
  };
  const saveStanding = () => apply((d, s) => {
    Object.values(dayRef.current.crews).forEach((c) => {
      d.crews[c.id] = { ...c, at: s.at, by: s.by };
    });
  }, "Standing setup updated from this day");
  const orderCrews = (ids) => applyDay((d, s) => {
    ids.forEach((cid, k) => { d.pos[cid] = { x: k * 10, y: 0 }; });
  }, "Crews rearranged");

  const resetToStanding = () => {
    setDayArr({ crews: clone(coreRef.current.crews), inherited: "standing" });
  };

  const peopleIds = () => live(coreRef.current.people).map((p) => p.id);

  /* The day's jobs from the Schedule tab, checked against each crew as it is
     on this board right now: missing equipment (or down), too few people. */
  const [sched, setSched] = useState(null);
  useEffect(() => {
    let dead = false;
    const load = () => shopGet(`sched.${cur}`).then((r) => { if (!dead) setSched(r); });
    load();
    const t = setInterval(() => { if (!document.hidden && !dragRef.current) load(); }, 15000);
    return () => { dead = true; clearInterval(t); };
  }, [cur]);
  const dayCore = useMemo(() => ({ ...core, assets: assetsOn(core.assets, cur) }), [core, cur]);
  const crewJobs = useMemo(() => {
    const out = {};
    Object.entries(sched?.assign || {}).forEach(([ref, a]) => {
      if (!a?.crew || ref.startsWith("_")) return;
      const c = day.crews[a.crew]; if (!c || c.del) return;
      const on = (c.people || []).filter((pid) => {
        const code = (week.cells[`${pid}:${dayIndex}`] || {}).code;
        return core.people[pid] && !core.people[pid].del && (!code || code === "on" || code === "light");
      }).length;
      const res = checkJob(a.tags, c, dayCore.assets, on);
      const o = (out[a.crew] = out[a.crew] || { jobs: 0, lines: [] });
      o.jobs++; o.lines.push(...problemLines(a.label || ref, res));
    });
    return out;
  }, [sched, day, core, dayCore, week, dayIndex]);
  const BIN_LABEL = { office: "→ Office", room: "→ Crew room", vac: "→ Off duty today", yard: "→ At the yard (unhooked)", broke: "→ Broken from this day on", newcrew: "→ New crew" };
  const dropLabel = (d) => {
    if (!d.over) return "";
    if (d.over === d.item.from) return "Same place — no change";
    if (d.over.startsWith("crew:") || d.over.startsWith("newcol:")) {
      const c = day.crews[d.over.slice(d.over.indexOf(":") + 1)] || {};
      return d.item.kind === "stack" ? `→ ${c.name || "crew"} · its own column` : `→ ${c.name || "crew"}`;
    }
    if (d.over.startsWith("slot:")) {
      const [, cid, k] = d.over.split(":");
      const c = day.crews[cid]; if (!c) return "";
      const col = colsOf(c, dayCore.assets)[+k] || [];
      const ids = d.item.members || [d.item.id];
      if (col.some((x) => ids.includes(x))) return "Same place — no change";
      const h = hookOnto(col, ids, dayCore.assets);
      const lead = dayCore.assets[col[0]] || {};
      return h ? `→ hook up with ${lead.tag || lead.name} on ${c.name}` : `→ ${c.name} · its own column (that one's full)`;
    }
    if (d.over === "canvas") return d.item.kind === "crew" ? "Drop to move the crew here" : "";
    return BIN_LABEL[d.over] || "";
  };

  /* Drop a name or a load on open ground and a crew starts there. Do it a few
     times and you have built the day's crews by hand. */
  const crewAt = (item, at) => {
    const n = live(dayRef.current.crews).filter((c) => /^CREW/.test(c.name)).length + 1;
    const cid = `c${Date.now().toString(36)}`;
    const hintX = Math.max(0, at ? at.x : 0), hintY = Math.max(0, at ? at.y : 0);
    const ids = item.kind === "stack" ? (item.members || dayRef.current.stacks[item.id] || [item.id]) : [];
    const label = item.kind === "person"
      ? (people[item.id] || {}).d
      : ids.map((m) => (coreRef.current.assets[m] || {}).tag).filter(Boolean).join(" · ");
    if (item.kind === "stack") {
      setBroken(ids, false);
    } else {
      const off = (week.cells[`${item.id}:${dayIndex}`] || {}).code;
      if (off && off !== "on") setCell(item.id, dayIndex, "on");
    }
    snapshot(`new crew from ${label}`);
    applyDay((d, s) => {
      Object.values(d.crews).forEach((c) => {
        if (item.kind === "person") { if (c.people.includes(item.id)) { c.people = c.people.filter((x) => x !== item.id); c.at = s.at; c.by = s.by; } }
        else { const k = c.iron.length; c.iron = c.iron.filter((x) => !ids.includes(x)); if (c.iron.length !== k) { c.at = s.at; c.by = s.by; } }
      });
      d.crews[cid] = {
        id: cid, name: `CREW ${n}`, ops: "GTC",
        people: item.kind === "person" ? [item.id] : [],
        iron: item.kind === "stack" ? ids : [],
        at: s.at, by: s.by,
      };
      d.pos[cid] = { x: hintX, y: hintY };
    }, `CREW ${n} started with ${label}`);
  };

  const yardMove = (item, where, at) => {
    const { kind, id } = item;
    if (where === "newcrew" && (kind === "person" || kind === "stack")) { crewAt(item, { x: 100000, y: 100000 }); return; }
    if (where === "canvas" && (kind === "person" || kind === "stack")) return;   // open ground: snaps back
    /* dropped inside a crew box: that box is now who it belongs to */
    if (where && (where.startsWith("crew:") || where.startsWith("slot:") || where.startsWith("newcol:"))) {
      const cid = where.startsWith("slot:") ? where.split(":")[1] : where.slice(where.indexOf(":") + 1);
      const slotK = where.startsWith("slot:") ? +where.split(":")[2] : -1;
      const cname = (dayRef.current.crews[cid] || {}).name || "crew";
      if (kind === "person") {
        const wasOff = (week.cells[`${id}:${dayIndex}`] || {}).code;
        if (wasOff && wasOff !== "on") setCell(id, dayIndex, "on");
        snapshot(`${(people[id] || {}).d} to ${cname}`);
        applyDay((d, s) => {
          Object.values(d.crews).forEach((c) => {
            if (c.people.includes(id)) { c.people = c.people.filter((x) => x !== id); c.at = s.at; c.by = s.by; }
          });
          const c = d.crews[cid];
          if (c && !c.people.includes(id)) { c.people = [...c.people, id]; c.at = s.at; c.by = s.by; }
          delete d.pos[id];
        }, `${(people[id] || {}).d} → ${cname}`);
        return;
      }
      if (kind === "stack") {
        const ids = (item.members || dayRef.current.stacks[id] || [id]);
        const label = ids.map((m) => (coreRef.current.assets[m] || {}).tag).filter(Boolean).join(" · ");
        const tc = dayRef.current.crews[cid];
        const colsOfBefore = tc ? colsOf(tc, coreRef.current.assets) : [];
        setBroken(ids, false);
        snapshot(`${label} to ${cname}`);
        applyDay((d, s) => {
          Object.values(d.crews).forEach((c) => {
            const n = c.iron.length;
            if (c.iron.some((x) => ids.includes(x))) c.cols = colsOf(c, coreRef.current.assets).map((col) => col.filter((x) => !ids.includes(x))).filter((col) => col.length);
            c.iron = c.iron.filter((x) => !ids.includes(x));
            if (c.iron.length !== n) { c.at = s.at; c.by = s.by; }
          });
          const c = d.crews[cid];
          if (c) {
            // Columns: dropped ON a column → hooked there if that works (a towed
            // unit behind a free truck, or a truck in front of a lone unit);
            // anywhere else → a column of its own. Never hooked automatically.
            const A = coreRef.current.assets;
            const cols = colsOf(c, A);                       // (ids were just taken off every crew)
            const target = slotK >= 0 ? colsOfBefore[slotK] : null;
            const tIdx = target ? cols.findIndex((col) => col.some((x) => target.includes(x))) : -1;
            const hooked = tIdx >= 0 ? hookOnto(cols[tIdx], ids, A) : null;
            if (hooked) {
              cols[tIdx] = hooked;
              const left = ids.filter((x) => !hooked.includes(x));
              if (left.length) cols.push(left);
            } else cols.push(ids.slice());
            c.cols = cols;
            c.iron = cols.flat();
            c.at = s.at; c.by = s.by;
          }
          ids.forEach((m) => { delete d.pos[m]; });
        }, `${label} → ${cname}`);
        return;
      }
      return;
    }
    if (kind === "person") {
      const label = (people[id] || {}).d;
      if (where === "vac") {
        snapshot(`${label} off`);
        setCell(id, dayIndex, "vac");
        applyDay((d, s) => { delete d.pos[id]; pullOut(d, "person", [id], s); });
        return;
      }
      const wasOff = (week.cells[`${id}:${dayIndex}`] || {}).code;
      if (wasOff && wasOff !== "on") setCell(id, dayIndex, "on");
      // dropped in the office / crew room: that's where they start their days from now on
      const p0 = coreRef.current.people[id];
      if (p0 && (where === "office" || where === "room") && homeOf(p0) !== (where === "office" ? "office" : "yard")) setPerson(id, { home: where === "office" ? "office" : "yard" });
      applyDay((d, s) => {
        if (where === "canvas") d.pos[id] = { x: Math.max(4, Math.min(CW - 90, at.x)), y: Math.max(4, Math.min(CH - 60, at.y)) };
        else { delete d.pos[id]; pullOut(d, "person", [id], s); }
      }, where === "canvas" ? `${label} onto the yard` : where === "office" ? `${label} to the office` : `${label} to the crew room`);
      return;
    }
    if (kind === "crew") {
      applyDay((d, s) => {
        if (where === "canvas") d.pos[id] = { x: Math.max(4, Math.min(CW - 130, at.x)), y: Math.max(4, Math.min(CH - 120, at.y)) };
      }, `${(dayRef.current.crews[id] || {}).name} moved`);
      return;
    }
    /* a stack: the truck plus whatever is hitched to it */
    const mem = (item.members || dayRef.current.stacks[id] || [id]);
    const label = mem.map((m) => (coreRef.current.assets[m] || {}).tag).filter(Boolean).join(" · ");
    if (where === "broke") {
      snapshot(`${label} broken`);
      setBroken(mem, true, label);
      applyDay((d, s) => { delete d.pos[id]; pullOut(d, "stack", mem, s); regroup(d, mem); });
      return;
    }
    if (where === "yard") {
      snapshot(`${label} back to the yard`);
      setBroken(mem, false, label);
      applyDay((d, s) => { delete d.pos[id]; pullOut(d, "stack", mem, s); regroup(d, mem); });
      return;
    }
    applyDay((d) => {
      d.pos[id] = { x: Math.max(4, Math.min(CW - 70, at.x)), y: Math.max(4, Math.min(CH - 200, at.y)) };
    }, `${label} onto the yard`);
  };

  const addCrew = () => {
    const n = live(dayRef.current.crews).filter((c) => /^CREW/.test(c.name)).length + 1;
    const id = `c${Date.now().toString(36)}`;
    applyDay((d, s) => {
      d.crews[id] = { id, name: `CREW ${n}`, ops: "GTC", people: [], iron: [], at: s.at, by: s.by };
      const used = Object.values(d.pos || {});
      let spot = { x: 60, y: 40 };
      outer:
      for (let y = 40; y < CH - 110; y += 40) {
        for (let x = 40; x < CW - 160; x += 40) {
          if (used.every((u) => Math.hypot(u.x - x, u.y - y) > NEAR * 1.7)) { spot = { x, y }; break outer; }
        }
      }
      d.pos[id] = spot;
    }, `Crew ${n} added`);
    setOpenCrew(id);
  };
  const renameCrew = (id, name) => applyDay((d, s) => { const c = d.crews[id]; if (c) { c.name = name; c.at = s.at; c.by = s.by; } }, `Crew renamed ${name}`);
  const opsCrew = (id, ops) => applyDay((d, s) => { const c = d.crews[id]; if (c) { c.ops = ops; c.at = s.at; c.by = s.by; } });
  const delCrew = (id) => { setOpenCrew(null); applyDay((d, s) => { const c = d.crews[id]; if (c) { c.del = true; c.at = s.at; c.by = s.by; } }, `${(dayRef.current.crews[id] || {}).name} deleted`); };
  const [armed, setArmed] = useState(false);
  const addPerson = () => {
    const id = `p${Date.now().toString(36)}`;
    apply((d, s) => { d.people[id] = { id, name: "New name", d: "NEW NAME", at: s.at, by: s.by }; }, "Name added");
    setOpenPerson(id);
  };
  const setPerson = (id, patch) =>
    apply((d, s) => { const p = d.people[id]; if (p) { Object.assign(p, patch); p.at = s.at; p.by = s.by; } },
          `${(coreRef.current.people[id] || {}).name || "Person"} · ${patch.phone != null ? "phone number" : patch.c ? "colour" : patch.foreman != null ? (patch.foreman ? "foreman" : "not foreman") : patch.home ? `starts in the ${patch.home}` : "changed"}`);
  const renamePerson = (id, name) =>
    apply((d, s) => { const p = d.people[id]; if (p) { p.name = name; p.d = name.toUpperCase(); p.at = s.at; p.by = s.by; } },
          `Renamed ${name}`);
  const removePerson = (id) => {
    const gone = (coreRef.current.people[id] || {}).d;
    setOpenPerson(null);
    apply((d, s) => {
      const p = d.people[id]; if (p) { p.del = true; p.at = s.at; p.by = s.by; }
      // pull them off any crew and release whatever was signed out to them
      Object.values(d.crews).forEach((c) => {
        if (c.people.includes(id)) { c.people = c.people.filter((x) => x !== id); c.at = s.at; c.by = s.by; }
      });

    }, `${gone} removed`);
  };
  const resetBoard = async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return; }
    setArmed(false);
    if (!isAdmin) return;
    // wipes everyone's people, crews and equipment changes — never from a stray double tap
    if ((window.prompt("This erases EVERY change anyone has made to the board (people, crews, equipment) and goes back to the original import. Type RESET to do it.") || "").trim().toUpperCase() !== "RESET") return;
    const f = { ...freshCore(), resetAt: stampNow() };
    setCore(f); saveCoreBackup(f);
    await shopPatch("core", f, true);
    await shopPatch(srvKey(kWeek(wkIso)), { cells: {} }, true); setWeek({ cells: {} });
  };

  /* --- name gate --------------------------------------------------------- */
  const [gate, setGate] = useState("");
  if (!booted) return <div className="mb" style={{ padding: 28, fontSize: 13, color: C.inkDim }}><style>{CSS}</style>Opening the board…</div>;
  if (!me) return (
    <div className="mb"><style>{CSS}</style>
      <div className="gate">
        <h2>Shop board</h2>
        <p>Everyone here sees the same board. Put your name on it so the crew knows who moved what.</p>
        <input value={gate} placeholder="Your name" autoFocus
               onChange={(e) => setGate(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && gate.trim()) { const m = { name: gate.trim(), uid: Math.random().toString(36).slice(2, 9) }; sSet(K_ME, m, false); setMe(m); } }} />
        <div className="act" style={{ borderTop: 0, marginTop: 14, paddingTop: 0 }}>
          <button className="btn stencil" disabled={!gate.trim()}
                  onClick={() => { const m = { name: gate.trim(), uid: Math.random().toString(36).slice(2, 9) }; sSet(K_ME, m, false); setMe(m); }}>
            Open the board
          </button>
        </div>
      </div>
    </div>
  );

  const assets = live(dayCore.assets);
  const counts = ST_ORDER.map((k) => ({ k, n: assets.filter((a) => a.status === k).length }));
  const others = Object.entries(presence).filter(([uid, v]) => uid !== me.uid && Date.now() - v.at < 150000);
  const asset = openAsset && dayCore.assets[openAsset];
  const crew = openCrew && day.crews[openCrew];
  const subControls = (<>
          <div className="tabs" role="tablist" style={{ display: TABS.length > 1 ? undefined : "none" }}>
            {TABS.map(([k, l]) => (
              <button key={k} className="tab stencil" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          <div className="spacer" />
          {others.length > 0 && (
            <div className="who">{others.slice(0, 4).map(([uid, v]) => <span key={uid} className="stencil">{v.name}</span>)}</div>
          )}
          <div className="sync stencil">
            <span className={`dot beat ${sync === "err" ? "err" : sync === "warn" ? "warn" : ""}`} />
            {sync === "err" ? "Not saving" : `Live · ${ago(lastSync)}`}
          </div>
          <button className="btn stencil" data-primary="1" onClick={() => setNoteOpen(true)}>Day sheet</button>
          {isAdmin && <button className="btn stencil" onClick={resetBoard} data-danger={armed ? 1 : 0}
                  title="Reload the Fleetio import and clear everyone's changes">
            {armed ? "Reset everyone?" : "Reset"}
          </button>}
        </>);

  return (
    <div className="mb">
      <style>{CSS}</style>

{/* TITLE BAR LOOK (owner picking, Nov 25): A = these controls ride in the Dispatch bar;
          B = one slim bar here; C = a light row in the page that scrolls away */}
      {hlook === "A" && subSlot ? createPortal(<div className="mb mb-sub">{subControls}</div>, subSlot)
        : hlook === "A" ? null
        : (
        <header className={`hd ${hlook === "B" ? "slim" : "inpage"}`}>
          <div className="hd-in">{subControls}</div>
        </header>
      )}

      {tab === "fleet" && (
        <>
          <FleetView core={dayCore} crewsMap={day.crews} engine={engine} filters={filters} setFilters={setFilters}
                     flashSet={flashSet} onOpen={setOpenAsset} onStatus={setStatus} onAdd={() => setAddAsset(true)} />
          {core.log.length > 0 && (
            <div className="log">
              <h4>WHAT CHANGED</h4>
              <ol>{core.log.slice(0, 8).map((e) => (
                <li key={e.id}><b>{e.by}</b><span>{e.text}</span><time>{ago(e.at)}</time></li>
              ))}</ol>
            </div>
          )}
        </>
      )}
      {tab === "crews" && (
        <YardView prevDay={prevDay} look={look} onLook={onLook} onCopyDay={copyThisDay} onPasteDay={pasteHere} clip={clip} onOrder={orderCrews} core={dayCore} day={day} iso={cur} dayIndex={dayIndex} week={week} engine={engine} crewJobs={crewJobs}
                  savedDays={savedDays} ops={ops} setOps={setOps}
                  onMove={yardMove} onNewCrew={addCrew} onCrew={setOpenCrew} onPerson={setOpenPerson}
                  onOpenAsset={(id) => setOpenAsset(id)} onDate={setCur} onAddPerson={addPerson}
                  undoLabel={undoLabel} onUndo={undo}
                  onCopy={copyDay} onLink={lockRig} onUnlink={unlockRig} />
      )}
      {tab === "people" && (
        <PeopleView core={core} me={me} boardWeekIso={wkIso}
                    onBoardCell={(key, val) => setWeek((w) => ({ cells: { ...w.cells, [key]: val } }))}
                    onRename={renamePerson} onAddPerson={addPerson} onRemove={removePerson} onSetPerson={setPerson}
                    onSetOps={(id, list) => apply((d, s) => { const p = d.people[id]; if (p) { p.ops = PERSON_OPS.filter((o) => list.includes(o)); p.at = s.at; p.by = s.by; } },
                                                  `${(core.people[id] || {}).name} works in ${list.length ? list.join(", ") : "anything"}`)} />
      )}
      {tab === "week" && (
        <WeekView core={core} people={people} engine={engine} week={week} setCell={setCell}
                  marker={marker} setMarker={setMarker} iso={wkIso} onDayFocus={setDayFocus}
                  onPerson={setOpenPerson}
                  shift={(n) => setCur((c) => n === 0 ? isoOf(new Date()) : isoOf(addDays(new Date(c + "T00:00:00"), n)))} />
      )}

      {asset && !asset.del && (
        <AssetSheet a={asset} core={dayCore} iso={cur} onClose={() => setOpenAsset(null)} onStatus={setStatus}
                    onField={setField} onToggleOp={toggleOp} onDelete={removeAsset}
                    onLabel={(id, k, v) => apply((d, s) => { const x = d.assets[id]; if (x) { x.custom = { ...(x.custom || {}), [k]: v }; x[k] = v; x.at = s.at; x.by = s.by; } }, `${nameOf(id)} · ${k === "vl" ? "drawing label" : k} → ${v || "—"}`)} />
      )}
      {addAsset && (
        <AddAssetSheet onClose={() => setAddAsset(false)}
                       onCreate={(unit) => { const id = `a${Date.now().toString(36)}`; apply((d, s) => { d.assets[id] = { ...unit, id, at: s.at, by: s.by }; }, `${unit.name} added to the fleet`); setAddAsset(false); }} />
      )}
      {crew && !crew.del && (
        <CrewSheet c={crew} core={dayCore} day={day} offToday={(pid) => { const cc = week.cells[`${pid}:${dayIndex}`]; return cc && cc.code !== "on" && cc.code !== "light"; }}
                   onClose={() => setOpenCrew(null)} onRename={renameCrew} onOps={opsCrew} onDelete={delCrew}
                   onAddPerson={(pid) => yardMove({ kind: "person", id: pid }, `crew:${crew.id}`)}
                   onRemovePerson={(pid) => yardMove({ kind: "person", id: pid }, "room")}
                   onAddStack={(g) => yardMove({ kind: "stack", id: g.id, members: g.members }, `crew:${crew.id}`)}
                   onRemoveStack={(g) => yardMove({ kind: "stack", id: g.id, members: g.members }, "yard")} />
      )}
      {noteOpen && (
        <DaySheet core={dayCore} crewsMap={day.crews} week={week} iso={cur} dayIndex={dayIndex}
                  onClose={() => setNoteOpen(false)} />
      )}
      {openPerson && core.people[openPerson] && !core.people[openPerson].del && (
        <PersonSheet p={core.people[openPerson]} core={core} onClose={() => setOpenPerson(null)}
                     onRename={renamePerson} onRemove={removePerson} onSetPerson={setPerson}
                     offToday={(() => { const cc = week.cells[`${openPerson}:${dayIndex}`]; return cc && cc.code !== "on" && cc.code !== "light" ? DAY[cc.code].label : null; })()}
                     onBackOnDuty={() => setCell(openPerson, dayIndex, "on")}
                     onCalendar={() => { setOpenPerson(null); setTab("people"); }} />
      )}
      {dayFocus !== null && (
        <DayFocus dayIndex={dayFocus} iso={wkIso} core={core} week={week} setCell={setCell}
                  engine={engine} onClose={() => setDayFocus(null)} />
      )}

      <ConditionDock drag={drag} registerZone={engine.registerZone} onDrop={setStatus} />

      {drag && (
        <div className="ghost" ref={engine.ghostRef} style={{ transform: `translate3d(${drag.x - 14}px, ${drag.y - 12}px, 0)` }}>
          {drag.item.kind === "marker" ? (
            <div className="marker stencil" data-on="1" style={{ background: C.tileHi }}>
              <span className="swatch" style={{ background: DAY[drag.item.code].color }} />{DAY[drag.item.code].label}
            </div>
          ) : (
            <div className="mini stencil" style={{ borderLeftColor: drag.item.kind === "asset" ? (ST[(core.assets[drag.item.id] || {}).status] || ST.running).color : (drag.item.color || C.ink), padding: "6px 11px", fontSize: 12, gap: 7, flexDirection: drag.item.kind === "stack" ? "column" : "row", alignItems: "center" }}>
              {drag.item.kind === "stack" && (drag.item.members || []).length > 0 && (
                <span className="ghost-shape"><HLoad members={drag.item.members.map((m) => dayCore.assets[m]).filter(Boolean)} scale={0.8} /></span>
              )}
              {drag.item.shape && <MachineChip shape={drag.item.shape} />}{drag.item.name}
            </div>
          )}
          {drag.item.kind !== "marker" && (
            <div className={`ghost-to stencil${dropLabel(drag) ? "" : " none"}`}>{dropLabel(drag) || (drag.item.kind === "crew" ? "Drop to move the crew here" : "Drop on a crew, a bin or ＋ New crew")}</div>
          )}
        </div>
      )}
    </div>
  );
}

/* Used by the Schedule tab: the same crews, people and day inheritance. */
export { freshCore, mergeCore, live, isoOf, addDays, weekStartOf, assetsOn };
