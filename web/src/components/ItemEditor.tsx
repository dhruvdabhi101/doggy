import { useState } from "react";
import type { Item, ItemPatch, ItemType } from "../lib/api";
import { toLocalInput } from "../lib/format";

const TYPES: ItemType[] = ["task", "commitment", "event", "decision", "memory"];

export function ItemEditor({ item, onSave, onCancel }: { item: Item; onSave: (p: ItemPatch) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState<ItemType>(item.type);
  const [due, setDue] = useState(toLocalInput(item.dueAt));
  const [who, setWho] = useState(item.counterparty ?? "");
  const [details, setDetails] = useState(item.details ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    await onSave({
      title: title.trim(), type, dueAt: due ? new Date(due).toISOString() : null,
      counterparty: who.trim() || null, details: details.trim() || null,
    });
    setBusy(false);
  };
  return (
    <form className="item editor" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <label className="field"><span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </label>
      <div className="field-row">
        <label className="field"><span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field"><span>Due</span>
          <div className="due">
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            {due && <button type="button" className="link small" onClick={() => setDue("")}>Clear</button>}
          </div>
        </label>
      </div>
      <label className="field"><span>With</span>
        <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Person (optional)" />
      </label>
      <label className="field"><span>Notes</span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={3} placeholder="Optional" />
      </label>
      <div className="editor-actions">
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
