import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const dir = mkdtempSync(join(tmpdir(), "doggy-analytics-"));
const batches: string[] = [];
const receiver = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body = new Uint8Array(await req.arrayBuffer());
    const decoded = req.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(body) : body;
    batches.push(new TextDecoder().decode(decoded));
    return Response.json({ status: 1 });
  },
});
process.env.POSTHOG_KEY = "phc_local_test";
process.env.POSTHOG_HOST = `http://127.0.0.1:${receiver.port}`;
process.env.NODE_ENV = "development";
process.env.DOGGY_DB = join(dir, "test.db");
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
const { app } = await import("../src/index");
const { analytics } = await import("../src/analytics");
const sessionSchema = z.object({ token: z.string(), user: z.object({ id: z.string() }) });
const eventSchema = z.object({ event: z.string(), properties: z.record(z.string(), z.unknown()), distinct_id: z.string() });
const batchSchema = z.object({ batch: z.array(eventSchema) });
const secret = "private-analytics-sentinel";
try {
  const signup = await app.request("/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${secret}@example.com`, name: secret, password: `${secret}-password`, deviceKind: "web", deviceName: secret }),
  });
  assert.equal(signup.status, 200);
  const session = sessionSchema.parse(await signup.json());
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`);
    return response;
  };
  await request("/api/auth/login", "POST", { email: `${secret}@example.com`, password: `${secret}-password`, deviceKind: "mac-agent" });
  const created = await request("/api/items", "POST", { type: "task", title: secret, details: secret });
  const { item } = z.object({ item: z.object({ id: z.string() }) }).parse(await created.json());
  await request(`/api/items/${item.id}`, "PATCH", { status: "done", title: `${secret}-edited` });
  await request("/api/notes", "POST", { text: `Remember ${secret}`, source: "voice" });
  await request(`/api/search?q=${secret}`);
  await request("/api/ask", "POST", { question: secret });
  const capture = { events: [{ app: secret, window: secret, url: `https://${secret}.example.com`, text: secret }] };
  await request("/api/capture", "POST", capture);
  await request("/api/capture", "POST", capture);
  await request(`/api/sources/${encodeURIComponent(secret)}`, "PUT", { lane: "slow" });
  await request("/api/export");
  await request("/api/devices/mcp-token", "POST", { name: secret });
  const devices = z.object({ devices: z.array(z.object({ id: z.string(), kind: z.string() })) }).parse(await (await request("/api/devices")).json());
  const mcp = devices.devices.find((d) => d.kind === "mcp");
  assert.ok(mcp);
  await request(`/api/devices/${mcp.id}`, "DELETE");
  for (const tool of ["search_memory", "list_open_loops", "remember"]) {
    await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { query: secret, text: `Remember ${secret}` } } });
  }
  const oauthClient = z.object({ client_id: z.string() }).parse(await (await request("/oauth/register", "POST", { client_name: secret, redirect_uris: ["http://localhost:9999/callback"] })).json());
  await request("/oauth/approve", "POST", { client_id: oauthClient.client_id, redirect_uri: "http://localhost:9999/callback", approve: true, code_challenge_method: "S256", code_challenge: "a".repeat(43) });
  const invalid = await app.request(`/api/items/${item.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "bad" }) });
  assert.equal(invalid.status, 400);
  const denied = await app.request("/api/notes", { method: "POST", body: JSON.stringify({ text: secret }) });
  assert.equal(denied.status, 401);
  await request("/api/auth/logout", "POST");
  await analytics?.flush();
  const events = batches.flatMap((batch) => batchSchema.parse(JSON.parse(batch)).batch);
  const byName = (name: string) => events.filter((event) => event.event === name);
  for (const name of ["user_signed_up", "user_logged_in", "user_logged_out", "item_created", "item_updated", "note_saved", "memory_searched", "question_answered", "source_lane_changed", "items_exported", "device_removed", "mcp_token_created", "ai_connection_approved"]) {
    assert.equal(byName(name).length, 1, name);
  }
  assert.equal(byName("capture_batch_received").length, 2);
  assert.deepEqual(byName("capture_batch_received").map((e) => [e.properties.accepted_count, e.properties.deduped_count]), [[1, 0], [0, 1]]);
  assert.equal(byName("mcp_tool_used").length, 3);
  assert.ok(events.every((event) => event.distinct_id === session.user.id));
  assert.equal(byName("user_logged_in")[0]?.properties.device_kind, "mac-agent");
  assert.equal(byName("note_saved")[0]?.properties.source, "voice");
  assert.equal(byName("note_saved")[0]?.properties.extraction_succeeded, true);
  assert.deepEqual(byName("item_updated")[0]?.properties.changed_fields, ["status", "title"]);
  assert.ok(!batches.join("").includes(secret), "private content leaked into analytics");
  assert.ok(!batches.join("").includes(session.token), "sign-in token leaked into analytics");
  const html = await app.request("/");
  if (html.headers.get("content-type")?.startsWith("text/html")) {
    const policy = html.headers.get("content-security-policy");
    assert.ok(policy?.includes(`http://127.0.0.1:${receiver.port}`));
    assert.ok(policy?.includes("script-src 'self'"));
  }
  console.log(`Verified ${events.length} delivered server events, shared identity, metadata-only payloads and CSP.`);
} finally {
  await analytics?.shutdown(1000);
  receiver.stop(true);
  rmSync(dir, { recursive: true, force: true });
}
