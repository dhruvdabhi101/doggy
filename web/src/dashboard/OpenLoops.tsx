import { useMemo, useState } from "react";
import type { Item } from "../lib/api";
import { Empty } from "../components/Empty";
import { ItemRow, type OnUpdate } from "../components/ItemRow";
import { Pager, pageOf } from "../components/Pager";

const LOOP_TYPES = new Set(["task", "commitment", "event"]);
const ORDER = ["Overdue", "Today", "This week", "Later", "No date"] as const;

function bucket(i: Item): (typeof ORDER)[number] {
  if (!i.dueAt) return "No date";
  const d = new Date(i.dueAt).getTime(); const n = new Date();
  const sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (d < n.getTime()) return "Overdue";
  if (d < sod + 86_400_000) return "Today";
  if (d < sod + 7 * 86_400_000) return "This week";
  return "Later";
}

export function OpenLoops({ items, loaded, onUpdate }: { items: Item[]; loaded: boolean; onUpdate: OnUpdate }) {
  const [page, setPage] = useState(1);
  const { sorted, counts } = useMemo(() => {
    const open = items.filter((i) => i.status === "open" && LOOP_TYPES.has(i.type));
    const rank = new Map(ORDER.map((k, n) => [k, n]));
    const withBucket = open.map((i) => ({ i, b: bucket(i) }));
    withBucket.sort((x, y) => rank.get(x.b)! - rank.get(y.b)! || (x.i.dueAt ?? "~").localeCompare(y.i.dueAt ?? "~") || y.i.createdAt.localeCompare(x.i.createdAt));
    const counts = new Map<string, number>();
    for (const { b } of withBucket) counts.set(b, (counts.get(b) ?? 0) + 1);
    return { sorted: withBucket, counts };
  }, [items]);

  if (!loaded) return <div className="skeleton" aria-busy="true" />;
  if (!sorted.length) return <Empty title="Nothing open" body="Say or type something to remember, or install the desktop app to pick up tasks from your chats and email." />;

  const { rows, page: p, pages } = pageOf(sorted, page);
  const groups: [string, Item[]][] = [];
  for (const { i, b } of rows) {
    const last = groups.at(-1);
    if (last?.[0] === b) last[1].push(i); else groups.push([b, [i]]);
  }
  return (
    <section>
      {groups.map(([k, list]) => (
        <div key={k} className="group">
          <h2 className={k === "Overdue" ? "danger" : ""}>{k} <span className="count">{counts.get(k)}</span></h2>
          {list.map((i) => <ItemRow key={i.id} item={i} onUpdate={onUpdate} />)}
        </div>
      ))}
      <Pager page={p} pages={pages} total={sorted.length} onPage={setPage} />
    </section>
  );
}
