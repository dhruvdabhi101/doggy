import { db, now } from "./db";
import { KIND_LANE, LANES, resolveLane, type Lane, type LaneWhy, type Source, type SourceKind } from "./sources";

type StatsRow = { source_key: string; kind: SourceKind; episodes: number; calls_chars: number; items_kept: number; last_seen_at: string };

export function laneFor(userId: string, source: Source): { lane: Lane; why: LaneWhy } {
  const pref = db.query("SELECT lane FROM source_prefs WHERE user_id = ? AND source_key = ?")
    .get(userId, source.key) as { lane: Lane } | null;
  const stats = db.query("SELECT episodes, items_kept FROM source_stats WHERE user_id = ? AND source_key = ?")
    .get(userId, source.key) as { episodes: number; items_kept: number } | null;
  return resolveLane(source.kind, pref?.lane ?? null, stats && { episodes: stats.episodes, itemsKept: stats.items_kept });
}

/** Skipped episodes record with zero counts, so feeds still show up in the Sources list and can be turned on. */
export function recordSourceStats(userId: string, source: Source, d: { episodes: number; chars: number; itemsKept: number }) {
  db.query(
    `INSERT INTO source_stats (user_id, source_key, kind, episodes, calls_chars, items_kept, last_seen_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (user_id, source_key) DO UPDATE SET kind = excluded.kind,
       episodes = episodes + excluded.episodes, calls_chars = calls_chars + excluded.calls_chars,
       items_kept = items_kept + excluded.items_kept, last_seen_at = excluded.last_seen_at`,
  ).run(userId, source.key, source.kind, d.episodes, d.chars, d.itemsKept, now());
}

export type SourceView = {
  key: string; kind: SourceKind; defaultLane: Lane; lane: Lane; laneWhy: LaneWhy; override: Lane | null;
  episodes: number; itemsKept: number; lastSeenAt: string | null;
};

export function listSources(userId: string): SourceView[] {
  const stats = db.query("SELECT * FROM source_stats WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId) as StatsRow[];
  const prefs = new Map((db.query("SELECT source_key, lane FROM source_prefs WHERE user_id = ?").all(userId) as
    { source_key: string; lane: Lane }[]).map((p) => [p.source_key, p.lane]));
  const view = (key: string, kind: SourceKind, s: StatsRow | null): SourceView => {
    const override = prefs.get(key) ?? null;
    const r = resolveLane(kind, override, s && { episodes: s.episodes, itemsKept: s.items_kept });
    return {
      key, kind, defaultLane: KIND_LANE[kind], lane: r.lane, laneWhy: r.why, override,
      episodes: s?.episodes ?? 0, itemsKept: s?.items_kept ?? 0, lastSeenAt: s?.last_seen_at ?? null,
    };
  };
  const out = stats.map((s) => view(s.source_key, s.kind, s));
  const seen = new Set(stats.map((s) => s.source_key));
  for (const key of prefs.keys()) if (!seen.has(key)) out.push(view(key, "unknown", null));
  return out;
}

export function setLaneOverride(userId: string, key: string, lane: Lane | null) {
  if (lane === null) db.query("DELETE FROM source_prefs WHERE user_id = ? AND source_key = ?").run(userId, key);
  else db.query(
    `INSERT INTO source_prefs (user_id, source_key, lane, updated_at) VALUES (?,?,?,?)
     ON CONFLICT (user_id, source_key) DO UPDATE SET lane = excluded.lane, updated_at = excluded.updated_at`,
  ).run(userId, key, lane, now());
}

/** `null` clears the override. Anything that is not a lane or null is rejected. */
export function parseLaneBody(b: unknown): { lane: Lane | null } | { error: string } {
  const lane = (b as { lane?: unknown } | null)?.lane;
  if (lane === null) return { lane: null };
  if (typeof lane === "string" && (LANES as readonly string[]).includes(lane)) return { lane: lane as Lane };
  return { error: `lane must be one of ${LANES.join(", ")} or null` };
}
