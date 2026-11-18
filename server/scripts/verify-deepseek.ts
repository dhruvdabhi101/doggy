import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

assert.ok(process.env.DEEPSEEK_API_KEY?.trim(), "DEEPSEEK_API_KEY is required");
const dir = mkdtempSync(join(tmpdir(), "doggy-deepseek-"));
process.env.DOGGY_DB = join(dir, "test.db");
process.env.NODE_ENV = "test";
const { app } = await import("../src/index");
const { db } = await import("../src/db");
const { processSources } = await import("../src/pipeline");
const itemSchema = z.object({ title: z.string() });
const noteSchema = z.object({ items: z.array(itemSchema), warning: z.string().optional() });

try {
  const signup = await app.request("/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "deepseek-check@doggy.test", name: "Alice", password: crypto.randomUUID(),
      deviceKind: "web", deviceName: "DeepSeek verification", tz: "UTC",
    }),
  });
  assert.equal(signup.status, 200);
  const session = z.object({
    token: z.string(), user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
  }).parse(await signup.json());
  const request = async (path: string, body?: unknown) => {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  };
  for (const [source, text, keyword] of [
    ["text", "Remind me to send the nebula proposal to Bob tomorrow at 3pm.", "nebula"],
    ["voice", "Remind me to renew the telescope subscription tomorrow at 4pm.", "telescope"],
  ] as const) {
    const note = noteSchema.parse(await request("/api/notes", { source, text }));
    assert.equal(note.warning, undefined, `${source} extraction failed`);
    assert.ok(note.items.some((item) => item.title.toLowerCase().includes(keyword)), `${source} extraction missing item`);
    console.log(`PASS ${source} note extraction`);
  }
  const captured = await processSources({ ...session.user, tz: "UTC" }, "capture", [{
    app: "Slack", window: "Bob", sourceId: "verification:capture",
    text: "Bob: Alice, please send me the lighthouse invoice tomorrow at 2pm.\nAlice: Yes, I'll send the lighthouse invoice tomorrow at 2pm.",
  }]);
  assert.ok(captured.flat().some((item) => item.title.toLowerCase().includes("lighthouse")), "capture extraction missing item");
  console.log("PASS screen capture extraction");
  const answer = z.object({ answer: z.string() }).parse(await request("/api/ask", { question: "What do I need to do with the nebula proposal?" }));
  assert.match(answer.answer, /nebula/i);
  assert.match(answer.answer, /send/i);
  console.log("PASS Ask retrieves and answers from saved memory");
  const usage = z.object({ days: z.array(z.object({ kind: z.string(), inputTokens: z.number(), outputTokens: z.number() })) }).parse(await request("/api/usage"));
  for (const kind of ["text", "voice", "capture", "ask"]) {
    assert.ok(usage.days.some((day) => day.kind === kind && day.inputTokens > 0 && day.outputTokens > 0), `${kind} has no billed usage`);
  }
  console.log("PASS billed usage recorded for all four paths; temporary database only");
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
