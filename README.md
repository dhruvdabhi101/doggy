# Doggy

A personal memory that never lets you miss a commitment. Desktop agents read on-screen text (Mac: Accessibility API,
Windows: UI Automation); voice and text notes come from any device. An LLM pulls out tasks, commitments, events,
decisions, and facts, and every device signed into the same account sees the same open loops.

- **Plan & status:** [docs/PLAN.md](docs/PLAN.md)
- **Technical handoff (architecture, how each part works, gotchas):** [docs/TECHNICAL.md](docs/TECHNICAL.md)
- **API contract:** [docs/API.md](docs/API.md)

## Run it (5 minutes)

```bash
# 1. Server (also serves the web app)
cd server && bun install
export ANTHROPIC_API_KEY=sk-ant-...      # optional; without it a rule-based fallback is used (much lower accuracy)
cd ../web && bun install && bun run build
cd ../server && bun run start            # http://localhost:8787

# 2. Open http://localhost:8787, create an account, speak or type a note.

# 3. Mac capture agent
cd agents/mac && swift build -c release
.build/release/doggy-agent login --server http://localhost:8787 --email you@example.com --password '…'
.build/release/doggy-agent run           # grant Accessibility when prompted

# 4. Windows capture agent (on a Windows machine)
cd agents\windows && dotnet publish -c Release -r win-x64 --self-contained false
doggy-agent.exe login --server http://<server>:8787 --email … --password …
doggy-agent.exe run
```

**Phone:** voice input needs HTTPS. Expose the server with a tunnel (`cloudflared tunnel --url http://localhost:8787`)
or deploy it, open the URL on the phone, sign in with the same account, then use "Add to Home Screen".

**Claude / ChatGPT / Cursor:** add `https://<server>/mcp` as a connector; the app signs you in with OAuth. The dashboard's Connect AI page has one-click installs and a token for clients without OAuth.

## Ask feature flag

Ask is hidden until PostHog evaluates the boolean flag `ask` to true. Missing configuration, a disabled or missing flag, and failed requests keep it hidden. This controls the Ask navigation and page, including direct links. The authenticated server API remains available.

Copy `web/.env.example` to `web/.env.local`. Add the public Project API key from PostHog project settings as `VITE_POSTHOG_KEY`. Set `VITE_POSTHOG_HOST` to your ingestion host. Never put a personal or secret API key in a `VITE_` variable. The example is tracked; `.env.local` is ignored.

Use the boolean `ask` flag in PostHog with client-side evaluation allowed. Leave it disabled or at 0% rollout until Ask is needed. This integration uses an anonymous identifier for each browser tab, so percentage rollouts apply to tabs rather than Doggy accounts. It uses [PostHog's public flag API](https://posthog.com/docs/api/flags) without analytics, event capture, or session recording.

Vite reads these settings at build time. Restart `bun run dev` after editing them locally. For production, copy the values to `/srv/doggy/web/.env.local`, keep that file owned by `doggy`, and run `/srv/doggy/deploy/deploy.sh` to rebuild and restart. Changing the PostHog flag takes effect on the next app load without another build.
