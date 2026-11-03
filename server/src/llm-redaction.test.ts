import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { Item } from "./db";

test("actual SDK request bodies filter extraction and answers, including shortened metadata", async () => {
  const requests: string[] = [];
  const payload = z.object({ messages: z.array(z.object({ content: z.string() })) });
  const fakeFetch: typeof globalThis.fetch = Object.assign(async (
    _input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    requests.push(payload.parse(JSON.parse(init.body)).messages.map((m) => m.content).join("\n"));
    return Response.json({
      id: "msg_test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn",
      content: [{ type: "text", text: '{"items":[],"closes":[]}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
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
      await llm.extract({
        kind, userName: "Alice", userEmail: "alice@example.com", tz: "UTC",
        sources: [{ app: metadata, window: metadata, url: `https://example.com/?token=opaque-secret`, text: `password: hunter2\nCall Alice ${secret}` }],
        existing: [item], recentlyDone: [{ ...item, title: "SSN 123-45-6789" }],
      });
    }
    await llm.answer(`What about ${secret} and password=hunter2?`, "UTC", [{
      attrs: { app: `${"m".repeat(192)} ${secret}`, window: metadata },
      text: "Call Alice <alice@example.com>. Card: 4111 1111 1111 1111",
    }]);
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
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});
