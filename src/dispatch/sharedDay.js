/* The day being planned, shared between the Shop Board and the Schedule while
   the page is open: move to Wed 11/25 on the Shop Board and the Schedule opens
   on Wed 11/25 too (and the other way round). A fresh page starts on today. */
let day = null;
export const sharedDay = (fallback) => day || fallback;
export const setSharedDay = (iso) => { day = iso; };
