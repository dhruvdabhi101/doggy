import { useEffect, useState } from "react";
import { api, type Downloads } from "../lib/api";
import { fmtDate } from "../lib/format";
import { detectPlatform, PLATFORM_NAME } from "../lib/platform";
import { Icon } from "./Icon";
import { trackDownload } from "../lib/analytics";

const HELP = {
  mac: "Open the .dmg and drag Doggy to Applications. The first time, right-click → Open, then allow Accessibility.",
  windows: "Run the installer. If SmartScreen warns, choose More info → Run anyway. Doggy lives in the tray.",
} as const;

/** Desktop downloads, with the visitor's own OS first. */
export function DownloadButtons({ showHelp = false, large = false, hideWhenEmpty = false }: { showHelp?: boolean; large?: boolean; hideWhenEmpty?: boolean }) {
  const [d, setD] = useState<Downloads | null>(null);
  useEffect(() => { api.downloads().then(setD).catch(() => setD({})); }, []);
  const os = detectPlatform();
  if (!d) return hideWhenEmpty ? null : <div className="downloads"><span className="primary placeholder">Download</span></div>;
  const keys = (["mac", "windows"] as const).filter((k) => d[k]).sort((a) => (a === os ? -1 : 1));
  if (!keys.length) return hideWhenEmpty ? null : <p className="muted small">The desktop app isn't available for download yet.</p>;
  const mine = keys.find((k) => k === os);
  return (
    <>
      <div className="downloads">
        {keys.map((k) => (
          <a key={k} className={`${k === mine || (!mine && k === keys[0]) ? "primary" : "secondary"} ${large ? "lg" : ""}`} href={d[k]!.url} download onClick={() => trackDownload(k)}>
            <Icon name="download" size={18} /> Download for {PLATFORM_NAME[k]}
          </a>
        ))}
      </div>
      {showHelp && keys.map((k) => <p key={k} className="muted small">{PLATFORM_NAME[k]}: {HELP[k]} <span className="nowrap">Updated {fmtDate(d[k]!.builtAt)}.</span></p>)}
    </>
  );
}
