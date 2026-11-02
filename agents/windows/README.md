# Doggy for Windows (tray app + capture agent)

A .NET 10 Windows app that reads on-screen text from the **foreground window**
using **Windows UI Automation** (no screenshots, no OCR), diffs it against what
it has already sent, and ships only new lines to the Doggy server, which
extracts tasks/commitments in the background.

One exe, two modes:

- **No arguments → tray app** (what users double-click).
- **Any arguments → the original CLI** (`login` / `run` / `status`, `--dry-run`).

Assembly name: `doggy-agent`; distributed as `Doggy-windows.exe`. Project: `DoggyAgent`.

## Build & package

Requires the .NET 10 SDK. Builds on macOS/Linux thanks to
`<EnableWindowsTargeting>`; it can only **run** on Windows.

```sh
dotnet build -c Release

# Distributable: self-contained single-file exe (no .NET install needed)
scripts/package.sh
# → <repo>/dist/windows/Doggy-windows.exe  (~75 MB, compressed single file)
```

`scripts/package.sh` runs
`dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true`,
renames `doggy-agent.exe` → `Doggy-windows.exe`, and deletes the `.pdb`.

The icon `Assets/doggy.ico` (16–256 px) is generated from `web/public/icon.svg`
by `scripts/make-icon.sh` (macOS `sips` + a small Python ICO writer); it is
committed, so you only need to rerun the script if the SVG changes. It is used as
the exe icon (`ApplicationIcon`) and embedded as a resource for the tray icon.

Project notes: `OutputType` is `WinExe` (no console window for the tray);
`UseWPF` provides `System.Windows.Automation`, `UseWindowsForms` provides
`NotifyIcon`. In CLI mode the app calls `AttachConsole(ATTACH_PARENT_PROCESS)`
so output appears in the terminal you launched it from.

## Tray app

Double-click `Doggy-windows.exe`. A Doggy icon appears in the notification area
(on first launch a balloon says "Doggy is running in the tray"; you may need to
drag it out of the `^` overflow).

- If you're not signed in, a **Sign in** window opens: server URL (default
  `https://doggy.ruv.world`), email, password → **Sign in** or **Create account**
  (`POST /api/auth/login` / `/api/auth/signup`, `deviceKind: "windows-agent"`,
  `deviceName` = the PC name). The token is saved to `%USERPROFILE%\.doggy\agent.json`
  (same file the CLI uses) and capture starts.
- Right-click menu:
  - **Status** — Capturing / Paused / Upload error / Not signed in, events sent,
    last upload time (or the last error).
  - **Quick note…** — type a note, Ctrl+Enter or *Save note* → `POST /api/notes
    {text, source:"text"}`; extracted item titles are listed. (Double-clicking the
    tray icon opens this too.)
  - **Pause / Resume capture** — creates/deletes `%USERPROFILE%\.doggy\paused`.
  - **Open Doggy** — opens the server URL in your default browser.
  - **Start with Windows** — toggles `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
    value `Doggy` = `"<path to exe>"`. If you move the exe, toggle it off/on again.
  - **Sign out** — flushes queued events, clears the token, stops capture.
  - **Exit** — flushes and quits.
- Only one tray instance runs at a time (named mutex). If the server rejects the
  token (401/403), capture stops and the tray shows *Not signed in*.

Capture runs on a dedicated STA thread (`CaptureEngine`); the UI runs on the
WinForms thread.

## CLI (still available)

Run from a terminal with arguments. Because the exe is a GUI-subsystem app,
`cmd.exe` doesn't wait for it: output appears, but the prompt may print before it
(press Enter). In PowerShell use `Start-Process -Wait -NoNewWindow`, or
`.\Doggy-windows.exe status | Out-Host`, if you need it to block.

```sh
# 1. Log in (POSTs /api/auth/login with deviceKind "windows-agent",
#    saves {server, token} to %USERPROFILE%\.doggy\agent.json)
Doggy-windows.exe login --server https://doggy.ruv.world --email me@example.com --password secret --device-name "Work PC"

# 2. Run the capture loop (every ~3s, Ctrl+C to stop)
Doggy-windows.exe run

# 3. Capture the foreground window once and print the events JSON, no network
Doggy-windows.exe run --dry-run --once

# 4. Show config / login status
Doggy-windows.exe status
```

Don't run `run` and the tray app at the same time — both would upload the same text.

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

The tray menu edits this list for you. **Don't capture <app>** ignores the app you were last in, and **Apps Doggy ignores…** lists, removes and adds apps. Changes apply within one capture tick (3s), without a restart.

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

Use the tray's **Start with Windows** toggle. For the headless CLI instead, use
Task Scheduler:

```bat
schtasks /create /tn "DoggyAgent" /tr "\"C:\Tools\doggy\Doggy-windows.exe\" run" /sc onlogon /rl limited /f
```

## SmartScreen / code signing

`Doggy-windows.exe` is **unsigned**, so on first run Windows SmartScreen shows
"Windows protected your PC" → click **More info** → **Run anyway**. Browsers
may also flag the download as uncommon. For real distribution, sign it with an
Authenticode certificate (ideally EV, or Azure Trusted Signing):
`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 Doggy-windows.exe`.
Sign *after* `package.sh` (signing changes the bytes, so don't rename/patch after).

## Known limitations / must be tested on real Windows

This was written and compiled on macOS; it has **never been run**.

Tray app — verify on real Windows (10 and 11):

- Exe launches with no console window; icon shows in Explorer and in the tray
  (crisp at 100%/150%/200% scaling); first-run balloon appears once.
- Sign in / Create account against the real server; errors are readable;
  token lands in `agent.json` and capture starts.
- Status line updates (Capturing → events sent / last upload time); Pause/Resume
  toggles the pause file and status; Error state shows on server outage and
  recovers.
- Quick note posts and lists extracted titles.
- Start with Windows writes/removes the Run value and the app actually starts at
  logon; Open Doggy opens the browser; Sign out / Exit flush and quit cleanly.
- Second launch shows "already running" instead of a second icon.
- CLI from `cmd` and PowerShell: `status`, `login`, `run --dry-run --once` print
  to the terminal via `AttachConsole`; Ctrl+C stops `run` and flushes.
- SmartScreen / Defender behaviour for the unsigned, self-extracting single file.

Capture — verify text extraction and the URL heuristic for each app:

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
