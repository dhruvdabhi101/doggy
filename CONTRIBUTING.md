# Contributing

Thanks for looking at Doggy. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first. Security issues go through [SECURITY.md](SECURITY.md), not a public issue.

By submitting a change you agree it is licensed under AGPL-3.0-only, the same license as the rest of the repository. Copyright (C) 2026 Dhruv Dabhi.

## What you need

- [Bun](https://bun.sh) for the server and the web app.
- macOS 13 or newer and the Swift 6 toolchain, only if you build the Mac agent. Command Line Tools are enough. Xcode is not required.
- The .NET 10 SDK, only if you build the Windows agent. It can compile on macOS or Linux (`EnableWindowsTargeting`) and runs on Windows.

There is no separate lint script. Typecheck is the static check.

## Server

```bash
cd server
bun install
cp .env.example .env
bun run dev          # http://localhost:8787
bun test             # bun test src
bun run typecheck    # tsc --noEmit
```

`bun test` uses a temporary database. It does not call Anthropic. `bun run replay` replays stored captures through the capture gates and does not call a model. See [docs/TECHNICAL.md](docs/TECHNICAL.md) for the layout.

## Web

```bash
cd web
bun install
cp .env.example .env.local   # optional; analytics and the Ask flag stay off if the key is empty
bun run dev                  # Vite, proxies API routes to http://localhost:8787
bun test                     # bun test test
bun run build                # tsc --noEmit and vite build, output in web/dist
```

The server serves `web/dist` when that directory exists. For a single-process run, build the web app, then start the server.

## Mac agent

Details, signing, and the menu bar app are in [agents/mac/README.md](agents/mac/README.md).

```bash
cd agents/mac
swift build -c release --product doggy-agent
swift build -c release --product DoggyApp
```

There is no Swift test target. `doggy-agent run --dry-run --once` prints one capture and does not upload it. Accessibility permission is granted to the process that runs the agent.

## Windows agent

Details are in [agents/windows/README.md](agents/windows/README.md). The project notes say this agent has not been run on a real Windows machine.

```bash
cd agents/windows
dotnet build -c Release
```

There is no .NET test project. `scripts/package.sh` publishes a self-contained `Doggy-windows.exe`.

## Pull requests

- Use the pull request template.
- Describe the behavior change and how you tested it. If you could not run a platform (Swift on Linux, the Windows app on Windows), say so.
- Keep one concern in a change when you can.
- Do not commit `.env` files, API keys, SQLite databases, desktop installers, or real screen text.
- If you change what is captured, what is sent to the model, or how long data is kept, update the Privacy section of the README so it still matches the code.
- Do not add a claim the code does not implement.

Issues: use the bug or feature template. Feature ideas that are already in [docs/PLAN.md](docs/PLAN.md) are better as a note on that item than as a new design.
