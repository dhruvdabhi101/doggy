import type { Lane } from "./sources";

/**
 * Pure capture rules shared by the server and scripts/replay.ts: line fingerprints,
 * episode readiness, and packing episodes into model calls. No database here.
 */

/** Values of captures.processed. Rows written before 2026-11-02 only ever hold 0 or 1. */
export const CaptureStatus = { PENDING: 0, DONE: 1, SKIPPED: 2 } as const;
export type SkipReason = "own" | "feed" | "user_off";

/** Lines shorter than this recur across chats ("ok", "thanks"), so they are kept but never fingerprinted. */
export const MIN_FINGERPRINT_CHARS = 8;
export const SEEN_LINE_TTL_DAYS = 30;
/** Processed screen text is deleted after this. Items keep their own quote, so title and quote dedupe still works. */
export const CAPTURE_RETENTION_DAYS = Number(process.env.DOGGY_CAPTURE_RETENTION_DAYS ?? 30);

export const normalizeLine = (s: string) => s.replace(/\s+/g, " ").trim();

export const lineHash = (normalized: string) =>
  new Bun.CryptoHasher("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 32);

export type LineFilter = { lines: string[]; newHashes: string[] };

/**
 * Keep the lines of one event that this scope has not seen. `newHashes` is empty when nothing
 * fingerprintable is new, which means the event carries no new text and should be dropped.
 */
export function filterNewLines(text: string, seen: (hash: string) => boolean): LineFilter {
  const lines: string[] = [];
  const newHashes: string[] = [];
  const local = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = normalizeLine(raw);
    if (!line) continue;
    if (line.length < MIN_FINGERPRINT_CHARS) { lines.push(line); continue; }
    const h = lineHash(line);
    if (local.has(h) || seen(h)) continue;
    local.add(h);
    newHashes.push(h);
    lines.push(line);
  }
  return { lines, newHashes };
}

export const EPISODE_IDLE_MS = Number(process.env.DOGGY_EPISODE_IDLE_MS ?? 45_000);
export const SLOW_LANE_MS = Number(process.env.DOGGY_SLOW_LANE_MS ?? 60 * 60_000);
/** One episode never sends more than this; the oldest text of a long episode is cut. */
export const EPISODE_MAX_CHARS = 12_000;
/** Episodes of one user are packed into a single call up to this much source text. */
export const CALL_MAX_CHARS = 24_000;
export const MIN_EPISODE_CHARS = 20;

export type EpisodeTiming = { firstAt: string; lastAt: string; chars: number };

/**
 * End of the clock-aligned slow window that holds `ms`. Every slow episode a user starts in the same window
 * becomes ready at the same moment, so they share one packed call instead of one call each.
 */
export function slowFlushAt(ms: number): number {
  return (Math.floor(ms / SLOW_LANE_MS) + 1) * SLOW_LANE_MS;
}

/** Fast waits for the window to go quiet. Slow waits for its clock window to end. Skip never waits. */
export function isReady(lane: Lane, ep: EpisodeTiming, nowMs: number): boolean {
  if (lane === "skip" || ep.chars >= EPISODE_MAX_CHARS) return true;
  return lane === "fast"
    ? nowMs - Date.parse(ep.lastAt) >= EPISODE_IDLE_MS
    : nowMs >= slowFlushAt(Date.parse(ep.firstAt));
}

/** Greedy, in order. An episode is never split, so a call can hold one episode bigger than the limit. */
export function packEpisodes<T extends { text: string }>(eps: T[], maxChars = CALL_MAX_CHARS): T[][] {
  const packs: T[][] = [];
  let cur: T[] = []; let size = 0;
  for (const ep of eps) {
    if (cur.length && size + ep.text.length > maxChars) { packs.push(cur); cur = []; size = 0; }
    cur.push(ep); size += ep.text.length;
  }
  if (cur.length) packs.push(cur);
  return packs;
}
