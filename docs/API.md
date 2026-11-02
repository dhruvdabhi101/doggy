# Doggy API contract (v0, MVP)

Base URL: `http://localhost:8787` (configurable). All bodies are JSON. All `/api/*` routes except auth require
`Authorization: Bearer <token>`. A token belongs to exactly one **device** of one **user**; every device signed
into the same account sees the same data (server is the source of truth in the MVP).

## Auth / devices
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/signup` | `{email, password, deviceName, deviceKind}` | `{token, user:{id,email}, device:{id,name,kind}}` |
| POST | `/api/auth/login` | same as signup | same as signup |
| GET | `/api/me` | – | `{user, device}` |
| GET | `/api/devices` | – | `{devices:[{id,name,kind,lastSeenAt,createdAt}]}` |

`deviceKind` ∈ `web | mac-agent | windows-agent | ios | android`.

## Capture (desktop agents)
`POST /api/capture`
```json
{ "events": [ {
    "app": "Slack",                 // app display name
    "bundleId": "com.tinyspeck.slackmacgap", // mac bundle id or windows exe name (optional)
    "window": "#eng - Acme",        // window title
    "url": null,                    // browser URL if known
    "text": "new lines only...",    // ONLY lines not already sent for this window (agent-side diff)
    "capturedAt": "2026-11-02T10:00:00Z"
} ] }
```
Response: `{accepted: <n>, deduped: <n>}`. Agents batch events and POST every ~20s. Max 200 events / 500 KB per
request. The server drops lines it already stored for the same source (app bundle id, or URL host plus a known path
such as `x.com/messages`) in the last 30 days, and stores only the new lines. `deduped` counts events with no new
line, which are not stored. The server groups captures into episodes per (device, source, window) and extracts them
in the background by lane. See [CAPTURE_PIPELINE.md](CAPTURE_PIPELINE.md).

## Sources
Which apps and sites Doggy reads, and how soon. A source appears after the worker first sees it.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/sources?limit=&offset=` | – | `{sources, total, limit, offset}`. Omit `limit` and `offset` to get every source. |
| PUT | `/api/sources/:key` | `{lane: "fast"\|"slow"\|"skip"\|null}` | `{source: Source\|null}`. `null` clears the override. Other values → 400 |

```ts
type Lane = "fast" | "slow" | "skip";
type Source = {
  key: string;                // "web.whatsapp.com", "x.com/messages", "com.tinyspeck.slackmacgap"
  kind: "conversation" | "document" | "feed" | "own" | "unknown";
  defaultLane: Lane;          // from the kind
  lane: Lane;                 // what the worker uses now
  laneWhy: "override" | "adaptive" | "default";
  override: Lane | null;      // the user's choice, if any
  episodes: number;           // episodes extracted so far
  itemsKept: number;          // items created from them
  lastSeenAt: string | null;
}
```
URL-encode the key in the path (`/api/sources/x.com%2Fmessages`).

## Usage
`GET /api/usage` → model usage for this user, today (UTC) and the last 7 days.
```json
{ "today": { "day": "2026-11-02", "captureInputTokens": 41200 },
  "days": [ { "day": "2026-11-02", "kind": "capture", "calls": 12, "inputTokens": 41200, "outputTokens": 9100 } ] }
```
Usage is recorded, never capped. `kind` is `capture`, `voice`, `text` or `ask`. Without an API key, calls are counted with 0 tokens.

## Notes (voice / text from any client)
`POST /api/notes` `{text, source: "voice"|"text"}` → `{note:{id}, items:[Item]}` (extraction is synchronous here).

## Items (memories, tasks, commitments, decisions, events)
```ts
type Item = {
  id: string; type: "task"|"commitment"|"memory"|"decision"|"event";
  title: string; details: string|null;
  owner: string|null;        // "me" or a person's name
  counterparty: string|null; // who it was promised to / requested by
  dueAt: string|null;        // ISO
  status: "open"|"done"|"dismissed";
  evidence: string|null;     // verbatim quote from the source
  sourceKind: "capture"|"voice"|"text";
  sourceApp: string|null; sourceWindow: string|null; sourceId: string|null;
  confidence: number;        // 0..1
  createdAt: string; updatedAt: string; seq: number;
}
```
| Method | Path | Notes |
|---|---|---|
| GET | `/api/items?type=&status=&excludeStatus=&sort=due\|created&limit=&offset=` | `{items, total, limit, offset}`. `sort` defaults to `due` (null due dates last). `limit` defaults to 200, max 500. `offset` defaults to 0. |
| GET | `/api/export` | attachment `doggy-export.json` of this user's items. 10 requests per 10 minutes. |
| PATCH | `/api/items/:id` | `{status?, title?, dueAt?, type?, details?, owner?, counterparty?}` |
| GET | `/api/changes?since=<seq>` | `{items:[Item], cursor:<seq>}`. Up to 1000 rows with `seq` greater than `since`. |
| GET | `/api/search?q=&type=&limit=&offset=&captureLimit=&captureOffset=` | `{items, captures, itemTotal, captureTotal, limit, offset}`. Item `limit` defaults to 20, max 50. Capture `captureLimit` defaults to 8, max 50. |
| POST | `/api/ask` | `{question}` → `{answer, sources:[Item]}` |

## MCP
`POST /mcp` — MCP streamable-HTTP (JSON-RPC) endpoint, Bearer token auth. Tools: `search_memory`,
`list_open_loops`, `remember`. An unauthenticated call returns 401 with
`WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`, so clients
that speak MCP OAuth (Claude, ChatGPT, Cursor, VS Code, Claude Code) connect from the URL alone.

OAuth 2.1 (authorization code + PKCE S256, public clients only):
- `GET /.well-known/oauth-protected-resource[/mcp]`, `GET /.well-known/oauth-authorization-server` — discovery.
- `POST /oauth/register` — dynamic client registration (RFC 7591). Redirects must be https, loopback http, or an app scheme.
- `GET /oauth/authorize` — web page: sign in, then Allow / Cancel.
- `GET /oauth/client?client_id&redirect_uri` — public; name of a registered client (used by the consent page).
- `POST /oauth/approve` — signed-in user's decision; returns `{ redirect }`.
- `POST /oauth/token` — `grant_type=authorization_code`. The access token is a device token of kind `mcp`.

`POST /api/auth/logout` — revokes the calling device's token.

Rate limits (429 with `Retry-After`): `/api/auth/*` 20 per 15 min per IP; `/oauth/register` 20/h and `/oauth/token` 60/10 min per IP;
`/api/ask` 60, `/api/notes` 120, `/mcp` 300 per 10 min per user; `/api/capture` 600 per 10 min per device. Notes and MCP `remember`
text is truncated to 20,000 characters. The client IP comes from the last `X-Forwarded-For` entry, and only when the peer is loopback (Caddy).

`POST /api/devices/mcp-token` `{ name }` → `{ token, device }` — a token for clients without OAuth.
Tokens of kind `mcp` are accepted only on `/mcp`; they get 403 on `/api/*`.
