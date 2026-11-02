import { useEffect, useState } from "react";
import { api, type Lane, type SourceInfo } from "../lib/api";
import { Pager, pageOf } from "../components/Pager";

const LANE_LABEL: Record<Lane, string> = { fast: "Fast", slow: "Hourly", skip: "Off" };

/** Which apps and sites Doggy reads, and how soon. */
export function Sources() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [page, setPage] = useState(1);
  const load = () => api.sources().then((r) => setSources(r.sources)).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!sources.length) return null;
  const set = async (key: string, v: string) => { await api.setSourceLane(key, v === "" ? null : (v as Lane)).catch(() => {}); load(); };
  const { rows, page: p, pages } = pageOf(sources, page, 10);
  return (
    <div className="group"><h2>Sources</h2>
      <p className="muted small">Chats are read within a minute, documents about hourly, feeds not at all.</p>
      {rows.map((s) => (
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
      <Pager page={p} pages={pages} total={sources.length} onPage={setPage} />
    </div>
  );
}
