import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync, statSync } from "node:fs";
import { login, requireAuth, signup, type AuthEnv } from "./auth";
import {
  countCaptureHits, countItemHits, db, getItem, insertItem, listItems, now, schemaVersion, searchCaptures,
  searchItems, toItem, uid, updateItem, openItems,
  type ItemPatch, type ItemRow,
} from "./db";
import { answer, hasLLM, ITEM_TYPES, type AnswerSource } from "./llm";
import { processPendingCaptures, processSources } from "./pipeline";
import { handleMcp } from "./mcp";
import { filterNewLines } from "./capture";
import { classify } from "./sources";
import { listSources, parseLaneBody, setLaneOverride } from "./lanes";
import { recordUsage, usageReport } from "./usage";
import { mountOAuth, resourceMetadataUrl } from "./oauth";
import { rateLimit } from "./ratelimit";
import { issueDevice } from "./auth";

export const app = new Hono<AuthEnv>();
app.use("*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.header("x-frame-options", "DENY");
    c.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  }
});
// Bearer-token API, no cookies, so a permissive CORS policy does not expose anything.
app.use("/api/*", cors());
app.use("/mcp", cors({ origin: "*", exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"] }));
app.use("/oauth/*", cors());
app.use("/.well-known/*", cors());
mountOAuth(app);

app.get("/api/health", (c) => {
  try {
    db.query("SELECT 1 AS n").get();
    return c.json({ ok: true, schemaVersion: schemaVersion() });
  } catch {
    return c.json({ ok: false }, 500);
  }
});

app.use("/api/auth/*", rateLimit("auth", 20, 15 * 60_000));
app.post("/api/auth/signup", async (c) => {
  const r = await signup(await c.req.json().catch(() => ({})));
  return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
});
app.post("/api/auth/login", async (c) => {
  const r = await login(await c.req.json().catch(() => ({})));
  return "error" in r ? c.json({ error: r.error }, r.status) : c.json(r);
});

// ---- desktop app downloads (public: the landing page links them) ----
const DOWNLOADS = process.env.DOGGY_DOWNLOADS ?? `${import.meta.dir}/../data/downloads`;
const DOWNLOAD_FILES = { mac: "Doggy-mac.dmg", windows: "Doggy-windows.exe" } as const;
app.get("/api/downloads", (c) => {
  const out: Record<string, { url: string; builtAt: string }> = {};
  for (const [k, f] of Object.entries(DOWNLOAD_FILES)) {
    const path = `${DOWNLOADS}/${f}`;
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtime;
    // The version in the URL makes every new upload a new URL, so no browser or proxy cache can serve an old build.
    out[k] = { url: `/downloads/${f}?v=${mtime.getTime()}`, builtAt: mtime.toISOString() };
  }
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

app.use("/api/*", requireAuth);
app.use("/mcp", async (c, next) => {
  if (!/^bearer \S/i.test(c.req.header("authorization") ?? "")) {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl(c)}"`);
    return c.json({ error: "Unauthorized" }, 401);
  }
  const denied = await requireAuth(c, next);
  if (denied) denied.headers.set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl(c)}"`);
  return denied;
});

app.get("/api/me", (c) => c.json({ user: c.get("user"), device: c.get("device") }));

app.get("/api/devices", (c) => {
  const devices = db.query(
    "SELECT id, name, kind, last_seen_at AS lastSeenAt, created_at AS createdAt FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC",
  ).all(c.get("user").id);
  return c.json({ devices });
});
app.post("/api/auth/logout", (c) => {
  db.query("DELETE FROM devices WHERE id = ? AND user_id = ?").run(c.get("device").id, c.get("user").id);
  return c.json({ ok: true });
});

/** A token for MCP clients that can't do OAuth. Shown once; only works on /mcp. */
app.post("/api/devices/mcp-token", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "MCP client";
  const { token, device } = issueDevice(c.get("user").id, name, "mcp");
  return c.json({ token, device });
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

app.post("/api/capture", rateLimit("capture", 600, 10 * 60_000, (c) => c.get("device").id), async (c) => {
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

// ---- sources: which apps and sites get a model call, and how soon ----
app.get("/api/sources", (c) => {
  const all = listSources(c.get("user").id);
  if (c.req.query("limit") === undefined && c.req.query("offset") === undefined) {
    return c.json({ sources: all, total: all.length, limit: all.length, offset: 0 });
  }
  const page = pageArgs(c, 10, 100);
  if ("error" in page) return c.json({ error: page.error }, 400);
  return c.json({ sources: all.slice(page.offset, page.offset + page.limit), total: all.length, ...page });
});
app.put("/api/sources/:key", async (c) => {
  const key = c.req.param("key").trim();
  if (!key || key.length > 300) return c.json({ error: "bad source key" }, 400);
  const r = parseLaneBody(await c.req.json().catch(() => null));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const user = c.get("user");
  setLaneOverride(user.id, key, r.lane);
  return c.json({ source: listSources(user.id).find((s) => s.key === key) ?? null });
});

app.get("/api/usage", (c) => c.json(usageReport(c.get("user").id)));

// ---- notes (voice / text) ----
export const MAX_NOTE_CHARS = 20_000;
app.post("/api/notes", rateLimit("notes", 120, 10 * 60_000, (c) => c.get("user").id), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; source?: string };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_NOTE_CHARS) : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  const source = body.source === "voice" ? "voice" : "text";
  const user = c.get("user");
  const id = uid();
  db.query("INSERT INTO notes (id,user_id,device_id,text,source,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, user.id, c.get("device").id, text, source, now());
  try {
    const items = (await processSources(user, source, [{ text, sourceId: `note:${id}` }])).flat();
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

const STATUSES = new Set(["open", "done", "dismissed"]);

function pageArgs(c: { req: { query: (name: string) => string | undefined } }, fallbackLimit: number, maxLimit: number) {
  const raw = (name: string) => c.req.query(name);
  const parse = (v: string | undefined, fallback: number, min: number, max: number) => {
    if (v === undefined || v === "") return fallback;
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n < min || n > max ? null : n;
  };
  const limit = parse(raw("limit"), fallbackLimit, 1, maxLimit);
  const offset = parse(raw("offset"), 0, 0, 1_000_000);
  if (limit === null || offset === null) return { error: "bad page" as const };
  return { limit, offset };
}

// ---- items ----
app.get("/api/items", (c) => {
  const page = pageArgs(c, 200, 500);
  if ("error" in page) return c.json({ error: page.error }, 400);
  const type = c.req.query("type");
  const types = type ? type.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  if (types?.some((t) => !ITEM_TYPES.includes(t as typeof ITEM_TYPES[number]))) return c.json({ error: "bad type" }, 400);
  const status = c.req.query("status");
  const excludeStatus = c.req.query("excludeStatus");
  if (status && !STATUSES.has(status)) return c.json({ error: "bad status" }, 400);
  if (excludeStatus && !STATUSES.has(excludeStatus)) return c.json({ error: "bad status" }, 400);
  const sort = c.req.query("sort") ?? "due";
  if (sort !== "due" && sort !== "created") return c.json({ error: "bad sort" }, 400);
  const { items, total } = listItems(c.get("user").id, {
    types, status, excludeStatus, sort, limit: page.limit, offset: page.offset,
  });
  return c.json({ items, total, limit: page.limit, offset: page.offset });
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
app.get("/api/export", rateLimit("export", 10, 10 * 60_000, (c) => c.get("user").id), (c) => {
  const rows = db.query("SELECT * FROM items WHERE user_id = ? ORDER BY created_at, id").all(c.get("user").id) as ItemRow[];
  const body = JSON.stringify({ exportedAt: now(), items: rows.map(toItem) });
  return c.body(body, 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": 'attachment; filename="doggy-export.json"',
  });
});
app.get("/api/search", (c) => {
  const q = c.req.query("q") ?? "";
  const page = pageArgs(c, 20, 50);
  if ("error" in page) return c.json({ error: page.error }, 400);
  const captureLimit = (() => {
    const v = c.req.query("captureLimit");
    if (v === undefined || v === "") return 8;
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n < 1 || n > 50 ? null : n;
  })();
  const captureOffset = (() => {
    const v = c.req.query("captureOffset");
    if (v === undefined || v === "") return 0;
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n < 0 || n > 1_000_000 ? null : n;
  })();
  if (captureLimit === null || captureOffset === null) return c.json({ error: "bad page" }, 400);
  const type = c.req.query("type");
  if (type && !ITEM_TYPES.includes(type as typeof ITEM_TYPES[number])) return c.json({ error: "bad type" }, 400);
  const u = c.get("user").id;
  return c.json({
    items: searchItems(u, q, page.limit, page.offset, type),
    captures: searchCaptures(u, q, captureLimit, captureOffset),
    itemTotal: countItemHits(u, q, type),
    captureTotal: countCaptureHits(u, q),
    limit: page.limit,
    offset: page.offset,
  });
});
const ORIGIN = { capture: "screen", voice: "user said", text: "user wrote" } as const;
app.post("/api/ask", rateLimit("ask", 60, 10 * 60_000, (c) => c.get("user").id), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 1000) : "";
  if (!question) return c.json({ error: "question is required" }, 400);
  const user = c.get("user");
  const items = searchItems(user.id, question, 15);
  const timeQ = /\b(today|tomorrow|week|due|pending|open|forget|promis|owe|todo|task|focus|next)/i.test(question);
  const extra = timeQ ? openItems(user.id, 25) : [];
  const all = [...new Map([...items, ...extra].map((i) => [i.id, i])).values()].slice(0, 30);
  const caps = searchCaptures(user.id, question, 6);
  // Give the model local times; raw UTC ISO strings get misread as local time.
  const local = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { timeZone: user.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const sources: AnswerSource[] = [
    ...all.map((i) => ({
      attrs: { kind: i.type, status: i.status, origin: ORIGIN[i.sourceKind as keyof typeof ORIGIN], noted: local(i.createdAt), due: i.dueAt && local(i.dueAt), with: i.counterparty, app: i.sourceApp },
      text: `${i.title}${i.details ? `\n${i.details}` : ""}${i.evidence ? `\nQuote: "${i.evidence}"` : ""}`,
    })),
    ...caps.map((x) => ({ attrs: { kind: "seen", origin: "screen", app: x.app, window: x.window, at: local(x.capturedAt) }, text: x.text })),
  ];
  try {
    const r = await answer(question, user.tz, sources);
    recordUsage(user.id, "ask", r.usage);
    return c.json({ answer: r.text, sources: all });
  } catch (e) {
    console.error("[ask] failed:", (e as Error).message);
    return c.json({ answer: "I couldn't answer that right now. Here's what matched.", sources: all });
  }
});

app.post("/mcp", rateLimit("mcp", 300, 10 * 60_000, (c) => c.get("user").id), handleMcp);
app.get("/mcp", (c) => c.body(null, 405));

// ---- web app (built PWA) ----
const WEB_DIST = `${import.meta.dir}/../../web/dist`;
if (existsSync(WEB_DIST)) {
  app.use("/*", serveStatic({ root: WEB_DIST }));
  const indexHtml = Bun.file(`${WEB_DIST}/index.html`);
  app.get("*", (c) => c.req.path.startsWith("/api") ? c.json({ error: "Not found" }, 404) : c.body(indexHtml.stream(), 200, { "content-type": "text/html; charset=utf-8" }));
}

const port = Number(process.env.PORT ?? 8787);
if (import.meta.main) {
  setInterval(() => void processPendingCaptures(), 10_000);
  console.log(`doggy server on http://localhost:${port}${hasLLM ? "" : " (no ANTHROPIC_API_KEY: heuristic extraction)"}`);
}
export default { port, hostname: process.env.HOST ?? "0.0.0.0", fetch: app.fetch };
