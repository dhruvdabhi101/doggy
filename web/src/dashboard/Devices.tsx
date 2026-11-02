import { useEffect, useState } from "react";
import { api, type Device } from "../lib/api";
import { fmtDate } from "../lib/format";
import { DownloadButtons } from "../components/DownloadButtons";
import { Link } from "../lib/router";
import { Sources } from "./Sources";

const KIND_LABEL: Record<string, string> = { web: "Browser", ios: "iPhone", android: "Android", "mac-agent": "Mac app", "windows-agent": "Windows app", mcp: "AI app" };

export function Devices({ currentEmail }: { currentEmail: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const load = () => api.devices().then((r) => setDevices(r.devices.filter((d) => d.kind !== "mcp"))).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <section className="devices">
      <div className="group"><h2>Desktop app</h2>
        <p className="muted small">Picks up tasks and promises from your screen. Pause it any time from the menu bar or tray.</p>
        <DownloadButtons showHelp />
      </div>
      <div className="group"><h2>Signed-in devices</h2>
        <p className="muted small">Sign in with <b>{currentEmail}</b> on any device to sync.</p>
        {devices.map((d) => (
          <div key={d.id} className="device">
            <div><div className="title">{d.name}</div><div className="meta"><span className="tag">{KIND_LABEL[d.kind] ?? d.kind}</span><span>last seen {d.lastSeenAt ? fmtDate(d.lastSeenAt) : "never"}</span></div></div>
            <button className="link small" onClick={async () => { await api.removeDevice(d.id).catch(() => {}); load(); }}>Remove</button>
          </div>
        ))}
      </div>
      <Sources />
      <p className="muted small legal-links"><Link to="/privacy">Privacy policy</Link> · <Link to="/retention">Data retention</Link></p>
    </section>
  );
}
