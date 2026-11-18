import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { Item } from "./db";
import type { Extraction } from "./llm";

test("DeepSeek Flash handles every LLM path and filters secrets, including shortened metadata", async () => {
  const requests: string[] = [];
  const payload = z.object({
    model: z.literal("deepseek-flash"),
    thinking: z.object({ type: z.literal("disabled") }),
    messages: z.array(z.object({ content: z.string() })),
    tools: z.array(z.object({ name: z.literal("extract_memory"), input_schema: z.object({ type: z.literal("object") }) })).optional(),
    tool_choice: z.object({ type: z.literal("tool"), name: z.literal("extract_memory") }).optional(),
  });
  const fakeFetch: typeof globalThis.fetch = Object.assign(async (
    input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    expect(String(input)).toBe("https://api.deepseek.com/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-test-key");
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    const body = payload.parse(JSON.parse(init.body));
    expect(init.body).not.toContain("fallbacks");
    expect(init.body).not.toContain("output_config");
    requests.push(body.messages.map((m) => m.content).join("\n"));
    if (requests.length <= 3) {
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice?.name).toBe("extract_memory");
    } else {
      expect(body.tools).toBeUndefined();
    }
    return Response.json({
      id: "msg_test", type: "message", role: "assistant", model: "deepseek-flash",
      stop_reason: body.tools ? "tool_use" : "end_turn",
      content: body.tools
        ? [{ type: "tool_use", id: "tool_test", name: "extract_memory", input: { items: [], closes: [] } }]
        : [{ type: "text", text: "Alice will call tomorrow." }],
      usage: { input_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 1 },
    });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  const previousEnv = { ...process.env };
  process.env.DEEPSEEK_API_KEY = "synthetic-test-key";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.ANTHROPIC_AUTH_TOKEN = "legacy-token-must-not-be-sent";
  process.env.ANTHROPIC_BASE_URL = "https://legacy.invalid";
  process.env.DOGGY_MODEL = "claude-sonnet-5-5";
  process.env.DOGGY_MODEL_FAST = "claude-haiku-5-5";
  try {
    // An isolated module instance also exercises this path when other tests use the no-key fallback.
    const modulePath = "./llm.ts?redaction-test";
    const llm: typeof import("./llm") = await import(modulePath);
    const secret = `ghp_${"x".repeat(36)}`;
    const metadata = `${"m".repeat(292)} ${secret}`;
    const item: Item = {
      id: "item-1", type: "task", title: `Rotate ${secret}`, details: null, owner: "me", counterparty: null,
      dueAt: null, status: "open", evidence: null, sourceKind: "text", sourceApp: null, sourceWindow: null,
      sourceId: null, confidence: 1, createdAt: "2026-11-03", updatedAt: "2026-11-03", seq: 1,
    };
    for (const kind of ["capture", "text", "voice"] as const) {
      const extracted = await llm.extract({
        kind, userName: "Alice", userEmail: "alice@example.com", tz: "UTC",
        sources: [{ app: metadata, window: metadata, url: `https://example.com/?token=opaque-secret`, text: `password: hunter2\nCall Alice ${secret}` }],
        existing: [item], recentlyDone: [{ ...item, title: "SSN 123-45-6789" }],
      });
      expect(extracted.result).toEqual({ items: [], closes: [] });
      expect(extracted.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
    }
    const answered = await llm.answer(`What about ${secret} and password=hunter2?`, "UTC", [{
      attrs: { app: `${"m".repeat(192)} ${secret}`, window: metadata },
      text: "Call Alice <alice@example.com>. Card: 4111 1111 1111 1111",
    }]);
    expect(answered.text).toBe("Alice will call tomorrow.");
    expect(answered.usage).toEqual({ inputTokens: 5, outputTokens: 1 });
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request).toContain("Alice");
      expect(request).toContain("alice@example.com");
      expect(request).toContain("[REDACTED]");
      for (const sensitive of [secret, "ghp_", "hunter2", "opaque-secret", "123-45-6789", "4111 1111 1111 1111"]) {
        expect(request).not.toContain(sensitive);
      }
    }
  } finally {
    fetch.mockRestore();
    for (const key of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "DOGGY_MODEL", "DOGGY_MODEL_FAST"]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("DeepSeek extraction validates tool inputs and empty answers remain failures", async () => {
  let content: unknown[] = [];
  const fakeFetch: typeof globalThis.fetch = Object.assign(async () => Response.json({
    id: "msg_test", type: "message", role: "assistant", model: "deepseek-flash", stop_reason: "tool_use",
    content, usage: { input_tokens: 1, output_tokens: 1 },
  }), { preconnect: globalThis.fetch.preconnect });
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "synthetic-test-key";
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  try {
    const modulePath = "./llm.ts?validation-test";
    const llm: typeof import("./llm") = await import(modulePath);
    const input: Parameters<typeof llm.extract>[0] = {
      kind: "capture", userEmail: "alice@example.com", tz: "UTC", existing: [], recentlyDone: [],
      sources: [{ app: "Slack", window: null, url: null, text: "Alice, please send the proposal tomorrow." }],
    };
    await expect(llm.extract(input)).rejects.toThrow("invalid extraction payload");
    content = [{ type: "tool_use", id: "tool_test", name: "extract_memory", input: { items: "invalid", closes: [] } }];
    await expect(llm.extract(input)).rejects.toThrow("invalid extraction payload");
    const item: Extraction["items"][number] = {
      type: "task", title: "Send the proposal", details: null, owner: "me", counterparty: null,
      due_at: null, evidence: "Alice, please send the proposal tomorrow.", confidence: 0.9, source: 0,
    };
    content = [{
      type: "tool_use", id: "tool_test", name: "extract_memory",
      input: { items: [item, { ...item, source: 8 }], closes: [{ item_id: "unknown", evidence: "done" }] },
    }];
    const extracted = await llm.extract(input);
    expect(extracted.result).toEqual({ items: [item], closes: [] });
    content = [{ type: "text", text: "  " }];
    await expect(llm.answer("What is due?", "UTC", [])).rejects.toThrow("empty answer");
  } finally {
    fetch.mockRestore();
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});
