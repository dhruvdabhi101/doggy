import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { login, requireAuth, signup, type AuthEnv } from "./auth";
import {
  db, getItem, insertItem, now, searchCaptures, searchItems, toItem, uid, updateItem, openItems,
  type ItemPatch, type ItemRow,
} from "./db";
import { answer, hasLLM, MODEL, MODEL_FAST, ITEM_TYPES } from "./llm";
import { processPendingCaptures, processSource } from "./pipeline";
import { handleMcp } from "./mcp";
import { filterNewLines } from "./capture";
import { classify } from "./sources";

const app = new Hono<AuthEnv>();
app.use("/api/*", cors());
app.use("/mcp", cors());

app.get("/api/health", (c) => c.json({ ok: true, llm: hasLLM ? `${MODEL_FAST} (capture), ${MODEL} (notes/ask)` : "heuristic (no ANTHROPIC_API_KEY)" }));

app.post("/api/auth/signup", async (c) => {
  const r = await signup(await c.req.json().catch(() => ({})));
  return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
});
app.post("/api/auth/login", async (c) => {
  const r = await login(await c.req.json().catch(() => ({})));
  return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
});

app.use("/api/*", requireAuth);
app.use("/mcp", requireAuth);

app.get("/api/me", (c) => c.json({ user: c.get("user"), device: c.get("device") }));

app.get("/api/devices", (c) => {
  const devices = db.query(
    "SELECT id, name, kind, last_seen_at AS lastSeenAt, created_at AS createdAt FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC",
  ).all(c.get("user").id);
  return c.json({ devices });
});
app.delete("/api/devices/:id", (c) => {
  db.query("DELETE FROM devices WHERE id = ? AND user_id = ?").run(c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});

// ---- capture from desktop agents ----
const MAX_EVENTS = 200;
type CaptureEvent = { app: string; bundleId: string | null; window: string; url: string | null; text: string; capturedAt: string };

function parseCaptureEvent(e: any): CaptureEvent | null {
  const text = typeof e?.text === "string" ? e.text.slice(0, 50_000).trim() : "";
  if (!text || typeof e.app !== "string") return null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
  const at = typeof e.capturedAt === "string" && !Number.isNaN(Date.parse(e.capturedAt)) ? e.capturedAt : now();
  return {
    app: e.app.slice(0, 200), bundleId: str(e.bundleId, 200), window: String(e.window ?? "").slice(0, 500),
    url: str(e.url, 2000), text, capturedAt: at,
  };
}

app.post("/api/capture", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { events?: unknown[] } | null;
  const events = (Array.isArray(body?.events) ? body!.events.slice(0, MAX_EVENTS) : [])
    .map(parseCaptureEvent).filter((e): e is CaptureEvent => !!e);
  const user = c.get("user"); const device = c.get("device");
  const ins = db.query(
    `INSERT INTO captures (user_id,device_id,app,bundle_id,window,url,text,captured_at,source_key,source_kind)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const isSeen = db.query("SELECT 1 FROM seen_lines WHERE user_id = ? AND scope = ? AND hash = ?");
  const remember = db.query("INSERT OR IGNORE INTO seen_lines (user_id, scope, hash, seen_at) VALUES (?,?,?,?)");
  let accepted = 0; let deduped = 0;
  db.transaction(() => {
    const t = now();
    for (const e of events) {
      const source = classify(e);
      const kept = filterNewLines(e.text, (h) => !!isSeen.get(user.id, source.key, h));
      if (!kept.newHashes.length) { deduped++; continue; }
      for (const h of kept.newHashes) remember.run(user.id, source.key, h, t);
      ins.run(user.id, device.id, e.app, e.bundleId, e.window, e.url, kept.lines.join("\n"), e.capturedAt, source.key, source.kind);
      accepted++;
    }
  })();
  return c.json({ accepted, deduped });
});

// ---- notes (voice / text) ----
app.post("/api/notes", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; source?: string };
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text is required" }, 400);
  const source = body.source === "voice" ? "voice" : "text";
  const user = c.get("user");
  const id = uid();
  db.query("INSERT INTO notes (id,user_id,device_id,text,source,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, user.id, c.get("device").id, text, source, now());
  try {
    const items = await processSource(user, { kind: source, text, sourceId: `note:${id}` });
    return c.json({ note: { id }, items });
  } catch (e) {
    console.error("[notes] extraction failed:", (e as Error).message);
    return c.json({ note: { id }, items: [], warning: "Saved, but extraction failed. It will not be retried yet." });
  }
});
app.get("/api/notes/:id", (c) => {
  const n = db.query("SELECT id, text, source, created_at AS createdAt FROM notes WHERE id = ? AND user_id = ?")
    .get(c.req.param("id"), c.get("user").id);
  return n ? c.json({ note: n }) : c.json({ error: "Not found" }, 404);
});
app.get("/api/captures/:id", (c) => {
  const r = db.query("SELECT id, app, window, url, text, captured_at AS capturedAt FROM captures WHERE id = ? AND user_id = ?")
    .get(Number(c.req.param("id")), c.get("user").id);
  return r ? c.json({ capture: r }) : c.json({ error: "Not found" }, 404);
});

// ---- items ----
app.get("/api/items", (c) => {
  const { type, status } = c.req.query();
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);
  const where = ["user_id = ?"]; const args: any[] = [c.get("user").id];
  if (type) { where.push(`type IN (${type.split(",").map(() => "?").join(",")})`); args.push(...type.split(",")); }
  if (status) { where.push("status = ?"); args.push(status); }
  const rows = db.query(
    `SELECT * FROM items WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT ?`,
  ).all(...args, limit) as ItemRow[];
  return c.json({ items: rows.map(toItem) });
});
/** Validate user-editable item fields. Returns the clean patch or an error message. */
function parseItemFields(b: any): { patch: ItemPatch } | { error: string } {
  const patch: ItemPatch = {};
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  const nullableStr = (v: unknown, max: number) => (v === null ? null : str(v, max) || null);
  if (b.status !== undefined) {
    if (!["open", "done", "dismissed"].includes(b.status)) return { error: "bad status" };
    patch.status = b.status;
  }
  if (b.type !== undefined) {
    if (!ITEM_TYPES.includes(b.type)) return { error: "bad type" };
    patch.type = b.type;
  }
  if (b.title !== undefined) {
    const t = str(b.title, 300);
    if (!t) return { error: "title can't be empty" };
    patch.title = t;
  }
  if (b.dueAt !== undefined) {
    if (b.dueAt === null || b.dueAt === "") patch.dueAt = null;
    else {
      const d = new Date(b.dueAt);
      if (Number.isNaN(d.getTime())) return { error: "bad dueAt" };
      patch.dueAt = d.toISOString();
    }
  }
  if (b.details !== undefined) patch.details = nullableStr(b.details, 5000);
  if (b.owner !== undefined) patch.owner = nullableStr(b.owner, 200);
  if (b.counterparty !== undefined) patch.counterparty = nullableStr(b.counterparty, 200);
  return { patch };
}

app.post("/api/items", async (c) => {
  const r = parseItemFields(await c.req.json().catch(() => ({})));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const p = r.patch;
  if (!p.title || !p.type) return c.json({ error: "type and title required" }, 400);
  return c.json({
    item: insertItem(c.get("user").id, {
      type: p.type, title: p.title, details: p.details, owner: p.owner ?? "me", counterparty: p.counterparty,
      dueAt: p.dueAt, sourceKind: "text", confidence: 1,
    }),
  });
});
app.patch("/api/items/:id", async (c) => {
  const r = parseItemFields(await c.req.json().catch(() => ({})));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const item = updateItem(c.get("user").id, c.req.param("id"), r.patch);
  return item ? c.json({ item }) : c.json({ error: "Not found" }, 404);
});
app.get("/api/items/:id", (c) => {
  const item = getItem(c.get("user").id, c.req.param("id"));
  return item ? c.json({ item }) : c.json({ error: "Not found" }, 404);
});
app.get("/api/changes", (c) => {
  const since = Number(c.req.query("since") ?? 0) || 0;
  const rows = db.query("SELECT * FROM items WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 1000")
    .all(c.get("user").id, since) as ItemRow[];
  return c.json({ items: rows.map(toItem), cursor: rows.at(-1)?.seq ?? since });
});

// ---- search / ask ----
app.get("/api/search", (c) => {
  const q = c.req.query("q") ?? "";
  const u = c.get("user").id;
  return c.json({ items: searchItems(u, q, 30), captures: searchCaptures(u, q, 15) });
});
app.post("/api/ask", async (c) => {
  const { question } = (await c.req.json().catch(() => ({}))) as { question?: string };
  if (!question?.trim()) return c.json({ error: "question is required" }, 400);
  const user = c.get("user");
  const items = searchItems(user.id, question, 15);
  const timeQ = /\b(today|tomorrow|week|due|pending|open|forget|promis|owe|todo|task|focus|next)/i.test(question);
  const extra = timeQ ? openItems(user.id, 25) : [];
  const all = [...new Map([...items, ...extra].map((i) => [i.id, i])).values()].slice(0, 30);
  const caps = searchCaptures(user.id, question, 6);
  // Give the model local times; raw UTC ISO strings get misread as local time.
  const local = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { timeZone: user.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const sources = [
    ...all.map((i) => ({
      label: `${i.type} (${i.status}) created ${local(i.createdAt)}${i.dueAt ? `, due ${local(i.dueAt)}` : ""}${i.sourceApp ? `, from ${i.sourceApp}` : ""}`,
      text: `${i.title}${i.details ? ` — ${i.details}` : ""}${i.counterparty ? ` (with ${i.counterparty})` : ""}${i.evidence ? `\nQuote: "${i.evidence}"` : ""}`,
    })),
    ...caps.map((x) => ({ label: `screen text from ${x.app} / ${x.window} at ${local(x.capturedAt)}`, text: x.text })),
  ];
  try {
    return c.json({ answer: await answer(question, user.tz, sources), sources: all });
  } catch (e) {
    console.error("[ask] failed:", (e as Error).message);
    return c.json({ answer: "Answering failed; showing matches instead.", sources: all });
  }
});

app.post("/mcp", handleMcp);
app.get("/mcp", (c) => c.body(null, 405));

// ---- desktop app downloads (files are uploaded to DOGGY_DOWNLOADS on the server, not kept in git) ----
const DOWNLOADS = process.env.DOGGY_DOWNLOADS ?? `${import.meta.dir}/../data/downloads`;
const DOWNLOAD_FILES = { mac: "Doggy-mac.dmg", windows: "Doggy-windows.exe" } as const;
app.get("/api/downloads", (c) => {
  const out: Record<string, string> = {};
  for (const [k, f] of Object.entries(DOWNLOAD_FILES)) if (existsSync(`${DOWNLOADS}/${f}`)) out[k] = f;
  return c.json(out);
});
app.get("/downloads/:file", (c) => {
  const f = c.req.param("file");
  if (!Object.values(DOWNLOAD_FILES).includes(f as any) || !existsSync(`${DOWNLOADS}/${f}`)) return c.json({ error: "Not found" }, 404);
  return c.body(Bun.file(`${DOWNLOADS}/${f}`).stream(), 200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${f}"`,
    "cache-control": "no-cache",
  });
});

// ---- web app (built PWA) ----
const WEB_DIST = `${import.meta.dir}/../../web/dist`;
if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST }));
  const indexHtml = Bun.file(`${WEB_DIST}/index.html`);
  app.get("*", (c) => c.req.path.startsWith("/api") ? c.json({ error: "Not found" }, 404) : c.body(indexHtml.stream(), 200, { "content-type": "text/html; charset=utf-8" }));
}

setInterval(() => void processPendingCaptures(), 10_000);

const port = Number(process.env.PORT ?? 8787);
console.log(`doggy server on http://localhost:${port}  (llm: ${hasLLM ? `${MODEL_FAST} capture / ${MODEL} notes+ask` : "heuristic fallback"})`);
export default { port, hostname: process.env.HOST ?? "0.0.0.0", fetch: app.fetch };
