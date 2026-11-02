import { useEffect, useState } from "react";
import { api, type Device } from "../lib/api";
import { fmtDate } from "../lib/format";
import { CopyField } from "../components/CopyField";
import { Icon } from "../components/Icon";

type Client = { id: string; name: string; steps: React.ReactNode; action?: { label: string; href: string } };

export function Connect() {
  const url = `${location.origin}/mcp`;
  const [apps, setApps] = useState<Device[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.devices().then((r) => setApps(r.devices.filter((d) => d.kind === "mcp"))).catch(() => {});
  useEffect(() => { load(); }, []);

  const clients: Client[] = [
    {
      id: "claude", name: "Claude",
      steps: <>Settings → Connectors → <b>Add custom connector</b>. Paste the URL, then press <b>Connect</b> and approve.</>,
      action: { label: "Open Claude connectors", href: "https://claude.ai/settings/connectors" },
    },
    {
      id: "claude-code", name: "Claude Code",
      steps: <>Run this, then type <code>/mcp</code> in Claude Code and choose <b>Authenticate</b>.
        <CopyField value={`claude mcp add --transport http doggy ${url}`} label="command" /></>,
    },
    {
      id: "chatgpt", name: "ChatGPT",
      steps: <>Settings → Apps &amp; Connectors → <b>Create</b> (developer mode). Paste the URL and pick <b>OAuth</b>.</>,
    },
    {
      id: "cursor", name: "Cursor",
      steps: <>Click to install, then press <b>Connect</b> next to Doggy in Cursor's MCP settings.</>,
      action: { label: "Add to Cursor", href: `cursor://anysphere.cursor-deeplink/mcp/install?name=doggy&config=${btoa(JSON.stringify({ url }))}` },
    },
    {
      id: "vscode", name: "VS Code",
      steps: <>Click to install, then start the server and sign in when VS Code asks.</>,
      action: { label: "Add to VS Code", href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "doggy", type: "http", url }))}` },
    },
  ];

  const createToken = async () => {
    setBusy(true);
    try { setToken((await api.mcpToken("MCP token")).token); load(); } catch { /* shown as no token */ } finally { setBusy(false); }
  };

  return (
    <section className="connect">
      <div className="hero-card">
        <p className="eyebrow">MCP server</p>
        <h2>Use your memory in any AI app</h2>
        <p className="muted">Add this URL to an app that supports MCP. You'll sign in and approve once. No keys to paste.</p>
        <CopyField value={url} label="server URL" />
      </div>

      <div className="client-grid">
        {clients.map((c) => (
          <article key={c.id} className="client card">
            <h3>{c.name}</h3>
            <div className="steps muted small">{c.steps}</div>
            {c.action && <a className="secondary" href={c.action.href} target={c.action.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{c.action.label} <Icon name="arrow" size={16} /></a>}
          </article>
        ))}
      </div>

      <div className="group">
        <h2>Apps without sign-in support</h2>
        <p className="muted small">Create a token and send it as <code>Authorization: Bearer &lt;token&gt;</code>. It only works for MCP and is shown once.</p>
        {token ? (
          <div className="token-box">
            <CopyField value={token} label="token" />
            <pre>{JSON.stringify({ mcpServers: { doggy: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}</pre>
          </div>
        ) : <button className="secondary" onClick={createToken} disabled={busy}>{busy ? "Creating…" : "Create token"}</button>}
      </div>

      <div className="group">
        <h2>Connected apps</h2>
        {!apps.length && <p className="muted small">None yet.</p>}
        {apps.map((d) => (
          <div key={d.id} className="device">
            <div><div className="title">{d.name}</div><div className="meta"><span>last used {d.lastSeenAt ? fmtDate(d.lastSeenAt) : "never"}</span></div></div>
            <button className="link small danger-link" onClick={async () => { await api.removeDevice(d.id).catch(() => {}); load(); }}>Disconnect</button>
          </div>
        ))}
      </div>
    </section>
  );
}
