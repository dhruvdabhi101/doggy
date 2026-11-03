export const ASK_FLAG = "ask";

export type PostHogConfig = { key: string; host: string };

export function postHogConfig(key?: string, host?: string): PostHogConfig | null {
  if (!key?.trim()) return null;
  try {
    const url = new URL(host?.trim() || "https://us.i.posthog.com");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return { key: key.trim(), host: url.href.replace(/\/+$/, "") };
  } catch { return null; }
}

export function askFlagEnabled(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("flags" in data)) return false;
  if ("errorsWhileComputingFlags" in data && data.errorsWhileComputingFlags === true) return false;
  if ("quotaLimited" in data && Array.isArray(data.quotaLimited) && data.quotaLimited.includes("feature_flags")) return false;
  const flags = data.flags;
  if (typeof flags !== "object" || flags === null || !(ASK_FLAG in flags)) return false;
  const flag = flags[ASK_FLAG];
  return typeof flag === "object" && flag !== null && "enabled" in flag && flag.enabled === true;
}

export async function loadAskFlag(config: PostHogConfig, distinctId: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${config.host}/flags?v=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: config.key, distinct_id: distinctId }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) return false;
    return askFlagEnabled(await response.json());
  } catch { return false; }
}
