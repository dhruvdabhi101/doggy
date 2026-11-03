import { expect, test } from "bun:test";
import { askFlagEnabled, loadAskFlag, postHogConfig } from "../src/lib/feature-flags";

test("missing configuration leaves Ask off", () => {
  expect(postHogConfig()).toBeNull();
  expect(postHogConfig(" ")).toBeNull();
  expect(postHogConfig("phc_public")).toEqual({ key: "phc_public", host: "https://us.i.posthog.com" });
  expect(postHogConfig(" phc_public ", "https://eu.i.posthog.com/")).toEqual({ key: "phc_public", host: "https://eu.i.posthog.com" });
  expect(postHogConfig("phc_public", "http://localhost:9009")).toEqual({ key: "phc_public", host: "http://localhost:9009" });
});

test.each([
  "invalid", "http://example.com", "ftp://example.com", "https://user:password@example.com",
  "https://example.com/?secret=value", "https://example.com/#fragment",
])("invalid PostHog host leaves Ask off: %s", (host) => {
  expect(postHogConfig("phc_public", host)).toBeNull();
});

test.each([
  null, [], {}, { flags: null }, { flags: {} }, { flags: { ask: false } },
  { flags: { ask: { enabled: false } } }, { flags: { ask: { enabled: "true" } } },
  { flags: { ask: { enabled: 1 } } },
  { flags: { ask: { enabled: true } }, errorsWhileComputingFlags: true },
  { flags: { ask: { enabled: true } }, quotaLimited: ["feature_flags"] },
].map((response) => ({ response })))("only a successfully enabled Ask flag shows Ask: %j", ({ response }) => {
  expect(askFlagEnabled(response)).toBe(false);
});

test("a boolean Ask flag is enabled from the current PostHog response", () => {
  expect(askFlagEnabled({ flags: { ask: { key: "ask", enabled: true } }, errorsWhileComputingFlags: false })).toBe(true);
});

test("flag evaluation sends only a public project key and anonymous ID", async () => {
  let requestBody: unknown;
  let requestPath = "";
  let authorization: string | null = null;
  let cookie: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requestPath = new URL(request.url).pathname + new URL(request.url).search;
      authorization = request.headers.get("authorization");
      cookie = request.headers.get("cookie");
      requestBody = await request.json();
      return Response.json({ flags: { ask: { enabled: true } }, errorsWhileComputingFlags: false });
    },
  });
  try {
    const enabled = await loadAskFlag({ key: "phc_public", host: `http://127.0.0.1:${server.port}` }, "anonymous-tab", new AbortController().signal);
    expect(enabled).toBe(true);
    expect(requestPath).toBe("/flags?v=2");
    expect(requestBody).toEqual({ api_key: "phc_public", distinct_id: "anonymous-tab" });
    expect(authorization).toBeNull();
    expect(cookie).toBeNull();
  } finally { server.stop(true); }
});

test.each(["http error", "invalid json", "aborted"])("flag failure keeps Ask off: %s", async (failure) => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => failure === "http error" ? new Response("unavailable", { status: 503 }) : new Response("not json"),
  });
  const controller = new AbortController();
  if (failure === "aborted") controller.abort();
  try {
    expect(await loadAskFlag({ key: "phc_public", host: `http://127.0.0.1:${server.port}` }, "anonymous-tab", controller.signal)).toBe(false);
  } finally { server.stop(true); }
});
