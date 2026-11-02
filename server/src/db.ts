import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CaptureStatus } from "./capture";
import { applyMigrations, baseline, readSchemaVersion } from "./migrate";
import { classify } from "./sources";

const DB_PATH = process.env.DOGGY_DB ?? `${import.meta.dir}/../data/doggy.db`;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

/** Lowercase, one space. The key used to notice an item we already stored. */
export function textKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = s.toLowerCase().replace(/\s+/g, " ").trim();
  return k.length ? k : null;
}

function backfillKeys(database: Database) {
  const pendingCaps = database.query(
    "SELECT id, app, bundle_id, url FROM captures WHERE processed = ? AND source_key IS NULL",
  ).all(CaptureStatus.PENDING) as { id: number; app: string; bundle_id: string | null; url: string | null }[];
  const fillCap = database.query("UPDATE captures SET source_key = ?, source_kind = ? WHERE id = ?");
  for (const r of pendingCaps) {
    const s = classify({ app: r.app, bundleId: r.bundle_id, url: r.url });
    fillCap.run(s.key, s.kind, r.id);
  }
  const pendingItems = database.query(
    "SELECT id, title, evidence FROM items WHERE title_key IS NULL OR (evidence IS NOT NULL AND evidence_key IS NULL)",
  ).all() as { id: string; title: string; evidence: string | null }[];
  const fillItem = database.query("UPDATE items SET title_key = ?, evidence_key = ? WHERE id = ?");
  for (const r of pendingItems) fillItem.run(textKey(r.title), textKey(r.evidence), r.id);
}

applyMigrations(db, [
  baseline,
  { version: 2, name: "backfill derived keys", up: backfillKeys },
]);

export function schemaVersion(): number {
  return readSchemaVersion(db);
}

/** True when this user already has an item with this title, or with this quote. Indexed lookups, any status. */
export function itemKeyTaken(userId: string, title: string, evidence: string | null): boolean {
  const titleKey = textKey(title);
  const evidenceKey = textKey(evidence);
  if (evidenceKey && evidenceKey.length >= 12) {
    const hit = db.query("SELECT 1 AS n FROM items WHERE user_id = ? AND evidence_key = ? LIMIT 1").get(userId, evidenceKey);
    if (hit) return true;
  }
  if (!titleKey) return false;
  return !!db.query("SELECT 1 AS n FROM items WHERE user_id = ? AND title_key = ? LIMIT 1").get(userId, titleKey);
}

export function nextSeq(): number {
  const row = db.query("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as {
    value: number;
  };
  return row.value;
}

export type ItemRow = {
  id: string; user_id: string; type: string; title: string; details: string | null;
  owner: string | null; counterparty: string | null; due_at: string | null; status: string;
  evidence: string | null; source_kind: string; source_app: string | null; source_window: string | null;
  source_id: string | null; confidence: number; created_at: string; updated_at: string; seq: number;
};

export function toItem(r: ItemRow) {
  return {
    id: r.id, type: r.type, title: r.title, details: r.details, owner: r.owner,
    counterparty: r.counterparty, dueAt: r.due_at, status: r.status, evidence: r.evidence,
    sourceKind: r.source_kind, sourceApp: r.source_app, sourceWindow: r.source_window,
    sourceId: r.source_id, confidence: r.confidence, createdAt: r.created_at,
    updatedAt: r.updated_at, seq: r.seq,
  };
}
export type Item = ReturnType<typeof toItem>;

export type NewItem = {
  type: string; title: string; details?: string | null; owner?: string | null;
  counterparty?: string | null; dueAt?: string | null; evidence?: string | null;
  sourceKind: string; sourceApp?: string | null; sourceWindow?: string | null;
  sourceId?: string | null; confidence?: number;
};

export function insertItem(userId: string, it: NewItem): Item {
  const id = uid(); const t = now();
  db.query(
    `INSERT INTO items (id,user_id,type,title,details,owner,counterparty,due_at,status,evidence,
      source_kind,source_app,source_window,source_id,confidence,created_at,updated_at,seq,title_key,evidence_key)
     VALUES (?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, userId, it.type, it.title, it.details ?? null, it.owner ?? null, it.counterparty ?? null,
    it.dueAt ?? null, it.evidence ?? null, it.sourceKind, it.sourceApp ?? null, it.sourceWindow ?? null,
    it.sourceId ?? null, it.confidence ?? 0.5, t, t, nextSeq(), textKey(it.title), textKey(it.evidence),
  );
  return getItem(userId, id)!;
}

export function getItem(userId: string, id: string): Item | null {
  const r = db.query("SELECT * FROM items WHERE id = ? AND user_id = ?").get(id, userId) as ItemRow | null;
  return r ? toItem(r) : null;
}

export type ItemPatch = {
  status?: string; title?: string; type?: string; dueAt?: string | null;
  details?: string | null; owner?: string | null; counterparty?: string | null;
};

export function updateItem(userId: string, id: string, patch: ItemPatch): Item | null {
  const cur = getItem(userId, id);
  if (!cur) return null;
  const pick = <K extends keyof ItemPatch>(k: K, fallback: unknown) => (patch[k] === undefined ? fallback : patch[k]);
  db.query(
    `UPDATE items SET status=?, title=?, type=?, due_at=?, details=?, owner=?, counterparty=?, updated_at=?, seq=?, title_key=?
     WHERE id=? AND user_id=?`,
  ).run(
    pick("status", cur.status) as string, pick("title", cur.title) as string, pick("type", cur.type) as string,
    pick("dueAt", cur.dueAt) as string | null, pick("details", cur.details) as string | null,
    pick("owner", cur.owner) as string | null, pick("counterparty", cur.counterparty) as string | null,
    now(), nextSeq(), textKey(pick("title", cur.title) as string), id, userId,
  );
  return getItem(userId, id);
}

export type ItemListQuery = {
  types?: string[];
  status?: string;
  excludeStatus?: string;
  sort: "due" | "created";
  limit: number;
  offset: number;
};

const ITEM_ORDER = {
  due: "CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC, id ASC",
  created: "created_at DESC, id DESC",
} as const;

function itemWhere(userId: string, q: Pick<ItemListQuery, "types" | "status" | "excludeStatus">) {
  const where = ["user_id = ?"];
  const args: (string | number)[] = [userId];
  if (q.types?.length) {
    where.push(`type IN (${q.types.map(() => "?").join(",")})`);
    args.push(...q.types);
  }
  if (q.status) { where.push("status = ?"); args.push(q.status); }
  else if (q.excludeStatus) { where.push("status != ?"); args.push(q.excludeStatus); }
  return { where: where.join(" AND "), args };
}

export function listItems(userId: string, q: ItemListQuery): { items: Item[]; total: number } {
  const { where, args } = itemWhere(userId, q);
  const total = (db.query(`SELECT COUNT(*) AS n FROM items WHERE ${where}`).get(...args) as { n: number }).n;
  const rows = db.query(
    `SELECT * FROM items WHERE ${where} ORDER BY ${ITEM_ORDER[q.sort]} LIMIT ? OFFSET ?`,
  ).all(...args, q.limit, q.offset) as ItemRow[];
  return { items: rows.map(toItem), total };
}

const STOP = new Set(
  "the a an and or of to in on for with what when where who why how did do does i me my we our you your is are was were be been it this that at by from about any have has had should can could will would tell show".split(" "),
);

const contentWords = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOP.has(w));

/** Turn free text into a safe FTS5 OR-query of prefix terms. */
export function ftsQuery(q: string): string | null {
  const words = contentWords(q);
  if (!words.length) return null;
  return [...new Set(words)].slice(0, 12).map((w) => `"${w}"*`).join(" OR ");
}

export function searchItems(userId: string, q: string, limit = 20, offset = 0, type?: string): Item[] {
  const fq = ftsQuery(q);
  if (!fq) return [];
  const typeSql = type ? " AND items.type = ?" : "";
  const args = type ? [fq, userId, type, limit, offset] : [fq, userId, limit, offset];
  const rows = db.query(
    `SELECT items.* FROM items_fts JOIN items ON items.rowid = items_fts.rowid
     WHERE items_fts MATCH ? AND items.user_id = ? AND items.status != 'dismissed'${typeSql}
     ORDER BY bm25(items_fts) LIMIT ? OFFSET ?`,
  ).all(...args) as ItemRow[];
  return rows.map(toItem);
}

export function countItemHits(userId: string, q: string, type?: string): number {
  const fq = ftsQuery(q);
  if (!fq) return 0;
  const typeSql = type ? " AND items.type = ?" : "";
  const args = type ? [fq, userId, type] : [fq, userId];
  return (db.query(
    `SELECT COUNT(*) AS n FROM items_fts JOIN items ON items.rowid = items_fts.rowid
     WHERE items_fts MATCH ? AND items.user_id = ? AND items.status != 'dismissed'${typeSql}`,
  ).get(...args) as { n: number }).n;
}

export type CaptureHit = { id: number; app: string; window: string; text: string; capturedAt: string };
export function searchCaptures(userId: string, q: string, limit = 10, offset = 0): CaptureHit[] {
  const fq = ftsQuery(q);
  if (!fq) return [];
  return db.query(
    `SELECT c.id, c.app, c.window, snippet(captures_fts, 2, '', '', ' … ', 48) AS text, c.captured_at AS capturedAt
     FROM captures_fts JOIN captures c ON c.id = captures_fts.rowid
     WHERE captures_fts MATCH ? AND c.user_id = ? ORDER BY bm25(captures_fts) LIMIT ? OFFSET ?`,
  ).all(fq, userId, limit, offset) as CaptureHit[];
}

export function countCaptureHits(userId: string, q: string): number {
  const fq = ftsQuery(q);
  if (!fq) return 0;
  return (db.query(
    `SELECT COUNT(*) AS n FROM captures_fts JOIN captures c ON c.id = captures_fts.rowid
     WHERE captures_fts MATCH ? AND c.user_id = ?`,
  ).get(fq, userId) as { n: number }).n;
}

export const NEAR_DUPLICATE_JACCARD = 0.6;

/** True when an open or done item's title shares most of its content words with this title. */
export function nearDuplicate(userId: string, title: string): boolean {
  const a = new Set(contentWords(title));
  if (!a.size) return false;
  return searchItems(userId, title, 5).some((it) => {
    const b = new Set(contentWords(it.title));
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared / (a.size + b.size - shared) >= NEAR_DUPLICATE_JACCARD;
  });
}

export function recentlyDoneItems(userId: string, limit = 15): Item[] {
  return (db.query("SELECT * FROM items WHERE user_id = ? AND status = 'done' ORDER BY updated_at DESC LIMIT ?")
    .all(userId, limit) as ItemRow[]).map(toItem);
}

export function openItems(userId: string, limit = 40): Item[] {
  return (db.query(
    `SELECT * FROM items WHERE user_id = ? AND status = 'open' AND type IN ('task','commitment','event')
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(userId, limit) as ItemRow[]).map(toItem);
}
