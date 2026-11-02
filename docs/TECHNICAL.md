# Doggy: technical handoff

Read this before changing anything. The status and roadmap live in [PLAN.md](PLAN.md); the wire format is in [API.md](API.md).

## Layout
```
server/            Bun + Hono + bun:sqlite. API, extraction pipeline, MCP, serves web/dist
  src/index.ts     routes; starts the capture worker (every 10s)
  src/db.ts        schema (created on boot), FTS5 tables + triggers, item helpers, search
  src/auth.ts      signup/login, device tokens (sha256 stored), requireAuth middleware
  src/llm.ts       ALL LLM calls: extract() and answer(); rule-based fallback when no key
  src/pipeline.ts  processSource() (shared by notes and captures) + processPendingCaptures() worker
  src/mcp.ts       minimal MCP JSON-RPC server (initialize, tools/list, tools/call)
web/               Vite + React PWA (single page). src/App.tsx = all screens, src/speech.ts = voice
agents/mac/        Swift CLI `doggy-agent` (Accessibility). See its README
agents/windows/    .NET 10 console `doggy-agent.exe` (UI Automation). See its README
docs/              PLAN.md, TECHNICAL.md, API.md
```

## Data flow
```
desktop agent ──POST /api/capture──▶ captures table ──(worker: 45s idle or 12k chars per app+window)──┐
web/phone note ─POST /api/notes────▶ notes table ──(synchronous)─────────────────────────────────────┤
MCP "remember" ─────────────────────▶ notes table ───────────────────────────────────────────────────┤
                                                                                                      ▼
                       processSource(): open items (recent + FTS-related) ─▶ llm.extract() ─▶ items (+ closes)
                                                                                                      │
clients ◀── GET /api/changes?since=seq (incremental) / /api/items / /api/search / POST /api/ask ◀───────┘
```

## Key design points
- **Server is the source of truth.** Every device has its own token (`devices` table); every device of a user reads
  the same rows. Sync is `GET /api/changes?since=<seq>`: each insert or update bumps a global `seq` counter. The web
  app polls every 10s and when the tab becomes visible. Native/offline clients should use the same endpoint.
- **The agents diff, the server groups.** Agents send only new lines per window (hash set per app+window title), so
  captures are small. The server groups pending captures into an episode per (user, device, app, window) and
  extracts once the window has been quiet for `DOGGY_EPISODE_IDLE_MS` (default 45s) or holds over 12k chars.
  Failed extractions stay `processed=0` and are retried on the next tick.
- **One extraction prompt** (`llm.ts`) for screen text, voice, and typed notes, so accuracy is tuned in one place.
  Structured output (`output_config.format` JSON schema) is validated with zod. Each item requires a verbatim
  `evidence` quote. Existing open items are passed in so the model doesn't duplicate them and can return `closes`
  (loop closure). Confidence thresholds are in `pipeline.ts`: capture 0.6, notes 0.2.
- **Models:** captures → `DOGGY_MODEL_FAST` (Haiku 5.5, effort `low`); notes and ask → `DOGGY_MODEL` (Sonnet 5.5).
  Rough cost for one heavy user (~300 episodes/day × ~3k tokens in, ~1.5k out): Haiku ≈ $0.30/day; the same load
  on Opus 5.5 ≈ $12/day. Measure accuracy before moving the capture path to a bigger model.
- **Refusals:** non-Haiku requests use `betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"` (Haiku 5.5
  has no server-side fallback). On `refusal` or
  `max_tokens`, captures are dropped and notes fall back to heuristics.
- **Search:** FTS5 over items (title/details/evidence/people) and captures (app/window/text). `ftsQuery()` turns free
  text into a safe prefix OR-query; never pass raw user input to MATCH.
- **Ask:** FTS hits + (for time/todo questions) open items + capture snippets → `answer()` with numbered citations.
- **MCP:** stateless streamable-HTTP, JSON responses only, Bearer token = a device token. Tools: `search_memory`,
  `list_open_loops`, `remember`.

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Enables Claude extraction; without it, rule-based fallback |
| `DOGGY_MODEL_FAST` | `claude-haiku-5-5` | Screen-capture extraction (high volume) |
| `DOGGY_MODEL` | `claude-sonnet-5-5` | Voice/text note extraction and "ask" (low volume) |
| `DOGGY_DB` | `server/data/doggy.db` | SQLite path |
| `DOGGY_EPISODE_IDLE_MS` | `45000` | Quiet time before a window's capture is extracted |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |

## Capture agents (summary; details in each README)
- **Mac** (`agents/mac`): every 3s reads the focused window of the frontmost app via `AXUIElement`. Sets
  `AXManualAccessibility=true` so Chrome/Electron apps expose text (it deliberately does not set
  `AXEnhancedUserInterface`, which breaks window animations). Limits: 3000 nodes, depth 40, 400ms, 0.5s messaging
  timeout. Skips `AXSecureTextField` and excluded apps (`~/.doggy/agent.json` → `excludeApps`). Pause by creating
  `~/.doggy/paused`. Uploads every 20s. Config is `~/.doggy/agent.json` (chmod 600).
  Not code-signed yet: each rebuild may need Accessibility granted again.
- **Windows** (`agents/windows`): same loop with `System.Windows.Automation` (WPF), CacheRequest +
  ControlViewWalker, skips `IsPassword`. Config `%USERPROFILE%\.doggy\agent.json`. Chromium/Electron apps build
  their UIA tree only once a client asks; some need `--force-renderer-accessibility`. Untested on real Windows.
- Both agents keep the diff state and upload queue **in memory only**. A restart re-sends text that is still on
  screen (the server dedupes items by exact title, and the LLM sees existing items).

## Known gaps and risks
- Raw screen text is stored unencrypted on the server (`captures`). Add retention/encryption before real users.
- No rate limiting, no password reset, no email verification. Device tokens never expire (revoke via Devices tab).
- Dedupe is exact-title plus whatever the LLM catches; near-duplicates can slip through. Embeddings will fix this.
- Times: the LLM resolves relative dates in the user's timezone (`users.tz`, set from the browser at signup/login).
  The heuristic fallback uses server-local time.
- A window title that changes (unread counters) creates new episodes and re-sent text.
- The web app's `/api/changes` loop stops at 1000 rows per call (it loops until fewer are returned).

## Dev loop
```bash
cd server && bun run dev          # watch mode, :8787
cd web && bun run dev             # :5173, proxies /api and /mcp to :8787
cd server && bunx tsc --noEmit    # typecheck
cd web && bun run build           # typecheck + build into web/dist (the server serves it)
```
Smoke test: sign up via curl, `POST /api/notes`, `GET /api/items` (see the API.md examples).

## Reference: what minimi does (from inspecting the installed app, v1.0.92)
- Electron app. **No model names in the client:** all LLM calls go through `backend.projectminimi.com`. Their privacy
  policy names Gemini (embeddings), OpenAI GPT on Azure (action items, decision tracing), and Deepgram (audio).
  The exact model versions can't be seen from the client.
- Local storage: `better-sqlite3-multiple-ciphers` (encrypted SQLite) + `sqlite-vec` + `usearch` (vector search).
- **Per-app extractors** (native binaries in `Contents/Resources/exec`): get-slack-content(-web),
  get-whatsapp-content(-web), get-teams-content(-web), get-gmail-content-web, get-outlook-content-web,
  get-native-outlook-content, get-discord-content(-web), get-linkedin-content-web, get-web-content, plus a generic
  get-ax-text. Also meetings/captureAudio/google-meet-monitor/micwatch-detector for audio.
  **Takeaway:** most of their accuracy likely comes from app-specific parsing (sender, timestamp, thread) rather than
  a big model. Our agents use one generic tree walk; adding per-app parsers for the top apps is on the plan.
