import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readCounts, shrinkReport, snapshotDatabase } from "./backup";
import { applyMigrations, baseline, readSchemaVersion } from "./migrate";

const dir = mkdtempSync(join(tmpdir(), "doggy-prove-"));
process.env.DOGGY_DB = join(dir, "live.db");

test("an existing database keeps its rows when the baseline runs again", () => {
  const path = join(dir, "legacy.db");
  const db = new Database(path);
  baseline.up(db);
  db.query("INSERT INTO users (id, email, pw_hash, created_at) VALUES ('u', 'a@b.co', 'x', '2026-01-01')").run();
  db.query("INSERT INTO items (id, user_id, type, title, status, source_kind, confidence, created_at, updated_at, seq) VALUES ('i1', 'u', 'task', 'ship it', 'open', 'text', 1, '2026-01-02', '2026-01-02', 1)").run();
  applyMigrations(db, [baseline]);
  applyMigrations(db, [baseline]);
  const users = (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const items = (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  expect(users).toBe(1);
  expect(items).toBe(1);
  expect(readSchemaVersion(db)).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(1);
  db.close();
});

const { app } = await import("./index");

test("pages come from the server, export matches them, and a snapshot does not drop rows", async () => {
  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "prove@doggy.test", password: "long-enough", deviceName: "test", deviceKind: "web" }),
  });
  expect(signup.status).toBe(200);
  const { token } = await signup.json() as { token: string };
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (let i = 0; i < 25; i++) {
    const res = await app.request("/api/items", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "memory", title: `memory ${String(i).padStart(2, "0")}` }),
    });
    expect(res.status).toBe(200);
  }
  const ids = async (offset: number) => {
    const res = await app.request(`/api/items?sort=created&excludeStatus=dismissed&limit=10&offset=${offset}`, { headers: auth });
    expect(res.status).toBe(200);
    return await res.json() as { items: { id: string }[]; total: number; limit: number; offset: number };
  };
  const first = await ids(0);
  const middle = await ids(10);
  const last = await ids(20);
  expect(first.total).toBe(25);
  expect(middle.total).toBe(25);
  expect(first.items).toHaveLength(10);
  expect(middle.items).toHaveLength(10);
  expect(last.items).toHaveLength(5);
  expect(middle.limit).toBe(10);
  expect(middle.offset).toBe(10);
  const seen = new Set([...first.items, ...middle.items, ...last.items].map((i) => i.id));
  expect(seen.size).toBe(25);

  const found = await app.request("/api/search?q=memory&limit=10&offset=10", { headers: auth });
  expect(found.status).toBe(200);
  const hits = await found.json() as { items: unknown[]; itemTotal: number };
  expect(hits.itemTotal).toBe(25);
  expect(hits.items).toHaveLength(10);

  const bad = await app.request("/api/items?limit=0", { headers: auth });
  expect(bad.status).toBe(400);

  const health = await app.request("/api/health");
  expect(health.status).toBe(200);
  const healthBody = await health.json() as { ok: boolean; schemaVersion: number };
  expect(healthBody.ok).toBe(true);
  expect(healthBody.schemaVersion).toBeGreaterThanOrEqual(2);

  const exported = await app.request("/api/export", { headers: auth });
  expect(exported.status).toBe(200);
  const file = await exported.json() as { items: unknown[] };
  expect(file.items).toHaveLength(25);

  const snap = join(dir, "snap.db");
  const shot = snapshotDatabase(process.env.DOGGY_DB!, snap);
  expect(shot.integrity).toBe("ok");
  expect(shot.counts.items).toBe(25);
  expect(shot.counts.users).toBe(1);
  const again = snapshotDatabase(process.env.DOGGY_DB!, snap);
  expect(again.counts).toEqual(shot.counts);
  expect(readCounts(snap).items).toBe(25);
  expect(shrinkReport(shot.counts, { ...shot.counts, items: 24 })).toEqual(["items 25 -> 24"]);
  expect(shrinkReport(shot.counts, shot.counts)).toEqual([]);
});
