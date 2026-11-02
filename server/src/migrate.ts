import type { Database } from "bun:sqlite";

export type Migration = { version: number; name: string; up: (db: Database) => void };

/** Recorded versions are skipped. A crash before the version row commits runs the step again. */
export function applyMigrations(db: Database, migrations: readonly Migration[]) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const has = db.query("SELECT 1 AS n FROM schema_migrations WHERE version = ?");
  const mark = db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const m of migrations) {
    if (has.get(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      mark.run(m.version, m.name, new Date().toISOString());
    })();
  }
}

export function readSchemaVersion(db: Database): number {
  const row = db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row?.v ?? 0;
}

export const baseline: Migration = {
  version: 1,
  name: "baseline",
  up(db) {
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
CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, app, window, text) VALUES ('delete', old.id, old.app, old.window, old.text);
END;
`);
    for (const sql of [
      "ALTER TABLE items ADD COLUMN title_key TEXT",
      "ALTER TABLE items ADD COLUMN evidence_key TEXT",
      "ALTER TABLE captures ADD COLUMN source_key TEXT",
      "ALTER TABLE captures ADD COLUMN source_kind TEXT",
      "ALTER TABLE captures ADD COLUMN skip_reason TEXT",
    ]) {
      try { db.exec(sql); } catch (e) {
        if (!/duplicate column/i.test((e as Error).message)) throw e;
      }
    }
    db.exec(`
CREATE INDEX IF NOT EXISTS items_title_key ON items(user_id, title_key);
CREATE INDEX IF NOT EXISTS items_evidence_key ON items(user_id, evidence_key);
CREATE INDEX IF NOT EXISTS captures_pending_source ON captures(processed, user_id, device_id, source_key, window);
CREATE TABLE IF NOT EXISTS seen_lines (
  user_id TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL, seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope, hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS seen_lines_age ON seen_lines(seen_at);
CREATE TABLE IF NOT EXISTS llm_usage (
  day TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, kind)
);
CREATE TABLE IF NOT EXISTS source_prefs (
  user_id TEXT NOT NULL, source_key TEXT NOT NULL, lane TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_key)
);
CREATE TABLE IF NOT EXISTS source_stats (
  user_id TEXT NOT NULL, source_key TEXT NOT NULL, kind TEXT NOT NULL,
  episodes INTEGER NOT NULL DEFAULT 0, calls_chars INTEGER NOT NULL DEFAULT 0,
  items_kept INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source_key)
);
`);
  },
};
