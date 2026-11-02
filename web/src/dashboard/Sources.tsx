import { useEffect, useState } from "react";
import { api, type Lane, type SourceInfo } from "../lib/api";
import { Pager } from "../components/Pager";

const LANE_LABEL: Record<Lane, string> = { fast: "Fast", slow: "Hourly", skip: "Off" };

/** Which apps and sites Doggy reads, and how soon. */
const SOURCE_PAGE = 10;

export function Sources() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const load = (p = page) => api.sources({ limit: SOURCE_PAGE, offset: (p - 1) * SOURCE_PAGE }).then((r) => { setSources(r.sources); setTotal(r.total); }).catch(() => {});
  useEffect(() => { load(page); }, [page]);
  if (!total && !sources.length) return null;
  const set = async (key: string, v: string) => { await api.setSourceLane(key, v === "" ? null : (v as Lane)).catch(() => {}); load(page); };
  const pages = Math.max(1, Math.ceil(total / SOURCE_PAGE));
  const p = Math.min(page, pages);
  return (
    <div className="group"><h2>Sources</h2>
      <p className="muted small">Chats are read within a minute, documents about hourly, feeds not at all.</p>
      {sources.map((s) => (
        <div key={s.key} className="device source">
          <div>
            <div className="title">{s.key}</div>
            <div className="meta">
              <span className="tag">{s.kind}</span>
              <span>{LANE_LABEL[s.lane]}</span>
              <span>{s.itemsKept} found</span>
            </div>
          </div>
          <select aria-label={`How often to read ${s.key}`} value={s.override ?? ""} onChange={(e) => set(s.key, e.target.value)}>
            <option value="">Default ({LANE_LABEL[s.defaultLane]})</option>
            <option value="fast">Fast</option>
            <option value="slow">Hourly</option>
            <option value="skip">Off</option>
          </select>
        </div>
      ))}
      <Pager page={p} pages={pages} total={total} onPage={setPage} />
    </div>
  );
}
