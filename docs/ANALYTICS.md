# Usage analytics

Use the same PostHog project key and ingestion host in `web/.env.local` as `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`, and in `server/.env` as `POSTHOG_KEY` / `POSTHOG_HOST`. Vite needs a rebuild when its variables change. Production server variables live in `/etc/doggy/doggy.env`. Restart the server after editing them. US and EU Cloud ingestion hosts are allowed by the server's content security policy. A custom host must also be configured on the server.

Empty or invalid configuration disables analytics. Server analytics is also disabled when `NODE_ENV=test`. Browser and server SDKs batch delivery; an ad blocker, offline device, failed delivery or ingestion delay can lower counts. No history is backfilled.

## Events

All signed-in events use the internal user ID as `distinct_id`, matching browser, desktop and MCP usage across devices. Anonymous visits have a persistent browser identifier that is linked on sign-in. Sign-out resets that identity, and account switching resets it before identifying the next account. Browser page views deduplicate React StrictMode's effect rerun. Business events come from the server once the operation succeeds, so optimistic UI changes and sync polling do not inflate usage.

| Event | Meaning and properties |
| --- | --- |
| `$pageview` | Initial load or app route change; `$pathname` and `signed_in`. Only known routes, no query or hash. |
| `app_active` | Signed-in app tab is visible and received interaction within two minutes. At most once every 30 seconds per tab. Opening or returning to a visible tab counts as interaction. |
| `desktop_download_clicked` | Download intent, with `platform` of `mac` or `windows`. Does not prove installation. |
| `user_signed_up`, `user_logged_in`, `user_logged_out` | Successful account actions. |
| `note_saved` | Durable note save; `source`, `item_count`, `extraction_succeeded`. A failed extraction still counts as a saved note. |
| `capture_batch_received` | Nonempty desktop capture batch; `accepted_count`, `deduped_count`. This measures background capture, not someone actively using the UI. |
| `item_created` | Explicit API item creation; `item_type`. Extracted items are counted by `note_saved` or MCP events instead. |
| `item_updated` | Successful nonempty patch; field names in `changed_fields`, optional `status`, `item_type`. Values of edited text fields are excluded. |
| `memory_searched` | Successful nonblank search request; `item_count`, `capture_count`. Debounced typing and pagination can cause multiple requests per search. |
| `question_answered` | Ask request completes; `source_count`, `succeeded`. False means Doggy returned its fallback response. |
| `source_lane_changed` | Capture setting updated; `lane`, without the source's name or address. |
| `items_exported`, `device_removed`, `mcp_token_created` | Successful account/device actions. |
| `ai_connection_approved` | Valid OAuth connection approval, without client name or redirect URL. |
| `mcp_tool_used` | Successful known tool call; `tool` and `item_count`. Protocol ping/list requests are excluded. |

Every event includes `app_client` of `web` or `server`. Server events include the authenticated `device_kind` so desktop, web, mobile and MCP traffic can be compared. No event contains user-entered text, app/window titles, page query parameters, account names, email addresses or credentials. The browser SDK has autocapture, session replay, surveys, performance and error capture disabled. Its outgoing properties are allowlisted. Feature-flag evaluation remains separate and anonymous per tab.

## Dashboard

In PostHog, create a dashboard named **Doggy usage**. Create SQL insights for the following queries and save each to that dashboard. Counts begin after deployment and depend on ingestion latency; refresh to update them.

### Users active now

```sql
SELECT count(DISTINCT distinct_id) AS active_users_last_2_minutes
FROM events
WHERE event = 'app_active'
  AND timestamp >= now() - INTERVAL 2 MINUTE
  AND timestamp <= now()
```

Display as a number. Multiple tabs or devices signed into the same account count once. Hidden tabs stop sending immediately; idle tabs stop after two minutes without interaction. A recent heartbeat remains in this rolling count for up to two more minutes, so a user who goes idle can remain counted for almost four minutes since their last interaction. Closing a tab expires within two minutes of its last heartbeat. This is recent activity, not an exact count of live network connections.

### Daily active users

```sql
SELECT toDate(timestamp) AS day, count(DISTINCT distinct_id) AS active_users
FROM events
WHERE event IN ('app_active', 'note_saved', 'item_created', 'item_updated',
                'memory_searched', 'question_answered', 'mcp_tool_used', 'items_exported')
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day
```

Display as a line chart. This excludes anonymous landing visits, auth-only users and automatic desktop capture. Use the same event set in a retention insight to measure users returning to use the product.

### Feature usage

```sql
SELECT event, count() AS uses, count(DISTINCT distinct_id) AS users
FROM events
WHERE event IN ('note_saved', 'memory_searched', 'question_answered',
                'item_updated', 'items_exported', 'mcp_tool_used', 'ai_connection_approved')
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY event
ORDER BY uses DESC
```

Display as a table. Break `note_saved` down by `source` for voice vs text, `item_updated` by `status` for completed/dismissed tasks, and `mcp_tool_used` by `tool` for AI-client adoption.

### Desktop capture usage

```sql
SELECT properties.device_kind AS device_kind,
       count(DISTINCT distinct_id) AS users,
       sum(toInt(properties.accepted_count)) AS accepted_captures,
       sum(toInt(properties.deduped_count)) AS deduped_captures
FROM events
WHERE event = 'capture_batch_received'
  AND timestamp >= now() - INTERVAL 1 DAY
GROUP BY device_kind
```

Display as a table. This counts users uploading screen captures even when their web dashboard is closed. It does not detect agents that are paused or have nothing new to upload.

Also add a trend of unique `user_signed_up` users, and an ordered funnel of `user_signed_up` → `desktop_download_clicked` → `capture_batch_received` to see adoption. Some users download before signing up, so that ordered funnel only measures the signup-first journey.

## Verification and deletion

Run `cd web && bun test && bun run build` and `cd server && POSTHOG_KEY= bun test && bun run typecheck`. The analytics tests use a local ingestion server or a stub SDK, never the production project. To verify a deployment, use PostHog's Activity view while signing in, navigating and saving a disposable note. Check the internal ID matches browser/server events and inspect properties for unexpected content. Wait for batch delivery before checking.

Account deletion is currently manual. Alongside deleting Doggy's database rows, find the PostHog person by internal user ID and delete the person and associated events. Configure event retention in the PostHog project; do not promise a retention period different from that setting.

SDK references: [browser configuration](https://posthog.com/docs/libraries/js/config), [identifying users](https://posthog.com/docs/libraries/js/usage), [server SDK](https://posthog.com/docs/libraries/node).
