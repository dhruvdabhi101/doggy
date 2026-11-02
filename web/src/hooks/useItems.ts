import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Item } from "../lib/api";

/** Open tasks, commitments, and events. Memory pages its own query. */
export function useItems(onUnauthorized: () => void) {
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0);
  const inflight = useRef(new Set<string>());
  const upsert = useCallback((list: Item[]) => {
    if (list.length) setItems((m) => { const n = new Map(m); list.forEach((i) => n.set(i.id, i)); return n; });
  }, []);
  const begin = useCallback((id: string) => { inflight.current.add(id); }, []);
  const end = useCallback((id: string) => { inflight.current.delete(id); }, []);
  const sync = useCallback(async () => {
    try {
      const r = await api.items({ status: "open", type: "task,commitment,event", sort: "due", limit: 500, offset: 0 });
      setTotal(r.total);
      setItems((prev) => {
        const next = new Map(r.items.map((i) => [i.id, i]));
        for (const id of inflight.current) {
          const local = prev.get(id);
          if (local) next.set(id, local);
        }
        return next;
      });
      setLoaded(true);
    } catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); }
  }, [onUnauthorized]);
  useEffect(() => {
    sync();
    const t = setInterval(sync, 10_000);
    const vis = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [sync]);
  return { items: [...items.values()], loaded, total, upsert, begin, end };
}
