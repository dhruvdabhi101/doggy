import posthog, { type CaptureResult } from "posthog-js/dist/module.slim.no-external";
import { postHogConfig } from "./feature-flags";

const config = postHogConfig(import.meta.env.VITE_POSTHOG_KEY, import.meta.env.VITE_POSTHOG_HOST);
let ready = false;
let userId: string | null = null;
let lastPage = "";

const ROUTES = new Set(["/", "/signin", "/signup", "/privacy", "/retention", "/oauth/authorize", "/app", "/app/ask", "/app/memory", "/app/connect", "/app/devices"]);
export const analyticsPath = (path: string) => ROUTES.has(path) ? path : "/unknown";

// Keep SDK-generated URLs, referrers, person properties and form contents out of every event.
const PROPERTIES = new Set([
  "token", "distinct_id", "$anon_distinct_id", "$device_id", "$user_id", "$is_identified",
  "$session_id", "$window_id", "$lib", "$lib_version", "$browser", "$browser_version",
  "$os", "$os_version", "$device_type", "$viewport_height", "$viewport_width",
  "$pathname", "app_client", "signed_in", "platform",
]);
export function sanitizeEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !["$pageview", "$identify", "app_active", "desktop_download_clicked"].includes(event.event)) return null;
  const properties = Object.fromEntries(Object.entries(event.properties).filter(([key]) => PROPERTIES.has(key)));
  delete properties.$pathname;
  if (typeof event.properties.$pathname === "string") {
    properties.$pathname = analyticsPath(event.properties.$pathname);
  }
  return { uuid: event.uuid, event: event.event, properties, timestamp: event.timestamp };
}

export function initAnalytics(initialUserId: string | null) {
  if (!config || ready) return;
  try {
    posthog.init(config.key, {
      api_host: config.host,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_feature_flags: true,
      advanced_disable_decide: true,
      persistence: "localStorage",
      person_profiles: "identified_only",
      save_referrer: false,
      save_campaign_params: false,
      before_send: sanitizeEvent,
    });
    ready = true;
    const persistedUser = posthog.get_property("$user_id");
    userId = typeof persistedUser === "string" ? persistedUser : null;
    identifyUser(initialUserId);
  } catch { /* Analytics must not prevent the app from loading. */ }
}

export function identifyUser(nextUserId: string | null) {
  if (!ready || userId === nextUserId) return;
  try {
    // Reset before switching accounts so one person's history cannot merge into another's.
    if (userId || !nextUserId) posthog.reset();
    userId = nextUserId;
    lastPage = "";
    if (userId) posthog.identify(userId);
  } catch { /* Analytics must not break sign-in or sign-out. */ }
}

export function trackPage(path: string) {
  if (!ready) return;
  const page = analyticsPath(path);
  const key = `${userId ?? "anonymous"}:${page}`;
  if (key === lastPage) return;
  lastPage = key;
  posthog.capture("$pageview", { $pathname: page, app_client: "web", signed_in: !!userId });
}

export function trackDownload(platform: "mac" | "windows") {
  if (ready) posthog.capture("desktop_download_clicked", { platform, app_client: "web", signed_in: !!userId });
}

export function startActivityTracking() {
  if (!ready || !userId) return () => {};
  let lastActivity = Date.now();
  let lastSent = 0;
  const heartbeat = () => {
    const now = Date.now();
    if (!userId || document.visibilityState !== "visible" || now - lastActivity >= 120_000 || now - lastSent < 30_000) return;
    lastSent = now;
    posthog.capture("app_active", { app_client: "web", signed_in: true, $pathname: analyticsPath(location.pathname) });
  };
  const activity = () => { lastActivity = Date.now(); heartbeat(); };
  const visibility = () => { if (document.visibilityState === "visible") activity(); };
  const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
  for (const event of events) window.addEventListener(event, activity, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  // Defer the first send so React StrictMode's setup/cleanup cycle cannot duplicate it.
  const first = window.setTimeout(heartbeat, 0);
  const interval = window.setInterval(heartbeat, 30_000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(interval);
    for (const event of events) window.removeEventListener(event, activity);
    document.removeEventListener("visibilitychange", visibility);
  };
}
