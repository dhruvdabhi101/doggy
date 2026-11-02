import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { login, requireAuth, signup, type AuthEnv } from "./auth";
import {
  db, getItem, now, searchCaptures, searchItems, toItem, uid, updateItem, openItems,
  type ItemRow,
} from "./db";
import { answer, hasLLM, MODEL, MODEL_FAST, ITEM_TYPES } from "./llm";
import { processPendingCaptures, processSource } from "./pipeline";
import { handleMcp } from "./mcp";

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
app.post("/api/capture", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { events?: any[] } | null;
  const events = Array.isArray(body?.events) ? body!.events.slice(0, MAX_EVENTS) : [];
  const user = c.get("user"); const device = c.get("device");
  const ins = db.query(
    "INSERT INTO captures (user_id,device_id,app,bundle_id,window,url,text,captured_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  let accepted = 0;
  db.transaction(() => {
    for (const e of events) {
      const text = typeof e?.text === "string" ? e.text.slice(0, 50_000).trim() : "";
      if (!text || typeof e.app !== "string") continue;
      ins.run(user.id, device.id, e.app.slice(0, 200), e.bundleId ?? null, String(e.window ?? "").slice(0, 500),
        e.url ?? null, text, typeof e.capturedAt === "string" ? e.capturedAt : now());
      accepted++;
    }
  })();
  return c.json({ accepted });
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
app.post("/api/items", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as any;
  if (!b.title || !ITEM_TYPES.includes(b.type)) return c.json({ error: "type and title required" }, 400);
  const { insertItem } = await import("./db");
  return c.json({ item: insertItem(c.get("user").id, { ...b, sourceKind: "text", confidence: 1 }) });
});
app.patch("/api/items/:id", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { status?: string; title?: string; dueAt?: string | null };
  if (b.status && !["open", "done", "dismissed"].includes(b.status)) return c.json({ error: "bad status" }, 400);
  const item = updateItem(c.get("user").id, c.req.param("id"), b);
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
