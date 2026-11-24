import { useEffect, useState } from "react";
import { shopSettings, saveYard } from "./shop/shopApi";
import { loadMaps } from "./BacklogMap.jsx";

/* The one shop every crew runs out of (owner, Nov 24): 400 Western Blvd.
   Looked up once (Google's geocoder in the browser, kept to the Rochester
   area), then remembered on the server as settings.yards.Shop so every map
   shows the same star without looking it up again. */
export const SHOP_ADDR = "400 Western Blvd";
export const STAR_PATH = "M 0,-11 3.2,-4.4 10.5,-3.4 5.2,1.6 6.5,8.9 0,5.5 -6.5,8.9 -5.2,1.6 -10.5,-3.4 -3.2,-4.4 z";
let cache = null, pending = null;

async function resolveShop() {
  const st = await shopSettings();
  const y = st?.yards?.Shop;
  if (y && isFinite(y.lat) && /^400 Western/i.test(y.addr || "")) return { lat: y.lat, lng: y.lng, addr: y.addr, name: "Shop" };
  await loadMaps();
  const g = window.google.maps;
  const r = await new Promise((ok) => new g.Geocoder().geocode({
    address: `${SHOP_ADDR}, NY`,
    bounds: new g.LatLngBounds({ lat: 42.8, lng: -78.2 }, { lat: 43.45, lng: -77.1 }),
    componentRestrictions: { country: "US", administrativeArea: "NY" },
  }, (res, status) => ok(status === "OK" && res && res[0] ? res[0] : null)));
  if (!r) return null;
  const p = { lat: r.geometry.location.lat(), lng: r.geometry.location.lng(), addr: r.formatted_address || SHOP_ADDR, name: "Shop" };
  try { await saveYard("Shop", p.addr, { lat: p.lat, lng: p.lng }); } catch {}
  return p;
}

/** { lat, lng, addr, name } of the shop, or null while unknown. */
export function useShop() {
  const [shop, setShop] = useState(cache);
  useEffect(() => {
    if (cache) return;
    let dead = false;
    pending = pending || resolveShop().catch(() => null).then((p) => { cache = p; if (!p) pending = null; return p; });
    pending.then((p) => { if (!dead && p) setShop(p); });
    return () => { dead = true; };
  }, []);
  return shop;
}

/** A Google Maps marker icon: the shop star. */
export const starIcon = (g) => ({ path: STAR_PATH, fillColor: "#FFD54F", fillOpacity: 1, strokeColor: "#0b0e11", strokeWeight: 1.5, scale: 1.25, anchor: new g.Point(0, 0) });
