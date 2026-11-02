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
Response: `{accepted: <n>}`. Agents batch events and POST every ~20s. Max 200 events / 500 KB per request.
Server groups capture text into episodes per (device, app, window) and runs extraction in the background.

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
