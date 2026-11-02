import { useState } from "react";
import { Icon } from "./Icon";

export function CopyField({ value, label, mono = true }: { value: string; label?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* no clipboard */ }
  };
  return (
    <div className="copy-field">
      <code className={mono ? "" : "plain"} aria-label={label}>{value}</code>
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy ${label ?? ""}`.trim()}>
        <Icon name={copied ? "check" : "copy"} size={16} /><span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
