import { useState } from "react";
import type { Item, ItemPatch } from "../lib/api";
import { fmtDate } from "../lib/format";
import { ItemEditor } from "./ItemEditor";

export type OnUpdate = (i: Item, patch: ItemPatch) => Promise<boolean>;

const SOURCE_LABEL = { capture: "seen on screen", voice: "you said", text: "you wrote" } as const;

export function ItemRow({ item, onUpdate }: { item: Item; onUpdate: OnUpdate }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const done = item.status !== "open";
  if (editing) return <ItemEditor item={item} onCancel={() => setEditing(false)} onSave={async (p) => { if (await onUpdate(item, p)) setEditing(false); }} />;
  return (
    <div className={`item ${done ? "done" : ""}`}>
      <button className={`check ${item.status === "done" ? "on" : ""}`} aria-label={done ? "Reopen" : "Mark done"}
        onClick={() => onUpdate(item, { status: done ? "open" : "done" })}>{item.status === "done" ? "✓" : ""}</button>
      <div className="body">
        <button className="item-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <div className="title">{item.title}</div>
          <div className="meta">
            <span className={`tag ${item.type}`}>{item.type}</span>
            {item.dueAt && <span>{fmtDate(item.dueAt)}</span>}
            {item.counterparty && <span>with {item.counterparty}</span>}
            {item.owner && item.owner !== "me" && <span>owner {item.owner}</span>}
            <span className="src">{item.sourceApp ?? SOURCE_LABEL[item.sourceKind]}</span>
          </div>
        </button>
        {open && (
          <div className="detail">
            {item.details && <p>{item.details}</p>}
            {item.evidence && <blockquote>“{item.evidence}”</blockquote>}
            <p className="muted small">{SOURCE_LABEL[item.sourceKind]}{item.sourceWindow ? ` · ${item.sourceWindow}` : ""} · {fmtDate(item.createdAt)}</p>
            <div className="row-actions">
              <button className="link small" onClick={() => setEditing(true)}>Edit</button>
              {item.status !== "dismissed"
                ? <button className="link small danger-link" onClick={() => onUpdate(item, { status: "dismissed" })}>Delete</button>
                : <button className="link small" onClick={() => onUpdate(item, { status: "open" })}>Restore</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
