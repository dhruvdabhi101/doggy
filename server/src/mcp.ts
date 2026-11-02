import type { Context } from "hono";
import type { AuthEnv } from "./auth";
import { db, openItems, searchCaptures, searchItems, uid, now, type Item } from "./db";
import { processSource } from "./pipeline";

/**
 * Minimal MCP server (streamable HTTP transport, JSON responses only, stateless).
 * Lets Claude / ChatGPT / any MCP client read and write the user's memory.
 */
const TOOLS = [
  {
    name: "search_memory",
    description: "Search the user's memories, tasks, commitments, decisions and captured screen text.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_open_loops",
    description: "List the user's open tasks, commitments and upcoming events (things they must not forget).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description: "Store a note in the user's memory. Tasks and commitments are extracted automatically.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const fmt = (i: Item) =>
  `- (${i.type}${i.status !== "open" ? `, ${i.status}` : ""}) ${i.title}` +
  `${i.dueAt ? ` — due ${i.dueAt}` : ""}${i.counterparty ? ` — with ${i.counterparty}` : ""}` +
  `${i.sourceApp ? ` [from ${i.sourceApp}]` : ""}${i.evidence ? `\n  "${i.evidence}"` : ""}`;

export async function handleMcp(c: Context<AuthEnv>) {
  const msg = (await c.req.json().catch(() => null)) as any;
  if (!msg || Array.isArray(msg)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  if (msg.id === undefined) return c.body(null, 202); // notification

  const user = c.get("user");
  const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id: msg.id, result });
  const text = (t: string) => ok({ content: [{ type: "text", text: t }] });

  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "doggy-memory", version: "0.1.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === "search_memory") {
        const items = searchItems(user.id, String(args.query ?? ""), 15);
        const caps = searchCaptures(user.id, String(args.query ?? ""), 5);
        return text(
          (items.length ? items.map(fmt).join("\n") : "No matching items.") +
          (caps.length ? "\n\nScreen captures:\n" + caps.map((x) => `- ${x.app} / ${x.window} (${x.capturedAt}): ${x.text}`).join("\n") : ""),
        );
      }
      if (name === "list_open_loops") {
        const items = openItems(user.id, 50);
        return text(items.length ? items.map(fmt).join("\n") : "No open loops.");
      }
      if (name === "remember") {
        const t = String(args.text ?? "").trim();
        if (!t) return text("Nothing to remember.");
        const id = uid();
        db.query("INSERT INTO notes (id,user_id,device_id,text,source,created_at) VALUES (?,?,?,?,?,?)")
          .run(id, user.id, c.get("device").id, t, "text", now());
        const items = await processSource(user, { kind: "text", text: t, sourceId: `note:${id}` });
        return text(`Saved. ${items.length ? "Extracted:\n" + items.map(fmt).join("\n") : ""}`);
      }
      return c.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } });
    }
    default:
      return c.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}
