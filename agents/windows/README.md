# Doggy Windows capture agent

A .NET 10 console app that reads on-screen text from the **foreground window**
using **Windows UI Automation** (no screenshots, no OCR), diffs it against what
it has already sent, and ships only new lines to the Doggy server, which
extracts tasks/commitments in the background.

Assembly name: `doggy-agent`. Project: `DoggyAgent`.

## Build

Requires the .NET 10 SDK.

```sh
dotnet build -c Release
# Framework-dependent publish for Windows x64 (needs .NET 10 runtime on the box):
dotnet publish -c Release -r win-x64 --self-contained false
```

The project targets `net10.0-windows` with `<UseWPF>true</UseWPF>` (which brings
in `UIAutomationClient` / `System.Windows.Automation`) and
`<EnableWindowsTargeting>true</EnableWindowsTargeting>` so it **compiles on
macOS/Linux**. It can only **run** on Windows.

The published binary is `doggy-agent.exe` in
`bin/Release/net10.0-windows/win-x64/publish/`.

## Usage

```sh
# 1. Log in (POSTs /api/auth/login with deviceKind "windows-agent",
#    saves {server, token} to %USERPROFILE%\.doggy\agent.json)
doggy-agent login --server http://localhost:8787 --email me@example.com --password secret --device-name "Work PC"

# 2. Run the capture loop (every ~3s)
doggy-agent run

# 3. Capture the foreground window once and print the events JSON, no network
doggy-agent run --dry-run --once

# 4. Show config / login status
doggy-agent status
```

### Pause

Create the file `%USERPROFILE%\.doggy\paused` to pause capture; delete it to
resume. No restart needed.

### Config

`%USERPROFILE%\.doggy\agent.json`:

```json
{
  "server": "http://localhost:8787",
  "token": "…",
  "deviceName": "Work PC",
  "excludeApps": ["mybankapp", "privatechat"]
}
```

`excludeApps` is an optional list of process-name substrings (case-insensitive)
to never capture, on top of the built-in skip list (1Password, Bitwarden,
KeePass, `credentialuifirefox`, LogonUI, LockApp).

## How it works

- Every ~3s on an **STA thread**: `GetForegroundWindow` → process name via
  `GetWindowThreadProcessId` → `AutomationElement.FromHandle`.
- A **CacheRequest** fetches `Name`, `ControlType`, `IsPassword`,
  `AutomationId`, and `ValuePattern.Value`; the tree is walked with
  `TreeWalker.ControlViewWalker` under hard limits (**≤3000 nodes, depth ≤40,
  ~500 ms budget**) so a huge or hung window can't stall the loop.
- Text is collected from `Text`, `Edit`, `Document`, `Hyperlink`, `ListItem`,
  `DataItem`, and `Header` controls. Any element marked `IsPassword` is skipped.
- For browsers, the agent tries to read the address bar (`Edit` named like
  "Address and search bar" / AutomationId containing `urlbar`/`address`) as the
  event `url`.
- **Agent-side diff**: per `(processName + window title)` it keeps hashes of
  previously-sent normalized lines (trim, collapse whitespace, drop lines <3
  chars and pure numbers/timestamps). Only new lines are sent, joined by `\n`.
  Memory is bounded: 200 windows (LRU), 5000 line hashes each.
- **Batching**: events POST to `/api/capture` every ~20s (or when >100 are
  queued), ≤200 events/request, with a `Bearer` token. On failure the queue is
  kept (capped ~5 MB, oldest dropped) and retried with exponential backoff.
- Every UIA call is wrapped in try/catch (`ElementNotAvailableException`,
  `COMException`) and time-boxed.

## Autostart

**Task Scheduler** (runs at logon, survives reboots):

```bat
schtasks /create /tn "DoggyAgent" /tr "\"C:\Tools\doggy\doggy-agent.exe\" run" /sc onlogon /rl limited /f
```

Remove with `schtasks /delete /tn "DoggyAgent" /f`.

**Startup folder** alternative: put a shortcut to `doggy-agent.exe run` in
`shell:startup` (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`).

## SmartScreen / code signing

The published `.exe` is unsigned, so Windows SmartScreen will warn on first run
("Windows protected your PC" → *More info* → *Run anyway*). For real
distribution, sign it with an Authenticode certificate (ideally EV) via
`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 doggy-agent.exe` to
build reputation and suppress the warning.

## Known limitations / must be tested on real Windows

This was written and compiled on macOS; it has **never been run**. On a real
Windows machine, verify text extraction and the URL heuristic for each app:

- **Chrome / Edge** — address bar read as `url`; confirm the Edit name
  ("Address and search bar") matches the installed locale/version.
- **Slack, Teams, WhatsApp desktop, Discord, VS Code** — Chromium/Electron
  apps. **Their UIA accessibility tree is only populated once a UIA client
  queries it**, and some Electron apps need to be launched with
  `--force-renderer-accessibility` before any text is exposed. Expect empty
  captures until accessibility is active.
- **Outlook** — classic Win32/Office UIA differs from the new (WebView2) Outlook;
  check which build exposes message text.

Other things to validate on Windows:

- The node/depth/time-budget limits are tuned blind — may need adjusting for
  very large documents.
- Password/secret redaction relies on apps setting `IsPassword`; not guaranteed.
- Multi-monitor / per-monitor DPI and UAC-elevated foreground windows (an agent
  running non-elevated cannot read an elevated window's tree).
- High-volume windows may generate large diffs; confirm the 5 MB queue cap and
  backoff behave under a server outage.
