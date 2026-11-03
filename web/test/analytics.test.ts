import { afterAll, expect, mock, setSystemTime, test } from "bun:test";
import type { CaptureResult, PostHogConfig } from "posthog-js";

const captured: CaptureResult[] = [];
const identities: string[] = [];
let resets = 0;
let sdkConfig: Partial<PostHogConfig> = {};
let sdkUser: string | null = null;
mock.module("posthog-js/dist/module.slim.no-external", () => ({
  default: {
    init: (_key: string, config: Partial<PostHogConfig>) => { sdkConfig = config; },
    get_property: () => sdkUser,
    identify: (id: string) => { sdkUser = id; identities.push(id); },
    reset: () => { sdkUser = null; resets++; },
    capture: (event: string, properties: Record<string, unknown>) => {
      const result = sdkConfig.before_send;
      if (typeof result !== "function") throw new Error("Missing privacy filter");
      const safe = result({ uuid: crypto.randomUUID(), event, properties: { token: "phc_test", distinct_id: sdkUser ?? "anonymous", ...properties } });
      if (safe) captured.push(safe);
    },
  },
}));
const previousKey = process.env.VITE_POSTHOG_KEY;
process.env.VITE_POSTHOG_KEY = "phc_test";
const { initAnalytics, identifyUser, trackPage, sanitizeEvent, startActivityTracking } = await import("../src/lib/analytics");
afterAll(() => {
  if (previousKey === undefined) delete process.env.VITE_POSTHOG_KEY;
  else process.env.VITE_POSTHOG_KEY = previousKey;
  setSystemTime();
});

test("events keep ingestion identity but discard sensitive SDK and application properties", () => {
  const safe = sanitizeEvent({
    uuid: crypto.randomUUID(), event: "$identify",
    $set: { email: "private@example.com" }, $set_once: { $initial_current_url: "https://doggy.test/?token=secret" },
    properties: {
      token: "phc_test", distinct_id: "user-a", $anon_distinct_id: "anon", $session_id: "session",
      $current_url: "https://doggy.test/oauth/authorize?state=secret", $pathname: "/oauth/authorize",
      $referrer: "https://secret.example.com", $set: { email: "private@example.com" },
      email: "private@example.com", question: "private question", text: "private note",
    },
  });
  expect(safe?.properties).toEqual({ token: "phc_test", distinct_id: "user-a", $anon_distinct_id: "anon", $session_id: "session", $pathname: "/oauth/authorize" });
  expect(safe?.$set).toBeUndefined();
  expect(safe?.$set_once).toBeUndefined();
  expect(sanitizeEvent({ uuid: "id", event: "$autocapture", properties: {} })).toBeNull();
  expect(sanitizeEvent({ uuid: "id", event: "$pageview", properties: { $pathname: "/private/path?token=secret" } })?.properties.$pathname).toBe("/unknown");
});

test("identity resets between accounts and on logout, with one pageview per route transition", () => {
  initAnalytics(null);
  expect(sdkConfig.autocapture).toBe(false);
  expect(sdkConfig.disable_session_recording).toBe(true);
  trackPage("/"); trackPage("/");
  identifyUser("user-a");
  trackPage("/app"); trackPage("/app");
  identifyUser("user-b"); trackPage("/app");
  identifyUser(null); trackPage("/");
  expect(identities).toEqual(["user-a", "user-b"]);
  expect(resets).toBe(2);
  expect(captured.map((e) => [e.event, e.properties.distinct_id])).toEqual([
    ["$pageview", "anonymous"], ["$pageview", "user-a"], ["$pageview", "user-b"], ["$pageview", "anonymous"],
  ]);
});

test("heartbeats stop for hidden, idle and signed-out tabs and cleanup prevents StrictMode duplicates", () => {
  const originals = Object.fromEntries(["window", "document", "location"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    setInterval: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number) => timers.delete(id), clearInterval: (id: number) => timers.delete(id),
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  for (const [key, value] of Object.entries({ window: win, document: doc, location: { pathname: "/app" } })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  let time = 1_800_000_000_000;
  const tick = (ms: number) => { time += ms; setSystemTime(time); for (const fn of timers.values()) fn(); };
  const count = () => captured.filter((e) => e.event === "app_active").length;
  try {
    setSystemTime(time);
    identifyUser("user-a");
    startActivityTracking()();
    expect(timers.size).toBe(0);
    const stop = startActivityTracking();
    tick(0); expect(count()).toBe(1);
    tick(10_000); expect(count()).toBe(1);
    tick(20_000); expect(count()).toBe(2);
    doc.visibilityState = "hidden";
    tick(30_000); expect(count()).toBe(2);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange")); expect(count()).toBe(3);
    tick(120_000); expect(count()).toBe(3);
    win.dispatchEvent(new Event("pointerdown")); expect(count()).toBe(4);
    identifyUser(null);
    tick(30_000); expect(count()).toBe(4);
    stop();
    tick(30_000); win.dispatchEvent(new Event("keydown")); expect(count()).toBe(4);
    startActivityTracking(); expect(timers.size).toBe(0);
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    setSystemTime();
  }
});
