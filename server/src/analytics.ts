import { PostHog } from "posthog-node";

const key = process.env.NODE_ENV === "test" ? undefined : process.env.POSTHOG_KEY?.trim();
const host = process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
function ingestionOrigin() {
  try {
    const url = new URL(host);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
export const postHogOrigin = ingestionOrigin();
export const analytics = key && postHogOrigin ? new PostHog(key, {
  host, flushInterval: 5000, maxQueueSize: 1000, requestTimeout: 5000,
  disableGeoip: true, enableExceptionAutocapture: false,
}) : null;
analytics?.on("error", () => console.warn("[analytics] PostHog delivery failed"));

type Event =
  | { event: "user_signed_up" | "user_logged_in" | "user_logged_out" | "items_exported" | "device_removed" | "mcp_token_created"; properties?: never }
  | { event: "note_saved"; properties: { source: "voice" | "text"; item_count: number; extraction_succeeded: boolean } }
  | { event: "capture_batch_received"; properties: { accepted_count: number; deduped_count: number } }
  | { event: "item_created"; properties: { item_type: string } }
  | { event: "item_updated"; properties: { changed_fields: string[]; status?: string; item_type: string } }
  | { event: "memory_searched"; properties: { item_count: number; capture_count: number } }
  | { event: "question_answered"; properties: { source_count: number; succeeded: boolean } }
  | { event: "source_lane_changed"; properties: { lane: "fast" | "slow" | "skip" | null } }
  | { event: "mcp_tool_used"; properties: { tool: "search_memory" | "list_open_loops" | "remember"; item_count: number } }
  | { event: "ai_connection_approved"; properties?: never };

export function track(userId: string, deviceKind: string, { event, properties }: Event) {
  try {
    analytics?.capture({
      distinctId: userId, event,
      properties: { ...properties, app_client: "server", device_kind: deviceKind, $process_person_profile: true },
    });
  } catch { /* Usage tracking must not fail an application request. */ }
}
