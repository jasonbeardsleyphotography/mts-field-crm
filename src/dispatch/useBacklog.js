import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "./api";
import { enrich } from "./backlogModel";

/** The uploaded backlog + jobs on pause, enriched. Shared by Backlog, Schedule and Quick pick. */
export function useBacklog() {
  const [data, setData] = useState(undefined);        // undefined = loading, null = none uploaded
  const [paused, setPaused] = useState({});
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try { const d = await api("backlog"); setData(d.empty ? null : d); setErr(""); }
    catch (e) { setErr(`Couldn't load the backlog (${e.message}).`); setData(null); }
    try { setPaused((await api("paused")).paused || {}); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  // pick up pauses made by someone else
  useEffect(() => {
    const t = setInterval(async () => { if (!document.hidden) { try { setPaused((await api("paused")).paused || {}); } catch {} } }, 30000);
    return () => clearInterval(t);
  }, []);
  const jobs = useMemo(() => (data ? enrich(data, paused) : []), [data, paused]);
  const pause = useCallback(async (ref, reason, until) => {
    const r = await api("paused", { method: "POST", body: { ref, reason, until } });
    setPaused(r.paused || {});
  }, []);
  const resume = useCallback(async (ref) => {
    const r = await api("paused", { method: "POST", body: { ref, remove: true } });
    setPaused(r.paused || {});
  }, []);
  return { data, jobs, err, load, pause, resume };
}
