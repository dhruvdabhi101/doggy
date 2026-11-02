import { db, insertItem, itemKeyTaken, openItems, updateItem, searchItems, type Item } from "./db";
import { extract, type ExtractInput, type ExtractSource } from "./llm";
import { type Source, type SourceKind } from "./sources";
import { laneFor, recordSourceStats } from "./lanes";
import { captureCapHit, recordUsage, utcDay } from "./usage";
import {
  CaptureStatus, EPISODE_MAX_CHARS, MIN_EPISODE_CHARS, SEEN_LINE_TTL_DAYS, isReady, packEpisodes, type SkipReason,
} from "./capture";

type UserCtx = { id: string; email: string; name: string | null; tz: string };

const MIN_CONFIDENCE = { capture: 0.6, voice: 0.2, text: 0.2 } as const;

export type SourceInput = Partial<Omit<ExtractSource, "text">> & { text: string; sourceId: string };

/** Run one extraction over one or more sources and persist the results. Returns the new items per source. */
export async function processSources(user: UserCtx, kind: ExtractInput["kind"], inputs: SourceInput[]): Promise<Item[][]> {
  const related = inputs.flatMap((s) => searchItems(user.id, s.text.slice(0, 1000), 8)).filter((i) => i.status === "open");
  const existing = [...new Map([...openItems(user.id, 25), ...related].map((i) => [i.id, i])).values()];
  const sources: ExtractSource[] = inputs.map((s) => ({ app: s.app ?? null, window: s.window ?? null, url: s.url ?? null, text: s.text }));

  const { result: out, usage } = await extract({ kind, sources, userName: user.name, userEmail: user.email, tz: user.tz, existing });
  recordUsage(user.id, kind, usage);

  const created: Item[][] = inputs.map(() => []);
  for (const it of out.items) {
    if (it.confidence < MIN_CONFIDENCE[kind]) continue;
    if (itemKeyTaken(user.id, it.title, it.evidence)) continue;
    const src = inputs[it.source]!;
    created[it.source]!.push(insertItem(user.id, {
      type: it.type, title: it.title, details: it.details, owner: it.owner, counterparty: it.counterparty,
      dueAt: validIso(it.due_at), evidence: it.evidence, sourceKind: kind, sourceApp: src.app ?? null,
      sourceWindow: src.window ?? null, sourceId: src.sourceId, confidence: it.confidence,
    }));
  }
  for (const c of out.closes) {
    updateItem(user.id, c.item_id, { status: "done" });
    console.log(`[pipeline] closed ${c.item_id}: ${c.evidence.slice(0, 80)}`);
  }
  return created;
}

function validIso(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- background capture worker ----------
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrune = 0;
let running = false;

function pruneSeenLines() {
  if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = Date.now();
  const cutoff = new Date(Date.now() - SEEN_LINE_TTL_DAYS * 86_400_000).toISOString();
  const r = db.query("DELETE FROM seen_lines WHERE seen_at < ?").run(cutoff);
  if (r.changes) console.log(`[pipeline] pruned ${r.changes} seen lines older than ${SEEN_LINE_TTL_DAYS} days`);
}

type Group = {
  user_id: string; device_id: string; source_key: string; source_kind: SourceKind; window: string;
  first: string; last: string; chars: number;
};
type Episode = { userId: string; source: Source; window: string; app: string; url: string | null; ids: number[]; text: string };

function loadEpisode(g: Group): Episode {
  const rows = db.query(
    `SELECT id, app, text, url FROM captures
     WHERE processed = ? AND user_id = ? AND device_id = ? AND source_key = ? AND window = ? ORDER BY id`,
  ).all(CaptureStatus.PENDING, g.user_id, g.device_id, g.source_key, g.window) as
    { id: number; app: string; text: string; url: string | null }[];
  return {
    userId: g.user_id, source: { key: g.source_key, kind: g.source_kind }, window: g.window,
    app: rows.at(-1)?.app ?? "", url: rows.findLast((r) => r.url)?.url ?? null, ids: rows.map((r) => r.id),
    text: rows.map((r) => r.text).join("\n").slice(-EPISODE_MAX_CHARS),
  };
}

function markCaptures(ids: number[], status: number, reason: SkipReason | null = null) {
  if (!ids.length) return;
  db.query(`UPDATE captures SET processed = ?, skip_reason = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .run(status, reason, ...ids);
}

export async function processPendingCaptures() {
  if (running) return;
  running = true;
  try {
    pruneSeenLines();
    const groups = db.query(
      `SELECT user_id, device_id, source_key, source_kind, window, MIN(captured_at) AS first, MAX(captured_at) AS last,
         SUM(LENGTH(text)) AS chars
       FROM captures WHERE processed = ? GROUP BY user_id, device_id, source_key, window`,
    ).all(CaptureStatus.PENDING) as Group[];
    const nowMs = Date.now();
    const ready = new Map<string, Episode[]>();
    for (const g of groups) {
      const { lane, why } = laneFor(g.user_id, { key: g.source_key, kind: g.source_kind });
      if (!isReady(lane, { firstAt: g.first, lastAt: g.last, chars: g.chars }, nowMs)) continue;
      const ep = loadEpisode(g);
      if (lane === "skip") {
        const reason: SkipReason = why === "override" ? "user_off" : g.source_kind === "own" ? "own" : "feed";
        markCaptures(ep.ids, CaptureStatus.SKIPPED, reason);
        recordSourceStats(ep.userId, ep.source, { episodes: 0, chars: 0, itemsKept: 0 });
        continue;
      }
      if (ep.text.trim().length < MIN_EPISODE_CHARS) { markCaptures(ep.ids, CaptureStatus.DONE); continue; }
      ready.set(g.user_id, [...(ready.get(g.user_id) ?? []), ep]);
    }
    for (const [userId, eps] of ready) await extractForUser(userId, eps);
  } finally {
    running = false;
  }
}

const capLogged = new Map<string, string>();

async function extractForUser(userId: string, eps: Episode[]) {
  const user = db.query("SELECT id, email, name, tz FROM users WHERE id = ?").get(userId) as UserCtx;
  const packs = packEpisodes(eps);
  for (const pack of packs) {
    const cap = captureCapHit(userId);
    if (cap) {
      for (const ep of pack) markCaptures(ep.ids, CaptureStatus.SKIPPED, "budget");
      if (capLogged.get(userId) !== utcDay()) {
        capLogged.set(userId, utcDay());
        console.warn(`[pipeline] user ${userId}: ${cap} daily capture token cap reached; skipping captures until 00:00 UTC`);
      }
      continue;
    }
    try {
      const created = await processSources(user, "capture", pack.map((ep) => ({
        app: ep.app, window: ep.window, url: ep.url, text: ep.text, sourceId: `capture:${ep.ids.at(-1)}`,
      })));
      pack.forEach((ep, i) => {
        markCaptures(ep.ids, CaptureStatus.DONE);
        recordSourceStats(userId, ep.source, { episodes: 1, chars: ep.text.length, itemsKept: created[i]!.length });
        if (created[i]!.length) console.log(`[pipeline] ${ep.source.key} / ${ep.window}: +${created[i]!.length} items`);
      });
    } catch (e) {
      // Left pending; retried next tick.
      console.error(`[pipeline] extraction failed for ${pack.length} episode(s):`, (e as Error).message);
    }
  }
  console.log(`[pipeline] user ${userId}: ${eps.length} episode(s) in ${packs.length} call(s)`);
}
