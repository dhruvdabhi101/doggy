import { useState } from "react";
import { detectPlatform, isStandalone } from "../lib/platform";
import { Icon } from "./Icon";

const KEY = "doggy.installHint";

/** iOS Safari has no install prompt, so say how to add Doggy to the home screen. */
export function InstallHint() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(KEY) === "x"; } catch { return false; } });
  if (detectPlatform() !== "ios" || isStandalone() || hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem(KEY, "x"); } catch { /* private mode */ } };
  return (
    <div className="install-hint">
      <span>Install Doggy: tap <b>Share</b> <Icon name="share" size={15} /> then <b>Add to Home Screen</b>.</span>
      <button className="link small" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
