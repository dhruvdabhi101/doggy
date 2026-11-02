/**
 * Replays stored captures through the capture gates without calling a model, and compares the
 * old pipeline (one call per app+window episode) with the new one (dedupe, lanes, batching).
 *
 *   bun scripts/replay.ts <path-to-db-copy> [--from ISO] [--to ISO] [--user id]
 *
 * Opens the database read-only. Approximations, stated in the output too: the worker tick is
 * modelled as a 10s bucket, adaptive demotion and budget caps are ignored, and a database written
 * by the new server already holds deduped captures.
 */
import { Database } from "bun:sqlite";
import {
  CALL_MAX_CHARS, EPISODE_IDLE_MS, EPISODE_MAX_CHARS, MIN_EPISODE_CHARS, SLOW_LANE_MS, filterNewLines, packEpisodes, slowFlushAt,
} from "../src/capture";
import { classify, resolveLane, type Lane, type Source } from "../src/sources";

const TICK_MS = 10_000;

type Args = { path: string; from: string | null; to: string | null; user: string | null };
function parseArgs(argv: string[]): Args {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null; };
  const path = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  if (!path) {
    console.error("usage: bun scripts/replay.ts <path-to-db-copy> [--from ISO] [--to ISO] [--user id]");
    process.exit(2);
  }
  return { path, from: flag("--from"), to: flag("--to"), user: flag("--user") };
}

type Row = {
  id: number; user_id: string; device_id: string; app: string; bundle_id: string | null; window: string;
  url: string | null; text: string; captured_at: string;
};
type Capture = Row & { ms: number; source: Source };
type Episode = { userId: string; caps: Capture[]; text: string; firstMs: number; lastMs: number; readyMs: number; lane: Lane; key: string };

/** Splits one group's captures into episodes the way the worker would close them. */
function episodesOf(caps: Capture[], lane: Lane, key: string, text: (c: Capture) => string): Episode[] {
  const out: Episode[] = [];
  let cur: Episode | null = null;
  const close = () => {
    if (!cur) return;
    const full = cur.text.length >= EPISODE_MAX_CHARS;
    cur.readyMs = full ? cur.lastMs : lane === "slow" ? slowFlushAt(cur.firstMs) : cur.lastMs + EPISODE_IDLE_MS;
    cur.text = cur.text.slice(-EPISODE_MAX_CHARS);
    out.push(cur); cur = null;
  };
  for (const c of caps) {
    if (cur) {
      const expired = lane === "slow" ? c.ms >= slowFlushAt(cur.firstMs) : c.ms - cur.lastMs > EPISODE_IDLE_MS;
      if (expired || cur.text.length >= EPISODE_MAX_CHARS) close();
    }
    const t = text(c);
    if (!cur) cur = { userId: c.user_id, caps: [], text: "", firstMs: c.ms, lastMs: c.ms, readyMs: 0, lane, key };
    cur.caps.push(c); cur.lastMs = c.ms;
    cur.text = cur.text ? `${cur.text}\n${t}` : t;
  }
  close();
  return out;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x); else m.set(k, [x]);
  }
  return m;
}

const hasTable = (db: Database, name: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.path, { readonly: true });
  const where = ["1 = 1"]; const params: string[] = [];
  if (args.from) { where.push("captured_at >= ?"); params.push(args.from); }
  if (args.to) { where.push("captured_at <= ?"); params.push(args.to); }
  if (args.user) { where.push("user_id = ?"); params.push(args.user); }
  const rows = db.query(
    `SELECT id, user_id, device_id, app, bundle_id, window, url, text, captured_at FROM captures
     WHERE ${where.join(" AND ")} ORDER BY captured_at, id`,
  ).all(...params) as Row[];
  const caps: Capture[] = rows.map((r) => ({
    ...r, ms: Date.parse(r.captured_at), source: classify({ app: r.app, bundleId: r.bundle_id, url: r.url }),
  }));

  const prefs = new Map<string, Lane>();
  if (hasTable(db, "source_prefs"))
    for (const p of db.query("SELECT user_id, source_key, lane FROM source_prefs").all() as { user_id: string; source_key: string; lane: Lane }[])
      prefs.set(`${p.user_id}\u0001${p.source_key}`, p.lane);
  const resolve = (c: Capture) => resolveLane(c.source.kind, prefs.get(`${c.user_id}\u0001${c.source.key}`) ?? null, null);
  const laneOf = (c: Capture) => resolve(c).lane;

  // Old pipeline: every app+window episode with 20+ chars and not wholly our own page is one call.
  const oldEpisodes = [...groupBy(caps, (c) => [c.user_id, c.device_id, c.app, c.window].join("\u0001")).values()]
    .flatMap((g) => episodesOf(g, "fast", g[0]!.app, (c) => c.text));
  const oldCalls = oldEpisodes.filter((ep) => {
    const urls = ep.caps.filter((c) => c.url);
    const own = urls.length > 0 && urls.every((c) => c.source.kind === "own");
    return !own && ep.text.trim().length >= MIN_EPISODE_CHARS;
  });

  // New pipeline: dedupe per (user, source), then lanes, then per-tick packing.
  const seen = new Map<string, Set<string>>();
  const kept = new Map<number, string>();
  for (const c of caps) {
    const scope = `${c.user_id}\u0001${c.source.key}`;
    const set = seen.get(scope) ?? new Set<string>();
    seen.set(scope, set);
    const f = filterNewLines(c.text, (h) => set.has(h));
    if (!f.newHashes.length) continue;
    for (const h of f.newHashes) set.add(h);
    kept.set(c.id, f.lines.join("\n"));
  }
  const survivors = caps.filter((c) => kept.has(c.id));
  const newEpisodes = [...groupBy(survivors, (c) => [c.user_id, c.device_id, c.source.key, c.window].join("\u0001")).values()]
    .flatMap((g) => episodesOf(g, laneOf(g[0]!), g[0]!.source.key, (c) => kept.get(c.id)!));
  const callable = newEpisodes.filter((ep) => ep.lane !== "skip" && ep.text.trim().length >= MIN_EPISODE_CHARS);
  const ticks = groupBy(callable, (ep) => `${ep.userId}\u0001${Math.ceil(ep.readyMs / TICK_MS)}`);
  const newCalls = [...ticks.values()].flatMap((eps) => packEpisodes(eps, CALL_MAX_CHARS));

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lanes: Lane[] = ["fast", "slow", "skip"];

  console.log(`replay ${args.path}${args.from ? ` from ${args.from}` : ""}${args.to ? ` to ${args.to}` : ""}${args.user ? ` user ${args.user}` : ""}`);
  console.log(`idle ${EPISODE_IDLE_MS}ms, slow lane ${SLOW_LANE_MS}ms, episode cap ${EPISODE_MAX_CHARS} chars, call cap ${CALL_MAX_CHARS} chars`);
  console.log("");
  console.log(`raw events                ${caps.length}`);
  console.log(`events after dedupe       ${survivors.length}`);
  console.log(`episodes per lane         ${lanes.map((l) => `${l} ${newEpisodes.filter((e) => e.lane === l).length}`).join(", ")}`);
  console.log(`model calls  old ${pad(oldCalls.length, 8)} new ${newCalls.length}`);
  console.log(`chars sent   old ${pad(sum(oldCalls.map((ep) => ep.text.length)), 8)} new ${sum(newCalls.flat().map((e) => e.text.length))}`);
  console.log("");

  console.log("per source");
  console.log(`  ${pad("source", 34)}${pad("lane", 6)}${pad("raw", 6)}${pad("kept", 6)}${pad("episodes", 10)}old calls`);
  const bySource = groupBy(caps, (c) => c.source.key);
  const ordered = [...bySource.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, cs] of ordered) {
    const keptN = cs.filter((c) => kept.has(c.id)).length;
    const eps = newEpisodes.filter((e) => e.key === key).length;
    const old = oldCalls.filter((ep) => ep.caps.some((c) => c.source.key === key)).length;
    console.log(`  ${pad(key.slice(0, 33), 34)}${pad(laneOf(cs[0]!), 6)}${pad(cs.length, 6)}${pad(keptN, 6)}${pad(eps, 10)}${old}`);
  }
  console.log("");

  const items = db.query(
    `SELECT title, status, source_id FROM items WHERE source_kind = 'capture' AND source_id LIKE 'capture:%' AND status != 'dismissed'
     ${args.user ? "AND user_id = ?" : ""} ORDER BY created_at`,
  ).all(...(args.user ? [args.user] : [])) as { title: string; status: string; source_id: string }[];
  console.log(`kept capture items (${items.length}): would the new pipeline still extract their episode?`);
  const byId = new Map(caps.map((c) => [c.id, c]));
  const oldEpisodeOf = new Map(oldEpisodes.flatMap((ep) => ep.caps.map((c) => [c.id, ep] as const)));
  for (const it of items) {
    const id = Number(it.source_id.slice("capture:".length));
    const c = byId.get(id);
    if (!c) { console.log(`  [outside range] ${it.title}`); continue; }
    const old = oldEpisodeOf.get(id);
    const survived = (old?.caps ?? [c]).filter((x) => kept.has(x.id)).length;
    const { lane, why } = resolve(c);
    const verdict = lane === "skip" ? `SKIPPED (${why === "override" ? "user off" : c.source.kind})`
      : survived === 0 ? "DROPPED by dedupe" : `extracted, ${lane} lane`;
    const title = it.title.replace(/\s+/g, " ");
    console.log(`  ${pad(verdict, 22)} ${pad(c.source.key.slice(0, 30), 31)} ${survived}/${old?.caps.length ?? 1} captures kept  ${title}`);
  }
  console.log("");
  console.log("approximations: 10s tick buckets; adaptive demotion and budget caps not modelled; a DB written by the new server is already deduped at ingest.");
}

main();
