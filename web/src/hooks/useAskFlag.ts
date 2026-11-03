import { useEffect, useState } from "react";
import { loadAskFlag, postHogConfig } from "../lib/feature-flags";

const config = postHogConfig(import.meta.env.VITE_POSTHOG_KEY, import.meta.env.VITE_POSTHOG_HOST);
const ID_KEY = "doggy.flags-id";
let memoryId: string | undefined;

function distinctId(): string {
  if (memoryId) return memoryId;
  try {
    memoryId = sessionStorage.getItem(ID_KEY) || crypto.randomUUID();
    sessionStorage.setItem(ID_KEY, memoryId);
  } catch { memoryId = crypto.randomUUID(); }
  return memoryId;
}

export function useAskFlag(): boolean | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(config ? undefined : false);
  useEffect(() => {
    if (!config) return;
    let live = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    loadAskFlag(config, distinctId(), controller.signal).then((value) => {
      window.clearTimeout(timeout);
      if (live) setEnabled(value);
    });
    return () => {
      live = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);
  return enabled;
}
