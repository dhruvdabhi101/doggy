/**
 * Pure capture rules shared by the server and scripts/replay.ts: line fingerprints,
 * episode readiness, and packing episodes into model calls. No database here.
 */

/** Values of captures.processed. Rows written before 2026-11-02 only ever hold 0 or 1. */
export const CaptureStatus = { PENDING: 0, DONE: 1, SKIPPED: 2 } as const;
export type SkipReason = "own" | "feed" | "user_off" | "budget";

/** Lines shorter than this recur across chats ("ok", "thanks"), so they are kept but never fingerprinted. */
export const MIN_FINGERPRINT_CHARS = 8;
export const SEEN_LINE_TTL_DAYS = 30;

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
