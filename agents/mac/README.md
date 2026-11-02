# doggy-agent (macOS)

Captures on-screen text from the frontmost window with the macOS **Accessibility API** (no screenshots, no OCR)
and sends new lines to the Doggy server (`POST /api/capture`), where tasks and commitments get extracted.

## Build

```sh
cd agents/mac
swift build -c release
# binary: .build/release/doggy-agent
sudo cp .build/release/doggy-agent /usr/local/bin/   # optional, gives it a stable path
```

Requires the Swift 6 toolchain (Command Line Tools are enough, no Xcode project). No third-party dependencies.

## Grant Accessibility permission

macOS gives Accessibility access to the **responsible process**:

- Run from a terminal: grant it to the terminal app (Terminal, iTerm, Ghostty...).
- Run as a LaunchAgent: grant it to the binary itself (`/usr/local/bin/doggy-agent`).

System Settings → Privacy & Security → Accessibility → `+` → pick the app or binary → enable it.
On first run the agent also triggers the system prompt. If you rebuild or move the binary, macOS may treat it as a
new app: remove the old entry and add it again.

`doggy-agent status` shows whether permission is granted.

## Login

```sh
doggy-agent login --server http://localhost:8787 --email you@example.com --password '...' [--device-name "My MacBook"]
```

This calls `POST /api/auth/login` with `deviceKind: "mac-agent"` and saves `{server, token}` to `~/.doggy/agent.json`
(mode 600).

## Run

```sh
doggy-agent run                    # capture loop: every 3s, uploads every 20s (or when >100 events are queued)
doggy-agent run --dry-run --once   # capture the frontmost window once and print events as JSON; no network
doggy-agent run --dry-run          # loop, printing events instead of uploading
doggy-agent status
```

Logs go to stderr.

### Privacy controls

- **Pause:** `touch ~/.doggy/paused` stops all capture. `rm ~/.doggy/paused` resumes it.
- **Default exclusions:** 1Password, Bitwarden, Keychain Access, Passwords, System Settings, loginwindow,
  SecurityAgent.
- **Your own exclusions:** add bundle ids or app names to `~/.doggy/agent.json`:
  ```json
  { "server": "...", "token": "...", "excludeApps": ["com.apple.MobileSMS", "Signal"] }
  ```
- `AXSecureTextField` (password fields) is never read, and the agent does not walk below it.

## How it works

1. Gets the frontmost app from NSWorkspace, then calls `AXUIElementCreateApplication(pid)`. It sets
   `AXManualAccessibility = true` so Electron and Chromium apps (Slack, WhatsApp, Chrome...) expose their tree.
2. Walks `AXFocusedWindow` depth-first, with limits of 3000 nodes, depth 40 and 400 ms. It collects
   `AXValue`/`AXTitle`/`AXDescription` from text roles (StaticText, TextArea, TextField, Heading, Link, Cell...).
   For browsers it reads the URL from `AXWebArea.AXURL`. Every AX call has a 0.5 s messaging timeout, so a hung app
   can't block the loop.
3. Diffs per (bundleId + window title). Each line is normalized (trimmed, whitespace collapsed, lines under 3
   characters and pure numbers or timestamps dropped). Only lines whose hash hasn't been seen are sent. Memory is
   capped with an LRU of 200 windows × 5000 lines.
4. Batches events and POSTs them with a Bearer token (at most 200 events or ~450 KB per request). On failure it keeps
   the queue in memory (capped at 5 MB, oldest dropped first) and retries with exponential backoff (20 s → 5 min).

## Run at login (LaunchAgent)

```sh
# edit the binary path in the plist if needed
cp com.doggy.agent.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.doggy.agent.plist
# stop / uninstall
launchctl bootout gui/$(id -u)/com.doggy.agent
```

Logs: `/tmp/doggy-agent.log`. Grant Accessibility to the binary path the plist uses (see above).

## Known limitations

- Only the focused window of the frontmost app is captured, not background windows or other displays.
- Diff state and the upload queue live in memory only, so a restart re-sends text that is still visible and
  loses events that weren't uploaded yet.
- The diff key includes the window title. Apps that put changing content in the title (unread counts, timers)
  produce new keys and re-send text.
- Large or virtualized trees (long Slack channels, big documents) are cut off by the node and time limits. Only
  what's rendered in the AX tree is visible, which is usually what's on screen.
- Some apps expose little or no AX text: canvas-based apps, games, some Java or Qt apps, remote desktops, and
  Electron apps that ignore `AXManualAccessibility`. Firefox needs its accessibility service turned on.
- `AXEnhancedUserInterface` is deliberately not set, because it breaks window managers and animations. Some
  Chromium builds may need it to expose a full tree.
- Lines are deduped by hash, so text that legitimately repeats in a window ("ok", "thanks") is sent once.
- Rebuilding the binary usually invalidates the Accessibility grant (it isn't code-signed with a stable identity).
