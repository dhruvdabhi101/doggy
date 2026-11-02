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
