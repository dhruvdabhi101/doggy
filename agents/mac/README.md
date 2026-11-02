# Doggy for macOS (menu bar app + `doggy-agent` CLI)

Captures on-screen text from the frontmost window with the macOS **Accessibility API** (no screenshots, no OCR)
and sends new lines to the Doggy server (`POST /api/capture`), where tasks and commitments get extracted.

The package has three targets:

| Target | Kind | What it is |
|---|---|---|
| `DoggyCore` | library | Config, AX capture, differ, uploader, API calls, and `CaptureEngine` (start/stop/pause, observable status) |
| `DoggyApp` | executable | The SwiftUI menu bar app, shipped as `Doggy.app` |
| `doggy-agent` | executable | The CLI (same commands as before) |

The app and the CLI share `~/.doggy/agent.json` (server + token) and `~/.doggy/paused`, so you can use either one.
Don't run both capture loops at once, or every line gets uploaded twice.

## Menu bar app

Install from `dist/mac/Doggy-mac.dmg` by dragging Doggy to Applications, then open it. There's no Dock icon
(`LSUIElement`); look for the paw in the menu bar.

- **First launch:** if you're not signed in, a sign-in window opens. Enter the server (default
  `https://doggy.ruv.world`), email and password, then choose **Sign in** or **Create account**. The device is registered
  as `mac-agent` using the Mac's name.
- **Status line:** `Capturing · last sync 2m ago`, `Paused`, `Needs Accessibility permission` or `Not signed in`,
  plus how many events were sent today and the last error, if there is one.
- **Quick note…** (⌘N) opens a small window. Notes are sent to `POST /api/notes` (`source: "text"`), and the window
  lists the extracted tasks, commitments and other items.
- **Pause / Resume capture** (⌘P) creates or removes `~/.doggy/paused`.
- **Open Doggy** opens the server URL in your browser.
- **Grant Accessibility…** appears only while permission is missing. It shows the system prompt and opens
  System Settings → Privacy & Security → Accessibility. The app checks every 3 s and starts capturing as soon as
  permission is granted, with no restart needed.
- **Start at login** uses `SMAppService.mainApp`. This only works from the bundled app, not `swift run`.
- **Sign out** clears the token in `agent.json` but keeps the server and `excludeApps`. **Quit** exits the app.

For development, `swift run DoggyApp` runs the app unbundled. Accessibility is then granted to your terminal.

## Packaging

```sh
cd agents/mac
./scripts/package.sh
# -> dist/mac/Doggy.app and dist/mac/Doggy-mac.dmg (repo root)
```

The script needs SwiftPM only, no Xcode. It:

1. runs `swift build -c release --product DoggyApp`
2. assembles `Doggy.app` with an `Info.plist` (`world.ruv.doggy`, 0.1.0, `LSUIElement`, macOS 13+)
3. renders `web/public/icon.svg` to `AppIcon.icns` with `sips`/`iconutil`, falling back to `qlmanage` and then to no icon
4. ad-hoc signs the app (`codesign --force --deep -s -`)
5. builds a compressed DMG containing the app and an `/Applications` link

The build targets the host architecture only, which is **arm64** on Apple silicon. It is not a universal binary.

### Gatekeeper and unsigned builds

The app is only ad-hoc signed and is not notarized, so macOS blocks it the first time it's opened from a downloaded DMG.
To get past that, do one of these:

- In Finder, right-click (or Control-click) `Doggy.app`, choose **Open**, then confirm with **Open**. On recent macOS,
  you may need to approve it in System Settings → Privacy & Security → "Open Anyway" instead.
- Or remove the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Doggy.app`

An ad-hoc signature changes with every build, so macOS treats each rebuild as a new app. After updating, remove
Doggy from the Accessibility list and add it again.

**Real distribution** needs an Apple Developer ID Application certificate, signing with the hardened runtime
(`codesign --options runtime --timestamp -s "Developer ID Application: …"`), notarization
(`xcrun notarytool submit Doggy-mac.dmg --wait`) and stapling (`xcrun stapler staple`). A stable Developer ID
signature also keeps the Accessibility grant across updates.

## CLI build

```sh
cd agents/mac
swift build -c release --product doggy-agent
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
