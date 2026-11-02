import { db, insertItem, openItems, updateItem, searchItems, type Item } from "./db";
import { extract, type ExtractInput } from "./llm";

type UserCtx = { id: string; email: string; name: string | null; tz: string };

const MIN_CONFIDENCE = { capture: 0.6, voice: 0.2, text: 0.2 } as const;

/** Run extraction for one source and persist the results. Shared by notes and screen captures. */
export async function processSource(
  user: UserCtx,
  src: Omit<ExtractInput, "userName" | "userEmail" | "tz" | "existing"> & { sourceId: string },
): Promise<Item[]> {
  // Existing open loops: most recent plus anything lexically related, so the model can dedupe/close.
  const related = searchItems(user.id, src.text.slice(0, 2000), 15).filter((i) => i.status === "open");
  const existing = [...new Map([...openItems(user.id, 25), ...related].map((i) => [i.id, i])).values()];

  const out = await extract({ ...src, userName: user.name, userEmail: user.email, tz: user.tz, existing });

  const created: Item[] = [];
  for (const it of out.items) {
    if (it.confidence < MIN_CONFIDENCE[src.kind]) continue;
    const dup = existing.find((e) => e.title.toLowerCase() === it.title.toLowerCase());
    if (dup) continue;
    created.push(insertItem(user.id, {
      type: it.type, title: it.title, details: it.details, owner: it.owner, counterparty: it.counterparty,
      dueAt: validIso(it.due_at), evidence: it.evidence, sourceKind: src.kind, sourceApp: src.app ?? null,
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
const IDLE_MS = Number(process.env.DOGGY_EPISODE_IDLE_MS ?? 45_000); // window quiet this long => episode done
const MAX_CHARS = 12_000;
let running = false;

type Group = { user_id: string; device_id: string; app: string; window: string; last: string; chars: number };

export async function processPendingCaptures() {
  if (running) return;
  running = true;
  try {
    const groups = db.query(
      `SELECT user_id, device_id, app, window, MAX(captured_at) AS last, SUM(LENGTH(text)) AS chars
       FROM captures WHERE processed = 0 GROUP BY user_id, device_id, app, window`,
    ).all() as Group[];
    const cutoff = new Date(Date.now() - IDLE_MS).toISOString();
    for (const g of groups) {
      if (g.last > cutoff && g.chars < MAX_CHARS) continue; // still active; wait for more context
      const rows = db.query(
        `SELECT id, text, url FROM captures WHERE processed = 0 AND user_id=? AND device_id=? AND app=? AND window=?
         ORDER BY id`,
      ).all(g.user_id, g.device_id, g.app, g.window) as { id: number; text: string; url: string | null }[];
      const ids = rows.map((r) => r.id);
      const text = rows.map((r) => r.text).join("\n").slice(-MAX_CHARS);
      const user = db.query("SELECT id, email, name, tz FROM users WHERE id = ?").get(g.user_id) as UserCtx;
      try {
        if (text.trim().length >= 20) {
          const made = await processSource(user, {
            kind: "capture", text, app: g.app, window: g.window,
            url: rows.findLast((r) => r.url)?.url ?? null, sourceId: `capture:${ids.at(-1)}`,
          });
          if (made.length) console.log(`[pipeline] ${g.app} / ${g.window}: +${made.length} items`);
        }
        db.query(`UPDATE captures SET processed = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      } catch (e) {
        console.error(`[pipeline] extraction failed for ${g.app}/${g.window}:`, (e as Error).message);
        // leave unprocessed; retried next tick
      }
    }
  } finally {
    running = false;
  }
}
