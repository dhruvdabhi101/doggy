# Doggy: technical handoff

Read this before changing anything. The status and roadmap live in [PLAN.md](PLAN.md); the wire format is in [API.md](API.md).
How screen text becomes items, and every gate that limits model calls, is in [CAPTURE_PIPELINE.md](CAPTURE_PIPELINE.md).

## Layout
```
server/            Bun + Hono + bun:sqlite. API, extraction pipeline, MCP, serves web/dist
  src/index.ts     routes; starts the capture worker (every 10s)
  src/db.ts        schema (created on boot), FTS5 tables + triggers, item helpers, search
  src/auth.ts      signup/login, device tokens (sha256 stored), requireAuth middleware
  src/llm.ts       ALL LLM calls: extract() and answer(); rule-based fallback when no key
  src/pipeline.ts  processSources() (shared by notes and captures) + processPendingCaptures() worker
  src/capture.ts   pure capture rules: line fingerprints, capture status, lane readiness, packing
  src/sources.ts   pure source registry: rule table, classify(), kind default lanes, resolveLane()
  src/lanes.ts     per-user lane overrides and source stats (source_prefs, source_stats)
  src/usage.ts     llm_usage ledger, daily capture caps, /api/usage report
  src/mcp.ts       minimal MCP JSON-RPC server (initialize, tools/list, tools/call)
  scripts/replay.ts  replays a DB copy through the capture gates; prints old vs new calls (no model calls)
web/               Vite + React PWA (single page). src/App.tsx = all screens, src/speech.ts = voice
agents/mac/        Swift CLI `doggy-agent` (Accessibility). See its README
agents/windows/    .NET 10 console `doggy-agent.exe` (UI Automation). See its README
docs/              PLAN.md, TECHNICAL.md, API.md
```

## Data flow
```
desktop agent ──POST /api/capture──▶ seen-line dedupe ──▶ captures ──(worker: lanes, budget, batching)──┐
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
- **The agents diff, the server dedupes and groups.** Agents send only new lines per window title. Titles change, so
  the server fingerprints every line per (user, source) in `seen_lines` and stores only lines it has not seen in
  the last 30 days. The source is a bundle id or URL host, never a window title. The worker groups pending captures
  into episodes per (user, device, source, window). Each source has a lane: chats are fast (45s of quiet), documents
  and unknown apps are slow (oldest capture 60 min old), feeds and our own site are skipped with no call. Ready
  episodes of one user are packed into one call of up to ~24k chars. Capture extraction has a per-user and a global
  daily input-token cap. Failed extractions stay pending and are retried on the next tick. Details and tradeoffs are in
  [CAPTURE_PIPELINE.md](CAPTURE_PIPELINE.md).
- **No keyword gating.** Whether text reaches the model depends on its source and whether it is new, never on its
  words. The model decides what is a task.
- **One extraction prompt** (`llm.ts`) for screen text, voice, and typed notes, so accuracy is tuned in one place.
  Structured output (`output_config.format` JSON schema) is validated with zod. Each item requires a verbatim
  `evidence` quote. Existing open items are passed in so the model doesn't duplicate them and can return `closes`
  (loop closure), plus the 15 most recently done titles so it does not recreate them. Confidence thresholds are in
  `pipeline.ts`: capture 0.6, notes 0.2. Screen items whose title shares 60% of its content words with an open or
  done item are dropped (`nearDuplicate`).
- **Usage ledger.** `extract()` and `answer()` return the response `usage`. The pipeline and the ask route add it to
  `llm_usage` per UTC day, user and kind (`capture`, `voice`, `text`, `ask`). `llm.ts` has no database access.
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
| `DOGGY_EPISODE_IDLE_MS` | `45000` | Fast lane: quiet time before a chat episode is extracted |
| `DOGGY_SLOW_LANE_MS` | `3600000` | Slow lane: age of an episode's oldest capture before it is extracted |
| `DOGGY_USER_DAILY_INPUT_TOKENS` | `300000` | Per-user daily input-token cap on capture extraction (UTC day) |
| `DOGGY_GLOBAL_DAILY_INPUT_TOKENS` | `3000000` | Daily input-token cap on capture extraction across all users |
| `DOGGY_PUBLIC_HOST` | – | Extra host treated as our own site; its captures are skipped |
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
  screen. The server drops lines it already stored for that source, so this costs no model call.

## Known gaps and risks
- Raw screen text is stored unencrypted on the server (`captures`). Add retention/encryption before real users.
- No rate limiting, no password reset, no email verification. Device tokens never expire (revoke via Devices tab).
- Dedupe is exact title or quote, a word-overlap check for screen items, and whatever the LLM catches. Reworded
  duplicates can still slip through. Embeddings will fix this.
- Times: the LLM resolves relative dates in the user's timezone (`users.tz`, set from the browser at signup/login).
  The heuristic fallback uses server-local time.
- A window title that changes (unread counters) still starts a new episode, but its re-sent lines are dropped at
  ingest. A long line seen in one chat is also dropped in another chat of the same app.
- Hitting the daily capture cap is only visible in `GET /api/usage` and the server log. The web app does not show it.
- Slow-lane sources (documents, unknown apps) can take up to an hour to produce items.
- Feeds are skipped by default, so a real request in an X reply or YouTube comment is missed unless the user turns
  that source on.
- The web app's `/api/changes` loop stops at 1000 rows per call (it loops until fewer are returned).

## Dev loop
```bash
cd server && bun run dev          # watch mode, :8787
cd web && bun run dev             # :5173, proxies /api and /mcp to :8787
cd server && bunx tsc --noEmit    # typecheck
cd server && bun run replay <db-copy>   # old vs new model calls on stored captures
cd web && bun run build           # typecheck + build into web/dist (the server serves it)
```
Smoke test: sign up via curl, `POST /api/notes`, `GET /api/items` (see the API.md examples).
Bun loads `server/.env` on its own. To force the heuristic path, set the key to empty (`ANTHROPIC_API_KEY= bun src/index.ts`);
`env -u` is not enough.

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

## Production deployment (doggy.ruv.world)
- **Host:** VPS `187.126.120.197` (Debian 13), **shared with other production apps** (d3crm, hrms, incubyte,
  d3agency). Don't touch their Caddy blocks, pm2, or Postgres.
- **Layout:** repo clone at `/srv/doggy` (owner `doggy`, a system user with no login). Bun at `/opt/bun/bin/bun`.
  Data at `/var/lib/doggy/doggy.db`. Desktop installers at `/var/lib/doggy/downloads/` (`Doggy-mac.dmg`,
  `Doggy-windows.exe`; uploaded by hand, not in git). Secrets in `/etc/doggy/doggy.env` (root:doggy 640).
- **Service:** `systemctl status doggy` (unit from `deploy/doggy.service`, listens on 127.0.0.1:8787, sandboxed).
  Logs: `journalctl -u doggy -f`.
- **Caddy:** `/etc/caddy/doggy.caddy` (from `deploy/doggy.caddy`), imported at the end of `/etc/caddy/Caddyfile`.
  Backup taken as `/etc/caddy/Caddyfile.before-doggy-<timestamp>`. Always run
  `caddy validate --config /etc/caddy/Caddyfile` before `systemctl reload caddy`.
- **DNS:** Cloudflare, `A doggy → 187.126.120.197`, DNS only (grey cloud) so Caddy can get its own certificate.
- **Deploy:** push to `main`, then `ssh root@187.126.120.197 /srv/doggy/deploy/deploy.sh` (git pull, install,
  build web, restart, health check). First-time setup: `deploy/setup-vps.sh` (needs `unzip`).
- **Publish desktop builds:** `scp dist/mac/Doggy-mac.dmg dist/windows/Doggy-windows.exe root@187.126.120.197:/var/lib/doggy/downloads/`
  then `chown doggy:doggy` them. The Devices page shows download buttons for whatever files exist.
