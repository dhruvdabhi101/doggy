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
| GET | `/api/sources` | – | `{sources:[Source]}`, most recently seen first |
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
{ "today": { "day": "2026-11-02", "captureInputTokens": 41200, "capped": null },
  "caps": { "userDailyInputTokens": 300000, "globalDailyInputTokens": 3000000 },
  "days": [ { "day": "2026-11-02", "kind": "capture", "calls": 12, "inputTokens": 41200, "outputTokens": 9100 } ] }
```
`capped` is `"user"`, `"global"` or `null`. While capped, screen captures are skipped until 00:00 UTC. Notes and ask
still work. `kind` is `capture`, `voice`, `text` or `ask`. Without an API key, calls are counted with 0 tokens.

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
| GET | `/api/items?type=&status=&limit=` | newest first |
| PATCH | `/api/items/:id` | `{status?, title?, dueAt?}` |
| GET | `/api/changes?since=<seq>` | `{items:[Item], cursor:<seq>}` incremental sync |
| GET | `/api/search?q=` | `{items:[Item], captures:[{id,app,window,text,capturedAt}]}` |
| POST | `/api/ask` | `{question}` → `{answer, sources:[Item]}` |

## MCP
`POST /mcp` — MCP streamable-HTTP (JSON-RPC) endpoint, Bearer token auth. Tools: `search_memory`,
`list_open_loops`, `remember`.
