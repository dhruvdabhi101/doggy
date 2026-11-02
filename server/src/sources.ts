/**
 * Where screen text came from, and how eagerly it deserves a model call.
 * Pure: no database, so the replay script can import it.
 */
export type SourceKind = "conversation" | "document" | "feed" | "own" | "unknown";
export type Lane = "fast" | "slow" | "skip";
export const LANES: readonly Lane[] = ["fast", "slow", "skip"];
export type Source = { key: string; kind: SourceKind };

type Rule = { kind: SourceKind; host?: string; pathPrefix?: string; app?: RegExp; bundleIds?: string[] };

/** First match wins. URL rules apply when the capture has a URL; app rules apply otherwise. */
export const RULES: readonly Rule[] = [
  { host: "x.com", pathPrefix: "/messages", kind: "conversation" },
  { host: "twitter.com", pathPrefix: "/messages", kind: "conversation" },
  { host: "linkedin.com", pathPrefix: "/messaging", kind: "conversation" },
  { host: "instagram.com", pathPrefix: "/direct", kind: "conversation" },
  { host: "linkedin.com", pathPrefix: "/feed", kind: "feed" },
  { host: "calendar.google.com", kind: "document" },

  { host: "web.whatsapp.com", kind: "conversation" },
  { host: "app.slack.com", kind: "conversation" },
  { host: "discord.com", kind: "conversation" },
  { host: "teams.microsoft.com", kind: "conversation" },
  { host: "teams.live.com", kind: "conversation" },
  { host: "web.telegram.org", kind: "conversation" },
  { host: "mail.google.com", kind: "conversation" },
  { host: "outlook.live.com", kind: "conversation" },
  { host: "outlook.office.com", kind: "conversation" },
  { host: "outlook.office365.com", kind: "conversation" },

  { host: "notion.so", kind: "document" },
  { host: "docs.google.com", kind: "document" },
  { host: "linear.app", kind: "document" },
  { host: "atlassian.net", kind: "document" },
  { host: "github.com", kind: "document" },
  { host: "todoist.com", kind: "document" },

  { host: "x.com", kind: "feed" },
  { host: "twitter.com", kind: "feed" },
  { host: "youtube.com", kind: "feed" },
  { host: "reddit.com", kind: "feed" },
  { host: "instagram.com", kind: "feed" },
  { host: "facebook.com", kind: "feed" },
  { host: "news.ycombinator.com", kind: "feed" },
  { host: "tiktok.com", kind: "feed" },

  { app: /whatsapp/i, bundleIds: ["net.whatsapp.WhatsApp", "desktop.WhatsApp"], kind: "conversation" },
  { app: /^slack$/i, bundleIds: ["com.tinyspeck.slackmacgap"], kind: "conversation" },
  { app: /^discord$/i, bundleIds: ["com.hnc.Discord"], kind: "conversation" },
  { app: /microsoft teams/i, bundleIds: ["com.microsoft.teams2", "com.microsoft.teams"], kind: "conversation" },
  { app: /^messages$/i, bundleIds: ["com.apple.MobileSMS"], kind: "conversation" },
  { app: /telegram/i, bundleIds: ["ru.keepcoder.Telegram", "org.telegram.desktop"], kind: "conversation" },
  { app: /^signal$/i, bundleIds: ["org.whispersystems.signal-desktop"], kind: "conversation" },
  { app: /^mail$/i, bundleIds: ["com.apple.mail"], kind: "conversation" },
  { app: /outlook/i, bundleIds: ["com.microsoft.Outlook"], kind: "conversation" },
  { app: /^spark/i, bundleIds: ["com.readdle.SparkDesktop", "com.readdle.smartemail-Mac"], kind: "conversation" },
  { app: /^notion/i, bundleIds: ["notion.id"], kind: "document" },
  { app: /^obsidian$/i, bundleIds: ["md.obsidian"], kind: "document" },
  { app: /^notes$/i, bundleIds: ["com.apple.Notes"], kind: "document" },
  { app: /^linear$/i, bundleIds: ["com.linear"], kind: "document" },
  { app: /^calendar$/i, bundleIds: ["com.apple.iCal"], kind: "document" },
  { app: /fantastical/i, bundleIds: ["com.flexibits.fantastical2.mac"], kind: "document" },
  { app: /todoist/i, bundleIds: ["com.todoist.mac.Todoist"], kind: "document" },
  { app: /^doggy$/i, kind: "own" },
];

const OWN_HOSTS = ["doggy.ruv.world", "localhost", "127.0.0.1"];

export const KIND_LANE: Record<SourceKind, Lane> = {
  conversation: "fast",
  document: "slow",
  unknown: "slow",
  feed: "skip",
  own: "skip",
};

const hostMatches = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

function parseUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Key and kind for one capture. Browser captures key on host (plus the matched path prefix), native apps on bundle id. */
export function classify(c: { app: string; bundleId?: string | null; url?: string | null }): Source {
  const u = parseUrl(c.url);
  if (u) {
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const ownHosts = [...OWN_HOSTS, process.env.DOGGY_PUBLIC_HOST?.toLowerCase()].filter(Boolean) as string[];
    if (ownHosts.includes(host)) return { key: host, kind: "own" };
    const path = u.pathname.toLowerCase();
    for (const r of RULES) {
      if (!r.host || !hostMatches(host, r.host)) continue;
      if (r.pathPrefix && !path.startsWith(r.pathPrefix)) continue;
      return { key: r.pathPrefix ? `${host}${r.pathPrefix}` : host, kind: r.kind };
    }
    return { key: host, kind: "unknown" };
  }
  const key = (c.bundleId || c.app).trim().slice(0, 200);
  for (const r of RULES) {
    if (r.host) continue;
    if ((c.bundleId && r.bundleIds?.includes(c.bundleId)) || r.app?.test(c.app)) return { key, kind: r.kind };
  }
  return { key, kind: "unknown" };
}

/** A fast source that has produced nothing after this many extracted episodes moves to the slow lane. */
export const DEMOTE_AFTER_EPISODES = 30;

export type LaneWhy = "override" | "adaptive" | "default";
export type SourceStats = { episodes: number; itemsKept: number };

/** Override first, then adaptive demotion, then the kind's default. Never auto-promotes and never auto-skips. */
export function resolveLane(kind: SourceKind, override: Lane | null, stats: SourceStats | null): { lane: Lane; why: LaneWhy } {
  if (override) return { lane: override, why: "override" };
  const lane = KIND_LANE[kind];
  if (lane === "fast" && stats && stats.episodes >= DEMOTE_AFTER_EPISODES && stats.itemsKept === 0)
    return { lane: "slow", why: "adaptive" };
  return { lane, why: "default" };
}
