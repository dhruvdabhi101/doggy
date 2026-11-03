# Doggy

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL_3.0_only-blue)](LICENSE)

Doggy reads on-screen text on a Mac or Windows PC, asks a language model to pull out tasks, commitments, and other open loops, and shows them in a web dashboard.

## What it does

A desktop agent reads the visible text of the frontmost window. It does not take screenshots and it does not use OCR. It uploads lines it has not already sent, with the app name, window title, and a browser URL when it can read one.

The server stores that text and, if you set an Anthropic API key, sends it to Anthropic to extract five kinds of item: task, commitment, event, decision, and memory. The prompt asks for a short quote from the source on each item. The server checks that the quote really appears in the source only when the model marks an existing item done. You can also type a note, or dictate one. Dictation uses the browser's speech recognition. The server stores the finished transcript. Audio stays with the browser's speech service.

The dashboard lists open items, searches them with SQLite full-text search, and can answer a question from saved items and screen text that is still on the server. The same account is shared by every device that signs in. An MCP endpoint at `/mcp` lets a connected assistant search memory, list open loops, and save a note.

With no Anthropic key, extraction is a local pattern match, and Ask returns a short list of matching lines. That path is much less accurate. The Ask page in the web app stays hidden unless you configure the PostHog flag in [docs/FEATURE_FLAGS.md](docs/FEATURE_FLAGS.md). `POST /api/ask` is still there.

[docs/PLAN.md](docs/PLAN.md) says the Mac agent has been used on a real Mac. The Windows agent compiles, and [agents/windows/README.md](agents/windows/README.md) says it has not been run on Windows. There is no native iOS or Android app. A phone uses the web app.

## Demo

> **Placeholder.** Put a demo GIF or screenshot of the open loops dashboard here. A reasonable path is `docs/media/dashboard.gif`, referenced as `![Open loops dashboard](docs/media/dashboard.gif)`. No image is in the repository yet.

## Supported platforms

| Part | Where it runs |
| --- | --- |
| Server | Bun on Linux, macOS, or Windows. Hono and SQLite (`bun:sqlite`). |
| Web app | A current browser. Installable PWA. Voice notes need a secure context (HTTPS, or localhost). |
| Mac agent | macOS 13 or newer. The package script builds for the machine you compile on (arm64 on Apple silicon). Ad-hoc signed, with no Developer ID and no notarization. It is not a universal binary. |
| Windows agent | Windows x64. Build with the .NET 10 SDK. Unsigned. Not yet run on Windows, per the agent README. |

## Quick start

You need [Bun](https://bun.sh). Model extraction needs an Anthropic API key in `server/.env`. Without it, the server still runs.

### Self-host

This runs the API and the built web app in one process.

```bash
cd web && bun install && bun run build
cd ../server && bun install
cp .env.example .env
# Set ANTHROPIC_API_KEY in server/.env if you want model extraction.
# If a reverse proxy terminates HTTPS, set DOGGY_PUBLIC_URL to the public origin.
bun run start
```

Open `http://localhost:8787` and create an account. The server listens on all interfaces unless you set `HOST`. For a public host, terminate TLS in a reverse proxy and keep the process on localhost. `deploy/` has a sample systemd unit and Caddy site for one layout. The steps are in [docs/TECHNICAL.md](docs/TECHNICAL.md).

The desktop apps default to `https://doggy.ruv.world`. Point them at your server or their captures go to that host. Installers are not in git. Build them from `agents/mac` and `agents/windows`.

Voice on a phone needs HTTPS. Localhost is enough for a browser on the same machine.

### Local development

Two processes. Vite proxies `/api`, `/mcp`, `/oauth`, and `/.well-known` to the server.

```bash
# terminal 1
cd server && bun install && cp .env.example .env && bun run dev

# terminal 2
cd web && bun install && bun run dev
```

Open `http://localhost:5173`.

### Desktop agents

Mac, after you grant Accessibility to the terminal or the binary:

```bash
cd agents/mac
swift build -c release --product doggy-agent
.build/release/doggy-agent login --server http://localhost:8787 --email you@example.com --password 'your-password'
.build/release/doggy-agent run
```

Windows build and run steps are in [agents/windows/README.md](agents/windows/README.md). Menu bar and tray apps are documented in the agent READMEs. Do not run the CLI capture loop and the tray app at the same time. Both would upload the same text.

To connect an MCP client, use `https://<your-server>/mcp`. The Connect page in the app lists the clients the UI knows about.

## Configuration

The server reads environment variables. The web app reads `VITE_` variables at build time. The agents do not read environment variables. They use `~/.doggy/agent.json` (Windows: `%USERPROFILE%\.doggy\agent.json`) for the server URL, token, and extra apps to ignore. A `paused` file next to that config pauses capture.

Copy [server/.env.example](server/.env.example) to `server/.env` and [web/.env.example](web/.env.example) to `web/.env.local`. [.env.example](.env.example) lists every variable. None of the examples contain real keys.

| Variable | Default | Role |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` | empty | Turns on Anthropic calls. Empty: local pattern matching. |
| `DOGGY_MODEL_FAST` | `claude-haiku-5-5` | Model for screen-capture extraction. |
| `DOGGY_MODEL` | `claude-sonnet-5-5` | Model for notes, voice, and Ask. |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address. |
| `DOGGY_DB` | `server/data/doggy.db` | SQLite file. |
| `DOGGY_DOWNLOADS` | `server/data/downloads` | Directory for `Doggy-mac.dmg` and `Doggy-windows.exe`. |
| `DOGGY_PUBLIC_URL` | request host | Public origin used in OAuth metadata. |
| `DOGGY_PUBLIC_HOST` | unset | Extra hostname whose captures are skipped. `localhost`, `127.0.0.1`, and `doggy.ruv.world` are always skipped. |
| `DOGGY_CAPTURE_RETENTION_DAYS` | `30` | Age, by `captured_at`, after which capture rows are deleted. |
| `DOGGY_EPISODE_IDLE_MS` | `45000` | Quiet time before a fast-lane episode is extracted. |
| `DOGGY_SLOW_LANE_MS` | `3600000` | Clock window for slow-lane episodes. |
| `POSTHOG_KEY` / `POSTHOG_HOST` | empty / `https://us.i.posthog.com` | Server analytics. Empty key disables it. |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | empty / US cloud | Browser analytics and the Ask flag. |
| `NODE_ENV` | unset | `test` disables server analytics. |

Seen-line fingerprints expire after 30 days. That number is `SEEN_LINE_TTL_DAYS` in code, not an environment variable.

Analytics, the Ask flag, and the sample deploy layout are documented in [docs/ANALYTICS.md](docs/ANALYTICS.md), [docs/FEATURE_FLAGS.md](docs/FEATURE_FLAGS.md), and [docs/TECHNICAL.md](docs/TECHNICAL.md). Both analytics sides stay off when their keys are empty.

## Architecture

```
desktop agents  >  POST /api/capture  >  captures
notes           >  POST /api/notes    >  notes
captures and notes  >  llm.extract() every 10 seconds for captures, immediately for notes  >  items
items  >  dashboard, search, Ask, and MCP
```

- `server/` is the source of truth: accounts, device tokens, capture intake, extraction, search, Ask, MCP, and the built web app.
- `web/` is a Vite and React PWA.
- `agents/mac` is a Swift menu bar app and a `doggy-agent` CLI.
- `agents/windows` is a .NET tray app and the same CLI commands.
- Agents keep their diff and upload queue in memory only. A restart can send text that is still on screen. The server drops lines it already stored for that source.

More detail: [docs/TECHNICAL.md](docs/TECHNICAL.md), [docs/API.md](docs/API.md), [docs/CAPTURE_PIPELINE.md](docs/CAPTURE_PIPELINE.md). [docs/PLAN.md](docs/PLAN.md) is a working status file. Some of its older lines have been corrected where they disagreed with the code. Treat the rest as notes.

## Privacy

This is what the current code does. The in-app pages at `/privacy` and `/retention` are the wording shipped in the web app. Where they disagree with the server, the server behavior below is the one to trust.

### What is captured

When the desktop app is signed in and not paused, it reads the focused window of the frontmost app about every 3 seconds.

- Mac: the Accessibility tree (`AXValue`, `AXTitle`, `AXDescription` on text roles), the app name, the bundle id, the window title, and a browser URL from `AXWebArea` when that exists. It skips `AXSecureTextField` and does not walk below it. Default exclusions include 1Password, Bitwarden, Keychain Access, Passwords, System Settings, the login window, and SecurityAgent. You can exclude more apps.
- Windows: the UI Automation tree of the foreground window, including names and values of text-like controls, the process name, the window title, and an address-bar guess for browsers. Controls with `IsPassword` are skipped. Default exclusions include 1Password, Bitwarden, KeePass, and the lock and sign-in UI. This path has not been run on Windows.
- Neither agent screenshots the display or OCRs pixels. Neither reads other apps' windows in the background. Pause creates `~/.doggy/paused` (or the Windows equivalent) and capture stops until that file is removed.
- The upload is new lines for that window, plus app, window title, and URL. Diff state lives in memory on the device.
- A typed note or a dictated transcript is sent as text to `POST /api/notes`. Audio is not uploaded. The browser's own speech service handles the audio. This repository does not include a transcription provider.
- A question you type into Ask is sent to `POST /api/ask`.
- The web app stores the sign-in token in `localStorage` (`doggy.session`). If PostHog is configured, it also stores analytics ids there, and an anonymous flag id in `sessionStorage` until the tab closes.

Password fields are skipped only when the app exposes them as secure or password controls. A secret typed into a normal text field can be captured.

### What is sent to the model provider

Calls go to Anthropic's Messages API through `@anthropic-ai/sdk`, using `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The model id is `DOGGY_MODEL_FAST` for screen text (default `claude-haiku-5-5`) and `DOGGY_MODEL` for notes, voice, and Ask (default `claude-sonnet-5-5`). If neither credential is set, nothing is sent to Anthropic.

Before the request, `redactSensitive` in `server/src/redact.ts` replaces some patterns with `[REDACTED]`: private key blocks, labeled passwords and API keys, common token shapes, bearer and cookie headers, URLs with credentials, labeled recovery phrases, card numbers that pass a checksum, IBANs, and some government-id shapes (SSN, Aadhaar, PAN) plus labeled passport and bank numbers. Names and email addresses are kept on purpose. The filter misses anything that does not match. It does not rewrite the text stored in SQLite.

An extraction request includes:

- your account name and email, timezone, and the current time
- titles, types, ids, and due times of open items used as context (not their full notes)
- titles of up to 15 recently completed items
- the source text. For screen episodes that is about the last 12,000 characters of each episode, with app name, window title, and URL, packed up to about 24,000 characters of source text per call

An Ask request includes the question, timezone, current time, and the retrieved records: item title, details, quote, and matching screen-text snippets. MCP tool replies pass through the same filter on the way out. The original note or capture is still stored unfiltered.

What Anthropic keeps, and for how long, is set by Anthropic's API terms. This repository does not configure that.

If `POSTHOG_KEY` or `VITE_POSTHOG_KEY` is set, usage events go to PostHog. The event list, and what is deliberately left out (note text, screen text, emails, search terms), is in [docs/ANALYTICS.md](docs/ANALYTICS.md). With those keys empty, those requests are not made. The Ask flag, when configured, sends the public project key and an anonymous tab id to PostHog's flags API. It does not send your account id.

### What is stored, and for how long

The database is a SQLite file. It is not encrypted. Anyone who can read the file can read the rows.

| Data | How long the server keeps it |
| --- | --- |
| Capture rows (app, window title, URL, screen text) | Deleted about once an hour when `captured_at` is older than `DOGGY_CAPTURE_RETENTION_DAYS` (default 30). The delete does not check whether extraction finished. Pending rows past that age are deleted too. |
| Fingerprints of lines already seen | 30 days (`SEEN_LINE_TTL_DAYS`, not configurable). The stored value is a truncated SHA-256 of the normalized line, not the line. Lines shorter than 8 characters are not fingerprinted. |
| Notes | Until the row is removed. There is no delete-note API. |
| Items, including the evidence quote | Until the row is removed. Marking an item done or dismissed changes `status` and leaves the row. There is no erase-item API. |
| Account (email, name, timezone, password hash) | Until the row is removed. The password is stored only as a `Bun.password` hash. There is no delete-account API. |
| Devices | Until logout or until the device is removed. The token is 32 random bytes. The database stores its SHA-256, not the token. Tokens do not expire on their own. |
| Per-source capture settings and counts, daily model token totals | Until those rows are removed. The usage rows are counts, not text. |
| OAuth authorization codes | About 5 minutes. Unused OAuth client rows are deleted after one day. |
| Server logs | This repository does not set a retention period. The process logs can include a source key, a window title, and up to 80 characters of a quote when an item is closed. |

The in-app retention page says screen text is kept for 30 days after it has been processed, and that server logs last 7 days. The delete in `server/src/pipeline.ts` is by `captured_at` and includes pending rows. Nothing in this repository configures a 7 day log limit.

`GET /api/export` downloads items as JSON. It does not include raw captures or notes.

If you enable `deploy/doggy-backup.timer`, daily snapshots of the whole database are kept for 14 days. `deploy/deploy.sh` also keeps recent pre-deploy snapshots (up to 20). A snapshot can still hold screen text after the live row was deleted. Those files sit next to the live database unless you copy them elsewhere.

### Self-host for full control

Run the server yourself, set your own Anthropic key, and sign the desktop agents into that server. Screen text and notes then sit on your disk and, when a key is set, in your Anthropic account. They are not sent to a Doggy-operated API. Leave the PostHog variables empty and the app does not call PostHog.

The agents' default server is `https://doggy.ruv.world`. Change it at login. Signing in there sends captures to whoever operates that host.

There is no in-app account deletion. On your own server, stop the process and delete the SQLite file, or delete that user's rows. Sign out of the browser and the desktop app to drop local tokens.

## Unsigned builds

Current desktop builds are not signed for distribution.

The Mac app is ad-hoc signed (`codesign -s -`) and is not notarized. macOS blocks a downloaded copy the first time you open it. Use one of these:

- System Settings, Privacy & Security, then Open Anyway.
- Or, in a terminal: `xattr -dr com.apple.quarantine` on the app path (for example `/Applications/Doggy.app`).

An ad-hoc signature changes every build, so Accessibility permission often has to be granted again after an update. A Developer ID signature and notarization are not set up in this repository.

`Doggy-windows.exe` is unsigned. Windows SmartScreen shows "Windows protected your PC". Choose More info, then Run anyway. Browsers may also warn that the download is uncommon.

## Roadmap

[docs/PLAN.md](docs/PLAN.md) is the working list, not a commitment. The items near the top are: measure extraction against a real day of captures, per-app parsers, a Windows test on a real PC, moving database snapshots off the server, reminders, and signed desktop builds. Later notes mention embeddings, native phone apps, encryption at rest, and meeting audio.

Two things in that file are already done in code and should not be read as missing: model names are the Haiku and Sonnet defaults above, and `server/src/redact.ts` filters text before model calls. Secret redaction is still pattern matching, not a guarantee. Captures are still stored unencrypted.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Dhruv Dabhi.

Doggy is licensed under the GNU Affero General Public License, version 3 only (SPDX `AGPL-3.0-only`). The full text is in [LICENSE](LICENSE).

If you modify Doggy and let other people use that modified version over a network, the AGPL requires you to offer those users the source of the version they are using. See section 13 of the license.
