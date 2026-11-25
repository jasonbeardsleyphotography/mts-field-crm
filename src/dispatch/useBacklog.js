import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "./api";
import { enrich } from "./backlogModel";

/** The uploaded backlog + jobs on pause, enriched. Shared by Backlog, Schedule and Quick pick. */
export function useBacklog() {
  const [data, setData] = useState(undefined);        // undefined = loading, null = none uploaded
  const [paused, setPaused] = useState({});
  const [deleted, setDeleted] = useState({});
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    try { const d = await api("backlog"); setData(d.empty ? null : d); setErr(""); }
    catch (e) { setErr(`Couldn't load the backlog (${e.message}).`); setData(null); }
    try { setPaused((await api("paused")).paused || {}); } catch {}
    try { setDeleted((await api("deleted")).deleted || {}); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);
  // pick up pauses made by someone else
  useEffect(() => {
    const t = setInterval(async () => { if (!document.hidden) { try { setPaused((await api("paused")).paused || {}); } catch {} } }, 30000);
    return () => clearInterval(t);
  }, []);
  // deleted jobs are left out everywhere (Backlog lists them so they can be restored)
  const allJobs = useMemo(() => (data ? enrich({ ...data, jobs: data.jobs.filter((j) => !deleted[j.ref]) }, paused) : []), [data, paused, deleted]);
  // stump-only visits live on the Stumps tab, not in the tree-work lists (owner, Nov 25)
  const jobs = useMemo(() => allJobs.filter((j) => !j.stumpOnly), [allJobs]);
  const pause = useCallback(async (ref, reason, until) => {
    const r = await api("paused", { method: "POST", body: { ref, reason, until } });
    setPaused(r.paused || {});
  }, []);
  const resume = useCallback(async (ref) => {
    const r = await api("paused", { method: "POST", body: { ref, remove: true } });
    setPaused(r.paused || {});
  }, []);
  const remove = useCallback(async (ref, name) => {
    const r = await api("deleted", { method: "POST", body: { ref, name } });
    setDeleted(r.deleted || {});
  }, []);
  const restore = useCallback(async (ref) => {
    const r = await api("deleted", { method: "POST", body: { ref, restore: true } });
    setDeleted(r.deleted || {});
  }, []);
  return { data, jobs, allJobs, err, load, pause, resume, deleted, remove, restore };
}
