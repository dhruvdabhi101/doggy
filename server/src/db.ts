import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DOGGY_DB ?? `${import.meta.dir}/../data/doggy.db`;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, pw_hash TEXT NOT NULL,
  tz TEXT NOT NULL DEFAULT 'UTC', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  app TEXT NOT NULL, bundle_id TEXT, window TEXT NOT NULL DEFAULT '', url TEXT,
  text TEXT NOT NULL, captured_at TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS captures_pending ON captures(processed, user_id, device_id, app, window);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
  text TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  details TEXT, owner TEXT, counterparty TEXT, due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open', evidence TEXT,
  source_kind TEXT NOT NULL, source_app TEXT, source_window TEXT, source_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, seq INTEGER NOT NULL,
  title_key TEXT, evidence_key TEXT
);
CREATE INDEX IF NOT EXISTS items_user_seq ON items(user_id, seq);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO counters VALUES ('seq', 0);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, details, evidence, owner, counterparty, content='items', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, details, evidence, owner, counterparty)
  VALUES (new.rowid, new.title, new.details, new.evidence, new.owner, new.counterparty);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, details, evidence, owner, counterparty)
  VALUES ('delete', old.rowid, old.title, old.details, old.evidence, old.owner, old.counterparty);
  INSERT INTO items_fts(rowid, title, details, evidence, owner, counterparty)
  VALUES (new.rowid, new.title, new.details, new.evidence, new.owner, new.counterparty);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  app, window, text, content='captures', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts(rowid, app, window, text) VALUES (new.id, new.app, new.window, new.text);
END;
`);

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

/** Lowercase, one space. The key used to notice an item we already stored. */
export function textKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const k = s.toLowerCase().replace(/\s+/g, " ").trim();
  return k.length ? k : null;
}

for (const sql of [
  "ALTER TABLE items ADD COLUMN title_key TEXT",
  "ALTER TABLE items ADD COLUMN evidence_key TEXT",
]) {
  try { db.exec(sql); } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}
db.exec(`
CREATE INDEX IF NOT EXISTS items_title_key ON items(user_id, title_key);
CREATE INDEX IF NOT EXISTS items_evidence_key ON items(user_id, evidence_key);
`);
{
  const pending = db.query(
    "SELECT id, title, evidence FROM items WHERE title_key IS NULL OR (evidence IS NOT NULL AND evidence_key IS NULL)",
  ).all() as { id: string; title: string; evidence: string | null }[];
  const fill = db.query("UPDATE items SET title_key = ?, evidence_key = ? WHERE id = ?");
  for (const r of pending) fill.run(textKey(r.title), textKey(r.evidence), r.id);
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

const STOP = new Set(
  "the a an and or of to in on for with what when where who why how did do does i me my we our you your is are was were be been it this that at by from about any have has had should can could will would tell show".split(" "),
);

/** Turn free text into a safe FTS5 OR-query of prefix terms. */
export function ftsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOP.has(w));
  if (!words.length) return null;
  return [...new Set(words)].slice(0, 12).map((w) => `"${w}"*`).join(" OR ");
}

export function searchItems(userId: string, q: string, limit = 20): Item[] {
  const fq = ftsQuery(q);
  if (!fq) return [];
  const rows = db.query(
    `SELECT items.* FROM items_fts JOIN items ON items.rowid = items_fts.rowid
     WHERE items_fts MATCH ? AND items.user_id = ? AND items.status != 'dismissed'
     ORDER BY bm25(items_fts) LIMIT ?`,
  ).all(fq, userId, limit) as ItemRow[];
  return rows.map(toItem);
}

export type CaptureHit = { id: number; app: string; window: string; text: string; capturedAt: string };
export function searchCaptures(userId: string, q: string, limit = 10): CaptureHit[] {
  const fq = ftsQuery(q);
  if (!fq) return [];
  return db.query(
    `SELECT c.id, c.app, c.window, snippet(captures_fts, 2, '', '', ' … ', 48) AS text, c.captured_at AS capturedAt
     FROM captures_fts JOIN captures c ON c.id = captures_fts.rowid
     WHERE captures_fts MATCH ? AND c.user_id = ? ORDER BY bm25(captures_fts) LIMIT ?`,
  ).all(fq, userId, limit) as CaptureHit[];
}

export function openItems(userId: string, limit = 40): Item[] {
  return (db.query(
    `SELECT * FROM items WHERE user_id = ? AND status = 'open' AND type IN ('task','commitment','event')
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(userId, limit) as ItemRow[]).map(toItem);
}
