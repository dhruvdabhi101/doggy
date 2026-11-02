import { useEffect, useMemo, useState } from "react";
import { api, type CaptureHit, type Item } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { ItemRow, type OnUpdate } from "../components/ItemRow";
import { Pager, pageOf } from "../components/Pager";

const FILTERS = ["all", "task", "commitment", "event", "decision", "memory"] as const;

export function Memory({ items, onUpdate }: { items: Item[]; onUpdate: OnUpdate }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ ids: string[]; captures: CaptureHit[] } | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
    if (!q.trim()) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => api.search(q).then((r) => live && setHits({ ids: r.items.map((i) => i.id), captures: r.captures })).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  useEffect(() => setPage(1), [filter]);

  const list = useMemo(() => {
    // Search returns ids; render the synced copy so edits show immediately.
    const byId = new Map(items.map((i) => [i.id, i]));
    const base = hits ? hits.ids.map((id) => byId.get(id)).filter((i): i is Item => !!i) : [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return base.filter((i) => i.status !== "dismissed" && (filter === "all" || i.type === filter));
  }, [items, hits, filter]);
  const { rows, page: p, pages } = pageOf(list, page);

  return (
    <section>
      <label className="search">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything…" aria-label="Search memory" />
      </label>
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      {rows.map((i) => <ItemRow key={i.id} item={i} onUpdate={onUpdate} />)}
      <Pager page={p} pages={pages} total={list.length} onPage={setPage} />
      {!list.length && !hits?.captures.length && <Empty title={q ? "No matches" : "No memories yet"} body={q ? undefined : "Things you say, type, or that the desktop app sees will show up here."} />}
      {!!hits?.captures.length && p === pages && (
        <div className="group"><h2>On your screen</h2>
          {hits.captures.map((c) => (
            <div key={c.id} className="capture"><div className="meta"><span className="src">{c.app}</span><span>{c.window}</span><span>{fmtDate(c.capturedAt)}</span></div><div>{c.text}</div></div>
          ))}
        </div>
      )}
    </section>
  );
}
