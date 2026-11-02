import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Item } from "../lib/api";

/** All of the user's items, kept current with incremental sync. */
export function useItems(onUnauthorized: () => void) {
  const [items, setItems] = useState<Map<string, Item>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const cursor = useRef(0);
  const upsert = useCallback((list: Item[]) => {
    if (list.length) setItems((m) => { const n = new Map(m); list.forEach((i) => n.set(i.id, i)); return n; });
  }, []);
  const sync = useCallback(async () => {
    try {
      let more = true;
      while (more) {
        const r = await api.changes(cursor.current);
        upsert(r.items);
        more = r.items.length >= 1000; cursor.current = r.cursor;
      }
      setLoaded(true);
    } catch (e) { if (e instanceof ApiError && e.status === 401) onUnauthorized(); }
  }, [onUnauthorized, upsert]);
  useEffect(() => {
    sync();
    const t = setInterval(sync, 10_000);
    const vis = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [sync]);
  return { items: [...items.values()], loaded, upsert };
}
