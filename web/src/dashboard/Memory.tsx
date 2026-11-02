import { useEffect, useState } from "react";
import { api, type CaptureHit, type Item } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { ItemRow, type OnUpdate } from "../components/ItemRow";
import { Pager, PAGE_SIZE } from "../components/Pager";

const FILTERS = ["all", "task", "commitment", "event", "decision", "memory"] as const;

export function Memory({ onUpdate, saved }: { onUpdate: OnUpdate; saved: number }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [captures, setCaptures] = useState<CaptureHit[]>([]);
  const [captureTotal, setCaptureTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [saved]);

  useEffect(() => {
    let live = true;
    const handle = window.setTimeout(() => {
      setLoading(true);
      const offset = (page - 1) * PAGE_SIZE;
      const type = filter === "all" ? undefined : filter;
      const req = q.trim()
        ? api.search(q, { limit: PAGE_SIZE, offset, captureLimit: 8, captureOffset: 0, type })
        : api.items({ type, excludeStatus: "dismissed", sort: "created", limit: PAGE_SIZE, offset });
      req.then((r) => {
        if (!live) return;
        if ("captures" in r) {
          setRows(r.items);
          setTotal(r.itemTotal);
          setCaptures(r.captures);
          setCaptureTotal(r.captureTotal);
        } else {
          setRows(r.items);
          setTotal(r.total);
          setCaptures([]);
          setCaptureTotal(0);
        }
        setError(null);
      }).catch((e: Error) => { if (live) setError(e.message); })
        .finally(() => { if (live) setLoading(false); });
    }, q.trim() ? 250 : 0);
    return () => { live = false; window.clearTimeout(handle); };
  }, [q, filter, page, saved]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const save: OnUpdate = async (it, patch) => {
    const ok = await onUpdate(it, patch);
    if (!ok) return false;
    setRows((list) => list.flatMap((row) => {
      if (row.id !== it.id) return [row];
      const next = { ...row, ...patch };
      if (patch.status === "dismissed") return [];
      return [next];
    }));
    if (patch.status === "dismissed") setTotal((n) => Math.max(0, n - 1));
    return true;
  };

  return (
    <section>
      <label className="search">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search everything…" aria-label="Search memory" />
      </label>
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => { setFilter(f); setPage(1); }}>{f}</button>
        ))}
      </div>
      {loading && !rows.length ? <div className="skeleton" aria-busy="true" /> : rows.map((i) => <ItemRow key={i.id} item={i} onUpdate={save} />)}
      <Pager page={Math.min(page, pages)} pages={pages} total={total} onPage={setPage} />
      {error && <p className="error">{error}</p>}
      {!loading && !rows.length && !captures.length && <Empty title={q ? "No matches" : "No memories yet"} body={q ? undefined : "Things you say, type, or that the desktop app sees will show up here."} />}
      {!!captures.length && (
        <div className="group"><h2>On your screen <span className="count">{captureTotal}</span></h2>
          {captures.map((c) => (
            <div key={c.id} className="capture"><div className="meta"><span className="src">{c.app}</span><span>{c.window}</span><span>{fmtDate(c.capturedAt)}</span></div><div>{c.text}</div></div>
          ))}
        </div>
      )}
    </section>
  );
}
